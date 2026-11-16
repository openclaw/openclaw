import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { jsonResponse, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "./credential-lease.runtime.js";

type CredentialPayload = { groupId: string; driverToken: string; sutToken: string };
const brokerUrl = "https://qa-cred.example.convex.site";
const ciEnv = { OPENCLAW_QA_CONVEX_SITE_URL: brokerUrl, OPENCLAW_QA_CONVEX_SECRET_CI: "ci-secret" };
const maintainerEnv = {
  OPENCLAW_QA_CONVEX_SITE_URL: brokerUrl,
  OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maintainer-secret",
};
const convexOptions = {
  kind: "telegram",
  source: "convex" as const,
  resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
  parsePayload: (payload: unknown) => payload as CredentialPayload,
};
const ciOptions = { ...convexOptions, role: "ci", env: ciEnv };
const credentials = { groupId: "-100123", driverToken: "driver", sutToken: "sut" };

function acquireCi(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = ciEnv) {
  return acquireQaCredentialLease({ ...ciOptions, env, fetchImpl });
}

function acquireTimed(fetchImpl: typeof fetch, parsePayload = () => ({})) {
  return acquireQaCredentialLease({ ...ciOptions, fetchImpl, parsePayload });
}

function acquireMaintainer(
  overrides: Partial<Parameters<typeof acquireQaCredentialLease<CredentialPayload>>[0]> = {},
  env: NodeJS.ProcessEnv = {},
) {
  return acquireQaCredentialLease({
    ...convexOptions,
    role: "maintainer",
    ...overrides,
    env: { ...maintainerEnv, ...env },
  });
}

function acquireWithEnv(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch) {
  return acquireMaintainer({ fetchImpl }, env);
}

function brokerOperation(url: Parameters<typeof fetch>[0]) {
  return new URL(url instanceof Request ? url.url : url).pathname.split("/").at(-1)!;
}

function acquired(payload: unknown, credentialId = "owned", leaseToken = "synthetic") {
  return { status: "ok", credentialId, leaseToken, payload };
}

function chunked(byteLength: number, chunkCount: number, id: string) {
  return acquired(
    { __openclawQaCredentialPayloadChunksV1: true, byteLength, chunkCount },
    `cred-${id}`,
    `lease-${id}`,
  );
}

function replies(...payloads: unknown[]) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const payload of payloads) {
    fetchImpl.mockResolvedValueOnce(jsonResponse(payload));
  }
  return fetchImpl;
}

function retryClock() {
  const sleeps: number[] = [];
  let nowMs = 0;
  return {
    sleeps,
    randomImpl: () => 0,
    timeImpl: () => nowMs,
    sleepImpl: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  };
}

function startHeartbeat(heartbeat: () => Promise<void>) {
  return startQaCredentialLeaseHeartbeat({
    source: "convex",
    kind: "telegram",
    heartbeatIntervalMs: 50,
    heartbeat,
  });
}

type FetchMock = { mock: { calls: Parameters<typeof fetch>[] } };

function expectOperations(fetchImpl: FetchMock, ...operations: string[]) {
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(
    operations.map((operation) => `${brokerUrl}/qa-credentials/v1/${operation}`),
  );
}

function expectAuthorization(fetchImpl: FetchMock, token: string) {
  expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
    `Bearer ${token}`,
  );
}

