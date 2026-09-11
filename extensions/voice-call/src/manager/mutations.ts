import { TerminalStates, type CallRecord } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { copyCallRecord } from "./state.js";
import { persistCallRecord } from "./store.js";

type CallMutationContext = Pick<CallManagerContext, "activeCalls" | "storePath" | "mutationQueue">;

/** Commit one live call update while preserving the call identity held by its callbacks. */
export function updateCall(
  ctx: CallMutationContext,
  call: CallRecord,
  update: (next: CallRecord) => void,
  isCurrent?: () => boolean,
): Promise<boolean> {
  return ctx.mutationQueue.enqueue("state", async () => {
    if (
      ctx.activeCalls.get(call.callId) !== call ||
      TerminalStates.has(call.state) ||
      (isCurrent && !isCurrent())
    ) {
      return false;
    }
    const next = copyCallRecord(call);
    update(next);
    await persistCallRecord(ctx.storePath, next);
    Object.assign(call, next);
    return true;
  });
}
