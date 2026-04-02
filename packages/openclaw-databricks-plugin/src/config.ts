import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInput,
} from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { DatabricksConfigError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_COUNT = 1;
const DEFAULT_POLLING_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLLING_WAIT_MS = 30_000;

const ALLOWED_DATABRICKS_HOST_SUFFIXES = [
  ".cloud.databricks.com",
  ".azuredatabricks.net",
  ".gcp.databricks.com",
] as const;

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
  pollingIntervalMs: z
    .number({ error: "pollingIntervalMs must be a number between 200 and 5000" })
    .int({ error: "pollingIntervalMs must be an integer between 200 and 5000" })
    .min(200, { error: "pollingIntervalMs must be >= 200" })
    .max(5_000, { error: "pollingIntervalMs must be <= 5000" }),
  maxPollingWaitMs: z
    .number({ error: "maxPollingWaitMs must be a number between 1000 and 120000" })
    .int({ error: "maxPollingWaitMs must be an integer between 1000 and 120000" })
    .min(1_000, { error: "maxPollingWaitMs must be >= 1000" })
    .max(120_000, { error: "maxPollingWaitMs must be <= 120000" }),
  allowedCatalogs: z.array(z.string().min(1)).default([]),
  allowedSchemas: z.array(z.string().min(1)).default([]),
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
  pollingIntervalMs?: unknown;
  maxPollingWaitMs?: unknown;
  allowedCatalogs?: unknown;
  allowedSchemas?: unknown;
  readOnly?: unknown;
};

function normalizeOptionalString(value: unknown, path: string): string | undefined {
  const resolved = normalizeResolvedSecretInputString({ value, path });
  return normalizeSecretInput(resolved) || undefined;
}

function isIpLiteral(hostname: string): boolean {
  return /^[\d.]+$/u.test(hostname) || hostname.includes(":");
}

function assertAllowedDatabricksHostname(hostname: string): void {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isIpLiteral(hostname)) {
    throw new DatabricksConfigError("Databricks host must be a public Databricks hostname.");
  }

  const isAllowed = ALLOWED_DATABRICKS_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
  );
  if (!isAllowed) {
    throw new DatabricksConfigError(
      "Databricks host must match a supported Databricks domain suffix.",
      {
        allowedSuffixes: ALLOWED_DATABRICKS_HOST_SUFFIXES,
      },
    );
  }
}

function normalizeHost(rawHost: string): string {
  const prefixed = /^https?:\/\//iu.test(rawHost) ? rawHost : `https://${rawHost}`;
  let url: URL;
  try {
    url = new URL(prefixed);
  } catch {
    throw new DatabricksConfigError("Invalid Databricks host URL.");
  }
  if (url.protocol !== "https:") {
    throw new DatabricksConfigError("Databricks host must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new DatabricksConfigError("Databricks host must not include userinfo.");
  }
  if (url.port && url.port !== "443") {
    throw new DatabricksConfigError("Databricks host must not override port.");
  }
  if (url.pathname && url.pathname !== "/") {
    throw new DatabricksConfigError("Databricks host must not include a path.");
  }
  if (url.search || url.hash) {
    throw new DatabricksConfigError("Databricks host must not include query or fragment.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  assertAllowedDatabricksHostname(hostname);

  return `https://${hostname}`;
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

function normalizePollingIntervalMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_POLLING_INTERVAL_MS;
  }
  return Math.floor(value);
}

function normalizeMaxPollingWaitMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_POLLING_WAIT_MS;
  }
  return Math.floor(value);
}

function normalizeAllowlistValues(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
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
  const pollingIntervalMs = normalizePollingIntervalMs(candidate?.pollingIntervalMs);
  const maxPollingWaitMs = normalizeMaxPollingWaitMs(candidate?.maxPollingWaitMs);
  const allowedCatalogs = normalizeAllowlistValues(candidate?.allowedCatalogs);
  const allowedSchemas = normalizeAllowlistValues(candidate?.allowedSchemas);
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
    pollingIntervalMs,
    maxPollingWaitMs,
    allowedCatalogs,
    allowedSchemas,
    readOnly,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DatabricksConfigError(issue?.message ?? "Invalid Databricks plugin configuration.");
  }
  return parsed.data;
}
