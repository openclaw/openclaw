import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  isProviderAuthProfileConfigured,
  isProviderApiKeyConfiguredAsync,
  isProviderAuthProfileConfiguredAsync,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice";
import { beforeEach, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/agent-runtime", () => {
  throw new Error("Lazy capability metadata must not load the broad agent runtime");
});

const runtimeMocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  transcribeAudio: vi.fn(),
  generateVideo: vi.fn(),
  listVoices: vi.fn(),
  synthesize: vi.fn(),
  transcriptionConnect: vi.fn(),
  transcriptionSendAudio: vi.fn(),
  transcriptionClose: vi.fn(),
  createTranscriptionSession: vi.fn(),
  voiceConnect: vi.fn(),
  voiceSendAudio: vi.fn(),
  voiceSetMediaTimestamp: vi.fn(),
  voiceSendUserMessage: vi.fn(),
  voiceTriggerGreeting: vi.fn(),
  voiceSubmitToolResult: vi.fn(),
  voiceClose: vi.fn(),
  voiceIsConnected: vi.fn(),
  buildImageProvider: vi.fn(),
  buildMediaProvider: vi.fn(),
  buildVideoProvider: vi.fn(),
  buildSpeechProvider: vi.fn(),
  buildTranscriptionProvider: vi.fn(),
  buildVoiceProvider: vi.fn(),
  createVoiceBridge: vi.fn<(request: RealtimeVoiceBridgeCreateRequest) => RealtimeVoiceBridge>(),
}));

export { runtimeMocks };

vi.mock("./image-generation-provider.js", () => ({
  buildXaiImageGenerationProvider: runtimeMocks.buildImageProvider,
}));
vi.mock("./stt.js", () => ({
  buildXaiMediaUnderstandingProvider: runtimeMocks.buildMediaProvider,
}));
vi.mock("./video-generation-provider.js", () => ({
  buildXaiVideoGenerationProvider: runtimeMocks.buildVideoProvider,
}));
vi.mock("./speech-provider.js", () => ({
  buildXaiSpeechProvider: runtimeMocks.buildSpeechProvider,
}));
vi.mock("./realtime-transcription-provider-factory.js", () => ({
  buildXaiRealtimeTranscriptionProvider: runtimeMocks.buildTranscriptionProvider,
}));
vi.mock("./realtime-voice-provider.js", () => ({
  buildXaiRealtimeVoiceProvider: runtimeMocks.buildVoiceProvider,
}));

export const capabilityHost = {
  isProviderAuthProfileConfigured,
  isProviderApiKeyConfiguredAsync,
  isProviderAuthProfileConfiguredAsync,
  resolveAgentDir,
  resolveApiKeyForProvider,
  createRealtimeTranscriptionWebSocketSession,
};

const lazyProvidersUrl = new URL("./lazy-capability-provider-factories.ts", import.meta.url).href;
let lazyProviderCase = 0;

export async function loadLazyProviders(): Promise<
  typeof import("./lazy-capability-provider-factories.js")
> {
  return await import(`${lazyProvidersUrl}?testCase=${lazyProviderCase}`);
}

export async function createLazyVoiceBridge(
  overrides: Partial<RealtimeVoiceBridgeCreateRequest> = {},
): Promise<RealtimeVoiceBridge> {
  const lazy = await loadLazyProviders();
  return lazy
    .createLazyXaiRealtimeVoiceProvider(capabilityHost)
    .createBridge(createVoiceRequest(overrides));
}

export function createVoiceRequest(
  overrides: Partial<RealtimeVoiceBridgeCreateRequest> = {},
): RealtimeVoiceBridgeCreateRequest {
  return {
    providerConfig: {},
    onAudio() {},
    onClearAudio() {},
    onError() {},
    ...overrides,
  };
}

beforeEach(() => {
  const m = runtimeMocks;
  // Refresh provider caches without reloading unchanged SDK dependencies.
  lazyProviderCase += 1;
  for (const value of Object.values(m)) {
    value.mockReset();
  }

  m.generateImage.mockResolvedValue({ images: [] });
  m.transcribeAudio.mockResolvedValue({ text: "transcript" });
  m.generateVideo.mockResolvedValue({ videos: [] });
  m.listVoices.mockResolvedValue([]);
  m.synthesize.mockResolvedValue({ audioBuffer: Buffer.alloc(0) });
  m.transcriptionConnect.mockResolvedValue(undefined);
  m.voiceConnect.mockResolvedValue(undefined);
  m.voiceIsConnected.mockReturnValue(false);

  m.createTranscriptionSession.mockReturnValue({
    connect: m.transcriptionConnect,
    sendAudio: m.transcriptionSendAudio,
    close: m.transcriptionClose,
    isConnected: () => false,
  });
  m.createVoiceBridge.mockImplementation(() => ({
    supportsToolResultContinuation: false,
    connect: m.voiceConnect,
    sendAudio: m.voiceSendAudio,
    setMediaTimestamp: m.voiceSetMediaTimestamp,
    sendUserMessage: m.voiceSendUserMessage,
    triggerGreeting: m.voiceTriggerGreeting,
    handleBargeIn() {},
    submitToolResult: m.voiceSubmitToolResult,
    acknowledgeMark() {},
    close: m.voiceClose,
    isConnected: m.voiceIsConnected,
  }));

  m.buildImageProvider.mockReturnValue({ generateImage: m.generateImage });
  m.buildMediaProvider.mockReturnValue({ transcribeAudio: m.transcribeAudio });
  m.buildVideoProvider.mockReturnValue({ generateVideo: m.generateVideo });
  m.buildSpeechProvider.mockReturnValue({
    listVoices: m.listVoices,
    synthesize: m.synthesize,
  });
  m.buildTranscriptionProvider.mockReturnValue({ createSession: m.createTranscriptionSession });
  m.buildVoiceProvider.mockReturnValue({ createBridge: m.createVoiceBridge });
});
