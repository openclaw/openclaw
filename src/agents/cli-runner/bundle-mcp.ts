import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import type { CliBackendConfig } from "../../config/types.js";
import {
  loadEnabledBundleMcpConfig,
  type BundleMcpConfig,
  type BundleMcpServerConfig,
} from "../../plugins/bundle-mcp.js";
import { isRecord } from "../../utils.js";

type PreparedCliBundleMcpConfig = {
  backend: CliBackendConfig;
  cleanup?: () => Promise<void>;
};

function extractServerMap(raw: unknown): Record<string, BundleMcpServerConfig> {
  if (!isRecord(raw)) {
    return {};
  }
  const nested = isRecord(raw.mcpServers)
    ? raw.mcpServers
    : isRecord(raw.servers)
      ? raw.servers
      : raw;
  if (!isRecord(nested)) {
    return {};
  }
  const result: Record<string, BundleMcpServerConfig> = {};
  for (const [serverName, serverRaw] of Object.entries(nested)) {
    if (!isRecord(serverRaw)) {
      continue;
    }
    result[serverName] = { ...serverRaw };
  }
  return result;
}

async function readExternalMcpConfig(configPath: string): Promise<BundleMcpConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(configPath, "utf-8")) as unknown;
    return { mcpServers: extractServerMap(raw) };
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
  backendId: string;
  backend: CliBackendConfig;
  workspaceDir: string;
  config?: OpenClawConfig;
  warn?: (message: string) => void;
}): Promise<PreparedCliBundleMcpConfig> {
  if (params.backendId !== "claude-cli") {
    return { backend: params.backend };
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

  if (Object.keys(mergedConfig.mcpServers).length === 0) {
    return { backend: params.backend };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mcp-"));
  const mcpConfigPath = path.join(tempDir, "mcp.json");
  await fs.writeFile(mcpConfigPath, `${JSON.stringify(mergedConfig, null, 2)}\n`, "utf-8");

  return {
    backend: {
      ...params.backend,
      args: injectMcpConfigArgs(params.backend.args, mcpConfigPath),
      resumeArgs: injectMcpConfigArgs(
        params.backend.resumeArgs ?? params.backend.args ?? [],
        mcpConfigPath,
      ),
    },
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}
