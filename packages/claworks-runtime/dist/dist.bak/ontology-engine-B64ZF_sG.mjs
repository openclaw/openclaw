import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
//#region src/planes/data/db-migrate.ts
/** Idempotent schema migrations for SQLite and PostgreSQL. */
function migrateClaworksSchema(db) {
	db.exec(`
    CREATE TABLE IF NOT EXISTS cw_outbox (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      is_dead INTEGER NOT NULL DEFAULT 0
    );
  `);
	addColumnIfMissing(db, "cw_events", "subject_id", "TEXT");
	addColumnIfMissing(db, "cw_events", "subject_type", "TEXT");
	addColumnIfMissing(db, "cw_events", "idempotency_key", "TEXT");
	addColumnIfMissing(db, "cw_outbox", "is_dead", "INTEGER NOT NULL DEFAULT 0");
	db.exec(`
    CREATE TABLE IF NOT EXISTS cw_user_profiles (
      user_id TEXT PRIMARY KEY,
      name TEXT,
      preferred_language TEXT,
      preferred_style TEXT NOT NULL DEFAULT 'concise',
      recent_topics TEXT NOT NULL DEFAULT '[]',
      interaction_count INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT NOT NULL,
      custom_notes TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
	db.exec(`
    CREATE TABLE IF NOT EXISTS cw_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      actor TEXT,
      target TEXT,
      payload TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_cw_audit_log_type ON cw_audit_log(event_type);`);
	db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_playbook ON cw_playbook_runs(playbook_id);
    CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_status ON cw_playbook_runs(status);
    CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_started ON cw_playbook_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cw_events_type ON cw_events(type);
    CREATE INDEX IF NOT EXISTS idx_cw_events_timestamp ON cw_events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_cw_outbox_due ON cw_outbox(next_attempt_at) WHERE is_dead = 0;
    CREATE INDEX IF NOT EXISTS idx_cw_objects_type_created ON cw_objects(type_name, created_at DESC);
  `);
}
function addColumnIfMissing(db, table, column, ddl) {
	try {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
	} catch {}
}
//#endregion
//#region src/planes/data/db-pg.ts
let nextId = 1;
function convertPlaceholders(sql) {
	let index = 0;
	return sql.replace(/\?/g, () => {
		index += 1;
		return `$${index}`;
	});
}
function openPostgresDatabase(connectionString) {
	const { port1, port2 } = new MessageChannel();
	const worker = new Worker(new URL("./pg-worker.mjs", import.meta.url), { env: { ...process.env } });
	worker.postMessage({ port: port2 }, [port2]);
	let ready = false;
	function callWorker(type, payload) {
		const id = nextId++;
		port1.postMessage({
			id,
			type,
			...payload
		});
		const received = receiveMessageOnPort(port1);
		if (!received || received.id !== id) throw new Error("PostgreSQL worker: unexpected reply");
		if (received.error) throw new Error(received.error);
		return received;
	}
	callWorker("init", { connectionString });
	ready = true;
	const db = {
		exec(sql) {
			if (!ready) throw new Error("PostgreSQL database not ready");
			callWorker("exec", { sql: convertPlaceholders(sql) });
		},
		prepare(sql) {
			const pgSql = convertPlaceholders(sql);
			return {
				run(...params) {
					callWorker("query", {
						sql: pgSql,
						params
					});
				},
				get(...params) {
					return callWorker("query", {
						sql: pgSql,
						params
					}).rows?.[0];
				},
				all(...params) {
					return callWorker("query", {
						sql: pgSql,
						params
					}).rows ?? [];
				}
			};
		},
		close() {
			if (!ready) return;
			try {
				callWorker("close", {});
			} finally {
				ready = false;
				worker.terminate();
			}
		}
	};
	return {
		db,
		close: () => db.close()
	};
}
function isPostgresDatabaseUrl(url) {
	const trimmed = url.trim();
	return trimmed.startsWith("postgresql://") || trimmed.startsWith("postgres://");
}
//#endregion
//#region src/planes/data/node-sqlite.ts
const require = createRequire(import.meta.url);
/** Load Node built-in sqlite (Node 22+). Kept in-package to avoid fork `src/infra` dependency. */
function requireNodeSqlite() {
	try {
		return require("node:sqlite");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`, { cause: err });
	}
}
//#endregion
//#region src/planes/data/schema-bootstrap.sql.ts
/**
* Canonical ClaWorks DDL (SQLite + PostgreSQL).
* Keep in sync with drizzle/migrations/0000_init.sql and db-migrate.ts indexes.
*/
const CW_SCHEMA_BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS cw_objects (
  id TEXT NOT NULL,
  type_name TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id, type_name)
);
CREATE INDEX IF NOT EXISTS idx_cw_objects_type ON cw_objects(type_name);
CREATE INDEX IF NOT EXISTS idx_cw_objects_type_created ON cw_objects(type_name, created_at DESC);

CREATE TABLE IF NOT EXISTS cw_playbook_runs (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  error TEXT,
  steps TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  completed_at BIGINT
);

CREATE TABLE IF NOT EXISTS cw_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  correlation_id TEXT,
  timestamp BIGINT NOT NULL,
  subject_id TEXT,
  subject_type TEXT,
  idempotency_key TEXT
);

CREATE TABLE IF NOT EXISTS cw_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at BIGINT NOT NULL,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  is_dead INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cw_kb_documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT,
  layer TEXT NOT NULL DEFAULT 'L2',
  doc_type TEXT,
  namespace TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  revision INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  published_at BIGINT
);

CREATE TABLE IF NOT EXISTS cw_kb_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  citation TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cw_kb_ingest_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  source_path TEXT,
  folder_path TEXT,
  namespace TEXT,
  layer TEXT,
  doc_type TEXT,
  report TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT
);

CREATE TABLE IF NOT EXISTS cw_hitl_pending (
  token TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  message TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cw_hooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  event_pattern TEXT NOT NULL,
  condition_expr TEXT,
  action_kind TEXT NOT NULL,
  action_channel TEXT,
  action_url TEXT,
  action_playbook_id TEXT,
  action_template TEXT NOT NULL,
  action_headers TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cw_cbr_cases (
  id TEXT PRIMARY KEY,
  problem TEXT NOT NULL,
  solution TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'success',
  similarity_keys TEXT NOT NULL DEFAULT '[]',
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  playbook_id TEXT,
  run_id TEXT
);

CREATE TABLE IF NOT EXISTS cw_notify_preferences (
  user_id TEXT PRIMARY KEY,
  channels TEXT NOT NULL DEFAULT '[]',
  subscriptions TEXT NOT NULL DEFAULT '[]',
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cw_notify_bindings (
  subject_key TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  user_ids TEXT NOT NULL DEFAULT '[]',
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cw_robot_identity (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cw_memory (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
`;
const CW_SCHEMA_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_playbook ON cw_playbook_runs(playbook_id);
CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_status ON cw_playbook_runs(status);
CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_started ON cw_playbook_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cw_events_type ON cw_events(type);
CREATE INDEX IF NOT EXISTS idx_cw_events_timestamp ON cw_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_cw_outbox_due ON cw_outbox(next_attempt_at) WHERE is_dead = 0;
CREATE INDEX IF NOT EXISTS idx_cw_kb_documents_status ON cw_kb_documents(status);
CREATE INDEX IF NOT EXISTS idx_cw_kb_documents_layer ON cw_kb_documents(layer);
CREATE INDEX IF NOT EXISTS idx_cw_kb_documents_namespace ON cw_kb_documents(namespace);
CREATE INDEX IF NOT EXISTS idx_cw_kb_chunks_document ON cw_kb_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_cw_kb_ingest_jobs_status ON cw_kb_ingest_jobs(status);
CREATE INDEX IF NOT EXISTS idx_cw_hitl_pending_run ON cw_hitl_pending(run_id);
CREATE INDEX IF NOT EXISTS idx_cw_hooks_enabled ON cw_hooks(enabled);
CREATE INDEX IF NOT EXISTS idx_cw_cbr_cases_outcome ON cw_cbr_cases(outcome);
CREATE INDEX IF NOT EXISTS idx_cw_cbr_cases_use_count ON cw_cbr_cases(use_count DESC);
CREATE INDEX IF NOT EXISTS idx_cw_notify_bindings_subject_type ON cw_notify_bindings(subject_type);
CREATE INDEX IF NOT EXISTS idx_cw_memory_expires ON cw_memory(expires_at);
`;
function execSchemaBootstrap(db) {
	for (const stmt of CW_SCHEMA_BOOTSTRAP_SQL.split(";").map((s) => s.trim()).filter(Boolean)) db.exec(stmt);
	for (const stmt of CW_SCHEMA_INDEX_SQL.split(";").map((s) => s.trim()).filter(Boolean)) db.exec(stmt);
}
//#endregion
//#region src/planes/data/db.ts
function openDatabase$1(databaseUrl) {
	const path = databaseUrl.startsWith("sqlite://") ? databaseUrl.slice(9) : databaseUrl;
	mkdirSync(dirname(path), { recursive: true });
	const { DatabaseSync } = requireNodeSqlite();
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec(`
    CREATE TABLE IF NOT EXISTS cw_objects (
      id TEXT NOT NULL,
      type_name TEXT NOT NULL,
      data TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (id, type_name)
    );
    CREATE INDEX IF NOT EXISTS idx_cw_objects_type ON cw_objects(type_name);

    CREATE TABLE IF NOT EXISTS cw_playbook_runs (
      id TEXT PRIMARY KEY,
      playbook_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT,
      error TEXT,
      steps TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS cw_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      payload TEXT NOT NULL,
      correlation_id TEXT,
      timestamp INTEGER NOT NULL,
      subject_id TEXT,
      subject_type TEXT,
      idempotency_key TEXT
    );
  `);
	execSchemaBootstrap(db);
	migrateClaworksSchema(db);
	return {
		db,
		close: () => db.close()
	};
}
//#endregion
//#region src/planes/data/db-open.ts
const PG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cw_objects (
  id TEXT NOT NULL,
  type_name TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id, type_name)
);
CREATE INDEX IF NOT EXISTS idx_cw_objects_type ON cw_objects(type_name);

CREATE TABLE IF NOT EXISTS cw_playbook_runs (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  error TEXT,
  steps TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  completed_at BIGINT
);

CREATE TABLE IF NOT EXISTS cw_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  correlation_id TEXT,
  timestamp BIGINT NOT NULL,
  subject_id TEXT,
  subject_type TEXT,
  idempotency_key TEXT
);

CREATE TABLE IF NOT EXISTS cw_user_profiles (
  user_id TEXT PRIMARY KEY,
  name TEXT,
  preferred_language TEXT,
  preferred_style TEXT NOT NULL DEFAULT 'concise',
  recent_topics TEXT NOT NULL DEFAULT '[]',
  interaction_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  custom_notes TEXT,
  updated_at TEXT NOT NULL DEFAULT NOW()
);
`;
function bootstrapPgSchema(db) {
	for (const stmt of PG_SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) db.exec(stmt);
	migrateClaworksSchema(db);
}
/**
* Open ClaWorks persistence (SQLite or PostgreSQL).
*/
function openDatabase(databaseUrl) {
	const url = databaseUrl.trim();
	if (isPostgresDatabaseUrl(url)) try {
		const pg = openPostgresDatabase(url);
		bootstrapPgSchema(pg.db);
		return {
			...pg,
			dialect: "postgresql"
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!message.includes("Cannot find package 'pg'")) throw err;
		return {
			...openDatabase$1(`sqlite://${join(homedir(), ".claworks", "pg-runtime-cache.db")}`),
			dialect: "postgresql",
			note: `PostgreSQL requested but optional dependency 'pg' is not installed (${message}). Install with: pnpm add -w pg. Using SQLite cache for this session.`
		};
	}
	return {
		...openDatabase$1(url),
		dialect: "sqlite"
	};
}
//#endregion
//#region src/planes/data/knowledge-base-file.ts
/**
* File-backed knowledge base (JSON). Used when config.data.kb_path is set.
*/
function createFileKnowledgeBase(filePath) {
	const load = () => {
		if (!existsSync(filePath)) return { documents: [] };
		try {
			const raw = readFileSync(filePath, "utf-8");
			const parsed = JSON.parse(raw);
			return { documents: Array.isArray(parsed.documents) ? parsed.documents : [] };
		} catch {
			return { documents: [] };
		}
	};
	const save = (data) => {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
	};
	return {
		async search(query, opts) {
			const limit = opts?.limit ?? 5;
			const ns = opts?.namespace;
			const q = query.toLowerCase();
			const docs = load().documents.filter((d) => !ns || d.namespace === ns);
			const hits = [];
			for (let i = 0; i < docs.length; i++) {
				const doc = docs[i];
				if (doc.text.toLowerCase().includes(q)) hits.push({
					id: doc.id,
					text: doc.text,
					score: 1 - i * .05,
					namespace: doc.namespace,
					source: doc.source
				});
				if (hits.length >= limit) break;
			}
			return hits;
		},
		async ingest(text, opts) {
			const data = load();
			const doc = {
				id: randomUUID(),
				text,
				namespace: opts?.namespace,
				source: opts?.source
			};
			data.documents.push(doc);
			save(data);
		}
	};
}
//#endregion
//#region src/planes/data/knowledge-base.ts
/** In-memory KB stub; use `data.kb_provider: memory-core` in claworks-robot for memory-core search. */
function createKnowledgeBase() {
	const docs = [];
	return {
		async search(query, opts) {
			const limit = opts?.limit ?? 5;
			const terms = query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean);
			return docs.filter((d) => !opts?.namespace || d.namespace === opts.namespace).filter((d) => {
				const text = d.text.toLowerCase();
				if (terms.length === 0) return true;
				return terms.every((term) => text.includes(term));
			}).slice(0, limit).map((d, i) => ({
				id: d.id,
				score: 1 - i * .1,
				text: d.text,
				source: d.source,
				namespace: d.namespace
			}));
		},
		async ingest(text, opts) {
			docs.push({
				id: `kb-${docs.length + 1}`,
				text,
				namespace: opts?.namespace,
				source: opts?.source
			});
		}
	};
}
//#endregion
//#region src/planes/data/mes-dispatch.ts
/** MES production dispatch — webhook or simulate per CLAWTWIN_MES_PRODUCTION_* env. */
async function mesProductionDispatch(params) {
	const webhook = process.env.CLAWTWIN_MES_PRODUCTION_WEBHOOK_URL?.trim() || process.env.CLAWORKS_MES_WEBHOOK_URL?.trim();
	const body = {
		station_id: params.station_id,
		workorder_id: params.workorder_id ?? params.work_order_id,
		priority: params.priority ?? "normal",
		notes: params.notes,
		dispatched_at: (/* @__PURE__ */ new Date()).toISOString()
	};
	if (!webhook) return {
		status: "ok",
		mode: "simulate",
		...body,
		message: "MES webhook not configured (set CLAWTWIN_MES_PRODUCTION_WEBHOOK_URL)"
	};
	const res = await fetch(webhook, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(3e4)
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`MES dispatch failed ${res.status}: ${text}`);
	}
	let response = null;
	try {
		response = await res.json();
	} catch {
		response = { accepted: true };
	}
	return {
		status: "ok",
		mode: "webhook",
		...body,
		response
	};
}
//#endregion
//#region src/planes/data/work-order-events.ts
function workOrderEventPayload(wo, extra) {
	return {
		workorder_id: wo.id,
		work_order_id: wo.id,
		equipment_id: wo.equipment_id ?? extra?.equipment_id,
		source_alarm_id: wo.source_alarm_id ?? extra?.source_alarm_id,
		station_id: wo.station_id ?? extra?.station_id,
		priority: wo.priority ?? extra?.priority,
		status: wo.status,
		description: wo.description,
		source: wo.source,
		...extra
	};
}
async function publishWorkOrderCreated(ctx, wo, extra) {
	if (!ctx.publishEvent) return;
	await ctx.publishEvent("workorder.created", `playbook:${ctx.playbookId}`, workOrderEventPayload(wo, extra), ctx.runId);
}
//#endregion
//#region src/planes/data/object-store.ts
function notifyPolicyWrite(opts, typeName) {
	if (typeName === "RbacPolicy" || typeName === "IngressPolicy") opts?.onPolicyWrite?.(typeName);
}
function periodKey(ts, granularity) {
	const d = ts instanceof Date ? ts : new Date(ts);
	if (Number.isNaN(d.getTime())) return "unknown";
	const y = d.getUTCFullYear();
	const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
	const da = String(d.getUTCDate()).padStart(2, "0");
	const hr = String(d.getUTCHours()).padStart(2, "0");
	switch (granularity) {
		case "hour": return `${y}-${mo}-${da}T${hr}`;
		case "day": return `${y}-${mo}-${da}`;
		case "week": {
			const jan1 = new Date(Date.UTC(y, 0, 1));
			const weekNo = Math.ceil(((d.getTime() - jan1.getTime()) / 864e5 + jan1.getUTCDay() + 1) / 7);
			return `${y}-W${String(weekNo).padStart(2, "0")}`;
		}
		case "month": return `${y}-${mo}`;
	}
}
function applyAggFn(fn, values) {
	if (values.length === 0) return 0;
	switch (fn) {
		case "count": return values.length;
		case "sum": return values.reduce((a, b) => a + b, 0);
		case "avg": return values.reduce((a, b) => a + b, 0) / values.length;
		case "min": return Math.min(...values);
		case "max": return Math.max(...values);
	}
}
function withinTimeRange(obj, timeField, from, to) {
	const raw = timeField === "_createdAt" ? obj._createdAt : obj[timeField];
	if (raw == null) return false;
	const ts = raw instanceof Date ? raw.toISOString() : String(raw);
	if (from && ts < from) return false;
	if (to && ts > to) return false;
	return true;
}
function createObjectStore(db, opts) {
	const selectByType = db.prepare("SELECT id, type_name, data, version, created_at, updated_at FROM cw_objects WHERE type_name = ? LIMIT ? OFFSET ?");
	const selectByTypeTimeRange = db.prepare(`SELECT id, type_name, data, version, created_at, updated_at FROM cw_objects
     WHERE type_name = ? AND created_at >= ? AND created_at <= ?
     ORDER BY created_at ASC LIMIT ?`);
	const selectOne = db.prepare("SELECT id, type_name, data, version, created_at, updated_at FROM cw_objects WHERE type_name = ? AND id = ?");
	const insert = db.prepare("INSERT INTO cw_objects (id, type_name, data, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
	const updateStmt = db.prepare("UPDATE cw_objects SET data = ?, version = ?, updated_at = ? WHERE type_name = ? AND id = ?");
	const deleteStmt = db.prepare("DELETE FROM cw_objects WHERE type_name = ? AND id = ?");
	return {
		async query(typeName, opts) {
			const limit = opts?.limit ?? 50;
			const offset = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
			let items;
			if (opts?.time_range) {
				const tr = opts.time_range;
				const fromMs = tr.from ? new Date(tr.from).getTime() : 0;
				const toMs = tr.to ? new Date(tr.to).getTime() : Date.now() + 0xe8d4a51000;
				if (!tr.field || tr.field === "_createdAt") {
					const rows = selectByTypeTimeRange.all(typeName, fromMs, toMs, limit + 1 + offset);
					items = rows.slice(offset, offset + limit).map(rowToObject);
					const hasMore = rows.length > offset + limit;
					return {
						items: opts.filter ? items.filter((o) => matchesFilter(o, opts.filter)) : items,
						nextCursor: hasMore ? String(offset + limit) : void 0
					};
				}
				items = selectByType.all(typeName, 2e3, 0).map(rowToObject).filter((o) => withinTimeRange(o, tr.field, tr.from, tr.to));
			} else {
				const rows = selectByType.all(typeName, limit + 1, offset);
				items = rows.slice(0, limit).map(rowToObject);
				return {
					items: opts?.filter ? items.filter((o) => matchesFilter(o, opts.filter)) : items,
					nextCursor: rows.length > limit ? String(offset + limit) : void 0
				};
			}
			const filtered = opts?.filter ? items.filter((o) => matchesFilter(o, opts.filter)) : items;
			return {
				items: filtered.slice(offset, offset + limit),
				nextCursor: filtered.length > offset + limit ? String(offset + limit) : void 0
			};
		},
		async get(typeName, id) {
			const row = selectOne.get(typeName, id);
			return row ? rowToObject(row) : null;
		},
		async create(typeName, data, ctx) {
			const validation = opts?.validate?.(typeName, data);
			if (validation && !validation.valid) {
				const msg = validation.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
				throw new Error(`Ontology validation failed for ${typeName}: ${msg}`);
			}
			const id = String(data.id ?? randomUUID());
			const now = Date.now();
			const payload = {
				...data,
				id
			};
			insert.run(id, typeName, JSON.stringify(payload), 1, now, now);
			const obj = {
				...payload,
				_type: typeName,
				_version: 1,
				_createdAt: new Date(now),
				_updatedAt: new Date(now)
			};
			if (typeName === "WorkOrder" && ctx) await publishWorkOrderCreated(ctx, obj, data);
			notifyPolicyWrite(opts, typeName);
			return obj;
		},
		async update(typeName, id, patch) {
			const existing = await this.get(typeName, id);
			if (!existing) throw new Error(`Object not found: ${typeName}/${id}`);
			const now = Date.now();
			const merged = {
				...stripMeta(existing),
				...patch,
				id
			};
			const version = existing._version + 1;
			updateStmt.run(JSON.stringify(merged), version, now, typeName, id);
			const updated = {
				...merged,
				_type: typeName,
				_version: version,
				_createdAt: existing._createdAt,
				_updatedAt: new Date(now)
			};
			notifyPolicyWrite(opts, typeName);
			return updated;
		},
		async upsert(typeName, id, data) {
			if (await this.get(typeName, id)) return this.update(typeName, id, {
				...data,
				id
			});
			return this.create(typeName, {
				...data,
				id
			});
		},
		async delete(typeName, id) {
			deleteStmt.run(typeName, id);
		},
		async executeAction(typeName, id, actionType, params, ctx) {
			if (actionType === "mes_production_dispatch") return await mesProductionDispatch(params);
			if (actionType === "ingest_kb_text" || typeName === "_kb") {
				const text = String(params.text ?? "");
				await ctx.kb.ingest(text, {
					namespace: params.layer ? String(params.layer) : String(params.namespace ?? "default"),
					source: params.source_uri ? String(params.source_uri) : params.source ? String(params.source) : params.title ? String(params.title) : void 0
				});
				return {
					status: "ok",
					document_id: `kb-${Date.now()}`,
					title: params.title,
					station_id: params.station_id
				};
			}
			const obj = await this.get(typeName, id);
			if (!obj) throw new Error(`Object not found: ${typeName}/${id}`);
			if (opts?.validateFsmTransition) {
				const stateValue = (() => {
					for (const key of [
						"status",
						"state",
						"fsm_state"
					]) if (typeof obj[key] === "string") return {
						field: key,
						value: obj[key]
					};
					return null;
				})();
				if (stateValue) {
					const check = opts.validateFsmTransition(typeName, actionType, stateValue.value);
					if (!check.allowed) throw new Error(`FSM transition denied for ${typeName}/${id}: ${check.reason ?? `action "${actionType}" not allowed from state "${stateValue.value}"`}`);
					if (check.nextState && check.nextState !== stateValue.value) params[stateValue.field] = check.nextState;
				}
			}
			if (actionType === "acknowledge_alarm") return {
				status: "ok",
				...await this.update(typeName, id, {
					status: "acknowledged",
					acknowledged_by: params.acknowledged_by,
					...params.note ? { note: params.note } : {}
				})
			};
			if (actionType === "create_work_order") return {
				status: "ok",
				...await this.create("WorkOrder", {
					...params,
					status: params.status ?? "open",
					source: params.source ?? "playbook"
				}, ctx)
			};
			const strict = process.env.CLAWORKS_STRICT_ACTIONS === "1";
			const msg = `unsupported action '${actionType}' on type '${typeName}' (object: ${id})`;
			if (strict) throw new Error(msg);
			return {
				status: "unsupported",
				actionType,
				typeName,
				objectId: id,
				message: msg
			};
		},
		async queryTimeSeries(typeName, tsOpts) {
			const granularity = tsOpts?.group_by_period ?? "day";
			const aggFn = tsOpts?.aggregate_fn ?? "count";
			const timeField = tsOpts?.time_field ?? "_createdAt";
			const aggField = tsOpts?.aggregate_field;
			const fromMs = tsOpts?.from ? new Date(tsOpts.from).getTime() : 0;
			const toMs = tsOpts?.to ? new Date(tsOpts.to).getTime() : Date.now() + 0xe8d4a51000;
			let items = selectByTypeTimeRange.all(typeName, fromMs, toMs, 5e3).map(rowToObject);
			if (tsOpts?.filter) items = items.filter((o) => matchesFilter(o, tsOpts.filter));
			if (timeField !== "_createdAt") items = items.filter((o) => withinTimeRange(o, timeField, tsOpts?.from, tsOpts?.to));
			const bucketMap = /* @__PURE__ */ new Map();
			for (const obj of items) {
				const raw = timeField === "_createdAt" ? obj._createdAt : obj[timeField];
				if (raw == null) continue;
				const key = periodKey(raw instanceof Date ? raw : String(raw), granularity);
				if (!bucketMap.has(key)) bucketMap.set(key, []);
				const numVal = aggFn === "count" ? 1 : aggField ? Number(obj[aggField] ?? 0) : 1;
				bucketMap.get(key).push(numVal);
			}
			const buckets = [...bucketMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, vals]) => ({
				period,
				value: applyAggFn(aggFn, vals),
				count: vals.length
			}));
			const totalValue = buckets.reduce((s, b) => s + b.value, 0);
			const totalCount = items.length;
			return {
				type_name: typeName,
				group_by_period: granularity,
				aggregate_fn: aggFn,
				aggregate_field: aggField,
				from: tsOpts?.from,
				to: tsOpts?.to,
				buckets,
				total_count: totalCount,
				total_value: totalValue
			};
		}
	};
}
function rowToObject(row) {
	return {
		...JSON.parse(row.data),
		id: row.id,
		_type: row.type_name,
		_version: row.version,
		_createdAt: new Date(row.created_at),
		_updatedAt: new Date(row.updated_at)
	};
}
function stripMeta(obj) {
	const { _type, _version, _createdAt, _updatedAt, ...rest } = obj;
	return rest;
}
function matchesFilter(obj, filter) {
	for (const [k, v] of Object.entries(filter)) if (obj[k] !== v) return false;
	return true;
}
//#endregion
//#region src/planes/data/ontology-engine.ts
function createOntologyEngine() {
	const types = /* @__PURE__ */ new Map();
	return {
		async loadFromPacks(packs) {
			types.clear();
			for (const pack of packs) for (const ot of pack.objectTypes) types.set(ot.name, ot);
		},
		async reloadPack(packId, pack) {
			for (const [name, def] of [...types.entries()]) if (def.pack === packId) types.delete(name);
			for (const ot of pack.objectTypes) types.set(ot.name, ot);
		},
		getType(name) {
			return types.get(name) ?? null;
		},
		listTypes() {
			return [...types.values()];
		},
		validate(typeName, data) {
			const def = types.get(typeName);
			if (!def) return {
				valid: true,
				errors: []
			};
			const errors = [];
			for (const field of def.fields) {
				if (field.name === def.primaryKey) continue;
				if (field.required && (data[field.name] === void 0 || data[field.name] === null)) errors.push({
					field: field.name,
					message: "required"
				});
			}
			return {
				valid: errors.length === 0,
				errors
			};
		},
		registerType(def) {
			types.set(def.name, def);
		}
	};
}
//#endregion
export { createKnowledgeBase as a, openDatabase$1 as c, migrateClaworksSchema as d, mesProductionDispatch as i, convertPlaceholders as l, createObjectStore as n, createFileKnowledgeBase as o, publishWorkOrderCreated as r, openDatabase as s, createOntologyEngine as t, isPostgresDatabaseUrl as u };
