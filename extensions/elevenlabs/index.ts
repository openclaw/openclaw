import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildElevenLabsSpeechProvider } from "openclaw/plugin-sdk/speech";

const elevenLabsPlugin = {
  id: "elevenlabs",
  name: "ElevenLabs Speech",
  description: "Bundled ElevenLabs speech provider",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerSpeechProvider(buildElevenLabsSpeechProvider());
  },
};

export default elevenLabsPlugin;
