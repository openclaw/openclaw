import { o as resolveRequiredHomeDir } from "./home-dir-BOPFpGo8.js";
import { t as formatSessionArchiveTimestamp, u as parseSessionArchiveTimestamp } from "./artifacts-BZhcmsUl.js";
import { i as resolveSessionFilePath, o as resolveSessionTranscriptPath, s as resolveSessionTranscriptPathInDir } from "./paths-Bg3PO6Gj.js";
import { t as emitSessionTranscriptUpdate } from "./transcript-events-ClYG_P1o.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/gateway/session-transcript-files.fs.ts
function classifySessionTranscriptCandidate(sessionId, sessionFile) {
	const transcriptSessionId = extractGeneratedTranscriptSessionId(sessionFile);
	if (!transcriptSessionId) return "custom";
	return transcriptSessionId === sessionId ? "current" : "stale";
}
function extractGeneratedTranscriptSessionId(sessionFile) {
	const trimmed = sessionFile?.trim();
	if (!trimmed) return;
	const base = path.basename(trimmed);
	if (!base.endsWith(".jsonl")) return;
	const withoutExt = base.slice(0, -6);
	const topicIndex = withoutExt.indexOf("-topic-");
	if (topicIndex > 0) {
		const topicSessionId = withoutExt.slice(0, topicIndex);
		return looksLikeGeneratedSessionId(topicSessionId) ? topicSessionId : void 0;
	}
	const forkMatch = withoutExt.match(/^(\d{4}-\d{2}-\d{2}T[\w-]+(?:Z|[+-]\d{2}(?:-\d{2})?)?)_(.+)$/);
	if (forkMatch?.[2]) return looksLikeGeneratedSessionId(forkMatch[2]) ? forkMatch[2] : void 0;
	return looksLikeGeneratedSessionId(withoutExt) ? withoutExt : void 0;
}
function looksLikeGeneratedSessionId(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function canonicalizePathForComparison(filePath) {
	const resolved = path.resolve(filePath);
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}
function resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId) {
	const candidates = [];
	const sessionFileState = classifySessionTranscriptCandidate(sessionId, sessionFile);
	const pushCandidate = (resolve) => {
		try {
			candidates.push(resolve());
		} catch {}
	};
	if (storePath) {
		const sessionsDir = path.dirname(storePath);
		if (sessionFile && sessionFileState !== "stale") pushCandidate(() => resolveSessionFilePath(sessionId, { sessionFile }, {
			sessionsDir,
			agentId
		}));
		pushCandidate(() => resolveSessionTranscriptPathInDir(sessionId, sessionsDir));
		if (sessionFile && sessionFileState === "stale") pushCandidate(() => resolveSessionFilePath(sessionId, { sessionFile }, {
			sessionsDir,
			agentId
		}));
	} else if (sessionFile) if (agentId) {
		if (sessionFileState !== "stale") pushCandidate(() => resolveSessionFilePath(sessionId, { sessionFile }, { agentId }));
	} else {
		const trimmed = sessionFile.trim();
		if (trimmed) candidates.push(path.resolve(trimmed));
	}
	if (agentId) {
		pushCandidate(() => resolveSessionTranscriptPath(sessionId, agentId));
		if (sessionFile && sessionFileState === "stale") pushCandidate(() => resolveSessionFilePath(sessionId, { sessionFile }, { agentId }));
	}
	const home = resolveRequiredHomeDir(process.env, os.homedir);
	const legacyDir = path.join(home, ".openclaw", "sessions");
	pushCandidate(() => resolveSessionTranscriptPathInDir(sessionId, legacyDir));
	return Array.from(new Set(candidates));
}
function archiveFileOnDisk(filePath, reason) {
	const archived = `${filePath}.${reason}.${formatSessionArchiveTimestamp()}`;
	fs.renameSync(filePath, archived);
	emitSessionTranscriptUpdate({ sessionFile: archived });
	return archived;
}
function archiveSessionTranscripts(opts) {
	return archiveSessionTranscriptsDetailed(opts).map((entry) => entry.archivedPath);
}
function archiveSessionTranscriptsDetailed(opts) {
	const archived = [];
	const storeDir = opts.restrictToStoreDir && opts.storePath ? canonicalizePathForComparison(path.dirname(opts.storePath)) : null;
	for (const candidate of resolveSessionTranscriptCandidates(opts.sessionId, opts.storePath, opts.sessionFile, opts.agentId)) {
		const candidatePath = canonicalizePathForComparison(candidate);
		if (storeDir) {
			const relative = path.relative(storeDir, candidatePath);
			if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
		}
		if (!fs.existsSync(candidatePath)) continue;
		try {
			archived.push({
				sourcePath: candidatePath,
				archivedPath: archiveFileOnDisk(candidatePath, opts.reason)
			});
		} catch (err) {
			opts.onArchiveError?.(err, candidatePath);
		}
	}
	return archived;
}
function resolveStableSessionEndTranscript(params) {
	const archivedTranscripts = params.archivedTranscripts ?? [];
	if (archivedTranscripts.length > 0) {
		const preferredPath = params.sessionFile?.trim() ? canonicalizePathForComparison(params.sessionFile) : void 0;
		const archivedPath = (preferredPath == null ? void 0 : archivedTranscripts.find((entry) => canonicalizePathForComparison(entry.sourcePath) === preferredPath))?.archivedPath ?? archivedTranscripts[0]?.archivedPath;
		if (archivedPath) return {
			sessionFile: archivedPath,
			transcriptArchived: true
		};
	}
	for (const candidate of resolveSessionTranscriptCandidates(params.sessionId, params.storePath, params.sessionFile, params.agentId)) {
		const candidatePath = canonicalizePathForComparison(candidate);
		if (fs.existsSync(candidatePath)) return {
			sessionFile: candidatePath,
			transcriptArchived: false
		};
	}
	return {};
}
async function cleanupArchivedSessionTranscripts(opts) {
	if (!Number.isFinite(opts.olderThanMs) || opts.olderThanMs < 0) return {
		removed: 0,
		scanned: 0
	};
	const now = opts.nowMs ?? Date.now();
	const reason = opts.reason ?? "deleted";
	const directories = Array.from(new Set(opts.directories.map((dir) => path.resolve(dir))));
	let removed = 0;
	let scanned = 0;
	for (const dir of directories) {
		const entries = await fs.promises.readdir(dir).catch(() => []);
		for (const entry of entries) {
			const timestamp = parseSessionArchiveTimestamp(entry, reason);
			if (timestamp == null) continue;
			scanned += 1;
			if (now - timestamp <= opts.olderThanMs) continue;
			const fullPath = path.join(dir, entry);
			if (!(await fs.promises.stat(fullPath).catch(() => null))?.isFile()) continue;
			await fs.promises.rm(fullPath).catch(() => void 0);
			removed += 1;
		}
	}
	return {
		removed,
		scanned
	};
}
//#endregion
export { resolveSessionTranscriptCandidates as a, cleanupArchivedSessionTranscripts as i, archiveSessionTranscripts as n, resolveStableSessionEndTranscript as o, archiveSessionTranscriptsDetailed as r, archiveFileOnDisk as t };
