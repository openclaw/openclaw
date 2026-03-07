/**
 * OpenClaw DingTalk Channel Plugin
 * 钉钉渠道插件入口
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/dingtalk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/dingtalk";
import { dingtalkPlugin } from "./src/channel.js";
import { setDingtalkRuntime } from "./src/runtime.js";
import { registerDingtalkTools } from "./src/tools.js";

const plugin = {
  id: "dingtalk",
  name: "DingTalk",
  description: "钉钉消息渠道插件",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    if (api.runtime) {
      setDingtalkRuntime(api.runtime as Record<string, unknown>);
    }
    api.registerChannel({ plugin: dingtalkPlugin });
    registerDingtalkTools(api);
  },
};

export default plugin;

export { dingtalkPlugin } from "./src/channel.js";
export { setDingtalkRuntime, getDingtalkRuntime } from "./src/runtime.js";
