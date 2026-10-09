import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { createLazyInworldRealtimeVoiceBridge } from "./realtime-voice-lazy.js";
import { createInworldRealtimeVoiceProviderMetadata } from "./realtime-voice-metadata.js";

export function createLazyInworldRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    ...createInworldRealtimeVoiceProviderMetadata(),
    createBridge: createLazyInworldRealtimeVoiceBridge,
  };
}
