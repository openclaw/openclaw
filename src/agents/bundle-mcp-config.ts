/**
 * Merges bundled plugin MCP servers with user-configured MCP servers for agent
 * runtimes.
 */
import fs from "node:fs";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { SessionToolOverrides } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  loadEnabledBundleMcpConfig,
  type BundleMcpConfig,
  type BundleMcpDataDirOwnership,
  type BundleMcpDiagnostic,
  type BundleMcpServerConfig,
} from "../plugins/bundle-mcp.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { partitionMcpServersByConnectionScope } from "./mcp-connection-resolver.js";

type MergedBundleMcpConfig = {
  config: BundleMcpConfig;
  diagnostics: BundleMcpDiagnostic[];
  pluginIdsByServer?: Record<string, string>;
  prepareDataDirsByServer: Record<string, BundleMcpDataDirOwnership>;
};

const OPENCLAW_TRANSPORT_TO_CLI_BUNDLE_TYPE: Record<string, string> = {
  "streamable-http": "http",
  http: "http",
  sse: "sse",
  stdio: "stdio",
};

/** Session-shared harness connections must exclude requester-owned credentials. */
export function loadStaticBundleMcpConfig(
  params: Parameters<typeof loadMergedBundleMcpConfig>[0],
): MergedBundleMcpConfig & { requesterScopedServerNames: string[] } {
  const loaded = loadMergedBundleMcpConfig(params);
  const { staticServers, requesterScopedServerNames } = partitionMcpServersByConnectionScope(
    loaded.config.mcpServers,
  );
  return {
    ...loaded,
    config: { mcpServers: staticServers },
    prepareDataDirsByServer: Object.fromEntries(
      Object.entries(loaded.prepareDataDirsByServer).filter(([name]) =>
        Object.hasOwn(staticServers, name),
      ),
    ),
    requesterScopedServerNames,
  };
}

export function prepareOwnedBundleMcpDataDirs(params: {
  config: BundleMcpConfig;
  prepareDataDirsByServer: Record<string, BundleMcpDataDirOwnership>;
}): MergedBundleMcpConfig {
  const mcpServers = { ...params.config.mcpServers };
  const prepareDataDirsByServer: Record<string, BundleMcpDataDirOwnership> = {};
  const diagnostics: BundleMcpDiagnostic[] = [];
  for (const [serverName, ownership] of Object.entries(params.prepareDataDirsByServer)) {
    if (!Object.hasOwn(mcpServers, serverName)) {
      continue;
    }
    try {
      fs.mkdirSync(ownership.dataDir, { recursive: true });
      prepareDataDirsByServer[serverName] = ownership;
    } catch (error) {
      delete mcpServers[serverName];
      diagnostics.push({
        pluginId: ownership.pluginId,
        message: `unable to prepare PLUGIN_DATA directory "${ownership.dataDir}" for MCP server "${serverName}": ${formatErrorMessage(error)}`,
      });
    }
  }
  return { config: { mcpServers }, diagnostics, prepareDataDirsByServer };
}

/**
 * User config stores OpenClaw MCP transport names, while CLI backends such as
 * Claude Code and Gemini expect a downstream `type` field. Keep this adapter
 * at the output boundary so OAuth and runtime policy keep canonical transport.
 */
export function toCliBundleMcpServerConfig(server: BundleMcpServerConfig): BundleMcpServerConfig {
  const next = { ...server };
  const rawTransport = next.transport;
  delete next.transport;
  if (typeof rawTransport === "string") {
    const mapped = OPENCLAW_TRANSPORT_TO_CLI_BUNDLE_TYPE[rawTransport];
    if (mapped) {
      next.type = mapped;
    }
  }
  return next;
}

/** Loads enabled bundled MCP servers and overlays user config by server name. */
export function loadMergedBundleMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers">;
}): MergedBundleMcpConfig {
  const bundleMcp = loadEnabledBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
  });
  const configuredMcp = normalizeConfiguredMcpServers(params.cfg?.mcp?.servers);
  const serverOverrides = params.toolOverrides?.mcpServers;
  // Merge owner config first so a disabled override also tombstones its bundle default.
  const mcpServers = Object.fromEntries(
    Object.entries({ ...bundleMcp.config.mcpServers, ...configuredMcp }).filter(([name]) => {
      const override =
        serverOverrides && Object.hasOwn(serverOverrides, name) ? serverOverrides[name] : undefined;
      return override !== false && (override === true || configuredMcp[name]?.enabled !== false);
    }),
  );
  const isUnshadowedBundleServer = ([name]: [string, unknown]) =>
    Object.hasOwn(mcpServers, name) && !Object.hasOwn(configuredMcp, name);
  const prepareDataDirsByServer = Object.fromEntries(
    Object.entries(bundleMcp.prepareDataDirsByServer ?? {}).filter(isUnshadowedBundleServer),
  );

  return {
    config: { mcpServers },
    diagnostics: bundleMcp.diagnostics,
    pluginIdsByServer: Object.fromEntries(
      Object.entries(bundleMcp.pluginIdsByServer).filter(isUnshadowedBundleServer),
    ),
    prepareDataDirsByServer,
  };
}
