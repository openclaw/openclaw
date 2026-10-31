import { Readable, Writable } from "node:stream";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  PROTOCOL_VERSION,
  type AgentSideConnection,
  type AnyMessage,
  type JsonRpcId,
} from "@agentclientprotocol/sdk";
import type { AcpSessionStore } from "@openclaw/acp-core/session";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { resolveGatewayClientBootstrap } from "../gateway/client-bootstrap.js";

type GatewayOptions = {
  onEvent?: (event: { event: string; payload?: unknown }) => void;
  onHelloOk?: () => void;
  onConnectError?: (error: Error) => void;
  onClose?: (code: number, reason: string) => void;
  tlsFingerprint?: string;
};
type SessionLocation = { sessionId: string; cwd: string };
const state = vi.hoisted(() => ({
  input: [] as Uint8Array[],
  output: [] as AnyMessage[],
  entered: [] as string[],
  enqueue: undefined as ((bytes: Uint8Array) => void) | undefined,
  store: undefined as AcpSessionStore | undefined,
  maxSessions: 10,
  slow: undefined as ReturnType<typeof createDeferred<void>> | undefined,
  connection: undefined as AgentSideConnection | undefined,
  gateway: undefined as GatewayOptions | undefined,
  sinkError: undefined as Error | undefined,
  events: vi.fn(async (_event: unknown) => {}),
  shutdown: vi.fn(),
  stop: vi.fn<() => Promise<void>>(),
  logs: vi.fn(),
  closeDb: vi.fn<() => Promise<void>>(),
  bootstrap: vi.fn<typeof resolveGatewayClientBootstrap>(),
}));
const notification = {
  sessionId: "new",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
} as const;
const sessionInfo = (sessionId: string, title: string) => ({
  sessionId,
  update: { sessionUpdate: "session_info_update" as const, title },
});

vi.mock("@openclaw/acp-core/session", async (original) => {
  const actual = await original<typeof import("@openclaw/acp-core/session")>();
  return {
    ...actual,
    createInMemorySessionStore: (
      options: Parameters<typeof actual.createInMemorySessionStore>[0],
    ) => actual.createInMemorySessionStore({ ...options, maxSessions: state.maxSessions }),
  };
});

// mock-isolation: drive connection callbacks without opening a real Gateway transport.
vi.mock("../gateway/client.js", () => ({
  GatewayClient: class {
    constructor(options: GatewayOptions) {
      state.gateway = options;
    }
    start() {}
    async stopAndWait() {
      await state.stop();
      state.gateway?.onClose?.(1000, "gateway stopped");
    }
  },
}));
// mock-isolation: bootstrap credentials and connection options belong to each startup scenario.
vi.mock("../gateway/client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: state.bootstrap,
}));
// mock-isolation: startup uses fixture config without reading the operator's configuration.
vi.mock("../config/config.js", () => {
  const loadConfig = () => ({ gateway: { mode: "local" } });
  return { getRuntimeConfig: loadConfig, loadConfig, resolveGatewayPort: () => 18_789 };
});
// mock-isolation: readiness is immediate so startup ordering does not depend on event-loop probes.
vi.mock("../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: async () => ({ ready: true }),
}));
// mock-isolation: importing the server must not launch its executable entry point.
vi.mock("../infra/is-main.js", () => ({ isMainModule: () => false }));
vi.mock("../logging/console.js", async (original) => ({
  ...(await original<typeof import("../logging/console.js")>()),
  routeLogsToStderr: () => state.logs(),
}));
// mock-isolation: observe shutdown ownership without closing a real process-wide state database.
vi.mock("../state/openclaw-state-db.js", () => ({
  closeOpenClawStateDatabaseAsync: () => state.closeDb(),
}));
// mock-isolation: startup wiring must not open a persistent SQLite event ledger.
vi.mock("./event-ledger.js", () => ({ createSqliteAcpEventLedger: () => ({}) }));
// mock-isolation: control translator events while exercising the real server framing and lifecycle.
vi.mock("./translator.js", () => ({
  AcpGatewayAgent: class {
    constructor(
      private connection: AgentSideConnection,
      _gateway: unknown,
      private options: { sessionStore: AcpSessionStore },
    ) {
      state.connection = connection;
      state.store = options.sessionStore;
    }
    start() {}
    shutdown() {
      state.shutdown();
    }
    handleGatewayReconnect() {}
    handleGatewayDisconnect() {}
    async handleGatewayEvent(event: unknown) {
      await state.events(event);
    }
    async initialize(params: { protocolVersion: number }) {
      return { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true } };
    }
    async newSession(params: { cwd: string }) {
      const sessionId = params.cwd.slice(1);
      state.entered.push(sessionId);
      this.options.sessionStore.createSession({
        sessionId,
        sessionKey: sessionId,
        cwd: params.cwd,
      });
      await this.connection.sessionUpdate(sessionInfo(sessionId, "snapshot"));
      if (sessionId === "slow") {
        await state.slow?.promise;
      }
      return { sessionId };
    }
    loadSession(params: SessionLocation) {
      return this.restore(params, "load");
    }
    resumeSession(params: SessionLocation) {
      return this.restore(params, "resume");
    }
    private async restore(params: SessionLocation, method: "load" | "resume") {
      state.entered.push(`${method}:${params.sessionId}`);
      this.options.sessionStore.createSession({ ...params, sessionKey: params.sessionId });
      await this.connection.sessionUpdate(
        sessionInfo(params.sessionId, method === "load" ? "loaded" : "resumed"),
      );
      return {};
    }
    async prompt(params: { sessionId: string }) {
      await this.connection.sessionUpdate({ ...notification, sessionId: params.sessionId });
      return { stopReason: "end_turn" };
    }
  },
}));

