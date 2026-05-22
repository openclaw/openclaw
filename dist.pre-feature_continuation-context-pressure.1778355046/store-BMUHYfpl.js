import { t as expandHomePrefix } from "./home-dir-g5LU3LmA.js";
import { d as resolveConfigDir } from "./utils-D5swhEXt.js";
import { t as parseJsonWithJson5Fallback } from "./parse-json-compat-CrSoP9Qk.js";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
//#region src/cron/schedule-identity.ts
function readString(record, key) {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readNumber(record, key) {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function schedulePayloadFromRecord(schedule) {
	const rawKind = readString(schedule, "kind")?.toLowerCase();
	const expr = readString(schedule, "expr") ?? readString(schedule, "cron");
	const at = readString(schedule, "at");
	const atMs = readNumber(schedule, "atMs");
	const everyMs = readNumber(schedule, "everyMs");
	const anchorMs = readNumber(schedule, "anchorMs");
	const tz = readString(schedule, "tz");
	const staggerMs = readNumber(schedule, "staggerMs");
	const kind = rawKind === "at" || rawKind === "every" || rawKind === "cron" ? rawKind : at || atMs !== void 0 ? "at" : everyMs !== void 0 ? "every" : expr ? "cron" : void 0;
	if (kind === "at") return at ? {
		kind: "at",
		at
	} : atMs !== void 0 ? {
		kind: "at",
		at: String(atMs)
	} : void 0;
	if (kind === "every" && everyMs !== void 0) return {
		kind: "every",
		everyMs,
		anchorMs
	};
	if (kind === "cron" && expr) return {
		kind: "cron",
		expr,
		tz,
		staggerMs
	};
}
function resolveSchedulePayload(job) {
	if (job.schedule && typeof job.schedule === "object" && !Array.isArray(job.schedule)) return schedulePayloadFromRecord(job.schedule);
	return schedulePayloadFromRecord(job);
}
function tryCronScheduleIdentity(job) {
	const schedule = resolveSchedulePayload(job);
	if (!schedule) return;
	return JSON.stringify({
		version: 1,
		enabled: typeof job.enabled === "boolean" ? job.enabled : true,
		schedule
	});
}
function cronSchedulingInputsEqual(previous, next) {
	const previousIdentity = tryCronScheduleIdentity(previous);
	const nextIdentity = tryCronScheduleIdentity(next);
	return previousIdentity !== void 0 && nextIdentity !== void 0 && previousIdentity === nextIdentity;
}
//#endregion
//#region src/cron/store.ts
const serializedStoreCache = /* @__PURE__ */ new Map();
function getSerializedStoreCache(storePath) {
	let entry = serializedStoreCache.get(storePath);
	if (!entry) {
		entry = { needsSplitMigration: false };
		serializedStoreCache.set(storePath, entry);
	}
	return entry;
}
function resolveDefaultCronDir() {
	return path.join(resolveConfigDir(), "cron");
}
function resolveDefaultCronStorePath() {
	return path.join(resolveDefaultCronDir(), "jobs.json");
}
function resolveStatePath(storePath) {
	if (storePath.endsWith(".json")) return storePath.replace(/\.json$/, "-state.json");
	return `${storePath}-state.json`;
}
function stripRuntimeOnlyCronFields(store) {
	return {
		version: store.version,
		jobs: store.jobs.map((job) => {
			const { state: _state, updatedAtMs: _updatedAtMs, ...rest } = job;
			return {
				...rest,
				state: {}
			};
		})
	};
}
function extractStateFile(store) {
	const jobs = {};
	for (const job of store.jobs) jobs[job.id] = {
		updatedAtMs: job.updatedAtMs,
		scheduleIdentity: tryCronScheduleIdentity(job),
		state: job.state ?? {}
	};
	return {
		version: 1,
		jobs
	};
}
function resolveCronStorePath(storePath) {
	if (storePath?.trim()) {
		const raw = storePath.trim();
		if (raw.startsWith("~")) return path.resolve(expandHomePrefix(raw));
		return path.resolve(raw);
	}
	return resolveDefaultCronStorePath();
}
async function loadStateFile(statePath) {
	let raw;
	try {
		raw = await fs.promises.readFile(statePath, "utf-8");
	} catch (err) {
		if (err?.code === "ENOENT") return null;
		throw new Error(`Failed to read cron state at ${statePath}: ${String(err)}`, { cause: err });
	}
	try {
		const parsed = parseJsonWithJson5Fallback(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const record = parsed;
		if (record.version !== 1 || typeof record.jobs !== "object" || record.jobs === null || Array.isArray(record.jobs)) return null;
		return {
			version: 1,
			jobs: record.jobs
		};
	} catch {
		return null;
	}
}
function loadStateFileSync(statePath) {
	let raw;
	try {
		raw = fs.readFileSync(statePath, "utf-8");
	} catch (err) {
		if (err?.code === "ENOENT") return null;
		throw new Error(`Failed to read cron state at ${statePath}: ${String(err)}`, { cause: err });
	}
	try {
		const parsed = parseJsonWithJson5Fallback(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const record = parsed;
		if (record.version !== 1 || typeof record.jobs !== "object" || record.jobs === null || Array.isArray(record.jobs)) return null;
		return {
			version: 1,
			jobs: record.jobs
		};
	} catch {
		return null;
	}
}
function hasInlineState(jobs) {
	return jobs.some((job) => job != null && job.state !== void 0 && typeof job.state === "object" && job.state !== null && Object.keys(job.state).length > 0);
}
function ensureJobStateObject(job) {
	if (!job.state || typeof job.state !== "object") job.state = {};
}
function backfillMissingRuntimeFields(job) {
	ensureJobStateObject(job);
	if (typeof job.updatedAtMs !== "number") job.updatedAtMs = typeof job.createdAtMs === "number" ? job.createdAtMs : Date.now();
}
function resolveUpdatedAtMs(job, updatedAtMs) {
	if (typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs)) return updatedAtMs;
	if (typeof job.updatedAtMs === "number" && Number.isFinite(job.updatedAtMs)) return job.updatedAtMs;
	return typeof job.createdAtMs === "number" && Number.isFinite(job.createdAtMs) ? job.createdAtMs : Date.now();
}
function mergeStateFileEntry(job, entry) {
	job.updatedAtMs = resolveUpdatedAtMs(job, entry.updatedAtMs);
	job.state = entry.state ?? {};
	if (typeof entry.scheduleIdentity === "string" && entry.scheduleIdentity !== tryCronScheduleIdentity(job)) {
		ensureJobStateObject(job);
		job.state.nextRunAtMs = void 0;
	}
}
async function loadCronStore(storePath) {
	try {
		const raw = await fs.promises.readFile(storePath, "utf-8");
		let parsed;
		try {
			parsed = parseJsonWithJson5Fallback(raw);
		} catch (err) {
			throw new Error(`Failed to parse cron store at ${storePath}: ${String(err)}`, { cause: err });
		}
		const parsedRecord = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		const jobs = Array.isArray(parsedRecord.jobs) ? parsedRecord.jobs : [];
		const store = {
			version: 1,
			jobs: jobs.filter(Boolean)
		};
		const stateFile = await loadStateFile(resolveStatePath(storePath));
		const hasLegacyInlineState = !stateFile && hasInlineState(jobs);
		if (stateFile) for (const job of store.jobs) {
			const entry = stateFile.jobs[job.id];
			if (entry) mergeStateFileEntry(job, entry);
			else backfillMissingRuntimeFields(job);
		}
		else if (!hasLegacyInlineState) for (const job of store.jobs) backfillMissingRuntimeFields(job);
		for (const job of store.jobs) ensureJobStateObject(job);
		const configJson = JSON.stringify(stripRuntimeOnlyCronFields(store), null, 2);
		const stateJson = JSON.stringify(extractStateFile(store), null, 2);
		serializedStoreCache.set(storePath, {
			configJson,
			stateJson,
			needsSplitMigration: hasLegacyInlineState
		});
		return store;
	} catch (err) {
		if (err?.code === "ENOENT") {
			serializedStoreCache.delete(storePath);
			return {
				version: 1,
				jobs: []
			};
		}
		throw err;
	}
}
function loadCronStoreSync(storePath) {
	try {
		const raw = fs.readFileSync(storePath, "utf-8");
		let parsed;
		try {
			parsed = parseJsonWithJson5Fallback(raw);
		} catch (err) {
			throw new Error(`Failed to parse cron store at ${storePath}: ${String(err)}`, { cause: err });
		}
		const parsedRecord = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		const jobs = Array.isArray(parsedRecord.jobs) ? parsedRecord.jobs : [];
		const store = {
			version: 1,
			jobs: jobs.filter(Boolean)
		};
		const stateFile = loadStateFileSync(resolveStatePath(storePath));
		const hasLegacyInlineState = !stateFile && hasInlineState(jobs);
		if (stateFile) for (const job of store.jobs) {
			const entry = stateFile.jobs[job.id];
			if (entry) mergeStateFileEntry(job, entry);
			else backfillMissingRuntimeFields(job);
		}
		else if (!hasLegacyInlineState) for (const job of store.jobs) backfillMissingRuntimeFields(job);
		for (const job of store.jobs) ensureJobStateObject(job);
		return store;
	} catch (err) {
		if (err?.code === "ENOENT") return {
			version: 1,
			jobs: []
		};
		throw err;
	}
}
async function setSecureFileMode(filePath) {
	await fs.promises.chmod(filePath, 384).catch(() => void 0);
}
async function atomicWrite(filePath, content, dirMode = 448) {
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, {
		recursive: true,
		mode: dirMode
	});
	await fs.promises.chmod(dir, dirMode).catch(() => void 0);
	const tmp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	await fs.promises.writeFile(tmp, content, {
		encoding: "utf-8",
		mode: 384
	});
	await renameWithRetry(tmp, filePath);
	await setSecureFileMode(filePath);
}
async function serializedFileNeedsWrite(filePath, expectedJson, contentChanged) {
	if (contentChanged) return true;
	try {
		return await fs.promises.readFile(filePath, "utf-8") !== expectedJson;
	} catch (err) {
		if (err?.code === "ENOENT") return true;
		throw err;
	}
}
async function saveCronStore(storePath, store, opts) {
	const stateOnly = opts?.stateOnly === true;
	const configJson = JSON.stringify(stripRuntimeOnlyCronFields(store), null, 2);
	const stateFile = extractStateFile(store);
	const stateJson = JSON.stringify(stateFile, null, 2);
	const statePath = resolveStatePath(storePath);
	const cache = serializedStoreCache.get(storePath);
	const configChanged = !stateOnly && cache?.configJson !== configJson;
	const stateChanged = cache?.stateJson !== stateJson;
	const migrating = cache?.needsSplitMigration === true;
	const configNeedsWrite = stateOnly ? false : await serializedFileNeedsWrite(storePath, configJson, configChanged);
	const stateNeedsWrite = await serializedFileNeedsWrite(statePath, stateJson, stateChanged);
	if (stateOnly ? !stateNeedsWrite && !migrating : !configNeedsWrite && !stateNeedsWrite && !migrating) return;
	const updatedCache = getSerializedStoreCache(storePath);
	if (stateNeedsWrite || migrating) {
		await atomicWrite(statePath, stateJson);
		updatedCache.stateJson = stateJson;
	}
	if (!stateOnly && (configNeedsWrite || migrating)) {
		if (!(opts?.skipBackup === true || !configChanged)) try {
			const backupPath = `${storePath}.bak`;
			await fs.promises.copyFile(storePath, backupPath);
			await setSecureFileMode(backupPath);
		} catch {}
		await atomicWrite(storePath, configJson);
		updatedCache.configJson = configJson;
	}
	updatedCache.needsSplitMigration = stateOnly && migrating;
}
const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 50;
async function renameWithRetry(src, dest) {
	for (let attempt = 0; attempt <= RENAME_MAX_RETRIES; attempt++) try {
		await fs.promises.rename(src, dest);
		return;
	} catch (err) {
		const code = err.code;
		if (code === "EBUSY" && attempt < RENAME_MAX_RETRIES) {
			await new Promise((resolve) => setTimeout(resolve, RENAME_BASE_DELAY_MS * 2 ** attempt));
			continue;
		}
		if (code === "EPERM" || code === "EEXIST") {
			await fs.promises.copyFile(src, dest);
			await fs.promises.unlink(src).catch(() => {});
			return;
		}
		throw err;
	}
}
//#endregion
export { cronSchedulingInputsEqual as a, saveCronStore as i, loadCronStoreSync as n, resolveCronStorePath as r, loadCronStore as t };
