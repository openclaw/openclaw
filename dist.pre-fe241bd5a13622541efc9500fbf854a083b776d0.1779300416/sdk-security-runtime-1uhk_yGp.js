import { f as pathScope, j as findExistingAncestor } from "./fs-safe-BIhMf0UI.js";
import "./runtime-env-CXIxjPCK.js";
import "./plugin-runtime-By8z431K.js";
import "./security-runtime-CFCiiDJI.js";
import "./gateway-runtime-ByDdVi7L.js";
import "./cli-runtime-G0p6h0It.js";
import "./logging-core-CUXJwrFA.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region extensions/browser/src/sdk-node-runtime.ts
async function withTimeout(work, timeoutMs, label) {
	const resolved = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs)) : void 0;
	if (!resolved) return await work(void 0);
	const abortCtrl = new AbortController();
	const timeoutError = /* @__PURE__ */ new Error(`${label ?? "request"} timed out`);
	const timer = setTimeout(() => abortCtrl.abort(timeoutError), resolved);
	timer.unref?.();
	let abortListener;
	const abortPromise = abortCtrl.signal.aborted ? Promise.reject(abortCtrl.signal.reason ?? timeoutError) : new Promise((_, reject) => {
		abortListener = () => reject(abortCtrl.signal.reason ?? timeoutError);
		abortCtrl.signal.addEventListener("abort", abortListener, { once: true });
	});
	try {
		return await Promise.race([work(abortCtrl.signal), abortPromise]);
	} finally {
		clearTimeout(timer);
		if (abortListener) abortCtrl.signal.removeEventListener("abort", abortListener);
	}
}
//#endregion
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
export { withTimeout as n, ensureAbsoluteDirectory as t };
