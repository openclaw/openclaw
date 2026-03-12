import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { n as listAgentIds, s as resolveAgentWorkspaceDir } from "./agent-scope-ET3-KDD1.js";
import { s as resolveStateDir } from "./paths-MYHBPf85.js";
import { T as CONFIG_DIR, t as createSubsystemLogger, z as resolveUserPath } from "./subsystem-CYLd4dcj.js";
import { o as resolvePluginSkillDirs, t as buildWorkspaceSkillCommandSpecs } from "./skills-D8Wcotgx.js";
import { a as listChatCommands } from "./commands-registry-BddqMTS2.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import syncFs from "node:fs";
import { randomUUID } from "node:crypto";
import chokidar from "chokidar";

//#region src/infra/json-files.ts
async function readJsonFile(filePath) {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
async function writeJsonAtomic(filePath, value, options) {
	const mode = options?.mode ?? 384;
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true });
	const tmp = `${filePath}.${randomUUID()}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
	try {
		await fs.chmod(tmp, mode);
	} catch {}
	await fs.rename(tmp, filePath);
	try {
		await fs.chmod(filePath, mode);
	} catch {}
}
function createAsyncLock() {
	let lock = Promise.resolve();
	return async function withLock(fn) {
		const prev = lock;
		let release;
		lock = new Promise((resolve) => {
			release = resolve;
		});
		await prev;
		try {
			return await fn();
		} finally {
			release?.();
		}
	};
}

//#endregion
//#region src/infra/pairing-files.ts
function resolvePairingPaths(baseDir, subdir) {
	const root = baseDir ?? resolveStateDir();
	const dir = path.join(root, subdir);
	return {
		dir,
		pendingPath: path.join(dir, "pending.json"),
		pairedPath: path.join(dir, "paired.json")
	};
}
function pruneExpiredPending(pendingById, nowMs, ttlMs) {
	for (const [id, req] of Object.entries(pendingById)) if (nowMs - req.ts > ttlMs) delete pendingById[id];
}

//#endregion
//#region src/agents/skills/refresh.ts
const log$1 = createSubsystemLogger("gateway/skills");
const listeners = /* @__PURE__ */ new Set();
const workspaceVersions = /* @__PURE__ */ new Map();
const watchers = /* @__PURE__ */ new Map();
let globalVersion = 0;
const DEFAULT_SKILLS_WATCH_IGNORED = [
	/(^|[\\/])\.git([\\/]|$)/,
	/(^|[\\/])node_modules([\\/]|$)/,
	/(^|[\\/])dist([\\/]|$)/,
	/(^|[\\/])\.venv([\\/]|$)/,
	/(^|[\\/])venv([\\/]|$)/,
	/(^|[\\/])__pycache__([\\/]|$)/,
	/(^|[\\/])\.mypy_cache([\\/]|$)/,
	/(^|[\\/])\.pytest_cache([\\/]|$)/,
	/(^|[\\/])build([\\/]|$)/,
	/(^|[\\/])\.cache([\\/]|$)/
];
function bumpVersion(current) {
	const now = Date.now();
	return now <= current ? current + 1 : now;
}
function emit(event) {
	for (const listener of listeners) try {
		listener(event);
	} catch (err) {
		log$1.warn(`skills change listener failed: ${String(err)}`);
	}
}
function resolveWatchPaths(workspaceDir, config) {
	const paths = [];
	if (workspaceDir.trim()) {
		paths.push(path.join(workspaceDir, "skills"));
		paths.push(path.join(workspaceDir, ".agents", "skills"));
	}
	paths.push(path.join(CONFIG_DIR, "skills"));
	paths.push(path.join(os.homedir(), ".agents", "skills"));
	const extraDirs = (config?.skills?.load?.extraDirs ?? []).map((d) => typeof d === "string" ? d.trim() : "").filter(Boolean).map((dir) => resolveUserPath(dir));
	paths.push(...extraDirs);
	const pluginSkillDirs = resolvePluginSkillDirs({
		workspaceDir,
		config
	});
	paths.push(...pluginSkillDirs);
	return paths;
}
function toWatchGlobRoot(raw) {
	return raw.replaceAll("\\", "/").replace(/\/+$/, "");
}
function resolveWatchTargets(workspaceDir, config) {
	const targets = /* @__PURE__ */ new Set();
	for (const root of resolveWatchPaths(workspaceDir, config)) {
		const globRoot = toWatchGlobRoot(root);
		targets.add(`${globRoot}/SKILL.md`);
		targets.add(`${globRoot}/*/SKILL.md`);
	}
	return Array.from(targets).toSorted();
}
function bumpSkillsSnapshotVersion(params) {
	const reason = params?.reason ?? "manual";
	const changedPath = params?.changedPath;
	if (params?.workspaceDir) {
		const next = bumpVersion(workspaceVersions.get(params.workspaceDir) ?? 0);
		workspaceVersions.set(params.workspaceDir, next);
		emit({
			workspaceDir: params.workspaceDir,
			reason,
			changedPath
		});
		return next;
	}
	globalVersion = bumpVersion(globalVersion);
	emit({
		reason,
		changedPath
	});
	return globalVersion;
}
function getSkillsSnapshotVersion(workspaceDir) {
	if (!workspaceDir) return globalVersion;
	const local = workspaceVersions.get(workspaceDir) ?? 0;
	return Math.max(globalVersion, local);
}
function ensureSkillsWatcher(params) {
	const workspaceDir = params.workspaceDir.trim();
	if (!workspaceDir) return;
	const watchEnabled = params.config?.skills?.load?.watch !== false;
	const debounceMsRaw = params.config?.skills?.load?.watchDebounceMs;
	const debounceMs = typeof debounceMsRaw === "number" && Number.isFinite(debounceMsRaw) ? Math.max(0, debounceMsRaw) : 250;
	const existing = watchers.get(workspaceDir);
	if (!watchEnabled) {
		if (existing) {
			watchers.delete(workspaceDir);
			if (existing.timer) clearTimeout(existing.timer);
			existing.watcher.close().catch(() => {});
		}
		return;
	}
	const watchTargets = resolveWatchTargets(workspaceDir, params.config);
	const pathsKey = watchTargets.join("|");
	if (existing && existing.pathsKey === pathsKey && existing.debounceMs === debounceMs) return;
	if (existing) {
		watchers.delete(workspaceDir);
		if (existing.timer) clearTimeout(existing.timer);
		existing.watcher.close().catch(() => {});
	}
	const watcher = chokidar.watch(watchTargets, {
		ignoreInitial: true,
		awaitWriteFinish: {
			stabilityThreshold: debounceMs,
			pollInterval: 100
		},
		ignored: DEFAULT_SKILLS_WATCH_IGNORED
	});
	const state = {
		watcher,
		pathsKey,
		debounceMs
	};
	const schedule = (changedPath) => {
		state.pendingPath = changedPath ?? state.pendingPath;
		if (state.timer) clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			const pendingPath = state.pendingPath;
			state.pendingPath = void 0;
			state.timer = void 0;
			bumpSkillsSnapshotVersion({
				workspaceDir,
				reason: "watch",
				changedPath: pendingPath
			});
		}, debounceMs);
	};
	watcher.on("add", (p) => schedule(p));
	watcher.on("change", (p) => schedule(p));
	watcher.on("unlink", (p) => schedule(p));
	watcher.on("error", (err) => {
		log$1.warn(`skills watcher error (${workspaceDir}): ${String(err)}`);
	});
	watchers.set(workspaceDir, state);
}

//#endregion
//#region src/infra/node-pairing.ts
const PENDING_TTL_MS = 300 * 1e3;
const withLock = createAsyncLock();

//#endregion
//#region src/infra/skills-remote.ts
const log = createSubsystemLogger("gateway/skills-remote");
const remoteNodes = /* @__PURE__ */ new Map();
function isMacPlatform(platform, deviceFamily) {
	const platformNorm = String(platform ?? "").trim().toLowerCase();
	const familyNorm = String(deviceFamily ?? "").trim().toLowerCase();
	if (platformNorm.includes("mac")) return true;
	if (platformNorm.includes("darwin")) return true;
	if (familyNorm === "mac") return true;
	return false;
}
function supportsSystemRun(commands) {
	return Array.isArray(commands) && commands.includes("system.run");
}
function getRemoteSkillEligibility() {
	const macNodes = [...remoteNodes.values()].filter((node) => isMacPlatform(node.platform, node.deviceFamily) && supportsSystemRun(node.commands));
	if (macNodes.length === 0) return;
	const bins = /* @__PURE__ */ new Set();
	for (const node of macNodes) for (const bin of node.bins) bins.add(bin);
	const labels = macNodes.map((node) => node.displayName ?? node.nodeId).filter(Boolean);
	return {
		platforms: ["darwin"],
		hasBin: (bin) => bins.has(bin),
		hasAnyBin: (required) => required.some((bin) => bins.has(bin)),
		note: labels.length > 0 ? `Remote macOS node available (${labels.join(", ")}). Run macOS-only skills via nodes.run on that node.` : "Remote macOS node available. Run macOS-only skills via nodes.run on that node."
	};
}

