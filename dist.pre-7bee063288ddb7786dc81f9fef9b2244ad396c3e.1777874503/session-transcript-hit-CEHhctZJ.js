import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import "./combined-store-gateway-J6vxmiJL.js";
import { p as parseUsageCountedSessionIdFromFileName } from "./artifacts-DMYJ61NM.js";
import path from "node:path";
//#region src/plugin-sdk/session-transcript-hit.ts
/**
* Derive transcript stem `S` from a memory search hit path for `source === "sessions"`.
* Builtin index uses `sessions/<basename>.jsonl`; QMD exports use `<stem>.md`.
*/
function extractTranscriptStemFromSessionsMemoryHit(hitPath) {
	const normalized = hitPath.replace(/\\/g, "/");
	const trimmed = normalized.startsWith("sessions/") ? normalized.slice(9) : normalized;
	const base = path.basename(trimmed);
	if (base.endsWith(".jsonl")) return base.slice(0, -6) || null;
	if (base.endsWith(".md")) return base.slice(0, -3) || null;
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
	return [...new Set(matches)];
}
//#endregion
export { resolveTranscriptStemToSessionKeys as n, extractTranscriptStemFromSessionsMemoryHit as t };
