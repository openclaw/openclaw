import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  deliveryContextFromSession,
  getSessionEntryAsync,
  resolveStorePath,
  sessionDeliveryChannel,
} from "openclaw/plugin-sdk/session-store-runtime";

export type CodexStableCatalogDelivery = {
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
};

/**
 * Resolve the persisted session delivery channel for Pass 2 (durable native
 * dynamic-tool catalog) so transient internal/inter-session turns do not mutate
 * channel-sensitive tool schemas or tool membership.
 */
export async function resolveCodexStableCatalogDelivery(
  params: EmbeddedRunAttemptParams,
  sessionAgentId: string,
  sandboxSessionKey: string,
): Promise<CodexStableCatalogDelivery | undefined> {
  let delivery = params.sessionPromptDelivery;
  if (!delivery && (params.sessionTarget?.storePath || params.config?.session?.store)) {
    const sessionKey = params.sessionTarget?.sessionKey ?? params.sessionKey ?? sandboxSessionKey;
    const agentId = params.sessionTarget?.agentId ?? sessionAgentId;
    if (sessionKey?.trim()) {
      const storePath =
        params.sessionTarget?.storePath ??
        resolveStorePath(params.config?.session?.store, { agentId });
      try {
        const entry = await getSessionEntryAsync({
          agentId,
          sessionKey,
          storePath,
          hydrateSkillPromptRefs: false,
        });
        delivery = entry?.delivery;
      } catch {
        // Best-effort presentation read for durable catalog stability, falling back to turn channel.
      }
    }
  }
  if (delivery?.kind === "external") {
    const channel = sessionDeliveryChannel({ delivery });
    const ctx = deliveryContextFromSession({ delivery });
    return {
      ...(channel ? { channel } : {}),
      ...(ctx?.accountId ? { accountId: ctx.accountId } : {}),
      ...(ctx?.to ? { to: ctx.to } : {}),
      ...(ctx?.threadId !== undefined ? { threadId: ctx.threadId } : {}),
    };
  }
  if (delivery?.kind === "internal") {
    return { channel: "webchat" };
  }
  return undefined;
}

export async function resolveCodexStableCatalogOptions(params: {
  attempt: EmbeddedRunAttemptParams;
  ignoreRuntimePlan?: boolean;
  sessionAgentId: string;
  sandboxSessionKey: string;
  messageToolProvider?: string;
}): Promise<{
  stableCatalog?: true;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  messageProvider?: string;
  toolPolicyMessageProvider?: string;
}> {
  const { attempt, ignoreRuntimePlan, sessionAgentId, sandboxSessionKey, messageToolProvider } =
    params;
  const delivery = ignoreRuntimePlan
    ? await resolveCodexStableCatalogDelivery(attempt, sessionAgentId, sandboxSessionKey)
    : undefined;
  return {
    ...(ignoreRuntimePlan ? { stableCatalog: true as const } : {}),
    ...(delivery?.accountId ? { agentAccountId: delivery.accountId } : {}),
    ...(delivery?.to ? { messageTo: delivery.to } : {}),
    ...(delivery?.threadId !== undefined ? { messageThreadId: delivery.threadId } : {}),
    messageProvider: delivery?.channel ?? messageToolProvider,
    toolPolicyMessageProvider:
      delivery?.channel ?? attempt.messageProvider ?? attempt.messageChannel,
  };
}
