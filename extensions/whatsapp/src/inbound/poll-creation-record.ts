// Extracts what a later vote needs from an incoming WhatsApp poll, and records it.
import { isJidGroup, type WAMessage } from "baileys";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveWhatsAppInboundPolicy } from "../inbound-policy.js";
import {
  normalizeWhatsAppPollJids,
  readPluginStateErrorCode,
  recordWhatsAppPoll,
  truncateUtf8,
  utf8ByteLength,
  warnWhatsAppPollState,
} from "../poll-vote-store.js";
import { findWhatsAppPollCreation } from "./poll-creation.js";

export type WhatsAppInboundPollRecordData = {
  chatJids: string[];
  creatorJids: string[];
  creatorName?: string;
  question: string;
  secret: Uint8Array;
  options: string[];
  selectableCount: number;
};

const POLL_SECRET_BYTES = 32;
const MAX_OPTIONS = 32;
const OPTION_MAX_BYTES = 1024;
const QUESTION_MAX_BYTES = 1024;
const NAME_MAX_BYTES = 128;

type WAMessageKeyWithAlt = NonNullable<WAMessage["key"]> & {
  remoteJidAlt?: string | null;
  participantAlt?: string | null;
};

function toSecretBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "string" && value) {
    return Buffer.from(value, "base64");
  }
  return undefined;
}

/** The poll layer's messageSecret wins, then an enclosing layer's, then the legacy encKey. */
function resolvePollSecret(
  match: NonNullable<ReturnType<typeof findWhatsAppPollCreation>>,
): Uint8Array | undefined {
  const candidates = [
    ...match.contextInfoLayers.map((layer) => layer.messageSecret),
    match.poll.encKey,
  ];
  for (const candidate of candidates) {
    const bytes = toSecretBytes(candidate);
    if (bytes?.byteLength === POLL_SECRET_BYTES) {
      return Uint8Array.from(bytes);
    }
  }
  return undefined;
}

export function extractWhatsAppInboundPollRecord(
  msg: Pick<WAMessage, "key" | "message" | "pushName">,
): WhatsAppInboundPollRecordData | { missingSecret: true } | undefined {
  const match = findWhatsAppPollCreation(msg.message);
  if (!match) {
    return undefined;
  }
  const options: string[] = [];
  for (const option of match.poll.options ?? []) {
    const name = option?.optionName;
    if (typeof name !== "string" || !name || utf8ByteLength(name) > OPTION_MAX_BYTES) {
      return undefined;
    }
    options.push(name);
  }
  if (options.length < 1 || options.length > MAX_OPTIONS) {
    return undefined;
  }
  const secret = resolvePollSecret(match);
  if (!secret) {
    return { missingSecret: true };
  }
  const key = (msg.key ?? {}) as WAMessageKeyWithAlt;
  const chatJids = normalizeWhatsAppPollJids([key.remoteJid, key.remoteJidAlt]);
  const isGroup = Boolean(key.remoteJid && isJidGroup(key.remoteJid));
  // A poll sent from the linked phone is ours; its creator JID comes from the vote key later.
  const creatorJids = key.fromMe
    ? normalizeWhatsAppPollJids([key.participant, key.participantAlt])
    : normalizeWhatsAppPollJids(
        isGroup ? [key.participant, key.participantAlt] : [key.remoteJid, key.remoteJidAlt],
      );
  const creatorName = msg.pushName?.trim();
  return {
    chatJids,
    creatorJids,
    ...(creatorName ? { creatorName: truncateUtf8(creatorName, NAME_MAX_BYTES) } : {}),
    question: truncateUtf8(match.poll.name ?? "", QUESTION_MAX_BYTES),
    secret,
    options,
    selectableCount: match.poll.selectableOptionsCount ?? 0,
  };
}

/**
 * Records an incoming poll so later votes on it can be decrypted. Callers pass
 * only messages access control already admitted; the group must also be
 * registered. Never throws: the poll is delivered exactly as before either way.
 */
export async function recordWhatsAppInboundPoll(params: {
  cfg: OpenClawConfig;
  accountId: string;
  msg: Pick<WAMessage, "key" | "message" | "pushName">;
  group: boolean;
  remoteJid: string;
  recordedAt?: number;
}): Promise<void> {
  try {
    const extracted = extractWhatsAppInboundPollRecord(params.msg);
    if (!extracted) {
      return;
    }
    if ("missingSecret" in extracted) {
      warnWhatsAppPollState("whatsapp inbound poll missing secret", {});
      return;
    }
    if (params.group) {
      const groupPolicy = resolveWhatsAppInboundPolicy({
        cfg: params.cfg,
        accountId: params.accountId,
      }).resolveConversationGroupPolicy(params.remoteJid);
      if (groupPolicy.allowlistEnabled && !groupPolicy.allowed) {
        return;
      }
    }
    await recordWhatsAppPoll(
      {
        accountId: params.accountId,
        pollMessageId: params.msg.key?.id ?? "",
        origin: "received",
        ...extracted,
        ...(params.recordedAt !== undefined ? { recordedAt: params.recordedAt } : {}),
      },
      { mode: "ifAbsent" },
    );
  } catch (error) {
    warnWhatsAppPollState("whatsapp inbound poll record failed", {
      code: readPluginStateErrorCode(error) ?? "unknown",
    });
  }
}
