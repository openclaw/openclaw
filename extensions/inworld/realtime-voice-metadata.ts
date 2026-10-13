import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { hasInworldRealtimeApiKeyInput } from "./realtime-voice-auth.js";
import {
  INWORLD_REALTIME_DEFAULT_MODEL,
  INWORLD_REALTIME_VOICES,
  normalizeInworldRealtimeProviderConfig,
} from "./realtime-voice-config.js";

const INWORLD_REALTIME_AUDIO_FORMAT_G711_ULAW_8KHZ = {
  encoding: "g711_ulaw",
  sampleRateHz: 8000,
  channels: 1,
} satisfies RealtimeVoiceAudioFormat;
const INWORLD_REALTIME_AUDIO_FORMAT_PCM16_24KHZ = {
  encoding: "pcm16",
  sampleRateHz: 24000,
  channels: 1,
} satisfies RealtimeVoiceAudioFormat;

export function createInworldRealtimeVoiceProviderMetadata() {
  return {
    id: "inworld",
    label: "Inworld Realtime",
    aliases: ["inworld-realtime", "inworld-realtime-voice"],
    defaultModel: INWORLD_REALTIME_DEFAULT_MODEL,
    voices: INWORLD_REALTIME_VOICES,
    autoSelectOrder: 30,
    capabilities: {
      transports: ["gateway-relay"],
      inputAudioFormats: [
        INWORLD_REALTIME_AUDIO_FORMAT_G711_ULAW_8KHZ,
        INWORLD_REALTIME_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      outputAudioFormats: [
        INWORLD_REALTIME_AUDIO_FORMAT_G711_ULAW_8KHZ,
        INWORLD_REALTIME_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      supportsBargeIn: true,
      handlesInputAudioBargeIn: true,
      supportsToolCalls: true,
      supportsSessionResumption: false,
    },
    resolveConfig: ({ rawConfig }) => normalizeInworldRealtimeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      hasInworldRealtimeApiKeyInput(normalizeInworldRealtimeProviderConfig(providerConfig).apiKey),
  } satisfies Omit<RealtimeVoiceProviderPlugin, "createBridge" | "createBrowserSession">;
}

export function assertInworldRealtimeVoiceRequestSupported(
  req: RealtimeVoiceBridgeCreateRequest,
): void {
  const config = normalizeInworldRealtimeProviderConfig(req.providerConfig);
  if (req.autoRespondToAudio === false) {
    throw new Error(
      'Inworld realtime voice requires automatic turn-detection responses; use consultRouting: "provider-direct"',
    );
  }
  if ((req.interruptResponseOnInputAudio ?? config.interruptResponseOnInputAudio) === false) {
    throw new Error(
      "Inworld realtime voice requires automatic turn-detection interruption handling",
    );
  }
}
