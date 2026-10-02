/** Persists restart-recoverable final delivery markers for agent runs. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CommandOwnerAssertion } from "../auto-reply/command-owner-authority.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  normalizePendingFinalDeliveryPayloads,
  normalizePendingFinalRecoveryPayloads,
} from "../auto-reply/reply/pending-final-delivery.js";
import {
  getRestartRecoveryTerminalDeliveryEvidence,
  mergeRestartRecoveryTerminalDeliveryEvidence,
} from "../config/sessions/restart-recovery-state.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import { resolveSqliteSessionKey } from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";

type PersistPendingFinalDeliveryMarkerParams = {
  agentId: string;
  deliver: boolean;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  storePath: string;
  suppressVisibleSessionEffects: boolean;
  sessionReboundDuringRun: boolean;
  payloads: ReplyPayload[];
  deliveryContext?: DeliveryContext;
  runOwnedSessionId: string;
  commandOwnerReference?: CommandOwnerAssertion["recoveryReference"];
  assertCurrent?: () => void;
};

type PendingFinalDeliveryMarkerResult = {
  sessionEntry?: SessionEntry;
  pendingFinalDeliveryMarkerPersisted: boolean;
  pendingFinalDeliveryIntentId?: string;
  hasSendableFinalPayload: boolean;
};

export async function persistPendingFinalDeliveryMarker(
  params: PersistPendingFinalDeliveryMarkerParams,
): Promise<PendingFinalDeliveryMarkerResult> {
  const sendablePayloads = params.payloads.filter(
    (payload) => normalizePendingFinalDeliveryPayloads([payload]).length > 0,
  );
  const hasSendableFinalPayload = sendablePayloads.length > 0;
  const recoverableText = buildRecoverablePendingFinalDeliveryText(
    normalizePendingFinalRecoveryPayloads(params.payloads),
  );

  if (
    !params.deliver ||
    !params.sessionStore ||
    !params.sessionKey ||
    params.suppressVisibleSessionEffects ||
    params.sessionReboundDuringRun ||
    isSubagentSessionKey(params.sessionKey) ||
    !hasSendableFinalPayload ||
    // A run without a resolvable delivery route (e.g. rejected best-effort
    // target) must not leave a custody marker restart recovery could act on.
    !params.deliveryContext
  ) {
    return {
      sessionEntry: params.sessionEntry,
      pendingFinalDeliveryMarkerPersisted: false,
      hasSendableFinalPayload,
    };
  }

  const entry = params.sessionStore[params.sessionKey] ?? params.sessionEntry;
  if (!entry) {
    return {
      sessionEntry: params.sessionEntry,
      pendingFinalDeliveryMarkerPersisted: false,
      hasSendableFinalPayload,
    };
  }

  params.assertCurrent?.();
  const sessionKey = resolveSqliteSessionKey(params.sessionKey, params.agentId);
  const now = Date.now();
  const intentId = randomUUID();
  const deliveryId = randomUUID();
  const harnessCompletion = entry.restartRecoveryHarnessCompletion
    ? structuredClone(entry.restartRecoveryHarnessCompletion)
    : undefined;
  const persisted = await applySessionEntryReplacements<SessionEntry | undefined>({
    agentId: params.agentId,
    sessionKeys: [sessionKey],
    storePath: params.storePath,
    assertCommitAllowed: params.assertCurrent,
    update: (entries) => {
      const current = entries.find((candidate) => candidate.sessionKey === sessionKey)?.entry;
      if (
        !current ||
        current.sessionId !== params.runOwnedSessionId ||
        current.abortedLastRun === true ||
        (harnessCompletion &&
          (harnessCompletion.sessionId !== current.sessionId ||
            harnessCompletion.lifecycleRevision !== current.lifecycleRevision ||
            !isDeepStrictEqual(current.restartRecoveryHarnessCompletion, harnessCompletion)))
      ) {
        return { result: current };
      }
      const savedEvidence = harnessCompletion
        ? getRestartRecoveryTerminalDeliveryEvidence(current, harnessCompletion.sourceRunId)
        : undefined;
      const next: SessionEntry = {
        ...current,
        pendingFinalDelivery: {
          ...(recoverableText && params.commandOwnerReference === undefined
            ? { kind: "replayable" as const, text: recoverableText }
            : { kind: "transport-only" as const }),
          intentId,
          deliveries: [{ id: deliveryId, state: "prepared" as const }],
          createdAt: now,
          context: params.deliveryContext,
        },
        // A new capture cannot replace a receipt or assign its send facts to another claim.
        // Preserve existing source evidence even when it cannot acknowledge this requester.
        ...(harnessCompletion && !savedEvidence
          ? {
              restartRecoveryTerminalDeliveryEvidence: mergeRestartRecoveryTerminalDeliveryEvidence(
                current.restartRecoveryTerminalDeliveryEvidence,
                [
                  {
                    runId: harnessCompletion.sourceRunId,
                    harnessCompletion,
                    deliveryContext: params.deliveryContext,
                    captured: true,
                  },
                ],
              ),
            }
          : {}),
        updatedAt: Math.max(current.updatedAt, now),
      };
      return { result: next, replacements: [{ sessionKey, entry: next }] };
    },
  });
  if (persisted) {
    params.sessionStore[params.sessionKey] = persisted;
  } else {
    delete params.sessionStore[params.sessionKey];
  }
  const markerPersisted = persisted?.pendingFinalDelivery?.intentId === intentId;

  if (markerPersisted) {
    for (const payload of sendablePayloads) {
      setReplyPayloadMetadata(payload, {
        ...(harnessCompletion
          ? {
              sessionWriterDeliveryAuthority: {
                ...getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority,
                agentId: harnessCompletion.requesterAgentId,
                expectedSessionId: params.runOwnedSessionId,
                ...(harnessCompletion.lifecycleRevision
                  ? { expectedLifecycleRevision: harnessCompletion.lifecycleRevision }
                  : {}),
                sessionKey: params.sessionKey,
                storePath: params.storePath,
                harnessCompletion,
              },
            }
          : {}),
        pendingFinalDeliveryCompletion: {
          commandOwnerReference: params.commandOwnerReference,
          agentId: params.agentId,
          deliveryId,
          intentId,
          ...(entry.restartRecoveryDeliveryRunId
            ? { recoveryRunId: entry.restartRecoveryDeliveryRunId }
            : {}),
          sessionId: params.runOwnedSessionId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        },
      });
    }
  }

  return {
    sessionEntry: persisted,
    pendingFinalDeliveryMarkerPersisted: markerPersisted,
    ...(markerPersisted ? { pendingFinalDeliveryIntentId: intentId } : {}),
    hasSendableFinalPayload,
  };
}
