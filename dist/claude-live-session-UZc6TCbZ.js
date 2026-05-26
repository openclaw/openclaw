import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { c as isRecord$1 } from "./utils-sBTEdeml.js";
import "./pi-embedded-helpers-bmljPI1n.js";
import { t as classifyFailoverReason } from "./errors-DYND-qcd.js";
import { c as resolveFailoverStatus, t as FailoverError } from "./failover-error-CZCIurQK.js";
import { t as extractBalancedJsonFragments } from "./balanced-json-YUc2rvlg.js";
import { r as cliBackendLog } from "./log-BqkNcamx.js";
import crypto from "node:crypto";
//#region src/agents/cli-output.ts
function isClaudeCliProvider(providerId) {
	return normalizeLowercaseStringOrEmpty(providerId) === "claude-cli";
}
function usesClaudeStreamJsonDialect(params) {
	return params.backend.jsonlDialect === "claude-stream-json" || isClaudeCliProvider(params.providerId);
}
function extractJsonObjectCandidates(raw) {
	return extractBalancedJsonFragments(raw, { openers: ["{"] }).map((fragment) => fragment.json);
}
function parseJsonRecordCandidates(raw) {
	const parsedRecords = [];
	const trimmed = raw.trim();
	if (!trimmed) return parsedRecords;
	try {
		const parsed = JSON.parse(trimmed);
		if (isRecord$1(parsed)) {
			parsedRecords.push(parsed);
			return parsedRecords;
		}
	} catch {}
	for (const candidate of extractJsonObjectCandidates(trimmed)) try {
		const parsed = JSON.parse(candidate);
		if (isRecord$1(parsed)) parsedRecords.push(parsed);
	} catch {}
	return parsedRecords;
}
function readNestedErrorMessage(parsed) {
	if (isRecord$1(parsed.error)) {
		const errorMessage = readNestedErrorMessage(parsed.error);
		if (errorMessage) return errorMessage;
	}
	if (typeof parsed.message === "string") {
		const trimmed = parsed.message.trim();
		if (trimmed) return trimmed;
	}
	if (typeof parsed.error === "string") {
		const trimmed = parsed.error.trim();
		if (trimmed) return trimmed;
	}
}
function unwrapCliErrorText(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	for (const parsed of parseJsonRecordCandidates(trimmed)) {
		const nested = readNestedErrorMessage(parsed);
		if (nested) return nested;
	}
	return trimmed;
}
function toCliUsage(raw) {
	const readNestedCached = (key) => {
		const nested = raw[key];
		if (!isRecord$1(nested)) return;
		return typeof nested.cached_tokens === "number" && nested.cached_tokens > 0 ? nested.cached_tokens : void 0;
	};
	const pick = (key) => typeof raw[key] === "number" && raw[key] > 0 ? raw[key] : void 0;
	const totalInput = pick("input_tokens") ?? pick("inputTokens");
	const output = pick("output_tokens") ?? pick("outputTokens");
	const nestedCached = readNestedCached("input_tokens_details") ?? readNestedCached("prompt_tokens_details");
	const cacheRead = pick("cache_read_input_tokens") ?? pick("cached_input_tokens") ?? pick("cacheRead") ?? pick("cached") ?? nestedCached;
	const input = pick("input") ?? ((Object.hasOwn(raw, "cached") || nestedCached !== void 0) && typeof totalInput === "number" ? Math.max(0, totalInput - (cacheRead ?? 0)) : totalInput);
	const cacheWrite = pick("cache_creation_input_tokens") ?? pick("cache_write_input_tokens") ?? pick("cacheWrite");
	const total = pick("total_tokens") ?? pick("total");
	if (!input && !output && !cacheRead && !cacheWrite && !total) return;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total
	};
}
function readCliUsage(parsed) {
	if (isRecord$1(parsed.usage)) {
		const usage = toCliUsage(parsed.usage);
		if (usage) return usage;
	}
	if (isRecord$1(parsed.stats)) return toCliUsage(parsed.stats);
}
function collectCliText(value) {
	if (!value) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((entry) => collectCliText(entry)).join("");
	if (!isRecord$1(value)) return "";
	if (typeof value.response === "string") return value.response;
	if (typeof value.text === "string") return value.text;
	if (typeof value.result === "string") return value.result;
	if (typeof value.content === "string") return value.content;
	if (Array.isArray(value.content)) return value.content.map((entry) => collectCliText(entry)).join("");
	if (isRecord$1(value.message)) return collectCliText(value.message);
	return "";
}
function unwrapNestedCliResultText(raw) {
	let text = raw;
	for (let depth = 0; depth < 8; depth += 1) {
		const trimmed = text.trim();
		if (!trimmed.startsWith("{")) return text;
		try {
			const parsed = JSON.parse(trimmed);
			if (!isRecord$1(parsed) || typeof parsed.type !== "string" || parsed.type !== "result" || typeof parsed.result !== "string") return text;
			text = parsed.result;
		} catch {
			return text;
		}
	}
	return text;
}
function collectExplicitCliErrorText(parsed) {
	const nested = readNestedErrorMessage(parsed);
	if (nested) return unwrapCliErrorText(nested);
	if (parsed.is_error === true && typeof parsed.result === "string") return unwrapCliErrorText(parsed.result);
	if (parsed.type === "assistant") {
		const text = collectCliText(parsed.message);
		if (/^\s*API Error:/i.test(text)) return unwrapCliErrorText(text);
	}
	if (parsed.type === "error") return unwrapCliErrorText(collectCliText(parsed.message) || collectCliText(parsed.content) || collectCliText(parsed.result) || collectCliText(parsed));
	return "";
}
function pickCliSessionId(parsed, backend) {
	const fields = backend.sessionIdFields ?? [
		"session_id",
		"sessionId",
		"conversation_id",
		"conversationId"
	];
	for (const field of fields) {
		const value = parsed[field];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
}
function shouldUnwrapNestedCliResultText(params) {
	if (!params.providerId || !isClaudeCliProvider(params.providerId)) return false;
	return !Object.hasOwn(params.parsed, "type") || params.parsed.type === "result";
}
function parseCliJson(raw, backend, providerId) {
	const parsedRecords = parseJsonRecordCandidates(raw);
	if (parsedRecords.length === 0) return null;
	let sessionId;
	let usage;
	let text = "";
	let sawStructuredOutput = false;
	for (const parsed of parsedRecords) {
		sessionId = pickCliSessionId(parsed, backend) ?? sessionId;
		usage = readCliUsage(parsed) ?? usage;
		const nextText = collectCliText(parsed.message) || collectCliText(parsed.content) || collectCliText(parsed.result) || collectCliText(parsed.response) || collectCliText(parsed);
		const trimmedText = (shouldUnwrapNestedCliResultText({
			providerId,
			parsed
		}) ? unwrapNestedCliResultText(nextText) : nextText).trim();
		if (trimmedText) {
			text = trimmedText;
			sawStructuredOutput = true;
			continue;
		}
		if (sessionId || usage) sawStructuredOutput = true;
	}
	if (!text && !sawStructuredOutput) return null;
	return {
		text,
		sessionId,
		usage
	};
}
function parseClaudeCliJsonlResult(params) {
	if (!usesClaudeStreamJsonDialect(params)) return null;
	if (typeof params.parsed.type === "string" && params.parsed.type === "result" && typeof params.parsed.result === "string") {
		const resultText = unwrapNestedCliResultText(params.parsed.result).trim();
		if (resultText) return {
			text: resultText,
			sessionId: params.sessionId,
			usage: params.usage
		};
		return {
			text: "",
			sessionId: params.sessionId,
			usage: params.usage
		};
	}
	return null;
}
function parseClaudeCliStreamingDelta(params) {
	if (!usesClaudeStreamJsonDialect(params)) return null;
	if (params.parsed.type !== "stream_event" || !isRecord$1(params.parsed.event)) return null;
	const event = params.parsed.event;
	if (event.type !== "content_block_delta" || !isRecord$1(event.delta)) return null;
	const delta = event.delta;
	if (delta.type !== "text_delta" || typeof delta.text !== "string") return null;
	if (!delta.text) return null;
	return {
		text: `${params.textSoFar}${delta.text}`,
		delta: delta.text,
		sessionId: params.sessionId,
		usage: params.usage
	};
}
function createCliJsonlStreamingParser(params) {
	let lineBuffer = "";
	let assistantText = "";
	let sessionId;
	let usage;
	let output = null;
	const texts = [];
	const handleParsedRecord = (parsed) => {
		sessionId = pickCliSessionId(parsed, params.backend) ?? sessionId;
		if (!sessionId && typeof parsed.thread_id === "string") sessionId = parsed.thread_id.trim();
		usage = readCliUsage(parsed) ?? usage;
		const result = parseClaudeCliJsonlResult({
			backend: params.backend,
			providerId: params.providerId,
			parsed,
			sessionId,
			usage
		});
		if (result) {
			output = result;
			return;
		}
		const item = isRecord$1(parsed.item) ? parsed.item : null;
		if (item && typeof item.text === "string") {
			const type = normalizeLowercaseStringOrEmpty(item.type);
			if (!type || type.includes("message")) texts.push(item.text);
		}
		const delta = parseClaudeCliStreamingDelta({
			backend: params.backend,
			providerId: params.providerId,
			parsed,
			textSoFar: assistantText,
			sessionId,
			usage
		});
		if (!delta) return;
		assistantText = delta.text;
		params.onAssistantDelta(delta);
	};
	const flushLines = (flushPartial) => {
		while (true) {
			const newlineIndex = lineBuffer.indexOf("\n");
			if (newlineIndex < 0) break;
			const line = lineBuffer.slice(0, newlineIndex).trim();
			lineBuffer = lineBuffer.slice(newlineIndex + 1);
			if (!line) continue;
			for (const parsed of parseJsonRecordCandidates(line)) handleParsedRecord(parsed);
		}
		if (!flushPartial) return;
		const tail = lineBuffer.trim();
		lineBuffer = "";
		if (!tail) return;
		for (const parsed of parseJsonRecordCandidates(tail)) handleParsedRecord(parsed);
	};
	return {
		push(chunk) {
			if (!chunk) return;
			lineBuffer += chunk;
			flushLines(false);
		},
		finish() {
			flushLines(true);
		},
		getOutput() {
			if (output) return output;
			const text = texts.join("\n").trim();
			return text ? {
				text,
				sessionId,
				usage
			} : null;
		}
	};
}
function parseCliJsonl(raw, backend, providerId) {
	const lines = raw.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0) return null;
	let sessionId;
	let usage;
	const texts = [];
	for (const line of lines) for (const parsed of parseJsonRecordCandidates(line)) {
		if (!sessionId) sessionId = pickCliSessionId(parsed, backend);
		if (!sessionId && typeof parsed.thread_id === "string") sessionId = parsed.thread_id.trim();
		usage = readCliUsage(parsed) ?? usage;
		const claudeResult = parseClaudeCliJsonlResult({
			backend,
			providerId,
			parsed,
			sessionId,
			usage
		});
		if (claudeResult) return claudeResult;
		const item = isRecord$1(parsed.item) ? parsed.item : null;
		if (item && typeof item.text === "string") {
			const type = normalizeLowercaseStringOrEmpty(item.type);
			if (!type || type.includes("message")) texts.push(item.text);
		}
	}
	const text = texts.join("\n").trim();
	if (!text) return null;
	return {
		text,
		sessionId,
		usage
	};
}
function parseCliOutput(params) {
	const outputMode = params.outputMode ?? "text";
	if (outputMode === "text") return {
		text: params.raw.trim(),
		sessionId: params.fallbackSessionId
	};
	if (outputMode === "jsonl") return parseCliJsonl(params.raw, params.backend, params.providerId) ?? {
		text: params.raw.trim(),
		sessionId: params.fallbackSessionId
	};
	return parseCliJson(params.raw, params.backend, params.providerId) ?? {
		text: params.raw.trim(),
		sessionId: params.fallbackSessionId
	};
}
function extractCliErrorMessage(raw) {
	const parsedRecords = parseJsonRecordCandidates(raw);
	if (parsedRecords.length === 0) return null;
	let errorText = "";
	for (const parsed of parsedRecords) {
		const next = collectExplicitCliErrorText(parsed);
		if (next) errorText = next;
	}
	return errorText || null;
}
//#endregion
//#region src/agents/cli-runner/claude-live-session.ts
const CLAUDE_LIVE_IDLE_TIMEOUT_MS = 600 * 1e3;
const CLAUDE_LIVE_MAX_SESSIONS = 16;
const CLAUDE_LIVE_MAX_STDERR_CHARS = 64 * 1024;
const CLAUDE_LIVE_DEFAULT_MAX_TURN_RAW_CHARS = 8 * 1024 * 1024;
const CLAUDE_LIVE_MIN_TURN_RAW_CHARS = 1024;
const CLAUDE_LIVE_MAX_CONFIGURABLE_TURN_RAW_CHARS = 64 * 1024 * 1024;
const CLAUDE_LIVE_DEFAULT_MAX_TURN_LINES = 2e4;
const CLAUDE_LIVE_MIN_TURN_LINES = 100;
const CLAUDE_LIVE_MAX_CONFIGURABLE_TURN_LINES = 1e5;
const CLAUDE_LIVE_CLOSE_WAIT_TIMEOUT_MS = 5e3;
const liveSessions = /* @__PURE__ */ new Map();
const liveSessionCreates = /* @__PURE__ */ new Map();
function sha256(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}
async function waitForManagedRunExit(managedRun) {
	let timeout = null;
	try {
		await Promise.race([managedRun.wait().then(() => void 0, () => void 0), new Promise((resolve) => {
			timeout = setTimeout(resolve, CLAUDE_LIVE_CLOSE_WAIT_TIMEOUT_MS);
			timeout.unref?.();
		})]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
async function closeClaudeLiveSessionForContext(context) {
	const key = buildClaudeLiveKey(context);
	const session = liveSessions.get(key);
	if (session) {
		closeLiveSession(session, "restart");
		await waitForManagedRunExit(session.managedRun);
	}
	liveSessionCreates.delete(key);
}
function shouldUseClaudeLiveSession(context) {
	return context.backendResolved.id === "claude-cli" && context.preparedBackend.backend.liveSession === "claude-stdio" && context.preparedBackend.backend.output === "jsonl" && context.preparedBackend.backend.input === "stdin";
}
function upsertArgValue(args, flag, value) {
	const normalized = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? "";
		if (arg === flag) {
			i += 1;
			continue;
		}
		if (arg.startsWith(`${flag}=`)) continue;
		normalized.push(arg);
	}
	normalized.push(flag, value);
	return normalized;
}
function appendArg(args, flag) {
	return args.includes(flag) ? args : [...args, flag];
}
function stripLiveProcessArgs(args, backend, stripSystemPrompt) {
	const liveProcessFlags = new Set([
		backend.sessionArg,
		"--session-id",
		stripSystemPrompt ? backend.systemPromptArg : void 0,
		stripSystemPrompt ? backend.systemPromptFileArg : void 0
	].filter((entry) => typeof entry === "string" && entry.length > 0));
	const stripped = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? "";
		if (liveProcessFlags.has(arg)) {
			i += 1;
			continue;
		}
		if ([...liveProcessFlags].some((flag) => arg.startsWith(`${flag}=`))) continue;
		stripped.push(arg);
	}
	return stripped;
}
function buildClaudeLiveArgs(params) {
	return appendArg(upsertArgValue(upsertArgValue(upsertArgValue(stripLiveProcessArgs(params.args, params.backend, params.useResume), "--input-format", "stream-json"), "--output-format", "stream-json"), "--permission-prompt-tool", "stdio"), "--replay-user-messages");
}
function buildClaudeLiveKey(context) {
	return `${context.backendResolved.id}:${sha256(JSON.stringify({
		agentAccountId: context.params.agentAccountId,
		agentId: context.params.agentId,
		authProfileId: context.effectiveAuthProfileId,
		sessionId: context.params.sessionId,
		sessionKey: context.params.sessionKey
	}))}`;
}
function buildClaudeLiveFingerprint(params) {
	const normalizeMcpConfigPath = Boolean(params.context.preparedBackend.mcpConfigHash);
	const skillSnapshot = params.context.params.skillsSnapshot;
	const skillsFingerprint = skillSnapshot ? sha256(JSON.stringify({
		promptHash: sha256(skillSnapshot.prompt),
		skillFilter: skillSnapshot.skillFilter,
		skills: skillSnapshot.skills,
		resolvedSkills: (skillSnapshot.resolvedSkills ?? []).map((skill) => ({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			sourceInfo: skill.sourceInfo
		})),
		version: skillSnapshot.version
	})) : void 0;
	const normalizePluginDir = Boolean(skillsFingerprint);
	const omittedValueFlags = new Set([
		params.context.preparedBackend.backend.systemPromptArg,
		params.context.preparedBackend.backend.systemPromptFileArg,
		"--resume",
		"-r"
	].filter((entry) => typeof entry === "string" && entry.length > 0));
	const unstableValueFlags = new Set([
		params.context.preparedBackend.backend.sessionArg,
		"--session-id",
		normalizeMcpConfigPath ? "--mcp-config" : void 0,
		normalizePluginDir ? "--plugin-dir" : void 0
	].filter((entry) => typeof entry === "string" && entry.length > 0));
	const stableArgv = [];
	for (let i = 0; i < params.argv.length; i += 1) {
		const entry = params.argv[i] ?? "";
		if (omittedValueFlags.has(entry)) {
			i += 1;
			continue;
		}
		if ([...omittedValueFlags].some((flag) => entry.startsWith(`${flag}=`))) continue;
		if (unstableValueFlags.has(entry)) {
			stableArgv.push("<unstable>");
			i += 1;
			continue;
		}
		if ([...unstableValueFlags].some((flag) => entry.startsWith(`${flag}=`))) {
			stableArgv.push("<unstable>");
			continue;
		}
		stableArgv.push(entry);
	}
	return JSON.stringify({
		command: params.context.preparedBackend.backend.command,
		workspaceDirHash: sha256(params.context.workspaceDir),
		provider: params.context.params.provider,
		model: params.context.normalizedModel,
		systemPromptHash: sha256(params.context.systemPrompt),
		authProfileIdHash: params.context.effectiveAuthProfileId ? sha256(params.context.effectiveAuthProfileId) : void 0,
		authEpochHash: params.context.authEpoch ? sha256(params.context.authEpoch) : void 0,
		extraSystemPromptHash: params.context.extraSystemPromptHash,
		promptToolNamesHash: params.context.promptToolNamesHash,
		mcpConfigHash: params.context.preparedBackend.mcpConfigHash,
		skillsFingerprint,
		argv: stableArgv,
		env: Object.keys(params.env).toSorted().map((key) => [key, params.env[key] ? sha256(params.env[key]) : ""])
	});
}
function createAbortError() {
	const error = /* @__PURE__ */ new Error("CLI run aborted");
	error.name = "AbortError";
	return error;
}
function clearTurnTimers(turn) {
	if (turn.noOutputTimer) {
		clearTimeout(turn.noOutputTimer);
		turn.noOutputTimer = null;
	}
	if (turn.timeoutTimer) {
		clearTimeout(turn.timeoutTimer);
		turn.timeoutTimer = null;
	}
}
function clearDrainTimer(session) {
	if (session.drainTimer) {
		clearTimeout(session.drainTimer);
		session.drainTimer = null;
	}
}
function finishTurn(session, output) {
	const turn = session.currentTurn;
	if (!turn) return;
	cliBackendLog.info(`claude live session turn: provider=${session.providerId} model=${session.modelId} durationMs=${Date.now() - turn.startedAtMs} rawLines=${turn.rawLines.length}`);
	clearTurnTimers(turn);
	turn.streamingParser.finish();
	session.currentTurn = null;
	turn.resolve(output);
	scheduleIdleClose(session);
}
function failTurn(session, error) {
	const turn = session.currentTurn;
	if (!turn) return;
	const errorKind = error instanceof Error ? error.name : typeof error;
	cliBackendLog.warn(`claude live session turn failed: provider=${session.providerId} model=${session.modelId} durationMs=${Date.now() - turn.startedAtMs} error=${errorKind}`);
	clearTurnTimers(turn);
	turn.streamingParser.finish();
	session.currentTurn = null;
	turn.reject(error);
}
function abortTurn(session, error) {
	if (!session.currentTurn) return;
	closeLiveSession(session, "abort", error);
}
function cleanupLiveSession(session) {
	if (session.cleanupDone) return;
	session.cleanupDone = true;
	session.cleanup();
}
function closeLiveSession(session, reason, error) {
	if (session.closing) return;
	cliBackendLog.info(`claude live session close: provider=${session.providerId} model=${session.modelId} reason=${reason}`);
	session.closing = true;
	if (session.idleTimer) {
		clearTimeout(session.idleTimer);
		session.idleTimer = null;
	}
	clearDrainTimer(session);
	if (liveSessions.get(session.key) === session) liveSessions.delete(session.key);
	if (error) failTurn(session, error);
	session.managedRun.cancel("manual-cancel");
	cleanupLiveSession(session);
}
function scheduleIdleClose(session) {
	if (session.idleTimer) clearTimeout(session.idleTimer);
	session.idleTimer = setTimeout(() => {
		if (!session.currentTurn) closeLiveSession(session, "idle");
	}, CLAUDE_LIVE_IDLE_TIMEOUT_MS);
}
function createTimeoutError(session, message) {
	return new FailoverError(message, {
		reason: "timeout",
		provider: session.providerId,
		model: session.modelId,
		status: resolveFailoverStatus("timeout")
	});
}
function createOutputLimitError(session, message) {
	return new FailoverError(message, {
		reason: "format",
		provider: session.providerId,
		model: session.modelId,
		status: resolveFailoverStatus("format")
	});
}
function resetNoOutputTimer(session) {
	const turn = session.currentTurn;
	if (!turn) return;
	if (turn.noOutputTimer) clearTimeout(turn.noOutputTimer);
	turn.noOutputTimer = setTimeout(() => {
		closeLiveSession(session, "abort", createTimeoutError(session, `CLI produced no output for ${Math.round(session.noOutputTimeoutMs / 1e3)}s and was terminated.`));
	}, session.noOutputTimeoutMs);
}
function parseSessionId(parsed) {
	return (typeof parsed.session_id === "string" ? parsed.session_id.trim() : typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "") || void 0;
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function normalizePositiveInt(value, fallback, min, max) {
	if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
	return Math.min(Math.max(value, min), max);
}
function resolveClaudeLiveOutputLimits(backend) {
	const configured = backend.reliability?.outputLimits;
	const maxTurnRawChars = normalizePositiveInt(configured?.maxTurnRawChars, CLAUDE_LIVE_DEFAULT_MAX_TURN_RAW_CHARS, CLAUDE_LIVE_MIN_TURN_RAW_CHARS, CLAUDE_LIVE_MAX_CONFIGURABLE_TURN_RAW_CHARS);
	return {
		maxTurnRawChars,
		maxPendingLineChars: maxTurnRawChars,
		maxTurnLines: normalizePositiveInt(configured?.maxTurnLines, CLAUDE_LIVE_DEFAULT_MAX_TURN_LINES, CLAUDE_LIVE_MIN_TURN_LINES, CLAUDE_LIVE_MAX_CONFIGURABLE_TURN_LINES)
	};
}
function parseClaudeLiveJsonLine(session, trimmed) {
	const maxPendingLineChars = session.currentTurn?.outputLimits.maxPendingLineChars ?? CLAUDE_LIVE_DEFAULT_MAX_TURN_RAW_CHARS;
	if (trimmed.length > maxPendingLineChars) {
		closeLiveSession(session, "abort", createOutputLimitError(session, "Claude CLI JSONL line exceeded output limit."));
		return null;
	}
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	return isRecord(parsed) ? parsed : null;
}
function createResultError(session, parsed, raw) {
	const result = typeof parsed.result === "string" ? parsed.result.trim() : "";
	const message = extractCliErrorMessage(raw) ?? (result || "Claude CLI failed.");
	const reason = classifyFailoverReason(message, { provider: session.providerId }) ?? "unknown";
	return new FailoverError(message, {
		reason,
		provider: session.providerId,
		model: session.modelId,
		status: resolveFailoverStatus(reason)
	});
}
function handleClaudeLiveLine(session, line) {
	const turn = session.currentTurn;
	const trimmed = line.trim();
	if (!trimmed) return;
	const parsed = parseClaudeLiveJsonLine(session, trimmed);
	if (!parsed) return;
	if (session.drainingAbortedTurn) {
		if (parsed.type === "result") {
			const turnToClear = session.currentTurn;
			if (turnToClear) {
				clearTurnTimers(turnToClear);
				session.currentTurn = null;
			}
			session.drainingAbortedTurn = false;
			clearDrainTimer(session);
			scheduleIdleClose(session);
		}
		return;
	}
	if (!turn) return;
	turn.rawChars += trimmed.length + 1;
	if (turn.rawChars > turn.outputLimits.maxTurnRawChars || turn.rawLines.length >= turn.outputLimits.maxTurnLines) {
		closeLiveSession(session, "abort", createOutputLimitError(session, "Claude CLI turn output exceeded limit."));
		return;
	}
	turn.rawLines.push(trimmed);
	turn.streamingParser.push(`${trimmed}\n`);
	turn.sessionId = parseSessionId(parsed) ?? turn.sessionId;
	if (parsed.type !== "result") return;
	const raw = turn.rawLines.join("\n");
	if (parsed.is_error === true) {
		failTurn(session, createResultError(session, parsed, raw));
		scheduleIdleClose(session);
		return;
	}
	finishTurn(session, parseCliOutput({
		raw,
		backend: turn.backend,
		providerId: session.providerId,
		outputMode: "jsonl",
		fallbackSessionId: turn.sessionId
	}));
}
function handleClaudeStdout(session, chunk) {
	resetNoOutputTimer(session);
	session.stdoutBuffer += chunk;
	const maxPendingLineChars = session.currentTurn?.outputLimits.maxPendingLineChars ?? CLAUDE_LIVE_DEFAULT_MAX_TURN_RAW_CHARS;
	if (session.stdoutBuffer.length > maxPendingLineChars) {
		closeLiveSession(session, "abort", createOutputLimitError(session, "Claude CLI JSONL line exceeded output limit."));
		return;
	}
	const lines = session.stdoutBuffer.split(/\r?\n/g);
	session.stdoutBuffer = lines.pop() ?? "";
	try {
		for (const line of lines) handleClaudeLiveLine(session, line);
	} catch (error) {
		closeLiveSession(session, "abort", error);
	}
}
function handleClaudeExit(session, exitCode) {
	session.closing = true;
	if (session.idleTimer) {
		clearTimeout(session.idleTimer);
		session.idleTimer = null;
	}
	clearDrainTimer(session);
	if (liveSessions.get(session.key) === session) liveSessions.delete(session.key);
	cleanupLiveSession(session);
	if (!session.currentTurn) return;
	if (session.stdoutBuffer.trim()) {
		try {
			handleClaudeLiveLine(session, session.stdoutBuffer);
		} catch (error) {
			session.stdoutBuffer = "";
			failTurn(session, error);
			return;
		}
		session.stdoutBuffer = "";
	}
	if (!session.currentTurn) return;
	const stderr = session.stderr.trim();
	const fallbackMessage = exitCode === 0 ? "Claude CLI exited before completing the turn." : "Claude CLI failed.";
	const message = extractCliErrorMessage(stderr) ?? (stderr || fallbackMessage);
	if (exitCode === 0) {
		failTurn(session, new Error(message));
		return;
	}
	const reason = classifyFailoverReason(message, { provider: session.providerId }) ?? "unknown";
	failTurn(session, new FailoverError(message, {
		reason,
		provider: session.providerId,
		model: session.modelId,
		status: resolveFailoverStatus(reason)
	}));
}
function createClaudeUserInputMessage(content) {
	return `${JSON.stringify({
		type: "user",
		session_id: "",
		parent_tool_use_id: null,
		message: {
			role: "user",
			content
		}
	})}\n`;
}
async function writeTurnInput(session, prompt) {
	const stdin = session.managedRun.stdin;
	if (!stdin) throw new Error("Claude CLI live session stdin is unavailable");
	await new Promise((resolve, reject) => {
		stdin.write(createClaudeUserInputMessage(prompt), (error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}
async function createClaudeLiveSession(params) {
	let session = null;
	const managedRun = await params.supervisor.spawn({
		sessionId: params.context.params.sessionId,
		backendId: params.context.backendResolved.id,
		scopeKey: `claude-live:${params.key}`,
		replaceExistingScope: true,
		mode: "child",
		argv: params.argv,
		cwd: params.context.workspaceDir,
		env: params.env,
		stdinMode: "pipe-open",
		captureOutput: false,
		onStdout: (chunk) => {
			if (session) handleClaudeStdout(session, chunk);
		},
		onStderr: (chunk) => {
			if (session) {
				session.stderr += chunk;
				if (session.stderr.length > CLAUDE_LIVE_MAX_STDERR_CHARS) {
					closeLiveSession(session, "abort", createOutputLimitError(session, "Claude CLI stderr exceeded limit."));
					return;
				}
				resetNoOutputTimer(session);
			}
		}
	});
	session = {
		key: params.key,
		fingerprint: params.fingerprint,
		managedRun,
		providerId: params.context.params.provider,
		modelId: params.context.modelId,
		noOutputTimeoutMs: params.noOutputTimeoutMs,
		stderr: "",
		stdoutBuffer: "",
		currentTurn: null,
		drainTimer: null,
		drainingAbortedTurn: false,
		idleTimer: null,
		cleanup: params.cleanup,
		cleanupDone: false,
		closing: false
	};
	managedRun.wait().then((exit) => handleClaudeExit(session, exit.exitCode), (error) => {
		if (session) closeLiveSession(session, "abort", error);
	});
	liveSessions.set(params.key, session);
	cliBackendLog.info(`claude live session start: provider=${session.providerId} model=${session.modelId} activeSessions=${liveSessions.size}`);
	return session;
}
function createTurn(params) {
	const turn = {
		backend: params.context.preparedBackend.backend,
		outputLimits: resolveClaudeLiveOutputLimits(params.context.preparedBackend.backend),
		startedAtMs: Date.now(),
		rawLines: [],
		rawChars: 0,
		noOutputTimer: null,
		timeoutTimer: null,
		streamingParser: createCliJsonlStreamingParser({
			backend: params.context.preparedBackend.backend,
			providerId: params.context.backendResolved.id,
			onAssistantDelta: params.onAssistantDelta
		}),
		resolve: params.resolve,
		reject: params.reject
	};
	turn.noOutputTimer = setTimeout(() => {
		closeLiveSession(params.session, "abort", createTimeoutError(params.session, `CLI produced no output for ${Math.round(params.noOutputTimeoutMs / 1e3)}s and was terminated.`));
	}, params.noOutputTimeoutMs);
	turn.timeoutTimer = setTimeout(() => {
		closeLiveSession(params.session, "abort", createTimeoutError(params.session, `CLI exceeded timeout (${Math.round(params.context.params.timeoutMs / 1e3)}s) and was terminated.`));
	}, params.context.params.timeoutMs);
	return turn;
}
function closeOldestIdleSession() {
	for (const session of liveSessions.values()) if (!session.currentTurn && !session.drainingAbortedTurn) {
		closeLiveSession(session, "idle");
		return true;
	}
	return false;
}
function ensureLiveSessionCapacity(key, context) {
	if (liveSessions.has(key) || liveSessionCreates.has(key) || liveSessions.size + liveSessionCreates.size < CLAUDE_LIVE_MAX_SESSIONS) return;
	if (closeOldestIdleSession()) return;
	throw new FailoverError("Too many Claude CLI live sessions are active.", {
		reason: "rate_limit",
		provider: context.params.provider,
		model: context.modelId,
		status: resolveFailoverStatus("rate_limit")
	});
}
async function runClaudeLiveSessionTurn(params) {
	const key = buildClaudeLiveKey(params.context);
	const resumeCapable = Boolean(params.context.preparedBackend.backend.resumeArgs?.length);
	const argv = [params.context.preparedBackend.backend.command, ...buildClaudeLiveArgs({
		args: params.args,
		backend: params.context.preparedBackend.backend,
		systemPrompt: params.context.systemPrompt,
		useResume: params.useResume
	})];
	const fingerprint = buildClaudeLiveFingerprint({
		context: params.context,
		argv,
		env: params.env
	});
	let cleanupDone = false;
	const cleanup = async () => {
		if (cleanupDone) return;
		cleanupDone = true;
		await params.cleanup();
	};
	let session = liveSessions.get(key) ?? null;
	if (session && resumeCapable && !params.useResume) {
		closeLiveSession(session, "restart");
		session = null;
	}
	if (session && session.fingerprint !== fingerprint) {
		closeLiveSession(session, "restart");
		session = null;
	}
	let cleanupTurnArtifacts = Boolean(session);
	try {
		ensureLiveSessionCapacity(key, params.context);
	} catch (error) {
		await cleanup();
		throw error;
	}
	if (!session) {
		const pendingSession = liveSessionCreates.get(key);
		if (pendingSession) {
			try {
				session = await pendingSession;
			} catch (error) {
				await cleanup();
				throw error;
			}
			if (session.fingerprint !== fingerprint) {
				closeLiveSession(session, "restart");
				session = null;
			} else if (resumeCapable && !params.useResume) {
				closeLiveSession(session, "restart");
				session = null;
			} else cleanupTurnArtifacts = true;
		}
		if (!session) {
			const createSession = createClaudeLiveSession({
				context: params.context,
				argv,
				env: params.env,
				fingerprint,
				key,
				noOutputTimeoutMs: params.noOutputTimeoutMs,
				supervisor: params.getProcessSupervisor(),
				cleanup
			}).finally(() => {
				if (liveSessionCreates.get(key) === createSession) liveSessionCreates.delete(key);
			});
			liveSessionCreates.set(key, createSession);
			try {
				session = await createSession;
			} catch (error) {
				await cleanup();
				throw error;
			}
		}
	}
	if (cleanupTurnArtifacts && session) {
		await cleanup();
		if (session.idleTimer) {
			clearTimeout(session.idleTimer);
			session.idleTimer = null;
		}
		cliBackendLog.info(`claude live session reuse: provider=${session.providerId} model=${session.modelId}`);
	}
	if (session.closing) {
		await cleanup();
		throw new Error("Claude CLI live session closed before handling the turn");
	}
	if (session.currentTurn || session.drainingAbortedTurn) throw new Error("Claude CLI live session is already handling a turn");
	const liveSession = session;
	liveSession.noOutputTimeoutMs = params.noOutputTimeoutMs;
	liveSession.stderr = "";
	const outputPromise = new Promise((resolve, reject) => {
		liveSession.currentTurn = createTurn({
			context: params.context,
			noOutputTimeoutMs: params.noOutputTimeoutMs,
			onAssistantDelta: params.onAssistantDelta,
			session: liveSession,
			resolve,
			reject
		});
	});
	const abort = () => abortTurn(liveSession, createAbortError());
	let replyBackendCompleted = false;
	const replyBackendHandle = params.context.params.replyOperation ? {
		kind: "cli",
		cancel: abort,
		isStreaming: () => !replyBackendCompleted
	} : void 0;
	params.context.params.abortSignal?.addEventListener("abort", abort, { once: true });
	if (replyBackendHandle) params.context.params.replyOperation?.attachBackend(replyBackendHandle);
	try {
		if (params.context.params.abortSignal?.aborted) abort();
		else try {
			await writeTurnInput(liveSession, params.prompt);
		} catch (error) {
			closeLiveSession(liveSession, "abort", error);
		}
		return { output: await outputPromise };
	} finally {
		replyBackendCompleted = true;
		params.context.params.abortSignal?.removeEventListener("abort", abort);
		if (replyBackendHandle) params.context.params.replyOperation?.detachBackend(replyBackendHandle);
	}
}
//#endregion
export { createCliJsonlStreamingParser as a, shouldUseClaudeLiveSession as i, closeClaudeLiveSessionForContext as n, extractCliErrorMessage as o, runClaudeLiveSessionTurn as r, parseCliOutput as s, buildClaudeLiveArgs as t };
