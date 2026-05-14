import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { senseaudioMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildSenseAudioSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "senseaudio",
  name: "SenseAudio",
  description: "Bundled SenseAudio audio transcription and speech synthesis provider",
  register(api) {
    api.registerMediaUnderstandingProvider(senseaudioMediaUnderstandingProvider);
    api.registerSpeechProvider(buildSenseAudioSpeechProvider());
  },
});
