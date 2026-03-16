/**
 * Central hook registration for the observe-only probe plugin.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { TelemetryCollector } from "../telemetry/collector.js";
import { registerModelHooks } from "./model-hooks.js";
import { registerSessionHooks } from "./session-hooks.js";
import { registerToolHooks } from "./tool-hooks.js";

export function registerAllHooks(api: OpenClawPluginApi, collector: TelemetryCollector): void {
  registerSessionHooks(api, collector);
  registerToolHooks(api, collector);
  registerModelHooks(api, collector);
}
