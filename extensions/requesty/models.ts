// Requesty plugin module implements model id normalization behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const REQUESTY_MODEL_PREFIX = "requesty/";

// Requesty routes to upstream models using the same `provider/model` id shape as
// the upstream vendors (e.g. `openai/gpt-4o`, `anthropic/claude-sonnet-4-5`). The
// bare `requesty/` qualifier is the OpenClaw provider prefix; strip it only when
// the remainder is still a namespaced upstream id, mirroring the OpenRouter rule.
export function normalizeRequestyApiModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  if (!normalized.startsWith(REQUESTY_MODEL_PREFIX)) {
    return normalized;
  }
  const unprefixed = normalized.slice(REQUESTY_MODEL_PREFIX.length);
  return unprefixed.includes("/") ? unprefixed : normalized;
}
