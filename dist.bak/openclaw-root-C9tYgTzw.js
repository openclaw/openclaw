import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fs$1 from "node:fs/promises";

//#region src/agents/skills/filter.ts
function normalizeSkillFilter(skillFilter) {
	if (skillFilter === void 0) return;
	return skillFilter.map((entry) => String(entry).trim()).filter(Boolean);
}
function normalizeSkillFilterForComparison(skillFilter) {
	const normalized = normalizeSkillFilter(skillFilter);
	if (normalized === void 0) return;
	return Array.from(new Set(normalized)).toSorted();
}
function matchesSkillFilter(cached, next) {
	const cachedNormalized = normalizeSkillFilterForComparison(cached);
	const nextNormalized = normalizeSkillFilterForComparison(next);
	if (cachedNormalized === void 0 || nextNormalized === void 0) return cachedNormalized === nextNormalized;
	if (cachedNormalized.length !== nextNormalized.length) return false;
	return cachedNormalized.every((entry, index) => entry === nextNormalized[index]);
}

//#endregion
//#region src/infra/path-guards.ts
const NOT_FOUND_CODES = new Set(["ENOENT", "ENOTDIR"]);
const SYMLINK_OPEN_CODES = new Set([
	"ELOOP",
	"EINVAL",
	"ENOTSUP"
]);
function normalizeWindowsPathForComparison(input) {
	let normalized = path.win32.normalize(input);
	if (normalized.startsWith("\\\\?\\")) {
		normalized = normalized.slice(4);
		if (normalized.toUpperCase().startsWith("UNC\\")) normalized = `\\\\${normalized.slice(4)}`;
	}
	return normalized.replaceAll("/", "\\").toLowerCase();
}
function isNodeError(value) {
	return Boolean(value && typeof value === "object" && "code" in value);
}
function isNotFoundPathError(value) {
	return isNodeError(value) && typeof value.code === "string" && NOT_FOUND_CODES.has(value.code);
}
function isSymlinkOpenError(value) {
	return isNodeError(value) && typeof value.code === "string" && SYMLINK_OPEN_CODES.has(value.code);
}
function isPathInside(root, target) {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target);
	if (process.platform === "win32") {
		const rootForCompare = normalizeWindowsPathForComparison(resolvedRoot);
		const targetForCompare = normalizeWindowsPathForComparison(resolvedTarget);
		const relative = path.win32.relative(rootForCompare, targetForCompare);
		return relative === "" || !relative.startsWith("..") && !path.win32.isAbsolute(relative);
	}
	const relative = path.relative(resolvedRoot, resolvedTarget);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}