let serve: typeof import("./server.js").serveAcpGateway;
const signals = new Map<NodeJS.Signals, () => void>();
function bootstrap(
  url = "ws://127.0.0.1:18789",
): Awaited<ReturnType<typeof resolveGatewayClientBootstrap>> {
  return {
    url,
    urlSource: "test",
    connectionDetails: { url, urlSource: "test", message: url },
    auth: {},
  };
}
function post(message: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(message) + "\n");
  if (state.enqueue) {
    state.enqueue(bytes);
  } else {
    state.input.push(bytes);
  }
}
const request = (id: JsonRpcId, method: string, params: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});
const create = (id: JsonRpcId, sessionId: string) =>
  request(id, "session/new", { cwd: `/${sessionId}`, mcpServers: [] });
const initialize = (id: number) =>
  request(id, "initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
const restore = (id: JsonRpcId, method: string, sessionId: string) =>
  request(id, method, { sessionId, cwd: "/tmp", mcpServers: [] });
async function ready() {
  await vi.waitFor(() => expect(state.gateway).toBeDefined());
  state.gateway?.onHelloOk?.();
  await vi.waitFor(() => expect(state.connection).toBeDefined());
}
async function run(
  body: (closed: Promise<void>) => Promise<void>,
  options: Parameters<typeof serve>[0] = {},
  expectedFailure = false,
) {
  const closed = serve(options);
  try {
    await body(closed);
  } finally {
    state.slow?.resolve();
    signals.get("SIGINT")?.();
    if (expectedFailure) {
      await closed.catch(() => {});
    } else {
      await closed;
    }
  }
}

beforeAll(async () => {
  Object.defineProperties(process.stdin, {
    readableEnded: { configurable: true, value: false },
    readableLength: { configurable: true, value: 1 },
  });
  ({ serveAcpGateway: serve } = await import("./server.js"));
});
afterAll(() => {
  Reflect.deleteProperty(process.stdin, "readableEnded");
  Reflect.deleteProperty(process.stdin, "readableLength");
});
beforeEach(() => {
  state.input.length = state.output.length = state.entered.length = 0;
  state.connection = state.gateway = undefined;
  state.enqueue = state.store = undefined;
  state.maxSessions = 10;
  state.slow = createDeferred();
  state.sinkError = undefined;
  signals.clear();
  for (const mock of [
    state.events,
    state.shutdown,
    state.stop,
    state.logs,
    state.closeDb,
    state.bootstrap,
  ]) {
    mock.mockReset();
  }
  state.stop.mockResolvedValue(undefined);
  state.closeDb.mockResolvedValue(undefined);
  state.bootstrap.mockResolvedValue(bootstrap());
  // Keep stdin open until server cancellation; feed real SDK NDJSON bytes.
  vi.spyOn(Readable, "toWeb").mockImplementation(
    () =>
      new NodeReadableStream<Uint8Array>({
        start(controller) {
          state.enqueue = (bytes) => controller.enqueue(bytes);
          for (const bytes of state.input) {
            controller.enqueue(bytes);
          }
        },
      }),
  );
  vi.spyOn(Writable, "toWeb").mockImplementation(
    () =>
      new WritableStream<Uint8Array>({
        write(bytes) {
          if (state.sinkError) {
            throw state.sinkError;
          }
          state.output.push(JSON.parse(new TextDecoder().decode(bytes)));
        },
      }),
  );
  vi.spyOn(process, "on").mockImplementation(((signal: NodeJS.Signals, listener: () => void) => {
    signals.set(signal, listener);
    return process;
  }) as typeof process.on);
});
afterEach(() => vi.restoreAllMocks());

it("routes logs before bootstrap and waits for hello on the TLS-configured Gateway", async () => {
  state.bootstrap.mockResolvedValue({
    ...bootstrap("wss://127.0.0.1:18789"),
    tlsFingerprint: "sha256:local",
  });
  await run(async () => {
    await Promise.resolve();
    expect(state.logs.mock.invocationCallOrder[0]).toBeLessThan(
      state.bootstrap.mock.invocationCallOrder[0]!,
    );
    expect(state.connection).toBeUndefined();
    await ready();
    expect(state.gateway?.tlsFingerprint).toBe("sha256:local");
  });
});

it("contains rejected gateway event handling with verbose logging", async () => {
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  state.events.mockRejectedValueOnce(new Error("handler boom"));
  await run(
    async () => {
      await ready();
      state.gateway?.onEvent?.({ event: "chat" });
      await vi.waitFor(() =>
        expect(writes).toEqual([
          "openclaw acp: gateway event chat failed\n",
          "openclaw acp: gateway event chat error: handler boom\n",
        ]),
      );
    },
    { verbose: true },
  );
});

it("rejects startup when gateway connect fails before hello", async () => {
  await run(
    async (closed) => {
      await vi.waitFor(() => expect(state.gateway).toBeDefined());
      state.gateway?.onConnectError?.(new Error("connect failed"));
      await expect(closed).rejects.toThrow("connect failed");
      expect(state.connection).toBeUndefined();
    },
    {},
    true,
  );
});

it("shuts down when buffered pre-hello ACP input exceeds its limit", async () => {
  state.input.push(new Uint8Array(1024 * 1024 + 1));
  await run(async (closed) => {
    await closed;
    expect(state.connection).toBeUndefined();
    expect(state.closeDb).toHaveBeenCalledOnce();
  });
});

it("closes the real SQLite handle only after SDK and Gateway transport teardown", async () => {
  const db = await vi.importActual<typeof import("../state/openclaw-state-db.js")>(
    "../state/openclaw-state-db.js",
  );
  const handle = db.openOpenClawStateDatabase();
  state.closeDb.mockImplementation(() => db.closeOpenClawStateDatabaseAsync());
  const gate = createDeferred();
  state.stop.mockImplementation(() => gate.promise);
  try {
    await run(async (closed) => {
      try {
        await ready();
        expect(handle.db.isOpen).toBe(true);
        signals.get("SIGTERM")?.();
        await expectDefined(state.connection, "SDK connection").closed;
        expect(state.shutdown).toHaveBeenCalledOnce();
        expect(state.closeDb).not.toHaveBeenCalled();
        expect(handle.db.isOpen).toBe(true);
      } finally {
        gate.resolve();
      }
      await closed;
      expect(state.closeDb).toHaveBeenCalledOnce();
      expect(handle.db.isOpen).toBe(false);
      expect(db.isOpenClawStateDatabaseOpen()).toBe(false);
    });
  } finally {
    gate.resolve();
    await db.closeOpenClawStateDatabaseAsync();
  }
});

it.each(["2025-11-25", 1.5, 42])(
  "normalizes initialize version %s through the SDK",
  async (version) => {
    post(request(1, "initialize", { protocolVersion: version, clientCapabilities: {} }));
    await run(async () => {
      await ready();
      await vi.waitFor(() =>
        expect(state.output).toEqual([
          {
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: version === 42 ? 42 : PROTOCOL_VERSION,
              agentCapabilities: { loadSession: true },
            },
          },
        ]),
      );
    });
  },
);

