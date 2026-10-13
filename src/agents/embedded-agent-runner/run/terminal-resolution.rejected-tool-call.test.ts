import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput, type TerminalInput } from "./terminal-resolution.test-support.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

// mock-isolation: terminal recovery must not update persistent auth-profile state.
vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

const REJECTED_TOOL_CALL_MESSAGE = "Provider returned an incomplete or malformed tool call";

// The reported turn: an exec call completed, then the provider streamed a second
// call whose arguments were not valid JSON. The transport removed that call
// before dispatch and ended the turn with stopReason=error.
function rejectedCallAfterSettledTool(
  overrides: Parameters<typeof makeEmbeddedRunnerAttempt>[0] = {},
  assistantOverrides: Parameters<typeof buildEmbeddedRunnerAssistant>[0] = {},
) {
  const assistant = buildEmbeddedRunnerAssistant({
    api: "openai-completions",
    provider: "meterkey",
    model: "deepseek/deepseek-v4-flash",
    stopReason: "error",
    errorMessage: REJECTED_TOOL_CALL_MESSAGE,
    content: [],
    ...assistantOverrides,
  });
  const attempt = makeEmbeddedRunnerAttempt({
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    toolMetas: [{ toolName: "exec", toolCallId: "call_exec", meta: "git log" }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    ...overrides,
  });
  return {
    attempt,
    attemptAssistant: assistant,
    activeErrorContext: { provider: "meterkey", model: "deepseek/deepseek-v4-flash" },
    modelApi: "openai-completions",
    payloadsWithToolMedia: buildEmbeddedRunPayloads({
      assistantTexts: attempt.assistantTexts,
      lastAssistant: assistant,
      currentAssistant: assistant,
      sessionKey: "session:rejected-tool-call",
    }),
  } satisfies Partial<TerminalInput>;
}

describe("terminal resolution for a tool call rejected before dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("continues once after settled tools instead of replaying the attempt", async () => {
    const turn = rejectedCallAfterSettledTool();
    // The completed exec makes the attempt unsafe to replay.
    expect(turn.attempt.replayMetadata.hadPotentialSideEffects).toBe(true);
    const activateInternalPrompt = vi.fn();

    await expect(
      resolveEmbeddedRunTerminal(
        makeTerminalInput({ ...turn, sessionPromptState: { activateInternalPrompt } }),
      ),
    ).resolves.toEqual({ action: "retry" });
    expect(activateInternalPrompt).toHaveBeenCalledOnce();
    const instruction = activateInternalPrompt.mock.calls[0]?.[0] as string;
    expect(instruction).toContain("rejected before it ran");
    expect(instruction).toContain("Do not repeat completed tool calls");

    const exhausted = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        ...turn,
        retryState: { ...createEmbeddedRunTerminalRetryState(), emptyResponseAttempts: 1 },
      }),
    );
    expect(exhausted.action).toBe("complete");
    if (exhausted.action !== "complete") {
      return;
    }
    expect(exhausted.result.meta.error).toMatchObject({ kind: "incomplete_turn" });
  });

  it("also covers the malformed-arguments error code", async () => {
    const activateInternalPrompt = vi.fn();
    await expect(
      resolveEmbeddedRunTerminal(
        makeTerminalInput({
          ...rejectedCallAfterSettledTool(
            {},
            {
              errorMessage: "Provider completed tool call with malformed JSON arguments",
              errorCode: "malformed_tool_call_arguments",
            },
          ),
          sessionPromptState: { activateInternalPrompt },
        }),
      ),
    ).resolves.toEqual({ action: "retry" });
  });

  it("does not continue after an unrelated provider error", async () => {
    const overrides = {};
    const assistant = { errorMessage: "upstream connect error" };
    const activateInternalPrompt = vi.fn();
    const result = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        ...rejectedCallAfterSettledTool(overrides, assistant),
        sessionPromptState: { activateInternalPrompt },
      }),
    );

    expect(result.action).toBe("complete");
    expect(activateInternalPrompt).not.toHaveBeenCalled();
  });
});

// The reported turn: an exec call was refused by the exec preflight before it
// ran (recorded as lastToolError for exec), the model reacted with a new call,
// and that call streamed with malformed JSON arguments. The failed result is
// already in the transcript and the rejected call never ran, so the bounded
// continuation must still fire.
function buildRejectedAssistant(
  assistantOverrides: Parameters<typeof buildEmbeddedRunnerAssistant>[0] = {},
) {
  return buildEmbeddedRunnerAssistant({
    api: "openai-completions",
    provider: "meterkey",
    model: "deepseek/deepseek-v4-flash",
    stopReason: "error",
    errorMessage: "Provider completed tool call with malformed JSON arguments",
    errorCode: "malformed_tool_call_arguments",
    content: [],
    ...assistantOverrides,
  });
}

