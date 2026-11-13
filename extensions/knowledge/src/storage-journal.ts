import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { Check } from "typebox/value";
import type { VaultAccess } from "./access.js";
import type { AttachInput } from "./attachment-contract.js";
import { attachChunk } from "./attachments.js";
import { SourceCheckInput, type SourceIdentity } from "./ingestion-contract.js";
import { releaseSupersessionGuards } from "./lifecycle.js";
import type { Receipt } from "./mutation-contract.js";
import { publicationRole, PublicationFiles } from "./publication-files.js";
import { observeWithdrawals } from "./retrieval.js";
import { appendActivity } from "./session-activity.js";
import { StorageBase } from "./storage-base.js";
import type { StorageTables } from "./storage-tables.js";
import { blocked, scopeKey, type Plan } from "./storage-types.js";
import { checkpointKey } from "./store-manifest.js";
import { textWindow } from "./text-window.js";
import { digest } from "./vault.js";
/** Journal reads and recovery: resume, history, revisions, mutation receipts and source checks. */
export class StorageJournal extends StorageBase {
  async attach(input: AttachInput, access: VaultAccess) {
    access.assertCurrent();
    if (!this.config.writesEnabled) {
      throw new Error("Knowledge writes are disabled.");
    }
    if (input.expectedVaultId && input.expectedVaultId !== this.config.vaultId) {
      throw new Error("Connected vault changed; do not upload this file here.");
    }
    await this.initialize(access);
    this.assertReadable();
    return this.store.withDatabase((db) => {
      const before = this.identity(db, new PublicationFiles(this.config.root));
      return attachChunk(
        db,
        this.config.root,
        scopeKey(access.scope),
        input,
        () => access.assertCurrent(),
        this.hook,
        () => {
          this.assertCheckpoint(db, before);
          if (db.prepare("SELECT 1 FROM mutations WHERE state!='published' LIMIT 1").get()) {
            throw blocked();
          }
        },
      );
    });
  }
  resume(access: VaultAccess, requestId: string): Receipt {
    access.assertCurrent();
    const published = this.store.withDatabase((db) => {
      const row = this.row(db, scopeKey(access.scope), requestId);
      if (!row) {
        throw new Error("Mutation unavailable in this scope.");
      }
      const plan: Plan = JSON.parse(row.plan),
        receipt: Receipt = JSON.parse(row.receipt);
      const files = new PublicationFiles(this.config.root);
      if (plan.scope !== scopeKey(access.scope)) {
        throw new Error("Mutation scope mismatch");
      }
      if (row.state === "accepted") {
        if (files.identity() !== plan.rootIdentity) {
          throw new Error("Stale publisher root identity");
        }
        for (const change of plan.changes) {
          files.repairStageLink(change);
        }
      }
      const manifestChange = plan.changes.at(-1)!;
      const fallback =
        row.state !== "published" &&
        files.read(manifestChange.backup, true, publicationRole(manifestChange.path)) ===
          manifestChange.before
          ? manifestChange.before
          : undefined;
      this.identity(db, files, row.state !== "published" ? plan.after : undefined, fallback);
      if (row.state !== "accepted") {
        access.assertCurrent();
        return receipt;
      }
      this.assertCheckpoint(db, plan.before);
      try {
        // A reused immutable source is not a file change, but is still fenced on replay.
        for (const [p, raw] of Object.entries(plan.descriptors ?? {})) {
          if (
            !plan.changes.some((c) => c.path === `${plan.scope}/${p}`) &&
            files.read(`${plan.scope}/${p}`) !== raw
          ) {
            throw new Error("conflict");
          }
        }
        for (const change of plan.changes) {
          access.assertCurrent();
          files.publish(change, (stage) => this.hook(`${stage}:${change.path}`));
        }
        this.hook("before-receipt");
        for (const [p, raw] of Object.entries(plan.descriptors ?? {})) {
          if (files.read(`${plan.scope}/${p}`) !== raw) {
            throw new Error("conflict");
          }
        }
        for (const change of plan.changes) {
          if (
            files.read(change.path) !== change.after ||
            (change.before !== null &&
              files.read(change.backup, false, publicationRole(change.path)) !== change.before)
          ) {
            throw new Error("conflict");
          }
        }
        receipt.state = "published";
        receipt.message =
          "Published and available to exact reads; keyword indexing is pending until the next search reconciles this scope.";
        receipt.git = { state: "pending", message: "Published; local Git checkpoint pending." };
      } catch (e) {
        // SAFETY: publication failures are Error instances.
        if ((e as Error).message !== "conflict") {
          throw e;
        }
        receipt.state = "conflict";
        receipt.message =
          "Concurrent filesystem change preserved. Publication is blocked; retained before/after material requires recovery review. No automatic overwrite or rollback.";
      }
      receipt.at = new Date().toISOString();
      const gitFiles = new Map(
        plan.changes.filter((c) => c.path !== "vault.json").map((c) => [c.path, c.after]),
      );
      for (const [p, raw] of Object.entries(plan.descriptors ?? {})) {
        gitFiles.set(`${plan.scope}/${p}`, raw);
      }
      const after = JSON.stringify(plan.after),
        serializedReceipt = JSON.stringify(receipt);
      const gitChanges = [...gitFiles].map(([path, raw]) => ({ path, raw }));
      this.hook("before-settlement");
      access.assertCurrent();
      // The accepted intent remains durable while files are published. The worker
      // serializes publication; only receipt settlement needs SQLite's write lock.
      return runSqliteImmediateTransactionSync(
        db,
        () => {
          const current = db
            .prepare("SELECT state,receipt FROM mutations WHERE scope=? AND request=?")
            .get(row.scope, row.request)!;
          if (current.state !== "accepted") {
            // SAFETY: only this owner writes serialized Receipt rows.
            return JSON.parse(String(current.receipt)) as Receipt;
          }
          this.assertCheckpoint(db, plan.before);
          if (receipt.state === "published") {
            db.prepare("UPDATE identities SET manifest=? WHERE agent_key=?").run(
              after,
              checkpointKey(this.config.vaultId),
            );
            const records = plan.records ?? [plan.record];
            observeWithdrawals(db, records, this.retrievalBinding(access));
            releaseSupersessionGuards(db, plan.restored ?? [], this.retrievalBinding(access));
            for (const record of records) {
              this.recordObservation(db, plan.scope, record, plan.actor, plan.agentId);
            }
            if (plan.activity && plan.agentId) {
              appendActivity(db, plan.scope, plan.agentId, plan.activity, "write", records);
            }
            this.enqueueGit(
              db,
              plan.scope,
              gitChanges,
              plan.actor,
              this.publicationToken(plan.scope, requestId),
            );
          }
          db.prepare("UPDATE mutations SET state=?,receipt=? WHERE scope=? AND request=?").run(
            receipt.state,
            serializedReceipt,
            row.scope,
            row.request,
          );
          return receipt;
        },
        { operationLabel: "knowledge.resume" },
      );
    });
    this.hook("after-settlement");
    if (published.state === "published") {
      this.flushGit(access);
    }
    access.assertCurrent();
    return this.store.withDatabase((db) => {
      const row = db
        .prepare("SELECT receipt FROM mutations WHERE scope=? AND request=?")
        .get(scopeKey(access.scope), requestId)!;
      // SAFETY: receipts are serialized Receipt values written by this storage layer.
      return JSON.parse(String(row.receipt)) as Receipt;
    });
  }
  history(access: VaultAccess, input: { offset?: number; limit?: number; id?: string }) {
    access.assertCurrent();
    return this.store.withDatabase((db) => {
      // Pending manifests may be either side of the retained publication. Never
      // allow a different vault to inherit operational history at the same path.
      const pending = db
        .prepare("SELECT plan FROM mutations WHERE state!='published' LIMIT 1")
        .get();
      const files = new PublicationFiles(this.config.root),
        plan: Plan | undefined = pending ? JSON.parse(String(pending.plan)) : undefined;
      const last = plan?.changes.at(-1);
      const fallback =
        plan &&
        files.identity() === plan.rootIdentity &&
        last &&
        files.read(last.backup, true, publicationRole(last.path)) === last.before
          ? last.before
          : undefined;
      this.identity(db, files, plan?.after, fallback);
      const scope = scopeKey(access.scope),
        offset = input.offset ?? 0,
        limit = input.limit ?? 50;
      const id = input.id;
      let historyQuery = getNodeSqliteKysely<StorageTables>(db)
        .selectFrom("history")
        .select(["sequence", "id", "provenance", "at", "path", "revision", "hash"])
        .where("scope", "=", scope);
      if (id !== undefined) {
        historyQuery = historyQuery.where("id", "=", id);
      }
      const rows = executeSqliteQuerySync(
        db,
        historyQuery
          .orderBy("sequence", "desc")
          .limit(limit + 1)
          .offset(offset),
      ).rows;
      let query = getNodeSqliteKysely<StorageTables>(db)
        .selectFrom("mutations")
        .select("receipt")
        .where("scope", "=", scope);
      if (id !== undefined) {
        query = query.where((eb) =>
          eb.or([
            eb(eb.fn<string | null>("json_extract", [eb.ref("receipt"), eb.val("$.id")]), "=", id),
            eb(
              eb.fn<string | null>("json_extract", [eb.ref("receipt"), eb.val("$.targetId")]),
              "=",
              id,
            ),
          ]),
        );
      }
      const mutations = executeSqliteQuerySync(
        db,
        query
          .orderBy("rowid", "desc")
          .limit(limit + 1)
          .offset(offset),
        // SAFETY: receipts are serialized Receipt values written by this storage layer.
      ).rows.map((r) => JSON.parse(r.receipt) as Receipt);
      access.assertCurrent();
      return {
        git: this.gitStatus(db, scope),
        entries: rows.slice(0, limit),
        mutations: mutations.slice(0, limit),
        nextOffset: rows.length > limit || mutations.length > limit ? offset + limit : null,
      };
    });
  }
  revision(
    access: VaultAccess,
    sequence: number,
    input: { offset?: number; maxChars?: number } = {},
  ) {
    this.history(access, { limit: 1 });
    const result = this.store.withDatabase((db) => {
      const row = db
        .prepare("SELECT raw FROM history WHERE scope=? AND sequence=?")
        .get(scopeKey(access.scope), sequence);
      if (!row) {
        return { raw: null, content: null };
      }
      const page = textWindow(String(row.raw), input.offset, input.maxChars);
      return { raw: page.text, content: page.content };
    });
    access.assertCurrent();
    return result;
  }
  mutation(
    access: VaultAccess,
    requestId: string,
    input: {
      includeFiles?: boolean;
      offset?: number;
      limit?: number;
      charOffset?: number;
      maxChars?: number;
      contentField?: "before" | "proposed" | "displaced";
    } = {},
  ) {
    this.history(access, { limit: 1 });
    const result = this.store.withDatabase((db) => {
      const row = this.row(db, scopeKey(access.scope), requestId);
      if (!row) {
        return { receipt: null, files: [] };
      }
      const plan: Plan = JSON.parse(row.plan),
        files = new PublicationFiles(this.config.root);
      return {
        // SAFETY: receipts are serialized Receipt values written by this storage layer.
        receipt: JSON.parse(row.receipt) as Receipt,
        ...(plan.changes.filter((c) => c.path !== "vault.json").length > 3 ||
        input.includeFiles === false ||
        input.offset !== undefined ||
        input.limit !== undefined
          ? {
              totalFiles: plan.changes.length - 1,
              nextOffset:
                input.includeFiles === false
                  ? null
                  : (input.offset ?? 0) + (input.limit ?? 3) < plan.changes.length - 1
                    ? (input.offset ?? 0) + (input.limit ?? 3)
                    : null,
            }
          : {}),
        files: (input.includeFiles === false
          ? []
          : plan.changes
              .filter((c) => c.path !== "vault.json")
              .slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 3))
        ).map((c) => {
          const window = (raw: string | null, field: "before" | "proposed" | "displaced") => {
            if (raw === null) {
              return null;
            }
            const page = textWindow(
              raw,
              field === (input.contentField ?? "proposed") ? input.charOffset : 0,
              input.maxChars,
            );
            return { ...page, content: { ...page.content, hash: digest(raw) } };
          };
          const before = window(c.before, "before"),
            proposed = window(c.after, "proposed")!,
            displaced = window(files.read(c.backup, true, publicationRole(c.path)), "displaced");
          return {
            path: c.path.slice(plan.scope.length + 1),
            before: before?.text ?? null,
            proposed: proposed.text,
            displaced: displaced?.text ?? null,
            content: {
              before: before?.content ?? null,
              proposed: proposed.content,
              displaced: displaced?.content ?? null,
            },
          };
        }),
      };
    });
    access.assertCurrent();
    return result;
  }
  async sourceCheck(input: SourceIdentity, access: VaultAccess) {
    if (!Check(SourceCheckInput, input)) {
      throw new Error("Invalid source identity.");
    }
    await this.initialize(access);
    this.history(access, { limit: 1 }); // Same identity and pending-manifest fence as recovery reads.
    const row = this.store.withDatabase((db) => this.sourceRow(db, scopeKey(access.scope), input));
    access.assertCurrent();
    return {
      state: !row
        ? ("missing" as const)
        : JSON.parse(row.plan).source.sha256 === input.sha256
          ? ("unchanged" as const)
          : ("changed" as const),
      // SAFETY: receipts are serialized Receipt values written by this storage layer.
      receipt: row ? (JSON.parse(row.receipt) as Receipt) : null,
      message: row
        ? "Receipt is publication history, not proof outputs remain current. Verify its IDs; never recreate withdrawn or superseded outputs. Changed source bytes require explicit reconciliation."
        : "No batch source receipt in this scope. Legacy individual writes are not registered; resolve existing records before creating anything.",
    };
  }
}
