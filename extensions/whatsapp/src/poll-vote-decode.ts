// Verifies a WhatsApp poll vote against its recorded poll and decrypts the selection.
import { createHash } from "node:crypto";
import { decryptPollVote, type proto } from "baileys";
import { normalizeWhatsAppPollJids, type WhatsAppPollRecord } from "./poll-vote-store.js";

export type WhatsAppPollVoteRejectReason = "chat-mismatch" | "decrypt-failed" | "unknown-options";

export type WhatsAppPollVoteDecodeResult =
  | { ok: true; selected: string[] }
  | { ok: false; reason: WhatsAppPollVoteRejectReason; attempts: number };

type MaybePromise<T> = T | Promise<T>;

export type WhatsAppPollVoteChat = {
  remoteJid: string | null | undefined;
  remoteJidAlt?: string | null;
  resolveInboundJid?: (jid: string) => MaybePromise<string | null | undefined>;
};

function hashOption(option: string): string {
  return createHash("sha256").update(Buffer.from(option)).digest("hex");
}

async function chatMatchesRecord(
  record: WhatsAppPollRecord,
  chat: WhatsAppPollVoteChat,
): Promise<boolean> {
  const recorded = new Set(normalizeWhatsAppPollJids(record.chatJids));
  const candidates = normalizeWhatsAppPollJids([chat.remoteJid, chat.remoteJidAlt]);
  if (candidates.some((jid) => recorded.has(jid))) {
    return true;
  }
  if (!chat.resolveInboundJid) {
    return false;
  }
  for (const jid of candidates) {
    let resolved: string | null | undefined;
    try {
      resolved = await chat.resolveInboundJid(jid);
    } catch {
      continue;
    }
    // The resolver yields an E.164 number for direct chats; compare it as a PN JID too.
    const digits = resolved?.startsWith("+") ? resolved.slice(1) : undefined;
    const forms = normalizeWhatsAppPollJids([
      resolved,
      digits && /^\d+$/.test(digits) ? `${digits}@s.whatsapp.net` : undefined,
    ]);
    if (forms.some((form) => recorded.has(form))) {
      return true;
    }
  }
  return false;
}

/**
 * The vote key binds the poll id, the creator JID and the voter JID exactly as
 * the voting client saw them (PN or LID), so every normalized pairing is tried.
 * GCM authenticates, so a wrong pairing fails instead of decoding garbage.
 */
export async function decodeWhatsAppPollVote(params: {
  record: WhatsAppPollRecord;
  vote: proto.Message.IPollEncValue | null | undefined;
  pollMessageId: string;
  creatorJids: readonly (string | null | undefined)[];
  voterJids: readonly (string | null | undefined)[];
  chat: WhatsAppPollVoteChat;
}): Promise<WhatsAppPollVoteDecodeResult> {
  if (!(await chatMatchesRecord(params.record, params.chat))) {
    return { ok: false, reason: "chat-mismatch", attempts: 0 };
  }
  const encPayload = params.vote?.encPayload;
  const encIv = params.vote?.encIv;
  const creators = normalizeWhatsAppPollJids([...params.record.creatorJids, ...params.creatorJids]);
  const voters = normalizeWhatsAppPollJids(params.voterJids);
  const pollEncKey = Buffer.from(params.record.secret, "base64");
  let attempts = 0;
  let hashes: Uint8Array[] | undefined;
  if (encPayload && encIv) {
    search: for (const pollCreatorJid of creators) {
      for (const voterJid of voters) {
        attempts += 1;
        try {
          hashes = decryptPollVote(
            { encPayload, encIv },
            { pollCreatorJid, pollMsgId: params.pollMessageId, pollEncKey, voterJid },
          ).selectedOptions;
          break search;
        } catch {
          // Wrong pairing or wrong secret; GCM rejected it.
        }
      }
    }
  }
  if (!hashes) {
    return { ok: false, reason: "decrypt-failed", attempts };
  }
  const byHash = new Map(params.record.options.map((option) => [hashOption(option), option]));
  const selected = hashes
    .map((hash) => byHash.get(Buffer.from(hash).toString("hex")))
    .filter((option): option is string => option !== undefined);
  if (hashes.length > 0 && selected.length === 0) {
    return { ok: false, reason: "unknown-options", attempts };
  }
  return { ok: true, selected: [...new Set(selected)] };
}
