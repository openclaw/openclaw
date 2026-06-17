import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export type XMemoMemoryConfig = {
  baseUrl: string;
  token: string | undefined;
  bucket: string;
  scope: string | undefined;
  teamId: string | undefined;
  agentId: string;
  agentInstanceId: string;
  autoRecall: boolean;
  autoCapture: boolean;
  captureMaxChars: number;
  recallMaxChars: number;
  recallMaxItems: number;
  recallMaxTokens: number;
};

export const DEFAULT_BASE_URL = "https://xmemo.dev";
export const DEFAULT_BUCKET = "openclaw";
export const DEFAULT_AGENT_ID = "openclaw";

export const TOKEN_ENV_VARS = ["XMEMO_KEY", "MEMORY_OS_API_KEY", "MEMORY_OS_MCP_TOKEN"];
export const BASE_URL_ENV_VARS = ["XMEMO_BASE_URL", "XMEMO_URL", "MEMORY_OS_BASE_URL", "MEMORY_OS_URL"];
export const AGENT_ID_ENV_VARS = ["XMEMO_AGENT_ID", "MEMORY_OS_AGENT_ID"];
export const AGENT_INSTANCE_ID_ENV_VARS = ["XMEMO_AGENT_INSTANCE_ID", "MEMORY_OS_AGENT_INSTANCE_ID"];

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

export function resolveXMemoBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeBaseUrl(firstEnv(env, BASE_URL_ENV_VARS));
}

export function resolveXMemoToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return firstEnv(env, TOKEN_ENV_VARS);
}

export function resolveXMemoAgentId(env: NodeJS.ProcessEnv = process.env): string {
  return firstEnv(env, AGENT_ID_ENV_VARS) ?? DEFAULT_AGENT_ID;
}

export function resolveXMemoAgentInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  return firstEnv(env, AGENT_INSTANCE_ID_ENV_VARS) ?? buildDeviceInstanceId(env);
}

function buildDeviceInstanceId(env: NodeJS.ProcessEnv): string {
  // Prefer a stable file outside the repo so the same machine keeps the same id.
  const configHome = env.XMEMO_CONFIG_HOME ?? env.MEMORY_OS_CONFIG_HOME;
  let configDir: string;
  if (configHome) {
    configDir = configHome;
  } else if (process.platform === "win32" && env.LOCALAPPDATA) {
    configDir = path.join(env.LOCALAPPDATA, "XMemo", "CLI");
  } else if (env.XDG_CONFIG_HOME) {
    configDir = path.join(env.XDG_CONFIG_HOME, "xmemo");
  } else {
    configDir = path.join(homedir(), ".config", "xmemo");
  }

  const instancePath = path.join(configDir, "device-instance.json");
  try {
    if (fs.existsSync(instancePath)) {
      const parsed = JSON.parse(fs.readFileSync(instancePath, "utf8")) as { id?: string };
      if (parsed.id) {
        return parsed.id;
      }
    }
  } catch {
    // ignore
  }

  const id = `xmemo-${randomUUID()}`;
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(instancePath, JSON.stringify({ id }, null, 2), { mode: 0o600 });
  } catch {
    // ignore
  }
  return id;
}

export function resolveXMemoMemoryConfig(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): XMemoMemoryConfig {
  // Plugin config lives at plugins.entries["xmemo-memory"].config in resolved OpenClaw config.
  const pluginConfig = resolvePluginConfigObject(cfg, "xmemo-memory") ?? {};

  return {
    baseUrl: normalizeBaseUrl((pluginConfig.baseUrl as string | undefined) ?? resolveXMemoBaseUrl(env)),
    token: (pluginConfig.token as string | undefined) ?? resolveXMemoToken(env),
    bucket: (pluginConfig.bucket as string | undefined) ?? DEFAULT_BUCKET,
    scope: (pluginConfig.scope as string | undefined) ?? undefined,
    teamId: (pluginConfig.teamId as string | undefined) ?? undefined,
    agentId: (pluginConfig.agentId as string | undefined) ?? resolveXMemoAgentId(env),
    agentInstanceId: resolveXMemoAgentInstanceId(env),
    autoRecall: (pluginConfig.autoRecall as boolean | undefined) ?? true,
    autoCapture: (pluginConfig.autoCapture as boolean | undefined) ?? true,
    captureMaxChars: (pluginConfig.captureMaxChars as number | undefined) ?? 500,
    recallMaxChars: (pluginConfig.recallMaxChars as number | undefined) ?? 1000,
    recallMaxItems: (pluginConfig.recallMaxItems as number | undefined) ?? 8,
    recallMaxTokens: (pluginConfig.recallMaxTokens as number | undefined) ?? 1500,
  };
}

export function resolveXMemoStateDir(cfg: OpenClawConfig): string {
  return resolveStateDir(cfg) ?? path.join(homedir(), ".openclaw", "state");
}
