import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import "./combined-store-gateway-NV2GSCR6.js";
import { d as parseUsageCountedSessionIdFromFileName } from "./artifacts-BZhcmsUl.js";
import path from "node:path";
//#region src/plugin-sdk/session-transcript-hit.ts
const QMD_ARCHIVE_STEM_RE = /^(.+)-jsonl-(reset|deleted)-(.+)$/;
const QMD_ARCHIVE_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})[tT](\d{2}-\d{2}-\d{2})(?:(?:\.|-)(\d{3}))?[zZ]$/;
function restoreQmdNormalizedArchiveTimestamp(timestamp) {
	const match = QMD_ARCHIVE_TIMESTAMP_RE.exec(timestamp);
	if (!match) return null;
	const [, date, time, milliseconds] = match;
	return `${date}T${time}${milliseconds ? `.${milliseconds}` : ""}Z`;
}
function restoreQmdNormalizedArchiveName(mdStem) {
	const match = QMD_ARCHIVE_STEM_RE.exec(mdStem);
	if (!match) return null;
	const [, sessionId, reason, timestamp] = match;
	const restoredTimestamp = restoreQmdNormalizedArchiveTimestamp(timestamp);
	return restoredTimestamp ? `${sessionId}.jsonl.${reason}.${restoredTimestamp}` : null;
}
function normalizeQmdSessionStem(stem) {
	return stem.normalize("NFKD").toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}
function parseSessionsPath(hitPath) {
	const normalized = hitPath.replace(/\\/g, "/");
	const fromSessionsRoot = normalized.startsWith("sessions/") ? normalized.slice(9) : normalized;
	const parts = fromSessionsRoot.split("/").filter(Boolean);
	return {
		base: path.posix.basename(fromSessionsRoot),
		ownerAgentId: normalized.startsWith("sessions/") && parts.length === 2 ? normalizeAgentId(parts[0]) : void 0
	};
}
/**
* Derive transcript stem `S` from a memory search hit path for `source === "sessions"`.
* Builtin index uses `sessions/<basename>.jsonl`; QMD exports use `<stem>.md`.
* Archived transcripts (`.jsonl.reset.<iso>` / `.jsonl.deleted.<iso>`) resolve
* to the same stem as the live `.jsonl` they were rotated from.
*/
function extractTranscriptStemFromSessionsMemoryHit(hitPath) {
	return extractTranscriptIdentityFromSessionsMemoryHit(hitPath)?.stem ?? null;
}
function extractTranscriptIdentityFromSessionsMemoryHit(hitPath) {
	const isQmdPath = hitPath.replace(/\\/g, "/").startsWith("qmd/");
	const { base, ownerAgentId } = parseSessionsPath(hitPath);
	const archivedStem = parseUsageCountedSessionIdFromFileName(base);
	if (archivedStem && base !== `${archivedStem}.jsonl`) return {
		stem: archivedStem,
		ownerAgentId,
		archived: true
	};
	if (base.endsWith(".jsonl")) {
		const stem = base.slice(0, -6);
		return stem ? {
			stem,
			ownerAgentId,
			archived: false
		} : null;
	}
	if (base.endsWith(".md")) {
		const mdStem = base.slice(0, -3);
		if (!mdStem) return null;
		if (isQmdPath) {
			const exportedArchiveStem = parseUsageCountedSessionIdFromFileName(mdStem);
			if (exportedArchiveStem && mdStem !== `${exportedArchiveStem}.jsonl`) return {
				stem: exportedArchiveStem,
				liveStem: mdStem,
				ownerAgentId,
				archived: true
			};
			const restoredArchiveName = restoreQmdNormalizedArchiveName(mdStem);
			if (restoredArchiveName) {
				const archivedStem = parseUsageCountedSessionIdFromFileName(restoredArchiveName);
				if (archivedStem && restoredArchiveName !== `${archivedStem}.jsonl`) return {
					stem: archivedStem,
					liveStem: mdStem,
					ownerAgentId,
					archived: true
				};
			}
		}
		return {
			stem: mdStem,
			ownerAgentId,
			archived: false
		};
	}
	return null;
}
/**
* Map transcript stem to canonical session store keys (all agents in the combined store).
* Session tools visibility and agent-to-agent policy are enforced by the caller (e.g.
* `createSessionVisibilityGuard`), including cross-agent cases.
*/
function resolveTranscriptStemToSessionKeys(params) {
	const { store } = params;
	const matches = [];
	const parsedStemId = parseUsageCountedSessionIdFromFileName(params.stem.endsWith(".jsonl") ? params.stem : `${params.stem}.jsonl`);
	for (const [sessionKey, entry] of Object.entries(store)) {
		const sessionFile = normalizeOptionalString(entry.sessionFile);
		if (sessionFile) {
			const base = path.basename(sessionFile);
			if ((base.endsWith(".jsonl") ? base.slice(0, -6) : base) === params.stem) {
				matches.push(sessionKey);
				continue;
			}
		}
		if (entry.sessionId === params.stem || parsedStemId && entry.sessionId === parsedStemId) matches.push(sessionKey);
	}
	const deduped = [...new Set(matches)];
	if (deduped.length > 0) return deduped;
	const normalizedStem = normalizeQmdSessionStem(params.stem);
	if (params.allowQmdSlugFallback === true && normalizedStem) for (const [sessionKey, entry] of Object.entries(store)) {
		const sessionFile = normalizeOptionalString(entry.sessionFile);
		if (sessionFile) {
			const base = path.basename(sessionFile);
			if (normalizeQmdSessionStem(base.endsWith(".jsonl") ? base.slice(0, -6) : base) === normalizedStem) {
				matches.push(sessionKey);
				continue;
			}
		}
		if (normalizeQmdSessionStem(entry.sessionId) === normalizedStem) matches.push(sessionKey);
	}
	const normalizedDeduped = [...new Set(matches)];
	if (normalizedDeduped.length > 0) return normalizedDeduped.length === 1 ? normalizedDeduped : [];
	const archivedOwnerAgentId = normalizeOptionalString(params.archivedOwnerAgentId);
	return archivedOwnerAgentId ? [`agent:${normalizeAgentId(archivedOwnerAgentId)}:${params.stem}`] : [];
}
//#endregion
export { extractTranscriptStemFromSessionsMemoryHit as n, resolveTranscriptStemToSessionKeys as r, extractTranscriptIdentityFromSessionsMemoryHit as t };
