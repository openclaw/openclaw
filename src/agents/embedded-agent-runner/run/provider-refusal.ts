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
  return provider || category ? { provider, category } : undefined;
}
