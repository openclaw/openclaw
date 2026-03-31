import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createApFreeWifidogPluginConfigSchema, resolveApFreeWifidogConfig } from "./src/config.js";
import { ApFreeWifidogBridge } from "./src/manager.js";
import { createApFreeWifidogTools } from "./src/tool.js";

export default definePluginEntry({
  id: "apfree-wifidog",
  name: "ApFree WiFiDog",
  description: "Bridge apfree-wifidog devices into OpenClaw over WebSocket.",
  configSchema: () => {
    const schema = createApFreeWifidogPluginConfigSchema();
    schema.uiHints = {
      enabled: { label: "Enable bridge" },
      bind: { label: "Bind address", advanced: true },
      port: { label: "Bridge port" },
      path: { label: "WebSocket path" },
      allowDeviceIds: {
        label: "Allowed device IDs",
        help: "Optional allowlist. Leave empty to accept any device_id.",
      },
      requestTimeoutMs: { label: "Default request timeout (ms)", advanced: true },
      maxPayloadBytes: { label: "Max payload bytes", advanced: true },
      token: {
        label: "Device authentication token",
        help: "Optional shared secret. If set, routers must provide this token in their connect message.",
        advanced: true,
      },
      awasEnabled: { label: "Enable AWAS auth proxy" },
      awasHost: { label: "AWAS server hostname" },
      awasPort: { label: "AWAS server port" },
      awasPath: { label: "AWAS WebSocket path" },
      awasSsl: { label: "Use TLS (wss://)", advanced: true },
    };
    return schema;
  },
  register(api) {
    const config = resolveApFreeWifidogConfig(api.pluginConfig);
    const bridge = ApFreeWifidogBridge.getOrCreate({ config, logger: api.logger });

    api.registerService({
      id: "apfree-wifidog-bridge",
      async start() {
        await bridge.start();
      },
      async stop() {
        await bridge.stop();
      },
    });

    api.registerTool(() => createApFreeWifidogTools({ bridge }));
  },
});
