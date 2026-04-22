import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const selfPrefixedProviderIds = new Set<string>();

export function registerProviderSelfPrefix(providerId: string): void {
  const normalized = normalizeLowercaseStringOrEmpty(providerId);
  if (!normalized) {
    return;
  }
  selfPrefixedProviderIds.add(normalized);
}

export function isProviderSelfPrefixed(providerId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(providerId);
  if (!normalized) {
    return false;
  }
  return selfPrefixedProviderIds.has(normalized);
}

export function __resetProviderSelfPrefixForTest(): void {
  selfPrefixedProviderIds.clear();
}
