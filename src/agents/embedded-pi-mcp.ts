import fs from "node:fs";
import process from "node:process";
import { normalizeConfiguredMcpServers } from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpDiagnostic, BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import { loadEnabledBundleMcpConfig } from "../plugins/bundle-mcp.js";

export type EmbeddedPiMcpConfig = {
  mcpServers: Record<string, BundleMcpServerConfig>;
  diagnostics: BundleMcpDiagnostic[];
};

export type EmbeddedPiMcpPolicy = {
  externalMcpEnabled?: boolean;
  allowedMcpServers?: string[];
  toolPolicy?: string;
  runId?: string;
  jobId?: string;
};

const MCP_LIVE_DEBUG_PATH = "/tmp/openclaw-agent-exec-mcp-live-debug.jsonl";
const MCP_LIVE_DEBUG_ENV = "OPENCLAW_AGENT_EXEC_DEBUG";

function appendMcpLiveDebugEvent(event: Record<string, unknown>): void {
  if (process.env[MCP_LIVE_DEBUG_ENV] !== "1") {
    return;
  }
  try {
    fs.appendFileSync(
      MCP_LIVE_DEBUG_PATH,
      `${JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, ppid: process.ppid, ...event })}\n`,
      "utf8",
    );
  } catch {
    // ignore debug write failures
  }
}

function applyEmbeddedPiMcpPolicy(params: {
  mcpServers: Record<string, BundleMcpServerConfig>;
  policy?: EmbeddedPiMcpPolicy;
}): Record<string, BundleMcpServerConfig> {
  if (params.policy?.externalMcpEnabled === false) {
    return {};
  }
  const allowed = params.policy?.allowedMcpServers?.filter((name) => name.trim().length > 0) ?? [];
  if (allowed.length === 0) {
    return params.mcpServers;
  }
  const allowSet = new Set(allowed);
  return Object.fromEntries(
    Object.entries(params.mcpServers).filter(([serverName]) => allowSet.has(serverName)),
  );
}

export function loadEmbeddedPiMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  policy?: EmbeddedPiMcpPolicy;
}): EmbeddedPiMcpConfig {
  const bundleMcp = loadEnabledBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const configuredMcp = normalizeConfiguredMcpServers(params.cfg?.mcp?.servers);

  const mergedServers = {
    // OpenClaw config is the owner-managed layer, so it overrides bundle defaults.
    ...bundleMcp.config.mcpServers,
    ...configuredMcp,
  };

  const filteredServers = applyEmbeddedPiMcpPolicy({
    mcpServers: mergedServers,
    policy: params.policy,
  });
  const serverNames = Object.keys(filteredServers).toSorted();
  appendMcpLiveDebugEvent({
    source: "src/agents/embedded-pi-mcp.ts#loadEmbeddedPiMcpConfig",
    run_id: params.policy?.runId,
    job_id: params.policy?.jobId,
    tool_policy: params.policy?.toolPolicy,
    external_mcp_enabled: params.policy?.externalMcpEnabled,
    allowed_mcp_servers: params.policy?.allowedMcpServers ?? [],
    mcp_server_names: serverNames,
    has_zapier: serverNames.includes("zapier") || serverNames.includes("zapier_remote_test"),
    materialization: serverNames.length === 0 ? "skipped" : "allowed",
  });
  return {
    mcpServers: filteredServers,
    diagnostics: bundleMcp.diagnostics,
  };
}
