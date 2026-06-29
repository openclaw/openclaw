// Tlon plugin module implements auth behavior.
import { readProviderTextResponse } from "openclaw/plugin-sdk/provider-http";
import type { LookupFn, SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { UrbitAuthError } from "./errors.js";
import { urbitFetch } from "./fetch.js";

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

    // 16 MiB body cap. Some Urbit implementations defer set-cookie
    // header finalize until the body drains; the cap ensures a hostile
    // /~/login body cannot OOM us before headers parse. Body value
    // itself is discarded.
    try {
      await readProviderTextResponse(response, "Tlon Urbit auth");
    } catch {
      // Preserve original semantic: discard read outcome so cookie
      // parse still runs even on partial-read failures.
    }
    const cookie = response.headers.get("set-cookie");
    if (!cookie) {
      throw new UrbitAuthError("missing_cookie", "No authentication cookie received");
    }
    return cookie;
  } finally {
    await release();
  }
}
