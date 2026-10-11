import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getRuntimeConfig } from "../../../config/config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { loadSessionEntryReadOnly as loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { SessionEntryCurrentFacts } from "../../../config/sessions/session-entry-current.types.js";
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { captureIncognitoSessionSource } from "../../../config/sessions/session-incognito-binding.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../../routing/session-key.js";
import { resolveActiveEmbeddedRunSessionId } from "../../embedded-agent-runner/active-run-projections.js";
import { isEmbeddedAgentRunActive } from "../../embedded-agent-runner/runs.js";
import { withSubagentSessionSource } from "../spawn/subagent-session-source.js";
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

function resolveRequesterSessionEntryScope(
  requesterSessionKey: string,
  explicitAgentId?: string,
): Omit<RequesterSessionEntryResult, "entry"> & { storageKey: string } {
  const cfg = getRuntimeConfig();
  const rawStorageKey = requesterSessionKey.trim();
  const canonicalKey = resolveRequesterStoreKey(cfg, requesterSessionKey, explicitAgentId);
  const configuredMainKey = normalizeMainKey(cfg.session?.mainKey);
  const storageKey =
    rawStorageKey === "main" || rawStorageKey === configuredMainKey ? canonicalKey : rawStorageKey;
  const agentId = tryResolveSubagentRequesterAgentId(cfg, rawStorageKey, explicitAgentId);
  if (!agentId) {
    return { cfg, canonicalKey, storageKey };
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return { cfg, canonicalKey, agentId, storePath, storageKey };
}

export async function loadRequesterSessionEntry(
  requesterSessionKey: string,
  explicitAgentId?: string,
): Promise<RequesterSessionEntryResult> {
  const { storageKey, ...resolved } = resolveRequesterSessionEntryScope(
    requesterSessionKey,
    explicitAgentId,
  );
  if (!resolved.agentId) {
    return { ...resolved, entry: undefined };
  }
  const scope = {
    storePath: resolved.storePath,
    sessionKey: storageKey,
    agentId: resolved.agentId,
    clone: false,
  };
  return withSubagentSessionSource(
    { agentId: resolved.agentId, sessionKey: storageKey },
    async (source) => {
      // Until activation, unbound requester reads retain their native owner and SQL.
      const storePath = source
        ? "kind" in source
          ? source.path
          : source.actor.path
        : resolved.storePath;
      const target = { ...scope, storePath };
      const entry = source
        ? await readSessionEntryReadOnlyInWorker(target)
        : loadSessionEntry(target);
      return { ...resolved, storePath, entry };
    },
  );
}

/** Capture exact currency before yielding; later guards never discover another actor. */
export function captureRequesterSessionEntryCurrent(
  requesterSessionKey: string,
  explicitAgentId?: string,
): () => SessionEntryCurrentFacts | undefined {
  const source = captureIncognitoSessionSource({
    sessionKey: requesterSessionKey,
    agentId: explicitAgentId,
  });
  if (source) {
    if ("kind" in source) {
      return () => {
        source.assertCurrent();
        source.admissionSignal?.throwIfAborted();
        return undefined;
      };
    }
    const claim = source.actor.sessions.captureCurrent(requesterSessionKey);
    return () => {
      source.admissionSignal?.throwIfAborted();
      source.actor.assertReadable();
      claim.assertCurrent();
      return source.actor.sessions.readSharing(requesterSessionKey)?.entry;
    };
  }
  const { storageKey, agentId, storePath } = resolveRequesterSessionEntryScope(
    requesterSessionKey,
    explicitAgentId,
  );
  return () =>
    agentId
      ? loadSessionEntry({ storePath, sessionKey: storageKey, agentId, clone: false })
      : undefined;
}

/** Selected requesters retain their actor through all consumers and accepted settlement. */
export function withSubagentRequesterSource<T>(
  requesterSessionKey: string,
  explicitAgentId: string | undefined,
  consume: (isCurrent?: () => boolean) => Promise<T>,
): Promise<T> {
  const agentId = explicitAgentId ?? parseAgentSessionKey(requesterSessionKey)?.agentId;
  if (!agentId) {
    return consume();
  }
  return withSubagentSessionSource({ agentId, sessionKey: requesterSessionKey }, async (source) => {
    if (!source) {
      return consume();
    }
    const readCurrent = captureRequesterSessionEntryCurrent(requesterSessionKey, agentId);
    const isCurrent = () => {
      try {
        return readCurrent() !== undefined;
      } catch {
        return false;
      }
    };
    return consume(isCurrent);
  });
}

export function getSubagentRequesterSessionActivity(
  requesterSessionKey: string,
  requester: Pick<RequesterSessionEntryResult, "agentId" | "entry">,
) {
  if (!requester.agentId) {
    return { isActive: false };
  }
  const storedSessionId = requester.entry?.sessionId;
  // Active-run keys carry no physical root; selected actors use their own session identity.
  const source = captureIncognitoSessionSource({
    sessionKey: requesterSessionKey,
    agentId: requester.agentId,
  });
  const activeSessionId =
    !source && parseAgentSessionKey(requesterSessionKey)
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
  return withSubagentSessionSource({ agentId, sessionKey }, async (source) =>
    readSessionEntryReadOnlyInWorker({
      storePath: source ? ("kind" in source ? source.path : source.actor.path) : storePath,
      sessionKey,
      agentId,
      projection: "list",
    }),
  );
}
