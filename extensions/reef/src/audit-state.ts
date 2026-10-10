import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "@noble/hashes/utils.js";
import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
// Import from the defining module, not the protocol barrel: index.js re-exports
// guard-adapters, whose provider-http graph doctor enumeration must not cold-load.
import {
  createAuditEntry,
  verifyChainSegment,
  type AuditEntry,
  type AuditStore,
} from "../protocol/audit.js";

export const REEF_AUDIT_NAMESPACE = "audit";
export const REEF_AUDIT_HEAD_NAMESPACE = "audit-head";
export const REEF_AUDIT_HEAD_KEY = "head";
export const REEF_AUDIT_MAX_ENTRIES = 30_000;
export const REEF_AUDIT_STORE_MAX_ENTRIES = REEF_AUDIT_MAX_ENTRIES + 1;
export const REEF_AUDIT_HEAD_MAX_ENTRIES = 1;
export const REEF_AUDIT_MIGRATION_NAMESPACE = "audit-migration";
export const REEF_AUDIT_MIGRATION_KEY = "audit-jsonl";
export const REEF_AUDIT_MIGRATION_MAX_ENTRIES = 1;

type ReefAuditPendingAppend = {
  owner: string;
  expiresAt: number;
  entryKey?: string;
};

export type ReefAuditHeadRecord = {
  kind: "head";
  hash: string;
  seq: number;
  oldestHash: string;
  pending?: ReefAuditPendingAppend;
  garbageEntryKey?: string;
};

export type ReefAuditStateRecord = { kind: "entry"; entry: AuditEntry; nextHash?: string };

const REEF_AUDIT_APPEND_LEASE_MS = 30_000;
const REEF_AUDIT_APPEND_RETRY_MS = 25;
const REEF_AUDIT_APPEND_ATTEMPTS = 120;

export function reefAuditEntryKey(entryHash: string): string {
  return `entry:${entryHash}`;
}

export function parseReefAuditHead(value: ReefAuditHeadRecord | undefined): ReefAuditHeadRecord {
  if (value === undefined) {
    return { kind: "head", hash: "", seq: 0, oldestHash: "" };
  }
  if (
    value.kind !== "head" ||
    typeof value.hash !== "string" ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 0 ||
    (value.seq === 0) !== (value.hash === "") ||
    typeof value.oldestHash !== "string" ||
    (value.seq === 0) !== (value.oldestHash === "") ||
    (value.garbageEntryKey !== undefined &&
      (typeof value.garbageEntryKey !== "string" || value.garbageEntryKey.length === 0)) ||
    (value.pending !== undefined &&
      (typeof value.pending.owner !== "string" ||
        value.pending.owner.length === 0 ||
        !Number.isSafeInteger(value.pending.expiresAt) ||
        value.pending.expiresAt <= 0 ||
        (value.pending.entryKey !== undefined &&
          (typeof value.pending.entryKey !== "string" || value.pending.entryKey.length === 0))))
  ) {
    throw new Error("invalid Reef audit head");
  }
  return value;
}

function parseAuditEntryRecord(value: ReefAuditStateRecord | undefined): AuditEntry {
  if (!value || value.kind !== "entry") {
    throw new Error("missing Reef audit entry");
  }
  return value.entry;
}

function parseAuditStateRecord(value: ReefAuditStateRecord | undefined): ReefAuditStateRecord {
  parseAuditEntryRecord(value);
  if (
    value?.nextHash !== undefined &&
    (typeof value.nextHash !== "string" || value.nextHash.length === 0)
  ) {
    throw new Error("invalid Reef audit next pointer");
  }
  return value!;
}

export function verifyReefAuditWindow(
  reversed: AuditEntry[],
  head: ReefAuditHeadRecord,
  maxEntries: number,
): AuditEntry[] {
  if (reversed.length !== Math.min(head.seq, maxEntries)) {
    throw new Error("Reef audit chain is shorter than its committed retention window");
  }
  const entries = reversed.toReversed();
  const first = entries[0];
  if (
    !first ||
    !verifyChainSegment(entries, {
      previousHash: first.prevHash,
      previousSeq: first.event.seq - 1,
      head: head.hash,
    })
  ) {
    throw new Error("invalid Reef audit chain state");
  }
  return entries;
}

