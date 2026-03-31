import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInput,
} from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { DatabricksConfigError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_COUNT = 1;

const DatabricksRuntimeConfigSchema = z.object({
  host: z.string().min(1, { error: "host is required" }),
  token: z.string().min(1, { error: "token is required" }),
  warehouseId: z.string().min(1, { error: "warehouseId is required" }),
  timeoutMs: z
    .number({ error: "timeoutMs must be a number between 1000 and 120000" })
    .int({ error: "timeoutMs must be an integer between 1000 and 120000" })
    .min(1_000, { error: "timeoutMs must be >= 1000" })
    .max(120_000, { error: "timeoutMs must be <= 120000" }),
  retryCount: z
    .number({ error: "retryCount must be a number between 0 and 3" })
    .int({ error: "retryCount must be an integer between 0 and 3" })
    .min(0, { error: "retryCount must be >= 0" })
    .max(3, { error: "retryCount must be <= 3" }),
  readOnly: z.literal(true, {
    error: "Only readOnly=true is supported in this Databricks runtime iteration.",
  }),
});

export type ResolvedDatabricksRuntimeConfig = z.infer<typeof DatabricksRuntimeConfigSchema>;

type DatabricksPluginConfig = {
  host?: unknown;
  token?: unknown;
  warehouseId?: unknown;
  timeoutMs?: unknown;
  retryCount?: unknown;
  readOnly?: unknown;
};

function normalizeOptionalString(value: unknown, path: string): string | undefined {
  const resolved = normalizeResolvedSecretInputString({ value, path });
  return normalizeSecretInput(resolved) || undefined;
}

function normalizeHost(rawHost: string): string {
  const prefixed = /^https?:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`;
  let url: URL;
  try {
    url = new URL(prefixed);
  } catch {
    throw new DatabricksConfigError("Invalid databricks host URL.");
  }
  if (url.protocol !== "https:") {
    throw new DatabricksConfigError("Databricks host must use HTTPS.");
  }
  if (url.pathname && url.pathname !== "/") {
    throw new DatabricksConfigError("Databricks host must not include a path.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/u, "");
}

function normalizeRetryCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RETRY_COUNT;
  }
  return Math.floor(value);
}

function normalizeTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.floor(value);
}

export function resolveDatabricksPluginRawConfig(
  config?: OpenClawConfig,
): DatabricksPluginConfig | undefined {
  const entry = config?.plugins?.entries?.databricks?.config;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  return entry as DatabricksPluginConfig;
}

export function resolveDatabricksRuntimeConfig(params: {
  rawConfig?: unknown;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): ResolvedDatabricksRuntimeConfig {
  const env = params.env ?? process.env;
  const fromOpenClawConfig = resolveDatabricksPluginRawConfig(params.config);
  const candidate =
    params.rawConfig && typeof params.rawConfig === "object" && !Array.isArray(params.rawConfig)
      ? (params.rawConfig as DatabricksPluginConfig)
      : fromOpenClawConfig;

  const host =
    normalizeOptionalString(candidate?.host, "plugins.entries.databricks.config.host") ||
    normalizeSecretInput(env.DATABRICKS_HOST || "") ||
    undefined;
  const token =
    normalizeOptionalString(candidate?.token, "plugins.entries.databricks.config.token") ||
    normalizeSecretInput(env.DATABRICKS_TOKEN || "") ||
    undefined;
  const warehouseId =
    normalizeOptionalString(
      candidate?.warehouseId,
      "plugins.entries.databricks.config.warehouseId",
    ) ||
    normalizeSecretInput(env.DATABRICKS_WAREHOUSE_ID || "") ||
    undefined;

  const timeoutMs = normalizeTimeoutMs(candidate?.timeoutMs);
  const retryCount = normalizeRetryCount(candidate?.retryCount);
  const readOnly =
    typeof candidate?.readOnly === "boolean"
      ? candidate.readOnly
      : normalizeSecretInput(env.DATABRICKS_READ_ONLY || "").toLowerCase() !== "false";

  const parsed = DatabricksRuntimeConfigSchema.safeParse({
    host: host ? normalizeHost(host) : "",
    token: token ?? "",
    warehouseId: warehouseId ?? "",
    timeoutMs,
    retryCount,
    readOnly,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DatabricksConfigError(issue?.message ?? "Invalid Databricks plugin configuration.");
  }
  return parsed.data;
}
