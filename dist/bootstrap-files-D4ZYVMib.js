import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { v as resolveSessionAgentIds } from "./agent-scope-CtLXGcWm.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-DpfQDjis.js";
import { f as isWorkspaceSetupCompleted, h as loadWorkspaceBootstrapFiles, n as DEFAULT_BOOTSTRAP_FILENAME, r as DEFAULT_HEARTBEAT_FILENAME, u as filterBootstrapFilesForSession } from "./workspace-DTx8zuCN.js";
import { r as getOrLoadBootstrapFiles } from "./bootstrap-cache-ClkciH8b.js";
import { n as shouldIncludeHeartbeatGuidanceForSystemPrompt } from "./heartbeat-system-prompt-CGMC07RM.js";
import { _ as resolveBootstrapMaxChars, h as buildBootstrapContextFiles, y as resolveBootstrapTotalMaxChars } from "./pi-embedded-helpers-bmljPI1n.js";
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
//#region src/agents/bootstrap-files.ts
const CONTINUATION_SCAN_MAX_TAIL_BYTES = 256 * 1024;
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
function resolveContextInjectionMode(config, agentId) {
	const agentMode = config && agentId ? resolveAgentConfig(config, agentId)?.contextInjection : void 0;
	if (agentMode === "always" || agentMode === "continuation-skip" || agentMode === "never") return agentMode;
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
			const records = text.split(/\r?\n/u).filter((line) => line.trim().length > 0).slice(-500);
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
	const workspaceRoot = resolveUserPath(workspaceDir);
	const seenPaths = /* @__PURE__ */ new Set();
	const sanitized = [];
	for (const file of files) {
		const pathValue = normalizeOptionalString(file.path) ?? "";
		if (!pathValue) {
			warn?.(`skipping bootstrap file "${file.name}" — missing or invalid "path" field (hook may have used "filePath" instead)`);
			continue;
		}
		const resolvedPath = path.isAbsolute(pathValue) ? path.resolve(pathValue) : pathValue.startsWith("~") ? resolveUserPath(pathValue) : path.resolve(workspaceRoot, pathValue);
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
function filterCompletedWorkspaceBootstrapFile(files, setupCompleted, workspaceDir) {
	if (!setupCompleted) return files;
	const workspaceRoot = resolveUserPath(workspaceDir);
	const rootBootstrapPath = path.join(workspaceRoot, DEFAULT_BOOTSTRAP_FILENAME);
	return files.filter((file) => {
		if (file.name !== "BOOTSTRAP.md") return true;
		const pathValue = normalizeOptionalString(file.path);
		if (!pathValue) return true;
		return (path.isAbsolute(pathValue) ? path.resolve(pathValue) : pathValue.startsWith("~") ? resolveUserPath(pathValue) : path.resolve(workspaceRoot, pathValue)) !== rootBootstrapPath;
	});
}
async function isWorkspaceSetupCompletedForContext(workspaceDir) {
	try {
		return await isWorkspaceSetupCompleted(workspaceDir);
	} catch {
		return false;
	}
}
async function resolveBootstrapFilesForRun(params) {
	const excludeHeartbeatBootstrapFile = shouldExcludeHeartbeatBootstrapFile(params);
	const sessionKey = params.sessionKey ?? params.sessionId;
	const workspaceSetupCompleted = await isWorkspaceSetupCompletedForContext(params.workspaceDir);
	return sanitizeBootstrapFiles(filterHeartbeatBootstrapFile(filterCompletedWorkspaceBootstrapFile(await applyBootstrapHookOverrides({
		files: applyContextModeFilter({
			files: filterCompletedWorkspaceBootstrapFile(filterBootstrapFilesForSession(params.sessionKey ? await getOrLoadBootstrapFiles({
				workspaceDir: params.workspaceDir,
				sessionKey: params.sessionKey
			}) : await loadWorkspaceBootstrapFiles(params.workspaceDir), sessionKey), workspaceSetupCompleted, params.workspaceDir),
			contextMode: params.contextMode,
			runKind: params.runKind
		}),
		workspaceDir: params.workspaceDir,
		config: params.config,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		agentId: params.agentId
	}), workspaceSetupCompleted, params.workspaceDir), excludeHeartbeatBootstrapFile), params.workspaceDir, params.warn);
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
		maxChars: resolveBootstrapMaxChars(params.config, params.agentId),
		totalMaxChars: resolveBootstrapTotalMaxChars(params.config, params.agentId),
		warn: params.warn
	});
}
//#endregion
export { resolveBootstrapContextForRun as a, makeBootstrapWarn as i, buildBootstrapContextForFiles as n, resolveBootstrapFilesForRun as o, hasCompletedBootstrapTurn as r, resolveContextInjectionMode as s, FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE as t };
