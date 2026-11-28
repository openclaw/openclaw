import {
  buildMentionRegexes,
  implicitMentionKindWhen,
  matchesMentionPatterns,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asPositiveSafeInteger } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveSignalAccountConfig } from "../accounts.js";
import { resolveSignalReplyContextWithPersistence } from "../reply-authors.js";
import type {
  SignalDataMessage,
  SignalEventHandlerDeps,
  SignalMention,
} from "./event-handler.types.js";

const OBJECT_REPLACEMENT = "\uFFFC";

function isValidMention(mention: SignalMention | null | undefined): mention is SignalMention {
  if (!mention) {
    return false;
  }
  if (!(mention.uuid || mention.number)) {
    return false;
  }
  if (typeof mention.start !== "number" || Number.isNaN(mention.start)) {
    return false;
  }
  if (typeof mention.length !== "number" || Number.isNaN(mention.length)) {
    return false;
  }
  return mention.length > 0;
}

function clampBounds(start: number, length: number, textLength: number) {
  const safeStart = Math.max(0, Math.trunc(start));
  const safeLength = Math.max(0, Math.trunc(length));
  const safeEnd = Math.min(textLength, safeStart + safeLength);
  return { start: safeStart, end: safeEnd };
}

function isValidStructuredMention(
  message: string,
  mention: SignalMention | null | undefined,
): mention is SignalMention {
  if (!mention || !(mention.uuid || mention.number)) {
    return false;
  }
  const { start, length } = mention;
  if (typeof start !== "number" || typeof length !== "number") {
    return false;
  }
  return (
    Number.isInteger(start) &&
    Number.isInteger(length) &&
    start >= 0 &&
    length > 0 &&
    start + length <= message.length
  );
}

function normalizeAccountPhone(account?: string | null) {
  const trimmed = account?.trim();
  return trimmed ? normalizeE164(trimmed) : undefined;
}

export async function resolveSignalMentionDecision(params: {
  cfg: OpenClawConfig;
  account: Pick<SignalEventHandlerDeps, "account" | "accountUuid" | "accountId">;
  agentId: string;
  groupId?: string;
  rawMessage: string;
  messageText: string;
  dataMessage: SignalDataMessage;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
}) {
  const { cfg, account, groupId, dataMessage } = params;
  const isGroup = Boolean(groupId);
  const mentionRegexes = buildMentionRegexes(cfg, params.agentId);
  const { mentions, quote } = dataMessage;
  const validMentions = (mentions ?? []).filter((mention) =>
    isValidStructuredMention(params.rawMessage, mention),
  );
  const botUuid = account.accountUuid?.trim();
  const botPhone = normalizeAccountPhone(account.account);
  const matchesBot = (uuid?: string | null, number?: string | null) => {
    if (botUuid && uuid?.trim() === botUuid) {
      return true;
    }
    return Boolean(botPhone && normalizeAccountPhone(number) === botPhone);
  };
  // signal-cli's legacy author field can contain a UUID when no number is known.
  const legacyQuoteAuthor = quote?.author?.trim();
  const quotePhone =
    quote?.authorNumber ?? (legacyQuoteAuthor?.startsWith("+") ? legacyQuoteAuthor : undefined);
  const quoteId = asPositiveSafeInteger(quote?.id);
  let quotesBot = false;
  if (
    groupId &&
    quoteId !== undefined &&
    matchesBot(quote?.authorUuid ?? legacyQuoteAuthor, quotePhone) &&
    cfg.channels?.defaults?.implicitMentions?.quotedBot !== false &&
    resolveSignalAccountConfig(cfg, account.accountId).implicitMentions?.quotedBot === true
  ) {
    const quoted = await resolveSignalReplyContextWithPersistence({
      accountId: account.accountId,
      to: `group:${groupId}`,
      replyToId: String(quoteId),
    });
    // An inbound or older reply context can have the bot's account identity too.
    quotesBot =
      quoted?.author !== undefined &&
      quoted.sentByOpenClaw === true &&
      matchesBot(quoted.author, quoted.author.startsWith("+") ? quoted.author : undefined);
  }
  const canDetectMention = mentionRegexes.length > 0 || Boolean(botUuid || botPhone);
  const { effectiveWasMentioned, shouldSkip } = resolveInboundMentionDecision({
    facts: {
      canDetectMention,
      wasMentioned:
        isGroup &&
        (matchesMentionPatterns(params.messageText, mentionRegexes) ||
          validMentions.some(({ uuid, number }) => matchesBot(uuid, number))),
      hasAnyMention: validMentions.length > 0,
      implicitMentionKinds: implicitMentionKindWhen("quoted_bot", quotesBot),
    },
    policy: {
      isGroup,
      requireMention:
        isGroup &&
        resolveChannelGroupRequireMention({
          cfg,
          channel: "signal",
          groupId,
          accountId: account.accountId,
          configuredGroupDefaultsToNoMention: true,
        }),
      allowTextCommands: true,
      hasControlCommand: params.hasControlCommand,
      commandAuthorized: params.commandAuthorized,
    },
  });
  return { canDetectMention, effectiveWasMentioned, shouldSkip };
}

export function renderSignalMentions(message: string, mentions?: SignalMention[] | null) {
  if (!message || !mentions?.length) {
    return message;
  }

  let normalized = message;
  const candidates = mentions.filter(isValidMention).toSorted((a, b) => b.start! - a.start!);

  for (const mention of candidates) {
    const identifier = mention.uuid ?? mention.number;
    if (!identifier) {
      continue;
    }

    const { start, end } = clampBounds(mention.start!, mention.length!, normalized.length);
    if (start >= end) {
      continue;
    }
    const slice = normalized.slice(start, end);

    if (!slice.includes(OBJECT_REPLACEMENT)) {
      continue;
    }

    normalized = normalized.slice(0, start) + `@${identifier}` + normalized.slice(end);
  }

  return normalized;
}
