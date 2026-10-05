import { isDeepStrictEqual } from "node:util";
import { SessionPendingInputCustodyError } from "../../config/sessions/session-pending-input-custody-error.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { isForegroundRecoveryInputCurrent } from "./main-session-recovery-state-transitions.js";
import type { rollbackRestartRecoveryReservation } from "./main-session-restart-dispatch-settlement.js";
import type { MainSessionRecoveryCurrentInput } from "./main-session-restart-dispatch.types.js";

/** Keep fresh foreground custody after the recovery owner has checked effects and the issuer. */
export async function prepareRestartRecoveryAcceptedInput(params: {
  entry: InternalSessionEntry;
  prepareAcceptedInput?: (assertCurrent: () => void) => Promise<string | undefined>;
  assertCurrent: () => void;
  assertDispatchCurrent: () => void;
  cancelReservation: () => Promise<
    Awaited<ReturnType<typeof rollbackRestartRecoveryReservation>> | undefined
  >;
}): Promise<string | MainSessionRecoveryCurrentInput | undefined> {
  try {
    return await params.prepareAcceptedInput?.(params.assertDispatchCurrent);
  } catch (error) {
    const intent = params.entry.mainRestartRecovery?.turnIntent;
    const assertCurrentTurn =
      error instanceof SessionPendingInputCustodyError ? error.assertCurrentTurn : undefined;
    if (
      !intent ||
      !assertCurrentTurn ||
      !isForegroundRecoveryInputCurrent(params.entry, intent) ||
      params.entry.mainRestartRecovery?.queuedInputId
    ) {
      throw error;
    }
    assertCurrentTurn(intent);
    const cancelled = await params.cancelReservation();
    params.assertCurrent();
    assertCurrentTurn(intent);
    if (
      cancelled?.entry?.sessionId !== intent.sessionId ||
      cancelled.entry.lifecycleRevision !== intent.lifecycleRevision ||
      cancelled.entry.mainRestartRecovery?.reservation ||
      !isDeepStrictEqual(cancelled.entry.mainRestartRecovery?.turnIntent, intent)
    ) {
      throw error;
    }
    // The initiating receipt owns this fresh input. Its unused recovery
    // reservation was refunded without dispatching or consuming the input.
    return { kind: "current-input", intent, assertCurrent: () => assertCurrentTurn(intent) };
  }
}
