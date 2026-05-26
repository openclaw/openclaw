import { c as normalizeOptionalString, f as readStringValue } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import "./model-selection-P-81eBKx.js";
import { n as stripInboundMetadata } from "./strip-inbound-meta-D2-__BeH.js";
import { t as attachOpenClawTranscriptMeta } from "./session-utils.fs-CsnHXIqH.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/chat/tool-content.ts
function normalizeToolContentType(value) {
	return typeof value === "string" ? value.toLowerCase() : "";
}
function isToolCallContentType(value) {
	const type = normalizeToolContentType(value);
	return type === "toolcall" || type === "tool_call" || type === "tooluse" || type === "tool_use";
}
function isToolResultContentType(value) {
	const type = normalizeToolContentType(value);
	return type === "toolresult" || type === "tool_result";
}
function isToolCallBlock(block) {
	return isToolCallContentType(block.type);
}
function isToolResultBlock(block) {
	return isToolResultContentType(block.type);
}
function resolveToolUseId(block) {
	return typeof block.id === "string" && block.id.trim() || typeof block.tool_use_id === "string" && block.tool_use_id.trim() || typeof block.toolUseId === "string" && block.toolUseId.trim() || void 0;
}
//#endregion
//#region src/gateway/cli-session-history.claude.ts
const CLAUDE_CLI_PROVIDER = "claude-cli";
const CLAUDE_PROJECTS_RELATIVE_DIR = path.join(".claude", "projects");
function resolveHistoryHomeDir(homeDir) {
	return normalizeOptionalString(homeDir) || process.env.HOME || os.homedir();
}
function resolveClaudeProjectsDir(homeDir) {
	return path.join(resolveHistoryHomeDir(homeDir), CLAUDE_PROJECTS_RELATIVE_DIR);
}
function resolveClaudeCliBindingSessionId(entry) {
	const bindingSessionId = normalizeOptionalString(entry?.cliSessionBindings?.[CLAUDE_CLI_PROVIDER]?.sessionId);
	if (bindingSessionId) return bindingSessionId;
	const legacyMapSessionId = normalizeOptionalString(entry?.cliSessionIds?.[CLAUDE_CLI_PROVIDER]);
	if (legacyMapSessionId) return legacyMapSessionId;
	return normalizeOptionalString(entry?.claudeCliSessionId) || void 0;
}
function resolveFiniteNumber$1(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function resolveTimestampMs(value) {
	if (typeof value !== "string") return;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function resolveClaudeCliUsage(raw) {
	if (!raw || typeof raw !== "object") return;
	const input = resolveFiniteNumber$1(raw.input_tokens);
	const output = resolveFiniteNumber$1(raw.output_tokens);
	const cacheRead = resolveFiniteNumber$1(raw.cache_read_input_tokens);
	const cacheWrite = resolveFiniteNumber$1(raw.cache_creation_input_tokens);
	if (input === void 0 && output === void 0 && cacheRead === void 0 && cacheWrite === void 0) return;
	return {
		...input !== void 0 ? { input } : {},
		...output !== void 0 ? { output } : {},
		...cacheRead !== void 0 ? { cacheRead } : {},
		...cacheWrite !== void 0 ? { cacheWrite } : {}
	};
}
function cloneJsonValue(value) {
	return structuredClone(value);
}
function normalizeClaudeCliContent(content, toolNameRegistry) {
	if (!Array.isArray(content)) return cloneJsonValue(content);
	const normalized = [];
	for (const item of content) {
		if (!item || typeof item !== "object") {
			normalized.push(cloneJsonValue(item));
			continue;
		}
		const block = cloneJsonValue(item);
		const type = typeof block.type === "string" ? block.type : "";
		if (type === "tool_use") {
			const id = normalizeOptionalString(block.id) ?? "";
			const name = normalizeOptionalString(block.name) ?? "";
			if (id && name) toolNameRegistry.set(id, name);
			if (block.input !== void 0 && block.arguments === void 0) block.arguments = cloneJsonValue(block.input);
			block.type = "toolcall";
			delete block.input;
			normalized.push(block);
			continue;
		}
		if (type === "tool_result") {
			const toolUseId = resolveToolUseId(block);
			if (!block.name && toolUseId) {
				const toolName = toolNameRegistry.get(toolUseId);
				if (toolName) block.name = toolName;
			}
			normalized.push(block);
			continue;
		}
		normalized.push(block);
	}
	return normalized;
}
function getMessageBlocks(message) {
	if (!message || typeof message !== "object") return null;
	const content = message.content;
	return Array.isArray(content) ? content : null;
}
function isAssistantToolCallMessage(message) {
	if (!message || typeof message !== "object") return false;
	if (message.role !== "assistant") return false;
	const blocks = getMessageBlocks(message);
	return Boolean(blocks && blocks.length > 0 && blocks.every(isToolCallBlock));
}
function isUserToolResultMessage(message) {
	if (!message || typeof message !== "object") return false;
	if (message.role !== "user") return false;
	const blocks = getMessageBlocks(message);
	return Boolean(blocks && blocks.length > 0 && blocks.every(isToolResultBlock));
}
function coalesceClaudeCliToolMessages(messages) {
	const coalesced = [];
	for (let index = 0; index < messages.length; index += 1) {
		const current = messages[index];
		const next = messages[index + 1];
		if (!isAssistantToolCallMessage(current) || !isUserToolResultMessage(next)) {
			coalesced.push(current);
			continue;
		}
		const callBlocks = getMessageBlocks(current) ?? [];
		const resultBlocks = getMessageBlocks(next) ?? [];
		const callIds = new Set(callBlocks.map(resolveToolUseId).filter((id) => Boolean(id)));
		if (!(resultBlocks.length > 0 && resultBlocks.every((block) => {
			const toolUseId = resolveToolUseId(block);
			return Boolean(toolUseId && callIds.has(toolUseId));
		}))) {
			coalesced.push(current);
			continue;
		}
		coalesced.push({
			...current,
			content: [...callBlocks.map(cloneJsonValue), ...resultBlocks.map(cloneJsonValue)]
		});
		index += 1;
	}
	return coalesced;
}
function parseClaudeCliHistoryEntry(entry, cliSessionId, toolNameRegistry) {
	if (entry.isSidechain === true || !entry.message || typeof entry.message !== "object") return null;
	const type = typeof entry.type === "string" ? entry.type : void 0;
	const role = typeof entry.message.role === "string" ? entry.message.role : void 0;
	if (type !== "user" && type !== "assistant" || role !== type) return null;
	const timestamp = resolveTimestampMs(entry.timestamp);
	const baseMeta = {
		importedFrom: CLAUDE_CLI_PROVIDER,
		cliSessionId,
		...normalizeOptionalString(entry.uuid) ? { externalId: entry.uuid } : {}
	};
	const content = typeof entry.message.content === "string" || Array.isArray(entry.message.content) ? normalizeClaudeCliContent(entry.message.content, toolNameRegistry) : void 0;
	if (content === void 0) return null;
	if (type === "user") return attachOpenClawTranscriptMeta({
		role: "user",
		content,
		...timestamp !== void 0 ? { timestamp } : {}
	}, baseMeta);
	return attachOpenClawTranscriptMeta({
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: CLAUDE_CLI_PROVIDER,
		...normalizeOptionalString(entry.message.model) ? { model: entry.message.model } : {},
		...normalizeOptionalString(entry.message.stop_reason) ? { stopReason: entry.message.stop_reason } : {},
		...resolveClaudeCliUsage(entry.message.usage) ? { usage: resolveClaudeCliUsage(entry.message.usage) } : {},
		...timestamp !== void 0 ? { timestamp } : {}
	}, baseMeta);
}
function resolveClaudeCliSessionFilePath(params) {
	const sessionId = params.cliSessionId.trim();
	if (!sessionId || sessionId === "." || sessionId === ".." || path.isAbsolute(sessionId) || sessionId.includes("/") || sessionId.includes("\\")) return;
	const projectsDir = resolveClaudeProjectsDir(params.homeDir);
	let projectEntries;
	try {
		projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of projectEntries) {
		if (!entry.isDirectory()) continue;
		const projectDir = path.join(projectsDir, entry.name);
		const candidate = path.resolve(projectDir, `${sessionId}.jsonl`);
		const resolvedProjectDir = path.resolve(projectDir);
		if (!candidate.startsWith(`${resolvedProjectDir}${path.sep}`)) continue;
		if (fs.existsSync(candidate)) return candidate;
	}
}
function readClaudeCliSessionMessages(params) {
	const filePath = resolveClaudeCliSessionFilePath(params);
	if (!filePath) return [];
	let content;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}
	const messages = [];
	const toolNameRegistry = /* @__PURE__ */ new Map();
	for (const line of content.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const message = parseClaudeCliHistoryEntry(JSON.parse(line), params.cliSessionId, toolNameRegistry);
			if (message) messages.push(message);
		} catch {}
	}
	return coalesceClaudeCliToolMessages(messages);
}
function isCompactBoundary(entry) {
	if (entry.type !== "system") return false;
	const subtype = entry.subtype;
	return typeof subtype === "string" && subtype === "compact_boundary";
}
function extractCompactBoundaryFallbackText(entry) {
	const content = entry.content;
	return typeof content === "string" && content.trim() ? content.trim() : void 0;
}
function extractSummaryText(entry) {
	if (entry.type !== "summary") return;
	const summary = entry.summary;
	return typeof summary === "string" && summary.trim() ? summary.trim() : void 0;
}
function readClaudeCliFallbackSeed(params) {
	const filePath = resolveClaudeCliSessionFilePath(params);
	if (!filePath) return;
	let content;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return;
	}
	let pendingSummary;
	let lastSummary;
	let lastBoundaryFallback;
	let windowedTurns = [];
	const toolNameRegistry = /* @__PURE__ */ new Map();
	for (const line of content.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const explicitSummary = extractSummaryText(parsed);
		if (explicitSummary) {
			pendingSummary = explicitSummary;
			continue;
		}
		if (isCompactBoundary(parsed)) {
			lastSummary = pendingSummary;
			pendingSummary = void 0;
			lastBoundaryFallback = extractCompactBoundaryFallbackText(parsed) ?? lastBoundaryFallback;
			windowedTurns = [];
			toolNameRegistry.clear();
			continue;
		}
		const message = parseClaudeCliHistoryEntry(parsed, params.cliSessionId, toolNameRegistry);
		if (message) windowedTurns.push(message);
	}
	const recentTurns = coalesceClaudeCliToolMessages(windowedTurns);
	const resolvedSummaryText = lastSummary ?? pendingSummary ?? lastBoundaryFallback;
	if (!resolvedSummaryText && recentTurns.length === 0) return;
	return {
		...resolvedSummaryText ? { summaryText: resolvedSummaryText } : {},
		recentTurns
	};
}
//#endregion
//#region src/gateway/cli-session-history.merge.ts
const DEDUPE_TIMESTAMP_WINDOW_MS = 300 * 1e3;
function extractComparableText(message) {
	if (!message || typeof message !== "object") return;
	const record = message;
	const role = readStringValue(record.role);
	const parts = [];
	const text = readStringValue(record.text);
	if (text !== void 0) parts.push(text);
	const content = readStringValue(record.content);
	if (content !== void 0) parts.push(content);
	else if (Array.isArray(record.content)) {
		for (const block of record.content) if (block && typeof block === "object" && "text" in block) {
			const blockText = readStringValue(block.text);
			if (blockText !== void 0) parts.push(blockText);
		}
	}
	if (parts.length === 0) return;
	const joined = parts.join("\n").trim();
	if (!joined) return;
	return (role === "user" ? stripInboundMetadata(joined) : joined).replace(/\s+/g, " ").trim() || void 0;
}
function resolveFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function resolveComparableTimestamp(message) {
	if (!message || typeof message !== "object") return;
	return resolveFiniteNumber(message.timestamp);
}
function resolveComparableRole(message) {
	if (!message || typeof message !== "object") return;
	return readStringValue(message.role);
}
function resolveImportedExternalId(message) {
	if (!message || typeof message !== "object") return;
	return normalizeOptionalString(("__openclaw" in message && message["__openclaw"] && typeof message["__openclaw"] === "object" ? message["__openclaw"] ?? {} : void 0)?.externalId);
}
function isEquivalentImportedMessage(existing, imported) {
	const importedExternalId = resolveImportedExternalId(imported);
	if (importedExternalId && resolveImportedExternalId(existing) === importedExternalId) return true;
	const existingRole = resolveComparableRole(existing);
	const importedRole = resolveComparableRole(imported);
	if (!existingRole || existingRole !== importedRole) return false;
	const existingText = extractComparableText(existing);
	const importedText = extractComparableText(imported);
	if (!existingText || !importedText || existingText !== importedText) return false;
	const existingTimestamp = resolveComparableTimestamp(existing);
	const importedTimestamp = resolveComparableTimestamp(imported);
	if (existingTimestamp === void 0 || importedTimestamp === void 0) return true;
	return Math.abs(existingTimestamp - importedTimestamp) <= DEDUPE_TIMESTAMP_WINDOW_MS;
}
function compareHistoryMessages(a, b) {
	const aTimestamp = resolveComparableTimestamp(a.message);
	const bTimestamp = resolveComparableTimestamp(b.message);
	if (aTimestamp !== void 0 && bTimestamp !== void 0 && aTimestamp !== bTimestamp) return aTimestamp - bTimestamp;
	if (aTimestamp !== void 0 && bTimestamp === void 0) return -1;
	if (aTimestamp === void 0 && bTimestamp !== void 0) return 1;
	return a.order - b.order;
}
function mergeImportedChatHistoryMessages(params) {
	if (params.importedMessages.length === 0) return params.localMessages;
	const merged = params.localMessages.map((message, index) => ({
		message,
		order: index
	}));
	let nextOrder = merged.length;
	for (const imported of params.importedMessages) {
		if (merged.some((existing) => isEquivalentImportedMessage(existing.message, imported))) continue;
		merged.push({
			message: imported,
			order: nextOrder
		});
		nextOrder += 1;
	}
	merged.sort(compareHistoryMessages);
	return merged.map((entry) => entry.message);
}
//#endregion
//#region src/gateway/cli-session-history.ts
const ANTHROPIC_PROVIDER = "anthropic";
function augmentChatHistoryWithCliSessionImports(params) {
	const cliSessionId = resolveClaudeCliBindingSessionId(params.entry);
	if (!cliSessionId) return params.localMessages;
	const normalizedProvider = normalizeProviderId(params.provider ?? "");
	if (normalizedProvider && normalizedProvider !== "claude-cli" && normalizedProvider !== ANTHROPIC_PROVIDER && params.localMessages.length > 0) return params.localMessages;
	const importedMessages = readClaudeCliSessionMessages({
		cliSessionId,
		homeDir: params.homeDir
	});
	return mergeImportedChatHistoryMessages({
		localMessages: params.localMessages,
		importedMessages
	});
}
//#endregion
export { readClaudeCliFallbackSeed as n, augmentChatHistoryWithCliSessionImports as t };