class ReefSqliteAuditStore implements AuditStore {
  readonly #auditKey: Uint8Array;
  readonly #rng: (length: number) => Uint8Array;
  readonly #maxEntries: number;
  readonly #store: PluginStateKeyedStore<ReefAuditStateRecord, 2>;
  readonly #headStore: PluginStateKeyedStore<ReefAuditHeadRecord, 2>;
  readonly #enqueue = createAsyncLock();

  constructor(
    runtime: PluginRuntime,
    auditKey: Uint8Array,
    rng: (length: number) => Uint8Array = randomBytes,
    maxEntries = REEF_AUDIT_MAX_ENTRIES,
  ) {
    if (auditKey.length !== 32) {
      throw new Error("audit key must be 32 bytes");
    }
    this.#auditKey = auditKey.slice();
    this.#rng = rng;
    this.#maxEntries = maxEntries;
    this.#store = runtime.state.openKeyedStoreV2<ReefAuditStateRecord>({
      namespace: REEF_AUDIT_NAMESPACE,
      maxEntries: maxEntries + 1,
      overflowPolicy: "reject-new",
    });
    this.#headStore = runtime.state.openKeyedStoreV2<ReefAuditHeadRecord>({
      namespace: REEF_AUDIT_HEAD_NAMESPACE,
      maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
  }

  async #editHead(
    decide: (head: ReefAuditHeadRecord) => ReefAuditHeadRecord,
  ): Promise<ReefAuditHeadRecord> {
    let observation = await this.#headStore.observe(REEF_AUDIT_HEAD_KEY);
    for (;;) {
      const value = decide(parseReefAuditHead(observation.value));
      const result = await this.#headStore.compareAndApply(
        REEF_AUDIT_HEAD_KEY,
        observation.comparison,
        { operation: "update", action: "set", value },
      );
      if (result.status !== "conflict") {
        return value;
      }
      observation = result.current;
    }
  }

  async #editEntry(
    key: string,
    acceptsHead: (head: ReefAuditHeadRecord) => boolean,
    decide: (entry: ReefAuditStateRecord | undefined) => ReefAuditStateRecord | undefined,
  ): Promise<void> {
    for (;;) {
      const head = await this.#headStore.observe(REEF_AUDIT_HEAD_KEY);
      if (!acceptsHead(parseReefAuditHead(head.value))) {
        throw new Error("Reef audit append lease was lost before entry mutation");
      }
      const observation = await this.#store.observe(key);
      const value = decide(observation.value);
      const result = await this.#store.compareAndApply(
        key,
        observation.comparison,
        value === undefined
          ? { operation: "delete", action: "delete" }
          : { operation: "update", action: "set", value },
        {
          conditions: [
            {
              namespace: REEF_AUDIT_HEAD_NAMESPACE,
              key: REEF_AUDIT_HEAD_KEY,
              comparison: head.comparison,
            },
          ],
        },
      );
      if (result.status !== "conflict") {
        return;
      }
    }
  }

  appendEvent(
    type: string,
    payload: unknown,
    ts = Math.floor(Date.now() / 1000),
  ): Promise<AuditEntry> {
    return this.#enqueue(() => this.#appendEvent(type, payload, ts));
  }

  async #appendEvent(type: string, payload: unknown, ts: number): Promise<AuditEntry> {
    const owner = randomUUID();
    const ownsHead = (head: ReefAuditHeadRecord) => head.pending?.owner === owner;
    for (let attempt = 0; attempt < REEF_AUDIT_APPEND_ATTEMPTS; attempt++) {
      const acquired = await this.#editHead((latest) => {
        if (latest.pending && latest.pending.expiresAt > Date.now()) {
          return latest;
        }
        return {
          ...latest,
          pending: {
            owner,
            expiresAt: Date.now() + REEF_AUDIT_APPEND_LEASE_MS,
            ...(latest.pending?.entryKey ? { entryKey: latest.pending.entryKey } : {}),
          },
        };
      });
      if (!ownsHead(acquired)) {
        await sleep(REEF_AUDIT_APPEND_RETRY_MS);
        continue;
      }
      let staleEntryKey = acquired.pending?.entryKey;
      const { pending: _acquiredPending, ...committedHead } = acquired;
      let head = committedHead;

      let entryKey: string | undefined;
      let entryHash: string | undefined;
      let inserted = false;
      let staleCleanupComplete = !staleEntryKey;
      try {
        if (staleEntryKey) {
          if (!staleEntryKey.startsWith("entry:") || staleEntryKey.length === "entry:".length) {
            throw new Error("invalid Reef audit staged entry key");
          }
          const staleEntryHash = staleEntryKey.slice("entry:".length);
          if (head.hash) {
            await this.#editEntry(reefAuditEntryKey(head.hash), ownsHead, (current) => {
              const previous = parseAuditStateRecord(current);
              if (previous.nextHash !== staleEntryHash) {
                return previous;
              }
              const { nextHash: _nextHash, ...unlinked } = previous;
              return unlinked;
            });
          }
          await this.#editEntry(staleEntryKey, ownsHead, () => undefined);
          await this.#editHead((latest) => {
            if (latest.pending?.owner !== owner || latest.pending.entryKey !== staleEntryKey) {
              return latest;
            }
            return {
              ...latest,
              pending: {
                owner,
                expiresAt: latest.pending.expiresAt,
              },
            };
          });
          staleCleanupComplete = true;
          staleEntryKey = undefined;
        }
        if (head.garbageEntryKey) {
          await this.#editEntry(head.garbageEntryKey, ownsHead, () => undefined);
          await this.#editHead((latest) => {
            if (latest.pending?.owner !== owner) {
              return latest;
            }
            const { garbageEntryKey: _garbageEntryKey, ...cleaned } = latest;
            return cleaned;
          });
          const { garbageEntryKey: _garbageEntryKey, ...cleanedHead } = head;
          head = cleanedHead;
        }
        const entry = createAuditEntry(type, payload, ts, this.#auditKey, head, this.#rng);
        entryHash = entry.entryHash;
        entryKey = reefAuditEntryKey(entry.entryHash);
        await this.#editHead((latest) => {
          if (
            latest.hash !== head.hash ||
            latest.seq !== head.seq ||
            latest.pending?.owner !== owner
          ) {
            throw new Error("Reef audit append lease was lost before staging");
          }
          return { ...latest, pending: { ...latest.pending, entryKey } };
        });
        await this.#editEntry(entryKey, ownsHead, (current) => {
          if (current) {
            throw new Error("Reef audit entry already exists before head advancement");
          }
          return { kind: "entry", entry };
        });
        inserted = true;
        if (head.hash) {
          await this.#editEntry(reefAuditEntryKey(head.hash), ownsHead, (current) => {
            const previous = parseAuditStateRecord(current);
            if (previous.entry.entryHash !== head.hash) {
              throw new Error("Reef audit head entry differs before linking append");
            }
            if (previous.nextHash === entry.entryHash) {
              return previous;
            }
            if (previous.nextHash !== undefined) {
              throw new Error("Reef audit head already links a committed successor");
            }
            return { ...previous, nextHash: entry.entryHash };
          });
        }
        let oldestHash = head.seq === 0 ? entry.entryHash : head.oldestHash;
        let garbageEntryKey: string | undefined;
        if (head.seq >= this.#maxEntries) {
          const oldest = parseAuditStateRecord(
            await this.#store.lookup(reefAuditEntryKey(head.oldestHash)),
          );
          if (!oldest.nextHash) {
            throw new Error("Reef audit retention pointer is missing");
          }
          oldestHash = oldest.nextHash;
          garbageEntryKey = reefAuditEntryKey(head.oldestHash);
        }
        await this.#editHead((latest) => {
          if (
            latest.hash !== head.hash ||
            latest.seq !== head.seq ||
            latest.pending?.owner !== owner ||
            latest.pending.entryKey !== entryKey
          ) {
            throw new Error("Reef audit append lease was lost before commit");
          }
          return {
            kind: "head",
            hash: entry.entryHash,
            seq: entry.event.seq,
            oldestHash,
            ...(garbageEntryKey ? { garbageEntryKey } : {}),
          };
        });
        if (garbageEntryKey) {
          try {
            await this.#editEntry(
              garbageEntryKey,
              (latest) =>
                latest.hash === entry.entryHash && latest.garbageEntryKey === garbageEntryKey,
              () => undefined,
            );
            await this.#editHead((latest) => {
              if (latest.hash !== entry.entryHash || latest.garbageEntryKey !== garbageEntryKey) {
                return latest;
              }
              const { garbageEntryKey: _garbageEntryKey, ...cleaned } = latest;
              return cleaned;
            });
          } catch {
            // The committed head names the orphan. The next lease holder
            // removes it before consuming the single overflow slot.
          }
        }
        return structuredClone(entry);
      } catch (error) {
        const latestHead = parseReefAuditHead(await this.#headStore.lookup(REEF_AUDIT_HEAD_KEY));
        const entryOwnedElsewhere =
          entryKey !== undefined &&
          ((latestHead.hash === entryHash && latestHead.seq === head.seq + 1) ||
            (latestHead.pending?.owner !== owner && latestHead.pending?.entryKey === entryKey));
        if (inserted && entryKey && !entryOwnedElsewhere && ownsHead(latestHead)) {
          await this.#editEntry(entryKey, ownsHead, () => undefined);
        }
        if (entryKey && head.hash && !entryOwnedElsewhere && ownsHead(latestHead)) {
          await this.#editEntry(reefAuditEntryKey(head.hash), ownsHead, (current) => {
            const previous = parseAuditStateRecord(current);
            if (previous.nextHash !== entryHash) {
              return previous;
            }
            const { nextHash: _nextHash, ...unlinked } = previous;
            return unlinked;
          });
        }
        await this.#editHead((latest) => {
          if (latest.pending?.owner !== owner) {
            return latest;
          }
          if (!staleCleanupComplete && staleEntryKey) {
            return {
              ...latest,
              pending: {
                owner,
                expiresAt: Math.max(1, Date.now() - 1),
                entryKey: staleEntryKey,
              },
            };
          }
          const { pending: _pending, ...committed } = latest;
          return committed;
        });
        throw error;
      }
    }
    throw new Error("Reef audit append contention exceeded retry budget");
  }

  async entries(): Promise<AuditEntry[]> {
    for (;;) {
      const observed = await this.#headStore.observe(REEF_AUDIT_HEAD_KEY);
      const rows = await this.#store.entries();
      const checked = await this.#headStore.compareAndApply(
        REEF_AUDIT_HEAD_KEY,
        observed.comparison,
        { operation: "delete", action: "keep" },
      );
      if (checked.status === "conflict") {
        continue;
      }
      const head = parseReefAuditHead(observed.value);
      if (head.seq === 0) {
        return [];
      }
      const records = new Map(rows.map((row) => [row.key, row.value]));
      const reversed: AuditEntry[] = [];
      let hash = head.hash;
      for (let seq = head.seq; seq > 0 && reversed.length < this.#maxEntries; seq--) {
        const record = records.get(reefAuditEntryKey(hash));
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
      return structuredClone(verifyReefAuditWindow(reversed, head, this.#maxEntries));
    }
  }
}

export async function openReefAuditStore(
  runtime: PluginRuntime,
  auditKey: Uint8Array,
  maxEntries?: number,
): Promise<AuditStore> {
  const migration = runtime.state.openKeyedStoreV2<{ pending: true }>({
    namespace: REEF_AUDIT_MIGRATION_NAMESPACE,
    maxEntries: REEF_AUDIT_MIGRATION_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  if (await migration.lookup(REEF_AUDIT_MIGRATION_KEY)) {
    throw new Error(
      "Reef audit migration is incomplete; repair audit.jsonl and rerun openclaw doctor --fix",
    );
  }
  return new ReefSqliteAuditStore(runtime, auditKey, randomBytes, maxEntries);
}
