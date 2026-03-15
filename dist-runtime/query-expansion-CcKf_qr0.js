import { n as redactSensitiveText } from "./redact-CPjO5IzK.js";
import { v as expandHomePrefix } from "./paths-1qR_mW4i.js";
import { t as createSubsystemLogger } from "./subsystem-EnljYYs1.js";
import { t as installProcessWarningFilter } from "./warning-filter-xAwZkSAQ.js";
import { d as isPathInside, f as isSymlinkOpenError, l as hasNodeErrorCode, u as isNotFoundPathError } from "./filter-Qe6Ch68_.js";
import { n as sameFileIdentity } from "./safe-open-sync-BmiTH5-j.js";
import { i as logWarn } from "./logger-BwHrL168.js";
import { n as assertNoPathAliasEscape } from "./path-alias-guards-SF-nwQor.js";
import { t as detectMime } from "./mime-h80iV1FL.js";
import { c as resolveSessionTranscriptsDirForAgent } from "./paths-YN5WLIkL.js";
import { n as buildMemoryMultimodalLabel, r as classifyMemoryMultimodalPath } from "./multimodal-IUqnzBU8.js";
import { createRequire } from "node:module";
import fs, { constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import crypto, { randomUUID } from "node:crypto";
import fs$1 from "node:fs/promises";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
//#region src/utils/run-with-concurrency.ts
async function runTasksWithConcurrency(params) {
	const { tasks, limit, onTaskError } = params;
	const errorMode = params.errorMode ?? "continue";
	if (tasks.length === 0) {return {
		results: [],
		firstError: void 0,
		hasError: false
	};}
	const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
	const results = Array.from({ length: tasks.length });
	let next = 0;
	let firstError = void 0;
	let hasError = false;
	const workers = Array.from({ length: resolvedLimit }, async () => {
		while (true) {
			if (errorMode === "stop" && hasError) {return;}
			const index = next;
			next += 1;
			if (index >= tasks.length) {return;}
			try {
				results[index] = await tasks[index]();
			} catch (error) {
				if (!hasError) {
					firstError = error;
					hasError = true;
				}
				onTaskError?.(error, index);
				if (errorMode === "stop") {return;}
			}
		}
	});
	await Promise.allSettled(workers);
	return {
		results,
		firstError,
		hasError
	};
}
//#endregion
//#region src/infra/fs-pinned-write-helper.ts
const LOCAL_PINNED_WRITE_PYTHON = [
	"import errno",
	"import os",
	"import secrets",
	"import stat",
	"import sys",
	"",
	"root_path = sys.argv[1]",
	"relative_parent = sys.argv[2]",
	"basename = sys.argv[3]",
	"mkdir_enabled = sys.argv[4] == \"1\"",
	"file_mode = int(sys.argv[5], 8)",
	"",
	"DIR_FLAGS = os.O_RDONLY",
	"if hasattr(os, 'O_DIRECTORY'):",
	"    DIR_FLAGS |= os.O_DIRECTORY",
	"if hasattr(os, 'O_NOFOLLOW'):",
	"    DIR_FLAGS |= os.O_NOFOLLOW",
	"",
	"WRITE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL",
	"if hasattr(os, 'O_NOFOLLOW'):",
	"    WRITE_FLAGS |= os.O_NOFOLLOW",
	"",
	"def open_dir(path_value, dir_fd=None):",
	"    return os.open(path_value, DIR_FLAGS, dir_fd=dir_fd)",
	"",
	"def walk_parent(root_fd, rel_parent, mkdir_enabled):",
	"    current_fd = os.dup(root_fd)",
	"    try:",
	"        for segment in [part for part in rel_parent.split('/') if part and part != '.']:",
	"            if segment == '..':",
	"                raise OSError(errno.EPERM, 'path traversal is not allowed', segment)",
	"            try:",
	"                next_fd = open_dir(segment, dir_fd=current_fd)",
	"            except FileNotFoundError:",
	"                if not mkdir_enabled:",
	"                    raise",
	"                os.mkdir(segment, 0o777, dir_fd=current_fd)",
	"                next_fd = open_dir(segment, dir_fd=current_fd)",
	"            os.close(current_fd)",
	"            current_fd = next_fd",
	"        return current_fd",
	"    except Exception:",
	"        os.close(current_fd)",
	"        raise",
	"",
	"def create_temp_file(parent_fd, basename, mode):",
	"    prefix = '.' + basename + '.'",
	"    for _ in range(128):",
	"        candidate = prefix + secrets.token_hex(6) + '.tmp'",
	"        try:",
	"            fd = os.open(candidate, WRITE_FLAGS, mode, dir_fd=parent_fd)",
	"            return candidate, fd",
	"        except FileExistsError:",
	"            continue",
	"    raise RuntimeError('failed to allocate pinned temp file')",
	"",
	"root_fd = open_dir(root_path)",
	"parent_fd = None",
	"temp_fd = None",
	"temp_name = None",
	"try:",
	"    parent_fd = walk_parent(root_fd, relative_parent, mkdir_enabled)",
	"    temp_name, temp_fd = create_temp_file(parent_fd, basename, file_mode)",
	"    while True:",
	"        chunk = sys.stdin.buffer.read(65536)",
	"        if not chunk:",
	"            break",
	"        os.write(temp_fd, chunk)",
	"    os.fsync(temp_fd)",
	"    os.close(temp_fd)",
	"    temp_fd = None",
	"    os.replace(temp_name, basename, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)",
	"    temp_name = None",
	"    os.fsync(parent_fd)",
	"    result_stat = os.stat(basename, dir_fd=parent_fd, follow_symlinks=False)",
	"    print(f'{result_stat.st_dev}|{result_stat.st_ino}')",
	"finally:",
	"    if temp_fd is not None:",
	"        os.close(temp_fd)",
	"    if temp_name is not None and parent_fd is not None:",
	"        try:",
	"            os.unlink(temp_name, dir_fd=parent_fd)",
	"        except FileNotFoundError:",
	"            pass",
	"    if parent_fd is not None:",
	"        os.close(parent_fd)",
	"    os.close(root_fd)"
].join("\n");
function parsePinnedIdentity(stdout) {
	const line = stdout.trim().split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1);
	if (!line) {throw new Error("Pinned write helper returned no identity");}
	const [devRaw, inoRaw] = line.split("|");
	const dev = Number.parseInt(devRaw ?? "", 10);
	const ino = Number.parseInt(inoRaw ?? "", 10);
	if (!Number.isFinite(dev) || !Number.isFinite(ino)) {throw new Error(`Pinned write helper returned invalid identity: ${line}`);}
	return {
		dev,
		ino
	};
}
async function runPinnedWriteHelper(params) {
	const child = spawn("python3", [
		"-c",
		LOCAL_PINNED_WRITE_PYTHON,
		params.rootPath,
		params.relativeParentPath,
		params.basename,
		params.mkdir ? "1" : "0",
		(params.mode || 384).toString(8)
	], { stdio: [
		"pipe",
		"pipe",
		"pipe"
	] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding?.("utf8");
	child.stderr.setEncoding?.("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exitPromise = once(child, "close");
	try {
		if (!child.stdin) {
			const identity = await runPinnedWriteFallback(params);
			await exitPromise.catch(() => {});
			return identity;
		}
		if (params.input.kind === "buffer") {
			const input = params.input;
			await new Promise((resolve, reject) => {
				child.stdin.once("error", reject);
				if (typeof input.data === "string") {
					child.stdin.end(input.data, input.encoding ?? "utf8", () => resolve());
					return;
				}
				child.stdin.end(input.data, () => resolve());
			});
		} else {await pipeline(params.input.stream, child.stdin);}
		const [code, signal] = await exitPromise;
		if (code !== 0) {throw new Error(stderr.trim() || `Pinned write helper failed with code ${code ?? "null"} (${signal ?? "?"})`);}
		return parsePinnedIdentity(stdout);
	} catch (error) {
		child.kill("SIGKILL");
		await exitPromise.catch(() => {});
		throw error;
	}
}
async function runPinnedWriteFallback(params) {
	const parentPath = params.relativeParentPath ? path.join(params.rootPath, ...params.relativeParentPath.split("/")) : params.rootPath;
	if (params.mkdir) {await fs$1.mkdir(parentPath, { recursive: true });}
	const targetPath = path.join(parentPath, params.basename);
	const tempPath = path.join(parentPath, `.${params.basename}.fallback.tmp`);
	if (params.input.kind === "buffer") {if (typeof params.input.data === "string") await fs$1.writeFile(tempPath, params.input.data, {
		encoding: params.input.encoding ?? "utf8",
		mode: params.mode
	});
	else await fs$1.writeFile(tempPath, params.input.data, { mode: params.mode });}
	else {
		const handle = await fs$1.open(tempPath, "w", params.mode);
		try {
			await pipeline(params.input.stream, handle.createWriteStream());
		} finally {
			await handle.close().catch(() => {});
		}
	}
	await fs$1.rename(tempPath, targetPath);
	const stat = await fs$1.stat(targetPath);
	return {
		dev: stat.dev,
		ino: stat.ino
	};
}
//#endregion
//#region src/infra/fs-safe.ts
var SafeOpenError = class extends Error {
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
		this.name = "SafeOpenError";
	}
};
const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in constants;
const OPEN_READ_FLAGS = constants.O_RDONLY | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const OPEN_WRITE_EXISTING_FLAGS = constants.O_WRONLY | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const OPEN_WRITE_CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const OPEN_APPEND_EXISTING_FLAGS = constants.O_RDWR | constants.O_APPEND | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const OPEN_APPEND_CREATE_FLAGS = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const ensureTrailingSep = (value) => value.endsWith(path.sep) ? value : value + path.sep;
async function expandRelativePathWithHome(relativePath) {
	let home = process.env.HOME || process.env.USERPROFILE || os.homedir();
	try {
		home = await fs$1.realpath(home);
	} catch {}
	return expandHomePrefix(relativePath, { home });
}
async function openVerifiedLocalFile(filePath, options) {
	try {
		if ((await fs$1.lstat(filePath)).isDirectory()) {throw new SafeOpenError("not-file", "not a file");}
	} catch (err) {
		if (err instanceof SafeOpenError) {throw err;}
	}
	let handle;
	try {
		handle = await fs$1.open(filePath, OPEN_READ_FLAGS);
	} catch (err) {
		if (isNotFoundPathError(err)) {throw new SafeOpenError("not-found", "file not found");}
		if (isSymlinkOpenError(err)) {throw new SafeOpenError("symlink", "symlink open blocked", { cause: err });}
		if (hasNodeErrorCode(err, "EISDIR")) {throw new SafeOpenError("not-file", "not a file");}
		throw err;
	}
	try {
		const [stat, lstat] = await Promise.all([handle.stat(), fs$1.lstat(filePath)]);
		if (lstat.isSymbolicLink()) {throw new SafeOpenError("symlink", "symlink not allowed");}
		if (!stat.isFile()) {throw new SafeOpenError("not-file", "not a file");}
		if (options?.rejectHardlinks && stat.nlink > 1) {throw new SafeOpenError("invalid-path", "hardlinked path not allowed");}
		if (!sameFileIdentity(stat, lstat)) {throw new SafeOpenError("path-mismatch", "path changed during read");}
		const realPath = await fs$1.realpath(filePath);
		const realStat = await fs$1.stat(realPath);
		if (options?.rejectHardlinks && realStat.nlink > 1) {throw new SafeOpenError("invalid-path", "hardlinked path not allowed");}
		if (!sameFileIdentity(stat, realStat)) {throw new SafeOpenError("path-mismatch", "path mismatch");}
		return {
			handle,
			realPath,
			stat
		};
	} catch (err) {
		await handle.close().catch(() => {});
		if (err instanceof SafeOpenError) {throw err;}
		if (isNotFoundPathError(err)) {throw new SafeOpenError("not-found", "file not found");}
		throw err;
	}
}
async function resolvePathWithinRoot(params) {
	let rootReal;
	try {
		rootReal = await fs$1.realpath(params.rootDir);
	} catch (err) {
		if (isNotFoundPathError(err)) {throw new SafeOpenError("not-found", "root dir not found");}
		throw err;
	}
	const rootWithSep = ensureTrailingSep(rootReal);
	const expanded = await expandRelativePathWithHome(params.relativePath);
	const resolved = path.resolve(rootWithSep, expanded);
	if (!isPathInside(rootWithSep, resolved)) {throw new SafeOpenError("outside-workspace", "file is outside workspace root");}
	return {
		rootReal,
		rootWithSep,
		resolved
	};
}
async function openFileWithinRoot(params) {
	const { rootWithSep, resolved } = await resolvePathWithinRoot(params);
	let opened;
	try {
		opened = await openVerifiedLocalFile(resolved);
	} catch (err) {
		if (err instanceof SafeOpenError) {
			if (err.code === "not-found") {throw err;}
			throw new SafeOpenError("invalid-path", "path is not a regular file under root", { cause: err });
		}
		throw err;
	}
	if (params.rejectHardlinks !== false && opened.stat.nlink > 1) {
		await opened.handle.close().catch(() => {});
		throw new SafeOpenError("invalid-path", "hardlinked path not allowed");
	}
	if (!isPathInside(rootWithSep, opened.realPath)) {
		await opened.handle.close().catch(() => {});
		throw new SafeOpenError("outside-workspace", "file is outside workspace root");
	}
	return opened;
}
async function readFileWithinRoot(params) {
	const opened = await openFileWithinRoot({
		rootDir: params.rootDir,
		relativePath: params.relativePath,
		rejectHardlinks: params.rejectHardlinks
	});
	try {
		return await readOpenedFileSafely({
			opened,
			maxBytes: params.maxBytes
		});
	} finally {
		await opened.handle.close().catch(() => {});
	}
}
async function readPathWithinRoot(params) {
	const rootDir = path.resolve(params.rootDir);
	const candidatePath = path.isAbsolute(params.filePath) ? path.resolve(params.filePath) : path.resolve(rootDir, params.filePath);
	return await readFileWithinRoot({
		rootDir,
		relativePath: path.relative(rootDir, candidatePath),
		rejectHardlinks: params.rejectHardlinks,
		maxBytes: params.maxBytes
	});
}
function createRootScopedReadFile(params) {
	const rootDir = path.resolve(params.rootDir);
	return async (filePath) => {
		return (await readPathWithinRoot({
			rootDir,
			filePath,
			rejectHardlinks: params.rejectHardlinks,
			maxBytes: params.maxBytes
		})).buffer;
	};
}
async function readLocalFileSafely(params) {
	const opened = await openVerifiedLocalFile(params.filePath);
	try {
		return await readOpenedFileSafely({
			opened,
			maxBytes: params.maxBytes
		});
	} finally {
		await opened.handle.close().catch(() => {});
	}
}
async function readOpenedFileSafely(params) {
	if (params.maxBytes !== void 0 && params.opened.stat.size > params.maxBytes) {throw new SafeOpenError("too-large", `file exceeds limit of ${params.maxBytes} bytes (got ${params.opened.stat.size})`);}
	return {
		buffer: await params.opened.handle.readFile(),
		realPath: params.opened.realPath,
		stat: params.opened.stat
	};
}
function emitWriteBoundaryWarning(reason) {
	logWarn(`security: fs-safe write boundary warning (${reason})`);
}
function buildAtomicWriteTempPath(targetPath) {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	return path.join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);
}
async function writeTempFileForAtomicReplace(params) {
	const tempHandle = await fs$1.open(params.tempPath, OPEN_WRITE_CREATE_FLAGS, params.mode);
	try {
		if (typeof params.data === "string") {await tempHandle.writeFile(params.data, params.encoding ?? "utf8");}
		else {await tempHandle.writeFile(params.data);}
		return await tempHandle.stat();
	} finally {
		await tempHandle.close().catch(() => {});
	}
}
async function verifyAtomicWriteResult(params) {
	const rootWithSep = ensureTrailingSep(await fs$1.realpath(params.rootDir));
	const opened = await openVerifiedLocalFile(params.targetPath, { rejectHardlinks: true });
	try {
		if (!sameFileIdentity(opened.stat, params.expectedIdentity)) {throw new SafeOpenError("path-mismatch", "path changed during write");}
		if (!isPathInside(rootWithSep, opened.realPath)) {throw new SafeOpenError("outside-workspace", "file is outside workspace root");}
	} finally {
		await opened.handle.close().catch(() => {});
	}
}
async function resolveOpenedFileRealPathForHandle(handle, ioPath) {
	try {
		return await fs$1.realpath(ioPath);
	} catch (err) {
		if (!isNotFoundPathError(err)) {throw err;}
	}
	const fdCandidates = process.platform === "linux" ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`] : process.platform === "win32" ? [] : [`/dev/fd/${handle.fd}`];
	for (const fdPath of fdCandidates) {try {
		return await fs$1.realpath(fdPath);
	} catch {}}
	throw new SafeOpenError("path-mismatch", "unable to resolve opened file path");
}
async function openWritableFileWithinRoot(params) {
	const { rootReal, rootWithSep, resolved } = await resolvePathWithinRoot(params);
	try {
		await assertNoPathAliasEscape({
			absolutePath: resolved,
			rootPath: rootReal,
			boundaryLabel: "root"
		});
	} catch (err) {
		throw new SafeOpenError("invalid-path", "path alias escape blocked", { cause: err });
	}
	if (params.mkdir !== false) {await fs$1.mkdir(path.dirname(resolved), { recursive: true });}
	let ioPath = resolved;
	try {
		const resolvedRealPath = await fs$1.realpath(resolved);
		if (!isPathInside(rootWithSep, resolvedRealPath)) {throw new SafeOpenError("outside-workspace", "file is outside workspace root");}
		ioPath = resolvedRealPath;
	} catch (err) {
		if (err instanceof SafeOpenError) {throw err;}
		if (!isNotFoundPathError(err)) {throw err;}
	}
	const fileMode = params.mode ?? 384;
	let handle;
	let createdForWrite = false;
	const existingFlags = params.append ? OPEN_APPEND_EXISTING_FLAGS : OPEN_WRITE_EXISTING_FLAGS;
	const createFlags = params.append ? OPEN_APPEND_CREATE_FLAGS : OPEN_WRITE_CREATE_FLAGS;
	try {
		try {
			handle = await fs$1.open(ioPath, existingFlags, fileMode);
		} catch (err) {
			if (!isNotFoundPathError(err)) {throw err;}
			handle = await fs$1.open(ioPath, createFlags, fileMode);
			createdForWrite = true;
		}
	} catch (err) {
		if (isNotFoundPathError(err)) {throw new SafeOpenError("not-found", "file not found");}
		if (isSymlinkOpenError(err)) {throw new SafeOpenError("invalid-path", "symlink open blocked", { cause: err });}
		throw err;
	}
	let openedRealPath = null;
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) {throw new SafeOpenError("invalid-path", "path is not a regular file under root");}
		if (stat.nlink > 1) {throw new SafeOpenError("invalid-path", "hardlinked path not allowed");}
		try {
			const lstat = await fs$1.lstat(ioPath);
			if (lstat.isSymbolicLink() || !lstat.isFile()) {throw new SafeOpenError("invalid-path", "path is not a regular file under root");}
			if (!sameFileIdentity(stat, lstat)) {throw new SafeOpenError("path-mismatch", "path changed during write");}
		} catch (err) {
			if (!isNotFoundPathError(err)) {throw err;}
		}
		const realPath = await resolveOpenedFileRealPathForHandle(handle, ioPath);
		openedRealPath = realPath;
		const realStat = await fs$1.stat(realPath);
		if (!sameFileIdentity(stat, realStat)) {throw new SafeOpenError("path-mismatch", "path mismatch");}
		if (realStat.nlink > 1) {throw new SafeOpenError("invalid-path", "hardlinked path not allowed");}
		if (!isPathInside(rootWithSep, realPath)) {throw new SafeOpenError("outside-workspace", "file is outside workspace root");}
		if (params.append !== true && params.truncateExisting !== false && !createdForWrite) {await handle.truncate(0);}
		return {
			handle,
			createdForWrite,
			openedRealPath: realPath,
			openedStat: stat
		};
	} catch (err) {
		const cleanupCreatedPath = createdForWrite && err instanceof SafeOpenError;
		const cleanupPath = openedRealPath ?? ioPath;
		await handle.close().catch(() => {});
		if (cleanupCreatedPath) {await fs$1.rm(cleanupPath, { force: true }).catch(() => {});}
		throw err;
	}
}
async function appendFileWithinRoot(params) {
	const target = await openWritableFileWithinRoot({
		rootDir: params.rootDir,
		relativePath: params.relativePath,
		mkdir: params.mkdir,
		truncateExisting: false,
		append: true
	});
	try {
		let prefix = "";
		if (params.prependNewlineIfNeeded === true && !target.createdForWrite && target.openedStat.size > 0 && (typeof params.data === "string" && !params.data.startsWith("\n") || Buffer.isBuffer(params.data) && params.data.length > 0 && params.data[0] !== 10)) {
			const lastByte = Buffer.alloc(1);
			const { bytesRead } = await target.handle.read(lastByte, 0, 1, target.openedStat.size - 1);
			if (bytesRead === 1 && lastByte[0] !== 10) {prefix = "\n";}
		}
		if (typeof params.data === "string") {
			await target.handle.appendFile(`${prefix}${params.data}`, params.encoding ?? "utf8");
			return;
		}
		const payload = prefix.length > 0 ? Buffer.concat([Buffer.from(prefix, "utf8"), params.data]) : params.data;
		await target.handle.appendFile(payload);
	} finally {
		await target.handle.close().catch(() => {});
	}
}
async function writeFileWithinRoot(params) {
	if (process.platform === "win32") {
		await writeFileWithinRootLegacy(params);
		return;
	}
	const pinned = await resolvePinnedWriteTargetWithinRoot({
		rootDir: params.rootDir,
		relativePath: params.relativePath
	});
	const identity = await runPinnedWriteHelper({
		rootPath: pinned.rootReal,
		relativeParentPath: pinned.relativeParentPath,
		basename: pinned.basename,
		mkdir: params.mkdir !== false,
		mode: pinned.mode,
		input: {
			kind: "buffer",
			data: params.data,
			encoding: params.encoding
		}
	}).catch((error) => {
		throw normalizePinnedWriteError(error);
	});
	try {
		await verifyAtomicWriteResult({
			rootDir: params.rootDir,
			targetPath: pinned.targetPath,
			expectedIdentity: identity
		});
	} catch (err) {
		emitWriteBoundaryWarning(`post-write verification failed: ${String(err)}`);
		throw err;
	}
}
async function copyFileWithinRoot(params) {
	const source = await openVerifiedLocalFile(params.sourcePath, { rejectHardlinks: params.rejectSourceHardlinks });
	if (params.maxBytes !== void 0 && source.stat.size > params.maxBytes) {
		await source.handle.close().catch(() => {});
		throw new SafeOpenError("too-large", `file exceeds limit of ${params.maxBytes} bytes (got ${source.stat.size})`);
	}
	try {
		if (process.platform === "win32") {
			await copyFileWithinRootLegacy(params, source);
			return;
		}
		const pinned = await resolvePinnedWriteTargetWithinRoot({
			rootDir: params.rootDir,
			relativePath: params.relativePath
		});
		const sourceStream = source.handle.createReadStream();
		const identity = await runPinnedWriteHelper({
			rootPath: pinned.rootReal,
			relativeParentPath: pinned.relativeParentPath,
			basename: pinned.basename,
			mkdir: params.mkdir !== false,
			mode: pinned.mode,
			input: {
				kind: "stream",
				stream: sourceStream
			}
		}).catch((error) => {
			throw normalizePinnedWriteError(error);
		});
		try {
			await verifyAtomicWriteResult({
				rootDir: params.rootDir,
				targetPath: pinned.targetPath,
				expectedIdentity: identity
			});
		} catch (err) {
			emitWriteBoundaryWarning(`post-copy verification failed: ${String(err)}`);
			throw err;
		}
	} finally {
		await source.handle.close().catch(() => {});
	}
}
async function writeFileFromPathWithinRoot(params) {
	await copyFileWithinRoot({
		sourcePath: params.sourcePath,
		rootDir: params.rootDir,
		relativePath: params.relativePath,
		mkdir: params.mkdir,
		rejectSourceHardlinks: true
	});
}
async function resolvePinnedWriteTargetWithinRoot(params) {
	const { rootReal, rootWithSep, resolved } = await resolvePathWithinRoot(params);
	try {
		await assertNoPathAliasEscape({
			absolutePath: resolved,
			rootPath: rootReal,
			boundaryLabel: "root"
		});
	} catch (err) {
		throw new SafeOpenError("invalid-path", "path alias escape blocked", { cause: err });
	}
	const relativeResolved = path.relative(rootReal, resolved);
	if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) {throw new SafeOpenError("outside-workspace", "file is outside workspace root");}
	const relativePosix = relativeResolved ? relativeResolved.split(path.sep).join(path.posix.sep) : "";
	const basename = path.posix.basename(relativePosix);
	if (!basename || basename === "." || basename === "/") {throw new SafeOpenError("invalid-path", "invalid target path");}
	let mode = 384;
	try {
		const opened = await openFileWithinRoot({
			rootDir: params.rootDir,
			relativePath: params.relativePath,
			rejectHardlinks: true
		});
		try {
			mode = opened.stat.mode & 511;
			if (!isPathInside(rootWithSep, opened.realPath)) {throw new SafeOpenError("outside-workspace", "file is outside workspace root");}
		} finally {
			await opened.handle.close().catch(() => {});
		}
	} catch (err) {
		if (!(err instanceof SafeOpenError) || err.code !== "not-found") {throw err;}
	}
	return {
		rootReal,
		targetPath: resolved,
		relativeParentPath: path.posix.dirname(relativePosix) === "." ? "" : path.posix.dirname(relativePosix),
		basename,
		mode: mode || 384
	};
}
function normalizePinnedWriteError(error) {
	if (error instanceof SafeOpenError) {return error;}
	return new SafeOpenError("invalid-path", "path is not a regular file under root", { cause: error instanceof Error ? error : void 0 });
}
async function writeFileWithinRootLegacy(params) {
	const target = await openWritableFileWithinRoot({
		rootDir: params.rootDir,
		relativePath: params.relativePath,
		mkdir: params.mkdir,
		truncateExisting: false
	});
	const destinationPath = target.openedRealPath;
	const targetMode = target.openedStat.mode & 511;
	await target.handle.close().catch(() => {});
	let tempPath = null;
	try {
		tempPath = buildAtomicWriteTempPath(destinationPath);
		const writtenStat = await writeTempFileForAtomicReplace({
			tempPath,
			data: params.data,
			encoding: params.encoding,
			mode: targetMode || 384
		});
		await fs$1.rename(tempPath, destinationPath);
		tempPath = null;
		try {
			await verifyAtomicWriteResult({
				rootDir: params.rootDir,
				targetPath: destinationPath,
				expectedIdentity: writtenStat
			});
		} catch (err) {
			emitWriteBoundaryWarning(`post-write verification failed: ${String(err)}`);
			throw err;
		}
	} finally {
		if (tempPath) {await fs$1.rm(tempPath, { force: true }).catch(() => {});}
	}
}
async function copyFileWithinRootLegacy(params, source) {
	let target = null;
	let sourceClosedByStream = false;
	let targetClosedByUs = false;
	let tempHandle = null;
	let tempPath = null;
	let tempClosedByStream = false;
	try {
		target = await openWritableFileWithinRoot({
			rootDir: params.rootDir,
			relativePath: params.relativePath,
			mkdir: params.mkdir,
			truncateExisting: false
		});
		const destinationPath = target.openedRealPath;
		const targetMode = target.openedStat.mode & 511;
		await target.handle.close().catch(() => {});
		targetClosedByUs = true;
		tempPath = buildAtomicWriteTempPath(destinationPath);
		tempHandle = await fs$1.open(tempPath, OPEN_WRITE_CREATE_FLAGS, targetMode || 384);
		const sourceStream = source.handle.createReadStream();
		const targetStream = tempHandle.createWriteStream();
		sourceStream.once("close", () => {
			sourceClosedByStream = true;
		});
		targetStream.once("close", () => {
			tempClosedByStream = true;
		});
		await import("node:stream/promises").then(({ pipeline }) => pipeline(sourceStream, targetStream));
		const writtenStat = await fs$1.stat(tempPath);
		if (!tempClosedByStream) {
			await tempHandle.close().catch(() => {});
			tempClosedByStream = true;
		}
		tempHandle = null;
		await fs$1.rename(tempPath, destinationPath);
		tempPath = null;
		try {
			await verifyAtomicWriteResult({
				rootDir: params.rootDir,
				targetPath: destinationPath,
				expectedIdentity: writtenStat
			});
		} catch (err) {
			emitWriteBoundaryWarning(`post-copy verification failed: ${String(err)}`);
			throw err;
		}
	} catch (err) {
		if (target?.createdForWrite) {await fs$1.rm(target.openedRealPath, { force: true }).catch(() => {});}
		throw err;
	} finally {
		if (tempPath) {await fs$1.rm(tempPath, { force: true }).catch(() => {});}
		if (!sourceClosedByStream) {await source.handle.close().catch(() => {});}
		if (tempHandle && !tempClosedByStream) {await tempHandle.close().catch(() => {});}
		if (target && !targetClosedByUs) {await target.handle.close().catch(() => {});}
	}
}
//#endregion
//#region src/memory/fs-utils.ts
function isFileMissingError(err) {
	return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}
async function statRegularFile(absPath) {
	let stat;
	try {
		stat = await fs$1.lstat(absPath);
	} catch (err) {
		if (isFileMissingError(err)) {return { missing: true };}
		throw err;
	}
	if (stat.isSymbolicLink() || !stat.isFile()) {throw new Error("path required");}
	return {
		missing: false,
		stat
	};
}
//#endregion
//#region src/memory/embedding-input-limits.ts
function estimateUtf8Bytes(text) {
	if (!text) {return 0;}
	return Buffer.byteLength(text, "utf8");
}
function estimateStructuredEmbeddingInputBytes(input) {
	if (!input.parts?.length) {return estimateUtf8Bytes(input.text);}
	let total = 0;
	for (const part of input.parts) {
		if (part.type === "text") {
			total += estimateUtf8Bytes(part.text);
			continue;
		}
		total += estimateUtf8Bytes(part.mimeType);
		total += estimateUtf8Bytes(part.data);
	}
	return total;
}
function splitTextToUtf8ByteLimit(text, maxUtf8Bytes) {
	if (maxUtf8Bytes <= 0) {return [text];}
	if (estimateUtf8Bytes(text) <= maxUtf8Bytes) {return [text];}
	const parts = [];
	let cursor = 0;
	while (cursor < text.length) {
		let low = cursor + 1;
		let high = Math.min(text.length, cursor + maxUtf8Bytes);
		let best = cursor;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			if (estimateUtf8Bytes(text.slice(cursor, mid)) <= maxUtf8Bytes) {
				best = mid;
				low = mid + 1;
			} else {high = mid - 1;}
		}
		if (best <= cursor) {best = Math.min(text.length, cursor + 1);}
		if (best < text.length && best > cursor && text.charCodeAt(best - 1) >= 55296 && text.charCodeAt(best - 1) <= 56319 && text.charCodeAt(best) >= 56320 && text.charCodeAt(best) <= 57343) {best -= 1;}
		const part = text.slice(cursor, best);
		if (!part) {break;}
		parts.push(part);
		cursor = best;
	}
	return parts;
}
//#endregion
//#region src/memory/embedding-inputs.ts
function buildTextEmbeddingInput(text) {
	return { text };
}
function isInlineDataEmbeddingInputPart(part) {
	return part.type === "inline-data";
}
function hasNonTextEmbeddingParts(input) {
	if (!input?.parts?.length) {return false;}
	return input.parts.some((part) => isInlineDataEmbeddingInputPart(part));
}
//#endregion
//#region src/memory/internal.ts
const DISABLED_MULTIMODAL_SETTINGS = {
	enabled: false,
	modalities: [],
	maxFileBytes: 0
};
function ensureDir(dir) {
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {}
	return dir;
}
function normalizeRelPath(value) {
	return value.trim().replace(/^[./]+/, "").replace(/\\/g, "/");
}
function normalizeExtraMemoryPaths(workspaceDir, extraPaths) {
	if (!extraPaths?.length) {return [];}
	const resolved = extraPaths.map((value) => value.trim()).filter(Boolean).map((value) => path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceDir, value));
	return Array.from(new Set(resolved));
}
function isMemoryPath(relPath) {
	const normalized = normalizeRelPath(relPath);
	if (!normalized) {return false;}
	if (normalized === "MEMORY.md" || normalized === "memory.md") {return true;}
	return normalized.startsWith("memory/");
}
function isAllowedMemoryFilePath(filePath, multimodal) {
	if (filePath.endsWith(".md")) {return true;}
	return classifyMemoryMultimodalPath(filePath, multimodal ?? DISABLED_MULTIMODAL_SETTINGS) !== null;
}
async function walkDir(dir, files, multimodal) {
	const entries = await fs$1.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) {continue;}
		if (entry.isDirectory()) {
			await walkDir(full, files, multimodal);
			continue;
		}
		if (!entry.isFile()) {continue;}
		if (!isAllowedMemoryFilePath(full, multimodal)) {continue;}
		files.push(full);
	}
}
async function listMemoryFiles(workspaceDir, extraPaths, multimodal) {
	const result = [];
	const memoryFile = path.join(workspaceDir, "MEMORY.md");
	const altMemoryFile = path.join(workspaceDir, "memory.md");
	const memoryDir = path.join(workspaceDir, "memory");
	const addMarkdownFile = async (absPath) => {
		try {
			const stat = await fs$1.lstat(absPath);
			if (stat.isSymbolicLink() || !stat.isFile()) {return;}
			if (!absPath.endsWith(".md")) {return;}
			result.push(absPath);
		} catch {}
	};
	await addMarkdownFile(memoryFile);
	await addMarkdownFile(altMemoryFile);
	try {
		const dirStat = await fs$1.lstat(memoryDir);
		if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {await walkDir(memoryDir, result);}
	} catch {}
	const normalizedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
	if (normalizedExtraPaths.length > 0) {for (const inputPath of normalizedExtraPaths) try {
		const stat = await fs$1.lstat(inputPath);
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			await walkDir(inputPath, result, multimodal);
			continue;
		}
		if (stat.isFile() && isAllowedMemoryFilePath(inputPath, multimodal)) result.push(inputPath);
	} catch {}}
	if (result.length <= 1) {return result;}
	const seen = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const entry of result) {
		let key = entry;
		try {
			key = await fs$1.realpath(entry);
		} catch {}
		if (seen.has(key)) {continue;}
		seen.add(key);
		deduped.push(entry);
	}
	return deduped;
}
function hashText(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}
async function buildFileEntry(absPath, workspaceDir, multimodal) {
	let stat;
	try {
		stat = await fs$1.stat(absPath);
	} catch (err) {
		if (isFileMissingError(err)) {return null;}
		throw err;
	}
	const normalizedPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
	const multimodalSettings = multimodal ?? DISABLED_MULTIMODAL_SETTINGS;
	const modality = classifyMemoryMultimodalPath(absPath, multimodalSettings);
	if (modality) {
		if (stat.size > multimodalSettings.maxFileBytes) {return null;}
		let buffer;
		try {
			buffer = await fs$1.readFile(absPath);
		} catch (err) {
			if (isFileMissingError(err)) {return null;}
			throw err;
		}
		const mimeType = await detectMime({
			buffer: buffer.subarray(0, 512),
			filePath: absPath
		});
		if (!mimeType || !mimeType.startsWith(`${modality}/`)) {return null;}
		const contentText = buildMemoryMultimodalLabel(modality, normalizedPath);
		const dataHash = crypto.createHash("sha256").update(buffer).digest("hex");
		const chunkHash = hashText(JSON.stringify({
			path: normalizedPath,
			contentText,
			mimeType,
			dataHash
		}));
		return {
			path: normalizedPath,
			absPath,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			hash: chunkHash,
			dataHash,
			kind: "multimodal",
			contentText,
			modality,
			mimeType
		};
	}
	let content;
	try {
		content = await fs$1.readFile(absPath, "utf-8");
	} catch (err) {
		if (isFileMissingError(err)) {return null;}
		throw err;
	}
	const hash = hashText(content);
	return {
		path: normalizedPath,
		absPath,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		hash,
		kind: "markdown"
	};
}
async function loadMultimodalEmbeddingInput(entry) {
	if (entry.kind !== "multimodal" || !entry.contentText || !entry.mimeType) {return null;}
	let stat;
	try {
		stat = await fs$1.stat(entry.absPath);
	} catch (err) {
		if (isFileMissingError(err)) {return null;}
		throw err;
	}
	if (stat.size !== entry.size) {return null;}
	let buffer;
	try {
		buffer = await fs$1.readFile(entry.absPath);
	} catch (err) {
		if (isFileMissingError(err)) {return null;}
		throw err;
	}
	const dataHash = crypto.createHash("sha256").update(buffer).digest("hex");
	if (entry.dataHash && entry.dataHash !== dataHash) {return null;}
	return {
		text: entry.contentText,
		parts: [{
			type: "text",
			text: entry.contentText
		}, {
			type: "inline-data",
			mimeType: entry.mimeType,
			data: buffer.toString("base64")
		}]
	};
}
async function buildMultimodalChunkForIndexing(entry) {
	const embeddingInput = await loadMultimodalEmbeddingInput(entry);
	if (!embeddingInput) {return null;}
	return {
		chunk: {
			startLine: 1,
			endLine: 1,
			text: entry.contentText ?? embeddingInput.text,
			hash: entry.hash,
			embeddingInput
		},
		structuredInputBytes: estimateStructuredEmbeddingInputBytes(embeddingInput)
	};
}
function chunkMarkdown(content, chunking) {
	const lines = content.split("\n");
	if (lines.length === 0) {return [];}
	const maxChars = Math.max(32, chunking.tokens * 4);
	const overlapChars = Math.max(0, chunking.overlap * 4);
	const chunks = [];
	let current = [];
	let currentChars = 0;
	const flush = () => {
		if (current.length === 0) {return;}
		const firstEntry = current[0];
		const lastEntry = current[current.length - 1];
		if (!firstEntry || !lastEntry) {return;}
		const text = current.map((entry) => entry.line).join("\n");
		const startLine = firstEntry.lineNo;
		const endLine = lastEntry.lineNo;
		chunks.push({
			startLine,
			endLine,
			text,
			hash: hashText(text),
			embeddingInput: buildTextEmbeddingInput(text)
		});
	};
	const carryOverlap = () => {
		if (overlapChars <= 0 || current.length === 0) {
			current = [];
			currentChars = 0;
			return;
		}
		let acc = 0;
		const kept = [];
		for (let i = current.length - 1; i >= 0; i -= 1) {
			const entry = current[i];
			if (!entry) {continue;}
			acc += entry.line.length + 1;
			kept.unshift(entry);
			if (acc >= overlapChars) {break;}
		}
		current = kept;
		currentChars = kept.reduce((sum, entry) => sum + entry.line.length + 1, 0);
	};
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const lineNo = i + 1;
		const segments = [];
		if (line.length === 0) {segments.push("");}
		else {for (let start = 0; start < line.length; start += maxChars) segments.push(line.slice(start, start + maxChars));}
		for (const segment of segments) {
			const lineSize = segment.length + 1;
			if (currentChars + lineSize > maxChars && current.length > 0) {
				flush();
				carryOverlap();
			}
			current.push({
				line: segment,
				lineNo
			});
			currentChars += lineSize;
		}
	}
	flush();
	return chunks;
}
/**
* Remap chunk startLine/endLine from content-relative positions to original
* source file positions using a lineMap.  Each entry in lineMap gives the
* 1-indexed source line for the corresponding 0-indexed content line.
*
* This is used for session JSONL files where buildSessionEntry() flattens
* messages into a plain-text string before chunking.  Without remapping the
* stored line numbers would reference positions in the flattened text rather
* than the original JSONL file.
*/
function remapChunkLines(chunks, lineMap) {
	if (!lineMap || lineMap.length === 0) {return;}
	for (const chunk of chunks) {
		chunk.startLine = lineMap[chunk.startLine - 1] ?? chunk.startLine;
		chunk.endLine = lineMap[chunk.endLine - 1] ?? chunk.endLine;
	}
}
function parseEmbedding(raw) {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
function cosineSimilarity(a, b) {
	if (a.length === 0 || b.length === 0) {return 0;}
	const len = Math.min(a.length, b.length);
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < len; i += 1) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		dot += av * bv;
		normA += av * av;
		normB += bv * bv;
	}
	if (normA === 0 || normB === 0) {return 0;}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
async function runWithConcurrency(tasks, limit) {
	const { results, firstError, hasError } = await runTasksWithConcurrency({
		tasks,
		limit,
		errorMode: "stop"
	});
	if (hasError) {throw firstError;}
	return results;
}
//#endregion
//#region src/memory/session-files.ts
const log = createSubsystemLogger("memory");
async function listSessionFilesForAgent(agentId) {
	const dir = resolveSessionTranscriptsDirForAgent(agentId);
	try {
		return (await fs$1.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(dir, name));
	} catch {
		return [];
	}
}
function sessionPathForFile(absPath) {
	return path.join("sessions", path.basename(absPath)).replace(/\\/g, "/");
}
function normalizeSessionText(value) {
	return value.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
}
function extractSessionText(content) {
	if (typeof content === "string") {
		const normalized = normalizeSessionText(content);
		return normalized ? normalized : null;
	}
	if (!Array.isArray(content)) {return null;}
	const parts = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {continue;}
		const record = block;
		if (record.type !== "text" || typeof record.text !== "string") {continue;}
		const normalized = normalizeSessionText(record.text);
		if (normalized) {parts.push(normalized);}
	}
	if (parts.length === 0) {return null;}
	return parts.join(" ");
}
async function buildSessionEntry(absPath) {
	try {
		const stat = await fs$1.stat(absPath);
		const lines = (await fs$1.readFile(absPath, "utf-8")).split("\n");
		const collected = [];
		const lineMap = [];
		for (let jsonlIdx = 0; jsonlIdx < lines.length; jsonlIdx++) {
			const line = lines[jsonlIdx];
			if (!line.trim()) {continue;}
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (!record || typeof record !== "object" || record.type !== "message") {continue;}
			const message = record.message;
			if (!message || typeof message.role !== "string") {continue;}
			if (message.role !== "user" && message.role !== "assistant") {continue;}
			const text = extractSessionText(message.content);
			if (!text) {continue;}
			const safe = redactSensitiveText(text, { mode: "tools" });
			const label = message.role === "user" ? "User" : "Assistant";
			collected.push(`${label}: ${safe}`);
			lineMap.push(jsonlIdx + 1);
		}
		const content = collected.join("\n");
		return {
			path: sessionPathForFile(absPath),
			absPath,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			hash: hashText(content + "\n" + lineMap.join(",")),
			content,
			lineMap
		};
	} catch (err) {
		log.debug(`Failed reading session file ${absPath}: ${String(err)}`);
		return null;
	}
}
//#endregion
//#region src/memory/sqlite.ts
const require = createRequire(import.meta.url);
function requireNodeSqlite() {
	installProcessWarningFilter();
	try {
		return require("node:sqlite");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`, { cause: err });
	}
}
//#endregion
//#region src/memory/query-expansion.ts
/**
* Query expansion for FTS-only search mode.
*
* When no embedding provider is available, we fall back to FTS (full-text search).
* FTS works best with specific keywords, but users often ask conversational queries
* like "that thing we discussed yesterday" or "之前讨论的那个方案".
*
* This module extracts meaningful keywords from such queries to improve FTS results.
*/
const STOP_WORDS_EN = new Set([
	"a",
	"an",
	"the",
	"this",
	"that",
	"these",
	"those",
	"i",
	"me",
	"my",
	"we",
	"our",
	"you",
	"your",
	"he",
	"she",
	"it",
	"they",
	"them",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"can",
	"may",
	"might",
	"in",
	"on",
	"at",
	"to",
	"for",
	"of",
	"with",
	"by",
	"from",
	"about",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"under",
	"over",
	"and",
	"or",
	"but",
	"if",
	"then",
	"because",
	"as",
	"while",
	"when",
	"where",
	"what",
	"which",
	"who",
	"how",
	"why",
	"yesterday",
	"today",
	"tomorrow",
	"earlier",
	"later",
	"recently",
	"before",
	"ago",
	"just",
	"now",
	"thing",
	"things",
	"stuff",
	"something",
	"anything",
	"everything",
	"nothing",
	"please",
	"help",
	"find",
	"show",
	"get",
	"tell",
	"give"
]);
const STOP_WORDS_ES = new Set([
	"el",
	"la",
	"los",
	"las",
	"un",
	"una",
	"unos",
	"unas",
	"este",
	"esta",
	"ese",
	"esa",
	"yo",
	"me",
	"mi",
	"nosotros",
	"nosotras",
	"tu",
	"tus",
	"usted",
	"ustedes",
	"ellos",
	"ellas",
	"de",
	"del",
	"a",
	"en",
	"con",
	"por",
	"para",
	"sobre",
	"entre",
	"y",
	"o",
	"pero",
	"si",
	"porque",
	"como",
	"es",
	"son",
	"fue",
	"fueron",
	"ser",
	"estar",
	"haber",
	"tener",
	"hacer",
	"ayer",
	"hoy",
	"mañana",
	"antes",
	"despues",
	"después",
	"ahora",
	"recientemente",
	"que",
	"qué",
	"cómo",
	"cuando",
	"cuándo",
	"donde",
	"dónde",
	"porqué",
	"favor",
	"ayuda"
]);
const STOP_WORDS_PT = new Set([
	"o",
	"a",
	"os",
	"as",
	"um",
	"uma",
	"uns",
	"umas",
	"este",
	"esta",
	"esse",
	"essa",
	"eu",
	"me",
	"meu",
	"minha",
	"nos",
	"nós",
	"você",
	"vocês",
	"ele",
	"ela",
	"eles",
	"elas",
	"de",
	"do",
	"da",
	"em",
	"com",
	"por",
	"para",
	"sobre",
	"entre",
	"e",
	"ou",
	"mas",
	"se",
	"porque",
	"como",
	"é",
	"são",
	"foi",
	"foram",
	"ser",
	"estar",
	"ter",
	"fazer",
	"ontem",
	"hoje",
	"amanhã",
	"antes",
	"depois",
	"agora",
	"recentemente",
	"que",
	"quê",
	"quando",
	"onde",
	"porquê",
	"favor",
	"ajuda"
]);
const STOP_WORDS_AR = new Set([
	"ال",
	"و",
	"أو",
	"لكن",
	"ثم",
	"بل",
	"أنا",
	"نحن",
	"هو",
	"هي",
	"هم",
	"هذا",
	"هذه",
	"ذلك",
	"تلك",
	"هنا",
	"هناك",
	"من",
	"إلى",
	"الى",
	"في",
	"على",
	"عن",
	"مع",
	"بين",
	"ل",
	"ب",
	"ك",
	"كان",
	"كانت",
	"يكون",
	"تكون",
	"صار",
	"أصبح",
	"يمكن",
	"ممكن",
	"بالأمس",
	"امس",
	"اليوم",
	"غدا",
	"الآن",
	"قبل",
	"بعد",
	"مؤخرا",
	"لماذا",
	"كيف",
	"ماذا",
	"متى",
	"أين",
	"هل",
	"من فضلك",
	"فضلا",
	"ساعد"
]);
const STOP_WORDS_KO = new Set([
	"은",
	"는",
	"이",
	"가",
	"을",
	"를",
	"의",
	"에",
	"에서",
	"로",
	"으로",
	"와",
	"과",
	"도",
	"만",
	"까지",
	"부터",
	"한테",
	"에게",
	"께",
	"처럼",
	"같이",
	"보다",
	"마다",
	"밖에",
	"대로",
	"나",
	"나는",
	"내가",
	"나를",
	"너",
	"우리",
	"저",
	"저희",
	"그",
	"그녀",
	"그들",
	"이것",
	"저것",
	"그것",
	"여기",
	"저기",
	"거기",
	"있다",
	"없다",
	"하다",
	"되다",
	"이다",
	"아니다",
	"보다",
	"주다",
	"오다",
	"가다",
	"것",
	"거",
	"등",
	"수",
	"때",
	"곳",
	"중",
	"분",
	"잘",
	"더",
	"또",
	"매우",
	"정말",
	"아주",
	"많이",
	"너무",
	"좀",
	"그리고",
	"하지만",
	"그래서",
	"그런데",
	"그러나",
	"또는",
	"그러면",
	"왜",
	"어떻게",
	"뭐",
	"언제",
	"어디",
	"누구",
	"무엇",
	"어떤",
	"어제",
	"오늘",
	"내일",
	"최근",
	"지금",
	"아까",
	"나중",
	"전에",
	"제발",
	"부탁"
]);
const KO_TRAILING_PARTICLES = [
	"에서",
	"으로",
	"에게",
	"한테",
	"처럼",
	"같이",
	"보다",
	"까지",
	"부터",
	"마다",
	"밖에",
	"대로",
	"은",
	"는",
	"이",
	"가",
	"을",
	"를",
	"의",
	"에",
	"로",
	"와",
	"과",
	"도",
	"만"
].toSorted((a, b) => b.length - a.length);
function stripKoreanTrailingParticle(token) {
	for (const particle of KO_TRAILING_PARTICLES) {if (token.length > particle.length && token.endsWith(particle)) return token.slice(0, -particle.length);}
	return null;
}
function isUsefulKoreanStem(stem) {
	if (/[\uac00-\ud7af]/.test(stem)) {return stem.length >= 2;}
	return /^[a-z0-9_]+$/i.test(stem);
}
const STOP_WORDS_JA = new Set([
	"これ",
	"それ",
	"あれ",
	"この",
	"その",
	"あの",
	"ここ",
	"そこ",
	"あそこ",
	"する",
	"した",
	"して",
	"です",
	"ます",
	"いる",
	"ある",
	"なる",
	"できる",
	"の",
	"こと",
	"もの",
	"ため",
	"そして",
	"しかし",
	"また",
	"でも",
	"から",
	"まで",
	"より",
	"だけ",
	"なぜ",
	"どう",
	"何",
	"いつ",
	"どこ",
	"誰",
	"どれ",
	"昨日",
	"今日",
	"明日",
	"最近",
	"今",
	"さっき",
	"前",
	"後"
]);
const STOP_WORDS_ZH = new Set([
	"我",
	"我们",
	"你",
	"你们",
	"他",
	"她",
	"它",
	"他们",
	"这",
	"那",
	"这个",
	"那个",
	"这些",
	"那些",
	"的",
	"了",
	"着",
	"过",
	"得",
	"地",
	"吗",
	"呢",
	"吧",
	"啊",
	"呀",
	"嘛",
	"啦",
	"是",
	"有",
	"在",
	"被",
	"把",
	"给",
	"让",
	"用",
	"到",
	"去",
	"来",
	"做",
	"说",
	"看",
	"找",
	"想",
	"要",
	"能",
	"会",
	"可以",
	"和",
	"与",
	"或",
	"但",
	"但是",
	"因为",
	"所以",
	"如果",
	"虽然",
	"而",
	"也",
	"都",
	"就",
	"还",
	"又",
	"再",
	"才",
	"只",
	"之前",
	"以前",
	"之后",
	"以后",
	"刚才",
	"现在",
	"昨天",
	"今天",
	"明天",
	"最近",
	"东西",
	"事情",
	"事",
	"什么",
	"哪个",
	"哪些",
	"怎么",
	"为什么",
	"多少",
	"请",
	"帮",
	"帮忙",
	"告诉"
]);
function isQueryStopWordToken(token) {
	return STOP_WORDS_EN.has(token) || STOP_WORDS_ES.has(token) || STOP_WORDS_PT.has(token) || STOP_WORDS_AR.has(token) || STOP_WORDS_ZH.has(token) || STOP_WORDS_KO.has(token) || STOP_WORDS_JA.has(token);
}
/**
* Check if a token looks like a meaningful keyword.
* Returns false for short tokens, numbers-only, etc.
*/
function isValidKeyword(token) {
	if (!token || token.length === 0) {return false;}
	if (/^[a-zA-Z]+$/.test(token) && token.length < 3) {return false;}
	if (/^\d+$/.test(token)) {return false;}
	if (/^[\p{P}\p{S}]+$/u.test(token)) {return false;}
	return true;
}
/**
* Simple tokenizer that handles English, Chinese, Korean, and Japanese text.
* For Chinese, we do character-based splitting since we don't have a proper segmenter.
* For English, we split on whitespace and punctuation.
*/
function tokenize(text) {
	const tokens = [];
	const segments = text.toLowerCase().trim().split(/[\s\p{P}]+/u).filter(Boolean);
	for (const segment of segments) {if (/[\u3040-\u30ff]/.test(segment)) {
		const jpParts = segment.match(/[a-z0-9_]+|[\u30a0-\u30ffー]+|[\u4e00-\u9fff]+|[\u3040-\u309f]{2,}/g) ?? [];
		for (const part of jpParts) if (/^[\u4e00-\u9fff]+$/.test(part)) {
			tokens.push(part);
			for (let i = 0; i < part.length - 1; i++) tokens.push(part[i] + part[i + 1]);
		} else tokens.push(part);
	} else if (/[\u4e00-\u9fff]/.test(segment)) {
		const chars = Array.from(segment).filter((c) => /[\u4e00-\u9fff]/.test(c));
		tokens.push(...chars);
		for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
	} else if (/[\uac00-\ud7af\u3131-\u3163]/.test(segment)) {
		const stem = stripKoreanTrailingParticle(segment);
		const stemIsStopWord = stem !== null && STOP_WORDS_KO.has(stem);
		if (!STOP_WORDS_KO.has(segment) && !stemIsStopWord) tokens.push(segment);
		if (stem && !STOP_WORDS_KO.has(stem) && isUsefulKoreanStem(stem)) tokens.push(stem);
	} else tokens.push(segment);}
	return tokens;
}
/**
* Extract keywords from a conversational query for FTS search.
*
* Examples:
* - "that thing we discussed about the API" → ["discussed", "API"]
* - "之前讨论的那个方案" → ["讨论", "方案"]
* - "what was the solution for the bug" → ["solution", "bug"]
*/
function extractKeywords(query) {
	const tokens = tokenize(query);
	const keywords = [];
	const seen = /* @__PURE__ */ new Set();
	for (const token of tokens) {
		if (isQueryStopWordToken(token)) {continue;}
		if (!isValidKeyword(token)) {continue;}
		if (seen.has(token)) {continue;}
		seen.add(token);
		keywords.push(token);
	}
	return keywords;
}
//#endregion
export { openWritableFileWithinRoot as A, isFileMissingError as C, copyFileWithinRoot as D, appendFileWithinRoot as E, runTasksWithConcurrency as F, readLocalFileSafely as M, writeFileFromPathWithinRoot as N, createRootScopedReadFile as O, writeFileWithinRoot as P, splitTextToUtf8ByteLimit as S, SafeOpenError as T, remapChunkLines as _, listSessionFilesForAgent as a, estimateStructuredEmbeddingInputBytes as b, buildMultimodalChunkForIndexing as c, ensureDir as d, hashText as f, parseEmbedding as g, normalizeExtraMemoryPaths as h, buildSessionEntry as i, readFileWithinRoot as j, openFileWithinRoot as k, chunkMarkdown as l, listMemoryFiles as m, isQueryStopWordToken as n, sessionPathForFile as o, isMemoryPath as p, requireNodeSqlite as r, buildFileEntry as s, extractKeywords as t, cosineSimilarity as u, runWithConcurrency as v, statRegularFile as w, estimateUtf8Bytes as x, hasNonTextEmbeddingParts as y };
