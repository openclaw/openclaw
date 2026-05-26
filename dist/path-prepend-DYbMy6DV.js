import path from "node:path";
//#region src/infra/path-prepend.ts
/**
* Find the actual key used for PATH in the env object.
* On Windows, `process.env` stores it as `Path` (not `PATH`),
* and after copying to a plain object the original casing is preserved.
*/
function findPathKey(env) {
	if ("PATH" in env) return "PATH";
	for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") return key;
	return "PATH";
}
function normalizePathPrepend(entries) {
	if (!Array.isArray(entries)) return [];
	const seen = /* @__PURE__ */ new Set();
	const normalized = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		normalized.push(trimmed);
	}
	return normalized;
}
function mergePathPrepend(existing, prepend) {
	if (prepend.length === 0) return existing;
	const partsExisting = (existing ?? "").split(path.delimiter).map((part) => part.trim()).filter(Boolean);
	const merged = [];
	const seen = /* @__PURE__ */ new Set();
	for (const part of [...prepend, ...partsExisting]) {
		if (seen.has(part)) continue;
		seen.add(part);
		merged.push(part);
	}
	return merged.join(path.delimiter);
}
function applyPathPrepend(env, prepend, options) {
	if (!Array.isArray(prepend) || prepend.length === 0) return;
	const pathKey = findPathKey(env);
	if (options?.requireExisting && !env[pathKey]) return;
	const merged = mergePathPrepend(env[pathKey], prepend);
	if (merged) env[pathKey] = merged;
}
//#endregion
export { normalizePathPrepend as i, findPathKey as n, mergePathPrepend as r, applyPathPrepend as t };
