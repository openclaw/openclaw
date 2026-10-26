/**
 * Test fetch resolver that bypasses mocked global fetch when Browser tests need
 * a real HTTP client.
 */
import { createRequire } from "node:module";

type FetchLike = ((input: string | URL, init?: RequestInit) => Promise<Response>) & {
  mock?: unknown;
};

/** Fetch shape used by Browser integration test helpers. */
export type BrowserTestFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function isUsableFetch(value: unknown): value is FetchLike {
  return typeof value === "function" && !("mock" in (value as FetchLike));
}

function loadBrowserTestUndici(): typeof import("undici") {
  const require = createRequire(import.meta.url);
  const vitest = (globalThis as { vi?: { doUnmock?: (id: string) => void } }).vi;
  vitest?.doUnmock?.("undici/index.js");
  try {
    delete require.cache[require.resolve("undici/index.js")];
  } catch {
    // Best-effort cache bust for shared-thread test workers.
  }
  // Match the runtime dispatcher owner: Bun's bare undici shim has no private pool lifecycle.
  return require("undici/index.js") as typeof import("undici");
}

/** Owns the real HTTP client's connections until the test closes them. */
export function createBrowserTestClient() {
  const undici = loadBrowserTestUndici();
  const dispatcher = new undici.Agent();
  const fetch: typeof undici.fetch = (input, init) => undici.fetch(input, { ...init, dispatcher });
  return { fetch, close: () => dispatcher.close() };
}

/** Returns undici fetch when usable, falling back to an unmocked global fetch. */
export function getBrowserTestFetch(): BrowserTestFetch {
  const { fetch } = loadBrowserTestUndici();
  if (isUsableFetch(fetch)) {
    return (input, init) => fetch(input, init);
  }
  if (isUsableFetch(globalThis.fetch)) {
    return (input, init) => globalThis.fetch(input, init);
  }
  throw new TypeError("fetch is not a function");
}
