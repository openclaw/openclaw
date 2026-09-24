/** Process-local active-turn registry for ACP maintenance and recovery decisions. */
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { AcpSessionTarget } from "./manager.types.js";
import { acpSessionActorKey } from "./manager.utils.js";

// Process-local liveness signal for in-flight ACP prompt turns, kept off the
// SDK-exported AcpSessionManager so plugins cannot read this maintenance-only
// state. Mirrors cron's active-jobs registry: task maintenance asks "is a turn
// still running for this session?" to avoid reclaiming a live run whose persisted
// session entry survived a crash. The AcpSessionManager marks/clears it in lockstep
// with its in-memory turn map.

type AcpActiveTurnState = {
  activeTurnKeys: Map<string, symbol>;
};

const ACP_ACTIVE_TURN_STATE_KEY = Symbol.for("openclaw.acp.activeTurns");

function getAcpActiveTurnState(): AcpActiveTurnState {
  return resolveGlobalSingleton<AcpActiveTurnState>(ACP_ACTIVE_TURN_STATE_KEY, () => ({
    activeTurnKeys: new Map<string, symbol>(),
  }));
}

/** Registers the current turn and returns its ownership-checked release callback. */
export function markAcpTurnActive(target: AcpSessionTarget): (() => void) | undefined {
  if (!target.sessionKey) {
    return undefined;
  }
  const actorKey = acpSessionActorKey(target);
  const owner = Symbol("acp-active-turn");
  const state = getAcpActiveTurnState();
  state.activeTurnKeys.set(actorKey, owner);
  return () => {
    if (state.activeTurnKeys.get(actorKey) === owner) {
      state.activeTurnKeys.delete(actorKey);
    }
  };
}

/** Returns whether the process currently owns an in-flight ACP turn for a session. */
export function isAcpTurnActive(target: AcpSessionTarget): boolean {
  if (!target.sessionKey) {
    return false;
  }
  return getAcpActiveTurnState().activeTurnKeys.has(acpSessionActorKey(target));
}
