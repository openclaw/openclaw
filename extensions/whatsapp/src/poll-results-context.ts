// Builds the stored poll results block for one chat, attached when the agent is woken there.
import type { WhatsAppSelfIdentity } from "./identity.js";
import { requireWhatsAppInboundAdmission } from "./inbound/admission.js";
import type { AdmittedWebInboundMessage } from "./inbound/types.js";
import {
  listWhatsAppChatPollIds,
  normalizeWhatsAppPollJids,
  readPluginStateErrorCode,
  readWhatsAppPollRecord,
  warnWhatsAppPollState,
  type WhatsAppPollAccount,
  type WhatsAppPollRecord,
} from "./poll-vote-store.js";
import { readWhatsAppPollTally, type WhatsAppPollTallyVoter } from "./poll-vote-tally-store.js";

export type WhatsAppPollResultsContextEntry = {
  label: string;
  source: string;
  type: string;
  payload: { note: string; polls: WhatsAppPollResultsPoll[] };
};

type WhatsAppPollResultsOption = { option: string; votes: number; voters: string[] };

type WhatsAppPollResultsPoll = {
  poll_id: string;
  question: string;
  created_by: string;
  created_at: string;
  selectable_count: number;
  voters_total: number;
  options: WhatsAppPollResultsOption[];
};

const MAX_POLLS = 3;
// Index rows can outlive their record, so read past the ones that no longer resolve.
const INDEX_READ_LIMIT = 12;
const MAX_NAMES_PER_OPTION = 50;
const MAX_PAYLOAD_BYTES = 4096;
const NOTE =
  "Stored latest selection per voter for polls in this chat. Mention only when asked about a poll.";

function pnJidToE164(jid: string): string | undefined {
  const digits = /^(\d+)@s\.whatsapp\.net$/.exec(jid)?.[1];
  return digits ? `+${digits}` : undefined;
}

// LID JIDs are never shown; they identify nobody to a reader.
function describeVoter(voter: WhatsAppPollTallyVoter): string {
  return (
    voter.name ||
    voter.e164 ||
    [voter.voterKey, ...voter.voterJids].map(pnJidToE164).find(Boolean) ||
    "unknown voter"
  );
}

function describeCreator(record: WhatsAppPollRecord): string {
  if (record.origin === "sent") {
    return "assistant";
  }
  return (
    record.creatorName ||
    record.creatorE164 ||
    record.creatorJids.map(pnJidToE164).find(Boolean) ||
    "unknown"
  );
}

/** Drops voters the chat's context visibility policy hides; they are neither named nor counted. */
export type WhatsAppPollVoterFilter = (
  voters: WhatsAppPollTallyVoter[],
) => WhatsAppPollTallyVoter[];

/** Whether the chat's context visibility policy still shows a received poll's creator. */
export type WhatsAppPollCreatorFilter = (record: WhatsAppPollRecord) => boolean;

export type WhatsAppPollVisibility = {
  filterVoters: WhatsAppPollVoterFilter;
  isCreatorVisible: WhatsAppPollCreatorFilter;
};

function buildPoll(
  pollMessageId: string,
  record: WhatsAppPollRecord,
  tally: WhatsAppPollTallyVoter[],
  filterVoters: WhatsAppPollVoterFilter | undefined,
): WhatsAppPollResultsPoll {
  // First voters first, so the list reads in the order people answered.
  const voters = (filterVoters ? filterVoters(tally) : tally)
    .filter((voter) => voter.selected.length > 0)
    .toSorted((a, b) => a.votedAtMs - b.votedAtMs || a.voterKey.localeCompare(b.voterKey));
  return {
    poll_id: pollMessageId,
    question: record.question,
    created_by: describeCreator(record),
    created_at: new Date(record.recordedAt).toISOString(),
    selectable_count: record.selectableCount,
    voters_total: voters.length,
    options: record.options.map((option) => {
      const names = voters
        .filter((voter) => voter.selected.includes(option))
        .map((voter) => describeVoter(voter));
      const shown = names.slice(0, MAX_NAMES_PER_OPTION);
      return {
        option,
        votes: names.length,
        voters:
          names.length > shown.length ? [...shown, `+${names.length - shown.length} more`] : shown,
      };
    }),
  };
}

function payloadBytes(payload: WhatsAppPollResultsContextEntry["payload"]): number {
  return Buffer.byteLength(JSON.stringify(payload));
}

