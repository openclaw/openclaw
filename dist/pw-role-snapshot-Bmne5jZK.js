import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { _ as INTERACTIVE_ROLES, g as CONTENT_ROLES, v as STRUCTURAL_ROLES } from "./chrome-BZjIEoo0.js";
//#region extensions/browser/src/browser/url-pattern.ts
function wildcardPatternToRegExp(pattern) {
	let source = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index] ?? "";
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				source += ".*";
				index += 1;
			} else source += "[^/]*";
			continue;
		}
		source += char.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&");
	}
	source += "$";
	return new RegExp(source, "u");
}
function matchBrowserUrlPattern(pattern, url) {
	const trimmedPattern = pattern.trim();
	if (!trimmedPattern) return false;
	if (trimmedPattern === url) return true;
	if (trimmedPattern === "*") return true;
	if (trimmedPattern.includes("*")) return wildcardPatternToRegExp(trimmedPattern).test(url);
	return url.includes(trimmedPattern);
}
//#endregion
//#region extensions/browser/src/browser/act-policy.ts
const ACT_MAX_CLICK_DELAY_MS = 5e3;
const ACT_MAX_WAIT_TIME_MS = 3e4;
const ACT_MIN_TIMEOUT_MS = 500;
const ACT_MAX_INTERACTION_TIMEOUT_MS = 6e4;
const ACT_MAX_WAIT_TIMEOUT_MS = 12e4;
const ACT_DEFAULT_INTERACTION_TIMEOUT_MS = 8e3;
const ACT_DEFAULT_WAIT_TIMEOUT_MS = 2e4;
function normalizeActBoundedNonNegativeMs(value, fieldName, maxMs) {
	if (value === void 0) return;
	if (!Number.isFinite(value) || value < 0) throw new Error(`${fieldName} must be >= 0`);
	const normalized = Math.floor(value);
	if (normalized > maxMs) throw new Error(`${fieldName} exceeds maximum of ${maxMs}ms`);
	return normalized;
}
function resolveActInteractionTimeoutMs(timeoutMs) {
	return Math.max(ACT_MIN_TIMEOUT_MS, Math.min(ACT_MAX_INTERACTION_TIMEOUT_MS, typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : ACT_DEFAULT_INTERACTION_TIMEOUT_MS));
}
function resolveActWaitTimeoutMs(timeoutMs) {
	return Math.max(ACT_MIN_TIMEOUT_MS, Math.min(ACT_MAX_WAIT_TIMEOUT_MS, typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : ACT_DEFAULT_WAIT_TIMEOUT_MS));
}
//#endregion
//#region extensions/browser/src/browser/form-fields.ts
const DEFAULT_FILL_FIELD_TYPE = "text";
function normalizeBrowserFormFieldRef(value) {
	return normalizeOptionalString(value) ?? "";
}
function normalizeBrowserFormFieldType(value) {
	return (normalizeOptionalString(value) ?? "") || "text";
}
function normalizeBrowserFormFieldValue(value) {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : void 0;
}
function normalizeBrowserFormField(record) {
	const ref = normalizeBrowserFormFieldRef(record.ref);
	if (!ref) return null;
	const type = normalizeBrowserFormFieldType(record.type);
	const value = normalizeBrowserFormFieldValue(record.value);
	return value === void 0 ? {
		ref,
		type
	} : {
		ref,
		type,
		value
	};
}
//#endregion
//#region extensions/browser/src/browser/pw-role-snapshot.ts
function getRoleSnapshotStats(snapshot, refs) {
	const interactive = Object.values(refs).filter((r) => INTERACTIVE_ROLES.has(r.role)).length;
	return {
		lines: snapshot.split("\n").length,
		chars: snapshot.length,
		refs: Object.keys(refs).length,
		interactive
	};
}
function getIndentLevel(line) {
	const match = line.match(/^(\s*)/);
	return match ? Math.floor(match[1].length / 2) : 0;
}
function matchInteractiveSnapshotLine(line, options) {
	const depth = getIndentLevel(line);
	if (options.maxDepth !== void 0 && depth > options.maxDepth) return null;
	const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/);
	if (!match) return null;
	const [, , roleRaw, name, suffix] = match;
	if (roleRaw.startsWith("/")) return null;
	return {
		roleRaw,
		role: normalizeLowercaseStringOrEmpty(roleRaw),
		...name ? { name } : {},
		suffix
	};
}
function createRoleNameTracker() {
	const counts = /* @__PURE__ */ new Map();
	const refsByKey = /* @__PURE__ */ new Map();
	return {
		counts,
		refsByKey,
		getKey(role, name) {
			return `${role}:${name ?? ""}`;
		},
		getNextIndex(role, name) {
			const key = this.getKey(role, name);
			const current = counts.get(key) ?? 0;
			counts.set(key, current + 1);
			return current;
		},
		trackRef(role, name, ref) {
			const key = this.getKey(role, name);
			const list = refsByKey.get(key) ?? [];
			list.push(ref);
			refsByKey.set(key, list);
		},
		getDuplicateKeys() {
			const out = /* @__PURE__ */ new Set();
			for (const [key, refs] of refsByKey) if (refs.length > 1) out.add(key);
			return out;
		}
	};
}
function removeNthFromNonDuplicates(refs, tracker) {
	const duplicates = tracker.getDuplicateKeys();
	for (const [ref, data] of Object.entries(refs)) {
		const key = tracker.getKey(data.role, data.name);
		if (!duplicates.has(key)) delete refs[ref]?.nth;
	}
}
function compactTree(tree) {
	const lines = tree.split("\n");
	const result = [];
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.includes("[ref=")) {
			result.push(line);
			continue;
		}
		if (line.includes(":") && !line.trimEnd().endsWith(":")) {
			result.push(line);
			continue;
		}
		const currentIndent = getIndentLevel(line);
		let hasRelevantChildren = false;
		for (let j = i + 1; j < lines.length; j += 1) {
			if (getIndentLevel(lines[j]) <= currentIndent) break;
			if (lines[j]?.includes("[ref=")) {
				hasRelevantChildren = true;
				break;
			}
		}
		if (hasRelevantChildren) result.push(line);
	}
	return result.join("\n");
}
function processLine(line, refs, options, tracker, nextRef) {
	const depth = getIndentLevel(line);
	if (options.maxDepth !== void 0 && depth > options.maxDepth) return null;
	const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/);
	if (!match) return options.interactive ? null : line;
	const [, prefix, roleRaw, name, suffix] = match;
	if (roleRaw.startsWith("/")) return options.interactive ? null : line;
	const role = normalizeLowercaseStringOrEmpty(roleRaw);
	const isInteractive = INTERACTIVE_ROLES.has(role);
	const isContent = CONTENT_ROLES.has(role);
	const isStructural = STRUCTURAL_ROLES.has(role);
	if (options.interactive && !isInteractive) return null;
	if (options.compact && isStructural && !name) return null;
	if (!(isInteractive || isContent && name)) return line;
	const ref = nextRef();
	const nth = tracker.getNextIndex(role, name);
	tracker.trackRef(role, name, ref);
	refs[ref] = {
		role,
		name,
		nth
	};
	let enhanced = `${prefix}${roleRaw}`;
	if (name) enhanced += ` "${name}"`;
	enhanced += ` [ref=${ref}]`;
	if (nth > 0) enhanced += ` [nth=${nth}]`;
	if (suffix) enhanced += suffix;
	return enhanced;
}
function buildInteractiveSnapshotLines(params) {
	const out = [];
	for (const line of params.lines) {
		const parsed = matchInteractiveSnapshotLine(line, params.options);
		if (!parsed) continue;
		if (!INTERACTIVE_ROLES.has(parsed.role)) continue;
		const resolved = params.resolveRef(parsed);
		if (!resolved?.ref) continue;
		params.recordRef(parsed, resolved.ref, resolved.nth);
		let enhanced = `- ${parsed.roleRaw}`;
		if (parsed.name) enhanced += ` "${parsed.name}"`;
		enhanced += ` [ref=${resolved.ref}]`;
		if ((resolved.nth ?? 0) > 0) enhanced += ` [nth=${resolved.nth}]`;
		if (params.includeSuffix(parsed.suffix)) enhanced += parsed.suffix;
		out.push(enhanced);
	}
	return out;
}
function parseRoleRef(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const normalized = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed.startsWith("ref=") ? trimmed.slice(4) : trimmed;
	if (/^e\d+$/i.test(normalized)) return normalized;
	if (/^\d{1,9}$/.test(normalized)) return normalized;
	return null;
}
function buildRoleSnapshotFromAriaSnapshot(ariaSnapshot, options = {}) {
	const lines = ariaSnapshot.split("\n");
	const refs = {};
	const tracker = createRoleNameTracker();
	let counter = 0;
	const nextRef = () => {
		counter += 1;
		return `e${counter}`;
	};
	if (options.interactive) {
		const result = buildInteractiveSnapshotLines({
			lines,
			options,
			resolveRef: ({ role, name }) => {
				const ref = nextRef();
				const nth = tracker.getNextIndex(role, name);
				tracker.trackRef(role, name, ref);
				return {
					ref,
					nth
				};
			},
			recordRef: ({ role, name }, ref, nth) => {
				refs[ref] = {
					role,
					name,
					nth
				};
			},
			includeSuffix: (suffix) => suffix.includes("[")
		});
		removeNthFromNonDuplicates(refs, tracker);
		return {
			snapshot: result.join("\n") || "(no interactive elements)",
			refs
		};
	}
	const result = [];
	for (const line of lines) {
		const processed = processLine(line, refs, options, tracker, nextRef);
		if (processed !== null) result.push(processed);
	}
	removeNthFromNonDuplicates(refs, tracker);
	const tree = result.join("\n") || "(empty)";
	return {
		snapshot: options.compact ? compactTree(tree) : tree,
		refs
	};
}
function parseAiSnapshotRef(suffix) {
	const eMatch = suffix.match(/\[ref=(e\d+)\]/i);
	if (eMatch) return eMatch[1];
	const numMatch = suffix.match(/\[ref=(\d{1,9})\]/);
	return numMatch ? numMatch[1] : null;
}
/**
* Build a role snapshot from Playwright's AI snapshot output while preserving Playwright's own
* aria-ref ids (e.g. ref=e13). This makes the refs self-resolving across calls.
*/
function buildRoleSnapshotFromAiSnapshot(aiSnapshot, options = {}) {
	const lines = aiSnapshot.split("\n");
	const refs = {};
	if (options.interactive) return {
		snapshot: buildInteractiveSnapshotLines({
			lines,
			options,
			resolveRef: ({ suffix }) => {
				const ref = parseAiSnapshotRef(suffix);
				return ref ? { ref } : null;
			},
			recordRef: ({ role, name }, ref) => {
				refs[ref] = {
					role,
					...name ? { name } : {}
				};
			},
			includeSuffix: () => true
		}).join("\n") || "(no interactive elements)",
		refs
	};
	const out = [];
	for (const line of lines) {
		const depth = getIndentLevel(line);
		if (options.maxDepth !== void 0 && depth > options.maxDepth) continue;
		const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/);
		if (!match) {
			out.push(line);
			continue;
		}
		const [, , roleRaw, name, suffix] = match;
		if (roleRaw.startsWith("/")) {
			out.push(line);
			continue;
		}
		const role = normalizeLowercaseStringOrEmpty(roleRaw);
		const isStructural = STRUCTURAL_ROLES.has(role);
		if (options.compact && isStructural && !name) continue;
		const ref = parseAiSnapshotRef(suffix);
		if (ref) refs[ref] = {
			role,
			...name ? { name } : {}
		};
		out.push(line);
	}
	const tree = out.join("\n") || "(empty)";
	return {
		snapshot: options.compact ? compactTree(tree) : tree,
		refs
	};
}
//#endregion
export { DEFAULT_FILL_FIELD_TYPE as a, ACT_MAX_CLICK_DELAY_MS as c, resolveActInteractionTimeoutMs as d, resolveActWaitTimeoutMs as f, parseRoleRef as i, ACT_MAX_WAIT_TIME_MS as l, buildRoleSnapshotFromAriaSnapshot as n, normalizeBrowserFormField as o, matchBrowserUrlPattern as p, getRoleSnapshotStats as r, normalizeBrowserFormFieldValue as s, buildRoleSnapshotFromAiSnapshot as t, normalizeActBoundedNonNegativeMs as u };
