import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { loadFleetConfig, getActiveNodes, isNodePreferred } from "./fleet-registry.js";
import { startHealthMonitor, stopHealthMonitor, runHealthCheck, getCachedHealth } from "./health-monitor.js";
import { getRecommendation } from "./task-router.js";
import { startService, stopService } from "./service-lifecycle.js";
import { registerFleetGuard } from "./hooks/fleet-guard.js";
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
			input: Type.Object({}),
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
				return result;
			},
		});

		api.registerTool({
			name: "fleet_health",
			description: "Run a full health check across all fleet nodes and services. Returns live results.",
			input: Type.Object({}),
			execute: async () => {
				const results = await runHealthCheck(config);
				return Object.fromEntries(results);
			},
		});

		api.registerTool({
			name: "fleet_recommendation",
			description: "Get the best node for a task type. Considers VRAM, load, scheduling, and routing rules.",
			input: Type.Object({
				taskType: Type.String({ description: "Task type (e.g. coding_project, gpu_work, docker_ops)" }),
				explicitNode: Type.Optional(Type.String({ description: "Force a specific node (overrides routing)" })),
			}),
			execute: async (args) => {
				const { taskType, explicitNode } = args as { taskType: string; explicitNode?: string };
				return getRecommendation(taskType, config, explicitNode);
			},
		});

		api.registerTool({
			name: "fleet_service_start",
			description: "Start an on-demand service on a fleet node (e.g. art pipeline on Kubuntu).",
			input: Type.Object({
				node: Type.String({ description: "Node name" }),
				service: Type.String({ description: "Service name from fleet.json" }),
			}),
			execute: async (args) => {
				const { node, service } = args as { node: string; service: string };
				return startService(config, node, service);
			},
		});

		api.registerTool({
			name: "fleet_service_stop",
			description: "Stop an on-demand service on a fleet node, releasing resources.",
			input: Type.Object({
				node: Type.String({ description: "Node name" }),
				service: Type.String({ description: "Service name" }),
			}),
			execute: async (args) => {
				const { node, service } = args as { node: string; service: string };
				return stopService(config, node, service);
			},
		});

		// Register guard hooks
		registerFleetGuard(api);

		api.logger.info(`fleet-coordinator loaded: ${Object.keys(getActiveNodes(config)).length} active nodes, 5 tools, guard hooks`);
	},
});
