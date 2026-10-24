import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import { createMatrixGuardedFetch, performMatrixRequest } from "./transport.js";

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
const dns = vi.hoisted(() => ({
  calls: 0,
  beforeResolve: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("openclaw/plugin-sdk/ssrf-dispatcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-dispatcher")>();
  return {
    ...actual,
    resolvePinnedHostnameWithPolicy: async (
      ...args: Parameters<typeof actual.resolvePinnedHostnameWithPolicy>
    ) => {
      dns.calls++;
      await dns.beforeResolve?.();
      return actual.resolvePinnedHostnameWithPolicy(...args);
    },
  };
});

function clearTestUndiciRuntimeDepsOverride(): void {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
}

function stubRuntimeFetch(fetchImpl: typeof fetch): void {
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: function MockAgent() {},
    EnvHttpProxyAgent: function MockEnvHttpProxyAgent() {},
    ProxyAgent: function MockProxyAgent() {},
    fetch: fetchImpl,
  };
}

function requestMatrix(overrides: Partial<Parameters<typeof performMatrixRequest>[0]> = {}) {
  return performMatrixRequest({
    homeserver: "http://127.0.0.1:8008",
    accessToken: "token",
    method: "GET",
    endpoint: "/_matrix/client/v3/account/whoami",
    timeoutMs: 5000,
    ssrfPolicy: { allowPrivateNetwork: true },
    ...overrides,
  });
}

type RecordedRequest = { url: string | undefined; authorization: string | undefined };
function withJsonServer(
  body: object,
  run: (url: string, requests: RecordedRequest[]) => Promise<void>,
) {
  const requests: RecordedRequest[] = [];
  return withServer(
    (request, response) => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    },
    (url) => run(url, requests),
  );
}

const guardedFetch = () => createMatrixGuardedFetch({ ssrfPolicy: { allowPrivateNetwork: true } });

function stubResponse(body: BodyInit | null, headers?: HeadersInit) {
  const runtimeFetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(body, { status: 200, headers }),
  );
  stubRuntimeFetch(runtimeFetch);
  return runtimeFetch;
}

async function expectIdleTimeout(raw: boolean) {
  vi.useFakeTimers();
  try {
    stubResponse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
      }),
      raw ? undefined : { "content-type": "application/json" },
    );
    const request = requestMatrix({
      raw,
      maxBytes: 1024,
      readIdleTimeoutMs: 50,
      ...(raw ? { endpoint: "/_matrix/media/v3/download/example/id" } : {}),
    });
    const rejection = expect(request).rejects.toThrow(
      `${raw ? "Matrix media download" : "Matrix JSON response"} stalled: no data received for 50ms`,
    );
    await vi.advanceTimersByTimeAsync(60);
    await rejection;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  dns.calls = 0;
  dns.beforeResolve = undefined;
  vi.unstubAllGlobals();
  clearTestUndiciRuntimeDepsOverride();
});
afterEach(clearTestUndiciRuntimeDepsOverride);

