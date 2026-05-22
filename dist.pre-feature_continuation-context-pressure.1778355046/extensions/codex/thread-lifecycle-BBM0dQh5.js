import { c as wrapToolWithBeforeToolCallHook, o as isToolWrappedWithBeforeToolCallHook } from "../../pi-tools.before-tool-call-B3h4zwpd.js";
import { t as createAgentToolResultMiddlewareRunner } from "../../tool-result-middleware-CbzEiiiD.js";
import { t as log } from "../../logger-WjiJP55B.js";
import { o as normalizeHeartbeatToolResponse } from "../../heartbeat-tool-response-Doen4xTo.js";
import { S as isMessagingToolSendAction, g as filterToolResultMediaUrls, m as extractToolResultMediaArtifact, x as isMessagingTool } from "../../attempt.tool-run-context-DWoeab5E.js";
import { a as createCodexAppServerToolResultExtensionRunner } from "../../agent-harness-runtime-PIBBM_v4.js";
import { s as runAgentHarnessAfterToolCallHook } from "../../native-hook-relay-6YJn9VwN.js";
import { n as codexSandboxPolicyForTurn } from "./config-BVzPOnLj.js";
import { n as assertCodexThreadStartResponse, t as assertCodexThreadResumeResponse } from "./protocol-validators-6gWH5imQ.js";
import { t as isJsonObject } from "./protocol-C7oB2RlO.js";
import { n as CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY, r as renderCodexPromptOverlay } from "./prompt-overlay-DL6NQHJ4.js";
import { r as isModernCodexModel } from "./provider-DL2UQx5g.js";
import { i as isCodexAppServerConnectionClosedError } from "./client-ByhkhNJH.js";
import { i as readCodexAppServerBinding, n as isCodexAppServerNativeAuthProfile, o as writeCodexAppServerBinding, t as clearCodexAppServerBinding } from "./session-binding-BinCZ7G0.js";
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
	const toolResultHookContext = toToolResultHookContext(params.hookContext);
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
		...toolResultHookContext
	});
	const legacyExtensionRunner = createCodexAppServerToolResultExtensionRunner(toolResultHookContext);
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
					startArgs: args,
					result,
					startedAt
				});
				return {
					contentItems: result.content.flatMap(convertToolContent),
					success: !resultIsError
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
					runId: toolResultHookContext.runId,
					agentId: toolResultHookContext.agentId,
					sessionId: toolResultHookContext.sessionId,
					sessionKey: toolResultHookContext.sessionKey,
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
function toToolResultHookContext(ctx) {
	const { agentId, sessionId, sessionKey, runId } = ctx ?? {};
	return {
		...agentId && { agentId },
		...sessionId && { sessionId },
		...sessionKey && { sessionKey },
		...runId && { runId }
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
	const binding = await readCodexAppServerBinding(params.params.sessionFile, {
		authProfileStore: params.params.authProfileStore,
		agentDir: params.params.agentDir,
		config: params.params.config
	});
	let preserveExistingBinding = false;
	if (binding?.threadId) if (binding.dynamicToolsFingerprint && !areDynamicToolFingerprintsCompatible(binding.dynamicToolsFingerprint, dynamicToolsFingerprint)) {
		preserveExistingBinding = shouldStartTransientNoToolThread({
			previous: binding.dynamicToolsFingerprint,
			next: dynamicToolsFingerprint
		});
		if (preserveExistingBinding) log.debug("codex app-server dynamic tools unavailable for turn; starting transient thread", { threadId: binding.threadId });
		else {
			log.debug("codex app-server dynamic tool catalog changed; starting a new thread", { threadId: binding.threadId });
			await clearCodexAppServerBinding(params.params.sessionFile);
		}
	} else try {
		const authProfileId = params.params.authProfileId ?? binding.authProfileId;
		const response = assertCodexThreadResumeResponse(await params.client.request("thread/resume", buildThreadResumeParams(params.params, {
			threadId: binding.threadId,
			authProfileId,
			appServer: params.appServer,
			developerInstructions: params.developerInstructions,
			config: params.config
		})));
		const boundAuthProfileId = authProfileId;
		const fallbackModelProvider = resolveCodexAppServerModelProvider({
			provider: params.params.provider,
			authProfileId: boundAuthProfileId,
			authProfileStore: params.params.authProfileStore,
			agentDir: params.params.agentDir,
			config: params.params.config
		});
		await writeCodexAppServerBinding(params.params.sessionFile, {
			threadId: response.thread.id,
			cwd: params.cwd,
			authProfileId: boundAuthProfileId,
			model: params.params.modelId,
			modelProvider: response.modelProvider ?? fallbackModelProvider,
			dynamicToolsFingerprint,
			createdAt: binding.createdAt
		}, {
			authProfileStore: params.params.authProfileStore,
			agentDir: params.params.agentDir,
			config: params.params.config
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
	const modelProvider = resolveCodexAppServerModelProvider({
		provider: params.params.provider,
		authProfileId: params.params.authProfileId,
		authProfileStore: params.params.authProfileStore,
		agentDir: params.params.agentDir,
		config: params.params.config
	});
	const createdAt = (/* @__PURE__ */ new Date()).toISOString();
	if (!preserveExistingBinding) await writeCodexAppServerBinding(params.params.sessionFile, {
		threadId: response.thread.id,
		cwd: params.cwd,
		authProfileId: params.params.authProfileId,
		model: response.model ?? params.params.modelId,
		modelProvider: response.modelProvider ?? modelProvider,
		dynamicToolsFingerprint,
		createdAt
	}, {
		authProfileStore: params.params.authProfileStore,
		agentDir: params.params.agentDir,
		config: params.params.config
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
	const modelProvider = resolveCodexAppServerModelProvider({
		provider: params.provider,
		authProfileId: params.authProfileId,
		authProfileStore: params.authProfileStore,
		agentDir: params.agentDir,
		config: params.config
	});
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
	const modelProvider = resolveCodexAppServerModelProvider({
		provider: params.provider,
		authProfileId: options.authProfileId ?? params.authProfileId,
		authProfileStore: params.authProfileStore,
		agentDir: params.agentDir,
		config: params.config
	});
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
		effort: resolveReasoningEffort(params.thinkLevel, params.modelId),
		collaborationMode: buildTurnCollaborationMode(params)
	};
}
function buildTurnCollaborationMode(params) {
	return {
		mode: "default",
		settings: {
			model: params.modelId,
			reasoning_effort: resolveReasoningEffort(params.thinkLevel, params.modelId),
			developer_instructions: params.trigger === "heartbeat" ? buildHeartbeatCollaborationInstructions() : null
		}
	};
}
function buildHeartbeatCollaborationInstructions() {
	return ["This is an OpenClaw heartbeat turn. Apply these instructions only to this heartbeat wake; ordinary chat turns should stay in Codex Default mode.", CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY].join("\n\n");
}
function codexDynamicToolsFingerprint(dynamicTools) {
	return fingerprintDynamicTools(dynamicTools);
}
function areCodexDynamicToolFingerprintsCompatible(params) {
	return areDynamicToolFingerprintsCompatible(params.previous, params.next);
}
function fingerprintDynamicTools(dynamicTools) {
	return JSON.stringify(dynamicTools.map(fingerprintDynamicToolSpec).toSorted(compareJsonFingerprint));
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
const EMPTY_DYNAMIC_TOOLS_FINGERPRINT = JSON.stringify([]);
function areDynamicToolFingerprintsCompatible(previous, next) {
	return !previous || previous === next;
}
function shouldStartTransientNoToolThread(params) {
	return Boolean(params.previous && params.previous !== EMPTY_DYNAMIC_TOOLS_FINGERPRINT && params.next === EMPTY_DYNAMIC_TOOLS_FINGERPRINT);
}
function compareJsonFingerprint(left, right) {
	return JSON.stringify(left).localeCompare(JSON.stringify(right));
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
function resolveCodexAppServerModelProvider(params) {
	const normalized = params.provider.trim();
	const normalizedLower = normalized.toLowerCase();
	if (!normalized || normalizedLower === "codex") return;
	if (isCodexAppServerNativeAuthProfile(params) && (normalizedLower === "openai" || normalizedLower === "openai-codex")) return;
	return normalizedLower === "openai-codex" ? "openai" : normalized;
}
function resolveReasoningEffort(thinkLevel, modelId) {
	if (thinkLevel === "minimal") return isModernCodexModel(modelId) ? "low" : "minimal";
	if (thinkLevel === "low" || thinkLevel === "medium" || thinkLevel === "high" || thinkLevel === "xhigh") return thinkLevel;
	return null;
}
//#endregion
export { buildTurnStartParams as a, createCodexDynamicToolBridge as c, buildThreadStartParams as i, applyCodexDynamicToolProfile as l, buildDeveloperInstructions as n, codexDynamicToolsFingerprint as o, buildThreadResumeParams as r, startOrResumeThread as s, areCodexDynamicToolFingerprintsCompatible as t };
