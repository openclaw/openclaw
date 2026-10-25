import { ReadableStream as NodeReadableStream } from "node:stream/web";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { resolveGatewayClientBootstrap } from "../gateway/client-bootstrap.js";

type GatewayClientCallbacks = {
  onEvent?: (evt: { event: string; payload?: unknown }) => void;
  onHelloOk?: () => void;
  onConnectError?: (err: Error) => void;
  onClose?: (code: number, reason: string) => void;
};

type ResolveGatewayClientBootstrap = typeof resolveGatewayClientBootstrap;
type GatewayClientOptions = GatewayClientCallbacks & {
  token?: string;
  password?: string;
  caps?: string[];
  tlsFingerprint?: string;
  url?: string;
};
type MockAcpStream = {
  writable: WritableStream<unknown>;
  readable: ReadableStream<unknown>;
};

function rpcRequest(id: number, method: string, params: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method, params };
}

function rpcUpdate(sessionId: string, text: string) {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  };
}

const mockState = vi.hoisted(() => ({
  acpProtocolVersion: 1,
  acpInputMessages: [] as unknown[],
  rawInputChunks: [] as Uint8Array[],
  acpOutputMessages: [] as unknown[],
  /** When set, the NDJSON sink rejects every write, standing in for a broken stdout. */
  acpOutputSinkError: null as Error | null,
  gateways: [] as MockGatewayClient[],
  agentSideConnectionCtor:
    vi.fn<(factory: (conn: unknown) => unknown, stream: MockAcpStream) => void>(),
  agentHandleGatewayEvent: vi.fn(async (_evt: unknown) => {}),
  agentShutdown: vi.fn(),
  routeLogsToStderr: vi.fn(),
  closeOpenClawStateDatabaseAsync: vi.fn<() => Promise<void>>(async () => {}),
  gatewayStopDeferred: null as {
    resolve: () => void;
    promise: Promise<void>;
  } | null,
  resolveGatewayClientBootstrap: vi.fn<ResolveGatewayClientBootstrap>(),
}));

vi.mock("node:stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:stream")>();
  vi.spyOn(actual.Readable, "toWeb").mockImplementation(
    () =>
      new NodeReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of mockState.rawInputChunks) {
            controller.enqueue(chunk);
          }
        },
      }),
  );
  vi.spyOn(actual.Writable, "toWeb").mockImplementation(() => new WritableStream());
  return actual;
});

class MockGatewayClient {
  constructor(readonly options: GatewayClientOptions) {
    mockState.gateways.push(this);
  }

  start(): void {}

  stop(): void {
    this.options.onClose?.(1000, "gateway stopped");
  }

  async stopAndWait(): Promise<void> {
    if (mockState.gatewayStopDeferred) {
      await mockState.gatewayStopDeferred.promise;
    }
    this.stop();
  }
}

vi.mock("@agentclientprotocol/sdk", () => ({
  AGENT_METHODS: { initialize: "initialize" },
  AgentSideConnection: function AgentSideConnection(
    factory: (conn: unknown) => unknown,
    stream: MockAcpStream,
  ) {
    const [input, monitor] = stream.readable.tee();
    const closed = new Promise<void>((resolve) => {
      // Match the SDK: both EOF and reader failure close the connection.
      void monitor.pipeTo(new WritableStream()).then(
        () => resolve(),
        () => resolve(),
      );
    });
    mockState.agentSideConnectionCtor(factory, { ...stream, readable: input });
    factory({});
    return { closed };
  },
  PROTOCOL_VERSION: mockState.acpProtocolVersion,
  ndJsonStream: vi.fn(() => ({
    writable: new WritableStream({
      write(message) {
        if (mockState.acpOutputSinkError) {
          throw mockState.acpOutputSinkError;
        }
        mockState.acpOutputMessages.push(message);
      },
    }),
    readable: new ReadableStream({
      start(controller) {
        for (const message of mockState.acpInputMessages) {
          controller.enqueue(message);
        }
      },
    }),
  })),
}));

vi.mock("../config/config.js", () => {
  const loadConfig = () => ({ gateway: { mode: "local" } });
  return {
    getRuntimeConfig: loadConfig,
    loadConfig,
    resolveGatewayPort: vi.fn(() => 18_789),
  };
});

