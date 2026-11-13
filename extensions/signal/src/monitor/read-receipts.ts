import type { DmPolicy, GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  formatSignalSenderDisplay,
  formatSignalSenderId,
  resolveSignalPeerId,
  resolveSignalSender,
} from "../identity.js";
import { resolveSignalAccessState } from "./access-policy.js";
import type { SignalReceivePayload } from "./event-handler.types.js";

type SignalReadReceiptDeps = {
  cfg: OpenClawConfig;
  accountId: string;
  account?: string;
  accountUuid?: string;
  dmPolicy: DmPolicy;
  groupPolicy: GroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
};

/**
 * Turns a read receipt from an admitted direct sender into next-turn system context, the same
 * way reactions arrive, so the agent can tell a result it sent was opened. Returns true when the
 * payload was a read receipt (handled or deliberately dropped) and must not reach the message path.
 */
export async function handleSignalReadReceipt(
  deps: SignalReadReceiptDeps,
  payload: SignalReceivePayload | null | undefined,
): Promise<boolean> {
  const envelope = payload?.envelope;
  const receipt = envelope?.receiptMessage;
  if (!envelope || receipt?.isRead !== true || envelope.dataMessage || envelope.reactionMessage) {
    return false;
  }
  const sender = resolveSignalSender(envelope);
  const timestamps = (receipt.timestamps ?? []).filter(
    (timestamp): timestamp is number => Number.isSafeInteger(timestamp) && timestamp > 0,
  );
  if (!sender || timestamps.length === 0) {
    return true;
  }
  const ownNumber = deps.account ? normalizeE164(deps.account) : undefined;
  if (
    (sender.kind === "phone" && sender.e164 === ownNumber) ||
    (sender.kind === "uuid" && sender.raw === deps.accountUuid)
  ) {
    return true;
  }
  const { senderAccess } = await resolveSignalAccessState({ ...deps, sender, isGroup: false });
  if (senderAccess.decision !== "allow") {
    logVerbose(`Blocked signal read receipt sender ${formatSignalSenderDisplay(sender)}`);
    return true;
  }
  const route = resolveAgentRoute({
    cfg: deps.cfg,
    channel: "signal",
    accountId: deps.accountId,
    peer: { kind: "direct", id: resolveSignalPeerId(sender) },
  });
  const reader = envelope.sourceName ?? formatSignalSenderDisplay(sender);
  const senderId = formatSignalSenderId(sender);
  for (const timestamp of timestamps) {
    enqueueSystemEvent(`Signal read receipt: ${reader} read msg ${timestamp}`, {
      sessionKey: route.sessionKey,
      contextKey: `signal:read:${timestamp}:${senderId}`,
    });
  }
  return true;
}
