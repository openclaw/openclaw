import { l as wrapToolWithBeforeToolCallHook, s as isToolWrappedWithBeforeToolCallHook } from "./pi-tools.before-tool-call-BAsFa_dg.js";
import { t as createAgentToolResultMiddlewareRunner } from "./tool-result-middleware-Db49hsXk.js";
import { o as normalizeHeartbeatToolResponse } from "./heartbeat-tool-response-3_26S-Cy.js";
import { S as isMessagingToolSendAction, g as filterToolResultMediaUrls, m as extractToolResultMediaArtifact, x as isMessagingTool } from "./attempt.tool-run-context-TFGsfpWy.js";
import { t as log } from "./logger-DM7utI1X.js";
import { a as createCodexAppServerToolResultExtensionRunner } from "./agent-harness-runtime-Db7--TWF.js";
import { s as runAgentHarnessAfterToolCallHook } from "./native-hook-relay-JIA_iULB.js";
import { l as resolveCodexPluginsPolicy, r as codexSandboxPolicyForTurn } from "./config-DsRdKnC3.js";
import { n as assertCodexThreadStartResponse, t as assertCodexThreadResumeResponse } from "./protocol-validators-DNrgzxsT.js";
import { t as isJsonObject } from "./protocol-Bk1aN7ce.js";
import { n as CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY, r as renderCodexPromptOverlay } from "./prompt-overlay-DEPyA00r.js";
import { r as isModernCodexModel } from "./provider-Dc59h5gn.js";
import { i as isCodexAppServerConnectionClosedError } from "./client-DHhpKlwI.js";
import { i as readCodexAppServerBinding, n as isCodexAppServerNativeAuthProfile, o as writeCodexAppServerBinding, t as clearCodexAppServerBinding } from "./session-binding-3xSqhiKt.js";
import { i as defaultCodexAppInventoryCache, n as readCodexPluginInventory, t as ensureCodexPluginActivation } from "./plugin-activation-Z9abykXE.js";
import crypto from "node:crypto";
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
const DYNAMIC_TOOL_NAME_ALIASES = {
	bash: "exec",
	"apply-patch": "apply_patch"
};
function normalizeCodexDynamicToolName(name) {
	const normalized = name.trim().toLowerCase();
	return DYNAMIC_TOOL_NAME_ALIASES[normalized] ?? normalized;
}
function applyCodexDynamicToolProfile(tools, config) {
	const excludes = /* @__PURE__ */ new Set();
	if ((config.codexDynamicToolsProfile ?? "native-first") === "native-first") for (const name of CODEX_NATIVE_FIRST_DYNAMIC_TOOL_EXCLUDES) excludes.add(name);
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
	const directToolNames = new Set([...ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES, ...params.directToolNames ?? []]);
	return {
		specs: tools.map((tool) => createCodexDynamicToolSpec({
			tool,
			loading: params.loading ?? "searchable",
			directToolNames
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
//#region extensions/codex/src/app-server/plugin-thread-config.ts
const CODEX_PLUGIN_THREAD_CONFIG_INPUT_FINGERPRINT_VERSION = 1;
const CODEX_PLUGIN_THREAD_CONFIG_FINGERPRINT_VERSION = 1;
function shouldBuildCodexPluginThreadConfig(pluginConfig) {
	return resolveCodexPluginsPolicy(pluginConfig).configured;
}
function buildCodexPluginThreadConfigInputFingerprint(params) {
	return fingerprintJson({
		version: CODEX_PLUGIN_THREAD_CONFIG_INPUT_FINGERPRINT_VERSION,
		policy: policyFingerprint(resolveCodexPluginsPolicy(params.pluginConfig)),
		appCacheKey: params.appCacheKey ?? null
	});
}
async function buildCodexPluginThreadConfig(params) {
	const appCache = params.appCache ?? defaultCodexAppInventoryCache;
	let inputFingerprint = buildCodexPluginThreadConfigInputFingerprint({
		pluginConfig: params.pluginConfig,
		appCacheKey: params.appCacheKey
	});
	const policy = resolveCodexPluginsPolicy(params.pluginConfig);
	if (!policy.enabled) return emptyPluginThreadConfig({
		enabled: false,
		inputFingerprint,
		configPatch: buildDisabledAppsConfigPatch()
	});
	let inventory = await readCodexPluginInventory({
		pluginConfig: params.pluginConfig,
		policy,
		request: params.request,
		appCache,
		appCacheKey: params.appCacheKey,
		nowMs: params.nowMs
	});
	if (shouldWaitForInitialAppInventory(params, policy, inventory)) {
		await refreshAppInventoryNow(params, appCache);
		inventory = await readCodexPluginInventory({
			pluginConfig: params.pluginConfig,
			policy,
			request: params.request,
			appCache,
			appCacheKey: params.appCacheKey,
			nowMs: params.nowMs
		});
		inputFingerprint = buildCodexPluginThreadConfigInputFingerprint({
			pluginConfig: params.pluginConfig,
			appCacheKey: params.appCacheKey
		});
	}
	const activationDiagnostics = [];
	const activationResults = [];
	for (const record of inventory.records) {
		if (!record.activationRequired) continue;
		const activation = await ensureCodexPluginActivation({
			identity: record.policy,
			request: params.request,
			appCache,
			appCacheKey: params.appCacheKey
		});
		activationResults.push(activation);
		if (!activation.ok) activationDiagnostics.push({
			code: "plugin_activation_failed",
			plugin: record.policy,
			message: activation.diagnostics.map((item) => item.message).join(" ") || activation.reason
		});
	}
	if (activationResults.some((activation) => activation.ok && activation.installAttempted)) {
		await refreshAppInventoryNow(params, appCache, { forceRefetch: true });
		inventory = await readCodexPluginInventory({
			pluginConfig: params.pluginConfig,
			policy,
			request: params.request,
			appCache,
			appCacheKey: params.appCacheKey,
			nowMs: params.nowMs
		});
		inputFingerprint = buildCodexPluginThreadConfigInputFingerprint({
			pluginConfig: params.pluginConfig,
			appCacheKey: params.appCacheKey
		});
	}
	const diagnostics = [...inventory.diagnostics, ...activationDiagnostics];
	const apps = { _default: {
		enabled: false,
		destructive_enabled: false,
		open_world_enabled: false
	} };
	const policyApps = {};
	const pluginAppIds = {};
	for (const record of inventory.records) {
		if (record.activationRequired) {
			if (!activationResults.find((item) => item.identity.configKey === record.policy.configKey)?.ok) continue;
		}
		if (record.appOwnership !== "proven") continue;
		pluginAppIds[record.policy.configKey] = [...record.ownedAppIds].toSorted();
		for (const app of record.apps) {
			if (!app.accessible || !app.enabled) {
				diagnostics.push({
					code: "app_not_ready",
					plugin: record.policy,
					message: `${app.id} is not accessible or enabled for ${record.policy.pluginName}.`
				});
				continue;
			}
			const appConfig = {
				enabled: true,
				destructive_enabled: record.policy.allowDestructiveActions,
				open_world_enabled: true,
				default_tools_approval_mode: "prompt"
			};
			apps[app.id] = appConfig;
			policyApps[app.id] = {
				configKey: record.policy.configKey,
				marketplaceName: record.policy.marketplaceName,
				pluginName: record.policy.pluginName,
				allowDestructiveActions: record.policy.allowDestructiveActions,
				mcpServerNames: [...record.detail?.mcpServers ?? []].toSorted()
			};
		}
	}
	const configPatch = { apps };
	const policyContext = buildPluginAppPolicyContext(policyApps, pluginAppIds);
	return {
		enabled: true,
		configPatch,
		fingerprint: fingerprintJson({
			version: CODEX_PLUGIN_THREAD_CONFIG_FINGERPRINT_VERSION,
			inputFingerprint,
			configPatch,
			policyContext
		}),
		inputFingerprint,
		policyContext,
		inventory,
		diagnostics
	};
}
function mergeCodexThreadConfigs(...configs) {
	let merged;
	for (const config of configs) {
		if (!config) continue;
		merged = mergeJsonObjects(merged ?? {}, config);
	}
	return merged && Object.keys(merged).length > 0 ? merged : void 0;
}
function isCodexPluginThreadBindingStale(params) {
	if (!params.codexPluginsEnabled) return Boolean(params.bindingFingerprint || params.bindingInputFingerprint || params.hasBindingPolicyContext);
	if (!params.bindingFingerprint || !params.bindingInputFingerprint || !params.hasBindingPolicyContext) return true;
	return params.bindingInputFingerprint !== params.currentInputFingerprint;
}
function emptyPluginThreadConfig(params) {
	const policyContext = buildPluginAppPolicyContext({}, {});
	return {
		enabled: params.enabled,
		fingerprint: fingerprintJson({
			version: CODEX_PLUGIN_THREAD_CONFIG_FINGERPRINT_VERSION,
			inputFingerprint: params.inputFingerprint,
			configPatch: params.configPatch ?? null,
			policyContext
		}),
		inputFingerprint: params.inputFingerprint,
		...params.configPatch ? { configPatch: params.configPatch } : {},
		policyContext,
		diagnostics: []
	};
}
function buildDisabledAppsConfigPatch() {
	return { apps: { _default: {
		enabled: false,
		destructive_enabled: false,
		open_world_enabled: false
	} } };
}
function buildPluginAppPolicyContext(apps, pluginAppIds) {
	return {
		fingerprint: fingerprintJson({
			version: 1,
			apps,
			pluginAppIds
		}),
		apps,
		pluginAppIds
	};
}
function shouldWaitForInitialAppInventory(params, policy, inventory) {
	return Boolean(params.appCacheKey && policy.pluginPolicies.some((plugin) => plugin.enabled) && inventory.appInventory?.state === "missing");
}
async function refreshAppInventoryNow(params, appCache, options = {}) {
	const appCacheKey = params.appCacheKey;
	if (!appCacheKey) return;
	const request = async (method, requestParams) => await params.request(method, requestParams);
	try {
		await appCache.refreshNow({
			key: appCacheKey,
			request,
			nowMs: params.nowMs,
			forceRefetch: options.forceRefetch
		});
	} catch {}
}
function policyFingerprint(policy) {
	return {
		enabled: policy.enabled,
		allowDestructiveActions: policy.allowDestructiveActions,
		plugins: policy.pluginPolicies.map((plugin) => ({
			configKey: plugin.configKey,
			marketplaceName: plugin.marketplaceName,
			pluginName: plugin.pluginName,
			enabled: plugin.enabled,
			allowDestructiveActions: plugin.allowDestructiveActions
		}))
	};
}
function mergeJsonObjects(left, right) {
	const merged = { ...left };
	for (const [key, value] of Object.entries(right)) {
		const existing = merged[key];
		merged[key] = isPlainJsonObject(existing) && isPlainJsonObject(value) ? mergeJsonObjects(existing, value) : value;
	}
	return merged;
}
function isPlainJsonObject(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function fingerprintJson(value) {
	return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}
function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
	return JSON.stringify(value);
}
//#endregion
//#region extensions/codex/src/app-server/thread-lifecycle.ts
async function startOrResumeThread(params) {
	const dynamicToolsFingerprint = fingerprintDynamicTools(params.dynamicTools);
	let binding = await readCodexAppServerBinding(params.params.sessionFile, {
		authProfileStore: params.params.authProfileStore,
		agentDir: params.params.agentDir,
		config: params.params.config
	});
	let preserveExistingBinding = false;
	let prebuiltPluginThreadConfig;
	if (binding?.threadId) {
		let pluginBindingStale = isCodexPluginThreadBindingStale({
			codexPluginsEnabled: params.pluginThreadConfig?.enabled ?? false,
			bindingFingerprint: binding.pluginAppsFingerprint,
			bindingInputFingerprint: binding.pluginAppsInputFingerprint,
			currentInputFingerprint: params.pluginThreadConfig?.inputFingerprint,
			hasBindingPolicyContext: Boolean(binding.pluginAppPolicyContext)
		});
		if (!pluginBindingStale && shouldRecheckRecoverablePluginBinding({
			binding,
			pluginThreadConfig: params.pluginThreadConfig
		})) try {
			prebuiltPluginThreadConfig = await params.pluginThreadConfig?.build();
			pluginBindingStale = prebuiltPluginThreadConfig?.fingerprint !== binding.pluginAppsFingerprint;
		} catch (error) {
			log.warn("codex app-server plugin app config recovery check failed", {
				error,
				threadId: binding.threadId
			});
		}
		if (pluginBindingStale) {
			log.debug("codex app-server plugin app config changed; starting a new thread", { threadId: binding.threadId });
			await clearCodexAppServerBinding(params.params.sessionFile);
			binding = void 0;
		}
	}
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
			pluginAppsFingerprint: binding.pluginAppsFingerprint,
			pluginAppsInputFingerprint: binding.pluginAppsInputFingerprint,
			pluginAppPolicyContext: binding.pluginAppPolicyContext,
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
			dynamicToolsFingerprint,
			pluginAppsFingerprint: binding.pluginAppsFingerprint,
			pluginAppsInputFingerprint: binding.pluginAppsInputFingerprint,
			pluginAppPolicyContext: binding.pluginAppPolicyContext
		};
	} catch (error) {
		if (isCodexAppServerConnectionClosedError(error)) throw error;
		log.warn("codex app-server thread resume failed; starting a new thread", { error });
		await clearCodexAppServerBinding(params.params.sessionFile);
	}
	const pluginThreadConfig = params.pluginThreadConfig?.enabled ? prebuiltPluginThreadConfig ?? await params.pluginThreadConfig.build() : void 0;
	const config = mergeCodexThreadConfigs(params.config, pluginThreadConfig?.configPatch);
	const response = assertCodexThreadStartResponse(await params.client.request("thread/start", buildThreadStartParams(params.params, {
		cwd: params.cwd,
		dynamicTools: params.dynamicTools,
		appServer: params.appServer,
		developerInstructions: params.developerInstructions,
		config
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
		pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
		pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
		pluginAppPolicyContext: pluginThreadConfig?.policyContext,
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
		pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
		pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
		pluginAppPolicyContext: pluginThreadConfig?.policyContext,
		createdAt,
		updatedAt: createdAt
	};
}
function shouldRecheckRecoverablePluginBinding(params) {
	if (!params.pluginThreadConfig?.enabled) return false;
	if (!params.binding.pluginAppsFingerprint || !params.binding.pluginAppsInputFingerprint || params.binding.pluginAppsInputFingerprint !== params.pluginThreadConfig.inputFingerprint) return false;
	const policyContext = params.binding.pluginAppPolicyContext;
	if (!policyContext) return false;
	const expectedPluginConfigKeys = params.pluginThreadConfig.enabledPluginConfigKeys ?? [];
	return Object.keys(policyContext.apps).length === 0 || expectedPluginConfigKeys.length > 0;
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
	return [
		"This is an OpenClaw heartbeat turn. Apply these instructions only to this heartbeat wake; ordinary chat turns should stay in Codex Default mode.",
		"When you are ready to end the heartbeat, prefer the structured `heartbeat_respond` tool so OpenClaw can record the wake outcome and notification decision. If `heartbeat_respond` is not already available and `tool_search` is available, search for `heartbeat_respond`, load it, then call it. Use `notify=false` when nothing should visibly interrupt the user.",
		CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY
	].join("\n\n");
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
export { buildTurnStartParams as a, buildCodexPluginThreadConfig as c, createCodexDynamicToolBridge as d, applyCodexDynamicToolProfile as f, buildThreadStartParams as i, buildCodexPluginThreadConfigInputFingerprint as l, buildDeveloperInstructions as n, codexDynamicToolsFingerprint as o, normalizeCodexDynamicToolName as p, buildThreadResumeParams as r, startOrResumeThread as s, areCodexDynamicToolFingerprintsCompatible as t, shouldBuildCodexPluginThreadConfig as u };