it("tears down the agent, Gateway, and state database when the outbound sink fails", async () => {
  await run(async (closed) => {
    await ready();
    expect(state.closeDb).not.toHaveBeenCalled();
    state.sinkError = new Error("stdout sink failed");
    await expectDefined(state.connection, "SDK connection")
      .sessionUpdate(notification)
      .catch(() => {});
    await closed;
    for (const operation of [state.stop, state.shutdown, state.closeDb]) {
      expect(operation).toHaveBeenCalledOnce();
    }
    expect(state.output).toEqual([]);
  });
});

const poll = { interval: 1 };
const responseIndex = (id: JsonRpcId) =>
  state.output.findIndex((frame) => "id" in frame && frame.id === id && !("method" in frame));
const updateIndex = (sessionId: string) =>
  state.output.findIndex(
    (frame) =>
      "method" in frame &&
      frame.method === "session/update" &&
      (frame.params as { sessionId?: string }).sessionId === sessionId,
  );
async function exchange(message: ReturnType<typeof request>) {
  post(message);
  await waitResponse(message.id);
}
async function waitResponse(id: JsonRpcId) {
  await expect.poll(() => responseIndex(id), poll).toBeGreaterThanOrEqual(0);
}
async function beginSlow(id: JsonRpcId) {
  post(create(id, "slow"));
  await expect.poll(() => state.entered, poll).toContain("slow");
}
async function finishSlow(id: JsonRpcId) {
  state.slow?.resolve();
  await waitResponse(id);
  await expect.poll(() => updateIndex("slow"), poll).toBeGreaterThan(responseIndex(id));
}
function expectUpdateBefore(sessionId: string, id: JsonRpcId) {
  expect(updateIndex(sessionId)).toBeGreaterThanOrEqual(0);
  expect(updateIndex(sessionId)).toBeLessThan(responseIndex(id));
}
async function withWire(body: () => Promise<void>) {
  await run(async () => {
    await ready();
    await body();
  });
}

