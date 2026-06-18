import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Reconnect-on-session-loss coverage for `callTool`. This file mocks the MCP
// SDK `Client`, the transport resolver, and the embedded MCP config so we can
// deterministically simulate a server dropping our streamable-http session — a
// path that is impractical to trigger with the real-server harness used by
// `agent-bundle-mcp-runtime.test.ts`. Mocks are hoisted/module-wide, which is
// why this lives in a dedicated file rather than extending the harness suite.
// ---------------------------------------------------------------------------

type CallToolHandler = (clientIndex: number, req: unknown) => Promise<unknown> | unknown;
type ConnectHandler = (clientIndex: number) => Promise<void> | void;

const hooks = vi.hoisted(() => {
  type FakeClient = {
    index: number;
    connect: ReturnType<typeof vi.fn>;
    getServerCapabilities: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  type FakeTransport = {
    index: number;
    transportType: "stdio" | "sse" | "streamable-http";
    close: ReturnType<typeof vi.fn>;
    terminateSession: ReturnType<typeof vi.fn>;
  };

  const clients: FakeClient[] = [];
  const transports: FakeTransport[] = [];
  const controller: {
    callTool: CallToolHandler;
    connect: ConnectHandler;
    transportType: "stdio" | "sse" | "streamable-http";
    servers: Record<string, unknown>;
  } = {
    // Default: every tool call succeeds.
    callTool: () => ({ content: [{ type: "text", text: "ok" }] }),
    // Default: every connect resolves immediately.
    connect: () => {},
    transportType: "streamable-http",
    servers: { vault: { url: "https://example.test/mcp", transport: "streamable-http" } },
  };

  class ClientMock {
    index: number;
    connect: ReturnType<typeof vi.fn>;
    getServerCapabilities: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    constructor() {
      const index = clients.length;
      this.index = index;
      this.connect = vi.fn(async () => {
        await controller.connect(index);
      });
      this.getServerCapabilities = vi.fn(() => undefined);
      this.listTools = vi.fn(async () => ({
        tools: [{ name: "do_thing", inputSchema: { type: "object" } }],
        nextCursor: undefined,
      }));
      this.callTool = vi.fn(async (req: unknown) => controller.callTool(index, req));
      this.close = vi.fn(async () => {});
      clients.push(this as unknown as FakeClient);
    }
  }

  const resolveMcpTransport = vi.fn((serverName: string) => {
    const index = transports.length;
    const transport: FakeTransport = {
      index,
      transportType: controller.transportType,
      close: vi.fn(async () => {}),
      terminateSession: vi.fn(async () => {}),
    };
    transports.push(transport);
    return {
      transport,
      description: `fake:${serverName}`,
      transportType: controller.transportType,
      connectionTimeoutMs: 100_000,
      requestTimeoutMs: 100_000,
      supportsParallelToolCalls: false,
      detachStderr: undefined,
    };
  });

  const loadEmbeddedAgentMcpConfig = vi.fn(() => ({
    mcpServers: controller.servers,
    diagnostics: [],
  }));

  return {
    clients,
    transports,
    controller,
    ClientMock,
    resolveMcpTransport,
    loadEmbeddedAgentMcpConfig,
  };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: hooks.ClientMock }));
vi.mock("./mcp-transport.js", () => ({ resolveMcpTransport: hooks.resolveMcpTransport }));
vi.mock("./embedded-agent-mcp.js", () => ({
  loadEmbeddedAgentMcpConfig: hooks.loadEmbeddedAgentMcpConfig,
}));

