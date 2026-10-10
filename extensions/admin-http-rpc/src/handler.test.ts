import { createServer, type Server } from "node:http";
import { connect, Socket } from "node:net";
import { Readable } from "node:stream";
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdminHttpRpcRequest } from "./handler.js";

const { dispatchGatewayMethod } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod,
}));

vi.mock("node:timers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers")>();
  return {
    ...actual,
    // The canonical reader deliberately captures Node timers. Route them through
    // the test clock here so the 30-second response-flush contract stays fast.
    setTimeout: ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      globalThis.setTimeout(callback, delay, ...args)) as typeof actual.setTimeout,
    clearTimeout: ((timer: ReturnType<typeof globalThis.setTimeout> | undefined) =>
      globalThis.clearTimeout(timer)) as typeof actual.clearTimeout,
  };
});

type CapturedResponse = {
  statusCode: number;
  headers: Record<string, string | number | readonly string[]>;
  body: string;
};

function createRequest(body: unknown, method = "POST") {
  const req =
    body instanceof Readable
      ? body
      : Readable.from([typeof body === "string" ? body : JSON.stringify(body)]);
  Object.assign(req, {
    method,
    socket: new Socket(),
    url: "/api/v1/admin/rpc",
    headers: {
      "content-type": "application/json",
    },
  });
  return req as import("node:http").IncomingMessage;
}

async function invoke(body: unknown, method = "POST") {
  return invokeRequest(createRequest(body, method));
}

async function invokeRequest(req: import("node:http").IncomingMessage) {
  const captured: CapturedResponse = {
    statusCode: 200,
    headers: {},
    body: "",
  };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(value: number) {
      captured.statusCode = value;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string | Buffer) {
      captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk ?? "");
    },
  } as import("node:http").ServerResponse;
  const handled = await handleAdminHttpRpcRequest(req, res);
  return {
    handled,
    captured,
    json: captured.body ? (JSON.parse(captured.body) as unknown) : undefined,
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  return address.port;
}

