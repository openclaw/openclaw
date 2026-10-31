import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
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
    this.real = new RealVault(config, store, (records, access, evidence) =>
      this.observe(records, access, evidence),
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
    const row = db
      .prepare("SELECT manifest FROM identities WHERE agent_key=?")
      .get(checkpointKey(this.config.vaultId));
    if (!row || canonical(JSON.parse(String(row.manifest))) !== canonical(expected)) {
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
        db.prepare("DELETE FROM git_files WHERE scope=? AND path=?").run(scope, c.path);
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
    db.prepare(
      "INSERT INTO history(scope,id,provenance,at,path,revision,hash,raw,agent_id) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      scope,
      r.id,
      provenance,
      new Date().toISOString(),
      r.path,
      r.revision,
      r.hash,
      r.raw,
      agentId ?? null,
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
  private observe(records: LoadedRecord[], access: VaultAccess, evidence: EvidenceInspector) {
    const scope = access.scope;
    access.assertCurrent();
    this.store.withDatabase((db) => {
      const before = this.identity(db, new PublicationFiles(this.config.root));
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
      access.assertCurrent();
      runSqliteImmediateTransactionSync(
        db,
        () => {
          this.assertCheckpoint(db, before);
          if (db.prepare("SELECT 1 FROM mutations WHERE state!='published' LIMIT 1").get()) {
            throw blocked();
          }
          observeWithdrawals(db, records, this.retrievalBinding(access));
          this.enqueueGit(db, key, changes, "external observation");
          // Never materialize stored raw text just to compare hashes.
          const priorOf = db.prepare(
            "SELECT path,hash,revision FROM observations WHERE scope=? AND id=?",
          );
          const exactWriter = db.prepare(
            "SELECT provenance,agent_id,sequence FROM history WHERE scope=? AND id=? AND hash=? ORDER BY sequence DESC LIMIT 1",
          );
          const convertedWriter = db.prepare(
            "SELECT provenance,agent_id FROM history WHERE scope=? AND id=? AND sequence<? AND provenance!='conversion' ORDER BY sequence DESC LIMIT 1",
          );
          for (const r of records.filter(
            (record) => record.valid && idCounts.get(record.id) === 1,
          )) {
            const prior = priorOf.get(key, r.id);
            if (prior && (prior.hash !== r.hash || prior.path !== r.path)) {
              r.revision = Math.max(r.revision, Number(prior.revision) + 1);
            } else if (prior) {
              r.revision = Math.max(r.revision, Number(prior.revision));
            }
            if (!prior || prior.hash !== r.hash || prior.path !== r.path) {
              this.recordObservation(db, key, r, prior ? "external-edit" : "observed");
            }
            // Only journal-confirmed agent revisions may carry an agent byline.
            // Scope ownership alone is not authorship (operator/import/external edits).
            // In a shared store the writer is whichever agent published, never the viewer.
            // A store conversion rewrote only the storage envelope; authorship stays
            // with the revision it converted.
            const exact = exactWriter.get(key, r.id, r.hash);
            const writer =
              exact?.provenance === "conversion"
                ? convertedWriter.get(key, r.id, exact.sequence!)
                : exact;
            if (writer?.provenance === "agent" && writer.agent_id) {
              r.writtenByAgentId = String(writer.agent_id);
            }
          }
          const present = new Set(records.map((r) => r.id));
          for (const prior of db
            .prepare("SELECT id,path,revision FROM observations WHERE scope=? AND hash!=''")
            .all(key)) {
            if (!present.has(String(prior.id))) {
              db.prepare(
                "INSERT INTO history(scope,id,provenance,at,path,revision,hash,raw) VALUES (?,?,?,?,?,?,?,?)",
              ).run(
                key,
                prior.id!,
                "external-unavailable",
                new Date().toISOString(),
                prior.path!,
                Number(prior.revision) + 1,
                "",
                "",
              );
              db.prepare(
                "UPDATE observations SET hash='',revision=revision+1 WHERE scope=? AND id=?",
              ).run(key, prior.id!);
            }
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
