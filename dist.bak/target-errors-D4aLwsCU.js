import { c as detectMime } from "./image-ops-Z3_QkQPj.js";
import { r as sanitizeToolResultImages } from "./tool-images-0PIXjd8w.js";
import fs from "node:fs/promises";

//#region src/agents/tools/common.ts
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
function toSnakeCaseKey(key) {
	return key.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
function readParamRaw(params, key) {
	if (Object.hasOwn(params, key)) return params[key];
	const snakeKey = toSnakeCaseKey(key);
	if (snakeKey !== key && Object.hasOwn(params, snakeKey)) return params[snakeKey];
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
	const { required = false, label = key, integer = false } = options;
	const raw = readParamRaw(params, key);
	let value;
	if (typeof raw === "number" && Number.isFinite(raw)) value = raw;
	else if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed) {
			const parsed = Number.parseFloat(trimmed);
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
function jsonResult(payload) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(payload, null, 2)
		}],
		details: payload
	};
}
async function imageResult(params) {
	return await sanitizeToolResultImages({
		content: [{
			type: "text",
			text: params.extraText ?? `MEDIA:${params.path}`
		}, {
			type: "image",
			data: params.base64,
			mimeType: params.mimeType
		}],
		details: {
			path: params.path,
			...params.details
		}
	}, params.label, params.imageSanitization);
}
async function imageResultFromFile(params) {
	const buf = await fs.readFile(params.path);
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
	const result = raw.filter((t) => typeof t === "object" && t !== null && typeof t.name === "string").map((t) => ({
		...t.id !== void 0 && typeof t.id === "string" ? { id: t.id } : {},
		name: t.name,
		...typeof t.moderated === "boolean" ? { moderated: t.moderated } : {},
		...t.emoji_id === null || typeof t.emoji_id === "string" ? { emoji_id: t.emoji_id } : {},
		...t.emoji_name === null || typeof t.emoji_name === "string" ? { emoji_name: t.emoji_name } : {}
	}));
	return result.length ? result : void 0;
}

//#endregion
//#region src/infra/outbound/target-errors.ts
function missingTargetMessage(provider, hint) {
	return `Delivering to ${provider} requires target${formatTargetHint(hint)}`;
}
function missingTargetError(provider, hint) {
	return new Error(missingTargetMessage(provider, hint));
}
function ambiguousTargetMessage(provider, raw, hint) {
	return `Ambiguous target "${raw}" for ${provider}. Provide a unique name or an explicit id.${formatTargetHint(hint, true)}`;
}
function ambiguousTargetError(provider, raw, hint) {
	return new Error(ambiguousTargetMessage(provider, raw, hint));
}
function unknownTargetMessage(provider, raw, hint) {
	return `Unknown target "${raw}" for ${provider}.${formatTargetHint(hint, true)}`;
}
function unknownTargetError(provider, raw, hint) {
	return new Error(unknownTargetMessage(provider, raw, hint));
}
function formatTargetHint(hint, withLabel = false) {
	if (!hint) return "";
	return withLabel ? ` Hint: ${hint}` : ` ${hint}`;
}

//#endregion
export { ToolInputError as a, imageResultFromFile as c, readNumberParam as d, readReactionParams as f, readStringParam as h, ToolAuthorizationError as i, jsonResult as l, readStringOrNumberParam as m, missingTargetError as n, createActionGate as o, readStringArrayParam as p, unknownTargetError as r, imageResult as s, ambiguousTargetError as t, parseAvailableTags as u };