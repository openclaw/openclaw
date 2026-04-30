/**
 * Merges bundled plugin MCP servers with user-configured MCP servers for agent
 * runtimes.
 */
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadEnabledBundleMcpConfig,
  type BundleMcpConfig,
  type BundleMcpDiagnostic,
  type BundleMcpServerConfig,
} from "../plugins/bundle-mcp.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { isRecord } from "../utils.js";

type MergedBundleMcpConfig = {
  config: BundleMcpConfig;
  diagnostics: BundleMcpDiagnostic[];
};

type BundleMcpServerMapper = (server: BundleMcpServerConfig, name: string) => BundleMcpServerConfig;

const OPENCLAW_TRANSPORT_TO_CLI_BUNDLE_TYPE: Record<string, string> = {
  "streamable-http": "http",
  http: "http",
  sse: "sse",
  stdio: "stdio",
};

/**
 * User config stores OpenClaw MCP transport names, while CLI backends such as
 * Claude Code and Gemini expect a downstream `type` field. Keep this adapter
 * out of the generic merge path because embedded OpenClaw still consumes the raw
 * OpenClaw `transport` shape directly.
 */
export function toCliBundleMcpServerConfig(server: BundleMcpServerConfig): BundleMcpServerConfig {
  const next = { ...server } as Record<string, unknown>;
  const rawTransport = next.transport;
  delete next.transport;
  if (typeof next.type === "string") {
    return next as BundleMcpServerConfig;
  }
  if (typeof rawTransport === "string") {
    const mapped = OPENCLAW_TRANSPORT_TO_CLI_BUNDLE_TYPE[rawTransport];
    if (mapped) {
      next.type = mapped;
    }
  }
  return next as BundleMcpServerConfig;
}

/** Loads enabled bundled MCP servers and overlays user config by server name. */
export function loadMergedBundleMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  mapConfiguredServer?: BundleMcpServerMapper;
}): MergedBundleMcpConfig {
  const bundleMcp = loadEnabledBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
  });
  const configuredMcp = normalizeConfiguredMcpServers(params.cfg?.mcp?.servers);
  const disabledConfiguredNames = new Set(
    Object.entries(configuredMcp)
      .filter(([, server]) => server.enabled === false)
      .map(([name]) => name),
  );
  const enabledConfiguredMcp = Object.fromEntries(
    Object.entries(configuredMcp).filter(([, server]) => server.enabled !== false),
  );
  const enabledBundleMcp = Object.fromEntries(
    Object.entries(bundleMcp.config.mcpServers).filter(
      ([name]) => !disabledConfiguredNames.has(name),
    ),
  );
  const mapConfiguredServer = params.mapConfiguredServer ?? ((server) => server);

  return {
    config: {
      // OpenClaw config is the owner-managed layer, so it overrides bundle defaults.
      mcpServers: {
        ...enabledBundleMcp,
        ...Object.fromEntries(
          Object.entries(enabledConfiguredMcp).map(([name, server]) => [
            name,
            mapConfiguredServer(server as BundleMcpServerConfig, name),
          ]),
        ),
      } satisfies BundleMcpConfig["mcpServers"],
    },
    diagnostics: bundleMcp.diagnostics,
  };
}

/**
 * Server names from owner-managed `cfg.mcp.servers` that opted in to OpenClaw
 * caller-context header injection. Plugin-supplied bundle MCP layers are
 * intentionally NOT scanned here: granting an enabled plugin permission to
 * receive `x-session-key` and caller identifiers must remain an explicit owner
 * decision, made by listing the server in `mcp.servers` with
 * `injectCallerContext: true`.
 */
export function ownerCallerContextOptInServerNames(cfg?: OpenClawConfig): Set<string> {
  const names = new Set<string>();
  const servers = cfg?.mcp?.servers;
  if (!servers) {
    return names;
  }
  for (const [name, server] of Object.entries(servers)) {
    if (isRecord(server) && server.injectCallerContext === true) {
      names.add(name);
    }
  }
  return names;
}

/** True if any server in owner-managed `cfg.mcp.servers` opts in to caller-context injection. */
export function ownerWantsBundleMcpCallerContextInjection(cfg?: OpenClawConfig): boolean {
  return ownerCallerContextOptInServerNames(cfg).size > 0;
}
