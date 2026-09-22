import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createEmptyPluginRegistry,
  createPluginRuntimeMock,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { RealtimeVoicePlaybackItem } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "../../openai/api.js";
import { resolveFaceTimeConfig } from "../src/config.js";
import { startFaceTimeTalkDriver, type FaceTimeTalkDriver } from "../src/talk-driver.js";

const audio = vi.hoisted(() => ({
  suppressionReady: vi.fn(async () => {}),
  routeReady: vi.fn(async () => {}),
  processOutputSuppressed: vi.fn(() => true),
  writeOutputAudio: vi.fn(),
  getPlaybackState: vi.fn<() => RealtimeVoicePlaybackItem[]>(() => []),
  finishOutputAudio: vi.fn(),
  clearOutputAudio: vi.fn(),
  playedAudioFrames: vi.fn(() => 0),
  queuedAudioFrames: vi.fn(() => 0),
  suspendMedia: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}));
vi.mock("../src/audio-pump.js", () => ({ startFaceTimeAudioPump: () => audio }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const unexpectedProcess = () => {
    throw new Error("Native processes are forbidden in FaceTime provider tests");
  };
  return {
    ...actual,
    spawn: unexpectedProcess,
    spawnSync: unexpectedProcess,
    exec: unexpectedProcess,
    execSync: unexpectedProcess,
    execFile: unexpectedProcess,
    execFileSync: unexpectedProcess,
    fork: unexpectedProcess,
  };
});
vi.mock("openclaw/plugin-sdk/realtime-bootstrap-context", () => ({
  resolveRealtimeBootstrapContextInstructions: async () => undefined,
}));

const providerMocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } =
    await import("../../openai/realtime-voice-test-support.js");
  const state = createOpenAIRealtimeMockState();
  type MockSocket = InstanceType<typeof state.FakeWebSocket>;
  let onSocket: (socket: MockSocket) => void = () => {};
  class FaceTimeSocket extends state.FakeWebSocket {
    constructor(...args: unknown[]) {
      super(...args);
      onSocket(this);
    }
  }
  return {
    ...state,
    FakeWebSocket: FaceTimeSocket,
    setSocketListener(listener: (socket: MockSocket) => void) {
      onSocket = listener;
    },
  };
});
vi.mock("ws", () => ({ default: providerMocks.FakeWebSocket }));
vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  isProviderAuthProfileConfigured: providerMocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: providerMocks.resolveProviderAuthProfileApiKeyMock,
}));
vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  resolveProviderRequestHeaders: ({ defaultHeaders }: { defaultHeaders: Record<string, string> }) =>
    defaultHeaders,
}));
vi.mock("openclaw/plugin-sdk/proxy-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/proxy-capture")>()),
  resolveDebugProxySettings: vi.fn(),
  createDebugProxyWebSocketAgent: vi.fn(),
  captureWsEvent: vi.fn(),
}));

type Socket = InstanceType<typeof providerMocks.FakeWebSocket>;
const activeDrivers = new Set<FaceTimeTalkDriver>();

function emit(socket: Socket, event: Record<string, unknown>) {
  socket.emit("message", Buffer.from(JSON.stringify(event)));
}

