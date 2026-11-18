import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { VOICE_CALL_CLI_DESCRIPTOR } from "./cli-output-mode.js";

export default definePluginEntry({
  id: "voice-call",
  name: "Voice Call",
  description: "Voice call channel plugin",
  register(api) {
    api.registerCli(() => {}, {
      commands: ["voicecall"],
      descriptors: [VOICE_CALL_CLI_DESCRIPTOR],
    });
  },
});
