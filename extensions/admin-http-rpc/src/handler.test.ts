// Admin Http Rpc tests cover handler plugin behavior.
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdminHttpRpcRequest } from "./handler.js";
import { listAdminHttpRpcAllowedMethods } from "./methods.js";

const { dispatchGatewayMethod } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod,
}));

type CapturedResponse = {
  statusCode: number;
  headers: Record<string, string | number | readonly string[]>;
  body: string;
};

function createRequest(body: unknown, method = "POST", headers?: Record<string, string>) {
  const req = Readable.from([typeof body === "string" ? body : JSON.stringify(body)]);
  Object.assign(req, {
    method,
    url: "/api/v1/admin/rpc",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
  return req as import("node:http").IncomingMessage;
}

function createResponse() {
  const captured: CapturedResponse = {
    statusCode: 200,
    headers: {},
    body: "",
  };
  let onFinish: (() => void) | undefined;
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
    once(event: string, listener: () => void) {
      if (event === "finish") {
        onFinish = listener;
      }
      return res;
    },
    end(chunk?: string | Buffer) {
      captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk ?? "");
      onFinish?.();
    },
  } as import("node:http").ServerResponse;
  return { res, captured };
}

async function invoke(body: unknown, method = "POST", headers?: Record<string, string>) {
  const { res, captured } = createResponse();
  const handled = await handleAdminHttpRpcRequest(createRequest(body, method, headers), res);
  return {
    handled,
    captured,
    json: captured.body ? (JSON.parse(captured.body) as unknown) : undefined,
  };
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function requestRealAdminRpc(
  port: number,
  options: { body?: Buffer | string; contentLength?: number },
): Promise<CapturedResponse> {
  return await new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (options.contentLength !== undefined) {
      headers["content-length"] = String(options.contentLength);
    }

    const clientReq = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/v1/admin/rpc",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const responseHeaders: CapturedResponse["headers"] = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined) {
              responseHeaders[name] = value;
            }
          }
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: responseHeaders,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    clientReq.setTimeout(2_000, () => {
      clientReq.destroy(new Error("timed out waiting for Admin RPC response"));
    });
    clientReq.on("error", reject);
    clientReq.end(options.body);
  });
}

