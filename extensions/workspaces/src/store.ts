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

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { configureSqliteConnectionPragmas } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { WidgetAssetTokens } from "./asset-tokens.js";
import {
  hashChangeRequestProposal,
  parseChangeRequestState,
  reconcileChangeRequestProposal,
  validateChangeRequestId,
  validateChangeRequestRequester,
  validateDecisionReason,
  validateHumanDecider,
  validateIdempotencyKey,
  type CancelWorkspaceChangeRequestInput,
  type CreateWorkspaceChangeRequestInput,
  type DecideWorkspaceChangeRequestInput,
  type WorkspaceChangeRequest,
  type WorkspaceChangeRequestDecisionResult,
  type WorkspaceChangeRequestListFilter,
  type WorkspaceRequester,
  type WorkspaceTabProposal,
} from "./change-requests.js";
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
CREATE TABLE IF NOT EXISTS workspace_tab_id_tombstones (
  isolation_domain_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  removed_ms INTEGER NOT NULL,
  PRIMARY KEY (isolation_domain_id, workspace_id, tab_id)
);
CREATE TABLE IF NOT EXISTS workspace_change_requests (
  isolation_domain_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  tab_id TEXT NOT NULL CHECK (length(tab_id) BETWEEN 1 AND 64),
  requester_principal_id TEXT NOT NULL CHECK (length(requester_principal_id) BETWEEN 1 AND 256),
  requester_kind TEXT NOT NULL CHECK (requester_kind IN ('human', 'agent')),
  delegation_id TEXT,
  sponsor_principal_id TEXT,
  base_tab_revision INTEGER NOT NULL CHECK (base_tab_revision >= 1),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json) AND length(proposal_json) <= 131072),
  proposal_sha256 TEXT NOT NULL CHECK (length(proposal_sha256) = 64 AND proposal_sha256 NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'cancelled', 'conflict')),
  created_ms INTEGER NOT NULL CHECK (created_ms >= 0),
  decider_principal_id TEXT,
  decider_kind TEXT CHECK (decider_kind IS NULL OR decider_kind = 'human'),
  decided_ms INTEGER,
  decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) <= 2048),
  cancelled_ms INTEGER,
  PRIMARY KEY (isolation_domain_id, workspace_id, id),
  UNIQUE (
    isolation_domain_id,
    workspace_id,
    requester_principal_id,
    requester_kind,
    idempotency_key
  ),
  CHECK (
    (requester_kind = 'human' AND delegation_id IS NULL AND sponsor_principal_id IS NULL)
    OR
    (requester_kind = 'agent' AND (
      (delegation_id IS NULL AND sponsor_principal_id IS NULL)
      OR (delegation_id IS NOT NULL AND sponsor_principal_id IS NOT NULL)
    ))
  ),
  CHECK (
    (state = 'pending' AND decider_principal_id IS NULL AND decider_kind IS NULL
      AND decided_ms IS NULL AND decision_reason IS NULL AND cancelled_ms IS NULL)
    OR
    (state = 'cancelled' AND decider_principal_id IS NULL AND decider_kind IS NULL
      AND decided_ms IS NULL AND decision_reason IS NULL AND cancelled_ms IS NOT NULL)
    OR
    (state IN ('approved', 'rejected', 'conflict') AND decider_principal_id IS NOT NULL
      AND decider_kind = 'human' AND decided_ms IS NOT NULL AND cancelled_ms IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_workspace_change_requests_tab_state
  ON workspace_change_requests(isolation_domain_id, workspace_id, tab_id, state, created_ms);
CREATE TABLE IF NOT EXISTS workspace_change_request_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  isolation_domain_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  reason TEXT,
  created_ms INTEGER NOT NULL,
  FOREIGN KEY (isolation_domain_id, workspace_id, request_id)
    REFERENCES workspace_change_requests(isolation_domain_id, workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_change_request_events_transition
  ON workspace_change_request_events(
    isolation_domain_id,
    workspace_id,
    request_id,
    COALESCE(from_state, ''),
    to_state
  );
CREATE TRIGGER IF NOT EXISTS workspace_change_requests_payload_immutable
BEFORE UPDATE ON workspace_change_requests
WHEN NEW.isolation_domain_id IS NOT OLD.isolation_domain_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.id IS NOT OLD.id
  OR NEW.tab_id IS NOT OLD.tab_id
  OR NEW.requester_principal_id IS NOT OLD.requester_principal_id
  OR NEW.requester_kind IS NOT OLD.requester_kind
  OR NEW.delegation_id IS NOT OLD.delegation_id
  OR NEW.sponsor_principal_id IS NOT OLD.sponsor_principal_id
  OR NEW.base_tab_revision IS NOT OLD.base_tab_revision
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.proposal_json IS NOT OLD.proposal_json
  OR NEW.proposal_sha256 IS NOT OLD.proposal_sha256
  OR NEW.created_ms IS NOT OLD.created_ms
BEGIN
  SELECT RAISE(ABORT, 'workspace change request immutable payload cannot be changed');
END;
CREATE TRIGGER IF NOT EXISTS workspace_change_requests_transition_guard
BEFORE UPDATE OF state ON workspace_change_requests
WHEN OLD.state != 'pending'
  OR NEW.state NOT IN ('approved', 'rejected', 'cancelled', 'conflict')
BEGIN
  SELECT RAISE(ABORT, 'workspace change request terminal state cannot transition');
END;
CREATE TRIGGER IF NOT EXISTS workspace_change_requests_terminal_metadata_guard
BEFORE UPDATE OF decider_principal_id, decider_kind, decided_ms, decision_reason, cancelled_ms
ON workspace_change_requests
WHEN OLD.state != 'pending' OR NEW.state = OLD.state
BEGIN
  SELECT RAISE(ABORT, 'workspace change request terminal decision metadata cannot be changed');
END;
CREATE TRIGGER IF NOT EXISTS workspace_change_requests_delete_forbidden
BEFORE DELETE ON workspace_change_requests
BEGIN
  SELECT RAISE(ABORT, 'workspace change requests cannot be deleted');
END;
CREATE TRIGGER IF NOT EXISTS workspace_change_request_events_after_insert
AFTER INSERT ON workspace_change_requests
BEGIN
  INSERT INTO workspace_change_request_events (
    isolation_domain_id, workspace_id, request_id, from_state, to_state,
    actor_principal_id, actor_kind, reason, created_ms
  ) VALUES (
    NEW.isolation_domain_id, NEW.workspace_id, NEW.id, NULL, 'pending',
    NEW.requester_principal_id, NEW.requester_kind, NULL, NEW.created_ms
  );
END;
CREATE TRIGGER IF NOT EXISTS workspace_change_request_events_after_transition
AFTER UPDATE OF state ON workspace_change_requests
BEGIN
  INSERT INTO workspace_change_request_events (
    isolation_domain_id, workspace_id, request_id, from_state, to_state,
    actor_principal_id, actor_kind, reason, created_ms
  ) VALUES (
    NEW.isolation_domain_id, NEW.workspace_id, NEW.id, OLD.state, NEW.state,
    CASE WHEN NEW.state = 'cancelled' THEN NEW.requester_principal_id ELSE NEW.decider_principal_id END,
    CASE WHEN NEW.state = 'cancelled' THEN NEW.requester_kind ELSE NEW.decider_kind END,
    NEW.decision_reason,
    CASE WHEN NEW.state = 'cancelled' THEN NEW.cancelled_ms ELSE NEW.decided_ms END
  );
END;
CREATE TRIGGER IF NOT EXISTS workspace_change_request_events_insert_guard
BEFORE INSERT ON workspace_change_request_events
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_change_requests AS request
  WHERE request.isolation_domain_id = NEW.isolation_domain_id
    AND request.workspace_id = NEW.workspace_id
    AND request.id = NEW.request_id
    AND (
      (
        NEW.from_state IS NULL
        AND NEW.to_state = 'pending'
        AND request.state = 'pending'
        AND NEW.actor_principal_id = request.requester_principal_id
        AND NEW.actor_kind = request.requester_kind
        AND NEW.reason IS NULL
        AND NEW.created_ms = request.created_ms
      )
      OR
      (
        NEW.from_state = 'pending'
        AND NEW.to_state = request.state
        AND request.state IN ('approved', 'rejected', 'conflict', 'cancelled')
        AND NEW.actor_principal_id = CASE
          WHEN request.state = 'cancelled' THEN request.requester_principal_id
          ELSE request.decider_principal_id
        END
        AND NEW.actor_kind = CASE
          WHEN request.state = 'cancelled' THEN request.requester_kind
          ELSE request.decider_kind
        END
        AND NEW.reason IS request.decision_reason
        AND NEW.created_ms = CASE
          WHEN request.state = 'cancelled' THEN request.cancelled_ms
          ELSE request.decided_ms
        END
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'workspace change request audit event is invalid');
END;
CREATE TRIGGER IF NOT EXISTS workspace_change_request_events_update_forbidden
BEFORE UPDATE ON workspace_change_request_events
BEGIN
  SELECT RAISE(ABORT, 'workspace change request audit events are append-only');
END;
CREATE TRIGGER IF NOT EXISTS workspace_change_request_events_delete_forbidden
BEFORE DELETE ON workspace_change_request_events
BEGIN
  SELECT RAISE(ABORT, 'workspace change request audit events are append-only');
END;
`;

type SqliteTableColumn = { name: string };

type WorkspaceChangeRequestRow = {
  isolation_domain_id: string;
  workspace_id: string;
  id: string;
  tab_id: string;
  requester_principal_id: string;
  requester_kind: string;
  delegation_id: string | null;
  sponsor_principal_id: string | null;
  base_tab_revision: number;
  idempotency_key: string;
  proposal_json: string;
  proposal_sha256: string;
  state: string;
  created_ms: number;
  decider_principal_id: string | null;
  decider_kind: string | null;
  decided_ms: number | null;
  decision_reason: string | null;
  cancelled_ms: number | null;
};

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

function changeRequestFromRow(row: WorkspaceChangeRequestRow): WorkspaceChangeRequest {
  const requester = validateChangeRequestRequester({
    principalId: row.requester_principal_id,
    kind: row.requester_kind,
    ...(row.delegation_id === null ? {} : { delegationId: row.delegation_id }),
    ...(row.sponsor_principal_id === null ? {} : { sponsorPrincipalId: row.sponsor_principal_id }),
  });
  const decider =
    row.decider_principal_id === null
      ? undefined
      : validateHumanDecider({ principalId: row.decider_principal_id, kind: row.decider_kind });
  return Object.freeze({
    id: row.id,
    isolationDomainId: row.isolation_domain_id,
    workspaceId: row.workspace_id,
    tabId: row.tab_id,
    requester: Object.freeze(requester),
    baseTabRevision: row.base_tab_revision,
    idempotencyKey: row.idempotency_key,
    proposal: JSON.parse(row.proposal_json) as WorkspaceTabProposal,
    proposalSha256: row.proposal_sha256,
    state: parseChangeRequestState(row.state),
    createdAt: new Date(row.created_ms).toISOString(),
    ...(decider === undefined ? {} : { decider: Object.freeze(decider) }),
    ...(row.decided_ms === null ? {} : { decidedAt: new Date(row.decided_ms).toISOString() }),
    ...(row.decision_reason === null ? {} : { decisionReason: row.decision_reason }),
    ...(row.cancelled_ms === null ? {} : { cancelledAt: new Date(row.cancelled_ms).toISOString() }),
  });
}

function requesterMatches(left: WorkspaceRequester, right: WorkspaceRequester): boolean {
  return (
    left.principalId === right.principalId &&
    left.kind === right.kind &&
    (left.kind !== "agent" ||
      (right.kind === "agent" &&
        left.delegationId === right.delegationId &&
        left.sponsorPrincipalId === right.sponsorPrincipalId))
  );
}

function assertBaseTabRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("base tab revision must be a positive safe integer");
  }
  return value as number;
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

  createChangeRequest(input: CreateWorkspaceChangeRequestInput): WorkspaceChangeRequest {
    const id = validateChangeRequestId(input.id);
    const tabId = validateChangeRequestId(input.tabId, "tab id");
    const requester = validateChangeRequestRequester(input.requester);
    const baseTabRevision = assertBaseTabRevision(input.baseTabRevision);
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    return this.changeRequestTransaction(() => {
      const current = this.read();
      const tab = current.tabs.find((entry) => entry.id === tabId);
      if (!tab) {
        throw new Error(`workspace tab not found: ${tabId}`);
      }
      const canonical = reconcileChangeRequestProposal({
        proposal: input.proposal,
        current,
        tab,
        requester,
      }).proposal;
      const proposalJson = JSON.stringify(canonical);
      const proposalSha256 = hashChangeRequestProposal(canonical);
      const existing = this.db
        .prepare(
          `SELECT * FROM workspace_change_requests
           WHERE isolation_domain_id = ? AND workspace_id = ?
             AND requester_principal_id = ? AND requester_kind = ? AND idempotency_key = ?`,
        )
        .get(
          this.isolationDomainId,
          this.workspaceId,
          requester.principalId,
          requester.kind,
          idempotencyKey,
        ) as WorkspaceChangeRequestRow | undefined;
      if (existing) {
        const existingRequest = changeRequestFromRow(existing);
        const samePayload =
          existing.tab_id === tabId &&
          existing.base_tab_revision === baseTabRevision &&
          existing.proposal_sha256 === proposalSha256 &&
          existing.proposal_json === proposalJson &&
          requesterMatches(existingRequest.requester, requester);
        if (!samePayload) {
          throw new Error("idempotency key already belongs to a different change request payload");
        }
        return existingRequest;
      }
      const createdMs = Date.now();
      this.db
        .prepare(
          `INSERT INTO workspace_change_requests (
            isolation_domain_id, workspace_id, id, tab_id,
            requester_principal_id, requester_kind, delegation_id, sponsor_principal_id,
            base_tab_revision, idempotency_key, proposal_json, proposal_sha256, state, created_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          this.isolationDomainId,
          this.workspaceId,
          id,
          tabId,
          requester.principalId,
          requester.kind,
          requester.kind === "agent" ? (requester.delegationId ?? null) : null,
          requester.kind === "agent" ? (requester.sponsorPrincipalId ?? null) : null,
          baseTabRevision,
          idempotencyKey,
          proposalJson,
          proposalSha256,
          createdMs,
        );
      return this.requireChangeRequest(id);
    });
  }

  readChangeRequest(id: string): WorkspaceChangeRequest | null {
    const canonicalId = validateChangeRequestId(id);
    const row = this.selectChangeRequest(canonicalId);
    return row ? changeRequestFromRow(row) : null;
  }

  listChangeRequests(filter: WorkspaceChangeRequestListFilter = {}): WorkspaceChangeRequest[] {
    const clauses = ["isolation_domain_id = ?", "workspace_id = ?"];
    const values: Array<string> = [this.isolationDomainId, this.workspaceId];
    if (filter.tabId !== undefined) {
      clauses.push("tab_id = ?");
      values.push(validateChangeRequestId(filter.tabId, "tab id"));
    }
    if (filter.state !== undefined) {
      clauses.push("state = ?");
      values.push(parseChangeRequestState(filter.state));
    }
    if (filter.requesterPrincipalId !== undefined) {
      clauses.push("requester_principal_id = ?");
      values.push(filter.requesterPrincipalId);
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM workspace_change_requests
           WHERE ${clauses.join(" AND ")} ORDER BY created_ms, id`,
        )
        .all(...values) as unknown as WorkspaceChangeRequestRow[]
    ).map(changeRequestFromRow);
  }

  cancelChangeRequest(input: CancelWorkspaceChangeRequestInput): WorkspaceChangeRequest {
    const id = validateChangeRequestId(input.id);
    const requester = validateChangeRequestRequester(input.requester);
    return this.changeRequestTransaction(() => {
      const request = changeRequestFromRow(this.requireChangeRequestRow(id));
      if (!requesterMatches(request.requester, requester)) {
        throw new Error("only the request creator can cancel a change request");
      }
      if (request.state !== "pending") {
        throw new Error(`change request is already terminal: ${request.state}`);
      }
      this.db
        .prepare(
          `UPDATE workspace_change_requests SET state = 'cancelled', cancelled_ms = ?
           WHERE isolation_domain_id = ? AND workspace_id = ? AND id = ?`,
        )
        .run(Date.now(), this.isolationDomainId, this.workspaceId, id);
      return this.requireChangeRequest(id);
    });
  }

  decideChangeRequest(
    input: DecideWorkspaceChangeRequestInput,
  ): WorkspaceChangeRequestDecisionResult {
    const id = validateChangeRequestId(input.id);
    const decider = validateHumanDecider(input.decider);
    const reason = validateDecisionReason(input.reason);
    if (input.decision !== "approved" && input.decision !== "rejected") {
      throw new Error("change request decision is invalid");
    }
    return this.changeRequestTransaction(() => {
      const current = this.read();
      const request = this.requireChangeRequest(id);
      if (request.state !== "pending") {
        throw new Error(`change request is already terminal: ${request.state}`);
      }
      const tab = current.tabs.find((entry) => entry.id === request.tabId);
      const revisionMatches = tab?.revision === request.baseTabRevision;
      if (input.decision === "approved" && !revisionMatches) {
        const conflictReason = tab
          ? `tab revision changed from ${request.baseTabRevision} to ${tab.revision}`
          : "workspace tab no longer exists";
        this.setChangeRequestDecision(id, "conflict", decider.principalId, conflictReason);
        return { request: this.requireChangeRequest(id), doc: current, applied: false };
      }
      if (input.decision === "rejected") {
        this.setChangeRequestDecision(id, "rejected", decider.principalId, reason);
        return { request: this.requireChangeRequest(id), doc: current, applied: false };
      }
      if (!tab) {
        throw new Error(`workspace tab not found: ${request.tabId}`);
      }
      const reconciled = reconcileChangeRequestProposal({
        proposal: request.proposal,
        current,
        tab,
        requester: request.requester,
      }).doc;
      const tabs = structuredClone(reconciled.tabs);
      const approvedTab = tabs.find((entry) => entry.id === tab.id);
      if (!approvedTab) {
        throw new Error(`workspace tab not found: ${request.tabId}`);
      }
      approvedTab.revision = tab.revision + 1;
      const next = validateWorkspaceDoc({
        ...reconciled,
        workspaceVersion: current.workspaceVersion + 1,
        tabs,
      });
      this.commit(next, { snapshot: null });
      this.setChangeRequestDecision(id, "approved", decider.principalId, reason);
      return { request: this.requireChangeRequest(id), doc: next, applied: true };
    });
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
      const nextIds = new Set(derived.tabs.map((tab) => tab.id));
      const removedAt = Date.now();
      for (const tab of current.tabs) {
        if (!nextIds.has(tab.id)) {
          this.db
            .prepare(
              `INSERT OR IGNORE INTO workspace_tab_id_tombstones
                (isolation_domain_id, workspace_id, tab_id, removed_ms)
               VALUES (?, ?, ?, ?)`,
            )
            .run(this.isolationDomainId, this.workspaceId, tab.id, removedAt);
        }
      }
      const tombstones = new Set(
        (
          this.db
            .prepare(
              `SELECT tab_id FROM workspace_tab_id_tombstones
               WHERE isolation_domain_id = ? AND workspace_id = ?`,
            )
            .all(this.isolationDomainId, this.workspaceId) as Array<{ tab_id: string }>
        ).map((row) => row.tab_id),
      );
      const currentIds = new Set(current.tabs.map((tab) => tab.id));
      const rekeyed: WorkspaceDoc = {
        ...derived,
        tabs: derived.tabs.map((tab) => {
          if (currentIds.has(tab.id) || !tombstones.has(tab.id)) {
            return tab;
          }
          const restored = structuredClone(tab);
          restored.id = randomUUID();
          restored.revision = 1;
          return restored;
        }),
      };
      assertStableResourceIds(current, rekeyed);
      const revised = stampTabRevisions(current, rekeyed);
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

  private changeRequestTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // The transaction owns freshness. Another WorkspaceStore process may have
      // committed since this instance populated its read cache.
      this.cached = null;
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.cached = null;
      throw error;
    }
  }

  private selectChangeRequest(id: string): WorkspaceChangeRequestRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM workspace_change_requests
         WHERE isolation_domain_id = ? AND workspace_id = ? AND id = ?`,
      )
      .get(this.isolationDomainId, this.workspaceId, id) as WorkspaceChangeRequestRow | undefined;
  }

  private requireChangeRequestRow(id: string): WorkspaceChangeRequestRow {
    const row = this.selectChangeRequest(id);
    if (!row) {
      throw new Error(`workspace change request not found: ${id}`);
    }
    return row;
  }

  private requireChangeRequest(id: string): WorkspaceChangeRequest {
    return changeRequestFromRow(this.requireChangeRequestRow(id));
  }

  private setChangeRequestDecision(
    id: string,
    state: "approved" | "rejected" | "conflict",
    deciderPrincipalId: string,
    reason?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE workspace_change_requests SET
          state = ?, decider_principal_id = ?, decider_kind = 'human',
          decided_ms = ?, decision_reason = ?
         WHERE isolation_domain_id = ? AND workspace_id = ? AND id = ?`,
      )
      .run(
        state,
        deciderPrincipalId,
        Date.now(),
        reason ?? null,
        this.isolationDomainId,
        this.workspaceId,
        id,
      );
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
