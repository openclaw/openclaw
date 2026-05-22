import { createRequire } from "node:module";
import os, { homedir } from "node:os";
import path, { dirname, join } from "node:path";
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import "node:url";
import { randomUUID } from "node:crypto";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
//#endregion
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
    CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_playbook ON cw_playbook_runs(playbook_id);
    CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_status ON cw_playbook_runs(status);
    CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_started ON cw_playbook_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cw_events_type ON cw_events(type);
    CREATE INDEX IF NOT EXISTS idx_cw_events_timestamp ON cw_events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_cw_outbox_due ON cw_outbox(next_attempt_at) WHERE is_dead = 0;
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
//#region ../../src/security/safe-regex.ts
const SAFE_REGEX_CACHE_MAX = 256;
const safeRegexCache = /* @__PURE__ */ new Map();
function createParseFrame() {
	return {
		lastToken: null,
		containsRepetition: false,
		hasAlternation: false,
		branchMinLength: 0,
		branchMaxLength: 0,
		altMinLength: null,
		altMaxLength: null
	};
}
function addLength(left, right) {
	if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
	return left + right;
}
function multiplyLength(length, factor) {
	if (!Number.isFinite(length)) return factor === 0 ? 0 : Number.POSITIVE_INFINITY;
	return length * factor;
}
function recordAlternative(frame) {
	if (frame.altMinLength === null || frame.altMaxLength === null) {
		frame.altMinLength = frame.branchMinLength;
		frame.altMaxLength = frame.branchMaxLength;
		return;
	}
	frame.altMinLength = Math.min(frame.altMinLength, frame.branchMinLength);
	frame.altMaxLength = Math.max(frame.altMaxLength, frame.branchMaxLength);
}
function readQuantifier(source, index) {
	const ch = source[index];
	const consumed = source[index + 1] === "?" ? 2 : 1;
	if (ch === "*") return {
		consumed,
		minRepeat: 0,
		maxRepeat: null
	};
	if (ch === "+") return {
		consumed,
		minRepeat: 1,
		maxRepeat: null
	};
	if (ch === "?") return {
		consumed,
		minRepeat: 0,
		maxRepeat: 1
	};
	if (ch !== "{") return null;
	let i = index + 1;
	while (i < source.length && /\d/.test(source[i])) i += 1;
	if (i === index + 1) return null;
	const minRepeat = Number.parseInt(source.slice(index + 1, i), 10);
	let maxRepeat = minRepeat;
	if (source[i] === ",") {
		i += 1;
		const maxStart = i;
		while (i < source.length && /\d/.test(source[i])) i += 1;
		maxRepeat = i === maxStart ? null : Number.parseInt(source.slice(maxStart, i), 10);
	}
	if (source[i] !== "}") return null;
	i += 1;
	if (source[i] === "?") i += 1;
	if (maxRepeat !== null && maxRepeat < minRepeat) return null;
	return {
		consumed: i - index,
		minRepeat,
		maxRepeat
	};
}
function tokenizePattern(source) {
	const tokens = [];
	let inCharClass = false;
	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i];
		if (inCharClass) {
			if (ch === "\\") {
				i += 1;
				continue;
			}
			if (ch === "]") inCharClass = false;
			continue;
		}
		if (ch === "\\") {
			i += 1;
			tokens.push({ kind: "simple-token" });
			continue;
		}
		if (ch === "[") {
			inCharClass = true;
			tokens.push({ kind: "simple-token" });
			continue;
		}
		if (ch === "(") {
			tokens.push({ kind: "group-open" });
			continue;
		}
		if (ch === ")") {
			tokens.push({ kind: "group-close" });
			continue;
		}
		if (ch === "|") {
			tokens.push({ kind: "alternation" });
			continue;
		}
		const quantifier = readQuantifier(source, i);
		if (quantifier) {
			tokens.push({
				kind: "quantifier",
				quantifier
			});
			i += quantifier.consumed - 1;
			continue;
		}
		tokens.push({ kind: "simple-token" });
	}
	return tokens;
}
function analyzeTokensForNestedRepetition(tokens) {
	const frames = [createParseFrame()];
	const emitToken = (token) => {
		const frame = frames[frames.length - 1];
		frame.lastToken = token;
		if (token.containsRepetition) frame.containsRepetition = true;
		frame.branchMinLength = addLength(frame.branchMinLength, token.minLength);
		frame.branchMaxLength = addLength(frame.branchMaxLength, token.maxLength);
	};
	const emitSimpleToken = () => {
		emitToken({
			containsRepetition: false,
			hasAmbiguousAlternation: false,
			minLength: 1,
			maxLength: 1
		});
	};
	for (const token of tokens) {
		if (token.kind === "simple-token") {
			emitSimpleToken();
			continue;
		}
		if (token.kind === "group-open") {
			frames.push(createParseFrame());
			continue;
		}
		if (token.kind === "group-close") {
			if (frames.length > 1) {
				const frame = frames.pop();
				if (frame.hasAlternation) recordAlternative(frame);
				const groupMinLength = frame.hasAlternation ? frame.altMinLength ?? 0 : frame.branchMinLength;
				const groupMaxLength = frame.hasAlternation ? frame.altMaxLength ?? 0 : frame.branchMaxLength;
				emitToken({
					containsRepetition: frame.containsRepetition,
					hasAmbiguousAlternation: frame.hasAlternation && frame.altMinLength !== null && frame.altMaxLength !== null && frame.altMinLength !== frame.altMaxLength,
					minLength: groupMinLength,
					maxLength: groupMaxLength
				});
			}
			continue;
		}
		if (token.kind === "alternation") {
			const frame = frames[frames.length - 1];
			frame.hasAlternation = true;
			recordAlternative(frame);
			frame.branchMinLength = 0;
			frame.branchMaxLength = 0;
			frame.lastToken = null;
			continue;
		}
		const frame = frames[frames.length - 1];
		const previousToken = frame.lastToken;
		if (!previousToken) continue;
		if (previousToken.containsRepetition) return true;
		if (previousToken.hasAmbiguousAlternation && token.quantifier.maxRepeat === null) return true;
		const previousMinLength = previousToken.minLength;
		const previousMaxLength = previousToken.maxLength;
		previousToken.minLength = multiplyLength(previousToken.minLength, token.quantifier.minRepeat);
		previousToken.maxLength = token.quantifier.maxRepeat === null ? Number.POSITIVE_INFINITY : multiplyLength(previousToken.maxLength, token.quantifier.maxRepeat);
		previousToken.containsRepetition = true;
		frame.containsRepetition = true;
		frame.branchMinLength = frame.branchMinLength - previousMinLength + previousToken.minLength;
		frame.branchMaxLength = addLength(Number.isFinite(frame.branchMaxLength) && Number.isFinite(previousMaxLength) ? frame.branchMaxLength - previousMaxLength : Number.POSITIVE_INFINITY, previousToken.maxLength);
	}
	return false;
}
function hasNestedRepetition(source) {
	return analyzeTokensForNestedRepetition(tokenizePattern(source));
}
function compileSafeRegexDetailed(source, flags = "") {
	const trimmed = source.trim();
	if (!trimmed) return {
		regex: null,
		source: trimmed,
		flags,
		reason: "empty"
	};
	const cacheKey = `${flags}::${trimmed}`;
	if (safeRegexCache.has(cacheKey)) return safeRegexCache.get(cacheKey) ?? {
		regex: null,
		source: trimmed,
		flags,
		reason: "invalid-regex"
	};
	let result;
	if (hasNestedRepetition(trimmed)) result = {
		regex: null,
		source: trimmed,
		flags,
		reason: "unsafe-nested-repetition"
	};
	else try {
		result = {
			regex: new RegExp(trimmed, flags),
			source: trimmed,
			flags,
			reason: null
		};
	} catch {
		result = {
			regex: null,
			source: trimmed,
			flags,
			reason: "invalid-regex"
		};
	}
	safeRegexCache.set(cacheKey, result);
	if (safeRegexCache.size > SAFE_REGEX_CACHE_MAX) {
		const oldestKey = safeRegexCache.keys().next().value;
		if (oldestKey) safeRegexCache.delete(oldestKey);
	}
	return result;
}
//#endregion
//#region ../../src/security/config-regex.ts
function normalizeRejectReason(result) {
	if (result.reason === null || result.reason === "empty") return null;
	return result.reason;
}
function compileConfigRegex(pattern, flags = "") {
	const result = compileSafeRegexDetailed(pattern, flags);
	if (result.reason === "empty") return null;
	return {
		regex: result.regex,
		pattern: result.source,
		flags: result.flags,
		reason: normalizeRejectReason(result)
	};
}
//#endregion
//#region ../../node_modules/json5/lib/unicode.js
var require_unicode = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports.Space_Separator = /[\u1680\u2000-\u200A\u202F\u205F\u3000]/;
	module.exports.ID_Start = /[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u1884\u1887-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C88\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE4\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC03-\uDC37\uDC83-\uDCAF\uDCD0-\uDCE8\uDD03-\uDD26\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE2B\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEDE\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF50\uDF5D-\uDF61]|\uD805[\uDC00-\uDC34\uDC47-\uDC4A\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDD80-\uDDAE\uDDD8-\uDDDB\uDE00-\uDE2F\uDE44\uDE80-\uDEAA\uDF00-\uDF19]|\uD806[\uDCA0-\uDCDF\uDCFF\uDE00\uDE0B-\uDE32\uDE3A\uDE50\uDE5C-\uDE83\uDE86-\uDE89\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2E\uDC40\uDC72-\uDC8F\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD30\uDD46]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDED0-\uDEED\uDF00-\uDF2F\uDF40-\uDF43\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50\uDF93-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD83A[\uDC00-\uDCC4\uDD00-\uDD43]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]/;
	module.exports.ID_Continue = /[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0300-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u0483-\u0487\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05F0-\u05F2\u0610-\u061A\u0620-\u0669\u066E-\u06D3\u06D5-\u06DC\u06DF-\u06E8\u06EA-\u06FC\u06FF\u0710-\u074A\u074D-\u07B1\u07C0-\u07F5\u07FA\u0800-\u082D\u0840-\u085B\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u08D4-\u08E1\u08E3-\u0963\u0966-\u096F\u0971-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09F1\u09FC\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AEF\u0AF9-\u0AFF\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B6F\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BEF\u0C00-\u0C03\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58-\u0C5A\u0C60-\u0C63\u0C66-\u0C6F\u0C80-\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D00-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D44\u0D46-\u0D48\u0D4A-\u0D4E\u0D54-\u0D57\u0D5F-\u0D63\u0D66-\u0D6F\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E4E\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F47\u0F49-\u0F6C\u0F71-\u0F84\u0F86-\u0F97\u0F99-\u0FBC\u0FC6\u1000-\u1049\u1050-\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u135F\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17D3\u17D7\u17DC\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u1820-\u1877\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19D9\u1A00-\u1A1B\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA7\u1AB0-\u1ABD\u1B00-\u1B4B\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1BF3\u1C00-\u1C37\u1C40-\u1C49\u1C4D-\u1C7D\u1C80-\u1C88\u1CD0-\u1CD2\u1CD4-\u1CF9\u1D00-\u1DF9\u1DFB-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u203F\u2040\u2054\u2071\u207F\u2090-\u209C\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u2E2F\u3005-\u3007\u3021-\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u3099\u309A\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66F\uA674-\uA67D\uA67F-\uA6F1\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA827\uA840-\uA873\uA880-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F7\uA8FB\uA8FD\uA900-\uA92D\uA930-\uA953\uA960-\uA97C\uA980-\uA9C0\uA9CF-\uA9D9\uA9E0-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA60-\uAA76\uAA7A-\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABEA\uABEC\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF3F\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDDFD\uDE80-\uDE9C\uDEA0-\uDED0\uDEE0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF7A\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00-\uDE03\uDE05\uDE06\uDE0C-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE38-\uDE3A\uDE3F\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE6\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC00-\uDC46\uDC66-\uDC6F\uDC7F-\uDCBA\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD00-\uDD34\uDD36-\uDD3F\uDD50-\uDD73\uDD76\uDD80-\uDDC4\uDDCA-\uDDCC\uDDD0-\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE37\uDE3E\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEEA\uDEF0-\uDEF9\uDF00-\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3C-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF50\uDF57\uDF5D-\uDF63\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC00-\uDC4A\uDC50-\uDC59\uDC80-\uDCC5\uDCC7\uDCD0-\uDCD9\uDD80-\uDDB5\uDDB8-\uDDC0\uDDD8-\uDDDD\uDE00-\uDE40\uDE44\uDE50-\uDE59\uDE80-\uDEB7\uDEC0-\uDEC9\uDF00-\uDF19\uDF1D-\uDF2B\uDF30-\uDF39]|\uD806[\uDCA0-\uDCE9\uDCFF\uDE00-\uDE3E\uDE47\uDE50-\uDE83\uDE86-\uDE99\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC36\uDC38-\uDC40\uDC50-\uDC59\uDC72-\uDC8F\uDC92-\uDCA7\uDCA9-\uDCB6\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD47\uDD50-\uDD59]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDED0-\uDEED\uDEF0-\uDEF4\uDF00-\uDF36\uDF40-\uDF43\uDF50-\uDF59\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50-\uDF7E\uDF8F-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9D\uDC9E]|\uD834[\uDD65-\uDD69\uDD6D-\uDD72\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB\uDFCE-\uDFFF]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDC00-\uDCC4\uDCD0-\uDCD6\uDD00-\uDD4A\uDD50-\uDD59]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]|\uDB40[\uDD00-\uDDEF]/;
}));
//#endregion
//#region ../../node_modules/json5/lib/util.js
var require_util = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const unicode = require_unicode();
	module.exports = {
		isSpaceSeparator(c) {
			return typeof c === "string" && unicode.Space_Separator.test(c);
		},
		isIdStartChar(c) {
			return typeof c === "string" && (c >= "a" && c <= "z" || c >= "A" && c <= "Z" || c === "$" || c === "_" || unicode.ID_Start.test(c));
		},
		isIdContinueChar(c) {
			return typeof c === "string" && (c >= "a" && c <= "z" || c >= "A" && c <= "Z" || c >= "0" && c <= "9" || c === "$" || c === "_" || c === "‌" || c === "‍" || unicode.ID_Continue.test(c));
		},
		isDigit(c) {
			return typeof c === "string" && /[0-9]/.test(c);
		},
		isHexDigit(c) {
			return typeof c === "string" && /[0-9A-Fa-f]/.test(c);
		}
	};
}));
//#endregion
//#region ../../node_modules/json5/lib/parse.js
var require_parse = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const util = require_util();
	let source;
	let parseState;
	let stack;
	let pos;
	let line;
	let column;
	let token;
	let key;
	let root;
	module.exports = function parse(text, reviver) {
		source = String(text);
		parseState = "start";
		stack = [];
		pos = 0;
		line = 1;
		column = 0;
		token = void 0;
		key = void 0;
		root = void 0;
		do {
			token = lex();
			parseStates[parseState]();
		} while (token.type !== "eof");
		if (typeof reviver === "function") return internalize({ "": root }, "", reviver);
		return root;
	};
	function internalize(holder, name, reviver) {
		const value = holder[name];
		if (value != null && typeof value === "object") if (Array.isArray(value)) for (let i = 0; i < value.length; i++) {
			const key = String(i);
			const replacement = internalize(value, key, reviver);
			if (replacement === void 0) delete value[key];
			else Object.defineProperty(value, key, {
				value: replacement,
				writable: true,
				enumerable: true,
				configurable: true
			});
		}
		else for (const key in value) {
			const replacement = internalize(value, key, reviver);
			if (replacement === void 0) delete value[key];
			else Object.defineProperty(value, key, {
				value: replacement,
				writable: true,
				enumerable: true,
				configurable: true
			});
		}
		return reviver.call(holder, name, value);
	}
	let lexState;
	let buffer;
	let doubleQuote;
	let sign;
	let c;
	function lex() {
		lexState = "default";
		buffer = "";
		doubleQuote = false;
		sign = 1;
		for (;;) {
			c = peek();
			const token = lexStates[lexState]();
			if (token) return token;
		}
	}
	function peek() {
		if (source[pos]) return String.fromCodePoint(source.codePointAt(pos));
	}
	function read() {
		const c = peek();
		if (c === "\n") {
			line++;
			column = 0;
		} else if (c) column += c.length;
		else column++;
		if (c) pos += c.length;
		return c;
	}
	const lexStates = {
		default() {
			switch (c) {
				case "	":
				case "\v":
				case "\f":
				case " ":
				case "\xA0":
				case "﻿":
				case "\n":
				case "\r":
				case "\u2028":
				case "\u2029":
					read();
					return;
				case "/":
					read();
					lexState = "comment";
					return;
				case void 0:
					read();
					return newToken("eof");
			}
			if (util.isSpaceSeparator(c)) {
				read();
				return;
			}
			return lexStates[parseState]();
		},
		comment() {
			switch (c) {
				case "*":
					read();
					lexState = "multiLineComment";
					return;
				case "/":
					read();
					lexState = "singleLineComment";
					return;
			}
			throw invalidChar(read());
		},
		multiLineComment() {
			switch (c) {
				case "*":
					read();
					lexState = "multiLineCommentAsterisk";
					return;
				case void 0: throw invalidChar(read());
			}
			read();
		},
		multiLineCommentAsterisk() {
			switch (c) {
				case "*":
					read();
					return;
				case "/":
					read();
					lexState = "default";
					return;
				case void 0: throw invalidChar(read());
			}
			read();
			lexState = "multiLineComment";
		},
		singleLineComment() {
			switch (c) {
				case "\n":
				case "\r":
				case "\u2028":
				case "\u2029":
					read();
					lexState = "default";
					return;
				case void 0:
					read();
					return newToken("eof");
			}
			read();
		},
		value() {
			switch (c) {
				case "{":
				case "[": return newToken("punctuator", read());
				case "n":
					read();
					literal("ull");
					return newToken("null", null);
				case "t":
					read();
					literal("rue");
					return newToken("boolean", true);
				case "f":
					read();
					literal("alse");
					return newToken("boolean", false);
				case "-":
				case "+":
					if (read() === "-") sign = -1;
					lexState = "sign";
					return;
				case ".":
					buffer = read();
					lexState = "decimalPointLeading";
					return;
				case "0":
					buffer = read();
					lexState = "zero";
					return;
				case "1":
				case "2":
				case "3":
				case "4":
				case "5":
				case "6":
				case "7":
				case "8":
				case "9":
					buffer = read();
					lexState = "decimalInteger";
					return;
				case "I":
					read();
					literal("nfinity");
					return newToken("numeric", Infinity);
				case "N":
					read();
					literal("aN");
					return newToken("numeric", NaN);
				case "\"":
				case "'":
					doubleQuote = read() === "\"";
					buffer = "";
					lexState = "string";
					return;
			}
			throw invalidChar(read());
		},
		identifierNameStartEscape() {
			if (c !== "u") throw invalidChar(read());
			read();
			const u = unicodeEscape();
			switch (u) {
				case "$":
				case "_": break;
				default:
					if (!util.isIdStartChar(u)) throw invalidIdentifier();
					break;
			}
			buffer += u;
			lexState = "identifierName";
		},
		identifierName() {
			switch (c) {
				case "$":
				case "_":
				case "‌":
				case "‍":
					buffer += read();
					return;
				case "\\":
					read();
					lexState = "identifierNameEscape";
					return;
			}
			if (util.isIdContinueChar(c)) {
				buffer += read();
				return;
			}
			return newToken("identifier", buffer);
		},
		identifierNameEscape() {
			if (c !== "u") throw invalidChar(read());
			read();
			const u = unicodeEscape();
			switch (u) {
				case "$":
				case "_":
				case "‌":
				case "‍": break;
				default:
					if (!util.isIdContinueChar(u)) throw invalidIdentifier();
					break;
			}
			buffer += u;
			lexState = "identifierName";
		},
		sign() {
			switch (c) {
				case ".":
					buffer = read();
					lexState = "decimalPointLeading";
					return;
				case "0":
					buffer = read();
					lexState = "zero";
					return;
				case "1":
				case "2":
				case "3":
				case "4":
				case "5":
				case "6":
				case "7":
				case "8":
				case "9":
					buffer = read();
					lexState = "decimalInteger";
					return;
				case "I":
					read();
					literal("nfinity");
					return newToken("numeric", sign * Infinity);
				case "N":
					read();
					literal("aN");
					return newToken("numeric", NaN);
			}
			throw invalidChar(read());
		},
		zero() {
			switch (c) {
				case ".":
					buffer += read();
					lexState = "decimalPoint";
					return;
				case "e":
				case "E":
					buffer += read();
					lexState = "decimalExponent";
					return;
				case "x":
				case "X":
					buffer += read();
					lexState = "hexadecimal";
					return;
			}
			return newToken("numeric", sign * 0);
		},
		decimalInteger() {
			switch (c) {
				case ".":
					buffer += read();
					lexState = "decimalPoint";
					return;
				case "e":
				case "E":
					buffer += read();
					lexState = "decimalExponent";
					return;
			}
			if (util.isDigit(c)) {
				buffer += read();
				return;
			}
			return newToken("numeric", sign * Number(buffer));
		},
		decimalPointLeading() {
			if (util.isDigit(c)) {
				buffer += read();
				lexState = "decimalFraction";
				return;
			}
			throw invalidChar(read());
		},
		decimalPoint() {
			switch (c) {
				case "e":
				case "E":
					buffer += read();
					lexState = "decimalExponent";
					return;
			}
			if (util.isDigit(c)) {
				buffer += read();
				lexState = "decimalFraction";
				return;
			}
			return newToken("numeric", sign * Number(buffer));
		},
		decimalFraction() {
			switch (c) {
				case "e":
				case "E":
					buffer += read();
					lexState = "decimalExponent";
					return;
			}
			if (util.isDigit(c)) {
				buffer += read();
				return;
			}
			return newToken("numeric", sign * Number(buffer));
		},
		decimalExponent() {
			switch (c) {
				case "+":
				case "-":
					buffer += read();
					lexState = "decimalExponentSign";
					return;
			}
			if (util.isDigit(c)) {
				buffer += read();
				lexState = "decimalExponentInteger";
				return;
			}
			throw invalidChar(read());
		},
		decimalExponentSign() {
			if (util.isDigit(c)) {
				buffer += read();
				lexState = "decimalExponentInteger";
				return;
			}
			throw invalidChar(read());
		},
		decimalExponentInteger() {
			if (util.isDigit(c)) {
				buffer += read();
				return;
			}
			return newToken("numeric", sign * Number(buffer));
		},
		hexadecimal() {
			if (util.isHexDigit(c)) {
				buffer += read();
				lexState = "hexadecimalInteger";
				return;
			}
			throw invalidChar(read());
		},
		hexadecimalInteger() {
			if (util.isHexDigit(c)) {
				buffer += read();
				return;
			}
			return newToken("numeric", sign * Number(buffer));
		},
		string() {
			switch (c) {
				case "\\":
					read();
					buffer += escape();
					return;
				case "\"":
					if (doubleQuote) {
						read();
						return newToken("string", buffer);
					}
					buffer += read();
					return;
				case "'":
					if (!doubleQuote) {
						read();
						return newToken("string", buffer);
					}
					buffer += read();
					return;
				case "\n":
				case "\r": throw invalidChar(read());
				case "\u2028":
				case "\u2029":
					separatorChar(c);
					break;
				case void 0: throw invalidChar(read());
			}
			buffer += read();
		},
		start() {
			switch (c) {
				case "{":
				case "[": return newToken("punctuator", read());
			}
			lexState = "value";
		},
		beforePropertyName() {
			switch (c) {
				case "$":
				case "_":
					buffer = read();
					lexState = "identifierName";
					return;
				case "\\":
					read();
					lexState = "identifierNameStartEscape";
					return;
				case "}": return newToken("punctuator", read());
				case "\"":
				case "'":
					doubleQuote = read() === "\"";
					lexState = "string";
					return;
			}
			if (util.isIdStartChar(c)) {
				buffer += read();
				lexState = "identifierName";
				return;
			}
			throw invalidChar(read());
		},
		afterPropertyName() {
			if (c === ":") return newToken("punctuator", read());
			throw invalidChar(read());
		},
		beforePropertyValue() {
			lexState = "value";
		},
		afterPropertyValue() {
			switch (c) {
				case ",":
				case "}": return newToken("punctuator", read());
			}
			throw invalidChar(read());
		},
		beforeArrayValue() {
			if (c === "]") return newToken("punctuator", read());
			lexState = "value";
		},
		afterArrayValue() {
			switch (c) {
				case ",":
				case "]": return newToken("punctuator", read());
			}
			throw invalidChar(read());
		},
		end() {
			throw invalidChar(read());
		}
	};
	function newToken(type, value) {
		return {
			type,
			value,
			line,
			column
		};
	}
	function literal(s) {
		for (const c of s) {
			if (peek() !== c) throw invalidChar(read());
			read();
		}
	}
	function escape() {
		switch (peek()) {
			case "b":
				read();
				return "\b";
			case "f":
				read();
				return "\f";
			case "n":
				read();
				return "\n";
			case "r":
				read();
				return "\r";
			case "t":
				read();
				return "	";
			case "v":
				read();
				return "\v";
			case "0":
				read();
				if (util.isDigit(peek())) throw invalidChar(read());
				return "\0";
			case "x":
				read();
				return hexEscape();
			case "u":
				read();
				return unicodeEscape();
			case "\n":
			case "\u2028":
			case "\u2029":
				read();
				return "";
			case "\r":
				read();
				if (peek() === "\n") read();
				return "";
			case "1":
			case "2":
			case "3":
			case "4":
			case "5":
			case "6":
			case "7":
			case "8":
			case "9": throw invalidChar(read());
			case void 0: throw invalidChar(read());
		}
		return read();
	}
	function hexEscape() {
		let buffer = "";
		let c = peek();
		if (!util.isHexDigit(c)) throw invalidChar(read());
		buffer += read();
		c = peek();
		if (!util.isHexDigit(c)) throw invalidChar(read());
		buffer += read();
		return String.fromCodePoint(parseInt(buffer, 16));
	}
	function unicodeEscape() {
		let buffer = "";
		let count = 4;
		while (count-- > 0) {
			const c = peek();
			if (!util.isHexDigit(c)) throw invalidChar(read());
			buffer += read();
		}
		return String.fromCodePoint(parseInt(buffer, 16));
	}
	const parseStates = {
		start() {
			if (token.type === "eof") throw invalidEOF();
			push();
		},
		beforePropertyName() {
			switch (token.type) {
				case "identifier":
				case "string":
					key = token.value;
					parseState = "afterPropertyName";
					return;
				case "punctuator":
					pop();
					return;
				case "eof": throw invalidEOF();
			}
		},
		afterPropertyName() {
			if (token.type === "eof") throw invalidEOF();
			parseState = "beforePropertyValue";
		},
		beforePropertyValue() {
			if (token.type === "eof") throw invalidEOF();
			push();
		},
		beforeArrayValue() {
			if (token.type === "eof") throw invalidEOF();
			if (token.type === "punctuator" && token.value === "]") {
				pop();
				return;
			}
			push();
		},
		afterPropertyValue() {
			if (token.type === "eof") throw invalidEOF();
			switch (token.value) {
				case ",":
					parseState = "beforePropertyName";
					return;
				case "}": pop();
			}
		},
		afterArrayValue() {
			if (token.type === "eof") throw invalidEOF();
			switch (token.value) {
				case ",":
					parseState = "beforeArrayValue";
					return;
				case "]": pop();
			}
		},
		end() {}
	};
	function push() {
		let value;
		switch (token.type) {
			case "punctuator":
				switch (token.value) {
					case "{":
						value = {};
						break;
					case "[":
						value = [];
						break;
				}
				break;
			case "null":
			case "boolean":
			case "numeric":
			case "string":
				value = token.value;
				break;
		}
		if (root === void 0) root = value;
		else {
			const parent = stack[stack.length - 1];
			if (Array.isArray(parent)) parent.push(value);
			else Object.defineProperty(parent, key, {
				value,
				writable: true,
				enumerable: true,
				configurable: true
			});
		}
		if (value !== null && typeof value === "object") {
			stack.push(value);
			if (Array.isArray(value)) parseState = "beforeArrayValue";
			else parseState = "beforePropertyName";
		} else {
			const current = stack[stack.length - 1];
			if (current == null) parseState = "end";
			else if (Array.isArray(current)) parseState = "afterArrayValue";
			else parseState = "afterPropertyValue";
		}
	}
	function pop() {
		stack.pop();
		const current = stack[stack.length - 1];
		if (current == null) parseState = "end";
		else if (Array.isArray(current)) parseState = "afterArrayValue";
		else parseState = "afterPropertyValue";
	}
	function invalidChar(c) {
		if (c === void 0) return syntaxError(`JSON5: invalid end of input at ${line}:${column}`);
		return syntaxError(`JSON5: invalid character '${formatChar(c)}' at ${line}:${column}`);
	}
	function invalidEOF() {
		return syntaxError(`JSON5: invalid end of input at ${line}:${column}`);
	}
	function invalidIdentifier() {
		column -= 5;
		return syntaxError(`JSON5: invalid identifier character at ${line}:${column}`);
	}
	function separatorChar(c) {
		console.warn(`JSON5: '${formatChar(c)}' in strings is not valid ECMAScript; consider escaping`);
	}
	function formatChar(c) {
		const replacements = {
			"'": "\\'",
			"\"": "\\\"",
			"\\": "\\\\",
			"\b": "\\b",
			"\f": "\\f",
			"\n": "\\n",
			"\r": "\\r",
			"	": "\\t",
			"\v": "\\v",
			"\0": "\\0",
			"\u2028": "\\u2028",
			"\u2029": "\\u2029"
		};
		if (replacements[c]) return replacements[c];
		if (c < " ") {
			const hexString = c.charCodeAt(0).toString(16);
			return "\\x" + ("00" + hexString).substring(hexString.length);
		}
		return c;
	}
	function syntaxError(message) {
		const err = new SyntaxError(message);
		err.lineNumber = line;
		err.columnNumber = column;
		return err;
	}
}));
//#endregion
//#region ../../node_modules/json5/lib/stringify.js
var require_stringify = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const util = require_util();
	module.exports = function stringify(value, replacer, space) {
		const stack = [];
		let indent = "";
		let propertyList;
		let replacerFunc;
		let gap = "";
		let quote;
		if (replacer != null && typeof replacer === "object" && !Array.isArray(replacer)) {
			space = replacer.space;
			quote = replacer.quote;
			replacer = replacer.replacer;
		}
		if (typeof replacer === "function") replacerFunc = replacer;
		else if (Array.isArray(replacer)) {
			propertyList = [];
			for (const v of replacer) {
				let item;
				if (typeof v === "string") item = v;
				else if (typeof v === "number" || v instanceof String || v instanceof Number) item = String(v);
				if (item !== void 0 && propertyList.indexOf(item) < 0) propertyList.push(item);
			}
		}
		if (space instanceof Number) space = Number(space);
		else if (space instanceof String) space = String(space);
		if (typeof space === "number") {
			if (space > 0) {
				space = Math.min(10, Math.floor(space));
				gap = "          ".substr(0, space);
			}
		} else if (typeof space === "string") gap = space.substr(0, 10);
		return serializeProperty("", { "": value });
		function serializeProperty(key, holder) {
			let value = holder[key];
			if (value != null) {
				if (typeof value.toJSON5 === "function") value = value.toJSON5(key);
				else if (typeof value.toJSON === "function") value = value.toJSON(key);
			}
			if (replacerFunc) value = replacerFunc.call(holder, key, value);
			if (value instanceof Number) value = Number(value);
			else if (value instanceof String) value = String(value);
			else if (value instanceof Boolean) value = value.valueOf();
			switch (value) {
				case null: return "null";
				case true: return "true";
				case false: return "false";
			}
			if (typeof value === "string") return quoteString(value, false);
			if (typeof value === "number") return String(value);
			if (typeof value === "object") return Array.isArray(value) ? serializeArray(value) : serializeObject(value);
		}
		function quoteString(value) {
			const quotes = {
				"'": .1,
				"\"": .2
			};
			const replacements = {
				"'": "\\'",
				"\"": "\\\"",
				"\\": "\\\\",
				"\b": "\\b",
				"\f": "\\f",
				"\n": "\\n",
				"\r": "\\r",
				"	": "\\t",
				"\v": "\\v",
				"\0": "\\0",
				"\u2028": "\\u2028",
				"\u2029": "\\u2029"
			};
			let product = "";
			for (let i = 0; i < value.length; i++) {
				const c = value[i];
				switch (c) {
					case "'":
					case "\"":
						quotes[c]++;
						product += c;
						continue;
					case "\0": if (util.isDigit(value[i + 1])) {
						product += "\\x00";
						continue;
					}
				}
				if (replacements[c]) {
					product += replacements[c];
					continue;
				}
				if (c < " ") {
					let hexString = c.charCodeAt(0).toString(16);
					product += "\\x" + ("00" + hexString).substring(hexString.length);
					continue;
				}
				product += c;
			}
			const quoteChar = quote || Object.keys(quotes).reduce((a, b) => quotes[a] < quotes[b] ? a : b);
			product = product.replace(new RegExp(quoteChar, "g"), replacements[quoteChar]);
			return quoteChar + product + quoteChar;
		}
		function serializeObject(value) {
			if (stack.indexOf(value) >= 0) throw TypeError("Converting circular structure to JSON5");
			stack.push(value);
			let stepback = indent;
			indent = indent + gap;
			let keys = propertyList || Object.keys(value);
			let partial = [];
			for (const key of keys) {
				const propertyString = serializeProperty(key, value);
				if (propertyString !== void 0) {
					let member = serializeKey(key) + ":";
					if (gap !== "") member += " ";
					member += propertyString;
					partial.push(member);
				}
			}
			let final;
			if (partial.length === 0) final = "{}";
			else {
				let properties;
				if (gap === "") {
					properties = partial.join(",");
					final = "{" + properties + "}";
				} else {
					let separator = ",\n" + indent;
					properties = partial.join(separator);
					final = "{\n" + indent + properties + ",\n" + stepback + "}";
				}
			}
			stack.pop();
			indent = stepback;
			return final;
		}
		function serializeKey(key) {
			if (key.length === 0) return quoteString(key, true);
			const firstChar = String.fromCodePoint(key.codePointAt(0));
			if (!util.isIdStartChar(firstChar)) return quoteString(key, true);
			for (let i = firstChar.length; i < key.length; i++) if (!util.isIdContinueChar(String.fromCodePoint(key.codePointAt(i)))) return quoteString(key, true);
			return key;
		}
		function serializeArray(value) {
			if (stack.indexOf(value) >= 0) throw TypeError("Converting circular structure to JSON5");
			stack.push(value);
			let stepback = indent;
			indent = indent + gap;
			let partial = [];
			for (let i = 0; i < value.length; i++) {
				const propertyString = serializeProperty(String(i), value);
				partial.push(propertyString !== void 0 ? propertyString : "null");
			}
			let final;
			if (partial.length === 0) final = "[]";
			else if (gap === "") final = "[" + partial.join(",") + "]";
			else {
				let separator = ",\n" + indent;
				let properties = partial.join(separator);
				final = "[\n" + indent + properties + ",\n" + stepback + "]";
			}
			stack.pop();
			indent = stepback;
			return final;
		}
	};
}));
//#endregion
//#region ../../src/infra/cli-root-options.ts
var import_lib = /* @__PURE__ */ __toESM((/* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = {
		parse: require_parse(),
		stringify: require_stringify()
	};
})))(), 1);
const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const ROOT_VALUE_FLAGS = new Set([
	"--profile",
	"--log-level",
	"--container"
]);
function isValueToken(arg) {
	if (!arg || arg === "--") return false;
	if (!arg.startsWith("-")) return true;
	return /^-\d+(?:\.\d+)?$/.test(arg);
}
function consumeRootOptionToken(args, index) {
	const arg = args[index];
	if (!arg) return 0;
	if (ROOT_BOOLEAN_FLAGS.has(arg)) return 1;
	if (arg.startsWith("--profile=") || arg.startsWith("--log-level=") || arg.startsWith("--container=")) return 1;
	if (ROOT_VALUE_FLAGS.has(arg)) return isValueToken(args[index + 1]) ? 2 : 1;
	return 0;
}
//#endregion
//#region ../../src/terminal/ansi.ts
const ANSI_CSI_PATTERN = "\\x1b\\[[\\x20-\\x3f]*[\\x40-\\x7e]";
const ANSI_OSC_PATTERN = "\\x1b\\][^\\x07\\x1b]*(?:\\x1b\\\\|\\x07)";
new RegExp(ANSI_CSI_PATTERN, "g");
new RegExp(ANSI_OSC_PATTERN, "g");
typeof Intl !== "undefined" && "Segmenter" in Intl && new Intl.Segmenter(void 0, { granularity: "grapheme" });
//#endregion
//#region ../../src/cli/program/command-descriptor-utils.ts
function getCommandDescriptorNames(descriptors) {
	return descriptors.map((descriptor) => descriptor.name);
}
function getCommandsWithSubcommands(descriptors) {
	return descriptors.filter((descriptor) => descriptor.hasSubcommands).map((descriptor) => descriptor.name);
}
function getParentDefaultHelpCommands(descriptors) {
	return descriptors.filter((descriptor) => descriptor.parentDefaultHelp).map((descriptor) => descriptor.name);
}
function defineCommandDescriptorCatalog(descriptors) {
	return {
		descriptors,
		getDescriptors: () => descriptors,
		getNames: () => getCommandDescriptorNames(descriptors),
		getCommandsWithSubcommands: () => getCommandsWithSubcommands(descriptors),
		getParentDefaultHelpCommands: () => getParentDefaultHelpCommands(descriptors)
	};
}
const CORE_CLI_COMMAND_DESCRIPTORS = defineCommandDescriptorCatalog([
	{
		name: "crestodian",
		description: "Open the interactive setup and repair assistant",
		hasSubcommands: false
	},
	{
		name: "setup",
		description: "Initialize local config and an agent workspace",
		hasSubcommands: false
	},
	{
		name: "onboard",
		description: "Interactive onboarding for gateway, workspace, and skills",
		hasSubcommands: false
	},
	{
		name: "configure",
		description: "Interactive configuration for credentials, channels, gateway, and agent defaults",
		hasSubcommands: false
	},
	{
		name: "config",
		description: "Non-interactive config helpers (get/set/unset/file/validate). Default: starts guided setup.",
		hasSubcommands: true
	},
	{
		name: "backup",
		description: "Create and verify local backup archives for OpenClaw state",
		hasSubcommands: true
	},
	{
		name: "migrate",
		description: "Import state from another agent system",
		hasSubcommands: true
	},
	{
		name: "doctor",
		description: "Diagnose and repair config, Gateway, plugin, and channel problems",
		hasSubcommands: false
	},
	{
		name: "dashboard",
		description: "Open the Control UI with your current token",
		hasSubcommands: false
	},
	{
		name: "reset",
		description: "Reset local config/state (keeps the CLI installed)",
		hasSubcommands: false
	},
	{
		name: "uninstall",
		description: "Uninstall the gateway service + local data (CLI remains)",
		hasSubcommands: false
	},
	{
		name: "message",
		description: "Send, read, and manage channel messages",
		hasSubcommands: true
	},
	{
		name: "mcp",
		description: "Manage OpenClaw MCP config and channel bridge",
		hasSubcommands: true,
		parentDefaultHelp: true
	},
	{
		name: "packs",
		description: "Manage ClaWorks extension packs (Nexus registry)",
		hasSubcommands: true
	},
	{
		name: "agent",
		description: "Run one agent turn via the Gateway",
		hasSubcommands: false
	},
	{
		name: "agents",
		description: "Manage isolated agents (workspaces, auth, routing)",
		hasSubcommands: true
	},
	{
		name: "status",
		description: "Show Gateway, channel, model, and recent-session status",
		hasSubcommands: false
	},
	{
		name: "health",
		description: "Fetch detailed health from the running Gateway",
		hasSubcommands: false
	},
	{
		name: "sessions",
		description: "List stored conversation sessions",
		hasSubcommands: true
	},
	{
		name: "commitments",
		description: "List and manage inferred follow-up commitments",
		hasSubcommands: true
	},
	{
		name: "tasks",
		description: "Inspect durable background tasks and flows",
		hasSubcommands: true
	}
]).descriptors;
path.join("dist", "plugin-sdk", "qa-lab.js");
const SUB_CLI_DESCRIPTORS = defineCommandDescriptorCatalog([
	{
		name: "acp",
		description: "Run and manage ACP-backed coding agents",
		hasSubcommands: true
	},
	{
		name: "gateway",
		description: "Run, inspect, and query the OpenClaw Gateway",
		hasSubcommands: true
	},
	{
		name: "daemon",
		description: "Manage the Gateway service (legacy alias)",
		hasSubcommands: true
	},
	{
		name: "logs",
		description: "Tail Gateway logs locally or via RPC",
		hasSubcommands: false
	},
	{
		name: "system",
		description: "System events, heartbeat, and presence",
		hasSubcommands: true
	},
	{
		name: "models",
		description: "List, scan, and set model providers",
		hasSubcommands: true
	},
	{
		name: "infer",
		description: "Run provider-backed model, media, search, and embedding commands",
		hasSubcommands: true
	},
	{
		name: "capability",
		description: "Run provider capability commands (fallback alias: infer)",
		hasSubcommands: true
	},
	{
		name: "approvals",
		description: "Manage exec approvals (gateway or node host)",
		hasSubcommands: true,
		parentDefaultHelp: true
	},
	{
		name: "exec-policy",
		description: "Show or synchronize requested exec policy with host approvals",
		hasSubcommands: true
	},
	{
		name: "nodes",
		description: "Pair nodes and run node-host commands through the Gateway",
		hasSubcommands: true
	},
	{
		name: "devices",
		description: "Device pairing + token management",
		hasSubcommands: true,
		parentDefaultHelp: true
	},
	{
		name: "node",
		description: "Run and manage the headless node host service",
		hasSubcommands: true
	},
	{
		name: "sandbox",
		description: "Manage sandbox containers for agent isolation",
		hasSubcommands: true
	},
	{
		name: "tui",
		description: "Open a terminal UI connected to the Gateway",
		hasSubcommands: false
	},
	{
		name: "terminal",
		description: "Open a local terminal UI (alias for tui --local)",
		hasSubcommands: false
	},
	{
		name: "chat",
		description: "Open a local terminal UI (alias for tui --local)",
		hasSubcommands: false
	},
	{
		name: "cron",
		description: "Schedule and inspect Gateway background jobs",
		hasSubcommands: true,
		parentDefaultHelp: true
	},
	{
		name: "dns",
		description: "DNS helpers for wide-area discovery (Tailscale + CoreDNS)",
		hasSubcommands: true
	},
	{
		name: "docs",
		description: "Search the live OpenClaw docs",
		hasSubcommands: false
	},
	{
		name: "qa",
		description: "Run QA scenarios and launch the private QA debugger UI",
		hasSubcommands: true
	},
	{
		name: "proxy",
		description: "Run the OpenClaw debug proxy and inspect captured traffic",
		hasSubcommands: true
	},
	{
		name: "hooks",
		description: "Manage internal agent hooks",
		hasSubcommands: true
	},
	{
		name: "webhooks",
		description: "Webhook helpers and integrations",
		hasSubcommands: true
	},
	{
		name: "qr",
		description: "Generate mobile pairing QR/setup code",
		hasSubcommands: false
	},
	{
		name: "clawbot",
		description: "Legacy clawbot command aliases",
		hasSubcommands: true
	},
	{
		name: "pairing",
		description: "Secure DM pairing (approve inbound requests)",
		hasSubcommands: true
	},
	{
		name: "plugins",
		description: "Install, enable, disable, and inspect plugins",
		hasSubcommands: true,
		parentDefaultHelp: true
	},
	{
		name: "channels",
		description: "Add, remove, login, and inspect messaging channels",
		hasSubcommands: true,
		parentDefaultHelp: true
	},
	{
		name: "directory",
		description: "Lookup contact and group IDs (self, peers, groups) for supported chat channels",
		hasSubcommands: true
	},
	{
		name: "security",
		description: "Security tools and local config audits",
		hasSubcommands: true
	},
	{
		name: "secrets",
		description: "Audit, apply, and reload SecretRef-backed credentials",
		hasSubcommands: true
	},
	{
		name: "skills",
		description: "List, inspect, and install agent skills",
		hasSubcommands: true
	},
	{
		name: "update",
		description: "Update OpenClaw and inspect update channel status",
		hasSubcommands: true
	},
	{
		name: "completion",
		description: "Generate shell completion script",
		hasSubcommands: false
	}
]).descriptors;
//#endregion
//#region ../../src/cli/argv.ts
const ROOT_COMMAND_DESCRIPTORS = [...CORE_CLI_COMMAND_DESCRIPTORS, ...SUB_CLI_DESCRIPTORS];
new Set(ROOT_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.name));
new Set(ROOT_COMMAND_DESCRIPTORS.filter((descriptor) => descriptor.hasSubcommands).map((descriptor) => descriptor.name));
function getCommandPathWithRootOptions(argv, depth = 2) {
	return getCommandPathInternal(argv, depth, { skipRootOptions: true });
}
function getCommandPathInternal(argv, depth, opts) {
	const args = argv.slice(2);
	const path = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--") break;
		if (opts.skipRootOptions) {
			const consumed = consumeRootOptionToken(args, i);
			if (consumed > 0) {
				i += consumed - 1;
				continue;
			}
		}
		if (arg.startsWith("-")) continue;
		path.push(arg);
		if (path.length >= depth) break;
	}
	return path;
}
//#endregion
//#region ../../src/infra/home-dir.ts
function normalize(value) {
	const trimmed = value?.trim();
	if (!trimmed || trimmed === "undefined" || trimmed === "null") return;
	return trimmed;
}
function normalizeSafe(homedir) {
	try {
		return normalize(homedir());
	} catch {
		return;
	}
}
function resolveRawOsHomeDir(env, homedir) {
	return normalize(env.HOME) ?? normalize(env.USERPROFILE) ?? normalizeSafe(homedir);
}
function resolveRawHomeDir(env, homedir) {
	const explicitHome = normalize(env.OPENCLAW_HOME);
	if (!explicitHome) return resolveRawOsHomeDir(env, homedir);
	if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
		const fallbackHome = resolveRawOsHomeDir(env, homedir);
		return fallbackHome ? explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome) : void 0;
	}
	return explicitHome;
}
function resolveEffectiveHomeDir(env = process.env, homedir = os.homedir) {
	const raw = resolveRawHomeDir(env, homedir);
	return raw ? path.resolve(raw) : void 0;
}
function resolveRequiredHomeDir(env = process.env, homedir = os.homedir) {
	return resolveEffectiveHomeDir(env, homedir) ?? path.resolve(process.cwd());
}
function expandHomePrefix(input, opts) {
	if (!input.startsWith("~")) return input;
	const home = normalize(opts?.home) ?? resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
	if (!home) return input;
	return input.replace(/^~(?=$|[\\/])/, home);
}
function resolveHomeRelativePath(input, opts) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		const expanded = expandHomePrefix(trimmed, {
			home: resolveRequiredHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
			env: opts?.env,
			homedir: opts?.homedir
		});
		return path.resolve(expanded);
	}
	return path.resolve(trimmed);
}
//#endregion
//#region ../../src/config/paths.ts
/**
* Nix mode detection: When OPENCLAW_NIX_MODE=1, the gateway is running under Nix.
* In this mode:
* - No auto-install flows should be attempted
* - Missing dependencies should produce actionable Nix-specific error messages
* - Config is managed externally (read-only from Nix perspective)
*/
function resolveIsNixMode(env = process.env) {
	return env.OPENCLAW_NIX_MODE === "1";
}
resolveIsNixMode();
const LEGACY_STATE_DIRNAMES = [".clawdbot"];
const NEW_STATE_DIRNAME = ".openclaw";
const CLAWORKS_STATE_DIRNAME = ".claworks";
const CONFIG_FILENAME = "openclaw.json";
const CLAWORKS_CONFIG_FILENAME = "claworks.json";
function isClaworksProduct(env = process.env) {
	return env.CLAWORKS_PRODUCT === "1";
}
function resolveProductStateDirname(env = process.env) {
	return isClaworksProduct(env) ? CLAWORKS_STATE_DIRNAME : NEW_STATE_DIRNAME;
}
function resolveProductConfigFilename(env = process.env) {
	return isClaworksProduct(env) ? CLAWORKS_CONFIG_FILENAME : CONFIG_FILENAME;
}
const LEGACY_CONFIG_FILENAMES = ["clawdbot.json"];
function resolveDefaultHomeDir() {
	return resolveRequiredHomeDir(process.env, os.homedir);
}
/** Build a homedir thunk that respects OPENCLAW_HOME for the given env. */
function envHomedir(env) {
	return () => resolveRequiredHomeDir(env, os.homedir);
}
function legacyStateDirs(homedir = resolveDefaultHomeDir) {
	return LEGACY_STATE_DIRNAMES.map((dir) => path.join(homedir(), dir));
}
function newStateDir(homedir = resolveDefaultHomeDir, env = process.env) {
	return path.join(homedir(), resolveProductStateDirname(env));
}
/**
* State directory for mutable data (sessions, logs, caches).
* Can be overridden via OPENCLAW_STATE_DIR.
* Default: ~/.openclaw
*/
function resolveStateDir(env = process.env, homedir = envHomedir(env)) {
	const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
	const override = env.OPENCLAW_STATE_DIR?.trim();
	if (override) return resolveUserPath(override, env, effectiveHomedir);
	const newDir = newStateDir(effectiveHomedir, env);
	if (env.OPENCLAW_TEST_FAST === "1") return newDir;
	const legacyDirs = legacyStateDirs(effectiveHomedir);
	if (fs.existsSync(newDir)) return newDir;
	const existingLegacy = legacyDirs.find((dir) => {
		try {
			return fs.existsSync(dir);
		} catch {
			return false;
		}
	});
	if (existingLegacy) return existingLegacy;
	return newDir;
}
function resolveUserPath(input, env = process.env, homedir = envHomedir(env)) {
	return resolveHomeRelativePath(input, {
		env,
		homedir
	});
}
resolveStateDir();
/**
* Config file path (JSON or JSON5).
* Can be overridden via OPENCLAW_CONFIG_PATH.
* Default: ~/.openclaw/openclaw.json (or $OPENCLAW_STATE_DIR/openclaw.json)
*/
function resolveCanonicalConfigPath(env = process.env, stateDir = resolveStateDir(env, envHomedir(env))) {
	const override = env.OPENCLAW_CONFIG_PATH?.trim();
	if (override) return resolveUserPath(override, env, envHomedir(env));
	return path.join(stateDir, resolveProductConfigFilename(env));
}
/**
* Resolve the active config path by preferring existing config candidates
* before falling back to the canonical path.
*/
function resolveConfigPathCandidate(env = process.env, homedir = envHomedir(env)) {
	if (env.OPENCLAW_TEST_FAST === "1") return resolveCanonicalConfigPath(env, resolveStateDir(env, homedir));
	const existing = resolveDefaultConfigCandidates(env, homedir).find((candidate) => {
		try {
			return fs.existsSync(candidate);
		} catch {
			return false;
		}
	});
	if (existing) return existing;
	return resolveCanonicalConfigPath(env, resolveStateDir(env, homedir));
}
/**
* Active config path (prefers existing config files).
*/
function resolveConfigPath(env = process.env, stateDir = resolveStateDir(env, envHomedir(env)), homedir = envHomedir(env)) {
	const override = env.OPENCLAW_CONFIG_PATH?.trim();
	if (override) return resolveUserPath(override, env, homedir);
	if (env.OPENCLAW_TEST_FAST === "1") return path.join(stateDir, resolveProductConfigFilename(env));
	const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
	const configFilename = resolveProductConfigFilename(env);
	const existing = [path.join(stateDir, configFilename), ...LEGACY_CONFIG_FILENAMES.map((name) => path.join(stateDir, name))].find((candidate) => {
		try {
			return fs.existsSync(candidate);
		} catch {
			return false;
		}
	});
	if (existing) return existing;
	if (stateOverride) return path.join(stateDir, configFilename);
	const defaultStateDir = resolveStateDir(env, homedir);
	if (path.resolve(stateDir) === path.resolve(defaultStateDir)) return resolveConfigPathCandidate(env, homedir);
	return path.join(stateDir, configFilename);
}
resolveConfigPathCandidate();
/**
* Resolve default config path candidates across default locations.
* Order: explicit config path → state-dir-derived paths → new default.
*/
function resolveDefaultConfigCandidates(env = process.env, homedir = envHomedir(env)) {
	const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
	const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
	if (explicit) return [resolveUserPath(explicit, env, effectiveHomedir)];
	const candidates = [];
	const openclawStateDir = env.OPENCLAW_STATE_DIR?.trim();
	const configFilename = resolveProductConfigFilename(env);
	if (openclawStateDir) {
		const resolved = resolveUserPath(openclawStateDir, env, effectiveHomedir);
		candidates.push(path.join(resolved, configFilename));
		candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(resolved, name)));
	}
	const defaultDirs = [newStateDir(effectiveHomedir, env), ...legacyStateDirs(effectiveHomedir)];
	for (const dir of defaultDirs) {
		candidates.push(path.join(dir, configFilename));
		candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(dir, name)));
	}
	return candidates;
}
//#endregion
//#region ../../src/logging/config.ts
let cachedLoggingConfig;
function shouldSkipMutatingLoggingConfigRead(argv = process.argv) {
	const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
	return primary === "config" && (secondary === "schema" || secondary === "validate");
}
function isObjectRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readLoggingConfig() {
	if (shouldSkipMutatingLoggingConfigRead()) return;
	try {
		const configPath = resolveConfigPath();
		if (cachedLoggingConfig?.path === configPath) return cachedLoggingConfig.logging;
		if (!fs.existsSync(configPath)) return;
		const parsed = import_lib.default.parse(fs.readFileSync(configPath, "utf8"));
		const logging = isObjectRecord(parsed) ? parsed.logging : void 0;
		const resolved = isObjectRecord(logging) ? logging : void 0;
		cachedLoggingConfig = {
			path: configPath,
			logging: resolved
		};
		return resolved;
	} catch {
		return;
	}
}
//#endregion
//#region ../../src/logging/redact-bounded.ts
const REDACT_REGEX_CHUNK_THRESHOLD = 32768;
const REDACT_REGEX_CHUNK_SIZE = 16384;
function replacePatternBounded(text, pattern, replacer, options) {
	const chunkThreshold = options?.chunkThreshold ?? REDACT_REGEX_CHUNK_THRESHOLD;
	const chunkSize = options?.chunkSize ?? REDACT_REGEX_CHUNK_SIZE;
	if (chunkThreshold <= 0 || chunkSize <= 0 || text.length <= chunkThreshold) return text.replace(pattern, replacer);
	let output = "";
	for (let index = 0; index < text.length; index += chunkSize) output += text.slice(index, index + chunkSize).replace(pattern, replacer);
	return output;
}
//#endregion
//#region ../../src/logging/redact.ts
const DEFAULT_REDACT_MODE = "tools";
const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;
const PAYMENT_CREDENTIAL_ENV_KEYS = String.raw`CARD[_-]?NUMBER|CARD[_-]?CVC|CARD[_-]?CVV|CVC|CVV|SECURITY[_-]?CODE|PAYMENT[_-]?CREDENTIAL|SHARED[_-]?PAYMENT[_-]?TOKEN`;
const PAYMENT_CREDENTIAL_QUERY_KEYS = String.raw`card[-_]?number|card[-_]?cvc|card[-_]?cvv|cvc|cvv|security[-_]?code|payment[-_]?credential|shared[-_]?payment[-_]?token`;
const PAYMENT_CREDENTIAL_JSON_KEYS = String.raw`cardNumber|card_number|cardCvc|card_cvc|cardCvv|card_cvv|cvc|cvv|securityCode|security_code|paymentCredential|payment_credential|sharedPaymentToken|shared_payment_token`;
new RegExp(String.raw`^(?:api[-_]?key|apiKey|token|secret|password|passwd|access[-_]?token|accessToken|refresh[-_]?token|refreshToken|id[-_]?token|idToken|auth[-_]?token|authToken|client[-_]?secret|clientSecret|app[-_]?secret|appSecret|${PAYMENT_CREDENTIAL_QUERY_KEYS}|${PAYMENT_CREDENTIAL_JSON_KEYS})$`, "i");
new RegExp(String.raw`^(?:(?:[A-Z0-9]+[_-])+(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)|API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|${PAYMENT_CREDENTIAL_ENV_KEYS})$`, "i");
const DEFAULT_REDACT_PATTERNS = [
	String.raw`/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|${PAYMENT_CREDENTIAL_ENV_KEYS})\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1/g`,
	String.raw`/[?&](?:access[-_]?token|auth[-_]?token|hook[-_]?token|refresh[-_]?token|api[-_]?key|client[-_]?secret|token|key|secret|password|pass|passwd|auth|signature|${PAYMENT_CREDENTIAL_QUERY_KEYS})=([^&\s"'<>]+)/gi`,
	String.raw`"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken|${PAYMENT_CREDENTIAL_JSON_KEYS})"\s*:\s*"([^"]+)"`,
	String.raw`(^|[\s,{])["']?(?:api[-_]key|access[-_]token|refresh[-_]token|authToken|auth[-_]token|clientSecret|client[-_]secret|appSecret|app[-_]secret)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`,
	String.raw`(^|[\s,{])["']?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`,
	String.raw`--(?:api[-_]?key|hook[-_]?token|token|secret|password|passwd|${PAYMENT_CREDENTIAL_QUERY_KEYS})\s+(["']?)([^\s"']+)\1`,
	String.raw`Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)`,
	String.raw`Authorization\s*[:=]\s*Basic\s+([A-Za-z0-9+/=]+)`,
	String.raw`(?:X-OpenClaw-Token|x-pomerium-jwt-assertion|X-Api-Key|X-Auth-Token)\s*[:=]\s*([^\s"',;]+)`,
	String.raw`\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b`,
	String.raw`(^|[\s,;])(?:access_token|refresh_token|auth[-_]?token|api[-_]?key|client[-_]?secret|app[-_]?secret|token|secret|password|passwd|${PAYMENT_CREDENTIAL_QUERY_KEYS})=([^\s&#]+)`,
	String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`,
	String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
	String.raw`(ghp_[A-Za-z0-9]{20,})`,
	String.raw`(github_pat_[A-Za-z0-9_]{20,})`,
	String.raw`(xox[baprs]-[A-Za-z0-9-]{10,})`,
	String.raw`(xapp-[A-Za-z0-9-]{10,})`,
	String.raw`(gsk_[A-Za-z0-9_-]{10,})`,
	String.raw`(AIza[0-9A-Za-z\-_]{20,})`,
	String.raw`(ya29\.[0-9A-Za-z_\-./+=]{10,})`,
	String.raw`(1//0[0-9A-Za-z_\-./+=]{10,})`,
	String.raw`(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`,
	String.raw`(pplx-[A-Za-z0-9_-]{10,})`,
	String.raw`(npm_[A-Za-z0-9]{10,})`,
	String.raw`(AKID[A-Za-z0-9]{10,})`,
	String.raw`(LTAI[A-Za-z0-9]{10,})`,
	String.raw`(hf_[A-Za-z0-9]{10,})`,
	String.raw`(r8_[A-Za-z0-9]{10,})`,
	String.raw`\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
	String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`
];
function normalizeMode(value) {
	return value === "off" ? "off" : DEFAULT_REDACT_MODE;
}
function parsePattern(raw) {
	if (raw instanceof RegExp) {
		if (raw.flags.includes("g")) return raw;
		return new RegExp(raw.source, `${raw.flags}g`);
	}
	if (!raw.trim()) return null;
	const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
	if (match) {
		const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
		return compileConfigRegex(match[1], flags)?.regex ?? null;
	}
	return compileConfigRegex(raw, "gi")?.regex ?? null;
}
function resolvePatterns(value) {
	return (value?.length ? value : DEFAULT_REDACT_PATTERNS).map(parsePattern).filter((re) => Boolean(re));
}
function maskToken(token) {
	if (token.length < DEFAULT_REDACT_MIN_LENGTH) return "***";
	return `${token.slice(0, DEFAULT_REDACT_KEEP_START)}…${token.slice(-DEFAULT_REDACT_KEEP_END)}`;
}
function redactPemBlock(block) {
	const lines = block.split(/\r?\n/).filter(Boolean);
	if (lines.length < 2) return "***";
	return `${lines[0]}\n…redacted…\n${lines[lines.length - 1]}`;
}
function redactMatch(match, groups) {
	if (match.includes("PRIVATE KEY-----")) return redactPemBlock(match);
	const token = groups.findLast((value) => typeof value === "string" && value.length > 0) ?? match;
	const masked = maskToken(token);
	if (token === match) return masked;
	return match.replace(token, masked);
}
function redactText(text, patterns) {
	let next = text;
	for (const pattern of patterns) next = replacePatternBounded(next, pattern, (...args) => redactMatch(args[0], args.slice(1, -2)));
	return next;
}
function resolveConfigRedaction() {
	const cfg = readLoggingConfig();
	return {
		mode: normalizeMode(cfg?.redactSensitive),
		patterns: cfg?.redactPatterns
	};
}
function resolveRedactOptions(options) {
	const resolved = options ?? resolveConfigRedaction();
	const mode = normalizeMode(resolved.mode);
	if (mode === "off") return {
		mode,
		patterns: []
	};
	return {
		mode,
		patterns: resolvePatterns(resolved.patterns)
	};
}
function redactSensitiveText(text, options) {
	if (!text) return text;
	const resolved = resolveRedactOptions(options);
	if (resolved.mode === "off") return text;
	if (!resolved.patterns.length) return text;
	return redactText(text, resolved.patterns);
}
//#endregion
//#region ../../src/infra/errors.ts
function formatErrorMessage(err) {
	let formatted;
	if (err instanceof Error) {
		formatted = err.message || err.name || "Error";
		let cause = err.cause;
		const seen = new Set([err]);
		while (cause && !seen.has(cause)) {
			seen.add(cause);
			if (cause instanceof Error) {
				if (cause.message) formatted += ` | ${cause.message}`;
				cause = cause.cause;
			} else if (typeof cause === "string") {
				formatted += ` | ${cause}`;
				break;
			} else break;
		}
	} else if (typeof err === "string") formatted = err;
	else if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") formatted = String(err);
	else try {
		formatted = JSON.stringify(err);
	} catch {
		formatted = Object.prototype.toString.call(err);
	}
	return redactSensitiveText(formatted);
}
//#endregion
//#region ../../src/shared/global-singleton.ts
function resolveGlobalSingleton(key, create) {
	const globalStore = globalThis;
	if (Object.prototype.hasOwnProperty.call(globalStore, key)) return globalStore[key];
	const created = create();
	globalStore[key] = created;
	return created;
}
//#endregion
//#region ../../src/infra/warning-filter.ts
const warningFilterKey = Symbol.for("openclaw.warning-filter");
function shouldIgnoreWarning(warning) {
	if (warning.code === "DEP0040" && warning.message?.includes("punycode")) return true;
	if (warning.code === "DEP0060" && warning.message?.includes("util._extend")) return true;
	if (warning.name === "ExperimentalWarning" && warning.message?.includes("SQLite is an experimental feature")) return true;
	return false;
}
function normalizeWarningArgs(args) {
	const warningArg = args[0];
	const secondArg = args[1];
	const thirdArg = args[2];
	let name;
	let code;
	let message;
	if (warningArg instanceof Error) {
		name = warningArg.name;
		message = warningArg.message;
		code = warningArg.code;
	} else if (typeof warningArg === "string") message = warningArg;
	if (secondArg && typeof secondArg === "object" && !Array.isArray(secondArg)) {
		const options = secondArg;
		if (typeof options.type === "string") name = options.type;
		if (typeof options.code === "string") code = options.code;
	} else {
		if (typeof secondArg === "string") name = secondArg;
		if (typeof thirdArg === "string") code = thirdArg;
	}
	return {
		name,
		code,
		message
	};
}
function installProcessWarningFilter() {
	const state = resolveGlobalSingleton(warningFilterKey, () => ({ installed: false }));
	if (state.installed) return;
	const originalEmitWarning = process.emitWarning.bind(process);
	const wrappedEmitWarning = ((...args) => {
		if (shouldIgnoreWarning(normalizeWarningArgs(args))) return;
		if (args[0] instanceof Error && args[1] && typeof args[1] === "object" && !Array.isArray(args[1])) {
			const warning = args[0];
			const emitted = Object.assign(new Error(warning.message), {
				name: warning.name,
				code: warning.code
			});
			process.emit("warning", emitted);
			return;
		}
		Reflect.apply(originalEmitWarning, process, args);
	});
	process.emitWarning = wrappedEmitWarning;
	state.installed = true;
}
//#endregion
//#region ../../src/infra/node-sqlite.ts
const require$1 = createRequire(import.meta.url);
function requireNodeSqlite() {
	installProcessWarningFilter();
	try {
		return require$1("node:sqlite");
	} catch (err) {
		const message = formatErrorMessage(err);
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
			const q = query.toLowerCase();
			return docs.filter((d) => !opts?.namespace || d.namespace === opts.namespace).filter((d) => d.text.toLowerCase().includes(q)).slice(0, limit).map((d, i) => ({
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
			const buckets = [...bucketMap.entries()].toSorted(([a], [b]) => a.localeCompare(b)).map(([period, vals]) => ({
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
		}
	};
}
//#endregion
export { createKnowledgeBase as a, openDatabase$1 as c, migrateClaworksSchema as d, __exportAll as f, mesProductionDispatch as i, convertPlaceholders as l, createObjectStore as n, createFileKnowledgeBase as o, publishWorkOrderCreated as r, openDatabase as s, createOntologyEngine as t, isPostgresDatabaseUrl as u };
