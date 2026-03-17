import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/mattermost";
import { mattermostPlugin } from "./src/channel.js";
import { registerSlashCommandRoute } from "./src/mattermost/slash-state.js";
import { setMattermostRuntime } from "./src/runtime.js";
const plugin = {
  id: "mattermost",
  name: "Mattermost",
  description: "Mattermost channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    setMattermostRuntime(api.runtime);
    api.registerChannel({ plugin: mattermostPlugin });
    registerSlashCommandRoute(api);
  }
};
var mattermost_default = plugin;
export {
  mattermost_default as default
};
