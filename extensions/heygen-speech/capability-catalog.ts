import type { PluginCapabilityCatalog } from "openclaw/plugin-sdk/plugin-entry";
import { buildHeyGenSpeechProvider } from "./speech-provider.js";

export default {
  speechProviders: [buildHeyGenSpeechProvider()],
} satisfies PluginCapabilityCatalog;
