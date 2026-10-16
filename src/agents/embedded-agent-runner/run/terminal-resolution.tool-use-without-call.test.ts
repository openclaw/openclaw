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

  it("retries once before returning a fallback-eligible failure without a candidate notice", async () => {
    const turn = toolUseStopWithoutCall();
    // Delivery hides the markup; the original assistant still drives incomplete-call detection.
    expect(turn.payloadsWithToolMedia).toEqual([expect.objectContaining({ text: "exec" })]);
    const activateInternalPrompt = vi.fn();

    await expect(
      resolveEmbeddedRunTerminal(
        makeTerminalInput({ ...turn, sessionPromptState: { activateInternalPrompt } }),
      ),
    ).resolves.toEqual({ action: "retry" });

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
    expect(exhausted.result.meta.error).toMatchObject({
      kind: "incomplete_turn",
      fallbackSafe: true,
    });
    expect(exhausted.result.payloads).toBeUndefined();
    expect(exhausted.result.meta.terminalReply).toEqual({ disposition: "empty" });
  });

  it.each(["toolUse", "length"] as const)(
    "preserves recovery or failure for %s-stopped NO_REPLY without a tool call",
    async (stopReason) => {
      const assistant = buildEmbeddedRunnerAssistant({
        stopReason,
        content: [{ type: "text", text: "NO_REPLY" }],
      });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      });
      const input = makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        runParams: {
          messageChannel: "telegram",
          sessionKey: "agent:main:telegram:direct:user",
        },
        payloadsWithToolMedia: buildEmbeddedRunPayloads({
          assistantTexts: attempt.assistantTexts,
          lastAssistant: assistant,
          currentAssistant: assistant,
          sessionKey: "agent:main:telegram:direct:user",
        }),
      });

      let resolved = await resolveEmbeddedRunTerminal(input);
      if (stopReason === "toolUse") {
        // Unlike a structured call or pending work, this malformed stop ran nothing.
        expect(resolved).toEqual({ action: "retry" });
        expect(input.sessionPromptState.activateInternalPrompt).toHaveBeenCalledOnce();
        resolved = await resolveEmbeddedRunTerminal(input);
      }

      expect(resolved.action).toBe("complete");
      if (resolved.action !== "complete") {
        throw new Error("expected an incomplete-turn result");
      }
      expect(resolved.result.meta.error).toMatchObject({ kind: "incomplete_turn" });
      expect(resolved.result.meta.stopReason).toBe("error");
      expect(resolved.result.sourceReplyDeliveryState).toBe("missing");
      if (stopReason === "toolUse") {
        expect(resolved.result.meta.terminalReply).toEqual({ disposition: "empty" });
        expect(resolved.result.payloads).toBeUndefined();
      } else {
        expect(resolved.result.meta.terminalReply?.disposition).toBe("visible");
        expect(resolved.result.payloads).toEqual([
          expect.objectContaining({ text: expect.any(String), isError: true }),
        ]);
        expect(resolved.result.payloads?.[0]?.text).not.toBe("NO_REPLY");
      }
    },
  );
});
