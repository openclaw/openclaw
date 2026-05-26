import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { o as normalizeHeartbeatToolResponse } from "./heartbeat-tool-response-Cf_D5Tj1.js";
import { c as isToolWrappedWithBeforeToolCallHook, d as setBeforeToolCallDiagnosticsEnabled, p as wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call-CP_aEkky.js";
import { F as extractToolResultMediaArtifact, G as isMessagingToolSendAction, L as filterToolResultMediaUrls, W as isMessagingTool, p as createAgentToolResultMiddlewareRunner } from "./attempt.tool-run-context-QAUT7ucg.js";
import "./routing-79DRZvfm.js";
import { s as createCodexAppServerToolResultExtensionRunner } from "./agent-harness-runtime-CMvm9HY6.js";
import { c as runAgentHarnessAfterToolCallHook } from "./native-hook-relay-CKQJJkrR.js";
import { C as sanitizeInlineImageDataUrl, x as invalidInlineImageText } from "./thread-lifecycle-ICclp34e.js";
//#region extensions/codex/src/app-server/dynamic-tool-profile.ts
const CODEX_APP_SERVER_OWNED_DYNAMIC_TOOL_EXCLUDES = [
	"read",
	"write",
	"edit",
	"apply_patch",
	"exec",
	"process",
	"update_plan",
	"tool_call",
	"tool_describe",
	"tool_search",
	"tool_search_code"
];
const DYNAMIC_TOOL_NAME_ALIASES = {
	bash: "exec",
	"apply-patch": "apply_patch"
};
function normalizeCodexDynamicToolName(name) {
	const normalized = name.trim().toLowerCase();
	return DYNAMIC_TOOL_NAME_ALIASES[normalized] ?? normalized;
}
function isForcedPrivateQaCodexRuntime(env = process.env) {
	return env.OPENCLAW_BUILD_PRIVATE_QA === "1" && env.OPENCLAW_QA_FORCE_RUNTIME?.trim().toLowerCase() === "codex";
}
function resolveCodexDynamicToolsLoading(config, env = process.env) {
	return isForcedPrivateQaCodexRuntime(env) ? "direct" : config.codexDynamicToolsLoading ?? "searchable";
}
function filterCodexDynamicTools(tools, config, env = process.env) {
	const excludes = /* @__PURE__ */ new Set();
	if (!isForcedPrivateQaCodexRuntime(env)) for (const name of CODEX_APP_SERVER_OWNED_DYNAMIC_TOOL_EXCLUDES) excludes.add(name);
	for (const name of config.codexDynamicToolsExclude ?? []) {
		const trimmed = normalizeCodexDynamicToolName(name);
		if (trimmed) excludes.add(trimmed);
	}
	return excludes.size === 0 ? tools : tools.filter((tool) => !excludes.has(normalizeCodexDynamicToolName(tool.name)));
}
//#endregion
//#region extensions/codex/src/app-server/dynamic-tools.ts
const CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE = "openclaw";
const ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES = new Set(["sessions_yield"]);
const DEFAULT_CODEX_DYNAMIC_TOOL_RESULT_MAX_CHARS = 16e3;
function createCodexDynamicToolBridge(params) {
	const toolResultHookContext = toToolResultHookContext(params.hookContext);
	const toolResultMaxChars = resolveCodexDynamicToolResultMaxChars(params.hookContext);
	const tools = params.tools.map((tool) => {
		if (isToolWrappedWithBeforeToolCallHook(tool)) {
			setBeforeToolCallDiagnosticsEnabled(tool, false);
			return tool;
		}
		return wrapToolWithBeforeToolCallHook(tool, params.hookContext, { emitDiagnostics: false });
	});
	const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
	const registeredTools = params.registeredTools ?? tools;
	const registeredToolNames = new Set(registeredTools.map((tool) => tool.name));
	const telemetry = {
		didSendViaMessagingTool: false,
		messagingToolSentTexts: [],
		messagingToolSentMediaUrls: [],
		messagingToolSentTargets: [],
		messagingToolSourceReplyPayloads: [],
		toolMediaUrls: [],
		toolAudioAsVoice: false
	};
	const middlewareRunner = createAgentToolResultMiddlewareRunner({
		runtime: "codex",
		...toolResultHookContext
	});
	const legacyExtensionRunner = createCodexAppServerToolResultExtensionRunner(toolResultHookContext);
	const directToolNames = new Set([...ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES, ...params.directToolNames ?? []]);
	return {
		availableSpecs: tools.map((tool) => createCodexDynamicToolSpec({
			tool,
			loading: params.loading ?? "searchable",
			directToolNames
		})),
		specs: registeredTools.map((tool) => createCodexDynamicToolSpec({
			tool,
			loading: params.loading ?? "searchable",
			directToolNames
		})),
		telemetry,
		handleToolCall: async (call, options) => {
			const tool = toolMap.get(call.tool);
			if (!tool) {
				if (registeredToolNames.has(call.tool)) return {
					contentItems: [{
						type: "inputText",
						text: `OpenClaw tool is not available for this turn: ${call.tool}`
					}],
					success: false
				};
				return {
					contentItems: [{
						type: "inputText",
						text: `Unknown OpenClaw tool: ${call.tool}`
					}],
					success: false
				};
			}
			const args = jsonObjectToRecord(call.arguments);
			const startedAt = Date.now();
			const signal = composeAbortSignals(params.signal, options?.signal);
			let didStartExecution = false;
			try {
				const preparedArgs = tool.prepareArguments ? tool.prepareArguments(args) : args;
				didStartExecution = true;
				const rawResult = await tool.execute(call.callId, preparedArgs, signal);
				const rawIsError = isToolResultError(rawResult);
				const middlewareResult = await middlewareRunner.applyToolResultMiddleware({
					threadId: call.threadId,
					turnId: call.turnId,
					toolCallId: call.callId,
					toolName: tool.name,
					args,
					isError: rawIsError,
					result: rawResult
				});
				const result = await legacyExtensionRunner.applyToolResultExtensions({
					threadId: call.threadId,
					turnId: call.turnId,
					toolCallId: call.callId,
					toolName: tool.name,
					args,
					result: middlewareResult
				});
				const resultIsError = rawIsError || isToolResultError(result);
				collectToolTelemetry({
					toolName: tool.name,
					args,
					result,
					mediaTrustResult: rawResult,
					telemetry,
					isError: resultIsError
				});
				runAgentHarnessAfterToolCallHook({
					toolName: tool.name,
					toolCallId: call.callId,
					runId: toolResultHookContext.runId,
					agentId: toolResultHookContext.agentId,
					sessionId: toolResultHookContext.sessionId,
					sessionKey: toolResultHookContext.sessionKey,
					channelId: toolResultHookContext.channelId,
					startArgs: args,
					result,
					startedAt
				});
				const terminalType = inferToolResultDiagnosticTerminalType(result, resultIsError);
				const response = withDiagnosticTerminalType({
					contentItems: convertToolContents(result.content, toolResultMaxChars),
					success: !resultIsError
				}, terminalType);
				withDynamicToolTermination(response, rawResult.terminate === true || result.terminate === true || isToolResultYield(rawResult) || isToolResultYield(result));
				return withSideEffectEvidence(response, terminalType !== "blocked");
			} catch (error) {
				collectToolTelemetry({
					toolName: tool.name,
					args,
					result: void 0,
					telemetry,
					isError: true
				});
				runAgentHarnessAfterToolCallHook({
					toolName: tool.name,
					toolCallId: call.callId,
					runId: toolResultHookContext.runId,
					agentId: toolResultHookContext.agentId,
					sessionId: toolResultHookContext.sessionId,
					sessionKey: toolResultHookContext.sessionKey,
					channelId: toolResultHookContext.channelId,
					startArgs: args,
					error: error instanceof Error ? error.message : String(error),
					startedAt
				});
				return withSideEffectEvidence(withDiagnosticTerminalType({
					contentItems: [{
						type: "inputText",
						text: error instanceof Error ? error.message : String(error)
					}],
					success: false
				}, "error"), didStartExecution);
			}
		}
	};
}
function createCodexDynamicToolSpec(params) {
	const base = {
		name: params.tool.name,
		description: params.tool.description,
		inputSchema: toJsonValue(params.tool.parameters)
	};
	if (params.loading === "direct" || params.directToolNames.has(params.tool.name)) return base;
	return {
		...base,
		namespace: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
		deferLoading: true
	};
}
function toToolResultHookContext(ctx) {
	const { agentId, sessionId, sessionKey, runId, channelId } = ctx ?? {};
	return {
		...agentId && { agentId },
		...sessionId && { sessionId },
		...sessionKey && { sessionKey },
		...runId && { runId },
		...channelId && { channelId }
	};
}
function resolveCodexDynamicToolResultMaxChars(ctx) {
	return resolveAgentContextLimitValue({
		config: ctx?.config,
		agentId: ctx?.agentId,
		key: "toolResultMaxChars"
	}) ?? DEFAULT_CODEX_DYNAMIC_TOOL_RESULT_MAX_CHARS;
}
function resolveAgentContextLimitValue(params) {
	const agents = readRecord(params.config?.agents);
	const defaultValue = readPositiveInteger(readRecord(readRecord(agents?.defaults)?.contextLimits)?.[params.key]);
	if (!params.agentId) return defaultValue;
	const list = agents?.list;
	if (!Array.isArray(list)) return defaultValue;
	const normalizedAgentId = normalizeAgentId(params.agentId);
	return readPositiveInteger(readRecord(readRecord(list.find((entry) => {
		const entryId = readRecord(entry)?.id;
		return typeof entryId === "string" && normalizeAgentId(entryId) === normalizedAgentId;
	}))?.contextLimits)?.[params.key]) ?? defaultValue;
}
function composeAbortSignals(...signals) {
	const activeSignals = signals.filter((signal) => Boolean(signal));
	if (activeSignals.length === 0) return new AbortController().signal;
	if (activeSignals.length === 1) return activeSignals[0];
	return AbortSignal.any(activeSignals);
}
function collectToolTelemetry(params) {
	if (params.isError) return;
	if (!params.isError && params.toolName === "cron" && isCronAddAction(params.args)) params.telemetry.successfulCronAdds = (params.telemetry.successfulCronAdds ?? 0) + 1;
	if (!params.isError && params.toolName === "heartbeat_respond") {
		const response = normalizeHeartbeatToolResponse(params.result?.details);
		if (response) params.telemetry.heartbeatToolResponse = response;
	}
	if (!params.isError && params.result) {
		const media = extractToolResultMediaArtifact(params.result);
		if (media) {
			const mediaUrls = filterToolResultMediaUrls(params.toolName, media.mediaUrls, params.mediaTrustResult ?? params.result);
			const seen = new Set(params.telemetry.toolMediaUrls);
			for (const mediaUrl of mediaUrls) if (!seen.has(mediaUrl)) {
				seen.add(mediaUrl);
				params.telemetry.toolMediaUrls.push(mediaUrl);
			}
			if (media.audioAsVoice) params.telemetry.toolAudioAsVoice = true;
		}
	}
	if (!isMessagingTool(params.toolName) || !isMessagingToolSendAction(params.toolName, params.args)) return;
	params.telemetry.didSendViaMessagingTool = true;
	const sourceReplyPayload = extractInternalSourceReplyPayload(params.result?.details);
	if (sourceReplyPayload) {
		params.telemetry.messagingToolSourceReplyPayloads.push(sourceReplyPayload);
		return;
	}
	const text = readFirstString(params.args, [
		"text",
		"message",
		"body",
		"content"
	]);
	if (text) params.telemetry.messagingToolSentTexts.push(text);
	const mediaUrls = collectMediaUrls(params.args);
	params.telemetry.messagingToolSentMediaUrls.push(...mediaUrls);
	params.telemetry.messagingToolSentTargets.push({
		tool: params.toolName,
		provider: readFirstString(params.args, ["provider", "channel"]) ?? params.toolName,
		accountId: readFirstString(params.args, ["accountId", "account_id"]),
		to: readFirstString(params.args, [
			"to",
			"target",
			"recipient"
		]),
		threadId: readFirstString(params.args, [
			"threadId",
			"thread_id",
			"messageThreadId"
		]),
		...text ? { text } : {},
		...mediaUrls.length > 0 ? { mediaUrls } : {}
	});
}
function extractInternalSourceReplyPayload(details) {
	if (!isRecord(details) || details.sourceReplySink !== "internal-ui") return;
	const rawPayload = details.sourceReply;
	if (!isRecord(rawPayload)) return;
	const text = readFirstString(rawPayload, ["text", "message"]);
	const mediaUrls = collectMediaUrls(rawPayload);
	const mediaUrl = typeof rawPayload.mediaUrl === "string" && rawPayload.mediaUrl.trim() ? rawPayload.mediaUrl.trim() : mediaUrls[0];
	const payload = {
		...text ? { text } : {},
		...mediaUrl ? { mediaUrl } : {},
		...mediaUrls.length > 0 ? { mediaUrls } : {},
		...rawPayload.audioAsVoice === true ? { audioAsVoice: true } : {},
		...isRecord(rawPayload.presentation) ? { presentation: rawPayload.presentation } : {},
		...isRecord(rawPayload.interactive) ? { interactive: rawPayload.interactive } : {},
		...isRecord(rawPayload.channelData) ? { channelData: rawPayload.channelData } : {},
		...typeof details.idempotencyKey === "string" && details.idempotencyKey.trim() ? { idempotencyKey: details.idempotencyKey.trim() } : {}
	};
	return text || mediaUrls.length > 0 || payload.presentation || payload.interactive ? payload : void 0;
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readRecord(value) {
	return isRecord(value) ? value : void 0;
}
function readPositiveInteger(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
	return Math.floor(value);
}
function isToolResultError(result) {
	const details = result.details;
	if (!isRecord(details)) return false;
	if (details.timedOut === true) return true;
	if (typeof details.exitCode === "number" && details.exitCode !== 0) return true;
	if (typeof details.status !== "string") return false;
	const status = details.status.trim().toLowerCase();
	return status !== "" && status !== "0" && status !== "ok" && status !== "success" && status !== "completed" && status !== "recorded" && status !== "pending" && status !== "started" && status !== "running" && status !== "yielded";
}
function isToolResultYield(result) {
	const details = result.details;
	if (!isRecord(details) || typeof details.status !== "string") return false;
	return details.status.trim().toLowerCase() === "yielded";
}
function inferToolResultDiagnosticTerminalType(result, isError) {
	const details = result.details;
	if (isRecord(details) && typeof details.status === "string") {
		if (details.status.trim().toLowerCase() === "blocked") return "blocked";
	}
	return isError ? "error" : "completed";
}
function withDiagnosticTerminalType(response, terminalType) {
	Object.defineProperty(response, "diagnosticTerminalType", {
		configurable: true,
		enumerable: false,
		value: terminalType
	});
	return response;
}
function withSideEffectEvidence(response, sideEffectEvidence) {
	if (!sideEffectEvidence) return response;
	Object.defineProperty(response, "sideEffectEvidence", {
		configurable: true,
		enumerable: false,
		value: true
	});
	return response;
}
function withDynamicToolTermination(response, terminate) {
	if (!terminate) return response;
	Object.defineProperty(response, "terminate", {
		configurable: true,
		enumerable: false,
		value: true
	});
	return response;
}
function normalizeToolResultMaxChars(maxChars) {
	return typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_CODEX_DYNAMIC_TOOL_RESULT_MAX_CHARS;
}
function convertToolContents(content, toolResultMaxChars = DEFAULT_CODEX_DYNAMIC_TOOL_RESULT_MAX_CHARS) {
	const maxChars = normalizeToolResultMaxChars(toolResultMaxChars);
	const totalTextChars = content.reduce((total, item) => total + (item.type === "text" ? item.text.length : 0), 0);
	if (totalTextChars <= maxChars) return content.flatMap(convertToolContent);
	const noticeText = `...(OpenClaw truncated dynamic tool result: original ${totalTextChars} chars, showing ${maxChars}; rerun with narrower args.)`;
	const notice = `\n${noticeText}`;
	let remainingTextBudget = Math.max(0, maxChars - notice.length);
	let appendedNotice = false;
	const output = [];
	for (const item of content) {
		if (item.type !== "text") {
			output.push(...convertToolContent(item));
			continue;
		}
		if (appendedNotice) continue;
		if (notice.length >= maxChars) {
			output.push({
				type: "inputText",
				text: noticeText.slice(0, maxChars)
			});
			appendedNotice = true;
			continue;
		}
		const sliceLength = Math.min(item.text.length, remainingTextBudget);
		remainingTextBudget -= sliceLength;
		const shouldAppendNotice = remainingTextBudget <= 0;
		const text = item.text.slice(0, sliceLength);
		if (shouldAppendNotice) {
			output.push({
				type: "inputText",
				text: `${text.trimEnd()}${notice}`.slice(0, maxChars)
			});
			appendedNotice = true;
		} else if (text.length > 0) output.push({
			type: "inputText",
			text
		});
	}
	if (!appendedNotice) output.push({
		type: "inputText",
		text: noticeText.slice(0, maxChars)
	});
	return output;
}
function convertToolContent(content) {
	if (content.type === "text") return [{
		type: "inputText",
		text: content.text
	}];
	const imageUrl = sanitizeInlineImageDataUrl(`data:${content.mimeType};base64,${content.data}`);
	if (!imageUrl) return [{
		type: "inputText",
		text: invalidInlineImageText("codex dynamic tool")
	}];
	return [{
		type: "inputImage",
		imageUrl
	}];
}
function toJsonValue(value) {
	try {
		const text = JSON.stringify(value);
		if (!text) return {};
		return JSON.parse(text);
	} catch {
		return {};
	}
}
function jsonObjectToRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value;
}
function readFirstString(record, keys) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
}
function collectMediaUrls(record) {
	const urls = [];
	const pushMediaUrl = (value) => {
		if (typeof value === "string" && value.trim()) urls.push(value.trim());
	};
	const pushAttachment = (value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		const attachment = value;
		for (const key of [
			"media",
			"mediaUrl",
			"path",
			"filePath",
			"fileUrl",
			"url"
		]) pushMediaUrl(attachment[key]);
	};
	for (const key of [
		"media",
		"mediaUrl",
		"media_url",
		"path",
		"filePath",
		"fileUrl",
		"imageUrl",
		"image_url"
	]) {
		const value = record[key];
		pushMediaUrl(value);
	}
	for (const key of [
		"mediaUrls",
		"media_urls",
		"imageUrls",
		"image_urls"
	]) {
		const value = record[key];
		if (!Array.isArray(value)) continue;
		for (const entry of value) pushMediaUrl(entry);
	}
	const attachments = record.attachments;
	if (Array.isArray(attachments)) for (const attachment of attachments) pushAttachment(attachment);
	return urls;
}
function isCronAddAction(args) {
	const action = args.action;
	return typeof action === "string" && action.trim().toLowerCase() === "add";
}
//#endregion
export { resolveCodexDynamicToolsLoading as a, normalizeCodexDynamicToolName as i, filterCodexDynamicTools as n, isForcedPrivateQaCodexRuntime as r, createCodexDynamicToolBridge as t };
