import { b as isSubagentSessionKey, l as resolveAgentIdFromSessionKey, s as normalizeAgentId, t as DEFAULT_AGENT_ID, x as parseAgentSessionKey, y as isCronSessionKey } from "./session-key-47BV2tLd.js";
import { s as resolveStateDir, u as resolveRequiredHomeDir } from "./paths-DVWx7USN.js";
import { H as resolveUserPath, Q as info, Z as danger, et as logVerboseConsole, i as defaultRuntime, it as warn, lt as getLogger, nt as shouldLogVerbose, t as createSubsystemLogger, z as pathExists$1 } from "./subsystem-B0uKDnzH.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import fs$1 from "node:fs/promises";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

//#region src/config/model-input.ts
function resolveAgentModelPrimaryValue(model) {
	if (typeof model === "string") return model.trim() || void 0;
	if (!model || typeof model !== "object") return;
	return model.primary?.trim() || void 0;
}
function resolveAgentModelFallbackValues(model) {
	if (!model || typeof model !== "object") return [];
	return Array.isArray(model.fallbacks) ? model.fallbacks : [];
}
function toAgentModelListLike(model) {
	if (typeof model === "string") {
		const primary = model.trim();
		return primary ? { primary } : void 0;
	}
	if (!model || typeof model !== "object") return;
	return model;
}

//#endregion
//#region src/agents/skills/filter.ts
function normalizeSkillFilter(skillFilter) {
	if (skillFilter === void 0) return;
	return skillFilter.map((entry) => String(entry).trim()).filter(Boolean);
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
//#region src/logger.ts
const subsystemPrefixRe = /^([a-z][a-z0-9-]{1,20}):\s+(.*)$/i;
function splitSubsystem(message) {
	const match = message.match(subsystemPrefixRe);
	if (!match) return null;
	const [, subsystem, rest] = match;
	return {
		subsystem,
		rest
	};
}
function logInfo(message, runtime = defaultRuntime) {
	const parsed = runtime === defaultRuntime ? splitSubsystem(message) : null;
	if (parsed) {
		createSubsystemLogger(parsed.subsystem).info(parsed.rest);
		return;
	}
	runtime.log(info(message));
	getLogger().info(message);
}
function logWarn(message, runtime = defaultRuntime) {
	const parsed = runtime === defaultRuntime ? splitSubsystem(message) : null;
	if (parsed) {
		createSubsystemLogger(parsed.subsystem).warn(parsed.rest);
		return;
	}
	runtime.log(warn(message));
	getLogger().warn(message);
}
function logError(message, runtime = defaultRuntime) {
	const parsed = runtime === defaultRuntime ? splitSubsystem(message) : null;
	if (parsed) {
		createSubsystemLogger(parsed.subsystem).error(parsed.rest);
		return;
	}
	runtime.error(danger(message));
	getLogger().error(message);
}
function logDebug(message) {
	getLogger().debug(message);
	logVerboseConsole(message);
}

//#endregion
//#region src/process/spawn-utils.ts
const DEFAULT_RETRY_CODES = ["EBADF"];
function resolveCommandStdio(params) {
	return [
		params.hasInput ? "pipe" : params.preferInherit ? "inherit" : "pipe",
		"pipe",
		"pipe"
	];
}
function shouldRetry(err, codes) {
	const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
	return code.length > 0 && codes.includes(code);
}
async function spawnAndWaitForSpawn(spawnImpl, argv, options) {
	const child = spawnImpl(argv[0], argv.slice(1), options);
	return await new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			child.removeListener("error", onError);
			child.removeListener("spawn", onSpawn);
		};
		const finishResolve = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(child);
		};
		const onError = (err) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};
		const onSpawn = () => {
			finishResolve();
		};
		child.once("error", onError);
		child.once("spawn", onSpawn);
		process.nextTick(() => {
			if (typeof child.pid === "number") finishResolve();
		});
	});
}
async function spawnWithFallback(params) {
	const spawnImpl = params.spawnImpl ?? spawn;
	const retryCodes = params.retryCodes ?? DEFAULT_RETRY_CODES;
	const baseOptions = { ...params.options };
	const fallbacks = params.fallbacks ?? [];
	const attempts = [{ options: baseOptions }, ...fallbacks.map((fallback) => ({
		label: fallback.label,
		options: {
			...baseOptions,
			...fallback.options
		}
	}))];
	let lastError;
	for (let index = 0; index < attempts.length; index += 1) {
		const attempt = attempts[index];
		try {
			return {
				child: await spawnAndWaitForSpawn(spawnImpl, params.argv, attempt.options),
				usedFallback: index > 0,
				fallbackLabel: attempt.label
			};
		} catch (err) {
			lastError = err;
			const nextFallback = fallbacks[index];
			if (!nextFallback || !shouldRetry(err, retryCodes)) throw err;
			params.onFallback?.(err, nextFallback);
		}
	}
	throw lastError;
}

