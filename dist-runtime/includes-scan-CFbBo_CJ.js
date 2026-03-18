import { mt as INCLUDE_KEY } from "./workspace-dirs-Ejflbukt.js";
import path from "node:path";
import JSON5 from "json5";
import * as fs$1 from "node:fs/promises";
//#region src/config/includes-scan.ts
function listDirectIncludes(parsed) {
	const out = [];
	const visit = (value) => {
		if (!value) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== "object") return;
		const rec = value;
		const includeVal = rec[INCLUDE_KEY];
		if (typeof includeVal === "string") out.push(includeVal);
		else if (Array.isArray(includeVal)) {
			for (const item of includeVal) if (typeof item === "string") out.push(item);
		}
		for (const v of Object.values(rec)) visit(v);
	};
	visit(parsed);
	return out;
}
function resolveIncludePath(baseConfigPath, includePath) {
	return path.normalize(path.isAbsolute(includePath) ? includePath : path.resolve(path.dirname(baseConfigPath), includePath));
}
async function collectIncludePathsRecursive(params) {
	const visited = /* @__PURE__ */ new Set();
	const result = [];
	const walk = async (basePath, parsed, depth) => {
		if (depth > 10) return;
		for (const raw of listDirectIncludes(parsed)) {
			const resolved = resolveIncludePath(basePath, raw);
			if (visited.has(resolved)) continue;
			visited.add(resolved);
			result.push(resolved);
			const rawText = await fs$1.readFile(resolved, "utf-8").catch(() => null);
			if (!rawText) continue;
			const nestedParsed = (() => {
				try {
					return JSON5.parse(rawText);
				} catch {
					return null;
				}
			})();
			if (nestedParsed) await walk(resolved, nestedParsed, depth + 1);
		}
	};
	await walk(params.configPath, params.parsed, 0);
	return result;
}
//#endregion
export { collectIncludePathsRecursive as t };
