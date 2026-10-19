import { Buffer } from "node:buffer";
import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { expectPreparedHandoff } from "./client.test-support.js";

vi.mock("openclaw/plugin-sdk/core", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/core")>(
    "openclaw/plugin-sdk/core",
  );
  return {
    ...actual,
    generateSecureUuid: () => "test-id",
  };
});

let signalCheck: typeof import("./client.js").signalCheck;
let signalRpcRequest: typeof import("./client.js").signalRpcRequest;
let streamSignalEvents: typeof import("./client.js").streamSignalEvents;

const servers: http.Server[] = [];
const rpc = (baseUrl: string, options: Partial<Parameters<typeof signalRpcRequest>[2]> = {}) =>
  signalRpcRequest("version", undefined, { baseUrl, ...options });
const stream = (baseUrl: string, options: Partial<Parameters<typeof streamSignalEvents>[0]> = {}) =>
  streamSignalEvents({ baseUrl, onEvent: () => {}, ...options });
const reply = (body: string | Buffer, status = 200) =>
  withSignalServer((_req, res) => {
    res.writeHead(status);
    res.end(body);
  });
const sse = (body: string) =>
  withSignalServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(body);
  });

async function withSignalServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = http.createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error: unknown) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing test server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  ({ signalCheck, signalRpcRequest, streamSignalEvents } = await import("./client.js"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    ),
  );
});

describe("signalRpcRequest", () => {
  it.each([false, true])(
    "prepares the HTTP handoff and rechecks its caller after waiting (revoked=%s)",
    async (revoked) => {
      await expectPreparedHandoff(revoked, async ({ arrive, response, assertHandoff }) => {
        const result = { sent: true };
        const baseUrl = await withSignalServer(async (_req, res) => {
          arrive();
          await response;
          res.end(JSON.stringify({ jsonrpc: "2.0", id: "test-id", result }));
        });
        const request = vi.spyOn(http, "request");
        return {
          send: () =>
            signalRpcRequest(
              "send",
              { message: "prepared" },
              {
                baseUrl,
                assertDirectAdapterHandoff: assertHandoff,
              },
            ),
          assertCount: (count) => expect(request).toHaveBeenCalledTimes(count),
          result,
        };
      });
    },
  );

  it("rejects malformed UTF-8 bytes before JSON parsing", async () => {
    const baseUrl = await reply(
      Buffer.concat([
        Buffer.from('{"jsonrpc":"2.0","result":{"version":"'),
        Buffer.from([0xff]),
        Buffer.from('"},"id":"test-id"}'),
      ]),
    );
    await expect(rpc(baseUrl)).rejects.toBeInstanceOf(TypeError);
  });

  it.each([
    {
      body: "not-json",
      status: 502,
      error: {
        message: "Signal RPC returned malformed JSON (status 502)",
        cause: expect.any(SyntaxError),
      },
    },
    {
      body: '{"jsonrpc":"2.0","id":"test-id"}',
      status: 200,
      error: { message: "Signal RPC returned invalid response envelope (status 200)" },
    },
    {
      body: "x".repeat(1_048_577),
      status: 200,
      error: { message: "Signal HTTP response exceeded size limit" },
    },
  ])("rejects invalid RPC responses: $error.message", async ({ body, status, error }) => {
    const result = rpc(await reply(body, status));
    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toMatchObject(error);
  });
  it("rejects credentialed base URLs", async () => {
    await expect(rpc("http://user:pass@127.0.0.1:8080")).rejects.toThrow(
      "Signal base URL must not include credentials",
    );
  });

  it("uses an absolute deadline for slow-drip RPC responses", async () => {
    const baseUrl = await withSignalServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const interval = setInterval(() => {
        res.write(" ");
      }, 5);
      res.on("close", () => clearInterval(interval));
    });

    await expect(rpc(baseUrl, { timeoutMs: 25 })).rejects.toThrow(
      "Signal HTTP exceeded deadline after 25ms",
    );
  });
});

describe("signalCheck", () => {
  it.each([
    [200, Buffer.from([0xff]), { ok: true, status: 200, error: null }],
    [503, "down", { ok: false, status: 503, error: "HTTP 503" }],
  ] as const)("reports status %s without decoding the body", async (status, body, expected) => {
    await expect(signalCheck(await reply(body, status))).resolves.toEqual(expected);
  });
});

describe("streamSignalEvents", () => {
  it("preserves path-prefixed base URLs for event streams", async () => {
    type StreamEvent = Parameters<Parameters<typeof streamSignalEvents>[0]["onEvent"]>[0];
    const events: StreamEvent[] = [];
    const onStreamOpen = vi.fn();
    const serverUrl = await withSignalServer((req, res) => {
      expect(req.url).toBe("/signal/api/v1/events?account=%2B15555550123");
      expect(req.headers.accept).toBe("text/event-stream");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('id: 42\nevent: message\ndata: {"group":true}\n\n');
    });

    await streamSignalEvents({
      baseUrl: `${serverUrl}/signal`,
      account: "+15555550123",
      onEvent: (event) => events.push(event),
      onStreamOpen,
    });

    expect(onStreamOpen).toHaveBeenCalledOnce();
    expect(events).toEqual([{ id: "42", event: "message", data: '{"group":true}' }]);
  });

  it("propagates receive-handler failures to the stream", async () => {
    const appendError = new Error("durable append failed");
    await expect(
      stream(await sse('event: receive\ndata: {"envelope":{}}\n\n'), {
        onEvent: async () => {
          throw appendError;
        },
      }),
    ).rejects.toBe(appendError);
  });

  it("reports HTTP status failures from the event stream", async () => {
    const baseUrl = await withSignalServer((_req, res) => {
      res.writeHead(503, "Unavailable");
      res.end("down");
    });

    await expect(stream(baseUrl)).rejects.toMatchObject({
      message: "Signal SSE failed (503 Unavailable)",
      status: 503,
    });
  });

  it.each([
    [25, "Error", "Signal SSE connection timed out after 25ms"],
    [0, "AbortError", "Signal SSE aborted"],
  ] as const)("bounds a headerless stream with timeout %s", async (timeoutMs, name, message) => {
    // signal-cli can leave the request open before its first keepalive flush.
    const baseUrl = await withSignalServer(() => {});
    const controller = new AbortController();
    const timer = timeoutMs === 0 ? setTimeout(() => controller.abort(), 25) : undefined;
    timer?.unref?.();
    await expect(
      stream(baseUrl, { timeoutMs, abortSignal: controller.signal }),
    ).rejects.toMatchObject({ name, message });
  });

  it("rejects oversized SSE line buffers by byte size", async () => {
    await expect(stream(await sse(`data: ${"🙂".repeat(262_145)}`))).rejects.toThrow(
      "Signal SSE buffer exceeded size limit",
    );
  });

  it("rejects oversized SSE events split across smaller data lines", async () => {
    const baseUrl = await withSignalServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const line = `data: ${"x".repeat(4096)}\n`;
      for (let index = 0; index < 260; index += 1) {
        res.write(line);
      }
      res.end();
    });

    await expect(stream(baseUrl)).rejects.toThrow("Signal SSE event data exceeded size limit");
  });
});
