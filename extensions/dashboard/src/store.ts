// Dashboard workspace store: the single writer for the workspace document.
//
// Storage split (AGENTS.md "Storage default: SQLite only"):
// - the workspace document + its undo ring live in this plugin-owned SQLite DB,
//   the same shape logbook uses ("frames on disk, everything else in one
//   plugin-owned DB");
// - agent-authored widget assets (`dashboard/widgets/<name>/`) and file-binding
//   data (`dashboard/data/`) stay on disk, because those are named product
//   artifacts: the agent authors them with ordinary file tools and the widget
//   route serves their bytes.
//
// Every mutation is a single BEGIN IMMEDIATE transaction, so a read-modify-write
// cycle cannot interleave with another writer. node:sqlite is synchronous, which
// is why the mutator must be synchronous too: the transaction is the lock.

import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureSqliteConnectionPragmas } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { DEFAULT_DASHBOARD_WORKSPACE } from "./default-workspace.js";
import {
  validateWorkspaceDoc,
  type DashboardActor,
  type DashboardWidgetRegistryEntry,
  type WorkspaceDoc,
} from "./schema.js";

export type DashboardMutationOptions = { actor: DashboardActor };
export type DashboardMutationResult = { doc: WorkspaceDoc; changed: boolean };

const MAX_WORKSPACE_BYTES = 256 * 1024;
const UNDO_RING_SIZE = 20;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const BUSY_TIMEOUT_MS = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  doc TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS undo (
  version INTEGER PRIMARY KEY,
  doc TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
`;

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
 * - **approval status.** Otherwise any caller of `workspace.replace` could submit
 *   a document whose `widgetsRegistry` already marks an agent-authored widget
 *   `approved`, and the asset route would serve it — skipping the operator
 *   approval gate that is the entire trust boundary for custom widgets. Status
 *   changes only through `dashboard.widget.approve`.
 * - **provenance (`createdBy`).** Otherwise an agent could stamp its own tabs and
 *   widgets `user`, or an operator could stamp `agent:<id>`, and the AI-provenance
 *   chip would be a lie. Existing entities keep their stamp; new ones get `actor`.
 */
export function reconcileReplace(
  incoming: WorkspaceDoc,
  current: WorkspaceDoc,
  actor: DashboardActor,
): WorkspaceDoc {
  const widgetsRegistry: Record<string, DashboardWidgetRegistryEntry> = {};
  for (const name of Object.keys(incoming.widgetsRegistry)) {
    widgetsRegistry[name] = current.widgetsRegistry[name] ?? {
      status: "pending",
      createdBy: actor,
    };
  }
  const existingTabs = new Map(current.tabs.map((tab) => [tab.slug, tab]));
  const existingWidgets = new Map(
    current.tabs.flatMap((tab) => tab.widgets.map((widget) => [widget.id, widget] as const)),
  );
  return {
    ...incoming,
    widgetsRegistry,
    tabs: incoming.tabs.map((tab) => ({
      ...tab,
      createdBy: existingTabs.get(tab.slug)?.createdBy ?? actor,
      widgets: tab.widgets.map((widget) => ({
        ...widget,
        createdBy: existingWidgets.get(widget.id)?.createdBy ?? actor,
      })),
    })),
  };
}

export class DashboardStore {
  readonly stateDir: string;
  readonly dashboardDir: string;
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  /**
   * Single-slot cache of the parsed document. This process is the only writer
   * and every write goes through `commit()`, so the cache is exact rather than
   * merely fresh — the unauthenticated asset route can check approval status on
   * every request without re-parsing a 256 KB document.
   */
  private cached: WorkspaceDoc | null = null;

  constructor(options: { stateDir?: string } = {}) {
    this.stateDir = options.stateDir ?? resolveStateDir();
    this.dashboardDir = path.join(this.stateDir, "dashboard");
    this.dbPath = path.join(this.dashboardDir, "dashboard.sqlite");
    mkdirSync(this.dashboardDir, { recursive: true, mode: DIR_MODE });
    this.db = new DatabaseSync(this.dbPath);
    try {
      configureSqliteConnectionPragmas(this.db, { busyTimeoutMs: BUSY_TIMEOUT_MS });
      // WAL/SHM sidecars inherit the main DB file's permissions.
      chmodSync(this.dbPath, FILE_MODE);
      this.db.exec(SCHEMA);
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
    const row = this.db.prepare("SELECT doc FROM workspace WHERE id = 1").get() as
      | { doc: string }
      | undefined;
    if (!row) {
      const seeded = validateWorkspaceDoc(structuredClone(DEFAULT_DASHBOARD_WORKSPACE));
      this.commit(seeded, { snapshot: null });
      return structuredClone(seeded);
    }
    const doc = validateWorkspaceDoc(JSON.parse(row.doc));
    this.cached = doc;
    return structuredClone(doc);
  }

  /** Approval status for one custom widget, without materializing the document. */
  widgetStatus(name: string): DashboardWidgetRegistryEntry["status"] | null {
    return this.read().widgetsRegistry[name]?.status ?? null;
  }

  /**
   * Applies `fn` to a draft of the current document and persists the result.
   * `fn` must be synchronous: it runs inside the write transaction, which is what
   * serializes concurrent RPC / CLI / agent-tool callers.
   */
  mutate(
    fn: (draft: WorkspaceDoc) => WorkspaceDoc | void,
    _options: DashboardMutationOptions,
  ): DashboardMutationResult {
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
  replace(doc: WorkspaceDoc, options: DashboardMutationOptions): DashboardMutationResult {
    return this.transact((current) =>
      reconcileReplace(structuredClone(doc), current, options.actor),
    );
  }

  /**
   * Restores the newest undo snapshot as a NEW version. The restored document is
   * a fresh write, not a rewind: `workspaceVersion` stays monotonic so connected
   * UIs — which refetch only on a strictly newer version — see the undo.
   */
  undo(): WorkspaceDoc {
    return this.transact(
      () => {
        const row = this.db
          .prepare("SELECT version, doc FROM undo ORDER BY version DESC LIMIT 1")
          .get() as { version: number; doc: string } | undefined;
        if (!row) {
          throw new Error("no dashboard undo snapshot available");
        }
        this.db.prepare("DELETE FROM undo WHERE version = ?").run(row.version);
        // transact() stamps the next version, so the restored document lands as a
        // forward write rather than a rewind.
        return validateWorkspaceDoc(JSON.parse(row.doc));
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
  ): DashboardMutationResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Derive from what the transaction sees, never from the cache: the cache
      // is a read-path accelerator, not the transaction's snapshot.
      this.cached = null;
      const current = this.read();
      const next = validateWorkspaceDoc({
        ...derive(current),
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
        .prepare("INSERT OR REPLACE INTO undo (version, doc, created_ms) VALUES (?, ?, ?)")
        .run(doc.workspaceVersion, serializeWorkspaceDoc(params.snapshot), now);
      this.db
        .prepare(
          "DELETE FROM undo WHERE version NOT IN (SELECT version FROM undo ORDER BY version DESC LIMIT ?)",
        )
        .run(UNDO_RING_SIZE);
    }
    this.db
      .prepare(
        "INSERT INTO workspace (id, version, doc, updated_ms) VALUES (1, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET version = excluded.version, doc = excluded.doc, updated_ms = excluded.updated_ms",
      )
      .run(doc.workspaceVersion, serialized, now);
    this.cached = doc;
  }
}
