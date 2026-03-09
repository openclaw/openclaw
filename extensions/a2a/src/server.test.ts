import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { A2APluginConfig } from "./config.js";
import { createA2AServer } from "./server.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createConfig(overrides?: Partial<A2APluginConfig>): A2APluginConfig {
  return {
    enabled: true,
    card: {
      name: "Test Agent",
      description: "Test",
      version: "1.0.0",
      skills: [{ id: "chat", name: "Chat", description: "Chat" }],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
    },
    auth: { mode: "none" },
    routing: { defaultAgentId: "default" },
    peers: [],
    timeouts: { agentResponseMs: 300_000, taskRetentionMs: 86_400_000 },
    ...overrides,
  };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function createReq(method: string, url: string, headers?: Record<string, string>): IncomingMessage {
  return {
    method,
    url,
    headers: { host: "localhost:18789", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    on: vi.fn(),
  } as unknown as IncomingMessage;
}

type MockRes = ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: string;
  _ended: boolean;
};

function createRes(): MockRes {
  const headers: Record<string, string> = {};
  let body = "";
  let ended = false;
  let status = 200;
  const res = {
    get _status() {
      return status;
    },
    get _headers() {
      return headers;
    },
    get _body() {
      return body;
    },
    get _ended() {
      return ended;
    },
    writeHead(s: number, h?: Record<string, string | number>) {
      status = s;
      if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
      return res;
    },
    setHeader(key: string, value: string) {
      headers[key.toLowerCase()] = value;
      return res;
    },
    getHeader(key: string) {
      return headers[key.toLowerCase()];
    },
    write(chunk: string) {
      body += chunk;
      return true;
    },
    end(data?: string) {
      if (data) body += data;
      ended = true;
      return res;
    },
    flushHeaders() {},
  } as unknown as MockRes;
  return res;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("createA2AServer", () => {
  it("creates a server with correct agent card", () => {
    const cfg = createConfig();
    const server = createA2AServer(cfg, "/tmp/a2a-test", logger, undefined);

    expect(server.agentCard.name).toBe("Test Agent");
    expect(server.agentCard.protocolVersion).toBe("0.3.0");
    expect(server.agentCard.url).toBe("http://127.0.0.1:18789/a2a/jsonrpc");
  });

  describe("handleRequest", () => {
    it("serves Agent Card on GET /.well-known/agent-card.json", async () => {
      const cfg = createConfig();
      const server = createA2AServer(cfg, "/tmp/a2a-test", logger, undefined);

      const req = createReq("GET", "/.well-known/agent-card.json");
      const res = createRes();

      const handled = await server.handleRequest(req, res);

      expect(handled).toBe(true);
      expect(res._status).toBe(200);
      expect(res._headers["content-type"]).toBe("application/json");

      const body = JSON.parse(res._body);
      expect(body.name).toBe("Test Agent");
      expect(body.protocolVersion).toBe("0.3.0");
    });

    it("serves Agent Card on legacy path /.well-known/agent.json", async () => {
      const cfg = createConfig();
      const server = createA2AServer(cfg, "/tmp/a2a-test", logger, undefined);

      const req = createReq("GET", "/.well-known/agent.json");
      const res = createRes();

      const handled = await server.handleRequest(req, res);
      expect(handled).toBe(true);
      expect(res._status).toBe(200);
    });

    it("returns false for unrelated paths", async () => {
      const cfg = createConfig();
      const server = createA2AServer(cfg, "/tmp/a2a-test", logger, undefined);

      const req = createReq("GET", "/some/other/path");
      const res = createRes();

      const handled = await server.handleRequest(req, res);
      expect(handled).toBe(false);
    });

    it("returns false for GET on JSON-RPC path", async () => {
      const cfg = createConfig();
      const server = createA2AServer(cfg, "/tmp/a2a-test", logger, undefined);

      const req = createReq("GET", "/a2a/jsonrpc");
      const res = createRes();

      const handled = await server.handleRequest(req, res);
      expect(handled).toBe(false);
    });

    it("rejects POST without bearer token when auth configured", async () => {
      const cfg = createConfig({ auth: { mode: "bearer", token: "secret123" } });
      const server = createA2AServer(cfg, "/tmp/a2a-test", logger, undefined);

      // Simulate POST with body
      const req = createReq("POST", "/a2a/jsonrpc");
      const res = createRes();

      // Mock request body reading
      const onMock = req.on as ReturnType<typeof vi.fn>;
      onMock.mockImplementation((event: string, handler: (data?: Buffer) => void) => {
        if (event === "end") handler();
        return req;
      });

      const handled = await server.handleRequest(req, res);
      expect(handled).toBe(true);
      expect(res._status).toBe(401);

      const body = JSON.parse(res._body);
      expect(body.error.message).toBe("Unauthorized");
    });

    it("accepts POST with correct bearer token", async () => {
      const cfg = createConfig({ auth: { mode: "bearer", token: "secret123" } });
      const server = createA2AServer(cfg, "/tmp/a2a-test", logger, undefined);

      const req = createReq("POST", "/a2a/jsonrpc", {
        authorization: "Bearer secret123",
      });
      const res = createRes();

      // Mock request body with invalid JSON-RPC (to trigger parse error, but auth should pass)
      const onMock = req.on as ReturnType<typeof vi.fn>;
      onMock.mockImplementation((event: string, handler: (data?: Buffer) => void) => {
        if (event === "data") handler(Buffer.from("not-json"));
        if (event === "end") handler();
        return req;
      });

      const handled = await server.handleRequest(req, res);
      expect(handled).toBe(true);
      // Should get parse error (400) not auth error (401)
      expect(res._status).toBe(400);
    });

    it("accepts requests when auth mode is none", async () => {
      const cfg = createConfig({ auth: { mode: "none" } });
      const server = createA2AServer(cfg, "/tmp/a2a-test", logger, undefined);

      const req = createReq("POST", "/a2a/jsonrpc");
      const res = createRes();

      const onMock = req.on as ReturnType<typeof vi.fn>;
      onMock.mockImplementation((event: string, handler: (data?: Buffer) => void) => {
        if (event === "data") handler(Buffer.from("{}"));
        if (event === "end") handler();
        return req;
      });

      const handled = await server.handleRequest(req, res);
      expect(handled).toBe(true);
      // No 401 — either 200 or 400 from JSON-RPC processing
      expect(res._status).not.toBe(401);
    });
  });

  describe("start/stop", () => {
    it("starts and stops without error", () => {
      const cfg = createConfig();
      const server = createA2AServer(cfg, "/tmp/a2a-test", logger, undefined);

      expect(() => server.start()).not.toThrow();
      expect(() => server.stop()).not.toThrow();
    });

    it("can stop multiple times safely", () => {
      const cfg = createConfig();
      const server = createA2AServer(cfg, "/tmp/a2a-test", logger, undefined);

      server.start();
      expect(() => server.stop()).not.toThrow();
      expect(() => server.stop()).not.toThrow();
    });
  });
});
