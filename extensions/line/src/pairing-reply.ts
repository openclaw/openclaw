// Sends one text back to a LINE sender, preferring their reply token so the
// answer costs no push quota and never duplicating a possibly accepted reply.
// Also owns the pairing-code recovery: a first-contact sender whose challenge
// delivery was ambiguous can re-obtain the same pending code once by messaging
// again.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import {
  buildPairingReply,
  resolvePairingIdLabel,
  upsertChannelPairingRequest,
} from "openclaw/plugin-sdk/conversation-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { LineHandlerContext } from "./bot-handlers.js";
import { canFallbackAfterLineReplyFailure } from "./send-retry.js";
import { pushMessageLine, replyMessageLine } from "./send.js";

/**
 * Say one line back to a sender, preferring their reply token so the answer costs no
 * push quota, and falling back to a push only when LINE definitively rejected the
 * reply. A partial-delivery or ambiguous failure means the reply may have been seen,
 * so it never falls back to a duplicate push.
 */
export async function sendLineHandlerText(params: {
  context: LineHandlerContext;
  text: string;
  replyToken?: string;
  pushTarget: string;
  logLabel: string;
  authorize?: () => boolean | Promise<boolean>;
  /** Called when the reply failed ambiguously and no duplicate push was sent. */
  onAmbiguousReplyFailure?: () => void;
}): Promise<void> {
  const { context, logLabel, text } = params;
  const sendOptions = {
    cfg: context.cfg,
    accountId: context.account.accountId,
    channelAccessToken: context.account.channelAccessToken,
    ...(params.authorize ? { authorize: params.authorize } : {}),
  };
  if (params.replyToken) {
    if (params.authorize && !(await params.authorize())) {
      return;
    }
    try {
      await replyMessageLine(params.replyToken, [{ type: "text", text }], sendOptions);
      return;
    } catch (err) {
      logVerbose(`${logLabel}: ${String(err)}`);
      if (isChannelPartialDeliveryError(err) || !canFallbackAfterLineReplyFailure(err)) {
        if (!isChannelPartialDeliveryError(err)) {
          params.onAmbiguousReplyFailure?.();
        }
        return;
      }
    }
  }
  if (params.authorize && !(await params.authorize())) {
    return;
  }
  try {
    await pushMessageLine(params.pushTarget, text, sendOptions);
  } catch (err) {
    logVerbose(`${logLabel}: ${String(err)}`);
  }
}

// Senders whose latest pairing reply failed ambiguously. The shared issuer
// deliberately sends nothing while a request is pending, so a challenge whose
// first delivery was uncertain could otherwise be lost for the pending request's
// one-hour lifetime. A later message from such a sender re-sends the same code
// once, and that re-send never re-arms the marker, so recovery fires at most
// once; a successful first delivery never marks the sender at all. The marker
// is keyed by the LINE account, sender and exact pending code so recovery state
// never authorizes a resend under another account or request.
const LINE_PAIRING_RECOVERY_TTL_MS = 60 * 60 * 1000;
const linePairingRecovery = new Map<string, number>();

function recoveryKey(accountId: string, senderId: string, code: string): string {
  return `${accountId}\u0000${senderId}\u0000${code}`;
}

function markLinePairingRecoveryNeeded(accountId: string, senderId: string, code: string): void {
  const now = Date.now();
  for (const [staleKey, markedAt] of linePairingRecovery) {
    if (now - markedAt > LINE_PAIRING_RECOVERY_TTL_MS) {
      linePairingRecovery.delete(staleKey);
    }
  }
  linePairingRecovery.set(recoveryKey(accountId, senderId, code), now);
}

function consumeLinePairingRecovery(accountId: string, senderId: string, code: string): boolean {
  const key = recoveryKey(accountId, senderId, code);
  const markedAt = linePairingRecovery.get(key);
  if (markedAt === undefined) {
    return false;
  }
  linePairingRecovery.delete(key);
  return Date.now() - markedAt <= LINE_PAIRING_RECOVERY_TTL_MS;
}

export async function sendLinePairingReply(params: {
  senderId: string;
  replyToken?: string;
  context: LineHandlerContext;
}): Promise<void> {
  const { senderId, replyToken, context } = params;
  const idLabel = (() => {
    try {
      return resolvePairingIdLabel("line");
    } catch {
      return "lineUserId";
    }
  })();
  const senderIdLine = `Your ${idLabel}: ${senderId}`;
  const accountId = context.account.accountId;
  const rearmRecovery = () => {
    const code = upsertResult?.code;
    if (code) {
      markLinePairingRecoveryNeeded(accountId, senderId, code);
    }
  };
  const sendReply = (text: string, logLabel: string, onAmbiguousReplyFailure?: () => void) =>
    sendLineHandlerText({
      context,
      text,
      replyToken,
      pushTarget: `line:${senderId}`,
      logLabel,
      ...(onAmbiguousReplyFailure ? { onAmbiguousReplyFailure } : {}),
    });
  let upsertResult: { code: string; created: boolean } | undefined;
  await createChannelPairingChallengeIssuer({
    channel: "line",
    accountId,
    upsertPairingRequest: async ({ id, meta }) => {
      upsertResult = await upsertChannelPairingRequest({
        channel: "line",
        id,
        accountId,
        meta,
      });
      return upsertResult;
    },
  })({
    senderId,
    senderIdLine,
    onCreated: () => {
      logVerbose(`line pairing request sender=${senderId}`);
    },
    sendPairingReply: async (text) =>
      await sendReply(text, `line pairing reply failed for ${senderId}`, rearmRecovery),
  });
  if (
    upsertResult?.code &&
    !upsertResult.created &&
    consumeLinePairingRecovery(accountId, senderId, upsertResult.code)
  ) {
    await sendReply(
      buildPairingReply({ channel: "line", idLine: senderIdLine, code: upsertResult.code }),
      `line pairing reply re-sent for ${senderId}`,
    );
  }
}
