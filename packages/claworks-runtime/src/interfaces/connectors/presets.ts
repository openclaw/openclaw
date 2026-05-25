import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ConnectorConfig } from "./types.js";

export type ConnectorConfigInput = Omit<ConnectorConfig, "command"> & {
  /** Built-in connector id: echo | rest-poll | mqtt | opcua | modbus | filesystem-kb */
  preset?: string;
  /**
   * 模拟模式（开发/测试用）。
   * true → 自动使用 <preset>-simulate 变体（如 mqtt-simulate），
   * 发送内置仿真事件而不连接真实 OT 设备。
   * 生产环境应省略或设为 false。
   */
  simulate?: boolean;
  /** 连接器命令（当 preset 存在时可省略，由 preset resolver 填充） */
  command?: string;
  /** 特定连接器所需的应用 ID（如飞书 App ID） */
  app_id?: string;
  /** 任意扩展配置（供自定义连接器使用） */
  [key: string]: unknown;
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
        // 模拟模式由调用方通过 simulate: true 或环境变量 CLAWORKS_MQTT_SIMULATE=1 控制
      };
    case "mqtt-simulate":
      return {
        command: process.execPath,
        args: [presetPath(root, "mqtt", "mqtt-bridge.mjs")],
        env: { CLAWORKS_MQTT_SIMULATE: "1" },
      };
    case "opcua":
      return {
        command: process.env.CLAWORKS_PYTHON ?? "python3",
        args: [presetPath(root, "opcua", "opcua-bridge.py")],
        // 模拟模式由调用方通过 simulate: true 或环境变量 CLAWORKS_OPCUA_SIMULATE=1 控制
      };
    case "opcua-simulate":
      return {
        command: process.env.CLAWORKS_PYTHON ?? "python3",
        args: [presetPath(root, "opcua", "opcua-bridge.py")],
        env: { CLAWORKS_OPCUA_SIMULATE: "1" },
      };
    case "modbus":
      return {
        command: process.env.CLAWORKS_PYTHON ?? "python3",
        args: [presetPath(root, "modbus", "modbus-bridge.py")],
        // 模拟模式由调用方通过 simulate: true 或环境变量 CLAWORKS_MODBUS_SIMULATE=1 控制
      };
    case "modbus-simulate":
      return {
        command: process.env.CLAWORKS_PYTHON ?? "python3",
        args: [presetPath(root, "modbus", "modbus-bridge.py")],
        env: { CLAWORKS_MODBUS_SIMULATE: "1" },
      };
    case "database-poll":
      return {
        command: process.execPath,
        args: [presetPath(root, "database-poll", "database-poll-bridge.mjs")],
      };
    case "filesystem-kb":
      return {
        command: process.execPath,
        args: [presetPath(root, "filesystem-kb", "filesystem-kb-bridge.mjs")],
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
    // simulate: true → 自动使用 <preset>-simulate 变体（不污染生产路径）
    const effectivePreset =
      raw.preset && raw.simulate === true ? `${raw.preset}-simulate` : raw.preset;
    const preset = effectivePreset ? getConnectorPreset(effectivePreset, claworksRoot) : null;
    if (effectivePreset && !preset) {
      // 回退到不带 -simulate 后缀的 preset（未知变体兜底）
      const fallback = raw.preset ? getConnectorPreset(raw.preset, claworksRoot) : null;
      if (!fallback) {
        throw new Error(`Unknown connector preset: ${effectivePreset}`);
      }
      const { preset: _presetKey, simulate: _simulate, ...rest } = raw;
      resolved[id] = {
        ...fallback,
        ...rest,
        command: rest.command ?? fallback.command ?? "",
        args: rest.args ?? fallback.args,
        env: { ...fallback.env, ...rest.env },
      };
    } else {
      const { preset: _presetKey, simulate: _simulate, ...rest } = raw;
      resolved[id] = {
        ...preset,
        ...rest,
        command: rest.command ?? preset?.command ?? "",
        args: rest.args ?? preset?.args,
        env: { ...preset?.env, ...rest.env },
      };
    }
    if (!resolved[id].command) {
      throw new Error(`Connector ${id} missing command`);
    }
  }
  return resolved;
}