async function withHttpServer(run: (port: number, requestStarted: Promise<void>) => Promise<void>) {
  const started = Promise.withResolvers<void>();
  const server = createServer((req, res) => {
    void handleAdminHttpRpcRequest(req, res);
    started.resolve();
  });
  try {
    await run(await listen(server), started.promise);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function readSocketResponse(socket: Socket): Promise<string> {
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    socket.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.once("close", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.once("error", reject);
  });
}

describe("admin-http-rpc plugin handler", () => {
  beforeEach(() => {
    dispatchGatewayMethod.mockReset();
  });

  it("returns the allowlist without dispatching through the Gateway", async () => {
    const result = await invoke({ id: "1", method: "commands.list" });

    expect(result.handled).toBe(true);
    expect(result.captured.statusCode).toBe(200);
    expect(result.json).toEqual({
      id: "1",
      ok: true,
      payload: {
        methods: expect.arrayContaining([
          "config.get",
          "web.login.start",
          "web.login.wait",
          "gateway.suspend.prepare",
          "gateway.suspend.status",
          "gateway.suspend.resume",
        ]),
      },
    });
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it.each([
    { ok: true, payload: { status: "ok" }, meta: { requestId: "abc" } },
    { ok: true, payload: { status: "ok" } },
  ])("forwards the Gateway response through the request scope: %j", async (response) => {
    dispatchGatewayMethod.mockResolvedValueOnce(response);
    const result = await invoke({
      id: "cfg",
      method: "config.get",
      params: { path: "gateway" },
    });

    expect(dispatchGatewayMethod).toHaveBeenCalledWith("config.get", { path: "gateway" });
    expect(result.captured.statusCode).toBe(200);
    expect(result.json).toEqual({ id: "cfg", ...response });
  });

  it("rejects methods outside the admin HTTP RPC allowlist", async () => {
    const result = await invoke({ id: "bad", method: "sessions.send" });

    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    expect(result.captured.statusCode).toBe(400);
    expect(result.json).toEqual({
      id: "bad",
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "admin HTTP RPC method is not supported: sessions.send",
      },
    });
  });

  it("maps Gateway errors to HTTP status codes", async () => {
    dispatchGatewayMethod.mockResolvedValueOnce({
      ok: false,
      error: { code: "NOT_PAIRED", message: "pair first" },
    });

    const result = await invoke({ id: "node", method: "node.list" });

    expect(result.captured.statusCode).toBe(409);
    expect(result.json).toEqual({
      id: "node",
      ok: false,
      error: { code: "NOT_PAIRED", message: "pair first" },
    });
  });

  it.each([
    [{ id: "missing" }, "method must be a non-empty string"],
    ["", "request body must be JSON"],
    ["{", "request body must be valid JSON"],
  ])("rejects invalid request body %j before dispatch", async (body, message) => {
    const result = await invoke(body);

    expect(result.captured.statusCode).toBe(400);
    expect(result.json).toEqual({
      ok: false,
      error: { type: "invalid_request", message },
    });
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("only accepts POST", async () => {
    const result = await invoke({ method: "status" }, "GET");

    expect(result.captured.statusCode).toBe(405);
    expect(result.captured.headers.allow).toBe("POST");
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("settles an early client close and removes request-body listeners", async () => {
    const req = createRequest(new Readable({ read() {} }));
    const resultPromise = invokeRequest(req);

    req.emit("close");
    const result = await resultPromise;

    expect(result.captured.statusCode).toBe(400);
    expect(result.json).toEqual({
      ok: false,
      error: { type: "invalid_request", message: "Connection closed" },
    });
    for (const event of ["data", "end", "error", "close"]) {
      expect(req.listenerCount(event), event).toBe(0);
    }
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("flushes the 413 when the whole oversized body is already in flight", async () => {
    // Unlike a partial upload, the full body can queue the rejection behind unread bytes.
    await withHttpServer(async (port) => {
      const result = await postRawWebhook({
        url: `http://127.0.0.1:${port}/api/v1/admin/rpc`,
        body: "x".repeat(1024 * 1024 + 128 * 1024),
        headers: { "content-type": "application/json" },
        // Allow the transport owner's half-close deadline to expire.
        idleTimeoutMs: 3_000,
      });

      expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
      expect(JSON.parse(result.body) as unknown).toEqual({
        ok: false,
        error: { type: "invalid_request", message: "Payload too large" },
      });
      expect(result.closedByServer).toBe(true);
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    });
  });

  it.each([
    [413, "Payload too large", 1024 * 1024 + 1, "keep-alive"],
    [408, "Request body timeout", 64, "close"],
  ] as const)(
    "flushes HTTP %i before closing a partial upload",
    async (code, message, length, connection) => {
      await withHttpServer(async (port, requestStarted) => {
        if (code === 408) {
          vi.useFakeTimers();
        }
        const socket = connect({ host: "127.0.0.1", port });
        try {
          await new Promise<void>((resolve) => {
            socket.once("connect", resolve);
          });
          const responsePromise = readSocketResponse(socket);
          socket.write(
            [
              "POST /api/v1/admin/rpc HTTP/1.1",
              "Host: 127.0.0.1",
              "Content-Type: application/json",
              `Content-Length: ${length}`,
              `Connection: ${connection}`,
              "",
              "{",
            ].join("\r\n"),
          );
          await requestStarted;
          if (code === 408) {
            await vi.advanceTimersByTimeAsync(30_000);
          }
          const response = await responsePromise;
          const [, rawBody = ""] = response.split("\r\n\r\n", 2);

          expect(response).toContain(`HTTP/1.1 ${code}`);
          expect(response).toContain("Connection: close");
          expect(JSON.parse(rawBody) as unknown).toEqual({
            ok: false,
            error: { type: "invalid_request", message },
          });
          expect(dispatchGatewayMethod).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
          socket.destroy();
        }
      });
    },
  );
});
