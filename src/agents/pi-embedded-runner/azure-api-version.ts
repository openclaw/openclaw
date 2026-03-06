import type { OpenClawConfig } from "../../config/config.js";

const FETCH_WRAPPED = Symbol.for("openclaw.fetch.azure-api-version");

type FetchWithMarker = typeof fetch & { [FETCH_WRAPPED]?: boolean };

const azureApiVersionByHost = new Map<string, string>();

function normalizeHostFromBaseUrl(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function shouldAttachApiVersion(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  const version = azureApiVersionByHost.get(host);
  if (!version) {
    return null;
  }
  if (url.searchParams.has("api-version")) {
    return null;
  }
  if (!url.pathname.includes("/chat/completions")) {
    return null;
  }
  return version;
}

function rewriteRequestUrl(input: RequestInfo | URL): { url: string; original: string } | null {
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  try {
    const url = new URL(raw);
    const version = shouldAttachApiVersion(url);
    if (!version) {
      return null;
    }
    url.searchParams.set("api-version", version);
    const next = url.toString();
    return next === raw ? null : { url: next, original: raw };
  } catch {
    return null;
  }
}

function registerAzureApiVersionsFromConfig(cfg?: OpenClawConfig): void {
  azureApiVersionByHost.clear();
  const providers = cfg?.models?.providers;
  if (!providers) {
    return;
  }
  for (const entry of Object.values(providers)) {
    if (!entry) {
      continue;
    }
    const apiVersion = typeof entry.apiVersion === "string" ? entry.apiVersion.trim() : "";
    const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
    if (!apiVersion || !baseUrl) {
      continue;
    }
    const host = normalizeHostFromBaseUrl(baseUrl);
    if (!host) {
      continue;
    }
    azureApiVersionByHost.set(host, apiVersion);
  }
}

export function ensureAzureApiVersionFetchWrapper(cfg?: OpenClawConfig): void {
  // Always re-register before the early-return guard so the map reflects the
  // current config even after the wrapper is already installed.
  registerAzureApiVersionsFromConfig(cfg);
  const currentFetch = globalThis.fetch as FetchWithMarker | undefined;
  if (!currentFetch || currentFetch[FETCH_WRAPPED]) {
    return;
  }

  const wrapped: FetchWithMarker = (async (input, init) => {
    const rewrite = rewriteRequestUrl(input);
    if (!rewrite) {
      return currentFetch(input, init);
    }
    if (input instanceof Request) {
      const nextRequest = new Request(rewrite.url, input);
      return currentFetch(nextRequest, init);
    }
    return currentFetch(rewrite.url, init);
  }) as FetchWithMarker;

  wrapped[FETCH_WRAPPED] = true;
  globalThis.fetch = Object.assign(wrapped, currentFetch);
}
