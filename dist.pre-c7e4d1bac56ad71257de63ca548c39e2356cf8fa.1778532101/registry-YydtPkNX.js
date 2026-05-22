import { t as sanitizeForLog } from "./ansi-Dqm1lzVL.js";
import { n as resolveGlobalSingleton } from "./global-singleton-DZyLAEQq.js";
import { n as defaultSlotIdForKey } from "./slots-CQk-Ab1S.js";
//#region src/context-engine/registry.ts
const LEGACY_SESSION_KEY_COMPAT = Symbol.for("openclaw.contextEngine.sessionKeyCompat");
const SESSION_KEY_COMPAT_METHODS = [
	"bootstrap",
	"maintain",
	"ingest",
	"ingestBatch",
	"afterTurn",
	"assemble",
	"compact"
];
const LEGACY_COMPAT_METHOD_KEYS = {
	bootstrap: ["sessionKey"],
	maintain: ["sessionKey"],
	ingest: ["sessionKey"],
	ingestBatch: ["sessionKey"],
	afterTurn: ["sessionKey"],
	assemble: ["sessionKey", "prompt"],
	compact: ["sessionKey"]
};
function isSessionKeyCompatMethodName(value) {
	return typeof value === "string" && SESSION_KEY_COMPAT_METHODS.includes(value);
}
function hasOwnLegacyCompatKey(params, key) {
	return params !== null && typeof params === "object" && Object.prototype.hasOwnProperty.call(params, key);
}
function withoutLegacyCompatKeys(params, keys) {
	const legacyParams = { ...params };
	for (const key of keys) delete legacyParams[key];
	return legacyParams;
}
function issueRejectsLegacyCompatKeyStrictly(issue, key) {
	if (!issue || typeof issue !== "object") return false;
	const issueRecord = issue;
	if (issueRecord.code === "unrecognized_keys" && Array.isArray(issueRecord.keys) && issueRecord.keys.some((issueKey) => issueKey === key)) return true;
	return isLegacyCompatErrorForKey(issueRecord.message, key);
}
function* iterateErrorChain(error) {
	let current = error;
	const seen = /* @__PURE__ */ new Set();
	while (current !== void 0 && current !== null && !seen.has(current)) {
		yield current;
		seen.add(current);
		if (typeof current !== "object") break;
		current = current.cause;
	}
}
const LEGACY_UNKNOWN_FIELD_PATTERNS = {
	sessionKey: [
		/\bunrecognized key(?:\(s\)|s)? in object:.*['"`]sessionKey['"`]/i,
		/\badditional propert(?:y|ies)\b.*['"`]sessionKey['"`]/i,
		/\bmust not have additional propert(?:y|ies)\b.*['"`]sessionKey['"`]/i,
		/\b(?:unexpected|extraneous)\s+(?:property|properties|field|fields|key|keys)\b.*['"`]sessionKey['"`]/i,
		/\b(?:unknown|invalid)\s+(?:property|properties|field|fields|key|keys)\b.*['"`]sessionKey['"`]/i,
		/['"`]sessionKey['"`].*\b(?:was|is)\s+not allowed\b/i,
		/"code"\s*:\s*"unrecognized_keys"[^]*"sessionKey"/i
	],
	prompt: [
		/\bunrecognized key(?:\(s\)|s)? in object:.*['"`]prompt['"`]/i,
		/\badditional propert(?:y|ies)\b.*['"`]prompt['"`]/i,
		/\bmust not have additional propert(?:y|ies)\b.*['"`]prompt['"`]/i,
		/\b(?:unexpected|extraneous)\s+(?:property|properties|field|fields|key|keys)\b.*['"`]prompt['"`]/i,
		/\b(?:unknown|invalid)\s+(?:property|properties|field|fields|key|keys)\b.*['"`]prompt['"`]/i,
		/['"`]prompt['"`].*\b(?:was|is)\s+not allowed\b/i,
		/"code"\s*:\s*"unrecognized_keys"[^]*"prompt"/i
	]
};
function isLegacyCompatUnknownFieldValidationMessage(message, key) {
	return LEGACY_UNKNOWN_FIELD_PATTERNS[key].some((pattern) => pattern.test(message));
}
function isLegacyCompatErrorForKey(error, key) {
	for (const candidate of iterateErrorChain(error)) {
		if (Array.isArray(candidate)) {
			if (candidate.some((entry) => issueRejectsLegacyCompatKeyStrictly(entry, key))) return true;
			continue;
		}
		if (typeof candidate === "string") {
			if (isLegacyCompatUnknownFieldValidationMessage(candidate, key)) return true;
			continue;
		}
		if (!candidate || typeof candidate !== "object") continue;
		const issueContainer = candidate;
		if (Array.isArray(issueContainer.issues) && issueContainer.issues.some((issue) => issueRejectsLegacyCompatKeyStrictly(issue, key))) return true;
		if (Array.isArray(issueContainer.errors) && issueContainer.errors.some((issue) => issueRejectsLegacyCompatKeyStrictly(issue, key))) return true;
		if (typeof issueContainer.message === "string" && isLegacyCompatUnknownFieldValidationMessage(issueContainer.message, key)) return true;
	}
	return false;
}
function detectRejectedLegacyCompatKeys(error, allowedKeys) {
	const rejectedKeys = /* @__PURE__ */ new Set();
	for (const key of allowedKeys) if (isLegacyCompatErrorForKey(error, key)) rejectedKeys.add(key);
	return rejectedKeys;
}
async function invokeWithLegacyCompat(method, params, allowedKeys, opts) {
	const activeRejectedKeys = new Set(opts?.rejectedKeys ?? []);
	const availableKeys = allowedKeys.filter((key) => hasOwnLegacyCompatKey(params, key));
	if (availableKeys.length === 0) return await method(params);
	let currentParams = activeRejectedKeys.size > 0 ? withoutLegacyCompatKeys(params, activeRejectedKeys) : params;
	try {
		return await method(currentParams);
	} catch (error) {
		let currentError = error;
		while (true) {
			const rejectedKeys = detectRejectedLegacyCompatKeys(currentError, availableKeys);
			let learnedNewKey = false;
			for (const key of rejectedKeys) if (!activeRejectedKeys.has(key)) {
				activeRejectedKeys.add(key);
				learnedNewKey = true;
			}
			if (!learnedNewKey) throw currentError;
			opts?.onLegacyModeDetected?.();
			opts?.onLegacyKeysDetected?.(rejectedKeys);
			currentParams = withoutLegacyCompatKeys(params, activeRejectedKeys);
			try {
				return await method(currentParams);
			} catch (retryError) {
				currentError = retryError;
			}
		}
	}
}
function wrapContextEngineWithSessionKeyCompat(engine) {
	if (engine[LEGACY_SESSION_KEY_COMPAT]) return engine;
	let isLegacy = false;
	const rejectedKeys = /* @__PURE__ */ new Set();
	return new Proxy(engine, { get(target, property, receiver) {
		if (property === LEGACY_SESSION_KEY_COMPAT) return true;
		const value = Reflect.get(target, property, receiver);
		if (typeof value !== "function") return value;
		if (!isSessionKeyCompatMethodName(property)) return value.bind(target);
		return (params) => {
			const method = value.bind(target);
			const allowedKeys = LEGACY_COMPAT_METHOD_KEYS[property];
			if (isLegacy && allowedKeys.some((key) => rejectedKeys.has(key) && hasOwnLegacyCompatKey(params, key))) return method(withoutLegacyCompatKeys(params, rejectedKeys));
			return invokeWithLegacyCompat(method, params, allowedKeys, {
				onLegacyModeDetected: () => {
					isLegacy = true;
				},
				onLegacyKeysDetected: (keys) => {
					for (const key of keys) rejectedKeys.add(key);
				},
				rejectedKeys
			});
		};
	} });
}
const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");
const CORE_CONTEXT_ENGINE_OWNER = "core";
const PUBLIC_CONTEXT_ENGINE_OWNER = "public-sdk";
const contextEngineRegistryState = resolveGlobalSingleton(CONTEXT_ENGINE_REGISTRY_STATE, () => ({ engines: /* @__PURE__ */ new Map() }));
function getContextEngineRegistryState() {
	return contextEngineRegistryState;
}
function requireContextEngineOwner(owner) {
	const normalizedOwner = owner.trim();
	if (!normalizedOwner) throw new Error(`registerContextEngineForOwner: owner must be a non-empty string, got ${JSON.stringify(owner)}`);
	return normalizedOwner;
}
/**
* Register a context engine implementation under an explicit trusted owner.
*/
function registerContextEngineForOwner(id, factory, owner, opts) {
	const normalizedOwner = requireContextEngineOwner(owner);
	const registry = getContextEngineRegistryState().engines;
	const existing = registry.get(id);
	if (id === defaultSlotIdForKey("contextEngine") && normalizedOwner !== CORE_CONTEXT_ENGINE_OWNER) return {
		ok: false,
		existingOwner: CORE_CONTEXT_ENGINE_OWNER
	};
	if (existing && existing.owner !== normalizedOwner) return {
		ok: false,
		existingOwner: existing.owner
	};
	if (existing && opts?.allowSameOwnerRefresh !== true) return {
		ok: false,
		existingOwner: existing.owner
	};
	registry.set(id, {
		factory,
		owner: normalizedOwner
	});
	return { ok: true };
}
/**
* Public SDK entry point for third-party registrations.
*
* This path is intentionally unprivileged: it cannot claim core-owned ids and
* it cannot safely refresh an existing registration because the caller's
* identity is not authenticated.
*/
function registerContextEngine(id, factory) {
	return registerContextEngineForOwner(id, factory, PUBLIC_CONTEXT_ENGINE_OWNER);
}
/**
* List all registered engine ids.
*/
function listContextEngineIds() {
	return [...getContextEngineRegistryState().engines.keys()];
}
function clearContextEnginesForOwner(owner) {
	const normalizedOwner = requireContextEngineOwner(owner);
	const registry = getContextEngineRegistryState().engines;
	for (const [id, entry] of registry.entries()) if (entry.owner === normalizedOwner) registry.delete(id);
}
function describeResolvedContextEngineContractError(engineId, engine) {
	if (!engine || typeof engine !== "object") return `Context engine "${engineId}" factory returned ${JSON.stringify(engine)} instead of a ContextEngine object.`;
	const candidate = engine;
	const issues = [];
	const info = candidate.info;
	if (!info || typeof info !== "object") issues.push("missing info");
	else {
		const infoRecord = info;
		if (!(typeof infoRecord.id === "string" ? infoRecord.id.trim() : "")) issues.push("missing info.id");
		if (typeof infoRecord.name !== "string" || !infoRecord.name.trim()) issues.push("missing info.name");
	}
	if (typeof candidate.ingest !== "function") issues.push("missing ingest()");
	if (typeof candidate.assemble !== "function") issues.push("missing assemble()");
	if (typeof candidate.compact !== "function") issues.push("missing compact()");
	if (issues.length === 0) return null;
	return `Context engine "${engineId}" factory returned an invalid ContextEngine: ${issues.join(", ")}.`;
}
/**
* Resolve which ContextEngine to use based on plugin slot configuration.
*
* Resolution order:
*   1. `config.plugins.slots.contextEngine` (explicit slot override)
*   2. Default slot value ("legacy")
*
* When `config` is provided it is forwarded to the factory as part of a
* {@link ContextEngineFactoryContext}. Additional runtime paths can be
* supplied via `options`. Existing no-arg factories continue to work
* because JavaScript permits extra arguments at call sites.
*
* Non-default engines that fail (unregistered, factory throw, or contract
* violation) are logged and silently replaced by the default engine.
* Throws only when the default engine itself cannot be resolved.
*/
async function resolveContextEngine(config, options) {
	const slotValue = config?.plugins?.slots?.contextEngine;
	const engineId = typeof slotValue === "string" && slotValue.trim() ? slotValue.trim() : defaultSlotIdForKey("contextEngine");
	const defaultEngineId = defaultSlotIdForKey("contextEngine");
	const isDefaultEngine = engineId === defaultEngineId;
	const factoryCtx = {
		config,
		agentDir: options?.agentDir,
		workspaceDir: options?.workspaceDir
	};
	const entry = getContextEngineRegistryState().engines.get(engineId);
	if (!entry) {
		if (isDefaultEngine) throw new Error(`Context engine "${engineId}" is not registered. Available engines: ${listContextEngineIds().join(", ") || "(none)"}`);
		console.error(`[context-engine] Context engine "${sanitizeForLog(engineId)}" is not registered; falling back to default engine "${defaultEngineId}".`);
		return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
	}
	let engine;
	try {
		engine = await entry.factory(factoryCtx);
	} catch (factoryError) {
		if (isDefaultEngine) throw factoryError;
		console.error(`[context-engine] Context engine "${sanitizeForLog(engineId)}" factory threw during resolution: ${sanitizeForLog(factoryError instanceof Error ? factoryError.message : String(factoryError))}; falling back to default engine "${defaultEngineId}".`);
		return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
	}
	let contractError;
	try {
		contractError = describeResolvedContextEngineContractError(engineId, engine);
	} catch (validationError) {
		if (isDefaultEngine) throw validationError;
		console.error(`[context-engine] Context engine "${sanitizeForLog(engineId)}" contract validation threw: ${sanitizeForLog(validationError instanceof Error ? validationError.message : String(validationError))}; falling back to default engine "${defaultEngineId}".`);
		return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
	}
	if (contractError) {
		if (isDefaultEngine) throw new Error(contractError);
		console.error(`[context-engine] ${sanitizeForLog(contractError)}; falling back to default engine "${defaultEngineId}".`);
		return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
	}
	return wrapContextEngineWithSessionKeyCompat(engine);
}
/**
* Resolve the default context engine as a last-resort fallback.
*
* This helper is intentionally strict: if the default engine itself fails,
* there is no further fallback and the error must propagate.
*/
async function resolveDefaultContextEngine(defaultEngineId, factoryCtx) {
	const defaultEntry = getContextEngineRegistryState().engines.get(defaultEngineId);
	if (!defaultEntry) throw new Error(`[context-engine] fallback failed: default engine "${defaultEngineId}" is not registered. Available engines: ${listContextEngineIds().join(", ") || "(none)"}`);
	const engine = await defaultEntry.factory(factoryCtx);
	const contractError = describeResolvedContextEngineContractError(defaultEngineId, engine);
	if (contractError) throw new Error(`[context-engine] ${contractError}`);
	return wrapContextEngineWithSessionKeyCompat(engine);
}
//#endregion
export { resolveContextEngine as i, registerContextEngine as n, registerContextEngineForOwner as r, clearContextEnginesForOwner as t };
