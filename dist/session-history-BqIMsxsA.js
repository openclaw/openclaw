import { i as isPathInside } from "./path-B5B-_oAT.js";
import "./path-guards-DOGmBasP.js";
import { m as resolveSessionAgentIds } from "./agent-scope-C1Fl7gAf.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath } from "./paths-kGAxo7MN.js";
import path from "node:path";
import fs from "node:fs/promises";
import { migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
function limitAgentHookHistoryMessages(messages, maxMessages = 100) {
	if (maxMessages <= 0) return [];
	return messages.slice(-maxMessages);
}
function buildAgentHookConversationMessages(params) {
	return [...limitAgentHookHistoryMessages(params.historyMessages ?? []), ...params.currentTurnMessages ?? []];
}
const MAX_CLI_SESSION_HISTORY_MESSAGES = 100;
const RAW_TRANSCRIPT_RESEED_ALLOWED_REASONS = new Set([
	"missing-transcript",
	"system-prompt",
	"mcp",
	"session-expired"
]);
function coerceHistoryText(content) {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => {
		if (!block || typeof block !== "object") return [];
		const text = block.text;
		return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : [];
	}).join("\n").trim();
}
function buildCliSessionHistoryPrompt(params) {
	const maxHistoryChars = params.maxHistoryChars ?? 12288;
	const renderedHistoryRaw = params.messages.flatMap((message) => {
		if (!message || typeof message !== "object") return [];
		const entry = message;
		const role = entry.role === "assistant" ? "Assistant" : entry.role === "user" ? "User" : entry.role === "compactionSummary" ? "Compaction summary" : void 0;
		if (!role) return [];
		const text = entry.role === "compactionSummary" && typeof entry.summary === "string" ? entry.summary.trim() : coerceHistoryText(entry.content);
		return text ? [`${role}: ${text}`] : [];
	}).join("\n\n").trim();
	const renderedHistory = renderedHistoryRaw.length > maxHistoryChars ? `${renderedHistoryRaw.slice(0, maxHistoryChars).trimEnd()}\n[OpenClaw reseed history truncated]` : renderedHistoryRaw;
	if (!renderedHistory) return;
	return [
		"Continue this conversation using the OpenClaw transcript below as prior session history.",
		"Treat it as authoritative context for this fresh CLI session.",
		"",
		"<conversation_history>",
		renderedHistory,
		"</conversation_history>",
		"",
		"<next_user_message>",
		params.prompt,
		"</next_user_message>"
	].join("\n");
}
async function safeRealpath(filePath) {
	try {
		return await fs.realpath(filePath);
	} catch {
		return;
	}
}
function resolveSafeCliSessionFile(params) {
	const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
		sessionKey: params.sessionKey,
		config: params.config,
		agentId: params.agentId
	});
	const pathOptions = resolveSessionFilePathOptions({
		agentId: sessionAgentId ?? defaultAgentId,
		storePath: params.config?.session?.store
	});
	const sessionFile = resolveSessionFilePath(params.sessionId, { sessionFile: params.sessionFile }, pathOptions);
	return {
		sessionFile,
		sessionsDir: pathOptions?.sessionsDir ?? path.dirname(sessionFile)
	};
}
async function loadCliSessionEntries(params) {
	try {
		const { sessionFile, sessionsDir } = resolveSafeCliSessionFile(params);
		const entryStat = await fs.lstat(sessionFile);
		if (!entryStat.isFile() || entryStat.isSymbolicLink()) return [];
		const realSessionsDir = await safeRealpath(sessionsDir) ?? path.resolve(sessionsDir);
		const realSessionFile = await safeRealpath(sessionFile);
		if (!realSessionFile || realSessionFile === realSessionsDir || !isPathInside(realSessionsDir, realSessionFile)) return [];
		const stat = await fs.stat(realSessionFile);
		if (!stat.isFile() || stat.size > 5242880) return [];
		const entries = parseSessionEntries(await fs.readFile(realSessionFile, "utf-8"));
		migrateSessionEntries(entries);
		return entries.filter((entry) => entry.type !== "session");
	} catch {
		return [];
	}
}
async function loadCliSessionHistoryMessages(params) {
	return limitAgentHookHistoryMessages((await loadCliSessionEntries(params)).flatMap((entry) => {
		const candidate = entry;
		return candidate.type === "message" ? [candidate.message] : [];
	}), MAX_CLI_SESSION_HISTORY_MESSAGES);
}
async function loadCliSessionReseedMessages(params) {
	const entries = await loadCliSessionEntries(params);
	const loadRawTail = () => {
		if (params.allowRawTranscriptReseed !== true || !params.rawTranscriptReseedReason || !RAW_TRANSCRIPT_RESEED_ALLOWED_REASONS.has(params.rawTranscriptReseedReason)) return [];
		return limitAgentHookHistoryMessages(entries.flatMap((entry) => {
			const candidate = entry;
			return candidate.type === "message" ? [candidate.message] : [];
		}), MAX_CLI_SESSION_HISTORY_MESSAGES);
	};
	const latestCompactionIndex = entries.findLastIndex((entry) => {
		const candidate = entry;
		return candidate.type === "compaction" && typeof candidate.summary === "string";
	});
	if (latestCompactionIndex < 0) return loadRawTail();
	const compaction = entries[latestCompactionIndex];
	const summary = typeof compaction.summary === "string" ? compaction.summary.trim() : "";
	if (!summary) return loadRawTail();
	const tailMessages = entries.slice(latestCompactionIndex + 1).flatMap((entry) => {
		const candidate = entry;
		return candidate.type === "message" ? [candidate.message] : [];
	});
	return [{
		role: "compactionSummary",
		summary
	}, ...limitAgentHookHistoryMessages(tailMessages, MAX_CLI_SESSION_HISTORY_MESSAGES - 1)];
}
//#endregion
export { buildAgentHookConversationMessages as i, loadCliSessionHistoryMessages as n, loadCliSessionReseedMessages as r, buildCliSessionHistoryPrompt as t };
