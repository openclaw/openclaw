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
import { isValidAgentId, normalizeAgentId } from "../routing/session-key.js";

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

function normalizeAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => isValidAgentId(entry))
    .map((entry) => normalizeAgentId(entry));
}

/**
 * Shared per-agent MCP allowlist gate used by every runtime (CLI, embedded, and
 * Codex app-server). `hasAllowlist=false` means the server declared no scope, so
 * it stays visible to every agent (historical behavior). When a scope is
 * declared, an empty/invalid list or a run with no agent id fails closed, so a
 * misconfigured scope never silently widens to all agents. Both the generic
 * `agents` field and Codex's nested `codex.agents` route through this so the two
 * surfaces can never diverge in behavior.
 */
export function isMcpServerAllowedForAgentIds(
  hasAllowlist: boolean,
  allowlist: unknown,
  agentId: string | undefined,
): boolean {
  if (!hasAllowlist) {
    return true;
  }
  const agentIds = normalizeAgentIds(allowlist);
  if (agentIds.length === 0 || !agentId) {
    return false;
  }
  return agentIds.includes(normalizeAgentId(agentId));
}

/**
 * Resolves the generic per-server `agents` allowlist for the shared CLI/embedded
 * merge. Codex's app-server path layers `codex.agents` precedence on top via
 * isMcpServerAllowedForAgentIds directly.
 */
function isMcpServerAllowedForAgent(
  server: Record<string, unknown>,
  agentId: string | undefined,
): boolean {
  return isMcpServerAllowedForAgentIds(Object.hasOwn(server, "agents"), server.agents, agentId);
}

/** Loads enabled bundled MCP servers and overlays user config by server name. */
export function loadMergedBundleMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  agentId?: string;
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
    Object.entries(configuredMcp).filter(
      ([, server]) =>
        server.enabled !== false && isMcpServerAllowedForAgent(server, params.agentId),
    ),
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
          Object.entries(enabledConfiguredMcp).map(([name, server]) => {
            // `agents` is an OpenClaw-side scoping control, not a downstream MCP
            // field. Strip it so it never leaks into the launched server config.
            const { agents: _agents, ...downstream } = server as Record<string, unknown>;
            return [name, mapConfiguredServer(downstream as BundleMcpServerConfig, name)];
          }),
        ),
      } satisfies BundleMcpConfig["mcpServers"],
    },
    diagnostics: bundleMcp.diagnostics,
  };
}
