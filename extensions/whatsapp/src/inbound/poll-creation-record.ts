// Extracts what a later vote needs from an incoming WhatsApp poll (pure; no storage).
import { isJidGroup, type WAMessage } from "baileys";
import { normalizeWhatsAppPollJids, truncateUtf8, utf8ByteLength } from "../poll-vote-store.js";
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