//#endregion
//#region src/process/exec.ts
const execFileAsync = promisify(execFile);
/**
* Resolves a command for Windows compatibility.
* On Windows, non-.exe commands (like npm, pnpm) require their .cmd extension.
*/
function resolveCommand(command) {
	if (process.platform !== "win32") return command;
	const basename = path.basename(command).toLowerCase();
	if (path.extname(basename)) return command;
	if ([
		"npm",
		"pnpm",
		"yarn",
		"npx"
	].includes(basename)) return `${command}.cmd`;
	return command;
}
function shouldSpawnWithShell(params) {
	return false;
}
async function runExec(command, args, opts = 1e4) {
	const options = typeof opts === "number" ? {
		timeout: opts,
		encoding: "utf8"
	} : {
		timeout: opts.timeoutMs,
		maxBuffer: opts.maxBuffer,
		cwd: opts.cwd,
		encoding: "utf8"
	};
	try {
		const { stdout, stderr } = await execFileAsync(resolveCommand(command), args, options);
		if (shouldLogVerbose()) {
			if (stdout.trim()) logDebug(stdout.trim());
			if (stderr.trim()) logError(stderr.trim());
		}
		return {
			stdout,
			stderr
		};
	} catch (err) {
		if (shouldLogVerbose()) logError(danger(`Command failed: ${command} ${args.join(" ")}`));
		throw err;
	}
}
async function runCommandWithTimeout(argv, optionsOrTimeout) {
	const options = typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
	const { timeoutMs, cwd, input, env, noOutputTimeoutMs } = options;
	const { windowsVerbatimArguments } = options;
	const hasInput = input !== void 0;
	const shouldSuppressNpmFund = (() => {
		const cmd = path.basename(argv[0] ?? "");
		if (cmd === "npm" || cmd === "npm.cmd" || cmd === "npm.exe") return true;
		if (cmd === "node" || cmd === "node.exe") return (argv[1] ?? "").includes("npm-cli.js");
		return false;
	})();
	const mergedEnv = env ? {
		...process.env,
		...env
	} : { ...process.env };
	const resolvedEnv = Object.fromEntries(Object.entries(mergedEnv).filter(([, value]) => value !== void 0).map(([key, value]) => [key, String(value)]));
	if (shouldSuppressNpmFund) {
		if (resolvedEnv.NPM_CONFIG_FUND == null) resolvedEnv.NPM_CONFIG_FUND = "false";
		if (resolvedEnv.npm_config_fund == null) resolvedEnv.npm_config_fund = "false";
	}
	const stdio = resolveCommandStdio({
		hasInput,
		preferInherit: true
	});
	const resolvedCommand = resolveCommand(argv[0] ?? "");
	const child = spawn(resolvedCommand, argv.slice(1), {
		stdio,
		cwd,
		env: resolvedEnv,
		windowsVerbatimArguments,
		...shouldSpawnWithShell({
			resolvedCommand,
			platform: process.platform
		}) ? { shell: true } : {}
	});
	return await new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let noOutputTimedOut = false;
		let noOutputTimer = null;
		const shouldTrackOutputTimeout = typeof noOutputTimeoutMs === "number" && Number.isFinite(noOutputTimeoutMs) && noOutputTimeoutMs > 0;
		const clearNoOutputTimer = () => {
			if (!noOutputTimer) return;
			clearTimeout(noOutputTimer);
			noOutputTimer = null;
		};
		const armNoOutputTimer = () => {
			if (!shouldTrackOutputTimeout || settled) return;
			clearNoOutputTimer();
			noOutputTimer = setTimeout(() => {
				if (settled) return;
				noOutputTimedOut = true;
				if (typeof child.kill === "function") child.kill("SIGKILL");
			}, Math.floor(noOutputTimeoutMs));
		};
		const timer = setTimeout(() => {
			timedOut = true;
			if (typeof child.kill === "function") child.kill("SIGKILL");
		}, timeoutMs);
		armNoOutputTimer();
		if (hasInput && child.stdin) {
			child.stdin.write(input ?? "");
			child.stdin.end();
		}
		child.stdout?.on("data", (d) => {
			stdout += d.toString();
			armNoOutputTimer();
		});
		child.stderr?.on("data", (d) => {
			stderr += d.toString();
			armNoOutputTimer();
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearNoOutputTimer();
			reject(err);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearNoOutputTimer();
			const termination = noOutputTimedOut ? "no-output-timeout" : timedOut ? "timeout" : signal != null ? "signal" : "exit";
			resolve({
				pid: child.pid ?? void 0,
				stdout,
				stderr,
				code,
				signal,
				killed: child.killed,
				termination,
				noOutputTimedOut
			});
		});
	});
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
//#region src/agents/workspace-templates.ts
const FALLBACK_TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/reference/templates");
let cachedTemplateDir;
let resolvingTemplateDir;
async function resolveWorkspaceTemplateDir(opts) {
	if (cachedTemplateDir) return cachedTemplateDir;
	if (resolvingTemplateDir) return resolvingTemplateDir;
	resolvingTemplateDir = (async () => {
		const moduleUrl = opts?.moduleUrl ?? import.meta.url;
		const argv1 = opts?.argv1 ?? process.argv[1];
		const cwd = opts?.cwd ?? process.cwd();
		const packageRoot = await resolveOpenClawPackageRoot({
			moduleUrl,
			argv1,
			cwd
		});
		const candidates = [
			packageRoot ? path.join(packageRoot, "docs", "reference", "templates") : null,
			cwd ? path.resolve(cwd, "docs", "reference", "templates") : null,
			FALLBACK_TEMPLATE_DIR
		].filter(Boolean);
		for (const candidate of candidates) if (await pathExists$1(candidate)) {
			cachedTemplateDir = candidate;
			return candidate;
		}
		cachedTemplateDir = candidates[0] ?? FALLBACK_TEMPLATE_DIR;
		return cachedTemplateDir;
	})();
	try {
		return await resolvingTemplateDir;
	} finally {
		resolvingTemplateDir = void 0;
	}
}

