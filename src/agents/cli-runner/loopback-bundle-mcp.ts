import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import { setBundleMcpToolServerInstructions } from "../agent-bundle-mcp-instructions.js";
import { TOOL_NAME_SEPARATOR } from "../agent-bundle-mcp-names.js";
import { loadSessionMcpConfig } from "../agent-bundle-mcp-runtime-config.js";
import {
  acquireSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
} from "../agent-bundle-mcp-tools.js";
import type { BundleMcpToolRuntime } from "../agent-bundle-mcp-types.js";
import { applyFinalEffectiveToolPolicy } from "../embedded-agent-runner/effective-tool-policy.js";
import {
  applyEmbeddedAttemptToolsAllow,
  shouldCreateBundleMcpRuntimeForAttempt,
} from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { AnyAgentTool } from "../tools/common.js";
import { cliBackendLog } from "./log.js";
import type { resolveCliNativeMcpPolicy } from "./prepare-mcp.js";
import type { RunCliAgentParams } from "./types.js";

type CliCapabilityProfile = Awaited<ReturnType<typeof resolveCliNativeMcpPolicy>>;

/** Run-owned configured MCP tools served through the OpenClaw loopback bridge. */
export type CliLoopbackBundleMcp = {
  tools: readonly AnyAgentTool[];
  /** Transfers disposal to the prepared run's cleanup chain. */
  takeCleanup: () => () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

/**
 * Local Claude and exclusive CLI runs use one Gateway-owned configured MCP
 * catalog. Materialize its tools for the bridge, which enforces each turn's
 * policy on call independently of the CLI's native tool selection.
 */
export async function prepareCliLoopbackBundleMcp(params: {
  run: RunCliAgentParams;
  config: OpenClawConfig;
  workspaceDir: string;
  agentId: string;
  agentDir: string;
  resolveCapabilityProfile: () => Promise<CliCapabilityProfile>;
  runtimeToolsAllow?: string[];
}): Promise<CliLoopbackBundleMcp | undefined> {
  const { run } = params;
  if (!run.sessionId) {
    return undefined;
  }
  const configuredServers = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.config,
    toolOverrides: run.toolOverrides,
    logDiagnostics: false,
  });
  if (Object.keys(configuredServers.loaded.mcpServers).length === 0) {
    return undefined;
  }
  const capabilityProfile = await params.resolveCapabilityProfile();
  const mcpConfig = {
    workspaceDir: params.workspaceDir,
    cfg: params.config,
    toolOverrides: run.toolOverrides,
    toolDenylist: capabilityProfile.policy.explicitToolDenylist,
  };
  const { loaded, safeServerNamesByServer } = loadSessionMcpConfig({
    ...mcpConfig,
    logDiagnostics: false,
  });
  if (Object.keys(loaded.mcpServers).length === 0) {
    return undefined;
  }
  const toolsAllow = params.runtimeToolsAllow ?? run.cliToolAvailability?.openClaw;
  const enabled = shouldCreateBundleMcpRuntimeForAttempt({
    toolsEnabled: true,
    disableTools: run.disableTools,
    toolsAllow,
    resolveConfiguredMcpNamespaces: () =>
      Object.keys(params.config.mcp?.servers ?? {}).flatMap((name) => {
        const safeName = Object.hasOwn(loaded.mcpServers, name)
          ? safeServerNamesByServer.get(name)
          : undefined;
        return safeName ? [`${safeName}${TOOL_NAME_SEPARATOR}`] : [];
      }),
  });
  if (!enabled) {
    return undefined;
  }
  let materialized: BundleMcpToolRuntime;
  try {
    const acquisition = await acquireSessionMcpRuntime({
      ...mcpConfig,
      sessionId: run.sessionId,
      sessionKey: run.sessionKey,
      agentId: params.agentId,
      agentDir: params.agentDir,
      // The catalog must not depend on which turn asks for it. Requester-scoped
      // servers need a verified sender, which completions and automations lack.
      requesterSenderId: undefined,
      agentAccountId: run.agentAccountId,
      messageChannel: run.messageChannel ?? run.messageProvider,
    });
    materialized = await materializeBundleMcpToolsForRun({
      ...acquisition,
      agentId: params.agentId,
    });
    // Claude received server instructions over its native connection; keep
    // them with the bridged tools so the loopback can serve them.
    const servers = acquisition.runtime.peekCatalog()?.servers ?? {};
    for (const tool of materialized.tools) {
      const serverName = getPluginToolMeta(tool)?.mcp?.serverName;
      if (serverName && Object.hasOwn(servers, serverName)) {
        setBundleMcpToolServerInstructions(tool, serverName, servers[serverName]?.instructions);
      }
    }
  } catch (error) {
    cliBackendLog.warn(`configured MCP servers unavailable for this CLI run: ${String(error)}`);
    return undefined;
  }
  if (materialized.restrictAppTools) {
    // MCP app views outlive one call; bind them to this run's complete policy now.
    materialized.restrictAppTools(
      applyFinalEffectiveToolPolicy({
        bundledTools: applyEmbeddedAttemptToolsAllow(
          materialized.appTools ?? materialized.tools,
          toolsAllow,
          { toolMeta: (tool) => getPluginToolMeta(tool) },
        ),
        config: params.config,
        workspaceDir: params.workspaceDir,
        conversationCapabilityProfile: capabilityProfile,
        warn: (message) => cliBackendLog.warn(message),
      }),
    );
  }
  let owned = true;
  const dispose = () => materialized.dispose();
  return {
    tools: materialized.tools,
    takeCleanup: () => {
      owned = false;
      return dispose;
    },
    [Symbol.asyncDispose]: async () => {
      if (owned) {
        owned = false;
        await dispose();
      }
    },
  };
}
