import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-ixwfrboQ.js";
import "./fs-safe-D4r8mUJk.js";
import { t as appendRegularFile } from "./regular-file-6GdZVPgG.js";
import { t as privateFileStore } from "./private-file-store-9NwvLNnb.js";
import { a as resolveContextEngineOwnerPluginId } from "./registry-2sJBjayk.js";
import { t as emitSessionTranscriptUpdate } from "./transcript-events-Pp-VxfGB.js";
import { c as resolveSessionWriteLockAcquireTimeoutMs, r as acquireSessionWriteLock } from "./session-write-lock-DAM7teg5.js";
import { n as sleepWithAbort } from "./backoff-DBWKeC_y.js";
import { c as getQueueSize, i as enqueueCommandInLane } from "./command-queue-B_ee8LAq.js";
import { r as resolveContextEngineCapabilities } from "./compaction-runtime-context-BILQTCG8.js";
import { t as log } from "./logger-drL4w85E.js";
import { n as findActiveSessionTask } from "./session-async-task-status-BBOMQvZ2.js";
import { a as failTaskRunByRunId, c as recordTaskRunProgressByRunId, l as setDetachedTaskDeliveryStatusByRunId, n as completeTaskRunByRunId, r as createQueuedTaskRun, u as startTaskRunByRunId } from "./detached-task-runtime-DDLnCAuC.js";
import { r as resolveSessionLane } from "./lanes-CW-KJnxG.js";
import { c as updateTaskNotifyPolicyForOwner, i as findTaskByRunIdForOwner, n as cancelTaskByIdForOwner } from "./task-owner-access-CFzY2eTA.js";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CURRENT_SESSION_VERSION, buildSessionContext, migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
//#region src/agents/pi-embedded-runner/transcript-file-state.ts
function isSessionEntry(entry) {
	return entry.type !== "session";
}
function sessionHeaderVersion(header) {
	return typeof header?.version === "number" ? header.version : 1;
}
function generateEntryId(byId) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	return randomUUID();
}
function serializeTranscriptFileEntries(entries) {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
var TranscriptFileState = class {
	constructor(params) {
		this.byId = /* @__PURE__ */ new Map();
		this.labelsById = /* @__PURE__ */ new Map();
		this.labelTimestampsById = /* @__PURE__ */ new Map();
		this.leafId = null;
		this.header = params.header;
		this.entries = [...params.entries];
		this.migrated = params.migrated === true;
		this.rebuildIndex();
	}
	rebuildIndex() {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		for (const entry of this.entries) {
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
			if (entry.type === "label") if (entry.label) {
				this.labelsById.set(entry.targetId, entry.label);
				this.labelTimestampsById.set(entry.targetId, entry.timestamp);
			} else {
				this.labelsById.delete(entry.targetId);
				this.labelTimestampsById.delete(entry.targetId);
			}
		}
	}
	getCwd() {
		return this.header?.cwd ?? process.cwd();
	}
	getHeader() {
		return this.header;
	}
	getEntries() {
		return [...this.entries];
	}
	getLeafId() {
		return this.leafId;
	}
	getLeafEntry() {
		return this.leafId ? this.byId.get(this.leafId) : void 0;
	}
	getLabel(id) {
		return this.labelsById.get(id);
	}
	getBranch(fromId) {
		const branch = [];
		let current = fromId ?? this.leafId ? this.byId.get(fromId ?? this.leafId) : void 0;
		while (current) {
			branch.push(current);
			current = current.parentId ? this.byId.get(current.parentId) : void 0;
		}
		branch.reverse();
		return branch;
	}
	buildSessionContext() {
		return buildSessionContext(this.entries, this.leafId, this.byId);
	}
	branch(branchFromId) {
		if (!this.byId.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		this.leafId = branchFromId;
	}
	resetLeaf() {
		this.leafId = null;
	}
	appendMessage(message) {
		return this.appendEntry({
			type: "message",
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			message
		});
	}
	appendThinkingLevelChange(thinkingLevel) {
		return this.appendEntry({
			type: "thinking_level_change",
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			thinkingLevel
		});
	}
	appendModelChange(provider, modelId) {
		return this.appendEntry({
			type: "model_change",
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			provider,
			modelId
		});
	}
	appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook) {
		return this.appendEntry({
			type: "compaction",
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook
		});
	}
	appendCustomEntry(customType, data) {
		return this.appendEntry({
			type: "custom",
			customType,
			data,
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: (/* @__PURE__ */ new Date()).toISOString()
		});
	}
	appendSessionInfo(name) {
		return this.appendEntry({
			type: "session_info",
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			name: name.trim()
		});
	}
	appendCustomMessageEntry(customType, content, display, details) {
		return this.appendEntry({
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: (/* @__PURE__ */ new Date()).toISOString()
		});
	}
	appendLabelChange(targetId, label) {
		if (!this.byId.has(targetId)) throw new Error(`Entry ${targetId} not found`);
		return this.appendEntry({
			type: "label",
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			targetId,
			label
		});
	}
	branchWithSummary(branchFromId, summary, details, fromHook) {
		if (branchFromId !== null && !this.byId.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		this.leafId = branchFromId;
		return this.appendEntry({
			type: "branch_summary",
			id: generateEntryId(this.byId),
			parentId: branchFromId,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromHook
		});
	}
	appendEntry(entry) {
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		if (entry.type === "label") if (entry.label) {
			this.labelsById.set(entry.targetId, entry.label);
			this.labelTimestampsById.set(entry.targetId, entry.timestamp);
		} else {
			this.labelsById.delete(entry.targetId);
			this.labelTimestampsById.delete(entry.targetId);
		}
		return entry;
	}
};
async function readTranscriptFileState(sessionFile) {
	const fileEntries = parseSessionEntries(await fs.readFile(sessionFile, "utf-8"));
	const migrated = sessionHeaderVersion(fileEntries.find((entry) => entry.type === "session") ?? null) < CURRENT_SESSION_VERSION;
	migrateSessionEntries(fileEntries);
	return new TranscriptFileState({
		header: fileEntries.find((entry) => entry.type === "session") ?? null,
		entries: fileEntries.filter(isSessionEntry),
		migrated
	});
}
async function writeTranscriptFileAtomic(filePath, entries) {
	await privateFileStore(path.dirname(filePath)).writeText(path.basename(filePath), serializeTranscriptFileEntries(entries));
}
async function persistTranscriptStateMutation(params) {
	if (params.appendedEntries.length === 0 && !params.state.migrated) return;
	if (params.state.migrated) {
		await writeTranscriptFileAtomic(params.sessionFile, [...params.state.header ? [params.state.header] : [], ...params.state.entries]);
		return;
	}
	await appendRegularFile({
		filePath: params.sessionFile,
		content: `${params.appendedEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		rejectSymlinkParents: true
	});
}
//#endregion
//#region src/agents/session-raw-append-message.ts
const RAW_APPEND_MESSAGE = Symbol("openclaw.session.rawAppendMessage");
/**
* Return the unguarded appendMessage implementation for a session manager.
*/
function getRawSessionAppendMessage(sessionManager) {
	return sessionManager[RAW_APPEND_MESSAGE] ?? sessionManager.appendMessage.bind(sessionManager);
}
function setRawSessionAppendMessage(sessionManager, appendMessage) {
	sessionManager[RAW_APPEND_MESSAGE] = appendMessage;
}
//#endregion
//#region src/agents/pi-embedded-runner/transcript-rewrite.ts
function estimateMessageBytes(message) {
	return Buffer.byteLength(JSON.stringify(message), "utf8");
}
function remapEntryId(entryId, rewrittenEntryIds) {
	if (!entryId) return null;
	return rewrittenEntryIds.get(entryId) ?? entryId;
}
function appendBranchEntry(params) {
	const { sessionManager, entry, rewrittenEntryIds, appendMessage } = params;
	if (entry.type === "message") return appendMessage(entry.message);
	if (entry.type === "compaction") return sessionManager.appendCompaction(entry.summary, remapEntryId(entry.firstKeptEntryId, rewrittenEntryIds) ?? entry.firstKeptEntryId, entry.tokensBefore, entry.details, entry.fromHook);
	if (entry.type === "thinking_level_change") return sessionManager.appendThinkingLevelChange(entry.thinkingLevel);
	if (entry.type === "model_change") return sessionManager.appendModelChange(entry.provider, entry.modelId);
	if (entry.type === "custom") return sessionManager.appendCustomEntry(entry.customType, entry.data);
	if (entry.type === "custom_message") return sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
	if (entry.type === "session_info") {
		if (entry.name) return sessionManager.appendSessionInfo(entry.name);
		return sessionManager.appendSessionInfo("");
	}
	if (entry.type === "branch_summary") return sessionManager.branchWithSummary(remapEntryId(entry.parentId, rewrittenEntryIds), entry.summary, entry.details, entry.fromHook);
	return sessionManager.appendLabelChange(remapEntryId(entry.targetId, rewrittenEntryIds) ?? entry.targetId, entry.label);
}
function appendTranscriptStateBranchEntry(params) {
	const { state, entry, rewrittenEntryIds } = params;
	if (entry.type === "message") return state.appendMessage(entry.message);
	if (entry.type === "compaction") return state.appendCompaction(entry.summary, remapEntryId(entry.firstKeptEntryId, rewrittenEntryIds) ?? entry.firstKeptEntryId, entry.tokensBefore, entry.details, entry.fromHook);
	if (entry.type === "thinking_level_change") return state.appendThinkingLevelChange(entry.thinkingLevel);
	if (entry.type === "model_change") return state.appendModelChange(entry.provider, entry.modelId);
	if (entry.type === "custom") return state.appendCustomEntry(entry.customType, entry.data);
	if (entry.type === "custom_message") return state.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
	if (entry.type === "session_info") return state.appendSessionInfo(entry.name ?? "");
	if (entry.type === "branch_summary") return state.branchWithSummary(remapEntryId(entry.parentId, rewrittenEntryIds), entry.summary, entry.details, entry.fromHook);
	return state.appendLabelChange(remapEntryId(entry.targetId, rewrittenEntryIds) ?? entry.targetId, entry.label);
}
/**
* Safely rewrites transcript message entries on the active branch by branching
* from the first rewritten message's parent and re-appending the suffix.
*/
function rewriteTranscriptEntriesInSessionManager(params) {
	const replacementsById = new Map(params.replacements.filter((replacement) => replacement.entryId.trim().length > 0).map((replacement) => [replacement.entryId, replacement.message]));
	if (replacementsById.size === 0) return {
		changed: false,
		bytesFreed: 0,
		rewrittenEntries: 0,
		reason: "no replacements requested"
	};
	const branch = params.sessionManager.getBranch();
	if (branch.length === 0) return {
		changed: false,
		bytesFreed: 0,
		rewrittenEntries: 0,
		reason: "empty session"
	};
	const matchedIndices = [];
	let bytesFreed = 0;
	for (let index = 0; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const replacement = replacementsById.get(entry.id);
		if (!replacement) continue;
		const originalBytes = estimateMessageBytes(entry.message);
		const replacementBytes = estimateMessageBytes(replacement);
		matchedIndices.push(index);
		bytesFreed += Math.max(0, originalBytes - replacementBytes);
	}
	if (matchedIndices.length === 0) return {
		changed: false,
		bytesFreed: 0,
		rewrittenEntries: 0,
		reason: "no matching message entries"
	};
	const firstMatchedEntry = branch[matchedIndices[0]];
	if (!firstMatchedEntry) return {
		changed: false,
		bytesFreed: 0,
		rewrittenEntries: 0,
		reason: "invalid first rewrite target"
	};
	if (!firstMatchedEntry.parentId) params.sessionManager.resetLeaf();
	else params.sessionManager.branch(firstMatchedEntry.parentId);
	const appendMessage = getRawSessionAppendMessage(params.sessionManager);
	const rewrittenEntryIds = /* @__PURE__ */ new Map();
	for (let index = matchedIndices[0]; index < branch.length; index++) {
		const entry = branch[index];
		const replacement = entry.type === "message" ? replacementsById.get(entry.id) : void 0;
		const newEntryId = replacement === void 0 ? appendBranchEntry({
			sessionManager: params.sessionManager,
			entry,
			rewrittenEntryIds,
			appendMessage
		}) : appendMessage(replacement);
		rewrittenEntryIds.set(entry.id, newEntryId);
	}
	return {
		changed: true,
		bytesFreed,
		rewrittenEntries: matchedIndices.length
	};
}
function rewriteTranscriptEntriesInState(params) {
	const replacementsById = new Map(params.replacements.filter((replacement) => replacement.entryId.trim().length > 0).map((replacement) => [replacement.entryId, replacement.message]));
	if (replacementsById.size === 0) return {
		changed: false,
		bytesFreed: 0,
		rewrittenEntries: 0,
		reason: "no replacements requested",
		appendedEntries: []
	};
	const branch = params.state.getBranch();
	if (branch.length === 0) return {
		changed: false,
		bytesFreed: 0,
		rewrittenEntries: 0,
		reason: "empty session",
		appendedEntries: []
	};
	const matchedIndices = [];
	let bytesFreed = 0;
	for (let index = 0; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const replacement = replacementsById.get(entry.id);
		if (!replacement) continue;
		const originalBytes = estimateMessageBytes(entry.message);
		const replacementBytes = estimateMessageBytes(replacement);
		matchedIndices.push(index);
		bytesFreed += Math.max(0, originalBytes - replacementBytes);
	}
	if (matchedIndices.length === 0) return {
		changed: false,
		bytesFreed: 0,
		rewrittenEntries: 0,
		reason: "no matching message entries",
		appendedEntries: []
	};
	const firstMatchedEntry = branch[matchedIndices[0]];
	if (!firstMatchedEntry) return {
		changed: false,
		bytesFreed: 0,
		rewrittenEntries: 0,
		reason: "invalid first rewrite target",
		appendedEntries: []
	};
	if (!firstMatchedEntry.parentId) params.state.resetLeaf();
	else params.state.branch(firstMatchedEntry.parentId);
	const appendedEntries = [];
	const rewrittenEntryIds = /* @__PURE__ */ new Map();
	for (let index = matchedIndices[0]; index < branch.length; index++) {
		const entry = branch[index];
		const replacement = entry.type === "message" ? replacementsById.get(entry.id) : void 0;
		const newEntry = replacement === void 0 ? appendTranscriptStateBranchEntry({
			state: params.state,
			entry,
			rewrittenEntryIds
		}) : params.state.appendMessage(replacement);
		rewrittenEntryIds.set(entry.id, newEntry.id);
		appendedEntries.push(newEntry);
	}
	return {
		changed: true,
		bytesFreed,
		rewrittenEntries: matchedIndices.length,
		appendedEntries
	};
}
/**
* Open a transcript file, rewrite message entries on the active branch, and
* emit a transcript update when the active branch changed.
*/
async function rewriteTranscriptEntriesInSessionFile(params) {
	let sessionLock;
	try {
		sessionLock = await acquireSessionWriteLock({
			sessionFile: params.sessionFile,
			timeoutMs: resolveSessionWriteLockAcquireTimeoutMs(params.config)
		});
		const state = await readTranscriptFileState(params.sessionFile);
		const result = rewriteTranscriptEntriesInState({
			state,
			replacements: params.request.replacements
		});
		if (result.changed) {
			await persistTranscriptStateMutation({
				sessionFile: params.sessionFile,
				state,
				appendedEntries: result.appendedEntries
			});
			emitSessionTranscriptUpdate({
				sessionFile: params.sessionFile,
				sessionKey: params.sessionKey
			});
			log.info(`[transcript-rewrite] rewrote ${result.rewrittenEntries} entr${result.rewrittenEntries === 1 ? "y" : "ies"} bytesFreed=${result.bytesFreed} sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`);
		}
		return result;
	} catch (err) {
		const reason = formatErrorMessage(err);
		log.warn(`[transcript-rewrite] failed: ${reason}`);
		return {
			changed: false,
			bytesFreed: 0,
			rewrittenEntries: 0,
			reason
		};
	} finally {
		await sessionLock?.release();
	}
}
//#endregion
//#region src/agents/pi-embedded-runner/context-engine-maintenance.ts
const TURN_MAINTENANCE_TASK_KIND = "context_engine_turn_maintenance";
const TURN_MAINTENANCE_TASK_LABEL = "Context engine turn maintenance";
const TURN_MAINTENANCE_TASK_TASK = "Deferred context-engine maintenance after turn.";
const TURN_MAINTENANCE_LANE_PREFIX = "context-engine-turn-maintenance:";
const TURN_MAINTENANCE_WAIT_POLL_MS = 100;
const TURN_MAINTENANCE_LONG_WAIT_MS = 1e4;
const DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY = Symbol.for("openclaw.contextEngineTurnMaintenanceAbortState");
const activeDeferredTurnMaintenanceRuns = /* @__PURE__ */ new Map();
function resolveDeferredTurnMaintenanceAbortState(processLike) {
	const existing = processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY];
	if (existing) return existing;
	const created = {
		registered: false,
		controllers: /* @__PURE__ */ new Set(),
		cleanupHandlers: /* @__PURE__ */ new Map()
	};
	processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY] = created;
	return created;
}
function unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state) {
	if (!state.registered) return;
	for (const [signal, handler] of state.cleanupHandlers) processLike.off(signal, handler);
	state.cleanupHandlers.clear();
	state.registered = false;
}
function normalizeSessionKey(sessionKey) {
	return normalizeOptionalString(sessionKey) || void 0;
}
function resolveDeferredTurnMaintenanceLane(sessionKey) {
	return `${TURN_MAINTENANCE_LANE_PREFIX}${sessionKey}`;
}
function createDeferredTurnMaintenanceAbortSignal(params) {
	if (typeof AbortController === "undefined") return {
		abortSignal: void 0,
		dispose: () => {}
	};
	const processLike = params?.processLike ?? process;
	const state = resolveDeferredTurnMaintenanceAbortState(processLike);
	const handleTerminationSignal = (signalName) => {
		const shouldReraise = typeof processLike.listenerCount === "function" ? processLike.listenerCount(signalName) === 1 : false;
		for (const activeController of state.controllers) if (!activeController.signal.aborted) activeController.abort(/* @__PURE__ */ new Error(`received ${signalName} while waiting for deferred maintenance`));
		state.controllers.clear();
		unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
		if (shouldReraise && typeof processLike.kill === "function") try {
			processLike.kill(processLike.pid ?? process.pid, signalName);
		} catch {}
	};
	if (!state.registered) {
		state.registered = true;
		const onSigint = () => handleTerminationSignal("SIGINT");
		const onSigterm = () => handleTerminationSignal("SIGTERM");
		state.cleanupHandlers.set("SIGINT", onSigint);
		state.cleanupHandlers.set("SIGTERM", onSigterm);
		processLike.on("SIGINT", onSigint);
		processLike.on("SIGTERM", onSigterm);
	}
	const controller = new AbortController();
	state.controllers.add(controller);
	let disposed = false;
	const cleanup = () => {
		if (disposed) return;
		disposed = true;
		state.controllers.delete(controller);
		if (state.controllers.size === 0) unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
	};
	return {
		abortSignal: controller.signal,
		dispose: cleanup
	};
}
function markDeferredTurnMaintenanceTaskScheduleFailure(params) {
	const errorMessage = formatErrorMessage(params.error);
	log.warn(`failed to schedule deferred context engine maintenance: ${errorMessage}`);
	cancelTaskByIdForOwner({
		taskId: params.taskId,
		callerOwnerKey: params.sessionKey,
		endedAt: Date.now(),
		terminalSummary: `Deferred maintenance could not be scheduled: ${errorMessage}`
	});
}
function buildTurnMaintenanceTaskDescriptor(params) {
	const runId = `turn-maint:${params.sessionKey}:${Date.now().toString(36)}:${randomUUID().slice(0, 8)}`;
	return createQueuedTaskRun({
		runtime: "acp",
		taskKind: TURN_MAINTENANCE_TASK_KIND,
		sourceId: TURN_MAINTENANCE_TASK_KIND,
		requesterSessionKey: params.sessionKey,
		ownerKey: params.sessionKey,
		scopeKind: "session",
		runId,
		label: TURN_MAINTENANCE_TASK_LABEL,
		task: TURN_MAINTENANCE_TASK_TASK,
		notifyPolicy: "silent",
		deliveryStatus: "pending",
		preferMetadata: true
	});
}
function promoteTurnMaintenanceTaskVisibility(params) {
	const task = findTaskByRunIdForOwner({
		runId: params.runId,
		callerOwnerKey: params.sessionKey
	});
	if (!task) return createQueuedTaskRun({
		runtime: "acp",
		taskKind: TURN_MAINTENANCE_TASK_KIND,
		sourceId: TURN_MAINTENANCE_TASK_KIND,
		requesterSessionKey: params.sessionKey,
		ownerKey: params.sessionKey,
		scopeKind: "session",
		runId: params.runId,
		label: TURN_MAINTENANCE_TASK_LABEL,
		task: TURN_MAINTENANCE_TASK_TASK,
		notifyPolicy: params.notifyPolicy,
		deliveryStatus: "pending",
		preferMetadata: true
	});
	setDetachedTaskDeliveryStatusByRunId({
		runId: params.runId,
		runtime: "acp",
		sessionKey: params.sessionKey,
		deliveryStatus: "pending"
	});
	if (task.notifyPolicy !== params.notifyPolicy) updateTaskNotifyPolicyForOwner({
		taskId: task.taskId,
		callerOwnerKey: params.sessionKey,
		notifyPolicy: params.notifyPolicy
	});
	return findTaskByRunIdForOwner({
		runId: params.runId,
		callerOwnerKey: params.sessionKey
	}) ?? task;
}
/**
* Attach runtime-owned transcript rewrite helpers to an existing
* context-engine runtime context payload.
*/
function buildContextEngineMaintenanceRuntimeContext(params) {
	return {
		...params.runtimeContext,
		...resolveContextEngineCapabilities({
			config: params.config,
			sessionKey: params.sessionKey,
			agentId: params.agentId,
			contextEnginePluginId: params.contextEnginePluginId,
			purpose: params.purpose ?? "context-engine.maintenance"
		}),
		...params.allowDeferredCompactionExecution ? { allowDeferredCompactionExecution: true } : {},
		rewriteTranscriptEntries: async (request) => {
			if (params.sessionManager) return rewriteTranscriptEntriesInSessionManager({
				sessionManager: params.sessionManager,
				replacements: request.replacements
			});
			const rewriteTranscriptEntriesInFile = async () => await rewriteTranscriptEntriesInSessionFile({
				sessionFile: params.sessionFile,
				sessionId: params.sessionId,
				sessionKey: params.sessionKey,
				config: params.config,
				request
			});
			const rewriteSessionKey = normalizeSessionKey(params.sessionKey ?? params.sessionId);
			if (params.deferTranscriptRewriteToSessionLane && rewriteSessionKey) return await enqueueCommandInLane(resolveSessionLane(rewriteSessionKey), async () => await rewriteTranscriptEntriesInFile());
			return await rewriteTranscriptEntriesInFile();
		}
	};
}
async function executeContextEngineMaintenance(params) {
	if (typeof params.contextEngine.maintain !== "function") return;
	const result = await params.contextEngine.maintain({
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		sessionFile: params.sessionFile,
		runtimeContext: buildContextEngineMaintenanceRuntimeContext({
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			sessionFile: params.sessionFile,
			sessionManager: params.executionMode === "background" ? void 0 : params.sessionManager,
			runtimeContext: params.runtimeContext,
			agentId: params.agentId,
			allowDeferredCompactionExecution: params.executionMode === "background",
			deferTranscriptRewriteToSessionLane: params.executionMode === "background",
			config: params.config,
			purpose: `context-engine.${params.reason}.maintenance`,
			contextEnginePluginId: resolveContextEngineOwnerPluginId(params.contextEngine)
		})
	});
	if (result.changed) log.info(`[context-engine] maintenance(${params.reason}) changed transcript rewrittenEntries=${result.rewrittenEntries} bytesFreed=${result.bytesFreed} sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`);
	return result;
}
async function runDeferredTurnMaintenanceWorker(params) {
	let surfacedUserNotice = false;
	let longRunningTimer = null;
	const shutdownAbort = createDeferredTurnMaintenanceAbortSignal();
	const surfaceMaintenanceUpdate = (summary, eventSummary) => {
		promoteTurnMaintenanceTaskVisibility({
			sessionKey: params.sessionKey,
			runId: params.runId,
			notifyPolicy: "state_changes"
		});
		surfacedUserNotice = true;
		recordTaskRunProgressByRunId({
			runId: params.runId,
			runtime: "acp",
			sessionKey: params.sessionKey,
			lastEventAt: Date.now(),
			progressSummary: summary,
			eventSummary
		});
	};
	try {
		const sessionLane = resolveSessionLane(params.sessionKey);
		const startedWaitingAt = Date.now();
		let lastWaitNoticeAt = 0;
		for (;;) {
			while (getQueueSize(sessionLane) > 0) {
				const now = Date.now();
				if (now - startedWaitingAt >= TURN_MAINTENANCE_LONG_WAIT_MS && now - lastWaitNoticeAt >= TURN_MAINTENANCE_LONG_WAIT_MS) {
					lastWaitNoticeAt = now;
					surfaceMaintenanceUpdate("Waiting for the session lane to go idle.", surfacedUserNotice ? "Still waiting for the session lane to go idle." : "Deferred maintenance is waiting for the session lane to go idle.");
				}
				await sleepWithAbort(TURN_MAINTENANCE_WAIT_POLL_MS, shutdownAbort.abortSignal);
			}
			await Promise.resolve();
			if (getQueueSize(sessionLane) === 0) break;
		}
		const runningAt = Date.now();
		startTaskRunByRunId({
			runId: params.runId,
			runtime: "acp",
			sessionKey: params.sessionKey,
			startedAt: runningAt,
			lastEventAt: runningAt,
			progressSummary: "Running deferred maintenance.",
			eventSummary: "Starting deferred maintenance."
		});
		longRunningTimer = setTimeout(() => {
			try {
				surfaceMaintenanceUpdate("Deferred maintenance is still running.", "Deferred maintenance is still running.");
			} catch (error) {
				log.warn(`failed to surface deferred maintenance progress: ${String(error)}`);
			}
		}, TURN_MAINTENANCE_LONG_WAIT_MS);
		const result = await executeContextEngineMaintenance({
			contextEngine: params.contextEngine,
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			sessionFile: params.sessionFile,
			reason: "turn",
			sessionManager: params.sessionManager,
			runtimeContext: params.runtimeContext,
			agentId: params.agentId,
			config: params.config,
			executionMode: "background"
		});
		if (longRunningTimer) {
			clearTimeout(longRunningTimer);
			longRunningTimer = null;
		}
		const endedAt = Date.now();
		completeTaskRunByRunId({
			runId: params.runId,
			runtime: "acp",
			sessionKey: params.sessionKey,
			endedAt,
			lastEventAt: endedAt,
			progressSummary: result?.changed ? "Deferred maintenance completed with transcript changes." : "Deferred maintenance completed.",
			terminalSummary: result?.changed ? `Rewrote ${result.rewrittenEntries} transcript entr${result.rewrittenEntries === 1 ? "y" : "ies"} and freed ${result.bytesFreed} bytes.` : "No transcript changes were needed."
		});
	} catch (err) {
		if (shutdownAbort.abortSignal?.aborted) {
			if (longRunningTimer) {
				clearTimeout(longRunningTimer);
				longRunningTimer = null;
			}
			const task = findTaskByRunIdForOwner({
				runId: params.runId,
				callerOwnerKey: params.sessionKey
			});
			if (task) cancelTaskByIdForOwner({
				taskId: task.taskId,
				callerOwnerKey: params.sessionKey,
				endedAt: Date.now(),
				terminalSummary: "Deferred maintenance cancelled during shutdown."
			});
			return;
		}
		if (longRunningTimer) {
			clearTimeout(longRunningTimer);
			longRunningTimer = null;
		}
		const endedAt = Date.now();
		const reason = formatErrorMessage(err);
		if (!surfacedUserNotice) promoteTurnMaintenanceTaskVisibility({
			sessionKey: params.sessionKey,
			runId: params.runId,
			notifyPolicy: "done_only"
		});
		failTaskRunByRunId({
			runId: params.runId,
			runtime: "acp",
			sessionKey: params.sessionKey,
			endedAt,
			lastEventAt: endedAt,
			error: reason,
			progressSummary: "Deferred maintenance failed.",
			terminalSummary: reason
		});
		log.warn(`deferred context engine maintenance failed: ${reason}`);
	} finally {
		shutdownAbort.dispose();
	}
}
function scheduleDeferredTurnMaintenance(params) {
	const sessionKey = normalizeSessionKey(params.sessionKey);
	if (!sessionKey) return;
	const activeRun = activeDeferredTurnMaintenanceRuns.get(sessionKey);
	if (activeRun) {
		activeRun.rerunRequested = true;
		activeRun.latestParams = {
			...params,
			sessionKey
		};
		return activeRun.promise;
	}
	const existingTask = findActiveSessionTask({
		sessionKey,
		runtime: "acp",
		taskKind: TURN_MAINTENANCE_TASK_KIND
	});
	const reusableTask = existingTask?.runId?.trim() ? existingTask : void 0;
	if (existingTask && !reusableTask) {
		updateTaskNotifyPolicyForOwner({
			taskId: existingTask.taskId,
			callerOwnerKey: sessionKey,
			notifyPolicy: "silent"
		});
		cancelTaskByIdForOwner({
			taskId: existingTask.taskId,
			callerOwnerKey: sessionKey,
			endedAt: Date.now(),
			terminalSummary: "Superseded by refreshed deferred maintenance task."
		});
	}
	const task = reusableTask ?? buildTurnMaintenanceTaskDescriptor({ sessionKey });
	log.info(`[context-engine] deferred turn maintenance ${reusableTask ? "resuming" : "queued"} taskId=${task.taskId} sessionKey=${sessionKey} lane=${resolveDeferredTurnMaintenanceLane(sessionKey)}`);
	const schedulerAbort = createDeferredTurnMaintenanceAbortSignal();
	let runPromise;
	try {
		runPromise = enqueueCommandInLane(resolveDeferredTurnMaintenanceLane(sessionKey), async () => runDeferredTurnMaintenanceWorker({
			contextEngine: params.contextEngine,
			sessionId: params.sessionId,
			sessionKey,
			sessionFile: params.sessionFile,
			sessionManager: params.sessionManager,
			runtimeContext: params.runtimeContext,
			agentId: params.agentId,
			config: params.config,
			runId: task.runId
		}));
	} catch (err) {
		schedulerAbort.dispose();
		markDeferredTurnMaintenanceTaskScheduleFailure({
			sessionKey,
			taskId: task.taskId,
			error: err
		});
		return;
	}
	let state;
	const trackedPromise = runPromise.catch((err) => {
		markDeferredTurnMaintenanceTaskScheduleFailure({
			sessionKey,
			taskId: task.taskId,
			error: err
		});
	}).finally(async () => {
		schedulerAbort.dispose();
		const current = activeDeferredTurnMaintenanceRuns.get(sessionKey);
		if (current !== state) return;
		const shutdownTriggered = schedulerAbort.abortSignal?.aborted === true;
		const rerunParams = current.rerunRequested && !shutdownTriggered ? current.latestParams : void 0;
		activeDeferredTurnMaintenanceRuns.delete(sessionKey);
		if (rerunParams) await scheduleDeferredTurnMaintenance(rerunParams);
	});
	state = {
		promise: trackedPromise,
		rerunRequested: false,
		latestParams: {
			...params,
			sessionKey
		}
	};
	activeDeferredTurnMaintenanceRuns.set(sessionKey, state);
	return trackedPromise;
}
/**
* Run optional context-engine transcript maintenance and normalize the result.
*/
async function runContextEngineMaintenance(params) {
	if (typeof params.contextEngine?.maintain !== "function") return;
	const executionMode = params.executionMode ?? "foreground";
	if (params.reason === "turn" && executionMode !== "background" && params.contextEngine.info.turnMaintenanceMode === "background") {
		try {
			const deferred = scheduleDeferredTurnMaintenance({
				contextEngine: params.contextEngine,
				sessionId: params.sessionId,
				sessionKey: params.sessionKey ?? params.sessionId,
				sessionFile: params.sessionFile,
				sessionManager: params.sessionManager,
				runtimeContext: params.runtimeContext,
				agentId: params.agentId,
				config: params.config
			});
			if (deferred) params.onDeferredMaintenance?.(deferred);
		} catch (err) {
			log.warn(`failed to schedule deferred context engine maintenance: ${String(err)}`);
		}
		return;
	}
	try {
		return await executeContextEngineMaintenance({
			contextEngine: params.contextEngine,
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			sessionFile: params.sessionFile,
			reason: params.reason,
			sessionManager: params.sessionManager,
			runtimeContext: params.runtimeContext,
			agentId: params.agentId,
			executionMode,
			config: params.config
		});
	} catch (err) {
		log.warn(`context engine maintain failed (${params.reason}): ${String(err)}`);
		return;
	}
}
//#endregion
export { getRawSessionAppendMessage as a, persistTranscriptStateMutation as c, rewriteTranscriptEntriesInState as i, readTranscriptFileState as l, rewriteTranscriptEntriesInSessionFile as n, setRawSessionAppendMessage as o, rewriteTranscriptEntriesInSessionManager as r, TranscriptFileState as s, runContextEngineMaintenance as t, writeTranscriptFileAtomic as u };
