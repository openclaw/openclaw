import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { afterEach, beforeEach, expect, vi } from "vitest";

const {
  authenticateMock,
  buildChannelInboundEnvelopeMock,
  builtInboundContextPayload,
  createChannelInboundEnvelopeBuilderMock,
  formatInboundMediaUnavailableTextMock,
  sleepWithAbortMock,
  saveRemoteMediaMock,
  sseClientMock,
  ingressMock,
  inboundRuntimeMock,
  settingsManagerMock,
  realUrbitFixture,
} = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  buildChannelInboundEnvelopeMock: vi.fn(),
  builtInboundContextPayload: { kind: "tlon-inbound-context" },
  createChannelInboundEnvelopeBuilderMock: vi.fn(),
  formatInboundMediaUnavailableTextMock: vi.fn(),
  sleepWithAbortMock: vi.fn(),
  saveRemoteMediaMock: vi.fn(),
  sseClientMock: {
    scry: vi.fn().mockResolvedValue({}),
    subscribe: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    stopReceiving: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    poke: vi.fn().mockResolvedValue(undefined),
  },
  ingressMock: {
    receive: vi.fn().mockResolvedValue({ kind: "accepted" }),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  },
  inboundRuntimeMock: {
    resolveStable:
      vi.fn<
        ReturnType<typeof createPluginRuntimeMock>["channel"]["inbound"]["ingress"]["resolveStable"]
      >(),
    buildContext: vi.fn(),
    dispatch: vi.fn().mockResolvedValue(undefined),
    resolveAgentRoute: vi.fn(() => ({
      accountId: "default",
      agentId: "main",
      dmScope: "main",
      sessionKey: "agent:main:main",
    })),
    resolveEffectiveMessagesConfig: vi.fn((_cfg: OpenClawConfig, _agentId: string) => ({
      responsePrefix: undefined as string | undefined,
    })),
    shouldComputeCommandAuthorized: vi.fn(() => false),
  },
  settingsManagerMock: {
    load: vi.fn().mockResolvedValue({}),
    startSubscription: vi.fn().mockResolvedValue(undefined),
  },
  realUrbitFixture: {
    config: undefined as OpenClawConfig | undefined,
    enabled: false,
    url: "https://urbit.example.com",
    client: null as {
      stopReceiving: () => void;
      close: () => Promise<void>;
    } | null,
  },
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveHumanDelayConfig: vi.fn(() => undefined),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  createChannelInboundEnvelopeBuilderAsync: createChannelInboundEnvelopeBuilderMock,
  formatInboundMediaUnavailableText: formatInboundMediaUnavailableTextMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  sleepWithAbort: sleepWithAbortMock,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  MAX_IMAGE_BYTES: 6 * 1024 * 1024,
  readRemoteMediaBuffer: vi.fn(),
  saveRemoteMedia: saveRemoteMediaMock,
}));

vi.mock("../runtime.js", () => ({
  getTlonRuntime: () => ({
    config: {
      current: () =>
        realUrbitFixture.config ?? {
          channels: {
            tlon: {
              code: "code",
              ship: "~zod",
              url: realUrbitFixture.url,
              network: { dangerouslyAllowPrivateNetwork: true },
              ownerShip: "~nec",
              mediaMaxMb: 1 / 1024,
            },
          },
        },
    },
    logging: {
      getChildLogger: () => ({}),
    },
    channel: {
      commands: {
        shouldComputeCommandAuthorized: inboundRuntimeMock.shouldComputeCommandAuthorized,
      },
      inbound: {
        ingress: {
          ...createPluginRuntimeMock().channel.inbound.ingress,
          resolveStable: inboundRuntimeMock.resolveStable,
        },
        buildContext: inboundRuntimeMock.buildContext,
        dispatch: inboundRuntimeMock.dispatch,
      },
      reply: {
        resolveEffectiveMessagesConfig: inboundRuntimeMock.resolveEffectiveMessagesConfig,
      },
      routing: {
        resolveAgentRoute: inboundRuntimeMock.resolveAgentRoute,
      },
    },
  }),
}));

vi.mock("../urbit/auth.js", () => ({
  authenticate: authenticateMock,
}));

vi.mock("../urbit/sse-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../urbit/sse-client.js")>();
  return {
    ...actual,
    UrbitSSEClient: vi.fn(function (...args: ConstructorParameters<typeof actual.UrbitSSEClient>) {
      if (!realUrbitFixture.enabled) {
        return sseClientMock;
      }
      const client = new actual.UrbitSSEClient(...args);
      realUrbitFixture.client = client;
      return client;
    }),
  };
});

