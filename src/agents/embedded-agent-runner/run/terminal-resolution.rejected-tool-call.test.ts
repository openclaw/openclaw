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

  it.each([
    {
      name: "no tool ran before the rejection",
      overrides: {
        toolMetas: [],
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
      },
      assistant: {},
    },
    {
      name: "a tool is still running",
      overrides: { itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 1 } },
      assistant: {},
    },
    {
      name: "a tool failed",
      overrides: { lastToolError: { toolName: "exec", error: "exit 1" } },
      assistant: {},
    },
    {
      name: "async work started",
      overrides: {
        toolMetas: [
          { toolName: "exec", toolCallId: "call_exec", meta: "git log", asyncStarted: true },
        ],
      },
      assistant: {},
    },
    {
      name: "the error is not a pre-dispatch tool-call rejection",
      overrides: {},
      assistant: { errorMessage: "upstream connect error" },
    },
    {
      name: "the model already wrote visible text",
      overrides: { assistantTexts: ["Generating the briefing now."] },
      assistant: { content: [{ type: "text" as const, text: "Generating the briefing now." }] },
    },
    {
      name: "the assistant still carries a tool call",
      overrides: {},
      assistant: {
        content: [{ type: "toolCall" as const, id: "call_2", name: "exec", arguments: {} }],
      },
    },
  ])("does not continue when $name", async ({ overrides, assistant }) => {
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
