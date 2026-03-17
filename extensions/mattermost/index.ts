import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { mattermostPlugin } from "./src/channel.js";
import { registerSlashCommandRoute } from "./src/mattermost/slash-state.js";
import { setMattermostRuntime } from "./src/runtime.js";

export { mattermostPlugin } from "./src/channel.js";
export { setMattermostRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "mattermost",
  name: "Mattermost",
  description: "Mattermost channel plugin",
  plugin: mattermostPlugin,
  setRuntime: setMattermostRuntime,
  registerFull(api) {
    // Actual slash-command registration happens after the monitor connects and
    // knows the team id; the route itself can be wired here.
    registerSlashCommandRoute(api);
  },
});
