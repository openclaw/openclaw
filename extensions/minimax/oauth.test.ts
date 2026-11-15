import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHangingLoopbackServer } from "../test-support/hanging-loopback-server.js";
import { cancelTrackedTextResponse } from "../test-support/streaming-error-response.js";
import { loginMiniMaxPortalOAuth } from "./oauth.js";

const fetchTimeoutMs = 30_000;

function captureMiniMaxOAuthFetchTimeout() {
  const originalSetTimeout = globalThis.setTimeout;
  let fireTimeout: (() => void) | undefined;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    timeout?: number,
    ...args: unknown[]
  ) => {
    // Body readers share this duration and need a refreshable timer handle.
    const timer = originalSetTimeout(() => callback(...args), timeout);
    if (timeout === fetchTimeoutMs) {
      fireTimeout = () => {
        clearTimeout(timer);
        callback(...args);
      };
    }
    return timer;
  }) as typeof setTimeout);
  return {
    fire() {
      if (!fireTimeout) {
        throw new Error("expected MiniMax OAuth fetch timeout to be scheduled");
      }
      fireTimeout();
    },
  };
}

async function expectFetchWithoutDeadlineToStayPending(params: {
  url: string;
  init?: RequestInit;
  waitForRequest: () => Promise<void>;
}) {
  const controller = new AbortController();
  const request = fetch(params.url, { ...params.init, signal: controller.signal });
  request.catch(() => undefined);
  await params.waitForRequest();

  const result = await Promise.race([
    request.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"pending">((resolve) => {
      setTimeout(() => resolve("pending"), 30);
    }),
  ]);

  controller.abort();
  await request.catch(() => undefined);
  expect(result).toBe("pending");
}

type FetchResponder =
  | Response
  | ((input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>);

function authResponse(init?: RequestInit, overrides: Record<string, unknown> = {}): Response {
  const body = typeof init?.body === "string" ? init.body : "";
  return Response.json({
    user_code: "CODE",
    verification_uri: "https://example.com/device",
    expired_in: Date.now() + 10_000,
    state: new URLSearchParams(body).get("state"),
    ...overrides,
  });
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    status: "success",
    access_token: "access",
    refresh_token: "refresh",
    expired_in: 3600,
    ...overrides,
  });
}

