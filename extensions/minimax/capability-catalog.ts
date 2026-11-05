import type { PluginCapabilityCatalogHostEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildMinimaxSpeechProvider } from "./speech-provider-factory.js";

const catalog: PluginCapabilityCatalogHostEntry = (context) => ({
  speechProviders: [buildMinimaxSpeechProvider(context)],
});

export default catalog;
