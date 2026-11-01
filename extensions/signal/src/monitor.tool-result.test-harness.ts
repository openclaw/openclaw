import path from "node:path";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { MockFn } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, vi } from "vitest";
import type { SignalDaemonHandle } from "./daemon.js";
import type { MonitorSignalOpts } from "./monitor.js";
import { setSignalRuntime } from "./runtime.js";
import { clearSignalRuntimeForTest } from "./runtime.test-support.js";
import type { SignalIngressMonitor } from "./signal-ingress.js";

type SignalDaemonExitEvent = Awaited<SignalDaemonHandle["exited"]>;

type SignalToolResultMocks = {
  waitForTransportReadyMock: MockFn;
  enqueueSystemEventMock: MockFn;
  sendMock: MockFn;
  replyMock: MockFn;
  updateLastRouteMock: MockFn;
  readAllowFromStoreMock: MockFn;
  upsertPairingRequestMock: MockFn;
  streamMock: MockFn;
  signalCheckMock: MockFn;
  signalRpcRequestMock: MockFn;
  assertSignalDaemonEndpointAvailableMock: MockFn;
  spawnSignalDaemonMock: MockFn;
};
const signalToolResultMocks: SignalToolResultMocks = vi.hoisted(() => ({
  waitForTransportReadyMock: vi.fn(),
  enqueueSystemEventMock: vi.fn(),
  sendMock: vi.fn(),
  replyMock: vi.fn(),
  updateLastRouteMock: vi.fn(),
  readAllowFromStoreMock: vi.fn(),
  upsertPairingRequestMock: vi.fn(),
  streamMock: vi.fn(),
  signalCheckMock: vi.fn(),
  signalRpcRequestMock: vi.fn(),
  assertSignalDaemonEndpointAvailableMock: vi.fn(),
  spawnSignalDaemonMock: vi.fn(),
}));
export { signalToolResultMocks };
const {
  waitForTransportReadyMock,
  enqueueSystemEventMock,
  sendMock,
  replyMock,
  updateLastRouteMock,
  readAllowFromStoreMock,
  upsertPairingRequestMock,
  streamMock,
  signalCheckMock,
  signalRpcRequestMock,
  assertSignalDaemonEndpointAvailableMock,
  spawnSignalDaemonMock,
} = signalToolResultMocks;
const signalToolResultSessionStore = vi.hoisted(() => ({ path: "" }));
const signalToolResultIngressMonitor = vi.hoisted(() => ({
  current: undefined as SignalIngressMonitor | undefined,
}));
let signalToolResultState: OpenClawTestState | undefined;
let signalToolResultIngressQueue: ReturnType<typeof createChannelIngressQueueForTests> | undefined;

function toSignalToolResultTestError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage, { cause: value });
}

export async function waitForSignalToolResultIngressDispatchIdle() {
  const monitor = signalToolResultIngressMonitor.current;
  if (!monitor) {
    throw new Error("Signal tool-result ingress monitor is not initialized");
  }
  await monitor.waitForIdle();
}

async function waitForSignalToolResultIngressIdle() {
  const queue = signalToolResultIngressQueue;
  if (!queue) {
    throw new Error("Signal tool-result ingress monitor is not initialized");
  }
  await waitForSignalToolResultIngressDispatchIdle();
  // Canonical idle owns active delivery synchronization. Deferred debounce claims
  // settle later at turn adoption, so retain a bounded queue drain assertion.
  await vi.waitFor(
    async () => {
      const pending = await queue.listPending({ limit: "all" });
      const claims = await queue.listClaims();
      if (pending.length > 0 || claims.length > 0) {
        throw new Error(
          `Signal tool-result ingress still active: ${pending.length} pending, ${claims.length} claimed, ${replyMock.mock.calls.length} replies, ${sendMock.mock.calls.length} sends`,
        );
      }
    },
    { interval: 10, timeout: 5_000 },
  );
}

