import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../../config/sessions/test-helpers.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readVisibleSessionTranscriptMessageEntries,
} from "../../../plugin-sdk/session-transcript-runtime.js";
import {
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt as makeAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveRunEntryTerminalOutcome } from "../run-entry-terminal.js";
import { useFinalizationAdmission } from "./settled-finalization-harness.test-support.js";
import { prepareTerminalWithSettledTurnFinalization as finalize } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput as makeInput } from "./settled-turn-finalization.test-support.js";
import { settledBatch } from "./settled-turn-fixtures.test-support.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";

describe("unavailable finalization through the real core backend", () => {
  const fixture = useTempSessionsFixture("settled-finalization-unavailable-");
  const getContext = useFinalizationAdmission([], "unavailable-finalizer");

  it("preserves a failed cron turn and its transcript when finalization is unavailable", async () => {
    const expectedText =
      "⚠️ The model provider returned a temporary internal error before replying. Try again in a moment, or switch to another model if it keeps happening. Note: some tool actions may have already been executed — please verify before retrying.";
    const batch = settledBatch(["completed-command", "exec"]);
    const attempt = makeAttempt({
      ...batch,
      terminal: {
        kind: "failed",
        source: "prompt",
        error: Object.assign(
          new Error("Selected model is at capacity. Please try a different model."),
          { status: 503, code: "OVERLOADED" },
        ),
      },
      sessionIdUsed: "session-settled",
      currentAttemptAssistant: undefined,
      lastAssistant: undefined,
      messagesSnapshot: [
        { role: "user", content: "Run the command once.", timestamp: 1 },
        ...batch.messagesSnapshot,
      ],
      toolMetas: [{ toolName: "exec", toolCallId: "completed-command", replaySafe: false }],
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
    const input = makeInput(attempt, getContext());
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
        config: {},
        authProfileStore: { version: 1, profiles: {} },
        resolvedApiKey: "synthetic-unused-host-key",
      },
    );
    const harnessFinalizer = vi.fn(async () => {
      throw new Error("Harness-owned finalization is unavailable");
    });
    const runAttempt = vi.fn(async () => {
      throw new Error("Completed work must not be replayed");
    });
    input.finalization.harness.finalizeSettledTurn = harnessFinalizer;
    input.finalization.harness.runAttempt = runAttempt;

    const result = await finalize(input);

    expect(harnessFinalizer).toHaveBeenCalledOnce();
    expect(harnessFinalizer).toHaveBeenCalledWith(
      expect.objectContaining({ settledAttempt: attempt }),
    );
    expect(runAttempt).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      finalizationOutcome: "failed",
      prepared: { failureSignal: undefined },
    });
    expect(result.prepared.payloadsWithToolMedia ?? []).toEqual([]);
    expect(result.attempt).toBe(attempt);
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
    if (resolved.action !== "complete") {
      throw new Error("Provider failure must settle without replay");
    }
    expect(resolved.result).toMatchObject({
      meta: {
        aborted: false,
        replayInvalid: true,
        error: { message: expect.stringContaining("at capacity") },
      },
      payloads: [{ text: expectedText, isError: true }],
    });
    expect(
      resolveRunEntryTerminalOutcome({ result: resolved.result, fallbackExhausted: false }),
    ).toMatchObject({ status: "error" });
    expect(result.prepared).toMatchObject({
      finalAssistantVisibleText: "",
      finalAssistantRawText: "",
    });
    expect(JSON.stringify(attempt)).toBe(original);
    expect(await readVisibleSessionTranscriptMessageEntries(target)).toEqual(prefix);
  });
});
