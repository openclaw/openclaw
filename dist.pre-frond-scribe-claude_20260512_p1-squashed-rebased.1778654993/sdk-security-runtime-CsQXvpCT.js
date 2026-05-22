import { f as pathScope, j as findExistingAncestor } from "./fs-safe-DKdSS9ZL.js";
import "./security-runtime-7vEOoyka.js";
import "./logging-core-Chn8zC2Z.js";
import "./sdk-node-runtime-BA36lglR.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region extensions/browser/src/sdk-security-runtime.ts
async function ensureAbsoluteDirectory(dirPath, options) {
	const absolutePath = path.resolve(dirPath);
	const scopeLabel = options?.scopeLabel ?? "directory";
	const existingAncestor = await findExistingAncestor(absolutePath);
	if (!existingAncestor) return {
		ok: false,
		error: /* @__PURE__ */ new Error(`Invalid path: must stay within ${scopeLabel}`)
	};
	if (existingAncestor === absolutePath) {
		try {
			const stat = await fs.lstat(absolutePath);
			if (!stat.isSymbolicLink() && stat.isDirectory()) return {
				ok: true,
				path: absolutePath
			};
		} catch {}
		return {
			ok: false,
			error: /* @__PURE__ */ new Error(`Invalid path: must stay within ${scopeLabel}`)
		};
	}
	const result = await pathScope(existingAncestor, { label: options?.scopeLabel ?? "directory" }).ensureDir(path.relative(existingAncestor, absolutePath), { mode: options?.mode });
	if (result.ok) return result;
	return {
		ok: false,
		error: new Error(result.error)
	};
}
//#endregion
export { ensureAbsoluteDirectory as t };
