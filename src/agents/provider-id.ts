import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export function normalizeProviderId(provider: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(provider);
  if (normalized === "modelstudio" || normalized === "qwencloud") {
    return "qwen";
  }
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  if (normalized === "opencode-zen") {
    return "opencode";
  }
  if (normalized === "opencode-go-auth") {
    return "opencode-go";
  }
  if (normalized === "kimi" || normalized === "kimi-code" || normalized === "kimi-coding") {
    return "kimi";
  }
  if (normalized === "bedrock" || normalized === "aws-bedrock") {
    return "amazon-bedrock";
  }
  // Backward compatibility for older provider naming.
  if (normalized === "bytedance" || normalized === "doubao") {
    return "volcengine";
  }
  return normalized;
}

/**
 * Normalize provider IDs for catalog-family matching.
 *
 * Keep this separate from `normalizeProviderId()`: plan variants remain distinct
 * provider identities in the wider runtime, but they should match their base
 * providers when a surface is selecting catalog rows for a configured provider.
 */
export function normalizeProviderCatalogFamilyId(provider: string): string {
  const normalized = normalizeProviderId(provider);
  if (normalized === "volcengine-plan") {
    return "volcengine";
  }
  if (normalized === "byteplus-plan") {
    return "byteplus";
  }
  return normalized;
}

/** Normalize provider ID before manifest-owned auth alias lookup. */
export function normalizeProviderIdForAuth(provider: string): string {
  return normalizeProviderId(provider);
}

export function findNormalizedProviderValue<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): T | undefined {
  if (!entries) {
    return undefined;
  }
  const providerKey = normalizeProviderId(provider);
  for (const [key, value] of Object.entries(entries)) {
    if (normalizeProviderId(key) === providerKey) {
      return value;
    }
  }
  return undefined;
}

export function findNormalizedProviderKey(
  entries: Record<string, unknown> | undefined,
  provider: string,
): string | undefined {
  if (!entries) {
    return undefined;
  }
  const providerKey = normalizeProviderId(provider);
  return Object.keys(entries).find((key) => normalizeProviderId(key) === providerKey);
}
