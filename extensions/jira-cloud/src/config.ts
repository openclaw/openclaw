import type { OpenClawConfig } from "../runtime-api.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_COUNT = 2;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RETRY_COUNT = 5;

export type JiraCloudConfig = {
  siteUrl: string;
  email: string;
  apiToken: string;
  defaultProjectKey?: string;
  defaultIssueType?: string;
  requestTimeoutMs: number;
  retryCount: number;
  userAgent: string;
};

export const JIRA_FIELDS_ALLOWLIST = [
  "summary",
  "status",
  "priority",
  "assignee",
  "reporter",
  "issuetype",
  "project",
  "labels",
  "created",
  "updated",
  "description",
  "comment",
] as const;

export const DEFAULT_SEARCH_FIELDS: readonly string[] = [
  "summary",
  "status",
  "priority",
  "assignee",
  "issuetype",
  "project",
  "updated",
];

export function getRawJiraPluginConfig(cfg?: OpenClawConfig): Record<string, unknown> {
  const entries = cfg?.plugins?.entries;
  if (!entries || typeof entries !== "object") {
    return {};
  }
  const pluginEntry = (entries as Record<string, unknown>)["jira-cloud"];
  if (!pluginEntry || typeof pluginEntry !== "object") {
    return {};
  }
  const rawConfig = (pluginEntry as { config?: unknown }).config;
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    return {};
  }
  return rawConfig as Record<string, unknown>;
}

function normalizeSiteUrl(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") {
      return null;
    }
    if (!url.hostname.endsWith(".atlassian.net")) {
      return null;
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function parseString(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function parseNumber(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeProjectKey(raw: unknown): string | undefined {
  const value = parseString(raw);
  if (!value) {
    return undefined;
  }
  if (!/^[A-Z][A-Z0-9_]{0,49}$/i.test(value)) {
    throw new Error("jira-cloud config: defaultProjectKey must match Jira project key format.");
  }
  return value.toUpperCase();
}

function normalizeIssueType(raw: unknown): string | undefined {
  const value = parseString(raw);
  return value || undefined;
}

function normalizeEmail(raw: unknown): string | undefined {
  const value = parseString(raw);
  if (!value) {
    return undefined;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    throw new Error("jira-cloud config: email must be a valid email address.");
  }
  return value;
}

function normalizeBoundedNumber(params: {
  value: unknown;
  fallback: number;
  min: number;
  max: number;
  label: string;
}): number {
  const parsed = parseNumber(params.value);
  if (parsed === undefined) {
    return params.fallback;
  }
  const floored = Math.floor(parsed);
  if (floored < params.min || floored > params.max) {
    throw new Error(
      `jira-cloud config: ${params.label} must be between ${params.min} and ${params.max}.`,
    );
  }
  return floored;
}

export function resolveJiraCloudConfig(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): JiraCloudConfig {
  const rawConfig = getRawJiraPluginConfig(params.cfg);
  const env = params.env ?? process.env;

  const siteUrl =
    normalizeSiteUrl(rawConfig.siteUrl ?? rawConfig.baseUrl ?? env.JIRA_CLOUD_SITE_URL) ?? null;
  const email = normalizeEmail(rawConfig.email ?? env.JIRA_CLOUD_EMAIL);
  const apiToken = parseString(rawConfig.apiToken ?? env.JIRA_CLOUD_API_TOKEN);

  if (!siteUrl || !email || !apiToken) {
    throw new Error(
      "jira-cloud config invalid: siteUrl/baseUrl, email, and apiToken are required (config or JIRA_CLOUD_* env vars).",
    );
  }

  const requestTimeoutMs = normalizeBoundedNumber({
    value: rawConfig.requestTimeoutMs ?? env.JIRA_CLOUD_REQUEST_TIMEOUT_MS,
    fallback: DEFAULT_TIMEOUT_MS,
    min: MIN_TIMEOUT_MS,
    max: MAX_TIMEOUT_MS,
    label: "requestTimeoutMs",
  });

  const retryCount = normalizeBoundedNumber({
    value: rawConfig.retryCount ?? env.JIRA_CLOUD_RETRY_COUNT,
    fallback: DEFAULT_RETRY_COUNT,
    min: 0,
    max: MAX_RETRY_COUNT,
    label: "retryCount",
  });

  const userAgent =
    parseString(rawConfig.userAgent ?? env.JIRA_CLOUD_USER_AGENT) ?? "openclaw-jira-cloud/1.0";

  return {
    siteUrl,
    email,
    apiToken,
    defaultProjectKey: normalizeProjectKey(rawConfig.defaultProjectKey),
    defaultIssueType: normalizeIssueType(rawConfig.defaultIssueType),
    requestTimeoutMs,
    retryCount,
    userAgent,
  };
}

export function resolveAllowedJiraFields(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const allowlist = new Set<string>(JIRA_FIELDS_ALLOWLIST);
  return raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && allowlist.has(value));
}

