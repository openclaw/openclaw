import "./fs-safe-defaults-B7hUN42l.js";
import { i as isPathInside, m as FsSafeError, o as isPathRelativeEscape, r as isNotFoundPathError, s as isSymlinkOpenError } from "./path-BlG8lhgR.js";
import { t as sameFileIdentity } from "./file-identity-BKNyWMFA.js";
import { t as normalizeLowercaseStringOrEmpty } from "./string-coerce-6TL5VVOL.js";
import { c as assertAsyncDirectoryGuard, i as guardedRenameSync, n as registerTempPathForExit, o as guardedRmSync, s as withAsyncDirectoryGuards, t as serializePathWrite, u as createAsyncDirectoryGuard } from "./write-queue-C9nceBqy.js";
import { d as expandHomePrefix, o as root, p as resolveUserPath, s as getFsSafeTestHooks, t as resolveSecureTempRoot } from "./secure-temp-dir-aidxCRgA.js";
import { t as assertSafePathPrefix } from "./safe-path-segment-CvOPESFB.js";
import { a as inspectPathPermissions, c as isWorldReadable, l as isWorldWritable, o as isGroupReadable, s as isGroupWritable, u as modeBits } from "./permissions-ya3cPkFH.js";
import { URL, fileURLToPath } from "node:url";
import fs, { constants } from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import os from "node:os";
import crypto, { randomUUID } from "node:crypto";
//#region node_modules/@openclaw/fs-safe/dist/absolute-path.js
function assertAbsolutePathInput(filePath) {
	if (!filePath) throw new FsSafeError("invalid-path", "path is required");
	if (filePath.includes("\0")) throw new FsSafeError("invalid-path", "path must not contain NUL bytes");
	if (!path.isAbsolute(filePath)) throw new FsSafeError("invalid-path", "path must be absolute");
	return path.normalize(filePath);
}
async function pathExists$1(filePath) {
	try {
		await fs$1.access(filePath);
		return true;
	} catch {
		return false;
	}
}
async function findExistingAncestor(filePath) {
	return (await findExistingAncestorWithStat(filePath))?.path ?? null;
}
async function findExistingAncestorWithStat(filePath) {
	let current = path.resolve(filePath);
	while (true) {
		try {
			return {
				path: current,
				stat: await fs$1.lstat(current)
			};
		} catch (err) {
			if (err.code !== "ENOENT") throw err;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
async function canonicalPathFromExistingAncestor(filePath) {
	const ancestor = await findExistingAncestor(filePath);
	if (!ancestor) return path.resolve(filePath);
	let canonicalAncestor = ancestor;
	try {
		canonicalAncestor = await fs$1.realpath(ancestor);
	} catch {}
	const relative = path.relative(ancestor, filePath);
	return relative ? path.join(canonicalAncestor, relative) : canonicalAncestor;
}
async function resolveAbsolutePathForRead(filePath, options = {}) {
	const normalized = assertAbsolutePathInput(filePath);
	let canonicalPath;
	try {
		canonicalPath = await fs$1.realpath(normalized);
	} catch (err) {
		if (err.code === "ENOENT") throw new FsSafeError("not-found", "path not found", { cause: err });
		throw err;
	}
	if ((options.symlinks ?? "reject") === "reject" && canonicalPath !== normalized) throw new FsSafeError("symlink", "path traverses a symlink", { cause: { canonicalPath } });
	return {
		path: normalized,
		canonicalPath
	};
}
async function resolveAbsolutePathForWrite(filePath, options = {}) {
	const normalized = assertAbsolutePathInput(filePath);
	const parentDir = path.dirname(normalized);
	const parentExists = await pathExists$1(parentDir);
	if ((options.symlinks ?? "reject") === "reject") {
		const ancestor = await findExistingAncestor(parentDir);
		if (ancestor) {
			const canonicalAncestor = await fs$1.realpath(ancestor).catch(() => ancestor);
			if (canonicalAncestor !== ancestor) throw new FsSafeError("symlink", "path traverses a symlink", { cause: { canonicalPath: path.join(canonicalAncestor, path.relative(ancestor, normalized)) } });
		}
	}
	return {
		path: normalized,
		canonicalPath: await canonicalPathFromExistingAncestor(normalized),
		parentDir,
		parentExists
	};
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/filename.js
function sanitizeUntrustedFileName(fileName, fallbackName) {
	const trimmed = typeof fileName === "string" ? fileName.trim() : "";
	if (!trimmed) return fallbackName;
	let base = path.posix.basename(trimmed);
	base = path.win32.basename(base);
	let cleaned = "";
	for (let i = 0; i < base.length; i++) {
		const code = base.charCodeAt(i);
		if (code < 32 || code === 127) continue;
		cleaned += base[i];
	}
	base = cleaned.trim();
	if (!base || base === "." || base === "..") return fallbackName;
	if (base.length > 200) base = base.slice(0, 200);
	return base;
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/fs.js
/**
* Returns true when `fs.stat()` can stat the path.
*
* This follows stat semantics: broken symlinks return false, while symlinks to
* existing targets return true.
*/
async function pathExists(filePath) {
	try {
		await fs$1.stat(filePath);
		return true;
	} catch {
		return false;
	}
}
/**
* Synchronous counterpart to `pathExists()`, with the same `fs.statSync()`
* semantics.
*/
function pathExistsSync(filePath) {
	try {
		fs.statSync(filePath);
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/local-file-access.js
const ENCODED_FILE_URL_SEPARATOR_RE = /%(?:2f|5c)/i;
function isLocalFileUrlHost(hostname) {
	const normalized = normalizeLowercaseStringOrEmpty(hostname);
	return normalized === "" || normalized === "localhost";
}
function hasEncodedFileUrlSeparator(pathname) {
	return ENCODED_FILE_URL_SEPARATOR_RE.test(pathname);
}
function isWindowsNetworkPath(filePath, platform = process.platform) {
	if (platform !== "win32") return false;
	const normalized = filePath.replace(/\//g, "\\");
	return normalized.startsWith("\\\\?\\UNC\\") || normalized.startsWith("\\\\");
}
function isWindowsDriveLetterPath(filePath, platform = process.platform) {
	return platform === "win32" && /^[A-Za-z]:[\\/]/.test(filePath);
}
function assertNoWindowsNetworkPath(filePath, label = "Path") {
	if (isWindowsNetworkPath(filePath)) throw new Error(`${label} cannot use Windows network paths: ${filePath}`);
}
function safeFileURLToPath(fileUrl) {
	let parsed;
	try {
		parsed = new URL(fileUrl);
	} catch {
		throw new Error(`Invalid file:// URL: ${fileUrl}`);
	}
	if (parsed.protocol !== "file:") throw new Error(`Invalid file:// URL: ${fileUrl}`);
	if (!isLocalFileUrlHost(parsed.hostname)) throw new Error(`file:// URLs with remote hosts are not allowed: ${fileUrl}`);
	if (hasEncodedFileUrlSeparator(parsed.pathname)) throw new Error(`file:// URLs cannot encode path separators: ${fileUrl}`);
	const filePath = fileURLToPath(parsed);
	assertNoWindowsNetworkPath(filePath, "Local file URL");
	return filePath;
}
function trySafeFileURLToPath(fileUrl) {
	try {
		return safeFileURLToPath(fileUrl);
	} catch {
		return;
	}
}
function basenameFromMediaSource(source) {
	if (!source) return;
	if (source.startsWith("file://")) {
		const filePath = trySafeFileURLToPath(source);
		return filePath ? path.basename(filePath) || void 0 : void 0;
	}
	if (/^https?:\/\//i.test(source)) try {
		return path.basename(new URL(source).pathname) || void 0;
	} catch {
		return;
	}
	return path.basename(source) || void 0;
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/local-roots.js
function resolveLocalPathInput(input, label) {
	if (input.startsWith("file://")) try {
		return safeFileURLToPath(input);
	} catch {
		const location = label === "file path" ? "" : ` in ${label}`;
		throw new Error(`Invalid file:// URL${location}: ${input}`);
	}
	if (input.includes("\0")) throw new FsSafeError("invalid-path", `${label} must not contain NUL bytes`);
	return resolveUserPath(input);
}
function resolveLocalRootInput(input, label) {
	const trimmed = input.trim();
	if (!trimmed) throw new FsSafeError("invalid-path", `${label} entry is required`);
	const resolved = trimmed.startsWith("file://") ? resolveLocalPathInput(trimmed, label) : expandHomePrefix(trimmed);
	if (resolved.includes("\0")) throw new FsSafeError("invalid-path", `${label} entry must not contain NUL bytes`);
	if (!path.isAbsolute(resolved)) throw new FsSafeError("invalid-path", `${label} entries must be absolute paths: ${input}`);
	return path.resolve(resolved);
}
function isPathInsideRoot(candidate, rootDir) {
	return isPathInside(rootDir, candidate);
}
function resolveRootRealSync(rootDir) {
	try {
		if (!fs.lstatSync(rootDir).isDirectory()) return null;
		return fs.realpathSync(rootDir);
	} catch {
		return null;
	}
}
function resolveCandidateCanonicalSync(filePath) {
	let sawExistingLeaf = false;
	try {
		const stat = fs.lstatSync(filePath);
		sawExistingLeaf = true;
		return {
			exists: true,
			canonicalPath: fs.realpathSync(filePath),
			isFile: stat.isFile()
		};
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	if (sawExistingLeaf) throw new FsSafeError("symlink", "local roots candidate is a dangling symlink");
	let cursor = filePath;
	const missingSegments = [];
	while (true) {
		const parent = path.dirname(cursor);
		if (parent === cursor) return {
			exists: false,
			canonicalPath: filePath
		};
		missingSegments.unshift(path.basename(cursor));
		cursor = parent;
		try {
			fs.lstatSync(cursor);
			const ancestorReal = fs.realpathSync(cursor);
			return {
				exists: false,
				canonicalPath: path.join(ancestorReal, ...missingSegments)
			};
		} catch (err) {
			if (err.code !== "ENOENT") throw err;
		}
	}
}
function resolveLocalPathFromRootsSync(options) {
	const label = options.label ?? "local roots";
	const requestedPath = path.resolve(resolveLocalPathInput(options.filePath, "file path"));
	for (const rootEntry of options.roots) {
		const rootReal = resolveRootRealSync(resolveLocalRootInput(rootEntry, label));
		if (!rootReal) continue;
		let candidate;
		try {
			candidate = resolveCandidateCanonicalSync(requestedPath);
		} catch {
			continue;
		}
		if (!candidate.exists && options.allowMissing !== true) continue;
		if (candidate.exists && options.requireFile === true && !candidate.isFile) continue;
		if (isPathInsideRoot(candidate.canonicalPath, rootReal)) return {
			path: candidate.canonicalPath,
			root: rootReal
		};
	}
	return null;
}
async function readLocalFileFromRoots(options) {
	const label = options.label ?? "local roots";
	const requestedPath = path.resolve(resolveLocalPathInput(options.filePath, "file path"));
	for (const rootEntry of options.roots) {
		const rootDir = resolveLocalRootInput(rootEntry, label);
		let scopedRoot;
		try {
			scopedRoot = await root(rootDir);
		} catch {
			continue;
		}
		const relativePath = path.relative(scopedRoot.rootDir, requestedPath);
		if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) continue;
		try {
			const readOptions = {
				hardlinks: options.hardlinks,
				nonBlockingRead: options.nonBlockingRead,
				symlinks: options.symlinks
			};
			if (options.maxBytes !== void 0) readOptions.maxBytes = options.maxBytes;
			return {
				...await scopedRoot.read(relativePath, readOptions),
				root: scopedRoot.rootReal
			};
		} catch {
			continue;
		}
	}
	return null;
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/root-paths.js
function invalidPath(scopeLabel) {
	return {
		ok: false,
		error: `Invalid path: must stay within ${scopeLabel}`
	};
}
function pathStaysWithinRoot(rootDir, candidatePath) {
	const relative = path.relative(rootDir, candidatePath);
	return Boolean(relative) && !isPathRelativeEscape(relative);
}
async function resolveRealPathIfExists(targetPath) {
	try {
		return await fs$1.realpath(targetPath);
	} catch {
		return;
	}
}
async function resolveTrustedRootRealPath(rootDir) {
	try {
		const rootLstat = await fs$1.lstat(rootDir);
		if (!rootLstat.isDirectory() || rootLstat.isSymbolicLink()) return;
		return await fs$1.realpath(rootDir);
	} catch {
		return;
	}
}
async function validateCanonicalPathWithinRoot(params) {
	try {
		const candidateLstat = await fs$1.lstat(params.candidatePath);
		if (candidateLstat.isSymbolicLink()) return "invalid";
		if (params.expect === "directory" && !candidateLstat.isDirectory()) return "invalid";
		if (params.expect === "file" && !candidateLstat.isFile()) return "invalid";
		if (params.expect === "file" && candidateLstat.nlink > 1) return "invalid";
		const candidateRealPath = await fs$1.realpath(params.candidatePath);
		return isPathInside(params.rootRealPath, candidateRealPath) ? "ok" : "invalid";
	} catch (err) {
		return isNotFoundPathError(err) ? "not-found" : "invalid";
	}
}
function resolvePathWithinRoot(params) {
	const root = path.resolve(params.rootDir);
	const raw = params.requestedPath.trim();
	if (!raw) {
		if (!params.defaultFileName) return {
			ok: false,
			error: "path is required"
		};
		const defaultPath = path.resolve(root, params.defaultFileName);
		if (!pathStaysWithinRoot(root, defaultPath)) return {
			ok: false,
			error: `Invalid path: must stay within ${params.scopeLabel}`
		};
		return {
			ok: true,
			path: defaultPath
		};
	}
	const resolved = path.resolve(root, raw);
	if (!pathStaysWithinRoot(root, resolved)) return {
		ok: false,
		error: `Invalid path: must stay within ${params.scopeLabel}`
	};
	return {
		ok: true,
		path: resolved
	};
}
async function resolveWritablePathWithinRoot(params) {
	const lexical = resolvePathWithinRoot(params);
	if (!lexical.ok) return lexical;
	const rootRealPath = await resolveTrustedRootRealPath(path.resolve(params.rootDir));
	if (!rootRealPath) return invalidPath(params.scopeLabel);
	const requestedPath = lexical.path;
	if (await validateCanonicalPathWithinRoot({
		rootRealPath,
		candidatePath: path.dirname(requestedPath),
		expect: "directory"
	}) !== "ok") return invalidPath(params.scopeLabel);
	if (await validateCanonicalPathWithinRoot({
		rootRealPath,
		candidatePath: requestedPath,
		expect: "file"
	}) === "invalid") return invalidPath(params.scopeLabel);
	return lexical;
}
async function resolveNearestExistingPath(targetPath) {
	let current = path.resolve(targetPath);
	while (true) {
		try {
			await fs$1.lstat(current);
			return current;
		} catch (err) {
			if (!isNotFoundPathError(err)) throw err;
		}
		const parent = path.dirname(current);
		if (parent === current) throw new Error(`failed to resolve existing path for ${targetPath}`);
		current = parent;
	}
}
async function assertNoSymlinkSegments(params) {
	const relative = path.relative(params.rootDir, params.targetPath);
	if (isPathRelativeEscape(relative)) throw new Error(`Invalid path: must stay within ${params.scopeLabel}`);
	let current = params.rootDir;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			const stat = await fs$1.lstat(current);
			if (stat.isSymbolicLink()) throw new Error(`Invalid path: must not traverse symlinks within ${params.scopeLabel}`);
			if (!stat.isDirectory()) throw new Error(`Invalid path: existing segment must be a directory within ${params.scopeLabel}`);
		} catch (err) {
			if (isNotFoundPathError(err)) return;
			throw err;
		}
	}
}
async function ensureDirectoryWithinRoot(params) {
	const lexical = resolvePathWithinRoot({
		rootDir: params.rootDir,
		requestedPath: params.requestedPath,
		scopeLabel: params.scopeLabel,
		defaultFileName: params.defaultDirName
	});
	if (!lexical.ok) return lexical;
	const rootDir = path.resolve(params.rootDir);
	const targetPath = path.resolve(lexical.path);
	try {
		const rootStat = await fs$1.lstat(rootDir);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return invalidPath(params.scopeLabel);
		await assertNoSymlinkSegments({
			rootDir,
			targetPath,
			scopeLabel: params.scopeLabel
		});
		const rootReal = await fs$1.realpath(rootDir);
		const nearestExistingPath = await resolveNearestExistingPath(targetPath);
		if (!isPathInside(rootReal, await fs$1.realpath(nearestExistingPath))) return invalidPath(params.scopeLabel);
		const relative = path.relative(rootDir, targetPath);
		let current = rootDir;
		for (const segment of relative.split(path.sep).filter(Boolean)) {
			current = path.join(current, segment);
			while (true) try {
				const stat = await fs$1.lstat(current);
				if (stat.isSymbolicLink() || !stat.isDirectory()) return invalidPath(params.scopeLabel);
				break;
			} catch (err) {
				if (!isNotFoundPathError(err)) throw err;
				try {
					await fs$1.mkdir(current, { mode: params.mode });
				} catch (mkdirErr) {
					if (isNotFoundPathError(mkdirErr)) throw mkdirErr;
					if (mkdirErr.code === "EEXIST") continue;
					throw mkdirErr;
				}
			}
			if (!isPathInside(rootReal, await fs$1.realpath(current))) return invalidPath(params.scopeLabel);
		}
		if (!isPathInside(rootReal, await fs$1.realpath(targetPath))) return invalidPath(params.scopeLabel);
		return {
			ok: true,
			path: targetPath
		};
	} catch {
		return invalidPath(params.scopeLabel);
	}
}
function resolvePathsWithinRoot(params) {
	const resolvedPaths = [];
	for (const raw of params.requestedPaths) {
		const pathResult = resolvePathWithinRoot({
			rootDir: params.rootDir,
			requestedPath: raw,
			scopeLabel: params.scopeLabel
		});
		if (!pathResult.ok) return {
			ok: false,
			error: pathResult.error
		};
		resolvedPaths.push(pathResult.path);
	}
	return {
		ok: true,
		paths: resolvedPaths
	};
}
async function resolveExistingPathsWithinRoot(params) {
	return await resolveCheckedPathsWithinRoot(params, true);
}
async function resolveStrictExistingPathsWithinRoot(params) {
	return await resolveCheckedPathsWithinRoot(params, false);
}
function pathScope(rootDir, options) {
	const base = {
		rootDir,
		scopeLabel: options.label
	};
	return {
		rootDir,
		label: options.label,
		resolve: (requestedPath, pathOptions) => resolvePathWithinRoot({
			...base,
			requestedPath,
			defaultFileName: pathOptions?.defaultName
		}),
		resolveAll: (requestedPaths) => resolvePathsWithinRoot({
			...base,
			requestedPaths
		}),
		existing: (requestedPaths) => resolveExistingPathsWithinRoot({
			...base,
			requestedPaths
		}),
		files: (requestedPaths) => resolveStrictExistingPathsWithinRoot({
			...base,
			requestedPaths
		}),
		writable: (requestedPath, pathOptions) => resolveWritablePathWithinRoot({
			...base,
			requestedPath,
			defaultFileName: pathOptions?.defaultName
		}),
		ensureDir: (requestedPath, pathOptions) => ensureDirectoryWithinRoot({
			...base,
			requestedPath,
			defaultDirName: pathOptions?.defaultName,
			mode: pathOptions?.mode
		})
	};
}
async function resolveCheckedPathsWithinRoot(params, allowMissingFallback) {
	const rootDir = path.resolve(params.rootDir);
	const rootRealPath = await resolveRealPathIfExists(rootDir);
	const root$1 = rootRealPath ? await root(rootDir) : void 0;
	const isInRoot = (relativePath) => Boolean(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
	const resolveExistingRelativePath = async (requestedPath) => {
		const raw = requestedPath.trim();
		const lexicalPathResult = resolvePathWithinRoot({
			rootDir,
			requestedPath,
			scopeLabel: params.scopeLabel
		});
		if (lexicalPathResult.ok) return {
			ok: true,
			relativePath: path.relative(rootDir, lexicalPathResult.path),
			fallbackPath: lexicalPathResult.path
		};
		if (!rootRealPath || !raw || !path.isAbsolute(raw)) return lexicalPathResult;
		try {
			const resolvedExistingPath = await fs$1.realpath(raw);
			const relativePath = path.relative(rootRealPath, resolvedExistingPath);
			if (!isInRoot(relativePath)) return lexicalPathResult;
			return {
				ok: true,
				relativePath,
				fallbackPath: resolvedExistingPath
			};
		} catch {
			return lexicalPathResult;
		}
	};
	const resolvedPaths = [];
	for (const raw of params.requestedPaths) {
		const pathResult = await resolveExistingRelativePath(raw);
		if (!pathResult.ok) return {
			ok: false,
			error: pathResult.error
		};
		let opened;
		try {
			if (!root$1) throw new FsSafeError("not-found", "root dir not found");
			opened = await root$1.open(pathResult.relativePath);
			resolvedPaths.push(opened.realPath);
		} catch (err) {
			if (allowMissingFallback && err instanceof FsSafeError && err.code === "not-found") {
				if (!rootRealPath) {
					resolvedPaths.push(pathResult.fallbackPath);
					continue;
				}
				try {
					await assertNoSymlinkSegments({
						rootDir,
						targetPath: pathResult.fallbackPath,
						scopeLabel: params.scopeLabel
					});
					const existingPath = await resolveNearestExistingPath(pathResult.fallbackPath);
					if (!isPathInside(rootRealPath, await fs$1.realpath(existingPath))) return invalidPath(params.scopeLabel);
				} catch {
					return invalidPath(params.scopeLabel);
				}
				resolvedPaths.push(pathResult.fallbackPath);
				continue;
			}
			if (err instanceof FsSafeError && err.code === "outside-workspace") return {
				ok: false,
				error: `File is outside ${params.scopeLabel}`
			};
			return {
				ok: false,
				error: `Invalid path: must stay within ${params.scopeLabel} and be a regular non-symlink file`
			};
		} finally {
			await opened?.handle.close().catch(() => {});
		}
	}
	return {
		ok: true,
		paths: resolvedPaths
	};
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/trash.js
const TRASH_DESTINATION_COLLISION_CODES = new Set([
	"EEXIST",
	"ENOTEMPTY",
	"ERR_FS_CP_EEXIST"
]);
const TRASH_DESTINATION_RETRY_LIMIT = 4;
function getFsErrorCode(error) {
	if (!error || typeof error !== "object" || !("code" in error)) return;
	const code = error.code;
	return typeof code === "string" ? code : void 0;
}
function isTrashDestinationCollision(error) {
	const code = getFsErrorCode(error);
	return Boolean(code && TRASH_DESTINATION_COLLISION_CODES.has(code));
}
function isSameOrChildPath(candidate, parent) {
	return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}
function resolveAllowedTrashRoots(allowedRoots) {
	const roots = [...allowedRoots ?? [os.homedir(), os.tmpdir()]].flatMap((root) => {
		const lexicalRoot = path.resolve(root);
		try {
			return [path.resolve(fs.realpathSync.native(root)), lexicalRoot];
		} catch {
			return [lexicalRoot];
		}
	});
	return [...new Set(roots)];
}
function resolveTrashTargetPath(targetPath) {
	try {
		return {
			path: path.resolve(fs.realpathSync.native(targetPath)),
			resolved: true
		};
	} catch {
		return {
			path: path.resolve(targetPath),
			resolved: false
		};
	}
}
function assertAllowedTrashTarget(targetPath, allowedRoots) {
	const stat = fs.lstatSync(path.resolve(targetPath));
	const resolvedTarget = resolveTrashTargetPath(targetPath);
	const resolvedTargetPath = resolvedTarget.path;
	if (!resolveAllowedTrashRoots(allowedRoots).some((root) => resolvedTargetPath !== root && isSameOrChildPath(resolvedTargetPath, root))) throw new Error(`Refusing to trash path outside allowed roots: ${targetPath}`);
	return {
		path: path.resolve(targetPath),
		realPath: resolvedTargetPath,
		realPathResolved: resolvedTarget.resolved,
		stat
	};
}
function assertTrashTargetGuard(guard) {
	if (!sameFileIdentity(fs.lstatSync(guard.path), guard.stat)) throw new Error(`Refusing to trash path after it changed: ${guard.path}`);
	const current = resolveTrashTargetPath(guard.path);
	if (guard.realPathResolved && (!current.resolved || current.path !== guard.realPath)) throw new Error(`Refusing to trash path after it changed: ${guard.path}`);
	if (!guard.realPathResolved && current.resolved) throw new Error(`Refusing to trash path after it changed: ${guard.path}`);
}
function resolveTrashDir() {
	const homeDir = os.homedir();
	const trashDir = path.join(homeDir, ".Trash");
	fs.mkdirSync(trashDir, {
		recursive: true,
		mode: 448
	});
	const trashDirStat = fs.lstatSync(trashDir);
	if (!trashDirStat.isDirectory() || trashDirStat.isSymbolicLink()) throw new Error(`Refusing to use non-directory/symlink trash directory: ${trashDir}`);
	const realHome = path.resolve(fs.realpathSync.native(homeDir));
	const resolvedTrashDir = path.resolve(fs.realpathSync.native(trashDir));
	if (resolvedTrashDir === realHome || !isSameOrChildPath(resolvedTrashDir, realHome)) throw new Error(`Trash directory escaped home directory: ${trashDir}`);
	return resolvedTrashDir;
}
function trashBaseName(targetPath) {
	const resolvedTargetPath = path.resolve(targetPath);
	if (resolvedTargetPath === path.parse(resolvedTargetPath).root) throw new Error(`Refusing to trash root path: ${targetPath}`);
	const base = path.basename(resolvedTargetPath).replace(/[\\/]+/g, "");
	if (!base) throw new Error(`Unable to derive safe trash basename for: ${targetPath}`);
	return base;
}
function resolveContainedPath(root, leaf) {
	const resolvedRoot = path.resolve(root);
	const resolvedPath = path.resolve(resolvedRoot, leaf);
	if (!isSameOrChildPath(resolvedPath, resolvedRoot) || resolvedPath === resolvedRoot) throw new Error(`Trash destination escaped trash directory: ${resolvedPath}`);
	return resolvedPath;
}
function reserveTrashDestination(trashDir, base, timestamp) {
	const containerPrefix = resolveContainedPath(trashDir, `${base}-${timestamp}-`);
	const container = fs.mkdtempSync(containerPrefix);
	const resolvedContainer = path.resolve(container);
	const resolvedTrashDir = path.resolve(trashDir);
	if (resolvedContainer === resolvedTrashDir || !isSameOrChildPath(resolvedContainer, resolvedTrashDir)) throw new Error(`Trash destination escaped trash directory: ${container}`);
	return resolveContainedPath(container, base);
}
function movePathToDestination(target, dest) {
	getFsSafeTestHooks()?.beforeTrashMove?.(target.path, dest);
	assertTrashTargetGuard(target);
	try {
		guardedRenameSync({
			from: target.path,
			to: dest
		});
		return true;
	} catch (error) {
		if (getFsErrorCode(error) !== "EXDEV") {
			if (isTrashDestinationCollision(error)) return false;
			throw error;
		}
	}
	try {
		assertTrashTargetGuard(target);
		fs.cpSync(target.path, dest, {
			recursive: true,
			force: false,
			errorOnExist: true
		});
		assertTrashTargetGuard(target);
		guardedRmSync({
			target: target.path,
			recursive: true,
			force: false,
			verifyAfter: false
		});
		return true;
	} catch (error) {
		if (isTrashDestinationCollision(error)) return false;
		throw error;
	}
}
async function movePathToTrash(targetPath, options = {}) {
	const base = trashBaseName(targetPath);
	const target = assertAllowedTrashTarget(targetPath, options.allowedRoots);
	const trashDir = resolveTrashDir();
	const timestamp = Date.now();
	for (let attempt = 0; attempt < TRASH_DESTINATION_RETRY_LIMIT; attempt += 1) {
		const dest = reserveTrashDestination(trashDir, base, timestamp);
		if (movePathToDestination(target, dest)) return dest;
	}
	throw new Error(`Unable to choose a unique trash destination for ${targetPath}`);
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/timing.js
async function withTimeout(promise, timeoutMs, labelOrOptions = { message: "timeout" }) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await promise;
	const options = typeof labelOrOptions === "string" ? { label: labelOrOptions } : labelOrOptions;
	const createError = options.createError ?? (() => new Error(options.message ?? `${options.label ?? "operation"} timed out after ${timeoutMs}ms`));
	let timeoutId;
	try {
		return await Promise.race([promise, new Promise((_, reject) => {
			timeoutId = setTimeout(() => {
				try {
					reject(createError());
				} catch (error) {
					reject(error);
				}
			}, timeoutMs);
		})]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/sibling-temp.js
function buildTempPath(dir, tempPrefix) {
	const safePrefix = assertSafePathPrefix(tempPrefix ?? ".fs-safe-stream", { label: "sibling temp prefix" });
	return path.join(dir, `${safePrefix}.${process.pid}.${randomUUID()}.tmp`);
}
async function syncFileBestEffort(filePath) {
	const handle = await fs$1.open(filePath, "r+");
	try {
		await handle.sync();
	} catch (error) {
		if (error.code !== "EPERM") throw error;
	} finally {
		await handle.close();
	}
}
async function syncDirectoryBestEffort(dirPath) {
	let handle;
	try {
		handle = await fs$1.open(dirPath, "r");
		await handle.sync();
	} catch {} finally {
		await handle?.close().catch(() => void 0);
	}
}
function assertFinalPathIsSibling(dir, filePath) {
	const resolvedDir = path.resolve(dir);
	const resolvedFile = path.resolve(filePath);
	if (path.dirname(resolvedFile) !== resolvedDir) throw new Error("Final path must be in the sibling temp directory.");
}
async function writeSiblingTempFile(options) {
	const dir = path.resolve(options.dir);
	await fs$1.mkdir(dir, {
		recursive: true,
		mode: options.dirMode ?? 448
	});
	if (options.chmodDir !== false) await fs$1.chmod(dir, options.dirMode ?? 448).catch(() => void 0);
	const dirGuard = await createAsyncDirectoryGuard(dir);
	const tempPath = buildTempPath(dir, options.tempPrefix);
	const unregisterTempPath = registerTempPathForExit(tempPath);
	let tempExists = false;
	try {
		tempExists = true;
		const result = await options.writeTemp(tempPath);
		if (options.mode !== void 0) await fs$1.chmod(tempPath, options.mode).catch(() => void 0);
		if (options.syncTempFile) await syncFileBestEffort(tempPath);
		const filePath = path.resolve(options.resolveFinalPath(result));
		assertFinalPathIsSibling(dir, filePath);
		await serializePathWrite(filePath, async () => {
			await withAsyncDirectoryGuards([dirGuard], async () => {
				await fs$1.rename(tempPath, filePath);
			});
			tempExists = false;
			unregisterTempPath();
			if (options.mode !== void 0) await fs$1.chmod(filePath, options.mode).catch(() => void 0);
			if (options.syncParentDir) await syncDirectoryBestEffort(dir);
		});
		return {
			filePath,
			result
		};
	} finally {
		if (tempExists) await fs$1.rm(tempPath, { force: true }).catch(() => void 0);
		unregisterTempPath();
	}
}
function buildSiblingTempPath(params) {
	const id = crypto.randomUUID();
	const safePrefix = assertSafePathPrefix(params.tempPrefix, { label: "sibling temp prefix" });
	const safeTail = sanitizeUntrustedFileName(path.basename(params.targetPath), params.fallbackFileName);
	return path.join(path.dirname(params.targetPath), `${safePrefix}${id}-${safeTail}.part`);
}
async function writeViaSiblingTempPath(params) {
	const rootDir = await fs$1.realpath(path.resolve(params.rootDir)).catch(() => path.resolve(params.rootDir));
	const requestedTargetPath = path.resolve(params.targetPath);
	const targetPath = await fs$1.realpath(path.dirname(requestedTargetPath)).then((realDir) => path.join(realDir, path.basename(requestedTargetPath))).catch(() => requestedTargetPath);
	const relativeTargetPath = path.relative(rootDir, targetPath);
	if (!relativeTargetPath || relativeTargetPath === ".." || relativeTargetPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTargetPath)) throw new Error("Target path is outside the allowed root");
	const rootGuard = await createAsyncDirectoryGuard(rootDir);
	const tempDir = await fs$1.mkdtemp(path.join(resolveSecureTempRoot({
		fallbackPrefix: "fs-safe-output",
		unsafeFallbackLabel: "sibling temp output dir",
		warn: () => void 0
	}), "fs-safe-output-"));
	const tempPath = buildSiblingTempPath({
		targetPath: path.join(tempDir, path.basename(targetPath)),
		fallbackFileName: params.fallbackFileName ?? "output.bin",
		tempPrefix: params.tempPrefix ?? ".fs-safe-output-"
	});
	const unregisterTempPath = registerTempPathForExit(tempDir, { recursive: true });
	try {
		await getFsSafeTestHooks()?.beforeSiblingTempWrite?.(tempPath);
		await params.writeTemp(tempPath);
		await assertAsyncDirectoryGuard(rootGuard);
		await (await root(rootDir)).copyIn(relativeTargetPath, tempPath, { mkdir: false });
		await assertAsyncDirectoryGuard(rootGuard);
	} finally {
		await fs$1.rm(tempDir, {
			recursive: true,
			force: true
		}).catch(() => {});
		unregisterTempPath();
	}
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/secure-file.js
const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in constants;
const OPEN_READ_FLAGS = constants.O_RDONLY | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
function isAbsolutePathname(value) {
	return path.isAbsolute(value) || process.platform === "win32" && (isWindowsDriveLetterPath(value, "win32") || isWindowsNetworkPath(value, "win32"));
}
function label(options) {
	return options.label ?? "Secure file";
}
async function openSecureHandle(options) {
	if (isWindowsNetworkPath(options.filePath, "win32") && !options.trust?.allowNetworkPath) throw new FsSafeError("invalid-path", `${label(options)} must be a local absolute path.`);
	if (!isAbsolutePathname(options.filePath)) throw new FsSafeError("invalid-path", `${label(options)} must be an absolute path.`);
	const preStat = await fs$1.lstat(options.filePath).catch((err) => {
		throw new FsSafeError("not-found", `${label(options)} is not readable: ${options.filePath}`, { cause: err });
	});
	if (preStat.isDirectory()) throw new FsSafeError("not-file", `${label(options)} must be a file: ${options.filePath}`);
	if (preStat.isSymbolicLink() && !options.trust?.allowSymlink) throw new FsSafeError("symlink", `${label(options)} must not be a symlink: ${options.filePath}`);
	let handle;
	try {
		handle = await fs$1.open(options.filePath, options.trust?.allowSymlink ? constants.O_RDONLY : OPEN_READ_FLAGS);
	} catch (err) {
		if (isSymlinkOpenError(err)) throw new FsSafeError("symlink", `${label(options)} symlink open blocked`, { cause: err });
		throw err;
	}
	try {
		const openedStat = await handle.stat();
		if (!openedStat.isFile()) throw new FsSafeError("not-file", `${label(options)} must be a file: ${options.filePath}`);
		const pathStat = options.trust?.allowSymlink ? await fs$1.stat(options.filePath) : await fs$1.lstat(options.filePath);
		if (!options.trust?.allowSymlink && pathStat.isSymbolicLink()) throw new FsSafeError("symlink", `${label(options)} must not be a symlink: ${options.filePath}`);
		if (!sameFileIdentity(pathStat, openedStat)) throw new FsSafeError("path-mismatch", `${label(options)} changed during open.`);
		const realPath = await fs$1.realpath(options.filePath);
		if (!sameFileIdentity(await fs$1.stat(realPath), openedStat)) throw new FsSafeError("path-mismatch", `${label(options)} real path changed during open.`);
		if (options.io?.maxBytes !== void 0 && openedStat.size > options.io.maxBytes) throw new FsSafeError("too-large", `${label(options)} exceeded maxBytes (${options.io.maxBytes}).`);
		return {
			handle,
			pathStat: openedStat,
			realPath
		};
	} catch (err) {
		await handle.close().catch(() => void 0);
		throw err;
	}
}
async function assertTrustedDirs(options, realPath) {
	if (!options.trust?.trustedDirs || options.trust.trustedDirs.length === 0) return;
	if (!(await Promise.all(options.trust.trustedDirs.map(async (dir) => {
		const resolved = path.resolve(dir);
		return await fs$1.realpath(resolved).catch(() => resolved);
	}))).some((dir) => isPathInside(dir, realPath))) throw new FsSafeError("outside-workspace", `${label(options)} is outside trustedDirs: ${realPath}`);
}
function inspectOpenedPermissions(stat, platform) {
	const bits = modeBits(typeof stat.mode === "number" ? stat.mode : null);
	return {
		ok: true,
		isSymlink: false,
		isDir: stat.isDirectory(),
		mode: typeof stat.mode === "number" ? stat.mode : null,
		bits,
		source: platform === "win32" ? "unknown" : "posix",
		worldWritable: isWorldWritable(bits),
		groupWritable: isGroupWritable(bits),
		worldReadable: isWorldReadable(bits),
		groupReadable: isGroupReadable(bits)
	};
}
async function assertSecurePermissions(options, stat, realPath) {
	if (options.permissions?.allowInsecure) return;
	const platform = options.inject?.platform ?? process.platform;
	const permissions = platform === "win32" ? await inspectPathPermissions(realPath, options.inject) : inspectOpenedPermissions(stat, platform);
	if (!permissions.ok) throw new FsSafeError("permission-unverified", `${label(options)} permissions could not be verified: ${realPath}`);
	if (platform === "win32" && permissions.source === "unknown") throw new FsSafeError("permission-unverified", `${label(options)} ACL verification unavailable on Windows for ${realPath}.`);
	const writableByOthers = permissions.worldWritable || permissions.groupWritable;
	const readableByOthers = permissions.worldReadable || permissions.groupReadable;
	if (writableByOthers || !options.permissions?.allowReadableByOthers && readableByOthers) throw new FsSafeError("insecure-permissions", `${label(options)} permissions are too open: ${realPath}`);
	if (platform !== "win32" && typeof process.getuid === "function" && stat.uid != null) {
		const uid = process.getuid();
		if (stat.uid !== uid) throw new FsSafeError("not-owned", `${label(options)} must be owned by the current user (uid=${uid}): ${realPath}`);
	}
	return permissions;
}
async function readHandleWithTimeout(handle, timeoutMs) {
	if (timeoutMs === void 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return await handle.readFile();
	let timeout;
	try {
		return await Promise.race([handle.readFile(), new Promise((_resolve, reject) => {
			timeout = setTimeout(() => {
				handle.close().catch(() => void 0);
				reject(new FsSafeError("timeout", `secure file read timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		})]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
async function readSecureFile(options) {
	const opened = await openSecureHandle(options);
	try {
		await assertTrustedDirs(options, opened.realPath);
		const permissions = await assertSecurePermissions(options, opened.pathStat, opened.realPath);
		const buffer = await readHandleWithTimeout(opened.handle, options.io?.timeoutMs);
		if (options.io?.maxBytes !== void 0 && buffer.byteLength > options.io.maxBytes) throw new FsSafeError("too-large", `${label(options)} exceeded maxBytes (${options.io.maxBytes}).`);
		return {
			buffer,
			realPath: opened.realPath,
			stat: opened.pathStat,
			permissions
		};
	} finally {
		await opened.handle.close().catch(() => void 0);
	}
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/walk.js
function kindForDirent(dirent) {
	if (dirent.isDirectory()) return "directory";
	if (dirent.isFile()) return "file";
	if (dirent.isSymbolicLink()) return "symlink";
	return "other";
}
function shouldStop(result, options) {
	return options.maxEntries !== void 0 && result.scannedEntryCount >= Math.max(0, options.maxEntries);
}
function buildEntry(params) {
	const fullPath = path.join(params.dir, params.dirent.name);
	const relativePath = path.relative(params.rootDir, fullPath) || params.dirent.name;
	return {
		name: params.dirent.name,
		path: fullPath,
		relativePath,
		depth: params.depth,
		kind: params.kind ?? kindForDirent(params.dirent),
		dirent: params.dirent
	};
}
function resolveSyncKind(fullPath, dirent, symlinks) {
	const kind = kindForDirent(dirent);
	if (kind !== "symlink") return kind;
	if (symlinks === "skip") return null;
	if (symlinks === "include") return "symlink";
	try {
		const stat = fs.statSync(fullPath);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
	} catch {
		return null;
	}
	return "other";
}
async function resolveAsyncKind(fullPath, dirent, symlinks) {
	const kind = kindForDirent(dirent);
	if (kind !== "symlink") return kind;
	if (symlinks === "skip") return null;
	if (symlinks === "include") return "symlink";
	try {
		const stat = await fs$1.stat(fullPath);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
	} catch {
		return null;
	}
	return "other";
}
function walkDirectorySync(rootDir, options = {}) {
	const root = path.resolve(rootDir);
	const symlinks = options.symlinks ?? "skip";
	const result = {
		entries: [],
		scannedEntryCount: 0,
		truncated: false
	};
	const visitedDirs = /* @__PURE__ */ new Set();
	function visit(dir, depth) {
		if (options.maxDepth !== void 0 && depth > options.maxDepth) return;
		let realDir;
		try {
			realDir = fs.realpathSync(dir);
		} catch {
			return;
		}
		if (visitedDirs.has(realDir)) return;
		visitedDirs.add(realDir);
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const dirent of entries) {
			if (shouldStop(result, options)) {
				result.truncated = true;
				return;
			}
			result.scannedEntryCount += 1;
			const fullPath = path.join(dir, dirent.name);
			const kind = resolveSyncKind(fullPath, dirent, symlinks);
			if (!kind) continue;
			const entry = buildEntry({
				rootDir: root,
				dir,
				dirent,
				depth,
				kind
			});
			if (options.include?.(entry) ?? true) result.entries.push(entry);
			if (kind === "directory" && (options.maxDepth === void 0 || depth < options.maxDepth) && (options.descend?.(entry) ?? true)) {
				visit(fullPath, depth + 1);
				if (result.truncated) return;
			}
		}
	}
	visit(root, 1);
	return result;
}
async function walkDirectory(rootDir, options = {}) {
	const root = path.resolve(rootDir);
	const symlinks = options.symlinks ?? "skip";
	const result = {
		entries: [],
		scannedEntryCount: 0,
		truncated: false
	};
	const visitedDirs = /* @__PURE__ */ new Set();
	async function visit(dir, depth) {
		if (options.maxDepth !== void 0 && depth > options.maxDepth) return;
		let realDir;
		try {
			realDir = await fs$1.realpath(dir);
		} catch {
			return;
		}
		if (visitedDirs.has(realDir)) return;
		visitedDirs.add(realDir);
		let entries;
		try {
			entries = await fs$1.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const dirent of entries) {
			if (shouldStop(result, options)) {
				result.truncated = true;
				return;
			}
			result.scannedEntryCount += 1;
			const fullPath = path.join(dir, dirent.name);
			const kind = await resolveAsyncKind(fullPath, dirent, symlinks);
			if (!kind) continue;
			const entry = buildEntry({
				rootDir: root,
				dir,
				dirent,
				depth,
				kind
			});
			if (options.include?.(entry) ?? true) result.entries.push(entry);
			if (kind === "directory" && (options.maxDepth === void 0 || depth < options.maxDepth) && (options.descend?.(entry) ?? true)) {
				await visit(fullPath, depth + 1);
				if (result.truncated) return;
			}
		}
	}
	await visit(root, 1);
	return result;
}
//#endregion
//#region src/infra/fs-safe.ts
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
			const stat = await fs$1.lstat(absolutePath);
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
	const result = await ensureDirectoryWithinRoot({
		rootDir: existingAncestor,
		requestedPath: path.relative(existingAncestor, absolutePath),
		scopeLabel,
		mode: options?.mode
	});
	if (result.ok) return result;
	return {
		ok: false,
		error: new Error(result.error)
	};
}
async function writeExternalFileWithinRoot(options) {
	const targetPath = path.resolve(options.rootDir, options.path);
	await writeViaSiblingTempPath({
		rootDir: options.rootDir,
		targetPath,
		writeTemp: options.write,
		fallbackFileName: options.fallbackFileName,
		tempPrefix: options.tempPrefix
	});
	return { path: targetPath };
}
/** @deprecated Use root(rootDir).read(relativePath, options). */
async function readFileWithinRoot(params) {
	return await (await root(params.rootDir)).read(params.relativePath, {
		hardlinks: params.rejectHardlinks === false ? "allow" : "reject",
		maxBytes: params.maxBytes,
		nonBlockingRead: params.nonBlockingRead,
		symlinks: params.allowSymlinkTargetWithinRoot === true ? "follow-within-root" : "reject"
	});
}
/** @deprecated Use root(rootDir).write(relativePath, data, options). */
async function writeFileWithinRoot(params) {
	await (await root(params.rootDir)).write(params.relativePath, params.data, {
		encoding: params.encoding,
		mkdir: params.mkdir
	});
}
//#endregion
export { canonicalPathFromExistingAncestor as A, isWindowsNetworkPath as C, pathExistsSync as D, pathExists as E, resolveAbsolutePathForRead as M, resolveAbsolutePathForWrite as N, sanitizeUntrustedFileName as O, hasEncodedFileUrlSeparator as S, trySafeFileURLToPath as T, resolveWritablePathWithinRoot as _, walkDirectory as a, assertNoWindowsNetworkPath as b, writeSiblingTempFile as c, movePathToTrash as d, pathScope as f, resolveStrictExistingPathsWithinRoot as g, resolvePathsWithinRoot as h, writeFileWithinRoot as i, findExistingAncestor as j, assertAbsolutePathInput as k, writeViaSiblingTempPath as l, resolvePathWithinRoot as m, readFileWithinRoot as n, walkDirectorySync as o, resolveExistingPathsWithinRoot as p, writeExternalFileWithinRoot as r, readSecureFile as s, ensureAbsoluteDirectory as t, withTimeout as u, readLocalFileFromRoots as v, safeFileURLToPath as w, basenameFromMediaSource as x, resolveLocalPathFromRootsSync as y };
