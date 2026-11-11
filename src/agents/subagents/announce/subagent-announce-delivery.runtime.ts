import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getRuntimeConfig } from "../../../config/config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import {
  projectSessionSharingEntry,
  retainPreparedSessionGenerationFacts,
} from "../../../config/sessions/session-accessor.sqlite-entry-cache.js";
import { captureSessionActorStorageOwner } from "../../../config/sessions/session-actor-storage-binding.js";
import type { SessionEntryCurrentFacts } from "../../../config/sessions/session-entry-current.types.js";
import {
  readSessionEntryReadOnlyInWorker,
  withSessionEntryReadOnlyInWorker,
  withSessionEntriesFromStoreInWorker,
} from "../../../config/sessions/session-entry-read-runtime.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../../routing/session-key.js";
import type { SessionControllerInput } from "../../../sessions/session-controller.mailbox.js";
import { resolveActiveSessionRunId } from "../../../sessions/session-controller.queries.js";
import { captureSessionTarget } from "../../../sessions/session-controller.target.js";
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
  entry: Awaited<ReturnType<typeof readSessionEntryReadOnlyInWorker>>;
  canonicalKey: string;
  agentId?: string;
  storePath?: string;
  physicalStorePath?: string;
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
      const storePath = source?.path ?? resolved.storePath;
      if (source || isIncognitoSessionKey(storageKey)) {
        return {
          ...resolved,
          storePath,
          physicalStorePath: source?.path,
          entry: source?.actor.snapshot(source.authority)?.entry,
        };
      }
      return withSessionEntryReadOnlyInWorker(
        { ...scope, storePath },
        () => {},
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          return {
            ...resolved,
            storePath,
            physicalStorePath: owner.scope?.storePath,
            entry: read.value,
          };
        },
      );
    },
  );
}

/** Retain requester identity; run metadata writes do not replace its lifecycle. */
export async function captureRequesterSessionEntryCurrent(
  requesterSessionKey: string,
  explicitAgentId?: string,
): Promise<{
  readCurrent: () => Pick<SessionEntryCurrentFacts, "sessionId" | "lifecycleRevision"> | undefined;
  release: () => void;
}> {
  const source = captureSessionActorStorageOwner(
    {
      sessionKey: requesterSessionKey,
      agentId: explicitAgentId,
    },
    { assertCurrent() {}, authorize() {} },
  );
  if (source) {
    return {
      readCurrent: () =>
        source.binding?.actor.target.sessionKey === requesterSessionKey
          ? source.binding.actor.snapshot(source.authority)?.entry
          : source.owner?.readSession(requesterSessionKey, source.authority)?.entry,
      release() {},
    };
  }
  const { storageKey, agentId, storePath } = resolveRequesterSessionEntryScope(
    requesterSessionKey,
    explicitAgentId,
  );
  if (!agentId || !storePath) {
    return { readCurrent: () => undefined, release() {} };
  }
  return withSessionEntriesFromStoreInWorker(
    {
      storePath,
      agentId,
      sessionKeys: [storageKey],
      snapshotFields: [],
      includeAuthorization: true,
    },
    async ({ result }) => {
      const entry = result.entries[0]?.entry;
      const databaseIdentity = result.databaseIdentity?.identity;
      if (!entry || !databaseIdentity) {
        return { readCurrent: () => undefined, release() {} };
      }
      const retained = retainPreparedSessionGenerationFacts({
        databaseIdentity: `file:${databaseIdentity}`,
        sessionKey: storageKey,
        entry: projectSessionSharingEntry(entry),
      });
      return {
        readCurrent: () => retained.readCurrent() ?? undefined,
        release: retained.release,
      };
    },
  );
}

/** Selected requesters retain their actor through all consumers and accepted settlement. */
export function withSubagentRequesterSource<T>(
  requesterSessionKey: string,
  explicitAgentId: string | undefined,
  consume: (isCurrent?: () => boolean) => Promise<T>,
  controllerInput?: () => SessionControllerInput | undefined,
): Promise<T> {
  const agentId = explicitAgentId ?? parseAgentSessionKey(requesterSessionKey)?.agentId;
  if (!agentId) {
    return consume();
  }
  const retainedUntil = () => {
    const input = controllerInput?.();
    return input?.custody.rpcAdopted ? input.settlement.promise : undefined;
  };
  return withSubagentSessionSource(
    { agentId, sessionKey: requesterSessionKey, retainedUntil },
    async (source) => {
      if (!source) {
        return consume(isIncognitoSessionKey(requesterSessionKey) ? () => false : undefined);
      }
      const current = await captureRequesterSessionEntryCurrent(requesterSessionKey, agentId);
      const isCurrent = () => {
        try {
          return current.readCurrent() !== undefined;
        } catch {
          return false;
        }
      };
      try {
        return await consume(isCurrent);
      } finally {
        const retained = retainedUntil();
        if (retained) {
          void retained.then(current.release, current.release);
        } else {
          current.release();
        }
      }
    },
  );
}

/** Compose requester authority with the caller's guards without replacing either owner. */
export function withSubagentRequesterDelivery<
  T extends {
    requesterAgentId?: string;
    controllerInput?: SessionControllerInput;
    isSourceSessionEffectsAllowed?: () => boolean;
    isSourceSessionAdmissionAllowed?: () => boolean;
  },
  R,
>(requesterSessionKey: string, params: T, consume: (guarded: T) => Promise<R>): Promise<R> {
  return withSubagentRequesterSource(
    requesterSessionKey,
    params.requesterAgentId,
    (isCurrent) =>
      consume(
        isCurrent
          ? {
              ...params,
              isSourceSessionEffectsAllowed: () =>
                isCurrent() && params.isSourceSessionEffectsAllowed?.() !== false,
              isSourceSessionAdmissionAllowed: () =>
                isCurrent() && params.isSourceSessionAdmissionAllowed?.() !== false,
            }
          : params,
      ),
    () => params.controllerInput,
  );
}

export function getSubagentRequesterSessionActivity(
  requesterSessionKey: string,
  requester: Pick<RequesterSessionEntryResult, "agentId" | "canonicalKey" | "entry" | "storePath">,
) {
  if (!requester.agentId || !requester.storePath) {
    return { isActive: false };
  }
  const storedSessionId = requester.entry?.sessionId;
  const target = captureSessionTarget({
    storeScope: requester.storePath,
    sessionKey: requester.canonicalKey,
    aliases: [requesterSessionKey],
    agentId: requester.agentId,
    incarnation: storedSessionId,
  });
  const activeSessionId = resolveActiveSessionRunId(requester.canonicalKey, target);
  const sessionId = activeSessionId ?? storedSessionId;
  return {
    sessionId,
    target,
    isActive: activeSessionId !== undefined,
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
    source
      ? source.actor.snapshot(source.authority)?.entry
      : isIncognitoSessionKey(sessionKey)
        ? undefined
        : readSessionEntryReadOnlyInWorker({ storePath, sessionKey, agentId, projection: "list" }),
  );
}
