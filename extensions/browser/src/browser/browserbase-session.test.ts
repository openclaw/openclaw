import { describe, expect, it, vi } from "vitest";
import {
  BrowserbaseAuthConfigError,
  BrowserbaseSessionMalformedError,
  BrowserbaseSessionUnavailableError,
  fetchBrowserbaseConnectUrl,
  withResolvedCdpUrl,
} from "./browserbase-session.js";
import type { ResolvedBrowserProfile } from "./config.js";

const SESSION_ID = "44589bac-33f0-4080-9eff-f1b3e3a0bf9c";
const API_KEY_ENV = "BROWSERBASE_API_KEY_TEST";
const API_KEY_VALUE = "bb_live_TEST_KEY";

function makeResponse(
  body: unknown,
  init: { status?: number; bodyAsText?: string } = {},
): Response {
  const status = init.status ?? 200;
  const text = init.bodyAsText ?? JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeOkResponse(payload: { status: string; connectUrl?: string }): Response {
  return makeResponse(payload, { status: 200 });
}

describe("fetchBrowserbaseConnectUrl", () => {
  it("returns connectUrl on status=RUNNING and sets X-BB-API-Key", async () => {
    const fetchImpl = vi.fn(async () =>
      makeOkResponse({
        status: "RUNNING",
        connectUrl: "wss://connect.browserbase.com/abc?signingKey=xyz",
      }),
    );

    const url = await fetchBrowserbaseConnectUrl(SESSION_ID, API_KEY_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      envLookup: (name) => (name === API_KEY_ENV ? API_KEY_VALUE : undefined),
    });

    expect(url).toBe("wss://connect.browserbase.com/abc?signingKey=xyz");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const firstCall = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const calledUrl = firstCall[0];
    const calledInit = firstCall[1];
    expect(calledUrl).toContain("/v1/sessions/" + SESSION_ID);
    expect(calledInit.method).toBe("GET");
    const headers = calledInit.headers as Record<string, string>;
    expect(headers["X-BB-API-Key"]).toBe(API_KEY_VALUE);
    expect(headers["Accept"]).toBe("application/json");
  });

  it("throws BrowserbaseAuthConfigError when the env var is unset", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchBrowserbaseConnectUrl(SESSION_ID, API_KEY_ENV, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        envLookup: () => undefined,
      }),
    ).rejects.toBeInstanceOf(BrowserbaseAuthConfigError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws BrowserbaseAuthConfigError naming the env var when value is whitespace", async () => {
    await expect(
      fetchBrowserbaseConnectUrl(SESSION_ID, API_KEY_ENV, {
        fetchImpl: vi.fn() as unknown as typeof fetch,
        envLookup: () => "   ",
      }),
    ).rejects.toThrow(/BROWSERBASE_API_KEY_TEST/);
  });

  it("throws BrowserbaseSessionUnavailableError when status=COMPLETED", async () => {
    const fetchImpl = vi.fn(async () =>
      makeOkResponse({ status: "COMPLETED", connectUrl: "wss://stale" }),
    );

    let caught: unknown;
    try {
      await fetchBrowserbaseConnectUrl(SESSION_ID, API_KEY_ENV, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        envLookup: () => API_KEY_VALUE,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BrowserbaseSessionUnavailableError);
    expect((caught as BrowserbaseSessionUnavailableError).status).toBe("COMPLETED");
    expect(String(caught)).toContain("COMPLETED");
  });

  it("throws BrowserbaseSessionMalformedError when connectUrl is missing", async () => {
    const fetchImpl = vi.fn(async () => makeOkResponse({ status: "RUNNING" }));
    await expect(
      fetchBrowserbaseConnectUrl(SESSION_ID, API_KEY_ENV, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        envLookup: () => API_KEY_VALUE,
      }),
    ).rejects.toBeInstanceOf(BrowserbaseSessionMalformedError);
  });

  it("aborts in-flight fetch when timeoutMs elapses", async () => {
    // The mock honors the signal so the test verifies the timeout path
    // actually invokes AbortController.abort, not just that the function
    // resolves quickly.
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("test mock requires signal"));
          return;
        }
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const start = Date.now();
    let caught: unknown;
    try {
      await fetchBrowserbaseConnectUrl(SESSION_ID, API_KEY_ENV, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        envLookup: () => API_KEY_VALUE,
        timeoutMs: 50,
      });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;
    expect((caught as Error).name).toBe("AbortError");
    expect(elapsed).toBeLessThan(1000);
  });

  it("forwards an external AbortSignal to the in-flight fetch", async () => {
    const ctrl = new AbortController();
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const promise = fetchBrowserbaseConnectUrl(SESSION_ID, API_KEY_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      envLookup: () => API_KEY_VALUE,
      timeoutMs: 5_000,
      signal: ctrl.signal,
    });
    ctrl.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("surfaces non-2xx HTTP responses with the status code and an API-key hint on 401", async () => {
    const fetchImpl = vi.fn(async () => makeResponse({ message: "unauthorized" }, { status: 401 }));

    await expect(
      fetchBrowserbaseConnectUrl(SESSION_ID, API_KEY_ENV, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        envLookup: () => API_KEY_VALUE,
      }),
    ).rejects.toThrowError(/HTTP 401.*BROWSERBASE_API_KEY_TEST/);
  });

  it("never caches: two consecutive calls fire two HTTP requests", async () => {
    const fetchImpl = vi.fn(async () =>
      makeOkResponse({
        status: "RUNNING",
        connectUrl: "wss://connect.browserbase.com/x?signingKey=k",
      }),
    );
    const opts = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      envLookup: () => API_KEY_VALUE,
    };
    await fetchBrowserbaseConnectUrl(SESSION_ID, API_KEY_ENV, opts);
    await fetchBrowserbaseConnectUrl(SESSION_ID, API_KEY_ENV, opts);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// withResolvedCdpUrl
// ---------------------------------------------------------------------------

function baseProfile(overrides: Partial<ResolvedBrowserProfile> = {}): ResolvedBrowserProfile {
  return {
    name: "p",
    cdpPort: 0,
    cdpUrl: "",
    cdpHost: "",
    cdpIsLoopback: false,
    color: "#FF4500",
    driver: "openclaw",
    headless: false,
    attachOnly: false,
    ...overrides,
  };
}

describe("withResolvedCdpUrl", () => {
  it("returns the input profile unchanged when driver=openclaw", async () => {
    const input = baseProfile({
      driver: "openclaw",
      cdpUrl: "http://127.0.0.1:18800",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      cdpPort: 18800,
    });
    const fetchImpl = vi.fn();
    const out = await withResolvedCdpUrl(input, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toBe(input);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the input profile unchanged when driver=existing-session", async () => {
    const input = baseProfile({
      driver: "existing-session",
      cdpUrl: "",
      attachOnly: true,
    });
    const fetchImpl = vi.fn();
    const out = await withResolvedCdpUrl(input, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toBe(input);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns a shallow copy with a fresh URL when driver=browserbase", async () => {
    const input = baseProfile({
      driver: "browserbase",
      attachOnly: true,
      browserbaseSessionId: SESSION_ID,
      browserbaseApiKeyEnv: API_KEY_ENV,
    });
    const fetchImpl = vi.fn(async () =>
      makeOkResponse({
        status: "RUNNING",
        connectUrl: "wss://connect.browserbase.com/abc?signingKey=fresh",
      }),
    );

    const out = await withResolvedCdpUrl(input, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      envLookup: () => API_KEY_VALUE,
    });

    expect(out).not.toBe(input);
    expect(input.cdpUrl).toBe("");
    expect(out.cdpUrl).toBe("wss://connect.browserbase.com/abc?signingKey=fresh");
    expect(out.cdpHost).toBe("connect.browserbase.com");
    expect(out.cdpIsLoopback).toBe(false);
    expect(out.driver).toBe("browserbase");
    expect(out.browserbaseSessionId).toBe(SESSION_ID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws when driver=browserbase but session/env fields are missing", async () => {
    const input = baseProfile({
      driver: "browserbase",
      attachOnly: true,
      // intentionally no browserbaseSessionId/browserbaseApiKeyEnv
    });
    await expect(
      withResolvedCdpUrl(input, {
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/browserbase/);
  });
});
