import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createJanetTtsStreamService, registerJanetTtsGateway } from "./janet-tts-stream.js";

export default definePluginEntry({
  id: "janet-tts-stream",
  name: "Janet TTS Stream",
  description: "Janet-specific low-latency Microsoft TTS streaming plugin",
  register(api) {
    registerJanetTtsGateway(api);
    api.registerService(createJanetTtsStreamService(api.runtime, api.logger));
  },
});
