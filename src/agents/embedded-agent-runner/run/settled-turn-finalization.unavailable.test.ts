import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../../config/sessions/test-helpers.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readVisibleSessionTranscriptMessageEntries,
} from "../../../plugin-sdk/session-transcript-runtime.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import {
  buildEmbeddedRunnerAssistant,
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveRunEntryTerminalOutcome } from "../run-entry-terminal.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./settled-turn-finalization.test-support.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";

describe("unavailable finalization through the real core backend", () => {
  const fixture = useTempSessionsFixture("settled-finalization-unavailable-");
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;

  beforeEach(() => {
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "unavailable-finalizer");
  });
  afterEach(() => admission.close());

  it("preserves a failed cron turn and its transcript when finalization is unavailable", async () => {
    const expectedText =
      "⚠️ Selected model is at capacity. Try a different model, or wait and retry.";
    const admittedRunContext = await admission.admit("embedded");
    const assistant = buildEmbeddedRunnerAssistant({
      provider: "openai",
      model: "gpt-5.6-luna",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "completed-command", name: "exec", arguments: {} }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      terminal: {
        kind: "failed",
        source: "prompt",
        error: Object.assign(
          new Error("Selected model is at capacity. Please try a different model."),
          { status: 503, code: "OVERLOADED" },
        ),
      },
      sessionIdUsed: "session-settled",
      assistantTexts: [],
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: undefined,
      lastAssistant: undefined,
      messagesSnapshot: [
        { role: "user", content: "Run the command once.", timestamp: 1 },
        assistant,
        {
          role: "toolResult",
          toolCallId: "completed-command",
          toolName: "exec",
          content: [{ type: "text", text: "completed-once" }],
          isError: false,
          timestamp: 3,
        },
      ],
      toolMetas: [{ toolName: "exec", toolCallId: "completed-command", replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    });
    attempt.settledTurnFinalizationContext = Object.freeze({ source: "unavailable" });
    const original = JSON.stringify(attempt);
    const storePath = path.join(fs.realpathSync(fixture.sessionsDir()), "sessions.json");
    const target = {
      agentId: "main",
      sessionId: "session-settled",
      sessionKey: "agent:main:settled",
      storePath,
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    for (const message of attempt.messagesSnapshot) {
      await appendSessionTranscriptMessageByIdentity({ ...target, message });
    }
    const prefix = await readVisibleSessionTranscriptMessageEntries(target);
    const input = createSettledFinalizationTestInput(attempt, admittedRunContext);
    input.terminalBase.runParams.trigger = "cron";
    input.terminalBase.runParams.sessionKey = target.sessionKey;
    Object.assign(
      input.finalization.preparedAttempt,
      createResolvedEmbeddedRunnerModel("openai", "gpt-5.6-sol"),
      {
        provider: "openai",
        modelId: "gpt-5.6-sol",
        agentId: "main",
        sessionKey: target.sessionKey,
        sessionTarget: target,
        authProfileStore: { version: 1, profiles: {} },
        resolvedApiKey: "synthetic-unused-host-key",
      },
    );
    const finalize = vi.fn(async () => {
      throw new Error("Harness-owned finalization is unavailable");
    });
    const runAttempt = vi.fn(async () => {
      throw new Error("Completed work must not be replayed");
    });
    input.finalization.harness.finalizeSettledTurn = finalize;
    input.finalization.harness.runAttempt = runAttempt;

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ settledAttempt: attempt }));
    expect(runAttempt).not.toHaveBeenCalled();
    expect(result.finalizationOutcome).toBe("failed");
    expect(result.prepared.failureSignal).toBeUndefined();
    expect(result.prepared.payloadsWithToolMedia?.[0]?.isError).not.toBe(true);
    expect(result.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: expectedText }),
    ]);
    expect(result.attempt.assistantTexts).toEqual([expectedText]);
    expect(result.attempt.assistantTranscriptOwned).toBe(true);
    expect(result.attempt.terminal).toBe(attempt.terminal);
    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        ...result.prepared,
        attempt: result.attempt,
        attemptAssistant: result.attemptAssistant,
        terminalState: result.terminalState,
        runParams: input.terminalBase.runParams,
        settledTurnFinalizationOutcome: result.finalizationOutcome,
        replayState: { hadPotentialSideEffects: true, replayInvalid: true },
        resolveReplayInvalid: () => true,
      }),
    );
    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      throw new Error("Provider failure must settle without replay");
    }
    expect(resolved.result.meta).toMatchObject({
      aborted: false,
      replayInvalid: true,
      error: { message: expect.stringContaining("at capacity") },
    });
    expect(
      resolveRunEntryTerminalOutcome({ result: resolved.result, fallbackExhausted: false }),
    ).toMatchObject({ status: "error" });
    expect(result.prepared.finalAssistantVisibleText).toBe("");
    expect(result.prepared.finalAssistantRawText).toBe("");
    expect(result.attempt.currentAttemptAssistant).toMatchObject({
      provider: assistant.provider,
      model: assistant.model,
    });
    expect(JSON.stringify(attempt)).toBe(original);
    expect(attempt.terminal.kind).toBe("failed");
    const transcript = await readVisibleSessionTranscriptMessageEntries(target);
    expect(transcript.slice(0, prefix.length)).toEqual(prefix);
    expect(transcript.slice(prefix.length)).toMatchObject([
      {
        message: {
          provider: "openclaw",
          model: "delivery-mirror",
          content: [{ type: "text", text: expectedText }],
        },
      },
    ]);
    expect(transcript).toHaveLength(prefix.length + 1);
  });
});
