import fs from "node:fs/promises";
import path from "node:path";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
  type PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
// Import from defining modules, not the protocol barrel: index.js re-exports
// guard-adapters, whose provider-http graph doctor enumeration must not cold-load.
import { verifyChain, type AuditEntry } from "../protocol/audit.js";
import { parseVerdict } from "../protocol/guard.js";
import type { ReviewRequest } from "../protocol/pipeline.js";
import type { SignedReceipt } from "../protocol/receipts.js";
import {
  collectLegacyReefStateBackupResources,
  legacyReefFileExists,
  listLegacyReefFiles,
  REEF_DURABLE_LEGACY_FILENAMES,
  resolveLegacyReefStateDir,
} from "./doctor-state-paths.js";
import {
  REEF_REPLAY_MAX_ENTRIES,
  REEF_REPLAY_NAMESPACE,
  REEF_REPLAY_TTL_MS,
  reefReplayStoreKey,
  type ReefReplayRecord,
} from "./replay-store.js";
import {
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_HEAD_MAX_ENTRIES,
  REEF_AUDIT_HEAD_NAMESPACE,
  REEF_AUDIT_MAX_ENTRIES,
  REEF_AUDIT_MIGRATION_KEY,
  REEF_AUDIT_MIGRATION_MAX_ENTRIES,
  REEF_AUDIT_MIGRATION_NAMESPACE,
  REEF_AUDIT_NAMESPACE,
  REEF_AUDIT_STORE_MAX_ENTRIES,
  REEF_DELIVERED_MAX_ENTRIES,
  REEF_DELIVERED_NAMESPACE,
  REEF_DELIVERED_TTL_MS,
  REEF_DURABLE_MIGRATION_KEY,
  REEF_DURABLE_MIGRATION_MAX_ENTRIES,
  REEF_DURABLE_MIGRATION_NAMESPACE,
  REEF_REVIEWS_MAX_ENTRIES,
  REEF_REVIEWS_NAMESPACE,
  parseReefAuditHead,
  reefAuditEntryKey,
  verifyReefAuditWindow,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
  type ReefReviewRecord,
  type ReefDurableMigrationRecord,
  type ReefIdentityMigrationRecord,
  REEF_KEYS_MIGRATION_KEY,
  REEF_KEYS_MIGRATION_MAX_ENTRIES,
  REEF_KEYS_MIGRATION_NAMESPACE,
} from "./state.js";

const REEF_RUNTIME_LEGACY_FILENAMES = ["replay.jsonl", "reviews.json", "delivered.json"];

type ReefAuditMigrationRecord = { pending: true; expectedEntries?: number };

