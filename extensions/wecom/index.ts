/**
 * Author: YanHaidao
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { wecomPlugin } from "./src/channel.js";
import { handleWecomWebhookRequest } from "./src/monitor.js";
import { setWecomRuntime } from "./src/runtime.js";

const plugin = {
  id: "wecom",
  name: "WeCom",
  description: "OpenClaw WeCom (WeChat Work) intelligent bot channel plugin",
  configSchema: emptyPluginConfigSchema(),
  /**
   * **register (注册插件)**
   *
   * OpenClaw 插件入口点。
   * 1. 注入 Runtime 环境 (api.runtime)。
   * 2. 注册 WeCom 渠道插件 (ChannelPlugin)。
   * 3. 注册 Webhook HTTP 处理器 (handleWecomWebhookRequest)。
   */
  register(api: OpenClawPluginApi) {
    setWecomRuntime(api.runtime);
    api.registerChannel({ plugin: wecomPlugin });
    api.registerHttpHandler(handleWecomWebhookRequest);
  },
};

export default plugin;