vi.mock("../gateway/client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: mockState.resolveGatewayClientBootstrap,
}));

vi.mock("../gateway/client.js", () => ({
  GatewayClient: MockGatewayClient,
}));

vi.mock("../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: vi.fn(async (client: MockGatewayClient) => {
    client.start();
    return { ready: true };
  }),
}));

vi.mock("../infra/is-main.js", () => ({
  isMainModule: () => false,
}));

vi.mock("../logging/console.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/console.js")>();
  return {
    ...actual,
    routeLogsToStderr: () => mockState.routeLogsToStderr(),
  };
});

vi.mock("../state/openclaw-state-db.js", () => ({
  closeOpenClawStateDatabaseAsync: () => mockState.closeOpenClawStateDatabaseAsync(),
}));

vi.mock("./event-ledger.js", () => ({
  createSqliteAcpEventLedger: vi.fn(() => ({ kind: "sqlite-acp-event-ledger" })),
}));

vi.mock("./translator.js", () => ({
  AcpGatewayAgent: class {
    start(): void {}

    shutdown(): void {
      mockState.agentShutdown();
    }

    handleGatewayReconnect(): void {}

    handleGatewayDisconnect(): void {}

    async handleGatewayEvent(event: unknown): Promise<void> {
      await mockState.agentHandleGatewayEvent(event);
    }
  },
}));

