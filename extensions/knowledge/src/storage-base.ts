import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
  sqliteStringSet,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { Check } from "typebox/value";
import type { VaultAccess } from "./access.js";
import { annotationEvidence } from "./annotations.js";
import { EvidenceInspector, settledStamp } from "./evidence-files.js";
import { GitHistory, GitUnavailable, type GitBatch, type GitChange } from "./git-history.js";
import { SqliteIdentityStore } from "./identity-store.js";
import type { SourceIdentity } from "./ingestion-contract.js";
import { applyLifecycleGuards } from "./lifecycle.js";
import type { LoadedRecord } from "./model.js";
import type { Receipt } from "./mutation-contract.js";
import { PublicationFiles } from "./publication-files.js";
import { RealVault, type StoreConfig } from "./real-vault.js";
import { observeWithdrawals } from "./retrieval.js";
import { readSourceDescriptor, recordSourceDependencies } from "./source-records.js";
import type { StorageTables } from "./storage-tables.js";
import { canonical, scopeKey, blocked, type Row, type PublicationHook } from "./storage-types.js";
import { Manifest, checkpointKey } from "./store-manifest.js";
import type { SampleVault } from "./vault.js";
import { digest } from "./vault.js";
/** Storage state, identity fencing, Git checkpointing and external-change observation shared by every storage layer. */
export class StorageBase {
  protected readonly real: RealVault;
  // Content hash per authored file, valid while its stamp is unchanged, so Git
  // observation re-reads only files that changed since the last scan.
  private readonly observedHashes = new Map<string, { stamp: string; hash: string }>();
  // Source descriptors each record depends on, valid while the record keeps its
  // hash and every descriptor keeps the settled stamp this scan observed.
  private readonly observedSources = new Map<
    string,
    { hash: string; sources: [path: string, stamp: string, hash: string][] }
  >();
  private readonly git: GitHistory;
  constructor(
    readonly config: StoreConfig,
    protected readonly store = new SqliteIdentityStore(config.statePath),
    protected readonly hook: PublicationHook = () => {},
    git?: GitHistory,
  ) {
    this.git = git ?? new GitHistory(config.root);
    this.real = new RealVault(config, store, (records, access, evidence, manifest) =>
      this.observe(records, access, evidence, manifest),
    );
  }
  async run<T>(access: VaultAccess, operation: (vault: SampleVault) => Promise<T>): Promise<T> {
    access.assertCurrent();
    this.assertReadable();
    return this.real.run(access, operation, true);
  }
  protected retrievalBinding(access: VaultAccess) {
    return `${this.config.vaultId}:${scopeKey(access.scope)}`;
  }
  async initialize(access: VaultAccess) {
    access.assertCurrent();
    if (!(await this.store.lookup(checkpointKey(this.config.vaultId)))) {
      await this.real.run(access, async () => undefined);
    }
  }
  protected identity(
    db: DatabaseSync,
    files: PublicationFiles,
    allowed?: Manifest,
    fallback?: string | null,
  ) {
    const manifest = JSON.parse(files.read("vault.json") ?? fallback ?? "null");
    const checkpoint = db
      .prepare("SELECT manifest FROM identities WHERE agent_key=?")
      .get(checkpointKey(this.config.vaultId));
    if (
      !Check(Manifest, manifest) ||
      manifest.vaultId !== this.config.vaultId ||
      !checkpoint ||
      (canonical(manifest) !== canonical(JSON.parse(String(checkpoint.manifest))) &&
        canonical(manifest) !== canonical(allowed))
    ) {
      throw new Error("Knowledge vault identity mismatch; recovery review required.");
    }
    return manifest;
  }
  protected assertCheckpoint(db: DatabaseSync, expected: Manifest) {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<StorageTables>(db)
        .selectFrom("identities")
        .select("manifest")
        .where("agent_key", "=", checkpointKey(this.config.vaultId)),
    );
    if (!row || canonical(JSON.parse(row.manifest)) !== canonical(expected)) {
      throw new Error("Stale publisher identity");
    }
  }
  assertReadable() {
    this.store.withDatabase((db) => {
      if (db.prepare("SELECT 1 FROM mutations WHERE state!='published' LIMIT 1").get()) {
        throw blocked();
      }
    });
  }
  protected row(db: DatabaseSync, scope: string, request: string): Row | undefined {
    // SAFETY: mutation rows are written only by this storage layer, with Receipt states.
    return db.prepare("SELECT * FROM mutations WHERE scope=? AND request=?").get(scope, request) as
      | Row
      | undefined;
  }
  protected checkReplay(row: Row, intent: string) {
    if (row.intent !== intent) {
      throw new Error(
        "Request ID already belongs to a different payload. Use the original payload for retries.",
      );
    }
  }
  protected sourceRow(db: DatabaseSync, scope: string, source: SourceIdentity): Row | undefined {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<StorageTables>(db)
        .selectFrom("mutations")
        .select(["scope", "request", "intent", "state", "plan", "receipt"])
        .where("scope", "=", scope)
        .where(
          (eb) =>
            eb.fn<string | null>("json_extract", [eb.ref("plan"), eb.val("$.source.provider")]),
          "=",
          source.provider,
        )
        .where(
          (eb) => eb.fn<string | null>("json_extract", [eb.ref("plan"), eb.val("$.source.key")]),
          "=",
          source.key,
        )
        .orderBy("rowid", "desc")
        .limit(1),
    );
    // SAFETY: mutation rows are written only with Receipt states by this storage layer.
    return row as Row | undefined;
  }
  protected publicationToken(scope: string, request: string) {
    return digest(`${this.config.vaultId}:${scope}:${request}`);
  }
  protected enqueueGit(
    db: DatabaseSync,
    scope: string,
    changes: GitChange[],
    actor: string,
    token = digest(randomUUID()),
  ) {
    if (!changes.length || !this.config.writesEnabled) {
      return;
    }
    const batch: GitBatch = { token, changes, actor, at: new Date().toISOString() };
    const kysely = getNodeSqliteKysely<StorageTables>(db);
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("git_jobs")
        .values({
          scope,
          token,
          batch: JSON.stringify(batch),
          state: "pending",
          message: "Local Git checkpoint pending.",
        })
        .onConflict((oc) => oc.doNothing()),
    );
    for (const c of changes) {
      if (c.raw === null && !c.fileHash) {
        executeSqliteQuerySync(
          db,
          kysely.deleteFrom("git_files").where("scope", "=", scope).where("path", "=", c.path),
        );
      } else {
        const hash = c.fileHash ?? digest(c.raw!);
        executeSqliteQuerySync(
          db,
          kysely
            .insertInto("git_files")
            .values({ scope, path: c.path, hash })
            .onConflict((oc) => oc.columns(["scope", "path"]).doUpdateSet({ hash })),
        );
      }
    }
  }
  protected gitStatus(db: DatabaseSync, scope: string) {
    const waiting = db
      .prepare(
        "SELECT state,message FROM git_jobs WHERE scope=? AND state!='committed' ORDER BY sequence LIMIT 1",
      )
      .get(scope);
    const last = db
      .prepare(
        "SELECT state,message,commit_id FROM git_jobs WHERE scope=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(scope);
    const pending = Number(
      db
        .prepare("SELECT count(*) AS n FROM git_jobs WHERE scope=? AND state!='committed'")
        .get(scope)!.n,
    );
    // SAFETY: git_jobs rows waiting for a checkpoint are only pending or unavailable.
    const waitingState = waiting && (String(waiting.state) as "pending" | "unavailable");
    return {
      state: !this.config.writesEnabled
        ? ("read-only" as const)
        : waitingState
          ? waitingState
          : last
            ? ("committed" as const)
            : ("idle" as const),
      pending,
      message: String(
        waiting?.message ??
          last?.message ??
          (this.config.writesEnabled
            ? "Git will be used automatically when content is observed or published."
            : "Read-only vault; no Git changes."),
      ),
    };
  }
  protected flushGit(access: VaultAccess) {
    if (!this.config.writesEnabled) {
      return;
    }
    access.assertCurrent();
    this.store.withDatabase((db) => {
      this.identity(db, new PublicationFiles(this.config.root));
      const scope = scopeKey(access.scope);
      // The storage worker serializes operations. Keep the outbox ordered, but
      // load only one exact snapshot at a time and never hold a SQL lock for Git.
      const pending = db
        .prepare(
          "SELECT sequence FROM git_jobs WHERE scope=? AND state!='committed' ORDER BY sequence",
        )
        .all(scope);
      if (!pending.length) {
        return;
      }
      // This synchronous drain cannot accept another publication. Derive the
      // receipt lookup once, without loading the large retained plans.
      const requests = new Map(
        db
          .prepare("SELECT request FROM mutations WHERE scope=? AND state='published'")
          .all(scope)
          .map((row) => [this.publicationToken(scope, String(row.request)), row.request!]),
      );
      const jobAt = db.prepare("SELECT token,batch,state FROM git_jobs WHERE sequence=?");
      const updateJob = db.prepare(
        "UPDATE git_jobs SET state=?,commit_id=?,message=? WHERE sequence=? AND state!='committed'",
      );
      const receiptAt = db.prepare("SELECT receipt FROM mutations WHERE scope=? AND request=?");
      const updateReceipt = db.prepare(
        "UPDATE mutations SET receipt=? WHERE scope=? AND request=?",
      );
      for (const { sequence } of pending) {
        const job = jobAt.get(sequence!)!;
        if (job.state === "committed") {
          continue;
        }
        access.assertCurrent();
        let result: NonNullable<Receipt["git"]>;
        try {
          const commit = this.git.checkpoint(JSON.parse(String(job.batch)), this.hook);
          result = { state: "committed", commit, message: "Local Git history recorded." };
        } catch (e) {
          result = {
            state: e instanceof GitUnavailable ? "unavailable" : "pending",
            // SAFETY: Git checkpoint failures are Error instances.
            message: (e as Error).message.slice(0, 500),
          };
        }
        const request = requests.get(String(job.token));
        access.assertCurrent();
        // The checkpoint ref makes retries idempotent if this acknowledgement fails.
        runSqliteImmediateTransactionSync(
          db,
          () => {
            if (
              !updateJob.run(result.state, result.commit ?? null, result.message, sequence!).changes
            ) {
              return;
            }
            if (request !== undefined) {
              const receipt: Receipt = JSON.parse(String(receiptAt.get(scope, request)!.receipt));
              receipt.git = result;
              updateReceipt.run(JSON.stringify(receipt), scope, request);
            }
          },
          { operationLabel: "knowledge.git.settle" },
        );
        if (result.state !== "committed") {
          break;
        }
      }
    });
  }
  protected recordObservation(
    db: DatabaseSync,
    scope: string,
    r: LoadedRecord,
    provenance: string,
    agentId?: string,
  ) {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<StorageTables>(db)
        .insertInto("history")
        .values({
          scope,
          id: r.id,
          provenance,
          at: new Date().toISOString(),
          path: r.path,
          revision: r.revision,
          hash: r.hash,
          raw: r.raw,
          agent_id: agentId ?? null,
        }),
    );
    const observed = { path: r.path, hash: r.hash, revision: r.revision, raw: r.raw };
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<StorageTables>(db)
        .insertInto("observations")
        .values({ scope, id: r.id, ...observed })
        .onConflict((oc) => oc.columns(["scope", "id"]).doUpdateSet(observed)),
    );
  }
  /** Content hashes of the source descriptors one record cites. Reuses the last
   * result while the record is unchanged and the scan saw each descriptor with
   * the same settled stamp; descriptor bytes are then the bytes hashed before. */
  private sourceDependencies(
    r: LoadedRecord,
    key: string,
    evidence: EvidenceInspector,
  ): [string, string, string][] {
    const relative = `${key}/${r.path}`,
      known = this.observedSources.get(relative);
    if (
      known?.hash === r.hash &&
      known.sources.every(([p, stamp]) => evidence.stamps.get(p) === stamp && settledStamp(stamp))
    ) {
      return known.sources;
    }
    const sources = Object.entries(
      recordSourceDependencies(r, (p) => readSourceDescriptor(path.join(this.config.root, key), p)),
    ).map(([p, raw]): [string, string, string] => [p, evidence.stamps.get(p) ?? "", digest(raw)]);
    if (sources.every(([, stamp]) => settledStamp(stamp))) {
      this.observedSources.set(relative, { hash: r.hash, sources });
    } else {
      this.observedSources.delete(relative);
    }
    return sources;
  }
  private observe(
    records: LoadedRecord[],
    access: VaultAccess,
    evidence: EvidenceInspector,
    manifest: Manifest,
  ) {
    const scope = access.scope;
    access.assertCurrent();
    this.store.withDatabase((db) => {
      const before = this.identity(db, new PublicationFiles(this.config.root));
      // A scan can see a publisher's displaced file before observation starts.
      // Reject that stale scan before it records a false deletion.
      if (canonical(before) !== canonical(manifest)) {
        throw new Error("Knowledge vault identity changed during scan; retry the read.");
      }
      if (db.prepare("SELECT 1 FROM mutations WHERE state!='published' LIMIT 1").get()) {
        throw blocked();
      }
      const key = scopeKey(scope);
      let changes: GitChange[] = [];
      if (this.config.writesEnabled) {
        const files = new PublicationFiles(this.config.root);
        const snapshot = files.snapshot(key, true);
        // Content hashes per file, re-read only when its stamp changed.
        const current = new Map<string, string>();
        const originals = new Map<string, string>();
        // SAFETY: the snapshot is the JSON [path, stamp] list this class serialized.
        for (const [relative, stamp] of JSON.parse(snapshot) as [string, string][]) {
          if (stamp === "directory") {
            continue;
          }
          const known = this.observedHashes.get(relative);
          if (known?.stamp === stamp) {
            current.set(relative, known.hash);
            continue;
          }
          const raw = files.read(relative);
          if (raw === null) {
            throw new Error("Vault changed during Git observation.");
          }
          const hash = digest(raw);
          if (settledStamp(stamp)) {
            this.observedHashes.set(relative, { stamp, hash });
          } else {
            this.observedHashes.delete(relative);
          }
          current.set(relative, hash);
        }
        for (const relative of this.observedHashes.keys()) {
          if (relative.startsWith(`${key}/`) && !current.has(relative)) {
            this.observedHashes.delete(relative);
          }
        }
        const present = new Set(records.map((r) => `${key}/${r.path}`));
        for (const relative of this.observedSources.keys()) {
          if (relative.startsWith(`${key}/`) && !present.has(relative)) {
            this.observedSources.delete(relative);
          }
        }
        for (const r of records) {
          if (current.get(`${key}/${r.path}`) !== r.hash) {
            throw new Error("Vault changed during Git observation.");
          }
          for (const [p, , hash] of this.sourceDependencies(r, key, evidence)) {
            current.set(`${key}/${p}`, hash);
          }
          for (const file of [...(r.metadata.evidence ?? []), ...annotationEvidence(r.metadata)]) {
            if (!file.path.startsWith("artifacts/")) {
              continue;
            }
            const relative = `${key}/${file.path}`;
            try {
              const checked = evidence.inspect(file);
              // Match gbrain's Git sidecar routing threshold; media/large originals
              // remain in the local vault, outside automatic Git snapshots.
              const media =
                /^(image|audio|video)\//.test(file.mediaType ?? "") ||
                /\.(png|jpe?g|gif|webp|mp[34]|mov|wav|ogg|flac)$/i.test(file.filename ?? file.path);
              if (!media && checked.size < 100 * 1024 * 1024) {
                originals.set(relative, file.sha256);
              }
            } catch {
              /* Validation already reports unsafe/missing evidence. */
            }
          }
        }
        const prior = new Map(
          db
            .prepare("SELECT path,hash FROM git_files WHERE scope=?")
            .all(key)
            .map((r) => [String(r.path), String(r.hash)]),
        );
        changes = [...current]
          .filter(([p, hash]) => prior.get(p) !== hash)
          .map(([file, hash]) => {
            const raw = files.read(file);
            if (raw === null || digest(raw) !== hash) {
              throw new Error("Vault changed during Git observation.");
            }
            return { path: file, raw };
          });
        for (const [file, fileHash] of originals) {
          if (prior.get(file) !== fileHash) {
            changes.push({ path: file, raw: null, fileHash });
          }
        }
        // Artifacts are retained originals; absent references are not deletions.
        for (const p of prior.keys()) {
          if (!current.has(p) && !p.startsWith(`${key}/artifacts/`)) {
            changes.push({ path: p, raw: null });
          }
        }
        if (files.snapshot(key, true) !== snapshot) {
          throw new Error("Vault changed during Git observation.");
        }
      }
      // Count IDs once: records with a duplicated ID are not observed.
      const idCounts = new Map<string, number>();
      for (const r of records) {
        idCounts.set(r.id, (idCounts.get(r.id) ?? 0) + 1);
      }
      const kysely = getNodeSqliteKysely<StorageTables>(db);
      // Resolve bylines before reserving the writer. The serialized store lane owns
      // history; the commit section still validates the observed revision below.
      const writers = new Map(
        executeSqliteQuerySync(
          db,
          kysely
            .selectFrom("observations as o")
            .leftJoin("history as h", (join) =>
              join.on("h.sequence", "=", (eb) =>
                eb
                  .selectFrom("history")
                  .select("sequence")
                  .whereRef("scope", "=", "o.scope")
                  .whereRef("id", "=", "o.id")
                  .whereRef("hash", "=", "o.hash")
                  .orderBy("sequence", "desc")
                  .limit(1),
              ),
            )
            .select(["o.id", "o.hash", "o.revision"])
            .select((eb) =>
              eb
                .case()
                .when("h.provenance", "=", "conversion")
                .then(
                  eb
                    .selectFrom("history as original")
                    .select((original) =>
                      original
                        .case()
                        .when("original.provenance", "=", "agent")
                        .then(original.ref("original.agent_id"))
                        .else(null)
                        .end()
                        .as("agent_id"),
                    )
                    .whereRef("original.scope", "=", "o.scope")
                    .whereRef("original.id", "=", "o.id")
                    .whereRef("original.sequence", "<", "h.sequence")
                    .where("original.provenance", "!=", "conversion")
                    .orderBy("original.sequence", "desc")
                    .limit(1),
                )
                .when("h.provenance", "=", "agent")
                .then(eb.ref("h.agent_id"))
                .else(null)
                .end()
                .as("agent_id"),
            )
            .where("o.scope", "=", key)
            .where("o.id", "in", sqliteStringSet([...idCounts.keys()])),
        ).rows.map((row) => [row.id, row]),
      );
      const pending = kysely
        .selectFrom("mutations")
        .select("request")
        .where("state", "!=", "published")
        .limit(1)
        .compile();
      access.assertCurrent();
      runSqliteImmediateTransactionSync(
        db,
        () => {
          this.assertCheckpoint(db, before);
          if (executeSqliteQueryTakeFirstSync(db, { compile: () => pending })) {
            throw blocked();
          }
          observeWithdrawals(db, records, this.retrievalBinding(access));
          this.enqueueGit(db, key, changes, "external observation");
          // Share metadata across reconciliation and deletion, retaining tombstone
          // revisions only for IDs that reappeared in this scan.
          const observations = new Map(
            executeSqliteQuerySync(
              db,
              getNodeSqliteKysely<StorageTables>(db)
                .selectFrom("observations")
                .select(["id", "path", "hash", "revision"])
                .where("scope", "=", key)
                .where((eb) =>
                  eb.or([
                    eb("hash", "!=", ""),
                    eb("id", "in", sqliteStringSet([...idCounts.keys()])),
                  ]),
                ),
            ).rows.map((row) => [row.id, row]),
          );
          for (const r of records.filter(
            (record) => record.valid && idCounts.get(record.id) === 1,
          )) {
            const prior = observations.get(r.id);
            if (prior && (prior.hash !== r.hash || prior.path !== r.path)) {
              r.revision = Math.max(r.revision, prior.revision + 1);
            } else if (prior) {
              r.revision = Math.max(r.revision, prior.revision);
            }
            if (!prior || prior.hash !== r.hash || prior.path !== r.path) {
              this.recordObservation(db, key, r, prior ? "external-edit" : "observed");
              // This revision was just recorded as non-agent; its writer is already known.
              continue;
            }
            const writer = writers.get(r.id);
            if (!writer || writer.hash !== prior.hash || writer.revision !== prior.revision) {
              throw new Error(
                "Knowledge observation changed during writer attribution; retry the scan.",
              );
            }
            if (writer.agent_id) {
              r.writtenByAgentId = writer.agent_id;
            }
          }
          const removed = [...observations.values()]
            .filter((prior) => prior.hash !== "" && !idCounts.has(prior.id))
            .map((prior) => prior.id);
          if (removed.length) {
            const ids = sqliteStringSet(removed);
            executeSqliteQuerySync(
              db,
              kysely
                .insertInto("history")
                .columns(["scope", "id", "provenance", "at", "path", "revision", "hash", "raw"])
                .expression((eb) =>
                  eb
                    .selectFrom("observations")
                    .select(["scope", "id"])
                    .select((row) => [
                      row.val("external-unavailable").as("provenance"),
                      row.val(new Date().toISOString()).as("at"),
                    ])
                    .select("path")
                    .select((row) => row("revision", "+", 1).as("revision"))
                    .select((row) => [row.val("").as("hash"), row.val("").as("raw")])
                    .where("scope", "=", key)
                    .where("id", "in", ids),
                ),
            );
            executeSqliteQuerySync(
              db,
              kysely
                .updateTable("observations")
                .set((eb) => ({ hash: "", revision: eb("revision", "+", 1) }))
                .where("scope", "=", key)
                .where("id", "in", ids),
            );
          }
        },
        { operationLabel: "knowledge.observe" },
      );
    });
    this.store.withDatabase((db) =>
      applyLifecycleGuards(db, records, this.retrievalBinding(access)),
    );
    this.flushGit(access);
  }
}
