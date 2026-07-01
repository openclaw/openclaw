// Openai plugin module implements thinking policy behavior.
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

const OPENAI_THINKING_BASE_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
] as const satisfies ProviderThinkingProfile["levels"];

const OPENAI_CODEX_XHIGH_MODEL_IDS = [
  "gpt-5.6",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.3-codex-spark",
] as const;

const OPENAI_UNIFIED_XHIGH_MODEL_IDS = [
  ...OPENAI_CODEX_XHIGH_MODEL_IDS,
  "gpt-5.4-mini",
  "gpt-5.4-nano",
] as const;

const OPENAI_STALE_CATALOG_REASONING_MODEL_RE =
  /^gpt-5(?:\.\d+)?(?:$|-(?:mini|nano|pro|codex(?:-|$).*|\d{4}-\d{2}-\d{2}$))/u;
const OPENAI_STALE_CATALOG_O_SERIES_MODEL_RE = /^o(?:1|3|4)(?:-|$)/u;

function normalizeModelId(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("openai/") ? normalized.slice("openai/".length) : normalized;
}

function matchesExactOrPrefix(id: string, values: readonly string[]): boolean {
  const normalizedId = normalizeModelId(id);
  return values.some((value) => {
    const normalizedValue = normalizeModelId(value);
    return normalizedId === normalizedValue || normalizedId.startsWith(normalizedValue);
  });
}

function isOpenAIReasoningModelKnownDespiteStaleCatalog(modelId: string): boolean {
  const normalizedId = normalizeModelId(modelId);
  return (
    OPENAI_STALE_CATALOG_REASONING_MODEL_RE.test(normalizedId) ||
    OPENAI_STALE_CATALOG_O_SERIES_MODEL_RE.test(normalizedId)
  );
}

function buildOpenAIThinkingProfile(params: {
  modelId: string;
  xhighModelIds: readonly string[];
}): ProviderThinkingProfile {
  const supportsMax = normalizeModelId(params.modelId).startsWith("gpt-5.6");
  return {
    levels: [
      ...OPENAI_THINKING_BASE_LEVELS,
      ...(matchesExactOrPrefix(params.modelId, params.xhighModelIds)
        ? [{ id: "xhigh" as const }]
        : []),
      ...(supportsMax ? [{ id: "max" as const }] : []),
    ],
    ...(isOpenAIReasoningModelKnownDespiteStaleCatalog(params.modelId)
      ? { preserveWhenCatalogReasoningFalse: true }
      : {}),
  };
}

export function resolveOpenAICodexThinkingProfile(modelId: string): ProviderThinkingProfile {
  return buildOpenAIThinkingProfile({ modelId, xhighModelIds: OPENAI_CODEX_XHIGH_MODEL_IDS });
}

export function resolveUnifiedOpenAIThinkingProfile(modelId: string): ProviderThinkingProfile {
  return buildOpenAIThinkingProfile({ modelId, xhighModelIds: OPENAI_UNIFIED_XHIGH_MODEL_IDS });
}
