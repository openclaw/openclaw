/** Fleet registry — loads fleet.json, provides node/service/capability lookups. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FleetConfig, FleetNodeConfig, FleetServiceConfig } from "./types.js";

let cachedConfig: FleetConfig | null = null;

export function loadFleetConfig(configPath?: string): FleetConfig {
	if (cachedConfig) return cachedConfig;

	const path = configPath || resolve(process.cwd(), "config/fleet.json");
	const raw = readFileSync(path, "utf-8");
	cachedConfig = JSON.parse(raw) as FleetConfig;
	return cachedConfig;
}

export function reloadFleetConfig(configPath?: string): FleetConfig {
	cachedConfig = null;
	return loadFleetConfig(configPath);
}

export function getActiveNodes(config: FleetConfig): Record<string, FleetNodeConfig> {
	return Object.fromEntries(
		Object.entries(config.nodes).filter(([, node]) => node.active !== false),
	);
}

export function getNodeByRole(config: FleetConfig, role: string): FleetNodeConfig[] {
	return Object.values(getActiveNodes(config)).filter((n) => n.roles.includes(role));
}

export function getNodeByCapability(config: FleetConfig, capability: string): FleetNodeConfig[] {
	return Object.values(getActiveNodes(config)).filter((n) => n.capabilities.includes(capability));
}

export function getNodeService(config: FleetConfig, nodeName: string, serviceName: string): FleetServiceConfig | null {
	const node = config.nodes[nodeName];
	return node?.services?.[serviceName] ?? null;
}

export function getServiceUrl(node: FleetNodeConfig, service: FleetServiceConfig): string {
	const protocol = service.healthProtocol === "tcp" ? "tcp" : "http";
	return `${protocol}://${node.tailscaleIp}:${service.port}`;
}

/** Check if a node is within its preferred scheduling window. */
export function isNodePreferred(node: FleetNodeConfig): boolean {
	if (!node.scheduling?.availableHours) return true;

	const tz = node.scheduling.timezone || "America/Chicago";
	const now = new Date();
	const hour = Number(
		new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(now),
	);

	return node.scheduling.availableHours.includes(hour);
}
