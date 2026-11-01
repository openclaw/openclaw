import type { PluginCapabilityCatalogHostEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createLazyXaiSpeechProvider,
  createLazyXaiRealtimeTranscriptionProvider,
  createLazyXaiRealtimeVoiceProvider,
} from "./lazy-capability-provider-factories.js";

const catalog: PluginCapabilityCatalogHostEntry = (context) => ({
  speechProviders: [createLazyXaiSpeechProvider(context)],
  realtimeTranscriptionProviders: [createLazyXaiRealtimeTranscriptionProvider(context)],
  realtimeVoiceProviders: [createLazyXaiRealtimeVoiceProvider(context)],
});

export default catalog;
