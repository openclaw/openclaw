import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveOpenAICodexAccessTokenExpiry } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../test-support/streaming-error-response.js";
import { loginOpenAICodexDeviceCode } from "./openai-chatgpt-device-code.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function startLogin(
  fetchFn: typeof fetch,
  options: Partial<Parameters<typeof loginOpenAICodexDeviceCode>[0]> = {},
) {
  return loginOpenAICodexDeviceCode({ fetchFn, onVerification: async () => {}, ...options });
}

const accountClaims = { "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } };
function accessToken(claims: Record<string, unknown> = {}) {
  return createJwt({
    exp: Math.floor(Date.now() / 1000) + 600,
    ...accountClaims,
    ...claims,
  });
}

function expectJwtExpiry(expires: number, token: string) {
  const expected = resolveOpenAICodexAccessTokenExpiry(token);
  if (expected === undefined) {
    throw new Error("expected device-code expiry to be calculated");
  }
  expect(expires).toBe(expected);
}

function tokenResponse(access_token = accessToken(), extra: Record<string, unknown> = {}) {
  return Response.json({ access_token, refresh_token: "refresh-token-123", ...extra });
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
  return Response.json({
    device_auth_id: "device-auth-123",
    user_code: "CODE-12345",
    interval,
  });
}

function createAuthorizationResponse() {
  return Response.json({
    authorization_code: "authorization-code-123",
    code_verifier: "code-verifier-123",
  });
}

function fetchCall(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  return fetchMock.mock.calls[index]!;
}

function observe<T>(pending: Promise<T>) {
  return pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
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

function onFetchAbort(init: RequestInit | undefined, reject: (reason: unknown) => void) {
  const signal = init?.signal;
  if (!signal) {
    throw new Error("expected fetch signal");
  }
  if (signal.aborted) {
    reject(signal.reason);
  } else {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }
}

function waitForFetchAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    onFetchAbort(init, (reason) =>
      reject(reason instanceof Error ? reason : new Error("request aborted")),
    );
  });
}

function createBodyThatStallsUntilAbort(init?: RequestInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        onFetchAbort(init, (reason) => controller.error(reason));
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it.each(["headers", "body"])(
  "times out while waiting for device-code response %s",
  async (phase) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) =>
      phase === "headers" ? waitForFetchAbort(init) : createBodyThatStallsUntilAbort(init),
    );
    const pending = startLogin(fetchMock);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[1]?.signal).toBeInstanceOf(AbortSignal);
    await Promise.all([
      expect(pending).rejects.toThrow(
        "OpenAI device code user code request timed out after 30000ms",
      ),
      vi.advanceTimersByTimeAsync(30_000),
    ]);
  },
);

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
        Response.json({ device_auth_id: "device", user_code: "CODE", interval: "1" }),
      )
      .mockImplementationOnce(async () => {
        if (boundary === "authorization response") {
          held.resolve();
          await release.promise;
        }
        return Response.json({ authorization_code: "code", code_verifier: "verifier" });
      })
      .mockResolvedValueOnce(
        Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 60 }),
      );
    const outcome = observe(
      startLogin(fetchMock, {
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
      }),
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
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
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
      Response.json({
        authorization_code: "authorization-code-123",
        code_challenge: "ignored",
        code_verifier: "code-verifier-123",
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        access_token: accessToken({
          "https://api.openai.com/profile": { email: "codex@example.com" },
        }),
        refresh_token: "refresh-token-123",
        id_token: createJwt(accountClaims),
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

  for (const [index, path, body] of [
    [0, "usercode", '{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann"}'],
    [1, "token", '{"device_auth_id":"device-auth-123","user_code":"CODE-12345"}'],
  ] as const) {
    expectPost(
      fetchCall(fetchMock, index),
      `/api/accounts/deviceauth/${path}`,
      "application/json",
      body,
    );
  }
  const oauthTokenRequest = fetchCall(fetchMock, 3);
  expectPost(oauthTokenRequest, "/oauth/token", "application/x-www-form-urlencoded");
  expect(
    Object.fromEntries(new URLSearchParams(await new Response(oauthTokenRequest[1]?.body).text())),
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
  expect(credentials).toMatchObject({
    access: expect.any(String),
    refresh: "refresh-token-123",
    expires: Date.now() + 600_000,
  });
  expect(credentials.access.length).toBeGreaterThan(0);
  expect(credentials).not.toHaveProperty("accountId");
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
  const fetchMock = pollFetch().mockRejectedValueOnce(new TypeError("undefined is not a function"));

  await expect(startLogin(fetchMock)).rejects.toThrow("undefined is not a function");
});

it.each(["abort", "authority"] as const)(
  "stops device-code polling on %s without another request",
  async (retirement) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let current = true;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createDeviceCodeResponse("5"))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const login = startLogin(fetchMock, {
      signal: controller.signal,
      assertCurrent: () => {
        if (!current) {
          throw new Error("cancelled");
        }
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const outcome = observe(login);
    current = false;
    if (retirement === "abort") {
      controller.abort(new Error("cancelled"));
    }
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ error: expect.objectContaining({ message: "cancelled" }) });
    expect(controller.signal.aborted).toBe(retirement === "abort");
  },
);

it("treats JWT-derived expiry fallback as an absolute timestamp", async () => {
  const token = accessToken();
  const fetchMock = successfulFetch(tokenResponse(token));

  const credentials = await startLogin(fetchMock);

  expectJwtExpiry(credentials.expires, token);
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

  expectJwtExpiry(credentials.expires, token);
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
      Response.json({ error, error_description }, { status: 401 }),
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
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return createDeviceCodeResponse();
      }
      return response === "blocked headers"
        ? waitForFetchAbort(init)
        : new Response(null, { status: 404 });
    });
    let settled = false;
    const observing = observe(startLogin(fetchMock, { signal: controller.signal })).then(
      (result) => {
        settled = true;
        return result;
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