export async function receiveSignalPayloads(params: {
  payloads: unknown[];
  opts?: Partial<MonitorSignalOpts>;
}) {
  const abortController = new AbortController();
  let ingressError: Error | undefined;
  streamMock.mockImplementation(async ({ onEvent }) => {
    try {
      for (const payload of params.payloads) {
        await onEvent({
          event: "receive",
          data: JSON.stringify(payload),
        });
      }
      await waitForSignalToolResultIngressIdle();
    } catch (error) {
      ingressError = toSignalToolResultTestError(error, "Signal ingress delivery failed");
    } finally {
      abortController.abort();
    }
  });

  const { monitorSignalProvider } = await import("./monitor.js");
  await monitorSignalProvider({
    autoStart: false,
    baseUrl: "http://127.0.0.1:8080",
    abortSignal: abortController.signal,
    ...params.opts,
  });
  if (ingressError) {
    throw ingressError;
  }
}

let config: Record<string, unknown> = {};

export function configureSignalToolResultTest(
  overrides: Record<string, unknown> = {},
  messages?: Record<string, unknown>,
) {
  const base = config as { channels?: Record<string, unknown> };
  const channels = base.channels ?? {};
  const signal = (channels.signal ?? {}) as Record<string, unknown>;
  const { autoStart, httpPort, ...accountOverrides } = overrides;
  const transport =
    autoStart === false
      ? { kind: "external-native", url: "http://127.0.0.1:8080" }
      : {
          kind: "managed-native",
          ...(typeof httpPort === "number" ? { httpPort } : {}),
        };
  config = {
    ...base,
    ...(messages ? { messages } : {}),
    channels: {
      ...channels,
      signal: {
        ...signal,
        transport,
        dmPolicy: "open",
        allowFrom: ["*"],
        ...accountOverrides,
      },
    },
  };
}

export function createMockSignalDaemonHandle(
  overrides: Partial<SignalDaemonHandle> = {},
): SignalDaemonHandle {
  return {
    stop: vi.fn(),
    exited: new Promise<SignalDaemonExitEvent>(() => {}),
    ...overrides,
  };
}

// Use importActual so shared-worker mocks from earlier test files do not leak
// into this harness's partial overrides.
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => ({
  ...(await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>(
    "openclaw/plugin-sdk/runtime-config-snapshot",
  )),
  captureRuntimeConfigAsyncReader: () => async () => config,
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => ({
  ...(await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  )),
  resolveStorePath: vi.fn(() => signalToolResultSessionStore.path),
  updateLastRoute: updateLastRouteMock,
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    resolveInboundSessionEnvelopeContextAsync: vi.fn(
      async ({ cfg }: Parameters<typeof actual.resolveInboundSessionEnvelopeContextAsync>[0]) => ({
        storePath: signalToolResultSessionStore.path,
        envelopeOptions: actual.resolveEnvelopeFormatOptions(cfg),
        previousTimestamp: undefined,
      }),
    ),
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) => {
      const resolveTurn = params.adapter.resolveTurn;
      return await actual.runChannelInboundEvent({
        ...params,
        adapter: {
          ...params.adapter,
          resolveTurn: async (...args: Parameters<typeof resolveTurn>) => {
            const resolved = await resolveTurn(...args);
            if ("runDispatch" in resolved) {
              return resolved;
            }
            return {
              ...resolved,
              replyResolver: async (...replyArgs: unknown[]) => {
                await resolved.replyOptions?.turnAdoptionLifecycle?.onAdopted();
                return await replyMock(...replyArgs);
              },
            } as typeof resolved;
          },
        },
      });
    },
  };
});

vi.mock("./send.js", async () => ({
  ...(await vi.importActual<typeof import("./send.js")>("./send.js")),
  sendMessageSignal: sendMock,
  sendTypingSignal: vi.fn().mockResolvedValue(true),
  sendReadReceiptSignal: vi.fn().mockResolvedValue(true),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => ({
  ...(await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  )),
  readChannelAllowFromStore: readAllowFromStoreMock,
  upsertChannelPairingRequest: upsertPairingRequestMock,
}));

vi.mock("openclaw/plugin-sdk/security-runtime", async () => ({
  ...(await vi.importActual<typeof import("openclaw/plugin-sdk/security-runtime")>(
    "openclaw/plugin-sdk/security-runtime",
  )),
  readStoreAllowFromForDmPolicy: readAllowFromStoreMock,
}));

vi.mock("./client.js", async () => ({
  ...(await vi.importActual<typeof import("./client.js")>("./client.js")),
  streamSignalEvents: streamMock,
  signalCheck: signalCheckMock,
  signalRpcRequest: signalRpcRequestMock,
}));

// mock-isolation: Exercise ingress settlement without opening a daemon transport.
vi.mock("./client-adapter.js", () => ({
  streamSignalEvents: streamMock,
  signalCheck: signalCheckMock,
  signalRpcRequest: signalRpcRequestMock,
}));

vi.mock("./daemon.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./daemon.js")>();
  return {
    ...actual,
    assertSignalDaemonEndpointAvailable: assertSignalDaemonEndpointAvailableMock,
    spawnSignalDaemon: spawnSignalDaemonMock,
  };
});

