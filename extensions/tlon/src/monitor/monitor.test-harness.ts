import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, vi } from "vitest";

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
    onChange: vi.fn().mockReturnValue(() => {}),
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
  createChannelInboundEnvelopeBuilder: createChannelInboundEnvelopeBuilderMock,
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

export function useTlonMonitorFixture() {
  beforeEach(() => {
    const ingress = createPluginRuntimeMock().channel.inbound.ingress;
    inboundRuntimeMock.resolveStable
      .mockReset()
      .mockImplementation((params) => ingress.resolveStable(params));
    createChannelInboundEnvelopeBuilderMock.mockReturnValue(buildChannelInboundEnvelopeMock);
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
