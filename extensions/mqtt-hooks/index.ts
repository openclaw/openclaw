import type { OpenClawPluginApi } from "openclaw/plugin-sdk/mqtt-hooks";
import { createMqttHooksPluginConfigSchema } from "./src/config.js";
import { createMqttHooksService } from "./src/service.js";
import type { ResolvedMqttHooksPluginConfig } from "./src/types.js";

const mqttHooksPlugin = {
  id: "mqtt-hooks",
  name: "MQTT Hooks",
  description: "Consume MQTT events and route them through OpenClaw ingress actions.",
  configSchema: createMqttHooksPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(
      createMqttHooksService({
        pluginConfig: api.pluginConfig as ResolvedMqttHooksPluginConfig,
      }),
    );
  },
};

export default mqttHooksPlugin;
