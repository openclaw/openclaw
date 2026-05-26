import { l as normalizeWindowsPathForComparison } from "./path-BlG8lhgR.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import "./path-guards-CBe_wA_B.js";
import { i as resolveSandboxInputPath } from "./sandbox-paths-BTYunIeX.js";
import path from "node:path";
//#region src/agents/path-policy.ts
function throwPathEscapesBoundary(params) {
	const boundary = params.options?.boundaryLabel ?? "workspace root";
	const suffix = params.options?.includeRootInError ? ` (${params.rootResolved})` : "";
	throw new Error(`Path escapes ${boundary}${suffix}: ${params.candidate}`);
}
function validateRelativePathWithinBoundary(params) {
	if (params.relativePath === "" || params.relativePath === ".") {
		if (params.options?.allowRoot) return "";
		throwPathEscapesBoundary({
			options: params.options,
			rootResolved: params.rootResolved,
			candidate: params.candidate
		});
	}
	if (params.relativePath === ".." || params.relativePath.startsWith("../") || params.relativePath.startsWith("..\\") || params.isAbsolutePath(params.relativePath)) throwPathEscapesBoundary({
		options: params.options,
		rootResolved: params.rootResolved,
		candidate: params.candidate
	});
	return params.relativePath;
}
function toRelativePathUnderRoot(params) {
	const resolvedInput = resolveSandboxInputPath(params.candidate, params.options?.cwd ?? params.root);
	if (process.platform === "win32") {
		const rootResolved = path.win32.resolve(params.root);
		const resolvedCandidate = path.win32.resolve(resolvedInput);
		const rootForCompare = normalizeWindowsPathForComparison(rootResolved);
		const targetForCompare = normalizeWindowsPathForComparison(resolvedCandidate);
		return validateRelativePathWithinBoundary({
			relativePath: path.win32.relative(rootForCompare, targetForCompare),
			isAbsolutePath: path.win32.isAbsolute,
			options: params.options,
			rootResolved,
			candidate: params.candidate
		});
	}
	const rootResolved = path.resolve(params.root);
	const resolvedCandidate = path.resolve(resolvedInput);
	return validateRelativePathWithinBoundary({
		relativePath: path.relative(rootResolved, resolvedCandidate),
		isAbsolutePath: path.isAbsolute,
		options: params.options,
		rootResolved,
		candidate: params.candidate
	});
}
function toRelativeBoundaryPath(params) {
	return toRelativePathUnderRoot({
		root: params.root,
		candidate: params.candidate,
		options: {
			allowRoot: params.options?.allowRoot,
			cwd: params.options?.cwd,
			boundaryLabel: params.boundaryLabel,
			includeRootInError: params.includeRootInError
		}
	});
}
function toRelativeWorkspacePath(root, candidate, options) {
	return toRelativeBoundaryPath({
		root,
		candidate,
		options,
		boundaryLabel: "workspace root"
	});
}
function toRelativeSandboxPath(root, candidate, options) {
	return toRelativeBoundaryPath({
		root,
		candidate,
		options,
		boundaryLabel: "sandbox root",
		includeRootInError: true
	});
}
function resolvePathFromInput(filePath, cwd) {
	return path.normalize(resolveSandboxInputPath(filePath, cwd));
}
//#endregion
//#region src/agents/workspace-dir.ts
function normalizeWorkspaceDir(workspaceDir) {
	const trimmed = workspaceDir?.trim();
	if (!trimmed) return null;
	const expanded = trimmed.startsWith("~") ? resolveUserPath(trimmed) : trimmed;
	const resolved = path.resolve(expanded);
	if (resolved === path.parse(resolved).root) return null;
	return resolved;
}
function resolveWorkspaceRoot(workspaceDir) {
	return normalizeWorkspaceDir(workspaceDir) ?? process.cwd();
}
//#endregion
export { toRelativeWorkspacePath as a, toRelativeSandboxPath as i, resolveWorkspaceRoot as n, resolvePathFromInput as r, normalizeWorkspaceDir as t };
