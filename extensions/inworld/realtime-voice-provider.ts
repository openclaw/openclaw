import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { resolveInworldRealtimeApiKey } from "./realtime-voice-auth.js";
import { InworldRealtimeVoiceBridge } from "./realtime-voice-bridge.js";
import {
  normalizeInworldRealtimeBaseUrl,
  normalizeInworldRealtimeProviderConfig,
} from "./realtime-voice-config.js";
import {
  assertInworldRealtimeVoiceRequestSupported,
  createInworldRealtimeVoiceProviderMetadata,
} from "./realtime-voice-metadata.js";

export function buildInworldRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    ...createInworldRealtimeVoiceProviderMetadata(),
    createBridge: (req) => {
      const config = normalizeInworldRealtimeProviderConfig(req.providerConfig);
      assertInworldRealtimeVoiceRequestSupported(req);
      const { interruptResponseOnInputAudio: _ignored, ...bridgeConfig } = config;
      return new InworldRealtimeVoiceBridge({
        ...req,
        ...bridgeConfig,
        baseUrl: normalizeInworldRealtimeBaseUrl(config.baseUrl),
        resolveApiKey: () => resolveInworldRealtimeApiKey(config.apiKey),
      });
    },
  };
}
