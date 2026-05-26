import { n as resolveOpenClawPackageRootSync, t as resolveOpenClawPackageRoot } from "./openclaw-root-CNp1Ofdk.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/infra/control-ui-assets.fs.runtime.ts
const existsSync$1 = fs.existsSync.bind(fs);
const readFileSync$1 = fs.readFileSync.bind(fs);
const statSync$1 = fs.statSync.bind(fs);
const realpathSync$1 = fs.realpathSync.bind(fs);
//#endregion
//#region src/infra/control-ui-assets.ts
const CONTROL_UI_DIST_PATH_SEGMENTS = [
	"dist",
	"control-ui",
	"index.html"
];
function resolveControlUiDistIndexPathForRoot(root) {
	return path.join(root, ...CONTROL_UI_DIST_PATH_SEGMENTS);
}
async function resolveControlUiDistIndexHealth(opts = {}) {
	const indexPath = opts.root ? resolveControlUiDistIndexPathForRoot(opts.root) : await resolveControlUiDistIndexPath({
		argv1: opts.argv1 ?? process.argv[1],
		moduleUrl: opts.moduleUrl
	});
	return {
		indexPath,
		exists: Boolean(indexPath && existsSync$1(indexPath))
	};
}
function resolveControlUiRepoRoot(argv1 = process.argv[1]) {
	if (!argv1) return null;
	const normalized = path.resolve(argv1);
	const parts = normalized.split(path.sep);
	const srcIndex = parts.lastIndexOf("src");
	if (srcIndex !== -1) {
		const root = parts.slice(0, srcIndex).join(path.sep);
		if (existsSync$1(path.join(root, "ui", "vite.config.ts"))) return root;
	}
	let dir = path.dirname(normalized);
	for (let i = 0; i < 8; i++) {
		if (existsSync$1(path.join(dir, "package.json")) && existsSync$1(path.join(dir, "ui", "vite.config.ts"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}
async function resolveControlUiDistIndexPath(argv1OrOpts) {
	const argv1 = typeof argv1OrOpts === "string" ? argv1OrOpts : argv1OrOpts?.argv1 ?? process.argv[1];
	const moduleUrl = typeof argv1OrOpts === "object" ? argv1OrOpts?.moduleUrl : void 0;
	if (!argv1) return null;
	const normalized = path.resolve(argv1);
	const entrypointCandidates = [normalized];
	try {
		const realpathEntrypoint = realpathSync$1(normalized);
		if (realpathEntrypoint !== normalized) entrypointCandidates.push(realpathEntrypoint);
	} catch {}
	for (const entrypoint of entrypointCandidates) {
		const distDir = path.dirname(entrypoint);
		if (path.basename(distDir) === "dist") return path.join(distDir, "control-ui", "index.html");
	}
	const packageRoot = await resolveOpenClawPackageRoot({
		argv1: normalized,
		moduleUrl
	});
	if (packageRoot) return path.join(packageRoot, "dist", "control-ui", "index.html");
	const fallbackStartDirs = new Set(entrypointCandidates.map((candidate) => path.dirname(candidate)));
	for (const startDir of fallbackStartDirs) {
		let dir = startDir;
		for (let i = 0; i < 8; i++) {
			const pkgJsonPath = path.join(dir, "package.json");
			const indexPath = path.join(dir, "dist", "control-ui", "index.html");
			if (existsSync$1(pkgJsonPath)) try {
				const raw = readFileSync$1(pkgJsonPath, "utf-8");
				if (JSON.parse(raw).name === "openclaw") return existsSync$1(indexPath) ? indexPath : null;
				break;
			} catch {
				break;
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return null;
}
function pathsMatchByRealpathOrResolve(left, right) {
	let realLeft;
	let realRight;
	try {
		realLeft = realpathSync$1(left);
	} catch {
		realLeft = path.resolve(left);
	}
	try {
		realRight = realpathSync$1(right);
	} catch {
		realRight = path.resolve(right);
	}
	return realLeft === realRight;
}
function addCandidate(candidates, value) {
	if (!value) return;
	candidates.add(path.resolve(value));
}
function resolveControlUiRootOverrideSync(rootOverride) {
	const resolved = path.resolve(rootOverride);
	try {
		const stats = statSync$1(resolved);
		if (stats.isFile()) return path.basename(resolved) === "index.html" ? path.dirname(resolved) : null;
		if (stats.isDirectory()) return existsSync$1(path.join(resolved, "index.html")) ? resolved : null;
	} catch {
		return null;
	}
	return null;
}
function resolveControlUiRootSync(opts = {}) {
	const candidates = /* @__PURE__ */ new Set();
	const argv1 = opts.argv1 ?? process.argv[1];
	const cwd = opts.cwd ?? process.cwd();
	const moduleDir = opts.moduleUrl ? path.dirname(fileURLToPath(opts.moduleUrl)) : null;
	const argv1Dir = argv1 ? path.dirname(path.resolve(argv1)) : null;
	const argv1RealpathDir = (() => {
		if (!argv1) return null;
		try {
			return path.dirname(realpathSync$1(path.resolve(argv1)));
		} catch {
			return null;
		}
	})();
	const execDir = (() => {
		try {
			const execPath = opts.execPath ?? process.execPath;
			return path.dirname(realpathSync$1(execPath));
		} catch {
			return null;
		}
	})();
	const packageRoot = resolveOpenClawPackageRootSync({
		argv1,
		moduleUrl: opts.moduleUrl,
		cwd
	});
	addCandidate(candidates, execDir ? path.join(execDir, "../Resources/control-ui") : null);
	addCandidate(candidates, execDir ? path.join(execDir, "control-ui") : null);
	if (moduleDir) {
		addCandidate(candidates, path.join(moduleDir, "control-ui"));
		addCandidate(candidates, path.join(moduleDir, "../control-ui"));
		addCandidate(candidates, path.join(moduleDir, "../../dist/control-ui"));
	}
	if (argv1Dir) {
		addCandidate(candidates, path.join(argv1Dir, "dist", "control-ui"));
		addCandidate(candidates, path.join(argv1Dir, "control-ui"));
	}
	if (argv1RealpathDir && argv1RealpathDir !== argv1Dir) {
		addCandidate(candidates, path.join(argv1RealpathDir, "dist", "control-ui"));
		addCandidate(candidates, path.join(argv1RealpathDir, "control-ui"));
	}
	if (packageRoot) addCandidate(candidates, path.join(packageRoot, "dist", "control-ui"));
	addCandidate(candidates, path.join(cwd, "dist", "control-ui"));
	for (const dir of candidates) if (existsSync$1(path.join(dir, "index.html"))) return dir;
	return null;
}
function isPackageProvenControlUiRootSync(root, opts = {}) {
	const argv1 = opts.argv1 ?? process.argv[1];
	const cwd = opts.cwd ?? process.cwd();
	const packageRoot = resolveOpenClawPackageRootSync({
		argv1,
		moduleUrl: opts.moduleUrl,
		cwd
	});
	if (!packageRoot) return false;
	return pathsMatchByRealpathOrResolve(root, path.join(packageRoot, "dist", "control-ui"));
}
function summarizeCommandOutput(text) {
	const lines = text.split(/\r?\n/g).map((l) => l.trim()).filter(Boolean);
	if (!lines.length) return;
	const last = lines.at(-1);
	if (!last) return;
	return last.length > 240 ? `${last.slice(0, 239)}…` : last;
}
async function ensureControlUiAssetsBuilt(runtime = defaultRuntime, opts) {
	const health = await resolveControlUiDistIndexHealth({ argv1: process.argv[1] });
	const indexFromDist = health.indexPath;
	if (health.exists) return {
		ok: true,
		built: false
	};
	const repoRoot = resolveControlUiRepoRoot(process.argv[1]);
	if (!repoRoot) return {
		ok: false,
		built: false,
		message: `${indexFromDist ? `Missing Control UI assets at ${indexFromDist}` : "Missing Control UI assets"}. Build them with \`pnpm ui:build\` (auto-installs UI deps).`
	};
	const indexPath = resolveControlUiDistIndexPathForRoot(repoRoot);
	if (existsSync$1(indexPath)) return {
		ok: true,
		built: false
	};
	const uiScript = path.join(repoRoot, "scripts", "ui.js");
	if (!existsSync$1(uiScript)) return {
		ok: false,
		built: false,
		message: `Control UI assets missing but ${uiScript} is unavailable.`
	};
	runtime.log("Control UI assets missing; building (ui:build, auto-installs UI deps)…");
	const build = await runCommandWithTimeout([
		process.execPath,
		uiScript,
		"build"
	], {
		cwd: repoRoot,
		timeoutMs: opts?.timeoutMs ?? 10 * 6e4
	});
	if (build.code !== 0) return {
		ok: false,
		built: false,
		message: `Control UI build failed: ${summarizeCommandOutput(build.stderr) ?? `exit ${build.code}`}`
	};
	if (!existsSync$1(indexPath)) return {
		ok: false,
		built: true,
		message: `Control UI build completed but ${indexPath} is still missing.`
	};
	return {
		ok: true,
		built: true
	};
}
//#endregion
export { resolveControlUiDistIndexPathForRoot as a, resolveControlUiRootSync as c, resolveControlUiDistIndexPath as i, isPackageProvenControlUiRootSync as n, resolveControlUiRepoRoot as o, resolveControlUiDistIndexHealth as r, resolveControlUiRootOverrideSync as s, ensureControlUiAssetsBuilt as t };
