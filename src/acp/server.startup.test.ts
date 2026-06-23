/** Tests ACP server startup readiness, Gateway bootstrap, and shutdown wiring. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type GatewayClientCallbacks = {
  onStop?: () => void | Promise<void>;
  onHelloOk?: () => void;
  onConnectError?: (err: Error) => void;
  onClose?: (code: number, reason: string) => void;
};

type GatewayClientAuth = {
  token?: string;
  password?: string;
};
type ResolveGatewayClientBootstrap = (params: unknown) => Promise<{
  url: string;
  urlSource: string;
  auth: GatewayClientAuth;
  sshTunnel?: {
    stop: () => void | Promise<void>;
  };
}>;
type GatewayClientOptions = GatewayClientCallbacks &
  GatewayClientAuth & {
    caps?: string[];
    url?: string;
  };
type MockAcpStream = {
  writable: WritableStream<unknown>;
  readable: ReadableStream<unknown>;
};

const mockState = vi.hoisted(() => ({
  acpProtocolVersion: 1,
  acpInputMessages: [] as unknown[],
  gateways: [] as MockGatewayClient[],
  gatewayAuth: [] as GatewayClientAuth[],
  gatewayOptions: [] as GatewayClientOptions[],
  gatewayConstructorError: null as Error | null,
  gatewayStopAndWait: vi.fn(),
  agentSideConnectionCtor: vi.fn(),
  agentStart: vi.fn(),
  routeLogsToStderr: vi.fn(),
  startProxy: vi.fn(async (_configForTest: unknown) => null as unknown),
  stopProxy: vi.fn(async (_handle: unknown) => {}),
  resolveGatewayClientBootstrap: vi.fn<ResolveGatewayClientBootstrap>(async (_params) => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    auth: {
      token: undefined,
      password: undefined,
    },
  })),
}));

class MockGatewayClient {
  private callbacks: GatewayClientCallbacks;

  constructor(opts: GatewayClientOptions) {
    if (mockState.gatewayConstructorError) {
      throw mockState.gatewayConstructorError;
    }
    this.callbacks = opts;
    mockState.gatewayOptions.push(opts);
    mockState.gatewayAuth.push({ token: opts.token, password: opts.password });
    mockState.gateways.push(this);
  }

  start(): void {}

  stop(): void {
    void this.callbacks.onStop?.();
    this.callbacks.onClose?.(1000, "gateway stopped");
  }

  async stopAndWait(): Promise<void> {
    mockState.gatewayStopAndWait();
    await this.callbacks.onStop?.();
    this.callbacks.onClose?.(1000, "gateway stopped");
  }

  emitHello(): void {
    this.callbacks.onHelloOk?.();
  }

  emitConnectError(message: string): void {
    this.callbacks.onConnectError?.(new Error(message));
  }
}

vi.mock("@agentclientprotocol/sdk", () => ({
  AGENT_METHODS: {
    initialize: "initialize",
  },
  AgentSideConnection: function AgentSideConnection(
    factory: (conn: unknown) => unknown,
    stream: unknown,
  ) {
    mockState.agentSideConnectionCtor(factory, stream);
    factory({});
  },
  PROTOCOL_VERSION: mockState.acpProtocolVersion,
  ndJsonStream: vi.fn(() => ({
    writable: new WritableStream(),
    readable: new ReadableStream({
      start(controller) {
        for (const message of mockState.acpInputMessages) {
          controller.enqueue(message);
        }
        controller.close();
      },
    }),
  })),
}));

vi.mock("../config/config.js", () => {
  const loadConfig = () => ({
    gateway: {
      mode: "local",
    },
  });
  return {
    getRuntimeConfig: loadConfig,
    loadConfig,
    resolveGatewayPort: vi.fn(() => 18_789),
  };
});

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
  buildGatewayConnectionDetails: ({ url }: { url?: string }) => {
    if (typeof url === "string" && url.trim().length > 0) {
      return {
        url: url.trim(),
        urlSource: "cli --url",
      };
    }
    return {
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
    };
  },
}));

vi.mock("../gateway/client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: (params: unknown) =>
    mockState.resolveGatewayClientBootstrap(params),
}));

vi.mock("../gateway/client.js", () => ({
  GatewayClient: MockGatewayClient,
}));

vi.mock("../gateway/client-start-readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: vi.fn(async (client: MockGatewayClient) => {
    client.start();
    return {
      ready: true,
      elapsedMs: 0,
      maxDriftMs: 0,
      checks: 2,
      aborted: false,
    };
  }),
}));

vi.mock("../infra/is-main.js", () => ({
  isMainModule: () => false,
}));

vi.mock("../logging/console.js", () => ({
  routeLogsToStderr: () => mockState.routeLogsToStderr(),
}));

vi.mock("../infra/net/proxy/proxy-lifecycle.js", () => ({
  startProxy: (config: unknown) => mockState.startProxy(config),
  stopProxy: (handle: unknown) => mockState.stopProxy(handle),
}));

vi.mock("./translator.js", () => ({
  AcpGatewayAgent: class {
    start(): void {
      mockState.agentStart();
    }

    handleGatewayReconnect(): void {}

    handleGatewayDisconnect(): void {}

    async handleGatewayEvent(): Promise<void> {}
  },
}));

describe("serveAcpGateway startup", () => {
  let serveAcpGateway: typeof import("./server.js").serveAcpGateway;

  function getMockGateway() {
    const gateway = mockState.gateways[0];
    if (!gateway) {
      throw new Error("Expected mocked gateway instance");
    }
    return gateway;
  }

  function getGatewayBootstrapParams(): { env?: unknown; gatewayUrl?: unknown } {
    const firstCall = mockState.resolveGatewayClientBootstrap.mock.calls[0];
    if (!firstCall) {
      throw new Error("Expected gateway bootstrap resolution call");
    }
    const params = firstCall[0];
    if (!params || typeof params !== "object") {
      throw new Error("Expected gateway bootstrap params");
    }
    return params;
  }

  function captureProcessSignalHandlers() {
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const onceSpy = vi.spyOn(process, "once").mockImplementation(((
      signal: NodeJS.Signals,
      handler: () => void,
    ) => {
      signalHandlers.set(signal, handler);
      return process;
    }) as typeof process.once);
    return { signalHandlers, onceSpy };
  }

  async function emitHelloAndWaitForAgentSideConnection() {
    await vi.waitFor(() => {
      expect(mockState.gateways).toHaveLength(1);
    });
    const gateway = getMockGateway();
    gateway.emitHello();
    await vi.waitFor(() => {
      expect(mockState.agentSideConnectionCtor).toHaveBeenCalledTimes(1);
    });
  }

  function getCapturedAcpStream(): MockAcpStream {
    const stream = mockState.agentSideConnectionCtor.mock.calls[0]?.[1];
    if (
      !stream ||
      typeof stream !== "object" ||
      !(stream as MockAcpStream).readable ||
      !(stream as MockAcpStream).writable
    ) {
      throw new Error("Expected AgentSideConnection stream");
    }
    return stream as MockAcpStream;
  }

  async function readCapturedAcpMessages(): Promise<unknown[]> {
    const reader = getCapturedAcpStream().readable.getReader();
    const messages: unknown[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return messages;
        }
        messages.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  async function captureAcpMessagesAfterStartup(inputMessages: unknown[]): Promise<unknown[]> {
    mockState.acpInputMessages.push(...inputMessages);
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();
    const servePromise = serveAcpGateway({});

    try {
      await emitHelloAndWaitForAgentSideConnection();
      return await readCapturedAcpMessages();
    } finally {
      signalHandlers.get("SIGINT")?.();
      await servePromise;
      onceSpy.mockRestore();
    }
  }

  async function stopServeWithSigint(
    signalHandlers: Map<NodeJS.Signals, () => void>,
    servePromise: Promise<void>,
  ) {
    signalHandlers.get("SIGINT")?.();
    await servePromise;
  }

  beforeAll(async () => {
    ({ serveAcpGateway } = await import("./server.js"));
  });

  beforeEach(async () => {
    mockState.acpInputMessages.length = 0;
    mockState.gateways.length = 0;
    mockState.gatewayAuth.length = 0;
    mockState.gatewayOptions.length = 0;
    mockState.gatewayConstructorError = null;
    mockState.gatewayStopAndWait.mockReset();
    mockState.agentSideConnectionCtor.mockReset();
    mockState.agentStart.mockReset();
    mockState.routeLogsToStderr.mockReset();
    mockState.startProxy.mockReset();
    mockState.stopProxy.mockReset();
    mockState.startProxy.mockResolvedValue(null);
    mockState.stopProxy.mockResolvedValue(undefined);
    mockState.resolveGatewayClientBootstrap.mockReset();
    mockState.resolveGatewayClientBootstrap.mockResolvedValue({
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      auth: {
        token: undefined,
        password: undefined,
      },
    });
  });

  it("waits for gateway hello before creating AgentSideConnection", async () => {
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({});
      await Promise.resolve();

      expect(mockState.agentSideConnectionCtor).not.toHaveBeenCalled();
      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("subscribes the Gateway client to run-scoped tool events", async () => {
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({});
      await emitHelloAndWaitForAgentSideConnection();

      expect(mockState.gatewayOptions[0]?.caps).toEqual(["tool-events"]);

      await stopServeWithSigint(signalHandlers, servePromise);
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("routes logs to stderr before loading gateway config", async () => {
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({});
      await Promise.resolve();

      expect(mockState.routeLogsToStderr).toHaveBeenCalledTimes(1);
      expect(mockState.routeLogsToStderr.mock.invocationCallOrder[0]).toBeLessThan(
        mockState.resolveGatewayClientBootstrap.mock.invocationCallOrder[0] ??
          Number.MAX_SAFE_INTEGER,
      );

      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("rejects startup when gateway connect fails before hello", async () => {
    let resolveTunnelStop!: () => void;
    const sshTunnelStop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTunnelStop = resolve;
        }),
    );
    mockState.resolveGatewayClientBootstrap.mockResolvedValue({
      url: "ws://127.0.0.1:19091",
      urlSource: "config gateway.remote.url via ssh tunnel",
      auth: {
        token: undefined,
        password: undefined,
      },
      sshTunnel: { stop: sshTunnelStop },
    });
    const onceSpy = vi
      .spyOn(process, "once")
      .mockImplementation(
        ((_signal: NodeJS.Signals, _handler: () => void) => process) as typeof process.once,
      );

    try {
      let settled = false;
      const servePromise = serveAcpGateway({}).then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await Promise.resolve();

      const gateway = getMockGateway();
      gateway.emitConnectError("connect failed");
      await vi.waitFor(() => {
        expect(mockState.gatewayStopAndWait).toHaveBeenCalledTimes(1);
      });
      expect(sshTunnelStop).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);

      resolveTunnelStop();
      const error = await servePromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("connect failed");
      expect(mockState.agentSideConnectionCtor).not.toHaveBeenCalled();
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("passes resolved SecretInput gateway credentials to the ACP gateway client", async () => {
    mockState.resolveGatewayClientBootstrap.mockResolvedValue({
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      auth: {
        token: undefined,
        password: "resolved-secret-password", // pragma: allowlist secret
      },
    });
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({});
      await Promise.resolve();

      const bootstrapParams = getGatewayBootstrapParams();
      expect(bootstrapParams.env).toBe(process.env);
      expect(mockState.gatewayAuth[0]).toEqual({
        token: undefined,
        password: "resolved-secret-password", // pragma: allowlist secret
      });

      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("passes CLI URL override context into shared gateway auth resolution", async () => {
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({
        gatewayUrl: "wss://override.example/ws",
      });
      await Promise.resolve();

      const bootstrapParams = getGatewayBootstrapParams();
      expect(bootstrapParams.env).toBe(process.env);
      expect(bootstrapParams.gatewayUrl).toBe("wss://override.example/ws");

      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("passes the configured Gateway URL into the ACP gateway client", async () => {
    mockState.resolveGatewayClientBootstrap.mockResolvedValue({
      url: "ws://127.0.0.1:19999",
      urlSource: "cli --url",
      auth: {
        token: undefined,
        password: undefined,
      },
    });
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({
        gatewayUrl: "ws://127.0.0.1:19999",
      });
      await Promise.resolve();

      expect(mockState.gatewayOptions[0]?.url).toBe("ws://127.0.0.1:19999");

      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("stops bootstrap SSH tunnel during ACP shutdown", async () => {
    const sshTunnelStop = vi.fn(async () => undefined);
    mockState.resolveGatewayClientBootstrap.mockResolvedValue({
      url: "ws://127.0.0.1:19091",
      urlSource: "config gateway.remote.url via ssh tunnel",
      auth: {
        token: undefined,
        password: undefined,
      },
      sshTunnel: { stop: sshTunnelStop },
    });
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({});
      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);

      expect(sshTunnelStop).toHaveBeenCalledTimes(1);
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("stops bootstrap SSH tunnel when ACP GatewayClient construction fails", async () => {
    const sshTunnelStop = vi.fn(async () => undefined);
    mockState.gatewayConstructorError = new Error("device identity unavailable");
    mockState.resolveGatewayClientBootstrap.mockResolvedValue({
      url: "ws://127.0.0.1:19091",
      urlSource: "config gateway.remote.url via ssh tunnel",
      auth: {
        token: undefined,
        password: undefined,
      },
      sshTunnel: { stop: sshTunnelStop },
    });
    const onceSpy = vi
      .spyOn(process, "once")
      .mockImplementation(
        ((_signal: NodeJS.Signals, _handler: () => void) => process) as typeof process.once,
      );

    try {
      await expect(serveAcpGateway({})).rejects.toThrow("device identity unavailable");

      expect(mockState.gateways).toHaveLength(0);
      expect(sshTunnelStop).toHaveBeenCalledTimes(1);
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("does not proxy the standalone ACP control-plane Gateway connection", async () => {
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({});
      await vi.waitFor(() => {
        expect(mockState.gateways).toHaveLength(1);
      });

      expect(mockState.startProxy).not.toHaveBeenCalled();
      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);
      expect(mockState.stopProxy).not.toHaveBeenCalled();
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("coerces MCP date-string initialize protocol versions", async () => {
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        clientCapabilities: {},
      },
    };

    await expect(captureAcpMessagesAfterStartup([initializeRequest])).resolves.toEqual([
      {
        ...initializeRequest,
        params: {
          ...initializeRequest.params,
          protocolVersion: mockState.acpProtocolVersion,
        },
      },
    ]);
  });

  it("coerces non-integer numeric initialize protocol versions", async () => {
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1.5,
        clientCapabilities: {},
      },
    };

    await expect(captureAcpMessagesAfterStartup([initializeRequest])).resolves.toEqual([
      {
        ...initializeRequest,
        params: {
          ...initializeRequest.params,
          protocolVersion: mockState.acpProtocolVersion,
        },
      },
    ]);
  });

  it("passes uint16 numeric initialize protocol versions through unchanged", async () => {
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 42,
        clientCapabilities: {},
      },
    };

    const [message] = await captureAcpMessagesAfterStartup([initializeRequest]);
    expect(message).toBe(initializeRequest);
  });

  it("passes non-initialize JSON-RPC messages through unchanged", async () => {
    const sessionRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: {
        protocolVersion: "2025-11-25",
        cwd: "/tmp/openclaw",
      },
    };

    const [message] = await captureAcpMessagesAfterStartup([sessionRequest]);
    expect(message).toBe(sessionRequest);
  });
});