//#endregion
//#region src/auto-reply/skill-commands.ts
var skill_commands_exports = /* @__PURE__ */ __exportAll({
	listReservedChatSlashCommandNames: () => listReservedChatSlashCommandNames,
	listSkillCommandsForAgents: () => listSkillCommandsForAgents,
	listSkillCommandsForWorkspace: () => listSkillCommandsForWorkspace,
	resolveSkillCommandInvocation: () => resolveSkillCommandInvocation
});
function listReservedChatSlashCommandNames(extraNames = []) {
	const reserved = /* @__PURE__ */ new Set();
	for (const command of listChatCommands()) {
		if (command.nativeName) reserved.add(command.nativeName.toLowerCase());
		for (const alias of command.textAliases) {
			const trimmed = alias.trim();
			if (!trimmed.startsWith("/")) continue;
			reserved.add(trimmed.slice(1).toLowerCase());
		}
	}
	for (const name of extraNames) {
		const trimmed = name.trim().toLowerCase();
		if (trimmed) reserved.add(trimmed);
	}
	return reserved;
}
function listSkillCommandsForWorkspace(params) {
	return buildWorkspaceSkillCommandSpecs(params.workspaceDir, {
		config: params.cfg,
		skillFilter: params.skillFilter,
		eligibility: { remote: getRemoteSkillEligibility() },
		reservedNames: listReservedChatSlashCommandNames()
	});
}
function listSkillCommandsForAgents(params) {
	const used = listReservedChatSlashCommandNames();
	const entries = [];
	const agentIds = params.agentIds ?? listAgentIds(params.cfg);
	const visitedDirs = /* @__PURE__ */ new Set();
	for (const agentId of agentIds) {
		const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
		if (!syncFs.existsSync(workspaceDir)) continue;
		const canonicalDir = syncFs.realpathSync(workspaceDir);
		if (visitedDirs.has(canonicalDir)) continue;
		visitedDirs.add(canonicalDir);
		const commands = buildWorkspaceSkillCommandSpecs(workspaceDir, {
			config: params.cfg,
			eligibility: { remote: getRemoteSkillEligibility() },
			reservedNames: used
		});
		for (const command of commands) {
			used.add(command.name.toLowerCase());
			entries.push(command);
		}
	}
	return entries;
}
function normalizeSkillCommandLookup(value) {
	return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}
