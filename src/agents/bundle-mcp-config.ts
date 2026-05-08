import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadEnabledBundleMcpConfig,
  type BundleMcpConfig,
  type BundleMcpDiagnostic,
  type BundleMcpServerConfig,
} from "../plugins/bundle-mcp.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import { normalizeToolName } from "./tool-policy.js";

type MergedBundleMcpConfig = {
  config: BundleMcpConfig;
  diagnostics: BundleMcpDiagnostic[];
};

type BundleMcpToolPolicy = {
  allow?: string[];
  deny?: string[];
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
 * out of the generic merge path because embedded Pi still consumes the raw
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

function buildMcpServerPolicyCandidates(name: string): string[] {
  const serverName = normalizeToolName(name);
  if (!serverName) {
    return [];
  }
  const mcpServerName = serverName.startsWith("mcp__") ? serverName : `mcp__${serverName}`;
  return Array.from(new Set([serverName, mcpServerName, `${mcpServerName}__tool`]));
}

function policyEntryTargetsMcpServer(entry: string, serverName: string): boolean {
  const normalizedEntry = normalizeToolName(entry);
  const normalizedServerName = normalizeToolName(serverName);
  if (!normalizedEntry || !normalizedServerName) {
    return false;
  }
  if (normalizedEntry === "*") {
    return true;
  }
  const mcpServerName = normalizedServerName.startsWith("mcp__")
    ? normalizedServerName
    : `mcp__${normalizedServerName}`;
  if (normalizedEntry === normalizedServerName || normalizedEntry === mcpServerName) {
    return true;
  }
  if (normalizedEntry.startsWith(`${mcpServerName}__`)) {
    return true;
  }
  return buildMcpServerPolicyCandidates(serverName).some(
    (candidate) => !isToolAllowedByPolicyName(candidate, { deny: [entry] }),
  );
}

function isMcpServerAllowedByToolPolicy(name: string, policy: BundleMcpToolPolicy): boolean {
  const deny = policy.deny ?? [];
  if (deny.some((entry) => policyEntryTargetsMcpServer(entry, name))) {
    return false;
  }
  const allow = policy.allow ?? [];
  if (allow.length === 0) {
    return true;
  }
  return allow.some((entry) => policyEntryTargetsMcpServer(entry, name));
}

export function filterBundleMcpConfigByToolPolicies(params: {
  config: BundleMcpConfig;
  policies?: Array<BundleMcpToolPolicy | undefined>;
}): BundleMcpConfig {
  const policies = (params.policies ?? []).filter((policy): policy is BundleMcpToolPolicy =>
    Boolean(policy?.allow || policy?.deny),
  );
  if (policies.length === 0) {
    return params.config;
  }
  return {
    mcpServers: Object.fromEntries(
      Object.entries(params.config.mcpServers).filter(([name]) =>
        policies.every((policy) => isMcpServerAllowedByToolPolicy(name, policy)),
      ),
    ),
  };
}

export function loadMergedBundleMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  mapConfiguredServer?: BundleMcpServerMapper;
}): MergedBundleMcpConfig {
  const bundleMcp = loadEnabledBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const configuredMcp = normalizeConfiguredMcpServers(params.cfg?.mcp?.servers);
  const mapConfiguredServer = params.mapConfiguredServer ?? ((server) => server);

  return {
    config: {
      // OpenClaw config is the owner-managed layer, so it overrides bundle defaults.
      mcpServers: {
        ...bundleMcp.config.mcpServers,
        ...Object.fromEntries(
          Object.entries(configuredMcp).map(([name, server]) => [
            name,
            mapConfiguredServer(server as BundleMcpServerConfig, name),
          ]),
        ),
      } satisfies BundleMcpConfig["mcpServers"],
    },
    diagnostics: bundleMcp.diagnostics,
  };
}
