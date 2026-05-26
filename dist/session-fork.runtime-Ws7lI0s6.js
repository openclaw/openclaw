import "./fs-safe-CV86zY9G.js";
import { r as readRegularFile } from "./regular-file-DaVeNX32.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath } from "./paths-Bg3PO6Gj.js";
import { o as resolveFreshSessionTotalTokens } from "./types-BgvyBC-3.js";
import { r as readLatestRecentSessionUsageFromTranscriptAsync } from "./session-utils.fs-CsnHXIqH.js";
import { n as derivePromptTokens } from "./usage-DKNTRfvn.js";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { CURRENT_SESSION_VERSION, migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
//#region src/auto-reply/reply/session-fork.runtime.ts
const FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN = 4;
function resolvePositiveTokenCount(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : void 0;
}
function maxPositiveTokenCount(...values) {
	let max;
	for (const value of values) {
		const normalized = resolvePositiveTokenCount(value);
		if (typeof normalized === "number" && (max === void 0 || normalized > max)) max = normalized;
	}
	return max;
}
async function estimateParentTranscriptTokensFromBytes(params) {
	try {
		const filePath = resolveSessionFilePath(params.parentEntry.sessionId, params.parentEntry, resolveSessionFilePathOptions({ storePath: params.storePath }));
		const stat = await fs.stat(filePath);
		return resolvePositiveTokenCount(Math.ceil(stat.size / FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN));
	} catch {
		return;
	}
}
async function resolveParentForkTokenCountRuntime(params) {
	const freshPersistedTokens = resolveFreshSessionTotalTokens(params.parentEntry);
	if (typeof freshPersistedTokens === "number") return freshPersistedTokens;
	const cachedTokens = resolvePositiveTokenCount(params.parentEntry.totalTokens);
	const byteEstimateTokens = await estimateParentTranscriptTokensFromBytes(params);
	try {
		const usage = await readLatestRecentSessionUsageFromTranscriptAsync(params.parentEntry.sessionId, params.storePath, params.parentEntry.sessionFile, void 0, 1024 * 1024);
		const promptTokens = resolvePositiveTokenCount(derivePromptTokens({
			input: usage?.inputTokens,
			cacheRead: usage?.cacheRead,
			cacheWrite: usage?.cacheWrite
		}));
		const outputTokens = resolvePositiveTokenCount(usage?.outputTokens);
		if (typeof promptTokens === "number") return maxPositiveTokenCount(promptTokens + (outputTokens ?? 0), cachedTokens, byteEstimateTokens);
	} catch {}
	return maxPositiveTokenCount(cachedTokens, byteEstimateTokens);
}
function isSessionEntry(entry) {
	return entry.type !== "session" && typeof entry.id === "string" && (typeof entry.timestamp === "string" || typeof entry.timestamp === "number");
}
function buildEntryIndex(entries) {
	return new Map(entries.map((entry) => [entry.id, entry]));
}
function readBranch(params) {
	const branchEntries = [];
	let current = params.leafId ? params.byId.get(params.leafId) : void 0;
	while (current) {
		branchEntries.unshift(current);
		current = current.parentId ? params.byId.get(current.parentId) : void 0;
	}
	return branchEntries;
}
function generateEntryId(existingIds) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const id = crypto.randomUUID().slice(0, 8);
		if (!existingIds.has(id)) {
			existingIds.add(id);
			return id;
		}
	}
	const id = crypto.randomUUID();
	existingIds.add(id);
	return id;
}
function collectBranchLabels(params) {
	const labelsToWrite = [];
	for (const entry of params.allEntries) if (entry.type === "label" && entry.label && params.pathEntryIds.has(entry.targetId) && typeof entry.timestamp === "string") labelsToWrite.push({
		targetId: entry.targetId,
		label: entry.label,
		timestamp: entry.timestamp
	});
	return labelsToWrite;
}
async function readForkSourceTranscript(parentSessionFile) {
	const fileEntries = parseSessionEntries((await readRegularFile({ filePath: parentSessionFile })).buffer.toString("utf-8"));
	migrateSessionEntries(fileEntries);
	const header = fileEntries.find((entry) => entry.type === "session") ?? null;
	const entries = fileEntries.filter(isSessionEntry);
	const byId = buildEntryIndex(entries);
	const leafId = entries.at(-1)?.id ?? null;
	const branchEntries = readBranch({
		byId,
		leafId
	});
	const pathEntryIds = new Set(branchEntries.filter((entry) => entry.type !== "label").map((entry) => entry.id));
	return {
		cwd: header?.cwd ?? process.cwd(),
		sessionDir: path.dirname(parentSessionFile),
		leafId,
		branchEntries,
		labelsToWrite: collectBranchLabels({
			allEntries: entries,
			pathEntryIds
		})
	};
}
function buildBranchLabelEntries(params) {
	let parentId = params.lastEntryId;
	const labelEntries = [];
	for (const { targetId, label, timestamp } of params.labelsToWrite) {
		const labelEntry = {
			type: "label",
			id: generateEntryId(params.pathEntryIds),
			parentId,
			timestamp,
			targetId,
			label
		};
		params.pathEntryIds.add(labelEntry.id);
		labelEntries.push(labelEntry);
		parentId = labelEntry.id;
	}
	return labelEntries;
}
async function writeForkHeaderOnly(params) {
	const sessionId = crypto.randomUUID();
	const timestamp = (/* @__PURE__ */ new Date()).toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const sessionFile = path.join(params.sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionId,
		timestamp,
		cwd: params.cwd,
		parentSession: params.parentSessionFile
	};
	await fs.mkdir(path.dirname(sessionFile), { recursive: true });
	await fs.writeFile(sessionFile, `${JSON.stringify(header)}\n`, {
		encoding: "utf-8",
		mode: 384,
		flag: "wx"
	});
	return {
		sessionId,
		sessionFile
	};
}
async function writeBranchedSession(params) {
	const sessionId = crypto.randomUUID();
	const timestamp = (/* @__PURE__ */ new Date()).toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const sessionFile = path.join(params.source.sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
	const pathWithoutLabels = params.source.branchEntries.filter((entry) => entry.type !== "label");
	const pathEntryIds = new Set(pathWithoutLabels.map((entry) => entry.id));
	const labelEntries = buildBranchLabelEntries({
		labelsToWrite: params.source.labelsToWrite,
		pathEntryIds,
		lastEntryId: pathWithoutLabels.at(-1)?.id ?? null
	});
	const entries = [
		{
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionId,
			timestamp,
			cwd: params.source.cwd,
			parentSession: params.parentSessionFile
		},
		...pathWithoutLabels,
		...labelEntries
	];
	if (entries.some((entry) => entry.type === "message" && entry.message.role === "assistant")) {
		await fs.mkdir(path.dirname(sessionFile), { recursive: true });
		await fs.writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
			encoding: "utf-8",
			mode: 384,
			flag: "wx"
		});
	}
	return {
		sessionId,
		sessionFile
	};
}
async function forkSessionFromParentRuntime(params) {
	const parentSessionFile = resolveSessionFilePath(params.parentEntry.sessionId, params.parentEntry, {
		agentId: params.agentId,
		sessionsDir: params.sessionsDir
	});
	if (!parentSessionFile) return null;
	try {
		const source = await readForkSourceTranscript(parentSessionFile);
		if (!source) return null;
		return source.leafId ? await writeBranchedSession({
			parentSessionFile,
			source
		}) : await writeForkHeaderOnly({
			parentSessionFile,
			sessionDir: source.sessionDir,
			cwd: source.cwd
		});
	} catch {
		return null;
	}
}
//#endregion
export { forkSessionFromParentRuntime, resolveParentForkTokenCountRuntime };
