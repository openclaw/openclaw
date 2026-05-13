import {
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  fetchWithSsrFGuard,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { DEFAULT_FETCH_TIMEOUT_MS } from "./oauth.shared.js";

const GOOGLE_OAUTH_HTTP_POLICY = {
  ...buildHostnameAllowlistPolicyFromSuffixAllowlist(["googleapis.com"]),
  allowPrivateNetwork: true,
};

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init,
    timeoutMs,
    policy: GOOGLE_OAUTH_HTTP_POLICY,
  });
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
