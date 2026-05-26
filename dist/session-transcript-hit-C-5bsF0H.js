import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { c as normalizeAgentId } from "./session-key-DFEyR49L.js";
import "./combined-store-gateway-CrCDV3An.js";
import { d as parseUsageCountedSessionIdFromFileName } from "./artifacts-CZN5dsCJ.js";
import path from "node:path";
//#region src/plugin-sdk/session-transcript-hit.ts
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
		const stem = base.slice(0, -3);
		return stem ? {
			stem,
			archived: false
		} : null;
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
	const archivedOwnerAgentId = normalizeOptionalString(params.archivedOwnerAgentId);
	return archivedOwnerAgentId ? [`agent:${normalizeAgentId(archivedOwnerAgentId)}:${params.stem}`] : [];
}
//#endregion
export { extractTranscriptStemFromSessionsMemoryHit as n, resolveTranscriptStemToSessionKeys as r, extractTranscriptIdentityFromSessionsMemoryHit as t };
