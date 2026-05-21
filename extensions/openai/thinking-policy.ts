import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

const OPENAI_THINKING_BASE_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
] as const satisfies ProviderThinkingProfile["levels"];

const OPENAI_XHIGH_MODEL_IDS = [
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.2",
] as const;

const OPENAI_CODEX_XHIGH_MODEL_IDS = ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro"] as const;

function normalizeModelId(value: string): string {
  return value.trim().toLowerCase();
}

function matchesExactOrPrefix(id: string, values: readonly string[]): boolean {
  const normalizedId = normalizeModelId(id);
  return values.some((value) => {
    const normalizedValue = normalizeModelId(value);
    return normalizedId === normalizedValue || normalizedId.startsWith(normalizedValue);
  });
}

const OPENAI_REASONING_MODEL_PREFIXES = [
  "gpt-5.3-codex",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5-codex",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
  "o1",
  "o3",
  "o4",
] as const;

function isOpenAIReasoningModelId(modelId: string): boolean {
  const normalizedId = normalizeModelId(modelId);
  return normalizedId === "gpt-5" ||
    matchesExactOrPrefix(normalizedId, OPENAI_REASONING_MODEL_PREFIXES);
}

function buildOpenAIThinkingProfile(params: {
  modelId: string;
  xhighModelIds: readonly string[];
}): ProviderThinkingProfile {
  const overridesCatalogReasoning = isOpenAIReasoningModelId(params.modelId);
  return {
    levels: [
      ...OPENAI_THINKING_BASE_LEVELS,
      ...(matchesExactOrPrefix(params.modelId, params.xhighModelIds)
        ? [{ id: "xhigh" as const }]
        : []),
    ],
    ...(overridesCatalogReasoning ? { overridesCatalogReasoning } : {}),
  };
}

export function resolveOpenAIThinkingProfile(modelId: string): ProviderThinkingProfile {
  return buildOpenAIThinkingProfile({ modelId, xhighModelIds: OPENAI_XHIGH_MODEL_IDS });
}

export function resolveOpenAICodexThinkingProfile(modelId: string): ProviderThinkingProfile {
  return buildOpenAIThinkingProfile({ modelId, xhighModelIds: OPENAI_CODEX_XHIGH_MODEL_IDS });
}
