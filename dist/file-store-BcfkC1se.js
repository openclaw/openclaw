import { n as getFsSafeLockConfig, t as createSidecarLockManager } from "./sidecar-lock-Bv7C32CP.js";
import { d as resolveSafeRelativePath, i as isPathInside, m as FsSafeError, o as isPathRelativeEscape } from "./path-BlG8lhgR.js";
import { f as createSyncDirectoryGuard, l as assertSyncDirectoryGuard$1 } from "./write-queue-C9nceBqy.js";
import { a as resolveOpenedFileRealPathForHandle, o as root, s as getFsSafeTestHooks, t as resolveSecureTempRoot } from "./secure-temp-dir-aidxCRgA.js";
import { t as stringifyJsonDocument } from "./json-stringify-DYDqVIo7.js";
import { i as openRootFileSync, n as matchRootFileOpenFailure } from "./root-file-jRMCpJW4.js";
import { r as readRegularFile } from "./regular-file-DaVeNX32.js";
import { o as writeSecretFileAtomic } from "./secret-file-DsUhZ-Ug.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
//#region node_modules/@openclaw/fs-safe/dist/file-store-prune.js
async function pruneExpiredStoreEntries(params) {
	const now = Date.now();
	const recursive = params.options.recursive ?? false;
	const maxDepth = params.options.maxDepth;
	const pruneEmptyDirs = (recursive || maxDepth !== void 0) && (params.options.pruneEmptyDirs ?? false);
	await fs$1.mkdir(params.rootDir, {
		recursive: true,
		mode: params.dirMode
	});
	const rootReal = await fs$1.realpath(params.rootDir);
	const scopedRoot = await root(rootReal);
	const rootGuard = {
		dir: rootReal,
		realPath: rootReal,
		stat: await fs$1.lstat(rootReal)
	};
	async function assertRootGuard() {
		const stat = await fs$1.lstat(rootGuard.dir);
		if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== rootGuard.stat.dev || stat.ino !== rootGuard.stat.ino || await fs$1.realpath(rootGuard.dir) !== rootGuard.realPath) throw new FsSafeError("path-mismatch", "store root changed during prune");
	}
	async function readStableDirectory(dir) {
		const before = await fs$1.lstat(dir).catch(() => null);
		if (!before || before.isSymbolicLink() || !before.isDirectory()) return null;
		const real = await fs$1.realpath(dir).catch(() => null);
		if (!real || !isPathInside(rootReal, real)) return null;
		const entries = await fs$1.readdir(dir, { withFileTypes: true }).catch(() => null);
		if (!entries) return null;
		const after = await fs$1.lstat(dir).catch(() => null);
		if (!after || before.dev !== after.dev || before.ino !== after.ino) return null;
		return entries;
	}
	async function pruneDir(dir, relativeDir, depth) {
		const entries = await readStableDirectory(dir);
		if (!entries) return false;
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			const stat = await fs$1.lstat(fullPath).catch(() => null);
			if (!stat || stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				const shouldDescend = maxDepth !== void 0 ? depth < maxDepth : recursive;
				if (shouldDescend) await getFsSafeTestHooks()?.beforeFileStorePruneDescend?.(fullPath);
				if (shouldDescend && await pruneDir(fullPath, relativePath, depth + 1)) {
					await assertRootGuard();
					await scopedRoot.remove(relativePath).catch(() => void 0);
				}
				continue;
			}
			if (stat.isFile() && now - stat.mtimeMs > params.options.ttlMs) {
				await assertRootGuard();
				await scopedRoot.remove(relativePath).catch(() => void 0);
			}
		}
		if (!pruneEmptyDirs) return false;
		const remaining = await readStableDirectory(dir);
		return remaining !== null && remaining.length === 0;
	}
	await pruneDir(rootReal, "", 0);
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/file-store-boundary.js
function parentRelativePath(relativePath) {
	const parent = path.posix.dirname(relativePath);
	return parent === "." ? "" : parent;
}
async function ensureParentInRoot(scopedRoot, relativePath, mode) {
	const parent = parentRelativePath(relativePath);
	if (!parent) return;
	await scopedRoot.mkdir(parent);
	await chmodDirectoryInRootBestEffort(scopedRoot, parent, mode).catch(() => void 0);
}
async function openWritableStoreRoot(params) {
	await fs$1.mkdir(params.rootDir, {
		recursive: true,
		mode: params.dirMode
	});
	await fs$1.chmod(params.rootDir, params.dirMode).catch(() => void 0);
	return await root(params.rootDir, {
		hardlinks: "reject",
		maxBytes: params.maxBytes
	});
}
async function chmodDirectoryInRootBestEffort(scopedRoot, relativePath, mode) {
	const dirPath = await scopedRoot.resolve(relativePath);
	const directoryFlag = "O_DIRECTORY" in fs.constants ? fs.constants.O_DIRECTORY : 0;
	const noFollowFlag = process.platform !== "win32" && "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
	const handle = await fs$1.open(dirPath, fs.constants.O_RDONLY | directoryFlag | noFollowFlag);
	try {
		if (!(await handle.stat()).isDirectory()) return;
		const realPath = await resolveOpenedFileRealPathForHandle(handle, dirPath);
		if (!isPathInside(scopedRoot.rootWithSep, realPath)) throw new FsSafeError("outside-workspace", "directory is outside store root");
		await handle.chmod(mode).catch(() => void 0);
	} finally {
		await handle.close().catch(() => void 0);
	}
}
function createMaxBytesTransform(maxBytes) {
	if (maxBytes === void 0) return;
	let total = 0;
	return new Transform({ transform(chunk, _encoding, callback) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.byteLength;
		if (total > maxBytes) {
			callback(new FsSafeError("too-large", `file exceeds maximum size of ${maxBytes} bytes`));
			return;
		}
		callback(null, buffer);
	} });
}
async function writeStreamToTempSource(params) {
	const tempRoot = resolveSecureTempRoot({
		fallbackPrefix: "fs-safe-file-store",
		unsafeFallbackLabel: "file store temp dir",
		warn: () => void 0
	});
	const dir = await fs$1.mkdtemp(path.join(tempRoot, "fs-safe-file-store-"));
	const filePath = path.join(dir, "payload");
	let handle = null;
	let handleClosedByStream = false;
	try {
		handle = await fs$1.open(filePath, "wx", params.mode);
		const writable = handle.createWriteStream();
		writable.once("close", () => {
			handleClosedByStream = true;
		});
		const limiter = createMaxBytesTransform(params.maxBytes);
		if (limiter) await pipeline(params.stream, limiter, writable);
		else await pipeline(params.stream, writable);
		if (!handleClosedByStream) await handle.close().catch(() => void 0);
		await fs$1.chmod(filePath, params.mode).catch(() => void 0);
		return {
			path: filePath,
			cleanup: async () => {
				await fs$1.rm(dir, {
					recursive: true,
					force: true
				}).catch(() => void 0);
			}
		};
	} catch (err) {
		if (handle && !handleClosedByStream) await handle.close().catch(() => void 0);
		await fs$1.rm(dir, {
			recursive: true,
			force: true
		}).catch(() => void 0);
		throw err;
	}
}
function assertSyncDirectoryGuard(guard) {
	try {
		assertSyncDirectoryGuard$1(guard);
	} catch (error) {
		if (error instanceof FsSafeError && error.code === "path-mismatch") throw new FsSafeError("path-mismatch", "store directory changed during write", { cause: error });
		throw error;
	}
}
function chmodDirectorySyncBestEffort(dir, mode) {
	try {
		fs.chmodSync(dir, mode);
	} catch {}
}
function ensureParentSync(params) {
	const rootDir = path.resolve(params.rootDir);
	const dir = path.dirname(path.resolve(params.filePath));
	if (isPathRelativeEscape(path.relative(rootDir, dir))) throw new FsSafeError("outside-workspace", "file path escapes store root");
	fs.mkdirSync(rootDir, {
		recursive: true,
		mode: params.mode
	});
	const rootStat = fs.lstatSync(rootDir);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new FsSafeError("not-file", `store root must be a directory: ${rootDir}`);
	const rootReal = fs.realpathSync(rootDir);
	chmodDirectorySyncBestEffort(rootDir, params.mode);
	let current = rootDir;
	for (const segment of path.relative(rootDir, dir).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new FsSafeError("not-file", `store directory component must be a directory: ${current}`);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			fs.mkdirSync(current, { mode: params.mode });
		}
		if (!isPathInside(rootReal, fs.realpathSync(current))) throw new FsSafeError("outside-workspace", "store directory escapes root");
		chmodDirectorySyncBestEffort(current, params.mode);
	}
	const guard = createSyncDirectoryGuard(dir);
	assertSyncDirectoryGuard(guard);
	return guard;
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/file-store-source.js
async function readFileStoreCopySource(params) {
	const sourceStat = await fs$1.lstat(params.sourcePath);
	if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new FsSafeError("not-file", "source path is not a file");
	if (params.maxBytes !== void 0 && sourceStat.size > params.maxBytes) throw new FsSafeError("too-large", `file exceeds maximum size of ${params.maxBytes} bytes`);
	try {
		return (await readRegularFile({
			filePath: params.sourcePath,
			maxBytes: params.maxBytes
		})).buffer;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("regular file") || message.includes("not a regular file")) throw new FsSafeError("not-file", "source path is not a file", { cause: error instanceof Error ? error : void 0 });
		if (params.maxBytes !== void 0 && message.includes(`exceeds ${params.maxBytes} bytes`)) throw new FsSafeError("too-large", `file exceeds maximum size of ${params.maxBytes} bytes`, { cause: error instanceof Error ? error : void 0 });
		throw error;
	}
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/json-document-store.js
function cloneFallback(value) {
	if (value && typeof value === "object") return structuredClone(value);
	return value;
}
function resolveLockOptions(filePath, options) {
	if (!options.lock) return null;
	const lockOptions = options.lock === true ? {} : options.lock;
	const defaults = getFsSafeLockConfig();
	return {
		managerKey: lockOptions.managerKey ?? `fs-safe.json-store:${filePath}`,
		retry: lockOptions.retry ?? defaults.retry ?? {},
		staleMs: lockOptions.staleMs ?? defaults.staleMs ?? 3e4,
		staleRecovery: lockOptions.staleRecovery ?? defaults.staleRecovery,
		timeoutMs: lockOptions.timeoutMs ?? defaults.timeoutMs ?? 3e4
	};
}
function createJsonStore(adapter, options = {}) {
	const lockOptions = resolveLockOptions(adapter.filePath, options);
	const locks = lockOptions ? createSidecarLockManager(lockOptions.managerKey) : null;
	async function read() {
		return await adapter.readIfExists();
	}
	async function readOr(fallback) {
		const current = await read();
		return current === void 0 ? cloneFallback(fallback) : current;
	}
	async function write(value) {
		await adapter.write(value, { trailingNewline: options.trailingNewline ?? true });
	}
	async function withOptionalLock(run) {
		if (!locks || !lockOptions) return await run();
		return await locks.withLock({
			targetPath: adapter.filePath,
			staleMs: lockOptions.staleMs,
			timeoutMs: lockOptions.timeoutMs,
			retry: lockOptions.retry,
			staleRecovery: lockOptions.staleRecovery,
			allowReentrant: true,
			payload: () => ({
				pid: process.pid,
				createdAt: (/* @__PURE__ */ new Date()).toISOString()
			})
		}, run);
	}
	return {
		filePath: adapter.filePath,
		read,
		readOr,
		readRequired: adapter.readRequired,
		write: async (value) => {
			await withOptionalLock(async () => {
				await write(value);
			});
		},
		update: async (run) => await withOptionalLock(async () => {
			const next = await run(await read());
			await write(next);
			return next;
		}),
		updateOr: async (fallback, run) => await withOptionalLock(async () => {
			const current = await read();
			const next = await run(current === void 0 ? cloneFallback(fallback) : current);
			await write(next);
			return next;
		})
	};
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/file-store.js
function assertRelativePath(relativePath) {
	const raw = relativePath.trim();
	if (!raw) throw new FsSafeError("invalid-path", "relative path must be non-empty");
	return raw.replaceAll("\\", "/");
}
function resolveStorePath(rootDir, relativePath) {
	return resolveSafeRelativePath(rootDir, assertRelativePath(relativePath));
}
function assertStoreFilePath(rootDir, filePath) {
	if (!isPathInside(rootDir, filePath)) throw new FsSafeError("outside-workspace", "file path escapes store root");
}
function assertMaxBytes(size, maxBytes) {
	if (maxBytes !== void 0 && size > maxBytes) throw new FsSafeError("too-large", `file exceeds maximum size of ${maxBytes} bytes`);
}
function isNotFound(error) {
	if (!error) return false;
	return error instanceof FsSafeError ? error.code === "not-found" : error.code === "ENOENT" || error.code === "ENOTDIR";
}
function handleSyncStoreReadOpenFailure(opened) {
	return matchRootFileOpenFailure(opened, {
		path: (failure) => {
			if (isNotFound(failure.error)) return null;
			throw new FsSafeError("path-mismatch", "store target changed during read", { cause: failure.error instanceof Error ? failure.error : void 0 });
		},
		validation: (failure) => {
			throw new FsSafeError("path-mismatch", "store target failed read validation", { cause: failure.error instanceof Error ? failure.error : void 0 });
		},
		fallback: (failure) => {
			throw new FsSafeError("path-mismatch", "store target changed during read", { cause: failure.error instanceof Error ? failure.error : void 0 });
		}
	});
}
async function copyIntoRoot(params) {
	const relativePath = assertRelativePath(params.relativePath);
	const destination = resolveStorePath(params.rootDir, relativePath);
	const sourceStat = await fs$1.lstat(params.sourcePath);
	if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new FsSafeError("not-file", "source path is not a file");
	assertMaxBytes(sourceStat.size, params.maxBytes);
	const dirMode = params.dirMode ?? 448;
	const scopedRoot = await openWritableStoreRoot({
		rootDir: params.rootDir,
		dirMode,
		maxBytes: params.maxBytes
	});
	await ensureParentInRoot(scopedRoot, relativePath, dirMode);
	await scopedRoot.copyIn(relativePath, params.sourcePath, {
		maxBytes: params.maxBytes,
		mkdir: false,
		mode: params.mode ?? 384
	});
	return destination;
}
function fileStore(options) {
	const rootDir = path.resolve(options.rootDir);
	const privateMode = options.private ?? false;
	const dirMode = options.dirMode ?? 448;
	const mode = options.mode ?? 384;
	const maxBytes = options.maxBytes;
	async function openRoot() {
		return await root(rootDir, {
			hardlinks: "reject",
			maxBytes
		});
	}
	async function write(relativePath, data, writeOptions) {
		const safeRelativePath = assertRelativePath(relativePath);
		const destination = resolveStorePath(rootDir, safeRelativePath);
		const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
		assertMaxBytes(content.byteLength, writeOptions?.maxBytes ?? maxBytes);
		if (privateMode) {
			await writeSecretFileAtomic({
				rootDir,
				filePath: destination,
				content,
				dirMode: writeOptions?.dirMode ?? dirMode,
				mode: writeOptions?.mode ?? mode
			});
			return destination;
		}
		const writeDirMode = writeOptions?.dirMode ?? dirMode;
		const scopedRoot = await openWritableStoreRoot({
			rootDir,
			dirMode: writeDirMode,
			maxBytes: writeOptions?.maxBytes ?? maxBytes
		});
		await ensureParentInRoot(scopedRoot, safeRelativePath, writeDirMode);
		await scopedRoot.write(safeRelativePath, content, {
			mkdir: false,
			mode: writeOptions?.mode ?? mode
		});
		return destination;
	}
	return {
		rootDir,
		path: (relativePath) => resolveStorePath(rootDir, relativePath),
		root: openRoot,
		write,
		writeStream: async (relativePath, stream, writeOptions) => {
			const safeRelativePath = assertRelativePath(relativePath);
			const destination = resolveStorePath(rootDir, safeRelativePath);
			const limit = writeOptions?.maxBytes ?? maxBytes ?? (privateMode ? 16777216 : void 0);
			if (privateMode) {
				const chunks = [];
				let total = 0;
				for await (const chunk of stream) {
					const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
					total += buffer.byteLength;
					assertMaxBytes(total, limit);
					chunks.push(buffer);
				}
				await writeSecretFileAtomic({
					rootDir,
					filePath: destination,
					content: Buffer.concat(chunks),
					dirMode: writeOptions?.dirMode ?? dirMode,
					mode: writeOptions?.mode ?? mode
				});
				return destination;
			}
			const staged = await writeStreamToTempSource({
				stream,
				maxBytes: limit,
				mode: writeOptions?.mode ?? mode
			});
			try {
				await copyIntoRoot({
					rootDir,
					relativePath: safeRelativePath,
					sourcePath: staged.path,
					maxBytes: limit,
					mode: writeOptions?.mode ?? mode,
					tempPrefix: writeOptions?.tempPrefix,
					dirMode: writeOptions?.dirMode ?? dirMode
				});
			} finally {
				await staged.cleanup();
			}
			return destination;
		},
		copyIn: async (relativePath, sourcePath, writeOptions) => privateMode ? await (async () => {
			return await write(relativePath, await readFileStoreCopySource({
				sourcePath,
				maxBytes: writeOptions?.maxBytes ?? maxBytes ?? 16777216
			}), writeOptions);
		})() : await copyIntoRoot({
			rootDir,
			relativePath,
			sourcePath,
			dirMode: writeOptions?.dirMode ?? dirMode,
			maxBytes: writeOptions?.maxBytes ?? maxBytes,
			mode: writeOptions?.mode ?? mode,
			tempPrefix: writeOptions?.tempPrefix
		}),
		open: async (relativePath, readOptions) => await (await openRoot()).open(assertRelativePath(relativePath), readOptions),
		read: async (relativePath, readOptions) => await (await openRoot()).read(assertRelativePath(relativePath), readOptions),
		readBytes: async (relativePath, readOptions) => await (await openRoot()).readBytes(assertRelativePath(relativePath), readOptions),
		readText: async (relativePath, readOptions) => {
			const { encoding = "utf8", ...options } = readOptions ?? {};
			return (await (await openRoot()).read(assertRelativePath(relativePath), options)).buffer.toString(encoding);
		},
		readTextIfExists: async (relativePath, readOptions) => {
			try {
				return await (await openRoot()).readText(assertRelativePath(relativePath), readOptions);
			} catch (error) {
				if (isNotFound(error)) return null;
				throw error;
			}
		},
		readJson: async (relativePath, readOptions) => {
			const { encoding = "utf8", ...options } = readOptions ?? {};
			return JSON.parse((await (await openRoot()).read(assertRelativePath(relativePath), options)).buffer.toString(encoding));
		},
		readJsonIfExists: async (relativePath, readOptions) => {
			try {
				return await (await openRoot()).readJson(assertRelativePath(relativePath), readOptions);
			} catch (error) {
				if (isNotFound(error)) return null;
				throw error;
			}
		},
		remove: async (relativePath) => {
			await (await openRoot()).remove(assertRelativePath(relativePath));
		},
		exists: async (relativePath) => await (await openRoot()).exists(assertRelativePath(relativePath)),
		writeText: async (relativePath, data, writeOptions) => await write(relativePath, data, writeOptions),
		writeJson: async (relativePath, data, writeOptions) => {
			const json = stringifyJsonDocument(data, null, 2);
			return await write(relativePath, writeOptions?.trailingNewline === false ? json : `${json}\n`, writeOptions);
		},
		json: (relativePath, jsonOptions) => {
			return createJsonStore({
				filePath: resolveStorePath(rootDir, relativePath),
				readIfExists: async () => {
					try {
						return await (await openRoot()).readJson(assertRelativePath(relativePath));
					} catch (error) {
						if (isNotFound(error)) return;
						throw error;
					}
				},
				readRequired: async () => await (await openRoot()).readJson(assertRelativePath(relativePath)),
				write: async (value, options) => {
					const json = stringifyJsonDocument(value, null, 2);
					await write(relativePath, options?.trailingNewline === false ? json : `${json}\n`);
				}
			}, jsonOptions);
		},
		pruneExpired: async (pruneOptions) => {
			await pruneExpiredStoreEntries({
				rootDir,
				dirMode,
				options: pruneOptions
			});
		}
	};
}
function ensurePrivateDirectorySync(rootDir, targetDir, mode) {
	const root = path.resolve(rootDir);
	const target = path.resolve(targetDir);
	assertStoreFilePath(root, target);
	let current = root;
	fs.mkdirSync(current, {
		recursive: true,
		mode
	});
	const rootStat = fs.lstatSync(current);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new FsSafeError("not-file", `private store root must be a directory: ${current}`);
	try {
		fs.chmodSync(current, mode);
	} catch {}
	for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new FsSafeError("not-file", `private store directory component must be a directory: ${current}`);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			fs.mkdirSync(current, { mode });
		}
		if (!isPathInside(fs.realpathSync(root), fs.realpathSync(current))) throw new FsSafeError("outside-workspace", "private store directory escapes root");
		try {
			fs.chmodSync(current, mode);
		} catch {}
	}
	const guard = createSyncDirectoryGuard(target);
	assertSyncDirectoryGuard(guard);
	return guard;
}
function writeFileSyncAtomic(params) {
	const filePath = path.resolve(params.filePath);
	assertStoreFilePath(params.rootDir, filePath);
	let parentGuard;
	if (params.privateMode) {
		parentGuard = ensurePrivateDirectorySync(params.rootDir, path.dirname(filePath), params.dirMode);
		try {
			const stat = fs.lstatSync(filePath);
			if (stat.isSymbolicLink() || !stat.isFile()) throw new FsSafeError("not-file", `private store target must be a regular file: ${filePath}`);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	} else parentGuard = ensureParentSync({
		rootDir: params.rootDir,
		filePath,
		mode: params.dirMode
	});
	const tempPath = path.join(parentGuard?.dir ?? path.dirname(filePath), `.fs-safe-${process.pid}-${randomUUID()}.tmp`);
	let tempExists = false;
	try {
		getFsSafeTestHooks()?.beforeFileStoreSyncPrivateWrite?.(filePath);
		if (parentGuard) assertSyncDirectoryGuard(parentGuard);
		fs.writeFileSync(tempPath, params.content, {
			flag: "wx",
			mode: params.mode
		});
		tempExists = true;
		try {
			fs.chmodSync(tempPath, params.mode);
		} catch {}
		if (parentGuard) assertSyncDirectoryGuard(parentGuard);
		fs.renameSync(tempPath, filePath);
		tempExists = false;
		if (parentGuard) assertSyncDirectoryGuard(parentGuard);
		try {
			fs.chmodSync(filePath, params.mode);
		} catch {}
		return filePath;
	} finally {
		if (tempExists) try {
			fs.unlinkSync(tempPath);
		} catch {}
	}
}
function fileStoreSync(options) {
	const rootDir = path.resolve(options.rootDir);
	const privateMode = options.private ?? false;
	const dirMode = options.dirMode ?? 448;
	const mode = options.mode ?? 384;
	const maxBytes = options.maxBytes;
	function write(relativePath, data, writeOptions) {
		const destination = resolveStorePath(rootDir, relativePath);
		const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
		assertMaxBytes(content.byteLength, writeOptions?.maxBytes ?? maxBytes);
		return writeFileSyncAtomic({
			rootDir,
			filePath: destination,
			content,
			privateMode,
			dirMode: writeOptions?.dirMode ?? dirMode,
			mode: writeOptions?.mode ?? mode
		});
	}
	return {
		rootDir,
		path: (relativePath) => resolveStorePath(rootDir, relativePath),
		readTextIfExists: (relativePath, readOptions) => {
			const opened = openRootFileSync({
				absolutePath: resolveStorePath(rootDir, relativePath),
				rootPath: rootDir,
				boundaryLabel: "store root",
				rejectHardlinks: true
			});
			if (!opened.ok) return handleSyncStoreReadOpenFailure(opened);
			try {
				assertMaxBytes(opened.stat.size, readOptions?.maxBytes ?? maxBytes);
				const raw = fs.readFileSync(opened.fd, "utf8");
				assertMaxBytes(Buffer.byteLength(raw, "utf8"), readOptions?.maxBytes ?? maxBytes);
				return raw;
			} finally {
				fs.closeSync(opened.fd);
			}
		},
		readJsonIfExists: (relativePath, readOptions) => {
			const raw = fileStoreSync({
				rootDir,
				private: privateMode,
				dirMode,
				mode,
				maxBytes
			}).readTextIfExists(relativePath, readOptions);
			return raw === null ? null : JSON.parse(raw);
		},
		write,
		writeText: (relativePath, data, writeOptions) => write(relativePath, data, writeOptions),
		writeJson: (relativePath, data, writeOptions) => {
			const json = stringifyJsonDocument(data, null, 2);
			return write(relativePath, writeOptions?.trailingNewline === false ? json : `${json}\n`, writeOptions);
		}
	};
}
//#endregion
export { fileStoreSync as n, fileStore as t };
