import { v as resolveStateDir } from "../../paths-Cnwfh6dH.js";
import { n as VERSION } from "../../version-DmRkhYua.js";
import "../../agent-scope-wct0i6B_.js";
import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "../../agent-scope-config-BuKrT2wm.js";
import { r as getChildLogger, v as normalizeLogLevel } from "../../logger-tDhXRPrK.js";
import { a as shouldLogVerbose } from "../../globals-DaPK6X5S.js";
import { a as logWarn } from "../../logger-B-H6-XfD.js";
import { r as runCommandWithTimeout } from "../../exec-ByXDKomR.js";
import { i as getRuntimeConfig } from "../../io-Dn3XTR_G.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "../../defaults-DQNxPE51.js";
import { c as resolveThinkingProfile, p as normalizeThinkLevel } from "../../thinking-Bzr_rdQG.js";
import { i as replaceConfigFile, n as mutateConfigFile } from "../../mutate-DBgPft1J.js";
import "../../config-CKAUap-Q.js";
import { l as onAgentEvent } from "../../agent-events-DkpIHRmj.js";
import { o as normalizeDeliveryContext } from "../../delivery-context.shared-DgOflY-N.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "../../paths-_BPRx1WO.js";
import { t as loadSessionStore } from "../../store-load-Pm7UPztK.js";
import { a as saveSessionStore, c as updateSessionStoreEntry, s as updateSessionStore } from "../../store-BsgW6uVr.js";
import { _ as mediaKindFromMime, n as detectMime } from "../../mime-BjHvxzTf.js";
import { n as onSessionTranscriptUpdate } from "../../transcript-events-Bk5onV1S.js";
import { t as getPluginRuntimeGatewayRequestScope } from "../../gateway-request-scope-BwLd9jbN.js";
import "../../logging-CKt9_2Pp.js";
import { r as buildConfiguredModelCatalog } from "../../model-selection-shared-C0W6f8jq.js";
import { m as resolveThinkingDefault } from "../../model-selection-DCMPulC-.js";
import { o as requestHeartbeat } from "../../heartbeat-wake-B5ivU3tG.js";
import { a as enqueueSystemEvent } from "../../system-events-Dv0QB_eC.js";
import { c as getImageMetadata, p as resizeToJpeg } from "../../media-services-BgpAcVAA.js";
import { o as generateMusic, s as listRuntimeMusicGenerationProviders } from "../../openclaw-tools-CqeS3c0D.js";
import { l as ensureAgentWorkspace } from "../../workspace-DdOGUfrp.js";
import { a as createLazyRuntimeSurface, n as createLazyRuntimeMethodBinder, r as createLazyRuntimeModule, t as createLazyRuntimeMethod } from "../../lazy-runtime-CUDhYq-w.js";
import { n as listRuntimeImageGenerationProviders, t as generateImage } from "../../runtime-BEGMc40Y.js";
import { t as loadWebMedia } from "../../web-media-CWsZqtbP.js";
import { p as listTasksForFlowId } from "../../task-registry-CnDuGaDR.js";
import { n as summarizeTaskRecords } from "../../task-registry.summary-CTwvHaGc.js";
import "../../runtime-internal-BMRJEHf3.js";
import { _ as resolveTaskFlowForLookupTokenForOwner, g as listTaskFlowsForOwner, h as getTaskFlowByIdForOwner, l as getFlowTaskSummary, m as findLatestTaskFlowForOwner, t as cancelDetachedTaskRunById } from "../../task-executor-DKzwpLpU.js";
import { n as resolveAgentIdentity } from "../../identity-ByithkmL.js";
import { a as getTaskByIdForOwner, o as listTasksForRelatedSessionKeyForOwner, r as findLatestTaskForRelatedSessionKeyForOwner, s as resolveTaskForLookupTokenForOwner } from "../../task-owner-access-B-IEQ38R.js";
import { t as resolveAgentTimeoutMs } from "../../timeout-GQT-oqse.js";
import { n as listRuntimeVideoGenerationProviders, t as generateVideo } from "../../runtime-CCdySZfU.js";
import { i as runWebSearch, r as listWebSearchProviders } from "../../runtime-DQLjDTZR.js";
import { t as RequestScopedSubagentRuntimeError } from "../../error-runtime-BwV5V_90.js";
import { i as setGatewaySubagentRuntime, n as gatewaySubagentState, r as setGatewayNodesRuntime, t as clearGatewaySubagentRuntime } from "../../gateway-bindings-BSLxLQlX.js";
import { t as createRuntimeChannel } from "../../runtime-channel-D9yaTTQX.js";
import { r as isVoiceCompatibleAudio } from "../../audio-DfjwtLxO.js";
import { t as createRuntimeTaskFlow } from "../../runtime-taskflow-BnM4gJVd.js";
//#region src/plugins/runtime/runtime-cache.ts
function defineCachedValue(target, key, create) {
	let cached;
	let ready = false;
	Object.defineProperty(target, key, {
		configurable: true,
		enumerable: true,
		get() {
			if (!ready) {
				cached = create();
				ready = true;
			}
			return cached;
		}
	});
}
//#endregion
//#region src/plugins/runtime/runtime-agent.ts
const loadEmbeddedPiRuntime = createLazyRuntimeModule(() => import("../../runtime-embedded-pi.runtime-TA5TAKNX.js"));
function resolveRuntimeThinkingCatalog(params) {
	if (params.catalog) return params.catalog;
	const configuredCatalog = buildConfiguredModelCatalog({ cfg: getRuntimeConfig() });
	return configuredCatalog.length > 0 ? configuredCatalog : void 0;
}
function createRuntimeAgent() {
	const agentRuntime = {
		defaults: {
			model: DEFAULT_MODEL,
			provider: DEFAULT_PROVIDER
		},
		resolveAgentDir,
		resolveAgentWorkspaceDir,
		resolveAgentIdentity,
		resolveThinkingDefault,
		normalizeThinkingLevel: normalizeThinkLevel,
		resolveThinkingPolicy: (params) => {
			const profile = resolveThinkingProfile({
				...params,
				catalog: resolveRuntimeThinkingCatalog(params)
			});
			const policy = { levels: profile.levels.map(({ id, label }) => ({
				id,
				label
			})) };
			return profile.defaultLevel ? {
				...policy,
				defaultLevel: profile.defaultLevel
			} : policy;
		},
		resolveAgentTimeoutMs,
		ensureAgentWorkspace
	};
	defineCachedValue(agentRuntime, "runEmbeddedAgent", () => createLazyRuntimeMethod(loadEmbeddedPiRuntime, (runtime) => runtime.runEmbeddedAgent));
	defineCachedValue(agentRuntime, "runEmbeddedPiAgent", () => createLazyRuntimeMethod(loadEmbeddedPiRuntime, (runtime) => runtime.runEmbeddedPiAgent));
	defineCachedValue(agentRuntime, "session", () => ({
		resolveStorePath,
		loadSessionStore,
		saveSessionStore,
		updateSessionStore,
		updateSessionStoreEntry,
		resolveSessionFilePath
	}));
	return agentRuntime;
}
//#endregion
//#region src/plugins/runtime/runtime-config.ts
const RUNTIME_CONFIG_LOAD_WRITE_COMPAT_CODE = "runtime-config-load-write";
const warnedDeprecatedConfigApis = /* @__PURE__ */ new Set();
function formatDeprecatedConfigApiSubject(name) {
	const scope = getPluginRuntimeGatewayRequestScope();
	if (!scope?.pluginId) return `plugin runtime config.${name}()`;
	return `plugin "${scope.pluginId}" runtime config.${name}()`;
}
function formatDeprecatedConfigApiSource() {
	const scope = getPluginRuntimeGatewayRequestScope();
	return scope?.pluginSource ? ` Source: ${scope.pluginSource}` : "";
}
function formatDeprecatedConfigApiWarningKey(name) {
	return `${name}:${getPluginRuntimeGatewayRequestScope()?.pluginId ?? "anonymous"}`;
}
function warnDeprecatedConfigApiOnce(name, replacement) {
	const warningKey = formatDeprecatedConfigApiWarningKey(name);
	if (warnedDeprecatedConfigApis.has(warningKey)) return;
	warnedDeprecatedConfigApis.add(warningKey);
	logWarn(`${formatDeprecatedConfigApiSubject(name)} is deprecated (${RUNTIME_CONFIG_LOAD_WRITE_COMPAT_CODE}); use ${replacement}.${formatDeprecatedConfigApiSource()}`);
}
function createRuntimeConfig() {
	return {
		current: getRuntimeConfig,
		mutateConfigFile: async (params) => await mutateConfigFile({
			...params,
			writeOptions: params.writeOptions
		}),
		replaceConfigFile: async (params) => await replaceConfigFile({
			...params,
			writeOptions: params.writeOptions
		}),
		loadConfig: () => {
			warnDeprecatedConfigApiOnce("loadConfig", "config.current()");
			return getRuntimeConfig();
		},
		writeConfigFile: async (cfg, options) => {
			warnDeprecatedConfigApiOnce("writeConfigFile", "config.mutateConfigFile(...) or config.replaceConfigFile(...)");
			await replaceConfigFile({
				nextConfig: cfg,
				afterWrite: options?.afterWrite ?? { mode: "auto" },
				writeOptions: options
			});
		}
	};
}
//#endregion
//#region src/plugins/runtime/runtime-events.ts
function createRuntimeEvents() {
	return {
		onAgentEvent,
		onSessionTranscriptUpdate
	};
}
//#endregion
//#region src/plugins/runtime/runtime-logging.ts
function createRuntimeLogging() {
	return {
		shouldLogVerbose,
		getChildLogger: (bindings, opts) => {
			const logger = getChildLogger(bindings, { level: opts?.level ? normalizeLogLevel(opts.level) : void 0 });
			return {
				debug: (message) => logger.debug?.(message),
				info: (message) => logger.info(message),
				warn: (message) => logger.warn(message),
				error: (message) => logger.error(message)
			};
		}
	};
}
//#endregion
//#region src/plugins/runtime/runtime-media.ts
function createRuntimeMedia() {
	return {
		loadWebMedia,
		detectMime,
		mediaKindFromMime,
		isVoiceCompatibleAudio,
		getImageMetadata,
		resizeToJpeg
	};
}
//#endregion
//#region src/plugins/runtime/native-deps.ts
function formatNativeDependencyHint(params) {
	const manager = params.manager ?? "pnpm";
	const rebuildCommand = params.rebuildCommand ?? (manager === "npm" ? `npm rebuild ${params.packageName}` : manager === "yarn" ? `yarn rebuild ${params.packageName}` : `pnpm rebuild ${params.packageName}`);
	const steps = [
		params.approveBuildsCommand ?? (manager === "pnpm" ? `pnpm approve-builds (select ${params.packageName})` : void 0),
		rebuildCommand,
		params.downloadCommand
	].filter((step) => Boolean(step));
	if (steps.length === 0) return `Install ${params.packageName} and rebuild its native module.`;
	return `Install ${params.packageName} and rebuild its native module (${steps.join("; ")}).`;
}
//#endregion
//#region src/plugins/runtime/runtime-system.ts
const runHeartbeatOnceInternal = createLazyRuntimeMethod(createLazyRuntimeModule(() => import("../../heartbeat-runner-CnECwu8W.js")), (runtime) => runtime.runHeartbeatOnce);
function createRuntimeSystem() {
	const requestHeartbeatNow = (opts) => requestHeartbeat({
		source: opts?.source ?? "other",
		intent: opts?.intent ?? "immediate",
		reason: opts?.reason,
		coalesceMs: opts?.coalesceMs,
		agentId: opts?.agentId,
		sessionKey: opts?.sessionKey,
		heartbeat: opts?.heartbeat
	});
	return {
		enqueueSystemEvent,
		requestHeartbeat,
		requestHeartbeatNow,
		runHeartbeatOnce: (opts) => {
			const { reason, agentId, sessionKey, heartbeat } = opts ?? {};
			return runHeartbeatOnceInternal({
				reason,
				agentId,
				sessionKey,
				heartbeat: heartbeat ? { target: heartbeat.target } : void 0
			});
		},
		runCommandWithTimeout,
		formatNativeDependencyHint
	};
}
//#endregion
//#region src/tasks/task-domain-views.ts
function mapTaskRunAggregateSummary(summary) {
	return {
		total: summary.total,
		active: summary.active,
		terminal: summary.terminal,
		failures: summary.failures,
		byStatus: { ...summary.byStatus },
		byRuntime: { ...summary.byRuntime }
	};
}
function mapTaskRunView(task) {
	return {
		id: task.taskId,
		runtime: task.runtime,
		...task.sourceId ? { sourceId: task.sourceId } : {},
		sessionKey: task.requesterSessionKey,
		ownerKey: task.ownerKey,
		scope: task.scopeKind,
		...task.childSessionKey ? { childSessionKey: task.childSessionKey } : {},
		...task.parentFlowId ? { flowId: task.parentFlowId } : {},
		...task.parentTaskId ? { parentTaskId: task.parentTaskId } : {},
		...task.agentId ? { agentId: task.agentId } : {},
		...task.runId ? { runId: task.runId } : {},
		...task.label ? { label: task.label } : {},
		title: task.task,
		status: task.status,
		deliveryStatus: task.deliveryStatus,
		notifyPolicy: task.notifyPolicy,
		createdAt: task.createdAt,
		...task.startedAt !== void 0 ? { startedAt: task.startedAt } : {},
		...task.endedAt !== void 0 ? { endedAt: task.endedAt } : {},
		...task.lastEventAt !== void 0 ? { lastEventAt: task.lastEventAt } : {},
		...task.cleanupAfter !== void 0 ? { cleanupAfter: task.cleanupAfter } : {},
		...task.error ? { error: task.error } : {},
		...task.progressSummary ? { progressSummary: task.progressSummary } : {},
		...task.terminalSummary ? { terminalSummary: task.terminalSummary } : {},
		...task.terminalOutcome ? { terminalOutcome: task.terminalOutcome } : {}
	};
}
function mapTaskRunDetail(task) {
	return mapTaskRunView(task);
}
function mapTaskFlowView(flow) {
	return {
		id: flow.flowId,
		ownerKey: flow.ownerKey,
		...flow.requesterOrigin ? { requesterOrigin: { ...flow.requesterOrigin } } : {},
		status: flow.status,
		notifyPolicy: flow.notifyPolicy,
		goal: flow.goal,
		...flow.currentStep ? { currentStep: flow.currentStep } : {},
		...flow.cancelRequestedAt !== void 0 ? { cancelRequestedAt: flow.cancelRequestedAt } : {},
		createdAt: flow.createdAt,
		updatedAt: flow.updatedAt,
		...flow.endedAt !== void 0 ? { endedAt: flow.endedAt } : {}
	};
}
function mapTaskFlowDetail(params) {
	const summary = params.summary ?? summarizeTaskRecords(params.tasks);
	return {
		...mapTaskFlowView(params.flow),
		...params.flow.stateJson !== void 0 ? { state: params.flow.stateJson } : {},
		...params.flow.waitJson !== void 0 ? { wait: params.flow.waitJson } : {},
		...params.flow.blockedTaskId || params.flow.blockedSummary ? { blocked: {
			...params.flow.blockedTaskId ? { taskId: params.flow.blockedTaskId } : {},
			...params.flow.blockedSummary ? { summary: params.flow.blockedSummary } : {}
		} } : {},
		tasks: params.tasks.map((task) => mapTaskRunView(task)),
		taskSummary: mapTaskRunAggregateSummary(summary)
	};
}
//#endregion
//#region src/plugins/runtime/runtime-tasks.ts
function assertSessionKey(sessionKey, errorMessage) {
	const normalized = sessionKey?.trim();
	if (!normalized) throw new Error(errorMessage);
	return normalized;
}
function mapCancelledTaskResult(result) {
	return {
		found: result.found,
		cancelled: result.cancelled,
		...result.reason ? { reason: result.reason } : {},
		...result.task ? { task: mapTaskRunDetail(result.task) } : {}
	};
}
function createBoundTaskRunsRuntime(params) {
	const ownerKey = assertSessionKey(params.sessionKey, "Tasks runtime requires a bound sessionKey.");
	const requesterOrigin = params.requesterOrigin ? normalizeDeliveryContext(params.requesterOrigin) : void 0;
	return {
		sessionKey: ownerKey,
		...requesterOrigin ? { requesterOrigin } : {},
		get: (taskId) => {
			const task = getTaskByIdForOwner({
				taskId,
				callerOwnerKey: ownerKey
			});
			return task ? mapTaskRunDetail(task) : void 0;
		},
		list: () => listTasksForRelatedSessionKeyForOwner({
			relatedSessionKey: ownerKey,
			callerOwnerKey: ownerKey
		}).map((task) => mapTaskRunView(task)),
		findLatest: () => {
			const task = findLatestTaskForRelatedSessionKeyForOwner({
				relatedSessionKey: ownerKey,
				callerOwnerKey: ownerKey
			});
			return task ? mapTaskRunDetail(task) : void 0;
		},
		resolve: (token) => {
			const task = resolveTaskForLookupTokenForOwner({
				token,
				callerOwnerKey: ownerKey
			});
			return task ? mapTaskRunDetail(task) : void 0;
		},
		cancel: async ({ taskId, cfg }) => {
			const task = getTaskByIdForOwner({
				taskId,
				callerOwnerKey: ownerKey
			});
			if (!task) return {
				found: false,
				cancelled: false,
				reason: "Task not found."
			};
			return mapCancelledTaskResult(await cancelDetachedTaskRunById({
				cfg,
				taskId: task.taskId
			}));
		}
	};
}
function createBoundTaskFlowsRuntime(params) {
	const ownerKey = assertSessionKey(params.sessionKey, "TaskFlow runtime requires a bound sessionKey.");
	const requesterOrigin = params.requesterOrigin ? normalizeDeliveryContext(params.requesterOrigin) : void 0;
	const getDetail = (flowId) => {
		const flow = getTaskFlowByIdForOwner({
			flowId,
			callerOwnerKey: ownerKey
		});
		if (!flow) return;
		return mapTaskFlowDetail({
			flow,
			tasks: listTasksForFlowId(flow.flowId),
			summary: getFlowTaskSummary(flow.flowId)
		});
	};
	return {
		sessionKey: ownerKey,
		...requesterOrigin ? { requesterOrigin } : {},
		get: (flowId) => getDetail(flowId),
		list: () => listTaskFlowsForOwner({ callerOwnerKey: ownerKey }).map((flow) => mapTaskFlowView(flow)),
		findLatest: () => {
			const flow = findLatestTaskFlowForOwner({ callerOwnerKey: ownerKey });
			return flow ? getDetail(flow.flowId) : void 0;
		},
		resolve: (token) => {
			const flow = resolveTaskFlowForLookupTokenForOwner({
				token,
				callerOwnerKey: ownerKey
			});
			return flow ? getDetail(flow.flowId) : void 0;
		},
		getTaskSummary: (flowId) => {
			const flow = getTaskFlowByIdForOwner({
				flowId,
				callerOwnerKey: ownerKey
			});
			return flow ? mapTaskRunAggregateSummary(getFlowTaskSummary(flow.flowId)) : void 0;
		}
	};
}
function createRuntimeTaskRuns() {
	return {
		bindSession: (params) => createBoundTaskRunsRuntime({
			sessionKey: params.sessionKey,
			requesterOrigin: params.requesterOrigin
		}),
		fromToolContext: (ctx) => createBoundTaskRunsRuntime({
			sessionKey: assertSessionKey(ctx.sessionKey, "Tasks runtime requires tool context with a sessionKey."),
			requesterOrigin: ctx.deliveryContext
		})
	};
}
function createRuntimeTaskFlows() {
	return {
		bindSession: (params) => createBoundTaskFlowsRuntime({
			sessionKey: params.sessionKey,
			requesterOrigin: params.requesterOrigin
		}),
		fromToolContext: (ctx) => createBoundTaskFlowsRuntime({
			sessionKey: assertSessionKey(ctx.sessionKey, "TaskFlow runtime requires tool context with a sessionKey."),
			requesterOrigin: ctx.deliveryContext
		})
	};
}
function createRuntimeTasks(params) {
	return {
		runs: createRuntimeTaskRuns(),
		flows: createRuntimeTaskFlows(),
		managedFlows: params.legacyTaskFlow,
		flow: params.legacyTaskFlow
	};
}
//#endregion
//#region src/plugins/runtime/index.ts
const loadTtsRuntime = createLazyRuntimeModule(() => import("../../tts-CDAjhyAc.js"));
const loadMediaUnderstandingRuntime = createLazyRuntimeModule(() => import("../../runtime-Com1aD6d.js"));
const loadModelAuthRuntime = createLazyRuntimeModule(() => import("../../runtime-model-auth.runtime-Czm0kz_-.js"));
function createRuntimeTts() {
	const bindTtsRuntime = createLazyRuntimeMethodBinder(loadTtsRuntime);
	return {
		textToSpeech: bindTtsRuntime((runtime) => runtime.textToSpeech),
		textToSpeechStream: bindTtsRuntime((runtime) => runtime.textToSpeechStream),
		textToSpeechTelephony: bindTtsRuntime((runtime) => runtime.textToSpeechTelephony),
		listVoices: bindTtsRuntime((runtime) => runtime.listSpeechVoices)
	};
}
function createRuntimeMediaUnderstandingFacade() {
	const bindMediaUnderstandingRuntime = createLazyRuntimeMethodBinder(loadMediaUnderstandingRuntime);
	return {
		runFile: bindMediaUnderstandingRuntime((runtime) => runtime.runMediaUnderstandingFile),
		describeImageFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeImageFile),
		describeImageFileWithModel: bindMediaUnderstandingRuntime((runtime) => runtime.describeImageFileWithModel),
		extractStructuredWithModel: bindMediaUnderstandingRuntime((runtime) => runtime.extractStructuredWithModel),
		describeVideoFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeVideoFile),
		transcribeAudioFile: bindMediaUnderstandingRuntime((runtime) => runtime.transcribeAudioFile)
	};
}
function createRuntimeImageGeneration() {
	return {
		generate: (params) => generateImage(params),
		listProviders: (params) => listRuntimeImageGenerationProviders(params)
	};
}
function createRuntimeVideoGeneration() {
	return {
		generate: (params) => generateVideo(params),
		listProviders: (params) => listRuntimeVideoGenerationProviders(params)
	};
}
function createRuntimeMusicGeneration() {
	return {
		generate: (params) => generateMusic(params),
		listProviders: (params) => listRuntimeMusicGenerationProviders(params)
	};
}
function createRuntimeLlmFacade() {
	const loadLlm = createLazyRuntimeSurface(() => import("../../runtime-llm.runtime-B5PpZ6qR.js"), (m) => m.createRuntimeLlm({
		getConfig: getRuntimeConfig,
		authority: { allowComplete: true }
	}));
	return { complete: async (params) => {
		return (await loadLlm()).complete(params);
	} };
}
function createRuntimeModelAuth() {
	const getApiKeyForModel = createLazyRuntimeMethod(loadModelAuthRuntime, (runtime) => runtime.getApiKeyForModel);
	const getRuntimeAuthForModel = createLazyRuntimeMethod(loadModelAuthRuntime, (runtime) => runtime.getRuntimeAuthForModel);
	const resolveApiKeyForProvider = createLazyRuntimeMethod(loadModelAuthRuntime, (runtime) => runtime.resolveApiKeyForProvider);
	return {
		getApiKeyForModel: (params) => getApiKeyForModel({
			model: params.model,
			cfg: params.cfg,
			workspaceDir: params.workspaceDir
		}),
		getRuntimeAuthForModel: (params) => getRuntimeAuthForModel({
			model: params.model,
			cfg: params.cfg,
			workspaceDir: params.workspaceDir
		}),
		resolveApiKeyForProvider: (params) => resolveApiKeyForProvider({
			provider: params.provider,
			cfg: params.cfg,
			workspaceDir: params.workspaceDir
		})
	};
}
function createUnavailableSubagentRuntime() {
	const unavailable = () => {
		throw new RequestScopedSubagentRuntimeError();
	};
	return {
		run: unavailable,
		waitForRun: unavailable,
		getSessionMessages: unavailable,
		getSession: unavailable,
		deleteSession: unavailable
	};
}
/**
* Create a late-binding subagent that resolves to:
* 1. An explicitly provided subagent (from runtimeOptions), OR
* 2. The process-global gateway subagent when the caller explicitly opts in, OR
* 3. The unavailable fallback (throws with a clear error message).
*/
function createLateBindingSubagent(explicit, allowGatewaySubagentBinding = false) {
	if (explicit) return explicit;
	const unavailable = createUnavailableSubagentRuntime();
	if (!allowGatewaySubagentBinding) return unavailable;
	return new Proxy(unavailable, { get(_target, prop, _receiver) {
		const resolved = gatewaySubagentState.subagent ?? unavailable;
		return Reflect.get(resolved, prop, resolved);
	} });
}
function createUnavailableNodesRuntime() {
	const unavailable = () => {
		throw new Error("Plugin node runtime is only available inside the Gateway.");
	};
	return {
		list: unavailable,
		invoke: unavailable
	};
}
function createLateBindingNodes(allowGatewayBinding = false) {
	const unavailable = createUnavailableNodesRuntime();
	if (!allowGatewayBinding) return unavailable;
	return new Proxy(unavailable, { get(_target, prop, _receiver) {
		const resolved = gatewaySubagentState.nodes ?? unavailable;
		return Reflect.get(resolved, prop, resolved);
	} });
}
function createPluginRuntime(_options = {}) {
	const mediaUnderstanding = createRuntimeMediaUnderstandingFacade();
	const taskFlow = createRuntimeTaskFlow();
	const tasks = createRuntimeTasks({ legacyTaskFlow: taskFlow });
	const runtime = {
		version: VERSION,
		config: createRuntimeConfig(),
		agent: createRuntimeAgent(),
		subagent: createLateBindingSubagent(_options.subagent, _options.allowGatewaySubagentBinding === true),
		nodes: _options.nodes ?? createLateBindingNodes(_options.allowGatewaySubagentBinding === true),
		system: createRuntimeSystem(),
		media: createRuntimeMedia(),
		webSearch: {
			listProviders: listWebSearchProviders,
			search: runWebSearch
		},
		channel: createRuntimeChannel(),
		events: createRuntimeEvents(),
		logging: createRuntimeLogging(),
		state: {
			resolveStateDir,
			openKeyedStore: () => {
				throw new Error("openKeyedStore is only available through the plugin runtime proxy.");
			}
		},
		tasks,
		taskFlow
	};
	defineCachedValue(runtime, "tts", createRuntimeTts);
	defineCachedValue(runtime, "mediaUnderstanding", () => mediaUnderstanding);
	defineCachedValue(runtime, "stt", () => ({ transcribeAudioFile: mediaUnderstanding.transcribeAudioFile }));
	defineCachedValue(runtime, "modelAuth", createRuntimeModelAuth);
	defineCachedValue(runtime, "imageGeneration", createRuntimeImageGeneration);
	defineCachedValue(runtime, "videoGeneration", createRuntimeVideoGeneration);
	defineCachedValue(runtime, "musicGeneration", createRuntimeMusicGeneration);
	defineCachedValue(runtime, "llm", createRuntimeLlmFacade);
	return runtime;
}
//#endregion
export { clearGatewaySubagentRuntime, createPluginRuntime, setGatewayNodesRuntime, setGatewaySubagentRuntime };
