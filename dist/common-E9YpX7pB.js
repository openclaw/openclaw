import { r as lowercasePreservingWhitespace } from "./string-coerce-DyL154ka.js";
import "./fs-safe-CV86zY9G.js";
import { i as readLocalFileSafely } from "./secure-temp-dir-aidxCRgA.js";
import { n as detectMime } from "./mime-DppuT-pZ.js";
import { r as sanitizeToolResultImages } from "./tool-images-Cv3ZnK02.js";
//#region src/param-key.ts
function toSnakeCaseKey(key) {
	return lowercasePreservingWhitespace(key.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}
function resolveSnakeCaseParamKey(params, key) {
	if (Object.hasOwn(params, key)) return key;
	const snakeKey = toSnakeCaseKey(key);
	if (snakeKey !== key && Object.hasOwn(params, snakeKey)) return snakeKey;
}
function readSnakeCaseParamRaw(params, key) {
	const resolvedKey = resolveSnakeCaseParamKey(params, key);
	if (resolvedKey) return params[resolvedKey];
}
//#endregion
//#region src/agents/tools/common.ts
function asToolParamsRecord(params) {
	return params && typeof params === "object" && !Array.isArray(params) ? params : {};
}
var ToolInputError = class extends Error {
	constructor(message) {
		super(message);
		this.status = 400;
		this.name = "ToolInputError";
	}
};
var ToolAuthorizationError = class extends ToolInputError {
	constructor(message) {
		super(message);
		this.status = 403;
		this.name = "ToolAuthorizationError";
	}
};
function createActionGate(actions) {
	return (key, defaultValue = true) => {
		const value = actions?.[key];
		if (value === void 0) return defaultValue;
		return value !== false;
	};
}
function readParamRaw(params, key) {
	return readSnakeCaseParamRaw(params, key);
}
function readStringParam(params, key, options = {}) {
	const { required = false, trim = true, label = key, allowEmpty = false } = options;
	const raw = readParamRaw(params, key);
	if (typeof raw !== "string") {
		if (required) throw new ToolInputError(`${label} required`);
		return;
	}
	const value = trim ? raw.trim() : raw;
	if (!value && !allowEmpty) {
		if (required) throw new ToolInputError(`${label} required`);
		return;
	}
	return value;
}
/**
* Normalize tool model override input.
* - empty/whitespace => undefined
* - "default" (case-insensitive) => undefined (sentinel: reset/fallback)
* - otherwise returns trimmed explicit model string
*/
function normalizeToolModelOverride(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (!trimmed || trimmed.toLowerCase() === "default") return;
	return trimmed;
}
function readStringOrNumberParam(params, key, options = {}) {
	const { required = false, label = key } = options;
	const raw = readParamRaw(params, key);
	if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
	if (typeof raw === "string") {
		const value = raw.trim();
		if (value) return value;
	}
	if (required) throw new ToolInputError(`${label} required`);
}
function readNumberParam(params, key, options = {}) {
	const { required = false, label = key, integer = false, strict = false } = options;
	const raw = readParamRaw(params, key);
	let value;
	if (typeof raw === "number" && Number.isFinite(raw)) value = raw;
	else if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed) {
			const parsed = strict ? Number(trimmed) : Number.parseFloat(trimmed);
			if (Number.isFinite(parsed)) value = parsed;
		}
	}
	if (value === void 0) {
		if (required) throw new ToolInputError(`${label} required`);
		return;
	}
	return integer ? Math.trunc(value) : value;
}
function readStringArrayParam(params, key, options = {}) {
	const { required = false, label = key } = options;
	const raw = readParamRaw(params, key);
	if (Array.isArray(raw)) {
		const values = raw.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
		if (values.length === 0) {
			if (required) throw new ToolInputError(`${label} required`);
			return;
		}
		return values;
	}
	if (typeof raw === "string") {
		const value = raw.trim();
		if (!value) {
			if (required) throw new ToolInputError(`${label} required`);
			return;
		}
		return [value];
	}
	if (required) throw new ToolInputError(`${label} required`);
}
function readReactionParams(params, options) {
	const emojiKey = options.emojiKey ?? "emoji";
	const removeKey = options.removeKey ?? "remove";
	const remove = typeof params[removeKey] === "boolean" ? params[removeKey] : false;
	const emoji = readStringParam(params, emojiKey, {
		required: true,
		allowEmpty: true
	});
	if (remove && !emoji) throw new ToolInputError(options.removeErrorMessage);
	return {
		emoji,
		remove,
		isEmpty: !emoji
	};
}
function stringifyToolPayload(payload) {
	if (typeof payload === "string") return payload;
	try {
		const encoded = JSON.stringify(payload, null, 2);
		if (typeof encoded === "string") return encoded;
	} catch {}
	return String(payload);
}
function textResult(text, details) {
	return {
		content: [{
			type: "text",
			text
		}],
		details
	};
}
function failedTextResult(text, details) {
	return textResult(text, details);
}
function payloadTextResult(payload) {
	return textResult(stringifyToolPayload(payload), payload);
}
function jsonResult(payload) {
	return textResult(JSON.stringify(payload, null, 2), payload);
}
async function imageResult(params) {
	const content = [...params.extraText ? [{
		type: "text",
		text: params.extraText
	}] : [], {
		type: "image",
		data: params.base64,
		mimeType: params.mimeType
	}];
	const detailsMedia = params.details?.media && typeof params.details.media === "object" && !Array.isArray(params.details.media) ? params.details.media : void 0;
	return await sanitizeToolResultImages({
		content,
		details: {
			path: params.path,
			...params.details,
			media: {
				...detailsMedia,
				mediaUrl: params.path
			}
		}
	}, params.label, params.imageSanitization);
}
async function imageResultFromFile(params) {
	const buf = (await readLocalFileSafely({ filePath: params.path })).buffer;
	const mimeType = await detectMime({ buffer: buf.slice(0, 256) }) ?? "image/png";
	return await imageResult({
		label: params.label,
		path: params.path,
		base64: buf.toString("base64"),
		mimeType,
		extraText: params.extraText,
		details: params.details,
		imageSanitization: params.imageSanitization
	});
}
/**
* Validate and parse an `availableTags` parameter from untrusted input.
* Returns `undefined` when the value is missing or not an array.
* Entries that lack a string `name` are silently dropped.
*/
function parseAvailableTags(raw) {
	if (raw === void 0 || raw === null) return;
	if (!Array.isArray(raw)) return;
	const result = raw.filter((t) => typeof t === "object" && t !== null && typeof t.name === "string").map((t) => Object.assign({}, t.id !== void 0 && typeof t.id === `string` ? { id: t.id } : {}, { name: t.name }, typeof t.moderated === `boolean` ? { moderated: t.moderated } : {}, t.emoji_id === null || typeof t.emoji_id === `string` ? { emoji_id: t.emoji_id } : {}, t.emoji_name === null || typeof t.emoji_name === `string` ? { emoji_name: t.emoji_name } : {}));
	return result.length ? result : void 0;
}
//#endregion
export { stringifyToolPayload as _, failedTextResult as a, resolveSnakeCaseParamKey as b, jsonResult as c, payloadTextResult as d, readNumberParam as f, readStringParam as g, readStringOrNumberParam as h, createActionGate as i, normalizeToolModelOverride as l, readStringArrayParam as m, ToolInputError as n, imageResult as o, readReactionParams as p, asToolParamsRecord as r, imageResultFromFile as s, ToolAuthorizationError as t, parseAvailableTags as u, textResult as v, readSnakeCaseParamRaw as y };
