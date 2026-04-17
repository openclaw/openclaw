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
    // ── Config migration: preserve explicit activation for existing A2A config ──
    // Environments that already set broker config should keep working after
    // core a2a.task.* ownership moves behind the plugin gate.
    api.registerConfigMigration((config) => {
      const entry = config.plugins?.entries?.[A2A_BROKER_ADAPTER_PLUGIN_ID];
      if (!entry?.config || entry.enabled === false) {
        return null;
      }

      const allow = config.plugins?.allow;
      const shouldEnable = entry.enabled !== true;
      const shouldAllowlist =
        Array.isArray(allow) && !allow.includes(A2A_BROKER_ADAPTER_PLUGIN_ID);
      if (!shouldEnable && !shouldAllowlist) {
        return null;
      }

      const migrated = structuredClone(config);
      const plugins = { ...(migrated.plugins ?? {}) };
      const entries = { ...(plugins.entries ?? {}) };
      entries[A2A_BROKER_ADAPTER_PLUGIN_ID] = {
        ...entries[A2A_BROKER_ADAPTER_PLUGIN_ID],
        enabled: true,
      };
      plugins.entries = entries;
      if (shouldAllowlist) {
        plugins.allow = [...allow, A2A_BROKER_ADAPTER_PLUGIN_ID];
      }
      migrated.plugins = plugins;

      const changes: string[] = [];
      if (shouldEnable) {
        changes.push("a2a-broker-adapter: auto-enabled (existing config detected)");
      }
      if (shouldAllowlist) {
        changes.push("a2a-broker-adapter: added to plugins.allow (existing config detected)");
      }
      return {
        config: migrated,
        changes,
      };
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