function sentEvents(socket: Socket): Record<string, unknown>[] {
  return socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

function providerFixture() {
  const registry = createEmptyPluginRegistry();
  registry.realtimeVoiceProviders.push({
    pluginId: "openai",
    source: "test",
    provider: buildOpenAIRealtimeVoiceProvider({ logger: { warn: vi.fn(), debug: vi.fn() } }),
  });
  setActivePluginRegistry(registry);
}

function startParams(overrides: Partial<Parameters<typeof startFaceTimeTalkDriver>[0]> = {}) {
  return {
    config: resolveFaceTimeConfig({ ownerHandles: ["caller@example.test"] }),
    fullConfig: {},
    runtime: createPluginRuntimeMock(),
    logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    callUUID: "call-1",
    senderId: "caller@example.test",
    senderIsOwner: true as const,
    captureBinary: "/forbidden-capture",
    onHangupRequested: vi.fn(async () => {}),
    ...overrides,
  };
}

async function startConnectedDriver(params: Parameters<typeof startFaceTimeTalkDriver>[0]) {
  const socketCreated = createDeferred<Socket>();
  providerMocks.setSocketListener(socketCreated.resolve);
  const driver = await startFaceTimeTalkDriver(params);
  activeDrivers.add(driver);
  const ready = driver.readyForAudio();
  const socket = await Promise.race([socketCreated.promise, ready.then(() => undefined)]);
  if (!socket) {
    throw new Error("Realtime provider reported ready without its WebSocket");
  }
  socket.readyState = providerMocks.FakeWebSocket.OPEN;
  socket.emit("open");
  emit(socket, { type: "session.updated" });
  await ready;
  return { driver, socket };
}

describe("FaceTime realtime provider boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerMocks.FakeWebSocket.instances = [];
    providerMocks.isProviderAuthProfileConfiguredMock.mockReset().mockReturnValue(false);
    providerMocks.resolveProviderAuthProfileApiKeyMock.mockReset().mockResolvedValue(undefined);
    audio.playedAudioFrames.mockReturnValue(0);
    audio.queuedAudioFrames.mockReturnValue(0);
    audio.getPlaybackState.mockReturnValue([]);
    audio.clearOutputAudio.mockImplementation(() => audio.getPlaybackState.mockReturnValue([]));
    vi.stubEnv("OPENAI_API_KEY", "");
    providerFixture();
  });

  afterEach(async () => {
    await Promise.all([...activeDrivers].map((driver) => driver.close()));
    activeDrivers.clear();
    providerMocks.setSocketListener(() => {});
    resetPluginRuntimeStateForTest();
    audio.playedAudioFrames.mockReturnValue(0);
    audio.queuedAudioFrames.mockReturnValue(0);
    vi.unstubAllEnvs();
  });

  it("connects using the selected agent's API-key profile", async () => {
    const agentDir = "/synthetic/agents/voice-owner";
    const fullConfig: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", default: true },
          { id: "voice-owner", agentDir },
        ],
      },
    };
    providerMocks.isProviderAuthProfileConfiguredMock.mockImplementation(
      (params: { agentDir?: string }) => params.agentDir === agentDir,
    );
    providerMocks.resolveProviderAuthProfileApiKeyMock.mockImplementation(
      async (params: { cfg?: OpenClawConfig; agentDir?: string }) => {
        if (params.cfg !== fullConfig || params.agentDir !== agentDir) {
          throw new Error("No API-key profile for the selected agent");
        }
        return "test-api-key-agent-profile";
      },
    );

    const { driver } = await startConnectedDriver(
      startParams({
        fullConfig,
        config: resolveFaceTimeConfig({
          ownerHandles: ["caller@example.test"],
          realtime: { provider: "openai", sessionKey: "agent:voice-owner:main" },
        }),
      }),
    );

    expect(driver.realtimeActive()).toBe(true);
    expect(providerMocks.resolveProviderAuthProfileApiKeyMock).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: fullConfig, agentDir }),
    );
  });

  it.each([
    {
      name: "disabled",
      interrupt: false,
      playedMs: 500,
      completed: false,
      audioMs: [1_000],
      playedItemMs: [500],
      truncatedMs: [],
    },
    {
      name: "enabled",
      interrupt: true,
      playedMs: 500,
      completed: false,
      audioMs: [1_000],
      playedItemMs: [500],
      truncatedMs: [500],
    },
    {
      name: "early echo guard",
      interrupt: true,
      playedMs: 100,
      completed: false,
      audioMs: [1_000],
      playedItemMs: [100],
      truncatedMs: [],
    },
    {
      name: "completed but still audible",
      interrupt: true,
      playedMs: 500,
      completed: true,
      audioMs: [1_000],
      playedItemMs: [500],
      truncatedMs: [500],
    },
    {
      name: "multiple audio items",
      interrupt: true,
      playedMs: 500,
      completed: false,
      audioMs: [200, 800],
      playedItemMs: [200, 300],
      truncatedMs: [200, 300],
    },
  ])(
    "preserves provider interruption policy: $name",
    async ({ interrupt, playedMs, completed, audioMs, playedItemMs, truncatedMs }) => {
      const { driver, socket } = await startConnectedDriver(
        startParams({
          config: resolveFaceTimeConfig({
            ownerHandles: ["caller@example.test"],
            realtime: {
              provider: "openai",
              providers: {
                openai: { apiKey: "test-api-key-inline", interruptResponseOnInputAudio: interrupt },
              },
            },
          }),
        }),
      );
      expect(sentEvents(socket)).toContainEqual(
        expect.objectContaining({
          type: "session.update",
          session: expect.objectContaining({
            audio: expect.objectContaining({
              input: expect.objectContaining({
                turn_detection: expect.objectContaining({ interrupt_response: interrupt }),
              }),
            }),
          }),
        }),
      );
      emit(socket, { type: "response.created", response: { id: "response-1" } });
      for (const [index, durationMs] of audioMs.entries()) {
        const pcm = Buffer.alloc(durationMs * 48);
        emit(socket, {
          type: "response.output_audio.delta",
          item_id: `item-${index + 1}`,
          delta: pcm.toString("base64"),
        });
        expect(audio.writeOutputAudio).toHaveBeenNthCalledWith(index + 1, pcm, {
          itemId: `item-${index + 1}`,
        });
      }
      audio.getPlaybackState.mockReturnValue(
        playedItemMs.map((audioEndMs, index) => ({ itemId: `item-${index + 1}`, audioEndMs })),
      );
      audio.queuedAudioFrames.mockReturnValue((1_000 - playedMs) * 24);
      audio.playedAudioFrames.mockReturnValue(playedMs * 24);
      if (completed) {
        emit(socket, {
          type: "response.done",
          response: { id: "response-1", status: "completed" },
        });
        expect(audio.finishOutputAudio).toHaveBeenCalled();
      }

      emit(socket, { type: "input_audio_buffer.speech_started" });

      expect(audio.clearOutputAudio).toHaveBeenCalledTimes(truncatedMs.length ? 1 : 0);
      const truncations = sentEvents(socket).filter(
        (event) => event.type === "conversation.item.truncate",
      );
      expect(truncations).toEqual(
        truncatedMs.map((audioEndMs, index) => ({
          type: "conversation.item.truncate",
          item_id: `item-${index + 1}`,
          content_index: 0,
          audio_end_ms: audioEndMs,
        })),
      );
      expect(sentEvents(socket).some((event) => event.type === "response.cancel")).toBe(false);
      expect(driver.realtimeActive()).toBe(true);
    },
  );
});
