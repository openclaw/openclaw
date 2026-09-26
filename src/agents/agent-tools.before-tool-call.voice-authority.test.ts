/**
 * Final-effect coverage for spoken confirmation authority: the real
 * before_tool_call wrapper decides whether the tool body runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  authorizeClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy,
  deactivateClientVoiceConfirmationSession,
} from "../talk/client-voice-confirmation.js";
import {
  noteClientVoiceConfirmationUtteranceForTest as noteUtterance,
  resetClientVoiceConfirmationStateForTest,
} from "../talk/client-voice-confirmation.test-support.js";
import * as clientVoiceSession from "../talk/client-voice-session.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { resetAdjustedParamsByToolCallIdForTests } from "./agent-tools.before-tool-call.state.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

const VOICE_SESSION_ID = "voice-authority";
const SEND = { action: "send", to: "target-a", message: "approved body" };
const OTHER_SEND = { action: "send", to: "target-b", message: "another body" };
const TTL_MS = 2 * 60_000;

function bindVoiceRuns(runIds: string[]): void {
  const binding = {
    agentId: "main",
    voiceSessionId: VOICE_SESSION_ID,
    sessionKey: "agent:main:voice",
  };
  vi.spyOn(clientVoiceSession, "resolveClientVoiceRunBinding").mockImplementation((runId) =>
    runId && runIds.includes(runId) ? binding : undefined,
  );
  vi.spyOn(clientVoiceSession, "isClientVoiceSessionConfirmable").mockReturnValue(true);
}

function createMessageTool(runId: string) {
  const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
  const tool = wrapToolWithBeforeToolCallHook(
    { name: "message", execute } as unknown as AnyAgentTool,
    { runId, agentId: "main", sessionKey: "agent:main:voice" },
  );
  const run = (callId: string, params: unknown = SEND) =>
    tool.execute(callId, params, undefined, {} as Parameters<typeof tool.execute>[3]);
  return { execute, run };
}

function challengeFor(runId: string, params: unknown, now: number): string {
  const result = checkClientVoiceToolConfirmationPolicy({
    agentId: "main",
    voiceSessionId: VOICE_SESSION_ID,
    runId,
    toolName: "message",
    toolParams: params,
    isConfirmable: () => true,
    now,
  });
  if (result.allowed) {
    throw new Error("expected a confirmation challenge");
  }
  const id = result.reason.match(/VOICE_CONFIRMATION_REQUIRED:(\S+)/)?.[1];
  if (!id) {
    throw new Error("missing confirmation id");
  }
  return id;
}

function sayYesAndAuthorize(confirmationId: string, now: number) {
  noteUtterance({ agentId: "main", voiceSessionId: VOICE_SESSION_ID, text: "yes", timestamp: now });
  return authorizeClientVoiceConfirmation({
    agentId: "main",
    voiceSessionId: VOICE_SESSION_ID,
    confirmationId,
    now: now + 1,
  });
}

describe("spoken confirmation authority reaches the final tool effect", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    resetAdjustedParamsByToolCallIdForTests();
    resetClientVoiceConfirmationStateForTest();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    resetClientVoiceConfirmationStateForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs the tool body once for the current confirmed action", async () => {
    const runId = "run-approved";
    bindVoiceRuns([runId]);
    const { execute, run } = createMessageTool(runId);

    const blocked = await run("call-1");
    expect(execute).not.toHaveBeenCalled();
    const reason =
      typeof blocked.details === "object" && blocked.details !== null && "reason" in blocked.details
        ? blocked.details.reason
        : "";
    const confirmationId = String(reason).match(/VOICE_CONFIRMATION_REQUIRED:(\S+)/)?.[1];
    expect(confirmationId).toBeTruthy();

    vi.setSystemTime(Date.now() + 5);
    const grant = sayYesAndAuthorize(confirmationId!, Date.now());
    expect(bindAuthorizedClientVoiceConfirmation({ grant, runId })).toBe(true);

    const allowed = await run("call-2");
    expect(allowed.details).toEqual({ ok: true });
    expect(execute).toHaveBeenCalledOnce();

    const again = await run("call-3");
    expect(execute).toHaveBeenCalledOnce();
    expect(again.details).toMatchObject({ deniedReason: "client-voice-confirmation" });
  });

  it.each(["supersession", "refusal", "expiry", "closed-session"] as const)(
    "never runs the tool body after %s of a heard confirmation",
    async (invalidator) => {
      const runId = `run-${invalidator}`;
      bindVoiceRuns([runId]);
      const { execute, run } = createMessageTool(runId);
      const now = Date.now();
      const confirmationId = challengeFor(runId, SEND, now);
      const grant = sayYesAndAuthorize(confirmationId, now + 1);

      if (invalidator === "supersession") {
        challengeFor(runId, OTHER_SEND, now + 5);
      } else if (invalidator === "refusal") {
        noteUtterance({
          agentId: "main",
          voiceSessionId: VOICE_SESSION_ID,
          text: "no",
          timestamp: now + 5,
        });
      } else if (invalidator === "expiry") {
        vi.setSystemTime(now + TTL_MS + 1);
      } else {
        deactivateClientVoiceConfirmationSession("main", VOICE_SESSION_ID);
      }

      expect(bindAuthorizedClientVoiceConfirmation({ grant, runId })).toBe(false);
      const result = await run("call-after-invalidation");
      expect(execute).not.toHaveBeenCalled();
      expect(result.details).toMatchObject({ deniedReason: "client-voice-confirmation" });
    },
  );

  it("lets only the run that bound a challenge reused across runs execute", async () => {
    const first = "run-first-attempt";
    const retry = "run-retry";
    bindVoiceRuns([first, retry]);
    const firstTool = createMessageTool(first);
    const retryTool = createMessageTool(retry);
    const now = Date.now();

    const firstChallenge = challengeFor(first, SEND, now);
    const retryChallenge = challengeFor(retry, SEND, now + 10);
    expect(retryChallenge).toBe(firstChallenge);
    expect(firstTool.execute).not.toHaveBeenCalled();
    expect(retryTool.execute).not.toHaveBeenCalled();

    const grant = sayYesAndAuthorize(retryChallenge, now + 20);
    expect(bindAuthorizedClientVoiceConfirmation({ grant, runId: retry })).toBe(true);

    const stale = await firstTool.run("call-stale-run");
    expect(firstTool.execute).not.toHaveBeenCalled();
    expect(stale.details).toMatchObject({ deniedReason: "client-voice-confirmation" });

    const current = await retryTool.run("call-current-run");
    expect(current.details).toEqual({ ok: true });
    expect(retryTool.execute).toHaveBeenCalledOnce();
  });
});
