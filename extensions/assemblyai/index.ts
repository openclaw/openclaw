import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { assemblyaiMediaUnderstandingProvider } from "./media-understanding-provider.js";

export default definePluginEntry({
  id: "assemblyai",
  name: "AssemblyAI Media Understanding",
  description: "Bundled AssemblyAI audio transcription provider",
  register(api) {
    api.registerMediaUnderstandingProvider(assemblyaiMediaUnderstandingProvider);
  },
});