/** Drops voter names from the oldest poll first, then the oldest poll itself. */
function fitPayload(polls: WhatsAppPollResultsPoll[]): WhatsAppPollResultsPoll[] {
  const fitted = [...polls];
  for (let index = fitted.length - 1; index >= 0; index--) {
    if (payloadBytes({ note: NOTE, polls: fitted }) <= MAX_PAYLOAD_BYTES) {
      return fitted;
    }
    const poll = fitted[index];
    if (!poll) {
      continue;
    }
    fitted[index] = {
      ...poll,
      options: poll.options.map(({ option, votes }) => ({
        option,
        votes,
        voters: votes > 0 ? [`+${votes} more`] : [],
      })),
    };
    if (payloadBytes({ note: NOTE, polls: fitted }) <= MAX_PAYLOAD_BYTES) {
      return fitted;
    }
    fitted.splice(index, 1);
  }
  return fitted;
}

/**
 * Reads only the queued message's own chat, account and linked phone; nothing
 * the model controls selects the chat, so voter names never cross into another
 * chat, and polls recorded by a previously linked phone never reach this one.
 * Never throws: any failure yields no block and one warning carrying the code.
 */
export async function readWhatsAppPollResultsContext(params: {
  account: WhatsAppPollAccount;
  chatJids: readonly (string | null | undefined)[];
  filterVoters?: WhatsAppPollVoterFilter;
  isCreatorVisible?: WhatsAppPollCreatorFilter;
}): Promise<WhatsAppPollResultsContextEntry | undefined> {
  try {
    const chatJids = new Set(normalizeWhatsAppPollJids(params.chatJids));
    const ids = await listWhatsAppChatPollIds({
      account: params.account,
      chatJids: [...chatJids],
      limit: INDEX_READ_LIMIT,
      errors: "throw",
    });
    const polls: WhatsAppPollResultsPoll[] = [];
    for (const { pollMessageId } of ids) {
      if (polls.length >= MAX_POLLS) {
        break;
      }
      const record = await readWhatsAppPollRecord(params.account, pollMessageId, {
        errors: "throw",
      });
      if (!record || !record.chatJids.some((jid) => chatJids.has(jid))) {
        continue;
      }
      // A hidden creator takes the whole poll with them. A sent poll was read under the
      // linked phone's own keys, so it is this assistant's and always shows.
      if (record.origin === "received" && params.isCreatorVisible?.(record) === false) {
        continue;
      }
      const tally = await readWhatsAppPollTally({
        record,
        account: params.account,
        pollMessageId,
        errors: "throw",
      });
      polls.push(buildPoll(pollMessageId, record, tally ?? [], params.filterVoters));
    }
    const fitted = fitPayload(polls);
    if (fitted.length === 0) {
      return undefined;
    }
    return {
      label: "WhatsApp poll results",
      source: "whatsapp",
      type: "poll_results",
      payload: { note: NOTE, polls: fitted },
    };
  } catch (error) {
    warnWhatsAppPollState("whatsapp poll results read failed", {
      code: readPluginStateErrorCode(error) ?? "unknown",
    });
    return undefined;
  }
}

/**
 * Returns a copy of the queued message with the results block appended, or the
 * message itself when there is none. Broadcast agents share the original
 * object, so it is never mutated. Direct chats also look up the PN JID derived
 * from the conversation's E.164, since the chat may arrive under a LID.
 * Callers pass the linked phone, and the voter and creator filters for the
 * chat's context visibility policy.
 */
export async function attachWhatsAppPollResultsContext(
  msg: AdmittedWebInboundMessage,
  params: WhatsAppPollVisibility & { self: WhatsAppSelfIdentity | null | undefined },
): Promise<AdmittedWebInboundMessage> {
  const admission = requireWhatsAppInboundAdmission(msg);
  const digits = /^\+(\d+)$/.exec(admission.conversation.id)?.[1];
  const { self, ...visibility } = params;
  const entry = await readWhatsAppPollResultsContext({
    account: { accountId: admission.accountId, self },
    chatJids: [
      msg.platform.chatJid,
      admission.conversation.kind === "direct" && digits ? `${digits}@s.whatsapp.net` : undefined,
    ],
    ...visibility,
  });
  if (!entry) {
    return msg;
  }
  const existing = msg.payload.channelStructuredContext ?? [];
  return { ...msg, payload: { ...msg.payload, channelStructuredContext: [...existing, entry] } };
}
