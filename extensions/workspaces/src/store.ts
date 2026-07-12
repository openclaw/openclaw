// Workspaces store: the single writer for the workspace document.
//
// Storage split (AGENTS.md "Storage default: SQLite only"):
// - the workspace document + its undo ring live in this plugin-owned SQLite DB,
//   the same shape logbook uses ("frames on disk, everything else in one
//   plugin-owned DB");
// - agent-authored widget assets (`workspaces/widgets/<name>/`) and file-binding
//   data (`workspaces/data/`) stay on disk, because those are named product
//   artifacts: the agent authors them with ordinary file tools and the widget
//   route serves their bytes.
//
// Every mutation is a single BEGIN IMMEDIATE transaction, so a read-modify-write
// cycle cannot interleave with another writer. node:sqlite is synchronous, which
// is why the mutator must be synchronous too: the transaction is the lock.
//
// There is deliberately no migration from the `workspace.json` this plugin used
// while it was in review. The plugin has never been reachable from a release tag,
// so no installation can hold that file, and compatibility here is opt-in per
// AGENTS.md. The landed singleton SQLite shape is different: local main users can
// already hold durable layout state, so it is migrated once into the default
// isolation-domain partition and its v1 documents are rewritten canonically.

import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { configureSqliteConnectionPragmas } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { WidgetAssetTokens } from "./asset-tokens.js";
import { DEFAULT_WORKSPACE } from "./default-workspace.js";
import {
  DEFAULT_WORKSPACE_ID,
  migrateWorkspaceDoc,
  validateWorkspaceDoc,
  type WorkspaceActor,
  type WorkspaceWidgetRegistryEntry,
  type WorkspaceDoc,
} from "./schema.js";

type WorkspaceMutationOptions = { actor: WorkspaceActor };
type WorkspaceMutationResult = { doc: WorkspaceDoc; changed: boolean };

