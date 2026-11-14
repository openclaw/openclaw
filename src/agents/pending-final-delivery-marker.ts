/** Retains custody of already-produced final output until transport settlement. */
import { randomUUID } from "node:crypto";
import type { CommandOwnerAssertion } from "../auto-reply/command-owner-authority.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import { normalizePendingFinalDeliveryPayloads } from "../auto-reply/reply/pending-final-delivery.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import { resolveSqliteSessionKey } from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionAdmissionTransition } from "../config/sessions/session-admission-transition.types.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";

export type PendingFinalDeliverySource = Readonly<
  Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "activeWriterRunId">
>;

type PersistPendingFinalDeliveryMarkerParams = {
  admittedSource?: PendingFinalDeliverySource;
  compactionTransitions?: readonly SessionAdmissionTransition[];
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

export async function persistPendingFinalDeliveryMarker(
  params: PersistPendingFinalDeliveryMarkerParams,
): Promise<{
  sessionEntry?: SessionEntry;
  pendingFinalDeliveryMarkerPersisted: boolean;
  pendingFinalDeliveryIntentId?: string;
  hasSendableFinalPayload: boolean;
}> {
  const sendablePayloads = params.payloads.filter(
    (payload) => normalizePendingFinalDeliveryPayloads([payload]).length > 0,
  );
  const hasSendableFinalPayload = sendablePayloads.length > 0;
  const entry =
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined) ??
    params.sessionEntry;

  if (
    !params.deliver ||
    !params.sessionStore ||
    !params.sessionKey ||
    !entry ||
    params.suppressVisibleSessionEffects ||
    params.sessionReboundDuringRun ||
    isSubagentSessionKey(params.sessionKey) ||
    !hasSendableFinalPayload ||
    // Transport custody needs an exact delivery route.
    !params.deliveryContext
  ) {
    return {
      sessionEntry: params.sessionEntry,
      pendingFinalDeliveryMarkerPersisted: false,
      hasSendableFinalPayload,
    };
  }

  params.assertCurrent?.();
  const sessionKey = resolveSqliteSessionKey(params.sessionKey, params.agentId);
  const now = Date.now();
  let admitted = params.admittedSource;
  for (const transition of params.compactionTransitions ?? []) {
    if (
      !admitted ||
      transition.previous?.sessionId !== admitted.sessionId ||
      transition.previous.lifecycleRevision !== admitted.lifecycleRevision
    ) {
      admitted = undefined;
      break;
    }
    admitted = { ...admitted, ...transition.current };
  }
  if (params.admittedSource && !admitted) {
    return {
      sessionEntry: params.sessionEntry,
      pendingFinalDeliveryMarkerPersisted: false,
      hasSendableFinalPayload,
    };
  }
  const expected = admitted ?? entry;
  const intentId = randomUUID();
  const deliveryId = randomUUID();
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
        current.lifecycleRevision !== expected.lifecycleRevision ||
        current.activeWriterRunId !== expected.activeWriterRunId
      ) {
        return { result: current };
      }
      const next: SessionEntry = {
        ...current,
        pendingFinalDelivery: {
          kind: "transport-only",
          intentId,
          deliveries: [{ id: deliveryId, state: "prepared" as const }],
          createdAt: now,
          context: params.deliveryContext,
        },
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
        pendingFinalDeliveryCompletion: {
          commandOwnerReference: params.commandOwnerReference,
          agentId: params.agentId,
          deliveryId,
          intentId,
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

/** Keep only this captured intent's completion locator in step with a host commit. */
export function advancePendingFinalDeliveryCompletion(params: {
  payloads: ReplyPayload[];
  intentId?: string;
  transition?: SessionAdmissionTransition;
  entry: SessionEntry;
}): void {
  const { transition, entry } = params;
  if (
    !transition?.previous ||
    !params.intentId ||
    entry.sessionId !== transition.current.sessionId ||
    entry.lifecycleRevision !== transition.current.lifecycleRevision
  ) {
    return;
  }
  for (const payload of params.payloads) {
    const metadata = getReplyPayloadMetadata(payload);
    const completion = metadata?.pendingFinalDeliveryCompletion;
    if (
      completion?.sessionId === transition.previous.sessionId &&
      completion.intentId === params.intentId &&
      entry.pendingFinalDelivery?.intentId === completion.intentId &&
      entry.pendingFinalDelivery.deliveries?.some(
        (delivery) => delivery.id === completion.deliveryId,
      )
    ) {
      const authority = metadata?.sessionWriterDeliveryAuthority;
      setReplyPayloadMetadata(payload, {
        ...(authority
          ? {
              sessionWriterDeliveryAuthority: {
                ...authority,
                expectedSessionId: transition.current.sessionId,
                expectedLifecycleRevision: transition.current.lifecycleRevision,
              },
            }
          : {}),
        pendingFinalDeliveryCompletion: { ...completion, sessionId: transition.current.sessionId },
      });
    }
  }
}
