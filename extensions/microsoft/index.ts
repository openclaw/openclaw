import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createJanetTtsStreamService, registerJanetTtsGateway } from "./janet-tts-stream.js";
import { buildMicrosoftSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "microsoft",
  name: "Microsoft Speech",
  description: "Bundled Microsoft speech provider",
  register(api) {
    api.registerSpeechProvider(buildMicrosoftSpeechProvider());
    registerJanetTtsGateway(api);
    api.registerService(createJanetTtsStreamService(api.runtime, api.logger));
  },
});
