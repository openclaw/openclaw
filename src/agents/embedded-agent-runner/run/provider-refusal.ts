import { readProviderRefusalReview } from "@openclaw/llm-core/diagnostics";
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
  const provider =
    typeof refusal.details?.provider === "string" ? refusal.details.provider : undefined;
  const category =
    typeof refusal.details?.category === "string" ? refusal.details.category : undefined;
  if (!provider && !category) {
    return undefined;
  }
  const review = readProviderRefusalReview(refusal.details?.review);
  const nativeThreadId =
    typeof refusal.details?.nativeThreadId === "string"
      ? refusal.details.nativeThreadId
      : undefined;
  const nativeTurnId =
    typeof refusal.details?.nativeTurnId === "string" ? refusal.details.nativeTurnId : undefined;
  return {
    provider,
    category,
    ...(review ? { review } : {}),
    ...(nativeThreadId ? { nativeThreadId } : {}),
    ...(nativeTurnId ? { nativeTurnId } : {}),
  };
}
