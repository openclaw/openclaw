import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { t as CONFIG_DIR, y as resolveUserPath } from "./utils-BKDT474X.js";
import { r as listAgentIds, u as resolveAgentWorkspaceDir } from "./agent-scope-D8K2SjR7.js";
import { t as createSubsystemLogger } from "./subsystem-LTWJBEIv.js";
import { i as loadWorkspaceSkillEntries, n as buildWorkspaceSkillCommandSpecs, s as resolvePluginSkillDirs } from "./skills-dyOFjtQH.js";
import { a as listChatCommands } from "./commands-registry-DvQussPa.js";
import { a as resolvePairingPaths, c as readJsonFile, i as pruneExpiredPending, l as writeJsonAtomic, n as verifyPairingToken, o as upsertPendingPairingRequest, r as rejectPendingPairingRequest, s as createAsyncLock, t as generatePairingToken } from "./pairing-token-BdLe8Jtz.js";
import { t as listAgentWorkspaceDirs } from "./workspace-dirs-B6ZgmCPQ.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import chokidar from "chokidar";

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
function registerSkillsChangeListener(listener) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
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
async function loadState(baseDir) {
	const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
	const [pending, paired] = await Promise.all([readJsonFile(pendingPath), readJsonFile(pairedPath)]);
	const state = {
		pendingById: pending ?? {},
		pairedByNodeId: paired ?? {}
	};
	pruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);
	return state;
}
async function persistState(state, baseDir) {
	const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
	await Promise.all([writeJsonAtomic(pendingPath, state.pendingById), writeJsonAtomic(pairedPath, state.pairedByNodeId)]);
}
function normalizeNodeId(nodeId) {
	return nodeId.trim();
}
function newToken() {
	return generatePairingToken();
}
async function listNodePairing(baseDir) {
	const state = await loadState(baseDir);
	return {
		pending: Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts),
		paired: Object.values(state.pairedByNodeId).toSorted((a, b) => b.approvedAtMs - a.approvedAtMs)
	};
}
async function requestNodePairing(req, baseDir) {
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const nodeId = normalizeNodeId(req.nodeId);
		if (!nodeId) throw new Error("nodeId required");
		return await upsertPendingPairingRequest({
			pendingById: state.pendingById,
			isExisting: (pending) => pending.nodeId === nodeId,
			isRepair: Boolean(state.pairedByNodeId[nodeId]),
			createRequest: (isRepair) => ({
				requestId: randomUUID(),
				nodeId,
				displayName: req.displayName,
				platform: req.platform,
				version: req.version,
				coreVersion: req.coreVersion,
				uiVersion: req.uiVersion,
				deviceFamily: req.deviceFamily,
				modelIdentifier: req.modelIdentifier,
				caps: req.caps,
				commands: req.commands,
				permissions: req.permissions,
				remoteIp: req.remoteIp,
				silent: req.silent,
				isRepair,
				ts: Date.now()
			}),
			persist: async () => await persistState(state, baseDir)
		});
	});
}
async function approveNodePairing(requestId, baseDir) {
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const pending = state.pendingById[requestId];
		if (!pending) return null;
		const now = Date.now();
		const existing = state.pairedByNodeId[pending.nodeId];
		const node = {
			nodeId: pending.nodeId,
			token: newToken(),
			displayName: pending.displayName,
			platform: pending.platform,
			version: pending.version,
			coreVersion: pending.coreVersion,
			uiVersion: pending.uiVersion,
			deviceFamily: pending.deviceFamily,
			modelIdentifier: pending.modelIdentifier,
			caps: pending.caps,
			commands: pending.commands,
			permissions: pending.permissions,
			remoteIp: pending.remoteIp,
			createdAtMs: existing?.createdAtMs ?? now,
			approvedAtMs: now
		};
		delete state.pendingById[requestId];
		state.pairedByNodeId[pending.nodeId] = node;
		await persistState(state, baseDir);
		return {
			requestId,
			node
		};
	});
}
async function rejectNodePairing(requestId, baseDir) {
	return await withLock(async () => {
		return await rejectPendingPairingRequest({
			requestId,
			idKey: "nodeId",
			loadState: () => loadState(baseDir),
			persistState: (state) => persistState(state, baseDir),
			getId: (pending) => pending.nodeId
		});
	});
}
async function verifyNodeToken(nodeId, token, baseDir) {
	const state = await loadState(baseDir);
	const normalized = normalizeNodeId(nodeId);
	const node = state.pairedByNodeId[normalized];
	if (!node) return { ok: false };
	return verifyPairingToken(token, node.token) ? {
		ok: true,
		node
	} : { ok: false };
}
async function updatePairedNodeMetadata(nodeId, patch, baseDir) {
	await withLock(async () => {
		const state = await loadState(baseDir);
		const normalized = normalizeNodeId(nodeId);
		const existing = state.pairedByNodeId[normalized];
		if (!existing) return;
		const next = {
			...existing,
			displayName: patch.displayName ?? existing.displayName,
			platform: patch.platform ?? existing.platform,
			version: patch.version ?? existing.version,
			coreVersion: patch.coreVersion ?? existing.coreVersion,
			uiVersion: patch.uiVersion ?? existing.uiVersion,
			deviceFamily: patch.deviceFamily ?? existing.deviceFamily,
			modelIdentifier: patch.modelIdentifier ?? existing.modelIdentifier,
			remoteIp: patch.remoteIp ?? existing.remoteIp,
			caps: patch.caps ?? existing.caps,
			commands: patch.commands ?? existing.commands,
			bins: patch.bins ?? existing.bins,
			permissions: patch.permissions ?? existing.permissions,
			lastConnectedAtMs: patch.lastConnectedAtMs ?? existing.lastConnectedAtMs
		};
		state.pairedByNodeId[normalized] = next;
		await persistState(state, baseDir);
	});
}
async function renamePairedNode(nodeId, displayName, baseDir) {
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const normalized = normalizeNodeId(nodeId);
		const existing = state.pairedByNodeId[normalized];
		if (!existing) return null;
		const trimmed = displayName.trim();
		if (!trimmed) throw new Error("displayName required");
		const next = {
			...existing,
			displayName: trimmed
		};
		state.pairedByNodeId[normalized] = next;
		await persistState(state, baseDir);
		return next;
	});
}

