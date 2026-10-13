// Turns an encrypted WhatsApp poll vote into a stored tally row, and in a direct
// chat on the agent's own poll into a message for the agent.
import type { proto, WAMessage } from "baileys";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { decodeWhatsAppPollVote } from "../poll-vote-decode.js";
import {
  isTransientWhatsAppPollStoreError,
  normalizeWhatsAppPollJids,
  normalizeWhatsAppPollMessageId,
  readPluginStateErrorCode,
  readWhatsAppPollRecord,
  warnWhatsAppPollState,
  type WhatsAppPollRecord,
} from "../poll-vote-store.js";
import {
  applyWhatsAppPollVote,
  normalizeWhatsAppPollVoteTimestampMs,
} from "../poll-vote-tally-store.js";
import { isJidGroup, normalizeMessageContent } from "./runtime-api.js";

export type WhatsAppPollVoteResolution =
  | { kind: "not-a-vote" }
  | { kind: "completed" }
  | { kind: "deliver"; message: WAMessage };

export type WhatsAppPollVoteDeps = {
  accountId: string;
  /** The account's own PN/LID JIDs: the voter of a fromMe vote, a creator candidate otherwise. */
  selfJids: readonly (string | null | undefined)[];
  resolveInboundJid?: (jid: string) => Promise<string | null | undefined>;
};

export type WhatsAppPollVoteMeta = { pollMessageId: string };

type WAMessageKeyWithAlt = NonNullable<WAMessage["key"]> & {
  remoteJidAlt?: string | null;
  participantAlt?: string | null;
};

// Marks derived vote messages so access control never answers them with a pairing prompt.
const pollVoteMeta = new WeakMap<object, WhatsAppPollVoteMeta>();

export function getWhatsAppPollVoteMeta(msg: object): WhatsAppPollVoteMeta | undefined {
  return pollVoteMeta.get(msg);
}

async function resolveVoterE164(
  voterJids: readonly string[],
  resolveInboundJid: WhatsAppPollVoteDeps["resolveInboundJid"],
): Promise<string | undefined> {
  for (const jid of voterJids) {
    try {
      const resolved = await resolveInboundJid?.(jid);
      if (resolved && /^\+\d+$/.test(resolved)) {
        return resolved;
      }
    } catch {
      // A missing mapping only costs the number in the results block.
    }
  }
  return undefined;
}

function buildDerivedVoteMessage(
  msg: WAMessage,
  pollMessageId: string,
  record: WhatsAppPollRecord,
  selected: string[],
  selfJids: readonly (string | null | undefined)[],
): WAMessage {
  const text = selected.length > 0 ? `Poll vote: ${selected.join(", ")}` : "Poll vote removed";
  const quotedMessage: proto.IMessage = {
    pollCreationMessageV3: {
      name: record.question,
      options: record.options.map((optionName) => ({ optionName })),
      selectableOptionsCount: record.selectableCount,
    },
  };
  const derived: WAMessage = {
    ...msg,
    message: {
      extendedTextMessage: {
        text,
        contextInfo: {
          stanzaId: pollMessageId,
          participant: normalizeWhatsAppPollJids([...selfJids, ...record.creatorJids])[0],
          quotedMessage,
        },
      },
    },
  };
  pollVoteMeta.set(derived, { pollMessageId });
  return derived;
}

/**
 * Votes never wake the agent in a group, on someone else's poll, or when the
 * vote is our own; those end as "completed" once counted. Only a direct-chat
 * vote on a poll the agent sent is delivered, as a message quoting the poll.
 * Transient store failures propagate so durable ingress replays the vote.
 */
export async function resolveWhatsAppPollVote(
  msg: WAMessage,
  deps: WhatsAppPollVoteDeps,
): Promise<WhatsAppPollVoteResolution> {
  const update = normalizeMessageContent(msg.message)?.pollUpdateMessage;
  if (!update) {
    return { kind: "not-a-vote" };
  }
  const creationKey = update.pollCreationMessageKey ?? undefined;
  const pollMessageId = normalizeWhatsAppPollMessageId(creationKey?.id);
  if (!pollMessageId) {
    return { kind: "completed" };
  }
  const record = await readWhatsAppPollRecord(deps.accountId, pollMessageId);
  if (!record) {
    logVerbose("whatsapp poll vote for an unknown poll; ignored");
    return { kind: "completed" };
  }
  const key = (msg.key ?? {}) as WAMessageKeyWithAlt;
  const group = Boolean(key.remoteJid && isJidGroup(key.remoteJid));
  const fromMe = Boolean(key.fromMe);
  const voterJids = normalizeWhatsAppPollJids(
    fromMe
      ? [key.participant, key.participantAlt, ...deps.selfJids]
      : group
        ? [key.participant, key.participantAlt]
        : [key.remoteJid, key.remoteJidAlt],
  );
  const decoded = await decodeWhatsAppPollVote({
    record,
    vote: update.vote,
    pollMessageId,
    creatorJids: [
      creationKey?.participant,
      (creationKey as WAMessageKeyWithAlt | undefined)?.participantAlt,
      ...deps.selfJids,
    ],
    voterJids,
    chat: {
      remoteJid: key.remoteJid,
      remoteJidAlt: key.remoteJidAlt,
      resolveInboundJid: deps.resolveInboundJid,
    },
  });
  if (!decoded.ok) {
    warnWhatsAppPollState("whatsapp poll vote rejected", {
      reason: decoded.reason,
      origin: record.origin,
      pollMessageId,
      chat: redactIdentifier(key.remoteJid ?? ""),
      attempts: decoded.attempts,
    });
    return { kind: "completed" };
  }
  const deliver = !group && !fromMe && record.origin === "sent";
  try {
    await applyWhatsAppPollVote({
      record,
      accountId: deps.accountId,
      pollMessageId,
      voter: {
        jids: voterJids,
        name: msg.pushName ?? undefined,
        e164: await resolveVoterE164(voterJids, deps.resolveInboundJid),
      },
      selected: decoded.selected,
      votedAtMs: normalizeWhatsAppPollVoteTimestampMs(
        update.senderTimestampMs,
        msg.messageTimestamp,
      ),
      errors: "throw",
    });
  } catch (error) {
    // A vote that wakes nobody must not hold the chat lane on a failing write.
    if (isTransientWhatsAppPollStoreError(error, deliver ? "write" : "read")) {
      throw error;
    }
    warnWhatsAppPollState("whatsapp poll store tally write failed", {
      code: readPluginStateErrorCode(error) ?? "unknown",
    });
  }
  if (!deliver) {
    return { kind: "completed" };
  }
  return {
    kind: "deliver",
    message: buildDerivedVoteMessage(msg, pollMessageId, record, decoded.selected, deps.selfJids),
  };
}
