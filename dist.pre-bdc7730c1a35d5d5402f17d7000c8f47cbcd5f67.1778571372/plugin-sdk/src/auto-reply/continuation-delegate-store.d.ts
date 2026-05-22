/**
 * Re-export shim — delegates to the canonical TaskFlow-backed store at
 * `./continuation/delegate-store.js`.
 *
 * Every delegate operation is backed by TaskFlow (SQLite persistence).
 * The former volatile in-memory delegate substrate and config gate have
 * been removed. TaskFlow is the only substrate.
 *
 * This file exists so that existing import paths
 * (`../continuation-delegate-store.js`) keep working without a mass
 * import rewrite. Post-compaction functions wrap the canonical store
 * to preserve the `SessionPostCompactionDelegate` type contract that
 * downstream callers (persistPendingPostCompactionDelegates,
 * post-compaction-delegate-dispatch) rely on.
 */
import type { SessionPostCompactionDelegate } from "../config/sessions.js";
export { addDelayedContinuationReservation, cancelPendingDelegates, clearDelayedContinuationReservations, consumePendingDelegates, delayedContinuationReservationCount, enqueuePendingDelegate, highestDelayedContinuationReservationHop, listDelayedContinuationReservations, pendingDelegateCount, removeDelayedContinuationReservation, resetDelegateStoreForTests, stagedPostCompactionDelegateCount, takeDelayedContinuationReservation, } from "./continuation/delegate-store.js";
export declare function stagePostCompactionDelegate(sessionKey: string, delegate: SessionPostCompactionDelegate): void;
export declare function consumeStagedPostCompactionDelegates(sessionKey: string): SessionPostCompactionDelegate[];
