import type { SessionToolOverrides } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpDiagnostic } from "../plugins/bundle-mcp.types.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";

/** Codex app-server `mcp_servers` config map. */
export type CodexMcpServersConfig = Record<string, Record<string, unknown>>;

export type CodexBundleMcpThreadConfig = {
  configPatch?: {
    mcp_servers: CodexMcpServersConfig;
  };
  diagnostics: BundleMcpDiagnostic[];
  evaluated: boolean;
  fingerprint?: string;
  /** Enabled static servers across bundle defaults and owner config. */
  staticServerNames: string[];
  /** Enabled static servers originating from owner `mcp.servers` config. */
  userStaticServerNames: string[];
};

export type LoadCodexBundleMcpThreadConfigParams = {
  workspaceDir: string;
  agentId?: string;
  agentDir?: string;
  /** False for remote app servers, which must not receive OpenClaw-managed MCP bearers. */
  allowLiteralOAuthProjection?: boolean;
  onServerUnavailable?: (serverName: string, error: unknown) => void;
  /** Cancels OAuth bearer resolution; an abort rejects instead of omitting the server. */
  signal?: AbortSignal;
  /** Read-only initialization cannot provision data directories or requester transports. */
  preparationOnly?: true;
  cfg?: OpenClawConfig;
  toolsEnabled?: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
};
