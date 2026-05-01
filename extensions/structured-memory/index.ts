import { definePluginEntry } from "./api.js";
import { configSchema, resolveStructuredMemoryConfig } from "./src/config.js";
import { closeAllDatabases } from "./src/db.js";
import { runSessionMaintenance, runFullMaintenanceCycle } from "./src/maintenance.js";
import { createStructuredMemorySupplement } from "./src/supplement.js";
import {
  createMemoryRecordAddTool,
  createMemoryRecordFindTool,
  createMemoryRecordArchiveTool,
} from "./src/tools.js";

export default definePluginEntry({
  id: "structured-memory",
  name: "Structured Memory",
  description:
    "Structured typed memory records with importance scoring and Weibull time-based decay.",
  configSchema,
  register(api) {
    const config = resolveStructuredMemoryConfig(api.pluginConfig);
    if (!config.enabled) return;

    api.registerTool(createMemoryRecordAddTool(config, api), {
      name: "memory_record_add",
    });
    api.registerTool(createMemoryRecordFindTool(config), {
      name: "memory_record_find",
    });
    api.registerTool(createMemoryRecordArchiveTool(config), {
      name: "memory_record_archive",
    });

    api.registerMemoryCorpusSupplement(createStructuredMemorySupplement({ config }));

    api.on("agent_end", async (_event, ctx) => {
      try {
        const agentId = ctx.agentId ?? "main";
        await runSessionMaintenance({ agentId, config });
      } catch {
        // silent: maintenance does not affect main flow
      }
    });

    let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
    api.on("gateway_start", async () => {
      const intervalMs = 60 * 60 * 1000;
      maintenanceTimer = setInterval(async () => {
        try {
          await runFullMaintenanceCycle({ config, api });
        } catch {
          // silent
        }
      }, intervalMs);
      if (maintenanceTimer && typeof maintenanceTimer.unref === "function") {
        maintenanceTimer.unref();
      }
    });
    api.on("gateway_stop", () => {
      if (maintenanceTimer) {
        clearInterval(maintenanceTimer);
        maintenanceTimer = null;
      }
      closeAllDatabases();
    });
  },
});
