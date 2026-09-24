/** Explicit model reasoning-effort compatibility metadata. */
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";

/** Minimal model fields needed to resolve OpenAI reasoning effort compatibility. */
type OpenAIReasoningCompatModel = {
  provider?: string | null;
  id?: string | null;
  compat?: unknown;
};

// Provider metadata can remap reasoning effort names. Keep only string pairs so
// malformed compat data cannot poison request parameters.
function readCompatReasoningEffortMap(compat: unknown): Record<string, string> {
  const rawMap = asOptionalObjectRecord(asOptionalObjectRecord(compat)?.reasoningEffortMap);
  if (!rawMap) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(rawMap).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** Resolves the reasoning effort remap for an OpenAI-compatible model. */
export function resolveOpenAIReasoningEffortMap(
  model: OpenAIReasoningCompatModel,
  fallbackMap: Record<string, string> = {},
): Record<string, string> {
  return {
    ...fallbackMap,
    ...readCompatReasoningEffortMap(model.compat),
  };
}
