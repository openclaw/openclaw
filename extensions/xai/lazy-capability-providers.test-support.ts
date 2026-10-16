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
  streamSynthesize: vi.fn(),
  synthesizeTelephony: vi.fn(),
  transcriptionConnect: vi.fn(),
  transcriptionSendAudio: vi.fn(),
  transcriptionClose: vi.fn(),
  transcriptionIsConnected: vi.fn(),
  createTranscriptionSession: vi.fn(),
  voiceConnect: vi.fn(),
  voiceSendAudio: vi.fn(),
  voiceSetMediaTimestamp: vi.fn(),
  voiceSendUserMessage: vi.fn(),
  voiceTriggerGreeting: vi.fn(),
  voiceHandleBargeIn: vi.fn(),
  voiceSubmitToolResult: vi.fn(),
  voiceAcknowledgeMark: vi.fn(),
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

const capabilityHost = {
  isProviderAuthProfileConfigured,
  isProviderApiKeyConfiguredAsync,
  isProviderAuthProfileConfiguredAsync,
  resolveAgentDir,
  resolveApiKeyForProvider,
  createRealtimeTranscriptionWebSocketSession,
};

const lazyProvidersUrl = new URL("./lazy-capability-provider-factories.ts", import.meta.url).href;
let lazyProviderCase = 0;

async function loadLazyProviders(): Promise<
  typeof import("./lazy-capability-provider-factories.js")
> {
  return await import(`${lazyProvidersUrl}?testCase=${lazyProviderCase}`);
}

async function createLazyVoiceBridge(
  overrides: Partial<RealtimeVoiceBridgeCreateRequest> = {},
): Promise<RealtimeVoiceBridge> {
  const lazy = await loadLazyProviders();
  return lazy
    .createLazyXaiRealtimeVoiceProvider(capabilityHost)
    .createBridge(createVoiceRequest(overrides));
}

function createVoiceRequest(
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
  // Refresh provider caches without reloading unchanged SDK dependencies.
  lazyProviderCase += 1;
  for (const value of Object.values(runtimeMocks)) {
    value.mockReset();
  }

  runtimeMocks.generateImage.mockResolvedValue({ images: [] });
  runtimeMocks.transcribeAudio.mockResolvedValue({ text: "transcript" });
  runtimeMocks.generateVideo.mockResolvedValue({ videos: [] });
  runtimeMocks.listVoices.mockResolvedValue([]);
  runtimeMocks.synthesize.mockResolvedValue({ audioBuffer: Buffer.alloc(0) });
  runtimeMocks.streamSynthesize.mockResolvedValue({ audioStream: {} });
  runtimeMocks.synthesizeTelephony.mockResolvedValue({ audioBuffer: Buffer.alloc(0) });
  runtimeMocks.transcriptionConnect.mockResolvedValue(undefined);
  runtimeMocks.transcriptionIsConnected.mockReturnValue(false);
  runtimeMocks.voiceConnect.mockResolvedValue(undefined);
  runtimeMocks.voiceIsConnected.mockReturnValue(false);

  runtimeMocks.createTranscriptionSession.mockReturnValue({
    connect: runtimeMocks.transcriptionConnect,
    sendAudio: runtimeMocks.transcriptionSendAudio,
    close: runtimeMocks.transcriptionClose,
    isConnected: runtimeMocks.transcriptionIsConnected,
  });
  runtimeMocks.createVoiceBridge.mockImplementation(
    () =>
      ({
        supportsToolResultContinuation: false,
        connect: runtimeMocks.voiceConnect,
        sendAudio: runtimeMocks.voiceSendAudio,
        setMediaTimestamp: runtimeMocks.voiceSetMediaTimestamp,
        sendUserMessage: runtimeMocks.voiceSendUserMessage,
        triggerGreeting: runtimeMocks.voiceTriggerGreeting,
        handleBargeIn: runtimeMocks.voiceHandleBargeIn,
        submitToolResult: runtimeMocks.voiceSubmitToolResult,
        acknowledgeMark: runtimeMocks.voiceAcknowledgeMark,
        close: runtimeMocks.voiceClose,
        isConnected: runtimeMocks.voiceIsConnected,
      }) satisfies RealtimeVoiceBridge,
  );

  runtimeMocks.buildImageProvider.mockReturnValue({
    generateImage: runtimeMocks.generateImage,
  });
  runtimeMocks.buildMediaProvider.mockReturnValue({
    transcribeAudio: runtimeMocks.transcribeAudio,
  });
  runtimeMocks.buildVideoProvider.mockReturnValue({
    generateVideo: runtimeMocks.generateVideo,
  });
  runtimeMocks.buildSpeechProvider.mockReturnValue({
    listVoices: runtimeMocks.listVoices,
    synthesize: runtimeMocks.synthesize,
    streamSynthesize: runtimeMocks.streamSynthesize,
    synthesizeTelephony: runtimeMocks.synthesizeTelephony,
  });
  runtimeMocks.buildTranscriptionProvider.mockReturnValue({
    createSession: runtimeMocks.createTranscriptionSession,
  });
  runtimeMocks.buildVoiceProvider.mockReturnValue({
    createBridge: runtimeMocks.createVoiceBridge,
  });
});

export {
  capabilityHost,
  createLazyVoiceBridge,
  createVoiceRequest,
  loadLazyProviders,
  runtimeMocks,
};
