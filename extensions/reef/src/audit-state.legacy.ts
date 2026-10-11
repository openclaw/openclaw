import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "@noble/hashes/utils.js";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
// Import from the defining module, not the protocol barrel: index.js re-exports
// guard-adapters, whose provider-http graph doctor enumeration must not cold-load.
import { createAuditEntry, type AuditEntry, type AuditStore } from "../protocol/audit.js";
import {
  REEF_AUDIT_NAMESPACE,
  REEF_AUDIT_HEAD_NAMESPACE,
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_MAX_ENTRIES,
  REEF_AUDIT_HEAD_MAX_ENTRIES,
  REEF_AUDIT_MIGRATION_NAMESPACE,
  REEF_AUDIT_MIGRATION_KEY,
  REEF_AUDIT_MIGRATION_MAX_ENTRIES,
  REEF_AUDIT_APPEND_RETRY_MS,
  REEF_AUDIT_APPEND_ATTEMPTS,
  parseReefAuditHead,
  parseAuditEntryRecord,
  parseAuditStateRecord,
  reefAuditEntryKey,
  verifyReefAuditWindow,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
} from "./audit-state-format.js";

const REEF_AUDIT_APPEND_LEASE_MS = 30_000;

// Released older hosts lack atomic worker batches. Keep their original owner
// until the approved minimum host version supplies that capability.
export class ReefLegacySqliteAuditStore implements AuditStore {
  readonly #auditKey: Uint8Array;
  readonly #rng: (length: number) => Uint8Array;
  readonly #maxEntries: number;
  readonly #store: PluginStateSyncKeyedStore<ReefAuditStateRecord>;
  readonly #headStore: PluginStateSyncKeyedStore<ReefAuditHeadRecord>;

  constructor(
    runtime: PluginRuntime,
    auditKey: Uint8Array,
    rng: (length: number) => Uint8Array = randomBytes,
    maxEntries = REEF_AUDIT_MAX_ENTRIES,
    private readonly authoritySignal?: AbortSignal,
  ) {
    this.authoritySignal?.throwIfAborted();
    if (auditKey.length !== 32) {
      throw new Error("audit key must be 32 bytes");
    }
    this.#auditKey = auditKey.slice();
    this.#rng = rng;
    this.#maxEntries = maxEntries;
    const migration = runtime.state.openSyncKeyedStore<{ pending: true }>({
      namespace: REEF_AUDIT_MIGRATION_NAMESPACE,
      maxEntries: REEF_AUDIT_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    if (migration.lookup(REEF_AUDIT_MIGRATION_KEY)) {
      throw new Error(
        "Reef audit migration is incomplete; repair audit.jsonl and rerun openclaw doctor --fix",
      );
    }
    this.#store = runtime.state.openSyncKeyedStore<ReefAuditStateRecord>({
      namespace: REEF_AUDIT_NAMESPACE,
      maxEntries: maxEntries + 1,
      overflowPolicy: "reject-new",
    });
    this.#headStore = runtime.state.openSyncKeyedStore<ReefAuditHeadRecord>({
      namespace: REEF_AUDIT_HEAD_NAMESPACE,
      maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
  }

