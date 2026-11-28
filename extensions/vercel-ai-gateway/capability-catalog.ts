import type { PluginCapabilityCatalogHostEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildVercelAiGatewaySpeechProvider } from "./speech-provider.js";

const catalog: PluginCapabilityCatalogHostEntry = (context) => ({
  speechProviders: [buildVercelAiGatewaySpeechProvider(context)],
});

export default catalog;
