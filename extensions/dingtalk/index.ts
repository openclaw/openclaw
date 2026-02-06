import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { dingtalkPlugin } from "./src/channel.js";

const plugin = {
  id: "dingtalk",
  name: "DingTalk",
  description: "DingTalk (钉钉) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: dingtalkPlugin });
  },
};

export default plugin;
