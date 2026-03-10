import type { OpenClawPluginApi } from "openclaw/plugin-sdk/mqtt-hooks";
import { createMqttHooksPluginConfigSchema, resolveMqttHooksPluginConfig } from "./src/config.js";
import { createMqttHooksService } from "./src/service.js";

const pluginConfigSchema = createMqttHooksPluginConfigSchema();

const mqttHooksPlugin = {
  id: "mqtt-hooks",
  name: "MQTT Hooks",
  description: "Consume MQTT events and route them through OpenClaw ingress actions.",
  configSchema: pluginConfigSchema,
  register(api: OpenClawPluginApi) {
    const pluginConfig = resolveMqttHooksPluginConfig(api.pluginConfig);
    api.registerService(
      createMqttHooksService({
        pluginConfig,
      }),
    );
  },
};

export default mqttHooksPlugin;
