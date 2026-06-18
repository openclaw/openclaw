import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";

export type XMemoAuthMode = "api-key" | "bearer" | "both";

export type XMemoMemoryConfig = {
  baseUrl: string;
  apiKey: string | undefined;
  bucket: string;
  scope: string | undefined;
  teamId: string | undefined;
  agentId: string;
  agentInstanceId: string;
  authMode: XMemoAuthMode;
  autoCapture: boolean;
  captureMaxChars: number;
  customTriggers: string[] | undefined;
  recallMaxChars: number;
  recallMaxItems: number;
  recallMaxTokens: number;
};

export const DEFAULT_BASE_URL = "https://xmemo.dev";
export const DEFAULT_BUCKET = "openclaw";
export const DEFAULT_AGENT_ID = "openclaw";
export const DEFAULT_AUTH_MODE: XMemoAuthMode = "api-key";

export const API_KEY_ENV_VARS = ["XMEMO_KEY", "MEMORY_OS_API_KEY", "MEMORY_OS_MCP_TOKEN"];
export const BASE_URL_ENV_VARS = [
  "XMEMO_BASE_URL",
  "XMEMO_URL",
  "MEMORY_OS_BASE_URL",
  "MEMORY_OS_URL",
];
export const AGENT_ID_ENV_VARS = ["XMEMO_AGENT_ID", "MEMORY_OS_AGENT_ID"];
export const AGENT_INSTANCE_ID_ENV_VARS = [
  "XMEMO_AGENT_INSTANCE_ID",
  "MEMORY_OS_AGENT_INSTANCE_ID",
];

function firstEnv(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

function normalizeBaseUrl(input: string | undefined): string {
  if (!input) {
    return DEFAULT_BASE_URL;
  }
  let url = input.trim();
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }
  return url;
}

function normalizeAuthMode(input: string | undefined): XMemoAuthMode {
  if (input === "api-key" || input === "bearer" || input === "both") {
    return input;
  }
  return DEFAULT_AUTH_MODE;
}

function resolveApiKey(
  pluginConfig: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  // Prefer the modern `apiKey` config key; fall back to deprecated `token` or env vars.
  const fromConfig =
    normalizeSecretInputString(pluginConfig.apiKey) ??
    normalizeSecretInputString(pluginConfig.token);
  if (fromConfig) {
    return fromConfig;
  }
  return firstEnv(env, API_KEY_ENV_VARS);
}

export function resolveXMemoBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeBaseUrl(firstEnv(env, BASE_URL_ENV_VARS));
}

export function resolveXMemoAgentId(env: NodeJS.ProcessEnv = process.env): string {
  return firstEnv(env, AGENT_ID_ENV_VARS) ?? DEFAULT_AGENT_ID;
}

let moduleInstanceId: string | undefined;

export function resolveXMemoAgentInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  // Prefer explicit env. OpenClaw plugins should not silently write JSON sidecars;
  // if no stable id is configured, cache a single process-local id so repeated
  // config resolves stay consistent across runtime/tools/cli/hooks.
  const fromEnv = firstEnv(env, AGENT_INSTANCE_ID_ENV_VARS);
  if (fromEnv) {
    return fromEnv;
  }
  moduleInstanceId ??= `xmemo-${randomUUID()}`;
  return moduleInstanceId;
}

export function resolveXMemoMemoryConfig(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): XMemoMemoryConfig {
  // Plugin config lives at plugins.entries["xmemo-memory"].config in resolved OpenClaw config.
  const pluginConfig = resolvePluginConfigObject(cfg, "xmemo-memory") ?? {};

  return {
    baseUrl: normalizeBaseUrl(
      (pluginConfig.baseUrl as string | undefined) ?? resolveXMemoBaseUrl(env),
    ),
    apiKey: resolveApiKey(pluginConfig, env),
    bucket: (pluginConfig.bucket as string | undefined) ?? DEFAULT_BUCKET,
    scope: (pluginConfig.scope as string | undefined) ?? undefined,
    teamId: (pluginConfig.teamId as string | undefined) ?? undefined,
    agentId: (pluginConfig.agentId as string | undefined) ?? resolveXMemoAgentId(env),
    agentInstanceId: resolveXMemoAgentInstanceId(env),
    authMode: normalizeAuthMode(pluginConfig.authMode as string | undefined),
    autoCapture: (pluginConfig.autoCapture as boolean | undefined) ?? false,
    captureMaxChars: (pluginConfig.captureMaxChars as number | undefined) ?? 500,
    customTriggers: Array.isArray(pluginConfig.customTriggers)
      ? (pluginConfig.customTriggers as string[]).filter(
          (s) => typeof s === "string" && s.length > 0,
        )
      : undefined,
    recallMaxChars: (pluginConfig.recallMaxChars as number | undefined) ?? 1000,
    recallMaxItems: (pluginConfig.recallMaxItems as number | undefined) ?? 8,
    recallMaxTokens: (pluginConfig.recallMaxTokens as number | undefined) ?? 1500,
  };
}
