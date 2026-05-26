import { n as requireNodeSqlite, t as configureSqliteWalMaintenance } from "./sqlite-wal-RZTJ93Pu.js";
import { n as normalizeRequestInitHeadersForFetch } from "./fetch-headers-D18pVzIl.js";
import { r as resolveDebugProxySettings } from "./env-CDrl0Kuj.js";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
//#region src/proxy-capture/blob-store.ts
function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}
function writeCaptureBlob(params) {
	ensureDir(params.blobDir);
	const sha256 = createHash("sha256").update(params.data).digest("hex");
	const blobId = sha256.slice(0, 24);
	const outputPath = path.join(params.blobDir, `${blobId}.bin.gz`);
	if (!fs.existsSync(outputPath)) fs.writeFileSync(outputPath, gzipSync(params.data));
	return {
		blobId,
		path: outputPath,
		encoding: "gzip",
		sizeBytes: params.data.byteLength,
		sha256,
		...params.contentType ? { contentType: params.contentType } : {}
	};
}
function readCaptureBlobText(blobPath) {
	return gunzipSync(fs.readFileSync(blobPath)).toString("utf8");
}
//#endregion
//#region src/proxy-capture/store.sqlite.ts
function ensureParentDir(filePath) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
function openDatabase(dbPath) {
	ensureParentDir(dbPath);
	const { DatabaseSync } = requireNodeSqlite();
	const db = new DatabaseSync(dbPath);
	const walMaintenance = configureSqliteWalMaintenance(db);
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec(`
    CREATE TABLE IF NOT EXISTS capture_sessions (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      mode TEXT NOT NULL,
      source_scope TEXT NOT NULL,
      source_process TEXT NOT NULL,
      proxy_url TEXT,
      db_path TEXT NOT NULL,
      blob_dir TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS capture_events (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      source_scope TEXT NOT NULL,
      source_process TEXT NOT NULL,
      protocol TEXT NOT NULL,
      direction TEXT NOT NULL,
      kind TEXT NOT NULL,
      flow_id TEXT NOT NULL,
      method TEXT,
      host TEXT,
      path TEXT,
      status INTEGER,
      close_code INTEGER,
      content_type TEXT,
      headers_json TEXT,
      data_text TEXT,
      data_blob_id TEXT,
      data_sha256 TEXT,
      error_text TEXT,
      meta_json TEXT
    );
    CREATE INDEX IF NOT EXISTS capture_events_session_ts_idx ON capture_events(session_id, ts);
    CREATE INDEX IF NOT EXISTS capture_events_flow_idx ON capture_events(flow_id, ts);
  `);
	return {
		db,
		walMaintenance
	};
}
function serializeJson(value) {
	return value == null ? null : JSON.stringify(value);
}
function parseMetaJson(metaJson) {
	if (typeof metaJson !== "string" || metaJson.trim().length === 0) return null;
	try {
		const parsed = JSON.parse(metaJson);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}
function normalizeObservedValue(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
function sortObservedCounts(counts) {
	return [...counts.entries()].map(([value, count]) => ({
		value,
		count
	})).toSorted((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}
var DebugProxyCaptureStore = class {
	constructor(dbPath, blobDir) {
		this.dbPath = dbPath;
		this.blobDir = blobDir;
		this.closed = false;
		const opened = openDatabase(dbPath);
		this.db = opened.db;
		this.walMaintenance = opened.walMaintenance;
	}
	close() {
		if (this.closed) return;
		this.walMaintenance.close();
		this.db.close();
		this.closed = true;
	}
	get isClosed() {
		return this.closed;
	}
	upsertSession(session) {
		this.db.prepare(`INSERT INTO capture_sessions (
          id, started_at, ended_at, mode, source_scope, source_process, proxy_url, db_path, blob_dir
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          ended_at=excluded.ended_at,
          proxy_url=excluded.proxy_url,
          source_process=excluded.source_process`).run(session.id, session.startedAt, session.endedAt ?? null, session.mode, session.sourceScope, session.sourceProcess, session.proxyUrl ?? null, session.dbPath, session.blobDir);
	}
	endSession(sessionId, endedAt = Date.now()) {
		this.db.prepare(`UPDATE capture_sessions SET ended_at = ? WHERE id = ?`).run(endedAt, sessionId);
	}
	persistPayload(data, contentType) {
		return writeCaptureBlob({
			blobDir: this.blobDir,
			data,
			contentType
		});
	}
	recordEvent(event) {
		this.db.prepare(`INSERT INTO capture_events (
          session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id,
          method, host, path, status, close_code, content_type, headers_json,
          data_text, data_blob_id, data_sha256, error_text, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(event.sessionId, event.ts, event.sourceScope, event.sourceProcess, event.protocol, event.direction, event.kind, event.flowId, event.method ?? null, event.host ?? null, event.path ?? null, event.status ?? null, event.closeCode ?? null, event.contentType ?? null, event.headersJson ?? null, event.dataText ?? null, event.dataBlobId ?? null, event.dataSha256 ?? null, event.errorText ?? null, event.metaJson ?? null);
	}
	listSessions(limit = 50) {
		return this.db.prepare(`SELECT
           s.id,
           s.started_at AS startedAt,
           s.ended_at AS endedAt,
           s.mode,
           s.source_process AS sourceProcess,
           s.proxy_url AS proxyUrl,
           COUNT(e.id) AS eventCount
         FROM capture_sessions s
         LEFT JOIN capture_events e ON e.session_id = s.id
         GROUP BY s.id
         ORDER BY s.started_at DESC
         LIMIT ?`).all(limit);
	}
	getSessionEvents(sessionId, limit = 500) {
		return this.db.prepare(`SELECT
           id, session_id AS sessionId, ts, source_scope AS sourceScope, source_process AS sourceProcess,
           protocol, direction, kind, flow_id AS flowId, method, host, path, status, close_code AS closeCode,
           content_type AS contentType, headers_json AS headersJson, data_text AS dataText,
           data_blob_id AS dataBlobId, data_sha256 AS dataSha256, error_text AS errorText, meta_json AS metaJson
         FROM capture_events
         WHERE session_id = ?
         ORDER BY ts DESC, id DESC
         LIMIT ?`).all(sessionId, limit);
	}
	summarizeSessionCoverage(sessionId) {
		const rows = this.db.prepare(`SELECT host, meta_json AS metaJson
         FROM capture_events
         WHERE session_id = ?`).all(sessionId);
		const providers = /* @__PURE__ */ new Map();
		const apis = /* @__PURE__ */ new Map();
		const models = /* @__PURE__ */ new Map();
		const hosts = /* @__PURE__ */ new Map();
		const localPeers = /* @__PURE__ */ new Map();
		let unlabeledEventCount = 0;
		for (const row of rows) {
			const meta = parseMetaJson(row.metaJson);
			const provider = normalizeObservedValue(meta?.provider);
			const api = normalizeObservedValue(meta?.api);
			const model = normalizeObservedValue(meta?.model);
			const host = normalizeObservedValue(row.host);
			if (!provider && !api && !model) unlabeledEventCount += 1;
			if (provider) providers.set(provider, (providers.get(provider) ?? 0) + 1);
			if (api) apis.set(api, (apis.get(api) ?? 0) + 1);
			if (model) models.set(model, (models.get(model) ?? 0) + 1);
			if (host) {
				hosts.set(host, (hosts.get(host) ?? 0) + 1);
				if (host === "127.0.0.1:11434" || host.startsWith("127.0.0.1:") || host.startsWith("localhost:")) localPeers.set(host, (localPeers.get(host) ?? 0) + 1);
			}
		}
		return {
			sessionId,
			totalEvents: rows.length,
			unlabeledEventCount,
			providers: sortObservedCounts(providers),
			apis: sortObservedCounts(apis),
			models: sortObservedCounts(models),
			hosts: sortObservedCounts(hosts),
			localPeers: sortObservedCounts(localPeers)
		};
	}
	readBlob(blobId) {
		const row = this.db.prepare(`SELECT data_blob_id AS blobId FROM capture_events WHERE data_blob_id = ? LIMIT 1`).get(blobId);
		if (!row?.blobId) return null;
		const blobPath = path.join(this.blobDir, `${row.blobId}.bin.gz`);
		return fs.existsSync(blobPath) ? readCaptureBlobText(blobPath) : null;
	}
	queryPreset(preset, sessionId) {
		const sessionWhere = sessionId ? "AND session_id = ?" : "";
		const args = sessionId ? [sessionId] : [];
		switch (preset) {
			case "double-sends": return this.db.prepare(`SELECT host, path, method, COUNT(*) AS duplicateCount
             FROM capture_events
             WHERE kind = 'request' ${sessionWhere}
             GROUP BY host, path, method, data_sha256
             HAVING COUNT(*) > 1
             ORDER BY duplicateCount DESC, host ASC`).all(...args);
			case "retry-storms": return this.db.prepare(`SELECT host, path, COUNT(*) AS errorCount
             FROM capture_events
             WHERE kind = 'response' AND status >= 429 ${sessionWhere}
             GROUP BY host, path
             HAVING COUNT(*) > 1
             ORDER BY errorCount DESC, host ASC`).all(...args);
			case "cache-busting": return this.db.prepare(`SELECT host, path, COUNT(*) AS variantCount
             FROM capture_events
             WHERE kind = 'request'
               AND (path LIKE '%?%' OR headers_json LIKE '%cache-control%' OR headers_json LIKE '%pragma%')
               ${sessionWhere}
             GROUP BY host, path
             ORDER BY variantCount DESC, host ASC`).all(...args);
			case "ws-duplicate-frames": return this.db.prepare(`SELECT host, path, COUNT(*) AS duplicateFrames
             FROM capture_events
             WHERE kind = 'ws-frame' AND direction = 'outbound' ${sessionWhere}
             GROUP BY host, path, data_sha256
             HAVING COUNT(*) > 1
             ORDER BY duplicateFrames DESC, host ASC`).all(...args);
			case "missing-ack": return this.db.prepare(`SELECT flow_id AS flowId, host, path, COUNT(*) AS outboundFrames
             FROM capture_events
             WHERE kind = 'ws-frame' AND direction = 'outbound' ${sessionWhere}
               AND flow_id NOT IN (
                 SELECT flow_id FROM capture_events
                 WHERE kind = 'ws-frame' AND direction = 'inbound' ${sessionId ? "AND session_id = ?" : ""}
               )
             GROUP BY flow_id, host, path
             ORDER BY outboundFrames DESC`).all(...sessionId ? [sessionId, sessionId] : []);
			case "error-bursts": return this.db.prepare(`SELECT host, path, COUNT(*) AS errorCount
             FROM capture_events
             WHERE kind = 'error' ${sessionWhere}
             GROUP BY host, path
             ORDER BY errorCount DESC, host ASC`).all(...args);
			default: return [];
		}
	}
	purgeAll() {
		const sessionCount = this.db.prepare(`SELECT COUNT(*) AS count FROM capture_sessions`).get().count ?? 0;
		const eventCount = this.db.prepare(`SELECT COUNT(*) AS count FROM capture_events`).get().count ?? 0;
		this.db.exec(`DELETE FROM capture_events; DELETE FROM capture_sessions;`);
		let blobs = 0;
		if (fs.existsSync(this.blobDir)) for (const entry of fs.readdirSync(this.blobDir)) {
			fs.rmSync(path.join(this.blobDir, entry), { force: true });
			blobs += 1;
		}
		return {
			sessions: sessionCount,
			events: eventCount,
			blobs
		};
	}
	deleteSessions(sessionIds) {
		const uniqueSessionIds = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))];
		if (uniqueSessionIds.length === 0) return {
			sessions: 0,
			events: 0,
			blobs: 0
		};
		const placeholders = uniqueSessionIds.map(() => "?").join(", ");
		const blobRows = this.db.prepare(`SELECT DISTINCT data_blob_id AS blobId
         FROM capture_events
         WHERE session_id IN (${placeholders})
           AND data_blob_id IS NOT NULL`).all(...uniqueSessionIds);
		const eventCount = this.db.prepare(`SELECT COUNT(*) AS count
             FROM capture_events
             WHERE session_id IN (${placeholders})`).get(...uniqueSessionIds).count ?? 0;
		const sessionCount = this.db.prepare(`SELECT COUNT(*) AS count
             FROM capture_sessions
             WHERE id IN (${placeholders})`).get(...uniqueSessionIds).count ?? 0;
		this.db.prepare(`DELETE FROM capture_events WHERE session_id IN (${placeholders})`).run(...uniqueSessionIds);
		this.db.prepare(`DELETE FROM capture_sessions WHERE id IN (${placeholders})`).run(...uniqueSessionIds);
		const candidateBlobIds = blobRows.map((row) => row.blobId?.trim()).filter((blobId) => Boolean(blobId));
		const remainingBlobRefs = candidateBlobIds.length > 0 ? new Set(this.db.prepare(`SELECT DISTINCT data_blob_id AS blobId
                   FROM capture_events
                   WHERE data_blob_id IN (${candidateBlobIds.map(() => "?").join(", ")})
                     AND data_blob_id IS NOT NULL`).all(...candidateBlobIds).map((row) => row.blobId?.trim()).filter((blobId) => Boolean(blobId))) : /* @__PURE__ */ new Set();
		let blobs = 0;
		for (const row of blobRows) {
			const blobId = row.blobId?.trim();
			if (!blobId || remainingBlobRefs.has(blobId)) continue;
			const blobPath = path.join(this.blobDir, `${blobId}.bin.gz`);
			if (fs.existsSync(blobPath)) {
				fs.rmSync(blobPath, { force: true });
				blobs += 1;
			}
		}
		return {
			sessions: sessionCount,
			events: eventCount,
			blobs
		};
	}
};
let cachedStore = null;
let cachedKey = "";
let cachedStoreLeases = 0;
function getDebugProxyCaptureStore(dbPath, blobDir) {
	const key = `${dbPath}:${blobDir}`;
	if (!cachedStore || cachedStore.isClosed || cachedKey !== key) {
		cachedStore = new DebugProxyCaptureStore(dbPath, blobDir);
		cachedKey = key;
		cachedStoreLeases = 0;
	}
	return cachedStore;
}
function closeDebugProxyCaptureStore() {
	if (!cachedStore) return;
	cachedStore.close();
	cachedStore = null;
	cachedKey = "";
	cachedStoreLeases = 0;
}
function acquireDebugProxyCaptureStore(dbPath, blobDir) {
	const store = getDebugProxyCaptureStore(dbPath, blobDir);
	const key = cachedKey;
	cachedStoreLeases += 1;
	let released = false;
	return {
		store,
		release: () => {
			if (released) return;
			released = true;
			cachedStoreLeases = Math.max(0, cachedStoreLeases - 1);
			if (cachedStoreLeases === 0 && cachedStore === store && cachedKey === key) closeDebugProxyCaptureStore();
		}
	};
}
function persistEventPayload(store, params) {
	if (params.data == null) return {};
	const buffer = Buffer.isBuffer(params.data) ? params.data : Buffer.from(params.data);
	const previewLimit = params.previewLimit ?? 8192;
	const blob = store.persistPayload(buffer, params.contentType);
	return {
		dataText: buffer.subarray(0, previewLimit).toString("utf8"),
		dataBlobId: blob.blobId,
		dataSha256: blob.sha256
	};
}
function safeJsonString(value) {
	return serializeJson(value) ?? void 0;
}
//#endregion
//#region src/proxy-capture/runtime.ts
const DEBUG_PROXY_FETCH_PATCH_KEY = Symbol.for("openclaw.debugProxy.fetchPatch");
const REDACTED_CAPTURE_HEADER_VALUE = "[REDACTED]";
const SENSITIVE_CAPTURE_HEADER_NAMES = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
	"api-key",
	"apikey",
	"x-auth-token",
	"auth-token",
	"x-access-token",
	"access-token"
]);
const SENSITIVE_CAPTURE_HEADER_NAME_FRAGMENTS = [
	"api-key",
	"apikey",
	"token",
	"secret",
	"password",
	"credential",
	"session"
];
function resolveRuntimeDeps(deps = {}) {
	return {
		getStore: deps.getStore ?? getDebugProxyCaptureStore,
		closeStore: deps.closeStore ?? closeDebugProxyCaptureStore,
		persistEventPayload: deps.persistEventPayload ?? ((store, payload) => persistEventPayload(store, payload)),
		safeJsonString: deps.safeJsonString ?? safeJsonString,
		fetchTarget: deps.fetchTarget ?? globalThis
	};
}
function protocolFromUrl(rawUrl) {
	try {
		switch (new URL(rawUrl).protocol) {
			case "https:": return "https";
			case "wss:": return "wss";
			case "ws:": return "ws";
			default: return "http";
		}
	} catch {
		return "http";
	}
}
function resolveUrlString(input) {
	if (input instanceof URL) return input.toString();
	if (typeof input === "string") return input;
	if (typeof Request !== "undefined" && input instanceof Request) return input.url;
	return null;
}
function isSensitiveCaptureHeaderName(name) {
	const normalized = name.trim().toLowerCase();
	if (!normalized) return false;
	if (SENSITIVE_CAPTURE_HEADER_NAMES.has(normalized)) return true;
	return SENSITIVE_CAPTURE_HEADER_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}
function redactedCaptureHeaders(headers) {
	if (!headers) return;
	const entries = headers instanceof Headers ? Array.from(headers.entries()) : Object.entries(headers);
	const redacted = {};
	for (const [name, value] of entries) redacted[name] = isSensitiveCaptureHeaderName(name) ? REDACTED_CAPTURE_HEADER_VALUE : value;
	return redacted;
}
function createHttpCaptureEventBase(params) {
	return {
		sessionId: params.settings.sessionId,
		ts: Date.now(),
		sourceScope: "openclaw",
		sourceProcess: params.settings.sourceProcess,
		protocol: params.transport ?? protocolFromUrl(params.rawUrl),
		direction: params.direction,
		kind: params.kind,
		flowId: params.flowId,
		method: params.method,
		host: params.url.host,
		path: `${params.url.pathname}${params.url.search}`
	};
}
function installDebugProxyGlobalFetchPatch(settings, deps = {}) {
	const runtime = resolveRuntimeDeps(deps);
	const fetchTarget = runtime.fetchTarget;
	if (typeof fetchTarget.fetch !== "function") return;
	if (fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY]) return;
	const originalFetch = fetchTarget.fetch.bind(fetchTarget);
	fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY] = { originalFetch };
	fetchTarget.fetch = (async (input, init) => {
		const url = resolveUrlString(input);
		const normalizedInit = normalizeRequestInitHeadersForFetch(init);
		try {
			const response = await originalFetch(input, normalizedInit);
			if (url && /^https?:/i.test(url)) captureHttpExchange({
				url,
				method: (typeof Request !== "undefined" && input instanceof Request ? input.method : void 0) ?? normalizedInit?.method ?? "GET",
				requestHeaders: (typeof Request !== "undefined" && input instanceof Request ? input.headers : void 0) ?? normalizedInit?.headers,
				requestBody: (typeof Request !== "undefined" && input instanceof Request ? input.body : void 0) ?? normalizedInit?.body ?? null,
				response,
				transport: "http",
				meta: {
					captureOrigin: "global-fetch",
					source: settings.sourceProcess
				}
			}, settings, deps);
			return response;
		} catch (error) {
			if (url && /^https?:/i.test(url)) {
				const store = runtime.getStore(settings.dbPath, settings.blobDir);
				const parsed = new URL(url);
				store.recordEvent({
					sessionId: settings.sessionId,
					ts: Date.now(),
					sourceScope: "openclaw",
					sourceProcess: settings.sourceProcess,
					protocol: protocolFromUrl(url),
					direction: "local",
					kind: "error",
					flowId: randomUUID(),
					method: (typeof Request !== "undefined" && input instanceof Request ? input.method : void 0) ?? normalizedInit?.method ?? "GET",
					host: parsed.host,
					path: `${parsed.pathname}${parsed.search}`,
					errorText: error instanceof Error ? error.message : String(error),
					metaJson: runtime.safeJsonString({ captureOrigin: "global-fetch" })
				});
			}
			throw error;
		}
	});
}
function uninstallDebugProxyGlobalFetchPatch(deps = {}) {
	const fetchTarget = resolveRuntimeDeps(deps).fetchTarget;
	const state = fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY];
	if (!state) return;
	fetchTarget.fetch = state.originalFetch;
	delete fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY];
}
function isDebugProxyGlobalFetchPatchInstalled() {
	return Boolean(globalThis[DEBUG_PROXY_FETCH_PATCH_KEY]);
}
function initializeDebugProxyCapture(mode, resolved, deps = {}) {
	const settings = resolved ?? resolveDebugProxySettings();
	if (!settings.enabled) return;
	resolveRuntimeDeps(deps).getStore(settings.dbPath, settings.blobDir).upsertSession({
		id: settings.sessionId,
		startedAt: Date.now(),
		mode,
		sourceScope: "openclaw",
		sourceProcess: settings.sourceProcess,
		proxyUrl: settings.proxyUrl,
		dbPath: settings.dbPath,
		blobDir: settings.blobDir
	});
	installDebugProxyGlobalFetchPatch(settings, deps);
}
function finalizeDebugProxyCapture(resolved, deps = {}) {
	const settings = resolved ?? resolveDebugProxySettings();
	if (!settings.enabled) return;
	const runtime = resolveRuntimeDeps(deps);
	runtime.getStore(settings.dbPath, settings.blobDir).endSession(settings.sessionId);
	uninstallDebugProxyGlobalFetchPatch(deps);
	runtime.closeStore();
}
function captureHttpExchange(params, resolved, deps = {}) {
	const settings = resolved ?? resolveDebugProxySettings();
	if (!settings.enabled) return;
	const runtime = resolveRuntimeDeps(deps);
	const store = runtime.getStore(settings.dbPath, settings.blobDir);
	const flowId = params.flowId ?? randomUUID();
	const url = new URL(params.url);
	const requestBody = typeof params.requestBody === "string" || Buffer.isBuffer(params.requestBody) ? params.requestBody : null;
	const requestPayload = runtime.persistEventPayload(store, {
		data: requestBody,
		contentType: params.requestHeaders instanceof Headers ? params.requestHeaders.get("content-type") ?? void 0 : params.requestHeaders?.["content-type"]
	});
	store.recordEvent({
		...createHttpCaptureEventBase({
			settings,
			rawUrl: params.url,
			url,
			transport: params.transport,
			direction: "outbound",
			kind: "request",
			flowId,
			method: params.method
		}),
		contentType: params.requestHeaders instanceof Headers ? params.requestHeaders.get("content-type") ?? void 0 : params.requestHeaders?.["content-type"],
		headersJson: runtime.safeJsonString(redactedCaptureHeaders(params.requestHeaders)),
		metaJson: runtime.safeJsonString(params.meta),
		...requestPayload
	});
	if (!(params.response && typeof params.response.clone === "function" && typeof params.response.arrayBuffer === "function")) {
		store.recordEvent({
			...createHttpCaptureEventBase({
				settings,
				rawUrl: params.url,
				url,
				transport: params.transport,
				direction: "inbound",
				kind: "response",
				flowId,
				method: params.method
			}),
			status: params.response.status,
			contentType: typeof params.response.headers?.get === "function" ? params.response.headers.get("content-type") ?? void 0 : void 0,
			headersJson: params.response.headers && typeof params.response.headers.entries === "function" ? runtime.safeJsonString(redactedCaptureHeaders(params.response.headers)) : void 0,
			metaJson: runtime.safeJsonString({
				...params.meta,
				bodyCapture: "unavailable"
			})
		});
		return;
	}
	params.response.clone().arrayBuffer().then((buffer) => {
		const responsePayload = runtime.persistEventPayload(store, {
			data: Buffer.from(buffer),
			contentType: params.response.headers.get("content-type") ?? void 0
		});
		store.recordEvent({
			...createHttpCaptureEventBase({
				settings,
				rawUrl: params.url,
				url,
				transport: params.transport,
				direction: "inbound",
				kind: "response",
				flowId,
				method: params.method
			}),
			status: params.response.status,
			contentType: params.response.headers.get("content-type") ?? void 0,
			headersJson: runtime.safeJsonString(redactedCaptureHeaders(params.response.headers)),
			metaJson: runtime.safeJsonString(params.meta),
			...responsePayload
		});
	}).catch((error) => {
		store.recordEvent({
			...createHttpCaptureEventBase({
				settings,
				rawUrl: params.url,
				url,
				transport: params.transport,
				direction: "local",
				kind: "error",
				flowId,
				method: params.method
			}),
			errorText: error instanceof Error ? error.message : String(error)
		});
	});
}
function captureWsEvent(params) {
	const settings = resolveDebugProxySettings();
	if (!settings.enabled) return;
	const store = getDebugProxyCaptureStore(settings.dbPath, settings.blobDir);
	const url = new URL(params.url);
	const payload = persistEventPayload(store, {
		data: params.payload,
		contentType: "application/json"
	});
	store.recordEvent({
		sessionId: settings.sessionId,
		ts: Date.now(),
		sourceScope: "openclaw",
		sourceProcess: settings.sourceProcess,
		protocol: protocolFromUrl(params.url),
		direction: params.direction,
		kind: params.kind,
		flowId: params.flowId,
		host: url.host,
		path: `${url.pathname}${url.search}`,
		closeCode: params.closeCode,
		errorText: params.errorText,
		metaJson: safeJsonString(params.meta),
		...payload
	});
}
//#endregion
export { isDebugProxyGlobalFetchPatchInstalled as a, closeDebugProxyCaptureStore as c, initializeDebugProxyCapture as i, getDebugProxyCaptureStore as l, captureWsEvent as n, DebugProxyCaptureStore as o, finalizeDebugProxyCapture as r, acquireDebugProxyCaptureStore as s, captureHttpExchange as t };
