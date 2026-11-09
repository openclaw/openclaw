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
const hookMocks = vi.hoisted(() => ({
  hasHooks: vi.fn((name: string) => name === "before_agent_finalize"),
  runBeforeAgentFinalize: vi.fn(),
}));

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
// mock-isolation: a plugin's before_agent_finalize hook, without loading plugins.
vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: hookMocks.hasHooks,
    runBeforeAgentFinalize: hookMocks.runBeforeAgentFinalize,
  }),
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

const getContext = useFinalizationAdmission([
  backendMocks.finalize,
  hookMocks.runBeforeAgentFinalize,
]);

function finalizationInput() {
  const input = makeInput(settledToolAttempt(), getContext());
  Object.assign(input.terminalBase.runParams, { onAttemptTerminalReplaced: vi.fn() });
  return input;
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
  it("carries a hook revision of the answer, and terminal resolution runs one more pass", async () => {
    backendMocks.finalize.mockResolvedValueOnce(
      finalizationReply("answered", "Built: the plugin is ready."),
    );
    hookMocks.runBeforeAgentFinalize.mockResolvedValueOnce({
      action: "revise",
      reason: "The project changed after its last build: build it, then answer.",
    });

    const input = finalizationInput();
    const finalized = await finalize(input);

    expect(finalized.finalizationOutcome).toBe("answered");
    expect(hookMocks.runBeforeAgentFinalize).toHaveBeenCalledTimes(1);
    const [event, ctx] = hookMocks.runBeforeAgentFinalize.mock.calls[0];
    expect(event).toMatchObject({
      runId: "run-settled",
      lastAssistantMessage: "Built: the plugin is ready.",
      stopHookActive: false,
    });
    expect(Array.isArray(event.messages)).toBe(true);
    expect(ctx).toMatchObject({ runId: "run-settled" });
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

  it("delivers the answer when the hooks accept it", async () => {
    backendMocks.finalize.mockResolvedValueOnce(finalizationReply("answered", "Done."));
    hookMocks.runBeforeAgentFinalize.mockResolvedValueOnce({ action: "continue" });

    const input = finalizationInput();
    const finalized = await finalize(input);

    expect(hookMocks.runBeforeAgentFinalize).toHaveBeenCalledTimes(1);
    expect(finalized.attempt.beforeAgentFinalizeRevisionReason).toBeUndefined();
    const resolved = await resolveEmbeddedRunTerminal(terminalInputOf(input, finalized));
    expect(resolved.action).toBe("complete");
    assert(resolved.action === "complete", "Expected a completed run");
    expect(resolved.result.payloads?.[0]?.text).toBe("Done.");
  });

  it("runs no hook once the run revision budget is spent", async () => {
    backendMocks.finalize.mockResolvedValueOnce(finalizationReply("answered", "Done."));
    const input = finalizationInput();
    input.finalization.preparedAttempt.maxBeforeAgentFinalizeRevisions = 3;
    input.finalization.preparedAttempt.beforeAgentFinalizeRevisionAttempts = 3;

    const finalized = await finalize(input);

    expect(hookMocks.runBeforeAgentFinalize).not.toHaveBeenCalled();
    expect(finalized.attempt.beforeAgentFinalizeRevisionReason).toBeUndefined();
  });

  it("runs no hook when the finalizer produced no answer", async () => {
    backendMocks.finalize.mockResolvedValue(finalizationReply("empty"));

    const finalized = await finalize(finalizationInput());

    expect(finalized.finalizationOutcome).not.toBe("answered");
    expect(hookMocks.runBeforeAgentFinalize).not.toHaveBeenCalled();
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