vi.mock("openclaw/plugin-sdk/system-event-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/system-event-runtime")>(
    "openclaw/plugin-sdk/system-event-runtime",
  );
  return {
    ...actual,
    enqueueSystemEvent: (...args: Parameters<typeof actual.enqueueSystemEvent>) => {
      enqueueSystemEventMock(...args);
      return actual.enqueueSystemEvent(...args);
    },
  };
});

// mock-isolation: Drive readiness explicitly without polling a live daemon.
vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("./signal-ingress.js", async () => {
  const actual = await vi.importActual<typeof import("./signal-ingress.js")>("./signal-ingress.js");
  return {
    ...actual,
    startSignalIngressMonitor: async (
      ...args: Parameters<typeof actual.startSignalIngressMonitor>
    ) => {
      const monitor = await actual.startSignalIngressMonitor(...args);
      signalToolResultIngressMonitor.current = monitor;
      return monitor;
    },
  };
});

export function installSignalToolResultTestHooks() {
  beforeEach(async () => {
    const [{ resetInboundDedupe }, { resetSystemEventsForTest }] = await Promise.all([
      import("openclaw/plugin-sdk/reply-runtime"),
      import("openclaw/plugin-sdk/test-fixtures"),
    ]);
    resetInboundDedupe();
    signalToolResultState = await createOpenClawTestState({
      prefix: "openclaw-signal-tool-result-state-",
      layout: "state-only",
    });
    const stateDir = signalToolResultState.stateDir;
    signalToolResultSessionStore.path = path.join(stateDir, "sessions.json");
    signalToolResultIngressMonitor.current = undefined;
    signalToolResultIngressQueue = undefined;
    setSignalRuntime({
      channel: createPluginRuntimeMock().channel,
      logging: {
        getChildLogger: () => ({
          debug: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        }),
      },
      state: {
        resolveStateDir: () => stateDir,
        openKeyedStore: () => {
          throw new Error("keyed store is not configured in Signal monitor tests");
        },
        openChannelIngressQueue: (
          options?: Omit<Parameters<typeof createChannelIngressQueueForTests>[0], "channelId">,
        ) => {
          const queue = createChannelIngressQueueForTests({
            ...options,
            channelId: "signal",
            stateDir: options?.stateDir ?? stateDir,
          });
          signalToolResultIngressQueue = queue;
          return queue;
        },
      },
    } as unknown as PluginRuntime);
    config = {
      // Mocked final replies exercise transport behavior independently of harness defaults.
      messages: { responsePrefix: "PFX", visibleReplies: "automatic" },
      session: { store: signalToolResultSessionStore.path },
      channels: {
        signal: {
          transport: { kind: "external-native", url: "http://127.0.0.1:8080" },
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    };

    for (const mock of Object.values(signalToolResultMocks)) {
      mock.mockReset();
    }
    sendMock.mockResolvedValue(undefined);
    signalCheckMock.mockResolvedValue({ ok: true });
    signalRpcRequestMock.mockResolvedValue({});
    assertSignalDaemonEndpointAvailableMock.mockResolvedValue(undefined);
    spawnSignalDaemonMock.mockReturnValue(createMockSignalDaemonHandle());
    readAllowFromStoreMock.mockResolvedValue([]);
    upsertPairingRequestMock.mockResolvedValue({ code: "PAIRCODE", created: true });
    waitForTransportReadyMock.mockResolvedValue(undefined);

    resetSystemEventsForTest();
  });

  afterEach(async () => {
    await signalToolResultIngressMonitor.current?.stop();
    clearSignalRuntimeForTest();
    signalToolResultIngressMonitor.current = undefined;
    signalToolResultIngressQueue = undefined;
    await signalToolResultState?.cleanup();
    signalToolResultState = undefined;
    signalToolResultSessionStore.path = "";
  });
}
