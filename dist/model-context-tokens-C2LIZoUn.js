import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-DpfQDjis.js";
import { n as isCompactionCheckpointTranscriptFileName } from "./artifacts-BZhcmsUl.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import "./sessions-CQHHcgC_.js";
import { o as streamSessionTranscriptLines } from "./transcript-BA0Ngd-A.js";
import { t as emitSessionTranscriptUpdate } from "./transcript-events-ClYG_P1o.js";
import { m as resolveGatewaySessionStoreTarget } from "./session-utils-CRKr-5AU.js";
import { t as log$1 } from "./logger-D2U-uUBZ.js";
import { r as getActiveMemorySearchManager } from "./memory-runtime-DxsWIMOy.js";
import { t as resolveMemorySearchConfig } from "./memory-search-BEQRq9yG.js";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CURRENT_SESSION_VERSION, migrateSessionEntries } from "@earendil-works/pi-coding-agent";
//#region src/gateway/session-compaction-checkpoints.ts
const log = createSubsystemLogger("gateway/session-compaction-checkpoints");
const MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES = 64 * 1024 * 1024;
function trimSessionCheckpoints(checkpoints) {
	if (!Array.isArray(checkpoints) || checkpoints.length === 0) return {
		kept: void 0,
		removed: []
	};
	const kept = checkpoints.slice(-25);
	return {
		kept,
		removed: checkpoints.slice(0, Math.max(0, checkpoints.length - kept.length))
	};
}
function sessionStoreCheckpoints(entry) {
	return Array.isArray(entry?.compactionCheckpoints) ? [...entry.compactionCheckpoints] : [];
}
function resolveSessionCompactionCheckpointReason(params) {
	if (params.trigger === "manual") return "manual";
	if (params.timedOut) return "timeout-retry";
	if (params.trigger === "overflow") return "overflow-retry";
	return "auto-threshold";
}
const SESSION_HEADER_READ_MAX_BYTES = 64 * 1024;
const SESSION_TAIL_READ_INITIAL_BYTES = 64 * 1024;
async function readFileRangeAsync(fileHandle, position, length) {
	const buffer = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		const { bytesRead } = await fileHandle.read(buffer, offset, length - offset, position + offset);
		if (bytesRead <= 0) break;
		offset += bytesRead;
	}
	return offset === length ? buffer : buffer.subarray(0, offset);
}
async function readSessionHeaderFromTranscriptAsync(sessionFile) {
	let fileHandle;
	try {
		fileHandle = await fs.open(sessionFile, "r");
		const buffer = await readFileRangeAsync(fileHandle, 0, SESSION_HEADER_READ_MAX_BYTES);
		if (buffer.length <= 0) return null;
		const firstLine = buffer.toString("utf-8").split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
		if (!firstLine) return null;
		const parsed = JSON.parse(firstLine);
		if (parsed.type !== "session" || typeof parsed.id !== "string" || !parsed.id.trim()) return null;
		return {
			id: parsed.id.trim(),
			...typeof parsed.cwd === "string" && parsed.cwd.trim() ? { cwd: parsed.cwd } : {}
		};
	} catch {
		return null;
	} finally {
		if (fileHandle) await fileHandle.close().catch(() => void 0);
	}
}
async function readSessionIdFromTranscriptHeaderAsync(sessionFile) {
	return (await readSessionHeaderFromTranscriptAsync(sessionFile))?.id ?? null;
}
function parseTranscriptLineId(line) {
	try {
		const parsed = JSON.parse(line);
		if (parsed.type === "session") return { kind: "session" };
		if (typeof parsed.id === "string" && parsed.id.trim()) return {
			kind: "entry",
			id: parsed.id.trim()
		};
	} catch {
		return null;
	}
	return null;
}
async function readTranscriptEntriesForForkAsync(sessionFile) {
	const entries = [];
	try {
		for await (const line of streamSessionTranscriptLines(sessionFile)) try {
			const parsed = JSON.parse(line);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			entries.push(parsed);
		} catch {}
	} catch {
		return null;
	}
	const firstEntry = entries[0];
	if (firstEntry?.type !== "session" || typeof firstEntry.id !== "string") return null;
	return entries;
}
async function readSessionLeafIdFromTranscriptAsync(sessionFile, maxBytes = MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES) {
	let fileHandle;
	try {
		fileHandle = await fs.open(sessionFile, "r");
		const stat = await fileHandle.stat();
		if (!stat.isFile() || stat.size <= 0) return null;
		const requestedMaxBytes = Number.isFinite(maxBytes) ? Math.max(1024, Math.floor(maxBytes)) : MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES;
		const maxReadableBytes = Math.min(stat.size, requestedMaxBytes);
		let readLength = Math.min(maxReadableBytes, SESSION_TAIL_READ_INITIAL_BYTES);
		while (readLength > 0) {
			const readStart = Math.max(0, stat.size - readLength);
			const lines = (await readFileRangeAsync(fileHandle, readStart, readLength)).toString("utf-8").split(/\r?\n/);
			const candidateLines = readStart > 0 ? lines.slice(1) : lines;
			for (let i = candidateLines.length - 1; i >= 0; i -= 1) {
				const line = candidateLines[i]?.trim();
				if (!line) continue;
				const parsed = parseTranscriptLineId(line);
				if (!parsed) continue;
				if (parsed.kind === "session") return null;
				return parsed.id;
			}
			if (readStart === 0) return null;
			const nextReadLength = Math.min(maxReadableBytes, readLength * 2);
			if (nextReadLength === readLength) return null;
			readLength = nextReadLength;
		}
	} catch {
		return null;
	} finally {
		if (fileHandle) await fileHandle.close().catch(() => void 0);
	}
	return null;
}
async function forkCompactionCheckpointTranscriptAsync(params) {
	const sourceFile = params.sourceFile.trim();
	if (!sourceFile) return null;
	const sourceHeader = await readSessionHeaderFromTranscriptAsync(sourceFile);
	if (!sourceHeader) return null;
	const entries = await readTranscriptEntriesForForkAsync(sourceFile);
	if (!entries) return null;
	migrateSessionEntries(entries);
	const targetCwd = params.targetCwd ?? sourceHeader.cwd ?? process.cwd();
	const sessionDir = params.sessionDir ?? path.dirname(sourceFile);
	const sessionId = randomUUID();
	const timestamp = (/* @__PURE__ */ new Date()).toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const sessionFile = path.join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionId,
		timestamp,
		cwd: targetCwd,
		parentSession: sourceFile
	};
	try {
		await fs.mkdir(sessionDir, { recursive: true });
		const lines = [JSON.stringify(header)];
		for (const entry of entries) if (entry.type !== "session") lines.push(JSON.stringify(entry));
		await fs.writeFile(sessionFile, `${lines.join("\n")}\n`, {
			encoding: "utf-8",
			flag: "wx"
		});
		return {
			sessionId,
			sessionFile
		};
	} catch {
		try {
			await fs.unlink(sessionFile);
		} catch {}
		return null;
	}
}
/**
* Capture a bounded pre-compaction transcript snapshot without blocking the
* Gateway event loop on synchronous file reads/copies.
*/
async function captureCompactionCheckpointSnapshotAsync(params) {
	const getLeafId = params.sessionManager && typeof params.sessionManager.getLeafId === "function" ? params.sessionManager.getLeafId.bind(params.sessionManager) : null;
	const sessionFile = params.sessionFile.trim();
	if (!sessionFile || params.sessionManager && !getLeafId) return null;
	const liveLeafId = getLeafId ? getLeafId() : void 0;
	if (getLeafId && !liveLeafId) return null;
	const maxBytes = params.maxBytes ?? 67108864;
	try {
		const stat = await fs.stat(sessionFile);
		if (!stat.isFile() || stat.size > maxBytes) return null;
	} catch {
		return null;
	}
	const parsedSessionFile = path.parse(sessionFile);
	const snapshotFile = path.join(parsedSessionFile.dir, `${parsedSessionFile.name}.checkpoint.${randomUUID()}${parsedSessionFile.ext || ".jsonl"}`);
	try {
		await fs.copyFile(sessionFile, snapshotFile);
	} catch {
		return null;
	}
	const sessionId = await readSessionIdFromTranscriptHeaderAsync(snapshotFile);
	const leafId = liveLeafId ?? await readSessionLeafIdFromTranscriptAsync(snapshotFile, maxBytes);
	if (!sessionId || !leafId) {
		try {
			await fs.unlink(snapshotFile);
		} catch {}
		return null;
	}
	return {
		sessionId,
		sessionFile: snapshotFile,
		leafId
	};
}
async function cleanupCompactionCheckpointSnapshot(snapshot) {
	if (!snapshot?.sessionFile) return;
	try {
		await fs.unlink(snapshot.sessionFile);
	} catch {}
}
async function cleanupTrimmedCompactionCheckpointFiles(params) {
	if (params.removed.length === 0) return;
	const retainedPaths = new Set((params.retained ?? []).map((checkpoint) => checkpoint.preCompaction.sessionFile?.trim()).filter((filePath) => Boolean(filePath)));
	const snapshotDir = path.resolve(path.dirname(params.currentSnapshotFile));
	for (const checkpoint of params.removed) {
		const sessionFile = checkpoint.preCompaction.sessionFile?.trim();
		if (!sessionFile || retainedPaths.has(sessionFile)) continue;
		const resolvedSessionFile = path.resolve(sessionFile);
		if (path.dirname(resolvedSessionFile) !== snapshotDir || !isCompactionCheckpointTranscriptFileName(path.basename(resolvedSessionFile))) continue;
		try {
			await fs.unlink(resolvedSessionFile);
		} catch {}
	}
}
async function persistSessionCompactionCheckpoint(params) {
	const target = resolveGatewaySessionStoreTarget({
		cfg: params.cfg,
		key: params.sessionKey
	});
	const createdAt = params.createdAt ?? Date.now();
	const checkpoint = {
		checkpointId: randomUUID(),
		sessionKey: target.canonicalKey,
		sessionId: params.sessionId,
		createdAt,
		reason: params.reason,
		...typeof params.tokensBefore === "number" ? { tokensBefore: params.tokensBefore } : {},
		...typeof params.tokensAfter === "number" ? { tokensAfter: params.tokensAfter } : {},
		...params.summary?.trim() ? { summary: params.summary.trim() } : {},
		...params.firstKeptEntryId?.trim() ? { firstKeptEntryId: params.firstKeptEntryId.trim() } : {},
		preCompaction: {
			sessionId: params.snapshot.sessionId,
			sessionFile: params.snapshot.sessionFile,
			leafId: params.snapshot.leafId
		},
		postCompaction: {
			sessionId: params.sessionId,
			...params.postSessionFile?.trim() ? { sessionFile: params.postSessionFile.trim() } : {},
			...params.postLeafId?.trim() ? { leafId: params.postLeafId.trim() } : {},
			...params.postEntryId?.trim() ? { entryId: params.postEntryId.trim() } : {}
		}
	};
	let stored = false;
	let trimmedCheckpoints;
	await updateSessionStore(target.storePath, (store) => {
		const existing = store[target.canonicalKey];
		if (!existing?.sessionId) return;
		const checkpoints = sessionStoreCheckpoints(existing);
		checkpoints.push(checkpoint);
		trimmedCheckpoints = trimSessionCheckpoints(checkpoints);
		store[target.canonicalKey] = {
			...existing,
			updatedAt: Math.max(existing.updatedAt ?? 0, createdAt),
			compactionCheckpoints: trimmedCheckpoints.kept
		};
		stored = true;
	});
	if (!stored) {
		log.warn("skipping compaction checkpoint persist: session not found", { sessionKey: params.sessionKey });
		return null;
	}
	await cleanupTrimmedCompactionCheckpointFiles({
		removed: trimmedCheckpoints?.removed ?? [],
		retained: trimmedCheckpoints?.kept,
		currentSnapshotFile: params.snapshot.sessionFile
	});
	return checkpoint;
}
function listSessionCompactionCheckpoints(entry) {
	return sessionStoreCheckpoints(entry).toSorted((a, b) => b.createdAt - a.createdAt);
}
function getSessionCompactionCheckpoint(params) {
	const checkpointId = params.checkpointId.trim();
	if (!checkpointId) return;
	return listSessionCompactionCheckpoints(params.entry).find((checkpoint) => checkpoint.checkpointId === checkpointId);
}
//#endregion
//#region src/agents/pi-embedded-runner/compaction-hooks.ts
function resolvePostCompactionIndexSyncMode(config) {
	const mode = config?.agents?.defaults?.compaction?.postIndexSync;
	if (mode === "off" || mode === "async" || mode === "await") return mode;
	return "async";
}
async function runPostCompactionSessionMemorySync(params) {
	if (!params.config) return;
	try {
		const sessionFile = params.sessionFile.trim();
		if (!sessionFile) return;
		const agentId = resolveSessionAgentId({
			sessionKey: params.sessionKey,
			config: params.config
		});
		const resolvedMemory = resolveMemorySearchConfig(params.config, agentId);
		if (!resolvedMemory || !resolvedMemory.sources.includes("sessions")) return;
		if (!resolvedMemory.sync.sessions.postCompactionForce) return;
		const { manager } = await getActiveMemorySearchManager({
			cfg: params.config,
			agentId
		});
		if (!manager?.sync) return;
		await manager.sync({
			reason: "post-compaction",
			sessionFiles: [sessionFile]
		});
	} catch (err) {
		log$1.warn(`memory sync skipped (post-compaction): ${formatErrorMessage(err)}`);
	}
}
function syncPostCompactionSessionMemory(params) {
	if (params.mode === "off" || !params.config) return Promise.resolve();
	const syncTask = runPostCompactionSessionMemorySync({
		config: params.config,
		sessionKey: params.sessionKey,
		sessionFile: params.sessionFile
	});
	if (params.mode === "await") return syncTask;
	return Promise.resolve();
}
async function runPostCompactionSideEffects(params) {
	const sessionFile = params.sessionFile.trim();
	if (!sessionFile) return;
	emitSessionTranscriptUpdate({
		sessionFile,
		sessionKey: params.sessionKey
	});
	await syncPostCompactionSessionMemory({
		config: params.config,
		sessionKey: params.sessionKey,
		sessionFile,
		mode: resolvePostCompactionIndexSyncMode(params.config)
	});
}
function asCompactionHookRunner(hookRunner) {
	if (!hookRunner) return null;
	return {
		hasHooks: (hookName) => hookRunner.hasHooks?.(hookName) ?? false,
		runBeforeCompaction: hookRunner.runBeforeCompaction?.bind(hookRunner),
		runAfterCompaction: hookRunner.runAfterCompaction?.bind(hookRunner)
	};
}
function estimateTokenCountSafe(messages, estimateTokensFn) {
	try {
		let total = 0;
		for (const message of messages) total += estimateTokensFn(message);
		return total;
	} catch {
		return;
	}
}
function buildBeforeCompactionHookMetrics(params) {
	return {
		messageCountOriginal: params.originalMessages.length,
		tokenCountOriginal: estimateTokenCountSafe(params.originalMessages, params.estimateTokensFn),
		messageCountBefore: params.currentMessages.length,
		tokenCountBefore: params.observedTokenCount ?? estimateTokenCountSafe(params.currentMessages, params.estimateTokensFn)
	};
}
async function runBeforeCompactionHooks(params) {
	const missingSessionKey = !params.sessionKey || !params.sessionKey.trim();
	const hookSessionKey = params.sessionKey?.trim() || params.sessionId;
	try {
		const hookEvent = createInternalHookEvent("session", "compact:before", hookSessionKey, {
			sessionId: params.sessionId,
			missingSessionKey,
			messageCount: params.metrics.messageCountBefore,
			tokenCount: params.metrics.tokenCountBefore,
			messageCountOriginal: params.metrics.messageCountOriginal,
			tokenCountOriginal: params.metrics.tokenCountOriginal
		});
		await triggerInternalHook(hookEvent);
		if (hookEvent.messages.length > 0) await params.onHookMessages?.({
			phase: "before",
			messages: hookEvent.messages.slice(),
			sessionId: params.sessionId,
			sessionKey: hookSessionKey
		});
	} catch (err) {
		log$1.warn("session:compact:before hook failed", {
			errorMessage: formatErrorMessage(err),
			errorStack: err instanceof Error ? err.stack : void 0
		});
	}
	if (params.hookRunner?.hasHooks?.("before_compaction")) try {
		await params.hookRunner.runBeforeCompaction?.({
			messageCount: params.metrics.messageCountBefore,
			tokenCount: params.metrics.tokenCountBefore
		}, {
			sessionId: params.sessionId,
			agentId: params.sessionAgentId,
			sessionKey: hookSessionKey,
			workspaceDir: params.workspaceDir,
			messageProvider: params.messageProvider
		});
	} catch (err) {
		log$1.warn("before_compaction hook failed", {
			errorMessage: formatErrorMessage(err),
			errorStack: err instanceof Error ? err.stack : void 0
		});
	}
	return {
		hookSessionKey,
		missingSessionKey
	};
}
function estimateTokensAfterCompaction(params) {
	const tokensAfter = estimateTokenCountSafe(params.messagesAfter, params.estimateTokensFn);
	if (tokensAfter === void 0) return;
	const sanityCheckBaseline = params.observedTokenCount ?? params.fullSessionTokensBefore;
	if (sanityCheckBaseline > 0 && tokensAfter > (params.observedTokenCount !== void 0 ? sanityCheckBaseline : sanityCheckBaseline * 1.1)) return;
	return tokensAfter;
}
async function runAfterCompactionHooks(params) {
	try {
		const hookEvent = createInternalHookEvent("session", "compact:after", params.hookSessionKey, {
			sessionId: params.sessionId,
			missingSessionKey: params.missingSessionKey,
			messageCount: params.messageCountAfter,
			tokenCount: params.tokensAfter,
			compactedCount: params.compactedCount,
			summaryLength: params.summaryLength,
			tokensBefore: params.tokensBefore,
			tokensAfter: params.tokensAfter,
			firstKeptEntryId: params.firstKeptEntryId
		});
		await triggerInternalHook(hookEvent);
		if (hookEvent.messages.length > 0) await params.onHookMessages?.({
			phase: "after",
			messages: hookEvent.messages.slice(),
			sessionId: params.sessionId,
			sessionKey: params.hookSessionKey
		});
	} catch (err) {
		log$1.warn("session:compact:after hook failed", {
			errorMessage: formatErrorMessage(err),
			errorStack: err instanceof Error ? err.stack : void 0
		});
	}
	if (params.hookRunner?.hasHooks?.("after_compaction")) try {
		await params.hookRunner.runAfterCompaction?.({
			messageCount: params.messageCountAfter,
			tokenCount: params.tokensAfter,
			compactedCount: params.compactedCount,
			sessionFile: params.sessionFile
		}, {
			sessionId: params.sessionId,
			agentId: params.sessionAgentId,
			sessionKey: params.hookSessionKey,
			workspaceDir: params.workspaceDir,
			messageProvider: params.messageProvider
		});
	} catch (err) {
		log$1.warn("after_compaction hook failed", {
			errorMessage: formatErrorMessage(err),
			errorStack: err instanceof Error ? err.stack : void 0
		});
	}
}
//#endregion
//#region src/agents/pi-embedded-runner/model-context-tokens.ts
function readPiModelContextTokens(model) {
	const value = model?.contextTokens;
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
//#endregion
export { runAfterCompactionHooks as a, captureCompactionCheckpointSnapshotAsync as c, getSessionCompactionCheckpoint as d, listSessionCompactionCheckpoints as f, resolveSessionCompactionCheckpointReason as h, estimateTokensAfterCompaction as i, cleanupCompactionCheckpointSnapshot as l, readSessionLeafIdFromTranscriptAsync as m, asCompactionHookRunner as n, runBeforeCompactionHooks as o, persistSessionCompactionCheckpoint as p, buildBeforeCompactionHookMetrics as r, runPostCompactionSideEffects as s, readPiModelContextTokens as t, forkCompactionCheckpointTranscriptAsync as u };
