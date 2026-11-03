import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { connect, Socket } from "node:net";
import { Readable } from "node:stream";
import { createMockServerResponse, withServer } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdminHttpRpcRequest } from "./handler.js";

const { dispatchGatewayMethod } = vi.hoisted(() => ({ dispatchGatewayMethod: vi.fn() }));
// mock-isolation: Exercise HTTP handling with synthetic dispatch results, without a live Gateway.
vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({ dispatchGatewayMethod }));

vi.mock("node:timers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers")>();
  return {
    ...actual,
    // Use the test clock for the reader's captured Node timers and 30-second flush deadline.
    setTimeout: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      globalThis.setTimeout(callback, delay, ...args),
    clearTimeout: (...args: Parameters<typeof actual.clearTimeout>) =>
      globalThis.clearTimeout(...args),
  };
});

function createRequest(body: unknown, method = "POST") {
  const req =
    body instanceof Readable
      ? body
      : Readable.from([typeof body === "string" ? body : JSON.stringify(body)]);
  return Object.assign(req, {
    method,
    socket: new Socket(),
    url: "/api/v1/admin/rpc",
    headers: { "content-type": "application/json" },
  }) as IncomingMessage;
}

const invoke = (body: unknown, method = "POST") => invokeRequest(createRequest(body, method));

async function invokeRequest(req: IncomingMessage) {
  const res = createMockServerResponse();
  const handled = await handleAdminHttpRpcRequest(req, res);
  return { handled, res, json: res.body ? (JSON.parse(res.body) as unknown) : undefined };
}

async function withHttpServer(run: (url: string, requestStarted: Promise<void>) => Promise<void>) {
  const started = Promise.withResolvers<void>();
  await withServer(
    (req, res) => {
      void handleAdminHttpRpcRequest(req, res);
      started.resolve();
    },
    (url) => run(`${url}/api/v1/admin/rpc`, started.promise),
  );
}

async function readSocketResponse(socket: Socket): Promise<string> {
  let response = "";
  socket.setEncoding("utf8").on("data", (chunk) => (response += chunk.toString()));
  // A reset can follow buffered rejection bytes; collect until the server closes.
  socket.on("error", () => {});
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  });
  return response;
}

function expectRejectedBody(body: unknown, message: string) {
  expect(body).toEqual({ ok: false, error: { type: "invalid_request", message } });
  expect(dispatchGatewayMethod).not.toHaveBeenCalled();
}

describe("admin-http-rpc plugin handler", () => {
  beforeEach(() => dispatchGatewayMethod.mockReset());

  it("returns the allowlist without dispatching through the Gateway", async () => {
    const result = await invoke({ id: "1", method: "commands.list" });
    expect(result).toMatchObject({ handled: true, res: { statusCode: 200 } });
    const methods = expect.arrayContaining([
      "config.get",
      "web.login.start",
      "web.login.wait",
      "gateway.suspend.prepare",
      "gateway.suspend.status",
      "gateway.suspend.resume",
    ]);
    expect(result.json).toEqual({ id: "1", ok: true, payload: { methods } });
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it.each([
    [200, { ok: true, payload: { status: "ok" }, meta: { requestId: "abc" } }],
    [200, { ok: true, payload: { status: "ok" } }],
    [409, { ok: false, error: { code: "NOT_PAIRED", message: "pair first" } }],
  ] as const)("maps the Gateway response to HTTP %i: %j", async (statusCode, response) => {
    dispatchGatewayMethod.mockResolvedValueOnce(response);
    const result = await invoke({ id: "cfg", method: "config.get", params: { path: "gateway" } });
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("config.get", { path: "gateway" });
    expect(result.res.statusCode).toBe(statusCode);
    expect(result.json).toEqual({ id: "cfg", ...response });
  });

  it("rejects methods outside the admin HTTP RPC allowlist", async () => {
    const result = await invoke({ id: "bad", method: "sessions.send" });
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    expect(result.res.statusCode).toBe(400);
    const error = {
      code: "INVALID_REQUEST",
      message: "admin HTTP RPC method is not supported: sessions.send",
    };
    expect(result.json).toEqual({ id: "bad", ok: false, error });
  });

  it.each([
    [[], "request body must be an object"],
    [{ id: "missing" }, "method must be a non-empty string"],
    ["", "request body must be JSON"],
    ["{", "request body must be valid JSON"],
  ])("rejects invalid request body %j before dispatch", async (body, message) => {
    const result = await invoke(body);
    expect(result.res.statusCode).toBe(400);
    expectRejectedBody(result.json, message);
  });

  it("only accepts POST", async () => {
    const result = await invoke({ method: "status" }, "GET");
    expect(result.res.statusCode).toBe(405);
    expect(result.res.getHeader("allow")).toBe("POST");
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("settles an early client close and removes request-body listeners", async () => {
    const req = createRequest(new Readable({ read() {} }));
    const resultPromise = invokeRequest(req);
    req.emit("close");
    const result = await resultPromise;
    expect(result.res.statusCode).toBe(400);
    expectRejectedBody(result.json, "Connection closed");
    for (const event of ["data", "end", "error", "close"]) {
      expect(req.listenerCount(event), event).toBe(0);
    }
  });

  const oversized = "x".repeat(1024 * 1024 + 128 * 1024);
  it.each([
    [413, "Payload too large", oversized.length, "keep-alive", oversized],
    [413, "Payload too large", 1024 * 1024 + 1, "keep-alive", "{"],
    [408, "Request body timeout", 64, "close", "{"],
  ] as const)("flushes HTTP %i (%s), length %i", (code, message, length, connection, body) =>
    withHttpServer(async (url, requestStarted) => {
      if (code === 408) {
        vi.useFakeTimers();
      }
      const socket = connect({ host: "127.0.0.1", port: Number(new URL(url).port) });
      try {
        await once(socket, "connect");
        const responsePromise = readSocketResponse(socket);
        socket.write(
          "POST /api/v1/admin/rpc HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
            `Content-Type: application/json\r\nContent-Length: ${length}\r\n` +
            `Connection: ${connection}\r\n\r\n${body}`,
        );
        await requestStarted;
        if (code === 408) {
          await vi.advanceTimersByTimeAsync(30_000);
        }
        const response = await responsePromise;
        const [, rawBody = ""] = response.split("\r\n\r\n", 2);
        const status = code === 413 ? "413 Payload Too Large" : "408 Request Timeout";
        expect(response.split("\r\n", 1)[0]).toBe(`HTTP/1.1 ${status}`);
        expect(response).toContain("Connection: close");
        expectRejectedBody(JSON.parse(rawBody), message);
      } finally {
        vi.useRealTimers();
        socket.destroy();
      }
    }),
  );
});
