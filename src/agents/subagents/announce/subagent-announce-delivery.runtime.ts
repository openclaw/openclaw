/**
 * Runtime dependency owner for subagent announcement delivery.
 */
import "../../../auto-reply/reply/queue.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { loadSessionEntryReadOnly as loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import "../../../infra/outbound/best-effort-delivery.js";
import "../../../infra/outbound/bound-delivery-router.js";
import "../../../infra/outbound/conversation-id.js";
import { sendMessage } from "../../../infra/outbound/message.js";
import "../../../plugins/hook-runner-global.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../../routing/session-key.js";
import { resolveActiveEmbeddedRunSessionId } from "../../embedded-agent-runner/active-run-projections.js";
import type { EmbeddedAgentQueueMessageOptions } from "../../embedded-agent-runner/run-state.js";
import {
  formatEmbeddedAgentQueueFailureSummary,
  isEmbeddedAgentRunActive,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  queueGuardedEmbeddedAgentMessageWithOutcomeAsync,
  resolveEmbeddedRunAbandonment,
  type EmbeddedAgentQueueMessageOutcome,
} from "../../embedded-agent-runner/runs.js";
import { dispatchGatewayMethodInProcess } from "./subagent-announce.runtime.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";
export { resolveQueueSettings } from "../../../auto-reply/reply/queue.js";
export { resolveExternalBestEffortDeliveryTarget } from "../../../infra/outbound/best-effort-delivery.js";
export { createBoundDeliveryRouter } from "../../../infra/outbound/bound-delivery-router.js";
export { resolveConversationIdFromTargets } from "../../../infra/outbound/conversation-id.js";
export { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";

export { formatEmbeddedAgentQueueFailureSummary };

type RequesterSessionEntryResult = {
  cfg: ReturnType<typeof getRuntimeConfig>;
  entry: ReturnType<typeof loadSessionEntry>;
  canonicalKey: string;
  agentId?: string;
  storePath?: string;
};

export function tryResolveSubagentRequesterAgentId(
  cfg: OpenClawConfig,
  requesterSessionKey: string,
  explicitAgentId?: string,
): string | undefined {
  const requestedAgentId = explicitAgentId?.trim() ? normalizeAgentId(explicitAgentId) : undefined;
  const parsedAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;
  if (requestedAgentId && parsedAgentId && requestedAgentId !== parsedAgentId) {
    return undefined;
  }
  const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, requesterSessionKey);
  if (persistedStoreOwner.kind === "retired") {
    return undefined;
  }
  if (
    requestedAgentId &&
    persistedStoreOwner.kind === "configured" &&
    requestedAgentId !== persistedStoreOwner.agentId
  ) {
    return undefined;
  }
  const resolvedAgentId = requestedAgentId ?? parsedAgentId;
  if (resolvedAgentId) {
    return resolvedAgentId;
  }
  return (
    (persistedStoreOwner.kind === "configured" ? persistedStoreOwner.agentId : undefined) ??
    tryResolveLegacyCompatibilityAgentId(cfg)
  );
}

export function loadRequesterSessionEntry(
  requesterSessionKey: string,
  explicitAgentId?: string,
): RequesterSessionEntryResult {
  const cfg = getRuntimeConfig();
  const rawStorageKey = requesterSessionKey.trim();
  const canonicalKey = resolveRequesterStoreKey(cfg, requesterSessionKey, explicitAgentId);
  const configuredMainKey = normalizeMainKey(cfg.session?.mainKey);
  const storageKey =
    rawStorageKey === "main" || rawStorageKey === configuredMainKey ? canonicalKey : rawStorageKey;
  const agentId = tryResolveSubagentRequesterAgentId(cfg, rawStorageKey, explicitAgentId);
  if (!agentId) {
    return { cfg, entry: undefined, canonicalKey };
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const entry = loadSessionEntry({
    storePath,
    sessionKey: storageKey,
    agentId,
    clone: false,
  });
  return { cfg, entry, canonicalKey, agentId, storePath };
}

export function getSubagentAnnounceRuntimeConfig() {
  return getRuntimeConfig();
}

export function getSubagentRequesterSessionActivity(
  requesterSessionKey: string,
  requesterAgentId?: string,
) {
  const cfg = getRuntimeConfig();
  const resolvedAgentId = tryResolveSubagentRequesterAgentId(
    cfg,
    requesterSessionKey,
    requesterAgentId,
  );
  if (!resolvedAgentId) {
    return { isActive: false };
  }
  const storedSessionId = loadRequesterSessionEntry(requesterSessionKey, resolvedAgentId).entry
    ?.sessionId;
  // Unscoped active-run keys are ambiguous across agents. An explicit owner
  // must use its logical store entry instead of accepting another agent's run.
  const activeSessionId = parseAgentSessionKey(requesterSessionKey)
    ? resolveActiveEmbeddedRunSessionId(requesterSessionKey)
    : undefined;
  const sessionId = activeSessionId ?? storedSessionId;
  return {
    sessionId,
    isActive: Boolean(sessionId && isEmbeddedAgentRunActive(sessionId)),
  };
}

export function resolveSubagentRequesterSessionAbandonment(
  requesterSessionKey: string,
  sessionId?: string,
) {
  return resolveEmbeddedRunAbandonment({ sessionKey: requesterSessionKey, sessionId });
}

export function loadSessionEntryByKey(sessionKey: string, explicitAgentId?: string) {
  const cfg = getRuntimeConfig();
  const agentId = tryResolveSubagentRequesterAgentId(cfg, sessionKey, explicitAgentId);
  if (!agentId) {
    return undefined;
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return loadSessionEntry({
    storePath,
    sessionKey,
    agentId,
    clone: false,
  });
}

export async function queueSubagentAnnounceMessage(
  sessionId: string,
  text: string,
  options?: EmbeddedAgentQueueMessageOptions,
  canInject?: () => boolean,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  if (canInject) {
    return await queueGuardedEmbeddedAgentMessageWithOutcomeAsync(
      sessionId,
      text,
      options,
      canInject,
    );
  }
  return await queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, text, options);
}

export async function dispatchSubagentAnnounceAgent(
  agentParams: Record<string, unknown>,
  options: Parameters<typeof dispatchGatewayMethodInProcess>[2],
): Promise<unknown> {
  return await dispatchGatewayMethodInProcess("agent", agentParams, options);
}

export async function sendSubagentAnnounceMessage(
  params: Parameters<typeof sendMessage>[0],
): ReturnType<typeof sendMessage> {
  return await sendMessage(params);
}
