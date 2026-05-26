import { i as resolveRootPathSync, r as resolveRootPath } from "./root-path-BgCKz8X4.js";
import { t as openPinnedFileSync } from "./pinned-open-BRMz46d0.js";
import fs from "node:fs";
import path from "node:path";
//#region node_modules/@openclaw/fs-safe/dist/root-file.js
function canUseRootFileOpen(ioFs) {
	return typeof ioFs.openSync === "function" && typeof ioFs.closeSync === "function" && typeof ioFs.fstatSync === "function" && typeof ioFs.lstatSync === "function" && typeof ioFs.realpathSync === "function" && typeof ioFs.readFileSync === "function" && typeof ioFs.constants === "object" && ioFs.constants !== null;
}
function openRootFileSync(params) {
	const ioFs = params.ioFs ?? fs;
	const resolved = resolveRootFilePathGeneric({
		absolutePath: params.absolutePath,
		resolve: (absolutePath) => resolveRootPathSync({
			absolutePath,
			rootPath: params.rootPath,
			rootCanonicalPath: params.rootRealPath,
			boundaryLabel: params.boundaryLabel,
			skipLexicalRootCheck: params.skipLexicalRootCheck
		})
	});
	if (resolved instanceof Promise) return toBoundaryValidationError(/* @__PURE__ */ new Error("Unexpected async boundary resolution"));
	return finalizeRootFileOpen({
		resolved,
		maxBytes: params.maxBytes,
		rejectHardlinks: params.rejectHardlinks,
		allowedType: params.allowedType,
		ioFs
	});
}
function matchRootFileOpenFailure(failure, handlers) {
	switch (failure.reason) {
		case "path": return handlers.path ? handlers.path(failure) : handlers.fallback(failure);
		case "validation": return handlers.validation ? handlers.validation(failure) : handlers.fallback(failure);
		case "io": return handlers.io ? handlers.io(failure) : handlers.fallback(failure);
	}
	return handlers.fallback(failure);
}
function openRootFileResolved(params) {
	const opened = openPinnedFileSync({
		filePath: params.absolutePath,
		resolvedPath: params.resolvedPath,
		rejectHardlinks: params.rejectHardlinks ?? true,
		maxBytes: params.maxBytes,
		allowedType: params.allowedType,
		ioFs: params.ioFs
	});
	if (!opened.ok) return opened;
	return {
		ok: true,
		path: opened.path,
		fd: opened.fd,
		stat: opened.stat,
		rootRealPath: params.rootRealPath
	};
}
function finalizeRootFileOpen(params) {
	if ("ok" in params.resolved) return params.resolved;
	return openRootFileResolved({
		absolutePath: params.resolved.absolutePath,
		resolvedPath: params.resolved.resolvedPath,
		rootRealPath: params.resolved.rootRealPath,
		maxBytes: params.maxBytes,
		rejectHardlinks: params.rejectHardlinks,
		allowedType: params.allowedType,
		ioFs: params.ioFs
	});
}
async function openRootFile(params) {
	const ioFs = params.ioFs ?? fs;
	const maybeResolved = resolveRootFilePathGeneric({
		absolutePath: params.absolutePath,
		resolve: (absolutePath) => resolveRootPath({
			absolutePath,
			rootPath: params.rootPath,
			rootCanonicalPath: params.rootRealPath,
			boundaryLabel: params.boundaryLabel,
			policy: params.aliasPolicy,
			skipLexicalRootCheck: params.skipLexicalRootCheck
		})
	});
	return finalizeRootFileOpen({
		resolved: maybeResolved instanceof Promise ? await maybeResolved : maybeResolved,
		maxBytes: params.maxBytes,
		rejectHardlinks: params.rejectHardlinks,
		allowedType: params.allowedType,
		ioFs
	});
}
function toBoundaryValidationError(error) {
	return {
		ok: false,
		reason: "validation",
		error
	};
}
function mapResolvedRootPath(absolutePath, resolved) {
	return {
		absolutePath,
		resolvedPath: resolved.canonicalPath,
		rootRealPath: resolved.rootCanonicalPath
	};
}
function resolveRootFilePathGeneric(params) {
	const absolutePath = path.resolve(params.absolutePath);
	try {
		const resolved = params.resolve(absolutePath);
		if (resolved instanceof Promise) return resolved.then((value) => mapResolvedRootPath(absolutePath, value)).catch((error) => toBoundaryValidationError(error));
		return mapResolvedRootPath(absolutePath, resolved);
	} catch (error) {
		return toBoundaryValidationError(error);
	}
}
//#endregion
export { openRootFileSync as i, matchRootFileOpenFailure as n, openRootFile as r, canUseRootFileOpen as t };
