import type {
  PluginStateOperationCommand,
  PluginStateOperationTransaction,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createAuditEntry, type AuditEntry } from "../protocol/audit.js";
import {
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_MIGRATION_KEY,
  parseReefAuditHead,
  parseAuditEntryRecord,
  parseAuditStateRecord,
  reefAuditEntryKey,
  verifyReefAuditWindow,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
} from "./audit-state-format.js";

export type ReefAuditOperationConfig = {
  head: number;
  migration: number;
  entries: number;
  auditKey: Uint8Array;
  maxEntries: number;
};
export type ReefAuditAppendEvent = { type: string; payload: unknown; ts: number };
export type ReefAuditOperations = {
  append: {
    input: ReefAuditOperationConfig & { events: readonly ReefAuditAppendEvent[] };
    output: AuditEntry[];
  };
  entries: { input: ReefAuditOperationConfig; output: AuditEntry[] };
};

function readAuditHead(
  tx: PluginStateOperationTransaction,
  config: ReefAuditOperationConfig,
): ReefAuditHeadRecord {
  const [head, migration] = tx.lookupMany([
    { store: config.head, key: REEF_AUDIT_HEAD_KEY },
    { store: config.migration, key: REEF_AUDIT_MIGRATION_KEY },
  ]);
  if (migration !== undefined) {
    throw new Error(
      "Reef audit migration is incomplete; repair audit.jsonl and rerun openclaw doctor --fix",
    );
  }
  return parseReefAuditHead(head);
}

export function appendReefAuditEvents(
  tx: PluginStateOperationTransaction,
  config: ReefAuditOperationConfig,
  events: readonly ReefAuditAppendEvent[],
): AuditEntry[] {
  if (events.length === 0) {
    return [];
  }
  let head = readAuditHead(tx, config);
  if (head.pending && head.pending.expiresAt > Date.now()) {
    throw new Error("Reef audit append is owned by an active legacy writer");
  }
  const staleEntryKey = head.pending?.entryKey;
  if (staleEntryKey && (!staleEntryKey.startsWith("entry:") || staleEntryKey === "entry:")) {
    throw new Error("invalid Reef audit staged entry key");
  }
  let plannedHead = head;
  const appended = events.map(({ type, payload, ts }) => {
    const entry = createAuditEntry(type, payload, ts, config.auditKey, plannedHead);
    plannedHead = { ...plannedHead, hash: entry.entryHash, seq: entry.event.seq };
    return entry;
  });
  const keys = [
    ...new Set([
      ...appended.map((entry) => reefAuditEntryKey(entry.entryHash)),
      ...(head.hash ? [reefAuditEntryKey(head.hash)] : []),
      ...(head.seq >= config.maxEntries ? [reefAuditEntryKey(head.oldestHash)] : []),
    ]),
  ];
  const values = tx.lookupMany<ReefAuditStateRecord>(
    keys.map((key) => ({ store: config.entries, key })),
  );
  const rows = new Map<string, unknown>(keys.map((key, index) => [key, values[index]]));
  const changes = new Map<string, ReefAuditStateRecord | undefined>();
  const read = (key: string) => {
    if (changes.has(key)) {
      return changes.get(key);
    }
    if (!rows.has(key)) {
      rows.set(key, tx.lookup(config.entries, key));
    }
    return rows.get(key);
  };
  // Released writers can leave an expired staged append or retention orphan.
  // Their cleanup commits with the replacement chain, never on its own.
  for (const key of [staleEntryKey, head.garbageEntryKey]) {
    if (key) {
      changes.set(key, undefined);
    }
  }
  for (const entry of appended) {
    const entryKey = reefAuditEntryKey(entry.entryHash);
    if (read(entryKey) !== undefined) {
      throw new Error("Reef audit entry already exists before head advancement");
    }
    const previousKey = head.hash ? reefAuditEntryKey(head.hash) : undefined;
    if (previousKey) {
      const previous = parseAuditStateRecord(read(previousKey));
      if (previous.entry.entryHash !== head.hash) {
        throw new Error("Reef audit head entry differs before linking append");
      }
      if (
        previous.nextHash !== undefined &&
        reefAuditEntryKey(previous.nextHash) !== staleEntryKey
      ) {
        throw new Error("Reef audit head already links a committed successor");
      }
      changes.set(previousKey, { ...previous, nextHash: entry.entryHash });
    }
    let oldestHash = head.seq === 0 ? entry.entryHash : head.oldestHash;
    if (head.seq >= config.maxEntries) {
      const oldestKey = reefAuditEntryKey(head.oldestHash);
      const oldest = parseAuditStateRecord(read(oldestKey));
      if (!oldest.nextHash) {
        throw new Error("Reef audit retention pointer is missing");
      }
      oldestHash = oldest.nextHash;
      changes.set(oldestKey, undefined);
    }
    changes.set(entryKey, { kind: "entry", entry });
    head = { kind: "head", hash: entry.entryHash, seq: entry.event.seq, oldestHash };
  }
  // Free capacity before inserting the final suffix. Intermediate pruned events
  // still contribute to the hash chain and returned receipts.
  for (const [key, value] of changes) {
    if (value === undefined && (!rows.has(key) || rows.get(key) !== undefined)) {
      tx.delete(config.entries, key);
    }
  }
  for (const [key, value] of changes) {
    if (value !== undefined) {
      tx.set(config.entries, key, value);
    }
  }
  tx.set(config.head, REEF_AUDIT_HEAD_KEY, head);
  return appended;
}

function readReefAuditEntries(
  tx: PluginStateOperationTransaction,
  config: ReefAuditOperationConfig,
): AuditEntry[] {
  const head = readAuditHead(tx, config);
  if (head.seq === 0) {
    return [];
  }
  const rows = new Map(
    tx.entries<ReefAuditStateRecord>(config.entries).map(({ key, value }) => [key, value]),
  );
  const reversed: AuditEntry[] = [];
  let hash = head.hash;
  for (let seq = head.seq; seq > 0 && reversed.length < config.maxEntries; seq--) {
    const record = rows.get(reefAuditEntryKey(hash));
    if (!record) {
      break;
    }
    const entry = parseAuditEntryRecord(record);
    if (entry.entryHash !== hash || entry.event.seq !== seq) {
      throw new Error("invalid Reef audit chain state");
    }
    reversed.push(entry);
    hash = entry.prevHash;
  }
  return verifyReefAuditWindow(reversed, head, config.maxEntries);
}

export function executeReefAuditOperation(
  command: PluginStateOperationCommand<ReefAuditOperations>,
  tx: PluginStateOperationTransaction,
): AuditEntry[] {
  return command.type === "append"
    ? appendReefAuditEvents(tx, command.input, command.input.events)
    : readReefAuditEntries(tx, command.input);
}
