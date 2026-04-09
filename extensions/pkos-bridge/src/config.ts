import type { OpenClawPluginConfigSchema } from "../api.js";

type RawPkosBridgeConfig = {
  pkosRoot?: string;
  workbenchRoot?: string;
  traceBundleRoot?: string;
  guidance?: {
    enabled?: boolean;
  };
  http?: {
    basePath?: string;
  };
};

export type ResolvedPkosBridgeConfig = {
  pkosRoot?: string;
  workbenchRoot?: string;
  traceBundleRoot?: string;
  guidance: {
    enabled: boolean;
  };
  http: {
    basePath: string;
  };
};

export const pkosBridgeConfigSchema: OpenClawPluginConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    pkosRoot: { type: "string" },
    workbenchRoot: { type: "string" },
    traceBundleRoot: { type: "string" },
    guidance: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
      },
    },
    http: {
      type: "object",
      additionalProperties: false,
      properties: {
        basePath: { type: "string", default: "/plugins/pkos-bridge" },
      },
    },
  },
};

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBasePath(value: unknown): string {
  const normalized = normalizeNonEmptyString(value) ?? "/plugins/pkos-bridge";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function resolvePkosBridgeConfig(pluginConfig: unknown): ResolvedPkosBridgeConfig {
  const raw = (pluginConfig ?? {}) as RawPkosBridgeConfig;

  return {
    pkosRoot: normalizeNonEmptyString(raw.pkosRoot),
    workbenchRoot: normalizeNonEmptyString(raw.workbenchRoot),
    traceBundleRoot: normalizeNonEmptyString(raw.traceBundleRoot),
    guidance: {
      enabled: raw.guidance?.enabled !== false,
    },
    http: {
      basePath: normalizeBasePath(raw.http?.basePath),
    },
  };
}
