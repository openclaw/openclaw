import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedCodexRouteConfig, ResolvedCodexSdkPluginConfig } from "./config.js";
import type { CodexInput, CodexThreadEvent, CodexThreadOptions } from "./runtime-events.js";

export type CodexThread = {
  readonly id: string | null;
  runStreamed(
    input: CodexInput,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncGenerator<CodexThreadEvent> }>;
};

export type CodexClient = {
  startThread(options?: CodexThreadOptions): CodexThread;
  resumeThread(id: string, options?: CodexThreadOptions): CodexThread;
};

type CodexClientOptions = {
  codexPathOverride?: string;
  baseUrl?: string;
  apiKey?: string;
  config?: Record<string, unknown>;
  env?: Record<string, string>;
};

type CodexClientConstructor = new (options?: CodexClientOptions) => CodexClient;

export type CodexSdkModule = {
  Codex: CodexClientConstructor;
};

const BACKCHANNEL_SERVER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "backchannel-server.mjs",
);

export async function loadCodexSdk(): Promise<CodexSdkModule> {
  const specifier = "@openai/codex-sdk";
  return (await import(specifier)) as CodexSdkModule;
}

export function createCodexClientOptions(
  config: ResolvedCodexSdkPluginConfig,
  stateDir?: string,
  gatewayUrl?: string,
): CodexClientOptions {
  const env = resolveEnv(config);
  const codexConfig = resolveCodexConfig(config, stateDir, gatewayUrl);
  return {
    ...(config.codexPath ? { codexPathOverride: config.codexPath } : {}),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiKeyEnv && process.env[config.apiKeyEnv]
      ? { apiKey: process.env[config.apiKeyEnv] }
      : {}),
    ...(codexConfig ? { config: codexConfig } : {}),
    ...(env ? { env } : {}),
  };
}

export function describeBackchannel(
  config: ResolvedCodexSdkPluginConfig,
  stateDir?: string,
  gatewayUrl?: string,
): Record<string, unknown> {
  const backchannel = config.backchannel;
  return {
    enabled: backchannel.enabled,
    server: backchannel.name,
    command: backchannel.command ?? process.execPath,
    args: backchannel.args ?? [BACKCHANNEL_SERVER_PATH],
    gatewayUrlConfigured: Boolean(backchannel.gatewayUrl || gatewayUrl),
    stateDirConfigured: Boolean(stateDir),
    allowedMethods: backchannel.allowedMethods,
    safeWriteMethods: backchannel.safeWriteMethods,
    requireWriteToken: backchannel.requireWriteToken,
    writeTokenEnv: backchannel.writeTokenEnv,
  };
}

export function buildCodexThreadOptions(
  config: ResolvedCodexSdkPluginConfig,
  cwd: string | undefined,
  route: ResolvedCodexRouteConfig,
): CodexThreadOptions {
  return {
    ...(config.model || route.model ? { model: route.model ?? config.model } : {}),
    sandboxMode: route.sandboxMode ?? config.sandboxMode,
    ...(cwd ? { workingDirectory: cwd } : {}),
    skipGitRepoCheck: route.skipGitRepoCheck ?? config.skipGitRepoCheck,
    ...(config.modelReasoningEffort || route.modelReasoningEffort
      ? { modelReasoningEffort: route.modelReasoningEffort ?? config.modelReasoningEffort }
      : {}),
    ...(config.networkAccessEnabled !== undefined || route.networkAccessEnabled !== undefined
      ? { networkAccessEnabled: route.networkAccessEnabled ?? config.networkAccessEnabled }
      : {}),
    ...(config.webSearchMode || route.webSearchMode
      ? { webSearchMode: route.webSearchMode ?? config.webSearchMode }
      : {}),
    ...(config.approvalPolicy || route.approvalPolicy
      ? { approvalPolicy: route.approvalPolicy ?? config.approvalPolicy }
      : {}),
    ...(config.additionalDirectories || route.additionalDirectories
      ? { additionalDirectories: route.additionalDirectories ?? config.additionalDirectories }
      : {}),
  };
}

export function normalizeAgent(agent: string): string {
  return agent
    .trim()
    .toLowerCase()
    .replace(/^codex\//, "codex-");
}

export function extensionForMediaType(mediaType: string): string {
  const normalized = mediaType.toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) {
    return ".jpg";
  }
  if (normalized.includes("webp")) {
    return ".webp";
  }
  if (normalized.includes("gif")) {
    return ".gif";
  }
  return ".png";
}

function resolveCodexConfig(
  config: ResolvedCodexSdkPluginConfig,
  stateDir?: string,
  gatewayUrl?: string,
): Record<string, unknown> | undefined {
  const base = config.config ? (structuredClone(config.config) as Record<string, unknown>) : {};
  if (!config.backchannel.enabled) {
    return Object.keys(base).length > 0 ? base : undefined;
  }
  const existingMcpServers = isRecord(base.mcp_servers) ? base.mcp_servers : {};
  base.mcp_servers = {
    ...existingMcpServers,
    [config.backchannel.name]: buildBackchannelServerConfig(config, stateDir, gatewayUrl),
  };
  return base;
}

function buildBackchannelServerConfig(
  config: ResolvedCodexSdkPluginConfig,
  stateDir?: string,
  gatewayUrl?: string,
): Record<string, unknown> {
  const backchannel = config.backchannel;
  const env: Record<string, string> = {
    OPENCLAW_CODEX_BACKCHANNEL_ALLOWED_METHODS: JSON.stringify(backchannel.allowedMethods),
    OPENCLAW_CODEX_BACKCHANNEL_READ_METHODS: JSON.stringify(backchannel.readMethods),
    OPENCLAW_CODEX_BACKCHANNEL_SAFE_WRITE_METHODS: JSON.stringify(backchannel.safeWriteMethods),
    OPENCLAW_CODEX_BACKCHANNEL_REQUIRE_WRITE_TOKEN: String(backchannel.requireWriteToken),
    OPENCLAW_CODEX_BACKCHANNEL_WRITE_TOKEN_ENV: backchannel.writeTokenEnv,
    OPENCLAW_CODEX_BACKCHANNEL_REQUEST_TIMEOUT_MS: String(backchannel.requestTimeoutMs),
    OPENCLAW_CODEX_BACKCHANNEL_MAX_PAYLOAD_BYTES: String(backchannel.maxPayloadBytes),
    ...(stateDir ? { OPENCLAW_CODEX_BACKCHANNEL_STATE_DIR: stateDir } : {}),
    ...(backchannel.gatewayUrl || gatewayUrl
      ? { OPENCLAW_CODEX_BACKCHANNEL_URL: backchannel.gatewayUrl ?? gatewayUrl ?? "" }
      : {}),
    ...(backchannel.env ?? {}),
  };
  return {
    command: backchannel.command ?? process.execPath,
    args: backchannel.args ?? [BACKCHANNEL_SERVER_PATH],
    env,
    // Codex SDK turns are non-interactive; OpenClaw enforces method allowlists
    // and write-token checks inside the generated backchannel server.
    default_tools_approval_mode: "approve",
  };
}

function resolveEnv(config: ResolvedCodexSdkPluginConfig): Record<string, string> | undefined {
  if (config.inheritEnv && !config.env) {
    return undefined;
  }
  const env: Record<string, string> = {};
  if (config.inheritEnv) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
  }
  Object.assign(env, config.env ?? {});
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
