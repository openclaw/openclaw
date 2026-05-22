import { n as resolveBoundaryPath, r as resolveBoundaryPathSync } from "./boundary-path-DbcMiy8Y.js";
import { t as openVerifiedFileSync } from "./safe-open-sync-BVLkOkpr.js";
import fs from "node:fs";
import path from "node:path";
//#region src/infra/boundary-file-read.ts
function canUseBoundaryFileOpen(ioFs) {
	return typeof ioFs.openSync === "function" && typeof ioFs.closeSync === "function" && typeof ioFs.fstatSync === "function" && typeof ioFs.lstatSync === "function" && typeof ioFs.realpathSync === "function" && typeof ioFs.readFileSync === "function" && typeof ioFs.constants === "object" && ioFs.constants !== null;
}
function openBoundaryFileSync(params) {
	const ioFs = params.ioFs ?? fs;
	const resolved = resolveBoundaryFilePathGeneric({
		absolutePath: params.absolutePath,
		resolve: (absolutePath) => resolveBoundaryPathSync({
			absolutePath,
			rootPath: params.rootPath,
			rootCanonicalPath: params.rootRealPath,
			boundaryLabel: params.boundaryLabel,
			skipLexicalRootCheck: params.skipLexicalRootCheck
		})
	});
	if (resolved instanceof Promise) return toBoundaryValidationError(/* @__PURE__ */ new Error("Unexpected async boundary resolution"));
	return finalizeBoundaryFileOpen({
		resolved,
		maxBytes: params.maxBytes,
		rejectHardlinks: params.rejectHardlinks,
		allowedType: params.allowedType,
		ioFs
	});
}
function matchBoundaryFileOpenFailure(failure, handlers) {
	switch (failure.reason) {
		case "path": return handlers.path ? handlers.path(failure) : handlers.fallback(failure);
		case "validation": return handlers.validation ? handlers.validation(failure) : handlers.fallback(failure);
		case "io": return handlers.io ? handlers.io(failure) : handlers.fallback(failure);
	}
	return handlers.fallback(failure);
}
function openBoundaryFileResolved(params) {
	const opened = openVerifiedFileSync({
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
function finalizeBoundaryFileOpen(params) {
	if ("ok" in params.resolved) return params.resolved;
	return openBoundaryFileResolved({
		absolutePath: params.resolved.absolutePath,
		resolvedPath: params.resolved.resolvedPath,
		rootRealPath: params.resolved.rootRealPath,
		maxBytes: params.maxBytes,
		rejectHardlinks: params.rejectHardlinks,
		allowedType: params.allowedType,
		ioFs: params.ioFs
	});
}
async function openBoundaryFile(params) {
	const ioFs = params.ioFs ?? fs;
	const maybeResolved = resolveBoundaryFilePathGeneric({
		absolutePath: params.absolutePath,
		resolve: (absolutePath) => resolveBoundaryPath({
			absolutePath,
			rootPath: params.rootPath,
			rootCanonicalPath: params.rootRealPath,
			boundaryLabel: params.boundaryLabel,
			policy: params.aliasPolicy,
			skipLexicalRootCheck: params.skipLexicalRootCheck
		})
	});
	return finalizeBoundaryFileOpen({
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
function mapResolvedBoundaryPath(absolutePath, resolved) {
	return {
		absolutePath,
		resolvedPath: resolved.canonicalPath,
		rootRealPath: resolved.rootCanonicalPath
	};
}
function resolveBoundaryFilePathGeneric(params) {
	const absolutePath = path.resolve(params.absolutePath);
	try {
		const resolved = params.resolve(absolutePath);
		if (resolved instanceof Promise) return resolved.then((value) => mapResolvedBoundaryPath(absolutePath, value)).catch((error) => toBoundaryValidationError(error));
		return mapResolvedBoundaryPath(absolutePath, resolved);
	} catch (error) {
		return toBoundaryValidationError(error);
	}
}
//#endregion
export { openBoundaryFileSync as i, matchBoundaryFileOpenFailure as n, openBoundaryFile as r, canUseBoundaryFileOpen as t };
