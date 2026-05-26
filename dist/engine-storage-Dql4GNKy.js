import { t as installProcessWarningFilter } from "./warning-filter-Ek98bF5R.js";
import { t as configureSqliteWalMaintenance } from "./sqlite-wal-RZTJ93Pu.js";
import { r as normalizeOptionalString } from "./string-utils-xCz9RTVk.js";
import { t as formatErrorMessage } from "./error-utils-PBAKtEPD.js";
import "./fs-utils-DdhuqF2m.js";
import "./internal-CS1S1qm3.js";
import "./read-file-DT3HXSt4.js";
import "./backend-config-9Mpek5eW.js";
import { createRequire } from "node:module";
//#region packages/memory-host-sdk/src/host/memory-schema.ts
function ensureMemoryIndexSchema(params) {
	params.db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
	params.db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);
	params.db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
	if (params.cacheEnabled) {
		params.db.exec(`
      CREATE TABLE IF NOT EXISTS ${params.embeddingCacheTable} (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        dims INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model, provider_key, hash)
      );
    `);
		params.db.exec(`CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${params.embeddingCacheTable}(updated_at);`);
	}
	let ftsAvailable = false;
	let ftsError;
	if (params.ftsEnabled) try {
		const tokenizeClause = (params.ftsTokenizer ?? "unicode61") === "trigram" ? `, tokenize='trigram case_sensitive 0'` : "";
		params.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${params.ftsTable} USING fts5(\n  text,\n  id UNINDEXED,\n  path UNINDEXED,\n  source UNINDEXED,\n  model UNINDEXED,\n  start_line UNINDEXED,\n  end_line UNINDEXED\n${tokenizeClause});`);
		ftsAvailable = true;
	} catch (err) {
		const message = formatErrorMessage(err);
		ftsAvailable = false;
		ftsError = message;
	}
	ensureColumn(params.db, "files", "source", "TEXT NOT NULL DEFAULT 'memory'");
	ensureColumn(params.db, "chunks", "source", "TEXT NOT NULL DEFAULT 'memory'");
	params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
	params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);`);
	return {
		ftsAvailable,
		...ftsError ? { ftsError } : {}
	};
}
function ensureColumn(db, table, column, definition) {
	if (db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
//#endregion
//#region packages/memory-host-sdk/src/host/sqlite-vec-platform-variant.ts
const PLATFORM_VARIANTS = {
	"linux-x64": {
		pkg: "sqlite-vec-linux-x64",
		file: "vec0.so"
	},
	"linux-arm64": {
		pkg: "sqlite-vec-linux-arm64",
		file: "vec0.so"
	},
	"darwin-x64": {
		pkg: "sqlite-vec-darwin-x64",
		file: "vec0.dylib"
	},
	"darwin-arm64": {
		pkg: "sqlite-vec-darwin-arm64",
		file: "vec0.dylib"
	},
	"win32-x64": {
		pkg: "sqlite-vec-windows-x64",
		file: "vec0.dll"
	}
};
function resolveSqliteVecPlatformVariant() {
	const entry = PLATFORM_VARIANTS[`${process.platform}-${process.arch}`];
	if (!entry) return;
	try {
		const extensionPath = createRequire(import.meta.url).resolve(`${entry.pkg}/${entry.file}`);
		return {
			pkg: entry.pkg,
			extensionPath
		};
	} catch {
		return;
	}
}
//#endregion
//#region packages/memory-host-sdk/src/host/sqlite-vec.ts
const SQLITE_VEC_MODULE_ID = "sqlite-vec";
const SQLITE_VEC_CONFIG_HINT = "Set agents.defaults.memorySearch.store.vector.extensionPath, or an agent-specific memorySearch.store.vector.extensionPath, to a sqlite-vec loadable extension path.";
async function loadSqliteVecModule() {
	return import(SQLITE_VEC_MODULE_ID);
}
function isMissingSqliteVecPackageError(err) {
	const message = formatErrorMessage(err);
	const code = err && typeof err === "object" && "code" in err ? err.code : void 0;
	return /Cannot find (?:package|module) ['"]sqlite-vec['"]/u.test(message) && (code === void 0 || code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND");
}
async function loadSqliteVecExtension(params) {
	try {
		const resolvedPath = normalizeOptionalString(params.extensionPath);
		params.db.enableLoadExtension(true);
		if (resolvedPath) {
			params.db.loadExtension(resolvedPath);
			return {
				ok: true,
				extensionPath: resolvedPath
			};
		}
		try {
			const sqliteVec = await loadSqliteVecModule();
			const extensionPath = sqliteVec.getLoadablePath();
			sqliteVec.load(params.db);
			return {
				ok: true,
				extensionPath
			};
		} catch (err) {
			if (!isMissingSqliteVecPackageError(err)) throw err;
			const variant = resolveSqliteVecPlatformVariant();
			if (!variant) return {
				ok: false,
				error: `sqlite-vec package is not installed. ${SQLITE_VEC_CONFIG_HINT} Original error: ${formatErrorMessage(err)}`
			};
			try {
				params.db.loadExtension(variant.extensionPath);
				return {
					ok: true,
					extensionPath: variant.extensionPath
				};
			} catch (variantErr) {
				const message = formatErrorMessage(variantErr);
				return {
					ok: false,
					error: `sqlite-vec platform variant ${variant.pkg} failed to load from ${variant.extensionPath}. ${SQLITE_VEC_CONFIG_HINT} Original error: ${message}`
				};
			}
		}
	} catch (err) {
		return {
			ok: false,
			error: formatErrorMessage(err)
		};
	}
}
//#endregion
//#region packages/memory-host-sdk/src/host/sqlite.ts
const require = createRequire(import.meta.url);
const sqliteWalMaintenanceByDb = /* @__PURE__ */ new WeakMap();
function requireNodeSqlite() {
	installProcessWarningFilter();
	try {
		return require("node:sqlite");
	} catch (err) {
		const message = formatErrorMessage(err);
		throw new Error(`SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`, { cause: err });
	}
}
function configureMemorySqliteWalMaintenance(db, options) {
	const existing = sqliteWalMaintenanceByDb.get(db);
	if (existing) return existing;
	const maintenance = configureSqliteWalMaintenance(db, options);
	sqliteWalMaintenanceByDb.set(db, maintenance);
	return maintenance;
}
function closeMemorySqliteWalMaintenance(db) {
	const maintenance = sqliteWalMaintenanceByDb.get(db);
	if (!maintenance) return true;
	sqliteWalMaintenanceByDb.delete(db);
	return maintenance.close();
}
//#endregion
export { ensureMemoryIndexSchema as a, loadSqliteVecExtension as i, configureMemorySqliteWalMaintenance as n, requireNodeSqlite as r, closeMemorySqliteWalMaintenance as t };
