// Spooled-update handler lane types and wedged-handler escalation policy for
// Telegram isolated ingress. Lane state itself stays process-scoped in
// polling-session.ts (globalThis-backed) so module re-evaluation cannot fork it.
import { formatDurationPrecise } from "openclaw/plugin-sdk/runtime-env";
import type { ClaimedTelegramSpooledUpdate } from "./telegram-ingress-spool.js";

export type SpooledUpdateHandlerState = {
  handlerKey: string;
  laneKey: string;
  task: Promise<boolean>;
  update: ClaimedTelegramSpooledUpdate;
  updateId: number;
  startedAt: number;
  stopClaimRefresh: () => void;
  backlogStatusMessage?: string;
  timedOutAt?: number;
  timeoutMessage?: string;
  escalatedAt?: number;
};

export type DeferredSpooledUpdateClaimState = {
  claimKey: string;
  laneKey: string;
  task: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  timedOutMessage?: string;
  update: ClaimedTelegramSpooledUpdate;
  updateId: number;
  stopClaimRefresh: () => void;
};

export function buildDeferredSpooledUpdateClaimKey(update: ClaimedTelegramSpooledUpdate): string {
  return `${update.pendingPath}:${update.claim?.claimToken ?? update.claim?.processId ?? "claimed"}`;
}

// A handler that is still running this long after its reply abort will not
// settle on its own; releasing the lane in-process would risk double-processing
// (#93040), so the only safe recovery is a gateway process restart (#107482).
export const ISOLATED_INGRESS_WEDGED_HANDLER_ESCALATION_MS = 10 * 60_000;

export function hasEscalatedWedgedHandler(
  handlers: Iterable<Pick<SpooledUpdateHandlerState, "escalatedAt">>,
): boolean {
  for (const handler of handlers) {
    if (handler.escalatedAt !== undefined) {
      return true;
    }
  }
  return false;
}

export function maybeEscalateWedgedSpooledUpdateHandler(params: {
  handler: SpooledUpdateHandlerState;
  escalationMs: number;
  log: (message: string) => void;
  status: { noteWedgedHandlerEscalation: (error: string) => void };
}): void {
  const { handler } = params;
  if (handler.escalatedAt !== undefined || handler.timedOutAt === undefined) {
    return;
  }
  const wedgedForMs = Date.now() - handler.timedOutAt;
  if (wedgedForMs < params.escalationMs) {
    return;
  }
  handler.escalatedAt = Date.now();
  const message = `Telegram spooled update ${handler.updateId} has kept lane ${handler.laneKey} guarded for ${formatDurationPrecise(wedgedForMs)} after reply abort; a channel restart cannot release the lane, requesting a gateway process restart.`;
  params.log(`[telegram] ${message}`);
  params.status.noteWedgedHandlerEscalation(message);
}
