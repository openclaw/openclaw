import { createServer } from "node:http";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "./credential-lease.runtime.js";

type CredentialPayload = { groupId: string; driverToken: string; sutToken: string };
const brokerUrl = "https://qa-cred.example.convex.site";
const ciEnv = {
  OPENCLAW_QA_CONVEX_SITE_URL: brokerUrl,
  OPENCLAW_QA_CONVEX_SECRET_CI: "ci-secret",
};
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

function startHeartbeat(heartbeat: () => Promise<void>, retryDelaysMs?: number[]) {
  return startQaCredentialLeaseHeartbeat(
    { source: "convex", kind: "telegram", heartbeatIntervalMs: 50, heartbeat },
    { intervalMs: 50, retryDelaysMs },
  );
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchMock = { mock: { calls: Parameters<typeof fetch>[] } };

function fetchUrl(fetchImpl: FetchMock, index = 0): string {
  const url = fetchImpl.mock.calls[index]?.[0];
  if (typeof url !== "string") {
    throw new Error(`expected fetch call ${index} URL`);
  }
  return url;
}

function fetchInit(fetchImpl: FetchMock, index = 0): RequestInit {
  const init = fetchImpl.mock.calls[index]?.[1];
  if (!init || typeof init !== "object") {
    throw new Error(`expected fetch call ${index} init`);
  }
  return init;
}

async function startStreamingFailureBroker() {
  const chunkBytes = 64 * 1024;
  const totalBytes = 4 * 1024 * 1024;
  let bytesWritten = 0;
  let requestCount = 0;
  const closed = Promise.withResolvers<void>();

  const server = createServer((_req, res) => {
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
      const nextBytes = Math.min(chunkBytes, totalBytes - bytesWritten);
      bytesWritten += nextBytes;
      res.write("x".repeat(nextBytes));
    }, 1);
    res.on("close", () => {
      clearInterval(interval);
      closed.resolve();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected streaming broker address");
  }
  return {
    closePromise: closed.promise,
    getBytesWritten: () => bytesWritten,
    getRequestCount: () => requestCount,
    totalBytes,
    url: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

describe("credential lease runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("releases a credential whose TTL expires while the host monotonic clock is paused", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(42);
    const operations: string[] = [];
    await expect(
      acquireQaCredentialLease({
        ...ciOptions,
        kind: "discord",
        resolveEnvPayload: () => ({}),
        parsePayload: () => {
          vi.setSystemTime(Date.now() + 101);
          return {};
        },
        fetchImpl: async (url) => {
          const operation = brokerOperation(url);
          operations.push(operation);
          return jsonResponse(
            operation === "acquire" ? { ...acquired({}), leaseTtlMs: 100 } : { status: "ok" },
          );
        },
      }),
    ).rejects.toThrow("could not be confirmed before use");
    expect(performance.now()).toBe(42);
    expect(operations).toEqual(["acquire", "release"]);
  });

  it("cannot renew an expired lease or retain authority during a pending release", async () => {
    vi.useFakeTimers();
    const heartbeatReply = Promise.withResolvers<Response>();
    const releaseReply = Promise.withResolvers<Response>();
    const operations: string[] = [];
    const lease = await acquireQaCredentialLease({
      ...ciOptions,
      kind: "slack",
      resolveEnvPayload: () => ({}),
      parsePayload: () => ({}),
      fetchImpl: async (url) => {
        const operation = brokerOperation(url);
        operations.push(operation);
        if (operation === "heartbeat") {
          return heartbeatReply.promise;
        }
        if (operation === "release") {
          return releaseReply.promise;
        }
        return jsonResponse({ ...acquired({}), leaseTtlMs: 100 });
      },
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
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          credentialId: "cred-1",
          leaseToken: "lease-1",
          payload: { groupId: "-100123", driverToken: "driver", sutToken: "sut" },
          leaseTtlMs: 1_200_000,
          heartbeatIntervalMs: 30_000,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }))
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));

    const lease = await acquireQaCredentialLease({
      ...convexOptions,
      env: {
        OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
        OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maintainer-secret",
      },
      fetchImpl,
    });

    expect(lease.source).toBe("convex");
    expect(lease.credentialId).toBe("cred-1");
    expect(lease.payload.groupId).toBe("-100123");

    await lease.heartbeat();
    await lease.release();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchUrl(fetchImpl)).toContain("/qa-credentials/v1/acquire");
    const firstInit = fetchInit(fetchImpl);
    const headers = firstInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer maintainer-secret");
  });

  it("cancels a streaming convex broker failure body after the response cap", async () => {
    const broker = await startStreamingFailureBroker();
    try {
      await expect(
        acquireMaintainer(
          {},
          {
            OPENCLAW_QA_CONVEX_SITE_URL: broker.url,
            OPENCLAW_QA_ALLOW_INSECURE_HTTP: "1",
          },
        ),
      ).rejects.toThrow("Convex credential broker: text response exceeds 1048576 bytes");

      await broker.closePromise;
      expect(broker.getRequestCount()).toBe(1);
      expect(broker.getBytesWritten()).toBeLessThan(broker.totalBytes);
    } finally {
      await broker.stop();
    }
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
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchUrl(fetchImpl, 1)).toBe(`${brokerUrl}/qa-credentials/v1/payload-chunk`);
    const chunkRequestBody = fetchInit(fetchImpl, 1).body;
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
    "rejects chunk markers (%i bytes, %i chunks)",
    async (bytes, chunks, key, cap, error) => {
      const fetchImpl = replies(chunked(bytes, chunks, "capped"), { status: "ok" });
      await expect(
        acquireCi(fetchImpl, {
          ...ciEnv,
          [`OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_${key}`]: cap,
        }),
      ).rejects.toThrow(`Chunked credential payload marker exceeds ${error}.`);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchUrl(fetchImpl, 1)).toBe(`${brokerUrl}/qa-credentials/v1/release`);
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

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchUrl(fetchImpl, 1)).toBe(`${brokerUrl}/qa-credentials/v1/payload-chunk`);
    expect(fetchUrl(fetchImpl, 2)).toBe(`${brokerUrl}/qa-credentials/v1/release`);
  });

  it("defaults convex credential role to ci when CI=true", async () => {
    const fetchImpl = replies(acquired(credentials, "cred-ci-default", "lease-ci-default"));

    await acquireQaCredentialLease({
      ...convexOptions,
      env: { ...ciEnv, CI: "true" },
      fetchImpl,
    });

    const firstInit = fetchInit(fetchImpl);
    const headers = firstInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ci-secret");
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

  it("allows loopback http URLs when OPENCLAW_QA_ALLOW_INSECURE_HTTP is enabled", async () => {
    const fetchImpl = replies(acquired(credentials, "cred-local", "lease-local"));
    await acquireMaintainer(
      { fetchImpl },
      {
        OPENCLAW_QA_CONVEX_SITE_URL: "http://127.0.0.1:3210",
        OPENCLAW_QA_ALLOW_INSECURE_HTTP: "1",
      },
    );

    expect(fetchUrl(fetchImpl)).toBe("http://127.0.0.1:3210/qa-credentials/v1/acquire");
  });

  it("caps oversized convex HTTP timeouts before creating abort signals", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchImpl = replies(acquired(credentials, "cred-timeout", "lease-timeout"));
    await acquireMaintainer(
      { fetchImpl },
      {
        OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER),
      },
    );

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(fetchInit(fetchImpl).signal).toBe(timeoutController.signal);
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

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchUrl(fetchImpl, 1)).toBe(`${brokerUrl}/qa-credentials/v1/release`);
  });

  it("captures heartbeat failures for fail-fast checks", async () => {
    vi.useFakeTimers();
    const heartbeat = startHeartbeat(async () => {
      throw new Error("heartbeat-down");
    });

    await vi.advanceTimersByTimeAsync(55);
    expect(heartbeat.getFailure()).toBeInstanceOf(Error);
    expect(() => heartbeat.throwIfFailed()).toThrow("heartbeat-down");
    expect((await heartbeat.whenFailed).message).toContain("heartbeat-down");
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
    const heartbeat = startHeartbeat(heartbeatRequest, [10]);

    await vi.advanceTimersByTimeAsync(50);
    expect(heartbeatRequest).toHaveBeenCalledTimes(1);
    expect(heartbeat.getFailure()).toBeNull();

    await vi.advanceTimersByTimeAsync(10);
    expect(heartbeatRequest).toHaveBeenCalledTimes(2);
    expect(heartbeat.getFailure()).toBeNull();
    await heartbeat.stop();
  });

  it("fails closed after transient heartbeat retries are exhausted", async () => {
    vi.useFakeTimers();
    const heartbeatRequest = vi.fn(async () => {
      throw new Error("fetch failed | ETIMEDOUT");
    });
    const heartbeat = startHeartbeat(heartbeatRequest, [10, 20]);

    await vi.advanceTimersByTimeAsync(80);
    expect(heartbeatRequest).toHaveBeenCalledTimes(3);
    expect(() => heartbeat.throwIfFailed()).toThrow("ETIMEDOUT");
    await heartbeat.stop();
  });
});
