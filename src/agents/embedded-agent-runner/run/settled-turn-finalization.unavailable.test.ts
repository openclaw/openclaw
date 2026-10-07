import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
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

const FALLBACK =
  "The tool run finished, but no final summary was produced. I did not repeat any completed actions.";

describe("unavailable finalization through the real core backend", () => {
  const fixture = useTempSessionsFixture("settled-finalization-unavailable-");
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;

  beforeEach(() => {
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "unavailable-finalizer");
  });
  afterEach(() => admission.close());

  it.each([
    { trigger: "user", terminal: "ok", context: "unavailable", toolFailed: false },
    { trigger: "user", terminal: "failed", context: "unavailable", toolFailed: false },
    { trigger: "user", terminal: "failed", context: "openclaw-transcript", toolFailed: false },
    { trigger: "cron", terminal: "failed", context: "unavailable", toolFailed: false },
    { trigger: "user", terminal: "ok", context: "unavailable", toolFailed: true },
    { trigger: "cron", terminal: "ok", context: "unavailable", toolFailed: false },
  ] as const)(
    "preserves settled work when finalization is unavailable ($trigger/$terminal/$context/toolFailed=$toolFailed)",
    async ({ trigger, terminal, context, toolFailed }) => {
      const failed = terminal === "failed";
      const expectedText = failed
        ? "⚠️ Selected model is at capacity. Try a different model, or wait and retry."
        : trigger === "cron"
          ? SILENT_REPLY_TOKEN
          : FALLBACK;
      const admittedRunContext = await admission.admit("embedded");
      const assistant = buildEmbeddedRunnerAssistant({
        provider: "openai",
        model: "gpt-5.6-luna",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "completed-command", name: "exec", arguments: {} }],
      });
      const attempt = makeEmbeddedRunnerAttempt({
        terminal:
          terminal === "ok"
            ? { kind: "ok" }
            : {
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
            isError: toolFailed,
            timestamp: 3,
          },
        ],
        toolMetas: [{ toolName: "exec", toolCallId: "completed-command", replaySafe: false }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        lastToolError: toolFailed
          ? { toolName: "exec", error: "Command exited with code 127" }
          : undefined,
      });
      attempt.settledTurnFinalizationContext =
        context === "unavailable"
          ? Object.freeze({ source: context })
          : { source: context, messages: attempt.messagesSnapshot };
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
      input.terminalBase.runParams.trigger = trigger;
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
      expect(result.finalizationOutcome).toBe(
        trigger === "cron" && !failed ? "silent-fallback" : "failed",
      );
      expect(result.prepared.failureSignal).toBeUndefined();
      if (toolFailed) {
        expect(result.attempt).toBe(attempt);
        expect(result.prepared.payloadsWithToolMedia).toEqual([
          expect.objectContaining({ text: expect.stringContaining("failed"), isError: true }),
        ]);
        expect(await readVisibleSessionTranscriptMessageEntries(target)).toEqual(prefix);
        return;
      }
      expect(result.prepared.payloadsWithToolMedia?.[0]?.isError).not.toBe(true);
      expect(result.prepared.payloadsWithToolMedia).toEqual(
        trigger === "cron" && !failed ? [] : [expect.objectContaining({ text: expectedText })],
      );
      expect(result.attempt.assistantTexts).toEqual([expectedText]);
      expect(result.attempt.assistantTranscriptOwned).toBe(true);
      if (failed) {
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
      }
      if (trigger === "user") {
        expect(
          getReplyPayloadMetadata(result.prepared.payloadsWithToolMedia?.[0] ?? {}),
        ).toMatchObject({
          assistantTranscriptOwned: true,
          assistantTranscriptIdempotencyKey: "run-settled:settled-finalization-fallback",
        });
        expect(
          getReplyPayloadMetadata(result.prepared.payloadsWithToolMedia?.[0] ?? {})
            ?.deliverDespiteSourceReplySuppression,
        ).not.toBe(true);
      }
      expect(result.prepared.finalAssistantVisibleText).toBe("");
      expect(result.prepared.finalAssistantRawText).toBe("");
      expect(result.attempt.currentAttemptAssistant).toMatchObject({
        provider: assistant.provider,
        model: assistant.model,
      });
      expect(JSON.stringify(attempt)).toBe(original);
      expect(attempt.terminal.kind).toBe(terminal);
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
    },
  );
});
