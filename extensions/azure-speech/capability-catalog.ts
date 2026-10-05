import type { PluginCapabilityCatalog } from "openclaw/plugin-sdk/plugin-entry";
import { buildAzureSpeechTranscriptionProvider } from "./realtime-transcription-provider.js";
import { buildAzureSpeechProvider } from "./speech-provider.js";

export default {
  speechProviders: [buildAzureSpeechProvider()],
  realtimeTranscriptionProviders: [buildAzureSpeechTranscriptionProvider()],
} satisfies PluginCapabilityCatalog;
