// Tlon plugin module implements auth behavior.
import type { LookupFn, SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { UrbitAuthError } from "./errors.js";
import { urbitFetch } from "./fetch.js";

const AUTH_RESPONSE_DRAIN_MAX_BYTES = 64 * 1024;

type UrbitAuthenticateOptions = {
  ssrfPolicy?: SsrFPolicy;
  lookupFn?: LookupFn;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
};

export async function authenticate(
  url: string,
  code: string,
  options: UrbitAuthenticateOptions = {},
): Promise<string> {
  const { response, release } = await urbitFetch({
    baseUrl: url,
    path: "/~/login",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: code }).toString(),
    },
    ssrfPolicy: options.ssrfPolicy,
    lookupFn: options.lookupFn,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? 15_000,
    maxRedirects: 3,
    auditContext: "tlon-urbit-login",
  });

  try {
    if (!response.ok) {
      throw new UrbitAuthError("auth_failed", `Login failed with status ${response.status}`);
    }

    // Some Urbit setups require the response body to be read before cookie headers finalize.
    await drainAuthResponseBody(response);
    const cookie = response.headers.get("set-cookie");
    if (!cookie) {
      throw new UrbitAuthError("missing_cookie", "No authentication cookie received");
    }
    return cookie;
  } finally {
    await release();
  }
}

async function drainAuthResponseBody(response: Response): Promise<void> {
  try {
    if (!response.body) {
      await response.text().catch(() => {});
      return;
    }

    const reader = response.body.getReader();
    let remaining = AUTH_RESPONSE_DRAIN_MAX_BYTES;
    try {
      while (remaining > 0) {
        const { done, value } = await reader.read();
        if (done || !value?.byteLength) {
          return;
        }
        remaining -= value.byteLength;
      }
      await reader.cancel().catch(() => {});
    } finally {
      reader.releaseLock();
    }
  } catch {
    // Body drain is compatibility-only; cookie handling below owns auth success/failure.
  }
}
