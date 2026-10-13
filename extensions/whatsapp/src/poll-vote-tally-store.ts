// Latest selection per voter for recorded WhatsApp polls; no change history is kept.
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  buildWhatsAppKeyPrefixRange,
  normalizeWhatsAppPollJids,
  normalizeWhatsAppPollMessageId,
  openWhatsAppPollStore,
  resolveWhatsAppPollTtlMs,
  runWhatsAppPollStoreOperation,
  truncateUtf8,
  WHATSAPP_POLL_TTL_MS,
  type WhatsAppPollOrigin,
  type WhatsAppPollRecord,
  type WhatsAppPollStoreErrorMode,
} from "./poll-vote-store.js";

type WhatsAppPollTallyValue = {
  v: 1;
  voterJids: string[];
  name?: string;
  e164?: string;
  selected: string[];
  votedAtMs: number;
};

export type WhatsAppPollVoter = {
  /** Every JID known for the voter (participant, alt, LID); device suffixes are ignored. */
  jids: readonly (string | null | undefined)[];
  name?: string;
  e164?: string;
};

export type WhatsAppPollTallyVoter = {
  voterKey: string;
  voterJids: string[];
  name?: string;
  e164?: string;
  selected: string[];
  votedAtMs: number;
};

export const WHATSAPP_POLL_TALLY_STORES: Record<WhatsAppPollOrigin, OpenKeyedStoreOptions> = {
  sent: {
    namespace: "whatsapp.poll-tally-sent",
    maxEntries: 20_000,
    defaultTtlMs: WHATSAPP_POLL_TTL_MS,
  },
  received: {
    namespace: "whatsapp.poll-tally-received",
    maxEntries: 20_000,
    defaultTtlMs: WHATSAPP_POLL_TTL_MS,
  },
};
const TALLY_READ_LIMIT = 1100;
const NAME_MAX_BYTES = 128;

/**
 * senderTimestampMs is an int64: a protobuf Long before the durable queue and a
 * string after it. Missing or malformed values fall back to the message timestamp.
 */
export function normalizeWhatsAppPollVoteTimestampMs(
  senderTimestampMs: unknown,
  messageTimestampSeconds: unknown,
): number {
  const senderMs = toPositiveFiniteNumber(senderTimestampMs);
  if (senderMs !== undefined) {
    return senderMs;
  }
  const seconds = toPositiveFiniteNumber(messageTimestampSeconds);
  return seconds === undefined ? 0 : seconds * 1000;
}

function toPositiveFiniteNumber(value: unknown): number | undefined {
  let numeric: number | undefined;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string" || typeof value === "bigint") {
    numeric = Number(value);
  } else if (typeof (value as { toNumber?: unknown } | null)?.toNumber === "function") {
    numeric = (value as { toNumber: () => number }).toNumber();
  }
  return numeric !== undefined && Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function resolveVoterKey(voterJids: readonly string[]): string | undefined {
  return voterJids.find((jid) => jid.endsWith("@s.whatsapp.net")) ?? voterJids[0];
}

function tallyPrefix(accountId: string, pollMessageId: string): string {
  return `${accountId}:${pollMessageId}:`;
}

function isTallyValue(value: unknown): value is WhatsAppPollTallyValue {
  const tally = value as Partial<WhatsAppPollTallyValue> | null | undefined;
  return (
    tally?.v === 1 &&
    Array.isArray(tally.voterJids) &&
    tally.voterJids.every((jid) => typeof jid === "string") &&
    Array.isArray(tally.selected) &&
    tally.selected.every((option) => typeof option === "string") &&
    typeof tally.votedAtMs === "number"
  );
}

/**
 * Applies one decrypted vote. Callers rely on the per-chat ingress lane being
 * serial, so the read-then-write below cannot interleave with another vote on
 * the same poll. Returns false when the vote was stale or not stored.
 */
