import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { A2A_BROKER_ADAPTER_PLUGIN_ID } from "./api.js";
import {
  handleA2ATaskCancel,
  handleA2ATaskRequest,
  handleA2ATaskStatus,
  handleA2ATaskUpdate,
} from "./src/gateway-handlers.js";

export default definePluginEntry({
  id: A2A_BROKER_ADAPTER_PLUGIN_ID,
  name: "A2A Broker Adapter",
  description: "Standalone A2A broker gateway method registration and broker routing",
  register(api: OpenClawPluginApi) {
    // ── Config migration: auto-enable if existing A2A config detected ──
    // Ensures environments that already had baseUrl configured continue
    // to work after core a2a.task.* methods are removed.
    api.registerConfigMigration((config) => {
      const entry = config.plugins?.entries?.["a2a-broker-adapter"];
      if (entry?.config && entry.enabled !== false && entry.enabled !== true) {
        const migrated = structuredClone(config);
        const entries = { ...migrated.plugins?.entries };
        entries["a2a-broker-adapter"] = {
          ...entries["a2a-broker-adapter"],
          enabled: true,
        };
        migrated.plugins = { ...migrated.plugins, entries };
        return {
          config: migrated,
          changes: ["a2a-broker-adapter: auto-enabled (existing config detected)"],
        };
      }
      return null;
    });

    // ── Gateway method registration (ownership from core) ──
    // Scopes match the original core classification:
    //   a2a.task.status  → operator.read
    //   a2a.task.request → operator.write
    //   a2a.task.update  → operator.write
    //   a2a.task.cancel  → operator.write
    api.registerGatewayMethod("a2a.task.request", handleA2ATaskRequest, {
      scope: "operator.write",
    });
    api.registerGatewayMethod("a2a.task.update", handleA2ATaskUpdate, {
      scope: "operator.write",
    });
    api.registerGatewayMethod("a2a.task.cancel", handleA2ATaskCancel, {
      scope: "operator.write",
    });
    api.registerGatewayMethod("a2a.task.status", handleA2ATaskStatus, {
      scope: "operator.read",
    });
  },
});
