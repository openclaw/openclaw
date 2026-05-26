import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { i as resolveAgentModelPrimaryValue, r as resolveAgentModelFallbackValues } from "./model-input-ChW9XXsQ.js";
import { r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { t as getProviderEnvVars } from "./provider-env-vars-HpAfBQBJ.js";
import { n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { t as resolveEnvApiKey } from "./model-auth-env-CZ-LXyVa.js";
import { i as isFailoverError, r as describeFailoverError } from "./failover-error-CZCIurQK.js";
import "./auth-profiles-D6NMnufG.js";
import { n as listProfilesForProvider } from "./profile-list-C0HtPlut.js";
//#region src/media-generation/runtime-shared.ts
function recordCapabilityCandidateFailure(params) {
	const described = isFailoverError(params.error) ? describeFailoverError(params.error) : void 0;
	params.attempts.push({
		provider: params.provider,
		model: params.model,
		error: described?.message ?? formatErrorMessage(params.error),
		reason: described?.reason,
		status: described?.status,
		code: described?.code
	});
}
function hasMediaNormalizationEntry(entry) {
	return Boolean(entry && (entry.requested !== void 0 || entry.applied !== void 0 || entry.derivedFrom !== void 0 || (entry.supportedValues?.length ?? 0) > 0));
}
const IMAGE_RESOLUTION_ORDER = [
	"1K",
	"2K",
	"4K"
];
function resolveMediaProviderDefaultTimeoutMs(timeoutMs) {
	return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : void 0;
}
function resolveMediaProviderRequestTimeoutMs(params) {
	return params.timeoutMs ?? resolveMediaProviderDefaultTimeoutMs(params.providerDefaultTimeoutMs);
}
function resolveCurrentDefaultProviderId(cfg) {
	const trimmed = normalizeOptionalString(resolveAgentModelPrimaryValue(cfg?.agents?.defaults?.model));
	if (!trimmed) return DEFAULT_PROVIDER;
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return DEFAULT_PROVIDER;
	return normalizeOptionalString(trimmed.slice(0, slash)) || "openai";
}
function isCapabilityProviderConfigured(params) {
	if (params.provider.isConfigured) return params.provider.isConfigured({
		cfg: params.cfg,
		agentDir: params.agentDir
	});
	if (resolveEnvApiKey(params.provider.id)?.apiKey) return true;
	const agentDir = normalizeOptionalString(params.agentDir);
	if (!agentDir) return false;
	return listProfilesForProvider(ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false }), params.provider.id).length > 0;
}
function resolveAutoCapabilityFallbackRefs(params) {
	const providerDefaults = /* @__PURE__ */ new Map();
	for (const provider of params.listProviders(params.cfg)) {
		const providerId = normalizeOptionalString(provider.id);
		const modelId = normalizeOptionalString(provider.defaultModel);
		if (!providerId || !modelId || providerDefaults.has(providerId) || !isCapabilityProviderConfigured({
			provider,
			cfg: params.cfg,
			agentDir: params.agentDir
		})) continue;
		const aliases = (provider.aliases ?? []).flatMap((alias) => {
			const normalized = normalizeOptionalString(alias);
			return normalized ? [normalized] : [];
		});
		providerDefaults.set(providerId, {
			ref: `${providerId}/${modelId}`,
			aliases
		});
	}
	const defaultProvider = resolveCurrentDefaultProviderId(params.cfg);
	const providerIds = [...providerDefaults.keys()].toSorted();
	const matchesDefaultProvider = (providerId) => {
		const entry = providerDefaults.get(providerId);
		return providerId === defaultProvider || (entry?.aliases ?? []).includes(defaultProvider);
	};
	return [...providerIds.filter(matchesDefaultProvider), ...providerIds.filter((providerId) => !matchesDefaultProvider(providerId))].flatMap((providerId) => {
		const entry = providerDefaults.get(providerId);
		return entry ? [entry.ref] : [];
	});
}
function resolveProviderModelOnlyRef(params) {
	const model = normalizeOptionalString(params.raw);
	if (!model) return null;
	const provider = params.providers.find((candidate) => {
		return [candidate.defaultModel, ...candidate.models ?? []].some((entry) => normalizeOptionalString(entry) === model);
	});
	return provider ? {
		provider: provider.id,
		model
	} : null;
}
function hasCapabilityProviderId(params) {
	const providerId = normalizeOptionalString(params.providerId);
	if (!providerId) return false;
	return params.providers.some((provider) => provider.id === providerId || (provider.aliases ?? []).some((alias) => normalizeOptionalString(alias) === providerId));
}
function resolveCapabilityModelCandidates(params) {
	const candidates = [];
	const seen = /* @__PURE__ */ new Set();
	let providers;
	const getProviders = () => {
		providers ??= params.listProviders?.(params.cfg) ?? [];
		return providers;
	};
	const resolveCandidate = (raw, options) => {
		const trimmed = normalizeOptionalString(raw);
		if (!trimmed) return null;
		const parsed = params.parseModelRef(raw);
		if (!options.useProviderMetadata) return parsed;
		if (parsed && hasCapabilityProviderId({
			providerId: parsed.provider,
			providers: getProviders()
		})) return parsed;
		return resolveProviderModelOnlyRef({
			raw: trimmed,
			providers: getProviders()
		}) ?? parsed;
	};
	const add = (raw, options) => {
		const candidate = resolveCandidate(raw, options);
		if (!candidate) return;
		const key = `${candidate.provider}/${candidate.model}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(candidate);
	};
	const override = resolveCandidate(params.modelOverride, { useProviderMetadata: true });
	if (override) return [override];
	const autoProviderFallbackEnabled = params.autoProviderFallback ?? params.cfg.agents?.defaults?.mediaGenerationAutoProviderFallback !== false;
	add(params.modelOverride, { useProviderMetadata: true });
	add(resolveAgentModelPrimaryValue(params.modelConfig), { useProviderMetadata: autoProviderFallbackEnabled });
	for (const fallback of resolveAgentModelFallbackValues(params.modelConfig)) add(fallback, { useProviderMetadata: autoProviderFallbackEnabled });
	if (autoProviderFallbackEnabled && params.listProviders) for (const candidate of resolveAutoCapabilityFallbackRefs({
		cfg: params.cfg,
		agentDir: params.agentDir,
		listProviders: () => getProviders()
	})) add(candidate, { useProviderMetadata: false });
	return candidates;
}
function normalizeSupportedValues(values) {
	return (values ?? []).flatMap((entry) => {
		return normalizeOptionalString(entry) ? [entry] : [];
	});
}
function compareScores(next, best) {
	if (!best) return true;
	if (next.primary !== best.primary) return next.primary < best.primary;
	if (next.secondary !== best.secondary) return next.secondary < best.secondary;
	return next.tertiary.localeCompare(best.tertiary) < 0;
}
function parsePositiveDimensionPair(raw, pattern) {
	const trimmed = normalizeOptionalString(raw);
	if (!trimmed) return null;
	const match = pattern.exec(trimmed);
	if (!match) return null;
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
	return {
		width,
		height
	};
}
function parseAspectRatioValue(raw) {
	const pair = parsePositiveDimensionPair(raw, /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
	if (!pair) return null;
	return {
		width: pair.width,
		height: pair.height,
		value: pair.width / pair.height
	};
}
function parseSizeValue(raw) {
	const pair = parsePositiveDimensionPair(raw, /^(\d+)\s*x\s*(\d+)$/i);
	if (!pair) return null;
	return {
		width: pair.width,
		height: pair.height,
		aspectRatio: pair.width / pair.height,
		area: pair.width * pair.height
	};
}
function greatestCommonDivisor(a, b) {
	let left = Math.abs(a);
	let right = Math.abs(b);
	while (right !== 0) {
		const next = left % right;
		left = right;
		right = next;
	}
	return left || 1;
}
function deriveAspectRatioFromSize(size) {
	const parsed = parseSizeValue(size);
	if (!parsed) return;
	const divisor = greatestCommonDivisor(parsed.width, parsed.height);
	return `${parsed.width / divisor}:${parsed.height / divisor}`;
}
function resolveClosestAspectRatio(params) {
	const supported = normalizeSupportedValues(params.supportedAspectRatios);
	if (supported.length === 0) return params.requestedAspectRatio ?? deriveAspectRatioFromSize(params.requestedSize);
	if (params.requestedAspectRatio && supported.includes(params.requestedAspectRatio)) return params.requestedAspectRatio;
	const requested = parseAspectRatioValue(params.requestedAspectRatio) ?? parseAspectRatioValue(deriveAspectRatioFromSize(params.requestedSize));
	if (!requested) return;
	let bestValue;
	let bestScore = null;
	for (const candidate of supported) {
		const parsed = parseAspectRatioValue(candidate);
		if (!parsed) continue;
		const score = {
			primary: Math.abs(Math.log(parsed.value / requested.value)),
			secondary: Math.abs(parsed.width * requested.height - requested.width * parsed.height),
			tertiary: candidate
		};
		if (compareScores(score, bestScore)) {
			bestValue = candidate;
			bestScore = score;
		}
	}
	return bestValue;
}
function resolveClosestSize(params) {
	const supported = normalizeSupportedValues(params.supportedSizes);
	if (supported.length === 0) return params.requestedSize;
	if (params.requestedSize && supported.includes(params.requestedSize)) return params.requestedSize;
	const requested = parseSizeValue(params.requestedSize);
	const requestedAspectRatio = parseAspectRatioValue(params.requestedAspectRatio);
	if (!requested && !requestedAspectRatio) return;
	let bestValue;
	let bestScore = null;
	for (const candidate of supported) {
		const parsed = parseSizeValue(candidate);
		if (!parsed) continue;
		const score = {
			primary: Math.abs(Math.log(parsed.aspectRatio / (requested?.aspectRatio ?? requestedAspectRatio.value))),
			secondary: requested ? Math.abs(Math.log(parsed.area / requested.area)) : parsed.area,
			tertiary: candidate
		};
		if (compareScores(score, bestScore)) {
			bestValue = candidate;
			bestScore = score;
		}
	}
	return bestValue;
}
function resolveClosestResolution(params) {
	const supported = normalizeSupportedValues(params.supportedResolutions);
	if (supported.length === 0) return params.requestedResolution;
	if (params.requestedResolution && supported.includes(params.requestedResolution)) return params.requestedResolution;
	const order = params.order ?? IMAGE_RESOLUTION_ORDER;
	const requestedIndex = params.requestedResolution ? order.indexOf(params.requestedResolution) : -1;
	if (requestedIndex < 0) return;
	let bestValue;
	let bestScore = null;
	for (const candidate of supported) {
		const candidateIndex = order.indexOf(candidate);
		if (candidateIndex < 0) continue;
		const score = {
			primary: Math.abs(candidateIndex - requestedIndex),
			secondary: candidateIndex,
			tertiary: candidate
		};
		if (compareScores(score, bestScore)) {
			bestValue = candidate;
			bestScore = score;
		}
	}
	return bestValue;
}
function normalizeDurationToClosestMax(durationSeconds, maxDurationSeconds) {
	if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) return;
	const rounded = Math.max(1, Math.round(durationSeconds));
	if (typeof maxDurationSeconds !== "number" || !Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) return rounded;
	return Math.min(rounded, Math.max(1, Math.round(maxDurationSeconds)));
}
function buildMediaGenerationNormalizationMetadata(params) {
	const metadata = {};
	const { normalization } = params;
	if (normalization?.size?.requested !== void 0 && normalization.size.applied !== void 0) {
		metadata.requestedSize = normalization.size.requested;
		metadata.normalizedSize = normalization.size.applied;
	}
	if (normalization?.aspectRatio?.applied !== void 0) {
		if (normalization.aspectRatio.requested !== void 0) metadata.requestedAspectRatio = normalization.aspectRatio.requested;
		metadata.normalizedAspectRatio = normalization.aspectRatio.applied;
		if (normalization.aspectRatio.derivedFrom === "size" && params.requestedSizeForDerivedAspectRatio) {
			metadata.requestedSize = params.requestedSizeForDerivedAspectRatio;
			metadata.aspectRatioDerivedFromSize = deriveAspectRatioFromSize(params.requestedSizeForDerivedAspectRatio);
		}
	}
	if (normalization?.resolution?.requested !== void 0 && normalization.resolution.applied !== void 0) {
		metadata.requestedResolution = normalization.resolution.requested;
		metadata.normalizedResolution = normalization.resolution.applied;
	}
	if (normalization?.durationSeconds?.requested !== void 0 && normalization.durationSeconds.applied !== void 0) {
		metadata.requestedDurationSeconds = normalization.durationSeconds.requested;
		metadata.normalizedDurationSeconds = normalization.durationSeconds.applied;
		if (params.includeSupportedDurationSeconds && normalization.durationSeconds.supportedValues?.length) metadata.supportedDurationSeconds = normalization.durationSeconds.supportedValues;
	}
	return metadata;
}
function throwCapabilityGenerationFailure(params) {
	if (params.attempts.length <= 1 && params.lastError) throw params.lastError;
	const summary = formatCapabilityFailureAttempts(params.attempts);
	throw new Error(`All ${params.capabilityLabel} models failed (${params.attempts.length}): ${summary}`, { cause: params.lastError instanceof Error ? params.lastError : void 0 });
}
function formatCapabilityFailureAttempts(attempts) {
	if (attempts.length === 0) return "unknown";
	const abortedAttempts = attempts.filter(isAbortLikeFallbackAttempt);
	if (abortedAttempts.length === 0) return attempts.map(formatCapabilityFailureAttempt).join(" | ");
	if (abortedAttempts.length === attempts.length) return `${abortedAttempts.length} fallback(s) aborted after the request was cancelled or timed out: ${abortedAttempts.map(formatCapabilityAttemptRef).join(", ")}`;
	return [attempts.filter((attempt) => !isAbortLikeFallbackAttempt(attempt)).map(formatCapabilityFailureAttempt).join(" | "), `${abortedAttempts.length} fallback(s) aborted after the request was cancelled or timed out: ${abortedAttempts.map(formatCapabilityAttemptRef).join(", ")}`].join(" | ");
}
function formatCapabilityFailureAttempt(attempt) {
	return `${formatCapabilityAttemptRef(attempt)}: ${attempt.error}`;
}
function formatCapabilityAttemptRef(attempt) {
	return `${attempt.provider}/${attempt.model}`;
}
function isAbortLikeFallbackAttempt(attempt) {
	const message = attempt.error.trim().toLowerCase();
	return message === "this operation was aborted" || message === "operation was aborted" || message.includes("operation was aborted") || message.includes("request was aborted");
}
function buildNoCapabilityModelConfiguredMessage(params) {
	const getProviderEnvVars$1 = params.getProviderEnvVars ?? getProviderEnvVars;
	const sampleModel = params.providers.find((provider) => normalizeOptionalString(provider.id) && normalizeOptionalString(provider.defaultModel));
	const sampleRef = sampleModel ? `${sampleModel.id}/${sampleModel.defaultModel}` : params.fallbackSampleRef ?? "<provider>/<model>";
	const authHints = params.providers.flatMap((provider) => {
		const envVars = getProviderEnvVars$1(provider.id);
		if (envVars.length === 0) return [];
		return [`${provider.id}: ${envVars.join(" / ")}`];
	}).slice(0, 3);
	return [`No ${params.capabilityLabel} model configured. Set agents.defaults.${params.modelConfigKey}.primary to a provider/model like "${sampleRef}".`, authHints.length > 0 ? `If you want a specific provider, also configure that provider's auth/API key first (${authHints.join("; ")}).` : "If you want a specific provider, also configure that provider's auth/API key first."].join(" ");
}
//#endregion
export { normalizeDurationToClosestMax as a, resolveClosestAspectRatio as c, resolveMediaProviderDefaultTimeoutMs as d, resolveMediaProviderRequestTimeoutMs as f, hasMediaNormalizationEntry as i, resolveClosestResolution as l, buildNoCapabilityModelConfiguredMessage as n, recordCapabilityCandidateFailure as o, throwCapabilityGenerationFailure as p, deriveAspectRatioFromSize as r, resolveCapabilityModelCandidates as s, buildMediaGenerationNormalizationMetadata as t, resolveClosestSize as u };
