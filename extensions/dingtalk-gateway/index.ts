import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { dingtalkGatewayPlugin } from "./src/channel.js";
import { setDingTalkGatewayRuntime } from "./src/runtime.js";

const plugin = {
  id: "dingtalk-gateway",
  name: "DingTalk Gateway",
  description: "DingTalk Gateway channel plugin (Kafka-based)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setDingTalkGatewayRuntime(api.runtime);
    api.registerChannel({ plugin: dingtalkGatewayPlugin });
  },
};

export default plugin;