function rejectedCallAfterFailedTool(
  overrides: Parameters<typeof makeEmbeddedRunnerAttempt>[0] = {},
  assistantOverrides: Parameters<typeof buildEmbeddedRunnerAssistant>[0] = {},
) {
  const failedBatchAssistant = buildEmbeddedRunnerAssistant({
    api: "openai-completions",
    provider: "meterkey",
    model: "deepseek/deepseek-v4-flash",
    stopReason: "toolUse",
    content: [
      {
        type: "toolCall",
        id: "call_exec",
        name: "exec",
        arguments: { command: "python -c '...'" },
      },
    ],
  });
  const rejectedAssistant = buildRejectedAssistant(assistantOverrides);
  const attempt = makeEmbeddedRunnerAttempt({
    assistantTexts: [],
    lastAssistant: rejectedAssistant,
    currentAttemptAssistant: rejectedAssistant,
    toolMetas: [
      { toolName: "exec", toolCallId: "call_exec", meta: "python -c ...", isError: true },
    ],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    lastToolError: {
      toolName: "exec",
      executionStarted: false,
      meta: "python -c ...",
      error:
        "exec preflight: complex interpreter invocation detected; refusing to run without script preflight validation",
    },
    messagesSnapshot: [
      { role: "user", content: "Clean up the interpreter workbench.", timestamp: 1 } as never,
      failedBatchAssistant,
      { role: "toolResult", toolCallId: "call_exec", toolName: "exec", isError: true } as never,
      rejectedAssistant,
    ],
    ...overrides,
  });
  return {
    attempt,
    attemptAssistant: rejectedAssistant,
    activeErrorContext: { provider: "meterkey", model: "deepseek/deepseek-v4-flash" },
    modelApi: "openai-completions",
    payloadsWithToolMedia: buildEmbeddedRunPayloads({
      assistantTexts: attempt.assistantTexts,
      lastAssistant: rejectedAssistant,
      currentAssistant: rejectedAssistant,
      sessionKey: "session:rejected-tool-call",
    }),
  } satisfies Partial<TerminalInput>;
}

describe("terminal resolution for a rejected call after a same-turn tool failure", () => {
  beforeEach(() => vi.clearAllMocks());

  it("continues once when the retained error is the settled failure the model already saw", async () => {
    const turn = rejectedCallAfterFailedTool();
    const activateInternalPrompt = vi.fn();

    await expect(
      resolveEmbeddedRunTerminal(
        makeTerminalInput({ ...turn, sessionPromptState: { activateInternalPrompt } }),
      ),
    ).resolves.toEqual({ action: "retry" });
    expect(activateInternalPrompt).toHaveBeenCalledOnce();
    const instruction = activateInternalPrompt.mock.calls[0]?.[0] as string;
    expect(instruction).toContain("rejected before it ran");
    expect(instruction).toContain("Do not repeat completed tool calls");

    const exhausted = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        ...turn,
        retryState: { ...createEmbeddedRunTerminalRetryState(), emptyResponseAttempts: 1 },
      }),
    );
    expect(exhausted.action).toBe("complete");
    if (exhausted.action !== "complete") {
      return;
    }
    expect(exhausted.result.meta.error).toMatchObject({ kind: "incomplete_turn" });
  });

  it("continues when the retained error is stale from an earlier batch that other tools settled", async () => {
    const staleBatchAssistant = buildEmbeddedRunnerAssistant({
      api: "openai-completions",
      provider: "meterkey",
      model: "deepseek/deepseek-v4-flash",
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "call_read", name: "read", arguments: { path: "notes.txt" } },
      ],
    });
    const turn = rejectedCallAfterFailedTool({
      toolMetas: [
        { toolName: "exec", toolCallId: "call_exec", meta: "python -c ...", isError: true },
        { toolName: "read", toolCallId: "call_read", isError: false },
      ],
      itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
      messagesSnapshot: [
        { role: "user", content: "Clean up the interpreter workbench.", timestamp: 1 } as never,
        buildEmbeddedRunnerAssistant({
          api: "openai-completions",
          provider: "meterkey",
          model: "deepseek/deepseek-v4-flash",
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "call_exec",
              name: "exec",
              arguments: { command: "python -c '...'" },
            },
          ],
        }),
        { role: "toolResult", toolCallId: "call_exec", toolName: "exec", isError: true } as never,
        staleBatchAssistant,
        {
          role: "toolResult",
          toolCallId: "call_read",
          toolName: "read",
          isError: false,
        } as never,
        buildRejectedAssistant(),
      ],
    });
    const activateInternalPrompt = vi.fn();
    await expect(
      resolveEmbeddedRunTerminal(
        makeTerminalInput({ ...turn, sessionPromptState: { activateInternalPrompt } }),
      ),
    ).resolves.toEqual({ action: "retry" });
    expect(activateInternalPrompt).toHaveBeenCalledOnce();
  });

  it("does not continue when the retained error cannot be attributed to a settled batch", async () => {
    const turn = rejectedCallAfterFailedTool({ messagesSnapshot: [] });
    const activateInternalPrompt = vi.fn();
    const result = await resolveEmbeddedRunTerminal(
      makeTerminalInput({ ...turn, sessionPromptState: { activateInternalPrompt } }),
    );

    expect(result.action).toBe("complete");
    expect(activateInternalPrompt).not.toHaveBeenCalled();
  });
});
