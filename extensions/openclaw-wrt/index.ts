import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createClawWRTPluginConfigSchema, resolveClawWRTConfig } from "./src/config.js";
import { ClawWRTBridge } from "./src/manager.js";
import { createClawWRTTools } from "./src/tool.js";

export default definePluginEntry({
  id: "openclaw-wrt",
  name: "OpenClaw WRT",
  description:
    "List and inspect online OpenWrt or wireless router devices, publish captive portal HTML pages, and send management requests to connected routers over WebSocket.",
  configSchema: () => {
    const schema = createClawWRTPluginConfigSchema();
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
    const config = resolveClawWRTConfig(api.pluginConfig);
    const bridge = ClawWRTBridge.getOrCreate({ config, logger: api.logger });

    api.registerService({
      id: "openclaw-wrt-bridge",
      async start() {
        await bridge.start();
      },
      async stop() {
        await bridge.stop();
      },
    });

    api.registerTool(() => createClawWRTTools({ bridge }));
  },
});

// Public API exports (re-exported from api.ts barrel)
export { ClawWRTBridge, type DeviceSnapshot } from "./src/manager.js";
export { createClawWRTTools } from "./src/tool.js";
export {
  createClawWRTPluginConfigSchema,
  resolveClawWRTConfig,
  type ResolvedClawWRTConfig,
} from "./src/config.js";
