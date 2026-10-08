import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getRuntimeConfig } from "../../../config/config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { loadSessionEntryReadOnly as loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../../routing/session-key.js";
import { resolveActiveEmbeddedRunSessionId } from "../../embedded-agent-runner/active-run-projections.js";
import { isEmbeddedAgentRunActive } from "../../embedded-agent-runner/runs.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";
export { resolveQueueSettings } from "../../../auto-reply/reply/queue.js";
export { resolveExternalBestEffortDeliveryTarget } from "../../../infra/outbound/best-effort-delivery.js";
export { resolveBoundDeliveryDestination } from "../../../infra/outbound/bound-delivery-router.js";
export { resolveConversationIdFromTargets } from "../../../infra/outbound/conversation-id.js";
export { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
export { getRuntimeConfig as getSubagentAnnounceRuntimeConfig } from "../../../config/config.js";
export { sendMessage as sendSubagentAnnounceMessage } from "../../../infra/outbound/message.js";

type RequesterSessionEntryResult = {
  cfg: ReturnType<typeof getRuntimeConfig>;
  entry: ReturnType<typeof loadSessionEntry>;
  canonicalKey: string;
  agentId?: string;
  storePath?: string;
};

export function hasUsableSessionEntry(entry: unknown): entry is Record<string, unknown> {
  if (!isRecord(entry)) {
    return false;
  }
  const sessionId = entry.sessionId;
  return typeof sessionId !== "string" || sessionId.trim() !== "";
}

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

export function getSubagentRequesterSessionActivity(
  requesterSessionKey: string,
  requester: Pick<RequesterSessionEntryResult, "agentId" | "entry">,
) {
  if (!requester.agentId) {
    return { isActive: false };
  }
  const storedSessionId = requester.entry?.sessionId;
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

export async function loadSessionEntryByKey(sessionKey: string, explicitAgentId?: string) {
  const cfg = getRuntimeConfig();
  const agentId = tryResolveSubagentRequesterAgentId(cfg, sessionKey, explicitAgentId);
  if (!agentId) {
    return undefined;
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return await readSessionEntryReadOnlyInWorker({
    storePath,
    sessionKey,
    agentId,
    projection: "list",
  });
}
