import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import { slackPlugin } from "./src/channel.js";

const plugin = {
  id: "slack",
  name: "Slack",
  description: "Slack channel plugin",
  register(api: ClawdbotPluginApi) {
    api.registerChannel({ plugin: slackPlugin });
  },
};

export default plugin;
