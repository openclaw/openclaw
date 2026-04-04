import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { slackPlugin } from "./src/channel.js";
import { registerSlackPluginHttpRoutes } from "./src/http/plugin-routes.js";
import { setSlackRuntime } from "./src/runtime.js";

export { slackPlugin } from "./src/channel.js";
export { setSlackRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "slack",
  name: "Slack",
  description: "Slack channel plugin",
  plugin: slackPlugin,
  setRuntime: setSlackRuntime,
  registerFull: registerSlackPluginHttpRoutes,
});