it("streams create/prompt/load/resume with empty and null IDs while a creation is pending", async () => {
  await withWire(async () => {
    await beginSlow(90);
    await exchange(create(1, "chatty"));
    await exchange(request(2, "session/prompt", { sessionId: "chatty", prompt: [] }));
    await exchange(restore("", "session/load", "loaded"));
    await exchange(restore(null, "session/resume", "resumed"));
    expect(responseIndex(90)).toBe(-1);
    expect(updateIndex("chatty")).toBeGreaterThan(responseIndex(1));
    const text = state.output.findIndex(
      (frame) => "method" in frame && JSON.stringify(frame).includes('"answer"'),
    );
    expect(text).toBeGreaterThan(responseIndex(1));
    expect(text).toBeLessThan(responseIndex(2));
    expectUpdateBefore("loaded", "");
    expectUpdateBefore("resumed", null);
    await finishSlow(90);
  });
});

it.each([
  { ...create(41, "invalid"), jsonrpc: undefined },
  request(null, "session/new", { cwd: 1, mcpServers: [] }),
])("retires rejected session correlations for %j", async (message) => {
  await withWire(async () => {
    post(message);
    await waitResponse(null);
    expect(state.entered).toEqual([]);
    await expectDefined(state.connection, "SDK connection").sessionUpdate(
      sessionInfo("unowned", "after rejection"),
    );
    await exchange(initialize(42));
    expectUpdateBefore("unowned", 42);
    await beginSlow("");
    await finishSlow("");
    expect(state.entered).toEqual(["slow"]);
  });
});

it("does not settle a null-ID creation on an uncorrelated protocol error", async () => {
  await withWire(async () => {
    await beginSlow(null);
    post({ ...create(41, "invalid"), jsonrpc: "1.0" });
    await waitResponse(null);
    await exchange(initialize(42));
    expect(updateIndex("slow")).toBe(-1);
    await finishSlow(null);
    await expect
      .poll(() => state.output.some((frame) => "result" in frame && frame.id === null), poll)
      .toBe(true);
    await expect.poll(() => updateIndex("slow"), poll).toBeGreaterThan(2);
  });
});

it("forgets recognition when the actual session store evicts an idle session", async () => {
  state.maxSessions = 1;
  await withWire(async () => {
    await exchange(create(1, "evicted"));
    await beginSlow(2);
    expect(state.store?.hasSession("evicted")).toBe(false);
    const before = state.output.length;
    await expectDefined(state.connection, "SDK connection").sessionUpdate(
      sessionInfo("evicted", "late"),
    );
    await exchange(initialize(3));
    expect(state.output.slice(before)).toHaveLength(1);
    await finishSlow(2);
    await expect.poll(() => state.output.length, poll).toBe(before + 4);
  });
});

it("preserves the stable SDK's rejection of NDJSON batch frames", async () => {
  await withWire(async () => {
    post([create(1, "batched")]);
    await expectDefined(state.connection, "SDK connection").closed;
    expect(state.entered).toEqual([]);
    expect(state.output).toEqual([]);
  });
});
