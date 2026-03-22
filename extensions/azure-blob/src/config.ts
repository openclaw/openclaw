import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/config-runtime";
import { normalizeSecretInput } from "openclaw/plugin-sdk/provider-auth";

type PluginEntryConfig = {
  connectionString?: unknown;
  accountName?: string;
  accountKey?: unknown;
  accountUrl?: string;
  defaultContainer?: string;
} | null;

export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
export const HARD_MAX_BYTES = 20 * 1024 * 1024;

function pluginConfigFromOpenClaw(cfg?: OpenClawConfig): PluginEntryConfig {
  const raw = cfg?.plugins?.entries?.["azure-blob"]?.config;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as PluginEntryConfig;
}

function normalizeConfiguredSecret(value: unknown, path: string): string | undefined {
  return normalizeSecretInput(
    normalizeResolvedSecretInputString({
      value,
      path,
    }),
  );
}

export function resolveAzureBlobConnectionString(cfg?: OpenClawConfig): string | undefined {
  const plugin = pluginConfigFromOpenClaw(cfg);
  return (
    normalizeConfiguredSecret(
      plugin?.connectionString,
      "plugins.entries.azure-blob.config.connectionString",
    ) ||
    normalizeSecretInput(process.env.AZURE_STORAGE_CONNECTION_STRING) ||
    undefined
  );
}

export function resolveAzureBlobAccountName(cfg?: OpenClawConfig): string | undefined {
  const plugin = pluginConfigFromOpenClaw(cfg);
  const fromConfig = typeof plugin?.accountName === "string" ? plugin.accountName.trim() : "";
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = normalizeSecretInput(process.env.AZURE_STORAGE_ACCOUNT_NAME);
  return fromEnv?.trim() || undefined;
}

export function resolveAzureBlobAccountKey(cfg?: OpenClawConfig): string | undefined {
  const plugin = pluginConfigFromOpenClaw(cfg);
  return (
    normalizeConfiguredSecret(plugin?.accountKey, "plugins.entries.azure-blob.config.accountKey") ||
    normalizeSecretInput(process.env.AZURE_STORAGE_ACCOUNT_KEY) ||
    undefined
  );
}

export function resolveAzureBlobAccountUrl(cfg?: OpenClawConfig): string | undefined {
  const plugin = pluginConfigFromOpenClaw(cfg);
  const fromConfig = typeof plugin?.accountUrl === "string" ? plugin.accountUrl.trim() : "";
  if (fromConfig) {
    return fromConfig.replace(/\/+$/, "");
  }
  const fromEnv = normalizeSecretInput(process.env.AZURE_STORAGE_ACCOUNT_URL);
  return fromEnv?.trim().replace(/\/+$/, "") || undefined;
}

export function resolveAzureBlobDefaultContainer(cfg?: OpenClawConfig): string | undefined {
  const plugin = pluginConfigFromOpenClaw(cfg);
  const fromConfig =
    typeof plugin?.defaultContainer === "string" ? plugin.defaultContainer.trim() : "";
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = normalizeSecretInput(process.env.AZURE_STORAGE_DEFAULT_CONTAINER);
  return fromEnv?.trim() || undefined;
}

export function clampMaxBytes(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_MAX_BYTES;
  }
  const floor = Math.floor(requested);
  return Math.min(Math.max(floor, 1), HARD_MAX_BYTES);
}
