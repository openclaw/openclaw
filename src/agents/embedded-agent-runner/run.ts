/**
 * Public embedded-agent run entrypoint.
 */
import { runWithTurnSendLedgerOwner } from "../tools/turn-send-ledger.js";
import { runEmbeddedAgentTurn } from "./run-orchestrator.js";
import type { RunEmbeddedAgentInternalParams } from "./run/internal-params.js";

/**
 * Runs one embedded agent turn. It owns its per-turn send ledger scopes unless an enclosing
 * logical-run owner passes onDeferredTurnSendLedgerScope; direct plugin, voice-call, and Talk
 * callers have none.
 */
export function runEmbeddedAgent(params: RunEmbeddedAgentInternalParams) {
  return runWithTurnSendLedgerOwner(params, runEmbeddedAgentTurn);
}
