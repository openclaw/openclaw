import type { PluginCapabilityCatalog } from "openclaw/plugin-sdk/plugin-entry";
import { buildSpeechifySpeechProvider } from "./speech-provider.js";

export default {
  speechProviders: [buildSpeechifySpeechProvider()],
} satisfies PluginCapabilityCatalog;
