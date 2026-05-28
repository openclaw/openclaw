export function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeProviderId(provider: string): string {
  return normalizeLowercaseStringOrEmpty(provider);
}

// Normalizes a CLI-backend / provider id while folding the one legacy alias
// OpenClaw still honours: the pre-rename `anthropic-cli` key maps to the
// canonical `claude-cli` backend id. Mirrors the same alias fold used by the
// doctor migration path (`normalizeLegacyRuntimeProviderId` in
// commands/doctor/shared/legacy-runtime-model-providers.ts) and the security
// audit's claude-cli backend matcher, so config keyed under the legacy alias
// resolves to the same backend everywhere (inheritance lookup, classifier).
export function normalizeLegacyCliBackendKey(key: string): string {
  const normalized = normalizeProviderId(key);
  return normalized === "anthropic-cli" ? "claude-cli" : normalized;
}

/** Normalize provider ID before manifest-owned auth alias lookup. */
export function normalizeProviderIdForAuth(provider: string): string {
  return normalizeProviderId(provider);
}

// True for any provider id that maps to a Claude CLI subscription backend —
// today the headless `claude-cli` and the interactive proxy `claude-cli-interactive`.
// Both spawn the same `claude` binary against Anthropic's subscription auth,
// so any "is this a Claude CLI run?" gate (model-capability resolution, OAuth
// label lookup, credential fingerprinting, live-agent probe routing, etc.)
// should treat them as the same family. Single helper so future variants get
// recognised everywhere by extending this one function instead of grepping
// for every `=== "claude-cli"` site.
export function isClaudeCliCompatibleBackend(provider: string | undefined): boolean {
  const normalized = normalizeProviderId(provider ?? "");
  return normalized === "claude-cli" || normalized === "claude-cli-interactive";
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
