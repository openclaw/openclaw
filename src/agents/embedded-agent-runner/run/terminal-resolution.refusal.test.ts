import { expect, it } from "vitest";
import { PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE } from "../../../llm/types.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { emptyAssistant, makeTerminalInput } from "./terminal-resolution.test-support.js";

const providerReplay = {
  v: 1,
  type: "anthropic-compaction",
  data: "summary",
  provider: "anthropic",
  api: "anthropic-messages",
  model: "claude-sonnet-4-6",
  baseUrlHash: "route-a",
} as const;

function refusalInput(
  assistant: ReturnType<typeof emptyAssistant>,
  lastAssistant?: ReturnType<typeof emptyAssistant>,
) {
  return makeTerminalInput({
    assistant,
    attemptOverrides: {
      assistantTexts: [],
      lastAssistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    },
    retryState: { emptyResponseAttempts: 1 },
  });
}

it.each(["prior turn", "current attempt"])(
  "resolves server compaction with a refusal in %s",
  async (refusalOwner) => {
    const refusal = emptyAssistant({
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-sonnet-4-6",
      stopReason: "error",
      diagnostics: [
        {
          type: "provider_refusal",
          timestamp: 0,
          details: { provider: "anthropic", category: "cyber" },
        },
      ],
    });
    const assistant = emptyAssistant({
      ...refusal,
      stopReason: refusalOwner === "current attempt" ? "error" : "stop",
      diagnostics: refusalOwner === "current attempt" ? refusal.diagnostics : undefined,
      providerReplay,
    });
    const input = refusalInput(assistant, refusalOwner === "prior turn" ? refusal : assistant);
    const resolved = await resolveEmbeddedRunTerminal(input);

    if (refusalOwner === "current attempt") {
      expect(resolved).toMatchObject({
        action: "complete",
        result: {
          meta: { error: { kind: "incomplete_turn", fallbackSafe: false } },
          payloads: [
            {
              isError: true,
              text: "The provider refused this request (category: cyber). Revise the request and try again.",
            },
          ],
        },
      });
    } else {
      expect(resolved).toEqual({ action: "retry" });
    }
    const continuations = refusalOwner === "current attempt" ? 0 : 1;
    expect(input.retryState.compactionContinuationAttempts).toBe(continuations);
    expect(input.armPostCompactionGuard).toHaveBeenCalledTimes(continuations);
  },
);

it.each([false, true])("resolves incomplete turns with fallbackSafe=%s", async (fallbackSafe) => {
  const assistant = emptyAssistant(
    fallbackSafe
      ? { stopReason: "length" }
      : {
          stopReason: "error",
          errorCode: PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
          providerReplay,
        },
  );
  const priorRefusal = fallbackSafe
    ? emptyAssistant({
        stopReason: "error",
        diagnostics: [{ type: "provider_refusal", timestamp: 0, details: { provider: "openai" } }],
      })
    : undefined;
  const input = refusalInput(assistant, priorRefusal);
  expect(await resolveEmbeddedRunTerminal(input)).toMatchObject({
    action: "complete",
    result: { meta: { error: { kind: "incomplete_turn", fallbackSafe } } },
  });
  expect(input.armPostCompactionGuard).not.toHaveBeenCalled();
});
