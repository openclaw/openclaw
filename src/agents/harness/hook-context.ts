import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildAgentHookContextIdentityFields } from "../../plugins/hook-agent-context.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import {
  assertMemoryAudienceCurrent,
  assertMemoryAudienceSession,
} from "../../plugins/memory-audience.js";
import type { MemoryAudience } from "../../plugins/memory-provider-types.js";

/**
 * Only stable run/session/model facts are forwarded to plugin hooks; config remains a local
 * construction input so hooks do not accidentally depend on mutable raw configuration.
 */
export type AgentHarnessHookContext = Omit<
  PluginHookAgentContext,
  | "activeProjectKeys"
  | "senderExternalId"
  | "toolAuthority"
  | "hookInvocation"
  | "assertMemoryAudienceCurrent"
> & {
  config?: OpenClawConfig;
};

/**
 * Bind a host-minted audience to its session and pair it with its currentness guard.
 * The host derives the guard from the audience, so hooks never receive one without it.
 * Every runner's hook context takes these fields from here, so the rule has one owner.
 */
export function buildAgentHookMemoryAudienceFields(
  memoryAudience: MemoryAudience | undefined,
  sessionKey: string | undefined,
): Pick<PluginHookAgentContext, "memoryAudience" | "assertMemoryAudienceCurrent"> {
  if (!memoryAudience) {
    return {};
  }
  assertMemoryAudienceSession(memoryAudience, sessionKey);
  return {
    memoryAudience,
    assertMemoryAudienceCurrent: () => assertMemoryAudienceCurrent(memoryAudience),
  };
}

export function buildAgentHookContext(params: AgentHarnessHookContext): PluginHookAgentContext {
  const memoryAudienceFields = buildAgentHookMemoryAudienceFields(
    params.memoryAudience,
    params.sessionKey,
  );
  return {
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.trace ? { trace: params.trace } : {}),
    ...(params.jobId ? { jobId: params.jobId } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...memoryAudienceFields,
    ...(params.sandboxed !== undefined ? { sandboxed: params.sandboxed } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.modelProviderId ? { modelProviderId: params.modelProviderId } : {}),
    ...(params.modelId ? { modelId: params.modelId } : {}),
    ...(params.messageProvider ? { messageProvider: params.messageProvider } : {}),
    // The agent's configured channel account is routing context, not requester identity.
    // Keep it on non-user turns while the identity projection below withholds sender/chat facts.
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.channel ? { channel: params.channel } : {}),
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(params.toolNames ? { toolNames: Object.freeze([...params.toolNames]) } : {}),
    ...(params.completedTurn
      ? {
          completedTurn: Object.freeze({
            sessionId: params.completedTurn.sessionId,
            entryId: params.completedTurn.entryId,
          }),
        }
      : {}),
    ...(params.inputProvenance ? { inputProvenance: params.inputProvenance } : {}),
    ...(params.channelId ? { channelId: params.channelId } : {}),
    ...(params.contextTokenBudget ? { contextTokenBudget: params.contextTokenBudget } : {}),
    ...(params.contextWindowSource ? { contextWindowSource: params.contextWindowSource } : {}),
    ...(params.contextWindowReferenceTokens
      ? { contextWindowReferenceTokens: params.contextWindowReferenceTokens }
      : {}),
    ...buildAgentHookContextIdentityFields(params),
  };
}
