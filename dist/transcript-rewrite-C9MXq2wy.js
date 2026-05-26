import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import "./fs-safe-DpJlqO1z.js";
import { t as appendRegularFile } from "./regular-file-6GdZVPgG.js";
import { t as privateFileStore } from "./private-file-store-9NwvLNnb.js";
import { t as emitSessionTranscriptUpdate } from "./transcript-events-B00DLjg-.js";
import { c as resolveSessionWriteLockAcquireTimeoutMs, r as acquireSessionWriteLock } from "./session-write-lock-BT1vMcpZ.js";
import { t as log } from "./logger-8oA4pYXO.js";
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
export { setRawSessionAppendMessage as a, readTranscriptFileState as c, getRawSessionAppendMessage as i, writeTranscriptFileAtomic as l, rewriteTranscriptEntriesInSessionManager as n, TranscriptFileState as o, rewriteTranscriptEntriesInState as r, persistTranscriptStateMutation as s, rewriteTranscriptEntriesInSessionFile as t };
