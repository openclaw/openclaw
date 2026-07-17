// Tlon plugin module implements auth behavior.
import type { LookupFn, SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { UrbitAuthError } from "./errors.js";
import { urbitFetch } from "./fetch.js";

const MAX_AUTH_BODY_DRAIN_BYTES = 64 * 1024;

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

    // Drain the response body within a bounded buffer so cookie headers
    // finalize. A streaming drain with a cap avoids buffering an arbitrarily
    // large response into memory when only the set-cookie header is needed.
    const body = response.body;
    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      try {
        let drained = 0;
        while (drained < MAX_AUTH_BODY_DRAIN_BYTES) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) drained += value.byteLength;
        }
        await reader.cancel().catch(() => {});
      } catch {
        // Drain failure is non-fatal — the cookie may still be available.
      }
    } else {
      // Body stream unavailable; drain via text() with post-hoc cap.
      await response.text().catch(() => {});
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
