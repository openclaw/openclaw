import type { SessionToolOverrides } from "../config/sessions/types.js";
/**
 * Harness-facing materialization of configured OpenClaw MCP tools.
 * Static and requester-scoped transports share one OpenClaw-owned runtime.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { mergeMcpToolCatalogs } from "./agent-bundle-mcp-combined.js";
import {
  buildBundleMcpToolsFromCatalog,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import {
  getAdvertisedScopedMcpCatalog,
  getOrCreateRequesterScopedMcpRuntime,
  getOrCreateSessionMcpRuntime,
  rememberAdvertisedScopedMcpCatalog,
} from "./agent-bundle-mcp-runtime.js";
import type { McpToolCatalog, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import {
  resolveConversationCapabilityProfile,
  type ConversationCapabilityProfileParams,
  type ResolvedConversationCapabilityProfile,
} from "./conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "./embedded-agent-runner/effective-tool-policy.js";
import {
  applyEmbeddedAttemptToolsAllow,
  shouldCreateBundleMcpRuntimeForAttempt,
} from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { AnyAgentTool } from "./tools/common.js";

type ConfiguredHarnessMcpTools = {
  /** Executable tools for this turn (live binding or not-connected stubs). */
  tools: AnyAgentTool[];
  /**
   * Session-stable advertised tool surface for dynamic-tool fingerprints.
   * Identical for every sender once the session has observed a scoped catalog.
   */
  advertisedTools: AnyAgentTool[];
  appTools: AnyAgentTool[];
  diagnostics?: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>>["diagnostics"];
  restrictAppTools?: (allowedTools: readonly AnyAgentTool[]) => void;
  dispose: () => Promise<void>;
};

type RequesterScopedHarnessMcpTools = Pick<
  ConfiguredHarnessMcpTools,
  "tools" | "advertisedTools" | "dispose"
>;

type MaterializeConfiguredMcpToolsForHarnessRunParams = {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  requesterSenderId?: string | null;
  agentAccountId?: string | null;
  messageChannel?: string | null;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
  reservedToolNames?: Iterable<string>;
  toolsEnabled?: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
  /** When set, applies the same final effective tool policy as the embedded runner. */
  conversationCapabilityProfile?: ResolvedConversationCapabilityProfile;
  /** Builds a capability profile when conversationCapabilityProfile is omitted. */
  policyContext?: Omit<ConversationCapabilityProfileParams, "runtimeToolAllowlist">;
  warn?: (message: string) => void;
};

type MaterializeRequesterScopedMcpToolsForHarnessRunParams = Omit<
  MaterializeConfiguredMcpToolsForHarnessRunParams,
  "disableTools" | "toolsEnabled" | "toolOverrides"
>;

function notConnectedToolResult(serverName: string, toolName: string) {
  const message = `Requester has not connected MCP server "${serverName}" (tool "${toolName}") for this turn.`;
  return {
    content: [{ type: "text" as const, text: message }],
    details: {
      status: "error" as const,
      error: message,
      mcpServer: serverName,
      mcpTool: toolName,
    },
  };
}

function filterCatalogByScope(params: {
  catalog: McpToolCatalog;
  runtime: SessionMcpRuntime;
  requesterScoped: boolean;
}): McpToolCatalog {
  const isRequesterScoped = (serverName: string) =>
    params.runtime.isRequesterScopedServer?.(serverName) ??
    params.runtime.requesterScope !== undefined;
  const serverNames = new Set(
    Object.keys(params.catalog.servers).filter(
      (serverName) => isRequesterScoped(serverName) === params.requesterScoped,
    ),
  );
  return {
    version: 1,
    generatedAt: params.catalog.generatedAt,
    servers: Object.fromEntries(
      Object.entries(params.catalog.servers).filter(([serverName]) => serverNames.has(serverName)),
    ),
    tools: params.catalog.tools.filter((tool) => serverNames.has(tool.serverName)),
    ...(params.catalog.sessionDeniedTools
      ? {
          sessionDeniedTools: params.catalog.sessionDeniedTools.filter((tool) =>
            serverNames.has(tool.serverName),
          ),
        }
      : {}),
    ...(params.catalog.diagnostics ? { diagnostics: params.catalog.diagnostics } : {}),
  };
}

function applyHarnessToolPolicy(
  tools: AnyAgentTool[],
  params: MaterializeConfiguredMcpToolsForHarnessRunParams,
): AnyAgentTool[] {
  if (tools.length === 0) {
    return tools;
  }
  const allowed = applyEmbeddedAttemptToolsAllow(tools, params.toolsAllow, {
    toolMeta: (tool) => getPluginToolMeta(tool),
  });
  const profile =
    params.conversationCapabilityProfile ??
    (params.policyContext
      ? resolveConversationCapabilityProfile({
          ...params.policyContext,
          runtimeToolAllowlist: params.toolsAllow,
        })
      : undefined);
  if (!profile) {
    return allowed;
  }
  return applyFinalEffectiveToolPolicy({
    bundledTools: allowed,
    config: params.policyContext?.config ?? params.cfg,
    conversationCapabilityProfile: profile,
    warn: params.warn ?? (() => undefined),
  });
}

