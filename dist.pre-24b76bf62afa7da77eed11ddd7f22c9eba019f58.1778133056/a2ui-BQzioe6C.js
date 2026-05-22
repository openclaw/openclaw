import { r as lowercasePreservingWhitespace } from "./string-coerce-Bje8XVt9.js";
import { n as detectMime } from "./mime-CeZSHsWQ.js";
import { n as resolveFileWithinRoot, o as injectCanvasLiveReload, r as A2UI_PATH, s as isA2uiPath } from "./file-resolver-Ri8I9Jrw.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/canvas-host/a2ui.ts
let cachedA2uiRootReal;
let resolvingA2uiRoot = null;
let cachedA2uiResolvedAtMs = 0;
const A2UI_ROOT_RETRY_NULL_AFTER_MS = 1e4;
async function resolveA2uiRoot() {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const entryDir = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : null;
	const candidates = [
		path.resolve(here, "a2ui"),
		path.resolve(here, "canvas-host/a2ui"),
		path.resolve(here, "../canvas-host/a2ui"),
		...entryDir ? [
			path.resolve(entryDir, "a2ui"),
			path.resolve(entryDir, "canvas-host/a2ui"),
			path.resolve(entryDir, "../canvas-host/a2ui")
		] : [],
		path.resolve(here, "../../src/canvas-host/a2ui"),
		path.resolve(here, "../src/canvas-host/a2ui"),
		path.resolve(process.cwd(), "src/canvas-host/a2ui"),
		path.resolve(process.cwd(), "dist/canvas-host/a2ui")
	];
	if (process.execPath) candidates.unshift(path.resolve(path.dirname(process.execPath), "a2ui"));
	for (const dir of candidates) try {
		const indexPath = path.join(dir, "index.html");
		const bundlePath = path.join(dir, "a2ui.bundle.js");
		await fs.stat(indexPath);
		await fs.stat(bundlePath);
		return dir;
	} catch {}
	return null;
}
async function resolveA2uiRootReal() {
	if (cachedA2uiRootReal !== void 0 && (cachedA2uiRootReal !== null || Date.now() - cachedA2uiResolvedAtMs < A2UI_ROOT_RETRY_NULL_AFTER_MS)) return cachedA2uiRootReal;
	if (!resolvingA2uiRoot) resolvingA2uiRoot = (async () => {
		const root = await resolveA2uiRoot();
		cachedA2uiRootReal = root ? await fs.realpath(root) : null;
		cachedA2uiResolvedAtMs = Date.now();
		resolvingA2uiRoot = null;
		return cachedA2uiRootReal;
	})();
	return resolvingA2uiRoot;
}
async function handleA2uiHttpRequest(req, res) {
	const urlRaw = req.url;
	if (!urlRaw) return false;
	const url = new URL(urlRaw, "http://localhost");
	const basePath = isA2uiPath(url.pathname) ? A2UI_PATH : void 0;
	if (!basePath) return false;
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.statusCode = 405;
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.end("Method Not Allowed");
		return true;
	}
	const a2uiRootReal = await resolveA2uiRootReal();
	if (!a2uiRootReal) {
		res.statusCode = 503;
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.end("A2UI assets not found");
		return true;
	}
	const result = await resolveFileWithinRoot(a2uiRootReal, url.pathname.slice(basePath.length) || "/");
	if (!result) {
		res.statusCode = 404;
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.end("not found");
		return true;
	}
	try {
		const lower = lowercasePreservingWhitespace(result.realPath);
		const mime = lower.endsWith(".html") || lower.endsWith(".htm") ? "text/html" : await detectMime({ filePath: result.realPath }) ?? "application/octet-stream";
		res.setHeader("Cache-Control", "no-store");
		if (req.method === "HEAD") {
			res.setHeader("Content-Type", mime === "text/html" ? "text/html; charset=utf-8" : mime);
			res.end();
			return true;
		}
		if (mime === "text/html") {
			const buf = await result.handle.readFile({ encoding: "utf8" });
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(injectCanvasLiveReload(buf));
			return true;
		}
		res.setHeader("Content-Type", mime);
		res.end(await result.handle.readFile());
		return true;
	} finally {
		await result.handle.close().catch(() => {});
	}
}
//#endregion
export { handleA2uiHttpRequest as t };
