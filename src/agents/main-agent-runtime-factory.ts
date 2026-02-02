import type { OpenClawConfig } from "../config/config.js";
import type { AgentRuntime } from "./agent-runtime.js";
import type { SandboxContext } from "./sandbox.js";
import type { AnyAgentTool } from "./tools/common.js";
import { resolveMcpToolsForAgent } from "../mcp/mcp-tools.js";
import {
  DEFAULT_AGENT_ID,
  isSubagentSessionKey,
  normalizeAgentId,
} from "../routing/session-key.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { createSdkAgentRuntime } from "./claude-agent-sdk/sdk-agent-runtime.js";
import { resolveThinkingBudget } from "./claude-agent-sdk/sdk-runner.config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import { resolveSandboxContext } from "./sandbox.js";

export type MainAgentRuntimeKind = "pi" | "claude";

export function resolveMainAgentRuntimeKind(config?: OpenClawConfig): MainAgentRuntimeKind {
  // mainRuntime overrides the global runtime for the main agent only.
  const configured =
    config?.agents?.defaults?.mainRuntime ??
    config?.agents?.main?.runtime ??
    config?.agents?.defaults?.runtime;
  return configured === "claude" ? "claude" : "pi";
}

/**
 * Resolve the runtime kind for any agent (not just "main").
 *
 * Resolution order:
 * 1. Per-agent override: `agents.list[i].runtime`
 * 2. For main agent: `agents.defaults.mainRuntime` or `agents.main.runtime`
 * 3. Global default: `agents.defaults.runtime`
 * 4. Fallback: "pi"
 */
export function resolveAgentRuntimeKind(
  config: OpenClawConfig | undefined,
  agentId: string,
): MainAgentRuntimeKind {
  if (!config) {
    return "pi";
  }

  const normalized = normalizeAgentId(agentId);

  // 1. Try per-agent override
  const agentConfig = resolveAgentConfig(config, normalized);
  if (agentConfig?.runtime) {
    return agentConfig.runtime === "claude" ? "claude" : "pi";
  }

  // 2. For main agent, use mainRuntime logic
  if (normalized === DEFAULT_AGENT_ID) {
    return resolveMainAgentRuntimeKind(config);
  }

  // 3. Use global default
  const globalRuntime = config.agents?.defaults?.runtime;
  return globalRuntime === "claude" ? "claude" : "pi";
}

/**
 * Resolve the runtime kind for a session, with proper subagent inheritance.
 *
 * For subagent sessions (e.g., `agent:main:subagent:UUID`), this function:
 * 1. Checks for explicit subagent runtime config on the parent agent
 * 2. Checks for global subagent runtime defaults
 * 3. Falls back to the parent agent's runtime (inheritance)
 *
 * This ensures subagents inherit their parent's runtime by default, which is
 * important when using Claude Code SDK (claude runtime) - subagents should also use
 * the claude runtime rather than falling back to Pi (which requires separate API keys).
 */
export function resolveSessionRuntimeKind(
  config: OpenClawConfig | undefined,
  agentId: string,
  sessionKey?: string,
): MainAgentRuntimeKind {
  if (!config) {
    return "pi";
  }

  const normalized = normalizeAgentId(agentId);
  const isSubagent = sessionKey ? isSubagentSessionKey(sessionKey) : false;

  // For subagents, check for explicit subagent runtime config first
  if (isSubagent) {
    // 1. Check per-agent subagent runtime config
    const agentConfig = resolveAgentConfig(config, normalized);
    const subagentRuntime = agentConfig?.subagents?.runtime;
    if (subagentRuntime && subagentRuntime !== "inherit") {
      return subagentRuntime === "claude" ? "claude" : "pi";
    }

    // 2. Check global subagent runtime defaults
    const globalSubagentRuntime = config.agents?.defaults?.subagents?.runtime;
    if (globalSubagentRuntime && globalSubagentRuntime !== "inherit") {
      return globalSubagentRuntime === "claude" ? "claude" : "pi";
    }

    // 3. Inherit from parent agent's runtime (fall through to regular resolution)
  }

  // Regular agent runtime resolution (also used as inheritance source for subagents)
  return resolveAgentRuntimeKind(config, agentId);
}

export type CreateSdkMainAgentRuntimeParams = {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  abortSignal?: AbortSignal;

  // Message + threading context for tool policy + routing.
  messageProvider?: string;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };

  // Optional overrides for testing / callers that already resolved these.
  sandbox?: SandboxContext | null;
  tools?: AnyAgentTool[];
  /** Claude Code session ID for native session resume (avoids history serialization). */
  claudeSessionId?: string;
};

export async function createSdkMainAgentRuntime(
  params: CreateSdkMainAgentRuntimeParams,
): Promise<AgentRuntime> {
  const sandbox =
    params.sandbox ??
    (await resolveSandboxContext({
      config: params.config,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
    }));

  const agentIdForMcp = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.config,
  });

  const mcpTools = params.tools
    ? []
    : await resolveMcpToolsForAgent({
        config: params.config,
        agentId: agentIdForMcp,
        abortSignal: params.abortSignal,
      });

  const tools =
    params.tools ??
    createOpenClawCodingTools({
      config: params.config,
      sandbox,
      workspaceDir: params.workspaceDir,
      sessionKey: params.sessionKey,
      agentDir: params.agentDir,
      abortSignal: params.abortSignal,
      messageProvider: params.messageProvider,
      agentAccountId: params.agentAccountId,
      messageTo: params.messageTo,
      messageThreadId: params.messageThreadId,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      spawnedBy: params.spawnedBy,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
      currentChannelId: params.currentChannelId,
      currentThreadTs: params.currentThreadTs,
      replyToMode: params.replyToMode,
      hasRepliedRef: params.hasRepliedRef,
      extraTools: mcpTools,
    });

  const sdkCfg = params.config?.agents?.main?.sdk;

  return createSdkAgentRuntime({
    tools: tools as AnyAgentTool[],
    claudeSessionId: params.claudeSessionId,
    model: sdkCfg?.model,
    thinkingBudget: resolveThinkingBudget(sdkCfg?.thinkingBudget),
    hooksEnabled: sdkCfg?.hooksEnabled ?? true,
    sdkOptions: sdkCfg?.options,
  });
}
