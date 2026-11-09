import { existsSync } from "node:fs";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { AUDIO_COMMAND, AudioExecutor, parseAudio } from "./src/audio.js";
import { registerDeviceGateway } from "./src/gateway.js";

export default definePluginEntry({
  id: "device-controls",
  name: "Device Controls",
  description: "Opt-in bounded audio and pointer actions on explicitly selected nodes.",
  register(api) {
    const audio = new AudioExecutor();
    api.registerNodeInvokePolicy({
      commands: [AUDIO_COMMAND],
      dangerous: true,
      classifyRisk: ({ params }) => {
        parseAudio(params);
        return { level: "ordinary", family: "bounded_audio" };
      },
      handle: (context) => {
        if (!context.risk) {
          return {
            ok: false,
            code: "AUDIO_RISK_UNCLASSIFIED",
            message: "Audio request was not classified",
          };
        }
        return context.invokeNode();
      },
    });
    api.registerNodeHostCommand({
      command: AUDIO_COMMAND,
      cap: "device.audio",
      dangerous: true,
      isAvailable: () => process.platform === "darwin" && existsSync("/usr/bin/afplay"),
      hasActiveWork: () => audio.busy,
      onDisconnect: () => audio.disconnect(),
      handle: async (paramsJSON, _io, context) =>
        JSON.stringify(await audio.execute(JSON.parse(paramsJSON ?? "null"), context?.signal)),
    });
    registerDeviceGateway(api);
  },
});
