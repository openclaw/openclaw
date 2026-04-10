import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildPollySpeechProvider } from "./polly/speech-provider.js";
import { buildTranscribeMediaProvider } from "./transcribe/media-understanding-provider.js";
import { buildNovaSonicVoiceProvider } from "./nova-sonic/realtime-voice-provider.js";

export default definePluginEntry({
  id: "amazon",
  name: "Amazon AWS Services",
  description: "Amazon Polly (TTS), Transcribe (STT), Nova Sonic (realtime voice), and other AWS AI services.",
  register(api) {
    api.registerSpeechProvider(buildPollySpeechProvider(api.pluginConfig));
    api.registerMediaUnderstandingProvider(buildTranscribeMediaProvider(api.pluginConfig));
    api.registerRealtimeVoiceProvider(buildNovaSonicVoiceProvider(api.pluginConfig));
  },
});
