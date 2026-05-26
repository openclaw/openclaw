import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { n as hasSensitiveUrlHintTag, o as redactSensitiveUrlLikeString, r as isSensitiveUrlConfigPath } from "./redact-sensitive-url-NNYIE41N.js";
import { n as redactSecretRefId, t as isSecretRefShape } from "./redact-snapshot.secret-ref-BZAKAmBO.js";
import JSON5 from "json5";
import { isDeepStrictEqual } from "node:util";
//#region src/config/redact-snapshot.raw.ts
function replaceSensitiveValuesInRaw(params) {
	const values = [...new Set(params.sensitiveValues)].filter((value) => value !== "").toSorted((a, b) => b.length - a.length);
	let result = params.raw;
	for (const value of values) result = result.replaceAll(value, params.redactedSentinel);
	return result;
}
function shouldFallbackToStructuredRawRedaction(params) {
	try {
		const parsed = JSON5.parse(params.redactedRaw);
		const restored = params.restoreParsed(parsed);
		if (!restored.ok) return true;
		return !isDeepStrictEqual(restored.result, params.originalConfig);
	} catch {
		return true;
	}
}
//#endregion
//#region src/config/sensitive-paths.ts
const NORMALIZED_SENSITIVE_KEY_WHITELIST_SUFFIXES = [
	"maxtokens",
	"maxoutputtokens",
	"maxinputtokens",
	"maxcompletiontokens",
	"contexttokens",
	"totaltokens",
	"tokencount",
	"tokenlimit",
	"tokenbudget",
	"passwordFile"
].map((suffix) => normalizeLowercaseStringOrEmpty(suffix));
const SENSITIVE_PATTERNS = [
	/token$/i,
	/password/i,
	/secret/i,
	/api.?key/i,
	/encrypt.?key/i,
	/private.?key/i,
	/serviceaccount(?:ref)?$/i
];
function isWhitelistedSensitivePath(path) {
	const lowerPath = normalizeLowercaseStringOrEmpty(path);
	return NORMALIZED_SENSITIVE_KEY_WHITELIST_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix));
}
function matchesSensitivePattern(path) {
	return SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));
}
function isLocalServiceEnvValuePath(path) {
	return normalizeLowercaseStringOrEmpty(path).includes("localservice.env.");
}
function isSensitiveConfigPath(path) {
	return isLocalServiceEnvValuePath(path) || !isWhitelistedSensitivePath(path) && matchesSensitivePattern(path);
}
//#endregion
//#region src/config/redact-snapshot.ts
const log = createSubsystemLogger("config/redaction");
const ENV_VAR_PLACEHOLDER_PATTERN = /^\$\{[^}]*\}$/;
function isSensitivePath(path) {
	if (path.endsWith("[]")) return isSensitiveConfigPath(path.slice(0, -2));
	return isSensitiveConfigPath(path);
}
function isEnvVarPlaceholder(value) {
	return ENV_VAR_PLACEHOLDER_PATTERN.test(value.trim());
}
function isWholeObjectSensitivePath(path) {
	const lowered = normalizeLowercaseStringOrEmpty(path);
	return lowered.endsWith("serviceaccount") || lowered.endsWith("serviceaccountref");
}
function isSensitiveUrlPath(path) {
	return isSensitiveUrlConfigPath(path);
}
function hasSensitiveUrlHintPath(hints, paths) {
	if (!hints) return false;
	return paths.some((path) => hasSensitiveUrlHintTag(hints[path]));
}
function isObjectRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function collectSensitiveStrings(value, values) {
	if (typeof value === "string") {
		if (!isEnvVarPlaceholder(value)) values.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectSensitiveStrings(item, values);
		return;
	}
	if (isObjectRecord(value)) {
		const obj = value;
		if (isSecretRefShape(obj)) {
			if (!isEnvVarPlaceholder(obj.id)) values.push(obj.id);
			return;
		}
		for (const item of Object.values(obj)) collectSensitiveStrings(item, values);
	}
}
function isExplicitlyNonSensitivePath(hints, paths) {
	if (!hints) return false;
	return paths.some((path) => hints[path]?.sensitive === false);
}
/**
* Sentinel value used to replace sensitive config fields in gateway responses.
* Write-side handlers (config.set, config.apply, config.patch) detect this
* sentinel and restore the original value from the on-disk config, so a
* round-trip through the Web UI does not corrupt credentials.
*/
const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";
function isSecretRefWithProvider(value) {
	return isSecretRefShape(value) && typeof value.provider === "string";
}
function buildRedactionLookup(hints) {
	let result = /* @__PURE__ */ new Set();
	for (const [path, hint] of Object.entries(hints)) {
		if (!hint.sensitive) continue;
		const parts = path.split(".");
		let joinedPath = parts.shift() ?? "";
		result.add(joinedPath);
		if (joinedPath.endsWith("[]")) result.add(joinedPath.slice(0, -2));
		for (const part of parts) {
			if (part.endsWith("[]")) result.add(`${joinedPath}.${part.slice(0, -2)}`);
			joinedPath = `${joinedPath}.${part}`;
			result.add(joinedPath);
		}
	}
	if (result.size !== 0) result.add("");
	return result;
}
function redactObject(obj, hints) {
	if (hints) {
		const lookup = buildRedactionLookup(hints);
		return lookup.has("") ? redactObjectWithLookup(obj, lookup, "", [], hints) : redactObjectGuessing(obj, "", [], hints);
	}
	return redactObjectGuessing(obj, "", []);
}
/**
* Collect all sensitive string values from a config object.
* Used for text-based redaction of the raw JSON5 source.
*/
function collectSensitiveValues(obj, hints) {
	const result = [];
	if (hints) {
		const lookup = buildRedactionLookup(hints);
		if (lookup.has("")) redactObjectWithLookup(obj, lookup, "", result, hints);
		else redactObjectGuessing(obj, "", result, hints);
	} else redactObjectGuessing(obj, "", result);
	return result;
}
/**
* Worker for redactObject() and collectSensitiveValues().
* Used when there are ConfigUiHints available.
*/
function redactObjectWithLookup(obj, lookup, prefix, values, hints) {
	if (obj === null || obj === void 0) return obj;
	if (Array.isArray(obj)) {
		const path = `${prefix}[]`;
		if (!lookup.has(path)) return redactObjectGuessing(obj, prefix, values, hints);
		return obj.map((item) => {
			if (typeof item === "string" && !isEnvVarPlaceholder(item)) {
				values.push(item);
				return REDACTED_SENTINEL;
			}
			return redactObjectWithLookup(item, lookup, path, values, hints);
		});
	}
	if (isObjectRecord(obj)) {
		const result = {};
		for (const [key, value] of Object.entries(obj)) {
			const path = prefix ? `${prefix}.${key}` : key;
			const wildcardPath = prefix ? `${prefix}.*` : "*";
			let matched = false;
			for (const candidate of [path, wildcardPath]) {
				result[key] = value;
				if (lookup.has(candidate)) {
					matched = true;
					if (typeof value === "string" && !isEnvVarPlaceholder(value)) {
						result[key] = REDACTED_SENTINEL;
						values.push(value);
					} else if (typeof value === "object" && value !== null) if (hints[candidate]?.sensitive === true && !Array.isArray(value)) {
						const objectValue = toObjectRecord(value);
						if (isSecretRefShape(objectValue)) result[key] = redactSecretRefId({
							value: objectValue,
							values,
							redactedSentinel: REDACTED_SENTINEL,
							isEnvVarPlaceholder
						});
						else {
							collectSensitiveStrings(objectValue, values);
							result[key] = REDACTED_SENTINEL;
						}
					} else result[key] = redactObjectWithLookup(value, lookup, candidate, values, hints);
					else if (hints[candidate]?.sensitive === true && value !== void 0 && value !== null) result[key] = REDACTED_SENTINEL;
					else if (typeof value === "string" && (hasSensitiveUrlHintPath(hints, [
						candidate,
						path,
						wildcardPath
					]) || isSensitiveUrlPath(path))) if (redactSensitiveUrlLikeString(value) !== value) {
						values.push(value);
						result[key] = REDACTED_SENTINEL;
					} else result[key] = value;
					break;
				}
			}
			if (!matched) {
				const markedNonSensitive = isExplicitlyNonSensitivePath(hints, [path, wildcardPath]);
				if (typeof value === "string" && !markedNonSensitive && isSensitivePath(path) && !isEnvVarPlaceholder(value)) {
					result[key] = REDACTED_SENTINEL;
					values.push(value);
				} else if (typeof value === "string" && (hasSensitiveUrlHintPath(hints, [path, wildcardPath]) || isSensitiveUrlPath(path))) if (redactSensitiveUrlLikeString(value) !== value) {
					values.push(value);
					result[key] = REDACTED_SENTINEL;
				} else result[key] = value;
				else if (typeof value === "object" && value !== null) result[key] = redactObjectGuessing(value, path, values, hints);
			}
		}
		return result;
	}
	return obj;
}
/**
* Worker for redactObject() and collectSensitiveValues().
* Used when ConfigUiHints are NOT available.
*/
function redactObjectGuessing(obj, prefix, values, hints) {
	if (obj === null || obj === void 0) return obj;
	if (Array.isArray(obj)) return obj.map((item) => {
		const path = `${prefix}[]`;
		if (!isExplicitlyNonSensitivePath(hints, [path]) && isSensitivePath(path) && typeof item === "string" && !isEnvVarPlaceholder(item)) {
			values.push(item);
			return REDACTED_SENTINEL;
		}
		return redactObjectGuessing(item, path, values, hints);
	});
	if (isObjectRecord(obj)) {
		const result = {};
		for (const [key, value] of Object.entries(obj)) {
			const dotPath = prefix ? `${prefix}.${key}` : key;
			const wildcardPath = prefix ? `${prefix}.*` : "*";
			if (!isExplicitlyNonSensitivePath(hints, [dotPath, wildcardPath]) && isSensitivePath(dotPath) && typeof value === "string" && !isEnvVarPlaceholder(value)) {
				result[key] = REDACTED_SENTINEL;
				values.push(value);
			} else if (!isExplicitlyNonSensitivePath(hints, [dotPath, wildcardPath]) && isSensitivePath(dotPath) && isWholeObjectSensitivePath(dotPath) && value && typeof value === "object" && !Array.isArray(value)) {
				collectSensitiveStrings(value, values);
				result[key] = REDACTED_SENTINEL;
			} else if (typeof value === "string" && (hasSensitiveUrlHintPath(hints, [dotPath, wildcardPath]) || isSensitiveUrlPath(dotPath))) if (redactSensitiveUrlLikeString(value) !== value) {
				values.push(value);
				result[key] = REDACTED_SENTINEL;
			} else result[key] = value;
			else if (typeof value === "object" && value !== null) result[key] = redactObjectGuessing(value, dotPath, values, hints);
			else result[key] = value;
		}
		return result;
	}
	return obj;
}
/**
* Replace known sensitive values in a raw JSON5 string with the sentinel.
* Values are replaced longest-first to avoid partial matches.
*/
function redactRawText(raw, config, hints) {
	return replaceSensitiveValuesInRaw({
		raw,
		sensitiveValues: collectSensitiveValues(config, hints),
		redactedSentinel: REDACTED_SENTINEL
	});
}
let suppressRestoreWarnings = false;
function withRestoreWarningsSuppressed(fn) {
	const prev = suppressRestoreWarnings;
	suppressRestoreWarnings = true;
	try {
		return fn();
	} finally {
		suppressRestoreWarnings = prev;
	}
}
/**
* Returns a copy of the config snapshot with all sensitive fields
* replaced by {@link REDACTED_SENTINEL}. The `hash` is preserved
* (it tracks config identity, not content).
*
* Both `config` (the parsed object) and `raw` (the JSON5 source) are scrubbed
* so no credential can leak through either path.
*
* When `uiHints` are provided, sensitivity is determined from the schema hints.
* Without hints, falls back to regex-based detection via `isSensitivePath()`.
*/
/**
* Redact sensitive fields from a plain config object (not a full snapshot).
* Used by write endpoints (config.set, config.patch, config.apply) to avoid
* leaking credentials in their responses.
*/
function redactConfigObject(value, uiHints) {
	return redactObject(value, uiHints);
}
function redactConfigSnapshot(snapshot, uiHints) {
	if (!snapshot.valid) {
		const redactedConfig = {};
		const redactedResolved = {};
		return {
			...snapshot,
			sourceConfig: redactedResolved,
			runtimeConfig: redactedConfig,
			config: redactedConfig,
			raw: null,
			parsed: null,
			resolved: redactedResolved
		};
	}
	const redactedConfig = redactObject(snapshot.config, uiHints);
	const redactedParsed = snapshot.parsed ? redactObject(snapshot.parsed, uiHints) : snapshot.parsed;
	let redactedRaw = snapshot.raw ? redactRawText(snapshot.raw, snapshot.config, uiHints) : null;
	if (redactedRaw && shouldFallbackToStructuredRawRedaction({
		redactedRaw,
		originalConfig: snapshot.config,
		restoreParsed: (parsed) => withRestoreWarningsSuppressed(() => restoreRedactedValues(parsed, snapshot.config, uiHints))
	})) redactedRaw = null;
	const redactedResolved = redactConfigObject(snapshot.resolved, uiHints);
	const { pluginMetadataSnapshot: _pluginMetadataSnapshot, ...publicSnapshot } = snapshot;
	return {
		...publicSnapshot,
		sourceConfig: redactedResolved,
		runtimeConfig: redactedConfig,
		config: redactedConfig,
		raw: redactedRaw,
		parsed: redactedParsed,
		resolved: redactedResolved
	};
}
/**
* Deep-walk `incoming` and replace any {@link REDACTED_SENTINEL} values
* (on sensitive paths) with the corresponding value from `original`.
*
* This is called by config.set / config.apply / config.patch before writing,
* so that credentials survive a Web UI round-trip unmodified.
*/
function restoreRedactedValues(incoming, original, hints) {
	if (incoming === null || incoming === void 0) return {
		ok: false,
		error: "no input"
	};
	if (typeof incoming !== "object") return {
		ok: false,
		error: "input not an object"
	};
	try {
		let restored;
		if (hints) {
			const lookup = buildRedactionLookup(hints);
			if (lookup.has("")) restored = restoreRedactedValuesWithLookup(incoming, original, lookup, "", hints);
			else restored = restoreRedactedValuesGuessing(incoming, original, "", hints);
		} else restored = restoreRedactedValuesGuessing(incoming, original, "");
		assertNoRedactedSentinel(restored, "");
		return {
			ok: true,
			result: restored
		};
	} catch (err) {
		if (err instanceof RedactionError) return {
			ok: false,
			humanReadableMessage: err.humanReadableMessage
		};
		throw err;
	}
}
var RedactionError = class extends Error {
	constructor(key, humanReadableMessage) {
		super("internal error class---should never escape");
		this.key = key;
		this.humanReadableMessage = humanReadableMessage ?? `Sentinel value "__OPENCLAW_REDACTED__" in key ${key} is not valid as real data`;
		this.name = "RedactionError";
	}
};
function restoreOriginalValueOrThrow(params) {
	if (params.key in params.original) return params.original[params.key];
	if (!suppressRestoreWarnings) log.warn(`Cannot un-redact config key ${params.path} as it doesn't have any value`);
	throw new RedactionError(params.path);
}
function assertNoRedactedSentinel(value, path) {
	if (typeof value === "string" && value === "__OPENCLAW_REDACTED__") {
		const pathLabel = path || "<root>";
		throw new RedactionError(pathLabel, `Reserved redaction sentinel "${REDACTED_SENTINEL}" is not valid config data (${pathLabel}).`);
	}
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			const nextPath = path ? `${path}[${index}]` : `[${index}]`;
			assertNoRedactedSentinel(value[index], nextPath);
		}
		return;
	}
	if (isObjectRecord(value)) for (const [key, item] of Object.entries(value)) assertNoRedactedSentinel(item, path ? `${path}.${key}` : key);
}
function maybeRestoreSecretRefId(params) {
	const incomingObj = toObjectRecord(params.incoming);
	if (!isSecretRefShape(incomingObj) || incomingObj.id !== "__OPENCLAW_REDACTED__") return { handled: false };
	const originalObj = toObjectRecord(params.original);
	if (!isSecretRefWithProvider(originalObj)) {
		if (isSecretRefShape(originalObj)) throw new RedactionError(params.path, `SecretRef at ${params.path} requires a provider field to restore the redacted id automatically (original ref lacks provider).`);
		throw new RedactionError(params.path, `SecretRef at ${params.path} contains a redacted id placeholder with no matching original value.`);
	}
	if (!isSecretRefWithProvider(incomingObj)) throw new RedactionError(params.path, `SecretRef at ${params.path} must include source, provider, and id when redacted placeholders are present.`);
	if (incomingObj.source !== originalObj.source || incomingObj.provider !== originalObj.provider) throw new RedactionError(params.path, `SecretRef at ${params.path} changed source/provider while id is redacted. Provide an explicit id when changing source/provider.`);
	return {
		handled: true,
		value: {
			...incomingObj,
			id: originalObj.id
		}
	};
}
function mapRedactedArray(params) {
	const originalArray = Array.isArray(params.original) ? params.original : [];
	if (params.incoming.length < originalArray.length) log.warn(`Redacted config array key ${params.path} has been truncated`);
	return params.incoming.map((item, index) => params.mapItem(item, index, originalArray));
}
function toObjectRecord(value) {
	return isObjectRecord(value) ? value : {};
}
function shouldPassThroughRestoreValue(incoming) {
	return incoming === null || incoming === void 0 || typeof incoming !== "object";
}
function toRestoreArrayContext(incoming, prefix) {
	if (!Array.isArray(incoming)) return null;
	return {
		incoming,
		path: `${prefix}[]`
	};
}
function restoreArrayItemWithLookup(params) {
	if (params.item === "__OPENCLAW_REDACTED__") return params.originalArray[params.index];
	return restoreRedactedValuesWithLookup(params.item, params.originalArray[params.index], params.lookup, params.path, params.hints);
}
function restoreArrayItemWithGuessing(params) {
	if (!isExplicitlyNonSensitivePath(params.hints, [params.path]) && isSensitivePath(params.path) && params.item === "__OPENCLAW_REDACTED__") return params.originalArray[params.index];
	return restoreRedactedValuesGuessing(params.item, params.originalArray[params.index], params.path, params.hints);
}
function restoreGuessingArray(incoming, original, path, hints) {
	return mapRedactedArray({
		incoming,
		original,
		path,
		mapItem: (item, index, originalArray) => restoreArrayItemWithGuessing({
			item,
			index,
			originalArray,
			path,
			hints
		})
	});
}
function shouldRestoreSensitiveGuessingPath(path, hintPaths, hints) {
	return !isExplicitlyNonSensitivePath(hints, hintPaths) && (isSensitivePath(path) || hasSensitiveUrlHintPath(hints, hintPaths) || isSensitiveUrlPath(path));
}
function restoreRedactedEntryGuessing(params) {
	const hintPaths = [params.path, params.wildcardPath];
	const canRestoreSecretRef = shouldRestoreSensitiveGuessingPath(params.path, hintPaths, params.hints);
	if (params.value === "__OPENCLAW_REDACTED__" && canRestoreSecretRef) return restoreOriginalValueOrThrow({
		key: params.key,
		path: params.path,
		original: params.original
	});
	if (typeof params.value === "object" && params.value !== null) {
		if (canRestoreSecretRef) {
			const restoredSecretRef = maybeRestoreSecretRefId({
				incoming: params.value,
				original: params.original[params.key],
				path: params.path
			});
			if (restoredSecretRef.handled) return restoredSecretRef.value;
		}
		return restoreRedactedValuesGuessing(params.value, params.original[params.key], params.path, params.hints);
	}
	return params.value;
}
/**
* Worker for restoreRedactedValues().
* Used when there are ConfigUiHints available.
*/
function restoreRedactedValuesWithLookup(incoming, original, lookup, prefix, hints) {
	if (shouldPassThroughRestoreValue(incoming)) return incoming;
	const arrayContext = toRestoreArrayContext(incoming, prefix);
	if (arrayContext) {
		const { incoming: incomingArray, path } = arrayContext;
		if (!lookup.has(path)) return restoreRedactedValuesGuessing(incomingArray, original, prefix, hints);
		return mapRedactedArray({
			incoming: incomingArray,
			original,
			path,
			mapItem: (item, index, originalArray) => restoreArrayItemWithLookup({
				item,
				index,
				originalArray,
				lookup,
				path,
				hints
			})
		});
	}
	const orig = toObjectRecord(original);
	const result = {};
	for (const [key, value] of Object.entries(toObjectRecord(incoming))) {
		result[key] = value;
		const path = prefix ? `${prefix}.${key}` : key;
		const wildcardPath = prefix ? `${prefix}.*` : "*";
		let matched = false;
		for (const candidate of [path, wildcardPath]) if (lookup.has(candidate)) {
			matched = true;
			if (value === "__OPENCLAW_REDACTED__" && (hints[candidate]?.sensitive === true || hasSensitiveUrlHintPath(hints, [
				candidate,
				path,
				wildcardPath
			]) || isSensitiveUrlPath(path))) result[key] = restoreOriginalValueOrThrow({
				key,
				path: candidate,
				original: orig
			});
			else if (typeof value === "object" && value !== null) {
				const restoredSecretRef = maybeRestoreSecretRefId({
					incoming: value,
					original: orig[key],
					path
				});
				result[key] = restoredSecretRef.handled ? restoredSecretRef.value : restoreRedactedValuesWithLookup(value, orig[key], lookup, candidate, hints);
			}
			break;
		}
		if (!matched) result[key] = restoreRedactedEntryGuessing({
			key,
			value,
			path,
			wildcardPath,
			original: orig,
			hints
		});
	}
	return result;
}
/**
* Worker for restoreRedactedValues().
* Used when ConfigUiHints are NOT available.
*/
function restoreRedactedValuesGuessing(incoming, original, prefix, hints) {
	if (shouldPassThroughRestoreValue(incoming)) return incoming;
	const arrayContext = toRestoreArrayContext(incoming, prefix);
	if (arrayContext) {
		const { incoming: incomingArray, path } = arrayContext;
		return restoreGuessingArray(incomingArray, original, path, hints);
	}
	const orig = toObjectRecord(original);
	const result = {};
	for (const [key, value] of Object.entries(toObjectRecord(incoming))) result[key] = restoreRedactedEntryGuessing({
		key,
		value,
		path: prefix ? `${prefix}.${key}` : key,
		wildcardPath: prefix ? `${prefix}.*` : "*",
		original: orig,
		hints
	});
	return result;
}
//#endregion
export { isSensitiveConfigPath as a, restoreRedactedValues as i, redactConfigObject as n, redactConfigSnapshot as r, REDACTED_SENTINEL as t };