import { __testing, createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";

const { isMcpSessionLostError } = __testing;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sessionLostHttpError() {
  return new StreamableHTTPError(
    404,
    'Error POSTing to endpoint: {"jsonRpcError":{"code":-32603,"message":"Session not found: abc"}}',
  );
}

function makeRuntime(sessionId: string) {
  return createSessionMcpRuntime({ sessionId, workspaceDir: "/tmp/reconnect-test" });
}

afterEach(() => {
  hooks.clients.length = 0;
  hooks.transports.length = 0;
  hooks.controller.callTool = () => ({ content: [{ type: "text", text: "ok" }] });
  hooks.controller.connect = () => {};
  hooks.controller.transportType = "streamable-http";
  hooks.controller.servers = {
    vault: { url: "https://example.test/mcp", transport: "streamable-http" },
  };
  vi.clearAllMocks();
});

describe("isMcpSessionLostError", () => {
  it("flags a StreamableHTTPError with HTTP 404", () => {
    expect(isMcpSessionLostError(new StreamableHTTPError(404, "gone"))).toBe(true);
  });

  it("flags a StreamableHTTPError whose body leaked 'Session not found' (non-404 status)", () => {
    expect(
      isMcpSessionLostError(
        new StreamableHTTPError(500, "Error POSTing to endpoint: {... Session not found: x ...}"),
      ),
    ).toBe(true);
  });

  it("flags an McpError-shaped -32603 'Session not found' (HTTP-200 body)", () => {
    expect(
      isMcpSessionLostError({ code: -32603, message: "MCP error -32603: Session not found: abc" }),
    ).toBe(true);
  });

  it("does not flag unrelated errors", () => {
    expect(isMcpSessionLostError(new StreamableHTTPError(500, "internal boom"))).toBe(false);
    expect(isMcpSessionLostError(new Error("Session not found"))).toBe(false); // generic Error, no code
    expect(isMcpSessionLostError({ code: -32603, message: "some other internal error" })).toBe(
      false,
    );
    expect(isMcpSessionLostError(null)).toBe(false);
    expect(isMcpSessionLostError("Session not found")).toBe(false);
  });
});

describe("callTool reconnect-on-session-loss", () => {
  it("does not reconnect on a successful call", async () => {
    const runtime = makeRuntime("happy");
    const result = await runtime.callTool("vault", "do_thing", {});
    expect((result as { content: unknown }).content).toBeDefined();
    expect(hooks.clients).toHaveLength(1); // only the initial catalog client
    expect(hooks.clients[0].callTool).toHaveBeenCalledTimes(1);
    expect(hooks.transports[0].terminateSession).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("re-handshakes once and retries when the session is lost", async () => {
    hooks.controller.callTool = (clientIndex) => {
      if (clientIndex === 0) {
        throw sessionLostHttpError();
      }
      return { content: [{ type: "text", text: "healed" }] };
    };
    const runtime = makeRuntime("heal");
    const result = await runtime.callTool("vault", "do_thing", {});
    expect((result as { content: [{ text: string }] }).content[0].text).toBe("healed");
    // Exactly one reconnect: a fresh client + transport were built.
    expect(hooks.clients).toHaveLength(2);
    expect(hooks.transports).toHaveLength(2);
    // The dead session was torn down.
    expect(hooks.clients[0].close).toHaveBeenCalledTimes(1);
    expect(hooks.transports[0].close).toHaveBeenCalledTimes(1);
    // Dead-session teardown skips the guaranteed-404 DELETE.
    expect(hooks.transports[0].terminateSession).not.toHaveBeenCalled();
    // The retry ran on the fresh client.
    expect(hooks.clients[1].callTool).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it("does not re-list tools on reconnect and keeps the cached catalog stable", async () => {
    hooks.controller.callTool = (clientIndex) =>
      clientIndex === 0 ? Promise.reject(sessionLostHttpError()) : { content: [] };
    const runtime = makeRuntime("catalog");
    const before = await runtime.getCatalog();
    await runtime.callTool("vault", "do_thing", {});
    const after = await runtime.getCatalog();
    // Catalog identity is preserved across the reconnect (prompt-prefix stability).
    expect(after).toBe(before);
    // Only the initial catalog build listed tools; reconnect did not.
    expect(hooks.clients[0].listTools).toHaveBeenCalledTimes(1);
    expect(hooks.clients[1].listTools).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("propagates and does not loop when the retry also fails session-lost", async () => {
    hooks.controller.callTool = () => Promise.reject(sessionLostHttpError());
    const runtime = makeRuntime("loop");
    await expect(runtime.callTool("vault", "do_thing", {})).rejects.toBeInstanceOf(
      StreamableHTTPError,
    );
    // One reconnect only: clients = initial(0) + one reconnect(1). No storm.
    expect(hooks.clients).toHaveLength(2);
    await runtime.dispose();
  });

  it("rethrows a non-session error without reconnecting", async () => {
    hooks.controller.callTool = () => Promise.reject(new StreamableHTTPError(500, "boom"));
    const runtime = makeRuntime("nonsession");
    await expect(runtime.callTool("vault", "do_thing", {})).rejects.toThrow("boom");
    expect(hooks.clients).toHaveLength(1); // no reconnect
    await runtime.dispose();
  });

  it("does not reconnect a non-streamable-http transport on a session-lost-looking error", async () => {
    hooks.controller.transportType = "stdio";
    hooks.controller.servers = { vault: { command: "fake" } };
    hooks.controller.callTool = () => Promise.reject(sessionLostHttpError());
    const runtime = makeRuntime("stdio");
    await expect(runtime.callTool("vault", "do_thing", {})).rejects.toBeInstanceOf(
      StreamableHTTPError,
    );
    expect(hooks.clients).toHaveLength(1); // transport gate prevents reconnect
    await runtime.dispose();
  });

  it("surfaces the connect error and leaks nothing when reconnect fails", async () => {
    hooks.controller.callTool = (clientIndex) =>
      clientIndex === 0 ? Promise.reject(sessionLostHttpError()) : { content: [] };
    hooks.controller.connect = (clientIndex) => {
      if (clientIndex === 1) {
        throw new Error("connection refused");
      }
    };
    const runtime = makeRuntime("reconnect-fail");
    await expect(runtime.callTool("vault", "do_thing", {})).rejects.toThrow("connection refused");
    // The half-open reconnect client was disposed (no leak).
    expect(hooks.clients).toHaveLength(2);
    expect(hooks.clients[1].close).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it("dedupes concurrent reconnects on the same server", async () => {
    hooks.controller.callTool = (clientIndex) =>
      clientIndex === 0 ? Promise.reject(sessionLostHttpError()) : { content: [] };
    const runtime = makeRuntime("concurrent");
    const [a, b] = await Promise.all([
      runtime.callTool("vault", "do_thing", {}),
      runtime.callTool("vault", "do_thing", {}),
    ]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Single reconnect shared by both callers: initial(0) + one reconnect(1).
    expect(hooks.clients).toHaveLength(2);
    // resolveMcpTransport: once for the initial catalog, once for the single reconnect.
    expect(hooks.resolveMcpTransport).toHaveBeenCalledTimes(2);
    // Dead session disposed exactly once.
    expect(hooks.clients[0].close).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it("tears down the fresh client when disposed mid-reconnect", async () => {
    const gate = deferred<void>();
    hooks.controller.callTool = (clientIndex) =>
      clientIndex === 0 ? Promise.reject(sessionLostHttpError()) : { content: [] };
    hooks.controller.connect = async (clientIndex) => {
      if (clientIndex === 1) {
        await gate.promise; // hold the reconnect open
      }
    };
    const runtime = makeRuntime("disposed-mid");
    const call = runtime.callTool("vault", "do_thing", {});
    // Let the call reach the pending reconnect connect.
    await vi.waitFor(() => expect(hooks.clients).toHaveLength(2));
    await runtime.dispose();
    gate.resolve(); // connect resolves, but the runtime is now disposed
    await expect(call).rejects.toThrow(/disposed/);
    // Fresh reconnect client was torn down (no leak).
    expect(hooks.clients[1].close).toHaveBeenCalledTimes(1);
  });
});
