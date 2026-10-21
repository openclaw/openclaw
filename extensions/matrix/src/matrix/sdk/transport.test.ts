import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import { createMatrixGuardedFetch, performMatrixRequest } from "./transport.js";

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";

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

async function withServer(handler: http.RequestListener, run: (url: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback server address");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function stubResponse(body: BodyInit | null, headers?: HeadersInit) {
  const runtimeFetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(body, { status: 200, headers }),
  );
  stubRuntimeFetch(runtimeFetch);
  return runtimeFetch;
}

async function expectIdleTimeout(raw: boolean, message: string) {
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
    const rejection = expect(request).rejects.toThrow(message);
    await vi.advanceTimersByTimeAsync(60);
    await rejection;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  vi.unstubAllGlobals();
  clearTestUndiciRuntimeDepsOverride();
});
afterEach(clearTestUndiciRuntimeDepsOverride);

describe("performMatrixRequest", () => {
  it("loads a profile through the real SDK default guarded fetch and closes the client", async () => {
    const { MatrixClient } = await import("../sdk.js");
    const { resolveRuntimeMatrixClientWithReadiness } = await import("../client-bootstrap.js");
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    const profile = { displayname: "Matrix loopback fixture" };
    await withServer(
      (request, response) => {
        requests.push({ url: request.url, authorization: request.headers.authorization });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(profile));
      },
      async (url) => {
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
      },
    );
  });

  it("preserves an encoded nested proxy prefix through the real HTTP transport", async () => {
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    await withServer(
      (request, response) => {
        requests.push({ url: request.url, authorization: request.headers.authorization });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ user_id: "@bot:example.org" }));
      },
      async (url) => {
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
      },
    );
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

  it("uses the matrix-specific idle-timeout error for stalled raw downloads", async () => {
    await expectIdleTimeout(true, "Matrix media download stalled: no data received for 50ms");
  }, 5_000);

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

  it("uses the JSON-specific idle-timeout error for stalled JSON downloads", async () => {
    await expectIdleTimeout(false, "Matrix JSON response stalled: no data received for 50ms");
  }, 5_000);

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
    const guardedFetch = createMatrixGuardedFetch({});

    await expect(guardedFetch(url)).rejects.toBeInstanceOf(TypeError);
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
      const guardedFetch = createMatrixGuardedFetch({
        ssrfPolicy: { allowPrivateNetwork: true },
      });
      const response = await guardedFetch("http://127.0.0.1:8008/start");

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

    const guardedFetch = createMatrixGuardedFetch({
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    await expect(guardedFetch("http://127.0.0.1:8008/_matrix/client/v3/sync")).rejects.toThrow(
      "Matrix SDK response exceeds size limit (67108865 bytes > 67108864 bytes)",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("strips matrix-js-sdk state_after sync opt-in from /sync requests", async () => {
    const runtimeFetch = stubResponse("{}", { "content-type": "application/json" });

    const guardedFetch = createMatrixGuardedFetch({
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    const response = await guardedFetch(
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
