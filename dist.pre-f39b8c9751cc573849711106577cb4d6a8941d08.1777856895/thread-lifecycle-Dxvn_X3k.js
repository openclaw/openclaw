import { t as createAgentToolResultMiddlewareRunner } from "./tool-result-middleware-MXGuUxem.js";
import { t as log } from "./logger-U0HIdILh.js";
import { o as normalizeHeartbeatToolResponse } from "./heartbeat-tool-response-CTyHn3i6.js";
import { C as isMessagingToolSendAction, S as isMessagingTool, _ as filterToolResultMediaUrls, h as extractToolResultMediaArtifact } from "./attempt.tool-run-context-B8OaKaso.js";
import { c as wrapToolWithBeforeToolCallHook, o as isToolWrappedWithBeforeToolCallHook } from "./pi-tools.before-tool-call-DziqPH_s.js";
import { a as createCodexAppServerToolResultExtensionRunner } from "./agent-harness-runtime-DLpMbxR3.js";
import { s as runAgentHarnessAfterToolCallHook } from "./native-hook-relay-lD2JIRfO.js";
import { n as codexSandboxPolicyForTurn } from "./config-CVmqAfsu.js";
import { n as assertCodexThreadStartResponse, t as assertCodexThreadResumeResponse } from "./protocol-validators-Cg-Bl4Jq.js";
import { t as isJsonObject } from "./protocol-Dqzc0_23.js";
import { n as renderCodexPromptOverlay } from "./prompt-overlay-nghGAgfu.js";
import { r as isModernCodexModel } from "./provider-C49pN-e_.js";
import { i as isCodexAppServerConnectionClosedError } from "./client-Ch0ySBc-.js";
import { i as writeCodexAppServerBinding, n as readCodexAppServerBinding, t as clearCodexAppServerBinding } from "./session-binding-C4jYxemL.js";
//#region extensions/codex/src/app-server/dynamic-tool-profile.ts
const CODEX_NATIVE_FIRST_DYNAMIC_TOOL_EXCLUDES = [
	"read",
	"write",
	"edit",
	"apply_patch",
	"exec",
	"process",
	"update_plan"
];
function applyCodexDynamicToolProfile(tools, config) {
	const excludes = /* @__PURE__ */ new Set();
	if ((config.codexDynamicToolsProfile ?? "native-first") === "native-first") for (const name of CODEX_NATIVE_FIRST_DYNAMIC_TOOL_EXCLUDES) excludes.add(name);
	for (const name of config.codexDynamicToolsExclude ?? []) {
		const trimmed = name.trim();
		if (trimmed) excludes.add(trimmed);
	}
	return excludes.size === 0 ? tools : tools.filter((tool) => !excludes.has(tool.name));
}
//#endregion
//#region extensions/codex/src/app-server/dynamic-tools.ts
function createCodexDynamicToolBridge(params) {
	const tools = params.tools.map((tool) => isToolWrappedWithBeforeToolCallHook(tool) ? tool : wrapToolWithBeforeToolCallHook(tool, params.hookContext));
	const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
	const telemetry = {
		didSendViaMessagingTool: false,
		messagingToolSentTexts: [],
		messagingToolSentMediaUrls: [],
		messagingToolSentTargets: [],
		toolMediaUrls: [],
		toolAudioAsVoice: false
	};
	const middlewareRunner = createAgentToolResultMiddlewareRunner({
		runtime: "codex",
		...params.hookContext
	});
	const legacyExtensionRunner = createCodexAppServerToolResultExtensionRunner(params.hookContext ?? {});
	return {
		specs: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: toJsonValue(tool.parameters)
		})),
		telemetry,
		handleToolCall: async (call, options) => {
			const tool = toolMap.get(call.tool);
			if (!tool) return {
				contentItems: [{
					type: "inputText",
					text: `Unknown OpenClaw tool: ${call.tool}`
				}],
				success: false
			};
			const args = jsonObjectToRecord(call.arguments);
			const startedAt = Date.now();
			const signal = composeAbortSignals(params.signal, options?.signal);
			try {
				const preparedArgs = tool.prepareArguments ? tool.prepareArguments(args) : args;
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
				collectToolTelemetry({
					toolName: tool.name,
					args,
					result,
					mediaTrustResult: rawResult,
					telemetry,
					isError: rawIsError || isToolResultError(result)
				});
				runAgentHarnessAfterToolCallHook({
					toolName: tool.name,
					toolCallId: call.callId,
					runId: params.hookContext?.runId,
					agentId: params.hookContext?.agentId,
					sessionId: params.hookContext?.sessionId,
					sessionKey: params.hookContext?.sessionKey,
					startArgs: args,
					result,
					startedAt
				});
				return {
					contentItems: result.content.flatMap(convertToolContent),
					success: true
				};
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
					runId: params.hookContext?.runId,
					agentId: params.hookContext?.agentId,
					sessionId: params.hookContext?.sessionId,
					sessionKey: params.hookContext?.sessionKey,
					startArgs: args,
					error: error instanceof Error ? error.message : String(error),
					startedAt
				});
				return {
					contentItems: [{
						type: "inputText",
						text: error instanceof Error ? error.message : String(error)
					}],
					success: false
				};
			}
		}
	};
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
	const text = readFirstString(params.args, [
		"text",
		"message",
		"body",
		"content"
	]);
	if (text) params.telemetry.messagingToolSentTexts.push(text);
	params.telemetry.messagingToolSentMediaUrls.push(...collectMediaUrls(params.args));
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
		])
	});
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isToolResultError(result) {
	const details = result.details;
	if (!isRecord(details)) return false;
	if (details.timedOut === true) return true;
	if (typeof details.exitCode === "number" && details.exitCode !== 0) return true;
	if (typeof details.status !== "string") return false;
	const status = details.status.trim().toLowerCase();
	return status !== "" && status !== "0" && status !== "ok" && status !== "success" && status !== "completed" && status !== "recorded" && status !== "running";
}
function convertToolContent(content) {
	if (content.type === "text") return [{
		type: "inputText",
		text: content.text
	}];
	return [{
		type: "inputImage",
		imageUrl: `data:${content.mimeType};base64,${content.data}`
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
	for (const key of [
		"mediaUrl",
		"media_url",
		"imageUrl",
		"image_url"
	]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) urls.push(value.trim());
	}
	for (const key of [
		"mediaUrls",
		"media_urls",
		"imageUrls",
		"image_urls"
	]) {
		const value = record[key];
		if (!Array.isArray(value)) continue;
		for (const entry of value) if (typeof entry === "string" && entry.trim()) urls.push(entry.trim());
	}
	return urls;
}
function isCronAddAction(args) {
	const action = args.action;
	return typeof action === "string" && action.trim().toLowerCase() === "add";
}
//#endregion
//#region extensions/codex/src/app-server/thread-lifecycle.ts
async function startOrResumeThread(params) {
	const dynamicToolsFingerprint = fingerprintDynamicTools(params.dynamicTools);
	const binding = await readCodexAppServerBinding(params.params.sessionFile);
	if (binding?.threadId) if (binding.dynamicToolsFingerprint && binding.dynamicToolsFingerprint !== dynamicToolsFingerprint) {
		log.debug("codex app-server dynamic tool catalog changed; starting a new thread", { threadId: binding.threadId });
		await clearCodexAppServerBinding(params.params.sessionFile);
	} else try {
		const response = assertCodexThreadResumeResponse(await params.client.request("thread/resume", buildThreadResumeParams(params.params, {
			threadId: binding.threadId,
			appServer: params.appServer,
			developerInstructions: params.developerInstructions,
			config: params.config
		})));
		const boundAuthProfileId = params.params.authProfileId ?? binding.authProfileId;
		const fallbackModelProvider = resolveCodexAppServerModelProvider(params.params.provider);
		await writeCodexAppServerBinding(params.params.sessionFile, {
			threadId: response.thread.id,
			cwd: params.cwd,
			authProfileId: boundAuthProfileId,
			model: params.params.modelId,
			modelProvider: response.modelProvider ?? fallbackModelProvider,
			dynamicToolsFingerprint,
			createdAt: binding.createdAt
		});
		return {
			...binding,
			threadId: response.thread.id,
			cwd: params.cwd,
			authProfileId: boundAuthProfileId,
			model: params.params.modelId,
			modelProvider: response.modelProvider ?? fallbackModelProvider,
			dynamicToolsFingerprint
		};
	} catch (error) {
		if (isCodexAppServerConnectionClosedError(error)) throw error;
		log.warn("codex app-server thread resume failed; starting a new thread", { error });
		await clearCodexAppServerBinding(params.params.sessionFile);
	}
	const response = assertCodexThreadStartResponse(await params.client.request("thread/start", buildThreadStartParams(params.params, {
		cwd: params.cwd,
		dynamicTools: params.dynamicTools,
		appServer: params.appServer,
		developerInstructions: params.developerInstructions,
		config: params.config
	})));
	const modelProvider = resolveCodexAppServerModelProvider(params.params.provider);
	const createdAt = (/* @__PURE__ */ new Date()).toISOString();
	await writeCodexAppServerBinding(params.params.sessionFile, {
		threadId: response.thread.id,
		cwd: params.cwd,
		authProfileId: params.params.authProfileId,
		model: response.model ?? params.params.modelId,
		modelProvider: response.modelProvider ?? modelProvider,
		dynamicToolsFingerprint,
		createdAt
	});
	return {
		schemaVersion: 1,
		threadId: response.thread.id,
		sessionFile: params.params.sessionFile,
		cwd: params.cwd,
		authProfileId: params.params.authProfileId,
		model: response.model ?? params.params.modelId,
		modelProvider: response.modelProvider ?? modelProvider,
		dynamicToolsFingerprint,
		createdAt,
		updatedAt: createdAt
	};
}
function buildThreadStartParams(params, options) {
	const modelProvider = resolveCodexAppServerModelProvider(params.provider);
	return {
		model: params.modelId,
		...modelProvider ? { modelProvider } : {},
		cwd: options.cwd,
		approvalPolicy: options.appServer.approvalPolicy,
		approvalsReviewer: options.appServer.approvalsReviewer,
		sandbox: options.appServer.sandbox,
		...options.appServer.serviceTier ? { serviceTier: options.appServer.serviceTier } : {},
		serviceName: "OpenClaw",
		...options.config ? { config: options.config } : {},
		developerInstructions: options.developerInstructions ?? buildDeveloperInstructions(params),
		dynamicTools: options.dynamicTools,
		experimentalRawEvents: true,
		persistExtendedHistory: true
	};
}
function buildThreadResumeParams(params, options) {
	const modelProvider = resolveCodexAppServerModelProvider(params.provider);
	return {
		threadId: options.threadId,
		model: params.modelId,
		...modelProvider ? { modelProvider } : {},
		approvalPolicy: options.appServer.approvalPolicy,
		approvalsReviewer: options.appServer.approvalsReviewer,
		sandbox: options.appServer.sandbox,
		...options.appServer.serviceTier ? { serviceTier: options.appServer.serviceTier } : {},
		...options.config ? { config: options.config } : {},
		developerInstructions: options.developerInstructions ?? buildDeveloperInstructions(params),
		persistExtendedHistory: true
	};
}
function buildTurnStartParams(params, options) {
	return {
		threadId: options.threadId,
		input: buildUserInput(params, options.promptText),
		cwd: options.cwd,
		approvalPolicy: options.appServer.approvalPolicy,
		approvalsReviewer: options.appServer.approvalsReviewer,
		sandboxPolicy: codexSandboxPolicyForTurn(options.appServer.sandbox, options.cwd),
		model: params.modelId,
		...options.appServer.serviceTier ? { serviceTier: options.appServer.serviceTier } : {},
		effort: resolveReasoningEffort(params.thinkLevel, params.modelId)
	};
}
function fingerprintDynamicTools(dynamicTools) {
	return JSON.stringify(dynamicTools.map(fingerprintDynamicToolSpec));
}
function fingerprintDynamicToolSpec(tool) {
	if (!isJsonObject(tool)) return stabilizeJsonValue(tool);
	const stable = {};
	for (const [key, child] of Object.entries(tool).toSorted(([left], [right]) => left.localeCompare(right))) {
		if (key === "description") continue;
		stable[key] = stabilizeJsonValue(child);
	}
	return stable;
}
function stabilizeJsonValue(value) {
	if (Array.isArray(value)) return value.map(stabilizeJsonValue);
	if (!isJsonObject(value)) return value;
	const stable = {};
	for (const [key, child] of Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))) stable[key] = stabilizeJsonValue(child);
	return stable;
}
function buildDeveloperInstructions(params) {
	return [
		"You are running inside OpenClaw. Use OpenClaw dynamic tools for OpenClaw-specific integrations such as messaging, cron, sessions, media, gateway, and nodes when available.",
		"Preserve the user's existing channel/session context. If sending a channel reply, use the OpenClaw messaging tool instead of describing that you would reply.",
		renderCodexRuntimePromptOverlay(params),
		params.extraSystemPrompt,
		params.skillsSnapshot?.prompt
	].filter((section) => typeof section === "string" && section.trim()).join("\n\n");
}
function renderCodexRuntimePromptOverlay(params) {
	const contribution = params.runtimePlan?.prompt.resolveSystemPromptContribution({
		config: params.config,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		provider: params.provider,
		modelId: params.modelId,
		promptMode: "full",
		agentId: params.agentId
	});
	if (!contribution) return renderCodexPromptOverlay({
		config: params.config,
		providerId: params.provider,
		modelId: params.modelId
	});
	return [
		contribution.stablePrefix,
		...Object.values(contribution.sectionOverrides ?? {}),
		contribution.dynamicSuffix
	].filter((section) => typeof section === "string" && section.trim().length > 0).join("\n\n");
}
function buildUserInput(params, promptText = params.prompt) {
	return [{
		type: "text",
		text: promptText,
		text_elements: []
	}, ...(params.images ?? []).map((image) => ({
		type: "image",
		url: `data:${image.mimeType};base64,${image.data}`
	}))];
}
function resolveCodexAppServerModelProvider(provider) {
	const normalized = provider.trim();
	if (!normalized || normalized === "codex") return;
	return normalized === "openai-codex" ? "openai" : normalized;
}
function resolveReasoningEffort(thinkLevel, modelId) {
	if (thinkLevel === "minimal") return isModernCodexModel(modelId) ? "low" : "minimal";
	if (thinkLevel === "low" || thinkLevel === "medium" || thinkLevel === "high" || thinkLevel === "xhigh") return thinkLevel;
	return null;
}
//#endregion
export { startOrResumeThread as a, buildTurnStartParams as i, buildThreadResumeParams as n, createCodexDynamicToolBridge as o, buildThreadStartParams as r, applyCodexDynamicToolProfile as s, buildDeveloperInstructions as t };
