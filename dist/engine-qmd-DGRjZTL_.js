import { s as redactSensitiveText } from "./redact-ok5Q8nmw.js";
import { o as statRegularFile, r as readRegularFile } from "./regular-file-DaVeNX32.js";
import { r as isCronRunSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { a as hasInterSessionUserProvenance } from "./input-provenance-CmqYxlZ2.js";
import { c as isUsageCountedSessionTranscriptFileName, d as parseUsageCountedSessionIdFromFileName, i as isSessionArchiveArtifactName, n as isCompactionCheckpointTranscriptFileName } from "./artifacts-BZhcmsUl.js";
import { l as resolveSessionTranscriptsDirForAgent } from "./paths-Bg3PO6Gj.js";
import { u as stripInternalRuntimeContext } from "./internal-runtime-context-DWxvZFcB.js";
import { n as stripInboundMetadata } from "./strip-inbound-meta-D2-__BeH.js";
import { r as isSilentReplyPayloadText } from "./tokens-CFv3Qu_v.js";
import { n as HEARTBEAT_PROMPT } from "./heartbeat-6oYmHVVQ.js";
import { r as isHeartbeatUserMessage } from "./heartbeat-filter-Crwj3kBD.js";
import { a as resolveWindowsSpawnProgram, r as materializeWindowsSpawnProgram } from "./windows-spawn-B76fGM3V.js";
import { n as normalizeOptionalLowercaseString, t as normalizeLowercaseStringOrEmpty } from "./string-utils-xCz9RTVk.js";
import "./query-expansion-BMvljseN.js";
import { i as isExecCompletionEvent } from "./heartbeat-events-filter-Dro189NQ.js";
import "./openclaw-runtime-session-B0KU6IIj.js";
import { t as formatErrorMessage } from "./error-utils-PBAKtEPD.js";
import "./fs-utils-DdhuqF2m.js";
import { t as hashText } from "./hash-C0FSXO-A.js";
import fs, { statSync } from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { spawn } from "node:child_process";
//#region packages/memory-host-sdk/src/host/session-files.ts
const DREAMING_NARRATIVE_RUN_PREFIX = "dreaming-narrative-";
const SESSION_EXPORT_CONTENT_WRAP_CHARS = 800;
const SESSION_ENTRY_PARSE_YIELD_LINES = 250;
const DIRECT_CRON_PROMPT_RE = /^\[cron:[^\]]+\]\s*/;
function shouldSkipTranscriptFileForDreaming(absPath) {
	const fileName = path.basename(absPath);
	if (isCompactionCheckpointTranscriptFileName(fileName)) return true;
	if (isSessionArchiveArtifactName(fileName) && !isUsageCountedSessionTranscriptFileName(fileName)) return true;
	return false;
}
function isUsageCountedSessionArchiveTranscriptPath(absPath) {
	const fileName = path.basename(absPath);
	return isUsageCountedSessionTranscriptFileName(fileName) && isSessionArchiveArtifactName(fileName) && parseUsageCountedSessionIdFromFileName(fileName) !== null;
}
function isDreamingNarrativeBootstrapRecord(record) {
	if (!record || typeof record !== "object" || Array.isArray(record)) return false;
	const candidate = record;
	if (candidate.type !== "custom" || candidate.customType !== "openclaw:bootstrap-context:full" || !candidate.data || typeof candidate.data !== "object" || Array.isArray(candidate.data)) return false;
	const runId = candidate.data.runId;
	return typeof runId === "string" && runId.startsWith(DREAMING_NARRATIVE_RUN_PREFIX);
}
function hasDreamingNarrativeRunId(value) {
	return typeof value === "string" && value.startsWith(DREAMING_NARRATIVE_RUN_PREFIX);
}
function isDreamingNarrativeGeneratedRecord(record) {
	if (isDreamingNarrativeBootstrapRecord(record)) return true;
	if (!record || typeof record !== "object" || Array.isArray(record)) return false;
	const candidate = record;
	if (hasDreamingNarrativeRunId(candidate.runId) || hasDreamingNarrativeRunId(candidate.sessionKey)) return true;
	if (!candidate.data || typeof candidate.data !== "object" || Array.isArray(candidate.data)) return false;
	const nested = candidate.data;
	return hasDreamingNarrativeRunId(nested.runId) || hasDreamingNarrativeRunId(nested.sessionKey);
}
function isDreamingNarrativeSessionStoreKey(sessionKey) {
	const trimmed = sessionKey.trim();
	if (!trimmed) return false;
	const firstSeparator = trimmed.indexOf(":");
	if (firstSeparator < 0) return trimmed.startsWith(DREAMING_NARRATIVE_RUN_PREFIX);
	const secondSeparator = trimmed.indexOf(":", firstSeparator + 1);
	return (secondSeparator < 0 ? trimmed : trimmed.slice(secondSeparator + 1)).startsWith(DREAMING_NARRATIVE_RUN_PREFIX);
}
function hasCronRunSessionKey(value) {
	return typeof value === "string" && isCronRunSessionKey(value);
}
function isCronRunGeneratedRecord(record) {
	if (!record || typeof record !== "object" || Array.isArray(record)) return false;
	const candidate = record;
	if (hasCronRunSessionKey(candidate.sessionKey)) return true;
	if (!candidate.data || typeof candidate.data !== "object" || Array.isArray(candidate.data)) return false;
	const nested = candidate.data;
	return hasCronRunSessionKey(nested.sessionKey);
}
function normalizeComparablePath(pathname) {
	const resolved = path.resolve(pathname);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function normalizeSessionTranscriptPathForComparison(pathname) {
	return normalizeComparablePath(pathname);
}
function resolveSessionStoreTranscriptPath(sessionsDir, entry) {
	if (typeof entry?.sessionFile === "string" && entry.sessionFile.trim().length > 0) {
		const sessionFile = entry.sessionFile.trim();
		return normalizeComparablePath(path.isAbsolute(sessionFile) ? sessionFile : path.resolve(sessionsDir, sessionFile));
	}
	if (typeof entry?.sessionId === "string" && entry.sessionId.trim().length > 0) return normalizeComparablePath(path.join(sessionsDir, `${entry.sessionId.trim()}.jsonl`));
	return null;
}
function loadSessionTranscriptClassificationForSessionsDir(sessionsDir) {
	const store = readSessionTranscriptClassificationStore(path.join(sessionsDir, "sessions.json"));
	const dreamingTranscriptPaths = /* @__PURE__ */ new Set();
	const cronRunTranscriptPaths = /* @__PURE__ */ new Set();
	for (const [sessionKey, entry] of Object.entries(store)) {
		const transcriptPath = resolveSessionStoreTranscriptPath(sessionsDir, entry);
		if (!transcriptPath) continue;
		if (isDreamingNarrativeSessionStoreKey(sessionKey)) dreamingTranscriptPaths.add(transcriptPath);
		if (isCronRunSessionKey(sessionKey)) cronRunTranscriptPaths.add(transcriptPath);
	}
	return {
		dreamingNarrativeTranscriptPaths: dreamingTranscriptPaths,
		cronRunTranscriptPaths
	};
}
function readSessionTranscriptClassificationStore(storePath) {
	try {
		const parsed = JSON.parse(fs.readFileSync(storePath, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed;
	} catch {
		return {};
	}
}
function loadDreamingNarrativeTranscriptPathSetForAgent(agentId) {
	return loadSessionTranscriptClassificationForAgent(agentId).dreamingNarrativeTranscriptPaths;
}
function loadSessionTranscriptClassificationForAgent(agentId) {
	return loadSessionTranscriptClassificationForSessionsDir(resolveSessionTranscriptsDirForAgent(agentId));
}
function classifySessionTranscriptFromSessionStore(absPath) {
	const sessionsDir = path.dirname(absPath);
	const normalizedAbsPath = normalizeComparablePath(absPath);
	const primarySessionId = parseUsageCountedSessionIdFromFileName(path.basename(absPath));
	const normalizedPrimaryPath = primarySessionId && isSessionArchiveArtifactName(path.basename(absPath)) ? normalizeComparablePath(path.join(sessionsDir, `${primarySessionId}.jsonl`)) : null;
	const classification = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);
	const hasClassifiedPath = (paths) => paths.has(normalizedAbsPath) || normalizedPrimaryPath !== null && paths.has(normalizedPrimaryPath);
	return {
		generatedByDreamingNarrative: hasClassifiedPath(classification.dreamingNarrativeTranscriptPaths),
		generatedByCronRun: hasClassifiedPath(classification.cronRunTranscriptPaths)
	};
}
async function listSessionFilesForAgent(agentId) {
	const dir = resolveSessionTranscriptsDirForAgent(agentId);
	try {
		return (await fs$1.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).filter((name) => isUsageCountedSessionTranscriptFileName(name)).map((name) => path.join(dir, name));
	} catch {
		return [];
	}
}
function extractAgentIdFromSessionPath(absPath) {
	const parts = path.normalize(path.resolve(absPath)).split(path.sep).filter(Boolean);
	const sessionsIndex = parts.lastIndexOf("sessions");
	if (sessionsIndex < 2 || parts[sessionsIndex - 2] !== "agents") return null;
	return parts[sessionsIndex - 1] || null;
}
function sessionPathForFile(absPath) {
	const agentId = extractAgentIdFromSessionPath(absPath);
	return path.join("sessions", ...agentId ? [agentId] : [], path.basename(absPath)).replace(/\\/g, "/");
}
async function logSessionFileReadFailure(absPath, err) {
	createSubsystemLogger("memory").debug(`Failed reading session file ${absPath}: ${String(err)}`);
}
function normalizeSessionText(value) {
	return value.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
}
function collectRawSessionText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block;
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.length > 0 ? parts.join("\n") : null;
}
function isHighSurrogate(code) {
	return code >= 55296 && code <= 56319;
}
function isLowSurrogate(code) {
	return code >= 56320 && code <= 57343;
}
function splitLongSessionLine(text, maxChars = SESSION_EXPORT_CONTENT_WRAP_CHARS) {
	const normalized = text.trim();
	if (!normalized) return [];
	if (normalized.length <= maxChars) return [normalized];
	const segments = [];
	let cursor = 0;
	while (cursor < normalized.length) {
		if (normalized.length - cursor <= maxChars) {
			segments.push(normalized.slice(cursor).trim());
			break;
		}
		const limit = cursor + maxChars;
		let splitAt = limit;
		for (let index = limit; index > cursor; index -= 1) if (normalized[index] === " ") {
			splitAt = index;
			break;
		}
		if (splitAt < normalized.length && splitAt > cursor && isHighSurrogate(normalized.charCodeAt(splitAt - 1)) && isLowSurrogate(normalized.charCodeAt(splitAt))) splitAt -= 1;
		segments.push(normalized.slice(cursor, splitAt).trim());
		cursor = splitAt;
		while (cursor < normalized.length && normalized[cursor] === " ") cursor += 1;
	}
	return segments.filter(Boolean);
}
function renderSessionExportLines(label, text) {
	return splitLongSessionLine(text).map((segment) => `${label}: ${segment}`);
}
/**
* Strip OpenClaw-injected inbound metadata envelopes from a raw text block.
*
* User-role messages arriving from external channels (Telegram, Discord,
* Slack, …) are stored with a multi-line prefix containing Conversation info,
* Sender info, and other AI-facing metadata blocks. These envelopes must be
* removed BEFORE normalization, because `stripInboundMetadata` relies on
* newline structure and fenced `json` code fences to locate sentinels; once
* `normalizeSessionText` collapses newlines into spaces, stripping is
* impossible.
*
* See: https://github.com/openclaw/openclaw/issues/63921
*/
function stripInboundMetadataForUserRole(text, role) {
	if (role !== "user") return text;
	return stripInboundMetadata(text);
}
const GENERATED_SYSTEM_MESSAGE_RE = /^System(?: \(untrusted\))?: \[[^\]]+\]\s*/;
function isGeneratedSystemWrapperMessage(text, role) {
	if (role !== "user") return false;
	return GENERATED_SYSTEM_MESSAGE_RE.test(text);
}
function isGeneratedCronPromptMessage(text, role) {
	if (role !== "user") return false;
	return DIRECT_CRON_PROMPT_RE.test(text);
}
function isGeneratedHeartbeatPromptMessage(text, role) {
	return role === "user" && isHeartbeatUserMessage({
		role,
		content: text
	}, HEARTBEAT_PROMPT);
}
function sanitizeSessionText(text, role) {
	const normalized = normalizeSessionText(stripInternalRuntimeContext(stripInboundMetadataForUserRole(text, role)));
	if (!normalized) return null;
	if (isGeneratedSystemWrapperMessage(normalized, role)) return null;
	if (isGeneratedCronPromptMessage(normalized, role)) return null;
	if (isGeneratedHeartbeatPromptMessage(normalized, role)) return null;
	if (isSilentReplyPayloadText(normalized)) return null;
	if (role === "assistant" && normalized === "HEARTBEAT_OK") return null;
	if (isExecCompletionEvent(normalized.replace(GENERATED_SYSTEM_MESSAGE_RE, "").trim())) return null;
	return normalized;
}
function parseSessionTimestampMs(record, message) {
	const candidates = [message.timestamp, record.timestamp];
	for (const value of candidates) {
		if (typeof value === "number" && Number.isFinite(value)) {
			const ms = value > 0 && value < 1e11 ? value * 1e3 : value;
			if (Number.isFinite(ms) && ms > 0) return ms;
		}
		if (typeof value === "string") {
			const parsed = Date.parse(value);
			if (Number.isFinite(parsed) && parsed > 0) return parsed;
		}
	}
	return 0;
}
function resolveSessionEntryParseYieldLines(opts) {
	const configured = opts.parseYieldEveryLines;
	if (typeof configured === "number" && Number.isFinite(configured)) return Math.max(1, Math.floor(configured));
	return SESSION_ENTRY_PARSE_YIELD_LINES;
}
async function yieldSessionEntryParseIfNeeded(lineIndex, everyLines) {
	if (lineIndex > 0 && lineIndex % everyLines === 0) await new Promise((resolve) => {
		setImmediate(resolve);
	});
}
async function buildSessionEntry(absPath, opts = {}) {
	try {
		const regularFile = await statRegularFile(absPath);
		if (regularFile.missing) return null;
		const stat = regularFile.stat;
		if (shouldSkipTranscriptFileForDreaming(absPath)) return {
			path: sessionPathForFile(absPath),
			absPath,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			hash: hashText("\n\n"),
			content: "",
			lineMap: [],
			messageTimestampsMs: []
		};
		const raw = (await readRegularFile({ filePath: absPath })).buffer.toString("utf-8");
		const collected = [];
		const lineMap = [];
		const messageTimestampsMs = [];
		const parseYieldEveryLines = resolveSessionEntryParseYieldLines(opts);
		const sessionStoreClassification = opts.generatedByDreamingNarrative === void 0 || opts.generatedByCronRun === void 0 ? classifySessionTranscriptFromSessionStore(absPath) : null;
		let generatedByDreamingNarrative = opts.generatedByDreamingNarrative ?? sessionStoreClassification?.generatedByDreamingNarrative ?? false;
		let generatedByCronRun = opts.generatedByCronRun ?? sessionStoreClassification?.generatedByCronRun ?? false;
		const allowArchiveContentCronClassification = isUsageCountedSessionArchiveTranscriptPath(absPath);
		for (let jsonlIdx = 0, lineStart = 0; lineStart <= raw.length; jsonlIdx++) {
			await yieldSessionEntryParseIfNeeded(jsonlIdx, parseYieldEveryLines);
			const newlineIndex = raw.indexOf("\n", lineStart);
			const lineEnd = newlineIndex === -1 ? raw.length : newlineIndex;
			const line = raw.slice(lineStart, lineEnd);
			lineStart = newlineIndex === -1 ? raw.length + 1 : newlineIndex + 1;
			if (!line.trim()) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (!generatedByDreamingNarrative && isDreamingNarrativeGeneratedRecord(record)) generatedByDreamingNarrative = true;
			if (!generatedByCronRun && allowArchiveContentCronClassification && isCronRunGeneratedRecord(record)) {
				generatedByCronRun = true;
				collected.length = 0;
				lineMap.length = 0;
				messageTimestampsMs.length = 0;
			}
			if (!record || typeof record !== "object" || record.type !== "message") continue;
			const message = record.message;
			if (!message || typeof message.role !== "string") continue;
			if (message.role !== "user" && message.role !== "assistant") continue;
			if (message.role === "user" && hasInterSessionUserProvenance(message)) continue;
			const rawText = collectRawSessionText(message.content);
			if (rawText === null) continue;
			if (!generatedByCronRun && allowArchiveContentCronClassification && isGeneratedCronPromptMessage(normalizeSessionText(rawText), message.role)) {
				generatedByCronRun = true;
				collected.length = 0;
				lineMap.length = 0;
				messageTimestampsMs.length = 0;
			}
			const text = sanitizeSessionText(rawText, message.role);
			if (!text) continue;
			if (generatedByDreamingNarrative || generatedByCronRun) continue;
			const safe = redactSensitiveText(text, { mode: "tools" });
			const renderedLines = renderSessionExportLines(message.role === "user" ? "User" : "Assistant", safe);
			const timestampMs = parseSessionTimestampMs(record, message);
			collected.push(...renderedLines);
			lineMap.push(...renderedLines.map(() => jsonlIdx + 1));
			messageTimestampsMs.push(...renderedLines.map(() => timestampMs));
		}
		const content = collected.join("\n");
		return {
			path: sessionPathForFile(absPath),
			absPath,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			hash: hashText(content + "\n" + lineMap.join(",") + "\n" + messageTimestampsMs.join(",")),
			content,
			lineMap,
			messageTimestampsMs,
			...generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {},
			...generatedByCronRun ? { generatedByCronRun: true } : {}
		};
	} catch (err) {
		logSessionFileReadFailure(absPath, err);
		return null;
	}
}
//#endregion
//#region packages/memory-host-sdk/src/host/qmd-query-parser.ts
function parseQmdQueryJson(stdout, stderr) {
	const trimmedStdout = stdout.trim();
	const trimmedStderr = stderr.trim();
	const stdoutIsMarker = trimmedStdout.length > 0 && isQmdNoResultsOutput(trimmedStdout);
	const stderrIsMarker = trimmedStderr.length > 0 && isQmdNoResultsOutput(trimmedStderr);
	if (stdoutIsMarker || !trimmedStdout && stderrIsMarker) return [];
	if (!trimmedStdout) {
		const message = `stdout empty${trimmedStderr ? ` (stderr: ${summarizeQmdStderr(trimmedStderr)})` : ""}`;
		warnQmdQueryParseError(message);
		throw new Error(`qmd query returned invalid JSON: ${message}`);
	}
	try {
		const parsed = parseQmdQueryResultArray(trimmedStdout);
		if (parsed !== null) return parsed;
		const noisyPayload = extractFirstJsonArray(trimmedStdout);
		if (!noisyPayload) throw new Error("qmd query JSON response was not an array");
		const fallback = parseQmdQueryResultArray(noisyPayload);
		if (fallback !== null) return fallback;
		throw new Error("qmd query JSON response was not an array");
	} catch (err) {
		const message = formatErrorMessage(err);
		warnQmdQueryParseError(message);
		throw new Error(`qmd query returned invalid JSON: ${message}`, { cause: err });
	}
}
function warnQmdQueryParseError(message) {
	if (process.env.VITEST || false) return;
	process.stderr.write(`qmd query returned invalid JSON: ${message}\n`);
}
function isQmdNoResultsOutput(raw) {
	return raw.split(/\r?\n/).map((line) => normalizeLowercaseStringOrEmpty(line).replace(/\s+/g, " ")).filter((line) => line.length > 0).some((line) => isQmdNoResultsLine(line));
}
function isQmdNoResultsLine(line) {
	if (line === "no results found" || line === "no results found.") return true;
	return /^(?:\[[^\]]+\]\s*)?(?:(?:warn(?:ing)?|info|error|qmd)\s*:\s*)+no results found\.?$/.test(line);
}
function summarizeQmdStderr(raw) {
	return raw.length <= 120 ? raw : `${raw.slice(0, 117)}...`;
}
function parseQmdQueryResultArray(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		return parsed.map((item) => {
			if (typeof item !== "object" || item === null) return item;
			const record = item;
			return {
				docid: typeof record.docid === "string" ? record.docid : void 0,
				score: typeof record.score === "number" && Number.isFinite(record.score) ? record.score : void 0,
				collection: typeof record.collection === "string" ? record.collection : void 0,
				file: typeof record.file === "string" ? record.file : void 0,
				snippet: typeof record.snippet === "string" ? record.snippet : void 0,
				body: typeof record.body === "string" ? record.body : void 0,
				startLine: parseQmdLineNumber(record.start_line ?? record.startLine),
				endLine: parseQmdLineNumber(record.end_line ?? record.endLine)
			};
		});
	} catch {
		return null;
	}
}
function parseQmdLineNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function extractFirstJsonArray(raw) {
	const start = raw.indexOf("[");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < raw.length; i += 1) {
		const char = raw[i];
		if (char === void 0) break;
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "[") depth += 1;
		else if (char === "]") {
			depth -= 1;
			if (depth === 0) return raw.slice(start, i + 1);
		}
	}
	return null;
}
//#endregion
//#region packages/memory-host-sdk/src/host/qmd-scope.ts
function isQmdScopeAllowed(scope, sessionKey) {
	if (!scope) return true;
	const parsed = parseQmdSessionScope(sessionKey);
	const channel = parsed.channel;
	const chatType = parsed.chatType;
	const normalizedKey = parsed.normalizedKey ?? "";
	const rawKey = normalizeLowercaseStringOrEmpty(sessionKey ?? "");
	for (const rule of scope.rules ?? []) {
		if (!rule) continue;
		const match = rule.match ?? {};
		if (match.channel && match.channel !== channel) continue;
		if (match.chatType && match.chatType !== chatType) continue;
		const normalizedPrefix = normalizeOptionalLowercaseString(match.keyPrefix) || void 0;
		const rawPrefix = normalizeOptionalLowercaseString(match.rawKeyPrefix) || void 0;
		if (rawPrefix && !rawKey.startsWith(rawPrefix)) continue;
		if (normalizedPrefix) {
			if (normalizedPrefix.startsWith("agent:")) {
				if (!rawKey.startsWith(normalizedPrefix)) continue;
			} else if (!normalizedKey.startsWith(normalizedPrefix)) continue;
		}
		return rule.action === "allow";
	}
	return (scope.default ?? "allow") === "allow";
}
function deriveQmdScopeChannel(key) {
	return parseQmdSessionScope(key).channel;
}
function deriveQmdScopeChatType(key) {
	return parseQmdSessionScope(key).chatType;
}
function parseQmdSessionScope(key) {
	const normalized = normalizeQmdSessionKey(key);
	if (!normalized) return {};
	const parts = normalized.split(":").filter(Boolean);
	let chatType;
	if (parts.length >= 2 && (parts[1] === "group" || parts[1] === "channel" || parts[1] === "direct" || parts[1] === "dm")) {
		if (parts.includes("group")) chatType = "group";
		else if (parts.includes("channel")) chatType = "channel";
		return {
			normalizedKey: normalized,
			channel: normalizeOptionalLowercaseString(parts[0]),
			chatType: chatType ?? "direct"
		};
	}
	if (normalized.includes(":group:")) return {
		normalizedKey: normalized,
		chatType: "group"
	};
	if (normalized.includes(":channel:")) return {
		normalizedKey: normalized,
		chatType: "channel"
	};
	return {
		normalizedKey: normalized,
		chatType: "direct"
	};
}
function normalizeQmdSessionKey(key) {
	if (!key) return;
	const trimmed = key.trim();
	if (!trimmed) return;
	const normalized = normalizeLowercaseStringOrEmpty(parseAgentSessionKey(trimmed)?.rest ?? trimmed);
	if (normalized.startsWith("subagent:")) return;
	return normalized;
}
function parseAgentSessionKey(sessionKey) {
	const raw = normalizeOptionalLowercaseString(sessionKey);
	if (!raw) return null;
	const parts = raw.split(":").filter(Boolean);
	if (parts.length < 3 || parts[0] !== "agent") return null;
	const rest = parts.slice(2).join(":");
	return rest ? { rest } : null;
}
//#endregion
//#region packages/memory-host-sdk/src/host/qmd-process.ts
function resolveQmdBinaryUnavailableReason(result) {
	return result.reason ?? "binary";
}
function resolveCliSpawnInvocation(params) {
	return materializeWindowsSpawnProgram(resolveWindowsSpawnProgram({
		command: params.command,
		platform: process.platform,
		env: params.env,
		execPath: process.execPath,
		packageName: params.packageName,
		allowShellFallback: false
	}), params.args);
}
async function checkQmdBinaryAvailability(params) {
	let spawnInvocation;
	try {
		spawnInvocation = resolveCliSpawnInvocation({
			command: params.command,
			args: [],
			env: params.env,
			packageName: "qmd"
		});
	} catch (err) {
		return {
			available: false,
			reason: "binary",
			error: formatQmdAvailabilityError(err)
		};
	}
	const cwd = params.cwd ?? process.cwd();
	const cwdError = validateQmdProbeCwd(cwd);
	if (cwdError) return cwdError;
	return await new Promise((resolve) => {
		let settled = false;
		let didSpawn = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(result);
		};
		const child = spawn(spawnInvocation.command, spawnInvocation.argv, {
			env: params.env,
			cwd,
			shell: spawnInvocation.shell,
			windowsHide: spawnInvocation.windowsHide,
			stdio: "ignore"
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({
				available: false,
				reason: "binary",
				error: `spawn ${params.command} timed out after ${params.timeoutMs ?? 2e3}ms`
			});
		}, params.timeoutMs ?? 2e3);
		child.once("error", (err) => {
			finish({
				available: false,
				reason: "binary",
				error: formatQmdAvailabilityError(err)
			});
		});
		child.once("spawn", () => {
			didSpawn = true;
			child.kill();
			finish({ available: true });
		});
		child.once("close", () => {
			if (!didSpawn) return;
			finish({ available: true });
		});
	});
}
function validateQmdProbeCwd(cwd) {
	try {
		if (!statSync(cwd).isDirectory()) return {
			available: false,
			reason: "workspace-cwd",
			error: `workspace directory is not a directory: ${cwd}`
		};
		return null;
	} catch (err) {
		if (typeof err === "object" && err && "code" in err && err.code === "ENOENT") return {
			available: false,
			reason: "workspace-cwd",
			error: `workspace directory missing: ${cwd}`
		};
		return {
			available: false,
			reason: "workspace-cwd",
			error: `workspace directory unavailable: ${cwd} (${formatQmdAvailabilityError(err)})`
		};
	}
}
async function runCliCommand(params) {
	return await new Promise((resolve, reject) => {
		const child = spawn(params.spawnInvocation.command, params.spawnInvocation.argv, {
			env: params.env,
			cwd: params.cwd,
			shell: params.spawnInvocation.shell,
			windowsHide: params.spawnInvocation.windowsHide
		});
		let stdout = "";
		let stderr = "";
		let stdoutTruncated = false;
		let stderrTruncated = false;
		const discardStdout = params.discardStdout === true;
		const timer = params.timeoutMs ? setTimeout(() => {
			child.kill("SIGKILL");
			reject(/* @__PURE__ */ new Error(`${params.commandSummary} timed out after ${params.timeoutMs}ms`));
		}, params.timeoutMs) : null;
		child.stdout.on("data", (data) => {
			if (discardStdout) return;
			const next = appendOutputWithCap(stdout, data.toString("utf8"), params.maxOutputChars);
			stdout = next.text;
			stdoutTruncated = stdoutTruncated || next.truncated;
		});
		child.stderr.on("data", (data) => {
			const next = appendOutputWithCap(stderr, data.toString("utf8"), params.maxOutputChars);
			stderr = next.text;
			stderrTruncated = stderrTruncated || next.truncated;
		});
		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			if (!discardStdout && (stdoutTruncated || stderrTruncated)) {
				reject(/* @__PURE__ */ new Error(`${params.commandSummary} produced too much output (limit ${params.maxOutputChars} chars)`));
				return;
			}
			if (code === 0) resolve({
				stdout,
				stderr
			});
			else reject(/* @__PURE__ */ new Error(`${params.commandSummary} failed (code ${code}): ${stderr || stdout}`));
		});
	});
}
function appendOutputWithCap(current, chunk, maxChars) {
	const appended = current + chunk;
	if (appended.length <= maxChars) return {
		text: appended,
		truncated: false
	};
	return {
		text: appended.slice(-maxChars),
		truncated: true
	};
}
function formatQmdAvailabilityError(err) {
	if (err instanceof Error && err.message) return err.message;
	return String(err);
}
//#endregion
export { deriveQmdScopeChannel as a, parseQmdQueryJson as c, loadDreamingNarrativeTranscriptPathSetForAgent as d, loadSessionTranscriptClassificationForAgent as f, runCliCommand as i, buildSessionEntry as l, sessionPathForFile as m, resolveCliSpawnInvocation as n, deriveQmdScopeChatType as o, normalizeSessionTranscriptPathForComparison as p, resolveQmdBinaryUnavailableReason as r, isQmdScopeAllowed as s, checkQmdBinaryAvailability as t, listSessionFilesForAgent as u };