//#endregion
//#region src/agents/workspace.ts
function resolveDefaultAgentWorkspaceDir(env = process.env, homedir = os.homedir) {
	const home = resolveRequiredHomeDir(env, homedir);
	const profile = env.OPENCLAW_PROFILE?.trim();
	if (profile && profile.toLowerCase() !== "default") return path.join(home, ".openclaw", `workspace-${profile}`);
	return path.join(home, ".openclaw", "workspace");
}
const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();
const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
const DEFAULT_SOUL_FILENAME = "SOUL.md";
const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
const DEFAULT_USER_FILENAME = "USER.md";
const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";
const WORKSPACE_STATE_DIRNAME = ".openclaw";
const WORKSPACE_STATE_FILENAME = "workspace-state.json";
const WORKSPACE_STATE_VERSION = 1;
const workspaceTemplateCache = /* @__PURE__ */ new Map();
let gitAvailabilityPromise = null;
const MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES = 2 * 1024 * 1024;
const workspaceFileCache = /* @__PURE__ */ new Map();
function workspaceFileIdentity(stat, canonicalPath) {
	return `${canonicalPath}|${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}
async function readWorkspaceFileWithGuards(params) {
	const opened = await openBoundaryFile({
		absolutePath: params.filePath,
		rootPath: params.workspaceDir,
		boundaryLabel: "workspace root",
		maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES
	});
	if (!opened.ok) {
		workspaceFileCache.delete(params.filePath);
		return opened;
	}
	const identity = workspaceFileIdentity(opened.stat, opened.path);
	const cached = workspaceFileCache.get(params.filePath);
	if (cached && cached.identity === identity) {
		fs.closeSync(opened.fd);
		return {
			ok: true,
			content: cached.content
		};
	}
	try {
		const content = fs.readFileSync(opened.fd, "utf-8");
		workspaceFileCache.set(params.filePath, {
			content,
			identity
		});
		return {
			ok: true,
			content
		};
	} catch (error) {
		workspaceFileCache.delete(params.filePath);
		return {
			ok: false,
			reason: "io",
			error
		};
	} finally {
		fs.closeSync(opened.fd);
	}
}
function stripFrontMatter(content) {
	if (!content.startsWith("---")) return content;
	const endIndex = content.indexOf("\n---", 3);
	if (endIndex === -1) return content;
	const start = endIndex + 4;
	let trimmed = content.slice(start);
	trimmed = trimmed.replace(/^\s+/, "");
	return trimmed;
}
async function loadTemplate(name) {
	const cached = workspaceTemplateCache.get(name);
	if (cached) return cached;
	const pending = (async () => {
		const templateDir = await resolveWorkspaceTemplateDir();
		const templatePath = path.join(templateDir, name);
		try {
			return stripFrontMatter(await fs$1.readFile(templatePath, "utf-8"));
		} catch {
			throw new Error(`Missing workspace template: ${name} (${templatePath}). Ensure docs/reference/templates are packaged.`);
		}
	})();
	workspaceTemplateCache.set(name, pending);
	try {
		return await pending;
	} catch (error) {
		workspaceTemplateCache.delete(name);
		throw error;
	}
}
async function writeFileIfMissing(filePath, content) {
	try {
		await fs$1.writeFile(filePath, content, {
			encoding: "utf-8",
			flag: "wx"
		});
		return true;
	} catch (err) {
		if (err.code !== "EEXIST") throw err;
		return false;
	}
}
async function fileExists(filePath) {
	try {
		await fs$1.access(filePath);
		return true;
	} catch {
		return false;
	}
}
function resolveWorkspaceStatePath(dir) {
	return path.join(dir, WORKSPACE_STATE_DIRNAME, WORKSPACE_STATE_FILENAME);
}
function parseWorkspaceOnboardingState(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		return {
			version: WORKSPACE_STATE_VERSION,
			bootstrapSeededAt: typeof parsed.bootstrapSeededAt === "string" ? parsed.bootstrapSeededAt : void 0,
			onboardingCompletedAt: typeof parsed.onboardingCompletedAt === "string" ? parsed.onboardingCompletedAt : void 0
		};
	} catch {
		return null;
	}
}
async function readWorkspaceOnboardingState(statePath) {
	try {
		return parseWorkspaceOnboardingState(await fs$1.readFile(statePath, "utf-8")) ?? { version: WORKSPACE_STATE_VERSION };
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
		return { version: WORKSPACE_STATE_VERSION };
	}
}
async function writeWorkspaceOnboardingState(statePath, state) {
	await fs$1.mkdir(path.dirname(statePath), { recursive: true });
	const payload = `${JSON.stringify(state, null, 2)}\n`;
	const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
	try {
		await fs$1.writeFile(tmpPath, payload, { encoding: "utf-8" });
		await fs$1.rename(tmpPath, statePath);
	} catch (err) {
		await fs$1.unlink(tmpPath).catch(() => {});
		throw err;
	}
}
async function hasGitRepo(dir) {
	try {
		await fs$1.stat(path.join(dir, ".git"));
		return true;
	} catch {
		return false;
	}
}
async function isGitAvailable() {
	if (gitAvailabilityPromise) return gitAvailabilityPromise;
	gitAvailabilityPromise = (async () => {
		try {
			return (await runCommandWithTimeout(["git", "--version"], { timeoutMs: 2e3 })).code === 0;
		} catch {
			return false;
		}
	})();
	return gitAvailabilityPromise;
}
async function ensureGitRepo(dir, isBrandNewWorkspace) {
	if (!isBrandNewWorkspace) return;
	if (await hasGitRepo(dir)) return;
	if (!await isGitAvailable()) return;
	try {
		await runCommandWithTimeout(["git", "init"], {
			cwd: dir,
			timeoutMs: 1e4
		});
	} catch {}
}
async function ensureAgentWorkspace(params) {
	const dir = resolveUserPath(params?.dir?.trim() ? params.dir.trim() : DEFAULT_AGENT_WORKSPACE_DIR);
	await fs$1.mkdir(dir, { recursive: true });
	if (!params?.ensureBootstrapFiles) return { dir };
	const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
	const soulPath = path.join(dir, DEFAULT_SOUL_FILENAME);
	const toolsPath = path.join(dir, DEFAULT_TOOLS_FILENAME);
	const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);
	const userPath = path.join(dir, DEFAULT_USER_FILENAME);
	const heartbeatPath = path.join(dir, DEFAULT_HEARTBEAT_FILENAME);
	const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);
	const statePath = resolveWorkspaceStatePath(dir);
	const isBrandNewWorkspace = await (async () => {
		const templatePaths = [
			agentsPath,
			soulPath,
			toolsPath,
			identityPath,
			userPath,
			heartbeatPath
		];
		const userContentPaths = [
			path.join(dir, "memory"),
			path.join(dir, DEFAULT_MEMORY_FILENAME),
			path.join(dir, ".git")
		];
		const paths = [...templatePaths, ...userContentPaths];
		return (await Promise.all(paths.map(async (p) => {
			try {
				await fs$1.access(p);
				return true;
			} catch {
				return false;
			}
		}))).every((v) => !v);
	})();
	const agentsTemplate = await loadTemplate(DEFAULT_AGENTS_FILENAME);
	const soulTemplate = await loadTemplate(DEFAULT_SOUL_FILENAME);
	const toolsTemplate = await loadTemplate(DEFAULT_TOOLS_FILENAME);
	const identityTemplate = await loadTemplate(DEFAULT_IDENTITY_FILENAME);
	const userTemplate = await loadTemplate(DEFAULT_USER_FILENAME);
	const heartbeatTemplate = await loadTemplate(DEFAULT_HEARTBEAT_FILENAME);
	await writeFileIfMissing(agentsPath, agentsTemplate);
	await writeFileIfMissing(soulPath, soulTemplate);
	await writeFileIfMissing(toolsPath, toolsTemplate);
	await writeFileIfMissing(identityPath, identityTemplate);
	await writeFileIfMissing(userPath, userTemplate);
	await writeFileIfMissing(heartbeatPath, heartbeatTemplate);
	let state = await readWorkspaceOnboardingState(statePath);
	let stateDirty = false;
	const markState = (next) => {
		state = {
			...state,
			...next
		};
		stateDirty = true;
	};
	const nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
	let bootstrapExists = await fileExists(bootstrapPath);
	if (!state.bootstrapSeededAt && bootstrapExists) markState({ bootstrapSeededAt: nowIso() });
	if (!state.onboardingCompletedAt && state.bootstrapSeededAt && !bootstrapExists) markState({ onboardingCompletedAt: nowIso() });
	if (!state.bootstrapSeededAt && !state.onboardingCompletedAt && !bootstrapExists) {
		const [identityContent, userContent] = await Promise.all([fs$1.readFile(identityPath, "utf-8"), fs$1.readFile(userPath, "utf-8")]);
		const hasUserContent = await (async () => {
			const indicators = [
				path.join(dir, "memory"),
				path.join(dir, DEFAULT_MEMORY_FILENAME),
				path.join(dir, ".git")
			];
			for (const indicator of indicators) try {
				await fs$1.access(indicator);
				return true;
			} catch {}
			return false;
		})();
		if (identityContent !== identityTemplate || userContent !== userTemplate || hasUserContent) markState({ onboardingCompletedAt: nowIso() });
		else {
			if (!await writeFileIfMissing(bootstrapPath, await loadTemplate(DEFAULT_BOOTSTRAP_FILENAME))) bootstrapExists = await fileExists(bootstrapPath);
			else bootstrapExists = true;
			if (bootstrapExists && !state.bootstrapSeededAt) markState({ bootstrapSeededAt: nowIso() });
		}
	}
	if (stateDirty) await writeWorkspaceOnboardingState(statePath, state);
	await ensureGitRepo(dir, isBrandNewWorkspace);
	return {
		dir,
		agentsPath,
		soulPath,
		toolsPath,
		identityPath,
		userPath,
		heartbeatPath,
		bootstrapPath
	};
}
async function resolveMemoryBootstrapEntries(resolvedDir) {
	const candidates = [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME];
	const entries = [];
	for (const name of candidates) {
		const filePath = path.join(resolvedDir, name);
		try {
			await fs$1.access(filePath);
			entries.push({
				name,
				filePath
			});
		} catch {}
	}
	if (entries.length <= 1) return entries;
	const seen = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const entry of entries) {
		let key = entry.filePath;
		try {
			key = await fs$1.realpath(entry.filePath);
		} catch {}
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(entry);
	}
	return deduped;
}
async function loadWorkspaceBootstrapFiles(dir) {
	const resolvedDir = resolveUserPath(dir);
	const entries = [
		{
			name: DEFAULT_AGENTS_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME)
		},
		{
			name: DEFAULT_SOUL_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME)
		},
		{
			name: DEFAULT_TOOLS_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME)
		},
		{
			name: DEFAULT_IDENTITY_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME)
		},
		{
			name: DEFAULT_USER_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME)
		},
		{
			name: DEFAULT_HEARTBEAT_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_HEARTBEAT_FILENAME)
		},
		{
			name: DEFAULT_BOOTSTRAP_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME)
		}
	];
	entries.push(...await resolveMemoryBootstrapEntries(resolvedDir));
	const result = [];
	for (const entry of entries) {
		const loaded = await readWorkspaceFileWithGuards({
			filePath: entry.filePath,
			workspaceDir: resolvedDir
		});
		if (loaded.ok) result.push({
			name: entry.name,
			path: entry.filePath,
			content: loaded.content,
			missing: false
		});
		else result.push({
			name: entry.name,
			path: entry.filePath,
			missing: true
		});
	}
	return result;
}
const MINIMAL_BOOTSTRAP_ALLOWLIST = new Set([
	DEFAULT_AGENTS_FILENAME,
	DEFAULT_TOOLS_FILENAME,
	DEFAULT_SOUL_FILENAME,
	DEFAULT_IDENTITY_FILENAME,
	DEFAULT_USER_FILENAME
]);
function filterBootstrapFilesForSession(files, sessionKey) {
	if (!sessionKey || !isSubagentSessionKey(sessionKey) && !isCronSessionKey(sessionKey)) return files;
	return files.filter((file) => MINIMAL_BOOTSTRAP_ALLOWLIST.has(file.name));
}

//#endregion
//#region src/agents/agent-scope.ts
const log = createSubsystemLogger("agent-scope");
/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes(s) {
	return s.replace(/\0/g, "");
}
let defaultAgentWarned = false;
function listAgentEntries(cfg) {
	const list = cfg.agents?.list;
	if (!Array.isArray(list)) return [];
	return list.filter((entry) => Boolean(entry && typeof entry === "object"));
}
function listAgentIds(cfg) {
	const agents = listAgentEntries(cfg);
	if (agents.length === 0) return [DEFAULT_AGENT_ID];
	const seen = /* @__PURE__ */ new Set();
	const ids = [];
	for (const entry of agents) {
		const id = normalizeAgentId(entry?.id);
		if (seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids.length > 0 ? ids : [DEFAULT_AGENT_ID];
}
function resolveDefaultAgentId(cfg) {
	const agents = listAgentEntries(cfg);
	if (agents.length === 0) return DEFAULT_AGENT_ID;
	const defaults = agents.filter((agent) => agent?.default);
	if (defaults.length > 1 && !defaultAgentWarned) {
		defaultAgentWarned = true;
		log.warn("Multiple agents marked default=true; using the first entry as default.");
	}
	const chosen = (defaults[0] ?? agents[0])?.id?.trim();
	return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}
function resolveSessionAgentIds(params) {
	const defaultAgentId = resolveDefaultAgentId(params.config ?? {});
	const explicitAgentIdRaw = typeof params.agentId === "string" ? params.agentId.trim().toLowerCase() : "";
	const explicitAgentId = explicitAgentIdRaw ? normalizeAgentId(explicitAgentIdRaw) : null;
	const sessionKey = params.sessionKey?.trim();
	const normalizedSessionKey = sessionKey ? sessionKey.toLowerCase() : void 0;
	const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
	return {
		defaultAgentId,
		sessionAgentId: explicitAgentId ?? (parsed?.agentId ? normalizeAgentId(parsed.agentId) : defaultAgentId)
	};
}
function resolveSessionAgentId(params) {
	return resolveSessionAgentIds(params).sessionAgentId;
}
function resolveAgentEntry(cfg, agentId) {
	const id = normalizeAgentId(agentId);
	return listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}
function resolveAgentConfig(cfg, agentId) {
	const entry = resolveAgentEntry(cfg, normalizeAgentId(agentId));
	if (!entry) return;
	return {
		name: typeof entry.name === "string" ? entry.name : void 0,
		workspace: typeof entry.workspace === "string" ? entry.workspace : void 0,
		agentDir: typeof entry.agentDir === "string" ? entry.agentDir : void 0,
		model: typeof entry.model === "string" || entry.model && typeof entry.model === "object" ? entry.model : void 0,
		skills: Array.isArray(entry.skills) ? entry.skills : void 0,
		memorySearch: entry.memorySearch,
		humanDelay: entry.humanDelay,
		heartbeat: entry.heartbeat,
		identity: entry.identity,
		groupChat: entry.groupChat,
		subagents: typeof entry.subagents === "object" && entry.subagents ? entry.subagents : void 0,
		sandbox: entry.sandbox,
		tools: entry.tools
	};
}
function resolveAgentSkillsFilter(cfg, agentId) {
	return normalizeSkillFilter(resolveAgentConfig(cfg, agentId)?.skills);
}
function resolveModelPrimary(raw) {
	if (typeof raw === "string") return raw.trim() || void 0;
	if (!raw || typeof raw !== "object") return;
	const primary = raw.primary;
	if (typeof primary !== "string") return;
	return primary.trim() || void 0;
}
function resolveAgentExplicitModelPrimary(cfg, agentId) {
	const raw = resolveAgentConfig(cfg, agentId)?.model;
	return resolveModelPrimary(raw);
}
function resolveAgentEffectiveModelPrimary(cfg, agentId) {
	return resolveAgentExplicitModelPrimary(cfg, agentId) ?? resolveModelPrimary(cfg.agents?.defaults?.model);
}
function resolveAgentModelFallbacksOverride(cfg, agentId) {
	const raw = resolveAgentConfig(cfg, agentId)?.model;
	if (!raw || typeof raw === "string") return;
	if (!Object.hasOwn(raw, "fallbacks")) return;
	return Array.isArray(raw.fallbacks) ? raw.fallbacks : void 0;
}
function resolveFallbackAgentId(params) {
	const explicitAgentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
	if (explicitAgentId) return normalizeAgentId(explicitAgentId);
	return resolveAgentIdFromSessionKey(params.sessionKey);
}
function resolveRunModelFallbacksOverride(params) {
	if (!params.cfg) return;
	return resolveAgentModelFallbacksOverride(params.cfg, resolveFallbackAgentId({
		agentId: params.agentId,
		sessionKey: params.sessionKey
	}));
}
function hasConfiguredModelFallbacks(params) {
	const fallbacksOverride = resolveRunModelFallbacksOverride(params);
	const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);
	return (fallbacksOverride ?? defaultFallbacks).length > 0;
}
function resolveEffectiveModelFallbacks(params) {
	const agentFallbacksOverride = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
	if (!params.hasSessionModelOverride) return agentFallbacksOverride;
	const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
	return agentFallbacksOverride ?? defaultFallbacks;
}
function resolveAgentWorkspaceDir(cfg, agentId) {
	const id = normalizeAgentId(agentId);
	const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
	if (configured) return stripNullBytes(resolveUserPath(configured));
	if (id === resolveDefaultAgentId(cfg)) {
		const fallback = cfg.agents?.defaults?.workspace?.trim();
		if (fallback) return stripNullBytes(resolveUserPath(fallback));
		return stripNullBytes(resolveDefaultAgentWorkspaceDir(process.env));
	}
	const stateDir = resolveStateDir(process.env);
	return stripNullBytes(path.join(stateDir, `workspace-${id}`));
}
function resolveAgentDir(cfg, agentId) {
	const id = normalizeAgentId(agentId);
	const configured = resolveAgentConfig(cfg, id)?.agentDir?.trim();
	if (configured) return resolveUserPath(configured);
	const root = resolveStateDir(process.env);
	return path.join(root, "agents", id, "agent");
}

//#endregion
export { logError as A, isNotFoundPathError as B, loadWorkspaceBootstrapFiles as C, runExec as D, runCommandWithTimeout as E, openBoundaryFileSync as F, resolveAgentModelPrimaryValue as G, isSymlinkOpenError as H, sameFileIdentity$1 as I, toAgentModelListLike as K, BOUNDARY_PATH_ALIAS_POLICIES as L, logWarn as M, canUseBoundaryFileOpen as N, spawnWithFallback as O, openBoundaryFile as P, resolveBoundaryPath as R, filterBootstrapFilesForSession as S, resolveOpenClawPackageRootSync as T, normalizeSkillFilter as U, isPathInside as V, resolveAgentModelFallbackValues as W, DEFAULT_IDENTITY_FILENAME as _, resolveAgentEffectiveModelPrimary as a, DEFAULT_USER_FILENAME as b, resolveDefaultAgentId as c, resolveSessionAgentId as d, resolveSessionAgentIds as f, DEFAULT_HEARTBEAT_FILENAME as g, DEFAULT_BOOTSTRAP_FILENAME as h, resolveAgentDir as i, logInfo as j, logDebug as k, resolveEffectiveModelFallbacks as l, DEFAULT_AGENT_WORKSPACE_DIR as m, listAgentIds as n, resolveAgentSkillsFilter as o, DEFAULT_AGENTS_FILENAME as p, resolveAgentConfig as r, resolveAgentWorkspaceDir as s, hasConfiguredModelFallbacks as t, resolveRunModelFallbacksOverride as u, DEFAULT_SOUL_FILENAME as v, resolveOpenClawPackageRoot as w, ensureAgentWorkspace as x, DEFAULT_TOOLS_FILENAME as y, resolvePathViaExistingAncestorSync as z };