import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import type { CliBackendConfig } from "../../config/types.js";
import {
  extractMcpServerMap,
  loadEnabledBundleMcpConfig,
  type BundleMcpConfig,
} from "../../plugins/bundle-mcp.js";

type PreparedCliBundleMcpConfig = {
  backend: CliBackendConfig;
  cleanup?: () => Promise<void>;
  mcpConfigHash?: string;
  env?: Record<string, string>;
};

async function readExternalMcpConfig(configPath: string): Promise<BundleMcpConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(configPath, "utf-8")) as unknown;
    return { mcpServers: extractMcpServerMap(raw) };
  } catch {
    return { mcpServers: {} };
  }
}

function findMcpConfigPath(args?: string[]): string | undefined {
  if (!args?.length) {
    return undefined;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--mcp-config") {
      const next = args[i + 1];
      return typeof next === "string" && next.trim() ? next.trim() : undefined;
    }
    if (arg.startsWith("--mcp-config=")) {
      const inline = arg.slice("--mcp-config=".length).trim();
      return inline || undefined;
    }
  }
  return undefined;
}

function injectMcpConfigArgs(args: string[] | undefined, mcpConfigPath: string): string[] {
  const next: string[] = [];
  for (let i = 0; i < (args?.length ?? 0); i += 1) {
    const arg = args?.[i] ?? "";
    if (arg === "--strict-mcp-config") {
      continue;
    }
    if (arg === "--mcp-config") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--mcp-config=")) {
      continue;
    }
    next.push(arg);
  }
  next.push("--strict-mcp-config", "--mcp-config", mcpConfigPath);
  return next;
}

export async function prepareCliBundleMcpConfig(params: {
  enabled: boolean;
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

  const existingMcpConfigPath =
    findMcpConfigPath(params.backend.resumeArgs) ?? findMcpConfigPath(params.backend.args);
  let mergedConfig: BundleMcpConfig = { mcpServers: {} };

  if (existingMcpConfigPath) {
    const resolvedExistingPath = path.isAbsolute(existingMcpConfigPath)
      ? existingMcpConfigPath
      : path.resolve(params.workspaceDir, existingMcpConfigPath);
    mergedConfig = applyMergePatch(
      mergedConfig,
      await readExternalMcpConfig(resolvedExistingPath),
    ) as BundleMcpConfig;
  }

  const bundleConfig = loadEnabledBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.config,
  });
  for (const diagnostic of bundleConfig.diagnostics) {
    params.warn?.(`bundle MCP skipped for ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  mergedConfig = applyMergePatch(mergedConfig, bundleConfig.config) as BundleMcpConfig;
  if (params.additionalConfig) {
    mergedConfig = applyMergePatch(mergedConfig, params.additionalConfig) as BundleMcpConfig;
  }

  // Always pass an explicit strict MCP config for background claude-cli runs.
  // Otherwise Claude may inherit ambient user/global MCP servers (for example
  // Playwright) and spawn unexpected background processes.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mcp-"));
  const mcpConfigPath = path.join(tempDir, "mcp.json");
  const serializedConfig = `${JSON.stringify(mergedConfig, null, 2)}\n`;
  await fs.writeFile(mcpConfigPath, serializedConfig, "utf-8");

  return {
    backend: {
      ...params.backend,
      args: injectMcpConfigArgs(params.backend.args, mcpConfigPath),
      resumeArgs: injectMcpConfigArgs(
        params.backend.resumeArgs ?? params.backend.args ?? [],
        mcpConfigPath,
      ),
    },
    mcpConfigHash: crypto.createHash("sha256").update(serializedConfig).digest("hex"),
    env: params.env,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}
