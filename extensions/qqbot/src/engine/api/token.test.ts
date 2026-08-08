// Qqbot tests cover token plugin behavior.
import { getEventListeners } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lowercasePercentEscapes,
  stringifyWithSlashEscapedCredential,
} from "../../test-support/credential-reflection.js";
import { withLoopbackHttpServer } from "../../test-support/loopback-http.js";
import { TokenManager } from "./token.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const ssrfRuntimeActual = vi.hoisted(() => ({
  fetchWithSsrFGuard: undefined as
    | typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard
    | undefined,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  ssrfRuntimeActual.fetchWithSsrFGuard = actual.fetchWithSsrFGuard;
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function mockGuardedTokenResponse(body: BodyInit, init?: ResponseInit): ReturnType<typeof vi.fn> {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: new Response(body, init),
    release,
  });
  return release;
}

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  release: ReturnType<typeof vi.fn>;
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  const release = vi.fn(async () => {});
  const response = new Response(stream, init);
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
  return {
    release,
    response,
    wasCanceled: () => canceled,
  };
}

describe("QQBot token manager", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("wraps malformed access token JSON", async () => {
    const release = mockGuardedTokenResponse("{not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(new TokenManager().getAccessToken("app-id", "secret")).rejects.toThrow(
      "QQBot access_token response was malformed JSON",
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://bots.qq.com/app/getAppAccessToken",
      auditContext: "qqbot-token",
      capture: false,
      policy: {
        hostnameAllowlist: ["bots.qq.com"],
        allowRfc2544BenchmarkRange: true,
      },
      timeoutMs: 30_000,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "QQBotPlugin/unknown",
        },
        body: JSON.stringify({ appId: "app-id", clientSecret: "secret" }),
      },
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("adds account-neutral credential guidance when the token endpoint omits access_token", async () => {
    const clientSecret = "guidance-credential-qQ7x9V2";
    const release = mockGuardedTokenResponse('{"code":4001,"message":"invalid app secret"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    let error: unknown;
    try {
      await new TokenManager().getAccessToken("app-id", clientSecret);
    } catch (caught) {
      error = caught;
    }

    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("Failed to get QQBot access_token");
    expect(message).toContain("QQBot account appId and clientSecret");
    expect(message).toContain("https://q.qq.com/");
    expect(message).toContain('{"code":4001,"message":"invalid app secret"}');
    expect(message).not.toContain("QQBOT_APP_ID");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds access token responses without using response.text()", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const tracked = cancelTrackedResponse(`${"qqbot token unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));

    await expect(new TokenManager({ logger }).getAccessToken("app-id", "secret")).rejects.toThrow(
      "QQBot access_token response was malformed JSON",
    );

    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(tracked.release).toHaveBeenCalledTimes(1);
    const debugOutput = logger.debug.mock.calls.join("\n");
    expect(debugOutput).toContain("<malformed JSON body omitted>");
    expect(debugOutput).not.toContain("qqbot token unavailable");
    expect(debugOutput).not.toContain("tail");
  });

  it("omits malformed token response bodies from diagnostics", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const tokenPrefix = "qQMalformedP";
    const tokenFragment = "issued-token-fragment";
    const tokenSuffix = "tSfQ";
    const accessToken = [tokenPrefix, tokenFragment, tokenSuffix].join("/");
    const malformedBody = ['{"access_token":"', accessToken, '",'].join("");
    mockGuardedTokenResponse(malformedBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(new TokenManager({ logger }).getAccessToken("app-id", "secret")).rejects.toThrow(
      "QQBot access_token response was malformed JSON",
    );

    const debugOutput = logger.debug.mock.calls.join("\n");
    expect(debugOutput).toContain("<malformed JSON body omitted>");
    expect(debugOutput).not.toContain(accessToken);
    expect(debugOutput).not.toContain(tokenPrefix);
    expect(debugOutput).not.toContain(tokenFragment);
    expect(debugOutput).not.toContain(tokenSuffix);
  });

  it("redacts a reflected client secret before logging or throwing token errors", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const secretPrefix = "qQTokP";
    const secretSuffix = "tSfQ";
    const clientSecret = `${secretPrefix}/reflected~secret+${secretSuffix}`;
    const encodedCredential = encodeURIComponent(clientSecret);
    const formEncodedCredential = new URLSearchParams([["echo", clientSecret]]).toString();
    const lowercaseEncodedCredential = lowercasePercentEscapes(encodedCredential);
    const lowercaseFormEncodedCredential = lowercasePercentEscapes(formEncodedCredential);
    const slashEscapedCredential = clientSecret.replaceAll("/", "\\/");
    await withLoopbackHttpServer(
      (request, response) => {
        void readRequestBody(request).then(
          (rawBody) => {
            const parsed = JSON.parse(rawBody) as { clientSecret?: unknown };
            const reflectedCredential =
              typeof parsed.clientSecret === "string" ? parsed.clientSecret : "missing";
            const reflectedFormCredential = new URLSearchParams([
              ["echo", reflectedCredential],
            ]).toString();
            response.writeHead(401, { "content-type": "application/json" });
            response.end(
              stringifyWithSlashEscapedCredential(
                {
                  code: 11244,
                  message: "credential rejected",
                  clientSecret: reflectedCredential,
                  client_secret: reflectedCredential,
                  echoed: reflectedCredential,
                  encoded: lowercasePercentEscapes(encodeURIComponent(reflectedCredential)),
                  form: lowercasePercentEscapes(reflectedFormCredential),
                  request_id: "token-visible-123",
                },
                reflectedCredential,
              ),
            );
          },
          () => {
            response.writeHead(500, { "content-type": "text/plain" });
            response.end("request body read failed");
          },
        );
      },
      async (baseUrl) => {
        const actualGuard = ssrfRuntimeActual.fetchWithSsrFGuard;
        if (!actualGuard) {
          throw new Error("expected the real SSRF guard implementation");
        }
        const loopbackFetch = vi.fn(
          async (_input: RequestInfo | URL, init?: RequestInit) =>
            await fetch(`${baseUrl}/token`, init),
        );
        fetchWithSsrFGuardMock.mockImplementationOnce(
          async (request: Parameters<typeof actualGuard>[0]) =>
            await actualGuard({ ...request, fetchImpl: loopbackFetch }),
        );

        let error: unknown;
        try {
          await new TokenManager({ logger }).getAccessToken("app-id", clientSecret);
        } catch (caught) {
          error = caught;
        }

        expect(error).toBeInstanceOf(Error);
        const message = error instanceof Error ? error.message : String(error);
        const debugOutput = logger.debug.mock.calls.flat().join("\n");
        for (const output of [debugOutput, message]) {
          expect(output).toContain("token-visible-123");
          expect(output).not.toContain(clientSecret);
          expect(output).not.toContain(encodedCredential);
          expect(output).not.toContain(formEncodedCredential);
          expect(output).not.toContain(lowercaseEncodedCredential);
          expect(output).not.toContain(lowercaseFormEncodedCredential);
          expect(output).not.toContain(slashEscapedCredential);
          expect(output).not.toContain(secretPrefix);
          expect(output).not.toContain(secretSuffix);
          expect(output).not.toContain("reflected-secret");
        }
        expect(loopbackFetch).toHaveBeenCalledTimes(1);

        const proofHeadSha = process.env.OPENCLAW_PROOF_HEAD_SHA;
        if (proofHeadSha) {
          if (!/^[0-9a-f]{40}$/.test(proofHeadSha)) {
            throw new Error("OPENCLAW_PROOF_HEAD_SHA must be a full Git SHA");
          }
          console.info(
            `[qqbot token credential redaction proof] ${JSON.stringify({
              exactHead: proofHeadSha,
              transport: "loopback-http",
              status: 401,
              debugSafeMarkerPresent: debugOutput.includes("token-visible-123"),
              errorSafeMarkerPresent: message.includes("token-visible-123"),
              debugSecretAbsent: !debugOutput.includes(clientSecret),
              errorSecretAbsent: !message.includes(clientSecret),
              debugEncodedAbsent: !debugOutput.includes(encodedCredential),
              errorEncodedAbsent: !message.includes(encodedCredential),
              debugFormEncodedAbsent: !debugOutput.includes(formEncodedCredential),
              errorFormEncodedAbsent: !message.includes(formEncodedCredential),
              debugLowercaseEncodedAbsent: !debugOutput.includes(lowercaseEncodedCredential),
              errorLowercaseEncodedAbsent: !message.includes(lowercaseEncodedCredential),
              debugLowercaseFormEncodedAbsent: !debugOutput.includes(
                lowercaseFormEncodedCredential,
              ),
              errorLowercaseFormEncodedAbsent: !message.includes(lowercaseFormEncodedCredential),
              debugJsonSlashEscapedAbsent: !debugOutput.includes(slashEscapedCredential),
              errorJsonSlashEscapedAbsent: !message.includes(slashEscapedCredential),
              debugPrefixAbsent: !debugOutput.includes(secretPrefix),
              errorPrefixAbsent: !message.includes(secretPrefix),
              debugSuffixAbsent: !debugOutput.includes(secretSuffix),
              errorSuffixAbsent: !message.includes(secretSuffix),
              debugFragmentAbsent: !debugOutput.includes("reflected-secret"),
              errorFragmentAbsent: !message.includes("reflected-secret"),
            })}`,
          );
        }
      },
    );
  });

  it("fully redacts issued access tokens from successful token diagnostics", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const tokenPrefix = "qQIssuedP";
    const tokenSuffix = "tSfQ";
    const accessToken = [tokenPrefix, "UNIQUE-ISSUED-TOKEN", tokenSuffix].join("/");
    mockGuardedTokenResponse(
      JSON.stringify({
        access_token: accessToken,
        expires_in: 7200,
        marker: "issued-token-visible-123",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );

    await expect(
      new TokenManager({ logger }).getAccessToken("app-id", "client-secret"),
    ).resolves.toBe(accessToken);

    const debugOutput = logger.debug.mock.calls.flat().join("\n");
    expect(debugOutput).toContain("issued-token-visible-123");
    expect(debugOutput).not.toContain(accessToken);
    expect(debugOutput).not.toContain(tokenPrefix);
    expect(debugOutput).not.toContain(tokenSuffix);
    expect(debugOutput).not.toContain("UNIQUE-ISSUED-TOKEN");
  });

  it("passes the RFC2544 SSRF allowance to the token fetch (regression for #88984)", async () => {
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":7200}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(new TokenManager().getAccessToken("app-id", "secret")).resolves.toBe("token-1");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://bots.qq.com/app/getAppAccessToken",
        auditContext: "qqbot-token",
        policy: {
          hostnameAllowlist: ["bots.qq.com"],
          allowRfc2544BenchmarkRange: true,
        },
      }),
    );
  });

  it("does not cache access tokens forever when expires_in is unsafe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":1e309}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const manager = new TokenManager();
    await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-1");

    const status = manager.getStatus("app-id");
    expect(status.status).toBe("valid");
    expect(status.expiresAt).toBe(Date.now() + 7200 * 1000);
  });

  it("does not extend explicit non-positive token lifetimes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":0}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const manager = new TokenManager();
    await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-1");

    expect(manager.getStatus("app-id")).toEqual({
      status: "expired",
      expiresAt: Date.now(),
    });
  });

  it("does not cache fetched tokens when the process clock is outside the Date range", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":7200}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const manager = new TokenManager({ logger });
    try {
      await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-1");
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(manager.getStatus("app-id")).toEqual({ status: "none", expiresAt: null });
    expect(logger.debug).toHaveBeenCalledWith(
      "[qqbot:token:app-id] Not cached: invalid process clock",
    );
  });

  it("times out one stalled token fetch for every singleflight waiter and allows retry", async () => {
    vi.useFakeTimers();
    const { fetchWithSsrFGuard } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/ssrf-runtime")
    >("openclaw/plugin-sdk/ssrf-runtime");
    fetchWithSsrFGuardMock.mockImplementation(fetchWithSsrFGuard);

    let fetchSignal: AbortSignal | undefined;
    const stalledFetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          fetchSignal = init?.signal ?? undefined;
          if (!fetchSignal) {
            reject(new Error("missing guarded fetch signal"));
            return;
          }
          fetchSignal.addEventListener(
            "abort",
            () => {
              const reason = fetchSignal?.reason;
              const error =
                reason instanceof Error ? reason : new Error("request aborted", { cause: reason });
              reject(error);
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", stalledFetch);

    const manager = new TokenManager();
    const first = manager.getAccessToken("app-id", "secret");
    const second = manager.getAccessToken(" app-id ", "secret");
    const outcomes = Promise.allSettled([first, second]);

    await vi.advanceTimersByTimeAsync(0);
    expect(stalledFetch).toHaveBeenCalledTimes(1);
    expect(manager.getStatus("app-id").status).toBe("refreshing");

    await vi.advanceTimersByTimeAsync(30_000);
    const [firstOutcome, secondOutcome] = await outcomes;
    expect(fetchSignal?.aborted).toBe(true);
    expect(firstOutcome.status).toBe("rejected");
    expect(secondOutcome.status).toBe("rejected");
    if (firstOutcome.status !== "rejected" || secondOutcome.status !== "rejected") {
      throw new Error("expected every singleflight waiter to reject");
    }
    const timeoutError = firstOutcome.reason as Error;
    expect(timeoutError).toBe(secondOutcome.reason);
    expect(timeoutError.message).toContain("Network error getting access_token: request timed out");
    expect(timeoutError.message).toContain("Check network connectivity and DNS");
    expect(timeoutError.message).toContain("server IP whitelist");
    expect(timeoutError.message).not.toContain("appId");
    expect(timeoutError.cause).toMatchObject({
      name: "TimeoutError",
      message: "request timed out",
    });
    expect(manager.getStatus("app-id")).toEqual({ status: "none", expiresAt: null });

    stalledFetch.mockResolvedValueOnce(
      new Response('{"access_token":"token-2","expires_in":7200}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-2");
    expect(stalledFetch).toHaveBeenCalledTimes(2);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
  });

  it("yields and does not grow abort listeners across zero-delay refresh sleeps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));

    const accessTokenField = ["access", "token"].join("_");
    for (let i = 1; i <= 4; i += 1) {
      const body = JSON.stringify({ [accessTokenField]: `token-${i}`, expires_in: 0 });
      mockGuardedTokenResponse(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const addListenerSpy = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const activeAbortListenerCount = () =>
      [...new Set(addListenerSpy.mock.instances)]
        .filter((signal): signal is AbortSignal => signal instanceof AbortSignal)
        .reduce((count, signal) => count + getEventListeners(signal, "abort").length, 0);

    const manager = new TokenManager();
    try {
      manager.startBackgroundRefresh("app-id", "secret", {
        refreshAheadMs: 0,
        randomOffsetMs: 0,
        minRefreshIntervalMs: 0,
        retryDelayMs: 0,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
      expect(activeAbortListenerCount()).toBe(1);

      for (let cycle = 2; cycle <= 4; cycle += 1) {
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(cycle);
        expect(activeAbortListenerCount()).toBe(1);
      }
    } finally {
      manager.stopBackgroundRefresh("app-id");
      await vi.advanceTimersByTimeAsync(0);
      try {
        expect(activeAbortListenerCount()).toBe(0);
      } finally {
        addListenerSpy.mockRestore();
      }
    }
  });
});
