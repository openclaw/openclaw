import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import "./fs-safe-CV86zY9G.js";
import { t as appendRegularFile } from "./regular-file-DaVeNX32.js";
import { t as privateFileStore } from "./private-file-store-DMtyjgoc.js";
import { o as resolveContextEngineOwnerPluginId } from "./registry-DxH_0Os-.js";
import { t as emitSessionTranscriptUpdate } from "./transcript-events-ClYG_P1o.js";
import { d as resolveSessionWriteLockOptions, i as acquireSessionWriteLock } from "./session-write-lock-_a5O1H8L.js";
import { d as stripRuntimeContextCustomMessages } from "./internal-runtime-context-DWxvZFcB.js";
import { a as failTaskRunByRunId, c as recordTaskRunProgressByRunId, l as setDetachedTaskDeliveryStatusByRunId, n as completeTaskRunByRunId, r as createQueuedTaskRun, u as startTaskRunByRunId } from "./detached-task-runtime-C79km_82.js";
import { n as sleepWithAbort } from "./backoff-BQ4uO4hX.js";
import { c as getQueueSize, i as enqueueCommandInLane } from "./command-queue-Da2Lh3Ua.js";
import { l as findActiveSessionTask } from "./openclaw-tools-QeySpphx.js";
import { h as resolveContextEngineCapabilities, n as buildAfterTurnRuntimeContextFromUsage, t as buildAfterTurnRuntimeContext } from "./attempt.prompt-helpers-2z-P6Pk8.js";
import { t as log } from "./logger-D2U-uUBZ.js";
import { r as resolveSessionLane } from "./lanes-BrQRlRRS.js";
import { c as updateTaskNotifyPolicyForOwner, i as findTaskByRunIdForOwner, n as cancelTaskByIdForOwner } from "./task-owner-access-MrVYMLx_.js";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CURRENT_SESSION_VERSION, buildSessionContext, migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
//#region src/agents/pi-embedded-runner/transcript-file-state.ts
const sessionEntryTypes = new Set([
	"branch_summary",
	"compaction",
	"custom",
	"custom_message",
	"label",
	"message",
	"model_change",
	"session_info",
	"thinking_level_change"
]);
const repairableToolCallContentTypes = new Set([
	"functionCall",
	"function_call",
	"toolCall",
	"toolUse",
	"tool_call",
	"tool_use"
]);
const invalidJsonlSlotType = "__openclaw_invalid_jsonl_slot";
function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isString(value) {
	return typeof value === "string" && value.trim() !== "";
}
function isOptionalString(value) {
	return value === void 0 || typeof value === "string";
}
function isTextContent(value) {
	return isRecord(value) && value.type === "text" && typeof value.text === "string" && isOptionalString(value.textSignature);
}
function isThinkingContent(value) {
	return isRecord(value) && value.type === "thinking" && typeof value.thinking === "string" && isOptionalString(value.thinkingSignature) && (value.redacted === void 0 || typeof value.redacted === "boolean");
}
function isImageContent(value) {
	return isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";
}
function hasToolCallId(value) {
	return isString(value.id) || isString(value.call_id) || isString(value.toolCallId) || isString(value.toolUseId) || isString(value.tool_call_id) || isString(value.tool_use_id);
}
function isToolCallPayload(value) {
	return value === null || isRecord(value) || typeof value === "string";
}
function isToolCallContent(value) {
	return isRecord(value) && typeof value.type === "string" && repairableToolCallContentTypes.has(value.type) && hasToolCallId(value) && isString(value.name) && (value.arguments === void 0 || isToolCallPayload(value.arguments)) && (value.input === void 0 || isToolCallPayload(value.input)) && isOptionalString(value.thoughtSignature);
}
function isPersistedContentBlock(value) {
	if (!isRecord(value) || !isString(value.type)) return false;
	switch (value.type) {
		case "text": return isTextContent(value);
		case "thinking": return isThinkingContent(value);
		case "image": return isImageContent(value);
		default:
			if (repairableToolCallContentTypes.has(value.type)) return isToolCallContent(value);
			return true;
	}
}
function isUserContent(value) {
	return typeof value === "string" || Array.isArray(value) && value.every((item) => isPersistedContentBlock(item));
}
function isAssistantContent(value) {
	return typeof value === "string" || Array.isArray(value) && value.every((item) => isPersistedContentBlock(item));
}
function isToolResultContent(value) {
	return Array.isArray(value) && value.every((item) => isPersistedContentBlock(item));
}
function isOptionalBoolean(value) {
	return value === void 0 || typeof value === "boolean";
}
function isBashExecutionMessage(value) {
	return isString(value.command) && typeof value.output === "string" && (value.exitCode === void 0 || typeof value.exitCode === "number") && typeof value.cancelled === "boolean" && typeof value.truncated === "boolean" && isOptionalString(value.fullOutputPath) && isOptionalBoolean(value.excludeFromContext);
}
function isAgentMessage(value) {
	if (!isRecord(value)) return false;
	switch (value.role) {
		case "assistant": return isAssistantContent(value.content);
		case "bashExecution": return isBashExecutionMessage(value);
		case "custom": return isString(value.customType) && isUserContent(value.content);
		case "toolResult": return isString(value.toolCallId) && isString(value.toolName) && typeof value.isError === "boolean" && isToolResultContent(value.content);
		case "user": return isUserContent(value.content);
		default: return false;
	}
}
function hasSessionEntryBase(entry) {
	const candidate = entry;
	return isString(candidate.id) && (candidate.parentId === void 0 || candidate.parentId === null || isString(candidate.parentId)) && (candidate.timestamp === void 0 || isString(candidate.timestamp));
}
function isSessionEntry(entry) {
	if (entry.type === "session" || !sessionEntryTypes.has(entry.type) || !hasSessionEntryBase(entry)) return false;
	switch (entry.type) {
		case "branch_summary": {
			const candidate = entry;
			return isString(candidate.fromId) && typeof candidate.summary === "string";
		}
		case "compaction": {
			const candidate = entry;
			return isString(candidate.firstKeptEntryId) && typeof candidate.summary === "string" && typeof candidate.tokensBefore === "number";
		}
		case "custom": return isString(entry.customType);
		case "custom_message": {
			const candidate = entry;
			return isString(candidate.customType) && isUserContent(candidate.content) && typeof candidate.display === "boolean";
		}
		case "label": {
			const candidate = entry;
			return isString(candidate.targetId) && (candidate.label === void 0 || typeof candidate.label === "string");
		}
		case "message": return isAgentMessage(entry.message);
		case "model_change": {
			const candidate = entry;
			return isString(candidate.provider) && isString(candidate.modelId);
		}
		case "session_info": {
			const candidate = entry;
			return candidate.name === void 0 || typeof candidate.name === "string";
		}
		case "thinking_level_change": return isString(entry.thinkingLevel);
	}
	return false;
}
function readableSessionEntries(fileEntries) {
	const entries = [];
	const acceptedIds = /* @__PURE__ */ new Set();
	const acceptedEntryById = /* @__PURE__ */ new Map();
	const rejectedIds = /* @__PURE__ */ new Set();
	const rejectedParentById = /* @__PURE__ */ new Map();
	const firstReadableDescendantByRejectedId = /* @__PURE__ */ new Map();
	const rejectedAncestorsByAcceptedId = /* @__PURE__ */ new Map();
	const acceptedPath = (leafId) => {
		const path = [];
		let id = leafId ?? null;
		const seen = /* @__PURE__ */ new Set();
		while (id !== null) {
			if (seen.has(id)) break;
			seen.add(id);
			const entry = acceptedEntryById.get(id);
			if (!entry) break;
			path.unshift(entry);
			id = entry.parentId;
		}
		return path;
	};
	const firstReadableDescendantOnBranch = (rejectedId, leafId) => {
		for (const entry of acceptedPath(leafId)) if (rejectedAncestorsByAcceptedId.get(entry.id)?.includes(rejectedId)) return entry.id;
	};
	const rejectedParentChain = (parentId) => {
		const chain = [];
		let resolved = parentId ?? null;
		const seen = /* @__PURE__ */ new Set();
		while (resolved !== null && rejectedParentById.has(resolved)) {
			if (seen.has(resolved)) break;
			seen.add(resolved);
			chain.push(resolved);
			resolved = rejectedParentById.get(resolved) ?? null;
		}
		return chain;
	};
	const resolveRejectedParent = (parentId) => {
		let resolved = parentId ?? null;
		const seen = /* @__PURE__ */ new Set();
		while (resolved !== null && rejectedParentById.has(resolved)) {
			if (seen.has(resolved)) return null;
			seen.add(resolved);
			resolved = rejectedParentById.get(resolved) ?? null;
		}
		return resolved;
	};
	const repairEntryLinks = (entry) => {
		const rejectedAncestors = rejectedParentChain(entry.parentId);
		const resolvedRejectedParent = rejectedAncestors.length > 0 ? resolveRejectedParent(entry.parentId) : void 0;
		const parentId = resolvedRejectedParent !== void 0 ? resolvedRejectedParent !== null && acceptedIds.has(resolvedRejectedParent) ? resolvedRejectedParent : null : entry.parentId ?? null;
		let repaired = parentId === entry.parentId ? entry : {
			...entry,
			parentId
		};
		if (repaired.type === "compaction" && rejectedIds.has(repaired.firstKeptEntryId)) {
			const resolvedFirstKeptParent = resolveRejectedParent(repaired.firstKeptEntryId);
			const firstKeptEntryId = (resolvedFirstKeptParent !== null && acceptedIds.has(resolvedFirstKeptParent) ? resolvedFirstKeptParent : void 0) ?? firstReadableDescendantOnBranch(repaired.firstKeptEntryId, parentId) ?? firstReadableDescendantByRejectedId.get(repaired.firstKeptEntryId) ?? parentId;
			if (firstKeptEntryId !== null && firstKeptEntryId !== repaired.firstKeptEntryId) repaired = {
				...repaired,
				firstKeptEntryId
			};
		}
		if (repaired.type !== "compaction") {
			for (const rejectedId of rejectedAncestors) if (!firstReadableDescendantByRejectedId.has(rejectedId)) firstReadableDescendantByRejectedId.set(rejectedId, repaired.id);
			if (rejectedAncestors.length > 0) rejectedAncestorsByAcceptedId.set(repaired.id, rejectedAncestors);
		}
		return repaired;
	};
	for (const rawEntry of fileEntries) {
		if (!isRecord(rawEntry)) continue;
		const entry = rawEntry;
		const id = rawEntry.id;
		if (!isSessionEntry(entry)) {
			if (isString(id)) {
				rejectedIds.add(id);
				const parentId = rawEntry.parentId;
				rejectedParentById.set(id, isString(parentId) ? parentId : null);
			}
			continue;
		}
		if (entry.type === "label" && !acceptedIds.has(entry.targetId)) {
			rejectedIds.add(entry.id);
			rejectedParentById.set(entry.id, entry.parentId);
			continue;
		}
		if (acceptedIds.has(entry.id)) continue;
		const repaired = repairEntryLinks(entry);
		entries.push(repaired);
		acceptedIds.add(repaired.id);
		acceptedEntryById.set(repaired.id, repaired);
	}
	return entries;
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
function fileEntryOrMigrationSlot(value, index) {
	if (isRecord(value)) return value;
	return {
		type: invalidJsonlSlotType,
		id: `__openclaw_invalid_jsonl_slot_${index}`,
		parentId: null,
		timestamp: "1970-01-01T00:00:00.000Z"
	};
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
	const fileEntries = parseSessionEntries(await fs.readFile(sessionFile, "utf-8")).map(fileEntryOrMigrationSlot);
	const migrated = sessionHeaderVersion(fileEntries.find((entry) => entry.type === "session") ?? null) < CURRENT_SESSION_VERSION;
	migrateSessionEntries(fileEntries);
	return new TranscriptFileState({
		header: fileEntries.find((entry) => entry.type === "session") ?? null,
		entries: readableSessionEntries(fileEntries),
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
			...resolveSessionWriteLockOptions(params.config)
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
			if (params.sessionManager) {
				const sessionManager = params.sessionManager;
				const rewriteSessionManagerEntries = () => rewriteTranscriptEntriesInSessionManager({
					sessionManager,
					replacements: request.replacements
				});
				return params.withSessionManagerRewriteLock ? await params.withSessionManagerRewriteLock(rewriteSessionManagerEntries) : rewriteSessionManagerEntries();
			}
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
			withSessionManagerRewriteLock: params.executionMode === "background" ? void 0 : params.withSessionManagerRewriteLock,
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
			withSessionManagerRewriteLock: params.withSessionManagerRewriteLock,
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
//#region src/agents/harness/context-engine-lifecycle.ts
/**
* Run optional bootstrap + bootstrap maintenance for a harness-owned context engine.
*/
async function bootstrapHarnessContextEngine(params) {
	if (!params.hadSessionFile || !(params.contextEngine?.bootstrap || params.contextEngine?.maintain)) return;
	try {
		if (typeof params.contextEngine?.bootstrap === "function") await params.contextEngine.bootstrap({
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			sessionFile: params.sessionFile
		});
		await (params.runMaintenance ?? runHarnessContextEngineMaintenance)({
			contextEngine: params.contextEngine,
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			sessionFile: params.sessionFile,
			reason: "bootstrap",
			sessionManager: params.sessionManager,
			runtimeContext: params.runtimeContext,
			config: params.config
		});
	} catch (bootstrapErr) {
		params.warn(`context engine bootstrap failed: ${String(bootstrapErr)}`);
	}
}
/**
* Assemble model context through the active harness-owned context engine.
*/
async function assembleHarnessContextEngine(params) {
	if (!params.contextEngine) return;
	const messages = stripRuntimeContextCustomMessages(params.messages);
	return await params.contextEngine.assemble({
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		messages,
		tokenBudget: params.tokenBudget,
		...params.availableTools ? { availableTools: params.availableTools } : {},
		...params.citationsMode ? { citationsMode: params.citationsMode } : {},
		model: params.modelId,
		...params.prompt !== void 0 ? { prompt: params.prompt } : {}
	});
}
/**
* Finalize a completed harness turn via afterTurn or ingest fallbacks.
*/
async function finalizeHarnessContextEngineTurn(params) {
	if (!params.contextEngine) return { postTurnFinalizationSucceeded: true };
	const conversationSnapshot = buildContextEngineConversationSnapshot({
		messagesSnapshot: params.messagesSnapshot,
		prePromptMessageCount: params.prePromptMessageCount
	});
	let postTurnFinalizationSucceeded = true;
	if (typeof params.contextEngine.afterTurn === "function") try {
		await params.contextEngine.afterTurn({
			sessionId: params.sessionIdUsed,
			sessionKey: params.sessionKey,
			sessionFile: params.sessionFile,
			messages: conversationSnapshot.messages,
			prePromptMessageCount: conversationSnapshot.prePromptMessageCount,
			tokenBudget: params.tokenBudget,
			runtimeContext: params.runtimeContext
		});
	} catch (afterTurnErr) {
		postTurnFinalizationSucceeded = false;
		params.warn(`context engine afterTurn failed: ${String(afterTurnErr)}`);
	}
	else {
		const newMessages = conversationSnapshot.messages.slice(conversationSnapshot.prePromptMessageCount);
		if (newMessages.length > 0) if (typeof params.contextEngine.ingestBatch === "function") try {
			await params.contextEngine.ingestBatch({
				sessionId: params.sessionIdUsed,
				sessionKey: params.sessionKey,
				messages: newMessages
			});
		} catch (ingestErr) {
			postTurnFinalizationSucceeded = false;
			params.warn(`context engine ingest failed: ${String(ingestErr)}`);
		}
		else for (const msg of newMessages) try {
			await params.contextEngine.ingest?.({
				sessionId: params.sessionIdUsed,
				sessionKey: params.sessionKey,
				message: msg
			});
		} catch (ingestErr) {
			postTurnFinalizationSucceeded = false;
			params.warn(`context engine ingest failed: ${String(ingestErr)}`);
		}
	}
	if (!params.promptError && !params.aborted && !params.yieldAborted && postTurnFinalizationSucceeded) await (params.runMaintenance ?? runHarnessContextEngineMaintenance)({
		contextEngine: params.contextEngine,
		sessionId: params.sessionIdUsed,
		sessionKey: params.sessionKey,
		sessionFile: params.sessionFile,
		reason: "turn",
		sessionManager: params.sessionManager,
		runtimeContext: params.runtimeContext,
		config: params.config
	});
	return { postTurnFinalizationSucceeded };
}
function buildContextEngineConversationSnapshot(params) {
	const prePromptMessages = stripRuntimeContextCustomMessages(params.messagesSnapshot.slice(0, params.prePromptMessageCount));
	const turnMessages = stripRuntimeContextCustomMessages(params.messagesSnapshot.slice(params.prePromptMessageCount));
	return {
		messages: [...prePromptMessages, ...turnMessages],
		prePromptMessageCount: prePromptMessages.length
	};
}
/**
* Build runtime context passed into harness context-engine hooks.
*/
function buildHarnessContextEngineRuntimeContext(params) {
	return buildAfterTurnRuntimeContext(params);
}
/**
* Build runtime context passed into harness context-engine hooks from usage data.
*/
function buildHarnessContextEngineRuntimeContextFromUsage(params) {
	return buildAfterTurnRuntimeContextFromUsage(params);
}
/**
* Run optional transcript maintenance for a harness-owned context engine.
*/
async function runHarnessContextEngineMaintenance(params) {
	return await runContextEngineMaintenance({
		contextEngine: params.contextEngine,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		sessionFile: params.sessionFile,
		reason: params.reason,
		sessionManager: params.sessionManager,
		runtimeContext: params.runtimeContext,
		executionMode: params.executionMode,
		onDeferredMaintenance: params.onDeferredMaintenance,
		config: params.config
	});
}
/**
* Return true when a non-legacy context engine should affect plugin harness behavior.
*/
function isActiveHarnessContextEngine(contextEngine) {
	return Boolean(contextEngine && contextEngine.info.id !== "legacy");
}
//#endregion
export { writeTranscriptFileAtomic as _, finalizeHarnessContextEngineTurn as a, runContextEngineMaintenance as c, rewriteTranscriptEntriesInState as d, getRawSessionAppendMessage as f, readTranscriptFileState as g, persistTranscriptStateMutation as h, buildHarnessContextEngineRuntimeContextFromUsage as i, rewriteTranscriptEntriesInSessionFile as l, TranscriptFileState as m, bootstrapHarnessContextEngine as n, isActiveHarnessContextEngine as o, setRawSessionAppendMessage as p, buildHarnessContextEngineRuntimeContext as r, runHarnessContextEngineMaintenance as s, assembleHarnessContextEngine as t, rewriteTranscriptEntriesInSessionManager as u };