describe("serveAcpGateway startup", () => {
  let serveAcpGateway: typeof import("./server.js").serveAcpGateway;

  function createGatewayBootstrap(
    url = "ws://127.0.0.1:18789",
    urlSource = "local loopback",
  ): Awaited<ReturnType<ResolveGatewayClientBootstrap>> {
    return {
      url,
      urlSource,
      connectionDetails: { url, urlSource, message: `Gateway target: ${url}` },
      auth: { token: undefined, password: undefined },
    };
  }

  function getMockGateway() {
    return expectDefined(mockState.gateways[0], "mock Gateway");
  }

  function captureProcessSignalHandlers() {
    const handlers = new Map<NodeJS.Signals, () => void>();
    const spy = vi.spyOn(process, "on").mockImplementation(((
      signal: NodeJS.Signals,
      handler: () => void,
    ) => {
      handlers.set(signal, handler);
      return process;
    }) as typeof process.on);
    return { signalHandlers: handlers, onSpy: spy };
  }

  async function emitHelloAndWaitForAgentSideConnection() {
    await vi.waitFor(() => {
      expect(mockState.gateways).toHaveLength(1);
    });
    const gateway = getMockGateway();
    gateway.options.onHelloOk?.();
    await vi.waitFor(() => {
      expect(mockState.agentSideConnectionCtor).toHaveBeenCalledTimes(1);
    });
  }

  function getCapturedAcpStream(): MockAcpStream {
    return expectDefined(mockState.agentSideConnectionCtor.mock.calls[0]?.[1], "ACP stream");
  }

  async function readCapturedAcpMessages(): Promise<unknown[]> {
    const reader = getCapturedAcpStream().readable.getReader();
    const messages: unknown[] = [];
    try {
      while (messages.length < mockState.acpInputMessages.length) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        messages.push(value);
      }
      return messages;
    } finally {
      reader.releaseLock();
    }
  }

  async function stopServeWithSigint(
    handlers: Map<NodeJS.Signals, () => void>,
    servePromise: Promise<void>,
  ) {
    handlers.get("SIGINT")?.();
    await servePromise;
  }

  async function withWire(
    messages: unknown[],
    run: (writer: WritableStreamDefaultWriter<unknown>, serving: Promise<void>) => Promise<void>,
  ) {
    mockState.acpInputMessages.push(...messages);
    const { signalHandlers, onSpy } = captureProcessSignalHandlers();
    const serving = serveAcpGateway({});
    let writer: WritableStreamDefaultWriter<unknown> | undefined;
    try {
      await emitHelloAndWaitForAgentSideConnection();
      await readCapturedAcpMessages();
      writer = getCapturedAcpStream().writable.getWriter();
      await run(writer, serving);
    } finally {
      writer?.releaseLock();
      try {
        await stopServeWithSigint(signalHandlers, serving);
      } finally {
        onSpy.mockRestore();
      }
    }
  }

  beforeAll(async () => {
    // Vitest workers have closed stdin; model the open ACP transport used by
    // these startup tests. Closed-stdin behavior has process-level coverage.
    Object.defineProperty(process.stdin, "readableEnded", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdin, "readableLength", {
      configurable: true,
      value: 1,
    });
    ({ serveAcpGateway } = await import("./server.js"));
  });

  afterAll(() => {
    const testStdin = process.stdin as unknown as {
      readableEnded?: boolean;
      readableLength?: number;
    };
    delete testStdin.readableEnded;
    delete testStdin.readableLength;
  });

  beforeEach(async () => {
    mockState.acpInputMessages.length = 0;
    mockState.rawInputChunks.length = 0;
    mockState.acpOutputMessages.length = 0;
    mockState.acpOutputSinkError = null;
    mockState.gateways.length = 0;
    mockState.agentSideConnectionCtor.mockReset();
    mockState.agentHandleGatewayEvent.mockReset();
    mockState.agentShutdown.mockReset();
    mockState.routeLogsToStderr.mockReset();
    mockState.closeOpenClawStateDatabaseAsync.mockReset();
    mockState.gatewayStopDeferred = null;
    mockState.resolveGatewayClientBootstrap.mockReset();
    mockState.resolveGatewayClientBootstrap.mockResolvedValue(createGatewayBootstrap());
  });

  describe("Gateway lifecycle", () => {
    let signalHandlers: ReturnType<typeof captureProcessSignalHandlers>["signalHandlers"];
    let onSpy: ReturnType<typeof captureProcessSignalHandlers>["onSpy"];

    async function captureAcpMessagesAfterStartup(inputMessages: unknown[]): Promise<unknown[]> {
      mockState.acpInputMessages.push(...inputMessages);
      const servePromise = serveAcpGateway({});

      try {
        await emitHelloAndWaitForAgentSideConnection();
        return await readCapturedAcpMessages();
      } finally {
        signalHandlers.get("SIGINT")?.();
        await servePromise;
      }
    }

    beforeEach(() => {
      ({ signalHandlers, onSpy } = captureProcessSignalHandlers());
    });
    afterEach(() => onSpy.mockRestore());

    it("routes logs before bootstrap and waits for hello on the TLS-configured Gateway", async () => {
      mockState.resolveGatewayClientBootstrap.mockResolvedValue({
        ...createGatewayBootstrap("wss://127.0.0.1:18789"),
        tlsFingerprint: "sha256:local",
      });

      const servePromise = serveAcpGateway({});
      await Promise.resolve();
      expect(mockState.routeLogsToStderr).toHaveBeenCalledTimes(1);
      expect(mockState.routeLogsToStderr.mock.invocationCallOrder[0]).toBeLessThan(
        mockState.resolveGatewayClientBootstrap.mock.invocationCallOrder[0] ??
          Number.MAX_SAFE_INTEGER,
      );
      expect(mockState.agentSideConnectionCtor).not.toHaveBeenCalled();
      await emitHelloAndWaitForAgentSideConnection();

      expect(getMockGateway().options.tlsFingerprint).toBe("sha256:local");

      await stopServeWithSigint(signalHandlers, servePromise);
    });

    it("contains rejected gateway event handling with verbose logging", async () => {
      const writes: string[] = [];
      const writeSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk: string | Uint8Array): boolean => {
          writes.push(String(chunk));
          return true;
        });
      mockState.agentHandleGatewayEvent.mockRejectedValueOnce(new Error("handler boom"));

      try {
        const servePromise = serveAcpGateway({ verbose: true });
        await emitHelloAndWaitForAgentSideConnection();

        getMockGateway().options.onEvent?.({ event: "chat" });
        await vi.waitFor(() => {
          expect(writes).toEqual([
            "openclaw acp: gateway event chat failed\n",
            "openclaw acp: gateway event chat error: handler boom\n",
          ]);
        });

        await stopServeWithSigint(signalHandlers, servePromise);
      } finally {
        writeSpy.mockRestore();
      }
    });

    it("rejects startup when gateway connect fails before hello", async () => {
      const servePromise = serveAcpGateway({});
      await Promise.resolve();

      const gateway = getMockGateway();
      gateway.options.onConnectError?.(new Error("connect failed"));
      await expect(servePromise).rejects.toThrow("connect failed");
      expect(mockState.agentSideConnectionCtor).not.toHaveBeenCalled();
    });

    it("shuts down when buffered pre-hello ACP input exceeds its limit", async () => {
      mockState.rawInputChunks.push(new Uint8Array(1024 * 1024 + 1));

      await serveAcpGateway({});
      expect(mockState.agentSideConnectionCtor).not.toHaveBeenCalled();
      expect(mockState.closeOpenClawStateDatabaseAsync).toHaveBeenCalledOnce();
    });

    it("closes the real SQLite handle only after agent and Gateway transport teardown", async () => {
      const actualStateDb = await vi.importActual<typeof import("../state/openclaw-state-db.js")>(
        "../state/openclaw-state-db.js",
      );

      const realDb = actualStateDb.openOpenClawStateDatabase();
      expect(realDb.db.isOpen).toBe(true);
      expect(actualStateDb.isOpenClawStateDatabaseOpen()).toBe(true);

      mockState.closeOpenClawStateDatabaseAsync.mockImplementation(() =>
        actualStateDb.closeOpenClawStateDatabaseAsync(),
      );
      const stop = createDeferred();
      mockState.gatewayStopDeferred = stop;
      try {
        const servePromise = serveAcpGateway({});
        await emitHelloAndWaitForAgentSideConnection();
        const input = getCapturedAcpStream().readable.getReader();
        const inputClosed = expect(input.read()).rejects.toMatchObject({ name: "AbortError" });
        signalHandlers.get("SIGTERM")?.();
        await inputClosed;
        input.releaseLock();
        await vi.waitFor(() => expect(mockState.agentShutdown).toHaveBeenCalledOnce());
        expect(mockState.closeOpenClawStateDatabaseAsync).not.toHaveBeenCalled();
        expect(realDb.db.isOpen).toBe(true);
        stop.resolve();
        await servePromise;
        expect(mockState.closeOpenClawStateDatabaseAsync).toHaveBeenCalledOnce();
        expect(realDb.db.isOpen).toBe(false);
        expect(actualStateDb.isOpenClawStateDatabaseOpen()).toBe(false);
      } finally {
        stop.resolve();
        await actualStateDb.closeOpenClawStateDatabaseAsync();
      }
    });

    it.each(["2025-11-25", 1.5, 42])("normalizes initialize version %s", async (version) => {
      const request = rpcRequest(1, "initialize", {
        protocolVersion: version,
        clientCapabilities: {},
      });
      const [message] = await captureAcpMessagesAfterStartup([request]);
      if (version === 42) {
        expect(message).toBe(request);
      } else {
        expect(message).toEqual({
          ...request,
          params: { ...request.params, protocolVersion: mockState.acpProtocolVersion },
        });
      }
    });
  });

  it("wires session creation ordering into the server transport", async () => {
    await withWire([rpcRequest(1, "session/new", { cwd: "/tmp" })], async (writer) => {
      const update = rpcUpdate("new", "answer");
      const result = { jsonrpc: "2.0", id: 1, result: { sessionId: "new" } };
      await writer.write(update);
      expect(mockState.acpOutputMessages).toEqual([]);
      await writer.write(result);
      await vi.waitFor(() => expect(mockState.acpOutputMessages).toEqual([result, update]));
    });
  });

  it("tears down the agent, Gateway, and state database when the outbound sink fails", async () => {
    await withWire([], async (writer, serving) => {
      const stopAndWait = vi.spyOn(getMockGateway(), "stopAndWait");
      expect(mockState.closeOpenClawStateDatabaseAsync).not.toHaveBeenCalled();
      // Buffered writes expose sink failure through pipeTo, not writer.write.
      mockState.acpOutputSinkError = new Error("stdout sink failed");
      await writer.write({ jsonrpc: "2.0", id: 9, result: {} }).catch(() => {});
      await serving;
      expect(stopAndWait).toHaveBeenCalledOnce();
      expect(mockState.agentShutdown).toHaveBeenCalledOnce();
      expect(mockState.closeOpenClawStateDatabaseAsync).toHaveBeenCalledOnce();
    });
  });
});
