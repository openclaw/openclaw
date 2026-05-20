import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

export type GesahniBuilderConfig = {
  baseUrl: string;
  readBridgeToken: string;
  writeBridgeToken: string;
};

function readConfiguredString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeBaseUrl(value: string): string {
  return trimTrailingSlash(value);
}

export function resolveGesahniBuilderConfig(
  api: Pick<OpenClawPluginApi, "pluginConfig">,
): GesahniBuilderConfig {
  const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const baseUrl =
    readConfiguredString(pluginConfig.baseUrl) ??
    readConfiguredString(process.env.GESAHNI_BASE_URL);
  const readBridgeToken =
    readConfiguredString(pluginConfig.readBridgeToken) ??
    readConfiguredString(process.env.GESAHNI_READ_BRIDGE_TOKEN);
  const writeBridgeToken =
    readConfiguredString(pluginConfig.writeBridgeToken) ??
    readConfiguredString(process.env.GESAHNI_WRITE_BRIDGE_TOKEN);

  if (!baseUrl) {
    throw new Error(
      "Gesahni Builder requires a base URL (plugins.entries.gesahni-builder.config.baseUrl or GESAHNI_BASE_URL)",
    );
  }
  if (!readBridgeToken) {
    throw new Error(
      "Gesahni Builder requires a read bridge token (plugins.entries.gesahni-builder.config.readBridgeToken or GESAHNI_READ_BRIDGE_TOKEN)",
    );
  }
  if (!writeBridgeToken) {
    throw new Error(
      "Gesahni Builder requires a write bridge token (plugins.entries.gesahni-builder.config.writeBridgeToken or GESAHNI_WRITE_BRIDGE_TOKEN)",
    );
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    readBridgeToken,
    writeBridgeToken,
  };
}
