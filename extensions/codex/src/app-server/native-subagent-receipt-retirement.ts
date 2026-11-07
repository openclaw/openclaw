import { assertHistoryOwnerMatchesRegistration } from "./native-subagent-history-owner.js";
import type { ParentOwner, ParentState } from "./native-subagent-monitor-types.js";
import { NATIVE_RECEIPT_OBSERVATION_TIMEOUT_MS } from "./native-subagent-owned-receipts.js";
import type { ReceiptObservation } from "./native-subagent-receipt-observation.js";

/** A single bounded observation retains this owner, never admission for new work. */
export function observeNativeReceiptsBeforeRetirement(params: {
  state: ParentState;
  owner: ParentOwner;
  ownerKey: symbol;
  isCurrent: () => boolean;
  assertLifecycleCurrent?: () => Promise<void>;
  reconcile: (observation: ReceiptObservation) => Promise<void>;
}): Promise<void> | undefined {
  const { state, owner, ownerKey, assertLifecycleCurrent } = params;
  const turnId = owner.turnId;
  const history = state.historyOwner && { ...state.historyOwner };
  if (
    !turnId ||
    !history ||
    !assertLifecycleCurrent ||
    !owner.modelExecutionSettled ||
    owner.modelExecutionCancelled ||
    owner.isTurnYielded?.()
  ) {
    return undefined;
  }
  return (async () => {
    const deadlineAt = performance.now() + NATIVE_RECEIPT_OBSERVATION_TIMEOUT_MS;
    const abort = new AbortController();
    let source: ReturnType<NonNullable<ParentOwner["modelSource"]>["capture"]> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      source = owner.modelSource?.capture();
      if (!source) {
        return;
      }
      const retained = source;
      const assertCurrent = () => {
        if (
          abort.signal.aborted ||
          performance.now() >= deadlineAt ||
          !params.isCurrent() ||
          state.owners.get(ownerKey) !== owner ||
          owner.turnId !== turnId ||
          owner.modelExecutionCancelled ||
          owner.isTurnYielded?.() ||
          (owner.completionCustody && !owner.completionCustody.isCurrent())
        ) {
          throw new Error("Native receipt owner is no longer current");
        }
        retained.assertCurrent();
        assertHistoryOwnerMatchesRegistration(
          history,
          state.historyOwner,
          state.parentThreadId,
          true,
        );
        if (
          owner.requesterSessionId !== history.sessionId ||
          owner.requesterLifecycleRevision !== history.lifecycleRevision
        ) {
          throw new Error("Native receipt owner lifecycle changed");
        }
      };
      const assertCurrentAsync = async () => {
        assertCurrent();
        await assertLifecycleCurrent();
        assertCurrent();
      };
      const observe = async () => {
        await assertCurrentAsync();
        await params.reconcile({
          deadlineAt,
          signal: abort.signal,
          assertCurrent,
          assertCurrentAsync,
        });
      };
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(
          () => {
            abort.abort();
            resolve();
          },
          Math.max(1, Math.floor(deadlineAt - performance.now())),
        );
      });
      await Promise.race([observe(), timeout]);
    } catch {
      // Missing proof retains normal completion delivery.
    } finally {
      abort.abort();
      clearTimeout(timer);
      source?.release();
    }
  })();
}

/** Execution requires a live host; settled receipt reads retain only requester/connection custody. */
export function createNativeSubagentRegistrationGuards(params: {
  signal: AbortSignal;
  hostCapabilities: { assertActive: () => void };
  connection: { assertCurrent: () => void };
  submissionStore: { assertCurrent: () => void } | undefined;
  thread: { liveThreadOwnership?: { assertCurrent: () => void } };
  parent: { assertCurrent: () => Promise<void> } | undefined;
}): { assertCurrent: () => void; assertReceiptObservationCurrent?: () => Promise<void> } {
  const { parent, connection, submissionStore } = params;
  return {
    assertCurrent: () => {
      params.signal.throwIfAborted();
      params.hostCapabilities.assertActive();
      connection.assertCurrent();
      submissionStore?.assertCurrent();
      params.thread.liveThreadOwnership?.assertCurrent();
    },
    ...(parent
      ? {
          assertReceiptObservationCurrent: async () => {
            await parent.assertCurrent();
            connection.assertCurrent();
            submissionStore?.assertCurrent();
          },
        }
      : {}),
  };
}