function stubOAuthFetch(...responders: FetchResponder[]) {
  let responseIndex = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const responder = responders[responseIndex++];
    if (!responder) {
      throw new Error(`unexpected MiniMax OAuth fetch #${responseIndex}`);
    }
    return typeof responder === "function" ? await responder(input, init) : responder;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function loginMiniMax(overrides: Partial<Parameters<typeof loginMiniMaxPortalOAuth>[0]> = {}) {
  return loginMiniMaxPortalOAuth({
    openUrl: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    progress: { update: vi.fn(), stop: vi.fn() },
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("loginMiniMaxPortalOAuth", () => {
  it("delivers the pairing code before polling for credentials", async () => {
    const deviceCode = vi.fn(async () => {});
    stubOAuthFetch(
      (_input, init) => authResponse(init),
      () => {
        expect(deviceCode).toHaveBeenCalledExactlyOnceWith({
          title: "MiniMax OAuth",
          code: "CODE",
          expiresInMinutes: 1,
          message: "Enter this one-time code to approve access.",
        });
        return tokenResponse();
      },
    );
    await loginMiniMax({ deviceCode });
  });

  it("rejects malformed token expiry through the OAuth flow", async () => {
    stubOAuthFetch((_input, init) => authResponse(init), tokenResponse({ expired_in: "3600s" }));

    await expect(loginMiniMax()).rejects.toThrow("invalid token expiry");
  });

  it.each([
    ["authorization code", "/device-code", "response_type=code", 0],
    ["token polling", "/token", "grant_type=user_code", 1],
  ] as const)(
    "times out %s HTTP requests against a hanging loopback server",
    async (_phase, path, controlBody, fetchIndex) => {
      const realFetch = fetch;
      const server = await startHangingLoopbackServer();
      const oauthTimeout = captureMiniMaxOAuthFetchTimeout();
      let loginPromise: Promise<unknown> | undefined;

      try {
        await expectFetchWithoutDeadlineToStayPending({
          url: `${server.origin}/control`,
          init: { method: "POST", body: controlBody },
          waitForRequest: () => server.waitForRequestCount(1),
        });

        const hangingResponse: FetchResponder = async (_input, init) =>
          await realFetch(`${server.origin}${path}`, init);
        const fetchMock =
          fetchIndex === 0
            ? stubOAuthFetch(hangingResponse)
            : stubOAuthFetch((_input, init) => authResponse(init), hangingResponse);

        loginPromise = loginMiniMax();
        loginPromise.catch(() => undefined);

        await server.waitForRequestCount(2);
        oauthTimeout.fire();
        await expect(
          withTimeout(loginPromise, 2_000, {
            message: "MiniMax OAuth did not settle within the test deadline",
          }),
        ).rejects.toHaveProperty("name", expect.stringMatching(/^(AbortError|TimeoutError)$/));
        expect(server.requests).toContain(path);
        expect(fetchMock.mock.calls[fetchIndex]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      } finally {
        await server.close();
        await loginPromise?.catch(() => undefined);
      }
    },
  );

  it.each([
    ["authorization", false, 503],
    ["token", true, 503],
    ["HTTP 200 token", true, 200],
  ] as const)("bounds %s bodies without using response.text()", async (name, token, status) => {
    const malformed = status === 200;
    const chunk = malformed ? '{"status":"error","detail":"' : `minimax ${name} unavailable `;
    const message = malformed
      ? "MiniMax OAuth failed to parse response."
      : expect.stringContaining(
          token
            ? "minimax token unavailable"
            : "MiniMax OAuth authorization failed: minimax authorization unavailable",
        );
    const tracked = cancelTrackedTextResponse(`${chunk.repeat(malformed ? 512 : 1024)}tail`, {
      status,
      headers: { "Content-Type": status === 200 ? "application/json" : "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    if (token) {
      stubOAuthFetch((_input, init) => authResponse(init), tracked.response);
    } else {
      stubOAuthFetch(tracked.response);
    }
    const error = await loginMiniMax().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toEqual(message);
    expect((error as Error).message).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("records the issuing account endpoint for Global and CN credentials", async () => {
    for (const [region, host] of [
      ["global", "https://account.minimax.io"],
      ["cn", "https://account.minimaxi.com"],
    ] as const) {
      const fetchMock = stubOAuthFetch((_input, init) => authResponse(init), tokenResponse());

      const expectedHosts = [`${host}/oauth2/device/code`, `${host}/oauth2/token`];
      await expect(loginMiniMax({ region })).resolves.toMatchObject({
        tokenEndpoint: expectedHosts[1],
      });
      expect(
        fetchMock.mock.calls.map(([input]) =>
          input instanceof Request ? input.url : String(input),
        ),
      ).toEqual(expectedHosts);

      vi.unstubAllGlobals();
    }
  });

  it("rejects Date-invalid authorization expiries before formatting instructions", async () => {
    stubOAuthFetch((_input, init) => authResponse(init, { expired_in: 8_700_000_000_000_000 }));
    const note = vi.fn(async () => undefined);

    await expect(loginMiniMax({ note })).rejects.toThrow("invalid expired_in");
    expect(note).not.toHaveBeenCalled();
  });

  it.each([
    ["caps oversized poll intervals", MAX_TIMER_TIMEOUT_MS + 10_000, MAX_TIMER_TIMEOUT_MS, true],
    ["does not sleep past authorization expiry", 10_000, 10_000, false],
  ] as const)("%s before scheduling", async (_name, expiresIn, delay, succeeds) => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    stubOAuthFetch(
      (_input, init) =>
        authResponse(init, {
          expired_in: Date.now() + expiresIn,
          interval: Number.MAX_SAFE_INTEGER,
        }),
      Response.json({ status: "pending" }),
      ...(succeeds ? [tokenResponse()] : []),
    );

    const result = loginMiniMax();

    await vi.waitFor(() => {
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), delay);
    });

    const outcome = succeeds
      ? expect(result).resolves.toMatchObject({ access: "access", refresh: "refresh" })
      : expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(delay);
    await outcome;
  });
});