//#endregion
//#region src/infra/boundary-path.ts
const BOUNDARY_PATH_ALIAS_POLICIES = {
	strict: Object.freeze({
		allowFinalSymlinkForUnlink: false,
		allowFinalHardlinkForUnlink: false
	}),
	unlinkTarget: Object.freeze({
		allowFinalSymlinkForUnlink: true,
		allowFinalHardlinkForUnlink: true
	})
};
async function resolveBoundaryPath(params) {
	const rootPath = path.resolve(params.rootPath);
	const absolutePath = path.resolve(params.absolutePath);
	const rootCanonicalPath = params.rootCanonicalPath ? path.resolve(params.rootCanonicalPath) : await resolvePathViaExistingAncestor(rootPath);
	const lexicalInside = isPathInside(rootPath, absolutePath);
	const canonicalOutsideLexicalPath = resolveCanonicalOutsideLexicalPath({
		absolutePath,
		outsideLexicalCanonicalPath: lexicalInside ? void 0 : await resolvePathViaExistingAncestor(absolutePath)
	});
	assertLexicalBoundaryOrCanonicalAlias({
		skipLexicalRootCheck: params.skipLexicalRootCheck,
		lexicalInside,
		canonicalOutsideLexicalPath,
		rootCanonicalPath,
		boundaryLabel: params.boundaryLabel,
		rootPath,
		absolutePath
	});
	if (!lexicalInside) {
		const canonicalPath = canonicalOutsideLexicalPath;
		assertInsideBoundary({
			boundaryLabel: params.boundaryLabel,
			rootCanonicalPath,
			candidatePath: canonicalPath,
			absolutePath
		});
		return buildResolvedBoundaryPath({
			absolutePath,
			canonicalPath,
			rootPath,
			rootCanonicalPath,
			kind: await getPathKind(absolutePath, false)
		});
	}
	return resolveBoundaryPathLexicalAsync({
		params,
		absolutePath,
		rootPath,
		rootCanonicalPath
	});
}
function resolveBoundaryPathSync(params) {
	const rootPath = path.resolve(params.rootPath);
	const absolutePath = path.resolve(params.absolutePath);
	const rootCanonicalPath = params.rootCanonicalPath ? path.resolve(params.rootCanonicalPath) : resolvePathViaExistingAncestorSync(rootPath);
	const lexicalInside = isPathInside(rootPath, absolutePath);
	const canonicalOutsideLexicalPath = resolveCanonicalOutsideLexicalPath({
		absolutePath,
		outsideLexicalCanonicalPath: lexicalInside ? void 0 : resolvePathViaExistingAncestorSync(absolutePath)
	});
	assertLexicalBoundaryOrCanonicalAlias({
		skipLexicalRootCheck: params.skipLexicalRootCheck,
		lexicalInside,
		canonicalOutsideLexicalPath,
		rootCanonicalPath,
		boundaryLabel: params.boundaryLabel,
		rootPath,
		absolutePath
	});
	if (!lexicalInside) {
		const canonicalPath = canonicalOutsideLexicalPath;
		assertInsideBoundary({
			boundaryLabel: params.boundaryLabel,
			rootCanonicalPath,
			candidatePath: canonicalPath,
			absolutePath
		});
		return buildResolvedBoundaryPath({
			absolutePath,
			canonicalPath,
			rootPath,
			rootCanonicalPath,
			kind: getPathKindSync(absolutePath, false)
		});
	}
	return resolveBoundaryPathLexicalSync({
		params,
		absolutePath,
		rootPath,
		rootCanonicalPath
	});
}
async function resolveBoundaryPathLexicalAsync(params) {
	const segments = path.relative(params.rootPath, params.absolutePath).split(path.sep).filter(Boolean);
	const allowFinalSymlink = params.params.policy?.allowFinalSymlinkForUnlink === true;
	let canonicalCursor = params.rootCanonicalPath;
	let lexicalCursor = params.rootPath;
	let preserveFinalSymlink = false;
	for (let idx = 0; idx < segments.length; idx += 1) {
		const segment = segments[idx] ?? "";
		const isLast = idx === segments.length - 1;
		lexicalCursor = path.join(lexicalCursor, segment);
		let stat;
		try {
			stat = await fs$1.lstat(lexicalCursor);
		} catch (error) {
			if (isNotFoundPathError(error)) {
				const missingSuffix = segments.slice(idx);
				canonicalCursor = path.resolve(canonicalCursor, ...missingSuffix);
				assertInsideBoundary({
					boundaryLabel: params.params.boundaryLabel,
					rootCanonicalPath: params.rootCanonicalPath,
					candidatePath: canonicalCursor,
					absolutePath: params.absolutePath
				});
				break;
			}
			throw error;
		}
		if (!stat.isSymbolicLink()) {
			canonicalCursor = path.resolve(canonicalCursor, segment);
			assertInsideBoundary({
				boundaryLabel: params.params.boundaryLabel,
				rootCanonicalPath: params.rootCanonicalPath,
				candidatePath: canonicalCursor,
				absolutePath: params.absolutePath
			});
			continue;
		}
		if (allowFinalSymlink && isLast) {
			preserveFinalSymlink = true;
			canonicalCursor = path.resolve(canonicalCursor, segment);
			assertInsideBoundary({
				boundaryLabel: params.params.boundaryLabel,
				rootCanonicalPath: params.rootCanonicalPath,
				candidatePath: canonicalCursor,
				absolutePath: params.absolutePath
			});
			break;
		}
		const linkCanonical = await resolveSymlinkHopPath(lexicalCursor);
		if (!isPathInside(params.rootCanonicalPath, linkCanonical)) throw symlinkEscapeError({
			boundaryLabel: params.params.boundaryLabel,
			rootCanonicalPath: params.rootCanonicalPath,
			symlinkPath: lexicalCursor
		});
		canonicalCursor = linkCanonical;
		lexicalCursor = linkCanonical;
	}
	assertInsideBoundary({
		boundaryLabel: params.params.boundaryLabel,
		rootCanonicalPath: params.rootCanonicalPath,
		candidatePath: canonicalCursor,
		absolutePath: params.absolutePath
	});
	const kind = await getPathKind(params.absolutePath, preserveFinalSymlink);
	return buildResolvedBoundaryPath({
		absolutePath: params.absolutePath,
		canonicalPath: canonicalCursor,
		rootPath: params.rootPath,
		rootCanonicalPath: params.rootCanonicalPath,
		kind
	});
}
function resolveBoundaryPathLexicalSync(params) {
	const segments = path.relative(params.rootPath, params.absolutePath).split(path.sep).filter(Boolean);
	const allowFinalSymlink = params.params.policy?.allowFinalSymlinkForUnlink === true;
	let canonicalCursor = params.rootCanonicalPath;
	let lexicalCursor = params.rootPath;
	let preserveFinalSymlink = false;
	for (let idx = 0; idx < segments.length; idx += 1) {
		const segment = segments[idx] ?? "";
		const isLast = idx === segments.length - 1;
		lexicalCursor = path.join(lexicalCursor, segment);
		let stat;
		try {
			stat = fs.lstatSync(lexicalCursor);
		} catch (error) {
			if (isNotFoundPathError(error)) {
				const missingSuffix = segments.slice(idx);
				canonicalCursor = path.resolve(canonicalCursor, ...missingSuffix);
				assertInsideBoundary({
					boundaryLabel: params.params.boundaryLabel,
					rootCanonicalPath: params.rootCanonicalPath,
					candidatePath: canonicalCursor,
					absolutePath: params.absolutePath
				});
				break;
			}
			throw error;
		}
		if (!stat.isSymbolicLink()) {
			canonicalCursor = path.resolve(canonicalCursor, segment);
			assertInsideBoundary({
				boundaryLabel: params.params.boundaryLabel,
				rootCanonicalPath: params.rootCanonicalPath,
				candidatePath: canonicalCursor,
				absolutePath: params.absolutePath
			});
			continue;
		}
		if (allowFinalSymlink && isLast) {
			preserveFinalSymlink = true;
			canonicalCursor = path.resolve(canonicalCursor, segment);
			assertInsideBoundary({
				boundaryLabel: params.params.boundaryLabel,
				rootCanonicalPath: params.rootCanonicalPath,
				candidatePath: canonicalCursor,
				absolutePath: params.absolutePath
			});
			break;
		}
		const linkCanonical = resolveSymlinkHopPathSync(lexicalCursor);
		if (!isPathInside(params.rootCanonicalPath, linkCanonical)) throw symlinkEscapeError({
			boundaryLabel: params.params.boundaryLabel,
			rootCanonicalPath: params.rootCanonicalPath,
			symlinkPath: lexicalCursor
		});
		canonicalCursor = linkCanonical;
		lexicalCursor = linkCanonical;
	}
	assertInsideBoundary({
		boundaryLabel: params.params.boundaryLabel,
		rootCanonicalPath: params.rootCanonicalPath,
		candidatePath: canonicalCursor,
		absolutePath: params.absolutePath
	});
	const kind = getPathKindSync(params.absolutePath, preserveFinalSymlink);
	return buildResolvedBoundaryPath({
		absolutePath: params.absolutePath,
		canonicalPath: canonicalCursor,
		rootPath: params.rootPath,
		rootCanonicalPath: params.rootCanonicalPath,
		kind
	});
}
function resolveCanonicalOutsideLexicalPath(params) {
	return params.outsideLexicalCanonicalPath ?? params.absolutePath;
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
function buildResolvedBoundaryPath(params) {
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
	if (relative.startsWith("..") || path.isAbsolute(relative)) return "";
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
//#region src/infra/file-identity.ts
function isZero(value) {
	return value === 0 || value === 0n;
}
function sameFileIdentity$1(left, right, platform = process.platform) {
	if (left.ino !== right.ino) return false;
	if (left.dev === right.dev) return true;
	return platform === "win32" && (isZero(left.dev) || isZero(right.dev));
}

//#endregion
//#region src/infra/safe-open-sync.ts
function isExpectedPathError(error) {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}
function sameFileIdentity(left, right) {
	return sameFileIdentity$1(left, right);
}
function openVerifiedFileSync(params) {
	const ioFs = params.ioFs ?? fs;
	const openReadFlags = ioFs.constants.O_RDONLY | (typeof ioFs.constants.O_NOFOLLOW === "number" ? ioFs.constants.O_NOFOLLOW : 0);
	let fd = null;
	try {
		if (params.rejectPathSymlink) {
			if (ioFs.lstatSync(params.filePath).isSymbolicLink()) return {
				ok: false,
				reason: "validation"
			};
		}
		const realPath = params.resolvedPath ?? ioFs.realpathSync(params.filePath);
		const preOpenStat = ioFs.lstatSync(realPath);
		if (!preOpenStat.isFile()) return {
			ok: false,
			reason: "validation"
		};
		if (params.rejectHardlinks && preOpenStat.nlink > 1) return {
			ok: false,
			reason: "validation"
		};
		if (params.maxBytes !== void 0 && preOpenStat.size > params.maxBytes) return {
			ok: false,
			reason: "validation"
		};
		fd = ioFs.openSync(realPath, openReadFlags);
		const openedStat = ioFs.fstatSync(fd);
		if (!openedStat.isFile()) return {
			ok: false,
			reason: "validation"
		};
		if (params.rejectHardlinks && openedStat.nlink > 1) return {
			ok: false,
			reason: "validation"
		};
		if (params.maxBytes !== void 0 && openedStat.size > params.maxBytes) return {
			ok: false,
			reason: "validation"
		};
		if (!sameFileIdentity(preOpenStat, openedStat)) return {
			ok: false,
			reason: "validation"
		};
		const opened = {
			ok: true,
			path: realPath,
			fd,
			stat: openedStat
		};
		fd = null;
		return opened;
	} catch (error) {
		if (isExpectedPathError(error)) return {
			ok: false,
			reason: "path",
			error
		};
		return {
			ok: false,
			reason: "io",
			error
		};
	} finally {
		if (fd !== null) ioFs.closeSync(fd);
	}
}

//#endregion
//#region src/infra/boundary-file-read.ts
function canUseBoundaryFileOpen(ioFs) {
	return typeof ioFs.openSync === "function" && typeof ioFs.closeSync === "function" && typeof ioFs.fstatSync === "function" && typeof ioFs.lstatSync === "function" && typeof ioFs.realpathSync === "function" && typeof ioFs.readFileSync === "function" && typeof ioFs.constants === "object" && ioFs.constants !== null;
}
function openBoundaryFileSync(params) {
	const ioFs = params.ioFs ?? fs;
	const absolutePath = path.resolve(params.absolutePath);
	let resolvedPath;
	let rootRealPath;
	try {
		const resolved = resolveBoundaryPathSync({
			absolutePath,
			rootPath: params.rootPath,
			rootCanonicalPath: params.rootRealPath,
			boundaryLabel: params.boundaryLabel,
			skipLexicalRootCheck: params.skipLexicalRootCheck
		});
		resolvedPath = resolved.canonicalPath;
		rootRealPath = resolved.rootCanonicalPath;
	} catch (error) {
		return {
			ok: false,
			reason: "validation",
			error
		};
	}
	const opened = openVerifiedFileSync({
		filePath: absolutePath,
		resolvedPath,
		rejectHardlinks: params.rejectHardlinks ?? true,
		maxBytes: params.maxBytes,
		ioFs
	});
	if (!opened.ok) return opened;
	return {
		ok: true,
		path: opened.path,
		fd: opened.fd,
		stat: opened.stat,
		rootRealPath
	};
}
async function openBoundaryFile(params) {
	try {
		await resolveBoundaryPath({
			absolutePath: params.absolutePath,
			rootPath: params.rootPath,
			rootCanonicalPath: params.rootRealPath,
			boundaryLabel: params.boundaryLabel,
			policy: params.aliasPolicy,
			skipLexicalRootCheck: params.skipLexicalRootCheck
		});
	} catch (error) {
		return {
			ok: false,
			reason: "validation",
			error
		};
	}
	return openBoundaryFileSync(params);
}

//#endregion
//#region src/infra/openclaw-root.ts
const CORE_PACKAGE_NAMES = new Set(["openclaw"]);
async function readPackageName(dir) {
	try {
		const raw = await fs$1.readFile(path.join(dir, "package.json"), "utf-8");
		const parsed = JSON.parse(raw);
		return typeof parsed.name === "string" ? parsed.name : null;
	} catch {
		return null;
	}
}
function readPackageNameSync(dir) {
	try {
		const raw = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
		const parsed = JSON.parse(raw);
		return typeof parsed.name === "string" ? parsed.name : null;
	} catch {
		return null;
	}
}
async function findPackageRoot(startDir, maxDepth = 12) {
	for (const current of iterAncestorDirs(startDir, maxDepth)) {
		const name = await readPackageName(current);
		if (name && CORE_PACKAGE_NAMES.has(name)) return current;
	}
	return null;
}
function findPackageRootSync(startDir, maxDepth = 12) {
	for (const current of iterAncestorDirs(startDir, maxDepth)) {
		const name = readPackageNameSync(current);
		if (name && CORE_PACKAGE_NAMES.has(name)) return current;
	}
	return null;
}
function* iterAncestorDirs(startDir, maxDepth) {
	let current = path.resolve(startDir);
	for (let i = 0; i < maxDepth; i += 1) {
		yield current;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
}
function candidateDirsFromArgv1(argv1) {
	const normalized = path.resolve(argv1);
	const candidates = [path.dirname(normalized)];
	try {
		const resolved = fs.realpathSync(normalized);
		if (resolved !== normalized) candidates.push(path.dirname(resolved));
	} catch {}
	const parts = normalized.split(path.sep);
	const binIndex = parts.lastIndexOf(".bin");
	if (binIndex > 0 && parts[binIndex - 1] === "node_modules") {
		const binName = path.basename(normalized);
		const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
		candidates.push(path.join(nodeModulesDir, binName));
	}
	return candidates;
}
async function resolveOpenClawPackageRoot(opts) {
	for (const candidate of buildCandidates(opts)) {
		const found = await findPackageRoot(candidate);
		if (found) return found;
	}
	return null;
}
function resolveOpenClawPackageRootSync(opts) {
	for (const candidate of buildCandidates(opts)) {
		const found = findPackageRootSync(candidate);
		if (found) return found;
	}
	return null;
}
function buildCandidates(opts) {
	const candidates = [];
	if (opts.moduleUrl) candidates.push(path.dirname(fileURLToPath(opts.moduleUrl)));
	if (opts.argv1) candidates.push(...candidateDirsFromArgv1(opts.argv1));
	if (opts.cwd) candidates.push(opts.cwd);
	return candidates;
}

//#endregion
export { openBoundaryFileSync as a, BOUNDARY_PATH_ALIAS_POLICIES as c, isNotFoundPathError as d, isPathInside as f, normalizeSkillFilter as h, openBoundaryFile as i, resolveBoundaryPath as l, matchesSkillFilter as m, resolveOpenClawPackageRootSync as n, openVerifiedFileSync as o, isSymlinkOpenError as p, canUseBoundaryFileOpen as r, sameFileIdentity$1 as s, resolveOpenClawPackageRoot as t, resolvePathViaExistingAncestorSync as u };