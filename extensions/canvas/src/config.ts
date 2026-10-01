import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { isTruthyEnvValue } from "openclaw/plugin-sdk/runtime-env";
import { asBoolean as readBoolean, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type CanvasHostConfig = {
  enabled?: boolean;
};

export type CanvasPluginConfig = {
  host?: CanvasHostConfig;
};

export function parseCanvasPluginConfig(value: unknown): CanvasPluginConfig {
  if (!isRecord(value) || !isRecord(value.host)) {
    return {};
  }
  const enabled = readBoolean(value.host.enabled);
  return { host: enabled === undefined ? {} : { enabled } };
}

export function resolveCanvasHostConfig(params: {
  config?: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
}): CanvasHostConfig {
  const pluginConfig =
    params.pluginConfig ?? resolvePluginConfigObject(params.config, "canvas") ?? {};
  const parsedPluginConfig = parseCanvasPluginConfig(pluginConfig);
  return parsedPluginConfig.host ?? {};
}

export function isCanvasHostEnabled(config?: OpenClawConfig): boolean {
  if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_CANVAS_HOST)) {
    return false;
  }
  return resolveCanvasHostConfig({ config }).enabled !== false;
}

export const canvasConfigSchema = {
  parse: parseCanvasPluginConfig,
};
