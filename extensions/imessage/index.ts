import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import { imessagePlugin } from "./src/channel.js";

const plugin = {
  id: "imessage",
  name: "iMessage",
  description: "iMessage channel plugin",
  register(api: ClawdbotPluginApi) {
    api.registerChannel({ plugin: imessagePlugin });
  },
};

export default plugin;
