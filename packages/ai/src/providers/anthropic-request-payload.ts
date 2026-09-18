import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAnthropicContextManagementBetaHeader } from "../transports/anthropic-payload-policy.js";
import type { Model, StreamOptions } from "../types.js";
import { applyProviderPayloadHook } from "../utils/provider-payload.js";
import { applyClaudeRequestContract } from "./anthropic-model-contract.js";
import { applyAnthropicThinkingBindingControls } from "./anthropic-thinking-replay.js";

/** Both built-in adapters finish vendor normalization before final host admission. */
export async function finalizeAnthropicRequestPayload(
  payload: unknown,
  model: Model,
  onPayload: StreamOptions["onPayload"],
  directApiKeyBetaHeader: string | undefined,
) {
  let headers: Record<string, string> | undefined;
  const finalized = await applyProviderPayloadHook(onPayload, payload, model, (candidate) => {
    if (!isRecord(candidate)) {
      throw new Error("Anthropic requires an object request payload");
    }
    applyClaudeRequestContract(candidate, model);
    const betaHeader = resolveAnthropicContextManagementBetaHeader(
      candidate,
      directApiKeyBetaHeader,
    );
    headers =
      applyAnthropicThinkingBindingControls(candidate, betaHeader) ??
      (betaHeader ? { "anthropic-beta": betaHeader } : undefined);
    // Preserve ordinary hook replacement identity while making the stream flag
    // part of the admitted body, not a post-admission serializer rewrite.
    return { ...candidate, stream: true };
  });
  return { payload: finalized, headers };
}
