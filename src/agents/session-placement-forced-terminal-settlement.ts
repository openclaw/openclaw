import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Carry exact turn cleanup to its reply and backend owners; never recover by session id.
const forcedTerminalSettlement = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPlacementForcedTerminalSettlement"),
  () =>
    new AsyncLocalStorage<{ settle: () => Promise<void>; assertCurrent: SessionSourceAssertion }>(),
);

export function withSessionPlacementForcedTerminalSettlement<T>(
  settle: () => Promise<void>,
  assertClaimCurrent: SessionSourceAssertion,
  task: () => T,
): T {
  return forcedTerminalSettlement.run({ settle, assertCurrent: assertClaimCurrent }, task);
}

export function resolveSessionPlacementForcedTerminalSettlement():
  | (() => Promise<void>)
  | undefined {
  return forcedTerminalSettlement.getStore()?.settle;
}

export function resolveSessionPlacementTurnSettlementAssertion():
  | SessionSourceAssertion
  | undefined {
  return forcedTerminalSettlement.getStore()?.assertCurrent;
}

/** A new admission must acquire its own claim, never inherit its invoker's. */
export function withoutSessionPlacementForcedTerminalSettlement<T>(
  task: () => Promise<T>,
): Promise<T> {
  return forcedTerminalSettlement.exit(task);
}
