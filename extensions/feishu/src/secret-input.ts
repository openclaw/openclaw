import * as feishuSdk from "openclaw/plugin-sdk/feishu";

const { buildSecretInputSchema, hasConfiguredSecretInput } = feishuSdk;
const hostNormalizeResolvedInputString = feishuSdk.normalizeResolvedSecretInputString;
const hostNormalizeInputString = feishuSdk.normalizeSecretInputString;

/**
 * Local fallback for normalizeSecretInputString when the host openclaw version
 * predates the export (added in 2026.3.2).
 */
function normalizeSecretInputStringFallback(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const normalizeSecretInputString: typeof normalizeSecretInputStringFallback =
  typeof hostNormalizeInputString === "function"
    ? hostNormalizeInputString
    : normalizeSecretInputStringFallback;

/**
 * Fallback for normalizeResolvedSecretInputString that preserves
 * unresolved SecretRef validation: if the value looks like a SecretRef
 * object (has a `source` key), throw so the user sees the real problem
 * instead of silently treating the account as unconfigured.
 */
function normalizeResolvedSecretInputStringFallback(params: {
  value: unknown;
  refValue?: unknown;
  path: string;
}): string | undefined {
  const normalized = normalizeSecretInputString(params.value);
  if (normalized) {
    return normalized;
  }
  if (params.value != null && typeof params.value === "object" && "source" in params.value) {
    throw new Error(
      `${params.path}: unresolved SecretRef. Resolve this against an active gateway runtime snapshot before reading it.`,
    );
  }
  return undefined;
}

export const normalizeResolvedSecretInputString: typeof normalizeResolvedSecretInputStringFallback =
  typeof hostNormalizeResolvedInputString === "function"
    ? hostNormalizeResolvedInputString
    : normalizeResolvedSecretInputStringFallback;

export {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
};
