import type { PluginCapabilityCatalogEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildClawRouterSpeechProvider } from "./speech-provider.js";

export default ((context) => ({
  speechProviders: [buildClawRouterSpeechProvider(context)],
})) satisfies PluginCapabilityCatalogEntry;
