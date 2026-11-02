import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexPluginConfig, CodexSupervisionEndpoint } from "./app-server/config-contracts.js";

/** Legacy endpoint env retained for the shipped Supervisor tool contract. */
const LEGACY_CODEX_SUPERVISOR_ENDPOINTS_ENV = "OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS";

const ENDPOINT_URL_PREFIX = /^(?:wss?|unix):\/\//;

export type NormalizedSupervisionEndpoint = {
  id: string;
  label?: string;
  configured?: CodexSupervisionEndpoint;
};

function normalizeEndpointId(value: string, index: number): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/[^a-zA-Z0-9_.:-]/g, "-") : `endpoint-${index + 1}`;
}

function parseEndpointRecord(value: unknown): CodexSupervisionEndpoint | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const transport = typeof value.transport === "string" ? value.transport : undefined;
  const common = {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.label === "string" ? { label: value.label } : {}),
  };
  if (transport === "websocket" && typeof value.url === "string") {
    return {
      ...common,
      transport,
      url: value.url,
      ...(typeof value.authTokenEnv === "string" ? { authTokenEnv: value.authTokenEnv } : {}),
    };
  }
  if (transport === "stdio-proxy" || transport === undefined) {
    const args = Array.isArray(value.args)
      ? value.args.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    return {
      ...common,
      transport: "stdio-proxy",
      ...(typeof value.command === "string" ? { command: value.command } : {}),
      ...(args && args.length > 0 ? { args } : {}),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    };
  }
  return undefined;
}

function endpointFromToken(token: string, index: number): CodexSupervisionEndpoint | undefined {
  const trimmed = token.trim();
  if (trimmed === "local" || trimmed === "proxy" || trimmed === "stdio") {
    return {
      id: "local",
      label: "local Codex app-server",
      transport: "stdio-proxy",
    };
  }
  const separatorIndex = ENDPOINT_URL_PREFIX.test(trimmed) ? -1 : trimmed.indexOf("=");
  const id = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex) : "";
  const url = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
  if (ENDPOINT_URL_PREFIX.test(url)) {
    return { id: normalizeEndpointId(id, index), transport: "websocket", url };
  }
  return undefined;
}

function readLegacyEnvEndpoints(env: NodeJS.ProcessEnv): CodexSupervisionEndpoint[] | undefined {
  const raw = env[LEGACY_CODEX_SUPERVISOR_ENDPOINTS_ENV]?.trim();
  if (!raw) {
    return undefined;
  }
  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`${LEGACY_CODEX_SUPERVISOR_ENDPOINTS_ENV} must be a JSON array`);
    }
    return parsed
      .map((entry) => parseEndpointRecord(entry))
      .filter((entry): entry is CodexSupervisionEndpoint => Boolean(entry));
  }
  return raw
    .split(",")
    .map(endpointFromToken)
    .filter((entry): entry is CodexSupervisionEndpoint => Boolean(entry));
}

export function normalizeEndpoints(
  pluginConfig: CodexPluginConfig,
  options: { env?: NodeJS.ProcessEnv },
): NormalizedSupervisionEndpoint[] {
  const env = options.env ?? process.env;
  const configured = pluginConfig.supervision?.endpoints;
  const endpoints = configured?.length ? configured : readLegacyEnvEndpoints(env);
  const normalized: NormalizedSupervisionEndpoint[] = endpoints
    ? endpoints.map((endpoint, index) => {
        const entry: NormalizedSupervisionEndpoint = {
          id: normalizeEndpointId(endpoint.id ?? endpoint.label ?? "", index),
        };
        if (endpoint.label?.trim()) {
          entry.label = endpoint.label.trim();
        }
        entry.configured = endpoint;
        return entry;
      })
    : [{ id: "local", label: "local Codex app-server" }];
  const seen = new Set<string>();
  for (const endpoint of normalized) {
    if (seen.has(endpoint.id)) {
      throw new Error(`duplicate Codex supervisor endpoint id: ${endpoint.id}`);
    }
    seen.add(endpoint.id);
  }
  return normalized;
}
