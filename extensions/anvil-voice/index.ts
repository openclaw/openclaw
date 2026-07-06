// Anvil Voice plugin entrypoint registers the realtime voice provider.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildAnvilRealtimeVoiceProvider } from "./realtime-voice-provider.js";

export default definePluginEntry({
  id: "anvil-voice",
  name: "Anvil Voice",
  description: "Bundled Anvil Voice realtime provider",
  register(api) {
    api.registerRealtimeVoiceProvider(buildAnvilRealtimeVoiceProvider());
  },
});
