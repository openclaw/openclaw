import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { i as formatErrorMessage } from "./errors-ixwfrboQ.js";
import { c as isRecord } from "./utils-CpmNtyoq.js";
import { t as createSubsystemLogger } from "./subsystem-CwZgZA6E.js";
import { n as requireNodeSqlite, t as configureSqliteWalMaintenance } from "./sqlite-wal-Bx4wdSbF.js";
import { i as normalizeDeliveryContext } from "./delivery-context.shared-CzkDqCEX.js";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { isMainThread, threadId } from "node:worker_threads";
//#region src/tasks/task-registry.paths.ts
function resolveTaskStateDir(env = process.env) {
	if (env.OPENCLAW_STATE_DIR?.trim()) return resolveStateDir(env);
	if (env.VITEST || env.NODE_ENV === "test") {
		const workerIdRaw = env.VITEST_WORKER_ID ?? env.VITEST_POOL_ID ?? "";
		const workerId = Number.parseInt(workerIdRaw, 10);
		const shardSuffix = Number.isFinite(workerId) ? `${process.pid}-${workerId}` : isMainThread ? String(process.pid) : `${process.pid}-${threadId}`;
		return path.join(os.tmpdir(), "openclaw-test-state", shardSuffix);
	}
	return resolveStateDir(env);
}
function resolveTaskRegistryDir(env = process.env) {
	return path.join(resolveTaskStateDir(env), "tasks");
}
function resolveTaskRegistrySqlitePath(env = process.env) {
	return path.join(resolveTaskRegistryDir(env), "runs.sqlite");
}
//#endregion
//#region src/tasks/task-flow-registry.paths.ts
function resolveTaskFlowRegistryDir(env = process.env) {
	return path.join(resolveTaskStateDir(env), "flows");
}
function resolveTaskFlowRegistrySqlitePath(env = process.env) {
	return path.join(resolveTaskFlowRegistryDir(env), "registry.sqlite");
}
//#endregion
//#region src/tasks/task-flow-registry.store.sqlite.ts
let cachedDatabase = null;
const FLOW_REGISTRY_DIR_MODE = 448;
const FLOW_REGISTRY_FILE_MODE = 384;
const FLOW_REGISTRY_SIDECAR_SUFFIXES = [
	"",
	"-shm",
	"-wal"
];
function normalizeNumber(value) {
	if (typeof value === "bigint") return Number(value);
	return typeof value === "number" ? value : void 0;
}
function serializeJson(value) {
	return value === void 0 ? null : JSON.stringify(value);
}
function parseJsonValue(raw) {
	if (!raw?.trim()) return;
	try {
		return JSON.parse(raw);
	} catch {
		return;
	}
}
function parseDeliveryContextJson(raw) {
	const parsed = parseJsonValue(raw);
	if (!isRecord(parsed)) return;
	return normalizeDeliveryContext({
		channel: typeof parsed.channel === "string" ? parsed.channel : void 0,
		to: typeof parsed.to === "string" ? parsed.to : void 0,
		accountId: typeof parsed.accountId === "string" ? parsed.accountId : void 0,
		threadId: typeof parsed.threadId === "string" || typeof parsed.threadId === "number" ? parsed.threadId : void 0
	});
}
function rowToSyncMode(row) {
	if (row.sync_mode === "task_mirrored" || row.sync_mode === "managed") return row.sync_mode;
	return row.shape === "single_task" ? "task_mirrored" : "managed";
}
function rowToFlowRecord(row) {
	const endedAt = normalizeNumber(row.ended_at);
	const cancelRequestedAt = normalizeNumber(row.cancel_requested_at);
	const requesterOrigin = parseDeliveryContextJson(row.requester_origin_json);
	const stateJson = parseJsonValue(row.state_json);
	const waitJson = parseJsonValue(row.wait_json);
	return {
		flowId: row.flow_id,
		syncMode: rowToSyncMode(row),
		ownerKey: row.owner_key,
		...row.chain_id ? { chainId: row.chain_id } : {},
		...requesterOrigin ? { requesterOrigin } : {},
		...row.controller_id ? { controllerId: row.controller_id } : {},
		revision: normalizeNumber(row.revision) ?? 0,
		status: row.status,
		notifyPolicy: row.notify_policy,
		goal: row.goal,
		...row.current_step ? { currentStep: row.current_step } : {},
		...row.blocked_task_id ? { blockedTaskId: row.blocked_task_id } : {},
		...row.blocked_summary ? { blockedSummary: row.blocked_summary } : {},
		...stateJson !== void 0 ? { stateJson } : {},
		...waitJson !== void 0 ? { waitJson } : {},
		...cancelRequestedAt != null ? { cancelRequestedAt } : {},
		createdAt: normalizeNumber(row.created_at) ?? 0,
		updatedAt: normalizeNumber(row.updated_at) ?? 0,
		...endedAt != null ? { endedAt } : {}
	};
}
function bindFlowRecord(record) {
	return {
		flow_id: record.flowId,
		sync_mode: record.syncMode,
		owner_key: record.ownerKey,
		chain_id: record.chainId ?? null,
		requester_origin_json: serializeJson(record.requesterOrigin),
		controller_id: record.controllerId ?? null,
		revision: record.revision,
		status: record.status,
		notify_policy: record.notifyPolicy,
		goal: record.goal,
		current_step: record.currentStep ?? null,
		blocked_task_id: record.blockedTaskId ?? null,
		blocked_summary: record.blockedSummary ?? null,
		state_json: serializeJson(record.stateJson),
		wait_json: serializeJson(record.waitJson),
		cancel_requested_at: record.cancelRequestedAt ?? null,
		created_at: record.createdAt,
		updated_at: record.updatedAt,
		ended_at: record.endedAt ?? null
	};
}
function createStatements(db) {
	return {
		selectAll: db.prepare(`
      SELECT
        flow_id,
        sync_mode,
        shape,
        owner_key,
        chain_id,
        requester_origin_json,
        controller_id,
        revision,
        status,
        notify_policy,
        goal,
        current_step,
        blocked_task_id,
        blocked_summary,
        state_json,
        wait_json,
        cancel_requested_at,
        created_at,
        updated_at,
        ended_at
      FROM flow_runs
      ORDER BY created_at ASC, flow_id ASC
    `),
		upsertRow: db.prepare(`
      INSERT INTO flow_runs (
        flow_id,
        sync_mode,
        owner_key,
        chain_id,
        requester_origin_json,
        controller_id,
        revision,
        status,
        notify_policy,
        goal,
        current_step,
        blocked_task_id,
        blocked_summary,
        state_json,
        wait_json,
        cancel_requested_at,
        created_at,
        updated_at,
        ended_at
      ) VALUES (
        @flow_id,
        @sync_mode,
        @owner_key,
        @chain_id,
        @requester_origin_json,
        @controller_id,
        @revision,
        @status,
        @notify_policy,
        @goal,
        @current_step,
        @blocked_task_id,
        @blocked_summary,
        @state_json,
        @wait_json,
        @cancel_requested_at,
        @created_at,
        @updated_at,
        @ended_at
      )
      ON CONFLICT(flow_id) DO UPDATE SET
        sync_mode = excluded.sync_mode,
        owner_key = excluded.owner_key,
        -- chain_id is intentionally NOT updated on conflict:
        -- chain_id is set-once at create-time and represents the originating
        -- continuation chain; UPDATE-on-hop is deferred-by-design so that the
        -- column remains a stable audit-correlation key.
        requester_origin_json = excluded.requester_origin_json,
        controller_id = excluded.controller_id,
        revision = excluded.revision,
        status = excluded.status,
        notify_policy = excluded.notify_policy,
        goal = excluded.goal,
        current_step = excluded.current_step,
        blocked_task_id = excluded.blocked_task_id,
        blocked_summary = excluded.blocked_summary,
        state_json = excluded.state_json,
        wait_json = excluded.wait_json,
        cancel_requested_at = excluded.cancel_requested_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        ended_at = excluded.ended_at
    `),
		deleteRow: db.prepare(`DELETE FROM flow_runs WHERE flow_id = ?`),
		clearRows: db.prepare(`DELETE FROM flow_runs`)
	};
}
function hasFlowRunsColumn(db, columnName) {
	return db.prepare(`PRAGMA table_info(flow_runs)`).all().some((row) => row.name === columnName);
}
function ensureSchema(db) {
	db.exec(`
    CREATE TABLE IF NOT EXISTS flow_runs (
      flow_id TEXT PRIMARY KEY,
      shape TEXT,
      sync_mode TEXT NOT NULL DEFAULT 'managed',
      owner_key TEXT NOT NULL,
      requester_origin_json TEXT,
      controller_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      notify_policy TEXT NOT NULL,
      goal TEXT NOT NULL,
      current_step TEXT,
      blocked_task_id TEXT,
      blocked_summary TEXT,
      state_json TEXT,
      wait_json TEXT,
      cancel_requested_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER,
      chain_id TEXT
    );
  `);
	if (!hasFlowRunsColumn(db, "owner_key") && hasFlowRunsColumn(db, "owner_session_key")) {
		db.exec(`ALTER TABLE flow_runs ADD COLUMN owner_key TEXT;`);
		db.exec(`
      UPDATE flow_runs
      SET owner_key = owner_session_key
      WHERE owner_key IS NULL
    `);
	}
	if (!hasFlowRunsColumn(db, "shape")) db.exec(`ALTER TABLE flow_runs ADD COLUMN shape TEXT;`);
	if (!hasFlowRunsColumn(db, "sync_mode")) {
		db.exec(`ALTER TABLE flow_runs ADD COLUMN sync_mode TEXT;`);
		if (hasFlowRunsColumn(db, "shape")) db.exec(`
        UPDATE flow_runs
        SET sync_mode = CASE
          WHEN shape = 'single_task' THEN 'task_mirrored'
          ELSE 'managed'
        END
        WHERE sync_mode IS NULL
      `);
		else db.exec(`
        UPDATE flow_runs
        SET sync_mode = 'managed'
        WHERE sync_mode IS NULL
      `);
	}
	if (!hasFlowRunsColumn(db, "controller_id")) db.exec(`ALTER TABLE flow_runs ADD COLUMN controller_id TEXT;`);
	db.exec(`
    UPDATE flow_runs
    SET controller_id = 'core/legacy-restored'
    WHERE sync_mode = 'managed'
      AND (controller_id IS NULL OR trim(controller_id) = '')
  `);
	if (!hasFlowRunsColumn(db, "revision")) {
		db.exec(`ALTER TABLE flow_runs ADD COLUMN revision INTEGER;`);
		db.exec(`
      UPDATE flow_runs
      SET revision = 0
      WHERE revision IS NULL
    `);
	}
	if (!hasFlowRunsColumn(db, "blocked_task_id")) db.exec(`ALTER TABLE flow_runs ADD COLUMN blocked_task_id TEXT;`);
	if (!hasFlowRunsColumn(db, "blocked_summary")) db.exec(`ALTER TABLE flow_runs ADD COLUMN blocked_summary TEXT;`);
	if (!hasFlowRunsColumn(db, "state_json")) db.exec(`ALTER TABLE flow_runs ADD COLUMN state_json TEXT;`);
	if (!hasFlowRunsColumn(db, "wait_json")) db.exec(`ALTER TABLE flow_runs ADD COLUMN wait_json TEXT;`);
	if (!hasFlowRunsColumn(db, "cancel_requested_at")) db.exec(`ALTER TABLE flow_runs ADD COLUMN cancel_requested_at INTEGER;`);
	if (!hasFlowRunsColumn(db, "chain_id")) db.exec(`ALTER TABLE flow_runs ADD COLUMN chain_id TEXT;`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_runs_status ON flow_runs(status);`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_runs_owner_key ON flow_runs(owner_key);`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_runs_updated_at ON flow_runs(updated_at);`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_runs_chain_id ON flow_runs(chain_id);`);
}
function ensureFlowRegistryPermissions(pathname) {
	const dir = resolveTaskFlowRegistryDir(process.env);
	mkdirSync(dir, {
		recursive: true,
		mode: FLOW_REGISTRY_DIR_MODE
	});
	chmodSync(dir, FLOW_REGISTRY_DIR_MODE);
	for (const suffix of FLOW_REGISTRY_SIDECAR_SUFFIXES) {
		const candidate = `${pathname}${suffix}`;
		if (!existsSync(candidate)) continue;
		chmodSync(candidate, FLOW_REGISTRY_FILE_MODE);
	}
}
function openFlowRegistryDatabase() {
	const pathname = resolveTaskFlowRegistrySqlitePath(process.env);
	if (cachedDatabase && cachedDatabase.path === pathname) return cachedDatabase;
	if (cachedDatabase) {
		cachedDatabase.walMaintenance.close();
		cachedDatabase.db.close();
		cachedDatabase = null;
	}
	ensureFlowRegistryPermissions(pathname);
	const { DatabaseSync } = requireNodeSqlite();
	const db = new DatabaseSync(pathname);
	const walMaintenance = configureSqliteWalMaintenance(db);
	db.exec(`PRAGMA synchronous = NORMAL;`);
	db.exec(`PRAGMA busy_timeout = 5000;`);
	ensureSchema(db);
	ensureFlowRegistryPermissions(pathname);
	cachedDatabase = {
		db,
		path: pathname,
		statements: createStatements(db),
		walMaintenance
	};
	return cachedDatabase;
}
function withWriteTransaction(write) {
	const { db, path, statements } = openFlowRegistryDatabase();
	db.exec("BEGIN IMMEDIATE");
	try {
		write(statements);
		db.exec("COMMIT");
		ensureFlowRegistryPermissions(path);
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
function loadTaskFlowRegistryStateFromSqlite() {
	const { statements } = openFlowRegistryDatabase();
	const rows = statements.selectAll.all();
	return { flows: new Map(rows.map((row) => [row.flow_id, rowToFlowRecord(row)])) };
}
function saveTaskFlowRegistryStateToSqlite(snapshot) {
	withWriteTransaction((statements) => {
		statements.clearRows.run();
		for (const flow of snapshot.flows.values()) statements.upsertRow.run(bindFlowRecord(flow));
	});
}
function upsertTaskFlowRegistryRecordToSqlite(flow) {
	const store = openFlowRegistryDatabase();
	store.statements.upsertRow.run(bindFlowRecord(flow));
	ensureFlowRegistryPermissions(store.path);
}
function deleteTaskFlowRegistryRecordFromSqlite(flowId) {
	const store = openFlowRegistryDatabase();
	store.statements.deleteRow.run(flowId);
	ensureFlowRegistryPermissions(store.path);
}
function closeTaskFlowRegistrySqliteStore() {
	if (!cachedDatabase) return;
	cachedDatabase.walMaintenance.close();
	cachedDatabase.db.close();
	cachedDatabase = null;
}
let configuredFlowRegistryStore = {
	loadSnapshot: loadTaskFlowRegistryStateFromSqlite,
	saveSnapshot: saveTaskFlowRegistryStateToSqlite,
	upsertFlow: upsertTaskFlowRegistryRecordToSqlite,
	deleteFlow: deleteTaskFlowRegistryRecordFromSqlite,
	close: closeTaskFlowRegistrySqliteStore
};
let configuredFlowRegistryObservers = null;
function getTaskFlowRegistryStore() {
	return configuredFlowRegistryStore;
}
function getTaskFlowRegistryObservers() {
	return configuredFlowRegistryObservers;
}
//#endregion
//#region src/tasks/task-flow-registry.ts
const log = createSubsystemLogger("tasks/task-flow-registry");
const flows = /* @__PURE__ */ new Map();
let restoreAttempted = false;
let restoreFailureMessage = null;
function cloneStructuredValue(value) {
	if (value === void 0) return;
	return structuredClone(value);
}
function cloneFlowRecord(record) {
	return {
		...record,
		...record.requesterOrigin ? { requesterOrigin: cloneStructuredValue(record.requesterOrigin) } : {},
		...record.stateJson !== void 0 ? { stateJson: cloneStructuredValue(record.stateJson) } : {},
		...record.waitJson !== void 0 ? { waitJson: cloneStructuredValue(record.waitJson) } : {}
	};
}
function normalizeRestoredFlowRecord(record) {
	const syncMode = record.syncMode === "task_mirrored" ? "task_mirrored" : "managed";
	const controllerId = syncMode === "managed" ? normalizeOptionalString(record.controllerId) ?? "core/legacy-restored" : void 0;
	return {
		...record,
		syncMode,
		ownerKey: assertFlowOwnerKey(record.ownerKey),
		...record.chainId ? { chainId: record.chainId } : {},
		...record.requesterOrigin ? { requesterOrigin: cloneStructuredValue(record.requesterOrigin) } : {},
		...controllerId ? { controllerId } : {},
		currentStep: normalizeOptionalString(record.currentStep),
		blockedTaskId: normalizeOptionalString(record.blockedTaskId),
		blockedSummary: normalizeOptionalString(record.blockedSummary),
		...record.stateJson !== void 0 ? { stateJson: cloneStructuredValue(record.stateJson) } : {},
		...record.waitJson !== void 0 ? { waitJson: cloneStructuredValue(record.waitJson) } : {},
		revision: Math.max(0, record.revision),
		cancelRequestedAt: record.cancelRequestedAt ?? void 0,
		endedAt: record.endedAt ?? void 0
	};
}
function snapshotFlowRecords(source) {
	return [...source.values()].map((record) => cloneFlowRecord(record));
}
function emitFlowRegistryObserverEvent(createEvent) {
	const observers = getTaskFlowRegistryObservers();
	if (!observers?.onEvent) return;
	try {
		observers.onEvent(createEvent());
	} catch {}
}
function ensureNotifyPolicy(notifyPolicy) {
	return notifyPolicy ?? "done_only";
}
function normalizeJsonBlob(value) {
	return value === void 0 ? void 0 : cloneStructuredValue(value);
}
function assertFlowOwnerKey(ownerKey) {
	const normalized = normalizeOptionalString(ownerKey);
	if (!normalized) throw new Error("Flow ownerKey is required.");
	return normalized;
}
function assertControllerId(controllerId) {
	const normalized = normalizeOptionalString(controllerId);
	if (!normalized) throw new Error("Managed flow controllerId is required.");
	return normalized;
}
function resolveFlowBlockedSummary(task) {
	if (task.status !== "succeeded" || task.terminalOutcome !== "blocked") return;
	return normalizeOptionalString(task.terminalSummary) ?? normalizeOptionalString(task.progressSummary);
}
function deriveTaskFlowStatusFromTask(task) {
	if (task.status === "queued") return "queued";
	if (task.status === "running") return "running";
	if (task.status === "succeeded") return task.terminalOutcome === "blocked" ? "blocked" : "succeeded";
	if (task.status === "cancelled") return "cancelled";
	if (task.status === "lost") return "lost";
	return "failed";
}
function isTerminalTaskFlowStatus(status) {
	return status === "succeeded" || status === "blocked" || status === "failed" || status === "cancelled" || status === "lost";
}
function resolveTaskMirroredFlowTiming(task, isTerminal) {
	if (!isTerminal) return { updatedAt: task.lastEventAt ?? task.createdAt };
	const endedAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
	return {
		updatedAt: endedAt,
		endedAt
	};
}
function ensureFlowRegistryReady() {
	if (restoreAttempted) return;
	restoreAttempted = true;
	try {
		const restored = getTaskFlowRegistryStore().loadSnapshot();
		flows.clear();
		for (const [flowId, flow] of restored.flows) flows.set(flowId, normalizeRestoredFlowRecord(flow));
		restoreFailureMessage = null;
	} catch (error) {
		flows.clear();
		restoreFailureMessage = formatErrorMessage(error);
		log.warn("Failed to restore task-flow registry", { error });
		return;
	}
	emitFlowRegistryObserverEvent(() => ({
		kind: "restored",
		flows: snapshotFlowRecords(flows)
	}));
}
function getTaskFlowRegistryRestoreFailure() {
	ensureFlowRegistryReady();
	return restoreFailureMessage;
}
function persistFlowRegistry() {
	getTaskFlowRegistryStore().saveSnapshot({ flows: new Map(snapshotFlowRecords(flows).map((flow) => [flow.flowId, flow])) });
}
function persistFlowUpsert(flow) {
	const store = getTaskFlowRegistryStore();
	if (store.upsertFlow) {
		store.upsertFlow(cloneFlowRecord(flow));
		return;
	}
	persistFlowRegistry();
}
function persistFlowDelete(flowId) {
	const store = getTaskFlowRegistryStore();
	if (store.deleteFlow) {
		store.deleteFlow(flowId);
		return;
	}
	persistFlowRegistry();
}
function buildFlowRecord(params) {
	const now = params.createdAt ?? Date.now();
	const syncMode = params.syncMode ?? "managed";
	const controllerId = syncMode === "managed" ? assertControllerId(params.controllerId) : void 0;
	const chainId = normalizeOptionalString(params.chainId);
	return {
		flowId: crypto.randomUUID(),
		syncMode,
		ownerKey: assertFlowOwnerKey(params.ownerKey),
		...chainId ? { chainId } : {},
		...params.requesterOrigin ? { requesterOrigin: cloneStructuredValue(params.requesterOrigin) } : {},
		...controllerId ? { controllerId } : {},
		revision: Math.max(0, params.revision ?? 0),
		status: params.status ?? "queued",
		notifyPolicy: ensureNotifyPolicy(params.notifyPolicy),
		goal: params.goal,
		currentStep: normalizeOptionalString(params.currentStep),
		blockedTaskId: normalizeOptionalString(params.blockedTaskId),
		blockedSummary: normalizeOptionalString(params.blockedSummary),
		...normalizeJsonBlob(params.stateJson) !== void 0 ? { stateJson: normalizeJsonBlob(params.stateJson) } : {},
		...normalizeJsonBlob(params.waitJson) !== void 0 ? { waitJson: normalizeJsonBlob(params.waitJson) } : {},
		...params.cancelRequestedAt != null ? { cancelRequestedAt: params.cancelRequestedAt } : {},
		createdAt: now,
		updatedAt: params.updatedAt ?? now,
		...params.endedAt != null ? { endedAt: params.endedAt } : {}
	};
}
function applyFlowPatch(current, patch) {
	const controllerId = patch.controllerId === void 0 ? current.controllerId : normalizeOptionalString(patch.controllerId);
	if (current.syncMode === "managed") assertControllerId(controllerId);
	return {
		...current,
		...patch.status ? { status: patch.status } : {},
		...patch.notifyPolicy ? { notifyPolicy: patch.notifyPolicy } : {},
		...patch.goal ? { goal: patch.goal } : {},
		controllerId,
		currentStep: patch.currentStep === void 0 ? current.currentStep : normalizeOptionalString(patch.currentStep),
		blockedTaskId: patch.blockedTaskId === void 0 ? current.blockedTaskId : normalizeOptionalString(patch.blockedTaskId),
		blockedSummary: patch.blockedSummary === void 0 ? current.blockedSummary : normalizeOptionalString(patch.blockedSummary),
		stateJson: patch.stateJson === void 0 ? current.stateJson : normalizeJsonBlob(patch.stateJson),
		waitJson: patch.waitJson === void 0 ? current.waitJson : normalizeJsonBlob(patch.waitJson),
		cancelRequestedAt: patch.cancelRequestedAt === void 0 ? current.cancelRequestedAt : patch.cancelRequestedAt ?? void 0,
		revision: current.revision + 1,
		updatedAt: patch.updatedAt ?? Date.now(),
		endedAt: patch.endedAt === void 0 ? current.endedAt : patch.endedAt ?? void 0
	};
}
function writeFlowRecord(next, previous) {
	flows.set(next.flowId, next);
	persistFlowUpsert(next);
	emitFlowRegistryObserverEvent(() => ({
		kind: "upserted",
		flow: cloneFlowRecord(next),
		...previous ? { previous: cloneFlowRecord(previous) } : {}
	}));
	return cloneFlowRecord(next);
}
function createFlowRecord(params) {
	ensureFlowRegistryReady();
	return writeFlowRecord(buildFlowRecord(params));
}
function createManagedTaskFlow(params) {
	return createFlowRecord({
		...params,
		syncMode: "managed",
		controllerId: assertControllerId(params.controllerId)
	});
}
function createTaskFlowForTask(params) {
	const terminalFlowStatus = deriveTaskFlowStatusFromTask(params.task);
	const timing = resolveTaskMirroredFlowTiming(params.task, isTerminalTaskFlowStatus(terminalFlowStatus));
	return createFlowRecord({
		syncMode: "task_mirrored",
		ownerKey: params.task.ownerKey,
		requesterOrigin: params.requesterOrigin,
		status: terminalFlowStatus,
		notifyPolicy: params.task.notifyPolicy,
		goal: normalizeOptionalString(params.task.label) ?? (params.task.task.trim() || "Background task"),
		blockedTaskId: terminalFlowStatus === "blocked" ? normalizeOptionalString(params.task.taskId) : void 0,
		blockedSummary: resolveFlowBlockedSummary(params.task),
		createdAt: params.task.createdAt,
		updatedAt: timing.updatedAt,
		...timing.endedAt !== void 0 ? { endedAt: timing.endedAt } : {}
	});
}
function updateFlowRecordByIdUnchecked(flowId, patch) {
	ensureFlowRegistryReady();
	const current = flows.get(flowId);
	if (!current) return null;
	return writeFlowRecord(applyFlowPatch(current, patch), current);
}
function updateFlowRecordByIdExpectedRevision(params) {
	ensureFlowRegistryReady();
	const current = flows.get(params.flowId);
	if (!current) return {
		applied: false,
		reason: "not_found"
	};
	if (current.revision !== params.expectedRevision) return {
		applied: false,
		reason: "revision_conflict",
		current: cloneFlowRecord(current)
	};
	return {
		applied: true,
		flow: writeFlowRecord(applyFlowPatch(current, params.patch), current)
	};
}
function setFlowWaiting(params) {
	return updateFlowRecordByIdExpectedRevision({
		flowId: params.flowId,
		expectedRevision: params.expectedRevision,
		patch: {
			status: normalizeOptionalString(params.blockedTaskId) || normalizeOptionalString(params.blockedSummary) ? "blocked" : "waiting",
			currentStep: params.currentStep,
			stateJson: params.stateJson,
			waitJson: params.waitJson,
			blockedTaskId: params.blockedTaskId,
			blockedSummary: params.blockedSummary,
			endedAt: null,
			updatedAt: params.updatedAt
		}
	});
}
function resumeFlow(params) {
	return updateFlowRecordByIdExpectedRevision({
		flowId: params.flowId,
		expectedRevision: params.expectedRevision,
		patch: {
			status: params.status ?? "queued",
			currentStep: params.currentStep,
			stateJson: params.stateJson,
			waitJson: null,
			blockedTaskId: null,
			blockedSummary: null,
			endedAt: null,
			updatedAt: params.updatedAt
		}
	});
}
function finishFlow(params) {
	const endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
	return updateFlowRecordByIdExpectedRevision({
		flowId: params.flowId,
		expectedRevision: params.expectedRevision,
		patch: {
			status: "succeeded",
			currentStep: params.currentStep,
			stateJson: params.stateJson,
			waitJson: null,
			blockedTaskId: null,
			blockedSummary: null,
			endedAt,
			updatedAt: params.updatedAt ?? endedAt
		}
	});
}
function failFlow(params) {
	const endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
	return updateFlowRecordByIdExpectedRevision({
		flowId: params.flowId,
		expectedRevision: params.expectedRevision,
		patch: {
			status: "failed",
			currentStep: params.currentStep,
			stateJson: params.stateJson,
			waitJson: null,
			blockedTaskId: params.blockedTaskId,
			blockedSummary: params.blockedSummary,
			endedAt,
			updatedAt: params.updatedAt ?? endedAt
		}
	});
}
function requestFlowCancel(params) {
	return updateFlowRecordByIdExpectedRevision({
		flowId: params.flowId,
		expectedRevision: params.expectedRevision,
		patch: {
			cancelRequestedAt: params.cancelRequestedAt ?? params.updatedAt ?? Date.now(),
			updatedAt: params.updatedAt
		}
	});
}
function syncFlowFromTask(task) {
	const flowId = task.parentFlowId?.trim();
	if (!flowId) return null;
	const flow = getTaskFlowById(flowId);
	if (!flow) return null;
	if (flow.syncMode !== "task_mirrored") return flow;
	const terminalFlowStatus = deriveTaskFlowStatusFromTask(task);
	const isTerminal = isTerminalTaskFlowStatus(terminalFlowStatus);
	const timing = resolveTaskMirroredFlowTiming({
		createdAt: flow.createdAt,
		lastEventAt: task.lastEventAt,
		endedAt: task.endedAt
	}, isTerminal);
	return updateFlowRecordByIdUnchecked(flowId, {
		status: terminalFlowStatus,
		notifyPolicy: task.notifyPolicy,
		goal: normalizeOptionalString(task.label) ?? (task.task.trim() || "Background task"),
		blockedTaskId: terminalFlowStatus === "blocked" ? task.taskId.trim() || null : null,
		blockedSummary: terminalFlowStatus === "blocked" ? resolveFlowBlockedSummary(task) ?? null : null,
		waitJson: null,
		updatedAt: timing.updatedAt,
		...isTerminal ? { endedAt: timing.endedAt ?? timing.updatedAt } : { endedAt: null }
	});
}
function getTaskFlowById(flowId) {
	ensureFlowRegistryReady();
	const flow = flows.get(flowId);
	return flow ? cloneFlowRecord(flow) : void 0;
}
function listTaskFlowsForOwnerKey(ownerKey) {
	ensureFlowRegistryReady();
	const normalizedOwnerKey = ownerKey.trim();
	if (!normalizedOwnerKey) return [];
	return [...flows.values()].filter((flow) => flow.ownerKey.trim() === normalizedOwnerKey).map((flow) => cloneFlowRecord(flow)).toSorted((left, right) => right.createdAt - left.createdAt);
}
function findLatestTaskFlowForOwnerKey(ownerKey) {
	const flow = listTaskFlowsForOwnerKey(ownerKey)[0];
	return flow ? cloneFlowRecord(flow) : void 0;
}
function resolveTaskFlowForLookupToken(token) {
	const lookup = token.trim();
	if (!lookup) return;
	return getTaskFlowById(lookup) ?? findLatestTaskFlowForOwnerKey(lookup);
}
function listTaskFlowRecords() {
	ensureFlowRegistryReady();
	return [...flows.values()].map((flow) => cloneFlowRecord(flow)).toSorted((left, right) => right.createdAt - left.createdAt);
}
function deleteTaskFlowRecordById(flowId) {
	ensureFlowRegistryReady();
	const current = flows.get(flowId);
	if (!current) return false;
	flows.delete(flowId);
	persistFlowDelete(flowId);
	emitFlowRegistryObserverEvent(() => ({
		kind: "deleted",
		flowId,
		previous: cloneFlowRecord(current)
	}));
	return true;
}
//#endregion
export { resolveTaskRegistryDir as _, findLatestTaskFlowForOwnerKey as a, getTaskFlowRegistryRestoreFailure as c, requestFlowCancel as d, resolveTaskFlowForLookupToken as f, updateFlowRecordByIdExpectedRevision as g, syncFlowFromTask as h, failFlow as i, listTaskFlowRecords as l, setFlowWaiting as m, createTaskFlowForTask as n, finishFlow as o, resumeFlow as p, deleteTaskFlowRecordById as r, getTaskFlowById as s, createManagedTaskFlow as t, listTaskFlowsForOwnerKey as u, resolveTaskRegistrySqlitePath as v };
