import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { dingtalkPlugin } from "./src/channel.js";
import { DINGTALK_PLUGIN_ID } from "./src/config-schema.js";
import { setDingTalkRuntime } from "./src/runtime.js";

const plugin = {
  id: DINGTALK_PLUGIN_ID,
  name: "DingTalk",
  description: "DingTalk (钉钉) channel plugin for enterprise messaging",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setDingTalkRuntime(api.runtime);
    api.registerChannel({ plugin: dingtalkPlugin });
  },
};

export default plugin;
