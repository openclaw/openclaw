import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ConnectorConfig } from "./types.js";

export type ConnectorConfigInput = ConnectorConfig & {
  /** Built-in connector id: echo | rest-poll | mqtt | opcua | modbus */
  preset?: string;
};

export function resolveClaworksRoot(): string {
  const envRoot = process.env.CLAWORKS_ROOT?.trim();
  if (envRoot && existsSync(envRoot)) {
    return envRoot;
  }
  const cwd = process.cwd();
  if (existsSync(join(cwd, "connectors"))) {
    return cwd;
  }
  return cwd;
}

function presetPath(root: string, ...parts: string[]): string {
  return join(root, "connectors", ...parts);
}

export function getConnectorPreset(
  preset: string,
  claworksRoot = resolveClaworksRoot(),
): ConnectorConfig | null {
  const root = claworksRoot;
  switch (preset) {
    case "echo":
      return {
        command: process.execPath,
        args: [presetPath(root, "echo", "echo-bridge.mjs")],
      };
    case "rest-poll":
      return {
        command: process.execPath,
        args: [presetPath(root, "rest-poll", "rest-poll-bridge.mjs")],
      };
    case "mqtt":
      return {
        command: process.execPath,
        args: [presetPath(root, "mqtt", "mqtt-bridge.mjs")],
        env: { CLAWORKS_MQTT_SIMULATE: "1" },
      };
    case "opcua":
      return {
        command: process.env.CLAWORKS_PYTHON ?? "python3",
        args: [presetPath(root, "opcua", "opcua-bridge.py")],
        env: { CLAWORKS_OPCUA_SIMULATE: "1" },
      };
    case "modbus":
      return {
        command: process.env.CLAWORKS_PYTHON ?? "python3",
        args: [presetPath(root, "modbus", "modbus-bridge.py")],
        env: { CLAWORKS_MODBUS_SIMULATE: "1" },
      };
    default:
      return null;
  }
}

export function resolveConnectorConfigs(
  connectors: Record<string, ConnectorConfigInput> | undefined,
  claworksRoot = resolveClaworksRoot(),
): Record<string, ConnectorConfig> {
  const resolved: Record<string, ConnectorConfig> = {};
  for (const [id, raw] of Object.entries(connectors ?? {})) {
    const preset = raw.preset ? getConnectorPreset(raw.preset, claworksRoot) : null;
    if (raw.preset && !preset) {
      throw new Error(`Unknown connector preset: ${raw.preset}`);
    }
    const { preset: _presetKey, ...rest } = raw;
    resolved[id] = {
      ...preset,
      ...rest,
      command: rest.command ?? preset?.command ?? "",
      args: rest.args ?? preset?.args,
      env: { ...preset?.env, ...rest.env },
    };
    if (!resolved[id].command) {
      throw new Error(`Connector ${id} missing command`);
    }
  }
  return resolved;
}