async function requestContinuingStream(
  port: number,
): Promise<CapturedResponse & { closed: boolean; writesAfterLimit: number }> {
  return await new Promise((resolve, reject) => {
    let response: CapturedResponse | undefined;
    let writesAfterLimit = 0;
    const clientReq = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/v1/admin/rpc",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const headers: CapturedResponse["headers"] = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined) {
              headers[name] = value;
            }
          }
          response = {
            statusCode: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          };
        });
      },
    );
    const timer = setTimeout(() => {
      clientReq.destroy(new Error("timed out waiting for Admin RPC connection close"));
    }, 2_000);
    clientReq.on("close", () => {
      clearTimeout(timer);
      if (!response) {
        reject(new Error("Admin RPC connection closed before its 413 response"));
        return;
      }
      resolve({ ...response, closed: true, writesAfterLimit });
    });
    clientReq.on("error", (error) => {
      if (!response) {
        reject(error);
      }
    });

    clientReq.write(Buffer.alloc(1024 * 1024 + 1, "x"));
    for (let index = 0; index < 4; index += 1) {
      clientReq.write("x");
      writesAfterLimit += 1;
    }
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
        methods: listAdminHttpRpcAllowedMethods(),
      },
    });
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("dispatches allowed methods through the authenticated plugin request scope", async () => {
    dispatchGatewayMethod.mockResolvedValueOnce({
      ok: true,
      payload: { status: "ok" },
      meta: { requestId: "abc" },
    });

    const result = await invoke({
      id: "cfg",
      method: "config.get",
      params: { path: "gateway" },
    });

    expect(dispatchGatewayMethod).toHaveBeenCalledWith("config.get", { path: "gateway" });
    expect(result.captured.statusCode).toBe(200);
    expect(result.json).toEqual({
      id: "cfg",
      ok: true,
      payload: { status: "ok" },
      meta: { requestId: "abc" },
    });
  });

  it.each([
    ["web.login.start", { force: true, timeoutMs: 1000 }],
    ["web.login.wait", { timeoutMs: 1000 }],
  ] as const)(
    "allows web QR login method %s through the authenticated plugin request scope",
    async (method, params) => {
      dispatchGatewayMethod.mockResolvedValueOnce({
        ok: true,
        payload: { status: "ok" },
      });

      const result = await invoke({
        id: "web-login",
        method,
        params,
      });

      expect(dispatchGatewayMethod).toHaveBeenCalledWith(method, params);
      expect(result.captured.statusCode).toBe(200);
      expect(result.json).toEqual({
        id: "web-login",
        ok: true,
        payload: { status: "ok" },
      });
    },
  );

  it.each([
    ["gateway.suspend.prepare", { requestId: "host-request-1" }],
    ["gateway.suspend.status", { suspensionId: "suspension-1" }],
    ["gateway.suspend.resume", { suspensionId: "suspension-1" }],
  ] as const)("dispatches suspension method %s through Admin HTTP", async (method, params) => {
    dispatchGatewayMethod.mockResolvedValueOnce({
      ok: true,
      payload: { status: "ok" },
    });

    const result = await invoke({ id: "suspension", method, params });

    expect(dispatchGatewayMethod).toHaveBeenCalledWith(method, params);
    expect(result.captured.statusCode).toBe(200);
    expect(result.json).toEqual({
      id: "suspension",
      ok: true,
      payload: { status: "ok" },
    });
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

  it("rejects invalid request bodies before dispatch", async () => {
    const result = await invoke({ id: "missing" });

    expect(result.captured.statusCode).toBe(400);
    expect(result.json).toEqual({
      ok: false,
      error: {
        type: "invalid_request",
        message: "method must be a non-empty string",
      },
    });
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("rejects declared oversized request bodies before dispatch", async () => {
    const result = await invoke("", "POST", {
      "content-length": String(1024 * 1024 + 1),
    });

    expect(result.captured.statusCode).toBe(413);
    expect(result.json).toEqual({
      ok: false,
      error: {
        type: "invalid_request",
        message: "Payload too large",
      },
    });
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("delivers 413 to a real HTTP client for declared oversized request bodies", async () => {
    const server = createServer((req, res) => {
      void handleAdminHttpRpcRequest(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const result = await requestRealAdminRpc(address.port, {
        contentLength: 1024 * 1024 + 1,
      });

      expect(result.statusCode).toBe(413);
      expect(JSON.parse(result.body) as unknown).toEqual({
        ok: false,
        error: {
          type: "invalid_request",
          message: "Payload too large",
        },
      });
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("delivers 413 to a real HTTP client for streamed oversized request bodies", async () => {
    const server = createServer((req, res) => {
      void handleAdminHttpRpcRequest(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const result = await requestRealAdminRpc(address.port, {
        body: Buffer.alloc(1024 * 1024 + 1, "x"),
      });

      expect(result.statusCode).toBe(413);
      expect(JSON.parse(result.body) as unknown).toEqual({
        ok: false,
        error: {
          type: "invalid_request",
          message: "Payload too large",
        },
      });
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("closes a continuing streamed request after delivering its 413 response", async () => {
    const server = createServer((req, res) => {
      void handleAdminHttpRpcRequest(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const result = await requestContinuingStream(address.port);

      expect(result.statusCode).toBe(413);
      expect(result.closed).toBe(true);
      expect(result.writesAfterLimit).toBeGreaterThan(0);
      expect(JSON.parse(result.body) as unknown).toEqual({
        ok: false,
        error: {
          type: "invalid_request",
          message: "Payload too large",
        },
      });
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("only accepts POST", async () => {
    const result = await invoke({ method: "status" }, "GET");

    expect(result.captured.statusCode).toBe(405);
    expect(result.captured.headers.allow).toBe("POST");
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });
});
