import { expect, it, vi } from "vitest";
import { emitToolResultMessage } from "../../../../packages/agent-core/src/agent-stream-response.js";
import { createToolExecutionErrorResult } from "../../../../packages/agent-core/src/tool-call-outcome.js";
import { validateScriptFileForShellBleed } from "../../bash-tools.exec-script-preflight.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import type { ToolErrorSummary } from "../../tool-error-summary.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput, type TerminalInput } from "./terminal-resolution.test-support.js";

// mock-isolation: terminal recovery must not update persistent auth-profile state.
vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

const execAssistant = (id: string) =>
  buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id, name: "exec", arguments: {} }],
  });

function rejectedCallAfterSettledTool(
  overrides: Parameters<typeof makeEmbeddedRunnerAttempt>[0] = {},
  assistantOverrides: Parameters<typeof buildEmbeddedRunnerAssistant>[0] = {},
) {
  const assistant = buildEmbeddedRunnerAssistant({
    api: "openai-completions",
    provider: "meterkey",
    model: "deepseek/deepseek-v4-flash",
    stopReason: "error",
    errorMessage: "Provider returned an incomplete or malformed tool call",
    ...assistantOverrides,
  });
  const attempt = makeEmbeddedRunnerAttempt({
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

async function refusedExecResult(toolCallId = "call_exec") {
  const result = await validateScriptFileForShellBleed({
    command: "cat bad.py | python",
    workdir: "/tmp",
  }).then(() => expect.fail("Expected script-preflight refusal"), createToolExecutionErrorResult);
  return emitToolResultMessage(
    {
      toolCall: { type: "toolCall", id: toolCallId, name: "exec", arguments: {} },
      result,
      isError: true,
    },
    () => undefined,
  );
}

async function refusedExecThenRejectedCall() {
  const failure: ToolErrorSummary = {
    toolName: "exec",
    executionStarted: false,
    mutatingAction: false,
  };
  const failedTool = {
    toolName: "exec",
    toolCallId: "call_exec",
    isError: true,
    asyncStarted: false,
  };
  const turn = rejectedCallAfterSettledTool(
    {
      lastToolError: failure,
      toolMetas: [failedTool],
    },
    {
      api: "anthropic-messages",
      provider: "anthropic",
      errorCode: "malformed_tool_call_arguments",
      errorMessage: "Provider completed tool call with malformed JSON arguments",
    },
  );
  const failedResult = await refusedExecResult();
  turn.attempt.messagesSnapshot = [
    { role: "user", content: "Inspect the workspace", timestamp: 0 },
    execAssistant("call_exec"),
    failedResult,
    turn.attemptAssistant,
  ];
  return { ...turn, failure, failedTool, failedResult, modelApi: "anthropic-messages" };
}

function terminalCase(turn: Partial<TerminalInput>) {
  const activateInternalPrompt = vi.fn();
  const input = makeTerminalInput({
    ...turn,
    sessionPromptState: { activateInternalPrompt },
  });
  return { activateInternalPrompt, resolve: () => resolveEmbeddedRunTerminal(input) };
}

function prependFailedExec(
  turn: Awaited<ReturnType<typeof refusedExecThenRejectedCall>>,
  result: Awaited<ReturnType<typeof refusedExecResult>>,
) {
  turn.attempt.messagesSnapshot.splice(1, 0, execAssistant(result.toolCallId), result);
  turn.attempt.toolMetas.unshift({
    toolName: "exec",
    toolCallId: result.toolCallId,
    isError: true,
  });
  turn.attempt.itemLifecycle = { startedCount: 2, completedCount: 2, activeCount: 0 };
}

const MALFORMED_ARGS = "Provider completed tool call with malformed JSON arguments";
it.each(["message", "error code", "gateway diagnostic", "exec refusal"])(
  "continues once after settled tools (%s)",
  async (shape) => {
    const refused = shape === "exec refusal";
    const turn = refused
      ? await refusedExecThenRejectedCall()
      : rejectedCallAfterSettledTool(
          {},
          shape === "message"
            ? {}
            : shape === "error code"
              ? { errorMessage: MALFORMED_ARGS, errorCode: "malformed_tool_call_arguments" }
              : { errorMessage: "Upstream returned invalid tool input for 'exec'." },
        );
    if (!refused) {
      expect(turn.attempt.replayMetadata.hadPotentialSideEffects).toBe(true);
    }
    const { resolve, activateInternalPrompt } = terminalCase(turn);
    await expect(resolve()).resolves.toEqual({ action: "retry" });
    if (refused) {
      expect(turn.attempt.lastToolError).toEqual({
        toolName: "exec",
        executionStarted: false,
        mutatingAction: false,
      });
    }
    expect(activateInternalPrompt).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Do not repeat completed tool calls"),
    );
    if (!refused) {
      expect(activateInternalPrompt.mock.calls[0]?.[0]).toContain("rejected before it ran");
    }
    await expect(resolve()).resolves.toMatchObject(
      refused
        ? { action: "complete" }
        : {
            action: "complete",
            result: { meta: { error: { kind: "incomplete_turn" } } },
          },
    );
    expect(activateInternalPrompt).toHaveBeenCalledOnce();
  },
);

it("continues once when the rejected call followed visible progress text", async () => {
  const turn = rejectedCallAfterSettledTool(
    {},
    {
      api: "openai-responses",
      provider: "minimax-tp",
      model: "MiniMax-M3.1-Flash",
      stopReason: "error",
      errorCode: "malformed_tool_call_arguments",
      errorMessage: "Responses stream completed tool call with invalid JSON arguments",
      content: [{ type: "text", text: "Progress: checking the weekly report." }],
    },
  );
  const { resolve, activateInternalPrompt } = terminalCase(turn);
  await expect(resolve()).resolves.toEqual({ action: "retry" });
  expect(activateInternalPrompt).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("do not repeat it"),
  );
});

it("continues after a consumed preflight refusal with visible progress text", async () => {
  const turn = await refusedExecThenRejectedCall();
  turn.attemptAssistant.content = [
    { type: "text", text: "Progress: retrying the inspection after the refusal." },
  ];
  const { resolve, activateInternalPrompt } = terminalCase(turn);
  await expect(resolve()).resolves.toEqual({ action: "retry" });
  expect(activateInternalPrompt).toHaveBeenCalledOnce();
});

it("continues after multiple consumed preflight refusals", async () => {
  const turn = await refusedExecThenRejectedCall();
  prependFailedExec(turn, await refusedExecResult("call_earlier"));

  await expect(terminalCase(turn).resolve()).resolves.toEqual({ action: "retry" });
});

it.each(
  Object.entries({
    started: ({ failure }) => Object.assign(failure, { executionStarted: true }),
    unknown: ({ failure }) => {
      delete failure.executionStarted;
    },
    "missing-result": ({ attempt }) => attempt.messagesSnapshot.splice(2, 1),
    unconsumed: ({ attempt, failedResult }) => {
      attempt.messagesSnapshot.splice(2, 1);
      attempt.messagesSnapshot.push(failedResult);
    },
    "prior-turn": ({ attempt }) =>
      attempt.messagesSnapshot.splice(3, 0, { role: "user", content: "New task", timestamp: 1 }),
    "different-tool": ({ failure }) => Object.assign(failure, { toolName: "write" }),
    active: ({ attempt }) => Object.assign(attempt.itemLifecycle, { activeCount: 1 }),
    async: ({ failedTool }) => Object.assign(failedTool, { asyncStarted: true }),
    "earlier-failure": (turn) =>
      prependFailedExec(turn, {
        role: "toolResult",
        toolCallId: "call_earlier",
        toolName: "exec",
        content: [{ type: "text", text: "Command failed after starting" }],
        isError: true,
        timestamp: 0,
      }),
  } satisfies Record<
    string,
    (turn: Awaited<ReturnType<typeof refusedExecThenRejectedCall>>) => unknown
  >),
)("does not continue a %s tool failure", async (_condition, alter) => {
  const turn = await refusedExecThenRejectedCall();
  alter(turn);
  const { resolve, activateInternalPrompt } = terminalCase(turn);
  const result = await resolve();
  expect(result.action).toBe("complete");
  expect(activateInternalPrompt).not.toHaveBeenCalled();
});

it("does not continue after an unrelated provider error", async () => {
  const { resolve, activateInternalPrompt } = terminalCase(
    rejectedCallAfterSettledTool({}, { errorMessage: "upstream connect error" }),
  );
  const result = await resolve();

  expect(result.action).toBe("complete");
  expect(activateInternalPrompt).not.toHaveBeenCalled();
});
