import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveOpenAICodexAccessTokenExpiry } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../test-support/streaming-error-response.js";
import { loginOpenAICodexDeviceCode } from "./openai-chatgpt-device-code.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function createJsonResponse(body: unknown, init?: { status?: number }) {
  return Response.json(body, { status: init?.status ?? 200 });
}

function startLogin(
  fetchFn: typeof fetch,
  options: Partial<Parameters<typeof loginOpenAICodexDeviceCode>[0]> = {},
) {
  return loginOpenAICodexDeviceCode({ fetchFn, onVerification: async () => {}, ...options });
}

function accessToken() {
  return createJwt({
    exp: Math.floor(Date.now() / 1000) + 600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
  });
}

function tokenResponse(access_token = accessToken(), extra: Record<string, unknown> = {}) {
  return createJsonResponse({ access_token, refresh_token: "refresh-token-123", ...extra });
}

function successfulFetch(token: Response, interval: string | number = "0") {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(createDeviceCodeResponse(interval))
    .mockResolvedValueOnce(createAuthorizationResponse())
    .mockResolvedValueOnce(token);
}

function pollFetch() {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(createDeviceCodeResponse());
}

function createDeviceCodeResponse(interval: string | number = "0") {
  return createJsonResponse({
    device_auth_id: "device-auth-123",
    user_code: "CODE-12345",
    interval,
  });
}

function createAuthorizationResponse() {
  return createJsonResponse({
    authorization_code: "authorization-code-123",
    code_verifier: "code-verifier-123",
  });
}

function fetchCall(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected fetch call ${index}`);
  }
  return call;
}

function expectPost(
  call: ReturnType<typeof fetchCall>,
  path: string,
  contentType: string,
  body?: string,
) {
  expect(call[0]).toBe(`https://auth.openai.com${path}`);
  expect(call[1]).toMatchObject({ method: "POST", signal: expect.any(AbortSignal) });
  if (body !== undefined) {
    expect(call[1]?.body).toBe(body);
  }
  expect(call[1]?.headers).toEqual({
    "Content-Type": contentType,
    originator: "openclaw",
    version: "2026.3.22",
    "User-Agent": "openclaw/2026.3.22",
  });
}

function waitForFetchAbort(init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  if (!signal) {
    return Promise.reject(new Error("expected fetch signal"));
  }
  return new Promise((_resolve, reject) => {
    const rejectWithReason = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
    if (signal.aborted) {
      rejectWithReason();
      return;
    }
    signal.addEventListener("abort", rejectWithReason, { once: true });
  });
}

