import { r as normalizeProviderId } from "./provider-id-C3dkeX_L.js";
import { g as streamWithPayloadPatch, t as ANTHROPIC_BY_MODEL_REPLAY_HOOKS } from "./provider-model-shared-BJrHvRZi.js";
import { E as isAnthropicBedrockModel, w as createBedrockNoCacheWrapper } from "./provider-stream-shared-CN5xC3-5.js";
import { r as resolvePluginConfigObject } from "./plugin-config-runtime-Beaulzon.js";
import { t as refreshAwsSharedConfigCacheForBedrock } from "./aws-credential-refresh-DIKQa5lJ.js";
import { n as resolveBedrockConfigApiKey, t as mergeImplicitBedrockProvider } from "./discovery-shared-wMU-gjBJ.js";
import { t as bedrockMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter-CzbE2jD5.js";
import { n as resolveBedrockClaudeThinkingProfile, t as isOpus47BedrockModelRef } from "./thinking-policy-CBtFS26z.js";
//#region extensions/amazon-bedrock/register.sync.runtime.ts
const BEDROCK_SERVICE_TIER_VALUES = [
	"flex",
	"priority",
	"default",
	"reserved"
];
function isBedrockServiceTier(value) {
	return BEDROCK_SERVICE_TIER_VALUES.some((tier) => tier === value);
}
function resolveBedrockServiceTier(extraParams, warn) {
	const raw = extraParams?.serviceTier ?? extraParams?.service_tier;
	if (typeof raw !== "string") return;
	const normalized = raw.trim().toLowerCase();
	if (isBedrockServiceTier(normalized)) return normalized;
	warn(`ignoring invalid Bedrock service_tier param: ${raw}`);
}
function createBedrockServiceTierWrapper(underlying, serviceTier) {
	return (model, context, options) => {
		if (model.api !== "bedrock-converse-stream") return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
			payloadObj.serviceTier ??= { type: serviceTier };
		});
	};
}
function createGuardrailWrapStreamFn(innerWrapStreamFn, guardrailConfig) {
	return (ctx) => {
		const inner = innerWrapStreamFn(ctx);
		if (!inner) return inner;
		return (model, context, options) => {
			return streamWithPayloadPatch(inner, model, context, options, (payload) => {
				const gc = {
					guardrailIdentifier: guardrailConfig.guardrailIdentifier,
					guardrailVersion: guardrailConfig.guardrailVersion
				};
				if (guardrailConfig.streamProcessingMode) gc.streamProcessingMode = guardrailConfig.streamProcessingMode;
				if (guardrailConfig.trace) gc.trace = guardrailConfig.trace;
				payload.guardrailConfig = gc;
			});
		};
	};
}
/**
* Mirrors the shipped pi-ai Bedrock `supportsPromptCaching` matcher.
* Keep this in sync with node_modules/@mariozechner/pi-ai/dist/providers/amazon-bedrock.js.
*/
function matchesPiAiPromptCachingModelId(modelId) {
	const id = modelId.toLowerCase();
	if (!id.includes("claude")) return false;
	if (id.includes("-4-") || id.includes("-4.")) return true;
	if (id.includes("claude-3-7-sonnet")) return true;
	if (id.includes("claude-3-5-haiku")) return true;
	return false;
}
function piAiWouldInjectCachePoints(modelId) {
	return matchesPiAiPromptCachingModelId(modelId);
}
/**
* Detect Bedrock application inference profile ARNs — these are the only IDs
* where pi-ai's model-name-based checks fail because the ARN is opaque.
* System-defined profiles (us., eu., global.) and base model IDs always
* contain the model name and are handled by pi-ai natively.
*/
const BEDROCK_APP_INFERENCE_PROFILE_RE = /^arn:aws(-cn|-us-gov)?:bedrock:.*:application-inference-profile\//i;
function isBedrockAppInferenceProfile(modelId) {
	return BEDROCK_APP_INFERENCE_PROFILE_RE.test(modelId);
}
/**
* pi-ai's internal `supportsPromptCaching` checks `model.id` for specific Claude
* model name patterns, which fails for application inference profile ARNs (opaque
* IDs that may not contain the model name). When OpenClaw's `isAnthropicBedrockModel`
* identifies the model but pi-ai won't inject cache points, we do it via onPayload.
*
* Gated to application inference profile ARNs only — regular Claude model IDs and
* system-defined inference profiles (us.anthropic.claude-*) are left to pi-ai.
*/
function needsCachePointInjection(modelId) {
	if (!isBedrockAppInferenceProfile(modelId)) return false;
	if (piAiWouldInjectCachePoints(modelId)) return false;
	if (isAnthropicBedrockModel(modelId)) return true;
	return false;
}
/**
* Extract the region from a Bedrock ARN.
* e.g. "arn:aws:bedrock:us-east-1:123:application-inference-profile/abc" → "us-east-1"
*/
function extractRegionFromArn(arn) {
	const parts = arn.split(":");
	return parts.length >= 4 && parts[3] ? parts[3] : void 0;
}
/**
* Check if a resolved foundation model ARN supports prompt caching using the
* same matcher pi-ai uses for direct model IDs.
*/
function resolvedModelSupportsCaching(modelArn) {
	return matchesPiAiPromptCachingModelId(modelArn);
}
const appProfileTraitsCache = /* @__PURE__ */ new Map();
let bedrockControlPlaneOverride;
function resetBedrockAppProfileCacheEligibilityForTest() {
	appProfileTraitsCache.clear();
}
function setBedrockAppProfileControlPlaneForTest(controlPlane) {
	bedrockControlPlaneOverride = controlPlane;
	resetBedrockAppProfileCacheEligibilityForTest();
}
async function createBedrockControlPlane(region) {
	if (bedrockControlPlaneOverride) return bedrockControlPlaneOverride(region);
	await refreshAwsSharedConfigCacheForBedrock();
	const { BedrockClient, GetInferenceProfileCommand } = await import("@aws-sdk/client-bedrock");
	const client = new BedrockClient(region ? { region } : {});
	return { getInferenceProfile: async (input) => await client.send(new GetInferenceProfileCommand(input)) };
}
async function resolveAppProfileTraits(modelId, fallbackRegion) {
	const cached = appProfileTraitsCache.get(modelId);
	if (cached) return cached;
	try {
		const models = (await (await createBedrockControlPlane(extractRegionFromArn(modelId) ?? fallbackRegion)).getInferenceProfile({ inferenceProfileIdentifier: modelId })).models ?? [];
		const modelArns = models.map((m) => m.modelArn ?? "");
		const traits = {
			cacheEligible: models.length > 0 && modelArns.every((modelArn) => resolvedModelSupportsCaching(modelArn)),
			omitTemperature: modelArns.some(isOpus47BedrockModelRef)
		};
		appProfileTraitsCache.set(modelId, traits);
		return traits;
	} catch {
		return {
			cacheEligible: isAnthropicBedrockModel(modelId),
			omitTemperature: isOpus47BedrockModelRef(modelId)
		};
	}
}
function hasCachePoint(blocks) {
	return blocks?.some((b) => b.cachePoint != null) === true;
}
function makeCachePoint(cacheRetention) {
	return { cachePoint: {
		type: "default",
		...cacheRetention === "long" ? { ttl: "1h" } : {}
	} };
}
/**
* Inject Bedrock Converse cache points into the payload when pi-ai skipped them
* because it didn't recognize the model ID (application inference profiles).
*/
function injectBedrockCachePoints(payload, cacheRetention) {
	if (!cacheRetention || cacheRetention === "none") return;
	const point = makeCachePoint(cacheRetention);
	const system = payload.system;
	if (Array.isArray(system) && system.length > 0 && !hasCachePoint(system)) system.push(point);
	const messages = payload.messages;
	if (Array.isArray(messages) && messages.length > 0) for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "user" && Array.isArray(msg.content)) {
			if (!hasCachePoint(msg.content)) msg.content.push(point);
			break;
		}
	}
}
function patchOpus47MaxThinkingEffort(payload) {
	const fieldsValue = payload.additionalModelRequestFields;
	const fields = fieldsValue && typeof fieldsValue === "object" && !Array.isArray(fieldsValue) ? fieldsValue : {};
	const outputConfigValue = fields.output_config;
	const outputConfig = outputConfigValue && typeof outputConfigValue === "object" && !Array.isArray(outputConfigValue) ? outputConfigValue : {};
	outputConfig.effort = "max";
	fields.output_config = outputConfig;
	payload.additionalModelRequestFields = fields;
}
function registerAmazonBedrockPlugin(api) {
	const providerId = "amazon-bedrock";
	const bedrockRegionRe = /bedrock-runtime\.([a-z0-9-]+)\.amazonaws\./;
	const bedrockContextOverflowPatterns = [
		/ValidationException.*(?:input is too long|max input token|input token.*exceed)/i,
		/ValidationException.*(?:exceeds? the (?:maximum|max) (?:number of )?(?:input )?tokens)/i,
		/ModelStreamErrorException.*(?:Input is too long|too many input tokens)/i
	];
	const deprecatedTemperatureValidationRe = /ValidationException[\s\S]*(?:invalid_request_error[\s\S]*)?temperature[\s\S]*deprecated|ValidationException[\s\S]*deprecated[\s\S]*temperature/i;
	const anthropicByModelReplayHooks = ANTHROPIC_BY_MODEL_REPLAY_HOOKS;
	const startupPluginConfig = api.pluginConfig ?? {};
	function resolveCurrentPluginConfig(config) {
		return resolvePluginConfigObject(config, providerId) ?? (config ? void 0 : startupPluginConfig);
	}
	api.registerMemoryEmbeddingProvider(bedrockMemoryEmbeddingProviderAdapter);
	const baseWrapStreamFn = ({ modelId, streamFn }) => {
		if (isAnthropicBedrockModel(modelId)) return streamFn;
		if (isBedrockAppInferenceProfile(modelId)) return streamFn;
		return createBedrockNoCacheWrapper(streamFn);
	};
	function omitDeprecatedOpus47Temperature(modelId, options) {
		if (!isOpus47BedrockModelRef(modelId) || !("temperature" in options)) return options;
		const next = { ...options };
		delete next.temperature;
		return next;
	}
	function omitDeprecatedOpus47PayloadTemperature(payload) {
		const inferenceConfig = payload.inferenceConfig;
		if (!inferenceConfig || typeof inferenceConfig !== "object") return;
		delete inferenceConfig.temperature;
	}
	function withAwsCredentialRefreshOnPayload(options) {
		const originalOnPayload = options.onPayload;
		return {
			...options,
			onPayload: async (payload, payloadModel) => {
				await refreshAwsSharedConfigCacheForBedrock();
				return originalOnPayload?.(payload, payloadModel);
			}
		};
	}
	function createAwsCredentialRefreshStreamWrapper(streamFn) {
		if (!streamFn) return streamFn;
		return (streamModel, context, options) => streamFn(streamModel, context, withAwsCredentialRefreshOnPayload(Object.assign({}, options)));
	}
	/** Extract the AWS region from a bedrock-runtime baseUrl. */
	function extractRegionFromBaseUrl(baseUrl) {
		if (!baseUrl) return;
		return bedrockRegionRe.exec(baseUrl)?.[1];
	}
	/**
	* Resolve the AWS region for Bedrock API calls.
	* Provider-specific baseUrl wins over global bedrockDiscovery to avoid signing
	* with the wrong region when discovery and provider target different regions.
	*/
	function resolveBedrockRegion(config) {
		const providers = config?.models?.providers;
		if (providers) {
			const exact = providers[providerId]?.baseUrl;
			if (exact) {
				const region = extractRegionFromBaseUrl(exact);
				if (region) return region;
			}
			for (const [key, value] of Object.entries(providers)) {
				if (key === providerId || normalizeProviderId(key) !== providerId) continue;
				const region = extractRegionFromBaseUrl(value.baseUrl);
				if (region) return region;
			}
		}
		return config?.models?.bedrockDiscovery?.region;
	}
	api.registerProvider({
		id: providerId,
		label: "Amazon Bedrock",
		docsPath: "/providers/models",
		auth: [],
		catalog: {
			order: "simple",
			run: async (ctx) => {
				const { resolveImplicitBedrockProvider } = await import("./extensions/amazon-bedrock/discovery.js");
				const currentPluginConfig = resolveCurrentPluginConfig(ctx.config);
				const implicit = await resolveImplicitBedrockProvider({
					config: ctx.config,
					pluginConfig: currentPluginConfig,
					env: ctx.env
				});
				if (!implicit) return null;
				return { provider: mergeImplicitBedrockProvider({
					existing: ctx.config.models?.providers?.[providerId],
					implicit
				}) };
			}
		},
		resolveConfigApiKey: ({ env }) => resolveBedrockConfigApiKey(env),
		...anthropicByModelReplayHooks,
		wrapStreamFn: ({ modelId, config, model, streamFn, thinkingLevel, extraParams }) => {
			const currentGuardrail = resolveCurrentPluginConfig(config)?.guardrail;
			let wrapped = (currentGuardrail?.guardrailIdentifier && currentGuardrail?.guardrailVersion ? createGuardrailWrapStreamFn(baseWrapStreamFn, currentGuardrail)({
				modelId,
				streamFn
			}) : baseWrapStreamFn({
				modelId,
				streamFn
			})) ?? void 0;
			const serviceTier = resolveBedrockServiceTier(extraParams, (message) => api.logger.warn(message));
			if (serviceTier && wrapped) wrapped = createBedrockServiceTierWrapper(wrapped, serviceTier);
			const region = resolveBedrockRegion(config) ?? extractRegionFromBaseUrl(model?.baseUrl);
			const mayNeedCacheInjection = isBedrockAppInferenceProfile(modelId) && !piAiWouldInjectCachePoints(modelId);
			const shouldOmitTemperature = isOpus47BedrockModelRef(modelId);
			const shouldPatchMaxThinking = shouldOmitTemperature && thinkingLevel === "max";
			const heuristicMatch = needsCachePointInjection(modelId);
			if (!region && !mayNeedCacheInjection && !shouldOmitTemperature && !shouldPatchMaxThinking) return createAwsCredentialRefreshStreamWrapper(wrapped);
			const underlying = wrapped ?? streamFn;
			if (!underlying) return wrapped;
			return (streamModel, context, options) => {
				const merged = omitDeprecatedOpus47Temperature(modelId, Object.assign({}, options, region ? { region } : {}));
				const originalOnPayload = merged.onPayload;
				if (!mayNeedCacheInjection) return underlying(streamModel, context, withAwsCredentialRefreshOnPayload({
					...merged,
					...shouldPatchMaxThinking ? { onPayload: (payload, payloadModel) => {
						if (payload && typeof payload === "object") patchOpus47MaxThinkingEffort(payload);
						return originalOnPayload?.(payload, payloadModel);
					} } : {}
				}));
				const cacheRetention = typeof merged.cacheRetention === "string" ? merged.cacheRetention : "short";
				if (heuristicMatch) {
					const mayNeedTemperatureTrait = "temperature" in merged;
					return underlying(streamModel, context, withAwsCredentialRefreshOnPayload({
						...merged,
						onPayload: async (payload, payloadModel) => {
							if (payload && typeof payload === "object") {
								const payloadRecord = payload;
								injectBedrockCachePoints(payloadRecord, cacheRetention);
								if (shouldPatchMaxThinking) patchOpus47MaxThinkingEffort(payloadRecord);
								if (mayNeedTemperatureTrait) {
									if ((await resolveAppProfileTraits(modelId, region)).omitTemperature) omitDeprecatedOpus47PayloadTemperature(payloadRecord);
								}
							}
							return originalOnPayload?.(payload, payloadModel);
						}
					}));
				}
				return underlying(streamModel, context, withAwsCredentialRefreshOnPayload({
					...merged,
					onPayload: async (payload, payloadModel) => {
						const traits = await resolveAppProfileTraits(modelId, region);
						if (payload && typeof payload === "object") {
							const payloadRecord = payload;
							if (traits.cacheEligible) injectBedrockCachePoints(payloadRecord, cacheRetention);
							if (shouldPatchMaxThinking) patchOpus47MaxThinkingEffort(payloadRecord);
							if (traits.omitTemperature) omitDeprecatedOpus47PayloadTemperature(payloadRecord);
						}
						return originalOnPayload?.(payload, payloadModel);
					}
				}));
			};
		},
		matchesContextOverflowError: ({ errorMessage }) => bedrockContextOverflowPatterns.some((pattern) => pattern.test(errorMessage)),
		classifyFailoverReason: ({ errorMessage }) => {
			if (/ThrottlingException|Too many concurrent requests/i.test(errorMessage)) return "rate_limit";
			if (/ModelNotReadyException/i.test(errorMessage)) return "overloaded";
			if (deprecatedTemperatureValidationRe.test(errorMessage)) return "format";
		},
		resolveThinkingProfile: ({ modelId }) => resolveBedrockClaudeThinkingProfile(modelId)
	});
}
//#endregion
export { resetBedrockAppProfileCacheEligibilityForTest as n, setBedrockAppProfileControlPlaneForTest as r, registerAmazonBedrockPlugin as t };
