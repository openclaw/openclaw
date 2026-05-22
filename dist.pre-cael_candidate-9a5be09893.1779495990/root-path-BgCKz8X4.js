import { i as isPathInside, o as isPathRelativeEscape, r as isNotFoundPathError } from "./path-BlG8lhgR.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import os from "node:os";
//#region node_modules/@openclaw/fs-safe/dist/root-path.js
const ROOT_PATH_ALIAS_POLICIES = {
	strict: Object.freeze({
		allowFinalSymlinkForUnlink: false,
		allowFinalHardlinkForUnlink: false
	}),
	unlinkTarget: Object.freeze({
		allowFinalSymlinkForUnlink: true,
		allowFinalHardlinkForUnlink: true
	})
};
async function resolveRootPath(params) {
	const rootPath = path.resolve(params.rootPath);
	const absolutePath = path.resolve(params.absolutePath);
	const context = createBoundaryResolutionContext({
		resolveParams: params,
		rootPath,
		absolutePath,
		rootCanonicalPath: params.rootCanonicalPath ? path.resolve(params.rootCanonicalPath) : await resolvePathViaExistingAncestor(rootPath),
		outsideLexicalCanonicalPath: await resolveOutsideLexicalCanonicalPathAsync({
			rootPath,
			absolutePath
		})
	});
	const outsideResult = await resolveOutsideRootPathAsync({
		boundaryLabel: params.boundaryLabel,
		context
	});
	if (outsideResult) return outsideResult;
	return resolveRootPathLexicalAsync({
		params,
		absolutePath: context.absolutePath,
		rootPath: context.rootPath,
		rootCanonicalPath: context.rootCanonicalPath
	});
}
function resolveRootPathSync(params) {
	const rootPath = path.resolve(params.rootPath);
	const absolutePath = path.resolve(params.absolutePath);
	const context = createBoundaryResolutionContext({
		resolveParams: params,
		rootPath,
		absolutePath,
		rootCanonicalPath: params.rootCanonicalPath ? path.resolve(params.rootCanonicalPath) : resolvePathViaExistingAncestorSync(rootPath),
		outsideLexicalCanonicalPath: resolveOutsideLexicalCanonicalPathSync({
			rootPath,
			absolutePath
		})
	});
	const outsideResult = resolveOutsideRootPathSync({
		boundaryLabel: params.boundaryLabel,
		context
	});
	if (outsideResult) return outsideResult;
	return resolveRootPathLexicalSync({
		params,
		absolutePath: context.absolutePath,
		rootPath: context.rootPath,
		rootCanonicalPath: context.rootCanonicalPath
	});
}
function isPromiseLike(value) {
	return Boolean(value && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function");
}
function createLexicalTraversalState(params) {
	return {
		segments: path.relative(params.rootPath, params.absolutePath).split(path.sep).filter(Boolean),
		allowFinalSymlink: params.params.policy?.allowFinalSymlinkForUnlink === true,
		canonicalCursor: params.rootCanonicalPath,
		lexicalCursor: params.rootPath,
		preserveFinalSymlink: false
	};
}
function assertLexicalCursorInsideBoundary(params) {
	assertInsideBoundary({
		boundaryLabel: params.params.boundaryLabel,
		rootCanonicalPath: params.rootCanonicalPath,
		candidatePath: params.candidatePath,
		absolutePath: params.absolutePath
	});
}
function applyMissingSuffixToCanonicalCursor(params) {
	const missingSuffix = params.state.segments.slice(params.missingFromIndex);
	params.state.canonicalCursor = path.resolve(params.state.canonicalCursor, ...missingSuffix);
	assertLexicalCursorInsideBoundary({
		params: params.params,
		rootCanonicalPath: params.rootCanonicalPath,
		candidatePath: params.state.canonicalCursor,
		absolutePath: params.absolutePath
	});
}
function advanceCanonicalCursorForSegment(params) {
	params.state.canonicalCursor = path.resolve(params.state.canonicalCursor, params.segment);
	assertLexicalCursorInsideBoundary({
		params: params.params,
		rootCanonicalPath: params.rootCanonicalPath,
		candidatePath: params.state.canonicalCursor,
		absolutePath: params.absolutePath
	});
}
function finalizeLexicalResolution(params) {
	assertLexicalCursorInsideBoundary({
		params: params.params,
		rootCanonicalPath: params.rootCanonicalPath,
		candidatePath: params.state.canonicalCursor,
		absolutePath: params.absolutePath
	});
	return buildResolvedRootPath({
		absolutePath: params.absolutePath,
		canonicalPath: params.state.canonicalCursor,
		rootPath: params.rootPath,
		rootCanonicalPath: params.rootCanonicalPath,
		kind: params.kind
	});
}
function handleLexicalLstatFailure(params) {
	if (!isNotFoundPathError(params.error)) return false;
	applyMissingSuffixToCanonicalCursor({
		state: params.state,
		missingFromIndex: params.missingFromIndex,
		rootCanonicalPath: params.rootCanonicalPath,
		params: params.resolveParams,
		absolutePath: params.absolutePath
	});
	return true;
}
function handleLexicalStatReadFailure(params) {
	if (handleLexicalLstatFailure({
		error: params.error,
		state: params.state,
		missingFromIndex: params.missingFromIndex,
		rootCanonicalPath: params.rootCanonicalPath,
		resolveParams: params.resolveParams,
		absolutePath: params.absolutePath
	})) return null;
	throw params.error;
}
function handleLexicalStatDisposition(params) {
	if (!params.isSymbolicLink) {
		advanceCanonicalCursorForSegment({
			state: params.state,
			segment: params.segment,
			rootCanonicalPath: params.rootCanonicalPath,
			params: params.resolveParams,
			absolutePath: params.absolutePath
		});
		return "continue";
	}
	if (params.state.allowFinalSymlink && params.isLast) {
		params.state.preserveFinalSymlink = true;
		advanceCanonicalCursorForSegment({
			state: params.state,
			segment: params.segment,
			rootCanonicalPath: params.rootCanonicalPath,
			params: params.resolveParams,
			absolutePath: params.absolutePath
		});
		return "break";
	}
	return "resolve-link";
}
function applyResolvedSymlinkHop(params) {
	if (!isPathInside(params.rootCanonicalPath, params.linkCanonical)) throw symlinkEscapeError({
		boundaryLabel: params.boundaryLabel,
		rootCanonicalPath: params.rootCanonicalPath,
		symlinkPath: params.state.lexicalCursor
	});
	params.state.canonicalCursor = params.linkCanonical;
	params.state.lexicalCursor = params.linkCanonical;
}
function readLexicalStat(params) {
	try {
		const stat = params.read(params.state.lexicalCursor);
		if (isPromiseLike(stat)) return Promise.resolve(stat).catch((error) => handleLexicalStatReadFailure({
			...params,
			error
		}));
		return stat;
	} catch (error) {
		return handleLexicalStatReadFailure({
			...params,
			error
		});
	}
}
function resolveAndApplySymlinkHop(params) {
	const linkCanonical = params.resolveLinkCanonical(params.state.lexicalCursor);
	if (isPromiseLike(linkCanonical)) return Promise.resolve(linkCanonical).then((value) => applyResolvedSymlinkHop({
		state: params.state,
		linkCanonical: value,
		rootCanonicalPath: params.rootCanonicalPath,
		boundaryLabel: params.boundaryLabel
	}));
	applyResolvedSymlinkHop({
		state: params.state,
		linkCanonical,
		rootCanonicalPath: params.rootCanonicalPath,
		boundaryLabel: params.boundaryLabel
	});
}
function* iterateLexicalTraversal(state) {
	for (let idx = 0; idx < state.segments.length; idx += 1) {
		const segment = state.segments[idx] ?? "";
		const isLast = idx === state.segments.length - 1;
		state.lexicalCursor = path.join(state.lexicalCursor, segment);
		yield {
			idx,
			segment,
			isLast
		};
	}
}
async function resolveRootPathLexicalAsync(params) {
	const state = createLexicalTraversalState(params);
	const sharedStepParams = {
		state,
		rootCanonicalPath: params.rootCanonicalPath,
		resolveParams: params.params,
		absolutePath: params.absolutePath
	};
	for (const { idx, segment, isLast } of iterateLexicalTraversal(state)) {
		const stat = await readLexicalStat({
			...sharedStepParams,
			missingFromIndex: idx,
			read: (cursor) => fs$1.lstat(cursor)
		});
		if (!stat) break;
		const disposition = handleLexicalStatDisposition({
			...sharedStepParams,
			isSymbolicLink: stat.isSymbolicLink(),
			segment,
			isLast
		});
		if (disposition === "continue") continue;
		if (disposition === "break") break;
		await resolveAndApplySymlinkHop({
			state,
			rootCanonicalPath: params.rootCanonicalPath,
			boundaryLabel: params.params.boundaryLabel,
			resolveLinkCanonical: (cursor) => resolveSymlinkHopPath(cursor)
		});
	}
	const kind = await getPathKind(params.absolutePath, state.preserveFinalSymlink);
	return finalizeLexicalResolution({
		...params,
		state,
		kind
	});
}
function resolveRootPathLexicalSync(params) {
	const state = createLexicalTraversalState(params);
	for (let idx = 0; idx < state.segments.length; idx += 1) {
		const segment = state.segments[idx] ?? "";
		const isLast = idx === state.segments.length - 1;
		state.lexicalCursor = path.join(state.lexicalCursor, segment);
		const maybeStat = readLexicalStat({
			state,
			missingFromIndex: idx,
			rootCanonicalPath: params.rootCanonicalPath,
			resolveParams: params.params,
			absolutePath: params.absolutePath,
			read: (cursor) => fs.lstatSync(cursor)
		});
		if (isPromiseLike(maybeStat)) throw new Error("Unexpected async lexical stat");
		const stat = maybeStat;
		if (!stat) break;
		const disposition = handleLexicalStatDisposition({
			state,
			isSymbolicLink: stat.isSymbolicLink(),
			segment,
			isLast,
			rootCanonicalPath: params.rootCanonicalPath,
			resolveParams: params.params,
			absolutePath: params.absolutePath
		});
		if (disposition === "continue") continue;
		if (disposition === "break") break;
		if (isPromiseLike(resolveAndApplySymlinkHop({
			state,
			rootCanonicalPath: params.rootCanonicalPath,
			boundaryLabel: params.params.boundaryLabel,
			resolveLinkCanonical: (cursor) => resolveSymlinkHopPathSync(cursor)
		}))) throw new Error("Unexpected async symlink resolution");
	}
	const kind = getPathKindSync(params.absolutePath, state.preserveFinalSymlink);
	return finalizeLexicalResolution({
		...params,
		state,
		kind
	});
}
function resolveCanonicalOutsideLexicalPath(params) {
	return params.outsideLexicalCanonicalPath ?? params.absolutePath;
}
function createBoundaryResolutionContext(params) {
	const lexicalInside = isPathInside(params.rootPath, params.absolutePath);
	const canonicalOutsideLexicalPath = resolveCanonicalOutsideLexicalPath({
		absolutePath: params.absolutePath,
		outsideLexicalCanonicalPath: params.outsideLexicalCanonicalPath
	});
	assertLexicalBoundaryOrCanonicalAlias({
		skipLexicalRootCheck: params.resolveParams.skipLexicalRootCheck,
		lexicalInside,
		canonicalOutsideLexicalPath,
		rootCanonicalPath: params.rootCanonicalPath,
		boundaryLabel: params.resolveParams.boundaryLabel,
		rootPath: params.rootPath,
		absolutePath: params.absolutePath
	});
	return {
		rootPath: params.rootPath,
		absolutePath: params.absolutePath,
		rootCanonicalPath: params.rootCanonicalPath,
		lexicalInside,
		canonicalOutsideLexicalPath
	};
}
async function resolveOutsideRootPathAsync(params) {
	if (params.context.lexicalInside) return null;
	const kind = await getPathKind(params.context.absolutePath, false);
	return buildOutsideRootPathFromContext({
		boundaryLabel: params.boundaryLabel,
		context: params.context,
		kind
	});
}
function resolveOutsideRootPathSync(params) {
	if (params.context.lexicalInside) return null;
	const kind = getPathKindSync(params.context.absolutePath, false);
	return buildOutsideRootPathFromContext({
		boundaryLabel: params.boundaryLabel,
		context: params.context,
		kind
	});
}
function buildOutsideRootPathFromContext(params) {
	return buildOutsideLexicalRootPath({
		boundaryLabel: params.boundaryLabel,
		rootCanonicalPath: params.context.rootCanonicalPath,
		absolutePath: params.context.absolutePath,
		canonicalOutsideLexicalPath: params.context.canonicalOutsideLexicalPath,
		rootPath: params.context.rootPath,
		kind: params.kind
	});
}
async function resolveOutsideLexicalCanonicalPathAsync(params) {
	if (isPathInside(params.rootPath, params.absolutePath)) return;
	return await resolvePathViaExistingAncestor(params.absolutePath);
}
function resolveOutsideLexicalCanonicalPathSync(params) {
	if (isPathInside(params.rootPath, params.absolutePath)) return;
	return resolvePathViaExistingAncestorSync(params.absolutePath);
}
function buildOutsideLexicalRootPath(params) {
	assertInsideBoundary({
		boundaryLabel: params.boundaryLabel,
		rootCanonicalPath: params.rootCanonicalPath,
		candidatePath: params.canonicalOutsideLexicalPath,
		absolutePath: params.absolutePath
	});
	return buildResolvedRootPath({
		absolutePath: params.absolutePath,
		canonicalPath: params.canonicalOutsideLexicalPath,
		rootPath: params.rootPath,
		rootCanonicalPath: params.rootCanonicalPath,
		kind: params.kind
	});
}
function assertLexicalBoundaryOrCanonicalAlias(params) {
	if (params.skipLexicalRootCheck || params.lexicalInside) return;
	if (isPathInside(params.rootCanonicalPath, params.canonicalOutsideLexicalPath)) return;
	throw pathEscapeError({
		boundaryLabel: params.boundaryLabel,
		rootPath: params.rootPath,
		absolutePath: params.absolutePath
	});
}
function buildResolvedRootPath(params) {
	return {
		absolutePath: params.absolutePath,
		canonicalPath: params.canonicalPath,
		rootPath: params.rootPath,
		rootCanonicalPath: params.rootCanonicalPath,
		relativePath: relativeInsideRoot(params.rootCanonicalPath, params.canonicalPath),
		exists: params.kind.exists,
		kind: params.kind.kind
	};
}
async function resolvePathViaExistingAncestor(targetPath) {
	const normalized = path.resolve(targetPath);
	let cursor = normalized;
	const missingSuffix = [];
	while (!isFilesystemRoot(cursor) && !await pathExists(cursor)) {
		missingSuffix.unshift(path.basename(cursor));
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	if (!await pathExists(cursor)) return normalized;
	try {
		const resolvedAncestor = path.resolve(await fs$1.realpath(cursor));
		if (missingSuffix.length === 0) return resolvedAncestor;
		return path.resolve(resolvedAncestor, ...missingSuffix);
	} catch {
		return normalized;
	}
}
function resolvePathViaExistingAncestorSync(targetPath) {
	const normalized = path.resolve(targetPath);
	let cursor = normalized;
	const missingSuffix = [];
	while (!isFilesystemRoot(cursor) && !fs.existsSync(cursor)) {
		missingSuffix.unshift(path.basename(cursor));
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	if (!fs.existsSync(cursor)) return normalized;
	try {
		const resolvedAncestor = path.resolve(fs.realpathSync(cursor));
		if (missingSuffix.length === 0) return resolvedAncestor;
		return path.resolve(resolvedAncestor, ...missingSuffix);
	} catch {
		return normalized;
	}
}
async function getPathKind(absolutePath, preserveFinalSymlink) {
	try {
		return {
			exists: true,
			kind: toResolvedKind(preserveFinalSymlink ? await fs$1.lstat(absolutePath) : await fs$1.stat(absolutePath))
		};
	} catch (error) {
		if (isNotFoundPathError(error)) return {
			exists: false,
			kind: "missing"
		};
		throw error;
	}
}
function getPathKindSync(absolutePath, preserveFinalSymlink) {
	try {
		return {
			exists: true,
			kind: toResolvedKind(preserveFinalSymlink ? fs.lstatSync(absolutePath) : fs.statSync(absolutePath))
		};
	} catch (error) {
		if (isNotFoundPathError(error)) return {
			exists: false,
			kind: "missing"
		};
		throw error;
	}
}
function toResolvedKind(stat) {
	if (stat.isFile()) return "file";
	if (stat.isDirectory()) return "directory";
	if (stat.isSymbolicLink()) return "symlink";
	return "other";
}
function relativeInsideRoot(rootPath, targetPath) {
	const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
	if (!relative || relative === ".") return "";
	if (isPathRelativeEscape(relative)) return "";
	return relative;
}
function assertInsideBoundary(params) {
	if (isPathInside(params.rootCanonicalPath, params.candidatePath)) return;
	throw new Error(`Path resolves outside ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.absolutePath)}`);
}
function pathEscapeError(params) {
	return /* @__PURE__ */ new Error(`Path escapes ${params.boundaryLabel} (${shortPath(params.rootPath)}): ${shortPath(params.absolutePath)}`);
}
function symlinkEscapeError(params) {
	return /* @__PURE__ */ new Error(`Symlink escapes ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.symlinkPath)}`);
}
function shortPath(value) {
	const home = os.homedir();
	if (value.startsWith(home)) return `~${value.slice(home.length)}`;
	return value;
}
function isFilesystemRoot(candidate) {
	return path.parse(candidate).root === candidate;
}
async function pathExists(targetPath) {
	try {
		await fs$1.lstat(targetPath);
		return true;
	} catch (error) {
		if (isNotFoundPathError(error)) return false;
		throw error;
	}
}
async function resolveSymlinkHopPath(symlinkPath) {
	try {
		return path.resolve(await fs$1.realpath(symlinkPath));
	} catch (error) {
		if (!isNotFoundPathError(error)) throw error;
		const linkTarget = await fs$1.readlink(symlinkPath);
		return resolvePathViaExistingAncestor(path.resolve(path.dirname(symlinkPath), linkTarget));
	}
}
function resolveSymlinkHopPathSync(symlinkPath) {
	try {
		return path.resolve(fs.realpathSync(symlinkPath));
	} catch (error) {
		if (!isNotFoundPathError(error)) throw error;
		const linkTarget = fs.readlinkSync(symlinkPath);
		return resolvePathViaExistingAncestorSync(path.resolve(path.dirname(symlinkPath), linkTarget));
	}
}
//#endregion
export { resolveRootPathSync as i, resolvePathViaExistingAncestorSync as n, resolveRootPath as r, ROOT_PATH_ALIAS_POLICIES as t };
