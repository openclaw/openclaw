// Line plugin module owns in-flight tracking and turn feedback (loading
// keepalive, steering ack) for events admitted during an active run.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { replyMessageLine, showLoadingAnimation } from "./send.js";

// Tracks per-sender in-flight turns without blocking admission: rapid events
// always reach processMessage so core queue policy (steer/followup/collect/
// interrupt) decides; the flag only drives the delivery-side steering ack.
// Ref-counted because steered follow-ups legitimately overlap the same key.
type LineUserInFlightTracker = {
  isInFlight(key: string): boolean;
  begin(key: string): void;
  end(key: string): void;
};

export function createLineUserInFlightTracker(): LineUserInFlightTracker {
  const counts = new Map<string, number>();
  return {
    isInFlight(key: string): boolean {
      return (counts.get(key) ?? 0) > 0;
    },
    begin(key: string): void {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    end(key: string): void {
      const next = (counts.get(key) ?? 0) - 1;
      if (next > 0) {
        counts.set(key, next);
      } else {
        counts.delete(key);
      }
    },
  };
}

// LINE marks source userId optional: group/room postbacks and non-mobile group
// senders can arrive senderless. Tracking those would collapse distinct users
// onto one key and mis-attribute in-flight state, so they are not tracked.
export function buildLineInFlightKey(
  accountId: string,
  sourceInfo: { userId?: string; groupId?: string; roomId?: string; isGroup: boolean },
): string | null {
  const { userId } = sourceInfo;
  if (!userId) {
    return null;
  }
  if (sourceInfo.isGroup) {
    const conversationId = sourceInfo.groupId ?? sourceInfo.roomId;
    return conversationId ? `${accountId}|${conversationId}|${userId}` : null;
  }
  return `${accountId}|${userId}`;
}

const LINE_STEERING_ACK_TEXT = "👀 Got it — I'm folding this into the reply I'm working on.";

// Steering ack: core folded this inbound into the sender's active run
// (steer/collect), so no standalone reply exists. LINE has no reactions, so a
// silent accept reads as message loss — send a short reply-token ack instead.
// Best effort only; never push.
export async function maybeSendLineSteeringAck(params: {
  inFlightAtAdmission: boolean;
  replyToken?: string;
  replyTokenUsed: boolean;
  cfg: OpenClawConfig;
  accountId?: string;
  from: string;
  messageSid?: string;
}): Promise<void> {
  const { inFlightAtAdmission, replyToken, replyTokenUsed, cfg, accountId, from, messageSid } =
    params;
  if (!inFlightAtAdmission || !replyToken || replyTokenUsed) {
    logVerbose(
      `line: no response generated for message ${messageSid ?? "unknown"} from ${from} (inFlightAtAdmission=${String(inFlightAtAdmission)})`,
    );
    return;
  }
  try {
    await replyMessageLine(replyToken, [{ type: "text", text: LINE_STEERING_ACK_TEXT }], {
      cfg,
      accountId,
    });
    logVerbose(`line: steering ack sent to ${from} (message ${messageSid ?? "unknown"})`);
  } catch (ackErr) {
    logVerbose(`line: steering ack reply failed: ${String(ackErr)}`);
  }
}

export function startLineLoadingKeepalive(params: {
  cfg: OpenClawConfig;
  userId: string;
  accountId?: string;
  intervalMs?: number;
  loadingSeconds?: number;
}): () => void {
  const intervalMs = params.intervalMs ?? 18_000;
  const loadingSeconds = params.loadingSeconds ?? 20;
  let stopped = false;

  const trigger = () => {
    if (stopped) {
      return;
    }
    void showLoadingAnimation(params.userId, {
      cfg: params.cfg,
      accountId: params.accountId,
      loadingSeconds,
    }).catch(() => {});
  };

  trigger();
  const timer = setInterval(trigger, intervalMs);

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}
