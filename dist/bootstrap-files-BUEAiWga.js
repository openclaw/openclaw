import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { c as normalizeAgentId, u as resolveAgentIdFromSessionKey } from "./session-key-DFEyR49L.js";
import { c as resolveDefaultAgentId, r as resolveAgentConfig, t as listAgentEntries } from "./agent-scope-config-26EcJVc0.js";
import { m as resolveSessionAgentIds } from "./agent-scope-C1Fl7gAf.js";
import { t as parseDurationMs } from "./parse-duration-961Oqdwr.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-C8Y435Ix.js";
import { c as resolveHeartbeatPrompt } from "./heartbeat-DJ4ZZ8Yg.js";
import { h as loadWorkspaceBootstrapFiles, r as DEFAULT_HEARTBEAT_FILENAME, u as filterBootstrapFilesForSession } from "./workspace-BNTZ_9-b.js";
import { r as getOrLoadBootstrapFiles } from "./bootstrap-cache-BfWtGzmv.js";
import { d as buildBootstrapContextFiles, h as resolveBootstrapTotalMaxChars, p as resolveBootstrapMaxChars } from "./pi-embedded-helpers-CVGWGeIq.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/agents/bootstrap-hooks.ts
async function applyBootstrapHookOverrides(params) {
	const sessionKey = params.sessionKey ?? params.sessionId ?? "unknown";
	const agentId = params.agentId ?? (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : void 0);
	const event = createInternalHookEvent("agent", "bootstrap", sessionKey, {
		workspaceDir: params.workspaceDir,
		bootstrapFiles: params.files,
		cfg: params.config,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		agentId
	});
	await triggerInternalHook(event);
	const updated = event.context.bootstrapFiles;
	return Array.isArray(updated) ? updated : params.files;
}
//#endregion
//#region src/agents/heartbeat-system-prompt.ts
function resolveHeartbeatConfigForSystemPrompt(config, agentId) {
	const defaults = config?.agents?.defaults?.heartbeat;
	if (!config || !agentId) return defaults;
	const overrides = resolveAgentConfig(config, agentId)?.heartbeat;
	if (!defaults && !overrides) return overrides;
	return {
		...defaults,
		...overrides
	};
}
function isHeartbeatEnabledByAgentPolicy(config, agentId) {
	const resolvedAgentId = normalizeAgentId(agentId);
	const agents = listAgentEntries(config);
	if (agents.some((entry) => Boolean(entry?.heartbeat))) return agents.some((entry) => Boolean(entry?.heartbeat) && normalizeAgentId(entry.id) === resolvedAgentId);
	return resolvedAgentId === resolveDefaultAgentId(config);
}
function isHeartbeatCadenceEnabled(heartbeat) {
	const trimmedEvery = normalizeOptionalString(heartbeat?.every ?? "30m") ?? "";
	if (!trimmedEvery) return false;
	try {
		return parseDurationMs(trimmedEvery, { defaultUnit: "m" }) > 0;
	} catch {
		return false;
	}
}
function shouldIncludeHeartbeatGuidanceForSystemPrompt(params) {
	const defaultAgentId = params.defaultAgentId ?? resolveDefaultAgentId(params.config ?? {});
	const agentId = params.agentId ?? defaultAgentId;
	if (!agentId || normalizeAgentId(agentId) !== normalizeAgentId(defaultAgentId)) return false;
	if (params.config && !isHeartbeatEnabledByAgentPolicy(params.config, agentId)) return false;
	const heartbeat = resolveHeartbeatConfigForSystemPrompt(params.config, agentId);
	if (heartbeat?.includeSystemPromptSection === false) return false;
	return isHeartbeatCadenceEnabled(heartbeat);
}
function resolveHeartbeatPromptForSystemPrompt(params) {
	const agentId = params.agentId ?? params.defaultAgentId ?? resolveDefaultAgentId(params.config ?? {});
	const heartbeat = resolveHeartbeatConfigForSystemPrompt(params.config, agentId);
	if (!shouldIncludeHeartbeatGuidanceForSystemPrompt(params)) return;
	return resolveHeartbeatPrompt(heartbeat?.prompt);
}
//#endregion
//#region src/agents/bootstrap-files.ts
const CONTINUATION_SCAN_MAX_TAIL_BYTES = 256 * 1024;
const CONTINUATION_SCAN_MAX_RECORDS = 500;
const FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE = "openclaw:bootstrap-context:full";
const BOOTSTRAP_WARNING_DEDUPE_LIMIT = 1024;
const seenBootstrapWarnings = /* @__PURE__ */ new Set();
const bootstrapWarningOrder = [];
function rememberBootstrapWarning(key) {
	if (seenBootstrapWarnings.has(key)) return false;
	if (seenBootstrapWarnings.size >= BOOTSTRAP_WARNING_DEDUPE_LIMIT) {
		const oldest = bootstrapWarningOrder.shift();
		if (oldest) seenBootstrapWarnings.delete(oldest);
	}
	seenBootstrapWarnings.add(key);
	bootstrapWarningOrder.push(key);
	return true;
}
function resolveContextInjectionMode(config) {
	return config?.agents?.defaults?.contextInjection ?? "always";
}
async function hasCompletedBootstrapTurn(sessionFile) {
	try {
		const stat = await fs.lstat(sessionFile);
		if (stat.isSymbolicLink()) return false;
		const fh = await fs.open(sessionFile, "r");
		try {
			const bytesToRead = Math.min(stat.size, CONTINUATION_SCAN_MAX_TAIL_BYTES);
			if (bytesToRead <= 0) return false;
			const start = stat.size - bytesToRead;
			const buffer = Buffer.allocUnsafe(bytesToRead);
			const { bytesRead } = await fh.read(buffer, 0, bytesToRead, start);
			let text = buffer.toString("utf-8", 0, bytesRead);
			if (start > 0) {
				const firstNewline = text.indexOf("\n");
				if (firstNewline === -1) return false;
				text = text.slice(firstNewline + 1);
			}
			const records = text.split(/\r?\n/u).filter((line) => line.trim().length > 0).slice(-CONTINUATION_SCAN_MAX_RECORDS);
			let compactedAfterLatestAssistant = false;
			for (let i = records.length - 1; i >= 0; i--) {
				const line = records[i];
				if (!line) continue;
				let entry;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				const record = entry;
				if (record?.type === "compaction") {
					compactedAfterLatestAssistant = true;
					continue;
				}
				if (record?.type === "custom" && record.customType === "openclaw:bootstrap-context:full") return !compactedAfterLatestAssistant;
			}
			return false;
		} finally {
			await fh.close();
		}
	} catch {
		return false;
	}
}
function makeBootstrapWarn(params) {
	const warn = params.warn;
	if (!warn) return;
	const workspacePrefix = params.workspaceDir ?? "";
	return (message) => {
		if (!rememberBootstrapWarning(`${workspacePrefix}\u0000${params.sessionLabel}\u0000${message}`)) return;
		warn(`${message} (sessionKey=${params.sessionLabel})`);
	};
}
function sanitizeBootstrapFiles(files, workspaceDir, warn) {
	const workspaceRoot = path.resolve(workspaceDir);
	const seenPaths = /* @__PURE__ */ new Set();
	const sanitized = [];
	for (const file of files) {
		const pathValue = normalizeOptionalString(file.path) ?? "";
		if (!pathValue) {
			warn?.(`skipping bootstrap file "${file.name}" — missing or invalid "path" field (hook may have used "filePath" instead)`);
			continue;
		}
		const resolvedPath = path.isAbsolute(pathValue) ? path.resolve(pathValue) : path.resolve(workspaceRoot, pathValue);
		const dedupeKey = path.normalize(path.relative(workspaceRoot, resolvedPath));
		if (seenPaths.has(dedupeKey)) continue;
		seenPaths.add(dedupeKey);
		sanitized.push({
			...file,
			path: resolvedPath
		});
	}
	return sanitized;
}
function applyContextModeFilter(params) {
	const contextMode = params.contextMode ?? "full";
	const runKind = params.runKind ?? "default";
	if (contextMode !== "lightweight") return params.files;
	if (runKind === "heartbeat") return params.files.filter((file) => file.name === "HEARTBEAT.md");
	return [];
}
function shouldExcludeHeartbeatBootstrapFile(params) {
	if (!params.config || params.runKind === "heartbeat") return false;
	const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
		sessionKey: params.sessionKey ?? params.sessionId,
		config: params.config,
		agentId: params.agentId
	});
	if (sessionAgentId !== defaultAgentId) return false;
	return !shouldIncludeHeartbeatGuidanceForSystemPrompt({
		config: params.config,
		agentId: sessionAgentId,
		defaultAgentId
	});
}
function filterHeartbeatBootstrapFile(files, excludeHeartbeatBootstrapFile) {
	if (!excludeHeartbeatBootstrapFile) return files;
	return files.filter((file) => file.name !== DEFAULT_HEARTBEAT_FILENAME);
}
async function resolveBootstrapFilesForRun(params) {
	const excludeHeartbeatBootstrapFile = shouldExcludeHeartbeatBootstrapFile(params);
	const sessionKey = params.sessionKey ?? params.sessionId;
	return sanitizeBootstrapFiles(filterHeartbeatBootstrapFile(await applyBootstrapHookOverrides({
		files: applyContextModeFilter({
			files: filterBootstrapFilesForSession(params.sessionKey ? await getOrLoadBootstrapFiles({
				workspaceDir: params.workspaceDir,
				sessionKey: params.sessionKey
			}) : await loadWorkspaceBootstrapFiles(params.workspaceDir), sessionKey),
			contextMode: params.contextMode,
			runKind: params.runKind
		}),
		workspaceDir: params.workspaceDir,
		config: params.config,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		agentId: params.agentId
	}), excludeHeartbeatBootstrapFile), params.workspaceDir, params.warn);
}
async function resolveBootstrapContextForRun(params) {
	const bootstrapFiles = await resolveBootstrapFilesForRun(params);
	return {
		bootstrapFiles,
		contextFiles: buildBootstrapContextForFiles(bootstrapFiles, params)
	};
}
function buildBootstrapContextForFiles(bootstrapFiles, params) {
	return buildBootstrapContextFiles(bootstrapFiles, {
		maxChars: resolveBootstrapMaxChars(params.config),
		totalMaxChars: resolveBootstrapTotalMaxChars(params.config),
		warn: params.warn
	});
}
//#endregion
export { resolveBootstrapContextForRun as a, resolveHeartbeatPromptForSystemPrompt as c, makeBootstrapWarn as i, buildBootstrapContextForFiles as n, resolveBootstrapFilesForRun as o, hasCompletedBootstrapTurn as r, resolveContextInjectionMode as s, FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE as t };
