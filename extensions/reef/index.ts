import {
  buildChannelConfigSchema,
  defineChannelPluginEntry,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/core";
import { reefPlugin } from "./src/channel.js";
import { registerReefCommands } from "./src/commands.js";
import { ReefChannelConfigSchema } from "./src/config-schema.js";
import { setReefRuntime } from "./src/runtime.js";

export { reefPlugin } from "./src/channel.js";
export { setReefRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "reef",
  name: "Reef",
  description: "Guarded end-to-end encrypted claw channel",
  plugin: reefPlugin as ChannelPlugin,
  configSchema: buildChannelConfigSchema(ReefChannelConfigSchema),
  setRuntime: setReefRuntime,
  registerFull: registerReefCommands,
});
