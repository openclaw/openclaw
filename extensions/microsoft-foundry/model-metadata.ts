import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { FoundryProviderApi } from "./shared.js";

export function normalizeFoundryModelName(value?: string | null): string | undefined {
  const trimmed = normalizeLowercaseStringOrEmpty(value);
  return trimmed || undefined;
}

function isFoundryGpt6Model(normalized: string | undefined): boolean {
  return normalized !== undefined && /^gpt-6-(?:astra|sol|luna)$/u.test(normalized);
}

export function resolveFoundryOpenAIModelTokenLimits(
  normalized: string | undefined,
): { contextWindow: number; maxTokens: number } | undefined {
  if (!normalized) {
    return undefined;
  }
  // Foundry publishes provider-native capacities. Keep exact families here so
  // older GPT and continuously updated chat models retain their separate caps.
  if (
    isFoundryGpt6Model(normalized) ||
    /^gpt-5\.(?:4(?:-pro)?|5|6(?:-(?:sol|terra|luna))?)$/u.test(normalized)
  ) {
    return { contextWindow: 1_050_000, maxTokens: 128_000 };
  }
  if (/^gpt-5\.4-(?:mini|nano)$/u.test(normalized)) {
    return { contextWindow: 400_000, maxTokens: 128_000 };
  }
  return undefined;
}

export function requiresFoundryMaxCompletionTokens(value?: string | null): boolean {
  const normalized = normalizeFoundryModelName(value);
  if (!normalized) {
    return false;
  }
  return (
    isFoundryGpt6Model(normalized) ||
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  );
}

export function supportsFoundryReasoningEffort(value?: string | null): boolean {
  const normalized = normalizeFoundryModelName(value);
  if (
    !normalized ||
    /^gpt-5-chat(?:-|$)/u.test(normalized) ||
    /^o1-mini(?:-|$)/u.test(normalized)
  ) {
    return false;
  }
  return (
    isFoundryGpt6Model(normalized) ||
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  );
}

export function resolveFoundryReasoningEfforts(
  value: string | null | undefined,
  api: FoundryProviderApi,
): string[] | undefined {
  const normalized = normalizeFoundryModelName(value);
  if (!normalized || !supportsFoundryReasoningEffort(normalized)) {
    return undefined;
  }
  if (isFoundryGpt6Model(normalized)) {
    // Astra deployments can reject `none`; omit effort for off instead.
    // Foundry supports max effort only on the Responses API.
    return [
      ...(normalized === "gpt-6-astra" ? [] : ["none"]),
      "low",
      "medium",
      "high",
      "xhigh",
      ...(api === "openai-responses" ? ["max"] : []),
    ];
  }
  if (normalized === "gpt-5.1-codex-max") {
    return ["none", "medium", "high", "xhigh"];
  }
  if (normalized === "gpt-5-pro") {
    return ["high"];
  }
  if (/^gpt-5\.[2-9](?:\.|-|$)/u.test(normalized)) {
    return ["none", "low", "medium", "high"];
  }
  if (/^gpt-5\.1(?:-|$)/u.test(normalized)) {
    return ["none", "low", "medium", "high"];
  }
  if (/^gpt-5-codex(?:-|$)/u.test(normalized)) {
    return ["low", "medium", "high"];
  }
  if (/^gpt-5(?:-|$)/u.test(normalized)) {
    return ["minimal", "low", "medium", "high"];
  }
  return ["low", "medium", "high"];
}

export function buildFoundryThinkingLevelMap(
  efforts: string[] | undefined,
  modelName: string,
): Record<string, string | null> | undefined {
  if (!efforts) {
    return undefined;
  }
  const supported = new Set(efforts);
  return {
    off: supported.has("none") ? "none" : null,
    minimal: supported.has("minimal")
      ? "minimal"
      : isFoundryGpt6Model(normalizeFoundryModelName(modelName))
        ? "low"
        : null,
    low: supported.has("low") ? "low" : null,
    medium: supported.has("medium") ? "medium" : null,
    high: supported.has("high") ? "high" : null,
    xhigh: supported.has("xhigh") ? "xhigh" : null,
    max: supported.has("max") ? "max" : null,
  };
}
