/**
 * Signal reactions via signal-cli JSON-RPC API
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequest } from "./client-adapter.js";
import { normalizeSignalUuidForCompare } from "./normalize.js";
import { resolveSignalRpcContext } from "./rpc-context.js";
import {
  rememberSignalSelfReplyEcho,
  resolveSignalSelfReplyReactionEchoText,
} from "./self-reply-echoes.js";

export type SignalReactionOpts = {
  cfg: OpenClawConfig;
  baseUrl?: string;
  account?: string;
  accountId?: string;
  timeoutMs?: number;
  targetAuthor?: string;
  targetAuthorUuid?: string;
  groupId?: string;
};

export type SignalReactionResult = {
  ok: boolean;
  timestamp?: number;
};

type SignalReactionErrorMessages = {
  missingRecipient: string;
  invalidTargetTimestamp: string;
  missingEmoji: string;
  missingTargetAuthor: string;
};

function normalizeSignalId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^signal:/i, "").trim();
}

function normalizeSignalUuid(raw: string): string {
  const trimmed = normalizeSignalId(raw);
  if (!trimmed) {
    return "";
  }
  if (normalizeLowercaseStringOrEmpty(trimmed).startsWith("uuid:")) {
    return trimmed.slice("uuid:".length).trim();
  }
  return trimmed;
}

function resolveTargetAuthorParams(params: {
  targetAuthor?: string;
  targetAuthorUuid?: string;
  fallback?: string;
}): { targetAuthor?: string } {
  const candidates = [params.targetAuthor, params.targetAuthorUuid, params.fallback];
  for (const candidate of candidates) {
    const raw = candidate?.trim();
    if (!raw) {
      continue;
    }
    const normalized = normalizeSignalUuid(raw);
    if (normalized) {
      return { targetAuthor: normalized };
    }
  }
  return {};
}

function isSignalSelfReactionTarget(params: {
  recipient: string;
  account?: string | null;
  accountUuid?: string | null;
}): boolean {
  const recipientUuid = normalizeSignalUuidForCompare(params.recipient);
  const accountUuid = normalizeSignalUuidForCompare(params.accountUuid);
  if (recipientUuid && accountUuid && recipientUuid === accountUuid) {
    return true;
  }
  const recipientPhone = normalizeE164(params.recipient);
  const accountPhone = normalizeE164(params.account ?? "");
  return Boolean(recipientPhone && accountPhone && recipientPhone === accountPhone);
}

async function sendReactionSignalCore(params: {
  recipient: string;
  targetTimestamp: number;
  emoji: string;
  remove: boolean;
  opts: SignalReactionOpts;
  errors: SignalReactionErrorMessages;
}): Promise<SignalReactionResult> {
  const cfg = requireRuntimeConfig(params.opts.cfg, "Signal reactions");
  const apiMode = cfg.channels?.signal?.apiMode;
  const accountInfo = resolveSignalAccount({
    cfg,
    accountId: params.opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(params.opts, accountInfo);

  const normalizedRecipient = normalizeSignalUuid(params.recipient);
  const groupId = params.opts.groupId?.trim();
  if (!normalizedRecipient && !groupId) {
    throw new Error(params.errors.missingRecipient);
  }
  if (!Number.isFinite(params.targetTimestamp) || params.targetTimestamp <= 0) {
    throw new Error(params.errors.invalidTargetTimestamp);
  }
  const normalizedEmoji = params.emoji?.trim();
  if (!normalizedEmoji) {
    throw new Error(params.errors.missingEmoji);
  }

  const targetAuthorParams = resolveTargetAuthorParams({
    targetAuthor: params.opts.targetAuthor,
    targetAuthorUuid: params.opts.targetAuthorUuid,
    fallback: normalizedRecipient,
  });
  if (groupId && !targetAuthorParams.targetAuthor) {
    throw new Error(params.errors.missingTargetAuthor);
  }

  const requestParams: Record<string, unknown> = {
    emoji: normalizedEmoji,
    targetTimestamp: params.targetTimestamp,
    ...(params.remove ? { remove: true } : {}),
    ...targetAuthorParams,
  };
  if (normalizedRecipient) {
    requestParams.recipients = [normalizedRecipient];
  }
  if (groupId) {
    requestParams.groupIds = [groupId];
  }
  if (account) {
    requestParams.account = account;
  }

  const result = await signalRpcRequest<{ timestamp?: number }>("sendReaction", requestParams, {
    baseUrl,
    timeoutMs: params.opts.timeoutMs,
    apiMode,
  });

  if (
    accountInfo.config.ingressMode === "note-to-self" &&
    !groupId &&
    isSignalSelfReactionTarget({
      recipient: normalizedRecipient,
      account,
      accountUuid: accountInfo.config.accountUuid,
    })
  ) {
    const reactionEchoText = resolveSignalSelfReplyReactionEchoText({
      emoji: normalizedEmoji,
      remove: params.remove,
      targetTimestamp: params.targetTimestamp,
      targetAuthor: params.opts.targetAuthor,
      targetAuthorUuid: params.opts.targetAuthorUuid,
    });
    await rememberSignalSelfReplyEcho({
      accountId: accountInfo.accountId,
      accountIdentity: accountInfo.config.accountUuid ?? account,
      messageId: result?.timestamp != null ? String(result.timestamp) : undefined,
      timestamp: result?.timestamp,
      text: reactionEchoText,
      includeTextWithPrimary: true,
    });
  }

  return {
    ok: true,
    timestamp: result?.timestamp,
  };
}

/**
 * Send a Signal reaction to a message
 * @param recipient - UUID or E.164 phone number of the message author
 * @param targetTimestamp - Message ID (timestamp) to react to
 * @param emoji - Emoji to react with
 * @param opts - Optional account/connection overrides
 */
export async function sendReactionSignal(
  recipient: string,
  targetTimestamp: number,
  emoji: string,
  opts: SignalReactionOpts,
): Promise<SignalReactionResult> {
  return await sendReactionSignalCore({
    recipient,
    targetTimestamp,
    emoji,
    remove: false,
    opts,
    errors: {
      missingRecipient: "Recipient or groupId is required for Signal reaction",
      invalidTargetTimestamp: "Valid targetTimestamp is required for Signal reaction",
      missingEmoji: "Emoji is required for Signal reaction",
      missingTargetAuthor: "targetAuthor is required for group reactions",
    },
  });
}

/**
 * Remove a Signal reaction from a message
 * @param recipient - UUID or E.164 phone number of the message author
 * @param targetTimestamp - Message ID (timestamp) to remove reaction from
 * @param emoji - Emoji to remove
 * @param opts - Optional account/connection overrides
 */
export async function removeReactionSignal(
  recipient: string,
  targetTimestamp: number,
  emoji: string,
  opts: SignalReactionOpts,
): Promise<SignalReactionResult> {
  return await sendReactionSignalCore({
    recipient,
    targetTimestamp,
    emoji,
    remove: true,
    opts,
    errors: {
      missingRecipient: "Recipient or groupId is required for Signal reaction removal",
      invalidTargetTimestamp: "Valid targetTimestamp is required for Signal reaction removal",
      missingEmoji: "Emoji is required for Signal reaction removal",
      missingTargetAuthor: "targetAuthor is required for group reaction removal",
    },
  });
}
