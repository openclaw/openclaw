import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createWeChatMPPlugin } from "./src/channel.js";
import { setWeChatMPRuntime } from "./src/runtime.js";

const plugin = {
  id: "wechat-mp",
  name: "WeChat MP",
  description:
    "WeChat Official Account (微信公众号) channel plugin — stub for future implementation",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setWeChatMPRuntime(api.runtime);
    api.registerChannel({ plugin: createWeChatMPPlugin() });
  },
};

export default plugin;
