import type { ProviderResponseModelEquivalenceContext } from "openclaw/plugin-sdk/provider-model-types";

// Labs stamp snapshots as `gpt-5.5-2026-04-23` or `claude-sonnet-4-6-20260301`.
const DATED_SNAPSHOT_SUFFIX = /^-(?:\d{4}-\d{2}-\d{2}|\d{8})$/u;

/**
 * Requesty echoes the upstream lab's response id (`claude-sonnet-4-6`,
 * `gpt-5.5-2026-04-23`) while the requested id may carry an operator-authored
 * hosting prefix (`vertex/claude-sonnet-4-6`), so those reports name the same route.
 */
export function isResponseModelEquivalent({
  provider,
  requestedModelId,
  responseModelId,
}: ProviderResponseModelEquivalenceContext) {
  if (provider.trim().toLowerCase() !== "requesty") {
    return undefined;
  }
  const requested = requestedModelId.trim();
  const response = responseModelId.trim();
  if (!response) {
    return undefined;
  }
  if (requested === response || requested.endsWith(`/${response}`)) {
    return true;
  }
  // Hosting prefixes select a route, not a different model.
  const separator = requested.indexOf("/");
  const upstream = separator === -1 ? requested : requested.slice(separator + 1);
  return (
    upstream === response ||
    (response.startsWith(upstream) && DATED_SNAPSHOT_SUFFIX.test(response.slice(upstream.length)))
  );
}