function findSkillCommand(skillCommands, rawName) {
	const trimmed = rawName.trim();
	if (!trimmed) return;
	const lowered = trimmed.toLowerCase();
	const normalized = normalizeSkillCommandLookup(trimmed);
	return skillCommands.find((entry) => {
		if (entry.name.toLowerCase() === lowered) return true;
		if (entry.skillName.toLowerCase() === lowered) return true;
		return normalizeSkillCommandLookup(entry.name) === normalized || normalizeSkillCommandLookup(entry.skillName) === normalized;
	});
}
function resolveSkillCommandInvocation(params) {
	const trimmed = params.commandBodyNormalized.trim();
	if (!trimmed.startsWith("/")) return null;
	const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
	if (!match) return null;
	const commandName = match[1]?.trim().toLowerCase();
	if (!commandName) return null;
	if (commandName === "skill") {
		const remainder = match[2]?.trim();
		if (!remainder) return null;
		const skillMatch = remainder.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
		if (!skillMatch) return null;
		const skillCommand = findSkillCommand(params.skillCommands, skillMatch[1] ?? "");
		if (!skillCommand) return null;
		return {
			command: skillCommand,
			args: skillMatch[2]?.trim() || void 0
		};
	}
	const command = params.skillCommands.find((entry) => entry.name.toLowerCase() === commandName);
	if (!command) return null;
	return {
		command,
		args: match[2]?.trim() || void 0
	};
}

//#endregion
export { skill_commands_exports as a, getSkillsSnapshotVersion as c, createAsyncLock as d, readJsonFile as f, resolveSkillCommandInvocation as i, pruneExpiredPending as l, listSkillCommandsForAgents as n, getRemoteSkillEligibility as o, writeJsonAtomic as p, listSkillCommandsForWorkspace as r, ensureSkillsWatcher as s, listReservedChatSlashCommandNames as t, resolvePairingPaths as u };