import { EventEmitter } from "node:events";
import { DisconnectReason } from "baileys";
import { vi } from "vitest";
import { createAcceptedWhatsAppSendResult } from "./inbound/send-result.test-helper.js";

const runtimeContextMocks = vi.hoisted(() => ({
  channelRuntime: { runtimeContexts: {} },
  register: vi.fn(),
}));

const connectionOwnerMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
}));

export function getConnectionControllerMocks() {
  return { runtimeContextMocks, connectionOwnerMocks };
}

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  return {
    ...actual,
    createWaSocket: vi.fn(),
    waitForWaConnection: vi.fn(),
    readWebAuthExistsForDecision: vi.fn(async () => ({
      outcome: "stable" as const,
      exists: true,
    })),
    waitForCredsSaveQueueWithTimeout: vi.fn(async () => "drained" as const),
  };
});

vi.mock("./auth-store.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-store.js")>("./auth-store.js");
  return {
    ...actual,
    prepareWebAuthForLogin: vi.fn(async () => "cleared" as const),
  };
});

vi.mock("openclaw/plugin-sdk/channel-runtime-context", () => ({
  getChannelRuntimeContext: vi.fn(),
  registerChannelRuntimeContext: runtimeContextMocks.register,
}));

vi.mock("./runtime.js", () => ({
  getWhatsAppChannelRuntime: () => runtimeContextMocks.channelRuntime,
}));

vi.mock("./connection-owner.js", () => ({
  acquireWhatsAppGatewayConnectionOwner: connectionOwnerMocks.acquire,
}));

export async function loadConnectionControllerTestModules() {
  const session = await import("./session.js");
  const authStore = await import("./auth-store.js");
  const controller = await import("./connection-controller.js");
  const login = await import("./login-result.js");
  return {
    session,
    authStore,
    controller,
    login,
    createWaSocketMock: vi.mocked(session.createWaSocket),
    waitForWaConnectionMock: vi.mocked(session.waitForWaConnection),
    prepareWebAuthForLoginMock: vi.mocked(authStore.prepareWebAuthForLogin),
    readWebAuthExistsForDecisionMock: vi.mocked(session.readWebAuthExistsForDecision),
    waitForCredsSaveQueueWithTimeoutMock: vi.mocked(session.waitForCredsSaveQueueWithTimeout),
  };
}

export type ControllerTestModules = Awaited<ReturnType<typeof loadConnectionControllerTestModules>>;

export function resetConnectionControllerTestMocks(modules: ControllerTestModules): void {
  vi.clearAllMocks();
  runtimeContextMocks.register.mockReturnValue({ dispose: vi.fn() });
  connectionOwnerMocks.acquire.mockResolvedValue({ release: connectionOwnerMocks.release });
  connectionOwnerMocks.release.mockResolvedValue(undefined);
  modules.prepareWebAuthForLoginMock.mockReset().mockResolvedValue("cleared");
  modules.readWebAuthExistsForDecisionMock
    .mockReset()
    .mockResolvedValue({ outcome: "stable", exists: true });
  modules.waitForCredsSaveQueueWithTimeoutMock.mockReset().mockResolvedValue("drained");
}

export function createListenerStub(messageId = "ok") {
  return {
    sendMessage: vi.fn(async () => createAcceptedWhatsAppSendResult("text", messageId)),
    sendPoll: vi.fn(async () => createAcceptedWhatsAppSendResult("poll", messageId)),
    sendReaction: vi.fn(async () => createAcceptedWhatsAppSendResult("reaction", messageId)),
    sendComposingTo: vi.fn(async () => {}),
  };
}

export function createSocketWithTransportEmitter() {
  let closed = false;
  const ws = new EventEmitter() as EventEmitter & {
    close: ReturnType<typeof vi.fn>;
    readonly isClosed: boolean;
  };
  Object.defineProperty(ws, "isClosed", { get: () => closed });
  ws.close = vi.fn(async () => {
    closed = true;
  });
  return {
    end: vi.fn(async (_error?: Error) => {
      closed = true;
    }),
    ws,
  };
}

export const loginAuthDir = "/tmp/wa-auth";

export function loggedOutError() {
  return { output: { statusCode: DisconnectReason.loggedOut } };
}

export function createLoginResultHarness(
  waitForWhatsAppLoginResult: ControllerTestModules["login"]["waitForWhatsAppLoginResult"],
) {
  const initialSock = createSocketWithTransportEmitter();
  const replacementSock = createSocketWithTransportEmitter();
  const runtime = { log: vi.fn() } as never;

  return {
    initialSock,
    replacementSock,
    runtime,
    run: (opts: {
      waitForConnection: ReturnType<typeof vi.fn>;
      createSocket: ReturnType<typeof vi.fn>;
      verbose?: boolean;
      socketTiming?: {
        connectTimeoutMs: number;
        defaultQueryTimeoutMs: number;
        keepAliveIntervalMs: number;
      };
      onQr?: (qr: string) => void;
      onSocketReplaced?: (sock: unknown) => void;
    }) =>
      waitForWhatsAppLoginResult({
        sock: initialSock as never,
        authDir: loginAuthDir,
        isLegacyAuthDir: false,
        verbose: opts.verbose ?? false,
        runtime,
        waitForConnection: opts.waitForConnection as never,
        createSocket: opts.createSocket as never,
        ...(opts.socketTiming ? { socketTiming: opts.socketTiming } : {}),
        ...(opts.onQr ? { onQr: opts.onQr } : {}),
        ...(opts.onSocketReplaced ? { onSocketReplaced: opts.onSocketReplaced } : {}),
      }),
  };
}

type ControllerConstructor = ControllerTestModules["controller"]["WhatsAppConnectionController"];
type ControllerOptions = ConstructorParameters<ControllerConstructor>[0];

export function createTestController(
  Controller: ControllerConstructor,
  overrides: Partial<ControllerOptions> = {},
) {
  const reconnectPolicy = {
    initialMs: 250,
    maxMs: 1_000,
    factor: 2,
    jitter: 0,
    maxAttempts: 5,
  };
  return new Controller({
    accountId: "work",
    authDir: "/tmp/wa-auth",
    verbose: false,
    keepAlive: false,
    heartbeatSeconds: 30,
    transportTimeoutMs: 60_000,
    messageTimeoutMs: 60_000,
    watchdogCheckMs: 5_000,
    ...overrides,
    reconnectPolicy: {
      ...reconnectPolicy,
      ...overrides.reconnectPolicy,
    },
  });
}
