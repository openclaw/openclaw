import type {
  RealtimeVoiceBridgeCallbacks,
  RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { expect, vi } from "vitest";
import type { startFaceTimeAudioPump } from "../src/audio-pump.js";

type SessionParams = Required<
  Pick<RealtimeVoiceBridgeCallbacks, "onEvent" | "onReady" | "onError" | "onClose" | "onToolCall">
> &
  Pick<RealtimeVoiceBridgeCallbacks, "onResponseDone" | "onTranscript"> & {
    audioSink: { isOpen(): boolean; sendAudio(audio: Buffer): void; clearAudio(): void };
    instructions?: string;
    tools?: RealtimeVoiceTool[];
  };

export const mocks = vi.hoisted(() => ({
  bridge: {
    bridge: { supportsToolResultContinuation: false, supportsToolResultSuppression: true },
    close: vi.fn(),
    connect: vi.fn<() => Promise<void>>(),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
    triggerGreeting: vi.fn(),
  },
  createSession: vi.fn(),
  consult: vi.fn(),
  onFailure: vi.fn(async () => true),
  resolveAgentContext: vi.fn(),
  resolveDefaultAgentId: vi.fn((config: { agents?: { entries?: Record<string, unknown> } }) => {
    const agentIds = Object.keys(config.agents?.entries ?? {});
    return agentIds[0] ?? "main";
  }),
  resolveProvider: vi.fn(() => ({ provider: { id: "openai" }, providerConfig: {} })),
  hangupRequested: vi.fn(async () => {}),
  pump: {
    suppressionReady: vi.fn(async () => {}),
    routeReady: vi.fn(async () => {}),
    processOutputSuppressed: vi.fn(() => true),
    writeOutputAudio: vi.fn(),
    getPlaybackState: vi.fn(() => []),
    finishOutputAudio: vi.fn(),
    clearOutputAudio: vi.fn(),
    playedAudioFrames: vi.fn(() => 0),
    queuedAudioFrames: vi.fn(() => 0),
    suspendMedia: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  },
  pumpParams: undefined as Required<Parameters<typeof startFaceTimeAudioPump>[0]> | undefined,
  sessionParams: undefined as SessionParams | undefined,
}));

// mock-isolation: The driver fixture owns synthetic Talk sessions, consult callbacks, and observations; no host runtime is started.
vi.mock("openclaw/plugin-sdk/realtime-voice", async () => ({
  ...(await import("../../../src/talk/agent-consult-tool.js")),
  ...(await import("../../../src/talk/agent-run-control-shared.js")),
  ...(await import("../../../src/talk/session-log-runtime.js")),
  consultRealtimeVoiceAgent: mocks.consult,
  createRealtimeVoiceBridgeSession: mocks.createSession,
  getRealtimeVoiceProvider: vi.fn((providerId: string) => ({ id: providerId })),
  createTalkSessionController: vi.fn(() => {
    const recentEvents: unknown[] = [];
    return {
      outputAudioActive: false,
      recentEvents,
      emit: vi.fn((event: unknown) => recentEvents.push(event)),
      ensureTurn: vi.fn(() => ({ turnId: "turn-1" })),
      startOutputAudio: vi.fn(() => ({ event: undefined })),
      finishOutputAudio: vi.fn(),
      endTurn: vi.fn(() => ({ ok: false })),
    };
  }),
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: "pcm16-24khz",
  recordTalkObservabilityEvent: vi.fn(),
  resolveConfiguredRealtimeVoiceProviderAsync: mocks.resolveProvider,
}));

vi.mock("openclaw/plugin-sdk/realtime-bootstrap-context", () => ({
  resolveRealtimeVoiceAgentContextInstructions: mocks.resolveAgentContext,
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../src/audio-pump.js", () => ({
  startFaceTimeAudioPump: vi.fn((params) => {
    mocks.pumpParams = params;
    return mocks.pump;
  }),
}));

import { resolveFaceTimeConfig, type FaceTimeConfig } from "../src/config.js";
import { startFaceTimeTalkDriver } from "../src/talk-driver.js";

export function startParams({
  realtime,
  ...overrides
}: Partial<Parameters<typeof startFaceTimeTalkDriver>[0]> & {
  realtime?: Partial<FaceTimeConfig["realtime"]>;
} = {}) {
  return {
    config: resolveFaceTimeConfig({ ownerHandles: ["caller@example.com"], realtime }),
    fullConfig: {},
    runtime: { agent: {} } as never,
    logger: console,
    callUUID: "call-1",
    senderId: "caller@example.com",
    senderIsOwner: true as const,
    captureBinary: "/capture",
    onHangupRequested: mocks.hangupRequested,
    onFailure: mocks.onFailure,
    ...overrides,
  };
}

export async function startReadyFaceTimeTalkDriver(
  overrides: Parameters<typeof startParams>[0] = {},
) {
  const driver = await startFaceTimeTalkDriver(startParams(overrides));
  const ready = driver.readyForAudio();
  await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalledOnce());
  mocks.sessionParams?.onReady();
  await ready;
  return driver;
}

export function resetTalkDriverMocks() {
  vi.clearAllMocks();
  mocks.consult.mockReset().mockImplementation(() => new Promise(() => {}));
  mocks.onFailure.mockReset().mockResolvedValue(true);
  mocks.resolveAgentContext.mockResolvedValue("Agent context: shared voice agent context.");
  mocks.bridge.connect.mockResolvedValue();
  mocks.pump.suppressionReady.mockResolvedValue();
  mocks.pump.routeReady.mockResolvedValue();
  mocks.pump.suspendMedia.mockResolvedValue();
  mocks.pump.stop.mockResolvedValue();
  mocks.pumpParams = undefined;
  mocks.sessionParams = undefined;
  mocks.bridge.bridge.supportsToolResultContinuation = false;
  mocks.bridge.bridge.supportsToolResultSuppression = true;
  mocks.createSession.mockImplementation((params) => {
    mocks.sessionParams = params;
    return mocks.bridge;
  });
}
