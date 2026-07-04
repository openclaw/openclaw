/**
 * Prepares bundled MCP configuration for CLI runner backends.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyMergePatch } from "../../config/merge-patch.js";
import type { CliBackendConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { tryReadJson } from "../../infra/json-files.js";
import { extractMcpServerMap, type BundleMcpConfig } from "../../plugins/bundle-mcp.js";
import type { CliBundleMcpMode } from "../../plugins/types.js";
import { loadMergedBundleMcpConfig, toCliBundleMcpServerConfig } from "../bundle-mcp-config.js";
import { isRecord } from "./bundle-mcp-adapter-shared.js";
import {
  findClaudeMcpConfigPath,
  findClaudeMcpConfigPaths,
  hasExternalClaudeMcpServerPolicies,
  injectClaudeMcpConfigArgs,
  prepareClaudeMcpServers,
  writeClaudeMcpCaptureConfig,
} from "./bundle-mcp-claude.js";
import { injectCodexMcpConfigArgs } from "./bundle-mcp-codex.js";
import { writeGeminiMcpCaptureSettings, writeGeminiSystemSettings } from "./bundle-mcp-gemini.js";
import { isClaudeLiveSessionTransport } from "./claude-live-contract.js";
import type { ClaudeMcpServerToolPolicies } from "./types.js";

type PreparedCliBundleMcpConfig = {
  backend: CliBackendConfig;
  beforeExecution?: () => Promise<void>;
  cleanup?: () => Promise<void>;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
  mcpServerToolPolicies?: ClaudeMcpServerToolPolicies;
  mcpNativeServerNames?: string[];
  env?: Record<string, string>;
};

function resolveBundleMcpMode(mode: CliBundleMcpMode | undefined): CliBundleMcpMode {
  return mode ?? "claude-config-file";
}

async function readExternalMcpConfig(configPath: string): Promise<BundleMcpConfig> {
  return { mcpServers: extractMcpServerMap(await tryReadJson<unknown>(configPath)) };
}

function applyManagedMcpConfig(
  current: BundleMcpConfig,
  managed: BundleMcpConfig,
): BundleMcpConfig {
  const mcpServers = { ...current.mcpServers };
  for (const serverName of Object.keys(managed.mcpServers)) {
    // Managed identities replace native entries wholesale. Retaining stale
    // command/url fields could change which transport owns a trusted name.
    delete mcpServers[serverName];
  }
  return applyMergePatch({ ...current, mcpServers }, managed) as BundleMcpConfig;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function normalizeOpenClawLoopbackUrl(value: string): string {
  const match =
    /^(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])):\d+(\/mcp)$/.exec(value.trim()) ?? undefined;
  if (!match) {
    return value;
  }
  return `${match[1]}:<openclaw-loopback>${match[2]}`;
}

type RuntimeMcpConfig = {
  mcpServers: Record<string, unknown>;
};

function markClaudeDirectMcpServers(config: RuntimeMcpConfig): RuntimeMcpConfig {
  const openclaw = config.mcpServers.openclaw;
  if (!isRecord(openclaw)) {
    return config;
  }
  return {
    mcpServers: {
      ...config.mcpServers,
      openclaw: {
        ...openclaw,
        headers: {
          ...(isRecord(openclaw.headers) ? openclaw.headers : {}),
          "x-openclaw-direct-mcp-servers": "true",
        },
      },
    },
  };
}

function canonicalizeBundleMcpConfigForResume(config: RuntimeMcpConfig): RuntimeMcpConfig {
  // The OpenClaw loopback MCP port changes across runs. Replace it before
  // hashing so resume compatibility tracks config shape, not ephemeral ports.
  const canonicalServers = Object.fromEntries(
    Object.entries(config.mcpServers).map(([name, server]) => {
      if (name !== "openclaw" || !isRecord(server) || typeof server.url !== "string") {
        return [name, sortJsonValue(server)];
      }
      return [
        name,
        sortJsonValue({
          ...server,
          url: normalizeOpenClawLoopbackUrl(server.url),
        }),
      ];
    }),
  );
  return {
    mcpServers: sortJsonValue(canonicalServers) as Record<string, unknown>,
  };
}

const OPENCLAW_MCP_ENV_TEMPLATE_PATTERN = /\$\{(OPENCLAW_MCP_[A-Z0-9_]+)\}/g;

function resolveOpenClawMcpEnvTemplates(value: unknown, env?: Record<string, string>): unknown {
  if (!env) {
    return value;
  }
  if (typeof value === "string") {
    return value.replace(OPENCLAW_MCP_ENV_TEMPLATE_PATTERN, (match, name: string) => {
      return Object.hasOwn(env, name) ? env[name] : match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveOpenClawMcpEnvTemplates(entry, env));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, resolveOpenClawMcpEnvTemplates(entry, env)]),
  );
}

async function prepareModeSpecificBundleMcpConfig(params: {
  mode: CliBundleMcpMode;
  backend: CliBackendConfig;
  mergedConfig: BundleMcpConfig;
  nativeClaudeMcpServerNames?: ReadonlySet<string>;
  managedClaudeMcpServerOrder?: readonly string[];
  env?: Record<string, string>;
}): Promise<PreparedCliBundleMcpConfig> {
  const isClaudeConfig = params.mode === "claude-config-file";
  const preparedClaudeServers = isClaudeConfig
    ? prepareClaudeMcpServers(params.mergedConfig.mcpServers, {
        nativeServerNames: params.nativeClaudeMcpServerNames,
        managedServerOrder: params.managedClaudeMcpServerOrder,
      })
    : undefined;
  const mcpServerToolPolicies = preparedClaudeServers?.toolPolicies;
  const mcpNativeServerNames = preparedClaudeServers?.nativeServerNames;
  const hasExternalClaudeMcpServers = hasExternalClaudeMcpServerPolicies(mcpServerToolPolicies);
  if (hasExternalClaudeMcpServers && !isClaudeLiveSessionTransport(params.backend)) {
    throw new Error(
      'Claude CLI external MCP servers require liveSession: "claude-stdio", output: "jsonl", resumeOutput unset or "jsonl", and input: "stdin" for OpenClaw tool policy enforcement',
    );
  }
  const claudeRuntimeConfig = {
    mcpServers: preparedClaudeServers?.mcpServers ?? {},
  };
  const runtimeConfig = isClaudeConfig
    ? isClaudeLiveSessionTransport(params.backend)
      ? markClaudeDirectMcpServers(claudeRuntimeConfig)
      : claudeRuntimeConfig
    : params.mergedConfig;
  const policyHashInput = mcpServerToolPolicies ? `${JSON.stringify(mcpServerToolPolicies)}\n` : "";
  const serializedConfig = `${JSON.stringify(runtimeConfig, null, 2)}\n`;
  const mcpConfigHash = crypto
    .createHash("sha256")
    .update(serializedConfig)
    .update(policyHashInput)
    .digest("hex");
  const serializedResumeConfig = `${JSON.stringify(
    canonicalizeBundleMcpConfigForResume(runtimeConfig),
    null,
    2,
  )}\n`;
  const mcpResumeHash = crypto
    .createHash("sha256")
    .update(serializedResumeConfig)
    .update(policyHashInput)
    .digest("hex");

  if (params.mode === "codex-config-overrides") {
    return {
      backend: {
        ...params.backend,
        args: injectCodexMcpConfigArgs(params.backend.args, params.mergedConfig),
        resumeArgs: injectCodexMcpConfigArgs(
          params.backend.resumeArgs ?? params.backend.args ?? [],
          params.mergedConfig,
        ),
      },
      mcpConfigHash,
      mcpResumeHash,
      mcpServerToolPolicies,
      mcpNativeServerNames,
      env: params.env,
    };
  }

  if (params.mode === "gemini-system-settings") {
    const settings = await writeGeminiSystemSettings(params.mergedConfig, params.env);
    return {
      backend: params.backend,
      mcpConfigHash,
      mcpResumeHash,
      mcpServerToolPolicies,
      mcpNativeServerNames,
      env: settings.env,
      cleanup: settings.cleanup,
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mcp-"));
  const mcpConfigPath = path.join(tempDir, "mcp.json");
  const resolvedRuntimeConfig = resolveOpenClawMcpEnvTemplates(
    runtimeConfig,
    params.env,
  ) as BundleMcpConfig;
  await fs.writeFile(mcpConfigPath, `${JSON.stringify(resolvedRuntimeConfig, null, 2)}\n`, "utf-8");
  return {
    backend: {
      ...params.backend,
      args: injectClaudeMcpConfigArgs(params.backend.args, mcpConfigPath),
      resumeArgs: injectClaudeMcpConfigArgs(
        params.backend.resumeArgs ?? params.backend.args ?? [],
        mcpConfigPath,
      ),
    },
    mcpConfigHash,
    mcpResumeHash,
    mcpServerToolPolicies,
    mcpNativeServerNames,
    env: params.env,
    cleanup: async () => {
      // Claude config files are generated per run and should not survive cleanup.
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

/** Prepare backend args/env/cleanup for bundle MCP injection into a CLI run. */
export async function prepareCliBundleMcpConfig(params: {
  enabled: boolean;
  mode?: CliBundleMcpMode;
  backend: CliBackendConfig;
  workspaceDir: string;
  config?: OpenClawConfig;
  additionalConfig?: BundleMcpConfig;
  env?: Record<string, string>;
  warn?: (message: string) => void;
}): Promise<PreparedCliBundleMcpConfig> {
  if (!params.enabled) {
    return { backend: params.backend, env: params.env };
  }

  const mode = resolveBundleMcpMode(params.mode);
  const resumeMcpConfigPaths =
    mode === "claude-config-file" ? findClaudeMcpConfigPaths(params.backend.resumeArgs) : [];
  const existingMcpConfigPaths =
    mode === "claude-config-file" && resumeMcpConfigPaths.length > 0
      ? resumeMcpConfigPaths
      : mode === "claude-config-file"
        ? findClaudeMcpConfigPaths(params.backend.args)
        : [];
  let mergedConfig: BundleMcpConfig = { mcpServers: {} };
  const nativeClaudeMcpServerNames = new Set<string>();
  const managedClaudeMcpServerOrder: string[] = [];
  const markManagedClaudeMcpServers = (serverNames: readonly string[]) => {
    for (const serverName of serverNames) {
      const previousIndex = managedClaudeMcpServerOrder.indexOf(serverName);
      if (previousIndex >= 0) {
        managedClaudeMcpServerOrder.splice(previousIndex, 1);
      }
      managedClaudeMcpServerOrder.push(serverName);
    }
  };

  for (const existingMcpConfigPath of existingMcpConfigPaths) {
    // Merge any user-provided Claude MCP config first so bundle/plugin config can
    // override intentionally managed server entries.
    const resolvedExistingPath = path.isAbsolute(existingMcpConfigPath)
      ? existingMcpConfigPath
      : path.resolve(params.workspaceDir, existingMcpConfigPath);
    const externalConfig = await readExternalMcpConfig(resolvedExistingPath);
    mergedConfig = applyMergePatch(mergedConfig, externalConfig) as BundleMcpConfig;
    for (const serverName of Object.keys(externalConfig.mcpServers)) {
      nativeClaudeMcpServerNames.add(serverName);
    }
  }

  const bundleConfig = loadMergedBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.config,
    mapConfiguredServer: toCliBundleMcpServerConfig,
  });
  for (const diagnostic of bundleConfig.diagnostics) {
    params.warn?.(`bundle MCP skipped for ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  const bundleServerNames = Object.keys(bundleConfig.config.mcpServers);
  for (const serverName of bundleServerNames) {
    nativeClaudeMcpServerNames.delete(serverName);
  }
  markManagedClaudeMcpServers(bundleServerNames);
  mergedConfig = applyManagedMcpConfig(mergedConfig, bundleConfig.config);
  if (params.additionalConfig) {
    const additionalServerNames = Object.keys(params.additionalConfig.mcpServers);
    for (const serverName of additionalServerNames) {
      nativeClaudeMcpServerNames.delete(serverName);
    }
    markManagedClaudeMcpServers(additionalServerNames);
    mergedConfig = applyManagedMcpConfig(mergedConfig, params.additionalConfig);
  }

  return await prepareModeSpecificBundleMcpConfig({
    mode,
    backend: params.backend,
    mergedConfig,
    nativeClaudeMcpServerNames,
    managedClaudeMcpServerOrder,
    env: params.env,
  });
}

/** Prepares a per-attempt capture token without changing resume compatibility hashes. */
export async function prepareCliBundleMcpCaptureAttempt(params: {
  mode?: CliBundleMcpMode;
  backend?: CliBackendConfig;
  env?: Record<string, string>;
  captureKey?: string;
}): Promise<{ env?: Record<string, string>; cleanup?: () => Promise<void> }> {
  if (!params.captureKey) {
    return { env: params.env };
  }
  if (resolveBundleMcpMode(params.mode) === "gemini-system-settings") {
    return await writeGeminiMcpCaptureSettings({
      inheritedEnv: params.env,
      captureKey: params.captureKey,
    });
  }
  if (resolveBundleMcpMode(params.mode) === "claude-config-file") {
    const mcpConfigPath =
      findClaudeMcpConfigPath(params.backend?.args) ??
      findClaudeMcpConfigPath(params.backend?.resumeArgs);
    if (mcpConfigPath) {
      await writeClaudeMcpCaptureConfig({
        mcpConfigPath,
        captureKey: params.captureKey,
      });
    }
  }
  return {
    env: {
      ...params.env,
      OPENCLAW_MCP_CLI_CAPTURE_KEY: params.captureKey,
    },
  };
}
