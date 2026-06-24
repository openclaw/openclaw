// Google plugin module implements oauth.http behavior.
import {
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { DEFAULT_FETCH_TIMEOUT_MS } from "./oauth.shared.js";

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const guardedOptions = { url, init, timeoutMs };
  const { response, release } = await fetchWithSsrFGuard(
    shouldUseEnvHttpProxyForUrl(url)
      ? withTrustedEnvProxyGuardedFetchMode(guardedOptions)
      : guardedOptions,
  );
  try {
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await release();
  }
}
