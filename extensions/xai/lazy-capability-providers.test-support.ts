import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  isProviderApiKeyConfigured,
  isProviderAuthProfileConfigured,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice";
import { beforeEach, vi, type Mock } from "vitest";

vi.mock("openclaw/plugin-sdk/agent-runtime", () => {
  throw new Error("Lazy capability metadata must not load the broad agent runtime");
});

const runtimeMocks = vi.hoisted(() => {
  const generateImage: Mock = vi.fn();
  const transcribeAudio: Mock = vi.fn();
  const generateVideo: Mock = vi.fn();
  const listVoices: Mock = vi.fn();
  const synthesize: Mock = vi.fn();
  const streamSynthesize: Mock = vi.fn();
  const synthesizeTelephony: Mock = vi.fn();
  const transcriptionConnect: Mock = vi.fn();
  const transcriptionSendAudio: Mock = vi.fn();
  const transcriptionClose: Mock = vi.fn();
  const transcriptionIsConnected: Mock = vi.fn();
  const createTranscriptionSession: Mock = vi.fn();
  const voiceConnect: Mock = vi.fn();
  const voiceSendAudio: Mock = vi.fn();
  const voiceSetMediaTimestamp: Mock = vi.fn();
  const voiceSendUserMessage: Mock = vi.fn();
  const voiceTriggerGreeting: Mock = vi.fn();
  const voiceHandleBargeIn: Mock = vi.fn();
  const voiceSubmitToolResult: Mock = vi.fn();
  const voiceAcknowledgeMark: Mock = vi.fn();
  const voiceClose: Mock = vi.fn();
  const voiceIsConnected: Mock = vi.fn();
  const createVoiceBridge: Mock<
    (request: RealtimeVoiceBridgeCreateRequest) => RealtimeVoiceBridge
  > = vi.fn();
  const buildImageProvider: Mock = vi.fn();
  const buildMediaProvider: Mock = vi.fn();
  const buildVideoProvider: Mock = vi.fn();
  const buildSpeechProvider: Mock = vi.fn();
  const buildTranscriptionProvider: Mock = vi.fn();
  const buildVoiceProvider: Mock = vi.fn();

  return {
    generateImage,
    transcribeAudio,
    generateVideo,
    listVoices,
    synthesize,
    streamSynthesize,
    synthesizeTelephony,
    transcriptionConnect,
    transcriptionSendAudio,
    transcriptionClose,
    transcriptionIsConnected,
    createTranscriptionSession,
    voiceConnect,
    voiceSendAudio,
    voiceSetMediaTimestamp,
    voiceSendUserMessage,
    voiceTriggerGreeting,
    voiceHandleBargeIn,
    voiceSubmitToolResult,
    voiceAcknowledgeMark,
    voiceClose,
    voiceIsConnected,
    createVoiceBridge,
    buildImageProvider,
    buildMediaProvider,
    buildVideoProvider,
    buildSpeechProvider,
    buildTranscriptionProvider,
    buildVoiceProvider,
  };
});

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
  isProviderApiKeyConfigured,
  isProviderAuthProfileConfigured,
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
