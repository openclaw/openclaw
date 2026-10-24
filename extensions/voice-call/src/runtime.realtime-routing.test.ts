import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createVoiceCallStateRuntimeForTests } from "./manager.test-harness.js";
import { MockProvider } from "./providers/mock.js";
import { createVoiceCallRuntime, type VoiceCallRuntime } from "./runtime.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "./websocket-test-support.js";

const mocks = vi.hoisted(() => ({
  resolveConfiguredRealtimeVoiceProviderAsync: vi.fn(),
}));

vi.mock("./realtime-voice.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./realtime-voice.runtime.js")>();
  return {
    ...actual,
    resolveConfiguredRealtimeVoiceProviderAsync: mocks.resolveConfiguredRealtimeVoiceProviderAsync,
  };
});

function createOwner(agentId: string, id: string, model: string) {
  const connected = createDeferred<void>();
  const connect = vi.fn(async () => connected.resolve());
  const requests: RealtimeVoiceBridgeCreateRequest[] = [];
  const provider: RealtimeVoiceProviderPlugin = {
    id,
    label: id,
    isConfigured: () => true,
    createBridge: vi.fn((request): RealtimeVoiceBridge => {
      requests.push(request);
      return {
        connect,
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        isConnected: () => true,
        triggerGreeting: vi.fn(),
      };
    }),
  };
  return {
    agentId,
    provider,
    providerConfig: { credentialOwner: agentId, model },
    connected,
    connect,
    requests,
  };
}

// A timed-out callback can still be closing its runtime when Vitest enters afterEach.
let fixtureCleanup: Promise<void> | undefined;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await fixtureCleanup;
    cleanup();
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReset();
    resetPluginStateStoreForTests();
  }),
);

describe("voice-call realtime route ownership", () => {
  it("selects provider readiness and bridge auth from each inbound number owner", async ({
    signal,
  }) => {
    const sockets: WebSocket[] = [];
    const servers: Array<Awaited<ReturnType<typeof startUpgradeWsServer>>> = [];
    let runtime: VoiceCallRuntime | undefined;
    const sales = createOwner("sales", "openai", "gpt-realtime");
    const support = createOwner("support", "xai", "grok-voice");
    const owners = [sales, support];
    const registrations = new Map(owners.map((owner) => [owner.agentId, owner]));
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockImplementation(
      ({ agentId }: { agentId?: string }) => {
        const registration = agentId ? registrations.get(agentId) : undefined;
        if (!registration) {
          throw new Error(`No simulated realtime credentials for ${agentId ?? "unknown"}`);
        }
        return registration;
      },
    );

    const stopWaiting = () => {
      for (const owner of owners) {
        owner.connected.resolve();
      }
    };
    signal.addEventListener("abort", stopWaiting, { once: true });
    const cleanupFinished = createDeferred<void>();
    fixtureCleanup = cleanupFinished.promise;
    try {
      const config = createVoiceCallBaseConfig();
      config.agentId = "main";
      config.store = tempDirs.make("openclaw-voice-routing-");
      config.inboundPolicy = "open";
      config.maxConcurrentCalls = 2;
      config.staleCallReaperSeconds = 0;
      config.serve = { ...config.serve, port: 0 };
      config.realtime.enabled = true;
      config.numbers = {
        "+15550001001": { agentId: "sales" },
        "+15550001002": { agentId: "support" },
      };
      const fullConfig = {
        agents: {
          entries: { main: {}, sales: {}, support: {} },
        },
      } as OpenClawConfig;

      runtime = await createVoiceCallRuntime({
        scheduler: createTestPluginServiceScheduler(),
        config,
        coreConfig: fullConfig,
        agentRuntime: {} as never,
        stateRuntime: createVoiceCallStateRuntimeForTests(),
      });
      expect(mocks.resolveConfiguredRealtimeVoiceProviderAsync).not.toHaveBeenCalled();

      const handler = runtime.webhookServer.getRealtimeHandler();
      if (!handler) {
        throw new Error("expected realtime handler");
      }
      const routes = [
        { to: "+15550001001", callSid: "CA-sales", streamSid: "MZ-sales" },
        { to: "+15550001002", callSid: "CA-support", streamSid: "MZ-support" },
      ];
      for (const { to, ...start } of routes) {
        const { streamUrl } = handler.issueStreamSession({
          providerName: "twilio",
          direction: "inbound",
          from: "+15550009999",
          to,
        });
        const server = await startUpgradeWsServer({
          urlPath: new URL(streamUrl).pathname,
          onUpgrade: handler.handleWebSocketUpgrade.bind(handler),
        });
        servers.push(server);
        const ws = await connectWs(server.url);
        sockets.push(ws);
        ws.send(JSON.stringify({ event: "start", start }));
      }

      signal.throwIfAborted();
      await Promise.all(owners.map((owner) => owner.connected.promise));
      signal.throwIfAborted();
      for (const { provider, connect, agentId, providerConfig } of owners) {
        expect(provider.createBridge).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ agentId, providerConfig }),
        );
        expect(connect).toHaveBeenCalledOnce();
      }
      expect(
        mocks.resolveConfiguredRealtimeVoiceProviderAsync.mock.calls.map(
          ([options]) => (options as { agentId?: string }).agentId,
        ),
      ).toEqual(["sales", "support"]);

      const hangupCall = vi.spyOn(MockProvider.prototype, "hangupCall");
      onTestFinished(() => hangupCall.mockRestore());
      const closed = Promise.all(sockets.map((ws) => waitForClose(ws)));
      sales.requests[0]?.onClose?.("completed");
      sockets[1]?.close(1000);
      await closed;
      await vi.waitFor(() => expect(runtime?.manager.getActiveCalls()).toHaveLength(0), {
        timeout: 3_000,
      });
      expect(hangupCall).toHaveBeenCalledTimes(2);
      const history = await runtime.manager.getCallHistory();
      for (const [providerCallId, reason] of [
        ["CA-sales", "completed"],
        ["CA-support", "hangup-bot"],
      ]) {
        expect(hangupCall).toHaveBeenCalledWith(
          expect.objectContaining({ providerCallId, reason }),
        );
        expect(history).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ providerCallId, endReason: reason, state: reason }),
          ]),
        );
      }
    } finally {
      signal.removeEventListener("abort", stopWaiting);
      try {
        await runtime?.stop();
      } finally {
        try {
          for (const ws of sockets) {
            if (ws.readyState !== WebSocket.CLOSED) {
              const closed = waitForClose(ws);
              ws.terminate();
              await closed;
            }
          }
          await Promise.all(servers.map((server) => server.close()));
        } finally {
          cleanupFinished.resolve();
        }
      }
    }
  });
});
