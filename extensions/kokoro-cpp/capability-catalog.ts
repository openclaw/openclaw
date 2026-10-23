import type { PluginCapabilityCatalog } from "openclaw/plugin-sdk/plugin-entry";
import { buildKokoroCppSpeechProvider } from "./speech-provider.js";

export default {
  speechProviders: [buildKokoroCppSpeechProvider()],
} satisfies PluginCapabilityCatalog;
