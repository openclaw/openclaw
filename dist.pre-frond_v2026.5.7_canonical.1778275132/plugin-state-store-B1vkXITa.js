import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { n as requireNodeSqlite, t as configureSqliteWalMaintenance } from "./sqlite-wal-DmwGqLNY.js";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
//#region src/plugin-state/plugin-state-store.paths.ts
function resolvePluginStateDir(env = process.env) {
	return path.join(resolveStateDir(env), "plugin-state");
}
function resolvePluginStateSqlitePath(env = process.env) {
	return path.join(resolvePluginStateDir(env), "state.sqlite");
}
//#endregion
//#region src/plugin-state/plugin-state-store.types.ts
var PluginStateStoreError = class extends Error {
	constructor(message, options) {
		super(message, { cause: options.cause });
		this.name = "PluginStateStoreError";
		this.code = options.code;
		this.operation = options.operation;
		if (options.path) this.path = options.path;
	}
};
//#endregion
//#region src/plugin-state/plugin-state-store.sqlite.ts
const PLUGIN_STATE_SCHEMA_VERSION = 1;
const PLUGIN_STATE_DIR_MODE = 448;
const PLUGIN_STATE_FILE_MODE = 384;
const PLUGIN_STATE_SIDECAR_SUFFIXES = [
	"",
	"-shm",
	"-wal"
];
const MAX_ENTRIES_PER_PLUGIN = 1e3;
let cachedDatabase = null;
function normalizeNumber(value) {
	if (typeof value === "bigint") return Number(value);
	return typeof value === "number" ? value : void 0;
}
function createPluginStateError(params) {
	return new PluginStateStoreError(params.message, {
		code: params.code,
		operation: params.operation,
		...params.path ? { path: params.path } : {},
		cause: params.cause
	});
}
function wrapPluginStateError(error, operation, fallbackCode, message, pathname = resolvePluginStateSqlitePath(process.env)) {
	if (error instanceof PluginStateStoreError) return error;
	return createPluginStateError({
		code: fallbackCode,
		operation,
		message,
		path: pathname,
		cause: error
	});
}
function parseStoredJson(raw, operation) {
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw createPluginStateError({
			code: "PLUGIN_STATE_CORRUPT",
			operation,
			message: "Plugin state entry contains corrupt JSON.",
			path: resolvePluginStateSqlitePath(process.env),
			cause: error
		});
	}
}
function rowToEntry(row, operation) {
	const expiresAt = normalizeNumber(row.expires_at);
	return {
		key: row.entry_key,
		value: parseStoredJson(row.value_json, operation),
		createdAt: normalizeNumber(row.created_at) ?? 0,
		...expiresAt != null ? { expiresAt } : {}
	};
}
function getUserVersion(db) {
	const raw = db.prepare("PRAGMA user_version").get()?.user_version ?? 0;
	return typeof raw === "bigint" ? Number(raw) : raw;
}
function ensureSchema(db, pathname) {
	const userVersion = getUserVersion(db);
	if (userVersion > PLUGIN_STATE_SCHEMA_VERSION) throw createPluginStateError({
		code: "PLUGIN_STATE_SCHEMA_UNSUPPORTED",
		operation: "ensure-schema",
		message: `Plugin state database schema version ${userVersion} is newer than supported version ${PLUGIN_STATE_SCHEMA_VERSION}.`,
		path: pathname
	});
	db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_state_entries (
      plugin_id  TEXT    NOT NULL,
      namespace  TEXT    NOT NULL,
      entry_key  TEXT    NOT NULL,
      value_json TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (plugin_id, namespace, entry_key)
    );

    CREATE INDEX IF NOT EXISTS idx_plugin_state_expiry
      ON plugin_state_entries(expires_at)
      WHERE expires_at IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_plugin_state_listing
      ON plugin_state_entries(plugin_id, namespace, created_at, entry_key);

    PRAGMA user_version = ${PLUGIN_STATE_SCHEMA_VERSION};
  `);
}
function createStatements(db) {
	return {
		upsertEntry: db.prepare(`
      INSERT INTO plugin_state_entries (
        plugin_id,
        namespace,
        entry_key,
        value_json,
        created_at,
        expires_at
      ) VALUES (
        @plugin_id,
        @namespace,
        @entry_key,
        @value_json,
        @created_at,
        @expires_at
      )
      ON CONFLICT(plugin_id, namespace, entry_key) DO UPDATE SET
        value_json = excluded.value_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `),
		insertEntryIfAbsent: db.prepare(`
      INSERT OR IGNORE INTO plugin_state_entries (
        plugin_id,
        namespace,
        entry_key,
        value_json,
        created_at,
        expires_at
      ) VALUES (
        @plugin_id,
        @namespace,
        @entry_key,
        @value_json,
        @created_at,
        @expires_at
      )
    `),
		selectEntry: db.prepare(`
      SELECT plugin_id, namespace, entry_key, value_json, created_at, expires_at
      FROM plugin_state_entries
      WHERE plugin_id = ?
        AND namespace = ?
        AND entry_key = ?
        AND (expires_at IS NULL OR expires_at > ?)
    `),
		selectEntries: db.prepare(`
      SELECT plugin_id, namespace, entry_key, value_json, created_at, expires_at
      FROM plugin_state_entries
      WHERE plugin_id = ?
        AND namespace = ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at ASC, entry_key ASC
    `),
		deleteEntry: db.prepare(`
      DELETE FROM plugin_state_entries
      WHERE plugin_id = ? AND namespace = ? AND entry_key = ?
    `),
		clearNamespace: db.prepare(`
      DELETE FROM plugin_state_entries
      WHERE plugin_id = ? AND namespace = ?
    `),
		pruneExpiredNamespace: db.prepare(`
      DELETE FROM plugin_state_entries
      WHERE plugin_id = ?
        AND namespace = ?
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `),
		countLiveNamespace: db.prepare(`
      SELECT COUNT(*) AS count
      FROM plugin_state_entries
      WHERE plugin_id = ?
        AND namespace = ?
        AND (expires_at IS NULL OR expires_at > ?)
    `),
		countLivePlugin: db.prepare(`
      SELECT COUNT(*) AS count
      FROM plugin_state_entries
      WHERE plugin_id = ?
        AND (expires_at IS NULL OR expires_at > ?)
    `),
		deleteOldestNamespace: db.prepare(`
      DELETE FROM plugin_state_entries
      WHERE rowid IN (
        SELECT rowid
        FROM plugin_state_entries
        WHERE plugin_id = ?
          AND namespace = ?
          AND entry_key <> ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at ASC, entry_key ASC
        LIMIT ?
      )
    `),
		sweepExpired: db.prepare(`
      DELETE FROM plugin_state_entries
      WHERE expires_at IS NOT NULL AND expires_at <= ?
    `)
	};
}
function ensurePluginStatePermissions(pathname) {
	const dir = resolvePluginStateDir(process.env);
	mkdirSync(dir, {
		recursive: true,
		mode: PLUGIN_STATE_DIR_MODE
	});
	chmodSync(dir, PLUGIN_STATE_DIR_MODE);
	for (const suffix of PLUGIN_STATE_SIDECAR_SUFFIXES) {
		const candidate = `${pathname}${suffix}`;
		if (existsSync(candidate)) chmodSync(candidate, PLUGIN_STATE_FILE_MODE);
	}
}
function ensurePluginStatePermissionsBestEffort(pathname) {
	try {
		ensurePluginStatePermissions(pathname);
	} catch {}
}
function openPluginStateDatabase(operation = "open") {
	const pathname = resolvePluginStateSqlitePath(process.env);
	if (cachedDatabase && cachedDatabase.path === pathname) return cachedDatabase;
	if (cachedDatabase) {
		cachedDatabase.walMaintenance.close();
		cachedDatabase.db.close();
		cachedDatabase = null;
	}
	try {
		ensurePluginStatePermissions(pathname);
	} catch (error) {
		throw createPluginStateError({
			code: "PLUGIN_STATE_OPEN_FAILED",
			operation,
			message: "Failed to prepare the plugin state database directory.",
			path: pathname,
			cause: error
		});
	}
	let sqlite;
	try {
		sqlite = requireNodeSqlite();
	} catch (error) {
		throw createPluginStateError({
			code: "PLUGIN_STATE_SQLITE_UNAVAILABLE",
			operation: "load-sqlite",
			message: "SQLite support is unavailable for plugin state storage.",
			path: pathname,
			cause: error
		});
	}
	try {
		const db = new sqlite.DatabaseSync(pathname);
		const walMaintenance = configureSqliteWalMaintenance(db);
		db.exec("PRAGMA synchronous = NORMAL;");
		db.exec("PRAGMA busy_timeout = 5000;");
		ensureSchema(db, pathname);
		ensurePluginStatePermissions(pathname);
		cachedDatabase = {
			db,
			path: pathname,
			statements: createStatements(db),
			walMaintenance
		};
		return cachedDatabase;
	} catch (error) {
		throw wrapPluginStateError(error, operation, "PLUGIN_STATE_OPEN_FAILED", "Failed to open the plugin state database.", pathname);
	}
}
function countRow(row) {
	const raw = row?.count ?? 0;
	return typeof raw === "bigint" ? Number(raw) : raw;
}
function runWriteTransaction(operation, write) {
	const store = openPluginStateDatabase(operation);
	ensurePluginStatePermissions(store.path);
	store.db.exec("BEGIN IMMEDIATE");
	try {
		const result = write(store);
		store.db.exec("COMMIT");
		ensurePluginStatePermissionsBestEffort(store.path);
		return result;
	} catch (error) {
		try {
			store.db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
}
function enforcePostRegisterLimits(params) {
	const namespaceCount = countRow(params.store.statements.countLiveNamespace.get(params.pluginId, params.namespace, params.now));
	if (namespaceCount > params.maxEntries) params.store.statements.deleteOldestNamespace.run(params.pluginId, params.namespace, params.protectedKey, params.now, namespaceCount - params.maxEntries);
	if (countRow(params.store.statements.countLivePlugin.get(params.pluginId, params.now)) > MAX_ENTRIES_PER_PLUGIN) throw createPluginStateError({
		code: "PLUGIN_STATE_LIMIT_EXCEEDED",
		operation: "register",
		message: `Plugin state for ${params.pluginId} exceeds the ${MAX_ENTRIES_PER_PLUGIN} live row limit.`,
		path: params.store.path
	});
}
function pluginStateRegister(params) {
	try {
		runWriteTransaction("register", (store) => {
			const now = Date.now();
			const expiresAt = params.ttlMs == null ? null : now + params.ttlMs;
			store.statements.pruneExpiredNamespace.run(params.pluginId, params.namespace, now);
			store.statements.upsertEntry.run({
				plugin_id: params.pluginId,
				namespace: params.namespace,
				entry_key: params.key,
				value_json: params.valueJson,
				created_at: now,
				expires_at: expiresAt
			});
			enforcePostRegisterLimits({
				store,
				pluginId: params.pluginId,
				namespace: params.namespace,
				maxEntries: params.maxEntries,
				now,
				protectedKey: params.key
			});
		});
	} catch (error) {
		throw wrapPluginStateError(error, "register", "PLUGIN_STATE_WRITE_FAILED", "Failed to register plugin state entry.");
	}
}
function pluginStateRegisterIfAbsent(params) {
	try {
		return runWriteTransaction("register", (store) => {
			const now = Date.now();
			const expiresAt = params.ttlMs == null ? null : now + params.ttlMs;
			store.statements.pruneExpiredNamespace.run(params.pluginId, params.namespace, now);
			if (store.statements.insertEntryIfAbsent.run({
				plugin_id: params.pluginId,
				namespace: params.namespace,
				entry_key: params.key,
				value_json: params.valueJson,
				created_at: now,
				expires_at: expiresAt
			}).changes === 0) return false;
			enforcePostRegisterLimits({
				store,
				pluginId: params.pluginId,
				namespace: params.namespace,
				maxEntries: params.maxEntries,
				now,
				protectedKey: params.key
			});
			return true;
		});
	} catch (error) {
		throw wrapPluginStateError(error, "register", "PLUGIN_STATE_WRITE_FAILED", "Failed to register plugin state entry.");
	}
}
function pluginStateLookup(params) {
	try {
		const { statements } = openPluginStateDatabase("lookup");
		const row = statements.selectEntry.get(params.pluginId, params.namespace, params.key, Date.now());
		return row ? parseStoredJson(row.value_json, "lookup") : void 0;
	} catch (error) {
		throw wrapPluginStateError(error, "lookup", "PLUGIN_STATE_READ_FAILED", "Failed to read plugin state entry.");
	}
}
function pluginStateConsume(params) {
	try {
		return runWriteTransaction("consume", (store) => {
			const row = store.statements.selectEntry.get(params.pluginId, params.namespace, params.key, Date.now());
			if (!row) return;
			store.statements.deleteEntry.run(params.pluginId, params.namespace, params.key);
			return parseStoredJson(row.value_json, "consume");
		});
	} catch (error) {
		throw wrapPluginStateError(error, "consume", "PLUGIN_STATE_READ_FAILED", "Failed to consume plugin state entry.");
	}
}
function pluginStateDelete(params) {
	try {
		const { statements } = openPluginStateDatabase("delete");
		return statements.deleteEntry.run(params.pluginId, params.namespace, params.key).changes > 0;
	} catch (error) {
		throw wrapPluginStateError(error, "delete", "PLUGIN_STATE_WRITE_FAILED", "Failed to delete plugin state entry.");
	}
}
function pluginStateEntries(params) {
	try {
		const { statements } = openPluginStateDatabase("entries");
		return statements.selectEntries.all(params.pluginId, params.namespace, Date.now()).map((row) => rowToEntry(row, "entries"));
	} catch (error) {
		throw wrapPluginStateError(error, "entries", "PLUGIN_STATE_READ_FAILED", "Failed to list plugin state entries.");
	}
}
function pluginStateClear(params) {
	try {
		const { statements } = openPluginStateDatabase("clear");
		statements.clearNamespace.run(params.pluginId, params.namespace);
	} catch (error) {
		throw wrapPluginStateError(error, "clear", "PLUGIN_STATE_WRITE_FAILED", "Failed to clear plugin state namespace.");
	}
}
function sweepExpiredPluginStateEntries() {
	try {
		const { statements } = openPluginStateDatabase("sweep");
		const result = statements.sweepExpired.run(Date.now());
		return Number(result.changes);
	} catch (error) {
		throw wrapPluginStateError(error, "sweep", "PLUGIN_STATE_WRITE_FAILED", "Failed to sweep expired plugin state entries.");
	}
}
function isPluginStateDatabaseOpen() {
	return cachedDatabase !== null;
}
function closePluginStateSqliteStore() {
	if (!cachedDatabase) return;
	try {
		cachedDatabase.walMaintenance.close();
		cachedDatabase.db.close();
		cachedDatabase = null;
	} catch (error) {
		cachedDatabase = null;
		throw wrapPluginStateError(error, "close", "PLUGIN_STATE_WRITE_FAILED", "Failed to close plugin state database.");
	}
}
//#endregion
//#region src/plugin-state/plugin-state-store.ts
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;
const MAX_NAMESPACE_BYTES = 128;
const MAX_KEY_BYTES = 512;
const MAX_JSON_DEPTH = 64;
const namespaceOptionSignatures = /* @__PURE__ */ new Map();
const textEncoder = new TextEncoder();
function invalidInput(message, operation = "register") {
	return new PluginStateStoreError(message, {
		code: "PLUGIN_STATE_INVALID_INPUT",
		operation
	});
}
function assertMaxBytes(label, value, max, operation = "register") {
	if (textEncoder.encode(value).byteLength > max) throw invalidInput(`plugin state ${label} must be <= ${max} bytes`, operation);
}
function validateNamespace(value, operation = "open") {
	const trimmed = value.trim();
	if (!NAMESPACE_PATTERN.test(trimmed)) throw invalidInput(`plugin state namespace must be a safe path segment: ${value}`, operation);
	assertMaxBytes("namespace", trimmed, MAX_NAMESPACE_BYTES, operation);
	return trimmed;
}
function validateKey(value, operation = "register") {
	const trimmed = value.trim();
	if (!trimmed) throw invalidInput("plugin state entry key must not be empty", operation);
	assertMaxBytes("entry key", trimmed, MAX_KEY_BYTES, operation);
	return trimmed;
}
function validateMaxEntries(value) {
	if (!Number.isInteger(value) || value < 1) throw invalidInput("plugin state maxEntries must be an integer >= 1", "open");
	return value;
}
function validateOptionalTtlMs(value, operation = "register") {
	if (value == null) return;
	if (!Number.isInteger(value) || value < 1) throw invalidInput("plugin state ttlMs must be a positive integer", operation);
	return value;
}
function assertPlainJsonValue(value, seen, path, depth = 0) {
	if (depth > MAX_JSON_DEPTH) throw new PluginStateStoreError(`plugin state value nesting exceeds maximum depth of ${MAX_JSON_DEPTH}`, {
		code: "PLUGIN_STATE_LIMIT_EXCEEDED",
		operation: "register"
	});
	if (value === null) return;
	const valueType = typeof value;
	if (valueType === "string" || valueType === "boolean") return;
	if (valueType === "number") {
		if (!Number.isFinite(value)) throw invalidInput(`plugin state value at ${path} must be a finite number`);
		return;
	}
	if (valueType !== "object") throw invalidInput(`plugin state value at ${path} must be JSON-serializable`);
	const objectValue = value;
	if (seen.has(objectValue)) throw invalidInput(`plugin state value at ${path} must not contain circular references`);
	seen.add(objectValue);
	try {
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index += 1) {
				if (!(index in value)) throw invalidInput(`plugin state array at ${path} must not be sparse`);
				assertPlainJsonValue(value[index], seen, `${path}[${index}]`, depth + 1);
			}
			return;
		}
		if (Object.getPrototypeOf(objectValue) !== Object.prototype) throw invalidInput(`plugin state object at ${path} must be a plain object`);
		const descriptorEntries = Object.entries(Object.getOwnPropertyDescriptors(objectValue));
		const enumerableKeys = Object.keys(objectValue);
		if (Object.getOwnPropertySymbols(objectValue).length > 0) throw invalidInput(`plugin state object at ${path} must not use symbol keys`);
		if (descriptorEntries.length !== enumerableKeys.length) throw invalidInput(`plugin state object at ${path} must not use non-enumerable properties`);
		for (const [key, descriptor] of descriptorEntries) {
			if (descriptor.get || descriptor.set || !("value" in descriptor)) throw invalidInput(`plugin state object at ${path}.${key} must use data properties`);
			assertPlainJsonValue(descriptor.value, seen, `${path}.${key}`, depth + 1);
		}
	} finally {
		seen.delete(objectValue);
	}
}
function assertJsonSerializable(value) {
	assertPlainJsonValue(value, /* @__PURE__ */ new WeakSet(), "value");
}
function assertValueSize(json) {
	if (textEncoder.encode(json).byteLength > 65536) throw new PluginStateStoreError("plugin state value exceeds 64KB limit", {
		code: "PLUGIN_STATE_LIMIT_EXCEEDED",
		operation: "register"
	});
}
function assertConsistentOptions(pluginId, namespace, signature) {
	const key = `${pluginId}\0${namespace}`;
	const existing = namespaceOptionSignatures.get(key);
	if (!existing) {
		namespaceOptionSignatures.set(key, signature);
		return;
	}
	if (existing.maxEntries !== signature.maxEntries || existing.defaultTtlMs !== signature.defaultTtlMs) throw invalidInput(`plugin state namespace ${namespace} for ${pluginId} was reopened with incompatible options`, "open");
}
function createKeyedStoreForPluginId(pluginId, options) {
	const namespace = validateNamespace(options.namespace);
	const maxEntries = validateMaxEntries(options.maxEntries);
	const defaultTtlMs = validateOptionalTtlMs(options.defaultTtlMs);
	assertConsistentOptions(pluginId, namespace, {
		maxEntries,
		defaultTtlMs
	});
	const prepareRegisterParams = (key, value, opts) => {
		const normalizedKey = validateKey(key, "register");
		assertJsonSerializable(value);
		const json = JSON.stringify(value);
		assertValueSize(json);
		const ttlMs = validateOptionalTtlMs(opts?.ttlMs, "register") ?? defaultTtlMs;
		return {
			key: normalizedKey,
			valueJson: json,
			...ttlMs != null ? { ttlMs } : {}
		};
	};
	return {
		async register(key, value, opts) {
			const params = prepareRegisterParams(key, value, opts);
			pluginStateRegister({
				pluginId,
				namespace,
				key: params.key,
				valueJson: params.valueJson,
				maxEntries,
				...params.ttlMs != null ? { ttlMs: params.ttlMs } : {}
			});
		},
		async registerIfAbsent(key, value, opts) {
			const params = prepareRegisterParams(key, value, opts);
			return pluginStateRegisterIfAbsent({
				pluginId,
				namespace,
				key: params.key,
				valueJson: params.valueJson,
				maxEntries,
				...params.ttlMs != null ? { ttlMs: params.ttlMs } : {}
			});
		},
		async lookup(key) {
			return pluginStateLookup({
				pluginId,
				namespace,
				key: validateKey(key, "lookup")
			});
		},
		async consume(key) {
			return pluginStateConsume({
				pluginId,
				namespace,
				key: validateKey(key, "consume")
			});
		},
		async delete(key) {
			return pluginStateDelete({
				pluginId,
				namespace,
				key: validateKey(key, "delete")
			});
		},
		async entries() {
			return pluginStateEntries({
				pluginId,
				namespace
			});
		},
		async clear() {
			pluginStateClear({
				pluginId,
				namespace
			});
		}
	};
}
function createPluginStateKeyedStore(pluginId, options) {
	if (pluginId.startsWith("core:")) throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
	return createKeyedStoreForPluginId(pluginId, options);
}
//#endregion
export { sweepExpiredPluginStateEntries as i, closePluginStateSqliteStore as n, isPluginStateDatabaseOpen as r, createPluginStateKeyedStore as t };
