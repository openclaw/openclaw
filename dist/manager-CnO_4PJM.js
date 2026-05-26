import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { c as parseAgentSessionKey, n as isAcpSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { l as normalizeAgentId, u as normalizeMainKey } from "./session-key-Bte0mmcq.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { h as resolveRuntimeConfigCacheKey } from "./runtime-snapshot-DgdkBEdP.js";
import { i as resolveMainSessionKey, t as canonicalizeMainSessionAlias } from "./main-session-D3q_5w0B.js";
import { n as resolveRequiredCompletionTerminalResult, r as resolveAgentTimeoutMs } from "./task-completion-contract-D5t-_eBh.js";
import { a as failTaskRunByRunId, i as createRunningTaskRun, n as completeTaskRunByRunId, u as startTaskRunByRunId } from "./detached-task-runtime-C79km_82.js";
import { a as toAcpRuntimeError, n as AcpRuntimeError, o as withAcpRuntimeErrorBoundary, r as formatAcpErrorChain, t as ACP_ERROR_CODES } from "./errors-BgH2aVJW.js";
import { a as identityHasStableSessionId, c as resolveRuntimeHandleIdentifiersFromIdentity, i as identityEquals, l as resolveRuntimeResumeSessionId, n as createIdentityFromHandleEvent, o as isSessionIdentityPending, r as createIdentityFromStatus, s as mergeSessionIdentity, t as createIdentityFromEnsure, u as resolveSessionIdentityFromMeta } from "./session-identity-MDZT82Pf.js";
import { r as requireAcpRuntimeBackend, t as getAcpRuntimeBackend } from "./registry-KuKuvijT.js";
import { i as upsertAcpSessionMeta, n as readAcpSessionEntry, t as listAcpSessionEntries } from "./session-meta-CZ8B2a4Z.js";
import { t as KeyedAsyncQueue } from "./keyed-async-queue-CBv-Vhmc.js";
import { isAbsolute } from "node:path";
//#region src/acp/control-plane/manager.utils.ts
function resolveAcpAgentFromSessionKey(sessionKey, fallback = "main") {
	return normalizeAgentId(parseAgentSessionKey(sessionKey)?.agentId ?? fallback);
}
function resolveMissingMetaError(sessionKey) {
	return new AcpRuntimeError("ACP_SESSION_INIT_FAILED", `ACP metadata is missing for ${sessionKey}. Recreate this ACP session with /acp spawn and rebind the thread.`);
}
function resolveAcpSessionResolutionError(resolution) {
	if (resolution.kind === "ready") return null;
	if (resolution.kind === "stale") return resolution.error;
	return new AcpRuntimeError("ACP_SESSION_INIT_FAILED", `Session is not ACP-enabled: ${resolution.sessionKey}`);
}
function requireReadySessionMeta(resolution) {
	if (resolution.kind === "ready") return resolution.meta;
	throw resolveAcpSessionResolutionError(resolution);
}
function normalizeSessionKey(sessionKey) {
	return sessionKey.trim();
}
function canonicalizeAcpSessionKey(params) {
	const normalized = normalizeSessionKey(params.sessionKey);
	if (!normalized) return "";
	const lowered = normalizeLowercaseStringOrEmpty(normalized);
	if (lowered === "global" || lowered === "unknown") return lowered;
	const parsed = parseAgentSessionKey(lowered);
	if (parsed) return canonicalizeMainSessionAlias({
		cfg: params.cfg,
		agentId: parsed.agentId,
		sessionKey: lowered
	});
	const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
	if (lowered === "main" || lowered === mainKey) return resolveMainSessionKey(params.cfg);
	return lowered;
}
function normalizeActorKey(sessionKey) {
	return normalizeLowercaseStringOrEmpty(sessionKey);
}
function normalizeAcpErrorCode(code) {
	if (!code) return "ACP_TURN_FAILED";
	const normalized = code.trim().toUpperCase();
	for (const allowed of ACP_ERROR_CODES) if (allowed === normalized) return allowed;
	return "ACP_TURN_FAILED";
}
function createUnsupportedControlError(params) {
	return new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", `ACP backend "${params.backend}" does not support ${params.control}.`);
}
function resolveRuntimeIdleTtlMs(cfg) {
	const ttlMinutes = cfg.acp?.runtime?.ttlMinutes;
	if (typeof ttlMinutes !== "number" || !Number.isFinite(ttlMinutes) || ttlMinutes <= 0) return 0;
	return Math.round(ttlMinutes * 60 * 1e3);
}
function hasLegacyAcpIdentityProjection(meta) {
	const raw = meta;
	return Object.hasOwn(raw, "backendSessionId") || Object.hasOwn(raw, "agentSessionId") || Object.hasOwn(raw, "sessionIdsProvisional");
}
//#endregion
//#region src/acp/control-plane/manager.identity-reconcile.ts
async function reconcileManagerRuntimeSessionIdentifiers(params) {
	let runtimeStatus = params.runtimeStatus;
	if (!runtimeStatus && params.runtime.getStatus) try {
		runtimeStatus = await withAcpRuntimeErrorBoundary({
			run: async () => await params.runtime.getStatus({ handle: params.handle }),
			fallbackCode: "ACP_TURN_FAILED",
			fallbackMessage: "Could not read ACP runtime status."
		});
	} catch (error) {
		if (params.failOnStatusError) throw error;
		logVerbose(`acp-manager: failed to refresh ACP runtime status for ${params.sessionKey}: ${String(error)}`);
		return {
			handle: params.handle,
			meta: params.meta,
			runtimeStatus
		};
	}
	const now = Date.now();
	const currentIdentity = resolveSessionIdentityFromMeta(params.meta);
	const identityAfterEvent = mergeSessionIdentity({
		current: currentIdentity,
		incoming: createIdentityFromHandleEvent({
			handle: params.handle,
			now
		}),
		now
	}) ?? currentIdentity;
	const nextIdentity = mergeSessionIdentity({
		current: identityAfterEvent,
		incoming: createIdentityFromStatus({
			status: runtimeStatus,
			now
		}),
		now
	}) ?? identityAfterEvent;
	const handleIdentifiers = resolveRuntimeHandleIdentifiersFromIdentity(nextIdentity);
	const handleChanged = handleIdentifiers.backendSessionId !== params.handle.backendSessionId || handleIdentifiers.agentSessionId !== params.handle.agentSessionId;
	const nextHandle = handleChanged ? {
		...params.handle,
		...handleIdentifiers.backendSessionId ? { backendSessionId: handleIdentifiers.backendSessionId } : {},
		...handleIdentifiers.agentSessionId ? { agentSessionId: handleIdentifiers.agentSessionId } : {}
	} : params.handle;
	if (handleChanged) params.setCachedHandle(params.sessionKey, nextHandle);
	if (!(!identityEquals(currentIdentity, nextIdentity) || hasLegacyAcpIdentityProjection(params.meta))) return {
		handle: nextHandle,
		meta: params.meta,
		runtimeStatus
	};
	const nextMeta = {
		backend: params.meta.backend,
		agent: params.meta.agent,
		runtimeSessionName: params.meta.runtimeSessionName,
		...nextIdentity ? { identity: nextIdentity } : {},
		mode: params.meta.mode,
		...params.meta.runtimeOptions ? { runtimeOptions: params.meta.runtimeOptions } : {},
		...params.meta.cwd ? { cwd: params.meta.cwd } : {},
		lastActivityAt: now,
		state: params.meta.state,
		...params.meta.lastError ? { lastError: params.meta.lastError } : {}
	};
	if (!identityEquals(currentIdentity, nextIdentity)) {
		const currentAgentSessionId = currentIdentity?.agentSessionId ?? "<none>";
		const nextAgentSessionId = nextIdentity?.agentSessionId ?? "<none>";
		const currentAcpxSessionId = currentIdentity?.acpxSessionId ?? "<none>";
		const nextAcpxSessionId = nextIdentity?.acpxSessionId ?? "<none>";
		const currentAcpxRecordId = currentIdentity?.acpxRecordId ?? "<none>";
		const nextAcpxRecordId = nextIdentity?.acpxRecordId ?? "<none>";
		logVerbose(`acp-manager: session identity updated for ${params.sessionKey} (agentSessionId ${currentAgentSessionId} -> ${nextAgentSessionId}, acpxSessionId ${currentAcpxSessionId} -> ${nextAcpxSessionId}, acpxRecordId ${currentAcpxRecordId} -> ${nextAcpxRecordId})`);
	}
	await params.writeSessionMeta({
		cfg: params.cfg,
		sessionKey: params.sessionKey,
		mutate: (current, entry) => {
			if (!entry) return null;
			const base = current ?? entry.acp;
			if (!base) return null;
			return {
				backend: base.backend,
				agent: base.agent,
				runtimeSessionName: base.runtimeSessionName,
				...nextIdentity ? { identity: nextIdentity } : {},
				mode: base.mode,
				...base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {},
				...base.cwd ? { cwd: base.cwd } : {},
				state: base.state,
				lastActivityAt: now,
				...base.lastError ? { lastError: base.lastError } : {}
			};
		}
	});
	return {
		handle: nextHandle,
		meta: nextMeta,
		runtimeStatus
	};
}
//#endregion
//#region src/acp/control-plane/runtime-options.ts
const MAX_RUNTIME_MODE_LENGTH = 64;
const MAX_MODEL_LENGTH = 200;
const MAX_THINKING_LENGTH = 32;
const MAX_PERMISSION_PROFILE_LENGTH = 80;
const MAX_CWD_LENGTH = 4096;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 1440 * 60;
const MAX_BACKEND_OPTION_KEY_LENGTH = 64;
const MAX_BACKEND_OPTION_VALUE_LENGTH = 512;
const MAX_BACKEND_EXTRAS = 32;
const SAFE_OPTION_KEY_RE = /^[a-z0-9][a-z0-9._:-]*$/i;
const RUNTIME_CONFIG_OPTION_ALIASES = {
	model: ["model"],
	thinking: [
		"thinking",
		"effort",
		"reasoning_effort",
		"thought_level"
	],
	permissionProfile: [
		"approval_policy",
		"permission_profile",
		"permissions",
		"permission_mode"
	],
	timeoutSeconds: ["timeout", "timeout_seconds"]
};
function failInvalidOption(message) {
	throw new AcpRuntimeError("ACP_INVALID_RUNTIME_OPTION", message);
}
function validateNoControlChars(value, field) {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code < 32 || code === 127) failInvalidOption(`${field} must not include control characters.`);
	}
	return value;
}
function validateBoundedText(params) {
	const normalized = normalizeOptionalString(params.value);
	if (!normalized) failInvalidOption(`${params.field} must not be empty.`);
	if (normalized.length > params.maxLength) failInvalidOption(`${params.field} must be at most ${params.maxLength} characters.`);
	return validateNoControlChars(normalized, params.field);
}
function validateBackendOptionKey(rawKey) {
	const key = validateBoundedText({
		value: rawKey,
		field: "ACP config key",
		maxLength: MAX_BACKEND_OPTION_KEY_LENGTH
	});
	if (!SAFE_OPTION_KEY_RE.test(key)) failInvalidOption("ACP config key must use letters, numbers, dots, colons, underscores, or dashes.");
	return key;
}
function validateBackendOptionValue(rawValue) {
	return validateBoundedText({
		value: rawValue,
		field: "ACP config value",
		maxLength: MAX_BACKEND_OPTION_VALUE_LENGTH
	});
}
function validateRuntimeModeInput(rawMode) {
	return validateBoundedText({
		value: rawMode,
		field: "Runtime mode",
		maxLength: MAX_RUNTIME_MODE_LENGTH
	});
}
function validateRuntimeModelInput(rawModel) {
	return validateBoundedText({
		value: rawModel,
		field: "Model id",
		maxLength: MAX_MODEL_LENGTH
	});
}
function validateRuntimeThinkingInput(rawThinking) {
	return validateBoundedText({
		value: rawThinking,
		field: "Thinking level",
		maxLength: MAX_THINKING_LENGTH
	});
}
function validateRuntimePermissionProfileInput(rawProfile) {
	return validateBoundedText({
		value: rawProfile,
		field: "Permission profile",
		maxLength: MAX_PERMISSION_PROFILE_LENGTH
	});
}
function validateRuntimeCwdInput(rawCwd) {
	const cwd = validateBoundedText({
		value: rawCwd,
		field: "Working directory",
		maxLength: MAX_CWD_LENGTH
	});
	if (!isAbsolute(cwd)) failInvalidOption(`Working directory must be an absolute path. Received "${cwd}".`);
	return cwd;
}
function validateRuntimeTimeoutSecondsInput(rawTimeout) {
	if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout)) failInvalidOption("Timeout must be a positive integer in seconds.");
	const timeout = Math.round(rawTimeout);
	if (timeout < MIN_TIMEOUT_SECONDS || timeout > MAX_TIMEOUT_SECONDS) failInvalidOption(`Timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds.`);
	return timeout;
}
function parseRuntimeTimeoutSecondsInput(rawTimeout) {
	const normalized = normalizeOptionalString(rawTimeout);
	if (!normalized || !/^\d+$/.test(normalized)) failInvalidOption("Timeout must be a positive integer in seconds.");
	return validateRuntimeTimeoutSecondsInput(Number.parseInt(normalized, 10));
}
function validateRuntimeConfigOptionInput(rawKey, rawValue) {
	return {
		key: validateBackendOptionKey(rawKey),
		value: validateBackendOptionValue(rawValue)
	};
}
function validateRuntimeOptionPatch(patch) {
	if (!patch) return {};
	const rawPatch = patch;
	const allowedKeys = new Set([
		"runtimeMode",
		"model",
		"thinking",
		"cwd",
		"permissionProfile",
		"timeoutSeconds",
		"backendExtras"
	]);
	for (const key of Object.keys(rawPatch)) if (!allowedKeys.has(key)) failInvalidOption(`Unknown runtime option "${key}".`);
	const next = {};
	if (Object.hasOwn(rawPatch, "runtimeMode")) if (rawPatch.runtimeMode === void 0) next.runtimeMode = void 0;
	else next.runtimeMode = validateRuntimeModeInput(rawPatch.runtimeMode);
	if (Object.hasOwn(rawPatch, "model")) if (rawPatch.model === void 0) next.model = void 0;
	else next.model = validateRuntimeModelInput(rawPatch.model);
	if (Object.hasOwn(rawPatch, "thinking")) if (rawPatch.thinking === void 0) next.thinking = void 0;
	else next.thinking = validateRuntimeThinkingInput(rawPatch.thinking);
	if (Object.hasOwn(rawPatch, "cwd")) if (rawPatch.cwd === void 0) next.cwd = void 0;
	else next.cwd = validateRuntimeCwdInput(rawPatch.cwd);
	if (Object.hasOwn(rawPatch, "permissionProfile")) if (rawPatch.permissionProfile === void 0) next.permissionProfile = void 0;
	else next.permissionProfile = validateRuntimePermissionProfileInput(rawPatch.permissionProfile);
	if (Object.hasOwn(rawPatch, "timeoutSeconds")) if (rawPatch.timeoutSeconds === void 0) next.timeoutSeconds = void 0;
	else next.timeoutSeconds = validateRuntimeTimeoutSecondsInput(rawPatch.timeoutSeconds);
	if (Object.hasOwn(rawPatch, "backendExtras")) {
		const rawExtras = rawPatch.backendExtras;
		if (rawExtras === void 0) next.backendExtras = void 0;
		else if (!rawExtras || typeof rawExtras !== "object" || Array.isArray(rawExtras)) failInvalidOption("Backend extras must be a key/value object.");
		else {
			const entries = Object.entries(rawExtras);
			if (entries.length > MAX_BACKEND_EXTRAS) failInvalidOption(`Backend extras must include at most ${MAX_BACKEND_EXTRAS} entries.`);
			const extras = {};
			for (const [entryKey, entryValue] of entries) {
				const { key, value } = validateRuntimeConfigOptionInput(entryKey, entryValue);
				extras[key] = value;
			}
			next.backendExtras = Object.keys(extras).length > 0 ? extras : void 0;
		}
	}
	return next;
}
function normalizeRuntimeOptions(options) {
	const runtimeMode = normalizeOptionalString(options?.runtimeMode);
	const model = normalizeOptionalString(options?.model);
	const thinking = normalizeOptionalString(options?.thinking);
	const cwd = normalizeOptionalString(options?.cwd);
	const permissionProfile = normalizeOptionalString(options?.permissionProfile);
	let timeoutSeconds;
	if (typeof options?.timeoutSeconds === "number" && Number.isFinite(options.timeoutSeconds)) {
		const rounded = Math.round(options.timeoutSeconds);
		if (rounded > 0) timeoutSeconds = rounded;
	}
	const backendExtrasEntries = Object.entries(options?.backendExtras ?? {}).map(([key, value]) => [normalizeOptionalString(key), normalizeOptionalString(value)]).filter(([key, value]) => Boolean(key && value));
	const backendExtras = backendExtrasEntries.length > 0 ? Object.fromEntries(backendExtrasEntries) : void 0;
	return {
		...runtimeMode ? { runtimeMode } : {},
		...model ? { model } : {},
		...thinking ? { thinking } : {},
		...cwd ? { cwd } : {},
		...permissionProfile ? { permissionProfile } : {},
		...typeof timeoutSeconds === "number" ? { timeoutSeconds } : {},
		...backendExtras ? { backendExtras } : {}
	};
}
function mergeRuntimeOptions(params) {
	const current = normalizeRuntimeOptions(params.current);
	const patch = normalizeRuntimeOptions(validateRuntimeOptionPatch(params.patch));
	const mergedExtras = {
		...current.backendExtras,
		...patch.backendExtras
	};
	return normalizeRuntimeOptions({
		...current,
		...patch,
		...Object.keys(mergedExtras).length > 0 ? { backendExtras: mergedExtras } : {}
	});
}
function resolveRuntimeOptionsFromMeta(meta) {
	const normalized = normalizeRuntimeOptions(meta.runtimeOptions);
	if (normalized.cwd || !meta.cwd) return normalized;
	return normalizeRuntimeOptions({
		...normalized,
		cwd: meta.cwd
	});
}
function runtimeOptionsEqual(a, b) {
	return JSON.stringify(normalizeRuntimeOptions(a)) === JSON.stringify(normalizeRuntimeOptions(b));
}
function buildRuntimeControlSignature(options) {
	const normalized = normalizeRuntimeOptions(options);
	const extras = Object.entries(normalized.backendExtras ?? {}).toSorted(([a], [b]) => a.localeCompare(b));
	return JSON.stringify({
		runtimeMode: normalized.runtimeMode ?? null,
		model: normalized.model ?? null,
		thinking: normalized.thinking ?? null,
		permissionProfile: normalized.permissionProfile ?? null,
		timeoutSeconds: normalized.timeoutSeconds ?? null,
		backendExtras: extras
	});
}
function buildRuntimeConfigOptionPairs(options, advertisedConfigOptionKeys) {
	const normalized = normalizeRuntimeOptions(options);
	const pairs = /* @__PURE__ */ new Map();
	if (normalized.model) pairs.set(resolveRuntimeConfigOptionKey("model", advertisedConfigOptionKeys), normalized.model);
	if (normalized.thinking) pairs.set(resolveRuntimeConfigOptionKey("thinking", advertisedConfigOptionKeys), normalized.thinking);
	if (normalized.permissionProfile) pairs.set(resolveRuntimeConfigOptionKey("approval_policy", advertisedConfigOptionKeys), normalized.permissionProfile);
	if (typeof normalized.timeoutSeconds === "number" && shouldEmitTimeoutConfigOption(advertisedConfigOptionKeys)) pairs.set(resolveRuntimeConfigOptionKey("timeout", advertisedConfigOptionKeys), String(normalized.timeoutSeconds));
	for (const [key, value] of Object.entries(normalized.backendExtras ?? {})) {
		const wireKey = resolveRuntimeConfigOptionKey(key, advertisedConfigOptionKeys);
		if (!pairs.has(wireKey)) pairs.set(wireKey, value);
	}
	return [...pairs.entries()];
}
function shouldEmitTimeoutConfigOption(advertisedConfigOptionKeys) {
	const advertisedKeys = buildAdvertisedConfigOptionKeyMap(advertisedConfigOptionKeys);
	return advertisedKeys.size === 0 || RUNTIME_CONFIG_OPTION_ALIASES.timeoutSeconds.some((alias) => advertisedKeys.has(normalizeLowercaseStringOrEmpty(alias)));
}
function buildAdvertisedConfigOptionKeyMap(advertisedConfigOptionKeys) {
	const advertisedKeys = /* @__PURE__ */ new Map();
	for (const rawKey of advertisedConfigOptionKeys ?? []) {
		const key = normalizeOptionalString(rawKey);
		const normalizedKey = normalizeLowercaseStringOrEmpty(key);
		if (key && normalizedKey && !advertisedKeys.has(normalizedKey)) advertisedKeys.set(normalizedKey, key);
	}
	return advertisedKeys;
}
function resolveRuntimeConfigOptionAliases(key) {
	const normalizedKey = normalizeLowercaseStringOrEmpty(key);
	for (const aliases of Object.values(RUNTIME_CONFIG_OPTION_ALIASES)) if (aliases.some((alias) => normalizeLowercaseStringOrEmpty(alias) === normalizedKey)) return aliases;
	return [key];
}
function resolveRuntimeConfigOptionKey(key, advertisedConfigOptionKeys) {
	const normalizedKey = normalizeOptionalString(key) ?? "";
	const normalizedLookupKey = normalizeLowercaseStringOrEmpty(normalizedKey);
	const advertisedKeys = buildAdvertisedConfigOptionKeyMap(advertisedConfigOptionKeys);
	if (!normalizedKey || advertisedKeys.size === 0) return normalizedKey;
	const exactAdvertisedKey = advertisedKeys.get(normalizedLookupKey);
	if (exactAdvertisedKey) return exactAdvertisedKey;
	for (const alias of resolveRuntimeConfigOptionAliases(normalizedKey)) {
		const advertisedAlias = advertisedKeys.get(normalizeLowercaseStringOrEmpty(alias));
		if (advertisedAlias) return advertisedAlias;
	}
	return normalizedKey;
}
function inferRuntimeOptionPatchFromConfigOption(key, value) {
	const validated = validateRuntimeConfigOptionInput(key, value);
	const normalizedKey = normalizeLowercaseStringOrEmpty(validated.key);
	if (normalizedKey === "model") return { model: validateRuntimeModelInput(validated.value) };
	if (normalizedKey === "thinking" || normalizedKey === "effort" || normalizedKey === "thought_level" || normalizedKey === "reasoning_effort") return { thinking: validateRuntimeThinkingInput(validated.value) };
	if (normalizedKey === "approval_policy" || normalizedKey === "permission_profile" || normalizedKey === "permissions" || normalizedKey === "permission_mode") return { permissionProfile: validateRuntimePermissionProfileInput(validated.value) };
	if (normalizedKey === "timeout" || normalizedKey === "timeout_seconds") return { timeoutSeconds: parseRuntimeTimeoutSecondsInput(validated.value) };
	if (normalizedKey === "cwd") return { cwd: validateRuntimeCwdInput(validated.value) };
	return { backendExtras: { [validated.key]: validated.value } };
}
//#endregion
//#region src/acp/control-plane/manager.runtime-controls.ts
const OPTIONAL_TIMEOUT_CONFIG_KEYS = new Set(["timeout", "timeout_seconds"]);
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function extractConfigOptionKeys(value) {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => {
		if (typeof entry === "string") return normalizeOptionalString(entry);
		const record = asRecord(entry);
		return normalizeOptionalString(record?.id ?? record?.key);
	}).filter(Boolean);
}
function extractRuntimeStatusConfigOptionKeys(status) {
	const details = asRecord(status?.details);
	return [...extractConfigOptionKeys(details?.configOptions), ...extractConfigOptionKeys(details?.config_options)];
}
function isOptionalTimeoutConfigKey(key) {
	return OPTIONAL_TIMEOUT_CONFIG_KEYS.has(normalizeLowercaseStringOrEmpty(key));
}
function isUnsupportedOptionalTimeoutConfigRejection(key, error) {
	if (!isOptionalTimeoutConfigKey(key)) return false;
	if ((error && typeof error === "object" ? error.code : null) === "ACP_BACKEND_UNSUPPORTED_CONTROL") return true;
	const normalized = normalizeLowercaseStringOrEmpty(error instanceof Error ? error.message : typeof error === "string" ? error : String(error));
	return normalized.includes("session/set_config_option") && (normalized.includes("-32602") || normalized.includes("invalid params") || normalized.includes("unsupported") || normalized.includes("not supported") || normalized.includes("not implement"));
}
async function resolveManagerRuntimeCapabilities(params) {
	let reported;
	if (params.runtime.getCapabilities) reported = await withAcpRuntimeErrorBoundary({
		run: async () => await params.runtime.getCapabilities({ handle: params.handle }),
		fallbackCode: "ACP_TURN_FAILED",
		fallbackMessage: "Could not read ACP runtime capabilities."
	});
	const controls = new Set(reported?.controls ?? []);
	if (params.runtime.setMode) controls.add("session/set_mode");
	if (params.runtime.setConfigOption) controls.add("session/set_config_option");
	if (params.runtime.getStatus) controls.add("session/status");
	const normalizedKeys = new Set((reported?.configOptionKeys ?? []).map((entry) => normalizeOptionalString(entry)).filter(Boolean));
	if (normalizedKeys.size === 0 && params.includeStatusConfigOptionKeys && params.runtime.getStatus) try {
		const status = await params.runtime.getStatus({ handle: params.handle });
		for (const key of extractRuntimeStatusConfigOptionKeys(status)) normalizedKeys.add(key);
	} catch {}
	return {
		controls: [...controls].toSorted(),
		...normalizedKeys.size > 0 ? { configOptionKeys: [...normalizedKeys] } : {}
	};
}
async function applyManagerRuntimeControls(params) {
	const options = resolveRuntimeOptionsFromMeta(params.meta);
	const signature = buildRuntimeControlSignature(options);
	const cached = params.getCachedRuntimeState(params.sessionKey);
	if (cached?.appliedControlSignature === signature) return;
	const needsConfigOptionKeys = buildRuntimeConfigOptionPairs(options).length > 0;
	const capabilities = await resolveManagerRuntimeCapabilities({
		runtime: params.runtime,
		handle: params.handle,
		includeStatusConfigOptionKeys: needsConfigOptionKeys
	});
	const backend = params.handle.backend || params.meta.backend;
	const runtimeMode = normalizeOptionalString(options.runtimeMode);
	const configOptions = buildRuntimeConfigOptionPairs(options, capabilities.configOptionKeys);
	const advertisedKeys = new Set((capabilities.configOptionKeys ?? []).map((entry) => normalizeLowercaseStringOrEmpty(entry)).filter(Boolean));
	await withAcpRuntimeErrorBoundary({
		run: async () => {
			if (runtimeMode) {
				if (!capabilities.controls.includes("session/set_mode") || !params.runtime.setMode) throw createUnsupportedControlError({
					backend,
					control: "session/set_mode"
				});
				await params.runtime.setMode({
					handle: params.handle,
					mode: runtimeMode
				});
			}
			if (configOptions.length > 0) {
				if (!capabilities.controls.includes("session/set_config_option") || !params.runtime.setConfigOption) throw createUnsupportedControlError({
					backend,
					control: "session/set_config_option"
				});
				for (const [key, value] of configOptions) {
					if (advertisedKeys.size > 0 && !advertisedKeys.has(normalizeLowercaseStringOrEmpty(key))) throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", `ACP backend "${backend}" does not accept config key "${key}".`);
					try {
						await params.runtime.setConfigOption({
							handle: params.handle,
							key,
							value
						});
					} catch (error) {
						if (isUnsupportedOptionalTimeoutConfigRejection(key, error)) continue;
						throw error;
					}
				}
			}
		},
		fallbackCode: "ACP_TURN_FAILED",
		fallbackMessage: "Could not apply ACP runtime options before turn execution."
	});
	if (cached) cached.appliedControlSignature = signature;
}
//#endregion
//#region src/acp/control-plane/manager.turn-stream.ts
async function consumeAcpTurnEvents(params) {
	let streamError = null;
	let sawOutput = false;
	let sawTerminalEvent = false;
	for await (const event of params.events) {
		if (!params.eventGate.open) continue;
		if (event.type === "done") sawTerminalEvent = true;
		else if (event.type === "error") streamError = new AcpRuntimeError(normalizeAcpErrorCode(event.code), normalizeOptionalString(event.message) || "ACP turn failed before completion.");
		else if (event.type === "text_delta" || event.type === "tool_call") {
			sawOutput = true;
			await params.onOutputEvent?.(event);
		}
		await params.onEvent?.(event);
	}
	if (params.eventGate.open && streamError) throw streamError;
	return {
		sawOutput,
		sawTerminalEvent
	};
}
function errorFromTurnResult(result) {
	return new AcpRuntimeError(normalizeAcpErrorCode(result.error.code), normalizeOptionalString(result.error.message) || "ACP turn failed before completion.");
}
function waitForQueuedEvents() {
	return new Promise((resolve) => {
		setTimeout(() => resolve("pending"), 0);
	});
}
async function notifyTerminalResult(params) {
	if (!params.eventGate.open) return;
	if (params.result.status === "completed") {
		await params.onEvent?.({
			type: "done",
			...params.result.stopReason ? { stopReason: params.result.stopReason } : {}
		});
		return;
	}
	if (params.result.status === "cancelled") {
		await params.onEvent?.({
			type: "done",
			...params.result.stopReason ? { stopReason: params.result.stopReason } : {}
		});
		return;
	}
	await params.onEvent?.({
		type: "error",
		code: normalizeAcpErrorCode(params.result.error.code),
		...params.result.error.detailCode ? { detailCode: params.result.error.detailCode } : {},
		message: normalizeOptionalString(params.result.error.message) || "ACP turn failed before completion.",
		...params.result.error.retryable === void 0 ? {} : { retryable: params.result.error.retryable }
	});
}
async function consumeAcpTurnStream(params) {
	if (params.runtime.startTurn) {
		const turn = params.runtime.startTurn(params.turn);
		const eventsPromise = consumeAcpTurnEvents({
			events: turn.events,
			eventGate: params.eventGate,
			onEvent: params.onEvent,
			onOutputEvent: params.onOutputEvent
		}).then((outcome) => ({
			kind: "events",
			outcome
		}), (error) => ({
			kind: "event-error",
			error
		}));
		const resultPromise = turn.result.then((result) => ({
			kind: "result",
			result
		}), (error) => ({
			kind: "result-error",
			error
		}));
		let eventOutcome = null;
		let result = null;
		const firstOutcome = await Promise.race([eventsPromise, resultPromise]);
		if (firstOutcome.kind === "event-error") {
			await turn.closeStream({ reason: "turn-events-error" }).catch(() => {});
			throw firstOutcome.error;
		}
		if (firstOutcome.kind === "events") eventOutcome = firstOutcome.outcome;
		else if (firstOutcome.kind === "result-error") {
			await turn.closeStream({ reason: "turn-result-error" }).catch(() => {});
			throw firstOutcome.error;
		} else result = firstOutcome.result;
		if (!result) {
			const terminalOutcome = await resultPromise;
			if (terminalOutcome.kind === "result-error") {
				await turn.closeStream({ reason: "turn-result-error" }).catch(() => {});
				throw terminalOutcome.error;
			}
			result = terminalOutcome.result;
		}
		let closedTerminalStream = false;
		if (!eventOutcome) {
			let eventsOutcome = await Promise.race([eventsPromise, waitForQueuedEvents()]);
			if (eventsOutcome === "pending") {
				await turn.closeStream({ reason: `turn-result-${result.status}` }).catch(() => {});
				closedTerminalStream = true;
				eventsOutcome = await eventsPromise;
			}
			if (eventsOutcome.kind === "event-error") throw eventsOutcome.error;
			eventOutcome = eventsOutcome.outcome;
		}
		if (result.status !== "completed" && !closedTerminalStream) await turn.closeStream({ reason: `turn-result-${result.status}` }).catch(() => {});
		await notifyTerminalResult({
			result,
			eventGate: params.eventGate,
			onEvent: params.onEvent
		});
		if (result.status === "failed") throw errorFromTurnResult(result);
		return {
			sawOutput: eventOutcome.sawOutput,
			sawTerminalEvent: true
		};
	}
	return await consumeAcpTurnEvents({
		events: params.runtime.runTurn(params.turn),
		eventGate: params.eventGate,
		onEvent: params.onEvent,
		onOutputEvent: params.onOutputEvent
	});
}
//#endregion
//#region src/acp/control-plane/manager.types.ts
const DEFAULT_DEPS = {
	listAcpSessions: listAcpSessionEntries,
	readSessionEntry: readAcpSessionEntry,
	upsertSessionMeta: upsertAcpSessionMeta,
	getRuntimeBackend: getAcpRuntimeBackend,
	requireRuntimeBackend: requireAcpRuntimeBackend
};
//#endregion
//#region src/acp/control-plane/runtime-cache.ts
var RuntimeCache = class {
	constructor() {
		this.cache = /* @__PURE__ */ new Map();
	}
	size() {
		return this.cache.size;
	}
	has(actorKey) {
		return this.cache.has(actorKey);
	}
	get(actorKey, params = {}) {
		const entry = this.cache.get(actorKey);
		if (!entry) return null;
		if (params.touch !== false) entry.lastTouchedAt = params.now ?? Date.now();
		return entry.state;
	}
	peek(actorKey) {
		return this.get(actorKey, { touch: false });
	}
	getLastTouchedAt(actorKey) {
		return this.cache.get(actorKey)?.lastTouchedAt ?? null;
	}
	set(actorKey, state, params = {}) {
		this.cache.set(actorKey, {
			state,
			lastTouchedAt: params.now ?? Date.now()
		});
	}
	clear(actorKey) {
		this.cache.delete(actorKey);
	}
	snapshot(params = {}) {
		const now = params.now ?? Date.now();
		const entries = [];
		for (const [actorKey, entry] of this.cache.entries()) entries.push({
			actorKey,
			state: entry.state,
			lastTouchedAt: entry.lastTouchedAt,
			idleMs: Math.max(0, now - entry.lastTouchedAt)
		});
		return entries;
	}
	collectIdleCandidates(params) {
		if (!Number.isFinite(params.maxIdleMs) || params.maxIdleMs <= 0) return [];
		const now = params.now ?? Date.now();
		return this.snapshot({ now }).filter((entry) => entry.idleMs >= params.maxIdleMs);
	}
};
//#endregion
//#region src/acp/control-plane/session-actor-queue.ts
var SessionActorQueue = class {
	constructor() {
		this.queue = new KeyedAsyncQueue();
		this.pendingBySession = /* @__PURE__ */ new Map();
	}
	getTailMapForTesting() {
		return this.queue.getTailMapForTesting();
	}
	getTotalPendingCount() {
		let total = 0;
		for (const count of this.pendingBySession.values()) total += count;
		return total;
	}
	getPendingCountForSession(actorKey) {
		return this.pendingBySession.get(actorKey) ?? 0;
	}
	async run(actorKey, op) {
		return this.queue.enqueue(actorKey, op, {
			onEnqueue: () => {
				this.pendingBySession.set(actorKey, (this.pendingBySession.get(actorKey) ?? 0) + 1);
			},
			onSettle: () => {
				const pending = (this.pendingBySession.get(actorKey) ?? 1) - 1;
				if (pending <= 0) this.pendingBySession.delete(actorKey);
				else this.pendingBySession.set(actorKey, pending);
			}
		});
	}
};
//#endregion
//#region src/acp/control-plane/manager.core.ts
const ACP_TURN_TIMEOUT_GRACE_MS = 1e3;
const ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS = 2e3;
const ACP_TURN_TIMEOUT_REASON = "turn-timeout";
const ACP_BACKGROUND_TASK_TEXT_MAX_LENGTH = 160;
const ACP_BACKGROUND_TASK_PROGRESS_MAX_LENGTH = 240;
function summarizeBackgroundTaskText(text) {
	const normalized = normalizeOptionalString(text) ?? "ACP background task";
	if (normalized.length <= ACP_BACKGROUND_TASK_TEXT_MAX_LENGTH) return normalized;
	return `${normalized.slice(0, ACP_BACKGROUND_TASK_TEXT_MAX_LENGTH - 1)}…`;
}
function appendBackgroundTaskProgressSummary(current, chunk) {
	const normalizedChunk = chunk.replace(/\s+/g, " ");
	if (!normalizedChunk) return current;
	const chunkToAppend = current ? normalizedChunk : normalizedChunk.trimStart();
	if (!chunkToAppend) return current;
	const combined = `${current}${chunkToAppend}`.replace(/\s+/g, " ");
	if (combined.length <= ACP_BACKGROUND_TASK_PROGRESS_MAX_LENGTH) return combined;
	return `${combined.slice(0, ACP_BACKGROUND_TASK_PROGRESS_MAX_LENGTH - 1)}…`;
}
function resolveBackgroundTaskFailureStatus(error) {
	return /\btimed out\b/i.test(error.message) ? "timed_out" : "failed";
}
function resolveBackgroundTaskTerminalResult(progressSummary) {
	const requiredCompletionResult = resolveRequiredCompletionTerminalResult(progressSummary);
	if (requiredCompletionResult.terminalOutcome) return requiredCompletionResult;
	const normalized = normalizeOptionalString(progressSummary)?.replace(/\s+/g, " ").trim();
	if (!normalized) return {};
	const permissionDeniedMatch = normalized.match(/\b(?:write failed:\s*)?permission denied(?: for (?<path>\S+))?\.?/i);
	if (permissionDeniedMatch) {
		const path = normalizeOptionalString(permissionDeniedMatch.groups?.path)?.replace(/[.,;:!?]+$/, "");
		return {
			terminalOutcome: "blocked",
			terminalSummary: path ? `Permission denied for ${path}.` : "Permission denied."
		};
	}
	if (/\bneed a writable session\b/i.test(normalized) || /\bfilesystem authorization\b/i.test(normalized) || /`?apply_patch`?/i.test(normalized)) return {
		terminalOutcome: "blocked",
		terminalSummary: "Writable session or apply_patch authorization required."
	};
	return {};
}
var AcpSessionManager = class {
	constructor(deps = DEFAULT_DEPS) {
		this.deps = deps;
		this.actorQueue = new SessionActorQueue();
		this.runtimeCache = new RuntimeCache();
		this.activeTurnBySession = /* @__PURE__ */ new Map();
		this.turnLatencyStats = {
			completed: 0,
			failed: 0,
			totalMs: 0,
			maxMs: 0
		};
		this.errorCountsByCode = /* @__PURE__ */ new Map();
		this.evictedRuntimeCount = 0;
	}
	resolveSession(params) {
		const sessionKey = canonicalizeAcpSessionKey(params);
		if (!sessionKey) return {
			kind: "none",
			sessionKey
		};
		const acp = this.deps.readSessionEntry({
			cfg: params.cfg,
			sessionKey
		})?.acp;
		if (acp) return {
			kind: "ready",
			sessionKey,
			meta: acp
		};
		if (isAcpSessionKey(sessionKey)) return {
			kind: "stale",
			sessionKey,
			error: resolveMissingMetaError(sessionKey)
		};
		return {
			kind: "none",
			sessionKey
		};
	}
	getObservabilitySnapshot(cfg) {
		const completedTurns = this.turnLatencyStats.completed + this.turnLatencyStats.failed;
		const averageLatencyMs = completedTurns > 0 ? Math.round(this.turnLatencyStats.totalMs / completedTurns) : 0;
		return {
			runtimeCache: {
				activeSessions: this.runtimeCache.size(),
				idleTtlMs: resolveRuntimeIdleTtlMs(cfg),
				evictedTotal: this.evictedRuntimeCount,
				...this.lastEvictedAt ? { lastEvictedAt: this.lastEvictedAt } : {}
			},
			turns: {
				active: this.activeTurnBySession.size,
				queueDepth: this.actorQueue.getTotalPendingCount(),
				completed: this.turnLatencyStats.completed,
				failed: this.turnLatencyStats.failed,
				averageLatencyMs,
				maxLatencyMs: this.turnLatencyStats.maxMs
			},
			errorsByCode: Object.fromEntries([...this.errorCountsByCode.entries()].toSorted(([a], [b]) => a.localeCompare(b)))
		};
	}
	async reconcilePendingSessionIdentities(params) {
		let checked = 0;
		let resolved = 0;
		let failed = 0;
		let acpSessions;
		try {
			acpSessions = await this.deps.listAcpSessions({ cfg: params.cfg });
		} catch (error) {
			logVerbose(`acp-manager: startup identity scan failed: ${String(error)}`);
			return {
				checked,
				resolved,
				failed: failed + 1
			};
		}
		for (const session of acpSessions) {
			if (!session.acp || !session.sessionKey) continue;
			const currentIdentity = resolveSessionIdentityFromMeta(session.acp);
			if (!isSessionIdentityPending(currentIdentity) || !identityHasStableSessionId(currentIdentity)) continue;
			checked += 1;
			try {
				if (await this.withSessionActor(session.sessionKey, async () => {
					const resolution = this.resolveSession({
						cfg: params.cfg,
						sessionKey: session.sessionKey
					});
					if (resolution.kind !== "ready") return false;
					const { runtime, handle, meta } = await this.ensureRuntimeHandle({
						cfg: params.cfg,
						sessionKey: session.sessionKey,
						meta: resolution.meta
					});
					return !isSessionIdentityPending(resolveSessionIdentityFromMeta((await this.reconcileRuntimeSessionIdentifiers({
						cfg: params.cfg,
						sessionKey: session.sessionKey,
						runtime,
						handle,
						meta,
						failOnStatusError: false
					})).meta));
				})) resolved += 1;
			} catch (error) {
				failed += 1;
				logVerbose(`acp-manager: startup identity reconcile failed for ${session.sessionKey}: ${String(error)}`);
			}
		}
		return {
			checked,
			resolved,
			failed
		};
	}
	async initializeSession(input) {
		const sessionKey = canonicalizeAcpSessionKey({
			cfg: input.cfg,
			sessionKey: input.sessionKey
		});
		if (!sessionKey) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
		const agent = normalizeAgentId(input.agent);
		await this.evictIdleRuntimeHandles({ cfg: input.cfg });
		return await this.withSessionActor(sessionKey, async () => {
			const backend = this.deps.requireRuntimeBackend(input.backendId || input.cfg.acp?.backend);
			const runtime = backend.runtime;
			const initialRuntimeOptions = validateRuntimeOptionPatch({
				...input.runtimeOptions,
				...input.cwd !== void 0 ? { cwd: input.cwd } : {}
			});
			const requestedCwd = initialRuntimeOptions.cwd;
			const requestedModel = initialRuntimeOptions.model;
			const requestedThinking = initialRuntimeOptions.thinking;
			this.enforceConcurrentSessionLimit({
				cfg: input.cfg,
				sessionKey
			});
			const handle = await withAcpRuntimeErrorBoundary({
				run: async () => await runtime.ensureSession({
					sessionKey,
					agent,
					mode: input.mode,
					resumeSessionId: input.resumeSessionId,
					...requestedModel ? { model: requestedModel } : {},
					...requestedThinking ? { thinking: requestedThinking } : {},
					cwd: requestedCwd
				}),
				fallbackCode: "ACP_SESSION_INIT_FAILED",
				fallbackMessage: "Could not initialize ACP session runtime."
			});
			const effectiveCwd = normalizeOptionalString(handle.cwd) ?? requestedCwd;
			const effectiveRuntimeOptions = normalizeRuntimeOptions({
				...initialRuntimeOptions,
				...effectiveCwd ? { cwd: effectiveCwd } : {}
			});
			const identityNow = Date.now();
			const initializedIdentity = mergeSessionIdentity({
				current: void 0,
				incoming: createIdentityFromEnsure({
					handle,
					now: identityNow
				}),
				now: identityNow
			}) ?? {
				state: "pending",
				source: "ensure",
				lastUpdatedAt: identityNow
			};
			const meta = {
				backend: handle.backend || backend.id,
				agent,
				runtimeSessionName: handle.runtimeSessionName,
				identity: initializedIdentity,
				mode: input.mode,
				...Object.keys(effectiveRuntimeOptions).length > 0 ? { runtimeOptions: effectiveRuntimeOptions } : {},
				cwd: effectiveCwd,
				state: "idle",
				lastActivityAt: Date.now()
			};
			let persisted = null;
			try {
				persisted = await this.writeSessionMeta({
					cfg: input.cfg,
					sessionKey,
					mutate: () => meta,
					failOnError: true
				});
			} catch (error) {
				await runtime.close({
					handle,
					reason: "init-meta-failed"
				}).catch((closeError) => {
					logVerbose(`acp-manager: cleanup close failed after metadata write error for ${sessionKey}: ${String(closeError)}`);
				});
				throw error;
			}
			if (!persisted?.acp) {
				await runtime.close({
					handle,
					reason: "init-meta-failed"
				}).catch((closeError) => {
					logVerbose(`acp-manager: cleanup close failed after metadata write error for ${sessionKey}: ${String(closeError)}`);
				});
				throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", `Could not persist ACP metadata for ${sessionKey}.`);
			}
			this.setCachedRuntimeState(sessionKey, {
				runtime,
				handle,
				backend: handle.backend || backend.id,
				agent,
				mode: input.mode,
				cwd: effectiveCwd,
				configSignature: resolveRuntimeConfigCacheKey(input.cfg)
			});
			return {
				runtime,
				handle,
				meta
			};
		});
	}
	async getSessionStatus(params) {
		const sessionKey = canonicalizeAcpSessionKey(params);
		if (!sessionKey) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
		this.throwIfAborted(params.signal);
		await this.evictIdleRuntimeHandles({ cfg: params.cfg });
		return await this.withSessionActor(sessionKey, async () => {
			this.throwIfAborted(params.signal);
			const resolvedMeta = requireReadySessionMeta(this.resolveSession({
				cfg: params.cfg,
				sessionKey
			}));
			const { runtime, handle: ensuredHandle, meta: ensuredMeta } = await this.ensureRuntimeHandle({
				cfg: params.cfg,
				sessionKey,
				meta: resolvedMeta
			});
			let handle = ensuredHandle;
			let meta = ensuredMeta;
			const capabilities = await this.resolveRuntimeCapabilities({
				runtime,
				handle
			});
			let runtimeStatus;
			if (runtime.getStatus) runtimeStatus = await withAcpRuntimeErrorBoundary({
				run: async () => {
					this.throwIfAborted(params.signal);
					const status = await runtime.getStatus({
						handle,
						...params.signal ? { signal: params.signal } : {}
					});
					this.throwIfAborted(params.signal);
					return status;
				},
				fallbackCode: "ACP_TURN_FAILED",
				fallbackMessage: "Could not read ACP runtime status."
			});
			({handle, meta, runtimeStatus} = await this.reconcileRuntimeSessionIdentifiers({
				cfg: params.cfg,
				sessionKey,
				runtime,
				handle,
				meta,
				runtimeStatus,
				failOnStatusError: true
			}));
			const identity = resolveSessionIdentityFromMeta(meta);
			return {
				sessionKey,
				backend: handle.backend || meta.backend,
				agent: meta.agent,
				...identity ? { identity } : {},
				state: meta.state,
				mode: meta.mode,
				runtimeOptions: resolveRuntimeOptionsFromMeta(meta),
				capabilities,
				runtimeStatus,
				lastActivityAt: meta.lastActivityAt,
				lastError: meta.lastError
			};
		}, params.signal);
	}
	async setSessionRuntimeMode(params) {
		const sessionKey = canonicalizeAcpSessionKey(params);
		if (!sessionKey) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
		const runtimeMode = validateRuntimeModeInput(params.runtimeMode);
		await this.evictIdleRuntimeHandles({ cfg: params.cfg });
		return await this.withSessionActor(sessionKey, async () => {
			const resolvedMeta = requireReadySessionMeta(this.resolveSession({
				cfg: params.cfg,
				sessionKey
			}));
			const { runtime, handle, meta } = await this.ensureRuntimeHandle({
				cfg: params.cfg,
				sessionKey,
				meta: resolvedMeta
			});
			if (!(await this.resolveRuntimeCapabilities({
				runtime,
				handle
			})).controls.includes("session/set_mode") || !runtime.setMode) throw createUnsupportedControlError({
				backend: handle.backend || meta.backend,
				control: "session/set_mode"
			});
			await withAcpRuntimeErrorBoundary({
				run: async () => await runtime.setMode({
					handle,
					mode: runtimeMode
				}),
				fallbackCode: "ACP_TURN_FAILED",
				fallbackMessage: "Could not update ACP runtime mode."
			});
			const nextOptions = mergeRuntimeOptions({
				current: resolveRuntimeOptionsFromMeta(meta),
				patch: { runtimeMode }
			});
			await this.persistRuntimeOptions({
				cfg: params.cfg,
				sessionKey,
				options: nextOptions
			});
			return nextOptions;
		});
	}
	async setSessionConfigOption(params) {
		const sessionKey = canonicalizeAcpSessionKey(params);
		if (!sessionKey) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
		const normalizedOption = validateRuntimeConfigOptionInput(params.key, params.value);
		const key = normalizedOption.key;
		const value = normalizedOption.value;
		await this.evictIdleRuntimeHandles({ cfg: params.cfg });
		return await this.withSessionActor(sessionKey, async () => {
			const resolvedMeta = requireReadySessionMeta(this.resolveSession({
				cfg: params.cfg,
				sessionKey
			}));
			const { runtime, handle, meta } = await this.ensureRuntimeHandle({
				cfg: params.cfg,
				sessionKey,
				meta: resolvedMeta
			});
			const inferredPatch = inferRuntimeOptionPatchFromConfigOption(key, value);
			const capabilities = await this.resolveRuntimeCapabilities({
				runtime,
				handle,
				includeStatusConfigOptionKeys: true
			});
			if (!capabilities.controls.includes("session/set_config_option") || !runtime.setConfigOption) throw createUnsupportedControlError({
				backend: handle.backend || meta.backend,
				control: "session/set_config_option"
			});
			const advertisedKeys = new Set((capabilities.configOptionKeys ?? []).map((entry) => normalizeLowercaseStringOrEmpty(entry)).filter(Boolean));
			const wireKey = resolveRuntimeConfigOptionKey(key, capabilities.configOptionKeys);
			if (advertisedKeys.size > 0 && !advertisedKeys.has(normalizeLowercaseStringOrEmpty(wireKey))) throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", `ACP backend "${handle.backend || meta.backend}" does not accept config key "${wireKey}".`);
			await withAcpRuntimeErrorBoundary({
				run: async () => await runtime.setConfigOption({
					handle,
					key: wireKey,
					value
				}),
				fallbackCode: "ACP_TURN_FAILED",
				fallbackMessage: "Could not update ACP runtime config option."
			});
			const nextOptions = mergeRuntimeOptions({
				current: resolveRuntimeOptionsFromMeta(meta),
				patch: inferredPatch
			});
			await this.persistRuntimeOptions({
				cfg: params.cfg,
				sessionKey,
				options: nextOptions
			});
			return nextOptions;
		});
	}
	async updateSessionRuntimeOptions(params) {
		const sessionKey = canonicalizeAcpSessionKey(params);
		const validatedPatch = validateRuntimeOptionPatch(params.patch);
		if (!sessionKey) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
		await this.evictIdleRuntimeHandles({ cfg: params.cfg });
		return await this.withSessionActor(sessionKey, async () => {
			const nextOptions = mergeRuntimeOptions({
				current: resolveRuntimeOptionsFromMeta(requireReadySessionMeta(this.resolveSession({
					cfg: params.cfg,
					sessionKey
				}))),
				patch: validatedPatch
			});
			await this.persistRuntimeOptions({
				cfg: params.cfg,
				sessionKey,
				options: nextOptions
			});
			return nextOptions;
		});
	}
	async resetSessionRuntimeOptions(params) {
		const sessionKey = canonicalizeAcpSessionKey(params);
		if (!sessionKey) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
		await this.evictIdleRuntimeHandles({ cfg: params.cfg });
		return await this.withSessionActor(sessionKey, async () => {
			const resolvedMeta = requireReadySessionMeta(this.resolveSession({
				cfg: params.cfg,
				sessionKey
			}));
			const { runtime, handle } = await this.ensureRuntimeHandle({
				cfg: params.cfg,
				sessionKey,
				meta: resolvedMeta
			});
			await withAcpRuntimeErrorBoundary({
				run: async () => await runtime.close({
					handle,
					reason: "reset-runtime-options"
				}),
				fallbackCode: "ACP_TURN_FAILED",
				fallbackMessage: "Could not reset ACP runtime options."
			});
			this.clearCachedRuntimeState(sessionKey);
			await this.persistRuntimeOptions({
				cfg: params.cfg,
				sessionKey,
				options: {}
			});
			return {};
		});
	}
	async runTurn(input) {
		const sessionKey = canonicalizeAcpSessionKey({
			cfg: input.cfg,
			sessionKey: input.sessionKey
		});
		if (!sessionKey) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
		await this.evictIdleRuntimeHandles({ cfg: input.cfg });
		await this.withSessionActor(sessionKey, async () => {
			const turnStartedAt = Date.now();
			const actorKey = normalizeActorKey(sessionKey);
			const taskContext = input.mode === "prompt" ? this.resolveBackgroundTaskContext({
				cfg: input.cfg,
				sessionKey,
				requestId: input.requestId,
				text: input.text
			}) : null;
			if (taskContext) this.createBackgroundTaskRecord(taskContext, turnStartedAt);
			let taskProgressSummary = "";
			const initialResolution = this.resolveSession({
				cfg: input.cfg,
				sessionKey
			});
			const initialMeta = requireReadySessionMeta(initialResolution);
			const configuredPrimaryBackend = normalizeOptionalString(input.cfg.acp?.backend);
			const resolvedPrimaryBackend = normalizeOptionalString(initialMeta.backend);
			const fallbackBackends = Array.isArray(input.cfg.acp?.fallbacks) ? input.cfg.acp.fallbacks.map((backend) => normalizeOptionalString(backend)).filter((backend) => backend != null) : [];
			const candidateBackends = Array.from(new Set([configuredPrimaryBackend ?? resolvedPrimaryBackend ?? "", ...fallbackBackends]));
			const describeBackendCandidate = (backend) => backend || resolvedPrimaryBackend || configuredPrimaryBackend || "<auto>";
			const backendAttempts = [];
			const isFailoverWorthyBackendError = (attempt) => !attempt.sawOutput && (attempt.code === "ACP_TURN_FAILED" || attempt.code === "ACP_SESSION_INIT_FAILED" || attempt.code === "ACP_BACKEND_UNAVAILABLE") && /\b(?:unavailable|rate[-\s]?limit(?:ed|ing)?|quota|exhausted|temporar(?:y|ily)|overloaded)\b/i.test(attempt.error);
			const recordBackendFailure = async (error) => {
				const failedBackends = backendAttempts.map((attempt) => `${attempt.backend}: ${attempt.error}`).join(" | ");
				const errorToRecord = backendAttempts.length > 1 ? new AcpRuntimeError(error.code, `All ACP backends failed (${backendAttempts.length}): ${failedBackends}`) : error;
				this.recordTurnCompletion({
					startedAt: turnStartedAt,
					errorCode: errorToRecord.code
				});
				if (taskContext) this.markBackgroundTaskTerminal(taskContext.runId, {
					sessionKey,
					status: resolveBackgroundTaskFailureStatus(errorToRecord),
					endedAt: Date.now(),
					lastEventAt: Date.now(),
					error: formatAcpErrorChain(errorToRecord),
					progressSummary: taskProgressSummary || null,
					terminalSummary: null
				});
				await this.setSessionState({
					cfg: input.cfg,
					sessionKey,
					state: "error",
					lastError: formatAcpErrorChain(errorToRecord)
				});
				throw errorToRecord;
			};
			const shouldAttemptFailover = (backendIdx) => backendIdx < candidateBackends.length - 1;
			for (let backendIdx = 0; backendIdx < candidateBackends.length; backendIdx += 1) {
				const currentBackend = candidateBackends[backendIdx];
				if (backendIdx > 0) {
					await this.closeCachedRuntimeState({
						sessionKey,
						reason: "backend-failover"
					});
					logVerbose(`acp-manager: switching backend for ${sessionKey} from ${describeBackendCandidate(candidateBackends[backendIdx - 1])} to ${describeBackendCandidate(currentBackend)}`);
				}
				for (let attempt = 0; attempt < 2; attempt += 1) {
					const resolvedMeta = requireReadySessionMeta(backendIdx === 0 && attempt === 0 ? initialResolution : this.resolveSession({
						cfg: input.cfg,
						sessionKey
					}));
					const metaWithBackend = currentBackend ? {
						...resolvedMeta,
						backend: currentBackend
					} : resolvedMeta;
					let runtime;
					let handle;
					let meta;
					let activeTurn;
					let internalAbortController;
					let onCallerAbort;
					let activeTurnStarted = false;
					let sawTurnOutput = false;
					let retryFreshHandle = false;
					let skipPostTurnCleanup = false;
					try {
						const ensured = await this.ensureRuntimeHandle({
							cfg: input.cfg,
							sessionKey,
							meta: metaWithBackend
						});
						runtime = ensured.runtime;
						handle = ensured.handle;
						meta = ensured.meta;
						await this.applyRuntimeControls({
							sessionKey,
							runtime,
							handle,
							meta
						});
						await this.setSessionState({
							cfg: input.cfg,
							sessionKey,
							state: "running",
							clearLastError: true
						});
						internalAbortController = new AbortController();
						onCallerAbort = () => {
							internalAbortController?.abort();
						};
						if (input.signal?.aborted) internalAbortController.abort();
						else if (input.signal) input.signal.addEventListener("abort", onCallerAbort, { once: true });
						activeTurn = {
							runtime,
							handle,
							abortController: internalAbortController
						};
						this.activeTurnBySession.set(actorKey, activeTurn);
						activeTurnStarted = true;
						const combinedSignal = input.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([input.signal, internalAbortController.signal]) : internalAbortController.signal;
						const eventGate = { open: true };
						await input.onLifecycle?.({
							type: "prompt_submitted",
							at: Date.now()
						});
						const turnPromise = consumeAcpTurnStream({
							runtime,
							turn: {
								handle,
								text: input.text,
								attachments: input.attachments,
								mode: input.mode,
								requestId: input.requestId,
								signal: combinedSignal
							},
							eventGate,
							onOutputEvent: (event) => {
								sawTurnOutput = true;
								if (event.type === "text_delta" && event.stream !== "thought" && event.text) taskProgressSummary = appendBackgroundTaskProgressSummary(taskProgressSummary, event.text);
								if (taskContext) this.markBackgroundTaskRunning(taskContext.runId, {
									sessionKey,
									lastEventAt: Date.now(),
									progressSummary: taskProgressSummary || null
								});
							},
							onEvent: input.onEvent
						});
						const turnTimeoutMs = this.resolveTurnTimeoutMs({
							cfg: input.cfg,
							meta
						});
						const sessionMode = meta.mode;
						if (!(await this.awaitTurnWithTimeout({
							sessionKey,
							turnPromise,
							timeoutMs: turnTimeoutMs + ACP_TURN_TIMEOUT_GRACE_MS,
							timeoutLabelMs: turnTimeoutMs,
							onTimeout: async () => {
								eventGate.open = false;
								skipPostTurnCleanup = true;
								if (!activeTurn) return;
								await this.cleanupTimedOutTurn({
									sessionKey,
									activeTurn,
									mode: sessionMode
								});
							}
						})).sawTerminalEvent) throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP turn ended without a terminal done event.");
						this.recordTurnCompletion({ startedAt: turnStartedAt });
						if (taskContext) {
							const terminalResult = resolveBackgroundTaskTerminalResult(taskProgressSummary);
							this.markBackgroundTaskTerminal(taskContext.runId, {
								sessionKey,
								status: "succeeded",
								endedAt: Date.now(),
								lastEventAt: Date.now(),
								error: void 0,
								progressSummary: taskProgressSummary || null,
								terminalSummary: terminalResult.terminalSummary ?? null,
								terminalOutcome: terminalResult.terminalOutcome
							});
						}
						await this.setSessionState({
							cfg: input.cfg,
							sessionKey,
							state: "idle",
							clearLastError: true
						});
						return;
					} catch (error) {
						const acpError = toAcpRuntimeError({
							error,
							fallbackCode: activeTurnStarted ? "ACP_TURN_FAILED" : "ACP_SESSION_INIT_FAILED",
							fallbackMessage: activeTurnStarted ? "ACP turn failed before completion." : "Could not initialize ACP session runtime."
						});
						retryFreshHandle = await this.prepareFreshHandleRetry({
							attempt,
							cfg: input.cfg,
							sessionKey,
							error: acpError,
							sawTurnOutput,
							runtime,
							meta
						});
						if (retryFreshHandle) continue;
						const backendAttempt = {
							backend: describeBackendCandidate(currentBackend),
							error: acpError.message,
							code: acpError.code,
							sawOutput: sawTurnOutput
						};
						backendAttempts.push(backendAttempt);
						if (!isFailoverWorthyBackendError(backendAttempt) || !shouldAttemptFailover(backendIdx)) await recordBackendFailure(acpError);
						break;
					} finally {
						if (input.signal && onCallerAbort) input.signal.removeEventListener("abort", onCallerAbort);
						if (activeTurn && this.activeTurnBySession.get(actorKey) === activeTurn) this.activeTurnBySession.delete(actorKey);
						if (!retryFreshHandle && !skipPostTurnCleanup && runtime && handle && meta) ({handle, meta} = await this.reconcileRuntimeSessionIdentifiers({
							cfg: input.cfg,
							sessionKey,
							runtime,
							handle,
							meta,
							failOnStatusError: false
						}));
						if (!retryFreshHandle && !skipPostTurnCleanup && runtime && handle && meta && meta.mode === "oneshot") try {
							await runtime.close({
								handle,
								reason: "oneshot-complete"
							});
						} catch (error) {
							logVerbose(`acp-manager: ACP oneshot close failed for ${sessionKey}: ${String(error)}`);
						} finally {
							this.clearCachedRuntimeState(sessionKey);
						}
					}
					if (retryFreshHandle) continue;
				}
			}
		}, input.signal);
	}
	resolveTurnTimeoutMs(params) {
		const runtimeTimeoutSeconds = resolveRuntimeOptionsFromMeta(params.meta).timeoutSeconds;
		if (typeof runtimeTimeoutSeconds === "number" && Number.isFinite(runtimeTimeoutSeconds) && runtimeTimeoutSeconds > 0) return Math.max(1e3, Math.round(runtimeTimeoutSeconds * 1e3));
		return resolveAgentTimeoutMs({
			cfg: params.cfg,
			minMs: 1e3
		});
	}
	async awaitTurnWithTimeout(params) {
		const observedTurnPromise = params.turnPromise.then((value) => ({
			kind: "value",
			value
		}), (error) => ({
			kind: "error",
			error
		}));
		if (params.timeoutMs <= 0) {
			const outcome = await observedTurnPromise;
			if (outcome.kind === "error") throw outcome.error;
			return outcome.value;
		}
		const timeoutToken = Symbol("acp-turn-timeout");
		let timer;
		const timeoutPromise = new Promise((resolve) => {
			timer = setTimeout(() => resolve(timeoutToken), params.timeoutMs);
			timer.unref?.();
		});
		try {
			const outcome = await Promise.race([observedTurnPromise, timeoutPromise]);
			if (outcome === timeoutToken) {
				observedTurnPromise.then((lateOutcome) => {
					if (lateOutcome.kind === "error") logVerbose(`acp-manager: detached late turn error after timeout for ${params.sessionKey}: ${String(lateOutcome.error)}`);
				});
				await params.onTimeout();
				throw new AcpRuntimeError("ACP_TURN_FAILED", `ACP turn timed out after ${Math.max(1, Math.round(params.timeoutLabelMs / 1e3))}s.`);
			}
			if (outcome.kind === "error") throw outcome.error;
			return outcome.value;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	async cleanupTimedOutTurn(params) {
		params.activeTurn.abortController.abort();
		if (!params.activeTurn.cancelPromise) params.activeTurn.cancelPromise = params.activeTurn.runtime.cancel({
			handle: params.activeTurn.handle,
			reason: ACP_TURN_TIMEOUT_REASON
		});
		const cancelFinished = await this.awaitCleanupWithGrace({
			sessionKey: params.sessionKey,
			label: "cancel",
			promise: params.activeTurn.cancelPromise
		});
		if (params.mode !== "oneshot") return;
		const closePromise = params.activeTurn.runtime.close({
			handle: params.activeTurn.handle,
			reason: ACP_TURN_TIMEOUT_REASON
		});
		const closeFinished = await this.awaitCleanupWithGrace({
			sessionKey: params.sessionKey,
			label: "close",
			promise: closePromise
		});
		if (cancelFinished && closeFinished) {
			this.clearCachedRuntimeStateIfHandleMatches({
				sessionKey: params.sessionKey,
				handle: params.activeTurn.handle
			});
			return;
		}
		Promise.allSettled([params.activeTurn.cancelPromise, closePromise]).then(() => {
			this.clearCachedRuntimeStateIfHandleMatches({
				sessionKey: params.sessionKey,
				handle: params.activeTurn.handle
			});
		});
	}
	async awaitCleanupWithGrace(params) {
		const observedCleanupPromise = params.promise.then(() => ({ kind: "done" }), (error) => ({
			kind: "error",
			error
		}));
		const timeoutToken = Symbol(`acp-timeout-${params.label}`);
		let timer;
		const timeoutPromise = new Promise((resolve) => {
			timer = setTimeout(() => resolve(timeoutToken), ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS);
			timer.unref?.();
		});
		try {
			const outcome = await Promise.race([observedCleanupPromise, timeoutPromise]);
			if (outcome === timeoutToken) {
				observedCleanupPromise.then((lateOutcome) => {
					if (lateOutcome.kind === "error") logVerbose(`acp-manager: detached timed-out turn ${params.label} cleanup failed for ${params.sessionKey}: ${String(lateOutcome.error)}`);
				});
				logVerbose(`acp-manager: timed-out turn ${params.label} cleanup exceeded ${ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS}ms for ${params.sessionKey}`);
				return false;
			}
			if (outcome.kind === "error") logVerbose(`acp-manager: timed-out turn ${params.label} cleanup failed for ${params.sessionKey}: ${String(outcome.error)}`);
			return true;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	async cancelSession(params) {
		const sessionKey = canonicalizeAcpSessionKey(params);
		if (!sessionKey) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
		await this.evictIdleRuntimeHandles({ cfg: params.cfg });
		const actorKey = normalizeActorKey(sessionKey);
		const activeTurn = this.activeTurnBySession.get(actorKey);
		if (activeTurn) {
			activeTurn.abortController.abort();
			if (!activeTurn.cancelPromise) activeTurn.cancelPromise = activeTurn.runtime.cancel({
				handle: activeTurn.handle,
				reason: params.reason
			});
			await withAcpRuntimeErrorBoundary({
				run: async () => await activeTurn.cancelPromise,
				fallbackCode: "ACP_TURN_FAILED",
				fallbackMessage: "ACP cancel failed before completion."
			});
			return;
		}
		await this.withSessionActor(sessionKey, async () => {
			const resolvedMeta = requireReadySessionMeta(this.resolveSession({
				cfg: params.cfg,
				sessionKey
			}));
			const { runtime, handle } = await this.ensureRuntimeHandle({
				cfg: params.cfg,
				sessionKey,
				meta: resolvedMeta
			});
			try {
				await withAcpRuntimeErrorBoundary({
					run: async () => await runtime.cancel({
						handle,
						reason: params.reason
					}),
					fallbackCode: "ACP_TURN_FAILED",
					fallbackMessage: "ACP cancel failed before completion."
				});
				await this.setSessionState({
					cfg: params.cfg,
					sessionKey,
					state: "idle",
					clearLastError: true
				});
			} catch (error) {
				const acpError = toAcpRuntimeError({
					error,
					fallbackCode: "ACP_TURN_FAILED",
					fallbackMessage: "ACP cancel failed before completion."
				});
				await this.setSessionState({
					cfg: params.cfg,
					sessionKey,
					state: "error",
					lastError: acpError.message
				});
				throw acpError;
			}
		});
	}
	async closeSession(input) {
		const sessionKey = canonicalizeAcpSessionKey({
			cfg: input.cfg,
			sessionKey: input.sessionKey
		});
		if (!sessionKey) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
		await this.evictIdleRuntimeHandles({ cfg: input.cfg });
		return await this.withSessionActor(sessionKey, async () => {
			const resolution = this.resolveSession({
				cfg: input.cfg,
				sessionKey
			});
			const resolutionError = resolveAcpSessionResolutionError(resolution);
			if (resolutionError) {
				if (input.requireAcpSession ?? true) throw resolutionError;
				return {
					runtimeClosed: false,
					metaCleared: false
				};
			}
			const meta = requireReadySessionMeta(resolution);
			const currentIdentity = resolveSessionIdentityFromMeta(meta);
			const shouldSkipRuntimeClose = input.discardPersistentState && currentIdentity != null && !identityHasStableSessionId(currentIdentity);
			let runtimeClosed = false;
			let runtimeNotice;
			if (shouldSkipRuntimeClose) {
				if (input.discardPersistentState) {
					const configuredBackend = (meta.backend || input.cfg.acp?.backend || "").trim();
					try {
						await this.deps.getRuntimeBackend(configuredBackend || void 0)?.runtime.prepareFreshSession?.({ sessionKey });
					} catch (error) {
						logVerbose(`acp close fast-reset: unable to prepare fresh session for ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				this.clearCachedRuntimeState(sessionKey);
			} else try {
				const { runtime: ensuredRuntime, handle } = await this.ensureRuntimeHandle({
					cfg: input.cfg,
					sessionKey,
					meta
				});
				await withAcpRuntimeErrorBoundary({
					run: async () => await ensuredRuntime.close({
						handle,
						reason: input.reason,
						discardPersistentState: input.discardPersistentState
					}),
					fallbackCode: "ACP_TURN_FAILED",
					fallbackMessage: "ACP close failed before completion."
				});
				runtimeClosed = true;
				this.clearCachedRuntimeState(sessionKey);
			} catch (error) {
				const acpError = toAcpRuntimeError({
					error,
					fallbackCode: "ACP_TURN_FAILED",
					fallbackMessage: "ACP close failed before completion."
				});
				if (input.allowBackendUnavailable && (acpError.code === "ACP_BACKEND_MISSING" || acpError.code === "ACP_BACKEND_UNAVAILABLE" || input.discardPersistentState && acpError.code === "ACP_SESSION_INIT_FAILED" || input.discardPersistentState && acpError.code === "ACP_BACKEND_UNSUPPORTED_CONTROL" || this.isRecoverableAcpxExitError(acpError.message))) {
					if (input.discardPersistentState) {
						const configuredBackend = (meta.backend || input.cfg.acp?.backend || "").trim();
						try {
							const runtimeBackend = this.deps.getRuntimeBackend(configuredBackend || void 0);
							if (!runtimeBackend) throw acpError;
							await runtimeBackend.runtime.prepareFreshSession?.({ sessionKey });
						} catch (recoveryError) {
							logVerbose(`acp close recovery: unable to prepare fresh session for ${sessionKey}: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
						}
					}
					this.clearCachedRuntimeState(sessionKey);
					runtimeNotice = acpError.message;
				} else throw acpError;
			}
			let metaCleared = false;
			if (input.discardPersistentState && !input.clearMeta) await this.discardPersistedRuntimeState({
				cfg: input.cfg,
				sessionKey
			});
			if (input.clearMeta) {
				await this.writeSessionMeta({
					cfg: input.cfg,
					sessionKey,
					mutate: (_current, entry) => {
						if (!entry) return null;
						return null;
					},
					failOnError: true
				});
				metaCleared = true;
			}
			return {
				runtimeClosed,
				runtimeNotice,
				metaCleared
			};
		});
	}
	async ensureRuntimeHandle(params) {
		const agent = normalizeOptionalString(params.meta.agent) || resolveAcpAgentFromSessionKey(params.sessionKey, "main");
		const mode = params.meta.mode;
		const runtimeOptions = resolveRuntimeOptionsFromMeta(params.meta);
		const cwd = runtimeOptions.cwd ?? normalizeOptionalString(params.meta.cwd);
		const model = normalizeOptionalString(runtimeOptions.model);
		const thinking = normalizeOptionalString(runtimeOptions.thinking);
		const configuredBackend = (params.meta.backend || params.cfg.acp?.backend || "").trim();
		const configSignature = resolveRuntimeConfigCacheKey(params.cfg);
		const cached = this.getCachedRuntimeState(params.sessionKey);
		if (cached) {
			const backendMatches = !configuredBackend || cached.backend === configuredBackend;
			const agentMatches = cached.agent === agent;
			const modeMatches = cached.mode === mode;
			const cwdMatches = (cached.cwd ?? "") === (cwd ?? "");
			const configMatches = cached.configSignature === configSignature;
			const handleMatchesMeta = this.runtimeHandleMatchesMeta({
				handle: cached.handle,
				meta: params.meta
			});
			if (backendMatches && agentMatches && modeMatches && cwdMatches && configMatches && handleMatchesMeta && await this.isCachedRuntimeHandleReusable({
				sessionKey: params.sessionKey,
				runtime: cached.runtime,
				handle: cached.handle
			})) return {
				runtime: cached.runtime,
				handle: cached.handle,
				meta: params.meta
			};
			await this.closeCachedRuntimeState({
				sessionKey: params.sessionKey,
				reason: "runtime-handle-replaced"
			});
		}
		this.enforceConcurrentSessionLimit({
			cfg: params.cfg,
			sessionKey: params.sessionKey
		});
		const backend = this.deps.requireRuntimeBackend(configuredBackend || void 0);
		const runtime = backend.runtime;
		const previousMeta = params.meta;
		const previousIdentity = resolveSessionIdentityFromMeta(previousMeta);
		let identityForEnsure = previousIdentity;
		const persistedResumeSessionId = mode === "persistent" ? resolveRuntimeResumeSessionId(previousIdentity) : void 0;
		const shouldPrepareFreshPersistentSession = mode === "persistent" && previousIdentity != null && !identityHasStableSessionId(previousIdentity);
		const ensureSession = async (resumeSessionId) => await withAcpRuntimeErrorBoundary({
			run: async () => await runtime.ensureSession({
				sessionKey: params.sessionKey,
				agent,
				mode,
				...resumeSessionId ? { resumeSessionId } : {},
				...model ? { model } : {},
				...thinking ? { thinking } : {},
				cwd
			}),
			fallbackCode: "ACP_SESSION_INIT_FAILED",
			fallbackMessage: "Could not initialize ACP session runtime."
		});
		let ensured;
		if (shouldPrepareFreshPersistentSession) await runtime.prepareFreshSession?.({ sessionKey: params.sessionKey });
		if (persistedResumeSessionId) try {
			ensured = await ensureSession(persistedResumeSessionId);
		} catch (error) {
			const acpError = toAcpRuntimeError({
				error,
				fallbackCode: "ACP_SESSION_INIT_FAILED",
				fallbackMessage: "Could not initialize ACP session runtime."
			});
			if (acpError.code !== "ACP_SESSION_INIT_FAILED") throw acpError;
			logVerbose(`acp-manager: resume init failed for ${params.sessionKey}; retrying without persisted ACP session id: ${acpError.message}`);
			if (identityForEnsure) {
				const { acpxSessionId: _staleAcpxSessionId, agentSessionId: _staleAgentSessionId, ...retryIdentity } = identityForEnsure;
				identityForEnsure = {
					...retryIdentity,
					state: "pending"
				};
			}
			ensured = await ensureSession();
		}
		else ensured = await ensureSession();
		const now = Date.now();
		const effectiveCwd = normalizeOptionalString(ensured.cwd) ?? cwd;
		const nextRuntimeOptions = normalizeRuntimeOptions({
			...runtimeOptions,
			...effectiveCwd ? { cwd: effectiveCwd } : {}
		});
		const nextIdentity = mergeSessionIdentity({
			current: identityForEnsure,
			incoming: createIdentityFromEnsure({
				handle: ensured,
				now
			}),
			now
		}) ?? identityForEnsure;
		const nextHandleIdentifiers = resolveRuntimeHandleIdentifiersFromIdentity(nextIdentity);
		const nextHandle = {
			...ensured,
			...nextHandleIdentifiers.backendSessionId ? { backendSessionId: nextHandleIdentifiers.backendSessionId } : {},
			...nextHandleIdentifiers.agentSessionId ? { agentSessionId: nextHandleIdentifiers.agentSessionId } : {}
		};
		const nextMeta = {
			backend: ensured.backend || backend.id,
			agent,
			runtimeSessionName: ensured.runtimeSessionName,
			...nextIdentity ? { identity: nextIdentity } : {},
			mode: params.meta.mode,
			...Object.keys(nextRuntimeOptions).length > 0 ? { runtimeOptions: nextRuntimeOptions } : {},
			...effectiveCwd ? { cwd: effectiveCwd } : {},
			state: previousMeta.state,
			lastActivityAt: now,
			...previousMeta.lastError ? { lastError: previousMeta.lastError } : {}
		};
		if (previousMeta.backend !== nextMeta.backend || previousMeta.runtimeSessionName !== nextMeta.runtimeSessionName || !identityEquals(previousIdentity, nextIdentity) || previousMeta.agent !== nextMeta.agent || previousMeta.cwd !== nextMeta.cwd || !runtimeOptionsEqual(previousMeta.runtimeOptions, nextMeta.runtimeOptions) || hasLegacyAcpIdentityProjection(previousMeta)) await this.writeSessionMeta({
			cfg: params.cfg,
			sessionKey: params.sessionKey,
			mutate: (_current, entry) => {
				if (!entry) return null;
				return nextMeta;
			}
		});
		this.setCachedRuntimeState(params.sessionKey, {
			runtime,
			handle: nextHandle,
			backend: ensured.backend || backend.id,
			agent,
			mode,
			cwd: effectiveCwd,
			configSignature,
			appliedControlSignature: void 0
		});
		return {
			runtime,
			handle: nextHandle,
			meta: nextMeta
		};
	}
	async isCachedRuntimeHandleReusable(params) {
		if (!params.runtime.getStatus) return true;
		try {
			const status = await params.runtime.getStatus({ handle: params.handle });
			if (this.isRuntimeStatusUnavailable(status)) {
				this.clearCachedRuntimeState(params.sessionKey);
				logVerbose(`acp-manager: evicting cached runtime handle for ${params.sessionKey} after unhealthy status probe: ${status.summary ?? "status unavailable"}`);
				return false;
			}
			return true;
		} catch (error) {
			this.clearCachedRuntimeState(params.sessionKey);
			logVerbose(`acp-manager: evicting cached runtime handle for ${params.sessionKey} after status probe failed: ${String(error)}`);
			return false;
		}
	}
	isRuntimeStatusUnavailable(status) {
		if (!status) return false;
		const detailsStatus = normalizeLowercaseStringOrEmpty(status.details?.status);
		if (detailsStatus === "dead" || detailsStatus === "no-session") return true;
		const summaryMatch = status.summary?.match(/\bstatus=([^\s]+)/i);
		const summaryStatus = normalizeLowercaseStringOrEmpty(summaryMatch?.[1]);
		return summaryStatus === "dead" || summaryStatus === "no-session";
	}
	async persistRuntimeOptions(params) {
		const normalized = normalizeRuntimeOptions(params.options);
		const hasOptions = Object.keys(normalized).length > 0;
		await this.writeSessionMeta({
			cfg: params.cfg,
			sessionKey: params.sessionKey,
			mutate: (current, entry) => {
				if (!entry) return null;
				const base = current ?? entry.acp;
				if (!base) return null;
				return {
					backend: base.backend,
					agent: base.agent,
					runtimeSessionName: base.runtimeSessionName,
					...base.identity ? { identity: base.identity } : {},
					mode: base.mode,
					runtimeOptions: hasOptions ? normalized : void 0,
					cwd: normalized.cwd,
					state: base.state,
					lastActivityAt: Date.now(),
					...base.lastError ? { lastError: base.lastError } : {}
				};
			},
			failOnError: true
		});
		const cached = this.getCachedRuntimeState(params.sessionKey);
		if (!cached) return;
		if ((cached.cwd ?? "") !== (normalized.cwd ?? "")) {
			this.clearCachedRuntimeState(params.sessionKey);
			return;
		}
		cached.appliedControlSignature = void 0;
	}
	enforceConcurrentSessionLimit(params) {
		const configuredLimit = params.cfg.acp?.maxConcurrentSessions;
		if (typeof configuredLimit !== "number" || !Number.isFinite(configuredLimit)) return;
		const limit = Math.max(1, Math.floor(configuredLimit));
		const actorKey = normalizeActorKey(params.sessionKey);
		if (this.runtimeCache.has(actorKey)) return;
		const activeCount = this.runtimeCache.size();
		if (activeCount >= limit) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", `ACP max concurrent sessions reached (${activeCount}/${limit}).`);
	}
	recordTurnCompletion(params) {
		const durationMs = Math.max(0, Date.now() - params.startedAt);
		this.turnLatencyStats.totalMs += durationMs;
		this.turnLatencyStats.maxMs = Math.max(this.turnLatencyStats.maxMs, durationMs);
		if (params.errorCode) {
			this.turnLatencyStats.failed += 1;
			this.recordErrorCode(params.errorCode);
			return;
		}
		this.turnLatencyStats.completed += 1;
	}
	recordErrorCode(code) {
		const normalized = normalizeAcpErrorCode(code);
		this.errorCountsByCode.set(normalized, (this.errorCountsByCode.get(normalized) ?? 0) + 1);
	}
	async prepareFreshHandleRetry(params) {
		if (params.attempt > 0 || params.sawTurnOutput) return false;
		if (this.isRecoverableAcpxExitError(params.error.message)) {
			this.clearCachedRuntimeState(params.sessionKey);
			logVerbose(`acp-manager: retrying ${params.sessionKey} with a fresh runtime handle after early turn failure: ${params.error.message}`);
			return true;
		}
		if (!params.runtime || !params.meta || params.meta.mode !== "persistent" || !this.isRecoverableMissingPersistentSessionError(params.error.message)) return false;
		if (!await this.clearPersistedRuntimeResumeState({
			cfg: params.cfg,
			sessionKey: params.sessionKey
		})) return false;
		if (params.runtime.prepareFreshSession) try {
			await params.runtime.prepareFreshSession({ sessionKey: params.sessionKey });
		} catch (error) {
			logVerbose(`acp-manager: failed preparing a fresh persistent session for ${params.sessionKey}: ${formatErrorMessage(error)}`);
			return false;
		}
		this.clearCachedRuntimeState(params.sessionKey);
		logVerbose(`acp-manager: retrying ${params.sessionKey} with a fresh persistent session after missing backend resume target: ${params.error.message}`);
		return true;
	}
	isRecoverableAcpxExitError(message) {
		return /^acpx exited with (code \d+|signal [a-z0-9]+)/i.test(message.trim());
	}
	isRecoverableMissingPersistentSessionError(message) {
		const normalized = message.trim();
		return /persistent acp session .* could not be resumed/i.test(normalized) && /(resource not found|no matching session)/i.test(normalized);
	}
	async clearPersistedRuntimeResumeState(params) {
		const now = Date.now();
		if (!await this.writeSessionMeta({
			cfg: params.cfg,
			sessionKey: params.sessionKey,
			mutate: (current, entry) => {
				if (!entry) return null;
				const base = current ?? entry.acp;
				if (!base) return null;
				const currentIdentity = resolveSessionIdentityFromMeta(base);
				if (!currentIdentity?.acpxSessionId && !currentIdentity?.agentSessionId) return base;
				const nextIdentity = {
					state: "pending",
					...currentIdentity.acpxRecordId ? { acpxRecordId: currentIdentity.acpxRecordId } : {},
					source: currentIdentity.source,
					lastUpdatedAt: now
				};
				return {
					backend: base.backend,
					agent: base.agent,
					runtimeSessionName: base.runtimeSessionName,
					identity: nextIdentity,
					mode: base.mode,
					...base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {},
					...base.cwd ? { cwd: base.cwd } : {},
					state: base.state,
					lastActivityAt: now,
					...base.lastError ? { lastError: base.lastError } : {}
				};
			}
		})) {
			logVerbose(`acp-manager: unable to clear persisted runtime resume state for ${params.sessionKey}`);
			return false;
		}
		return true;
	}
	async discardPersistedRuntimeState(params) {
		const now = Date.now();
		await this.writeSessionMeta({
			cfg: params.cfg,
			sessionKey: params.sessionKey,
			mutate: (current, entry) => {
				if (!entry) return null;
				const base = current ?? entry.acp;
				if (!base) return null;
				const currentIdentity = resolveSessionIdentityFromMeta(base);
				const nextIdentity = currentIdentity ? {
					state: "pending",
					...currentIdentity.acpxRecordId ? { acpxRecordId: currentIdentity.acpxRecordId } : {},
					source: currentIdentity.source,
					lastUpdatedAt: now
				} : void 0;
				return {
					backend: base.backend,
					agent: base.agent,
					runtimeSessionName: base.runtimeSessionName,
					...nextIdentity ? { identity: nextIdentity } : {},
					mode: base.mode,
					...base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {},
					...base.cwd ? { cwd: base.cwd } : {},
					state: "idle",
					lastActivityAt: now
				};
			},
			failOnError: true
		});
	}
	async evictIdleRuntimeHandles(params) {
		const idleTtlMs = resolveRuntimeIdleTtlMs(params.cfg);
		if (idleTtlMs <= 0 || this.runtimeCache.size() === 0) return;
		const now = Date.now();
		const candidates = this.runtimeCache.collectIdleCandidates({
			maxIdleMs: idleTtlMs,
			now
		});
		if (candidates.length === 0) return;
		for (const candidate of candidates) await this.actorQueue.run(candidate.actorKey, async () => {
			if (this.activeTurnBySession.has(candidate.actorKey)) return;
			const lastTouchedAt = this.runtimeCache.getLastTouchedAt(candidate.actorKey);
			if (lastTouchedAt == null || now - lastTouchedAt < idleTtlMs) return;
			const cached = this.runtimeCache.peek(candidate.actorKey);
			if (!cached) return;
			this.runtimeCache.clear(candidate.actorKey);
			this.evictedRuntimeCount += 1;
			this.lastEvictedAt = Date.now();
			try {
				await cached.runtime.close({
					handle: cached.handle,
					reason: "idle-evicted"
				});
			} catch (error) {
				logVerbose(`acp-manager: idle eviction close failed for ${candidate.state.handle.sessionKey}: ${String(error)}`);
			}
		});
	}
	async resolveRuntimeCapabilities(params) {
		return await resolveManagerRuntimeCapabilities(params);
	}
	async applyRuntimeControls(params) {
		await applyManagerRuntimeControls({
			...params,
			getCachedRuntimeState: (sessionKey) => this.getCachedRuntimeState(sessionKey)
		});
	}
	async setSessionState(params) {
		await this.writeSessionMeta({
			cfg: params.cfg,
			sessionKey: params.sessionKey,
			mutate: (current, entry) => {
				if (!entry) return null;
				const base = current ?? entry.acp;
				if (!base) return null;
				const next = {
					backend: base.backend,
					agent: base.agent,
					runtimeSessionName: base.runtimeSessionName,
					...base.identity ? { identity: base.identity } : {},
					mode: base.mode,
					...base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {},
					...base.cwd ? { cwd: base.cwd } : {},
					state: params.state,
					lastActivityAt: Date.now(),
					...base.lastError ? { lastError: base.lastError } : {}
				};
				const lastError = normalizeOptionalString(params.lastError);
				if (lastError) next.lastError = lastError;
				else if (params.clearLastError) delete next.lastError;
				return next;
			}
		});
	}
	async reconcileRuntimeSessionIdentifiers(params) {
		return await reconcileManagerRuntimeSessionIdentifiers({
			...params,
			setCachedHandle: (sessionKey, handle) => {
				const cached = this.getCachedRuntimeState(sessionKey);
				if (cached) cached.handle = handle;
			},
			writeSessionMeta: async (writeParams) => await this.writeSessionMeta(writeParams)
		});
	}
	async writeSessionMeta(params) {
		try {
			return await this.deps.upsertSessionMeta({
				cfg: params.cfg,
				sessionKey: params.sessionKey,
				mutate: params.mutate
			});
		} catch (error) {
			if (params.failOnError) throw error;
			logVerbose(`acp-manager: failed persisting ACP metadata for ${params.sessionKey}: ${String(error)}`);
			return null;
		}
	}
	async withSessionActor(sessionKey, op, signal) {
		const actorKey = normalizeActorKey(sessionKey);
		this.throwIfAborted(signal);
		let actorStarted = false;
		const queued = this.actorQueue.run(actorKey, async () => {
			actorStarted = true;
			this.throwIfAborted(signal);
			return await op();
		});
		if (!signal) return await queued;
		return await new Promise((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				signal.removeEventListener("abort", onAbort);
			};
			const settleValue = (value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			};
			const settleError = (error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const onAbort = () => {
				if (actorStarted) return;
				try {
					this.throwIfAborted(signal);
				} catch (error) {
					settleError(error);
				}
			};
			signal.addEventListener("abort", onAbort, { once: true });
			queued.then(settleValue, settleError);
			if (signal.aborted) onAbort();
		});
	}
	throwIfAborted(signal) {
		if (!signal?.aborted) return;
		throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP operation aborted.");
	}
	getCachedRuntimeState(sessionKey) {
		return this.runtimeCache.get(normalizeActorKey(sessionKey));
	}
	setCachedRuntimeState(sessionKey, state) {
		this.runtimeCache.set(normalizeActorKey(sessionKey), state);
	}
	clearCachedRuntimeState(sessionKey) {
		this.runtimeCache.clear(normalizeActorKey(sessionKey));
	}
	async closeCachedRuntimeState(params) {
		const cached = this.getCachedRuntimeState(params.sessionKey);
		if (!cached) return;
		try {
			await cached.runtime.close({
				handle: cached.handle,
				reason: params.reason
			});
		} catch (error) {
			logVerbose(`acp-manager: cached runtime close failed for ${params.sessionKey}: ${String(error)}`);
		} finally {
			this.clearCachedRuntimeState(params.sessionKey);
		}
	}
	clearCachedRuntimeStateIfHandleMatches(params) {
		const cached = this.getCachedRuntimeState(params.sessionKey);
		if (!cached || !this.runtimeHandlesMatch(cached.handle, params.handle)) return;
		this.clearCachedRuntimeState(params.sessionKey);
	}
	runtimeHandlesMatch(a, b) {
		return a.sessionKey === b.sessionKey && a.backend === b.backend && a.runtimeSessionName === b.runtimeSessionName && (a.cwd ?? "") === (b.cwd ?? "") && (a.acpxRecordId ?? "") === (b.acpxRecordId ?? "") && (a.backendSessionId ?? "") === (b.backendSessionId ?? "") && (a.agentSessionId ?? "") === (b.agentSessionId ?? "");
	}
	runtimeHandleMatchesMeta(params) {
		const identity = resolveSessionIdentityFromMeta(params.meta);
		const expectedHandleIds = resolveRuntimeHandleIdentifiersFromIdentity(identity);
		if ((params.handle.backendSessionId ?? "") !== (expectedHandleIds.backendSessionId ?? "")) return false;
		if ((params.handle.agentSessionId ?? "") !== (expectedHandleIds.agentSessionId ?? "")) return false;
		const expectedAcpxRecordId = identity?.acpxRecordId ?? "";
		return (normalizeOptionalString(params.handle.acpxRecordId) ?? "") === expectedAcpxRecordId;
	}
	resolveBackgroundTaskContext(params) {
		const childEntry = this.deps.readSessionEntry({
			cfg: params.cfg,
			sessionKey: params.sessionKey
		})?.entry;
		const requesterSessionKey = normalizeOptionalString(childEntry?.spawnedBy) ?? normalizeOptionalString(childEntry?.parentSessionKey);
		if (!requesterSessionKey) return null;
		return {
			requesterSessionKey,
			requesterOrigin: (this.deps.readSessionEntry({
				cfg: params.cfg,
				sessionKey: requesterSessionKey
			})?.entry)?.deliveryContext ?? childEntry?.deliveryContext,
			childSessionKey: params.sessionKey,
			runId: params.requestId,
			label: normalizeOptionalString(childEntry?.label),
			task: summarizeBackgroundTaskText(params.text)
		};
	}
	createBackgroundTaskRecord(context, startedAt) {
		try {
			createRunningTaskRun({
				runtime: "acp",
				sourceId: context.runId,
				ownerKey: context.requesterSessionKey,
				scopeKind: "session",
				requesterOrigin: context.requesterOrigin,
				childSessionKey: context.childSessionKey,
				runId: context.runId,
				label: context.label,
				task: context.task,
				startedAt
			});
		} catch (error) {
			logVerbose(`acp-manager: failed creating background task for ${context.runId}: ${String(error)}`);
		}
	}
	markBackgroundTaskRunning(runId, params) {
		try {
			startTaskRunByRunId({
				runId,
				runtime: "acp",
				sessionKey: params.sessionKey,
				lastEventAt: params.lastEventAt,
				progressSummary: params.progressSummary
			});
		} catch (error) {
			logVerbose(`acp-manager: failed updating background task for ${runId}: ${String(error)}`);
		}
	}
	markBackgroundTaskTerminal(runId, params) {
		try {
			if (params.status === "succeeded") {
				completeTaskRunByRunId({
					runId,
					runtime: "acp",
					sessionKey: params.sessionKey,
					endedAt: params.endedAt,
					lastEventAt: params.lastEventAt,
					progressSummary: params.progressSummary,
					terminalSummary: params.terminalSummary,
					terminalOutcome: params.terminalOutcome
				});
				return;
			}
			failTaskRunByRunId({
				runId,
				runtime: "acp",
				sessionKey: params.sessionKey,
				status: params.status,
				endedAt: params.endedAt,
				lastEventAt: params.lastEventAt,
				error: params.error,
				progressSummary: params.progressSummary,
				terminalSummary: params.terminalSummary
			});
		} catch (error) {
			logVerbose(`acp-manager: failed updating background task for ${runId}: ${String(error)}`);
		}
	}
};
//#endregion
//#region src/acp/control-plane/manager.ts
let ACP_SESSION_MANAGER_SINGLETON = null;
function getAcpSessionManager() {
	if (!ACP_SESSION_MANAGER_SINGLETON) ACP_SESSION_MANAGER_SINGLETON = new AcpSessionManager();
	return ACP_SESSION_MANAGER_SINGLETON;
}
const testing = {
	resetAcpSessionManagerForTests() {
		ACP_SESSION_MANAGER_SINGLETON = null;
	},
	setAcpSessionManagerForTests(manager) {
		ACP_SESSION_MANAGER_SINGLETON = manager;
	}
};
//#endregion
export { validateRuntimeConfigOptionInput as a, validateRuntimeModelInput as c, parseRuntimeTimeoutSecondsInput as i, validateRuntimePermissionProfileInput as l, testing as n, validateRuntimeCwdInput as o, AcpSessionManager as r, validateRuntimeModeInput as s, getAcpSessionManager as t, resolveAcpSessionResolutionError as u };
