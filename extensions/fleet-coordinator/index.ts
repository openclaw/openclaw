import { Type } from "@sinclair/typebox";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { loadFleetConfig, getActiveNodes, isNodePreferred } from "./fleet-registry.js";
import {
  startHealthMonitor,
  stopHealthMonitor,
  runHealthCheck,
  getCachedHealth,
} from "./health-monitor.js";
import { registerFleetGuard } from "./hooks/fleet-guard.js";
import { startService, stopService } from "./service-lifecycle.js";
import { getRecommendation } from "./task-router.js";
import type { FleetConfig } from "./types.js";

export default definePluginEntry({
  id: "fleet-coordinator",
  name: "Fleet Coordinator",
  description: "Multi-node fleet registry, health monitoring, task routing, and guard hooks",
  register(api) {
    const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
    const configPath = pluginConfig?.fleetConfigPath as string | undefined;
    const healthInterval = (pluginConfig?.healthCheckIntervalMs as number) || 60000;

    let config: FleetConfig;
    try {
      config = loadFleetConfig(configPath);
    } catch (err) {
      api.logger.warn(`Fleet config not loaded: ${err}. Fleet tools will be unavailable.`);
      return;
    }

    // Start health monitor
    startHealthMonitor(config, healthInterval);
    api.on("gateway_stop", async () => stopHealthMonitor());

    // Register tools
    api.registerTool({
      name: "fleet_nodes",
      description: "List all active fleet nodes with roles, capabilities, and health status.",
      parameters: Type.Object({}),
      execute: async () => {
        const nodes = getActiveNodes(config);
        const health = getCachedHealth();
        const result = Object.entries(nodes).map(([name, node]) => ({
          name,
          displayName: node.name,
          ip: node.tailscaleIp,
          roles: node.roles,
          capabilities: node.capabilities,
          preferred: isNodePreferred(node),
          health: health.get(name) || null,
        }));
        return jsonResult(result);
      },
    } as unknown as AnyAgentTool);

    api.registerTool({
      name: "fleet_health",
      description:
        "Run a full health check across all fleet nodes and services. Returns live results.",
      parameters: Type.Object({}),
      execute: async () => {
        const results = await runHealthCheck(config);
        return jsonResult(Object.fromEntries(results));
      },
    } as unknown as AnyAgentTool);

    api.registerTool({
      name: "fleet_recommendation",
      description:
        "Get the best node for a task type. Considers VRAM, load, scheduling, and routing rules.",
      parameters: Type.Object({
        taskType: Type.String({
          description: "Task type (e.g. coding_project, gpu_work, docker_ops)",
        }),
        explicitNode: Type.Optional(
          Type.String({ description: "Force a specific node (overrides routing)" }),
        ),
      }),
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const taskType = rawParams.taskType as string;
        const explicitNode = rawParams.explicitNode as string | undefined;
        return jsonResult(getRecommendation(taskType, config, explicitNode));
      },
    } as unknown as AnyAgentTool);

    api.registerTool({
      name: "fleet_service_start",
      description: "Start an on-demand service on a fleet node (e.g. art pipeline on Kubuntu).",
      parameters: Type.Object({
        node: Type.String({ description: "Node name" }),
        service: Type.String({ description: "Service name from fleet.json" }),
      }),
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const node = rawParams.node as string;
        const service = rawParams.service as string;
        return jsonResult(await startService(config, node, service));
      },
    } as unknown as AnyAgentTool);

    api.registerTool({
      name: "fleet_service_stop",
      description: "Stop an on-demand service on a fleet node, releasing resources.",
      parameters: Type.Object({
        node: Type.String({ description: "Node name" }),
        service: Type.String({ description: "Service name" }),
      }),
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const node = rawParams.node as string;
        const service = rawParams.service as string;
        return jsonResult(await stopService(config, node, service));
      },
    } as unknown as AnyAgentTool);

    // Register guard hooks
    registerFleetGuard(api);

    api.logger.info(
      `fleet-coordinator loaded: ${Object.keys(getActiveNodes(config)).length} active nodes, 5 tools, guard hooks`,
    );
  },
});
