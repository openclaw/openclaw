import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildSenseaudioMusicGenerationProvider } from "./music-generation-provider.js";

export default definePluginEntry({
  id: "senseaudio",
  name: "SenseAudio",
  description: "Bundled SenseAudio music generation provider",
  register(api) {
    api.registerMusicGenerationProvider(buildSenseaudioMusicGenerationProvider());
  },
});