export async function applyWhatsAppPollVote(params: {
  record: WhatsAppPollRecord;
  accountId: string;
  pollMessageId: string;
  voter: WhatsAppPollVoter;
  selected: string[];
  votedAtMs: number;
  errors?: WhatsAppPollStoreErrorMode;
}): Promise<boolean> {
  const pollMessageId = normalizeWhatsAppPollMessageId(params.pollMessageId);
  const accountId = params.accountId.trim();
  const voterJids = normalizeWhatsAppPollJids(params.voter.jids);
  const voterKey = resolveVoterKey(voterJids);
  if (!pollMessageId || !accountId || !voterKey) {
    return false;
  }
  return await runWhatsAppPollStoreOperation({
    operation: "tally write",
    fallback: false,
    errors: params.errors,
    transient: "write",
    run: async () => {
      const store = openWhatsAppPollStore<WhatsAppPollTallyValue>(
        WHATSAPP_POLL_TALLY_STORES[params.record.origin],
      );
      if (!store) {
        return false;
      }
      const prefix = tallyPrefix(accountId, pollMessageId);
      const existing: Array<{ key: string; value: WhatsAppPollTallyValue }> = [];
      for (const jid of voterJids) {
        const value = await store.lookup(`${prefix}${jid}`);
        if (isTallyValue(value)) {
          existing.push({ key: `${prefix}${jid}`, value });
        }
      }
      if (existing.some(({ value }) => value.votedAtMs > params.votedAtMs)) {
        return false;
      }
      if (params.selected.length === 0) {
        for (const { key } of existing) {
          await store.delete(key);
        }
        return true;
      }
      const knownJids = normalizeWhatsAppPollJids([
        ...voterJids,
        ...existing.flatMap(({ value }) => value.voterJids),
      ]);
      const name =
        params.voter.name?.trim() || existing.find(({ value }) => value.name)?.value.name;
      const e164 =
        params.voter.e164?.trim() || existing.find(({ value }) => value.e164)?.value.e164;
      const voterRowKey = `${prefix}${voterKey}`;
      await store.register(
        voterRowKey,
        {
          v: 1,
          voterJids: knownJids,
          ...(name ? { name: truncateUtf8(name, NAME_MAX_BYTES) } : {}),
          ...(e164 ? { e164 } : {}),
          selected: [...params.selected],
          votedAtMs: params.votedAtMs,
        },
        { ttlMs: resolveWhatsAppPollTtlMs(params.record.recordedAt) },
      );
      for (const { key } of existing) {
        if (key !== voterRowKey) {
          await store.delete(key);
        }
      }
      return true;
    },
  });
}

/** Latest selection per voter; rows that share a JID collapse to the newest one. */
export async function readWhatsAppPollTally(params: {
  record: WhatsAppPollRecord;
  accountId: string;
  pollMessageId: string;
  errors?: WhatsAppPollStoreErrorMode;
}): Promise<WhatsAppPollTallyVoter[] | undefined> {
  const pollMessageId = normalizeWhatsAppPollMessageId(params.pollMessageId);
  const accountId = params.accountId.trim();
  if (!pollMessageId || !accountId) {
    return undefined;
  }
  return await runWhatsAppPollStoreOperation<WhatsAppPollTallyVoter[] | undefined>({
    operation: "tally read",
    fallback: undefined,
    errors: params.errors,
    run: async () => {
      const store = openWhatsAppPollStore<WhatsAppPollTallyValue>(
        WHATSAPP_POLL_TALLY_STORES[params.record.origin],
      );
      if (typeof store?.entriesInKeyRange !== "function") {
        return undefined;
      }
      const prefix = tallyPrefix(accountId, pollMessageId);
      const rows = await store.entriesInKeyRange(
        buildWhatsAppKeyPrefixRange(prefix, TALLY_READ_LIMIT),
      );
      const options = new Set(params.record.options);
      const candidates = rows
        // A voter key never contains ":", so a longer remainder belongs to another poll id.
        .filter((row) => !row.key.slice(prefix.length).includes(":") && isTallyValue(row.value))
        .toSorted((a, b) => b.value.votedAtMs - a.value.votedAtMs);
      const seenJids = new Set<string>();
      const voters: WhatsAppPollTallyVoter[] = [];
      for (const { key, value } of candidates) {
        const voterKey = key.slice(prefix.length);
        const jids = [voterKey, ...value.voterJids];
        if (jids.some((jid) => seenJids.has(jid))) {
          continue;
        }
        for (const jid of jids) {
          seenJids.add(jid);
        }
        voters.push({
          voterKey,
          voterJids: value.voterJids,
          ...(value.name ? { name: value.name } : {}),
          ...(value.e164 ? { e164: value.e164 } : {}),
          selected: value.selected.filter((option) => options.has(option)),
          votedAtMs: value.votedAtMs,
        });
      }
      return voters;
    },
  });
}
