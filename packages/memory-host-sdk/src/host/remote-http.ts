// Memory Host SDK module implements remote http behavior.
import {
  createHttp1EnvHttpProxyAgent,
  fetchWithResponseRelease,
  normalizeHostname,
  shouldUseEnvHttpProxyForUrl,
} from "./openclaw-runtime-network.js";

// Remote memory HTTP wrapper that releases response bodies after callers finish reading.

function assertRemoteUrlMatchesInitialHost(url: URL, initialHostname: string): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Remote memory HTTP only supports http and https URLs");
  }
  if (normalizeHostname(url.hostname) !== initialHostname) {
    throw new Error(`Blocked hostname (not configured remote host): ${url.hostname}`);
  }
}

type CloseableRemoteHttpDispatcher = {
  close?: () => Promise<void> | void;
};

function hasRequestDispatcher(init: RequestInit | undefined): boolean {
  return Boolean(init && "dispatcher" in init && (init as { dispatcher?: unknown }).dispatcher);
}

async function closeRemoteHttpDispatcher(
  dispatcher: CloseableRemoteHttpDispatcher | undefined,
): Promise<void> {
  await dispatcher?.close?.();
}

/** Execute a remote HTTP request and always release the response handle. */
export async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  auditContext?: string;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const initialUrl = new URL(params.url);
  const initialHostname = normalizeHostname(initialUrl.hostname);
  const validateUrl = (parsed: URL) => {
    assertRemoteUrlMatchesInitialHost(parsed, initialHostname);
  };
  validateUrl(initialUrl);
  const dispatcher =
    !hasRequestDispatcher(params.init) && shouldUseEnvHttpProxyForUrl(params.url)
      ? createHttp1EnvHttpProxyAgent()
      : undefined;
  let result: Awaited<ReturnType<typeof fetchWithResponseRelease>>;
  try {
    result = await fetchWithResponseRelease({
      url: params.url,
      fetchImpl: params.fetchImpl,
      init: dispatcher ? ({ ...params.init, dispatcher } as RequestInit) : params.init,
      signal: params.signal,
      validateUrl,
    });
  } catch (error) {
    await closeRemoteHttpDispatcher(dispatcher);
    throw error;
  }
  const { response, release } = result;
  try {
    return await params.onResponse(response);
  } finally {
    await release();
    await closeRemoteHttpDispatcher(dispatcher);
  }
}