const MAX_WORKSPACE_BYTES = 256 * 1024;
const UNDO_RING_SIZE = 20;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const BUSY_TIMEOUT_MS = 5000;
export const DEFAULT_ISOLATION_DOMAIN_ID = "default";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace (
  isolation_domain_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  doc TEXT NOT NULL,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (isolation_domain_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS undo (
  isolation_domain_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  doc TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (isolation_domain_id, workspace_id, version)
);
`;

type SqliteTableColumn = { name: string };

function tableColumns(db: DatabaseSync, table: "workspace" | "undo"): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as SqliteTableColumn[]).map(
      (column) => column.name,
    ),
  );
}

function initializeSchema(db: DatabaseSync): void {
  const workspaceColumns = tableColumns(db, "workspace");
  if (workspaceColumns.size === 0) {
    db.exec(SCHEMA);
    return;
  }
  if (workspaceColumns.has("isolation_domain_id")) {
    db.exec(SCHEMA);
    return;
  }
  if (!workspaceColumns.has("id")) {
    throw new Error("unsupported workspaces database schema");
  }

  const undoColumns = tableColumns(db, "undo");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE workspace RENAME TO workspace_legacy_singleton");
    if (undoColumns.size > 0) {
      db.exec("ALTER TABLE undo RENAME TO undo_legacy_singleton");
    }
    db.exec(SCHEMA);
    db.prepare(
      `INSERT INTO workspace
        (isolation_domain_id, workspace_id, version, doc, updated_ms)
       SELECT ?, ?, version, doc, updated_ms FROM workspace_legacy_singleton WHERE id = 1`,
    ).run(DEFAULT_ISOLATION_DOMAIN_ID, DEFAULT_WORKSPACE_ID);
    if (undoColumns.size > 0) {
      db.prepare(
        `INSERT INTO undo
          (isolation_domain_id, workspace_id, version, doc, created_ms)
         SELECT ?, ?, version, doc, created_ms FROM undo_legacy_singleton`,
      ).run(DEFAULT_ISOLATION_DOMAIN_ID, DEFAULT_WORKSPACE_ID);
      db.exec("DROP TABLE undo_legacy_singleton");
    }
    db.exec("DROP TABLE workspace_legacy_singleton");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function serializeWorkspaceDoc(doc: WorkspaceDoc): string {
  return JSON.stringify(doc);
}

function assertWorkspaceSize(serialized: string): void {
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORKSPACE_BYTES) {
    throw new Error("workspace document exceeds 256 KB");
  }
}

/**
 * Reconciles a whole-document replacement against what is already stored, inside
 * the write transaction. Two fields are never taken from the caller:
 *
 * - **the registry itself.** Entries are minted by `workspace_widget_scaffold` and
 *   nowhere else. Replacement preserves the complete current registry and ignores
 *   the incoming field: otherwise a caller could delete approval decisions or mint a `pending`
 *   entry for a name with no widget on disk, have an operator approve it, and only
 *   then write the code the operator "approved". Status likewise changes only
 *   through `workspaces.widget.approve` — a document that arrives already marked
 *   `approved` would skip the gate entirely and the asset route would serve it.
 * - **provenance (`createdBy`).** Otherwise an agent could stamp its own tabs and
 *   widgets `user`, or an operator could stamp `agent:<id>`, and the AI-provenance
 *   chip would be a lie. Existing entities keep their stamp; new ones get `actor`.
 */
function reconcileReplace(
  incoming: WorkspaceDoc,
  current: WorkspaceDoc,
  actor: WorkspaceActor,
): WorkspaceDoc {
  const widgetsRegistry: Record<string, WorkspaceWidgetRegistryEntry> = structuredClone(
    current.widgetsRegistry,
  );
  const existingTabsById = new Map(current.tabs.map((tab) => [tab.id, tab]));
  const existingTabs = new Map(current.tabs.map((tab) => [tab.slug, tab]));
  const existingWidgets = new Map(
    current.tabs.flatMap((tab) => tab.widgets.map((widget) => [widget.id, widget] as const)),
  );
  return {
    ...incoming,
    workspaceId: current.workspaceId,
    widgetsRegistry,
    tabs: incoming.tabs.map((tab) => {
      const existing = existingTabsById.get(tab.id) ?? existingTabs.get(tab.slug);
      return {
        ...tab,
        id: existing?.id ?? tab.id,
        createdBy: existing?.createdBy ?? actor,
        widgets: tab.widgets.map((widget) => ({
          ...widget,
          createdBy: existingWidgets.get(widget.id)?.createdBy ?? actor,
        })),
      };
    }),
  };
}

function assertStableResourceIds(current: WorkspaceDoc, next: WorkspaceDoc): void {
  if (next.workspaceId !== current.workspaceId) {
    throw new Error("workspaceId is immutable");
  }
  const existingIdsBySlug = new Map(current.tabs.map((tab) => [tab.slug, tab.id]));
  for (const tab of next.tabs) {
    const existingId = existingIdsBySlug.get(tab.slug);
    if (existingId !== undefined && tab.id !== existingId) {
      throw new Error(`tab id is immutable for slug: ${tab.slug}`);
    }
  }
}

function tabContentEquals(
  current: WorkspaceDoc["tabs"][number],
  next: WorkspaceDoc["tabs"][number],
) {
  return isDeepStrictEqual({ ...current, revision: 1 }, { ...next, revision: 1 });
}

function stampTabRevisions(current: WorkspaceDoc, next: WorkspaceDoc): WorkspaceDoc {
  const existingTabs = new Map(current.tabs.map((tab) => [tab.id, tab]));
  const tabs: WorkspaceDoc["tabs"] = [];
  for (const tab of next.tabs) {
    const existing = existingTabs.get(tab.id);
    const revision =
      existing === undefined
        ? 1
        : tabContentEquals(existing, tab)
          ? existing.revision
          : existing.revision + 1;
    tabs.push({ ...tab, revision });
  }
  return { ...next, tabs };
}

export class WorkspaceStore {
  readonly stateDir: string;
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly isolationDomainId: string;
  readonly workspaceId = DEFAULT_WORKSPACE_ID;
  private readonly db: DatabaseSync;
  readonly assetTokens = new WidgetAssetTokens();
  /**
   * Single-slot cache of the parsed document. This process is the only writer
   * and every write goes through `commit()`, so the cache is exact rather than
   * merely fresh — the capability-gated asset route can check approval status on
   * every request without re-parsing a 256 KB document.
   */
  private cached: WorkspaceDoc | null = null;

  constructor(options: { stateDir?: string; isolationDomainId?: string } = {}) {
    this.stateDir = options.stateDir ?? resolveStateDir();
    this.isolationDomainId = options.isolationDomainId ?? DEFAULT_ISOLATION_DOMAIN_ID;
    if (this.isolationDomainId.trim().length === 0) {
      throw new Error("isolationDomainId must not be empty");
    }
    this.workspaceDir = path.join(this.stateDir, "workspaces");
    this.dbPath = path.join(this.workspaceDir, "workspaces.sqlite");
    mkdirSync(this.workspaceDir, { recursive: true, mode: DIR_MODE });
    this.db = new DatabaseSync(this.dbPath);
    try {
      configureSqliteConnectionPragmas(this.db, { busyTimeoutMs: BUSY_TIMEOUT_MS });
      // WAL/SHM sidecars inherit the main DB file's permissions.
      chmodSync(this.dbPath, FILE_MODE);
      initializeSchema(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  read(): WorkspaceDoc {
    if (this.cached) {
      return structuredClone(this.cached);
    }
    const row = this.db
      .prepare("SELECT doc FROM workspace WHERE isolation_domain_id = ? AND workspace_id = ?")
      .get(this.isolationDomainId, this.workspaceId) as { doc: string } | undefined;
    if (!row) {
      const seeded = validateWorkspaceDoc(structuredClone(DEFAULT_WORKSPACE));
      this.commit(seeded, { snapshot: null });
      return structuredClone(seeded);
    }
    const migrated = migrateWorkspaceDoc(JSON.parse(row.doc));
    const doc = migrated.doc;
    if (doc.workspaceId !== this.workspaceId) {
      throw new Error(`workspace document id does not match stored workspace: ${this.workspaceId}`);
    }
    if (migrated.changed) {
      this.commit(doc, { snapshot: null });
    }
    this.cached = doc;
    return structuredClone(doc);
  }

  /** Registry entry for one custom widget, or null when it was never scaffolded. */
  widgetEntry(name: string): WorkspaceWidgetRegistryEntry | null {
    return this.read().widgetsRegistry[name] ?? null;
  }

  /** Approval status for one custom widget. */
  widgetStatus(name: string): WorkspaceWidgetRegistryEntry["status"] | null {
    return this.widgetEntry(name)?.status ?? null;
  }

  /**
   * Applies `fn` to a draft of the current document and persists the result.
   * `fn` must be synchronous: it runs inside the write transaction, which is what
   * serializes concurrent RPC / CLI / agent-tool callers.
   */
  mutate(
    fn: (draft: WorkspaceDoc) => WorkspaceDoc | void,
    _options: WorkspaceMutationOptions,
  ): WorkspaceMutationResult {
    return this.transact((current) => {
      const draft = structuredClone(current);
      const returned = fn(draft);
      return returned ?? draft;
    });
  }

  /**
   * Replaces the whole document (bulk authoring). Approval state and provenance
   * are always reconciled against the stored document, so replace can neither
   * self-approve a custom widget nor forge a `createdBy` stamp.
   */
  replace(doc: unknown, options: WorkspaceMutationOptions): WorkspaceMutationResult {
    const canonical = migrateWorkspaceDoc(structuredClone(doc)).doc;
    return this.transact((current) => reconcileReplace(canonical, current, options.actor));
  }

  /**
   * Restores the newest undo snapshot as a NEW version. The restored document is
   * a fresh write, not a rewind: `workspaceVersion` stays monotonic so connected
   * UIs — which refetch only on a strictly newer version — see the undo.
   */
  undo(): WorkspaceDoc {
    return this.transact(
      (current) => {
        const row = this.db
          .prepare(
            `SELECT version, doc FROM undo
             WHERE isolation_domain_id = ? AND workspace_id = ?
             ORDER BY version DESC LIMIT 1`,
          )
          .get(this.isolationDomainId, this.workspaceId) as
          | { version: number; doc: string }
          | undefined;
        if (!row) {
          throw new Error("no workspace undo snapshot available");
        }
        this.db
          .prepare(
            `DELETE FROM undo
             WHERE isolation_domain_id = ? AND workspace_id = ? AND version = ?`,
          )
          .run(this.isolationDomainId, this.workspaceId, row.version);
        // transact() stamps the next version, so the restored document lands as a
        // forward write rather than a rewind.
        const snapshot = migrateWorkspaceDoc(JSON.parse(row.doc)).doc;
        // Approval state is a separate operator decision, not layout history.
        // Undo may restore tabs/widgets, but it must never revive a revoked
        // approval or discard a registry decision made after the snapshot.
        return { ...snapshot, widgetsRegistry: current.widgetsRegistry };
      },
      // An undo consumes a snapshot; it must not push one, or repeated undo would
      // oscillate between the last two documents instead of walking history back.
      { snapshot: false },
    ).doc;
  }

  /**
   * One BEGIN IMMEDIATE transaction: read current, derive next, snapshot the old
   * document into the undo ring, write, trim. Any throw rolls the whole thing
   * back, so a rejected write never leaves a partially applied document.
   */
  private transact(
    derive: (current: WorkspaceDoc) => WorkspaceDoc,
    options: { snapshot?: boolean } = {},
  ): WorkspaceMutationResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Derive from what the transaction sees, never from the cache: the cache
      // is a read-path accelerator, not the transaction's snapshot.
      this.cached = null;
      const current = this.read();
      const derived = derive(current);
      assertStableResourceIds(current, derived);
      const revised = stampTabRevisions(current, derived);
      const next = validateWorkspaceDoc({
        ...revised,
        workspaceVersion: current.workspaceVersion + 1,
      });
      this.commit(next, { snapshot: options.snapshot === false ? null : current });
      this.db.exec("COMMIT");
      return { doc: next, changed: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.cached = null;
      throw error;
    }
  }

  /** Persists `doc` as the current workspace, pushing `snapshot` onto the undo ring. */
  private commit(doc: WorkspaceDoc, params: { snapshot: WorkspaceDoc | null }): void {
    const serialized = serializeWorkspaceDoc(doc);
    assertWorkspaceSize(serialized);
    const now = Date.now();
    if (params.snapshot) {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO undo
            (isolation_domain_id, workspace_id, version, doc, created_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          this.isolationDomainId,
          this.workspaceId,
          doc.workspaceVersion,
          serializeWorkspaceDoc(params.snapshot),
          now,
        );
      this.db
        .prepare(
          `DELETE FROM undo
           WHERE isolation_domain_id = ? AND workspace_id = ?
             AND version NOT IN (
               SELECT version FROM undo
               WHERE isolation_domain_id = ? AND workspace_id = ?
               ORDER BY version DESC LIMIT ?
             )`,
        )
        .run(
          this.isolationDomainId,
          this.workspaceId,
          this.isolationDomainId,
          this.workspaceId,
          UNDO_RING_SIZE,
        );
    }
    this.db
      .prepare(
        `INSERT INTO workspace
          (isolation_domain_id, workspace_id, version, doc, updated_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(isolation_domain_id, workspace_id) DO UPDATE SET
           version = excluded.version,
           doc = excluded.doc,
           updated_ms = excluded.updated_ms`,
      )
      .run(this.isolationDomainId, this.workspaceId, doc.workspaceVersion, serialized, now);
    this.cached = doc;
  }
}
