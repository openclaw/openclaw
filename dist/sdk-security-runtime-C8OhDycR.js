import { f as pathScope, j as findExistingAncestor } from "./fs-safe-CV86zY9G.js";
import "./runtime-env-BtvWnLRh.js";
import "./plugin-runtime-DG_BosJY.js";
import "./security-runtime-CcSekjBd.js";
import "./gateway-runtime-HxuTzDuS.js";
import "./cli-runtime-hT2uaCvo.js";
import "./logging-core-DwEC9Ajh.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region extensions/browser/src/sdk-node-runtime.ts
function normalizeTimeoutMs(timeoutMs) {
	return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs)) : void 0;
}
function createTimeoutAbortSignal(timeoutMs, label) {
	const controller = new AbortController();
	const error = /* @__PURE__ */ new Error(`${label ?? "request"} timed out`);
	const timer = setTimeout(() => controller.abort(error), timeoutMs);
	timer.unref?.();
	return {
		controller,
		error,
		timer
	};
}
function waitForAbort(signal, fallback) {
	if (signal.aborted) return {
		promise: Promise.reject(signal.reason ?? fallback),
		cleanup: () => void 0
	};
	let listener;
	return {
		cleanup: () => {
			if (listener) signal.removeEventListener("abort", listener);
		},
		promise: new Promise((_, reject) => {
			listener = () => reject(signal.reason ?? fallback);
			signal.addEventListener("abort", listener, { once: true });
		})
	};
}
async function withTimeout(work, timeoutMs, label) {
	const resolved = normalizeTimeoutMs(timeoutMs);
	if (!resolved) return await work(void 0);
	const timeout = createTimeoutAbortSignal(resolved, label);
	const abort = waitForAbort(timeout.controller.signal, timeout.error);
	try {
		return await Promise.race([work(timeout.controller.signal), abort.promise]);
	} finally {
		clearTimeout(timeout.timer);
		abort.cleanup();
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
