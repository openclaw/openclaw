/** Process-local active-turn registry for restart draining and ACP child admission. */
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { AcpSessionTarget } from "./manager.types.js";
import { acpSessionActorKey } from "./manager.utils.js";

type AcpActiveTurnState = {
  activeTurnKeys: Map<string, { token: symbol; sessionKey: string; ownerSessionKey?: string }>;
};

const ACP_ACTIVE_TURN_STATE_KEY = Symbol.for("openclaw.acp.activeTurns");

function getAcpActiveTurnState(): AcpActiveTurnState {
  return resolveGlobalSingleton<AcpActiveTurnState>(ACP_ACTIVE_TURN_STATE_KEY, () => ({
    activeTurnKeys: new Map<
      string,
      { token: symbol; sessionKey: string; ownerSessionKey?: string }
    >(),
  }));
}

/** Registers the current turn and returns its ownership-checked release callback. */
export function markAcpTurnActive(
  target: AcpSessionTarget & { ownerSessionKey?: string },
): (() => void) | undefined {
  if (!target.sessionKey) {
    return undefined;
  }
  const actorKey = acpSessionActorKey(target);
  const owner = Symbol("acp-active-turn");
  const state = getAcpActiveTurnState();
  state.activeTurnKeys.set(actorKey, {
    token: owner,
    sessionKey: target.sessionKey,
    ownerSessionKey: target.ownerSessionKey,
  });
  return () => {
    if (state.activeTurnKeys.get(actorKey)?.token === owner) {
      state.activeTurnKeys.delete(actorKey);
    }
  };
}

/** Number of currently owned ACP turns that must settle before restart. */
export function getActiveAcpTurnCount(): number {
  return getAcpActiveTurnState().activeTurnKeys.size;
}

export function listActiveAcpSessionsForOwner(ownerSessionKey: string): string[] {
  return [...getAcpActiveTurnState().activeTurnKeys.values()]
    .filter((turn) => turn.ownerSessionKey === ownerSessionKey)
    .map((turn) => turn.sessionKey);
}