function createBodyThatStallsUntilAbort(init?: RequestInit): Response {
  const signal = init?.signal;
  if (!signal) {
    throw new Error("expected fetch signal");
  }
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const fail = () => controller.error(signal.reason);
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener("abort", fail, { once: true });
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("loginOpenAICodexDeviceCode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("times out while waiting for device-code response headers", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => waitForFetchAbort(init));

    const pending = startLogin(fetchMock);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[1]?.signal).toBeInstanceOf(AbortSignal);
    const rejected = expect(pending).rejects.toThrow(
      "OpenAI device code user code request timed out after 30000ms",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
  });

  it("keeps the request timeout active while reading the response body", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) =>
      createBodyThatStallsUntilAbort(init),
    );

    const pending = startLogin(fetchMock);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledOnce();
    await Promise.all([
      expect(pending).rejects.toThrow(
        "OpenAI device code user code request timed out after 30000ms",
      ),
      vi.advanceTimersByTimeAsync(30_000),
    ]);
  });

  it("still honors caller cancellation during an active device-code request", async () => {
    const callerController = new AbortController();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => waitForFetchAbort(init));

    const pending = startLogin(fetchMock, { signal: callerController.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    callerController.abort(new Error("cancelled by caller"));
    await expect(pending).rejects.toThrow("cancelled by caller");
  });

  it.each(["verification", "authorization response"] as const)(
    "revalidates live authority after held %s before another device request",
    async (boundary) => {
      const held = createDeferred<void>();
      const release = createDeferred<void>();
      const controller = new AbortController();
      let current = true;
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          createJsonResponse({ device_auth_id: "device", user_code: "CODE", interval: "1" }),
        )
        .mockImplementationOnce(async () => {
          if (boundary === "authorization response") {
            held.resolve();
            await release.promise;
          }
          return createJsonResponse({ authorization_code: "code", code_verifier: "verifier" });
        })
        .mockResolvedValueOnce(
          createJsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 60 }),
        );
      const outcome = loginOpenAICodexDeviceCode({
        fetchFn: fetchMock,
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("owner retired");
          }
        },
        onVerification: async () => {
          if (boundary === "verification") {
            held.resolve();
            await release.promise;
          }
        },
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await held.promise;
        current = false;
        release.resolve();
        const result = await outcome;
        expect(fetchMock).toHaveBeenCalledTimes(boundary === "verification" ? 1 : 2);
        expect(result).toEqual({ error: expect.objectContaining({ message: "owner retired" }) });
        expect(controller.signal.aborted).toBe(false);
      } finally {
        controller.abort();
        release.resolve();
        await outcome;
      }
    },
  );

  it.each(["", "auth.openai.com"])(
    "uses the guarded auth proxy route with NO_PROXY=%s",
    async (noProxy) => {
      vi.stubEnv("https_proxy", "http://127.0.0.1:7897");
      vi.stubEnv("no_proxy", noProxy);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 503 }));
      await expect(startLogin(fetchMock)).rejects.toThrow(
        "OpenAI device code request failed: HTTP 503",
      );
      const requestInit = fetchCall(fetchMock, 0)[1] as
        | (RequestInit & { dispatcher?: { constructor?: { name?: string } } })
        | undefined;
      if (noProxy) {
        expect(requestInit?.dispatcher).toBeUndefined();
      } else {
        expect(requestInit?.dispatcher?.constructor?.name).toContain("EnvHttpProxyAgent");
      }
    },
  );

  it("requests a device code, polls for authorization, and exchanges OAuth tokens", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createDeviceCodeResponse())
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        createJsonResponse({
          authorization_code: "authorization-code-123",
          code_challenge: "ignored",
          code_verifier: "code-verifier-123",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          access_token: createJwt({
            exp: Math.floor(Date.now() / 1000) + 600,
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct_123",
            },
            "https://api.openai.com/profile": {
              email: "codex@example.com",
            },
          }),
          refresh_token: "refresh-token-123",
          id_token: createJwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct_123",
            },
          }),
          expires_in: 600,
        }),
      );
    const onVerification = vi.fn(async () => {});
    const onProgress = vi.fn();

    const credentialsPromise = startLogin(fetchMock, { onVerification, onProgress });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const credentials = await credentialsPromise;

    expectPost(
      fetchCall(fetchMock, 0),
      "/api/accounts/deviceauth/usercode",
      "application/json",
      '{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann"}',
    );
    expectPost(
      fetchCall(fetchMock, 1),
      "/api/accounts/deviceauth/token",
      "application/json",
      '{"device_auth_id":"device-auth-123","user_code":"CODE-12345"}',
    );
    const oauthTokenRequest = fetchCall(fetchMock, 3);
    expectPost(oauthTokenRequest, "/oauth/token", "application/x-www-form-urlencoded");
    expect(
      Object.fromEntries(
        new URLSearchParams(await new Response(oauthTokenRequest[1]?.body).text()),
      ),
    ).toEqual({
      grant_type: "authorization_code",
      code: "authorization-code-123",
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code_verifier: "code-verifier-123",
    });
    expect(onVerification).toHaveBeenCalledWith({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "CODE-12345",
      expiresInMs: 900_000,
    });
    expect(onProgress.mock.calls).toEqual([
      ["Requesting device code…"],
      ["Waiting for device authorization…"],
      ["Exchanging device code…"],
    ]);
    expect(typeof credentials.access).toBe("string");
    expect(credentials.access.length).toBeGreaterThan(0);
    expect(credentials.refresh).toBe("refresh-token-123");
    expect(credentials).not.toHaveProperty("accountId");
    expect(credentials.expires).toBe(Date.now() + 600_000);
  });

  it("retries a timed-out authorization poll within the overall device deadline", async () => {
    vi.useFakeTimers();
    const token = createJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
    let pollAttempts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return createDeviceCodeResponse();
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return ++pollAttempts === 1 ? waitForFetchAbort(init) : createAuthorizationResponse();
      }
      if (url.endsWith("/oauth/token")) {
        return tokenResponse(token, { expires_in: 600 });
      }
      throw new Error(`unexpected OpenAI device-code URL: ${url}`);
    });

    const login = startLogin(fetchMock);
    await vi.advanceTimersByTimeAsync(0);
    expect(pollAttempts).toBe(1);

    const resolved = expect(login).resolves.toMatchObject({ refresh: "refresh-token-123" });
    await vi.advanceTimersByTimeAsync(30_000);
    await resolved;
    expect(pollAttempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries a transient authorization poll network failure after the poll delay", async () => {
    vi.useFakeTimers();
    const token = createJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createDeviceCodeResponse("2"))
      .mockRejectedValueOnce(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND auth.openai.com"), {
            code: "ENOTFOUND",
          }),
        }),
      )
      .mockResolvedValueOnce(createAuthorizationResponse())
      .mockResolvedValueOnce(tokenResponse(token, { expires_in: 600 }));

    const login = startLogin(fetchMock);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const resolved = expect(login).resolves.toMatchObject({ refresh: "refresh-token-123" });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await resolved;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("still surfaces local authorization poll errors that are not transport failures", async () => {
    const fetchMock = pollFetch().mockRejectedValueOnce(
      new TypeError("undefined is not a function"),
    );

    await expect(startLogin(fetchMock)).rejects.toThrow("undefined is not a function");
  });

  it.each(["abort", "authority"] as const)(
    "stops device-code polling on %s without another request",
    async (retirement) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      let current = true;
      try {
        const fetchMock = vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(createDeviceCodeResponse("5"))
          .mockResolvedValueOnce(new Response(null, { status: 404 }));

        const login = loginOpenAICodexDeviceCode({
          fetchFn: fetchMock,
          onVerification: async () => {},
          signal: controller.signal,
          assertCurrent: () => {
            if (!current) {
              throw new Error("cancelled");
            }
          },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        const outcome = login.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        current = false;
        if (retirement === "abort") {
          controller.abort(new Error("cancelled"));
        }
        await vi.advanceTimersByTimeAsync(5_000);
        const result = await outcome;
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ error: expect.objectContaining({ message: "cancelled" }) });
        expect(controller.signal.aborted).toBe(retirement === "abort");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("treats JWT-derived expiry fallback as an absolute timestamp", async () => {
    const token = accessToken();
    const expectedExpiry = resolveOpenAICodexAccessTokenExpiry(token);
    const fetchMock = successfulFetch(tokenResponse(token));

    const credentials = await startLogin(fetchMock);

    if (expectedExpiry === undefined) {
      throw new Error("expected device-code expiry to be calculated");
    }
    expect(credentials.expires).toBe(expectedExpiry);
  });

  it("accepts token exchange JSON above the diagnostic preview limit", async () => {
    const token = accessToken();
    const fetchMock = successfulFetch(tokenResponse(token, { id_token: "x".repeat(10_000) }));

    const credentials = await startLogin(fetchMock);

    expect(credentials.refresh).toBe("refresh-token-123");
  });

  it("falls back when device-code intervals and token lifetimes overflow safe milliseconds", async () => {
    vi.useFakeTimers();
    const token = accessToken();
    const expectedExpiry = resolveOpenAICodexAccessTokenExpiry(token);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createDeviceCodeResponse(Number.MAX_SAFE_INTEGER))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(createAuthorizationResponse())
      .mockResolvedValueOnce(tokenResponse(token, { expires_in: Number.MAX_SAFE_INTEGER }));

    const credentialsPromise = startLogin(fetchMock);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const credentials = await credentialsPromise;

    if (expectedExpiry === undefined) {
      throw new Error("expected device-code expiry to be calculated");
    }
    expect(credentials.expires).toBe(expectedExpiry);
  });

  it("surfaces user-code request failures", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(`down\r\n\u001B[31mnow\u001B[0m`, {
        status: 503,
      }),
    );

    await expect(startLogin(fetchMock)).rejects.toThrow(
      "OpenAI device code request failed: HTTP 503 down now",
    );
  });

  it("bounds user-code error bodies without using response.text()", async () => {
    const tracked = cancelTrackedTextResponse(`${"device code unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    const fetchMock = vi.fn().mockResolvedValueOnce(tracked.response);

    const error = await startLogin(fetchMock).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /OpenAI device code request failed: HTTP 503 device code unavailable/,
    );
    expect((error as Error).message).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["C0/ANSI", "authorization_declined\r\n\u001B[31mspoofed\u001B[0m", "Denied\r\nnext line"],
    [
      "C1",
      `authorization_declined${String.fromCharCode(0x9b)}spoofed`,
      `Denied${String.fromCharCode(0x9d)}next line`,
    ],
  ])(
    "sanitizes %s controls in device authorization failures",
    async (_label, error, error_description) => {
      const fetchMock = pollFetch().mockResolvedValueOnce(
        createJsonResponse({ error, error_description }, { status: 401 }),
      );
      await expect(startLogin(fetchMock)).rejects.toThrow(
        "OpenAI device authorization failed: authorization_declined spoofed (Denied next line)",
      );
    },
  );

  it.each([
    { clockStepMs: -30 * 60_000, response: "blocked headers" },
    { clockStepMs: 30 * 60_000, response: "blocked headers" },
    { clockStepMs: -30 * 60_000, response: "pending authorization" },
    { clockStepMs: 30 * 60_000, response: "pending authorization" },
  ])(
    "keeps the 15-minute boundary after a $clockStepMs ms clock step with $response",
    async ({ clockStepMs, response }) => {
      // setSystemTime changes Date, independently of the fake monotonic clock and timers.
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const controller = new AbortController();
      const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/api/accounts/deviceauth/usercode")) {
          return createDeviceCodeResponse();
        }
        return response === "blocked headers"
          ? waitForFetchAbort(init)
          : new Response(null, { status: 404 });
      });
      let settled = false;
      const observing = loginOpenAICodexDeviceCode({
        fetchFn: fetchMock,
        signal: controller.signal,
        onVerification: async () => {},
      }).then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        vi.setSystemTime(clockStepMs);
        await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        expect(await observing).toEqual({
          error: expect.objectContaining({
            message: "OpenAI device authorization timed out after 15 minutes.",
          }),
        });
        const completedRequests = fetchMock.mock.calls.length;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fetchMock).toHaveBeenCalledTimes(completedRequests);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        controller.abort(new Error("test cleanup"));
        await observing;
        vi.useRealTimers();
      }
    },
  );
});
