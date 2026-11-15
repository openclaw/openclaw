import type { Client, Transport, McpSubscription } from "@modelcontextprotocol/client";
import type { SessionToolOverrides } from "../config/sessions/types.js";
/** Shared session MCP runtime constants and ownership contracts. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type {
  RequesterMcpConnect,
  SessionMcpRequesterScope,
  SessionMcpRuntime,
  SessionMcpRuntimeManager,
} from "./agent-bundle-mcp-types.js";
import type { bindMcpClientElicitation } from "./mcp-client-elicitation.runtime.js";
import type { McpServerConnectionResolved } from "./mcp-connection-resolver.js";
import type { McpToolCatalogMetadata } from "./mcp-tool-metadata.js";
import type { createNativeMcpClientBridge } from "./native-mcp-runtime-client.js";

export const SESSION_MCP_RUNTIME_MANAGER_KEY = Symbol.for("openclaw.sessionMcpRuntimeManager");
export const SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS = 60 * 1000;
// Includes runtimes being created or drained; idle owners yield capacity at the limit.
export const SESSION_MCP_MAX_LIVE_RUNTIMES = 256;

export class SessionMcpRuntimeCapacityError extends Error {
  constructor(
    readonly notify: boolean,
    message = "MCP tools are temporarily unavailable: all 256 Gateway MCP runtimes are in use. This turn will continue without MCP tools; retry on the next turn.",
  ) {
    super(message);
  }
}

/** TTL eviction is opt-in; capacity eviction also applies when zero. */
export function resolveSessionMcpRuntimeIdleTtlMs(cfg?: OpenClawConfig): number {
  return Math.floor(cfg?.mcp?.sessionIdleTtlMs ?? 0);
}

/** Checks whether harness-scoped MCP can affect a turn without loading its runtime graph. */
export function shouldLoadRequesterScopedMcpHarnessRuntime(params: {
  sessionId: string;
  requesterSenderId?: string | null;
}): boolean {
  if (params.requesterSenderId?.trim()) {
    return true;
  }
  const manager = (globalThis as Record<PropertyKey, unknown>)[SESSION_MCP_RUNTIME_MANAGER_KEY] as
    | SessionMcpRuntimeManager
    | undefined;
  return (manager?.getAdvertisedScopedCatalog(params.sessionId)?.tools.length ?? 0) > 0;
}

export type CreateSessionMcpRuntime = (params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  includeServerNames?: ReadonlySet<string>;
  excludeServerNames?: ReadonlySet<string>;
  safeServerNamesByServer?: ReadonlyMap<string, string>;
  connectionOverrides?: ReadonlyMap<string, McpServerConnectionResolved>;
  redactConnectionServerNames?: ReadonlySet<string>;
  requesterScope?: SessionMcpRequesterScope;
  requesterConnect?: RequesterMcpConnect;
  configFingerprint?: string;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
  toolDenylist?: string[];
}) => SessionMcpRuntime | Promise<SessionMcpRuntime>;

export type BundleMcpSession = {
  serverName: string;
  client: Client;
  transport: Transport;
  transportType: "stdio" | "sse" | "streamable-http";
  requestTimeoutMs: number;
  connected: boolean;
  disconnectReason?: string;
  retiring: boolean;
  connectPromise?: Promise<void>;
  disposePromise?: Promise<void>;
  detachStderr?: () => void;
  toolMetadata?: McpToolCatalogMetadata;
  withElicitation?: ReturnType<typeof bindMcpClientElicitation>;
  nativeBridge?: ReturnType<typeof createNativeMcpClientBridge>;
  nativeSubscription?: McpSubscription;
};

export type ServerMcpRuntime = SessionMcpRuntime & {
  readonly pluginOwned: boolean;
  resetStartupBackoff: () => void;
  readonly nativeContextKey: string | undefined;
  readonly nativeCapabilityContext: object | undefined;
  readonly nativeViewCount: number;
};
