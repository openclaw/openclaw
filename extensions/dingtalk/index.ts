import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { dingtalkPlugin } from "./src/channel.js";
import { PLUGIN_ID } from "./src/constants.js";
import { setDingTalkRuntime } from "./src/runtime.js";

const plugin: {
  id: string;
  name: string;
  description: string;
  configSchema: ReturnType<typeof emptyPluginConfigSchema>;
  register: (api: OpenClawPluginApi) => void;
} = {
  id: PLUGIN_ID,
  name: "DingTalk",
  description: "DingTalk (钉钉) enterprise robot channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setDingTalkRuntime(api.runtime);
    api.registerChannel({ plugin: dingtalkPlugin });
  },
};

export default plugin;
