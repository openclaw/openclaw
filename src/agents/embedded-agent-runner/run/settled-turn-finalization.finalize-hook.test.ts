import { assert, describe, expect, it, vi } from "vitest";
import { makeEmbeddedRunnerAttempt as makeAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { useFinalizationAdmission } from "./settled-finalization-harness.test-support.js";
import { prepareTerminalWithSettledTurnFinalization as finalize } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput as makeInput } from "./settled-turn-finalization.test-support.js";
import { finalizationReply, settledBatch } from "./settled-turn-fixtures.test-support.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";

const backendMocks = vi.hoisted(() => ({
  finalize: vi.fn(),
}));

// mock-isolation: no runtime plan exists in these fixtures, so the model attempt stays empty.
vi.mock("./backend.js", () => ({
  resolveRuntimeModelAttempt: vi.fn(() => undefined),
}));
// mock-isolation: finalization fixtures must not load or invoke the live agent harness.
vi.mock("../../harness/selection.js", () => ({
  runAgentHarnessSettledTurnFinalization: backendMocks.finalize,
}));
// mock-isolation: record synthetic mirror writes without loading transcript persistence.
vi.mock("../../../plugin-sdk/session-transcript-runtime.js", () => ({
  appendAssistantMirrorMessageByIdentity: vi.fn(),
}));

/** A turn whose side-effecting tool settled with no visible answer. */
function settledToolAttempt(): EmbeddedRunAttemptWithReceiptEvidence {
  const batch = settledBatch(["tool-edit", "edit_record"]);
  return makeAttempt({
    ...batch,
    terminal: { kind: "ok" },
    sessionIdUsed: "session-settled",
    sessionFileUsed: "/tmp/session-settled.jsonl",
    toolMetas: [{ toolName: "edit_record", isError: false, replaySafe: false }],
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    settledTurnFinalizationContext: {
      source: "openclaw-transcript",
      messages: batch.messagesSnapshot,
    },
    assistantTurns: 1,
  });
}

const getContext = useFinalizationAdmission([backendMocks.finalize]);

function finalizationInput() {
  const input = makeInput(settledToolAttempt(), getContext());
  Object.assign(input.terminalBase.runParams, { onAttemptTerminalReplaced: vi.fn() });
  Object.assign(input.finalization.preparedAttempt, {
    maxBeforeAgentFinalizeRevisions: 3,
    beforeAgentFinalizeRevisionAttempts: 1,
  });
  return input;
}

/** The params the isolated finalizer ran with. */
function finalizerParams() {
  const call = backendMocks.finalize.mock.calls[0];
  assert(call, "Expected a finalizer call");
  return call[0];
}

/** Terminal resolution of a finalized turn, as the run loop hands it over. */
function terminalInputOf(
  input: ReturnType<typeof finalizationInput>,
  result: Awaited<ReturnType<typeof finalize>>,
) {
  return makeTerminalInput({
    ...result.prepared,
    attempt: result.attempt,
    attemptAssistant: result.attemptAssistant,
    terminalState: result.terminalState,
    runParams: input.terminalBase.runParams,
    settledTurnFinalizationOutcome: result.finalizationOutcome,
    replayState: { hadPotentialSideEffects: true, replayInvalid: false },
  });
}

describe("before_agent_finalize on the settled-turn finalization answer", () => {
  it("grants the finalizer the run's revision budget under the committed session", async () => {
    backendMocks.finalize.mockResolvedValueOnce(finalizationReply("answered", "Done."));
    const input = finalizationInput();
    // The settled attempt adopted a successor session: the finalizer's hooks see that one.
    Object.assign(input.initial, {
      sessionIdUsed: "session-successor",
      sessionFileUsed: "/tmp/session-successor.jsonl",
    });

    await finalize(input);

    expect(finalizerParams()).toMatchObject({
      operation: "settled-tool-finalization",
      sessionId: "session-successor",
      sessionFile: "/tmp/session-successor.jsonl",
      maxBeforeAgentFinalizeRevisions: 3,
      beforeAgentFinalizeRevisionAttempts: 1,
    });
  });

  it("withholds the budget from the summary of a turn an output limit cut off", async () => {
    backendMocks.finalize.mockResolvedValueOnce(finalizationReply("answered", "Done."));
    const input = finalizationInput();
    const { terminalState } = input.initial;
    input.initial.terminalState = {
      ...terminalState,
      outcome: { ...terminalState.outcome, stopReason: "length" },
    };

    await finalize(input);

    expect(finalizerParams().maxBeforeAgentFinalizeRevisions).toBeUndefined();
    expect(finalizerParams().beforeAgentFinalizeRevisionAttempts).toBeUndefined();
  });

  it("carries the finalizer's revision of its answer, and terminal resolution runs one more pass", async () => {
    backendMocks.finalize.mockResolvedValueOnce(
      finalizationReply("answered", "Built: the plugin is ready.", {
        beforeAgentFinalizeRevisionReason:
          "The project changed after its last build: build it, then answer.",
      }),
    );

    const input = finalizationInput();
    const finalized = await finalize(input);

    expect(finalized.finalizationOutcome).toBe("answered");
    expect(finalized.attempt.beforeAgentFinalizeRevisionReason).toBe(
      "The project changed after its last build: build it, then answer.",
    );
    const terminal = terminalInputOf(input, finalized);
    const resolved = await resolveEmbeddedRunTerminal(terminal);
    expect(resolved.action).toBe("retry");
    expect(terminal.retryState.beforeFinalizeRevisionAttempts).toBe(1);
    expect(terminal.sessionPromptState.activateInternalPrompt).toHaveBeenCalledWith(
      expect.stringContaining("build it, then answer."),
    );
  });

  it("delivers an answer the hooks accepted", async () => {
    backendMocks.finalize.mockResolvedValueOnce(finalizationReply("answered", "Done."));

    const input = finalizationInput();
    const finalized = await finalize(input);

    expect(finalized.attempt.beforeAgentFinalizeRevisionReason).toBeUndefined();
    const resolved = await resolveEmbeddedRunTerminal(terminalInputOf(input, finalized));
    expect(resolved.action).toBe("complete");
    assert(resolved.action === "complete", "Expected a completed run");
    expect(resolved.result.payloads?.[0]?.text).toBe("Done.");
  });

  it("ignores a revision reason after a failed finalization", async () => {
    const attempt = settledToolAttempt();
    attempt.beforeAgentFinalizeRevisionReason = "stale revision";
    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({ attempt, settledTurnFinalizationOutcome: "failed" }),
    );
    expect(resolved.action).not.toBe("retry");
  });
});
