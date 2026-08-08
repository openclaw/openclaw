import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
// Qqbot tests cover api-client plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../../../../test-support/streaming-error-response.js";
import {
  lowercasePercentEscapes,
  stringifyWithSlashEscapedCredential,
} from "../../test-support/credential-reflection.js";

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

import { ApiError } from "../types.js";
import { ApiClient } from "./api-client.js";

const loopbackServers: Array<{ close: () => Promise<void> }> = [];

async function startReflectedAuthorizationServer(): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    const authorization = req.headers.authorization ?? "";
    const reflectedCredential = authorization.startsWith("QQBot ")
      ? authorization.slice("QQBot ".length)
      : authorization;
    const encodedCredential = lowercasePercentEscapes(encodeURIComponent(reflectedCredential));
    const formEncodedCredential = lowercasePercentEscapes(
      new URLSearchParams([["echo", reflectedCredential]]).toString(),
    );
    const slashEscapedCredential = reflectedCredential.replaceAll("/", "\\/");
    const slashEscapedAuthorization = authorization.replaceAll(
      reflectedCredential,
      slashEscapedCredential,
    );

    if (req.url === "/json-error") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(
        stringifyWithSlashEscapedCredential(
          {
            code: 40093001,
            message: `json-marker reflected credential ${reflectedCredential}; encoded ${encodedCredential}; form ${formEncodedCredential}; Authorization: ${authorization}`,
          },
          reflectedCredential,
        ),
      );
      return;
    }
    if (req.url === "/text-error") {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end(
        `plain-marker reflected credential ${slashEscapedCredential}; encoded ${encodedCredential}; form ${formEncodedCredential}; Authorization: ${slashEscapedAuthorization}`,
      );
      return;
    }
    if (req.url === "/success") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ authorization, marker: "success-marker" }));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  loopbackServers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function captureApiError(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected ApiClient request to fail");
}

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
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
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

