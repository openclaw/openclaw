/** Materializes the desktop-owned unified MCP template for an isolated Computer Use home. */
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ensureCodexComputerUseSharedPluginCache } from "./computer-use-cache.js";
import type { ResolvedCodexComputerUseConfig } from "./config.js";
import type { MacOSDesktopCodexAppPathCandidate } from "./desktop-app-paths.js";
import { readCodexDesktopArtifactTreeFingerprint } from "./desktop-generation-fingerprint.js";

export const UNIFIED_COMPUTER_USE_PLUGIN = "unified-computer-use";
const UNIFIED_SERVER = "cua_repl";
const CUA_REPL_ENTRY = "@oai/cua/tinyskyAlt";

export type CodexUnifiedComputerUseRuntime = {
  pluginRoot: string;
  sourceFingerprint: string;
  manifest: Record<string, unknown>;
  mcp: Record<string, unknown>;
};

/** The selected desktop distribution owns both the plugin and its executable dependencies. */
export async function resolveCodexUnifiedComputerUseRuntime(
  candidate: MacOSDesktopCodexAppPathCandidate,
  codexHome: string,
  requestedPluginName?: string,
  requestedServerName?: string,
): Promise<CodexUnifiedComputerUseRuntime | undefined> {
  const pluginName = requestedPluginName ?? "computer-use";
  const serverName = requestedServerName ?? pluginName;
  if (
    !(pluginName === "computer-use" && serverName === "computer-use") &&
    !(pluginName === UNIFIED_COMPUTER_USE_PLUGIN && serverName === UNIFIED_SERVER)
  ) {
    return undefined;
  }
  const legacy = await readObject(
    path.join(
      candidate.bundledMarketplacePath,
      "plugins",
      "computer-use",
      ".codex-plugin",
      "plugin.json",
    ),
  );
  if (legacy?.mcpServers && requestedPluginName !== UNIFIED_COMPUTER_USE_PLUGIN) {
    return undefined;
  }
  const pluginRoot = path.join(
    candidate.bundledMarketplacePath,
    "plugins",
    UNIFIED_COMPUTER_USE_PLUGIN,
  );
  const manifest = await readObject(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  if (
    !manifest ||
    manifest.name !== UNIFIED_COMPUTER_USE_PLUGIN ||
    manifest.mcpServers !== "./.mcp.json"
  ) {
    return undefined;
  }
  const template = await readObject(path.join(pluginRoot, ".mcp.json"));
  const servers = template?.mcpServers;
  const server = isRecord(servers) ? servers[UNIFIED_SERVER] : undefined;
  if (!template || !isRecord(servers) || !isRecord(server)) {
    throw new Error("The selected desktop's unified Computer Use MCP template is invalid.");
  }
  const runtimeRoot = path.join(candidate.appBundlePath, "Contents", "Resources", "cua_node");
  const modules = path.join(runtimeRoot, "lib", "node_modules");
  const node = path.join(runtimeRoot, "bin", "node");
  const nodeRepl = path.join(runtimeRoot, "bin", "node_repl");
  const launcher = path.join(modules, "@oai", "cua-repl", "bin", "cua-repl.mjs");
  const cuaRoot = path.join(modules, "@oai", "cua");
  const cuaPackage = await readObject(path.join(cuaRoot, "package.json"));
  const cuaEntry = isRecord(cuaPackage?.exports) ? cuaPackage.exports["./tinyskyAlt"] : undefined;
  try {
    if (
      typeof cuaEntry !== "string" ||
      !cuaEntry.startsWith("./") ||
      path.relative(cuaRoot, path.resolve(cuaRoot, cuaEntry)).startsWith("..")
    ) {
      throw new Error("The desktop CUA package does not expose its unified entry point.");
    }
    await Promise.all([
      fs.access(node, constants.X_OK),
      fs.access(nodeRepl, constants.X_OK),
      fs.access(launcher, constants.R_OK),
      fs.access(path.join(modules, "@oai", "sky", "package.json"), constants.R_OK),
      fs.access(path.resolve(cuaRoot, cuaEntry), constants.R_OK),
    ]);
  } catch (cause) {
    throw new Error("The selected desktop's unified Computer Use runtime is incomplete.", {
      cause,
    });
  }
  return {
    pluginRoot,
    sourceFingerprint: await readCodexDesktopArtifactTreeFingerprint(pluginRoot),
    manifest,
    mcp: {
      ...template,
      mcpServers: {
        ...servers,
        [UNIFIED_SERVER]: {
          ...server,
          command: node,
          args: [launcher],
          enabled: true,
          env_vars: [],
          // Do not import the desktop user's cache, browser sessions, or environment overrides.
          env: {
            CODEX_HOME: codexHome,
            CUA_REPL_NODE_REPL_PATH: nodeRepl,
            CUA_REPL_ENABLED_SURFACES: "computer",
            NODE_REPL_NODE_PATH: node,
            NODE_REPL_NODE_MODULE_DIRS: modules,
            NODE_REPL_TRUSTED_CODE_PATHS: [codexHome, modules].join(path.delimiter),
            NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service" }),
            NODE_REPL_JS_BANNER: `await import(${JSON.stringify(CUA_REPL_ENTRY)});`,
            SKY_CUA_SERVICE_PATH: path.join(codexHome, "computer-use", "Codex Computer Use.app"),
          },
        },
      },
    },
  };
}

export async function publishCodexUnifiedComputerUsePlugin(
  target: string,
  runtime: CodexUnifiedComputerUseRuntime,
): Promise<void> {
  // The signed desktop template can be read-only; the managed home owns its generated copy.
  const templatePath = path.join(runtime.pluginRoot, ".mcp.json");
  await fs.cp(runtime.pluginRoot, target, {
    recursive: true,
    filter: (source) => source !== templatePath,
  });
  await fs.writeFile(path.join(target, ".mcp.json"), `${JSON.stringify(runtime.mcp, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function codexUnifiedComputerUsePluginMatches(
  target: string,
  runtime: CodexUnifiedComputerUseRuntime,
): Promise<boolean> {
  return (
    isDeepStrictEqual(
      await readObject(path.join(target, ".codex-plugin", "plugin.json")),
      runtime.manifest,
    ) && isDeepStrictEqual(await readObject(path.join(target, ".mcp.json")), runtime.mcp)
  );
}

/** Preserve custom identities and legacy desktops; the legacy default follows its replacement. */
export async function resolveManagedCodexComputerUseConfig(
  config: ResolvedCodexComputerUseConfig,
  marketplacePath: string | undefined,
): Promise<ResolvedCodexComputerUseConfig> {
  if (
    !marketplacePath ||
    config.marketplaceSource ||
    config.marketplaceName ||
    config.marketplacePath ||
    config.pluginName !== "computer-use" ||
    config.mcpServerName !== "computer-use"
  ) {
    return config;
  }
  const plugins = path.join(marketplacePath, "plugins");
  const legacy = await readObject(
    path.join(plugins, "computer-use", ".codex-plugin", "plugin.json"),
  );
  if (!legacy || legacy.mcpServers) {
    return config;
  }
  const unified = await readObject(
    path.join(plugins, UNIFIED_COMPUTER_USE_PLUGIN, ".codex-plugin", "plugin.json"),
  );
  const mcp = await readObject(path.join(plugins, UNIFIED_COMPUTER_USE_PLUGIN, ".mcp.json"));
  const server = isRecord(mcp?.mcpServers) ? mcp.mcpServers[UNIFIED_SERVER] : undefined;
  if (
    unified?.name !== UNIFIED_COMPUTER_USE_PLUGIN ||
    !isRecord(server) ||
    server.enabled !== true
  ) {
    return config;
  }
  return { ...config, pluginName: UNIFIED_COMPUTER_USE_PLUGIN, mcpServerName: UNIFIED_SERVER };
}

/** Renaming a server must not discard an operator's legacy server or tool restrictions. */
export function hasLegacyCodexComputerUseMcpPolicy(config: unknown): boolean {
  if (!isRecord(config)) {
    return false;
  }
  if (isRecord(config.mcp_servers) && Object.hasOwn(config.mcp_servers, "computer-use")) {
    return true;
  }
  const plugin = isRecord(config.plugins)
    ? config.plugins["computer-use@openai-bundled"]
    : undefined;
  return (
    isRecord(plugin) && isRecord(plugin.mcp_servers) && Object.keys(plugin.mcp_servers).length > 0
  );
}

async function readObject(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Publish the cache from the same prepared source that native plugin/install consumes. */
export async function reconcileManagedCodexComputerUseCache(params: {
  codexHome: string;
  config: ResolvedCodexComputerUseConfig;
  ownershipRoot?: string;
  managedMarketplacePath?: string;
  bundledMarketplacePath?: string;
  epoch?: number;
  assertCurrent: () => void;
  forceRefresh?: boolean;
  previousCacheBinding?: string;
}): Promise<string | undefined> {
  const config = await resolveManagedCodexComputerUseConfig(
    params.config,
    params.managedMarketplacePath,
  );
  params.assertCurrent();
  const bundledMarketplacePath = params.managedMarketplacePath ?? params.bundledMarketplacePath;
  const cacheBinding = [
    params.epoch ?? "manual",
    bundledMarketplacePath ?? "default",
    config.pluginName,
  ].join("\0");
  const cache = await ensureCodexComputerUseSharedPluginCache({
    codexHome: params.codexHome,
    config,
    ...(params.ownershipRoot ? { ownershipRoot: params.ownershipRoot } : {}),
    ...(bundledMarketplacePath ? { bundledMarketplacePath } : {}),
    assertCurrent: params.assertCurrent,
    forceRefresh: params.forceRefresh === true || params.previousCacheBinding !== cacheBinding,
  });
  params.assertCurrent();
  return cache.status === "shared" ? cacheBinding : undefined;
}
