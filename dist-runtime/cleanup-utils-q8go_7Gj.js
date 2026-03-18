import { S as shortenHomeInString, b as resolveUserPath, d as init_utils, v as resolveHomeDir } from "./utils-BiUV1eIQ.js";
import { j as resolveDefaultAgentWorkspaceDir } from "./agent-scope-C0PckUtv.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/commands/cleanup-utils.ts
init_utils();
function collectWorkspaceDirs(cfg) {
	const dirs = /* @__PURE__ */ new Set();
	const defaults = cfg?.agents?.defaults;
	if (typeof defaults?.workspace === "string" && defaults.workspace.trim()) dirs.add(resolveUserPath(defaults.workspace));
	const list = Array.isArray(cfg?.agents?.list) ? cfg?.agents?.list : [];
	for (const agent of list) {
		const workspace = agent.workspace;
		if (typeof workspace === "string" && workspace.trim()) dirs.add(resolveUserPath(workspace));
	}
	if (dirs.size === 0) dirs.add(resolveDefaultAgentWorkspaceDir());
	return [...dirs];
}
function buildCleanupPlan(params) {
	return {
		configInsideState: isPathWithin(params.configPath, params.stateDir),
		oauthInsideState: isPathWithin(params.oauthDir, params.stateDir),
		workspaceDirs: collectWorkspaceDirs(params.cfg)
	};
}
function isPathWithin(child, parent) {
	const relative = path.relative(parent, child);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function isUnsafeRemovalTarget(target) {
	if (!target.trim()) return true;
	const resolved = path.resolve(target);
	if (resolved === path.parse(resolved).root) return true;
	const home = resolveHomeDir();
	if (home && resolved === path.resolve(home)) return true;
	return false;
}
async function removePath(target, runtime, opts) {
	if (!target?.trim()) return {
		ok: false,
		skipped: true
	};
	const resolved = path.resolve(target);
	const displayLabel = shortenHomeInString(opts?.label ?? resolved);
	if (isUnsafeRemovalTarget(resolved)) {
		runtime.error(`Refusing to remove unsafe path: ${displayLabel}`);
		return { ok: false };
	}
	if (opts?.dryRun) {
		runtime.log(`[dry-run] remove ${displayLabel}`);
		return {
			ok: true,
			skipped: true
		};
	}
	try {
		await fs.rm(resolved, {
			recursive: true,
			force: true
		});
		runtime.log(`Removed ${displayLabel}`);
		return { ok: true };
	} catch (err) {
		runtime.error(`Failed to remove ${displayLabel}: ${String(err)}`);
		return { ok: false };
	}
}
async function removeStateAndLinkedPaths(cleanup, runtime, opts) {
	await removePath(cleanup.stateDir, runtime, {
		dryRun: opts?.dryRun,
		label: cleanup.stateDir
	});
	if (!cleanup.configInsideState) await removePath(cleanup.configPath, runtime, {
		dryRun: opts?.dryRun,
		label: cleanup.configPath
	});
	if (!cleanup.oauthInsideState) await removePath(cleanup.oauthDir, runtime, {
		dryRun: opts?.dryRun,
		label: cleanup.oauthDir
	});
}
async function removeWorkspaceDirs(workspaceDirs, runtime, opts) {
	for (const workspace of workspaceDirs) await removePath(workspace, runtime, {
		dryRun: opts?.dryRun,
		label: workspace
	});
}
async function listAgentSessionDirs(stateDir) {
	const root = path.join(stateDir, "agents");
	try {
		return (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name, "sessions"));
	} catch {
		return [];
	}
}
//#endregion
export { removeStateAndLinkedPaths as a, removePath as i, isPathWithin as n, removeWorkspaceDirs as o, listAgentSessionDirs as r, buildCleanupPlan as t };