vi.mock("../settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../settings.js")>()),
  createSettingsManager: vi.fn(() => settingsManagerMock),
}));

vi.mock("./ingress.js", () => ({
  createTlonIngressMonitor: vi.fn(() => ingressMock),
}));

import { monitorTlonProvider } from "./index.js";

export function messageEssay(author: string, content: unknown, sent = 1_700_000_000_000) {
  return { author, content: typeof content === "string" ? [{ inline: [content] }] : content, sent };
}

function configureTlon(
  tlon: Record<string, unknown>,
  config: Omit<OpenClawConfig, "channels"> = {},
) {
  realUrbitFixture.config = {
    ...config,
    channels: { tlon: { code: "code", ship: "~zod", url: realUrbitFixture.url, ...tlon } },
  };
}

function startMonitor(
  options: Omit<Parameters<typeof monitorTlonProvider>[0], "scheduler" | "runtime"> & {
    controller?: AbortController;
  } = {},
) {
  const { controller = new AbortController(), ...monitorOptions } = options;
  const scheduler = createTestPluginServiceScheduler();
  const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
  const monitor = monitorTlonProvider({
    ...monitorOptions,
    scheduler,
    abortSignal: options.abortSignal
      ? AbortSignal.any([controller.signal, options.abortSignal])
      : controller.signal,
    runtime,
  });
  void monitor.catch(() => {});
  return {
    scheduler,
    runtime,
    monitor,
    stop: async () => {
      controller.abort();
      await monitor;
    },
  };
}

async function withMonitor(
  run: (runtime: RuntimeEnv) => Promise<void>,
  options: Parameters<typeof startMonitor>[0] & { waitForStart?: boolean } = {},
) {
  const { waitForStart, ...monitorOptions } = options;
  const started = Promise.withResolvers<void>();
  if (waitForStart) {
    ingressMock.start.mockImplementationOnce(() => started.resolve());
  }
  const { runtime, monitor, stop } = startMonitor(monitorOptions);
  try {
    if (waitForStart) {
      await Promise.race([started.promise, monitor]);
    } else {
      await vi.waitFor(() => expect(sseClientMock.connect).toHaveBeenCalledOnce());
    }
    await run(runtime);
  } finally {
    await stop();
  }
}

function getSubscription(app: string, path?: string) {
  const subscription = sseClientMock.subscribe.mock.calls
    .map(([value]) => value)
    .findLast((value) => value.app === app && (path === undefined || value.path === path));
  if (!subscription) {
    throw new Error(`expected ${app} ${path ?? ""} subscription`);
  }
  return subscription;
}

export function useTlonMonitorFixture() {
  beforeEach(() => {
    const ingress = createPluginRuntimeMock().channel.inbound.ingress;
    inboundRuntimeMock.resolveStable
      .mockReset()
      .mockImplementation((params) => ingress.resolveStable(params));
    createChannelInboundEnvelopeBuilderMock.mockResolvedValue(buildChannelInboundEnvelopeMock);
    buildChannelInboundEnvelopeMock.mockReturnValue("tlon-envelope");
    formatInboundMediaUnavailableTextMock.mockReturnValue("formatted-inbound-body");
    inboundRuntimeMock.buildContext.mockReset().mockReturnValue(builtInboundContextPayload);
    inboundRuntimeMock.dispatch.mockReset().mockResolvedValue(undefined);
    inboundRuntimeMock.resolveEffectiveMessagesConfig
      .mockReset()
      .mockReturnValue({ responsePrefix: undefined });
    ingressMock.receive.mockReset().mockResolvedValue({ kind: "accepted" });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
    const realClient = realUrbitFixture.client;
    if (realClient) {
      realClient.stopReceiving();
      await realClient.close().catch(() => undefined);
    }
    realUrbitFixture.enabled = false;
    realUrbitFixture.config = undefined;
    realUrbitFixture.url = "https://urbit.example.com";
    realUrbitFixture.client = null;
  });

  return {
    configureTlon,
    startMonitor,
    withMonitor,
    getSubscription,
    monitorTlonProvider,
    authenticateMock,
    buildChannelInboundEnvelopeMock,
    builtInboundContextPayload,
    formatInboundMediaUnavailableTextMock,
    sleepWithAbortMock,
    saveRemoteMediaMock,
    sseClientMock,
    ingressMock,
    inboundRuntimeMock,
    settingsManagerMock,
    realUrbitFixture,
  };
}
