import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { homeAssistantConfigSchema } from "./config-schema.js";
import { registerHomeAssistantPlugin } from "./register.runtime.js";

export default definePluginEntry({
  id: "home-assistant",
  name: "Home Assistant",
  description: "WebSocket bridge from OpenClaw to Home Assistant. Powers the kiosk dashboard view.",
  configSchema: homeAssistantConfigSchema,
  register(api) {
    return registerHomeAssistantPlugin(api);
  },
});