describe("ApiClient", () => {
  afterEach(async () => {
    const pendingServers = loopbackServers.splice(0);
    await Promise.all(pendingServers.map((server) => server.close()));
    vi.useRealTimers();
    vi.restoreAllMocks();
    fetchWithSsrFGuardMock.mockReset();
  });

  it("redacts reflected credentials from JSON, text, and debug output over real transport", async () => {
    const actualGuard = ssrfRuntimeActual.fetchWithSsrFGuard;
    if (!actualGuard) {
      throw new Error("expected the real SSRF guard implementation");
    }
    const baseUrl = await startReflectedAuthorizationServer();
    // Exercise the real guard and global fetch; only permit the test-owned
    // loopback host that production QQBot policy intentionally rejects.
    fetchWithSsrFGuardMock.mockImplementation(
      async (request: Parameters<typeof actualGuard>[0]) =>
        await actualGuard({
          ...request,
          policy: { ...request.policy, allowedHostnames: ["127.0.0.1"] },
        }),
    );

    const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const secretPrefix = "qQApiP";
    const secretSuffix = "aSfQ";
    const accessToken = `${secretPrefix}/UNIQUE~QQBOTSECRET+${secretSuffix}`;
    const encodedCredential = encodeURIComponent(accessToken);
    const formEncodedCredential = new URLSearchParams([["echo", accessToken]]).toString();
    const lowercaseEncodedCredential = lowercasePercentEscapes(encodedCredential);
    const lowercaseFormEncodedCredential = lowercasePercentEscapes(formEncodedCredential);
    const slashEscapedCredential = accessToken.replaceAll("/", "\\/");
    const authorization = `QQBot ${accessToken}`;
    const client = new ApiClient({ baseUrl, logger });

    const jsonError = await captureApiError(() =>
      client.request(accessToken, "GET", "/json-error"),
    );
    expect(jsonError.httpStatus).toBe(429);
    expect(jsonError.bizCode).toBe(40093001);
    expect(jsonError.message).toContain("json-marker");
    expect(jsonError.bizMessage).toContain("json-marker");
    expect(jsonError.message).not.toContain(accessToken);
    expect(jsonError.bizMessage).not.toContain(accessToken);
    expect(jsonError.message).not.toContain(encodedCredential);
    expect(jsonError.bizMessage).not.toContain(encodedCredential);
    expect(jsonError.message).not.toContain(formEncodedCredential);
    expect(jsonError.bizMessage).not.toContain(formEncodedCredential);
    expect(jsonError.message).not.toContain(lowercaseEncodedCredential);
    expect(jsonError.bizMessage).not.toContain(lowercaseEncodedCredential);
    expect(jsonError.message).not.toContain(lowercaseFormEncodedCredential);
    expect(jsonError.bizMessage).not.toContain(lowercaseFormEncodedCredential);
    expect(jsonError.message).not.toContain(slashEscapedCredential);
    expect(jsonError.bizMessage).not.toContain(slashEscapedCredential);
    expect(jsonError.message).not.toContain(secretPrefix);
    expect(jsonError.bizMessage).not.toContain(secretSuffix);
    expect(jsonError.message).not.toContain("UNIQUEQQBOTSECRET");

    const textError = await captureApiError(() =>
      client.request(accessToken, "GET", "/text-error"),
    );
    expect(textError.httpStatus).toBe(503);
    expect(textError.bizCode).toBeUndefined();
    expect(textError.message).toContain("plain-marker");
    expect(textError.message).not.toContain(accessToken);
    expect(textError.message).not.toContain(encodedCredential);
    expect(textError.message).not.toContain(formEncodedCredential);
    expect(textError.message).not.toContain(lowercaseEncodedCredential);
    expect(textError.message).not.toContain(lowercaseFormEncodedCredential);
    expect(textError.message).not.toContain(slashEscapedCredential);
    expect(textError.message).not.toContain(secretPrefix);
    expect(textError.message).not.toContain(secretSuffix);
    expect(textError.message).not.toContain("UNIQUEQQBOTSECRET");

    const success = await client.request<{ authorization: string; marker: string }>(
      accessToken,
      "GET",
      "/success",
    );
    expect(success).toEqual({ authorization, marker: "success-marker" });

    const debugOutput = logger.debug.mock.calls.flat().join("\n");
    expect(debugOutput).toContain("json-marker");
    expect(debugOutput).toContain("plain-marker");
    expect(debugOutput).toContain("success-marker");
    expect(debugOutput).not.toContain(accessToken);
    expect(debugOutput).not.toContain(encodedCredential);
    expect(debugOutput).not.toContain(formEncodedCredential);
    expect(debugOutput).not.toContain(lowercaseEncodedCredential);
    expect(debugOutput).not.toContain(lowercaseFormEncodedCredential);
    expect(debugOutput).not.toContain(slashEscapedCredential);
    expect(debugOutput).not.toContain(secretPrefix);
    expect(debugOutput).not.toContain(secretSuffix);
    expect(debugOutput).not.toContain("UNIQUEQQBOTSECRET");

    const redactedSurfaces = [
      jsonError.message,
      jsonError.bizMessage,
      textError.message,
      debugOutput,
    ].join("\n");
    const proofHeadSha = process.env.OPENCLAW_PROOF_HEAD_SHA;
    if (proofHeadSha) {
      if (!/^[0-9a-f]{40}$/.test(proofHeadSha)) {
        throw new Error("OPENCLAW_PROOF_HEAD_SHA must be a full Git SHA");
      }
      console.info(
        `[qqbot credential redaction proof] ${JSON.stringify({
          exactHead: proofHeadSha,
          transport: "loopback-http",
          status: [jsonError.httpStatus, textError.httpStatus, 200],
          path: ["/json-error", "/text-error", "/success"],
          safeMarkerPresent:
            redactedSurfaces.includes("json-marker") &&
            redactedSurfaces.includes("plain-marker") &&
            redactedSurfaces.includes("success-marker"),
          tokenAbsent: !redactedSurfaces.includes(accessToken),
          encodedAbsent: !redactedSurfaces.includes(encodedCredential),
          formEncodedAbsent: !redactedSurfaces.includes(formEncodedCredential),
          lowercaseEncodedAbsent: !redactedSurfaces.includes(lowercaseEncodedCredential),
          lowercaseFormEncodedAbsent: !redactedSurfaces.includes(lowercaseFormEncodedCredential),
          jsonSlashEscapedAbsent: !redactedSurfaces.includes(slashEscapedCredential),
          prefixAbsent: !redactedSurfaces.includes(secretPrefix),
          suffixAbsent: !redactedSurfaces.includes(secretSuffix),
          fragmentAbsent: !redactedSurfaces.includes("UNIQUEQQBOTSECRET"),
        })}`,
      );
    }
  });

  it("bounds error bodies on a UTF-16 boundary without using response.text()", async () => {
    const release = vi.fn(async () => {});
    const safePrefix = "x".repeat(199);
    const tracked = cancelTrackedResponse(`${safePrefix}🎉${"tail".repeat(4096)}`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: tracked.response,
      release,
    });

    const client = new ApiClient({ baseUrl: "https://qqbot.test" });

    let error: unknown;
    try {
      await client.request("token-1", "GET", "/v2/users/@me");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).toBe(`API Error [/v2/users/@me] HTTP 503: ${safePrefix}`);
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://qqbot.test/v2/users/@me",
      init: {
        method: "GET",
        headers: {
          Authorization: "QQBot token-1",
          "Content-Type": "application/json",
          "User-Agent": "QQBotPlugin/unknown",
        },
      },
      auditContext: "qqbot-api",
      policy: {
        hostnameAllowlist: ["qqbot.test"],
        allowRfc2544BenchmarkRange: true,
      },
      timeoutMs: 30_000,
    });
  });

  it("adds network and whitelist guidance to DNS failures without suggesting credentials", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(
      new Error("getaddrinfo ENOTFOUND api.sgroup.qq.com"),
    );

    const client = new ApiClient({ baseUrl: "https://qqbot.test" });
    let error: unknown;
    try {
      await client.request("token-1", "GET", "/v2/users/@me");
    } catch (caught) {
      error = caught;
    }

    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("Network error [/v2/users/@me]");
    expect(message).toContain("network connectivity and DNS");
    expect(message).toContain("server IP whitelist");
    expect(message).not.toContain("appId");
    expect(message).not.toContain("clientSecret");
  });

  it("adds credential guidance to structured HTTP 401 errors", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response('{"code":11241,"message":"invalid credentials"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
      release,
    });

    const client = new ApiClient({ baseUrl: "https://qqbot.test" });
    let error: unknown;
    try {
      await client.request("token-1", "POST", "/v2/messages", { content: "hi" });
    } catch (caught) {
      error = caught;
    }

    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("API Error [/v2/messages]: invalid credentials");
    expect(message).toContain("QQBot account appId and clientSecret");
    expect(message).toContain("https://q.qq.com/");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("adds credential guidance when QQ reports an expired token as HTTP 500", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response('{"code":11244,"message":"token not exist or expire"}', {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
      release,
    });

    const client = new ApiClient({ baseUrl: "https://qqbot.test" });
    let error: unknown;
    try {
      await client.request("token-1", "GET", "/gateway");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ httpStatus: 500, bizCode: 11244 });
    expect((error as Error).message).toContain("QQBot account appId and clientSecret");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps non-auth structured API guidance generic", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response('{"code":40034025,"message":"invalid event id"}', {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
      release,
    });

    const client = new ApiClient({ baseUrl: "https://qqbot.test" });
    let error: unknown;
    try {
      await client.request("token-1", "POST", "/v2/messages", { content: "hi" });
    } catch (caught) {
      error = caught;
    }

    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("API Error [/v2/messages]: invalid event id");
    expect(message).toContain("QQBot API troubleshooting");
    expect(message).not.toContain("appId");
    expect(message).not.toContain("clientSecret");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds successful response bodies without using response.text()", async () => {
    const release = vi.fn(async () => {});
    const streamed = createStreamingResponse({
      chunkCount: 32,
      chunkSize: 1024 * 1024,
      text: "x",
      headers: { "content-type": "application/json" },
    });
    const textSpy = vi.spyOn(streamed.response, "text").mockRejectedValue(new Error("unbounded"));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: streamed.response,
      release,
    });

    const client = new ApiClient({ baseUrl: "https://qqbot.test" });

    let error: unknown;
    try {
      await client.request("token-1", "GET", "/v2/users/@me");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect(String(error)).toContain("QQBot API response: text response exceeds 16777216 bytes");
    expect(streamed.getReadCount()).toBeLessThan(32);
    expect(streamed.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([0, 25])(
    "keeps the %dms request deadline active while reading a hanging response body",
    async (timeoutMs) => {
      vi.useFakeTimers();
      const actualGuard = ssrfRuntimeActual.fetchWithSsrFGuard;
      if (!actualGuard) {
        throw new Error("expected the real SSRF guard implementation");
      }
      let requestSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("expected the guarded fetch to pass its deadline signal");
        }
        requestSignal = signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      const lookupFn = vi.fn(async () => [
        { address: "93.184.216.34", family: 4 },
      ]) as unknown as LookupFn;
      fetchWithSsrFGuardMock.mockImplementationOnce(
        async (request: Parameters<typeof actualGuard>[0]) =>
          await actualGuard({ ...request, fetchImpl, lookupFn }),
      );

      const client = new ApiClient({
        baseUrl: "https://qqbot.test",
        defaultTimeoutMs: timeoutMs,
      });

      const rejection = expect(client.request("token-1", "GET", "/v2/users/@me")).rejects.toThrow(
        `Request timeout [/v2/users/@me]: exceeded ${timeoutMs}ms`,
      );
      const guardedTimeoutMs = Math.max(1, timeoutMs);
      await vi.advanceTimersByTimeAsync(guardedTimeoutMs);

      await rejection;
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: guardedTimeoutMs }),
      );
      expect(requestSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
