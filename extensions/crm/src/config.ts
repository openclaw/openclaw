import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";
import { resolveReadOnlyEnvSecretRef } from "openclaw/plugin-sdk/secret-ref-readonly";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_BASE_URL = "http://localhost:3001";
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const CRM_API_KEY_ENV_VAR = "CRM_API_KEY";

export const CRM_API_KEY_CONFIG_PATH = "plugins.entries.crm.config.apiKey";

export type CrmConfig = {
  baseUrl: string;
  apiKey: string;
  timeoutSeconds: number;
};

export type CrmToolConfigContext = Pick<
  OpenClawPluginToolContext,
  "config" | "runtimeConfig" | "getRuntimeConfig"
>;

function crmConfigRecord(cfg?: OpenClawConfig): Record<string, unknown> | undefined {
  return asOptionalRecord(cfg?.plugins?.entries?.crm?.config);
}

export function resolveCrmApiKey(cfg?: OpenClawConfig): string | undefined {
  const resolved = resolveReadOnlyEnvSecretRef({
    value: crmConfigRecord(cfg)?.apiKey,
    path: CRM_API_KEY_CONFIG_PATH,
    cfg,
    expectedEnvId: CRM_API_KEY_ENV_VAR,
    normalizeValue: normalizeSecretInput,
  });
  if (resolved.status === "available") {
    return resolved.value;
  }
  if (resolved.status === "blocked") {
    return undefined;
  }
  return normalizeSecretInput(process.env[CRM_API_KEY_ENV_VAR]) || undefined;
}

export function normalizeCrmBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("crm baseUrl cannot be empty.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`crm baseUrl is not a valid URL: ${trimmed}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("crm baseUrl must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new Error("crm baseUrl must not include credentials; configure the API key separately.");
  }

  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/u, "");
}

export function resolveCrmBaseUrl(cfg?: OpenClawConfig): string {
  const configured =
    normalizeOptionalString(crmConfigRecord(cfg)?.baseUrl) ??
    normalizeOptionalString(process.env.CRM_BASE_URL) ??
    DEFAULT_BASE_URL;
  return normalizeCrmBaseUrl(configured);
}

export function resolveCrmTimeoutSeconds(cfg?: OpenClawConfig): number {
  const configured = crmConfigRecord(cfg)?.timeoutSeconds;
  const value =
    typeof configured === "number"
      ? configured
      : typeof configured === "string" && configured.trim()
        ? Number(configured)
        : typeof process.env.CRM_TIMEOUT_SECONDS === "string" &&
            process.env.CRM_TIMEOUT_SECONDS.trim()
          ? Number(process.env.CRM_TIMEOUT_SECONDS)
          : Number.NaN;

  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.min(Math.max(Math.round(value), 1), MAX_TIMEOUT_SECONDS);
}

export function resolveCrmConfig(cfg?: OpenClawConfig): CrmConfig {
  const apiKey = resolveCrmApiKey(cfg);
  if (!apiKey) {
    throw new Error(
      "crm is not configured: set plugins.entries.crm.config.apiKey or CRM_API_KEY. " +
        "Create an API key in the CRM under Settings → API keys.",
    );
  }

  return {
    baseUrl: resolveCrmBaseUrl(cfg),
    apiKey,
    timeoutSeconds: resolveCrmTimeoutSeconds(cfg),
  };
}

export function resolveCrmToolConfig(
  api: OpenClawPluginApi,
  ctx?: CrmToolConfigContext,
): OpenClawConfig {
  return ctx?.getRuntimeConfig?.() ?? ctx?.runtimeConfig ?? ctx?.config ?? api.config;
}
