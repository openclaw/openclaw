import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HealthCheck, PluginRuntimeMaintenanceContextV1 } from "openclaw/plugin-sdk/health";
import { createCodexRuntimeMaintenanceChecks } from "./src/runtime-maintenance.js";

/** Explicit install/update only; ordinary discovery and turns never download a runtime. */
export function createPluginRuntimeMaintenanceChecksV1(
  context: PluginRuntimeMaintenanceContextV1,
): readonly HealthCheck[] {
  return createCodexRuntimeMaintenanceChecks({
    ...context,
    pluginRoot: path.dirname(fileURLToPath(import.meta.url)),
  });
}
