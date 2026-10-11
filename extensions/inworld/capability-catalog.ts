import type { PluginCapabilityCatalog } from "openclaw/plugin-sdk/plugin-entry";
import { createLazyInworldRealtimeVoiceProvider } from "./realtime-voice-lazy-provider.js";
import { buildInworldSpeechProvider } from "./speech-provider.js";

export default {
  speechProviders: [buildInworldSpeechProvider()],
  realtimeVoiceProviders: [createLazyInworldRealtimeVoiceProvider()],
} satisfies PluginCapabilityCatalog;