  async appendEvent(
    type: string,
    payload: unknown,
    ts = Math.floor(Date.now() / 1000),
  ): Promise<AuditEntry> {
    const update = this.#headStore.update;
    const updateEntry = this.#store.update;
    if (!update || !updateEntry) {
      throw new Error("Reef audit state requires atomic plugin-state updates");
    }
    const owner = randomUUID();
    for (let attempt = 0; attempt < REEF_AUDIT_APPEND_ATTEMPTS; attempt++) {
      this.authoritySignal?.throwIfAborted();
      let acquired = false;
      let staleEntryKey: string | undefined;
      let head: ReefAuditHeadRecord = { kind: "head", hash: "", seq: 0, oldestHash: "" };
      update(REEF_AUDIT_HEAD_KEY, (current) => {
        const latest = parseReefAuditHead(current);
        if (latest.pending && latest.pending.expiresAt > Date.now()) {
          return latest;
        }
        acquired = true;
        staleEntryKey = latest.pending?.entryKey;
        head = {
          kind: "head",
          hash: latest.hash,
          seq: latest.seq,
          oldestHash: latest.oldestHash,
          ...(latest.garbageEntryKey ? { garbageEntryKey: latest.garbageEntryKey } : {}),
        };
        return {
          ...head,
          pending: {
            owner,
            expiresAt: Date.now() + REEF_AUDIT_APPEND_LEASE_MS,
            ...(staleEntryKey ? { entryKey: staleEntryKey } : {}),
          },
        };
      });
      if (!acquired) {
        await sleep(REEF_AUDIT_APPEND_RETRY_MS);
        this.authoritySignal?.throwIfAborted();
        continue;
      }

      let entryKey: string | undefined;
      let entryHash: string | undefined;
      let inserted = false;
      let staleCleanupComplete = !staleEntryKey;
      try {
        this.authoritySignal?.throwIfAborted();
        if (staleEntryKey) {
          if (!staleEntryKey.startsWith("entry:") || staleEntryKey.length === "entry:".length) {
            throw new Error("invalid Reef audit staged entry key");
          }
          const staleEntryHash = staleEntryKey.slice("entry:".length);
          if (head.hash) {
            updateEntry(reefAuditEntryKey(head.hash), (current) => {
              const previous = parseAuditStateRecord(current);
              if (previous.nextHash !== staleEntryHash) {
                return previous;
              }
              const { nextHash: _nextHash, ...unlinked } = previous;
              return unlinked;
            });
          }
          this.#store.delete(staleEntryKey);
          update(REEF_AUDIT_HEAD_KEY, (current) => {
            const latest = parseReefAuditHead(current);
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
          this.#store.delete(head.garbageEntryKey);
          update(REEF_AUDIT_HEAD_KEY, (current) => {
            const latest = parseReefAuditHead(current);
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
        this.authoritySignal?.throwIfAborted();
        entryHash = entry.entryHash;
        entryKey = reefAuditEntryKey(entry.entryHash);
        let staged = false;
        update(REEF_AUDIT_HEAD_KEY, (current) => {
          const latest = parseReefAuditHead(current);
          if (
            latest.hash !== head.hash ||
            latest.seq !== head.seq ||
            latest.pending?.owner !== owner
          ) {
            return latest;
          }
          staged = true;
          return { ...latest, pending: { ...latest.pending, entryKey } };
        });
        if (!staged) {
          throw new Error("Reef audit append lease was lost before staging");
        }
        inserted = this.#store.registerIfAbsent(entryKey, { kind: "entry", entry });
        if (!inserted) {
          throw new Error("Reef audit entry already exists before head advancement");
        }
        if (head.hash) {
          updateEntry(reefAuditEntryKey(head.hash), (current) => {
            const previous = parseAuditStateRecord(current);
            if (previous.entry.entryHash !== head.hash) {
              throw new Error("Reef audit head entry differs before linking append");
            }
            const latestHead = parseReefAuditHead(this.#headStore.lookup(REEF_AUDIT_HEAD_KEY));
            if (latestHead.pending?.owner !== owner) {
              throw new Error("Reef audit append lease was lost before linking");
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
            this.#store.lookup(reefAuditEntryKey(head.oldestHash)),
          );
          if (!oldest.nextHash) {
            throw new Error("Reef audit retention pointer is missing");
          }
          oldestHash = oldest.nextHash;
          garbageEntryKey = reefAuditEntryKey(head.oldestHash);
        }
        let advanced = false;
        update(REEF_AUDIT_HEAD_KEY, (current) => {
          const latest = parseReefAuditHead(current);
          if (
            latest.hash !== head.hash ||
            latest.seq !== head.seq ||
            latest.pending?.owner !== owner ||
            latest.pending.entryKey !== entryKey
          ) {
            return latest;
          }
          advanced = true;
          return {
            kind: "head",
            hash: entry.entryHash,
            seq: entry.event.seq,
            oldestHash,
            ...(garbageEntryKey ? { garbageEntryKey } : {}),
          };
        });
        if (!advanced) {
          throw new Error("Reef audit append lease was lost before commit");
        }
        if (garbageEntryKey) {
          try {
            this.#store.delete(garbageEntryKey);
            update(REEF_AUDIT_HEAD_KEY, (current) => {
              const latest = parseReefAuditHead(current);
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
        // Revocation cannot strand a claimed append; its owner still settles staged state.
        const latestHead = parseReefAuditHead(this.#headStore.lookup(REEF_AUDIT_HEAD_KEY));
        const entryOwnedElsewhere =
          entryKey !== undefined &&
          ((latestHead.hash === entryHash && latestHead.seq === head.seq + 1) ||
            (latestHead.pending?.owner !== owner && latestHead.pending?.entryKey === entryKey));
        if (inserted && entryKey && !entryOwnedElsewhere) {
          this.#store.delete(entryKey);
        }
        if (entryKey && head.hash && !entryOwnedElsewhere) {
          updateEntry(reefAuditEntryKey(head.hash), (current) => {
            const previous = parseAuditStateRecord(current);
            if (previous.nextHash !== entryHash) {
              return previous;
            }
            const { nextHash: _nextHash, ...unlinked } = previous;
            return unlinked;
          });
        }
        update(REEF_AUDIT_HEAD_KEY, (current) => {
          const latest = parseReefAuditHead(current);
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
    this.authoritySignal?.throwIfAborted();
    const head = parseReefAuditHead(this.#headStore.lookup(REEF_AUDIT_HEAD_KEY));
    if (head.seq === 0) {
      return [];
    }
    const reversed: AuditEntry[] = [];
    let hash = head.hash;
    for (let seq = head.seq; seq > 0 && reversed.length < this.#maxEntries; seq--) {
      const record = this.#store.lookup(reefAuditEntryKey(hash));
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