describe("credential lease runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("releases leases that expire while the monotonic clock is paused", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(42);
    const operations: string[] = [];
    await expect(
      acquireTimed(
        async (url) => {
          const operation = brokerOperation(url);
          operations.push(operation);
          return jsonResponse(
            operation === "acquire" ? { ...acquired({}), leaseTtlMs: 100 } : { status: "ok" },
          );
        },
        () => {
          vi.setSystemTime(Date.now() + 101);
          return {};
        },
      ),
    ).rejects.toThrow("could not be confirmed before use");
    expect(performance.now()).toBe(42);
    expect(operations).toEqual(["acquire", "release"]);
  });

  it("rejects renewal after expiry and revokes authority before release settles", async () => {
    vi.useFakeTimers();
    const heartbeatReply = Promise.withResolvers<Response>();
    const releaseReply = Promise.withResolvers<Response>();
    const operations: string[] = [];
    const lease = await acquireTimed(async (url) => {
      const operation = brokerOperation(url);
      operations.push(operation);
      if (operation === "heartbeat") {
        return heartbeatReply.promise;
      }
      if (operation === "release") {
        return releaseReply.promise;
      }
      return jsonResponse({ ...acquired({}), leaseTtlMs: 100 });
    });
    const renewal = lease.heartbeat();
    vi.setSystemTime(Date.now() + 101);
    expect(() => lease.assertHealthy()).toThrow("expired");
    heartbeatReply.resolve(jsonResponse({ status: "ok" }));
    await expect(renewal).rejects.toThrow("expired");
    const release = lease.release();
    expect(() => lease.assertHealthy()).toThrow("released");
    await expect(lease.heartbeat()).rejects.toThrow("released");
    const duplicateRelease = lease.release();
    releaseReply.resolve(jsonResponse({ status: "ok" }));
    await Promise.all([release, duplicateRelease]);
    expect(operations).toEqual(["acquire", "heartbeat", "release"]);
  });

  it("uses env credentials by default", async () => {
    const lease = await acquireQaCredentialLease({
      kind: "telegram",
      resolveEnvPayload: () => credentials,
      parsePayload: () => {
        throw new Error("should not parse convex payload in env mode");
      },
      env: {},
    });

    expect(lease.source).toBe("env");
    expect(lease.payload).toEqual(credentials);
  });

  it("acquires, heartbeats, and releases convex credentials", async () => {
    const fetchImpl = replies(
      {
        ...acquired(credentials, "cred-1", "lease-1"),
        leaseTtlMs: 1_200_000,
        heartbeatIntervalMs: 30_000,
      },
      { status: "ok" },
      { status: "ok" },
    );
    const lease = await acquireMaintainer({ fetchImpl, role: undefined });
    expect(lease).toMatchObject({ source: "convex", credentialId: "cred-1", payload: credentials });
    await lease.heartbeat();
    await lease.release();
    expectOperations(fetchImpl, "acquire", "heartbeat", "release");
    expectAuthorization(fetchImpl, "maintainer-secret");
  });

  it("cancels a streaming convex broker failure body after the response cap", async () => {
    const chunk = Buffer.alloc(64 * 1024, "x");
    const totalBytes = 4 * 1024 * 1024;
    let bytesWritten = 0;
    let requestCount = 0;
    const closed = Promise.withResolvers<void>();

    await withServer(
      (_req, res) => {
        requestCount += 1;
        res.writeHead(500, { "content-type": "text/plain" });
        const interval = setInterval(() => {
          if (bytesWritten >= totalBytes || res.destroyed) {
            clearInterval(interval);
            if (!res.destroyed) {
              res.end();
            }
            return;
          }
          bytesWritten += chunk.length;
          res.write(chunk);
        }, 1);
        res.on("close", () => {
          clearInterval(interval);
          closed.resolve();
        });
      },
      async (baseUrl) => {
        await expect(
          acquireWithEnv(
            { OPENCLAW_QA_CONVEX_SITE_URL: baseUrl, OPENCLAW_QA_ALLOW_INSECURE_HTTP: "1" },
            fetch,
          ),
        ).rejects.toThrow("Convex credential broker: text response exceeds 1048576 bytes");

        await closed.promise;
        expect(requestCount).toBe(1);
        expect(bytesWritten).toBeLessThan(totalBytes);
      },
    );
  });

  it("hydrates chunked convex credential payloads after acquire", async () => {
    const serialized = JSON.stringify({ ...credentials, driverToken: "driv\u00e9r" });
    const fetchImpl = replies(
      chunked(Buffer.byteLength(serialized, "utf8"), 2, "chunked"),
      { status: "ok", data: serialized.slice(0, 20) },
      { status: "ok", data: serialized.slice(20) },
    );

    const lease = await acquireCi(fetchImpl);

    expect(lease.payload).toEqual({ ...credentials, driverToken: "driv\u00e9r" });
    expectOperations(fetchImpl, "acquire", "payload-chunk", "payload-chunk");
    const chunkRequestBody = fetchImpl.mock.calls[1]?.[1]?.body;
    expect(chunkRequestBody).toBeTypeOf("string");
    const chunkRequest: unknown = JSON.parse(chunkRequestBody as string);
    expect(chunkRequest).toMatchObject({
      credentialId: "cred-chunked",
      index: 0,
      leaseToken: "lease-chunked",
    });
  });

  it.each([
    [1, 3, "CHUNKS", "2", "2 chunks"],
    [33, 1, "BYTES", "32", "32 bytes"],
  ] as const)(
    "rejects oversized chunks (%i bytes, %i chunks)",
    async (bytes, chunks, key, cap, error) => {
      const fetchImpl = replies(chunked(bytes, chunks, "capped"), { status: "ok" });
      await expect(
        acquireCi(fetchImpl, {
          ...ciEnv,
          [`OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_${key}`]: cap,
        }),
      ).rejects.toThrow(`Chunked credential payload marker exceeds ${error}.`);
      expectOperations(fetchImpl, "acquire", "release");
    },
  );

  it("stops chunked convex payload hydration when chunk data exceeds the marker", async () => {
    const fetchImpl = replies(
      chunked(2, 2, "overrun"),
      { status: "ok", data: "abc" },
      { status: "ok" },
    );

    await expect(acquireCi(fetchImpl)).rejects.toThrow(
      "Chunked credential payload exceeded declared byteLength.",
    );

    expectOperations(fetchImpl, "acquire", "payload-chunk", "release");
  });

  it("defaults convex credential role to ci when CI=true", async () => {
    const fetchImpl = replies(acquired(credentials, "cred-ci-default", "lease-ci-default"));

    await acquireQaCredentialLease({ ...convexOptions, env: { ...ciEnv, CI: "true" }, fetchImpl });

    expectAuthorization(fetchImpl, "ci-secret");
  });

  it.each(["pool exhausted", "transport failure"])("retries acquire after %s", async (failure) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const attempts = failure === "pool exhausted" ? 2 : 1;
    for (let i = 0; i < attempts; i++) {
      if (failure === "pool exhausted") {
        fetchImpl.mockResolvedValueOnce(
          jsonResponse({ status: "error", code: "POOL_EXHAUSTED", message: "wait" }),
        );
      } else {
        fetchImpl.mockRejectedValueOnce(
          new Error("fetch failed | Connect Timeout Error | UND_ERR_CONNECT_TIMEOUT"),
        );
      }
    }
    fetchImpl.mockResolvedValueOnce(jsonResponse(acquired(credentials, "retried")));
    const clock = retryClock();
    const lease = await acquireMaintainer({ fetchImpl, ...clock, role: undefined });
    expect(lease.credentialId).toBe("retried");
    expect(fetchImpl).toHaveBeenCalledTimes(attempts + 1);
    expect(clock.sleeps).toHaveLength(attempts);
    if (attempts === 2) {
      expect(clock.sleeps[0]).toBeGreaterThanOrEqual(100);
      expect(clock.sleeps[1]).toBeGreaterThan(clock.sleeps[0] ?? 0);
    }
  });

  it.each([
    [{ OPENCLAW_QA_CONVEX_SITE_URL: "http://qa-cred.example.convex.site" }, "must use https://"],
    [
      { OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX: "//evil.example" },
      "OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX must be an absolute path",
    ],
    [{ OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "" }, "OPENCLAW_QA_CONVEX_SECRET_MAINTAINER"],
  ])("rejects unsafe or unauthenticated broker config %j", async (env, error) => {
    await expect(acquireMaintainer({}, env)).rejects.toThrow(error);
  });

  it("allows explicitly opted-in loopback HTTP", async () => {
    const fetchImpl = replies(acquired(credentials));
    await acquireWithEnv(
      {
        OPENCLAW_QA_CONVEX_SITE_URL: "http://127.0.0.1:3210",
        OPENCLAW_QA_ALLOW_INSECURE_HTTP: "1",
      },
      fetchImpl,
    );
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3210/qa-credentials/v1/acquire");
  });

  it("caps oversized convex HTTP timeouts before creating abort signals", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchImpl = replies(acquired(credentials));
    await acquireWithEnv(
      { OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER) },
      fetchImpl,
    );

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(timeoutController.signal);
  });

  it("releases acquired lease when payload parsing fails", async () => {
    const fetchImpl = replies(acquired({ broken: true }, "cred-parse-fail", "lease-parse-fail"), {
      status: "ok",
    });

    await expect(
      acquireMaintainer({
        fetchImpl,
        parsePayload: () => {
          throw new Error("bad payload shape");
        },
      }),
    ).rejects.toThrow("bad payload shape");

    expectOperations(fetchImpl, "acquire", "release");
  });

  it.each([
    ["heartbeat-down", 55, 1],
    ["fetch failed | ETIMEDOUT", 50 + 1_000 + 3_000 + 5_000, 4],
  ] as const)("fails closed on heartbeat error %s", async (message, elapsed, attempts) => {
    vi.useFakeTimers();
    const request = vi.fn(async () => {
      throw new Error(message);
    });
    const heartbeat = startHeartbeat(request);
    await vi.advanceTimersByTimeAsync(elapsed);
    expect(request).toHaveBeenCalledTimes(attempts);
    expect(heartbeat.getFailure()).toBeInstanceOf(Error);
    expect(() => heartbeat.throwIfFailed()).toThrow(message);
    expect((await heartbeat.whenFailed).message).toContain(message);
    await heartbeat.stop();
  });

  it("retries transient heartbeat transport failures", async () => {
    vi.useFakeTimers();
    const heartbeatRequest = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("fetch failed | Connect Timeout Error | UND_ERR_CONNECT_TIMEOUT"),
      )
      .mockResolvedValueOnce(undefined);
    const heartbeat = startHeartbeat(heartbeatRequest);

    await vi.advanceTimersByTimeAsync(50);
    expect(heartbeatRequest).toHaveBeenCalledTimes(1);
    expect(heartbeat.getFailure()).toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(heartbeatRequest).toHaveBeenCalledTimes(2);
    expect(heartbeat.getFailure()).toBeNull();
    await heartbeat.stop();
  });
});