export function openReefIdentityMigrationStore(context: PluginDoctorStateMigrationContext) {
  return context.openPluginStateKeyedStore<ReefIdentityMigrationRecord>({
    namespace: REEF_KEYS_MIGRATION_NAMESPACE,
    maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

export function openReefDurableMigrationStore(context: PluginDoctorStateMigrationContext) {
  return context.openPluginStateKeyedStore<ReefDurableMigrationRecord>({
    namespace: REEF_DURABLE_MIGRATION_NAMESPACE,
    maxEntries: REEF_DURABLE_MIGRATION_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

function openReefAuditMigrationStore(context: PluginDoctorStateMigrationContext) {
  return context.openPluginStateKeyedStore<ReefAuditMigrationRecord>({
    namespace: REEF_AUDIT_MIGRATION_NAMESPACE,
    maxEntries: REEF_AUDIT_MIGRATION_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

async function readLegacyReefAudit(filePath: string): Promise<AuditEntry[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const entries = raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
  if (!verifyChain(entries)) {
    throw new Error("invalid Reef audit chain");
  }
  return entries;
}

async function readStoredReefAudit(
  store: PluginStateKeyedStore<ReefAuditStateRecord>,
  headStore: PluginStateKeyedStore<ReefAuditHeadRecord>,
): Promise<AuditEntry[]> {
  const headValue = await headStore.lookup(REEF_AUDIT_HEAD_KEY);
  if (!headValue) {
    return [];
  }
  const head = parseReefAuditHead(headValue);
  const reversed: AuditEntry[] = [];
  let hash = head.hash;
  for (let seq = head.seq; seq > 0 && reversed.length < REEF_AUDIT_MAX_ENTRIES; seq--) {
    const record = await store.lookup(reefAuditEntryKey(hash));
    if (!record) {
      break;
    }
    if (record.entry.entryHash !== hash || record.entry.event.seq !== seq) {
      throw new Error("invalid Reef audit chain state");
    }
    reversed.push(record.entry);
    hash = record.entry.prevHash;
  }
  return verifyReefAuditWindow(reversed, head, REEF_AUDIT_MAX_ENTRIES);
}

type LegacyReefReplayLogRecord =
  | { op: "claim"; peer: string; id: string; envelopeHash: string }
  | { op: "complete"; peer: string; id: string; receipt: SignedReceipt; body?: { enc: string } }
  | { op: "consume" | "release"; peer: string; id: string };

function requireLegacyReplayString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid Reef replay ${field}`);
  }
  return value;
}

function parseLegacySignedReceipt(value: Record<string, unknown>): SignedReceipt {
  const id = requireLegacyReplayString(value, "id");
  const bodyHash = requireLegacyReplayString(value, "bodyHash");
  const auditHead = requireLegacyReplayString(value, "auditHead");
  const signature = requireLegacyReplayString(value, "signature");
  if (value.status !== "accepted" && value.status !== "rejected") {
    throw new Error("invalid Reef replay receipt status");
  }
  if (value.category !== undefined && typeof value.category !== "string") {
    throw new Error("invalid Reef replay receipt category");
  }
  return {
    id,
    bodyHash,
    auditHead,
    status: value.status,
    signature,
    ...(value.category !== undefined ? { category: value.category } : {}),
  };
}

function parseLegacyReviewRequest(value: Record<string, unknown>): ReviewRequest {
  const direction = value.direction;
  if (direction !== "inbound" && direction !== "outbound") {
    throw new Error("invalid Reef review direction");
  }
  return {
    id: requireLegacyReplayString(value, "id"),
    from: requireLegacyReplayString(value, "from"),
    to: requireLegacyReplayString(value, "to"),
    direction,
    bodyHash: requireLegacyReplayString(value, "bodyHash"),
    approvalDigest: requireLegacyReplayString(value, "approvalDigest"),
    verdict: parseVerdict(value.verdict),
  };
}

function parseLegacyReefReplayLine(value: unknown): LegacyReefReplayLogRecord {
  if (!isRecord(value)) {
    throw new Error("invalid Reef replay record");
  }
  const peer = requireLegacyReplayString(value, "peer");
  const id = requireLegacyReplayString(value, "id");
  if (value.op === "claim") {
    return {
      op: "claim",
      peer,
      id,
      envelopeHash: requireLegacyReplayString(value, "envelopeHash"),
    };
  }
  if (value.op === "consume" || value.op === "release") {
    return { op: value.op, peer, id };
  }
  if (value.op !== "complete" || !isRecord(value.receipt)) {
    throw new Error("invalid Reef replay operation");
  }
  const receipt = parseLegacySignedReceipt(value.receipt);
  if (receipt.id !== id) {
    throw new Error("invalid Reef replay receipt");
  }
  const body = value.body;
  if (
    (receipt.status === "accepted" && (!isRecord(body) || typeof body.enc !== "string")) ||
    (receipt.status === "rejected" && body !== undefined)
  ) {
    throw new Error("invalid Reef replay completion");
  }
  return {
    op: "complete",
    peer,
    id,
    receipt,
    ...(isRecord(body) && typeof body.enc === "string" ? { body: { enc: body.enc } } : {}),
  };
}

async function readLegacyReefReplay(filePath: string): Promise<ReefReplayRecord[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const records = new Map<string, ReefReplayRecord>();
  for (const [index, line] of lines.entries()) {
    let log: LegacyReefReplayLogRecord;
    try {
      log = parseLegacyReefReplayLine(JSON.parse(line) as unknown);
    } catch (error) {
      // The old append-only store tolerated only a torn final write.
      if (index === lines.length - 1 && !raw.endsWith("\n")) {
        break;
      }
      throw error;
    }
    const key = reefReplayStoreKey(log.peer, log.id);
    const existing = records.get(key);
    let next: ReefReplayRecord;
    if (log.op === "claim") {
      if (existing && existing.envelopeHash !== log.envelopeHash) {
        throw new Error("conflicting Reef replay binding");
      }
      next = {
        peer: log.peer,
        id: log.id,
        envelopeHash: log.envelopeHash,
        state: "available",
      };
    } else {
      if (!existing) {
        throw new Error(`Reef replay ${log.op} lacks claim`);
      }
      if (log.op === "complete") {
        next = {
          ...existing,
          state: "completed",
          receipt: log.receipt,
          ...(log.body ? { body: log.body } : {}),
        };
      } else if (log.op === "consume") {
        next = {
          peer: existing.peer,
          id: existing.id,
          envelopeHash: existing.envelopeHash,
          state: "consumed",
        };
      } else {
        next = { ...existing, state: "available" };
      }
    }
    records.delete(key);
    records.set(key, next);
  }
  return [...records.values()];
}

async function readLegacyReefReviews(filePath: string): Promise<Map<string, ReefReviewRecord>> {
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!isRecord(value)) {
    throw new Error("invalid Reef reviews file");
  }
  const records = new Map<string, ReefReviewRecord>();
  for (const [digest, raw] of Object.entries(value)) {
    if (!isRecord(raw) || !isRecord(raw.review)) {
      throw new Error(`invalid Reef review ${digest}`);
    }
    const review = parseLegacyReviewRequest(raw.review);
    if (
      review.approvalDigest !== digest ||
      (raw.approved !== undefined && typeof raw.approved !== "boolean")
    ) {
      throw new Error(`invalid Reef review ${digest}`);
    }
    records.set(digest, {
      review,
      ...(typeof raw.approved === "boolean" ? { approved: raw.approved } : {}),
    });
  }
  return records;
}

async function readLegacyReefDelivered(filePath: string): Promise<string[]> {
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("invalid Reef delivered file");
  }
  return [...new Set(value)];
}

async function importReefRuntimeRecords<T>(params: {
  store: PluginStateKeyedStore<T>;
  records: Array<{ key: string; value: T }>;
  maxEntries: number;
  recordLabel: string;
  capacityLabel: string;
  matches: (existing: T | undefined, expected: T) => boolean;
  persistedMismatch: (key: string) => string;
}): Promise<void> {
  const { store, records } = params;
  const canonicalEntries = await store.entries();
  const canonical = new Map(canonicalEntries.map((entry) => [entry.key, entry.value]));
  for (const { key, value } of records) {
    const existing = canonical.get(key);
    if (existing && !params.matches(existing, value)) {
      throw new Error(`current ${params.recordLabel} ${key} differs`);
    }
  }
  const missing = records.filter(({ key }) => !canonical.has(key));
  if (canonical.size + missing.length > params.maxEntries) {
    throw new Error(
      `${canonical.size + missing.length} ${params.capacityLabel} exceed plugin-state capacity`,
    );
  }
  for (const { key, value } of missing) {
    await store.registerIfAbsent(key, value);
  }
  for (const entry of canonicalEntries) {
    if (JSON.stringify(await store.lookup(entry.key)) !== JSON.stringify(entry.value)) {
      throw new Error(`current ${params.recordLabel} ${entry.key} changed during import`);
    }
  }
  for (const { key, value } of missing) {
    if (!params.matches(await store.lookup(key), value)) {
      throw new Error(params.persistedMismatch(key));
    }
  }
}

export const reefAuditStateMigration: PluginDoctorStateMigration = {
  id: "reef-audit-jsonl-to-plugin-state",
  label: "Reef audit trail",
  collectBackupResources: collectLegacyReefStateBackupResources,
  async detectLegacyState(params) {
    const filePath = path.join(resolveLegacyReefStateDir(params), "audit.jsonl");
    const migrationStore = openReefAuditMigrationStore(params.context);
    const sourceExists = await legacyReefFileExists(filePath);
    const pending = await migrationStore.lookup(REEF_AUDIT_MIGRATION_KEY);
    return sourceExists || pending
      ? {
          preview: [
            sourceExists
              ? "- Reef audit trail -> plugin state (audit)"
              : "- Verify Reef audit migration marker",
          ],
        }
      : null;
  },
  async migrateLegacyState(params) {
    const changes: string[] = [];
    const warnings: string[] = [];
    const filePath = path.join(resolveLegacyReefStateDir(params), "audit.jsonl");
    const migrationStore = openReefAuditMigrationStore(params.context);
    const durableMigrationStore = openReefDurableMigrationStore(params.context);
    const store = params.context.openPluginStateKeyedStore<ReefAuditStateRecord>({
      namespace: REEF_AUDIT_NAMESPACE,
      maxEntries: REEF_AUDIT_STORE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const headStore = params.context.openPluginStateKeyedStore<ReefAuditHeadRecord>({
      namespace: REEF_AUDIT_HEAD_NAMESPACE,
      maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    if (
      (await legacyReefFileExists(filePath)) ||
      (await migrationStore.lookup(REEF_AUDIT_MIGRATION_KEY)) ||
      (await durableMigrationStore.lookup(REEF_DURABLE_MIGRATION_KEY))
    ) {
      await durableMigrationStore.register(REEF_DURABLE_MIGRATION_KEY, { pending: true });
    }
    if (!(await legacyReefFileExists(filePath))) {
      const pending = await migrationStore.lookup(REEF_AUDIT_MIGRATION_KEY);
      if (!pending) {
        return { changes, warnings };
      }
      try {
        const canonical = await readStoredReefAudit(store, headStore);
        if (
          pending.expectedEntries === undefined
            ? canonical.length === 0
            : canonical.length !== pending.expectedEntries
        ) {
          throw new Error("saved audit trail does not match the verified import");
        }
        await migrationStore.delete(REEF_AUDIT_MIGRATION_KEY);
        changes.push("Verified Reef audit trail; cleared completed migration marker");
      } catch (error) {
        warnings.push(
          `Reef audit migration is incomplete and audit.jsonl is missing: ${String(error)}; left migration blocker in place`,
        );
      }
      return { changes, warnings };
    }
    await migrationStore.register(REEF_AUDIT_MIGRATION_KEY, { pending: true });
    let legacy: AuditEntry[];
    try {
      legacy = await readLegacyReefAudit(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { changes, warnings };
      }
      warnings.push(`Failed importing Reef audit trail: ${String(error)}; left source in place`);
      return { changes, warnings };
    }
    let canonical: AuditEntry[];
    try {
      canonical = await readStoredReefAudit(store, headStore);
    } catch (error) {
      warnings.push(
        `Failed reading saved Reef audit trail: ${String(error)}; left legacy source in place`,
      );
      return { changes, warnings };
    }
    if (
      canonical.length > 0 &&
      JSON.stringify(canonical) !== JSON.stringify(legacy.slice(-canonical.length))
    ) {
      warnings.push("Kept existing Reef audit trail; left differing legacy source in place");
      return { changes, warnings };
    }
    const retained = legacy.slice(-REEF_AUDIT_MAX_ENTRIES);
    if (canonical.length === 0 && retained.length > 0) {
      try {
        for (const [index, entry] of retained.entries()) {
          const key = reefAuditEntryKey(entry.entryHash);
          const nextHash = retained[index + 1]?.entryHash;
          const record: ReefAuditStateRecord = {
            kind: "entry",
            entry,
            ...(nextHash ? { nextHash } : {}),
          };
          const existing = await store.lookup(key);
          if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
            throw new Error(`conflicting audit entry ${entry.entryHash}`);
          }
          await store.registerIfAbsent(key, record);
        }
        const last = retained.at(-1)!;
        const first = retained[0]!;
        if (
          !(await headStore.registerIfAbsent(REEF_AUDIT_HEAD_KEY, {
            kind: "head",
            hash: last.entryHash,
            seq: last.event.seq,
            oldestHash: first.entryHash,
          }))
        ) {
          throw new Error("audit head appeared during import");
        }
      } catch (error) {
        warnings.push(`Failed importing Reef audit trail: ${String(error)}; left source in place`);
        return { changes, warnings };
      }
    }
    const persisted = await readStoredReefAudit(store, headStore);
    if (JSON.stringify(persisted) !== JSON.stringify(retained)) {
      warnings.push("Failed verifying Reef audit trail after import; left source in place");
      return { changes, warnings };
    }
    changes.push(
      `Migrated ${legacy.length} Reef audit ${legacy.length === 1 ? "entry" : "entries"} -> plugin state`,
    );
    // Persist the verified cardinality before archiving. A rerun can then
    // distinguish an interrupted empty import from a missing legacy source.
    await migrationStore.register(REEF_AUDIT_MIGRATION_KEY, {
      pending: true,
      expectedEntries: persisted.length,
    });
    const warningCount = warnings.length;
    await archiveLegacyStateSource({
      filePath,
      label: "Reef audit trail",
      changes,
      warnings,
    });
    if (persisted.length < legacy.length && warnings.length === warningCount) {
      changes.push(
        `Retained the newest ${persisted.length} Reef audit entries in SQLite; preserved the complete ${legacy.length}-entry chain in the archived legacy source`,
      );
    }
    if (warnings.length === warningCount) {
      await migrationStore.delete(REEF_AUDIT_MIGRATION_KEY);
    }
    return { changes, warnings };
  },
};

export const reefRuntimeStateMigration: PluginDoctorStateMigration = {
  id: "reef-runtime-files-to-plugin-state",
  label: "Reef durable runtime state",
  collectBackupResources: collectLegacyReefStateBackupResources,
  async detectLegacyState(params) {
    const stateDir = resolveLegacyReefStateDir(params);
    const files = await listLegacyReefFiles(stateDir, REEF_RUNTIME_LEGACY_FILENAMES);
    const durableSourceExists =
      (await listLegacyReefFiles(stateDir, REEF_DURABLE_LEGACY_FILENAMES)).length > 0;
    const durableMigrationStore = openReefDurableMigrationStore(params.context);
    const durablePending = await durableMigrationStore.lookup(REEF_DURABLE_MIGRATION_KEY);
    return files.length > 0 || durableSourceExists || durablePending
      ? {
          preview: [
            files.length > 0
              ? `- Reef runtime state -> plugin state (${files.join(", ")})`
              : durableSourceExists
                ? "- Finalize Reef durable state migration barrier"
                : "- Verify Reef durable state migration barrier",
          ],
        }
      : null;
  },
  async migrateLegacyState(params) {
    const changes: string[] = [];
    const warnings: string[] = [];
    const stateDir = resolveLegacyReefStateDir(params);
    const durableMigrationStore = openReefDurableMigrationStore(params.context);
    const durablePending = await durableMigrationStore.lookup(REEF_DURABLE_MIGRATION_KEY);
    const runtimeSourceExists =
      (await listLegacyReefFiles(stateDir, REEF_RUNTIME_LEGACY_FILENAMES)).length > 0;
    if (runtimeSourceExists || durablePending) {
      await durableMigrationStore.register(REEF_DURABLE_MIGRATION_KEY, { pending: true });
    }
    const migrateFile = async (
      filename: string,
      label: string,
      importFile: (filePath: string) => Promise<void>,
    ) => {
      const filePath = path.join(stateDir, filename);
      if (!(await legacyReefFileExists(filePath))) {
        return;
      }
      try {
        await importFile(filePath);
        await archiveLegacyStateSource({ filePath, label, changes, warnings });
      } catch (error) {
        warnings.push(`Failed importing ${label}: ${String(error)}; left source in place`);
      }
    };
    await migrateFile("replay.jsonl", "Reef replay state", async (replayPath) => {
      const legacy = await readLegacyReefReplay(replayPath);
      const store = params.context.openPluginStateKeyedStore<ReefReplayRecord>({
        namespace: REEF_REPLAY_NAMESPACE,
        maxEntries: REEF_REPLAY_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        defaultTtlMs: REEF_REPLAY_TTL_MS,
      });
      await importReefRuntimeRecords({
        store,
        records: legacy.map((value) => ({
          key: reefReplayStoreKey(value.peer, value.id),
          value,
        })),
        maxEntries: REEF_REPLAY_MAX_ENTRIES,
        recordLabel: "replay state",
        capacityLabel: "replay bindings",
        matches: (existing, expected) => JSON.stringify(existing) === JSON.stringify(expected),
        persistedMismatch: () => "persisted replay state differs",
      });
      changes.push(`Migrated ${legacy.length} Reef replay bindings -> plugin state`);
    });

    await migrateFile("reviews.json", "Reef reviews", async (reviewsPath) => {
      const legacy = await readLegacyReefReviews(reviewsPath);
      const pending = [...legacy].filter(([, record]) => record.approved === undefined);
      if (pending.length > REEF_REVIEWS_MAX_ENTRIES) {
        throw new Error(`${pending.length} pending reviews exceed plugin-state capacity`);
      }
      const completed = [...legacy].filter(([, record]) => record.approved !== undefined);
      const completedCapacity = REEF_REVIEWS_MAX_ENTRIES - pending.length;
      const retainedCompleted = completedCapacity > 0 ? completed.slice(-completedCapacity) : [];
      const retainedKeys = new Set([...pending, ...retainedCompleted].map(([digest]) => digest));
      const retained = new Map([...legacy].filter(([digest]) => retainedKeys.has(digest)));
      const store = params.context.openPluginStateKeyedStore<ReefReviewRecord>({
        namespace: REEF_REVIEWS_NAMESPACE,
        maxEntries: REEF_REVIEWS_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      for (const [digest, record] of retained) {
        const existing = await store.lookup(digest);
        if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
          throw new Error(`saved review ${digest} differs`);
        }
        if (!existing) {
          await store.registerIfAbsent(digest, record);
        }
      }
      for (const [digest, record] of retained) {
        if (JSON.stringify(await store.lookup(digest)) !== JSON.stringify(record)) {
          throw new Error(`persisted review ${digest} differs`);
        }
      }
      changes.push(`Migrated ${retained.size} of ${legacy.size} Reef reviews -> plugin state`);
    });

    await migrateFile("delivered.json", "Reef delivered markers", async (deliveredPath) => {
      const legacy = await readLegacyReefDelivered(deliveredPath);
      const store = params.context.openPluginStateKeyedStore<{ id: string }>({
        namespace: REEF_DELIVERED_NAMESPACE,
        maxEntries: REEF_DELIVERED_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        defaultTtlMs: REEF_DELIVERED_TTL_MS,
      });
      await importReefRuntimeRecords({
        store,
        records: legacy.map((id) => ({ key: id, value: { id } })),
        maxEntries: REEF_DELIVERED_MAX_ENTRIES,
        recordLabel: "delivered marker",
        capacityLabel: "delivered markers",
        matches: (existing, expected) => existing?.id === expected.id,
        persistedMismatch: (id) => `persisted delivered marker ${id} differs`,
      });
      changes.push(`Migrated ${legacy.length} Reef delivered markers -> plugin state`);
    });
    const remainingSources = await listLegacyReefFiles(stateDir, REEF_DURABLE_LEGACY_FILENAMES);
    const identityMigrationStore = openReefIdentityMigrationStore(params.context);
    const auditMigrationStore = openReefAuditMigrationStore(params.context);
    if (
      remainingSources.length === 0 &&
      !(await identityMigrationStore.lookup(REEF_KEYS_MIGRATION_KEY)) &&
      !(await auditMigrationStore.lookup(REEF_AUDIT_MIGRATION_KEY))
    ) {
      if (await durableMigrationStore.delete(REEF_DURABLE_MIGRATION_KEY)) {
        changes.push("Verified all Reef durable state; cleared migration barrier");
      }
    } else if (await durableMigrationStore.lookup(REEF_DURABLE_MIGRATION_KEY)) {
      warnings.push(
        `Reef durable state migration is incomplete; left migration blocker in place${remainingSources.length > 0 ? ` (${remainingSources.join(", ")})` : ""}`,
      );
    }
    return { changes, warnings };
  },
};
