import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/infra-runtime";
import { DEFAULT_FETCH_TIMEOUT_MS } from "./oauth.shared.js";

let oauthFetchWithSsrfGuard: typeof fetchWithSsrFGuard = fetchWithSsrFGuard;

export function __setOAuthFetchWithSsrfGuardForTest(fetchGuard: typeof fetchWithSsrFGuard): void {
  oauthFetchWithSsrfGuard = fetchGuard;
}

export function __resetOAuthFetchWithSsrfGuardForTest(): void {
  oauthFetchWithSsrfGuard = fetchWithSsrFGuard;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const { response, release } = await oauthFetchWithSsrfGuard({
    url,
    init,
    timeoutMs,
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
