import { c as readLoggingConfig, i as redactSensitiveText, t as getDefaultRedactPatterns } from "./redact-1fZUZMlV.js";
import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { t as sanitizeForLog } from "./ansi-Dqm1lzVL.js";
import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { t as createLazyImportLoader } from "./lazy-promise-BWWZqHu4.js";
import { t as createSubsystemLogger } from "./subsystem-CgTF-J8V.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-DNihGLJv.js";
import { n as resolveAgentModelPrimaryValue, t as resolveAgentModelFallbackValues } from "./model-input-qoijZF3K.js";
import { t as hasAnyAuthProfileStoreSource } from "./source-check-CgrdYfQr.js";
import { S as normalizeModelRef, f as resolveConfiguredModelRef, h as resolveModelRefFromString, i as buildModelAliasIndex, n as buildConfiguredAllowlistKeys, x as modelKey } from "./model-selection-shared-HUsqLCFt.js";
import "./model-selection-cli-DHawQCtm.js";
import { r as externalCliDiscoveryForProviders } from "./external-cli-discovery-yomk1YD5.js";
import { t as redactIdentifier } from "./redact-identifier-BSBtxIqa.js";
import { a as parseApiErrorInfo } from "./assistant-error-format-CCItx9bC.js";
import { f as stableStringify, o as getApiErrorPayloadFingerprint } from "./sanitize-user-facing-text-C8OOPiUY.js";
import { m as isLikelyContextOverflowError, r as classifyProviderRuntimeFailureKind } from "./errors-DEYYRlWS.js";
import "./pi-embedded-helpers-BTvKbJ6F.js";
import { a as isTimeoutError, i as isFailoverError, n as coerceToFailoverError, r as describeFailoverError, t as FailoverError } from "./failover-error-BQkZNf2j.js";
//#region src/agents/pi-embedded-error-observation.ts
const MAX_OBSERVATION_INPUT_CHARS = 64e3;
const MAX_FINGERPRINT_MESSAGE_CHARS = 8e3;
const RAW_ERROR_PREVIEW_MAX_CHARS = 400;
const PROVIDER_ERROR_PREVIEW_MAX_CHARS = 200;
const REQUEST_ID_RE = /\brequest[_ ]?id\b\s*[:=]\s*["'()]*([A-Za-z0-9._:-]+)/i;
const OBSERVATION_EXTRA_REDACT_PATTERNS = [
	String.raw`\b(?:x-)?api[-_]?key\b\s*[:=]\s*(["']?)([^\s"'\\;]+)\1`,
	String.raw`"(?:api[-_]?key|api_key)"\s*:\s*"([^"]+)"`,
	String.raw`(?:\bCookie\b\s*[:=]\s*[^;=\s]+=|;\s*[^;=\s]+=)([^;\s\r\n]+)`
];
function resolveConfiguredRedactPatterns() {
	const configured = readLoggingConfig()?.redactPatterns;
	if (!Array.isArray(configured)) return [];
	return configured.filter((pattern) => typeof pattern === "string");
}
function truncateForObservation(text, maxChars) {
	const trimmed = text?.trim();
	if (!trimmed) return;
	return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}
function boundObservationInput(text) {
	const trimmed = text?.trim();
	if (!trimmed) return;
	return trimmed.length > MAX_OBSERVATION_INPUT_CHARS ? trimmed.slice(0, MAX_OBSERVATION_INPUT_CHARS) : trimmed;
}
function replaceRequestIdPreview(text, requestId) {
	if (!text || !requestId) return text;
	return text.split(requestId).join(redactIdentifier(requestId, { len: 12 }));
}
function redactObservationText(text) {
	if (!text) return text;
	const configuredPatterns = resolveConfiguredRedactPatterns();
	return redactSensitiveText(text, {
		mode: "tools",
		patterns: [
			...getDefaultRedactPatterns(),
			...configuredPatterns,
			...OBSERVATION_EXTRA_REDACT_PATTERNS
		]
	});
}
function buildObservationFingerprint(params) {
	const boundedMessage = params.message && params.message.length > MAX_FINGERPRINT_MESSAGE_CHARS ? params.message.slice(0, MAX_FINGERPRINT_MESSAGE_CHARS) : params.message;
	const structured = params.httpCode || params.type || boundedMessage ? stableStringify({
		httpCode: params.httpCode,
		type: params.type,
		message: boundedMessage
	}) : null;
	if (structured) return structured;
	if (params.requestId) return params.raw.split(params.requestId).join("<request_id>");
	return getApiErrorPayloadFingerprint(params.raw);
}
function buildApiErrorObservationFields(rawError, opts) {
	const trimmed = boundObservationInput(rawError);
	if (!trimmed) return {};
	try {
		const parsed = parseApiErrorInfo(trimmed);
		const requestId = parsed?.requestId ?? normalizeOptionalString(trimmed.match(REQUEST_ID_RE)?.[1]);
		const requestIdHash = requestId ? redactIdentifier(requestId, { len: 12 }) : void 0;
		const rawFingerprint = buildObservationFingerprint({
			raw: trimmed,
			requestId,
			httpCode: parsed?.httpCode,
			type: parsed?.type,
			message: parsed?.message
		});
		const redactedRawPreview = replaceRequestIdPreview(redactObservationText(trimmed), requestId);
		const redactedProviderMessage = replaceRequestIdPreview(redactObservationText(parsed?.message), requestId);
		return {
			rawErrorPreview: truncateForObservation(redactedRawPreview, RAW_ERROR_PREVIEW_MAX_CHARS),
			rawErrorHash: redactIdentifier(trimmed, { len: 12 }),
			rawErrorFingerprint: rawFingerprint ? redactIdentifier(rawFingerprint, { len: 12 }) : void 0,
			httpCode: parsed?.httpCode,
			providerRuntimeFailureKind: classifyProviderRuntimeFailureKind({
				status: parsed?.httpCode ? Number(parsed.httpCode) : void 0,
				message: trimmed,
				provider: opts?.provider
			}),
			providerErrorType: parsed?.type,
			providerErrorMessagePreview: truncateForObservation(redactedProviderMessage, PROVIDER_ERROR_PREVIEW_MAX_CHARS),
			requestIdHash
		};
	} catch {
		return {};
	}
}
function buildTextObservationFields(text, opts) {
	const observed = buildApiErrorObservationFields(text, opts);
	return {
		textPreview: observed.rawErrorPreview,
		textHash: observed.rawErrorHash,
		textFingerprint: observed.rawErrorFingerprint,
		httpCode: observed.httpCode,
		providerRuntimeFailureKind: observed.providerRuntimeFailureKind,
		providerErrorType: observed.providerErrorType,
		providerErrorMessagePreview: observed.providerErrorMessagePreview,
		requestIdHash: observed.requestIdHash
	};
}
//#endregion
//#region src/agents/failover-policy.ts
function shouldAllowCooldownProbeForReason(reason) {
	return reason === "rate_limit" || reason === "overloaded" || reason === "billing" || reason === "unknown" || reason === "empty_response" || reason === "no_error_details" || reason === "unclassified" || reason === "timeout";
}
function shouldUseTransientCooldownProbeSlot(reason) {
	return reason === "rate_limit" || reason === "overloaded" || reason === "unknown" || reason === "empty_response" || reason === "no_error_details" || reason === "unclassified" || reason === "timeout";
}
function shouldPreserveTransientCooldownProbeSlot(reason) {
	return reason === "model_not_found" || reason === "format" || reason === "auth" || reason === "auth_permanent" || reason === "session_expired";
}
//#endregion
//#region src/agents/live-model-switch-error.ts
var LiveSessionModelSwitchError = class extends Error {
	constructor(selection) {
		super(`Live session model switch requested: ${selection.provider}/${selection.model}`);
		this.name = "LiveSessionModelSwitchError";
		this.provider = selection.provider;
		this.model = selection.model;
		this.authProfileId = selection.authProfileId;
		this.authProfileIdSource = selection.authProfileIdSource;
	}
};
//#endregion
//#region src/agents/model-fallback-observation.ts
const decisionLog = createSubsystemLogger("model-fallback").child("decision");
function buildErrorObservationFields(error) {
	const observed = buildTextObservationFields(error);
	return {
		errorPreview: observed.textPreview,
		errorHash: observed.textHash,
		errorFingerprint: observed.textFingerprint,
		httpCode: observed.httpCode,
		providerErrorType: observed.providerErrorType,
		providerErrorMessagePreview: observed.providerErrorMessagePreview,
		requestIdHash: observed.requestIdHash
	};
}
function formatModelRef(candidate) {
	return `${candidate.provider}/${candidate.model}`;
}
function buildFallbackStepFields(params) {
	const lastPreviousAttempt = params.previousAttempts?.at(-1);
	if (params.decision === "candidate_succeeded") {
		if (!lastPreviousAttempt) return;
		return {
			fallbackStepType: "fallback_step",
			fallbackStepFromModel: `${lastPreviousAttempt.provider}/${lastPreviousAttempt.model}`,
			fallbackStepToModel: formatModelRef(params.candidate),
			...lastPreviousAttempt.reason ? { fallbackStepFromFailureReason: lastPreviousAttempt.reason } : {},
			...lastPreviousAttempt.error ? { fallbackStepFromFailureDetail: lastPreviousAttempt.error } : {},
			...typeof params.attempt === "number" ? { fallbackStepChainPosition: params.attempt } : {},
			fallbackStepFinalOutcome: "succeeded"
		};
	}
	const observed = buildErrorObservationFields(params.error);
	return {
		fallbackStepType: "fallback_step",
		fallbackStepFromModel: formatModelRef(params.candidate),
		...params.nextCandidate ? { fallbackStepToModel: formatModelRef(params.nextCandidate) } : {},
		...params.reason ? { fallbackStepFromFailureReason: params.reason } : {},
		...observed.providerErrorMessagePreview ?? observed.errorPreview ? { fallbackStepFromFailureDetail: observed.providerErrorMessagePreview ?? observed.errorPreview } : {},
		...typeof params.attempt === "number" ? { fallbackStepChainPosition: params.attempt } : {},
		fallbackStepFinalOutcome: params.nextCandidate ? "next_fallback" : "chain_exhausted"
	};
}
function logModelFallbackDecision(params) {
	const nextText = params.nextCandidate ? `${sanitizeForLog(params.nextCandidate.provider)}/${sanitizeForLog(params.nextCandidate.model)}` : "none";
	const reasonText = params.reason ?? "unknown";
	const observedError = buildErrorObservationFields(params.error);
	const detailText = observedError.providerErrorMessagePreview ?? observedError.errorPreview;
	const fallbackStepFields = params.decision === "skip_candidate" || params.decision === "candidate_failed" || params.decision === "candidate_succeeded" ? buildFallbackStepFields({
		decision: params.decision,
		candidate: params.candidate,
		reason: params.reason,
		error: params.error,
		nextCandidate: params.nextCandidate,
		attempt: params.attempt,
		previousAttempts: params.previousAttempts
	}) : void 0;
	const providerErrorTypeSuffix = observedError.providerErrorType ? ` providerErrorType=${sanitizeForLog(observedError.providerErrorType)}` : "";
	const detailSuffix = detailText ? ` detail=${sanitizeForLog(detailText)}` : "";
	decisionLog.warn("model fallback decision", {
		event: "model_fallback_decision",
		tags: [
			"error_handling",
			"model_fallback",
			params.decision
		],
		runId: params.runId,
		sessionId: params.sessionId,
		lane: params.lane,
		decision: params.decision,
		requestedProvider: params.requestedProvider,
		requestedModel: params.requestedModel,
		candidateProvider: params.candidate.provider,
		candidateModel: params.candidate.model,
		attempt: params.attempt,
		total: params.total,
		reason: params.reason,
		status: params.status,
		code: params.code,
		...observedError,
		...fallbackStepFields,
		nextCandidateProvider: params.nextCandidate?.provider,
		nextCandidateModel: params.nextCandidate?.model,
		isPrimary: params.isPrimary,
		requestedModelMatched: params.requestedModelMatched,
		fallbackConfigured: params.fallbackConfigured,
		allowTransientCooldownProbe: params.allowTransientCooldownProbe,
		profileCount: params.profileCount,
		previousAttempts: params.previousAttempts?.map((attempt) => ({
			provider: attempt.provider,
			model: attempt.model,
			reason: attempt.reason,
			status: attempt.status,
			code: attempt.code,
			...buildErrorObservationFields(attempt.error)
		})),
		consoleMessage: `model fallback decision: decision=${params.decision} requested=${sanitizeForLog(params.requestedProvider)}/${sanitizeForLog(params.requestedModel)} candidate=${sanitizeForLog(params.candidate.provider)}/${sanitizeForLog(params.candidate.model)} reason=${reasonText}${providerErrorTypeSuffix} next=${nextText}${detailSuffix}`
	});
	return fallbackStepFields;
}
//#endregion
//#region src/agents/model-fallback.ts
const log = createSubsystemLogger("model-fallback");
/**
* Structured error thrown when all model fallback candidates have been
* exhausted. Carries per-attempt details so callers can build informative
* user-facing messages (e.g. "rate-limited, retry in 30 s").
*/
var FallbackSummaryError = class extends Error {
	constructor(message, attempts, soonestCooldownExpiry, cause, attribution) {
		super(message, { cause });
		this.name = "FallbackSummaryError";
		this.attempts = attempts;
		this.soonestCooldownExpiry = soonestCooldownExpiry;
		this.sessionId = attribution?.sessionId;
		this.lane = attribution?.lane;
	}
};
function isFallbackSummaryError(err) {
	return err instanceof FallbackSummaryError;
}
/**
* Fallback abort check. Only treats explicit AbortError names as user aborts.
* Message-based checks (e.g., "aborted") can mask timeouts and skip fallback.
*/
function isFallbackAbortError(err) {
	if (!err || typeof err !== "object") return false;
	if (isFailoverError(err)) return false;
	return ("name" in err ? String(err.name) : "") === "AbortError";
}
function shouldRethrowAbort(err) {
	return isFallbackAbortError(err) && !isTimeoutError(err);
}
function createModelCandidateCollector(allowlist) {
	const seen = /* @__PURE__ */ new Set();
	const candidates = [];
	const addCandidate = (candidate, enforceAllowlist) => {
		if (!candidate.provider || !candidate.model) return;
		const key = modelKey(candidate.provider, candidate.model);
		if (seen.has(key)) return;
		if (enforceAllowlist && allowlist && !allowlist.has(key)) return;
		seen.add(key);
		candidates.push(candidate);
	};
	const addExplicitCandidate = (candidate) => {
		addCandidate(candidate, false);
	};
	const addAllowlistedCandidate = (candidate) => {
		addCandidate(candidate, true);
	};
	return {
		candidates,
		addExplicitCandidate,
		addAllowlistedCandidate
	};
}
const modelFallbackAuthRuntimeLoader = createLazyImportLoader(() => import("./model-fallback-auth.runtime.js"));
async function loadModelFallbackAuthRuntime() {
	return await modelFallbackAuthRuntimeLoader.load();
}
function buildFallbackSuccess(params) {
	return {
		result: params.result,
		provider: params.provider,
		model: params.model,
		attempts: params.attempts
	};
}
async function runFallbackCandidate(params) {
	try {
		return {
			ok: true,
			result: params.options ? await params.run(params.provider, params.model, params.options) : await params.run(params.provider, params.model)
		};
	} catch (err) {
		const normalizedFailover = coerceToFailoverError(err, {
			provider: params.provider,
			model: params.model,
			sessionId: params.attribution?.sessionId,
			lane: params.attribution?.lane
		});
		if (shouldRethrowAbort(err) && !normalizedFailover) throw err;
		return {
			ok: false,
			error: normalizedFailover ?? err
		};
	}
}
async function runFallbackAttempt(params) {
	const runResult = await runFallbackCandidate({
		run: params.run,
		provider: params.provider,
		model: params.model,
		options: params.options,
		attribution: params.attribution
	});
	if (runResult.ok) {
		const classifiedError = resolveResultClassificationError(await params.classifyResult?.({
			result: runResult.result,
			provider: params.provider,
			model: params.model,
			attempt: params.attempt,
			total: params.total
		}), {
			provider: params.provider,
			model: params.model,
			attribution: params.attribution
		});
		if (classifiedError) return { error: classifiedError };
		return { success: buildFallbackSuccess({
			result: runResult.result,
			provider: params.provider,
			model: params.model,
			attempts: params.attempts
		}) };
	}
	return { error: runResult.error };
}
function resolveResultClassificationError(classification, params) {
	if (!classification) return null;
	if ("error" in classification) return classification.error;
	const message = normalizeOptionalString(classification.message);
	if (!message) return null;
	return new FailoverError(message, {
		reason: classification.reason ?? "unknown",
		provider: params.provider,
		model: params.model,
		sessionId: params.attribution?.sessionId,
		lane: params.attribution?.lane,
		status: classification.status,
		code: classification.code,
		rawError: classification.rawError
	});
}
function sameModelCandidate(a, b) {
	return a.provider === b.provider && a.model === b.model;
}
function recordFailedCandidateAttempt(params) {
	const described = describeFailoverError(params.error);
	params.attempts.push({
		provider: params.candidate.provider,
		model: params.candidate.model,
		error: described.rawError ?? described.message,
		reason: described.reason ?? "unknown",
		status: described.status,
		code: described.code
	});
	return logModelFallbackDecision({
		decision: "candidate_failed",
		runId: params.runId,
		sessionId: params.sessionId,
		lane: params.lane,
		requestedProvider: params.requestedProvider ?? params.candidate.provider,
		requestedModel: params.requestedModel ?? params.candidate.model,
		candidate: params.candidate,
		attempt: params.attempt,
		total: params.total,
		reason: described.reason,
		status: described.status,
		code: described.code,
		error: described.rawError ?? described.message,
		nextCandidate: params.nextCandidate,
		isPrimary: params.isPrimary,
		requestedModelMatched: params.requestedModelMatched,
		fallbackConfigured: params.fallbackConfigured
	});
}
function findLiveSessionModelSwitchRedirectIndex(params) {
	const targetKey = modelKey(params.error.provider, params.error.model);
	for (let i = params.currentIndex + 1; i < params.candidates.length; i += 1) {
		const candidate = params.candidates[i];
		if (modelKey(candidate.provider, candidate.model) === targetKey) return i;
	}
	return null;
}
function throwFallbackFailureSummary(params) {
	if (params.attempts.length <= 1 && params.lastError) throw params.lastError;
	const summary = params.attempts.length > 0 ? params.attempts.map(params.formatAttempt).join(" | ") : "unknown";
	throw new FallbackSummaryError(`All ${params.label} failed (${params.attempts.length || params.candidates.length}): ${summary}`, params.attempts, params.soonestCooldownExpiry ?? null, params.lastError instanceof Error ? params.lastError : void 0, params.attribution);
}
function resolveFallbackSoonestCooldownExpiry(params) {
	if (!params.authRuntime || !params.authStore) return null;
	const refreshedStore = params.authRuntime.loadAuthProfileStoreForRuntime(params.agentDir, {
		readOnly: true,
		externalCli: externalCliDiscoveryForProviders({
			cfg: params.cfg,
			providers: params.candidates.map((candidate) => candidate.provider)
		})
	});
	let soonest = null;
	for (const candidate of params.candidates) {
		const ids = params.authRuntime.resolveAuthProfileOrder({
			cfg: params.cfg,
			store: refreshedStore,
			provider: candidate.provider
		});
		const candidateSoonest = params.authRuntime.getSoonestCooldownExpiry(refreshedStore, ids, { forModel: candidate.model });
		if (typeof candidateSoonest === "number" && Number.isFinite(candidateSoonest) && (soonest === null || candidateSoonest < soonest)) soonest = candidateSoonest;
	}
	return soonest;
}
function resolveImageFallbackCandidates(params) {
	const aliasIndex = buildModelAliasIndex({
		cfg: params.cfg ?? {},
		defaultProvider: params.defaultProvider
	});
	const { candidates, addExplicitCandidate, addAllowlistedCandidate } = createModelCandidateCollector(buildConfiguredAllowlistKeys({
		cfg: params.cfg,
		defaultProvider: params.defaultProvider
	}));
	const addRaw = (raw, opts) => {
		const resolved = resolveModelRefFromString({
			raw,
			defaultProvider: params.defaultProvider,
			aliasIndex
		});
		if (!resolved) return;
		if (opts?.allowlist) {
			addAllowlistedCandidate(resolved.ref);
			return;
		}
		addExplicitCandidate(resolved.ref);
	};
	if (params.modelOverride?.trim()) addRaw(params.modelOverride);
	else {
		const primary = resolveAgentModelPrimaryValue(params.cfg?.agents?.defaults?.imageModel);
		if (primary?.trim()) addRaw(primary);
	}
	const imageFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.imageModel);
	for (const raw of imageFallbacks) addRaw(raw);
	return candidates;
}
function resolveImageFallbackDefaultProvider(cfg) {
	const configuredPrimary = resolveAgentModelPrimaryValue(cfg?.agents?.defaults?.imageModel);
	if (configuredPrimary?.trim()) {
		const resolved = resolveModelRefFromString({
			raw: configuredPrimary,
			defaultProvider: DEFAULT_PROVIDER,
			aliasIndex: buildModelAliasIndex({
				cfg: cfg ?? {},
				defaultProvider: DEFAULT_PROVIDER
			})
		});
		if (resolved?.ref.provider) return resolved.ref.provider;
	}
	return DEFAULT_PROVIDER;
}
function resolveFallbackCandidates(params) {
	const primary = params.cfg ? resolveConfiguredModelRef({
		cfg: params.cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	}) : null;
	const defaultProvider = primary?.provider ?? "openai";
	const defaultModel = primary?.model ?? "gpt-5.5";
	const providerRaw = normalizeOptionalString(params.provider) || defaultProvider;
	const modelRaw = normalizeOptionalString(params.model) || defaultModel;
	const normalizedPrimary = normalizeModelRef(providerRaw, modelRaw);
	const configuredPrimary = normalizeModelRef(defaultProvider, defaultModel);
	const aliasIndex = buildModelAliasIndex({
		cfg: params.cfg ?? {},
		defaultProvider
	});
	const { candidates, addExplicitCandidate } = createModelCandidateCollector(buildConfiguredAllowlistKeys({
		cfg: params.cfg,
		defaultProvider
	}));
	const resolvedModelAlias = resolveModelRefFromString({
		raw: modelRaw,
		defaultProvider: providerRaw,
		aliasIndex
	});
	const resolvedProviderModelAlias = resolveModelRefFromString({
		raw: `${providerRaw}/${modelRaw}`,
		defaultProvider,
		aliasIndex
	});
	const resolvedPrimary = (resolvedModelAlias?.alias ? resolvedModelAlias.ref : null) ?? (resolvedProviderModelAlias?.alias ? resolvedProviderModelAlias.ref : null) ?? normalizedPrimary;
	const effectivePrimary = normalizeModelRef(resolvedPrimary.provider, resolvedPrimary.model);
	addExplicitCandidate(effectivePrimary);
	const modelFallbacks = (() => {
		if (params.fallbacksOverride !== void 0) return params.fallbacksOverride;
		const configuredFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);
		if (effectivePrimary.provider !== configuredPrimary.provider) return configuredFallbacks.some((raw) => {
			const resolved = resolveModelRefFromString({
				raw,
				defaultProvider,
				aliasIndex
			});
			return resolved ? sameModelCandidate(resolved.ref, effectivePrimary) : false;
		}) ? configuredFallbacks : [];
		return configuredFallbacks;
	})();
	for (const raw of modelFallbacks) {
		const resolved = resolveModelRefFromString({
			raw,
			defaultProvider,
			aliasIndex
		});
		if (!resolved) continue;
		addExplicitCandidate(resolved.ref);
	}
	if (params.fallbacksOverride === void 0 && primary?.provider && primary.model) addExplicitCandidate({
		provider: primary.provider,
		model: primary.model
	});
	return candidates;
}
const lastProbeAttempt = /* @__PURE__ */ new Map();
const MIN_PROBE_INTERVAL_MS = 3e4;
const PROBE_MARGIN_MS = 120 * 1e3;
const PROBE_SCOPE_DELIMITER = "::";
const PROBE_STATE_TTL_MS = 1440 * 60 * 1e3;
const MAX_PROBE_KEYS = 256;
function resolveProbeThrottleKey(provider, agentDir) {
	const scope = normalizeOptionalString(agentDir) ?? "";
	return scope ? `${scope}${PROBE_SCOPE_DELIMITER}${provider}` : provider;
}
function pruneProbeState(now) {
	for (const [key, ts] of lastProbeAttempt) if (!Number.isFinite(ts) || ts <= 0 || now - ts > PROBE_STATE_TTL_MS) lastProbeAttempt.delete(key);
}
function enforceProbeStateCap() {
	while (lastProbeAttempt.size > MAX_PROBE_KEYS) {
		let oldestKey = null;
		let oldestTs = Number.POSITIVE_INFINITY;
		for (const [key, ts] of lastProbeAttempt) if (ts < oldestTs) {
			oldestKey = key;
			oldestTs = ts;
		}
		if (!oldestKey) break;
		lastProbeAttempt.delete(oldestKey);
	}
}
function isProbeThrottleOpen(now, throttleKey) {
	pruneProbeState(now);
	return now - (lastProbeAttempt.get(throttleKey) ?? 0) >= MIN_PROBE_INTERVAL_MS;
}
function markProbeAttempt(now, throttleKey) {
	pruneProbeState(now);
	lastProbeAttempt.set(throttleKey, now);
	enforceProbeStateCap();
}
function shouldProbePrimaryDuringCooldown(params) {
	if (!params.isPrimary || !params.hasFallbackCandidates) return false;
	if (!isProbeThrottleOpen(params.now, params.throttleKey)) return false;
	const soonest = params.authRuntime.getSoonestCooldownExpiry(params.authStore, params.profileIds, {
		now: params.now,
		forModel: params.model
	});
	if (soonest === null || !Number.isFinite(soonest)) return true;
	return params.now >= soonest - PROBE_MARGIN_MS;
}
function resolveCooldownDecision(params) {
	const shouldProbe = shouldProbePrimaryDuringCooldown({
		isPrimary: params.isPrimary,
		hasFallbackCandidates: params.hasFallbackCandidates,
		now: params.now,
		throttleKey: params.probeThrottleKey,
		authRuntime: params.authRuntime,
		authStore: params.authStore,
		profileIds: params.profileIds,
		model: params.candidate.model
	});
	const inferredReason = params.authRuntime.resolveProfilesUnavailableReason({
		store: params.authStore,
		profileIds: params.profileIds,
		now: params.now
	}) ?? "unknown";
	if (inferredReason === "auth" || inferredReason === "auth_permanent") return {
		type: "skip",
		reason: inferredReason,
		error: `Provider ${params.candidate.provider} has ${inferredReason} issue (skipping all models)`
	};
	if (inferredReason === "billing") {
		const shouldProbeSingleProviderBilling = params.isPrimary && !params.hasFallbackCandidates && isProbeThrottleOpen(params.now, params.probeThrottleKey);
		if (params.isPrimary && (shouldProbe || shouldProbeSingleProviderBilling)) return {
			type: "attempt",
			reason: inferredReason,
			markProbe: true
		};
		return {
			type: "skip",
			reason: inferredReason,
			error: `Provider ${params.candidate.provider} has ${inferredReason} issue (skipping all models)`
		};
	}
	if (!(params.isPrimary && (!params.requestedModel || shouldProbe) || !params.isPrimary && shouldUseTransientCooldownProbeSlot(inferredReason))) return {
		type: "skip",
		reason: inferredReason,
		error: `Provider ${params.candidate.provider} is in cooldown (all profiles unavailable)`
	};
	return {
		type: "attempt",
		reason: inferredReason,
		markProbe: params.isPrimary && shouldProbe
	};
}
async function runWithModelFallback(params) {
	const candidates = resolveFallbackCandidates({
		cfg: params.cfg,
		provider: params.provider,
		model: params.model,
		fallbacksOverride: params.fallbacksOverride
	});
	const authRuntime = params.cfg && hasAnyAuthProfileStoreSource(params.agentDir) ? await loadModelFallbackAuthRuntime() : null;
	const authStore = authRuntime ? authRuntime.ensureAuthProfileStore(params.agentDir, { externalCli: externalCliDiscoveryForProviders({
		cfg: params.cfg,
		providers: candidates.map((candidate) => candidate.provider)
	}) }) : null;
	const attempts = [];
	let lastError;
	const cooldownProbeUsedProviders = /* @__PURE__ */ new Set();
	const observeDecision = async (decision) => {
		const fallbackStep = logModelFallbackDecision(decision);
		if (fallbackStep) await params.onFallbackStep?.(fallbackStep);
	};
	const observeFailedCandidate = async (failedAttempt) => {
		const fallbackStep = recordFailedCandidateAttempt(failedAttempt);
		if (fallbackStep) await params.onFallbackStep?.(fallbackStep);
	};
	const hasFallbackCandidates = candidates.length > 1;
	const requestedCandidate = candidates[0];
	for (let i = 0; i < candidates.length; i += 1) {
		const candidate = candidates[i];
		const isPrimary = i === 0;
		const requestedModel = requestedCandidate ? sameModelCandidate(candidate, requestedCandidate) : false;
		let runOptions;
		let attemptedDuringCooldown = false;
		let transientProbeProviderForAttempt = null;
		if (authRuntime && authStore) {
			const profileIds = authRuntime.resolveAuthProfileOrder({
				cfg: params.cfg,
				store: authStore,
				provider: candidate.provider
			});
			const isAnyProfileAvailable = profileIds.some((id) => !authRuntime.isProfileInCooldown(authStore, id, void 0, candidate.model));
			if (profileIds.length > 0 && !isAnyProfileAvailable) {
				const now = Date.now();
				const probeThrottleKey = resolveProbeThrottleKey(candidate.provider, params.agentDir);
				const decision = resolveCooldownDecision({
					candidate,
					isPrimary,
					requestedModel,
					hasFallbackCandidates,
					now,
					probeThrottleKey,
					authRuntime,
					authStore,
					profileIds
				});
				if (decision.type === "skip") {
					attempts.push({
						provider: candidate.provider,
						model: candidate.model,
						error: decision.error,
						reason: decision.reason
					});
					await observeDecision({
						decision: "skip_candidate",
						runId: params.runId,
						sessionId: params.sessionId,
						lane: params.lane,
						requestedProvider: params.provider,
						requestedModel: params.model,
						candidate,
						attempt: i + 1,
						total: candidates.length,
						reason: decision.reason,
						error: decision.error,
						nextCandidate: candidates[i + 1],
						isPrimary,
						requestedModelMatched: requestedModel,
						fallbackConfigured: hasFallbackCandidates,
						profileCount: profileIds.length
					});
					continue;
				}
				if (decision.markProbe) markProbeAttempt(now, probeThrottleKey);
				if (shouldAllowCooldownProbeForReason(decision.reason)) {
					const isTransientCooldownReason = shouldUseTransientCooldownProbeSlot(decision.reason);
					if (isTransientCooldownReason && cooldownProbeUsedProviders.has(candidate.provider)) {
						const error = `Provider ${candidate.provider} is in cooldown (probe already attempted this run)`;
						attempts.push({
							provider: candidate.provider,
							model: candidate.model,
							error,
							reason: decision.reason
						});
						await observeDecision({
							decision: "skip_candidate",
							runId: params.runId,
							sessionId: params.sessionId,
							lane: params.lane,
							requestedProvider: params.provider,
							requestedModel: params.model,
							candidate,
							attempt: i + 1,
							total: candidates.length,
							reason: decision.reason,
							error,
							nextCandidate: candidates[i + 1],
							isPrimary,
							requestedModelMatched: requestedModel,
							fallbackConfigured: hasFallbackCandidates,
							profileCount: profileIds.length
						});
						continue;
					}
					runOptions = { allowTransientCooldownProbe: true };
					if (isTransientCooldownReason) transientProbeProviderForAttempt = candidate.provider;
				}
				attemptedDuringCooldown = true;
				await observeDecision({
					decision: "probe_cooldown_candidate",
					runId: params.runId,
					sessionId: params.sessionId,
					lane: params.lane,
					requestedProvider: params.provider,
					requestedModel: params.model,
					candidate,
					attempt: i + 1,
					total: candidates.length,
					reason: decision.reason,
					nextCandidate: candidates[i + 1],
					isPrimary,
					requestedModelMatched: requestedModel,
					fallbackConfigured: hasFallbackCandidates,
					allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
					profileCount: profileIds.length
				});
			}
		}
		const attemptRun = await runFallbackAttempt({
			run: params.run,
			...candidate,
			attempts,
			options: runOptions,
			classifyResult: params.classifyResult,
			attempt: i + 1,
			total: candidates.length,
			attribution: {
				sessionId: params.sessionId,
				lane: params.lane
			}
		});
		if ("success" in attemptRun) {
			if (i > 0 || attempts.length > 0 || attemptedDuringCooldown) await observeDecision({
				decision: "candidate_succeeded",
				runId: params.runId,
				sessionId: params.sessionId,
				lane: params.lane,
				requestedProvider: params.provider,
				requestedModel: params.model,
				candidate,
				attempt: i + 1,
				total: candidates.length,
				previousAttempts: attempts,
				isPrimary,
				requestedModelMatched: requestedModel,
				fallbackConfigured: hasFallbackCandidates
			});
			const notFoundAttempt = i > 0 ? attempts.find((a) => a.reason === "model_not_found") : void 0;
			if (notFoundAttempt) log.warn(`Model "${sanitizeForLog(notFoundAttempt.provider)}/${sanitizeForLog(notFoundAttempt.model)}" not found. Fell back to "${sanitizeForLog(candidate.provider)}/${sanitizeForLog(candidate.model)}".`);
			return attemptRun.success;
		}
		const err = attemptRun.error;
		{
			if (transientProbeProviderForAttempt) {
				const probeFailureReason = describeFailoverError(err).reason;
				if (!shouldPreserveTransientCooldownProbeSlot(probeFailureReason)) cooldownProbeUsedProviders.add(transientProbeProviderForAttempt);
			}
			if (isLikelyContextOverflowError(formatErrorMessage(err))) throw err;
			const normalized = coerceToFailoverError(err, {
				provider: candidate.provider,
				model: candidate.model,
				sessionId: params.sessionId,
				lane: params.lane
			}) ?? err;
			if (err instanceof LiveSessionModelSwitchError) {
				const liveSwitchTargetIndex = findLiveSessionModelSwitchRedirectIndex({
					error: err,
					candidates,
					currentIndex: i
				});
				if (liveSwitchTargetIndex !== null) {
					i = liveSwitchTargetIndex - 1;
					continue;
				}
				const switchMsg = err.message;
				const switchNormalized = new FailoverError(switchMsg, {
					reason: "unknown",
					provider: candidate.provider,
					model: candidate.model,
					sessionId: params.sessionId,
					lane: params.lane
				});
				lastError = switchNormalized;
				await observeFailedCandidate({
					attempts,
					candidate,
					error: switchNormalized,
					runId: params.runId,
					sessionId: params.sessionId,
					lane: params.lane,
					requestedProvider: params.provider,
					requestedModel: params.model,
					attempt: i + 1,
					total: candidates.length,
					nextCandidate: candidates[i + 1],
					isPrimary,
					requestedModelMatched: requestedModel,
					fallbackConfigured: hasFallbackCandidates
				});
				continue;
			}
			const isKnownFailover = isFailoverError(normalized);
			if (!isKnownFailover && i === candidates.length - 1) throw err;
			lastError = isKnownFailover ? normalized : err;
			await observeFailedCandidate({
				attempts,
				candidate,
				error: normalized,
				runId: params.runId,
				sessionId: params.sessionId,
				lane: params.lane,
				requestedProvider: params.provider,
				requestedModel: params.model,
				attempt: i + 1,
				total: candidates.length,
				nextCandidate: candidates[i + 1],
				isPrimary,
				requestedModelMatched: requestedModel,
				fallbackConfigured: hasFallbackCandidates
			});
			await params.onError?.({
				provider: candidate.provider,
				model: candidate.model,
				error: isKnownFailover ? normalized : err,
				attempt: i + 1,
				total: candidates.length
			});
		}
	}
	return throwFallbackFailureSummary({
		attempts,
		candidates,
		lastError,
		label: "models",
		formatAttempt: (attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}${attempt.reason ? ` (${attempt.reason})` : ""}`,
		soonestCooldownExpiry: resolveFallbackSoonestCooldownExpiry({
			authRuntime,
			authStore,
			agentDir: params.agentDir,
			cfg: params.cfg,
			candidates
		}),
		attribution: {
			sessionId: params.sessionId,
			lane: params.lane
		}
	});
}
async function runWithImageModelFallback(params) {
	const candidates = resolveImageFallbackCandidates({
		cfg: params.cfg,
		defaultProvider: resolveImageFallbackDefaultProvider(params.cfg),
		modelOverride: params.modelOverride
	});
	if (candidates.length === 0) throw new Error("No image model configured. Set agents.defaults.imageModel.primary or agents.defaults.imageModel.fallbacks.");
	const attempts = [];
	let lastError;
	for (let i = 0; i < candidates.length; i += 1) {
		const candidate = candidates[i];
		const attemptRun = await runFallbackAttempt({
			run: params.run,
			...candidate,
			attempts,
			attempt: i + 1,
			total: candidates.length
		});
		if ("success" in attemptRun) return attemptRun.success;
		{
			const err = attemptRun.error;
			lastError = err;
			attempts.push({
				provider: candidate.provider,
				model: candidate.model,
				error: formatErrorMessage(err)
			});
			await params.onError?.({
				provider: candidate.provider,
				model: candidate.model,
				error: err,
				attempt: i + 1,
				total: candidates.length
			});
		}
	}
	return throwFallbackFailureSummary({
		attempts,
		candidates,
		lastError,
		label: "image models",
		formatAttempt: (attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`
	});
}
//#endregion
export { shouldAllowCooldownProbeForReason as a, LiveSessionModelSwitchError as i, runWithImageModelFallback as n, buildApiErrorObservationFields as o, runWithModelFallback as r, buildTextObservationFields as s, isFallbackSummaryError as t };
