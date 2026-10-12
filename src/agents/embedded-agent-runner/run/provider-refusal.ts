import { readProviderRefusalReview } from "@openclaw/llm-core/diagnostics";
import { readStringField } from "@openclaw/normalization-core/record-coerce";
import type { AssistantMessage } from "../../../llm/types.js";
import type { EmbeddedAgentMeta } from "../types.js";

export function resolveProviderRefusal(
  message: AssistantMessage | undefined,
): EmbeddedAgentMeta["providerRefusal"] {
  const refusal = message?.diagnostics?.find(
    (diagnostic) => diagnostic.type === "provider_refusal",
  );
  if (!refusal) {
    return undefined;
  }
  const provider = readStringField(refusal.details, "provider");
  const category = readStringField(refusal.details, "category");
  if (!provider && !category) {
    return undefined;
  }
  const review = readProviderRefusalReview(refusal.details?.review);
  const nativeThreadId = readStringField(refusal.details, "nativeThreadId");
  const nativeTurnId = readStringField(refusal.details, "nativeTurnId");
  return {
    provider,
    category,
    ...(review ? { review } : {}),
    ...(nativeThreadId ? { nativeThreadId } : {}),
    ...(nativeTurnId ? { nativeTurnId } : {}),
  };
}
