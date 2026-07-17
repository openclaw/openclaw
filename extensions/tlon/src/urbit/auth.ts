// Tlon plugin module implements auth behavior.
import type { LookupFn, SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { UrbitAuthError } from "./errors.js";
import { urbitFetch } from "./fetch.js";

const AUTH_RESPONSE_DRAIN_MAX_BYTES = 64 * 1024;
const AUTH_RESPONSE_DRAIN_TIMEOUT_MS = 250;

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
    let releaseLock = true;
    const deadlineMs = Date.now() + AUTH_RESPONSE_DRAIN_TIMEOUT_MS;
    try {
      while (remaining > 0) {
        const timeoutMs = deadlineMs - Date.now();
        if (timeoutMs <= 0) {
          releaseLock = false;
          void reader.cancel().catch(() => {});
          return;
        }
        const result = await readAuthResponseChunk(reader, timeoutMs);
        if (result === "timeout") {
          releaseLock = false;
          void reader.cancel().catch(() => {});
          return;
        }
        const { done, value } = result;
        if (done || !value?.byteLength) {
          return;
        }
        remaining -= value.byteLength;
      }
      void reader.cancel().catch(() => {});
    } finally {
      if (releaseLock) {
        reader.releaseLock();
      }
    }
  } catch {
    // Body drain is compatibility-only; cookie handling below owns auth success/failure.
  }
}

async function readAuthResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array> | "timeout"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
