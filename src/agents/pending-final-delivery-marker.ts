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
import { advanceHarnessCompletionClaim } from "../config/sessions/harness-completion-compaction.js";
import {
  getRestartRecoveryPendingFinalSourceRunId,
  getRestartRecoveryTerminalDeliveryEvidence,
  mergeRestartRecoveryTerminalDeliveryEvidence,
} from "../config/sessions/restart-recovery-state.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import { resolveSqliteSessionKey } from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionAdmissionTransition } from "../config/sessions/session-admission-transition.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import {
  advancePendingFinalRecoverySource,
  matchesPendingFinalRecoverySource,
  type PendingFinalRecoverySource,
} from "./pending-final-recovery-source.js";

type PersistPendingFinalDeliveryMarkerParams = {
  /** Required by the command caller; omitted legacy callers cannot acknowledge a source. */
  admittedRecoverySource?: PendingFinalRecoverySource;
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

  params.assertCurrent?.();
  const sessionKey = resolveSqliteSessionKey(params.sessionKey, params.agentId);
  const now = Date.now();
  const intentId = randomUUID();
  const deliveryId = randomUUID();
  const admitted = params.admittedRecoverySource;
  const harnessCompletion = admitted
    ? advancePendingFinalRecoverySource(admitted, params.compactionTransitions)
        ?.restartRecoveryHarnessCompletion
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
        (admitted &&
          !matchesPendingFinalRecoverySource(current, admitted, params.compactionTransitions)) ||
        (harnessCompletion &&
          (harnessCompletion.sessionId !== current.sessionId ||
            harnessCompletion.lifecycleRevision !== current.lifecycleRevision ||
            !isDeepStrictEqual(current.restartRecoveryHarnessCompletion, harnessCompletion)))
      ) {
        return { result: current };
      }
      // Bind a normal requester final only while the same original source and route
      // still own it. A later turn or changed channel cannot acknowledge this source.
      const sourceRunId =
        harnessCompletion?.sourceRunId ??
        (admitted
          ? getRestartRecoveryPendingFinalSourceRunId(current, params.deliveryContext)
          : undefined);
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
          ...(sourceRunId ? { sourceRunId } : {}),
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
          ...(admitted?.restartRecoveryDeliveryRunId
            ? { recoveryRunId: admitted.restartRecoveryDeliveryRunId }
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
      const claim = advanceHarnessCompletionClaim(authority?.harnessCompletion, transition);
      if (
        authority?.harnessCompletion &&
        (!claim || !isDeepStrictEqual(entry.restartRecoveryHarnessCompletion, claim))
      ) {
        continue;
      }
      setReplyPayloadMetadata(payload, {
        ...(claim && authority
          ? {
              sessionWriterDeliveryAuthority: {
                ...authority,
                expectedSessionId: transition.current.sessionId,
                expectedLifecycleRevision: transition.current.lifecycleRevision,
                harnessCompletion: claim,
              },
            }
          : {}),
        pendingFinalDeliveryCompletion: { ...completion, sessionId: transition.current.sessionId },
      });
    }
  }
}
