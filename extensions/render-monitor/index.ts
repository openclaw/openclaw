import { definePluginEntry } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { renderMonitorConfigSchema } from "./src/config.js";
import { createRenderMonitorService } from "./src/service.js";
import { registerRenderMonitorCommands } from "./src/commands.js";
import { createVpsMonitorService } from "./src/vps-monitor.js";

export default definePluginEntry({
  id: "render-monitor",
  name: "Render Monitor",
  description: "Detect Render incidents, alert via Telegram, and enable investigation/remediation with approval.",
  // The OpenClaw plugin-config schema surface is intentionally flexible; we cast
  // to keep TypeScript happy with our TypeBox schema typing.
  configSchema: renderMonitorConfigSchema as any,
  register(api: OpenClawPluginApi) {
    api.registerService(createRenderMonitorService(api));
    api.registerService(createVpsMonitorService(api));
    registerRenderMonitorCommands(api);
  },
});

