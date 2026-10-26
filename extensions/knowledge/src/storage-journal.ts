import { jsonPathValue } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { Check } from "typebox/value";
import type { VaultAccess } from "./access.js";
import { SourceCheckInput, type SourceIdentity } from "./ingestion-contract.js";
import type { Receipt } from "./mutation-contract.js";
import { publicationRole, PublicationFiles } from "./publication-files.js";
import { observeWithdrawals } from "./retrieval.js";
import { appendActivity } from "./session-activity.js";
import { StorageBase } from "./storage-base.js";
import type { StorageTables } from "./storage-tables.js";
import { canonical, scopeKey, type Plan } from "./storage-types.js";
import { checkpointKey } from "./store-manifest.js";
import { textWindow } from "./text-window.js";
import { digest } from "./vault.js";
/** Journal reads and recovery: resume, history, revisions, mutation receipts and source checks. */
export class StorageJournal extends StorageBase {
  resume(access: VaultAccess, requestId: string): Receipt {
    access.assertCurrent();
    const published = this.transaction("knowledge.resume", (db) => {
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
      const checkpoint = JSON.parse(
        String(
          db
            .prepare("SELECT manifest FROM identities WHERE agent_key=?")
            .get(checkpointKey(this.config.vaultId))!.manifest,
        ),
      );
      if (canonical(checkpoint) !== canonical(plan.before)) {
        throw new Error("Stale publisher identity");
      }
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
        access.assertCurrent();
        db.prepare("UPDATE identities SET manifest=? WHERE agent_key=?").run(
          JSON.stringify(plan.after),
          checkpointKey(this.config.vaultId),
        );
        receipt.state = "published";
        receipt.message =
          "Published and available to exact reads; keyword indexing is pending until the next search reconciles this scope.";
        const records = plan.records ?? [plan.record];
        observeWithdrawals(db, records, this.retrievalBinding(access));
        for (const record of records) {
          this.recordObservation(db, plan.scope, record, plan.actor, plan.agentId);
        }
        if (plan.activity && plan.agentId) {
          appendActivity(db, plan.scope, plan.agentId, plan.activity, "write", records);
        }
        const gitFiles = new Map(
          plan.changes.filter((c) => c.path !== "vault.json").map((c) => [c.path, c.after]),
        );
        for (const [p, raw] of Object.entries(plan.descriptors ?? {})) {
          gitFiles.set(`${plan.scope}/${p}`, raw);
        }
        this.enqueueGit(
          db,
          plan.scope,
          [...gitFiles].map(([path, raw]) => ({ path, raw })),
          plan.actor,
          this.publicationToken(plan.scope, requestId),
        );
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
      db.prepare("UPDATE mutations SET state=?,receipt=? WHERE scope=? AND request=?").run(
        receipt.state,
        JSON.stringify(receipt),
        row.scope,
        row.request,
      );
      return receipt;
    });
    if (published.state === "published") {
      this.flushGit(access);
    }
    access.assertCurrent();
    return this.store.withDatabase(
      // SAFETY: receipts are serialized Receipt values written by this storage layer.
      (db) => JSON.parse(this.row(db, scopeKey(access.scope), requestId)!.receipt) as Receipt,
    );
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
            eb(jsonPathValue(db, eb.ref("receipt"), eb.val("$.id")), "=", id),
            eb(jsonPathValue(db, eb.ref("receipt"), eb.val("$.targetId")), "=", id),
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
