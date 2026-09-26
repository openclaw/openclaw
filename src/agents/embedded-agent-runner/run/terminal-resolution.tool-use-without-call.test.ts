import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput, type TerminalInput } from "./terminal-resolution.test-support.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

const TOOL_USE_WITHOUT_CALL_RETRY_INSTRUCTION =
  "The previous assistant turn stopped for tool use but contained no tool call, so nothing ran. Continue from the current state: call the tool you need through the tool interface instead of writing the call as text, or produce the visible answer now. Do not restart from scratch.";
const PSEUDO_TOOL_CALL_TEXT =
  'exec\n<invoke name="read">\n<parameter name="path">~/skills/example/SKILL.md</parameter>\n</invoke>';

// The reported turn: thinking plus a tool call written as text, stopped for tool
// use without a structured call (#138929).
function toolUseStopWithoutCall(overrides: Parameters<typeof makeEmbeddedRunnerAttempt>[0] = {}) {
  const assistant = buildEmbeddedRunnerAssistant({
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5",
    stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: "Load the skill first.", thinkingSignature: "sig_pseudo_call" },
      { type: "text", text: PSEUDO_TOOL_CALL_TEXT },
    ],
  });
  const attempt = makeEmbeddedRunnerAttempt({
    assistantTexts: [PSEUDO_TOOL_CALL_TEXT],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    ...overrides,
  });
  return {
    attempt,
    attemptAssistant: assistant,
    activeErrorContext: { provider: "anthropic", model: "claude-sonnet-5" },
    modelApi: "anthropic-messages",
    payloadsWithToolMedia: buildEmbeddedRunPayloads({
      assistantTexts: attempt.assistantTexts,
      lastAssistant: assistant,
      currentAssistant: assistant,
      sessionKey: "session:tool-use-without-call",
    }),
  } satisfies Partial<TerminalInput>;
}

describe("terminal resolution for a tool-use stop without a tool call", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retries once before surfacing the incomplete-turn warning", async () => {
    const turn = toolUseStopWithoutCall();
    // The written call survives payload preparation as an undelivered reply.
    expect(turn.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: PSEUDO_TOOL_CALL_TEXT }),
    ]);
    const activateInternalPrompt = vi.fn();

    await expect(
      resolveEmbeddedRunTerminal(makeTerminalInput({ ...turn, activateInternalPrompt })),
    ).resolves.toEqual({ action: "retry" });
    expect(activateInternalPrompt).toHaveBeenCalledWith(TOOL_USE_WITHOUT_CALL_RETRY_INSTRUCTION);

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
    expect(exhausted.result.payloads).toEqual([
      { text: "⚠️ Agent couldn't generate a response. Please try again.", isError: true },
    ]);
  });

  it.each([
    { name: "a tool ran", overrides: { toolMetas: [{ toolName: "read", meta: "path=a.md" }] } },
    {
      name: "the attempt had side effects",
      overrides: {
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      },
    },
  ])("does not retry after $name", async ({ overrides }) => {
    const activateInternalPrompt = vi.fn();
    const result = await resolveEmbeddedRunTerminal(
      makeTerminalInput({ ...toolUseStopWithoutCall(overrides), activateInternalPrompt }),
    );

    expect(result.action).toBe("complete");
    expect(activateInternalPrompt).not.toHaveBeenCalled();
  });
});
