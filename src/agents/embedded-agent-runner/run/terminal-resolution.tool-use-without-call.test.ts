import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEmbeddedRunnerAssistant } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import {
  textAssistant,
  assistantAttempt,
  expectComplete,
  makeTerminalInput,
  type TerminalInput,
} from "./terminal-resolution.test-support.js";

vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

const PSEUDO_TOOL_CALL_TEXT =
  'exec\n<invoke name="read">\n<parameter name="path">~/skills/example/SKILL.md</parameter>\n</invoke>';

// #138929: thinking plus a textual invocation stopped without a structured call.
function toolUseStopWithoutCall(
  assistant = buildEmbeddedRunnerAssistant({
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5",
    stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: "Load the skill first.", thinkingSignature: "sig_pseudo_call" },
      { type: "text", text: PSEUDO_TOOL_CALL_TEXT },
    ],
  }),
  sessionKey = "session:tool-use-without-call",
) {
  const text = assistant.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  const attempt = assistantAttempt(assistant, {
    assistantTexts: text,
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
  });
  return {
    attempt,
    attemptAssistant: assistant,
    payloadsWithToolMedia: buildEmbeddedRunPayloads({
      assistantTexts: attempt.assistantTexts,
      lastAssistant: assistant,
      currentAssistant: assistant,
      sessionKey,
    }),
  } satisfies Partial<TerminalInput>;
}

describe("terminal resolution for a tool-use stop without a tool call", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["pseudo", "toolUse", "length"] as const)("recovers %s", async (kind) => {
    const pseudo = kind === "pseudo";
    const sessionKey = "agent:main:telegram:direct:user";
    const turn = pseudo
      ? {
          ...toolUseStopWithoutCall(),
          activeErrorContext: { provider: "anthropic", model: "claude-sonnet-5" },
          modelApi: "anthropic-messages",
        }
      : {
          ...toolUseStopWithoutCall(textAssistant("NO_REPLY", { stopReason: kind }), sessionKey),
          runParams: { messageChannel: "telegram", sessionKey },
        };
    if (pseudo) {
      // Delivery hides markup; the original message still drives malformed-call recovery.
      expect(turn.payloadsWithToolMedia).toEqual([expect.objectContaining({ text: "exec" })]);
    }
    const input = makeTerminalInput(turn);
    let resolved = await resolveEmbeddedRunTerminal(input);
    if (kind !== "length") {
      expect(resolved).toEqual({ action: "retry" });
      expect(input.sessionPromptState.activateInternalPrompt).toHaveBeenCalledOnce();
      resolved = await resolveEmbeddedRunTerminal(input);
    }
    expectComplete(resolved);
    expect(resolved.result.meta.error).toMatchObject({
      kind: "incomplete_turn",
      ...(pseudo ? { fallbackSafe: true } : {}),
    });
    if (!pseudo) {
      expect(resolved.result.meta.stopReason).toBe("error");
      expect(resolved.result.sourceReplyDeliveryState).toBe("missing");
    }
    if (kind !== "length") {
      expect(resolved.result.meta.terminalReply).toEqual({ disposition: "empty" });
      expect(resolved.result.payloads).toBeUndefined();
    } else {
      expect(resolved.result.meta.terminalReply?.disposition).toBe("visible");
      expect(resolved.result.payloads).toEqual([
        expect.objectContaining({ text: expect.any(String), isError: true }),
      ]);
      expect(resolved.result.payloads?.[0]?.text).not.toBe("NO_REPLY");
    }
  });
});
