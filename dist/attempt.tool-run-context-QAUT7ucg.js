import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, f as readStringValue, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as redactSensitiveFieldValue, l as redactToolPayloadText } from "./redact-ok5Q8nmw.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as isAbortError } from "./unhandled-rejections-Km9wbHjh.js";
import { n as createLazyPromiseLoader } from "./lazy-promise-Djskx0qC.js";
import { y as truncateUtf16Safe } from "./utils-sBTEdeml.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import "./agent-scope-CtLXGcWm.js";
import { i as resolveAgentContextLimits } from "./agent-scope-config-CMp71_27.js";
import { w as resolvePluginControlPlaneFingerprint } from "./plugin-registry-CgH_ZSlH.js";
import { g as freezeDiagnosticTraceContext } from "./diagnostic-events-BLgzARSp.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import "./defaults-mDjiWzE5.js";
import { a as normalizeChannelId, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { t as emitSessionTranscriptUpdate } from "./transcript-events-ClYG_P1o.js";
import { d as resolveSessionWriteLockOptions, i as acquireSessionWriteLock } from "./session-write-lock-_a5O1H8L.js";
import { Q as resolveProviderRuntimePlugin, _ as normalizeProviderToolSchemasWithPlugin, f as inspectProviderToolSchemasWithPlugin } from "./provider-runtime-D8jQEgmu.js";
import "./model-selection-P-81eBKx.js";
import { d as stripRuntimeContextCustomMessages } from "./internal-runtime-context-DWxvZFcB.js";
import { t as estimateStringChars } from "./cjk-chars-BtjJDifS.js";
import { m as normalizeToolName } from "./tool-policy-COX5DaEj.js";
import { d as isGoogleModelApi } from "./pi-embedded-helpers-bmljPI1n.js";
import { n as extractToolResultId, t as extractToolCallsFromAssistant } from "./tool-call-id-CWG4BmeK.js";
import { o as isTimeoutError } from "./failover-error-CZCIurQK.js";
import { S as repairToolUseResultPairing, T as stripToolResultDetails } from "./openai-transport-stream-Pgx5hpN7.js";
import { o as normalizeTargetForProvider } from "./target-id-resolution-DVSHqxJ3.js";
import { r as splitMediaFromOutput } from "./parse-Hq4glz65.js";
import { t as pluginRegistrationContractRegistry } from "./registry-BlbU2sIq.js";
import { t as log$2 } from "./logger-D2U-uUBZ.js";
import { n as MIN_PROMPT_BUDGET_TOKENS, t as MIN_PROMPT_BUDGET_RATIO } from "./pi-compaction-constants-fWf8vbuR.js";
import { n as retryAsync } from "./retry-CryZAmlE.js";
import { d as rewriteTranscriptEntriesInState, g as readTranscriptFileState, h as persistTranscriptStateMutation, u as rewriteTranscriptEntriesInSessionManager } from "./context-engine-lifecycle-BMb8IJAk.js";
import { u as shouldPreserveThinkingBlocks } from "./provider-replay-helpers-BHVsUct1.js";
import { estimateTokens, generateSummary } from "@earendil-works/pi-coding-agent";
//#region src/agents/pi-embedded-messaging.ts
const CORE_MESSAGING_TOOLS = new Set(["sessions_send", "message"]);
const MESSAGE_TOOL_SEND_ACTIONS = new Set([
	"send",
	"thread-reply",
	"sendWithEffect",
	"sendAttachment",
	"upload-file"
]);
function isMessageToolSendActionName(action) {
	const normalized = normalizeOptionalString(action) ?? "";
	return MESSAGE_TOOL_SEND_ACTIONS.has(normalized);
}
function isMessagingTool(toolName) {
	if (CORE_MESSAGING_TOOLS.has(toolName)) return true;
	const providerId = normalizeChannelId(toolName);
	return Boolean(providerId && getChannelPlugin(providerId)?.actions);
}
function isMessagingToolSendAction(toolName, args) {
	const action = normalizeOptionalString(args.action) ?? "";
	if (toolName === "sessions_send") return true;
	if (toolName === "message") return isMessageToolSendActionName(action);
	const providerId = normalizeChannelId(toolName);
	if (!providerId) return false;
	const plugin = getChannelPlugin(providerId);
	if (!plugin?.actions?.extractToolSend) return false;
	return Boolean(plugin.actions.extractToolSend({ args })?.to);
}
//#endregion
//#region src/agents/content-blocks.ts
function collectTextContentBlocks(content) {
	if (!Array.isArray(content)) return [];
	const parts = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const rec = block;
		if (rec.type === "text" && typeof rec.text === "string") parts.push(rec.text);
	}
	return parts;
}
//#endregion
//#region src/agents/pi-embedded-subscribe.tools.ts
const TOOL_RESULT_MAX_CHARS = 8e3;
const TOOL_ERROR_MAX_CHARS = 400;
const TOOL_DENIAL_ERROR_CODES = ["SYSTEM_RUN_DENIED", "INVALID_REQUEST"];
function truncateToolText(text) {
	if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
	return `${truncateUtf16Safe(text, TOOL_RESULT_MAX_CHARS)}\n…(truncated)…`;
}
function normalizeToolErrorText(text) {
	const trimmed = text.trim();
	if (!trimmed) return;
	const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
	if (!firstLine) return;
	return firstLine.length > TOOL_ERROR_MAX_CHARS ? `${truncateUtf16Safe(firstLine, TOOL_ERROR_MAX_CHARS)}…` : firstLine;
}
function isErrorLikeStatus(status) {
	const normalized = normalizeOptionalLowercaseString(status);
	if (!normalized) return false;
	if (normalized === "0" || normalized === "ok" || normalized === "success" || normalized === "completed" || normalized === "running") return false;
	return /error|fail|timeout|timed[_\s-]?out|denied|cancel|invalid|forbidden/.test(normalized);
}
function readErrorCandidate(value) {
	if (typeof value === "string") return normalizeToolErrorText(value);
	if (!value || typeof value !== "object") return;
	const record = value;
	if (typeof record.message === "string") return normalizeToolErrorText(record.message);
	if (typeof record.error === "string") return normalizeToolErrorText(record.error);
}
function extractErrorField(value) {
	if (!value || typeof value !== "object") return;
	const record = value;
	const direct = extractDirectErrorField(record);
	if (direct) return direct;
	const status = normalizeOptionalString(record.status) ?? "";
	if (!status || !isErrorLikeStatus(status)) return;
	return normalizeToolErrorText(status);
}
function extractDirectErrorField(value) {
	if (!value || typeof value !== "object") return;
	const record = value;
	return readErrorCandidate(record.error) ?? readErrorCandidate(record.message) ?? readErrorCandidate(record.reason);
}
function readErrorCodeField(value) {
	return typeof value === "string" ? normalizeOptionalString(value) : void 0;
}
function readDenialErrorCodeFromMessage(value) {
	const message = typeof value === "string" ? normalizeOptionalString(value) : void 0;
	if (!message) return;
	for (const code of TOOL_DENIAL_ERROR_CODES) if (message === code || message.startsWith(`${code}:`)) return code;
}
function readNestedErrorCodeField(value) {
	if (!value || typeof value !== "object") return;
	const record = value;
	return readDenialErrorCodeFromMessage(record.message) ?? readDenialErrorCodeFromMessage(record.error) ?? readErrorCodeField(record.code) ?? readErrorCodeField(record.gatewayCode);
}
function extractDirectErrorCodeField(value) {
	if (!value || typeof value !== "object") return;
	const record = value;
	return readNestedErrorCodeField(record.error) ?? readNestedErrorCodeField(record.nodeError) ?? readErrorCodeField(record.code) ?? readErrorCodeField(record.gatewayCode);
}
function readRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function buildToolLifecycleErrorResult(error) {
	const errorRecord = readRecord(error);
	const nodeError = readRecord(readRecord(errorRecord?.details)?.nodeError);
	const gatewayCode = readErrorCodeField(errorRecord?.gatewayCode) ?? readErrorCodeField(errorRecord?.code);
	return { details: {
		status: "error",
		error: error instanceof Error ? error.message : String(error),
		...gatewayCode ? { gatewayCode } : {},
		...nodeError ? { nodeError } : {}
	} };
}
function extractAggregatedErrorField(value) {
	if (!value || typeof value !== "object") return;
	return readErrorCandidate(value.aggregated);
}
function redactStringsDeep(value, seen = /* @__PURE__ */ new WeakSet()) {
	if (typeof value === "string") return redactToolPayloadText(value);
	if (Array.isArray(value)) {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		return value.map((item) => redactStringsDeep(item, seen));
	}
	if (value && typeof value === "object") {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		const out = {};
		for (const [key, child] of Object.entries(value)) out[key] = typeof child === "string" ? redactSensitiveFieldValue(key, child) : redactStringsDeep(child, seen);
		return out;
	}
	return value;
}
function sanitizeToolArgs(args) {
	return redactStringsDeep(args);
}
function sanitizeToolResult(result) {
	if (typeof result === "string") return redactToolPayloadText(result);
	if (Array.isArray(result)) return redactStringsDeep(result);
	if (!result || typeof result !== "object") return result;
	const record = result;
	const preCleaned = { ...record };
	const originalContent = Array.isArray(record.content) ? record.content : null;
	if (originalContent) preCleaned.content = originalContent.map((item) => {
		if (!item || typeof item !== "object") return item;
		const entry = item;
		if (readStringValue(entry.type) === "image") {
			const data = readStringValue(entry.data);
			const bytes = data ? data.length : void 0;
			const cleaned = { ...entry };
			delete cleaned.data;
			return Object.assign({}, cleaned, {
				bytes,
				omitted: true
			});
		}
		return entry;
	});
	const baseline = redactStringsDeep(preCleaned);
	const out = { ...baseline };
	const content = Array.isArray(baseline.content) ? baseline.content : null;
	if (content) out.content = content.map((item) => {
		if (!item || typeof item !== "object") return item;
		const entry = item;
		if (readStringValue(entry.type) === "text" && typeof entry.text === "string") return Object.assign({}, entry, { text: truncateToolText(entry.text) });
		return entry;
	});
	return out;
}
function extractToolResultText(result) {
	if (!result || typeof result !== "object") return;
	const texts = collectTextContentBlocks(result.content).map((item) => {
		const trimmed = item.trim();
		return trimmed ? trimmed : void 0;
	}).filter((value) => Boolean(value));
	if (texts.length === 0) return;
	return texts.join("\n");
}
const TRUSTED_TOOL_RESULT_MEDIA = new Set([
	"agents_list",
	"apply_patch",
	"browser",
	"canvas",
	"cron",
	"edit",
	"exec",
	"gateway",
	"image",
	"image_generate",
	"memory_get",
	"memory_search",
	"message",
	"music_generate",
	"nodes",
	"process",
	"read",
	"session_status",
	"sessions_history",
	"sessions_list",
	"sessions_send",
	"sessions_spawn",
	"subagents",
	"tts",
	"video_generate",
	"web_fetch",
	"web_search",
	"x_search",
	"write"
]);
const TRUSTED_BUNDLED_PLUGIN_MEDIA_TOOLS = new Set(pluginRegistrationContractRegistry.flatMap((entry) => entry.toolNames));
const HTTP_URL_RE = /^https?:\/\//i;
function readToolResultDetails(result) {
	if (!result || typeof result !== "object") return;
	const record = result;
	return record.details && typeof record.details === "object" && !Array.isArray(record.details) ? record.details : void 0;
}
function readToolResultStatus(result) {
	const status = readToolResultDetails(result)?.status;
	return normalizeOptionalLowercaseString(status);
}
function isExternalToolResult(result) {
	const details = readToolResultDetails(result);
	if (!details) return false;
	return typeof details.mcpServer === "string" || typeof details.mcpTool === "string";
}
function isToolResultMediaTrusted(toolName, result) {
	if (!toolName || isExternalToolResult(result)) return false;
	const normalized = normalizeToolName(toolName);
	return TRUSTED_TOOL_RESULT_MEDIA.has(normalized) || TRUSTED_BUNDLED_PLUGIN_MEDIA_TOOLS.has(normalized);
}
function isTrustedOwnedTtsLocalMedia(toolName, result) {
	if (!toolName || !isToolResultMediaTrusted(toolName, result) || normalizeToolName(toolName) !== "tts") return false;
	const media = readToolResultDetails(result)?.media;
	if (!media || typeof media !== "object" || Array.isArray(media)) return false;
	return media.trustedLocalMedia === true;
}
function filterToolResultMediaUrls(toolName, mediaUrls, result, builtinToolNames) {
	if (mediaUrls.length === 0) return mediaUrls;
	const trustedOwnedTtsLocalMedia = isTrustedOwnedTtsLocalMedia(toolName, result);
	if (isToolResultMediaTrusted(toolName, result)) {
		if (builtinToolNames !== void 0) {
			if (!trustedOwnedTtsLocalMedia) {
				const registeredName = toolName?.trim();
				if (!registeredName || !builtinToolNames.has(registeredName)) return mediaUrls.filter((url) => HTTP_URL_RE.test(url.trim()));
			}
		}
		return mediaUrls;
	}
	return mediaUrls.filter((url) => HTTP_URL_RE.test(url.trim()));
}
function readToolResultDetailsMedia(result) {
	const details = readToolResultDetails(result);
	return details?.media && typeof details.media === "object" && !Array.isArray(details.media) ? details.media : void 0;
}
function collectStructuredMediaUrls(media) {
	const urls = [];
	const pushString = (value) => {
		if (typeof value !== "string") return;
		const normalized = value.trim();
		if (normalized) urls.push(normalized);
	};
	const pushAttachment = (value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		const attachment = value;
		pushString(attachment.media);
		pushString(attachment.path);
		pushString(attachment.url);
		pushString(attachment.mediaUrl);
		pushString(attachment.filePath);
		pushString(attachment.fileUrl);
	};
	if (typeof media.mediaUrl === "string" && media.mediaUrl.trim()) urls.push(media.mediaUrl.trim());
	if (Array.isArray(media.mediaUrls)) for (const value of media.mediaUrls) pushString(value);
	if (Array.isArray(media.attachments)) for (const attachment of media.attachments) pushAttachment(attachment);
	return Array.from(new Set(urls));
}
function extractTextContentMediaArtifact(content) {
	const mediaUrls = [];
	let audioAsVoice = false;
	let hasImageContent = false;
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const entry = item;
		if (entry.type === "image") {
			hasImageContent = true;
			continue;
		}
		if (entry.type !== "text" || typeof entry.text !== "string") continue;
		const parsed = splitMediaFromOutput(entry.text);
		if (parsed.audioAsVoice) audioAsVoice = true;
		if (parsed.mediaUrls?.length) mediaUrls.push(...parsed.mediaUrls);
	}
	return {
		mediaUrls,
		...audioAsVoice ? { audioAsVoice: true } : {},
		hasImageContent
	};
}
function extractToolResultMediaArtifact(result) {
	if (!result || typeof result !== "object") return;
	const record = result;
	const detailsMedia = readToolResultDetailsMedia(record);
	if (detailsMedia) {
		const mediaUrls = collectStructuredMediaUrls(detailsMedia);
		if (mediaUrls.length > 0) return {
			mediaUrls,
			...detailsMedia.audioAsVoice === true ? { audioAsVoice: true } : {},
			...detailsMedia.trustedLocalMedia === true ? { trustedLocalMedia: true } : {}
		};
	}
	const content = Array.isArray(record.content) ? record.content : null;
	if (!content) return;
	const textMedia = extractTextContentMediaArtifact(content);
	if (textMedia.mediaUrls.length > 0) return {
		mediaUrls: textMedia.mediaUrls,
		...textMedia.audioAsVoice ? { audioAsVoice: true } : {}
	};
	if (textMedia.hasImageContent) {
		const details = record.details;
		const p = normalizeOptionalString(details?.path) ?? "";
		if (p) return { mediaUrls: [p] };
	}
}
function isToolResultError(result) {
	const normalized = readToolResultStatus(result);
	if (!normalized) return false;
	return normalized === "error" || normalized === "timeout";
}
function extractToolErrorCode(result) {
	if (!result || typeof result !== "object") return;
	const record = result;
	return extractDirectErrorCodeField(record.details) ?? extractDirectErrorCodeField(record);
}
function isToolResultTimedOut(result) {
	if (readToolResultStatus(result) === "timeout") return true;
	return readToolResultDetails(result)?.timedOut === true;
}
function extractToolErrorMessage(result) {
	if (!result || typeof result !== "object") return;
	const record = result;
	const fromDetails = extractDirectErrorField(record.details);
	if (fromDetails) return fromDetails;
	const fromDetailsAggregated = extractAggregatedErrorField(record.details);
	if (fromDetailsAggregated) return fromDetailsAggregated;
	const fromRoot = extractDirectErrorField(record);
	if (fromRoot) return fromRoot;
	const text = extractToolResultText(result);
	if (text) try {
		const fromJson = extractErrorField(JSON.parse(text));
		if (fromJson) return fromJson;
	} catch {}
	const fromDetailsStatus = extractErrorField(record.details);
	if (fromDetailsStatus) return fromDetailsStatus;
	const fromRootStatus = extractErrorField(record);
	if (fromRootStatus) return fromRootStatus;
	return text ? normalizeToolErrorText(text) : void 0;
}
function resolveMessageToolTarget(args) {
	const toRaw = readStringValue(args.to);
	if (toRaw) return toRaw;
	return readStringValue(args.target);
}
function extractMessagingToolSend(toolName, args) {
	const action = normalizeOptionalString(args.action) ?? "";
	const accountId = normalizeOptionalString(args.accountId);
	if (toolName === "message") {
		if (!isMessageToolSendActionName(action)) return;
		const toRaw = resolveMessageToolTarget(args);
		if (!toRaw) return;
		const providerRaw = normalizeOptionalString(args.provider) ?? "";
		const channelRaw = normalizeOptionalString(args.channel) ?? "";
		const providerHint = providerRaw || channelRaw;
		const providerId = providerHint ? normalizeChannelId(providerHint) : null;
		const provider = providerId ?? normalizeOptionalLowercaseString(providerHint) ?? "message";
		const to = normalizeTargetForProvider(provider, toRaw);
		const threadId = normalizeOptionalString(args.threadId);
		const threadSuppressed = args.topLevel === true || args.threadId === null;
		const threadImplicit = !threadId && !threadSuppressed && Boolean(providerId && getChannelPlugin(providerId)?.threading?.resolveAutoThreadId);
		return to ? {
			tool: toolName,
			provider,
			accountId,
			to,
			...threadId ? { threadId } : {},
			...threadImplicit ? { threadImplicit: true } : {},
			...threadSuppressed ? { threadSuppressed: true } : {}
		} : void 0;
	}
	const providerId = normalizeChannelId(toolName);
	if (!providerId) return;
	const extracted = getChannelPlugin(providerId)?.actions?.extractToolSend?.({ args });
	if (!extracted?.to) return;
	const to = normalizeTargetForProvider(providerId, extracted.to);
	const threadId = normalizeOptionalString(extracted.threadId);
	return to ? {
		tool: toolName,
		provider: providerId,
		accountId: extracted.accountId ?? accountId,
		to,
		...threadId ? { threadId } : {}
	} : void 0;
}
const TRAJECTORY_FLUSH_TIMEOUT_ENV = "OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS";
const CLEANUP_TIMEOUT_DETAILS_TRUNCATED_SUFFIX = "...[truncated]";
function normalizeExplicitTimeoutMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	return Math.max(1, Math.floor(value));
}
function parseTimeoutEnvValue(value) {
	const trimmed = value?.trim();
	if (!trimmed) return;
	const timeoutMs = Number(trimmed);
	if (!Number.isFinite(timeoutMs)) return;
	const normalized = Math.floor(timeoutMs);
	return normalized > 0 ? normalized : void 0;
}
function resolveCleanupTimeoutDetails(getTimeoutDetails) {
	try {
		const timeoutDetails = getTimeoutDetails?.()?.trim();
		return timeoutDetails ? ` details=${truncateCleanupTimeoutDetails(timeoutDetails)}` : "";
	} catch (error) {
		return ` detailsError=${truncateCleanupTimeoutDetails(formatErrorMessage(error))}`;
	}
}
function truncateCleanupTimeoutDetails(value) {
	if (value.length <= 512) return value;
	const prefixLength = Math.max(0, 498);
	return `${value.slice(0, prefixLength)}${CLEANUP_TIMEOUT_DETAILS_TRUNCATED_SUFFIX}`;
}
function resolveAgentCleanupStepTimeoutMs(params) {
	const explicitTimeoutMs = normalizeExplicitTimeoutMs(params.timeoutMs);
	if (explicitTimeoutMs !== void 0) return explicitTimeoutMs;
	const env = params.env ?? process.env;
	if (params.step === "pi-trajectory-flush") {
		const trajectoryTimeoutMs = parseTimeoutEnvValue(env[TRAJECTORY_FLUSH_TIMEOUT_ENV]);
		if (trajectoryTimeoutMs !== void 0) return trajectoryTimeoutMs;
	}
	return parseTimeoutEnvValue(env["OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS"]) ?? 1e4;
}
async function runAgentCleanupStep(params) {
	const timeoutMs = resolveAgentCleanupStepTimeoutMs({
		step: params.step,
		timeoutMs: params.timeoutMs,
		env: params.env
	});
	let timeoutHandle;
	let timedOut = false;
	const cleanupPromise = Promise.resolve().then(params.cleanup);
	const observedCleanupPromise = cleanupPromise.catch((error) => {
		if (!timedOut) params.log.warn(`agent cleanup failed: runId=${params.runId} sessionId=${params.sessionId} step=${params.step} error=${formatErrorMessage(error)}`);
	});
	const timeoutPromise = new Promise((resolve) => {
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			resolve("timeout");
		}, timeoutMs);
		timeoutHandle.unref?.();
	});
	const result = await Promise.race([observedCleanupPromise.then(() => "done"), timeoutPromise]);
	if (timeoutHandle) clearTimeout(timeoutHandle);
	if (result === "timeout") {
		const details = resolveCleanupTimeoutDetails(params.getTimeoutDetails);
		params.log.warn(`agent cleanup timed out: runId=${params.runId} sessionId=${params.sessionId} step=${params.step} timeoutMs=${timeoutMs}${details}`);
		cleanupPromise.catch((error) => {
			params.log.warn(`agent cleanup rejected after timeout: runId=${params.runId} sessionId=${params.sessionId} step=${params.step} error=${formatErrorMessage(error)}`);
		});
	}
}
//#endregion
//#region src/agents/pi-embedded-runner/tool-schema-runtime.ts
function buildProviderToolSchemaContext(params, provider) {
	return {
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		provider,
		modelId: params.modelId,
		modelApi: params.modelApi,
		model: params.model,
		tools: params.tools
	};
}
/**
* Runs provider-owned tool-schema normalization without encoding provider
* families in the embedded runner.
*/
function normalizeProviderToolSchemas(params) {
	const provider = params.provider.trim();
	const pluginNormalized = normalizeProviderToolSchemasWithPlugin({
		provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		runtimeHandle: params.runtimeHandle,
		context: buildProviderToolSchemaContext(params, provider)
	});
	return Array.isArray(pluginNormalized) ? pluginNormalized : params.tools;
}
/**
* Logs provider-owned tool-schema diagnostics after normalization.
*/
function logProviderToolSchemaDiagnostics(params) {
	const provider = params.provider.trim();
	const diagnostics = inspectProviderToolSchemasWithPlugin({
		provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		runtimeHandle: params.runtimeHandle,
		context: buildProviderToolSchemaContext(params, provider)
	});
	if (!Array.isArray(diagnostics)) return;
	if (diagnostics.length === 0) return;
	const summary = summarizeProviderToolSchemaDiagnostics(diagnostics);
	log$2.warn(`provider tool schema diagnostics: ${diagnostics.length} ${diagnostics.length === 1 ? "tool" : "tools"} for ${params.provider}: ${summary}`, {
		provider: params.provider,
		toolCount: params.tools.length,
		diagnosticCount: diagnostics.length,
		tools: params.tools.map((tool, index) => `${index}:${tool.name}`),
		diagnostics: diagnostics.map((diagnostic) => ({
			index: diagnostic.toolIndex,
			tool: diagnostic.toolName,
			violations: diagnostic.violations.slice(0, 12),
			violationCount: diagnostic.violations.length
		}))
	});
}
function summarizeProviderToolSchemaDiagnostics(diagnostics) {
	const visible = diagnostics.slice(0, 6).map((diagnostic) => {
		const violationCount = diagnostic.violations.length;
		return `${diagnostic.toolName || "unknown"} (${violationCount} ${violationCount === 1 ? "violation" : "violations"})`;
	});
	const remaining = diagnostics.length - visible.length;
	return remaining > 0 ? `${visible.join(", ")}, +${remaining} more` : visible.join(", ");
}
//#endregion
//#region src/agents/runtime-plan/tools.ts
function runtimePlanToolContext(params) {
	return {
		workspaceDir: params.workspaceDir,
		modelApi: params.modelApi ?? void 0,
		model: params.model
	};
}
function normalizeAgentRuntimeTools(params) {
	const planContext = runtimePlanToolContext(params);
	return params.runtimePlan?.tools.normalize(params.tools, planContext) ?? normalizeProviderToolSchemas({
		tools: params.tools,
		provider: params.provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env ?? process.env,
		modelId: params.modelId,
		modelApi: params.modelApi,
		model: params.model
	});
}
function logAgentRuntimeToolDiagnostics(params) {
	const planContext = runtimePlanToolContext(params);
	if (params.runtimePlan) {
		params.runtimePlan.tools.logDiagnostics(params.tools, planContext);
		return;
	}
	logProviderToolSchemaDiagnostics({
		tools: params.tools,
		provider: params.provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env ?? process.env,
		modelId: params.modelId,
		modelApi: params.modelApi,
		model: params.model
	});
}
//#endregion
//#region src/agents/pi-embedded-runner/context-truncation-notice.ts
const CONTEXT_LIMIT_TRUNCATION_NOTICE = "more characters truncated";
function formatContextLimitTruncationNotice(truncatedChars) {
	return `[... ${Math.max(1, Math.floor(truncatedChars))} ${CONTEXT_LIMIT_TRUNCATION_NOTICE}]`;
}
//#endregion
//#region src/agents/pi-embedded-runner/tool-result-truncation.ts
/**
* Maximum share of the context window a single tool result should occupy.
* This is intentionally conservative – a single tool result should not
* consume more than 30% of the context window even without other messages.
*/
const MAX_TOOL_RESULT_CONTEXT_SHARE = .3;
/**
* Default hard cap for a single live tool result text block.
*
* Pi already truncates tool results aggressively when serializing old history
* for compaction summaries. For the live request path we still keep a bounded
* request-local ceiling so oversized tool output cannot dominate the next turn.
*/
const DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS = 16e3;
/**
* Minimum characters to keep when truncating.
* We always keep at least the first portion so the model understands
* what was in the content.
*/
const MIN_KEEP_CHARS = 2e3;
const RECOVERY_MIN_KEEP_CHARS = 0;
const DEFAULT_SUFFIX = (truncatedChars) => formatContextLimitTruncationNotice(truncatedChars);
MIN_KEEP_CHARS + DEFAULT_SUFFIX(1).length;
function resolveSuffixFactory(suffix) {
	if (typeof suffix === "function") return suffix;
	if (typeof suffix === "string") return () => suffix;
	return DEFAULT_SUFFIX;
}
function resolveEffectiveMinKeepChars(params) {
	const suffixFloor = params.suffixFactory(1).length;
	return Math.max(0, Math.min(params.minKeepChars, Math.max(0, params.maxChars - suffixFloor)));
}
function appendBoundedTruncationSuffix(params) {
	const build = (keptText) => keptText + params.suffixFactory(Math.max(1, params.originalTextLength - keptText.length));
	let keptText = params.keptText;
	while (true) {
		const finalText = build(keptText);
		if (finalText.length <= params.maxChars) return finalText;
		if (keptText.length === 0) return finalText.slice(0, params.maxChars);
		const overflow = finalText.length - params.maxChars;
		const nextKeptText = keptText.slice(0, Math.max(0, keptText.length - overflow));
		keptText = nextKeptText.length < keptText.length ? nextKeptText : keptText.slice(0, -1);
	}
}
/**
* Marker inserted between head and tail when using head+tail truncation.
*/
const MIDDLE_OMISSION_MARKER = "\n\n⚠️ [... middle content omitted — showing head and tail ...]\n\n";
/**
* Detect whether text likely contains error/diagnostic content near the end,
* which should be preserved during truncation.
*/
function hasImportantTail(text) {
	const tail = normalizeLowercaseStringOrEmpty(text.slice(-2e3));
	return /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b/.test(tail) || /\}\s*$/.test(tail.trim()) || /\b(total|summary|result|complete|finished|done)\b/.test(tail);
}
/**
* Truncate a single text string to fit within maxChars.
*
* Uses a head+tail strategy when the tail contains important content
* (errors, results, JSON structure), otherwise preserves the beginning.
* This ensures error messages and summaries at the end of tool output
* aren't lost during truncation.
*/
function truncateToolResultText(text, maxChars, options = {}) {
	const suffixFactory = resolveSuffixFactory(options.suffix);
	const minKeepChars = resolveEffectiveMinKeepChars({
		maxChars,
		minKeepChars: options.minKeepChars ?? MIN_KEEP_CHARS,
		suffixFactory
	});
	if (text.length <= maxChars) return text;
	const defaultSuffix = suffixFactory(Math.max(1, text.length - maxChars));
	const budget = Math.max(minKeepChars, maxChars - defaultSuffix.length);
	if (hasImportantTail(text) && budget > minKeepChars * 2) {
		const tailBudget = Math.min(Math.floor(budget * .3), 4e3);
		const headBudget = budget - tailBudget - 63;
		if (headBudget > minKeepChars) {
			let headCut = headBudget;
			const headNewline = text.lastIndexOf("\n", headBudget);
			if (headNewline > headBudget * .8) headCut = headNewline;
			let tailStart = text.length - tailBudget;
			const tailNewline = text.indexOf("\n", tailStart);
			if (tailNewline !== -1 && tailNewline < tailStart + tailBudget * .2) tailStart = tailNewline + 1;
			return appendBoundedTruncationSuffix({
				keptText: text.slice(0, headCut) + MIDDLE_OMISSION_MARKER + text.slice(tailStart),
				originalTextLength: text.length,
				maxChars,
				suffixFactory
			});
		}
	}
	let cutPoint = budget;
	const lastNewline = text.lastIndexOf("\n", budget);
	if (lastNewline > budget * .8) cutPoint = lastNewline;
	return appendBoundedTruncationSuffix({
		keptText: text.slice(0, cutPoint),
		originalTextLength: text.length,
		maxChars,
		suffixFactory
	});
}
/**
* Calculate the maximum allowed characters for a single tool result
* based on the model's context window tokens.
*
* Uses a rough 4 chars ≈ 1 token heuristic (conservative for English text;
* actual ratio varies by tokenizer).
*/
function calculateMaxToolResultChars(contextWindowTokens) {
	return calculateMaxToolResultCharsWithCap(contextWindowTokens, DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS);
}
function calculateMaxToolResultCharsWithCap(contextWindowTokens, hardCapChars) {
	const maxChars = Math.floor(contextWindowTokens * MAX_TOOL_RESULT_CONTEXT_SHARE) * 4;
	return Math.min(maxChars, Math.max(1, hardCapChars));
}
function resolveLiveToolResultMaxChars(params) {
	const configuredCap = resolveAgentContextLimits(params.cfg, params.agentId)?.toolResultMaxChars ?? 16e3;
	return calculateMaxToolResultCharsWithCap(params.contextWindowTokens, configuredCap);
}
/**
* Get the total character count of text content blocks in a tool result message.
*/
function getToolResultTextLength(msg) {
	if (!msg || msg.role !== "toolResult") return 0;
	const content = msg.content;
	if (!Array.isArray(content)) return 0;
	let totalLength = 0;
	for (const block of content) if (block && typeof block === "object" && block.type === "text") {
		const text = block.text;
		if (typeof text === "string") totalLength += text.length;
	}
	return totalLength;
}
/**
* Truncate a tool result message's text content blocks to fit within maxChars.
* Returns a new message (does not mutate the original).
*/
function truncateToolResultMessage(msg, maxChars, options = {}) {
	const suffixFactory = resolveSuffixFactory(options.suffix);
	const minKeepChars = resolveEffectiveMinKeepChars({
		maxChars,
		minKeepChars: options.minKeepChars ?? MIN_KEEP_CHARS,
		suffixFactory
	});
	const content = msg.content;
	if (!Array.isArray(content)) return msg;
	const totalTextChars = getToolResultTextLength(msg);
	if (totalTextChars <= maxChars) return msg;
	const newContent = content.map((block) => {
		if (!block || typeof block !== "object" || block.type !== "text") return block;
		const textBlock = block;
		if (typeof textBlock.text !== "string") return block;
		const blockShare = textBlock.text.length / totalTextChars;
		const defaultSuffix = suffixFactory(Math.max(1, textBlock.text.length - Math.floor(maxChars * blockShare)));
		const proportionalBudget = Math.floor(maxChars * blockShare);
		const blockBudget = Math.max(1, Math.min(maxChars, Math.max(minKeepChars + defaultSuffix.length, proportionalBudget)));
		return Object.assign({}, textBlock, { text: truncateToolResultText(textBlock.text, blockBudget, {
			suffix: suffixFactory,
			minKeepChars
		}) });
	});
	return {
		...msg,
		content: newContent
	};
}
function calculateRecoveryAggregateToolResultChars(contextWindowTokens, maxCharsOverride) {
	return Math.max(1, maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens));
}
function buildAggregateToolResultReplacements(params) {
	const minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;
	const minTruncatedTextChars = minKeepChars + DEFAULT_SUFFIX(1).length;
	const candidates = params.branch.map((entry, index) => ({
		entry,
		index
	})).filter((item) => item.entry.type === "message" && Boolean(item.entry.message) && item.entry.message.role === "toolResult").map((item) => ({
		index: item.index,
		entryId: item.entry.id,
		message: item.entry.message,
		textLength: getToolResultTextLength(item.entry.message)
	})).filter((item) => item.textLength > 0);
	if (candidates.length < 2) return [];
	const totalChars = candidates.reduce((sum, item) => sum + item.textLength, 0);
	if (totalChars <= params.aggregateBudgetChars) return [];
	let remainingReduction = totalChars - params.aggregateBudgetChars;
	const replacements = [];
	for (const candidate of candidates.toSorted((a, b) => {
		if (a.index !== b.index) return b.index - a.index;
		return b.textLength - a.textLength;
	})) {
		if (remainingReduction <= 0) break;
		const reducibleChars = Math.max(0, candidate.textLength - minTruncatedTextChars);
		if (reducibleChars <= 0) continue;
		const requestedReduction = Math.min(reducibleChars, remainingReduction);
		const targetChars = Math.max(minTruncatedTextChars, candidate.textLength - requestedReduction);
		const truncatedMessage = truncateToolResultMessage(candidate.message, targetChars, { minKeepChars });
		const newLength = getToolResultTextLength(truncatedMessage);
		const actualReduction = Math.max(0, candidate.textLength - newLength);
		if (actualReduction <= 0) continue;
		replacements.push({
			entryId: candidate.entryId,
			message: truncatedMessage
		});
		remainingReduction -= actualReduction;
	}
	return replacements;
}
function buildOversizedToolResultReplacements(params) {
	const minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;
	const replacements = [];
	for (const entry of params.branch) {
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		if (msg.role !== "toolResult") continue;
		if (getToolResultTextLength(msg) <= params.maxChars) continue;
		replacements.push({
			entryId: entry.id,
			message: truncateToolResultMessage(msg, params.maxChars, { minKeepChars })
		});
	}
	return replacements;
}
function calculateReplacementReduction(branch, replacements) {
	if (replacements.length === 0) return 0;
	const branchById = new Map(branch.map((entry) => [entry.id, entry]));
	let reduction = 0;
	for (const replacement of replacements) {
		const entry = branchById.get(replacement.entryId);
		if (!entry?.message) continue;
		reduction += Math.max(0, getToolResultTextLength(entry.message) - getToolResultTextLength(replacement.message));
	}
	return reduction;
}
function applyToolResultReplacementsToBranch(branch, replacements) {
	if (replacements.length === 0) return branch;
	const replacementsById = new Map(replacements.map((replacement) => [replacement.entryId, replacement]));
	return branch.map((entry) => {
		const replacement = replacementsById.get(entry.id);
		if (!replacement || entry.type !== "message") return entry;
		return {
			...entry,
			message: replacement.message
		};
	});
}
function buildToolResultReplacementPlan(params) {
	const minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;
	const oversizedReplacements = buildOversizedToolResultReplacements({
		branch: params.branch,
		maxChars: params.maxChars,
		minKeepChars
	});
	const oversizedReducibleChars = calculateReplacementReduction(params.branch, oversizedReplacements);
	const oversizedTrimmedBranch = applyToolResultReplacementsToBranch(params.branch, oversizedReplacements);
	const aggregateReplacements = buildAggregateToolResultReplacements({
		branch: oversizedTrimmedBranch,
		aggregateBudgetChars: params.aggregateBudgetChars,
		minKeepChars
	});
	const aggregateReducibleChars = calculateReplacementReduction(oversizedTrimmedBranch, aggregateReplacements);
	return {
		replacements: [...oversizedReplacements, ...aggregateReplacements],
		oversizedReplacementCount: oversizedReplacements.length,
		aggregateReplacementCount: aggregateReplacements.length,
		oversizedReducibleChars,
		aggregateReducibleChars
	};
}
function estimateToolResultReductionPotential(params) {
	const { messages, contextWindowTokens } = params;
	const maxChars = Math.max(1, params.maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens));
	const aggregateBudgetChars = calculateRecoveryAggregateToolResultChars(contextWindowTokens, maxChars);
	const branch = messages.map((message, index) => ({
		id: `message-${index}`,
		type: "message",
		message
	}));
	let toolResultCount = 0;
	let totalToolResultChars = 0;
	for (const msg of messages) {
		if (msg.role !== "toolResult") continue;
		const textLength = getToolResultTextLength(msg);
		if (textLength <= 0) continue;
		toolResultCount += 1;
		totalToolResultChars += textLength;
	}
	const plan = buildToolResultReplacementPlan({
		branch,
		maxChars,
		aggregateBudgetChars,
		minKeepChars: RECOVERY_MIN_KEEP_CHARS
	});
	const maxReducibleChars = plan.oversizedReducibleChars + plan.aggregateReducibleChars;
	return {
		maxChars,
		aggregateBudgetChars,
		toolResultCount,
		totalToolResultChars,
		oversizedCount: plan.oversizedReplacementCount,
		oversizedReducibleChars: plan.oversizedReducibleChars,
		aggregateReducibleChars: plan.aggregateReducibleChars,
		maxReducibleChars
	};
}
function truncateOversizedToolResultsInExistingSessionManager(params) {
	const { sessionManager, contextWindowTokens } = params;
	const maxChars = Math.max(1, params.maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens));
	const aggregateBudgetChars = calculateRecoveryAggregateToolResultChars(contextWindowTokens, maxChars);
	const branch = sessionManager.getBranch();
	if (branch.length === 0) return {
		truncated: false,
		truncatedCount: 0,
		reason: "empty session"
	};
	const plan = buildToolResultReplacementPlan({
		branch,
		maxChars,
		aggregateBudgetChars,
		minKeepChars: RECOVERY_MIN_KEEP_CHARS
	});
	if (plan.replacements.length === 0) return {
		truncated: false,
		truncatedCount: 0,
		reason: "no oversized or aggregate tool results"
	};
	const rewriteResult = rewriteTranscriptEntriesInSessionManager({
		sessionManager,
		replacements: plan.replacements
	});
	if (rewriteResult.changed && params.sessionFile) emitSessionTranscriptUpdate({
		sessionFile: params.sessionFile,
		sessionKey: params.sessionKey
	});
	log$2.info(`[tool-result-truncation] Truncated ${rewriteResult.rewrittenEntries} tool result(s) in session (contextWindow=${contextWindowTokens} maxChars=${maxChars} aggregateBudgetChars=${aggregateBudgetChars} oversized=${plan.oversizedReplacementCount} aggregate=${plan.aggregateReplacementCount}) sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`);
	return {
		truncated: rewriteResult.changed,
		truncatedCount: rewriteResult.rewrittenEntries,
		reason: rewriteResult.reason
	};
}
async function truncateOversizedToolResultsInTranscriptState(params) {
	const { state, contextWindowTokens } = params;
	const maxChars = Math.max(1, params.maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens));
	const aggregateBudgetChars = calculateRecoveryAggregateToolResultChars(contextWindowTokens, maxChars);
	const branch = state.getBranch();
	if (branch.length === 0) return {
		truncated: false,
		truncatedCount: 0,
		reason: "empty session"
	};
	const plan = buildToolResultReplacementPlan({
		branch,
		maxChars,
		aggregateBudgetChars,
		minKeepChars: RECOVERY_MIN_KEEP_CHARS
	});
	if (plan.replacements.length === 0) return {
		truncated: false,
		truncatedCount: 0,
		reason: "no oversized or aggregate tool results"
	};
	const rewriteResult = rewriteTranscriptEntriesInState({
		state,
		replacements: plan.replacements
	});
	if (rewriteResult.changed) {
		await persistTranscriptStateMutation({
			sessionFile: params.sessionFile,
			state,
			appendedEntries: rewriteResult.appendedEntries
		});
		emitSessionTranscriptUpdate({
			sessionFile: params.sessionFile,
			sessionKey: params.sessionKey
		});
	}
	log$2.info(`[tool-result-truncation] Truncated ${rewriteResult.rewrittenEntries} tool result(s) in session (contextWindow=${contextWindowTokens} maxChars=${maxChars} aggregateBudgetChars=${aggregateBudgetChars} oversized=${plan.oversizedReplacementCount} aggregate=${plan.aggregateReplacementCount}) sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`);
	return {
		truncated: rewriteResult.changed,
		truncatedCount: rewriteResult.rewrittenEntries,
		reason: rewriteResult.reason
	};
}
function truncateOversizedToolResultsInSessionManager(params) {
	try {
		return truncateOversizedToolResultsInExistingSessionManager(params);
	} catch (err) {
		const errMsg = formatErrorMessage(err);
		log$2.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
		return {
			truncated: false,
			truncatedCount: 0,
			reason: errMsg
		};
	}
}
async function truncateOversizedToolResultsInSession(params) {
	const { sessionFile, contextWindowTokens } = params;
	let sessionLock;
	try {
		sessionLock = await acquireSessionWriteLock({
			sessionFile,
			...resolveSessionWriteLockOptions(params.config)
		});
		return await truncateOversizedToolResultsInTranscriptState({
			state: await readTranscriptFileState(sessionFile),
			contextWindowTokens,
			maxCharsOverride: params.maxCharsOverride,
			sessionFile,
			sessionId: params.sessionId,
			sessionKey: params.sessionKey
		});
	} catch (err) {
		const errMsg = formatErrorMessage(err);
		log$2.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
		return {
			truncated: false,
			truncatedCount: 0,
			reason: errMsg
		};
	} finally {
		await sessionLock?.release();
	}
}
function sessionLikelyHasOversizedToolResults(params) {
	const estimate = estimateToolResultReductionPotential(params);
	return estimate.oversizedCount > 0 || estimate.aggregateReducibleChars > 0;
}
//#endregion
//#region src/agents/transcript-policy.ts
function shouldAllowProviderOwnedThinkingReplay(params) {
	return isAnthropicApi(params.modelApi) && params.policy.validateAnthropicTurns && params.policy.preserveSignatures && !params.policy.dropThinkingBlocks;
}
const DEFAULT_TRANSCRIPT_POLICY = {
	sanitizeMode: "images-only",
	sanitizeToolCallIds: false,
	toolCallIdMode: void 0,
	preserveNativeAnthropicToolUseIds: false,
	repairToolUseResultPairing: true,
	preserveSignatures: false,
	sanitizeThoughtSignatures: void 0,
	sanitizeThinkingSignatures: false,
	dropThinkingBlocks: false,
	dropReasoningFromHistory: false,
	applyGoogleTurnOrdering: false,
	validateGeminiTurns: false,
	validateAnthropicTurns: false,
	allowSyntheticToolResults: false
};
function isAnthropicApi(modelApi) {
	return modelApi === "anthropic-messages" || modelApi === "bedrock-converse-stream";
}
function isOpenAiResponsesCompatibleApi(modelApi) {
	return modelApi === "openai-responses" || modelApi === "openai-codex-responses" || modelApi === "azure-openai-responses";
}
function isClaudeFamilyModelId(modelId) {
	const id = normalizeLowercaseStringOrEmpty(modelId);
	return /(?:^|[./:_-])claude(?:$|[./:_-])/.test(id);
}
function modelDisablesReasoningEffort(model) {
	return (model?.compat)?.supportsReasoningEffort === false;
}
/**
* Provides a narrow replay-policy fallback for providers that do not have an
* owning runtime plugin.
*
* This exists to preserve generic custom-provider behavior. Bundled providers
* should express replay ownership through `buildReplayPolicy` instead.
*/
function buildUnownedProviderTransportReplayFallback(params) {
	const isGoogle = isGoogleModelApi(params.modelApi);
	const isAnthropic = isAnthropicApi(params.modelApi);
	const isStrictOpenAiCompatible = params.modelApi === "openai-completions";
	const requiresOpenAiCompatibleToolIdSanitization = params.modelApi === "openai-completions" || params.modelApi === "openai-responses" || params.modelApi === "openai-codex-responses" || params.modelApi === "azure-openai-responses";
	if (!isGoogle && !isAnthropic && !isStrictOpenAiCompatible && !requiresOpenAiCompatibleToolIdSanitization) return;
	const modelId = normalizeLowercaseStringOrEmpty(params.modelId);
	const isClaudeOpenAiResponses = isOpenAiResponsesCompatibleApi(params.modelApi) ? isClaudeFamilyModelId(modelId) : false;
	return {
		...isGoogle || isAnthropic ? { sanitizeMode: "full" } : {},
		...isGoogle || isAnthropic || requiresOpenAiCompatibleToolIdSanitization ? {
			sanitizeToolCallIds: true,
			toolCallIdMode: "strict"
		} : {},
		...isAnthropic ? { preserveSignatures: true } : {},
		...isGoogle ? { sanitizeThoughtSignatures: {
			allowBase64Only: true,
			includeCamelCase: true
		} } : {},
		...isAnthropic && modelId.includes("claude") ? { dropThinkingBlocks: !shouldPreserveThinkingBlocks(modelId) } : {},
		...isAnthropic && modelDisablesReasoningEffort(params.model) ? { dropThinkingBlocks: true } : {},
		...isStrictOpenAiCompatible ? { dropReasoningFromHistory: !requiresReasoningContentReplay(params.modelId) } : {},
		...isGoogle || isStrictOpenAiCompatible ? { applyAssistantFirstOrderingFix: true } : {},
		...isGoogle || isStrictOpenAiCompatible ? { validateGeminiTurns: true } : {},
		...isAnthropic || isStrictOpenAiCompatible || isClaudeOpenAiResponses ? { validateAnthropicTurns: true } : {},
		...isGoogle || isAnthropic || isOpenAiResponsesCompatibleApi(params.modelApi) ? { allowSyntheticToolResults: true } : {}
	};
}
const REASONING_CONTENT_REPLAY_MODEL_IDS = new Set([
	"kimi-for-coding",
	"kimi-k2.5",
	"kimi-k2.6",
	"kimi-k2-thinking",
	"kimi-k2-thinking-turbo",
	"mimo-v2-pro",
	"mimo-v2-omni",
	"mimo-v2.5",
	"mimo-v2.5-pro",
	"mimo-v2.6-pro"
]);
function requiresReasoningContentReplay(modelId) {
	const normalized = normalizeLowercaseStringOrEmpty(modelId);
	if (!normalized) return false;
	const parts = normalized.split("/").filter(Boolean);
	const finalPart = parts[parts.length - 1] ?? normalized;
	const candidates = [finalPart];
	const colonParts = finalPart.split(":").filter(Boolean);
	if (colonParts.length > 1) candidates.push(colonParts[0] ?? "", colonParts[colonParts.length - 1] ?? "");
	return candidates.some((candidate) => REASONING_CONTENT_REPLAY_MODEL_IDS.has(candidate));
}
function mergeTranscriptPolicy(policy, basePolicy = DEFAULT_TRANSCRIPT_POLICY) {
	if (!policy) return basePolicy;
	return {
		...basePolicy,
		...policy.sanitizeMode != null ? { sanitizeMode: policy.sanitizeMode } : {},
		...typeof policy.sanitizeToolCallIds === "boolean" ? { sanitizeToolCallIds: policy.sanitizeToolCallIds } : {},
		...policy.toolCallIdMode ? { toolCallIdMode: policy.toolCallIdMode } : {},
		...typeof policy.preserveNativeAnthropicToolUseIds === "boolean" ? { preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds } : {},
		...typeof policy.repairToolUseResultPairing === "boolean" ? { repairToolUseResultPairing: policy.repairToolUseResultPairing } : {},
		...typeof policy.preserveSignatures === "boolean" ? { preserveSignatures: policy.preserveSignatures } : {},
		...policy.sanitizeThoughtSignatures ? { sanitizeThoughtSignatures: policy.sanitizeThoughtSignatures } : {},
		...typeof policy.dropThinkingBlocks === "boolean" ? { dropThinkingBlocks: policy.dropThinkingBlocks } : {},
		...typeof policy.dropReasoningFromHistory === "boolean" ? { dropReasoningFromHistory: policy.dropReasoningFromHistory } : {},
		...typeof policy.applyAssistantFirstOrderingFix === "boolean" ? { applyGoogleTurnOrdering: policy.applyAssistantFirstOrderingFix } : {},
		...typeof policy.validateGeminiTurns === "boolean" ? { validateGeminiTurns: policy.validateGeminiTurns } : {},
		...typeof policy.validateAnthropicTurns === "boolean" ? { validateAnthropicTurns: policy.validateAnthropicTurns } : {},
		...typeof policy.allowSyntheticToolResults === "boolean" ? { allowSyntheticToolResults: policy.allowSyntheticToolResults } : {}
	};
}
const transcriptPolicyCache = /* @__PURE__ */ new WeakMap();
function canCacheTranscriptPolicy(params) {
	if (!params.config) return false;
	return !params.env || params.env === process.env;
}
function resolveTranscriptPolicyCacheKey(params) {
	return JSON.stringify({
		provider: params.provider,
		modelApi: params.modelApi ?? "",
		modelId: params.modelId ?? "",
		dropsThinkingForReasoningCompat: modelDisablesReasoningEffort(params.model),
		workspaceDir: params.workspaceDir ?? "",
		pluginControlPlane: resolvePluginControlPlaneFingerprint({
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env
		})
	});
}
function resolveTranscriptPolicy(params) {
	const provider = normalizeProviderId(params.provider ?? "");
	const cacheConfig = canCacheTranscriptPolicy(params) ? params.config : void 0;
	const cacheKey = cacheConfig ? resolveTranscriptPolicyCacheKey({
		...params,
		provider,
		config: cacheConfig
	}) : void 0;
	if (cacheConfig && cacheKey) {
		const cached = transcriptPolicyCache.get(cacheConfig)?.get(cacheKey);
		if (cached) return cached;
	}
	const runtimePlugin = params.runtimeHandle?.plugin ?? (provider ? resolveProviderRuntimePlugin({
		provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}) : void 0);
	const context = {
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		provider,
		modelId: params.modelId ?? "",
		modelApi: params.modelApi,
		model: params.model
	};
	const buildReplayPolicy = runtimePlugin?.buildReplayPolicy;
	const policy = buildReplayPolicy ? mergeTranscriptPolicy(buildReplayPolicy(context) ?? void 0) : mergeTranscriptPolicy(buildUnownedProviderTransportReplayFallback({
		modelApi: params.modelApi,
		modelId: params.modelId,
		model: params.model
	}));
	if (cacheConfig && cacheKey) {
		let configCache = transcriptPolicyCache.get(cacheConfig);
		if (!configCache) {
			configCache = /* @__PURE__ */ new Map();
			transcriptPolicyCache.set(cacheConfig, configCache);
		}
		configCache.set(cacheKey, policy);
	}
	return policy;
}
//#endregion
//#region src/node-host/with-timeout.ts
async function withTimeout(work, timeoutMs, label) {
	const resolved = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs)) : void 0;
	if (!resolved) return await work(void 0);
	const abortCtrl = new AbortController();
	const timeoutError = /* @__PURE__ */ new Error(`${label ?? "request"} timed out`);
	const timer = setTimeout(() => abortCtrl.abort(timeoutError), resolved);
	timer.unref?.();
	let abortListener;
	const abortPromise = abortCtrl.signal.aborted ? Promise.reject(abortCtrl.signal.reason ?? timeoutError) : new Promise((_, reject) => {
		abortListener = () => reject(abortCtrl.signal.reason ?? timeoutError);
		abortCtrl.signal.addEventListener("abort", abortListener, { once: true });
	});
	try {
		return await Promise.race([work(abortCtrl.signal), abortPromise]);
	} finally {
		clearTimeout(timer);
		if (abortListener) abortCtrl.signal.removeEventListener("abort", abortListener);
	}
}
//#endregion
//#region src/agents/pi-embedded-runner/compaction-safety-timeout.ts
const EMBEDDED_COMPACTION_TIMEOUT_MS = 9e5;
const MAX_SAFE_TIMEOUT_MS = 2147e6;
function createAbortError(signal) {
	const reason = "reason" in signal ? signal.reason : void 0;
	if (reason instanceof Error) return reason;
	const err = reason ? new Error("aborted", { cause: reason }) : /* @__PURE__ */ new Error("aborted");
	err.name = "AbortError";
	return err;
}
function composeAbortSignals(...signals) {
	const activeSignals = signals.filter((signal) => Boolean(signal));
	if (activeSignals.length <= 1) return {
		signal: activeSignals[0],
		cleanup: () => {}
	};
	const controller = new AbortController();
	const removers = [];
	const abortFrom = (signal) => {
		if (!controller.signal.aborted) controller.abort("reason" in signal ? signal.reason : void 0);
	};
	for (const signal of activeSignals) {
		if (signal.aborted) {
			abortFrom(signal);
			break;
		}
		const onAbort = () => abortFrom(signal);
		signal.addEventListener("abort", onAbort, { once: true });
		removers.push(() => signal.removeEventListener("abort", onAbort));
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			for (const remove of removers) remove();
		}
	};
}
function resolveCompactionTimeoutMs(cfg) {
	const raw = cfg?.agents?.defaults?.compaction?.timeoutSeconds;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw) * 1e3, MAX_SAFE_TIMEOUT_MS);
	return EMBEDDED_COMPACTION_TIMEOUT_MS;
}
async function compactWithSafetyTimeout(compact, timeoutMs = EMBEDDED_COMPACTION_TIMEOUT_MS, opts) {
	let canceled = false;
	const cancel = () => {
		if (canceled) return;
		canceled = true;
		try {
			opts?.onCancel?.();
		} catch {}
	};
	return await withTimeout(async (timeoutSignal) => {
		let timeoutListener;
		let externalAbortListener;
		let externalAbortPromise;
		const abortSignal = opts?.abortSignal;
		const composedAbortSignal = composeAbortSignals(timeoutSignal, abortSignal);
		if (timeoutSignal) {
			timeoutListener = () => {
				cancel();
			};
			timeoutSignal.addEventListener("abort", timeoutListener, { once: true });
		}
		if (abortSignal) {
			if (abortSignal.aborted) {
				cancel();
				throw createAbortError(abortSignal);
			}
			externalAbortPromise = new Promise((_, reject) => {
				externalAbortListener = () => {
					cancel();
					reject(createAbortError(abortSignal));
				};
				abortSignal.addEventListener("abort", externalAbortListener, { once: true });
			});
		}
		try {
			const compactPromise = compact(composedAbortSignal.signal);
			if (externalAbortPromise) return await Promise.race([compactPromise, externalAbortPromise]);
			return await compactPromise;
		} finally {
			composedAbortSignal.cleanup();
			if (timeoutListener) timeoutSignal?.removeEventListener("abort", timeoutListener);
			if (externalAbortListener) abortSignal?.removeEventListener("abort", externalAbortListener);
		}
	}, timeoutMs, "Compaction");
}
/**
* Invoke a plugin-owned {@link ContextEngine.compact} bounded by the same
* finite safety timeout that protects native runtime compaction.
*
* Plugin context engines that advertise `ownsCompaction` previously had their
* `compact()` awaited with no timeout, no watchdog, and no abort signal — a
* slow or hung plugin compaction would hang the agent turn indefinitely. This
* wrapper closes that gap:
*  - the call is bounded by `timeoutMs` (host-resolved, default
*    {@link EMBEDDED_COMPACTION_TIMEOUT_MS}); on timeout it rejects with a
*    "Compaction timed out" error so the caller's existing failure handling
*    runs instead of hanging;
*  - the timeout signal and caller `abortSignal` are both raced against the
*    call (so a non-cooperating engine is still bounded) and threaded into the
*    `compact()` params (so cooperating engines can cancel their own in-flight
*    work).
*
* Callers keep their existing try/catch — a timeout or abort surfaces as a
* thrown error, never a silent hang.
*/
function compactContextEngineWithSafetyTimeout(contextEngine, params, timeoutMs = EMBEDDED_COMPACTION_TIMEOUT_MS, abortSignal) {
	return compactWithSafetyTimeout((compactAbortSignal) => contextEngine.compact(compactAbortSignal ? {
		...params,
		abortSignal: compactAbortSignal
	} : params), timeoutMs, abortSignal ? { abortSignal } : void 0);
}
//#endregion
//#region src/agents/harness/tool-result-middleware.ts
const log$1 = createSubsystemLogger("agents/harness");
const MAX_MIDDLEWARE_CONTENT_BLOCKS = 200;
const MAX_MIDDLEWARE_TEXT_CHARS = 1e5;
const MAX_MIDDLEWARE_IMAGE_DATA_CHARS = 5e6;
const MAX_MIDDLEWARE_CONTENT_DEPTH = 20;
const MAX_MIDDLEWARE_DETAILS_BYTES = 1e5;
const MAX_MIDDLEWARE_DETAILS_DEPTH = 20;
const MAX_MIDDLEWARE_DETAILS_KEYS = 1e3;
const NESTED_TOOL_RESULT_BLOCK_TYPES = new Set(["toolresult", "tool_result"]);
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isValidMiddlewareContentBlock(value) {
	if (!isRecord$1(value) || typeof value.type !== "string") return false;
	if (value.type === "text") return typeof value.text === "string" && value.text.length <= MAX_MIDDLEWARE_TEXT_CHARS;
	if (value.type === "image") return typeof value.mimeType === "string" && value.mimeType.trim().length > 0 && typeof value.data === "string" && value.data.length <= MAX_MIDDLEWARE_IMAGE_DATA_CHARS;
	return false;
}
function isValidMiddlewareDetails(value, state = {
	keys: 0,
	bytes: 0,
	seen: /* @__PURE__ */ new WeakSet()
}, depth = 0) {
	if (value === void 0 || value === null) return true;
	if (depth > MAX_MIDDLEWARE_DETAILS_DEPTH) return false;
	if (typeof value === "string") {
		state.bytes += value.length;
		return state.bytes <= MAX_MIDDLEWARE_DETAILS_BYTES;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		state.bytes += String(value).length;
		return state.bytes <= MAX_MIDDLEWARE_DETAILS_BYTES;
	}
	if (typeof value !== "object") return false;
	if (state.seen.has(value)) return false;
	state.seen.add(value);
	if (Array.isArray(value)) {
		state.keys += value.length;
		if (state.keys > MAX_MIDDLEWARE_DETAILS_KEYS) return false;
		for (const entry of value) if (!isValidMiddlewareDetails(entry, state, depth + 1)) return false;
		return true;
	}
	for (const [key, entry] of Object.entries(value)) {
		state.keys += 1;
		state.bytes += key.length;
		if (state.keys > MAX_MIDDLEWARE_DETAILS_KEYS || state.bytes > MAX_MIDDLEWARE_DETAILS_BYTES) return false;
		if (!isValidMiddlewareDetails(entry, state, depth + 1)) return false;
	}
	return true;
}
function isValidMiddlewareToolResult(value) {
	if (!isRecord$1(value) || !Array.isArray(value.content)) return false;
	if (value.content.length > MAX_MIDDLEWARE_CONTENT_BLOCKS) return false;
	return value.content.every(isValidMiddlewareContentBlock) && isValidMiddlewareDetails(value.details);
}
function createMiddlewareContentCoerceState() {
	return {
		depth: 0,
		seen: /* @__PURE__ */ new Set()
	};
}
function descendMiddlewareContentCoerceState(value, state) {
	if (state.depth >= MAX_MIDDLEWARE_CONTENT_DEPTH) return;
	if (value !== null && typeof value === "object") {
		if (state.seen.has(value)) return;
		const seen = new Set(state.seen);
		seen.add(value);
		return {
			depth: state.depth + 1,
			seen
		};
	}
	return {
		depth: state.depth + 1,
		seen: state.seen
	};
}
function stringifyMiddlewareTextPayload(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	try {
		return JSON.stringify(value, (_key, val) => {
			if (typeof val === "bigint") return val.toString();
			if (typeof val === "function" || typeof val === "symbol" || val === void 0) return;
			if (val !== null && typeof val === "object") {
				if (seen.has(val)) return;
				seen.add(val);
			}
			return val;
		});
	} catch {
		return;
	}
}
function coerceMiddlewareText(value, state = createMiddlewareContentCoerceState()) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (!isRecord$1(value)) return;
	const nextState = descendMiddlewareContentCoerceState(value, state);
	if (!nextState) return;
	for (const key of [
		"text",
		"output",
		"result",
		"message"
	]) {
		const text = coerceMiddlewareText(value[key], nextState);
		if (text !== void 0) return text;
	}
	const content = value.content;
	if (Array.isArray(content)) {
		const chunks = coerceMiddlewareContentArray(content, nextState).filter((block) => block.type === "text").map((block) => block.text).filter((text) => text.length > 0);
		return chunks.length > 0 ? chunks.join("\n") : void 0;
	}
	return stringifyMiddlewareTextPayload(value);
}
function appendMiddlewareContentBlock(blocks, block) {
	if (blocks.length >= MAX_MIDDLEWARE_CONTENT_BLOCKS) return;
	if (block.type !== "text") {
		blocks.push(block);
		return;
	}
	if (!block.text) return;
	const previous = blocks.at(-1);
	if (previous?.type !== "text") {
		blocks.push({
			type: "text",
			text: truncateUtf16Safe(block.text, MAX_MIDDLEWARE_TEXT_CHARS)
		});
		return;
	}
	const remainingChars = MAX_MIDDLEWARE_TEXT_CHARS - previous.text.length - 1;
	if (remainingChars <= 0) return;
	previous.text = `${previous.text}\n${truncateUtf16Safe(block.text, remainingChars)}`;
}
function coerceMiddlewareContentArray(content, state) {
	const blocks = [];
	let inspectedBlocks = 0;
	for (const entry of content) {
		inspectedBlocks += 1;
		if (inspectedBlocks > MAX_MIDDLEWARE_CONTENT_BLOCKS || blocks.length >= MAX_MIDDLEWARE_CONTENT_BLOCKS) break;
		const coercedBlocks = coerceMiddlewareContentBlocks(entry, state);
		if (coercedBlocks.length > 0) {
			for (const block of coercedBlocks) {
				appendMiddlewareContentBlock(blocks, block);
				if (blocks.length >= MAX_MIDDLEWARE_CONTENT_BLOCKS) break;
			}
			continue;
		}
		const text = coerceMiddlewareText(entry, state);
		if (text) appendMiddlewareContentBlock(blocks, {
			type: "text",
			text: truncateUtf16Safe(text, MAX_MIDDLEWARE_TEXT_CHARS)
		});
	}
	return blocks;
}
function coerceMiddlewareContentBlocks(value, state = createMiddlewareContentCoerceState()) {
	if (isValidMiddlewareContentBlock(value)) return [value];
	if (!isRecord$1(value) || typeof value.type !== "string") return [];
	const normalizedType = value.type.toLowerCase();
	if (!NESTED_TOOL_RESULT_BLOCK_TYPES.has(normalizedType)) return [];
	const content = value.content;
	if (Array.isArray(content) && content.length > 0) {
		const nextState = descendMiddlewareContentCoerceState(value, state);
		return nextState ? coerceMiddlewareContentArray(content, nextState) : [];
	}
	const text = coerceMiddlewareText(content, state) ?? coerceMiddlewareText(value, state);
	if (!text) return [];
	return [{
		type: "text",
		text: truncateUtf16Safe(text, MAX_MIDDLEWARE_TEXT_CHARS)
	}];
}
function coerceMiddlewareToolResult(value, options = {}) {
	if (isValidMiddlewareToolResult(value)) return value;
	if (!isRecord$1(value) || !Array.isArray(value.content)) return;
	const content = [];
	const state = createMiddlewareContentCoerceState();
	let inspectedBlocks = 0;
	for (const block of value.content) {
		inspectedBlocks += 1;
		if (inspectedBlocks > MAX_MIDDLEWARE_CONTENT_BLOCKS) break;
		for (const coerced of coerceMiddlewareContentBlocks(block, state)) {
			content.push(coerced);
			if (content.length >= MAX_MIDDLEWARE_CONTENT_BLOCKS) break;
		}
		if (content.length >= MAX_MIDDLEWARE_CONTENT_BLOCKS) break;
	}
	if (content.length === 0) return;
	const details = isValidMiddlewareDetails(value.details) ? value.details : options.sanitizeDetails === true ? sanitizeMiddlewareDetailsValue(value.details) : void 0;
	if (details === void 0 && !isValidMiddlewareDetails(value.details)) return;
	const result = {
		...value,
		content,
		details
	};
	return isValidMiddlewareToolResult(result) ? result : void 0;
}
/**
* Coerce an arbitrary value into a JSON-safe shape that satisfies
* `isValidMiddlewareDetails`. Round-trips through `JSON.stringify` with a
* WeakSet replacer that drops functions, symbols, and `undefined`; coerces
* bigints to their decimal string form; breaks cycles at the offending
* reference; and collapses payloads larger than the validator byte cap to a
* `{ truncated, originalSizeBytes }` marker. Returns `null` for inputs that
* cannot be represented at all (top-level function/symbol/undefined).
*/
function sanitizeMiddlewareDetailsValue(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	try {
		const serialized = JSON.stringify(value, (_key, val) => {
			if (typeof val === "bigint") return val.toString();
			if (val !== null && typeof val === "object") {
				if (seen.has(val)) return;
				seen.add(val);
			}
			return val;
		});
		if (serialized === void 0) return null;
		if (serialized.length > MAX_MIDDLEWARE_DETAILS_BYTES) return {
			truncated: true,
			originalSizeBytes: serialized.length
		};
		return JSON.parse(serialized);
	} catch {
		return null;
	}
}
/**
* Coerce an incoming tool result into a shape the validator will accept,
* before any middleware runs. Tool emitters legitimately produce raw
* dependency payloads on `details` (channel SDK objects with methods, exec
* traces with cycles back to the runner, large attachment metadata). The
* harness owes a registered middleware a JSON-safe view of that payload;
* subsequent middleware-side mutations are still validated strictly.
*/
function sanitizeToolResultForMiddleware(result) {
	const coerced = coerceMiddlewareToolResult(result, { sanitizeDetails: true });
	if (coerced) return coerced;
	if (result.details === void 0 || result.details === null) return result;
	if (isValidMiddlewareDetails(result.details)) return result;
	return {
		...result,
		details: sanitizeMiddlewareDetailsValue(result.details)
	};
}
function buildMiddlewareFailureResult() {
	return {
		content: [{
			type: "text",
			text: "Tool output unavailable due to post-processing error."
		}],
		details: {
			status: "error",
			middlewareError: true
		}
	};
}
function createAgentToolResultMiddlewareRunner(ctx, handlers) {
	const middlewareContext = {
		...ctx,
		harness: ctx.harness ?? ctx.runtime
	};
	let resolvedHandlers = handlers;
	const resolvedHandlersLoader = createLazyPromiseLoader(async () => {
		const { loadAgentToolResultMiddlewaresForRuntime } = await import("./agent-tool-result-middleware-loader-CRfH9oee.js");
		return loadAgentToolResultMiddlewaresForRuntime({ runtime: ctx.runtime });
	});
	const resolveHandlers = async () => {
		if (resolvedHandlers) return resolvedHandlers;
		resolvedHandlers = await resolvedHandlersLoader.load();
		return resolvedHandlers;
	};
	return { async applyToolResultMiddleware(event) {
		const handlersForRun = await resolveHandlers();
		if (handlersForRun.length === 0) return event.result;
		let current = sanitizeToolResultForMiddleware(event.result);
		for (const handler of handlersForRun) try {
			const coercedCandidate = coerceMiddlewareToolResult((await handler({
				...event,
				result: current
			}, middlewareContext))?.result ?? current);
			if (coercedCandidate) current = coercedCandidate;
			else {
				log$1.warn(`[${ctx.runtime}] discarded invalid tool result middleware output for ${truncateUtf16Safe(event.toolName, 120)}`);
				return buildMiddlewareFailureResult();
			}
		} catch {
			log$1.warn(`[${ctx.runtime}] tool result middleware failed for ${truncateUtf16Safe(event.toolName, 120)}`);
			return buildMiddlewareFailureResult();
		}
		return current;
	} };
}
//#endregion
//#region src/agents/compaction.ts
const log = createSubsystemLogger("compaction");
const BASE_CHUNK_RATIO = .4;
const MIN_CHUNK_RATIO = .15;
const SAFETY_MARGIN = 1.2;
const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const DEFAULT_PARTS = 2;
const MERGE_SUMMARIES_INSTRUCTIONS = [
	"Merge these partial summaries into a single cohesive summary.",
	"",
	"MUST PRESERVE:",
	"- Active tasks and their current status (in-progress, blocked, pending)",
	"- Batch operation progress (e.g., '5/17 items completed')",
	"- The last thing the user requested and what was being done about it",
	"- Decisions made and their rationale",
	"- TODOs, open questions, and constraints",
	"- Any commitments or follow-ups promised",
	"",
	"PRIORITIZE recent context over older history. The agent needs to know",
	"what it was doing, not just what was discussed."
].join("\n");
const IDENTIFIER_PRESERVATION_INSTRUCTIONS = "Preserve all opaque identifiers exactly as written (no shortening or reconstruction), including UUIDs, hashes, IDs, hostnames, IPs, ports, URLs, and file names.";
[
	"Generate a concise recovery briefing for a new LLM taking over this session.",
	"The previous model hit a quota limit and you are providing the context for a smooth handoff.",
	"",
	"LEADER HIERARCHY REINFORCEMENT:",
	"- Explicitly state that the new model is the LEADER (Orchestrator).",
	"- Identify any active autonomous units (like AutoClaw) as SUBORDINATES.",
	"- Instruct the new model to NOT perform the subordinate's task, but to supervise and provide strategic commands.",
	"",
	"MUST CAPTURE:",
	"- Current high-level goal and project path.",
	"- Status of the latest tool executions (especially AutoClaw/Subagents).",
	"- Critical files currently being modified.",
	"- Pending items and next intended steps."
].join("\n");
const generateSummaryCompat = generateSummary;
function resolveIdentifierPreservationInstructions(instructions) {
	const policy = instructions?.identifierPolicy ?? "strict";
	if (policy === "off") return;
	if (policy === "custom") {
		const custom = instructions?.identifierInstructions?.trim();
		return custom && custom.length > 0 ? custom : IDENTIFIER_PRESERVATION_INSTRUCTIONS;
	}
	return IDENTIFIER_PRESERVATION_INSTRUCTIONS;
}
function buildCompactionSummarizationInstructions(customInstructions, instructions) {
	const custom = customInstructions?.trim();
	const identifierPreservation = resolveIdentifierPreservationInstructions(instructions);
	if (!identifierPreservation && !custom) return;
	if (!custom) return identifierPreservation;
	if (!identifierPreservation) return `Additional focus:\n${custom}`;
	return `${identifierPreservation}\n\nAdditional focus:\n${custom}`;
}
function estimateMessagesTokens(messages) {
	return stripToolResultDetails(stripRuntimeContextCustomMessages(messages)).reduce((sum, message) => sum + estimateTokens(message), 0);
}
function estimateCompactionMessageTokens(message) {
	return estimateMessagesTokens([message]);
}
function normalizeParts(parts, messageCount) {
	if (!Number.isFinite(parts) || parts <= 1) return 1;
	return Math.min(Math.max(1, Math.floor(parts)), Math.max(1, messageCount));
}
function splitMessagesByTokenShare(messages, parts = DEFAULT_PARTS) {
	if (messages.length === 0) return [];
	const normalizedParts = normalizeParts(parts, messages.length);
	if (normalizedParts <= 1) return [messages];
	const targetTokens = estimateMessagesTokens(messages) / normalizedParts;
	const chunks = [];
	let current = [];
	let currentTokens = 0;
	let pendingToolCallIds = /* @__PURE__ */ new Set();
	let pendingChunkStartIndex = null;
	const splitCurrentAtPendingBoundary = () => {
		if (pendingChunkStartIndex === null || pendingChunkStartIndex <= 0 || chunks.length >= normalizedParts - 1) return false;
		chunks.push(current.slice(0, pendingChunkStartIndex));
		current = current.slice(pendingChunkStartIndex);
		currentTokens = current.reduce((sum, msg) => sum + estimateCompactionMessageTokens(msg), 0);
		pendingChunkStartIndex = 0;
		return true;
	};
	for (const message of messages) {
		const messageTokens = estimateCompactionMessageTokens(message);
		if (pendingToolCallIds.size === 0 && chunks.length < normalizedParts - 1 && current.length > 0 && currentTokens + messageTokens > targetTokens) {
			chunks.push(current);
			current = [];
			currentTokens = 0;
			pendingChunkStartIndex = null;
		}
		current.push(message);
		currentTokens += messageTokens;
		if (message.role === "assistant") {
			const toolCalls = extractToolCallsFromAssistant(message);
			const stopReason = message.stopReason;
			const keepsPending = stopReason !== "aborted" && stopReason !== "error" && toolCalls.length > 0;
			pendingToolCallIds = /* @__PURE__ */ new Set();
			if (keepsPending) for (const toolCall of toolCalls) pendingToolCallIds.add(toolCall.id);
			pendingChunkStartIndex = keepsPending ? current.length - 1 : null;
		} else if (message.role === "toolResult" && pendingToolCallIds.size > 0) {
			const resultId = extractToolResultId(message);
			if (!resultId) {
				pendingToolCallIds = /* @__PURE__ */ new Set();
				pendingChunkStartIndex = null;
			} else pendingToolCallIds.delete(resultId);
			if (pendingToolCallIds.size === 0 && chunks.length < normalizedParts - 1 && currentTokens > targetTokens) {
				splitCurrentAtPendingBoundary();
				pendingChunkStartIndex = null;
			}
		}
	}
	if (pendingToolCallIds.size > 0 && currentTokens > targetTokens) splitCurrentAtPendingBoundary();
	if (current.length > 0) chunks.push(current);
	return chunks;
}
const SUMMARIZATION_OVERHEAD_TOKENS = 4096;
function chunkMessagesByMaxTokens(messages, maxTokens) {
	if (messages.length === 0) return [];
	const effectiveMax = Math.max(1, Math.floor(maxTokens / SAFETY_MARGIN));
	const chunks = [];
	let currentChunk = [];
	let currentTokens = 0;
	for (const message of messages) {
		const messageTokens = estimateCompactionMessageTokens(message);
		if (currentChunk.length > 0 && currentTokens + messageTokens > effectiveMax) {
			chunks.push(currentChunk);
			currentChunk = [];
			currentTokens = 0;
		}
		currentChunk.push(message);
		currentTokens += messageTokens;
		if (messageTokens > effectiveMax) {
			chunks.push(currentChunk);
			currentChunk = [];
			currentTokens = 0;
		}
	}
	if (currentChunk.length > 0) chunks.push(currentChunk);
	return chunks;
}
/**
* Compute adaptive chunk ratio based on average message size.
* When messages are large, we use smaller chunks to avoid exceeding model limits.
*/
function computeAdaptiveChunkRatio(messages, contextWindow) {
	if (messages.length === 0) return BASE_CHUNK_RATIO;
	const avgRatio = estimateMessagesTokens(messages) / messages.length * SAFETY_MARGIN / contextWindow;
	if (avgRatio > .1) {
		const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
		return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
	}
	return BASE_CHUNK_RATIO;
}
/**
* Check if a single message is too large to summarize.
* If single message > 50% of context, it can't be summarized safely.
*/
function isOversizedForSummary(msg, contextWindow) {
	return estimateCompactionMessageTokens(msg) * SAFETY_MARGIN > contextWindow * .5;
}
async function summarizeChunks(params) {
	if (params.messages.length === 0) return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
	const chunks = chunkMessagesByMaxTokens(stripToolResultDetails(stripRuntimeContextCustomMessages(params.messages)), params.maxChunkTokens);
	let summary = params.previousSummary;
	const effectiveInstructions = buildCompactionSummarizationInstructions(params.customInstructions, params.summarizationInstructions);
	for (const chunk of chunks) summary = await retryAsync(() => generateSummary$1(chunk, params.model, params.reserveTokens, params.apiKey, params.headers, params.signal, effectiveInstructions, summary), {
		attempts: 3,
		minDelayMs: 500,
		maxDelayMs: 5e3,
		jitter: .2,
		label: "compaction/generateSummary",
		shouldRetry: (err) => !isAbortError(err) && !isTimeoutError(err)
	});
	return summary ?? DEFAULT_SUMMARY_FALLBACK;
}
function generateSummary$1(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary) {
	if (generateSummary.length >= 8) return generateSummaryCompat(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary);
	return generateSummaryCompat(currentMessages, model, reserveTokens, apiKey, signal, customInstructions, previousSummary);
}
/**
* Summarize with progressive fallback for handling oversized messages.
* If full summarization fails, tries partial summarization excluding oversized messages.
*/
async function summarizeWithFallback(params) {
	const { messages, contextWindow } = params;
	if (messages.length === 0) return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
	try {
		return await summarizeChunks(params);
	} catch (fullError) {
		log.warn(`Full summarization failed: ${formatErrorMessage(fullError)}`);
	}
	const smallMessages = [];
	const oversizedNotes = [];
	for (const msg of messages) if (isOversizedForSummary(msg, contextWindow)) {
		const role = msg.role ?? "message";
		const tokens = estimateCompactionMessageTokens(msg);
		oversizedNotes.push(`[Large ${role} (~${Math.round(tokens / 1e3)}K tokens) omitted from summary]`);
	} else smallMessages.push(msg);
	if (smallMessages.length > 0 && smallMessages.length !== messages.length) try {
		return await summarizeChunks({
			...params,
			messages: smallMessages
		}) + (oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "");
	} catch (partialError) {
		log.warn(`Partial summarization also failed: ${formatErrorMessage(partialError)}`);
	}
	return `Context contained ${messages.length} messages (${oversizedNotes.length} oversized). Summary unavailable due to size limits.`;
}
async function summarizeInStages(params) {
	const { messages } = params;
	if (messages.length === 0) return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
	const minMessagesForSplit = Math.max(2, params.minMessagesForSplit ?? 4);
	const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, messages.length);
	const totalTokens = estimateMessagesTokens(messages);
	if (parts <= 1 || messages.length < minMessagesForSplit || totalTokens <= params.maxChunkTokens) return summarizeWithFallback(params);
	const splits = splitMessagesByTokenShare(messages, parts).filter((chunk) => chunk.length > 0);
	if (splits.length <= 1) return summarizeWithFallback(params);
	const partialSummaries = [];
	for (const chunk of splits) partialSummaries.push(await summarizeWithFallback({
		...params,
		messages: chunk,
		previousSummary: void 0
	}));
	if (partialSummaries.length === 1) return partialSummaries[0];
	const summaryMessages = partialSummaries.map((summary) => ({
		role: "user",
		content: summary,
		timestamp: Date.now()
	}));
	const custom = params.customInstructions?.trim();
	const mergeInstructions = custom ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\n${custom}` : MERGE_SUMMARIES_INSTRUCTIONS;
	return summarizeWithFallback({
		...params,
		messages: summaryMessages,
		customInstructions: mergeInstructions
	});
}
function pruneHistoryForContextShare(params) {
	const defaultShare = params.mode === "handoff" ? .2 : .5;
	const maxHistoryShare = params.maxHistoryShare ?? defaultShare;
	const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * maxHistoryShare));
	let keptMessages = params.messages;
	const allDroppedMessages = [];
	let droppedChunks = 0;
	let droppedMessages = 0;
	let droppedTokens = 0;
	const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, keptMessages.length);
	while (keptMessages.length > 0 && estimateMessagesTokens(keptMessages) > budgetTokens) {
		const chunks = splitMessagesByTokenShare(keptMessages, parts);
		if (chunks.length <= 1) break;
		const [dropped, ...rest] = chunks;
		const repairReport = repairToolUseResultPairing(rest.flat());
		const repairedKept = repairReport.messages;
		const orphanedCount = repairReport.droppedOrphanCount;
		droppedChunks += 1;
		droppedMessages += dropped.length + orphanedCount;
		droppedTokens += estimateMessagesTokens(dropped);
		allDroppedMessages.push(...dropped);
		keptMessages = repairedKept;
	}
	return {
		messages: keptMessages,
		droppedMessagesList: allDroppedMessages,
		droppedChunks,
		droppedMessages,
		droppedTokens,
		keptTokens: estimateMessagesTokens(keptMessages),
		budgetTokens
	};
}
function resolveContextWindowTokens(model) {
	const effective = model?.contextTokens ?? model?.contextWindow;
	return Math.max(1, Math.floor(effective ?? 2e5));
}
//#endregion
//#region src/agents/pi-embedded-runner/run/preemptive-compaction.ts
const PREEMPTIVE_OVERFLOW_ERROR_TEXT = "Context overflow: prompt too large for the model (precheck).";
const ESTIMATED_CHARS_PER_TOKEN = 4;
const TOOL_RESULT_CHARS_PER_TOKEN = 2;
const JSON_PAYLOAD_CHARS_PER_TOKEN = 3;
const MESSAGE_BOUNDARY_OVERHEAD_TOKENS = 12;
const CONTENT_BLOCK_OVERHEAD_TOKENS = 6;
const IMAGE_BLOCK_TOKENS = 2e3;
const TRUNCATION_ROUTE_BUFFER_TOKENS = 512;
function estimateStringTokenPressure(text, charsPerToken = ESTIMATED_CHARS_PER_TOKEN) {
	return Math.ceil(estimateStringChars(text) / charsPerToken);
}
function estimateJsonPayloadTokenPressure(value, charsPerToken = JSON_PAYLOAD_CHARS_PER_TOKEN) {
	try {
		const serialized = JSON.stringify(value);
		return typeof serialized === "string" ? Math.ceil(estimateStringChars(serialized) / charsPerToken) : 1;
	} catch {
		return 256;
	}
}
function estimateIdentifierTokenPressure(value, charsPerToken = JSON_PAYLOAD_CHARS_PER_TOKEN) {
	if (value == null) return 0;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return estimateStringTokenPressure(String(value), charsPerToken);
	return estimateJsonPayloadTokenPressure(value, charsPerToken);
}
function isRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function estimateContentBlockTokenPressure(block, charsPerToken = ESTIMATED_CHARS_PER_TOKEN) {
	if (typeof block === "string") return estimateStringTokenPressure(block, charsPerToken);
	if (!isRecord(block)) return estimateJsonPayloadTokenPressure(block, charsPerToken);
	const type = block.type;
	if (type === "text" && typeof block.text === "string") return CONTENT_BLOCK_OVERHEAD_TOKENS + estimateStringTokenPressure(block.text, charsPerToken);
	if (type === "thinking" && typeof block.thinking === "string") return CONTENT_BLOCK_OVERHEAD_TOKENS + estimateStringTokenPressure(block.thinking, charsPerToken);
	if (type === "image") return IMAGE_BLOCK_TOKENS;
	return CONTENT_BLOCK_OVERHEAD_TOKENS + estimateJsonPayloadTokenPressure(block, charsPerToken);
}
function estimateToolResultContentTokenPressure(content) {
	if (typeof content === "string") return estimateStringTokenPressure(content, TOOL_RESULT_CHARS_PER_TOKEN);
	if (Array.isArray(content)) return content.reduce((sum, block) => sum + estimateContentBlockTokenPressure(block, TOOL_RESULT_CHARS_PER_TOKEN), 0);
	if (content !== void 0) return estimateJsonPayloadTokenPressure(content, TOOL_RESULT_CHARS_PER_TOKEN);
	return 0;
}
function estimateAssistantToolCallTokenPressure(block) {
	const args = block.arguments ?? block.input ?? block.args ?? {};
	return CONTENT_BLOCK_OVERHEAD_TOKENS + estimateIdentifierTokenPressure(block.name, JSON_PAYLOAD_CHARS_PER_TOKEN) + estimateJsonPayloadTokenPressure(args, JSON_PAYLOAD_CHARS_PER_TOKEN);
}
function estimateContentTokenPressure(content) {
	if (typeof content === "string") return estimateStringTokenPressure(content);
	if (Array.isArray(content)) return content.reduce((sum, block) => sum + estimateContentBlockTokenPressure(block), 0);
	if (content !== void 0) return estimateJsonPayloadTokenPressure(content);
	return 0;
}
function isToolResultMessage(message) {
	const record = message;
	return record.role === "toolResult" || record.role === "tool" || record.type === "toolResult";
}
function estimateMessageTokenPressure(message) {
	const record = message;
	let tokens = MESSAGE_BOUNDARY_OVERHEAD_TOKENS;
	if (isToolResultMessage(message)) {
		tokens += estimateToolResultContentTokenPressure(record.content);
		tokens += estimateIdentifierTokenPressure(record.toolName ?? record.tool_name);
		return tokens;
	}
	if (record.role === "assistant") {
		const content = record.content;
		if (Array.isArray(content)) for (const block of content) if (isRecord(block) && (block.type === "toolCall" || block.type === "tool_use")) tokens += estimateAssistantToolCallTokenPressure(block);
		else tokens += estimateContentBlockTokenPressure(block);
		else tokens += estimateContentTokenPressure(content);
		const toolCalls = record.toolCalls ?? record.tool_calls;
		if (Array.isArray(toolCalls)) for (const toolCall of toolCalls) tokens += isRecord(toolCall) ? estimateAssistantToolCallTokenPressure(toolCall) : estimateJsonPayloadTokenPressure(toolCall);
		return tokens;
	}
	tokens += estimateContentTokenPressure(record.content);
	return tokens;
}
function estimateLlmBoundaryTokenPressure(params) {
	const historyTokens = params.messages.reduce((sum, message) => sum + estimateMessageTokenPressure(message), 0);
	const systemTokens = typeof params.systemPrompt === "string" && params.systemPrompt.trim().length > 0 ? MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.systemPrompt) : 0;
	const promptTokens = MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.prompt);
	return Math.max(0, Math.ceil((historyTokens + systemTokens + promptTokens) * SAFETY_MARGIN));
}
function estimateRenderedLlmBoundaryTokenPressure(params) {
	const systemTokens = typeof params.systemPrompt === "string" && params.systemPrompt.trim().length > 0 ? MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.systemPrompt) : 0;
	const promptTokens = MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.prompt);
	return Math.max(0, Math.ceil((systemTokens + promptTokens) * SAFETY_MARGIN));
}
function estimatePrePromptTokens(params) {
	return estimateLlmBoundaryTokenPressure(params);
}
function normalizeLlmBoundaryTokenPressure(pressure) {
	if (!pressure || !Number.isFinite(pressure.estimatedPromptTokens)) return;
	return {
		estimatedPromptTokens: Math.max(0, Math.ceil(pressure.estimatedPromptTokens)),
		source: pressure.source.trim() || "rendered_llm_boundary",
		...typeof pressure.renderedChars === "number" && Number.isFinite(pressure.renderedChars) ? { renderedChars: Math.max(0, Math.ceil(pressure.renderedChars)) } : {}
	};
}
function shouldPreemptivelyCompactBeforePrompt(params) {
	let messagesForPressure = params.messages;
	const llmBoundaryTokenPressure = normalizeLlmBoundaryTokenPressure(params.llmBoundaryTokenPressure);
	let estimatedPromptTokens = llmBoundaryTokenPressure?.estimatedPromptTokens ?? estimatePrePromptTokens({
		messages: params.messages,
		systemPrompt: params.systemPrompt,
		prompt: params.prompt
	});
	let pressureSource = llmBoundaryTokenPressure?.source ?? "transcript_estimate";
	if (params.unwindowedMessages && params.unwindowedMessages !== params.messages) {
		const unwindowedEstimatedPromptTokens = estimatePrePromptTokens({
			messages: params.unwindowedMessages,
			systemPrompt: params.systemPrompt,
			prompt: params.prompt
		});
		if (unwindowedEstimatedPromptTokens > estimatedPromptTokens) {
			estimatedPromptTokens = unwindowedEstimatedPromptTokens;
			messagesForPressure = params.unwindowedMessages;
			pressureSource = "unwindowed_transcript_estimate";
		}
	}
	const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
	const requestedReserveTokens = Math.max(0, Math.floor(params.reserveTokens));
	const minPromptBudget = Math.min(MIN_PROMPT_BUDGET_TOKENS, Math.max(1, Math.floor(contextTokenBudget * MIN_PROMPT_BUDGET_RATIO)));
	const effectiveReserveTokens = Math.min(requestedReserveTokens, Math.max(0, contextTokenBudget - minPromptBudget));
	const promptBudgetBeforeReserve = Math.max(1, contextTokenBudget - effectiveReserveTokens);
	const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
	const toolResultPotential = estimateToolResultReductionPotential({
		messages: messagesForPressure,
		contextWindowTokens: params.contextTokenBudget,
		maxCharsOverride: params.toolResultMaxChars
	});
	const overflowChars = overflowTokens * ESTIMATED_CHARS_PER_TOKEN;
	const truncateOnlyThresholdChars = Math.max(overflowChars + TRUNCATION_ROUTE_BUFFER_TOKENS * ESTIMATED_CHARS_PER_TOKEN, Math.ceil(overflowChars * 1.5));
	const toolResultReducibleChars = toolResultPotential.maxReducibleChars;
	let route = "fits";
	if (overflowTokens > 0) if (toolResultReducibleChars <= 0) route = "compact_only";
	else if (toolResultReducibleChars >= truncateOnlyThresholdChars) route = "truncate_tool_results_only";
	else route = "compact_then_truncate";
	return {
		route,
		shouldCompact: route === "compact_only" || route === "compact_then_truncate",
		estimatedPromptTokens,
		pressureSource,
		promptBudgetBeforeReserve,
		overflowTokens,
		toolResultReducibleChars,
		effectiveReserveTokens
	};
}
function formatPrePromptPrecheckLog(params) {
	const { result } = params;
	return `[context-overflow-precheck] pre-prompt check sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"} provider=${params.provider}/${params.modelId} route=${result.route} estimatedPromptTokens=${result.estimatedPromptTokens} pressureSource=${result.pressureSource ?? "unknown"} promptBudgetBeforeReserve=${result.promptBudgetBeforeReserve} overflowTokens=${result.overflowTokens} toolResultReducibleChars=${result.toolResultReducibleChars} reserveTokens=${params.reserveTokens} effectiveReserveTokens=${result.effectiveReserveTokens} contextTokenBudget=${params.contextTokenBudget} messages=${params.messageCount} unwindowedMessages=${params.unwindowedMessageCount ?? params.messageCount} sessionFile=${params.sessionFile}`;
}
//#endregion
//#region src/agents/pi-embedded-runner/run/attempt.tool-run-context.ts
function buildEmbeddedAttemptToolRunContext(params) {
	return {
		trigger: params.trigger,
		jobId: params.jobId,
		memoryFlushWritePath: params.memoryFlushWritePath,
		...params.toolsAllow ? { runtimeToolAllowlist: params.toolsAllow } : {},
		...params.trace ? { trace: freezeDiagnosticTraceContext(params.trace) } : {}
	};
}
//#endregion
export { runAgentCleanupStep as A, sanitizeToolArgs as B, truncateOversizedToolResultsInSessionManager as C, normalizeAgentRuntimeTools as D, logAgentRuntimeToolDiagnostics as E, extractToolResultMediaArtifact as F, isMessagingToolSendAction as G, collectTextContentBlocks as H, extractToolResultText as I, filterToolResultMediaUrls as L, extractMessagingToolSend as M, extractToolErrorCode as N, logProviderToolSchemaDiagnostics as O, extractToolErrorMessage as P, isToolResultError as R, truncateOversizedToolResultsInSession as S, formatContextLimitTruncationNotice as T, isMessageToolSendActionName as U, sanitizeToolResult as V, isMessagingTool as W, resolveTranscriptPolicy as _, shouldPreemptivelyCompactBeforePrompt as a, resolveLiveToolResultMaxChars as b, computeAdaptiveChunkRatio as c, resolveContextWindowTokens as d, summarizeInStages as f, resolveCompactionTimeoutMs as g, compactWithSafetyTimeout as h, formatPrePromptPrecheckLog as i, buildToolLifecycleErrorResult as j, normalizeProviderToolSchemas as k, estimateMessagesTokens as l, compactContextEngineWithSafetyTimeout as m, PREEMPTIVE_OVERFLOW_ERROR_TEXT as n, SAFETY_MARGIN as o, createAgentToolResultMiddlewareRunner as p, estimateRenderedLlmBoundaryTokenPressure as r, SUMMARIZATION_OVERHEAD_TOKENS as s, buildEmbeddedAttemptToolRunContext as t, pruneHistoryForContextShare as u, shouldAllowProviderOwnedThinkingReplay as v, truncateToolResultMessage as w, sessionLikelyHasOversizedToolResults as x, DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS as y, isToolResultTimedOut as z };
