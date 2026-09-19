import { expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildCancelResult: vi.fn((message: string) => ({ status: "cancelled", message })),
  bridge: {
    bridge: { supportsToolResultContinuation: false },
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    connect: vi.fn<() => Promise<void>>(),
    sendAudio: vi.fn(),
    sendUserMessage: vi.fn(),
    handleBargeIn: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
    triggerGreeting: vi.fn(),
  },
  createSession: vi.fn(),
  consult: vi.fn(),
  getSessionEntry: vi.fn<() => { sessionId: string } | undefined>(() => ({
    sessionId: "facetime-consult-session",
  })),
  resolveBootstrapContext: vi.fn(),
  resolveDefaultAgentId: vi.fn(
    (config: { agents?: { list?: Array<{ id: string; default?: boolean }> } }) => {
      const agents = config.agents?.list ?? [];
      return agents.find((agent) => agent.default)?.id ?? agents[0]?.id ?? "main";
    },
  ),
  resolveProvider: vi.fn(() => ({ provider: { id: "openai" }, providerConfig: {} })),
  hangupRequested: vi.fn(async () => {}),
  senderAuthVersion: 1 as number | undefined,
  pump: {
    suppressionReady: vi.fn(async () => {}),
    routeReady: vi.fn(async () => {}),
    processOutputSuppressed: vi.fn(() => true),
    writeOutputAudio: vi.fn(),
    finishOutputAudio: vi.fn(),
    clearOutputAudio: vi.fn(),
    playedAudioFrames: vi.fn(() => 0),
    queuedAudioFrames: vi.fn(() => 0),
    suspendMedia: vi.fn(async () => {}),
    failClosed: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  },
  pumpParams: undefined as
    | undefined
    | {
        onError(error: Error): void | Promise<void>;
        onInputAudio(audio: Buffer): void;
        onPlaybackDrained(event: { generation: number; playedFrames: number }): void;
      },
  sessionParams: undefined as
    | undefined
    | {
        audioSink: {
          isOpen(): boolean;
          sendAudio(audio: Buffer): void;
          clearAudio(): void;
        };
        instructions?: string;
        tools?: Array<{ name: string; description: string }>;
        onEvent(event: {
          direction: "client" | "server";
          type: string;
          detail?: string;
          responseId?: string;
        }): void;
        onResponseDone?(outcome: {
          status: "completed" | "cancelled" | "failed" | "incomplete";
          responseId?: string;
          message?: string;
        }): void;
        onTranscript?(role: "user" | "assistant", text: string, final: boolean): void;
        onReady(): void;
        onError(error: Error): void;
        onClose(reason: "completed" | "error"): void;
        onToolCall(event: {
          itemId: string;
          callId: string;
          name: string;
          args: unknown;
        }): void | Promise<void>;
      },
}));

vi.mock("openclaw/plugin-sdk/realtime-voice", () => ({
  REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES: ["safe-read-only", "owner", "none"],
  isRealtimeVoiceAgentConsultToolPolicy: (value: unknown) =>
    value === "safe-read-only" || value === "owner" || value === "none",
  get REALTIME_VOICE_AGENT_CONSULT_SENDER_AUTH_VERSION() {
    return mocks.senderAuthVersion;
  },
  buildRealtimeVoiceAgentConsultPolicyInstructions: vi.fn(
    ({ consultPolicy }: { consultPolicy?: string }) => `Consult behavior: ${consultPolicy}.`,
  ),
  buildRealtimeVoiceAgentCancelProviderResult: mocks.buildCancelResult,
  buildRealtimeVoiceAgentConsultWorkingResponse: vi.fn(() => ({ status: "working" })),
  consultRealtimeVoiceAgent: mocks.consult,
  createRealtimeVoiceBridgeSession: mocks.createSession,
  getRealtimeVoiceProvider: vi.fn((providerId: string) => ({ id: providerId })),
  createTalkSessionController: vi.fn(() => {
    const recentEvents: unknown[] = [];
    const remember = (event: unknown) => {
      recentEvents.push(event);
      return event;
    };
    return {
      outputAudioActive: false,
      recentEvents,
      emit: vi.fn(remember),
      ensureTurn: vi.fn(() => ({ turnId: "turn-1" })),
      startOutputAudio: vi.fn(() => ({ event: undefined })),
      finishOutputAudio: vi.fn(),
      endTurn: vi.fn(() => ({ ok: false })),
    };
  }),
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME: "openclaw_agent_consult",
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: "pcm16-24khz",
  recordTalkObservabilityEvent: vi.fn(),
  recordRealtimeVoiceTranscript: vi.fn((transcript, role, text, maxEntries = 40) => {
    const entry = { at: new Date().toISOString(), role, text };
    transcript.push(entry);
    transcript.splice(0, Math.max(0, transcript.length - maxEntries));
    return entry;
  }),
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveProvider,
  resolveRealtimeVoiceAgentConsultTools: vi.fn(
    (policy: string, customTools: Array<{ name: string }> = []) => [
      ...(policy === "none" ? [] : [{ name: "openclaw_agent_consult" }]),
      ...customTools,
    ],
  ),
  resolveRealtimeVoiceAgentConsultToolsAllow: vi.fn(() => []),
}));

vi.mock("openclaw/plugin-sdk/realtime-bootstrap-context", () => ({
  resolveRealtimeBootstrapContextInstructions: mocks.resolveBootstrapContext,
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

import { resolveFaceTimeConfig } from "../src/config.js";
import { startFaceTimeTalkDriver } from "../src/talk-driver.js";

export function startParams(overrides: Record<string, unknown> = {}) {
  return {
    config: resolveFaceTimeConfig({ ownerHandles: ["caller@example.com"] }),
    fullConfig: {} as never,
    runtime: {
      agent: {
        session: {
          resolveStorePath: vi.fn(() => "/store"),
          getSessionEntry: mocks.getSessionEntry,
        },
      },
    } as never,
    logger: console,
    callUUID: "call-1",
    senderId: "caller@example.com",
    senderIsOwner: true as const,
    captureBinary: "/capture",
    onHangupRequested: mocks.hangupRequested,
    ...overrides,
  };
}

export async function startReadyFaceTimeTalkDriver(params = startParams()) {
  const driver = await startFaceTimeTalkDriver(params);
  const ready = driver.readyForAudio();
  await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalledOnce());
  mocks.sessionParams?.onReady();
  await ready;
  return driver;
}

export function resetTalkDriverMocks() {
  vi.clearAllMocks();
  mocks.getSessionEntry.mockReturnValue({ sessionId: "facetime-consult-session" });
  mocks.senderAuthVersion = 1;
  mocks.resolveBootstrapContext.mockResolvedValue(undefined);
  mocks.bridge.connect.mockResolvedValue();
  mocks.pump.suppressionReady.mockResolvedValue();
  mocks.pump.routeReady.mockResolvedValue();
  mocks.pump.suspendMedia.mockResolvedValue();
  mocks.pump.stop.mockResolvedValue();
  mocks.pumpParams = undefined;
  mocks.sessionParams = undefined;
  mocks.bridge.bridge.supportsToolResultContinuation = false;
  (
    mocks.bridge.bridge as { supportsToolResultSuppression?: boolean }
  ).supportsToolResultSuppression = true;
  mocks.createSession.mockImplementation((params) => {
    mocks.sessionParams = params;
    return mocks.bridge;
  });
}

export { mocks };
