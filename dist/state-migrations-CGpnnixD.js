import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as expandHomePrefix } from "./home-dir-BOPFpGo8.js";
import { _ as resolveOAuthDir, g as resolveNewStateDir, h as resolveLegacyStateDirs, y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { c as isWithinDir } from "./path-BlG8lhgR.js";
import "./agent-scope-CtLXGcWm.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { l as normalizeAgentId, n as DEFAULT_MAIN_KEY, r as buildAgentMainSessionKey, t as DEFAULT_AGENT_ID, u as normalizeMainKey } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-CMp71_27.js";
import "./path-safety-CBe_wA_B.js";
import "./subsystem-DSPWLoK5.js";
import { c as listBundledChannelLegacySessionSurfaces, l as listBundledChannelLegacyStateMigrationDetectors } from "./bundled-0oTAwz0N.js";
import { t as canonicalizeMainSessionAlias } from "./main-session-D3q_5w0B.js";
import { c as saveSessionStore } from "./store-BmtchQvp.js";
import "./sessions-CQHHcgC_.js";
import fs from "node:fs";
import JSON5 from "json5";
import path from "node:path";
import os from "node:os";
//#region src/infra/state-migrations.fs.ts
function safeReadDir(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}
function existsDir(dir) {
	try {
		return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}
function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}
function fileExists(p) {
	try {
		return fs.existsSync(p) && fs.statSync(p).isFile();
	} catch {
		return false;
	}
}
function readSessionStoreJson5(storePath) {
	try {
		const raw = fs.readFileSync(storePath, "utf-8");
		const parsed = JSON5.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return {
			store: parsed,
			ok: true
		};
	} catch {}
	return {
		store: {},
		ok: false
	};
}
//#endregion
//#region src/infra/state-migrations.ts
let autoMigrateStateDirChecked = false;
let cachedLegacySessionSurfaces = null;
function getLegacySessionSurfaces() {
	cachedLegacySessionSurfaces ??= [...listBundledChannelLegacySessionSurfaces()];
	return cachedLegacySessionSurfaces;
}
function isSurfaceGroupKey(key) {
	return key.includes(":group:") || key.includes(":channel:");
}
function isLegacyGroupKey(key) {
	const trimmed = key.trim();
	if (!trimmed) return false;
	const lower = normalizeLowercaseStringOrEmpty(trimmed);
	if (lower.startsWith("group:") || lower.startsWith("channel:")) return true;
	for (const surface of getLegacySessionSurfaces()) if (surface.isLegacyGroupSessionKey?.(trimmed)) return true;
	return false;
}
function buildLegacyMigrationPreview(plan) {
	return `- ${plan.label}: ${plan.sourcePath} → ${plan.targetPath}`;
}
async function runLegacyMigrationPlans(plans) {
	const changes = [];
	const warnings = [];
	for (const plan of plans) {
		if (fileExists(plan.targetPath)) continue;
		try {
			ensureDir(path.dirname(plan.targetPath));
			if (plan.kind === "move") {
				fs.renameSync(plan.sourcePath, plan.targetPath);
				changes.push(`Moved ${plan.label} → ${plan.targetPath}`);
			} else {
				fs.copyFileSync(plan.sourcePath, plan.targetPath);
				changes.push(`Copied ${plan.label} → ${plan.targetPath}`);
			}
		} catch (err) {
			warnings.push(`Failed migrating ${plan.label} (${plan.sourcePath}): ${String(err)}`);
		}
	}
	return {
		changes,
		warnings
	};
}
function canonicalizeSessionKeyForAgent(params) {
	const agentId = normalizeAgentId(params.agentId);
	const raw = params.key.trim();
	if (!raw) return raw;
	const rawLower = normalizeLowercaseStringOrEmpty(raw);
	if (rawLower === "global" || rawLower === "unknown") return rawLower;
	if (params.skipCrossAgentRemap) {
		const parsed = parseAgentSessionKey(raw);
		if (parsed && normalizeAgentId(parsed.agentId) !== agentId) return rawLower;
		if (agentId !== "main" && (rawLower === "main" || rawLower === params.mainKey)) return rawLower;
	}
	const canonicalMain = canonicalizeMainSessionAlias({
		cfg: { session: {
			scope: params.scope,
			mainKey: params.mainKey
		} },
		agentId,
		sessionKey: raw
	});
	if (canonicalMain !== raw) return normalizeLowercaseStringOrEmpty(canonicalMain);
	const defaultPrefix = `agent:${DEFAULT_AGENT_ID}:`;
	if (rawLower.startsWith(defaultPrefix) && agentId !== "main" && !params.skipCrossAgentRemap) {
		const rest = rawLower.slice(defaultPrefix.length);
		if (rest === "main" || rest === params.mainKey) {
			const remapped = `agent:${agentId}:${rest}`;
			return normalizeLowercaseStringOrEmpty(canonicalizeMainSessionAlias({
				cfg: { session: {
					scope: params.scope,
					mainKey: params.mainKey
				} },
				agentId,
				sessionKey: remapped
			}));
		}
	}
	if (rawLower.startsWith("agent:")) return rawLower;
	if (rawLower.startsWith("subagent:")) return normalizeLowercaseStringOrEmpty(`agent:${agentId}:subagent:${raw.slice(9)}`);
	for (const surface of getLegacySessionSurfaces()) {
		const canonicalized = surface.canonicalizeLegacySessionKey?.({
			key: raw,
			agentId
		});
		const normalizedCanonicalized = normalizeOptionalLowercaseString(canonicalized);
		if (normalizedCanonicalized) return normalizedCanonicalized;
	}
	if (rawLower.startsWith("group:") || rawLower.startsWith("channel:")) return normalizeLowercaseStringOrEmpty(`agent:${agentId}:unknown:${raw}`);
	if (isSurfaceGroupKey(raw)) return normalizeLowercaseStringOrEmpty(`agent:${agentId}:${raw}`);
	return normalizeLowercaseStringOrEmpty(`agent:${agentId}:${raw}`);
}
function pickLatestLegacyDirectEntry(store) {
	let best = null;
	let bestUpdated = -1;
	for (const [key, entry] of Object.entries(store)) {
		if (!entry || typeof entry !== "object") continue;
		const normalized = key.trim();
		if (!normalized) continue;
		if (normalized === "global") continue;
		if (normalized.startsWith("agent:")) continue;
		if (normalizeLowercaseStringOrEmpty(normalized).startsWith("subagent:")) continue;
		if (isLegacyGroupKey(normalized) || isSurfaceGroupKey(normalized)) continue;
		const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
		if (updatedAt > bestUpdated) {
			bestUpdated = updatedAt;
			best = entry;
		}
	}
	return best;
}
function normalizeSessionEntry(entry) {
	const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : null;
	if (!sessionId) return null;
	const updatedAt = typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now();
	const normalized = {
		...entry,
		sessionId,
		updatedAt
	};
	const rec = normalized;
	if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") rec.groupChannel = rec.room;
	delete rec.room;
	return normalized;
}
function resolveUpdatedAt(entry) {
	return typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0;
}
function mergeSessionEntry(params) {
	if (!params.existing) return params.incoming;
	const existingUpdated = resolveUpdatedAt(params.existing);
	const incomingUpdated = resolveUpdatedAt(params.incoming);
	if (incomingUpdated > existingUpdated) return params.incoming;
	if (incomingUpdated < existingUpdated) return params.existing;
	return params.preferIncomingOnTie ? params.incoming : params.existing;
}
function canonicalizeSessionStore(params) {
	const canonical = {};
	const meta = /* @__PURE__ */ new Map();
	const legacyKeys = [];
	for (const [key, entry] of Object.entries(params.store)) {
		if (!entry || typeof entry !== "object") continue;
		const canonicalKey = canonicalizeSessionKeyForAgent({
			key,
			agentId: params.agentId,
			mainKey: params.mainKey,
			scope: params.scope,
			skipCrossAgentRemap: params.skipCrossAgentRemap
		});
		const isCanonical = canonicalKey === key;
		if (!isCanonical) legacyKeys.push(key);
		const existing = canonical[canonicalKey];
		if (!existing) {
			canonical[canonicalKey] = entry;
			meta.set(canonicalKey, {
				isCanonical,
				updatedAt: resolveUpdatedAt(entry)
			});
			continue;
		}
		const existingMeta = meta.get(canonicalKey);
		const incomingUpdated = resolveUpdatedAt(entry);
		const existingUpdated = existingMeta?.updatedAt ?? resolveUpdatedAt(existing);
		if (incomingUpdated > existingUpdated) {
			canonical[canonicalKey] = entry;
			meta.set(canonicalKey, {
				isCanonical,
				updatedAt: incomingUpdated
			});
			continue;
		}
		if (incomingUpdated < existingUpdated) continue;
		if (existingMeta?.isCanonical && !isCanonical) continue;
		if (!existingMeta?.isCanonical && isCanonical) {
			canonical[canonicalKey] = entry;
			meta.set(canonicalKey, {
				isCanonical,
				updatedAt: incomingUpdated
			});
			continue;
		}
	}
	return {
		store: canonical,
		legacyKeys
	};
}
function listLegacySessionKeys(params) {
	const legacy = [];
	for (const key of Object.keys(params.store)) if (canonicalizeSessionKeyForAgent({
		key,
		agentId: params.agentId,
		mainKey: params.mainKey,
		scope: params.scope
	}) !== key) legacy.push(key);
	return legacy;
}
function emptyDirOrMissing(dir) {
	if (!existsDir(dir)) return true;
	return safeReadDir(dir).length === 0;
}
function removeDirIfEmpty(dir) {
	if (!existsDir(dir)) return;
	if (!emptyDirOrMissing(dir)) return;
	try {
		fs.rmdirSync(dir);
	} catch {}
}
function resolveSymlinkTarget(linkPath) {
	try {
		const target = fs.readlinkSync(linkPath);
		return path.resolve(path.dirname(linkPath), target);
	} catch {
		return null;
	}
}
function formatStateDirMigration(legacyDir, targetDir) {
	return `State dir: ${legacyDir} → ${targetDir} (legacy path now symlinked)`;
}
function isDirPath(filePath) {
	try {
		return fs.statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}
function isLegacyTreeSymlinkMirror(currentDir, realTargetDir) {
	let entries;
	try {
		entries = fs.readdirSync(currentDir, { withFileTypes: true });
	} catch {
		return false;
	}
	if (entries.length === 0) return false;
	for (const entry of entries) {
		const entryPath = path.join(currentDir, entry.name);
		let stat;
		try {
			stat = fs.lstatSync(entryPath);
		} catch {
			return false;
		}
		if (stat.isSymbolicLink()) {
			const resolvedTarget = resolveSymlinkTarget(entryPath);
			if (!resolvedTarget) return false;
			let resolvedRealTarget;
			try {
				resolvedRealTarget = fs.realpathSync(resolvedTarget);
			} catch {
				return false;
			}
			if (!isWithinDir(realTargetDir, resolvedRealTarget)) return false;
			continue;
		}
		if (stat.isDirectory()) {
			if (!isLegacyTreeSymlinkMirror(entryPath, realTargetDir)) return false;
			continue;
		}
		return false;
	}
	return true;
}
function isLegacyDirSymlinkMirror(legacyDir, targetDir) {
	let realTargetDir;
	try {
		realTargetDir = fs.realpathSync(targetDir);
	} catch {
		return false;
	}
	return isLegacyTreeSymlinkMirror(legacyDir, realTargetDir);
}
async function autoMigrateLegacyStateDir(params) {
	if (autoMigrateStateDirChecked) return {
		migrated: false,
		skipped: true,
		changes: [],
		warnings: []
	};
	autoMigrateStateDirChecked = true;
	if ((params.env ?? process.env).OPENCLAW_STATE_DIR?.trim()) return {
		migrated: false,
		skipped: true,
		changes: [],
		warnings: []
	};
	const homedir = params.homedir ?? os.homedir;
	const targetDir = resolveNewStateDir(homedir);
	const legacyDirs = resolveLegacyStateDirs(homedir);
	let legacyDir = legacyDirs.find((dir) => {
		try {
			return fs.existsSync(dir);
		} catch {
			return false;
		}
	});
	const warnings = [];
	const changes = [];
	let legacyStat = null;
	try {
		legacyStat = legacyDir ? fs.lstatSync(legacyDir) : null;
	} catch {
		legacyStat = null;
	}
	if (!legacyStat) return {
		migrated: false,
		skipped: false,
		changes,
		warnings
	};
	if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
		warnings.push(`Legacy state path is not a directory: ${legacyDir}`);
		return {
			migrated: false,
			skipped: false,
			changes,
			warnings
		};
	}
	let symlinkDepth = 0;
	while (legacyStat.isSymbolicLink()) {
		const legacyTarget = legacyDir ? resolveSymlinkTarget(legacyDir) : null;
		if (!legacyTarget) {
			warnings.push(`Legacy state dir is a symlink (${legacyDir ?? "unknown"}); could not resolve target.`);
			return {
				migrated: false,
				skipped: false,
				changes,
				warnings
			};
		}
		if (path.resolve(legacyTarget) === path.resolve(targetDir)) return {
			migrated: false,
			skipped: false,
			changes,
			warnings
		};
		if (legacyDirs.some((dir) => path.resolve(dir) === path.resolve(legacyTarget))) {
			legacyDir = legacyTarget;
			try {
				legacyStat = fs.lstatSync(legacyDir);
			} catch {
				legacyStat = null;
			}
			if (!legacyStat) {
				warnings.push(`Legacy state dir missing after symlink resolution: ${legacyDir}`);
				return {
					migrated: false,
					skipped: false,
					changes,
					warnings
				};
			}
			if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
				warnings.push(`Legacy state path is not a directory: ${legacyDir}`);
				return {
					migrated: false,
					skipped: false,
					changes,
					warnings
				};
			}
			symlinkDepth += 1;
			if (symlinkDepth > 2) {
				warnings.push(`Legacy state dir symlink chain too deep: ${legacyDir}`);
				return {
					migrated: false,
					skipped: false,
					changes,
					warnings
				};
			}
			continue;
		}
		warnings.push(`Legacy state dir is a symlink (${legacyDir ?? "unknown"} → ${legacyTarget}); skipping auto-migration.`);
		return {
			migrated: false,
			skipped: false,
			changes,
			warnings
		};
	}
	if (isDirPath(targetDir)) {
		if (legacyDir && isLegacyDirSymlinkMirror(legacyDir, targetDir)) return {
			migrated: false,
			skipped: false,
			changes,
			warnings
		};
		warnings.push(`State dir migration skipped: target already exists (${targetDir}). Remove or merge manually.`);
		return {
			migrated: false,
			skipped: false,
			changes,
			warnings
		};
	}
	try {
		if (!legacyDir) throw new Error("Legacy state dir not found");
		fs.renameSync(legacyDir, targetDir);
	} catch (err) {
		warnings.push(`Failed to move legacy state dir (${legacyDir ?? "unknown"} → ${targetDir}): ${String(err)}`);
		return {
			migrated: false,
			skipped: false,
			changes,
			warnings
		};
	}
	try {
		if (!legacyDir) throw new Error("Legacy state dir not found");
		fs.symlinkSync(targetDir, legacyDir, "dir");
		changes.push(formatStateDirMigration(legacyDir, targetDir));
	} catch (err) {
		try {
			if (process.platform === "win32") {
				if (!legacyDir) throw new Error("Legacy state dir not found", { cause: err });
				fs.symlinkSync(targetDir, legacyDir, "junction");
				changes.push(formatStateDirMigration(legacyDir, targetDir));
			} else throw err;
		} catch (fallbackErr) {
			try {
				if (!legacyDir) throw new Error("Legacy state dir not found", { cause: fallbackErr });
				fs.renameSync(targetDir, legacyDir);
				warnings.push(`State dir migration rolled back (failed to link legacy path): ${String(fallbackErr)}`);
				return {
					migrated: false,
					skipped: false,
					changes: [],
					warnings
				};
			} catch (rollbackErr) {
				warnings.push(`State dir moved but failed to link legacy path (${legacyDir ?? "unknown"} → ${targetDir}): ${String(fallbackErr)}`);
				warnings.push(`Rollback failed; set OPENCLAW_STATE_DIR=${targetDir} to avoid split state: ${String(rollbackErr)}`);
				changes.push(`State dir: ${legacyDir ?? "unknown"} → ${targetDir}`);
			}
		}
	}
	return {
		migrated: changes.length > 0,
		skipped: false,
		changes,
		warnings
	};
}
async function collectChannelLegacyStateMigrationPlans(params) {
	const plans = [];
	const detectors = listBundledChannelLegacyStateMigrationDetectors({ config: params.cfg });
	for (const detectLegacyStateMigrations of detectors) {
		const detected = await detectLegacyStateMigrations({
			cfg: params.cfg,
			env: params.env,
			stateDir: params.stateDir,
			oauthDir: params.oauthDir
		});
		if (detected?.length) plans.push(...detected);
	}
	return plans;
}
async function detectLegacyStateMigrations(params) {
	const env = params.env ?? process.env;
	const stateDir = resolveStateDir(env, params.homedir ?? os.homedir);
	const oauthDir = resolveOAuthDir(env, stateDir);
	const targetAgentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
	const rawMainKey = params.cfg.session?.mainKey;
	const targetMainKey = typeof rawMainKey === "string" && rawMainKey.trim().length > 0 ? rawMainKey.trim() : DEFAULT_MAIN_KEY;
	const targetScope = params.cfg.session?.scope;
	const sessionsLegacyDir = path.join(stateDir, "sessions");
	const sessionsLegacyStorePath = path.join(sessionsLegacyDir, "sessions.json");
	const sessionsTargetDir = path.join(stateDir, "agents", targetAgentId, "sessions");
	const sessionsTargetStorePath = path.join(sessionsTargetDir, "sessions.json");
	const legacySessionEntries = safeReadDir(sessionsLegacyDir);
	const hasLegacySessions = fileExists(sessionsLegacyStorePath) || legacySessionEntries.some((e) => e.isFile() && e.name.endsWith(".jsonl"));
	const targetSessionParsed = fileExists(sessionsTargetStorePath) ? readSessionStoreJson5(sessionsTargetStorePath) : {
		store: {},
		ok: true
	};
	const legacyKeys = targetSessionParsed.ok ? listLegacySessionKeys({
		store: targetSessionParsed.store,
		agentId: targetAgentId,
		mainKey: targetMainKey,
		scope: targetScope
	}) : [];
	const legacyAgentDir = path.join(stateDir, "agent");
	const targetAgentDir = path.join(stateDir, "agents", targetAgentId, "agent");
	const hasLegacyAgentDir = existsDir(legacyAgentDir);
	const channelPlans = await collectChannelLegacyStateMigrationPlans({
		cfg: params.cfg,
		env,
		stateDir,
		oauthDir
	});
	const preview = [];
	if (hasLegacySessions) preview.push(`- Sessions: ${sessionsLegacyDir} → ${sessionsTargetDir}`);
	if (legacyKeys.length > 0) preview.push(`- Sessions: canonicalize legacy keys in ${sessionsTargetStorePath}`);
	if (hasLegacyAgentDir) preview.push(`- Agent dir: ${legacyAgentDir} → ${targetAgentDir}`);
	if (channelPlans.length > 0) preview.push(...channelPlans.map(buildLegacyMigrationPreview));
	return {
		targetAgentId,
		targetMainKey,
		targetScope,
		stateDir,
		oauthDir,
		sessions: {
			legacyDir: sessionsLegacyDir,
			legacyStorePath: sessionsLegacyStorePath,
			targetDir: sessionsTargetDir,
			targetStorePath: sessionsTargetStorePath,
			hasLegacy: hasLegacySessions || legacyKeys.length > 0,
			legacyKeys
		},
		agentDir: {
			legacyDir: legacyAgentDir,
			targetDir: targetAgentDir,
			hasLegacy: hasLegacyAgentDir
		},
		channelPlans: {
			hasLegacy: channelPlans.length > 0,
			plans: channelPlans
		},
		preview
	};
}
async function migrateLegacySessions(detected, now) {
	const changes = [];
	const warnings = [];
	if (!detected.sessions.hasLegacy) return {
		changes,
		warnings
	};
	ensureDir(detected.sessions.targetDir);
	const legacyParsed = fileExists(detected.sessions.legacyStorePath) ? readSessionStoreJson5(detected.sessions.legacyStorePath) : {
		store: {},
		ok: true
	};
	const targetParsed = fileExists(detected.sessions.targetStorePath) ? readSessionStoreJson5(detected.sessions.targetStorePath) : {
		store: {},
		ok: true
	};
	const legacyStore = legacyParsed.store;
	const targetStore = targetParsed.store;
	const canonicalizedTarget = canonicalizeSessionStore({
		store: targetStore,
		agentId: detected.targetAgentId,
		mainKey: detected.targetMainKey,
		scope: detected.targetScope
	});
	const canonicalizedLegacy = canonicalizeSessionStore({
		store: legacyStore,
		agentId: detected.targetAgentId,
		mainKey: detected.targetMainKey,
		scope: detected.targetScope
	});
	const merged = { ...canonicalizedTarget.store };
	for (const [key, entry] of Object.entries(canonicalizedLegacy.store)) merged[key] = mergeSessionEntry({
		existing: merged[key],
		incoming: entry,
		preferIncomingOnTie: false
	});
	const mainKey = buildAgentMainSessionKey({
		agentId: detected.targetAgentId,
		mainKey: detected.targetMainKey
	});
	if (!merged[mainKey]) {
		const latest = pickLatestLegacyDirectEntry(legacyStore);
		if (latest?.sessionId) {
			merged[mainKey] = latest;
			changes.push(`Migrated latest direct-chat session → ${mainKey}`);
		}
	}
	if (!legacyParsed.ok) warnings.push(`Legacy sessions store unreadable; left in place at ${detected.sessions.legacyStorePath}`);
	if ((legacyParsed.ok || targetParsed.ok) && (Object.keys(legacyStore).length > 0 || Object.keys(targetStore).length > 0)) {
		const normalized = {};
		for (const [key, entry] of Object.entries(merged)) {
			const normalizedEntry = normalizeSessionEntry(entry);
			if (!normalizedEntry) continue;
			normalized[key] = normalizedEntry;
		}
		await saveSessionStore(detected.sessions.targetStorePath, normalized, { skipMaintenance: true });
		changes.push(`Merged sessions store → ${detected.sessions.targetStorePath}`);
		if (canonicalizedTarget.legacyKeys.length > 0) changes.push(`Canonicalized ${canonicalizedTarget.legacyKeys.length} legacy session key(s)`);
	}
	const entries = safeReadDir(detected.sessions.legacyDir);
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (entry.name === "sessions.json") continue;
		const from = path.join(detected.sessions.legacyDir, entry.name);
		const to = path.join(detected.sessions.targetDir, entry.name);
		if (fileExists(to)) continue;
		try {
			fs.renameSync(from, to);
			changes.push(`Moved ${entry.name} → agents/${detected.targetAgentId}/sessions`);
		} catch (err) {
			warnings.push(`Failed moving ${from}: ${String(err)}`);
		}
	}
	if (legacyParsed.ok) try {
		if (fileExists(detected.sessions.legacyStorePath)) fs.rmSync(detected.sessions.legacyStorePath, { force: true });
	} catch {}
	removeDirIfEmpty(detected.sessions.legacyDir);
	if (safeReadDir(detected.sessions.legacyDir).filter((e) => e.isFile()).length > 0) {
		const backupDir = `${detected.sessions.legacyDir}.legacy-${now()}`;
		try {
			fs.renameSync(detected.sessions.legacyDir, backupDir);
			warnings.push(`Left legacy sessions at ${backupDir}`);
		} catch {}
	}
	return {
		changes,
		warnings
	};
}
async function migrateLegacyAgentDir(detected, now) {
	const changes = [];
	const warnings = [];
	if (!detected.agentDir.hasLegacy) return {
		changes,
		warnings
	};
	ensureDir(detected.agentDir.targetDir);
	const entries = safeReadDir(detected.agentDir.legacyDir);
	for (const entry of entries) {
		const from = path.join(detected.agentDir.legacyDir, entry.name);
		const to = path.join(detected.agentDir.targetDir, entry.name);
		if (fs.existsSync(to)) continue;
		try {
			fs.renameSync(from, to);
			changes.push(`Moved agent file ${entry.name} → agents/${detected.targetAgentId}/agent`);
		} catch (err) {
			warnings.push(`Failed moving ${from}: ${String(err)}`);
		}
	}
	removeDirIfEmpty(detected.agentDir.legacyDir);
	if (!emptyDirOrMissing(detected.agentDir.legacyDir)) {
		const backupDir = path.join(detected.stateDir, "agents", detected.targetAgentId, `agent.legacy-${now()}`);
		try {
			fs.renameSync(detected.agentDir.legacyDir, backupDir);
			warnings.push(`Left legacy agent dir at ${backupDir}`);
		} catch (err) {
			warnings.push(`Failed relocating legacy agent dir: ${String(err)}`);
		}
	}
	return {
		changes,
		warnings
	};
}
async function migrateChannelLegacyStatePlans(detected) {
	const changes = [];
	const warnings = [];
	if (!detected.channelPlans.hasLegacy) return {
		changes,
		warnings
	};
	return await runLegacyMigrationPlans(detected.channelPlans.plans);
}
async function runLegacyStateMigrations(params) {
	const now = params.now ?? (() => Date.now());
	const detected = params.detected;
	const sessions = await migrateLegacySessions(detected, now);
	const agentDir = await migrateLegacyAgentDir(detected, now);
	const channelPlans = await migrateChannelLegacyStatePlans(detected);
	return {
		changes: [
			...sessions.changes,
			...agentDir.changes,
			...channelPlans.changes
		],
		warnings: [
			...sessions.warnings,
			...agentDir.warnings,
			...channelPlans.warnings
		]
	};
}
/**
* Canonicalize orphaned raw session keys in all known agent session stores.
*
* Keys written by resolveSessionKey() used DEFAULT_AGENT_ID="main" regardless
* of the configured default agent; reads always use resolveSessionStoreKey()
* which canonicalizes via canonicalizeMainSessionAlias. This migration renames
* any orphaned raw keys to their canonical form in-place, merging with any
* existing canonical entry by preferring the most recently updated.
*
* Safe to run multiple times (idempotent). See #29683.
*/
async function migrateOrphanedSessionKeys(params) {
	const changes = [];
	const warnings = [];
	const env = params.env ?? process.env;
	const stateDir = resolveStateDir(env);
	const agentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
	const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
	const scope = params.cfg.session?.scope;
	const storeConfig = params.cfg.session?.store;
	const storeMap = /* @__PURE__ */ new Map();
	const addToStoreMap = (p, id) => {
		const existing = storeMap.get(p);
		if (existing) existing.add(id);
		else storeMap.set(p, new Set([id]));
	};
	addToStoreMap(storeConfig ? resolveStorePathFromTemplate(storeConfig, agentId, env) : path.join(stateDir, "agents", agentId, "sessions", "sessions.json"), agentId);
	for (const entry of params.cfg.agents?.list ?? []) if (entry?.id) {
		const id = normalizeAgentId(entry.id);
		addToStoreMap(storeConfig ? resolveStorePathFromTemplate(storeConfig, id, env) : path.join(stateDir, "agents", id, "sessions", "sessions.json"), id);
	}
	const agentsDir = path.join(stateDir, "agents");
	if (existsDir(agentsDir)) {
		for (const dirEntry of safeReadDir(agentsDir)) if (dirEntry.isDirectory()) {
			const diskAgentId = normalizeAgentId(dirEntry.name);
			if (diskAgentId) addToStoreMap(path.join(agentsDir, diskAgentId, "sessions", "sessions.json"), diskAgentId);
		}
	}
	for (const [storePath, storeAgentIds] of storeMap) {
		if (!fileExists(storePath)) continue;
		let parsed;
		try {
			parsed = readSessionStoreJson5(storePath);
		} catch (err) {
			warnings.push(`Could not read ${storePath}: ${String(err)}`);
			continue;
		}
		if (!parsed.ok) continue;
		let working = parsed.store;
		let totalLegacy = 0;
		for (const storeAgentId of storeAgentIds) {
			const { store: canonicalized, legacyKeys } = canonicalizeSessionStore({
				store: working,
				agentId: storeAgentId,
				mainKey,
				scope,
				skipCrossAgentRemap: storeAgentIds.size > 1 && storeAgentIds.has("main")
			});
			working = canonicalized;
			totalLegacy += legacyKeys.length;
		}
		if (totalLegacy === 0) continue;
		const normalized = {};
		for (const [key, entry] of Object.entries(working)) {
			const ne = normalizeSessionEntry(entry);
			if (ne) normalized[key] = ne;
		}
		try {
			await saveSessionStore(storePath, normalized, { skipMaintenance: true });
			changes.push(`Canonicalized ${totalLegacy} orphaned session key(s) in ${storePath}`);
		} catch (err) {
			warnings.push(`Failed to write canonicalized store ${storePath}: ${String(err)}`);
		}
	}
	return {
		changes,
		warnings
	};
}
function resolveStorePathFromTemplate(template, agentId, env) {
	const expand = (s) => s.startsWith("~") ? expandHomePrefix(s, {
		env: env ?? process.env,
		homedir: os.homedir
	}) : s;
	if (template.includes("{agentId}")) return path.resolve(expand(template.replaceAll("{agentId}", agentId)));
	return path.resolve(expand(template));
}
//#endregion
export { runLegacyStateMigrations as a, migrateOrphanedSessionKeys as i, detectLegacyStateMigrations as n, migrateLegacyAgentDir as r, autoMigrateLegacyStateDir as t };
