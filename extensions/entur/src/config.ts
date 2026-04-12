import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export const DEFAULT_CLIENT_NAME = "openclaw-entur";
export const DEFAULT_NUM_DEPARTURES = 10;
export const DEFAULT_TIMEOUT_MS = 15_000;

export type EnturPluginConfig = {
  clientName: string;
  defaultStopId: string | undefined;
  defaultNumDepartures: number;
  defaultTransportModes: string[] | undefined;
};

type PluginEntryConfig = {
  clientName?: string;
  defaultStopId?: string;
  defaultNumDepartures?: number;
  defaultTransportModes?: string[];
};

export function resolveEnturConfig(cfg?: OpenClawConfig): EnturPluginConfig {
  const pluginConfig = cfg?.plugins?.entries?.entur?.config as PluginEntryConfig | undefined;
  return {
    clientName: pluginConfig?.clientName || DEFAULT_CLIENT_NAME,
    defaultStopId: pluginConfig?.defaultStopId || undefined,
    defaultNumDepartures: pluginConfig?.defaultNumDepartures || DEFAULT_NUM_DEPARTURES,
    defaultTransportModes: pluginConfig?.defaultTransportModes || undefined,
  };
}
