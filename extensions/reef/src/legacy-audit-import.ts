import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { verifyChainSegment, type AuditEntry } from "../protocol/index.js";
import { forEachLegacyReefJsonlRecord } from "./legacy-jsonl.js";
import {
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_MAX_ENTRIES,
  parseReefAuditHead,
  reefAuditEntryKey,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
} from "./state.js";

// The canonical plugin-state store caps each persisted value at 65,536 bytes
// (MAX_PLUGIN_STATE_VALUE_BYTES). Migration must accept every journal the
// runtime store can hold, so per-record bounds mirror that per-value contract
// instead of an aggregate cap that can reject individually storable entries.
const REEF_LEGACY_AUDIT_RECORD_MAX_BYTES = 65_536;

export type LegacyReefAuditJournalSummary = {
  totalEntries: number;
  lastHash: string;
  lastSeq: number;
};

// Pass one: stream-validate the complete journal chain with O(1) memory and
// return the count needed to know the retention window boundary up front.
export async function validateLegacyReefAuditJournal(
  filePath: string,
): Promise<LegacyReefAuditJournalSummary> {
  let totalEntries = 0;
  let previousHash = "";
  let previousSeq = 0;
  let lastHash = "";
  let lastSeq = 0;
  await forEachLegacyReefJsonlRecord(filePath, "reject-torn", (value, recordBytes) => {
    if (recordBytes > REEF_LEGACY_AUDIT_RECORD_MAX_BYTES) {
      throw new Error(
        `Reef legacy JSONL audit record exceeds ${REEF_LEGACY_AUDIT_RECORD_MAX_BYTES} byte plugin-state value limit`,
      );
    }
    const entry = value as AuditEntry;
    if (
      !verifyChainSegment([entry], {
        previousHash,
        previousSeq,
        head: entry.entryHash,
      })
    ) {
      throw new Error("invalid Reef audit chain");
    }
    previousHash = entry.entryHash;
    previousSeq = entry.event.seq;
    totalEntries += 1;
    lastHash = entry.entryHash;
    lastSeq = entry.event.seq;
  });
  return { totalEntries, lastHash, lastSeq };
}

async function registerAuditEntry(
  store: PluginStateKeyedStore<ReefAuditStateRecord>,
  entry: AuditEntry,
  nextHash?: string,
): Promise<void> {
  const record: ReefAuditStateRecord = {
    kind: "entry",
    entry,
    ...(nextHash ? { nextHash } : {}),
  };
  const key = reefAuditEntryKey(entry.entryHash);
  const existing = await store.lookup(key);
  if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
    throw new Error(`conflicting audit entry ${entry.entryHash}`);
  }
  await store.registerIfAbsent(key, record);
}

// Pass two: re-stream the validated journal and persist only the newest
// windowSize entries with one-entry lag for the nextHash link, so migration
// memory stays bounded by bytes no matter how large the journal or its entries
// are. Re-validating the chain on this pass also closes a TOCTOU gap between
// the count pass and the persistence pass.
export async function streamLegacyReefAuditWindow(
  filePath: string,
  totalEntries: number,
  store: PluginStateKeyedStore<ReefAuditStateRecord>,
  headStore: PluginStateKeyedStore<ReefAuditHeadRecord>,
  windowSize = REEF_AUDIT_MAX_ENTRIES,
): Promise<{ persistedCount: number; oldestHash: string }> {
  const windowStart = Math.max(0, totalEntries - windowSize);
  let index = 0;
  let pending: AuditEntry | undefined;
  let persistedCount = 0;
  let oldestHash = "";
  let lastEntry: AuditEntry | undefined;
  let previousHash = "";
  let previousSeq = 0;
  await forEachLegacyReefJsonlRecord(filePath, "reject-torn", async (value, recordBytes) => {
    if (recordBytes > REEF_LEGACY_AUDIT_RECORD_MAX_BYTES) {
      throw new Error(
        `Reef legacy JSONL audit record exceeds ${REEF_LEGACY_AUDIT_RECORD_MAX_BYTES} byte plugin-state value limit`,
      );
    }
    const entry = value as AuditEntry;
    if (
      !verifyChainSegment([entry], {
        previousHash,
        previousSeq,
        head: entry.entryHash,
      })
    ) {
      throw new Error("invalid Reef audit chain");
    }
    previousHash = entry.entryHash;
    previousSeq = entry.event.seq;
    if (index >= windowStart) {
      if (pending) {
        await registerAuditEntry(store, pending, entry.entryHash);
        persistedCount += 1;
      }
      if (persistedCount === 0) {
        oldestHash = entry.entryHash;
      }
      pending = entry;
    }
    index += 1;
  });
  if (pending) {
    await registerAuditEntry(store, pending);
    persistedCount += 1;
    lastEntry = pending;
  }
  if (persistedCount > 0) {
    if (
      !(await headStore.registerIfAbsent(REEF_AUDIT_HEAD_KEY, {
        kind: "head",
        hash: lastEntry!.entryHash,
        seq: lastEntry!.event.seq,
        oldestHash,
      }))
    ) {
      throw new Error("audit head appeared during import");
    }
  }
  return { persistedCount, oldestHash };
}

// Streamed chain walk over the persisted window that verifies structure and
// entry hashes without materializing the window in memory.
export async function countStoredReefAuditWindow(
  store: PluginStateKeyedStore<ReefAuditStateRecord>,
  headStore: PluginStateKeyedStore<ReefAuditHeadRecord>,
  windowSize = REEF_AUDIT_MAX_ENTRIES,
): Promise<number> {
  const headValue = await headStore.lookup(REEF_AUDIT_HEAD_KEY);
  if (!headValue) {
    return 0;
  }
  const head = parseReefAuditHead(headValue);
  let hash = head.hash;
  let seq = head.seq;
  let count = 0;
  while (seq > 0 && count < windowSize) {
    const record = await store.lookup(reefAuditEntryKey(hash));
    if (!record) {
      break;
    }
    if (
      record.entry.entryHash !== hash ||
      record.entry.event.seq !== seq ||
      !verifyChainSegment([record.entry], {
        previousHash: record.entry.prevHash,
        previousSeq: record.entry.event.seq - 1,
        head: record.entry.entryHash,
      })
    ) {
      throw new Error("invalid Reef audit chain state");
    }
    count += 1;
    hash = record.entry.prevHash;
    seq -= 1;
  }
  const expected = Math.min(head.seq, windowSize);
  if (count !== expected) {
    throw new Error("Reef audit chain is shorter than its committed retention window");
  }
  return count;
}