describe("performMatrixRequest", () => {
  it("loads a profile through the real SDK default guarded fetch and closes the client", async () => {
    const { MatrixClient } = await import("../sdk.js");
    const { resolveRuntimeMatrixClientWithReadiness } = await import("../client-bootstrap.js");
    const profile = { displayname: "Matrix loopback fixture" };
    await withJsonServer(profile, async (url, requests) => {
      const client = new MatrixClient(`${url}/matrix-proxy`, "fixture-token", {
        encryption: false,
        autoBootstrapCrypto: false,
        ssrfPolicy: { allowPrivateNetwork: true },
      });

      try {
        const resolved = await resolveRuntimeMatrixClientWithReadiness({
          client,
          readiness: "none",
        });
        await expect(resolved.client.getUserProfile("@fixture:example.org")).resolves.toEqual(
          profile,
        );
        expect(requests).toEqual([
          {
            url: "/matrix-proxy/_matrix/client/v3/profile/%40fixture%3Aexample.org",
            authorization: "Bearer fixture-token",
          },
        ]);
      } finally {
        await client.stopWithoutPersist();
      }
    });
  });

  it("preserves an encoded nested proxy prefix through the real HTTP transport", async () => {
    await withJsonServer({ user_id: "@bot:example.org" }, async (url, requests) => {
      const result = await requestMatrix({
        homeserver: `${url}/proxy%20base/tenant/`,
        accessToken: "test-token",
        qs: { via: "proxy path" },
      });

      expect(result.response.status).toBe(200);
      expect(JSON.parse(result.text)).toEqual({ user_id: "@bot:example.org" });
      expect(requests).toEqual([
        {
          url: "/proxy%20base/tenant/_matrix/client/v3/account/whoami?via=proxy+path",
          authorization: "Bearer test-token",
        },
      ]);
    });
  });

  it("rejects malformed raw content-length before buffering the body", async () => {
    const response = new Response(null, { headers: { "content-length": "0x3" } });
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");
    stubRuntimeFetch(vi.fn(async () => response));

    await expect(
      requestMatrix({
        endpoint: "/_matrix/media/v3/download/example/id",
        raw: true,
        maxBytes: 1024,
      }),
    ).rejects.toThrow("invalid content-length header: 0x3");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses the correct idle-timeout error for raw=%s",
    expectIdleTimeout,
    5_000,
  );

  it("uses undici runtime fetch for pinned Matrix requests so the dispatcher stays bound", async () => {
    let ambientFetchCalls = 0;
    vi.stubGlobal("fetch", (async () => {
      ambientFetchCalls += 1;
      throw new Error("expected pinned Matrix requests to avoid ambient fetch");
    }) as typeof fetch);
    const runtimeFetch = stubResponse('{"ok":true}', { "content-type": "application/json" });

    const result = await requestMatrix({});

    expect(result.text).toBe('{"ok":true}');
    expect(ambientFetchCalls).toBe(0);
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    const dispatcher = (
      runtimeFetch.mock.calls.at(0)?.[1] as RequestInit & { dispatcher?: unknown }
    )?.dispatcher;
    expect((dispatcher as { constructor?: { name?: string } } | undefined)?.constructor?.name).toBe(
      "MockAgent",
    );
  });

  it("rejects oversized JSON responses via content-length before buffering the body", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    stubResponse(stream, {
      "content-type": "application/json",
      "content-length": String(16 * 1024 * 1024),
    });

    await expect(requestMatrix({ maxBytes: 1024 })).rejects.toThrow(
      "Matrix JSON response exceeds configured size limit",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("real HTTP server: rejects with MatrixMediaSizeLimitError when server declares over-cap Content-Length and maxBytes is omitted", async () => {
    const overCapBytes = 64 * 1024 * 1024 + 1;

    await withServer(
      (_req, res) => {
        // Flush headers without sending the declared oversized body.
        res.writeHead(200, { "content-length": String(overCapBytes) });
        res.write(Buffer.alloc(1));
      },
      async (url) => {
        await expect(
          requestMatrix({
            homeserver: url,
            endpoint: "/_matrix/media/v3/download/example/id",
            timeoutMs: 10_000,
            raw: true,
            // intentionally omitting maxBytes — fix applies MATRIX_SDK_RESPONSE_MAX_BYTES as default
          }),
        ).rejects.toBeInstanceOf(MatrixMediaSizeLimitError);
      },
    );
  });
});

describe("createMatrixGuardedFetch", () => {
  it.each(["not-a-url", ""])("rejects malformed URL %j before fetching", async (url) => {
    const runtimeFetch = vi.fn<typeof fetch>();
    stubRuntimeFetch(runtimeFetch);
    await expect(createMatrixGuardedFetch({})(url)).rejects.toBeInstanceOf(TypeError);
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it("preserves redirect success when the discarded body fails to cancel", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    const cancel = vi.fn(() => {
      throw new Error("cancel failed");
    });
    const runtimeFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status: 302,
          headers: { location: "/final" },
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    stubRuntimeFetch(runtimeFetch);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const response = await guardedFetch()("http://127.0.0.1:8008/start");

      await expect(response.json()).resolves.toEqual({});
      expect(runtimeFetch).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledOnce();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandledRejections).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      expect(process.listeners("unhandledRejection")).not.toContain(onUnhandledRejection);
    }
  });

  it("rejects and cancels SDK responses above the declared size limit", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    stubResponse(stream, { "content-length": String(64 * 1024 * 1024 + 1) });

    await expect(guardedFetch()("http://127.0.0.1:8008/_matrix/client/v3/sync")).rejects.toThrow(
      "Matrix SDK response exceeds size limit (67108865 bytes > 67108864 bytes)",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("strips matrix-js-sdk state_after sync opt-in from /sync requests", async () => {
    const runtimeFetch = stubResponse("{}", { "content-type": "application/json" });

    const response = await guardedFetch()(
      "http://127.0.0.1:8008/_matrix/client/v3/sync?filter=abc&org.matrix.msc4222.use_state_after=true&timeout=30000",
    );

    await expect(response.json()).resolves.toEqual({});
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    expect(runtimeFetch.mock.calls.at(0)?.[0]).toBe(
      "http://127.0.0.1:8008/_matrix/client/v3/sync?filter=abc&timeout=30000",
    );
  });
});

describe("matrix transport streaming OOM guard — real HTTP server without Content-Length", () => {
  // No Content-Length: only the streaming byte cap can stop this response.
  it("rejects oversized streaming raw response before fully buffering 20 MiB (OOM guard)", async () => {
    const CHUNK = Buffer.alloc(1024 * 1024, 0x61); // 1 MiB per chunk
    const TOTAL_CHUNKS = 20; // 20 MiB total — above 16 MiB cap
    let chunksWritten = 0;

    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        let sent = 0;
        let closed = false;
        res.on("close", () => {
          closed = true;
        });
        const sendChunk = () => {
          if (closed) {
            return;
          }
          if (sent >= TOTAL_CHUNKS) {
            res.end();
            return;
          }
          sent++;
          chunksWritten++;
          const ok = res.write(CHUNK);
          const scheduleNextChunk = () => {
            setTimeout(sendChunk, 5);
          };
          if (ok) {
            scheduleNextChunk();
          } else {
            res.once("drain", scheduleNextChunk);
          }
        };
        sendChunk();
      },
      async (url) => {
        await expect(
          requestMatrix({
            homeserver: url,
            endpoint: "/_matrix/media/v3/download/example/id",
            timeoutMs: 30_000,
            raw: true,
            maxBytes: 16 * 1024 * 1024, // 16 MiB cap — readResponseWithLimit enforces this
          }),
        ).rejects.toBeInstanceOf(MatrixMediaSizeLimitError);
        // Mutation-control: bare response.arrayBuffer() would buffer all 20 MiB.
        // readResponseWithLimit cancels the stream mid-flight so chunksWritten < TOTAL_CHUNKS.
        expect(chunksWritten).toBeLessThan(TOTAL_CHUNKS);
      },
    );
  }, 30_000);
});

it("keeps shared transaction identity alive when its first sender cancels during DNS", async () => {
  const { MatrixClient } = await import("../sdk.js");
  const { withResolvedMatrixSendClient } = await import("../send/client.js");
  const dnsEntered = createDeferred<void>();
  const resumeDns = createDeferred<void>();
  const secondJoined = createDeferred<void>();
  const firstCaller = new AbortController();
  const cancellation = new Error("first identity caller canceled during DNS preparation");
  const currentRoom = "!current:example.org";
  const timelineRequests: string[] = [];
  const unexpectedRequests: string[] = [];
  let whoamiRequests = 0;
  type Result = { scope: string; eventId: string };
  type Outcome = { value: Result | undefined; error: unknown };
  const settle = (promise: Promise<Result>): Promise<Outcome> =>
    promise.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
  const waitFor = (boundary: Promise<void>, result: Promise<Outcome>, label: string) =>
    Promise.race([
      boundary,
      result.then(({ error }) => {
        throw toErrorObject(error, `send settled before ${label}`);
      }),
    ]);
  await withServer(
    (request, response) => {
      const requestPath = decodeURIComponent(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
      let body: object;
      let code = 200;
      request.resume();
      if (request.method === "GET" && requestPath === "/_matrix/client/v3/account/whoami") {
        whoamiRequests++;
        body = { user_id: "@bot:example.org", device_id: "fixture" };
      } else if (request.method === "GET" && requestPath.includes("/state/m.room.encryption")) {
        body = { errcode: "M_NOT_FOUND" };
        code = 404;
      } else if (request.method === "PUT" && requestPath.includes("/send/m.room.message/")) {
        timelineRequests.push(requestPath);
        body = { event_id: "$current-accepted" };
      } else {
        unexpectedRequests.push(`${request.method} ${requestPath}`);
        body = { errcode: "M_UNRECOGNIZED" };
        code = 400;
      }
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    },
    async (baseUrl) => {
      const client = new MatrixClient(baseUrl, "fixture-token", {
        userId: "@bot:example.org",
        deviceId: "fixture",
        encryption: false,
        autoBootstrapCrypto: false,
        ssrfPolicy: { allowPrivateNetwork: true },
      });
      let first: Promise<Outcome> | undefined;
      let second: Promise<Outcome> | undefined;
      try {
        const send = (signal: AbortSignal, roomId: string, joined?: () => void) =>
          withResolvedMatrixSendClient({ client, cfg: {}, signal }, async (sender) => {
            const identity = sender.getTransactionScopeId();
            joined?.();
            const scope = await identity;
            const eventId = await sender.sendMessage(roomId, {
              msgtype: "m.text",
              body: "identity caller",
            });
            return { scope, eventId };
          });
        dns.calls = 0;
        dns.beforeResolve = async () => {
          dnsEntered.resolve();
          await resumeDns.promise;
        };
        first = settle(send(firstCaller.signal, "!abandoned:example.org"));
        await waitFor(dnsEntered.promise, first, "identity DNS preparation");
        second = settle(
          send(new AbortController().signal, currentRoom, () => secondJoined.resolve()),
        );
        await waitFor(secondJoined.promise, second, "the second identity waiter");
        expect({ dns: dns.calls, whoami: whoamiRequests }).toEqual({ dns: 1, whoami: 0 });
        firstCaller.abort(cancellation);
        resumeDns.resolve();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult.error).toMatchObject({
          message: expect.stringContaining(cancellation.message),
        });
        expect(secondResult).toMatchObject({
          error: undefined,
          value: { eventId: "$current-accepted" },
        });
        expect(timelineRequests).toEqual([
          expect.stringContaining(`/rooms/${currentRoom}/send/m.room.message/`),
        ]);
        expect(whoamiRequests).toBe(1);
        expect(await client.getTransactionScopeId()).toBe(secondResult.value?.scope);
        expect(whoamiRequests).toBe(1);
        expect(unexpectedRequests).toEqual([]);
      } finally {
        resumeDns.resolve();
        dns.beforeResolve = undefined;
        try {
          await Promise.all([first, second]);
        } finally {
          await client.stopWithoutPersist();
        }
      }
    },
  );
});
