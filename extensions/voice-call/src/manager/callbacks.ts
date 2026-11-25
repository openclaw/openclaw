import type { VoiceCallConfig } from "../config.js";
import type { CallRecord } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { getCallHistoryFromStore, MAX_CALL_RECORD_EVENTS } from "./store.js";

type CallbackContext = Pick<
  CallManagerContext,
  "config" | "storePath" | "stateRuntime" | "activeCalls"
>;

/** Callback admission requires a full international number, never a local-number alias. */
export async function findRecentOutboundCallback(
  ctx: CallbackContext,
  from?: string,
): Promise<CallRecord | undefined> {
  if (
    ctx.config.inboundPolicy !== "allowlist" ||
    !ctx.config.callbacks.enabled ||
    !from ||
    !/^\+[1-9]\d{1,14}$/.test(from)
  ) {
    return undefined;
  }
  const history = await getCallHistoryFromStore(
    ctx.storePath,
    MAX_CALL_RECORD_EVENTS,
    ctx.stateRuntime,
  );
  const latest = new Map(history.map((call) => [call.callId, call]));
  for (const call of ctx.activeCalls.values()) {
    latest.set(call.callId, call);
  }
  const now = Date.now();
  const cutoff = now - ctx.config.callbacks.windowMinutes * 60_000;
  return [...latest.values()]
    .filter(
      (call) =>
        call.direction === "outbound" &&
        call.providerCallId &&
        call.to === from &&
        call.startedAt >= cutoff &&
        call.startedAt <= now,
    )
    .toSorted((a, b) => b.startedAt - a.startedAt)[0];
}

/** Keep the original task for reporting, separate from the receptionist's instructions. */
export function buildCallbackMetadata(
  original: CallRecord,
  config: VoiceCallConfig,
): NonNullable<CallRecord["metadata"]> {
  const brief = { ...config.callbacks.brief };
  return {
    callbackOfCallId: original.callId,
    ...(original.metadata?.brief ? { callbackOriginalBrief: original.metadata.brief } : {}),
    ...(original.metadata?.requesterSessionKey
      ? { requesterSessionKey: original.metadata.requesterSessionKey }
      : {}),
    initialMessage:
      config.callbacks.greeting ||
      "Hello, I can take a message for the owner. They will follow up.",
    brief,
    ...(brief.maxDurationSeconds
      ? { maxDurationSeconds: Math.min(brief.maxDurationSeconds, config.maxDurationSeconds) }
      : {}),
  };
}