function buildHarnessMcpTools(params: {
  advertisedCatalog: McpToolCatalog;
  includeAppTools: boolean;
  liveRuntime?: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>>;
  materialization: MaterializeConfiguredMcpToolsForHarnessRunParams;
}): { materialized: ConfiguredHarnessMcpTools; hasProjectedSurface: boolean } {
  const reservedToolNames = params.materialization.reservedToolNames
    ? Array.from(params.materialization.reservedToolNames)
    : undefined;
  const advertisedTools = buildBundleMcpToolsFromCatalog({
    catalog: params.advertisedCatalog,
    reservedToolNames,
    createExecute: (tool) => async () => notConnectedToolResult(tool.serverName, tool.toolName),
    createResourceListExecute: (serverName) => async () =>
      notConnectedToolResult(serverName, "resources_list"),
    createResourceReadExecute: (serverName) => async () =>
      notConnectedToolResult(serverName, "resources_read"),
    createPromptListExecute: (serverName) => async () =>
      notConnectedToolResult(serverName, "prompts_list"),
    createPromptGetExecute: (serverName) => async () =>
      notConnectedToolResult(serverName, "prompts_get"),
  });
  const liveByName = new Map((params.liveRuntime?.tools ?? []).map((tool) => [tool.name, tool]));
  const tools = advertisedTools.map((tool) => liveByName.get(tool.name) ?? tool);
  const filteredTools = applyHarnessToolPolicy(tools, params.materialization);
  const filteredAdvertised = applyHarnessToolPolicy(advertisedTools, params.materialization);
  const projectedAppTools = params.includeAppTools
    ? (params.liveRuntime?.appTools ?? params.liveRuntime?.tools ?? [])
    : [];
  const filteredAppTools = applyHarnessToolPolicy(projectedAppTools, params.materialization);
  const allowedNames = new Set(filteredAdvertised.map((tool) => tool.name));
  const executableTools = filteredTools.filter((tool) => allowedNames.has(tool.name));

  let disposed = false;
  return {
    hasProjectedSurface: advertisedTools.length > 0 || projectedAppTools.length > 0,
    materialized: {
      tools: executableTools,
      advertisedTools: filteredAdvertised,
      appTools: filteredAppTools,
      diagnostics: params.liveRuntime?.diagnostics,
      restrictAppTools: params.liveRuntime?.restrictAppTools,
      dispose: async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        await params.liveRuntime?.dispose();
      },
    },
  };
}

/**
 * Materialize static and requester-scoped MCP tools for a harness run.
 * The session catalog remains stable after requester-scoped tools are observed.
 */
export async function materializeConfiguredMcpToolsForHarnessRun(
  params: MaterializeConfiguredMcpToolsForHarnessRunParams,
): Promise<ConfiguredHarnessMcpTools | undefined> {
  if (
    !shouldCreateBundleMcpRuntimeForAttempt({
      toolsEnabled: params.toolsEnabled !== false,
      disableTools: params.disableTools,
      toolsAllow: params.toolsAllow,
    })
  ) {
    return undefined;
  }
  const configuredRuntime = await getOrCreateSessionMcpRuntime({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
    requesterSenderId: params.requesterSenderId,
    agentAccountId: params.agentAccountId,
    messageChannel: params.messageChannel,
    toolOverrides: params.toolOverrides,
  });

  const liveRuntime = await materializeBundleMcpToolsForRun({
    runtime: configuredRuntime,
    reservedToolNames: params.reservedToolNames,
  });
  try {
    const catalog = configuredRuntime.peekCatalog() ?? (await configuredRuntime.getCatalog());
    const requesterCatalog = filterCatalogByScope({
      catalog,
      runtime: configuredRuntime,
      requesterScoped: true,
    });
    if (Object.keys(requesterCatalog.servers).length > 0) {
      rememberAdvertisedScopedMcpCatalog(params.sessionId, requesterCatalog);
    }
    const staticCatalog = filterCatalogByScope({
      catalog,
      runtime: configuredRuntime,
      requesterScoped: false,
    });
    const advertisedRequesterCatalog = getAdvertisedScopedMcpCatalog(params.sessionId);
    const advertisedCatalog = mergeMcpToolCatalogs(
      advertisedRequesterCatalog ? [staticCatalog, advertisedRequesterCatalog] : [staticCatalog],
    );
    const built = buildHarnessMcpTools({
      advertisedCatalog,
      includeAppTools: true,
      liveRuntime,
      materialization: params,
    });
    if (!built.hasProjectedSurface) {
      await built.materialized.dispose();
      return undefined;
    }
    return built.materialized;
  } catch (error) {
    await liveRuntime.dispose();
    throw error;
  }
}

/**
 * Requester-only compatibility path for harnesses that keep static MCP native.
 *
 * @deprecated Use materializeConfiguredMcpToolsForHarnessRun. This adapter remains
 * requester-scoped so existing harnesses do not open duplicate static transports.
 */
export async function materializeRequesterScopedMcpToolsForHarnessRun(
  params: MaterializeRequesterScopedMcpToolsForHarnessRunParams,
): Promise<RequesterScopedHarnessMcpTools | undefined> {
  const scopedRuntime = await getOrCreateRequesterScopedMcpRuntime(params);
  let liveRuntime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
  try {
    if (scopedRuntime) {
      liveRuntime = await materializeBundleMcpToolsForRun({
        runtime: scopedRuntime,
        reservedToolNames: params.reservedToolNames,
      });
      const catalog = scopedRuntime.peekCatalog() ?? (await scopedRuntime.getCatalog());
      rememberAdvertisedScopedMcpCatalog(params.sessionId, catalog);
    }

    const advertisedCatalog = getAdvertisedScopedMcpCatalog(params.sessionId);
    if (!advertisedCatalog) {
      await liveRuntime?.dispose();
      return undefined;
    }

    const built = buildHarnessMcpTools({
      advertisedCatalog,
      includeAppTools: false,
      liveRuntime,
      materialization: params,
    });
    if (!built.hasProjectedSurface) {
      await built.materialized.dispose();
      return undefined;
    }
    return {
      tools: built.materialized.tools,
      advertisedTools: built.materialized.advertisedTools,
      dispose: built.materialized.dispose,
    };
  } catch (error) {
    await liveRuntime?.dispose();
    throw error;
  }
}
