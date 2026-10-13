import type { SignalReactionNotificationMode } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { isSignalSenderAllowed, type SignalSender } from "../identity.js";
import type { SignalReactionMessage } from "./event-handler.types.js";

type SignalReactionTarget = {
  kind: "phone" | "uuid";
  id: string;
  display: string;
};

export function resolveSignalStatusReactionTimestamp(params: {
  timestamp?: number;
  messageId?: string;
}): number | null {
  if (typeof params.timestamp === "number") {
    return Number.isFinite(params.timestamp) && params.timestamp > 0 ? params.timestamp : null;
  }
  const parsed = Number(params.messageId);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveSignalReactionTargets(
  reaction: SignalReactionMessage,
): SignalReactionTarget[] {
  const targets: SignalReactionTarget[] = [];
  const uuid = reaction.targetAuthorUuid?.trim();
  if (uuid) {
    targets.push({ kind: "uuid", id: uuid, display: `uuid:${uuid}` });
  }
  const author = reaction.targetAuthor?.trim();
  if (author) {
    const normalized = normalizeE164(author);
    targets.push({ kind: "phone", id: normalized, display: normalized });
  }
  return targets;
}

export function isSignalReactionMessage(
  reaction: SignalReactionMessage | null | undefined,
): reaction is SignalReactionMessage {
  if (!reaction) {
    return false;
  }
  const emoji = reaction.emoji?.trim();
  const timestamp = reaction.targetSentTimestamp;
  const hasTarget = Boolean(
    normalizeOptionalString(reaction.targetAuthor) ||
    normalizeOptionalString(reaction.targetAuthorUuid),
  );
  return Boolean(emoji && typeof timestamp === "number" && timestamp > 0 && hasTarget);
}

export function shouldEmitSignalReactionNotification(params: {
  mode?: SignalReactionNotificationMode;
  account?: string | null;
  accountUuid?: string | null;
  targets?: SignalReactionTarget[];
  sender?: SignalSender | null;
  allowlist?: string[];
}) {
  const { mode, account, accountUuid, targets, sender, allowlist } = params;
  const effectiveMode = mode ?? "own";
  if (effectiveMode === "off") {
    return false;
  }
  if (effectiveMode === "own") {
    const accountId = normalizeOptionalString(account);
    const normalizedAccountUuid = normalizeOptionalString(accountUuid);
    if ((!accountId && !normalizedAccountUuid) || !targets || targets.length === 0) {
      return false;
    }
    const normalizedAccount = accountId ? normalizeE164(accountId) : undefined;
    return targets.some((target) => {
      if (target.kind === "uuid") {
        // UUID-only reaction payloads omit the phone identity carried by account.
        return [accountId, normalizedAccountUuid].some(
          (candidate) => candidate === target.id || candidate === `uuid:${target.id}`,
        );
      }
      return Boolean(normalizedAccount) && normalizedAccount === target.id;
    });
  }
  if (effectiveMode === "allowlist") {
    if (!sender || !allowlist || allowlist.length === 0) {
      return false;
    }
    return isSignalSenderAllowed(sender, allowlist);
  }
  return true;
}

export function buildSignalReactionSystemEventText(params: {
  emojiLabel: string;
  actorLabel: string;
  messageId: string;
  targetLabel?: string;
  groupLabel?: string;
}) {
  const base = `Signal reaction added: ${params.emojiLabel} by ${params.actorLabel} msg ${params.messageId}`;
  const withTarget = params.targetLabel ? `${base} from ${params.targetLabel}` : base;
  return params.groupLabel ? `${withTarget} in ${params.groupLabel}` : withTarget;
}
