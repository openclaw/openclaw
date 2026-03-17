import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/slack";
import { slackPlugin } from "./src/channel.js";
import { setSlackRuntime } from "./src/runtime.js";
const plugin = {
  id: "slack",
  name: "Slack",
  description: "Slack channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    setSlackRuntime(api.runtime);
    api.registerChannel({ plugin: slackPlugin });
  }
};
var slack_default = plugin;
export {
  slack_default as default
};
