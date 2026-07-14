// The Vertex SDK's bundled google-auth-library/gaxios stack only reaches for native
// `fetch` when a global `window.fetch` exists; otherwise gaxios dynamically imports
// `node-fetch`, which can fail to resolve depending on how the plugin's dependency
// tree is installed. That failure surfaces deep inside gaxios's token-exchange path
// as "Cannot convert undefined or null to object", breaking every Vertex auth request
// (openclaw/openclaw#41380 hit the same gaxios root cause via a different provider;
// openclaw/openclaw#107341 is this one). Exposing a minimal `window.fetch` keeps
// gaxios on the native-fetch branch and avoids the `node-fetch` import entirely.

type FetchOnlyWindow = { fetch: typeof fetch };
type GlobalWithOptionalWindow = Omit<typeof globalThis, "window"> & { window?: FetchOnlyWindow };

/**
 * Idempotent no-op if `window` already exists (real or previously shimmed) or if
 * native `fetch` isn't available. Deliberately sets only `fetch` - never
 * `document`/`navigator`/`crypto` - so unrelated browser-detection checks elsewhere
 * in the same dependency chain (the Anthropic SDK's browser guard,
 * google-auth-library's WebCrypto-vs-Node crypto selection) stay unaffected.
 */
export function ensureNativeFetchVisibleToGoogleAuth(
  target: GlobalWithOptionalWindow = globalThis as GlobalWithOptionalWindow,
): void {
  if (typeof target.window !== "undefined" || typeof target.fetch !== "function") {
    return;
  }
  target.window = { fetch: target.fetch };
}