//#endregion
//#region src/infra/skills-remote.ts
const log = createSubsystemLogger("gateway/skills-remote");
const remoteNodes = /* @__PURE__ */ new Map();
let remoteRegistry = null;
function describeNode(nodeId) {
	const record = remoteNodes.get(nodeId);
	const name = record?.displayName?.trim();
	const base = name && name !== nodeId ? `${name} (${nodeId})` : nodeId;
	const ip = record?.remoteIp?.trim();
	return ip ? `${base} @ ${ip}` : base;
}
function extractErrorMessage(err) {
	if (!err) return;
	if (typeof err === "string") return err;
	if (err instanceof Error) return err.message;
	if (typeof err === "object" && "message" in err && typeof err.message === "string") return err.message;
	if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") return String(err);
	if (typeof err === "symbol") return err.toString();
	if (typeof err === "object") try {
		return JSON.stringify(err);
	} catch {
		return;
	}
}
function logRemoteBinProbeFailure(nodeId, err) {
	const message = extractErrorMessage(err);
	const label = describeNode(nodeId);
	if (message?.includes("node not connected") || message?.includes("node disconnected")) {
		log.info(`remote bin probe skipped: node unavailable (${label})`);
		return;
	}
	if (message?.includes("invoke timed out") || message?.includes("timeout")) {
		log.warn(`remote bin probe timed out (${label}); check node connectivity for ${label}`);
		return;
	}
	log.warn(`remote bin probe error (${label}): ${message ?? "unknown"}`);
}
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
function supportsSystemWhich(commands) {
	return Array.isArray(commands) && commands.includes("system.which");
}
function upsertNode(record) {
	const existing = remoteNodes.get(record.nodeId);
	const bins = new Set(record.bins ?? existing?.bins ?? []);
	remoteNodes.set(record.nodeId, {
		nodeId: record.nodeId,
		displayName: record.displayName ?? existing?.displayName,
		platform: record.platform ?? existing?.platform,
		deviceFamily: record.deviceFamily ?? existing?.deviceFamily,
		commands: record.commands ?? existing?.commands,
		remoteIp: record.remoteIp ?? existing?.remoteIp,
		bins
	});
}
function setSkillsRemoteRegistry(registry) {
	remoteRegistry = registry;
}
async function primeRemoteSkillsCache() {
	try {
		const list = await listNodePairing();
		let sawMac = false;
		for (const node of list.paired) {
			upsertNode({
				nodeId: node.nodeId,
				displayName: node.displayName,
				platform: node.platform,
				deviceFamily: node.deviceFamily,
				commands: node.commands,
				remoteIp: node.remoteIp,
				bins: node.bins
			});
			if (isMacPlatform(node.platform, node.deviceFamily) && supportsSystemRun(node.commands)) sawMac = true;
		}
		if (sawMac) bumpSkillsSnapshotVersion({ reason: "remote-node" });
	} catch (err) {
		log.warn(`failed to prime remote skills cache: ${String(err)}`);
	}
}
function recordRemoteNodeInfo(node) {
	upsertNode(node);
}
function recordRemoteNodeBins(nodeId, bins) {
	upsertNode({
		nodeId,
		bins
	});
}
function removeRemoteNodeInfo(nodeId) {
	remoteNodes.delete(nodeId);
}
function collectRequiredBins(entries, targetPlatform) {
	const bins = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		const os = entry.metadata?.os ?? [];
		if (os.length > 0 && !os.includes(targetPlatform)) continue;
		const required = entry.metadata?.requires?.bins ?? [];
		const anyBins = entry.metadata?.requires?.anyBins ?? [];
		for (const bin of required) if (bin.trim()) bins.add(bin.trim());
		for (const bin of anyBins) if (bin.trim()) bins.add(bin.trim());
	}
	return [...bins];
}
function buildBinProbeScript(bins) {
	return `for b in ${bins.map((bin) => `'${bin.replace(/'/g, `'\\''`)}'`).join(" ")}; do if command -v "$b" >/dev/null 2>&1; then echo "$b"; fi; done`;
}
function parseBinProbePayload(payloadJSON, payload) {
	if (!payloadJSON && !payload) return [];
	try {
		const parsed = payloadJSON ? JSON.parse(payloadJSON) : payload;
		if (Array.isArray(parsed.bins)) return parsed.bins.map((bin) => String(bin).trim()).filter(Boolean);
		if (typeof parsed.stdout === "string") return parsed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	} catch {
		return [];
	}
	return [];
}
function areBinSetsEqual(a, b) {
	if (!a) return false;
	if (a.size !== b.size) return false;
	for (const bin of b) if (!a.has(bin)) return false;
	return true;
}
async function refreshRemoteNodeBins(params) {
	if (!remoteRegistry) return;
	if (!isMacPlatform(params.platform, params.deviceFamily)) return;
	const canWhich = supportsSystemWhich(params.commands);
	const canRun = supportsSystemRun(params.commands);
	if (!canWhich && !canRun) return;
	const workspaceDirs = listAgentWorkspaceDirs(params.cfg);
	const requiredBins = /* @__PURE__ */ new Set();
	for (const workspaceDir of workspaceDirs) {
		const entries = loadWorkspaceSkillEntries(workspaceDir, { config: params.cfg });
		for (const bin of collectRequiredBins(entries, "darwin")) requiredBins.add(bin);
	}
	if (requiredBins.size === 0) return;
	try {
		const binsList = [...requiredBins];
		const res = await remoteRegistry.invoke(canWhich ? {
			nodeId: params.nodeId,
			command: "system.which",
			params: { bins: binsList },
			timeoutMs: params.timeoutMs ?? 15e3
		} : {
			nodeId: params.nodeId,
			command: "system.run",
			params: { command: [
				"/bin/sh",
				"-lc",
				buildBinProbeScript(binsList)
			] },
			timeoutMs: params.timeoutMs ?? 15e3
		});
		if (!res.ok) {
			logRemoteBinProbeFailure(params.nodeId, res.error?.message ?? "unknown");
			return;
		}
		const bins = parseBinProbePayload(res.payloadJSON, res.payload);
		const existingBins = remoteNodes.get(params.nodeId)?.bins;
		const hasChanged = !areBinSetsEqual(existingBins, new Set(bins));
		recordRemoteNodeBins(params.nodeId, bins);
		if (!hasChanged) return;
		await updatePairedNodeMetadata(params.nodeId, { bins });
		bumpSkillsSnapshotVersion({ reason: "remote-node" });
	} catch (err) {
		logRemoteBinProbeFailure(params.nodeId, err);
	}
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
async function refreshRemoteBinsForConnectedNodes(cfg) {
	if (!remoteRegistry) return;
	const connected = remoteRegistry.listConnected();
	for (const node of connected) await refreshRemoteNodeBins({
		nodeId: node.nodeId,
		platform: node.platform,
		deviceFamily: node.deviceFamily,
		commands: node.commands,
		cfg
	});
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
		if (!fs.existsSync(workspaceDir)) continue;
		const canonicalDir = fs.realpathSync(workspaceDir);
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
export { registerSkillsChangeListener as S, requestNodePairing as _, skill_commands_exports as a, ensureSkillsWatcher as b, recordRemoteNodeInfo as c, removeRemoteNodeInfo as d, setSkillsRemoteRegistry as f, renamePairedNode as g, rejectNodePairing as h, resolveSkillCommandInvocation as i, refreshRemoteBinsForConnectedNodes as l, listNodePairing as m, listSkillCommandsForAgents as n, getRemoteSkillEligibility as o, approveNodePairing as p, listSkillCommandsForWorkspace as r, primeRemoteSkillsCache as s, listReservedChatSlashCommandNames as t, refreshRemoteNodeBins as u, updatePairedNodeMetadata as v, getSkillsSnapshotVersion as x, verifyNodeToken as y };