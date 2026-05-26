import { s as projectConfigOntoRuntimeSourceSnapshot } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-LkT7g78Y.js";
import { $ as resolveProviderRuntimePluginHandle, K as transformProviderSystemPrompt, N as resolveProviderSystemPromptContribution, P as resolveProviderTextTransforms, Z as resolveProviderFollowupFallbackRoute } from "./provider-runtime-D8jQEgmu.js";
import { r as isSilentReplyPayloadText } from "./tokens-CFv3Qu_v.js";
import { a as hasReplyPayloadContent } from "./payload-BDV15CYA.js";
import { O as logProviderToolSchemaDiagnostics, _ as resolveTranscriptPolicy, k as normalizeProviderToolSchemas } from "./attempt.tool-run-context-QAUT7ucg.js";
import { a as resolvePreparedExtraParams } from "./extra-params-S591BMjA.js";
import { t as buildAgentRuntimeAuthPlan } from "./auth-BE2XVbyx.js";
import { t as classifyEmbeddedPiRunResultForModelFallback } from "./result-fallback-classifier-BJuIbeJo.js";
//#region src/agents/runtime-plan/build.ts
function formatResolvedRef(params) {
	return `${params.provider}/${params.modelId}`;
}
function asOpenClawConfig(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function asProviderRuntimeModel(value) {
	return value !== void 0 ? value : void 0;
}
function asThinkLevel(value) {
	return value !== void 0 ? value : void 0;
}
function isProviderRuntimePluginHandle(value) {
	return value !== void 0 && "plugin" in value;
}
function resolveProviderRuntimeHandleForPlugins(params) {
	if (isProviderRuntimePluginHandle(params.runtimeHandle)) return params.runtimeHandle;
	if (!params.runtimeHandle && !params.resolveWhenMissing) return;
	return resolveProviderRuntimePluginHandle({
		provider: params.runtimeHandle?.provider ?? params.provider,
		config: asOpenClawConfig(params.runtimeHandle?.config) ?? params.config,
		workspaceDir: params.runtimeHandle?.workspaceDir ?? params.workspaceDir,
		env: params.runtimeHandle?.env ?? process.env,
		applyAutoEnable: params.runtimeHandle?.applyAutoEnable,
		bundledProviderAllowlistCompat: params.runtimeHandle?.bundledProviderAllowlistCompat,
		bundledProviderVitestCompat: params.runtimeHandle?.bundledProviderVitestCompat
	});
}
function buildAgentRuntimeDeliveryPlan(params) {
	const config = asOpenClawConfig(params.config);
	const providerRuntimeHandle = resolveProviderRuntimeHandleForPlugins({
		provider: params.provider,
		config,
		workspaceDir: params.workspaceDir,
		runtimeHandle: params.providerRuntimeHandle
	});
	return {
		isSilentPayload(payload) {
			return isSilentReplyPayloadText(payload.text, "NO_REPLY") && !hasReplyPayloadContent({
				...payload,
				text: void 0
			}, { trimText: true });
		},
		resolveFollowupRoute(routeParams) {
			return resolveProviderFollowupFallbackRoute({
				provider: params.provider,
				config,
				workspaceDir: params.workspaceDir,
				runtimeHandle: providerRuntimeHandle,
				context: {
					config,
					agentDir: params.agentDir,
					workspaceDir: params.workspaceDir,
					provider: params.provider,
					modelId: params.modelId,
					payload: routeParams.payload,
					originatingChannel: routeParams.originatingChannel,
					originatingTo: routeParams.originatingTo,
					originRoutable: routeParams.originRoutable,
					dispatcherAvailable: routeParams.dispatcherAvailable
				}
			});
		}
	};
}
function buildAgentRuntimeOutcomePlan() {
	return { classifyRunResult: classifyEmbeddedPiRunResultForModelFallback };
}
function buildAgentRuntimePlan(params) {
	const config = asOpenClawConfig(params.config);
	const model = asProviderRuntimeModel(params.model);
	const modelApi = params.modelApi ?? params.model?.api ?? void 0;
	const transport = params.resolvedTransport;
	const toolPlanningConfig = config ? projectConfigOntoRuntimeSourceSnapshot(config) : void 0;
	let toolPlanningMetadataSnapshot;
	const loadToolPlanningMetadataSnapshot = () => {
		toolPlanningMetadataSnapshot ??= loadManifestMetadataSnapshot({
			config: toolPlanningConfig,
			...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {},
			env: process.env
		});
		return toolPlanningMetadataSnapshot;
	};
	const providerRuntimeHandleForPlugins = resolveProviderRuntimeHandleForPlugins({
		provider: params.provider,
		config,
		workspaceDir: params.workspaceDir,
		runtimeHandle: params.providerRuntimeHandle,
		resolveWhenMissing: true
	});
	const auth = buildAgentRuntimeAuthPlan({
		provider: params.provider,
		authProfileProvider: params.authProfileProvider,
		authProfileMode: params.authProfileMode,
		sessionAuthProfileId: params.sessionAuthProfileId,
		sessionAuthProfileCandidateIds: params.sessionAuthProfileCandidateIds,
		config,
		workspaceDir: params.workspaceDir,
		harnessId: params.harnessId,
		harnessRuntime: params.harnessRuntime,
		allowHarnessAuthProfileForwarding: params.allowHarnessAuthProfileForwarding
	});
	const resolvedRef = {
		provider: params.provider,
		modelId: params.modelId,
		...modelApi ? { modelApi } : {},
		...params.harnessId ? { harnessId: params.harnessId } : {},
		...transport ? { transport } : {}
	};
	const toolContext = {
		provider: params.provider,
		config,
		workspaceDir: params.workspaceDir,
		env: process.env,
		runtimeHandle: providerRuntimeHandleForPlugins,
		modelId: params.modelId,
		modelApi,
		model
	};
	const resolveToolContext = (overrides) => ({
		...toolContext,
		...overrides?.workspaceDir !== void 0 ? { workspaceDir: overrides.workspaceDir } : {},
		...overrides?.modelApi !== void 0 ? { modelApi: overrides.modelApi } : {},
		...overrides?.model !== void 0 ? { model: asProviderRuntimeModel(overrides.model) } : {}
	});
	const resolveTranscriptRuntimePolicy = (overrides) => resolveTranscriptPolicy({
		provider: params.provider,
		modelId: params.modelId,
		config,
		workspaceDir: overrides?.workspaceDir ?? params.workspaceDir,
		env: process.env,
		runtimeHandle: providerRuntimeHandleForPlugins,
		modelApi: overrides?.modelApi ?? modelApi,
		model: asProviderRuntimeModel(overrides?.model) ?? model
	});
	const resolveTransportExtraParams = (overrides = {}) => resolvePreparedExtraParams({
		cfg: config,
		provider: params.provider,
		modelId: params.modelId,
		agentDir: params.agentDir,
		workspaceDir: overrides.workspaceDir ?? params.workspaceDir,
		extraParamsOverride: overrides.extraParamsOverride ?? params.extraParamsOverride,
		thinkingLevel: asThinkLevel(overrides.thinkingLevel ?? params.thinkingLevel),
		agentId: overrides.agentId ?? params.agentId,
		model: asProviderRuntimeModel(overrides.model) ?? model,
		resolvedTransport: overrides.resolvedTransport ?? transport,
		providerRuntimeHandle: providerRuntimeHandleForPlugins
	});
	let memoizedTranscriptPolicy;
	let memoizedTransportExtraParams;
	const resolveDefaultTranscriptPolicy = () => {
		memoizedTranscriptPolicy ??= resolveTranscriptRuntimePolicy();
		return memoizedTranscriptPolicy;
	};
	const resolveDefaultTransportExtraParams = () => {
		memoizedTransportExtraParams ??= resolveTransportExtraParams();
		return memoizedTransportExtraParams;
	};
	const providerTextTransforms = resolveProviderTextTransforms({
		provider: params.provider,
		config,
		workspaceDir: params.workspaceDir,
		env: process.env,
		runtimeHandle: providerRuntimeHandleForPlugins
	});
	return {
		resolvedRef,
		providerRuntimeHandle: providerRuntimeHandleForPlugins,
		auth,
		prompt: {
			provider: params.provider,
			modelId: params.modelId,
			textTransforms: providerTextTransforms,
			resolveSystemPromptContribution(context) {
				return resolveProviderSystemPromptContribution({
					provider: params.provider,
					config,
					workspaceDir: context.workspaceDir ?? params.workspaceDir,
					runtimeHandle: providerRuntimeHandleForPlugins,
					context: {
						...context,
						config: asOpenClawConfig(context.config)
					}
				});
			},
			transformSystemPrompt(context) {
				return transformProviderSystemPrompt({
					provider: params.provider,
					config,
					workspaceDir: context.workspaceDir ?? params.workspaceDir,
					runtimeHandle: providerRuntimeHandleForPlugins,
					context: {
						...context,
						config: asOpenClawConfig(context.config)
					}
				});
			}
		},
		tools: {
			preparedPlanning: { loadMetadataSnapshot: loadToolPlanningMetadataSnapshot },
			normalize(tools, overrides) {
				return normalizeProviderToolSchemas({
					...resolveToolContext(overrides),
					tools
				});
			},
			logDiagnostics(tools, overrides) {
				logProviderToolSchemaDiagnostics({
					...resolveToolContext(overrides),
					tools
				});
			}
		},
		transcript: {
			get policy() {
				return resolveDefaultTranscriptPolicy();
			},
			resolvePolicy: resolveTranscriptRuntimePolicy
		},
		delivery: buildAgentRuntimeDeliveryPlan({
			...params,
			providerRuntimeHandle: providerRuntimeHandleForPlugins
		}),
		outcome: buildAgentRuntimeOutcomePlan(),
		transport: {
			get extraParams() {
				return resolveDefaultTransportExtraParams();
			},
			resolveExtraParams: resolveTransportExtraParams
		},
		observability: {
			resolvedRef: formatResolvedRef({
				provider: params.provider,
				modelId: params.modelId
			}),
			provider: params.provider,
			modelId: params.modelId,
			...modelApi ? { modelApi } : {},
			...params.harnessId ? { harnessId: params.harnessId } : {},
			...auth.forwardedAuthProfileId ? { authProfileId: auth.forwardedAuthProfileId } : {},
			...transport ? { transport } : {}
		}
	};
}
//#endregion
export { buildAgentRuntimeOutcomePlan as n, buildAgentRuntimePlan as r, buildAgentRuntimeDeliveryPlan as t };
