import { a as sameFileIdentity, d as isPathInside, u as isNotFoundPathError } from "./boundary-file-read-CcBHg_z-.js";
import { F as copyFileWithinRoot, L as openFileWithinRoot, N as SafeOpenError, R as openWritableFileWithinRoot } from "./query-expansion-kdDusy7Q.js";
import { n as resolveSafeBaseDir } from "./path-safety-CmNS4Puh.js";
import path from "node:path";
import { constants } from "node:fs";
import fs$1 from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import JSZip from "jszip";
import * as tar from "tar";
//#region src/infra/archive-path.ts
function isWindowsDrivePath(value) {
	return /^[a-zA-Z]:[\\/]/.test(value);
}
function normalizeArchiveEntryPath(raw) {
	return raw.replaceAll("\\", "/");
}
function validateArchiveEntryPath(entryPath, params) {
	if (!entryPath || entryPath === "." || entryPath === "./") return;
	if (isWindowsDrivePath(entryPath)) throw new Error(`archive entry uses a drive path: ${entryPath}`);
	const normalized = path.posix.normalize(normalizeArchiveEntryPath(entryPath));
	const escapeLabel = params?.escapeLabel ?? "destination";
	if (normalized === ".." || normalized.startsWith("../")) throw new Error(`archive entry escapes ${escapeLabel}: ${entryPath}`);
	if (path.posix.isAbsolute(normalized) || normalized.startsWith("//")) throw new Error(`archive entry is absolute: ${entryPath}`);
}
function stripArchivePath(entryPath, stripComponents) {
	const raw = normalizeArchiveEntryPath(entryPath);
	if (!raw || raw === "." || raw === "./") return null;
	const parts = raw.split("/").filter((part) => part.length > 0 && part !== ".");
	const strip = Math.max(0, Math.floor(stripComponents));
	const stripped = strip === 0 ? parts.join("/") : parts.slice(strip).join("/");
	const result = path.posix.normalize(stripped);
	if (!result || result === "." || result === "./") return null;
	return result;
}
function resolveArchiveOutputPath(params) {
	const safeBase = resolveSafeBaseDir(params.rootDir);
	const outPath = path.resolve(params.rootDir, params.relPath);
	const escapeLabel = params.escapeLabel ?? "destination";
	if (!outPath.startsWith(safeBase)) throw new Error(`archive entry escapes ${escapeLabel}: ${params.originalPath}`);
	return outPath;
}
//#endregion
//#region src/infra/archive-staging.ts
const ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK = "archive entry traverses symlink in destination";
var ArchiveSecurityError = class extends Error {
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
		this.name = "ArchiveSecurityError";
	}
};
function symlinkTraversalError$1(originalPath) {
	return new ArchiveSecurityError("destination-symlink-traversal", `${ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK}: ${originalPath}`);
}
async function prepareArchiveDestinationDir(destDir) {
	const stat = await fs$1.lstat(destDir);
	if (stat.isSymbolicLink()) throw new ArchiveSecurityError("destination-symlink", "archive destination is a symlink");
	if (!stat.isDirectory()) throw new ArchiveSecurityError("destination-not-directory", "archive destination is not a directory");
	return await fs$1.realpath(destDir);
}
async function assertNoSymlinkTraversal(params) {
	const parts = params.relPath.split(/[\\/]+/).filter(Boolean);
	let current = path.resolve(params.rootDir);
	for (const part of parts) {
		current = path.join(current, part);
		let stat;
		try {
			stat = await fs$1.lstat(current);
		} catch (err) {
			if (isNotFoundPathError(err)) continue;
			throw err;
		}
		if (stat.isSymbolicLink()) throw symlinkTraversalError$1(params.originalPath);
	}
}
async function assertResolvedInsideDestination(params) {
	let resolved;
	try {
		resolved = await fs$1.realpath(params.targetPath);
	} catch (err) {
		if (isNotFoundPathError(err)) return;
		throw err;
	}
	if (!isPathInside(params.destinationRealDir, resolved)) throw symlinkTraversalError$1(params.originalPath);
}
async function prepareArchiveOutputPath(params) {
	await assertNoSymlinkTraversal({
		rootDir: params.destinationDir,
		relPath: params.relPath,
		originalPath: params.originalPath
	});
	if (params.isDirectory) {
		await fs$1.mkdir(params.outPath, { recursive: true });
		await assertResolvedInsideDestination({
			destinationRealDir: params.destinationRealDir,
			targetPath: params.outPath,
			originalPath: params.originalPath
		});
		return;
	}
	const parentDir = path.dirname(params.outPath);
	await fs$1.mkdir(parentDir, { recursive: true });
	await assertResolvedInsideDestination({
		destinationRealDir: params.destinationRealDir,
		targetPath: parentDir,
		originalPath: params.originalPath
	});
}
async function applyStagedEntryMode(params) {
	const destinationPath = path.join(params.destinationRealDir, params.relPath);
	await assertResolvedInsideDestination({
		destinationRealDir: params.destinationRealDir,
		targetPath: destinationPath,
		originalPath: params.originalPath
	});
	if (params.mode !== 0) await fs$1.chmod(destinationPath, params.mode).catch(() => void 0);
}
async function withStagedArchiveDestination(params) {
	const stagingDir = await fs$1.mkdtemp(path.join(params.destinationRealDir, ".openclaw-archive-"));
	try {
		return await params.run(stagingDir);
	} finally {
		await fs$1.rm(stagingDir, {
			recursive: true,
			force: true
		}).catch(() => void 0);
	}
}
async function mergeExtractedTreeIntoDestination(params) {
	const walk = async (currentSourceDir) => {
		const entries = await fs$1.readdir(currentSourceDir, { withFileTypes: true });
		for (const entry of entries) {
			const sourcePath = path.join(currentSourceDir, entry.name);
			const relPath = path.relative(params.sourceDir, sourcePath);
			const originalPath = relPath.split(path.sep).join("/");
			const destinationPath = path.join(params.destinationDir, relPath);
			const sourceStat = await fs$1.lstat(sourcePath);
			if (sourceStat.isSymbolicLink()) throw symlinkTraversalError$1(originalPath);
			if (sourceStat.isDirectory()) {
				await prepareArchiveOutputPath({
					destinationDir: params.destinationDir,
					destinationRealDir: params.destinationRealDir,
					relPath,
					outPath: destinationPath,
					originalPath,
					isDirectory: true
				});
				await walk(sourcePath);
				await applyStagedEntryMode({
					destinationRealDir: params.destinationRealDir,
					relPath,
					mode: sourceStat.mode & 511,
					originalPath
				});
				continue;
			}
			if (!sourceStat.isFile()) throw new Error(`archive staging contains unsupported entry: ${originalPath}`);
			await prepareArchiveOutputPath({
				destinationDir: params.destinationDir,
				destinationRealDir: params.destinationRealDir,
				relPath,
				outPath: destinationPath,
				originalPath,
				isDirectory: false
			});
			await copyFileWithinRoot({
				sourcePath,
				rootDir: params.destinationRealDir,
				relativePath: relPath,
				mkdir: true
			});
			await applyStagedEntryMode({
				destinationRealDir: params.destinationRealDir,
				relPath,
				mode: sourceStat.mode & 511,
				originalPath
			});
		}
	};
	await walk(params.sourceDir);
}
function createArchiveSymlinkTraversalError(originalPath) {
	return symlinkTraversalError$1(originalPath);
}
const ERROR_ARCHIVE_SIZE_EXCEEDS_LIMIT = "archive size exceeds limit";
const ERROR_ARCHIVE_ENTRY_COUNT_EXCEEDS_LIMIT = "archive entry count exceeds limit";
const ERROR_ARCHIVE_ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT = "archive entry extracted size exceeds limit";
const ERROR_ARCHIVE_EXTRACTED_SIZE_EXCEEDS_LIMIT = "archive extracted size exceeds limit";
const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in constants;
const OPEN_WRITE_CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const TAR_SUFFIXES = [
	".tgz",
	".tar.gz",
	".tar"
];
function resolveArchiveKind(filePath) {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".zip")) return "zip";
	if (TAR_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return "tar";
	return null;
}
async function resolvePackedRootDir(extractDir) {
	const direct = path.join(extractDir, "package");
	try {
		if ((await fs$1.stat(direct)).isDirectory()) return direct;
	} catch {}
	const dirs = (await fs$1.readdir(extractDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	if (dirs.length !== 1) throw new Error(`unexpected archive layout (dirs: ${dirs.join(", ")})`);
	const onlyDir = dirs[0];
	if (!onlyDir) throw new Error("unexpected archive layout (no package dir found)");
	return path.join(extractDir, onlyDir);
}
async function withTimeout(promise, timeoutMs, label) {
	let timeoutId;
	try {
		return await Promise.race([promise, new Promise((_, reject) => {
			timeoutId = setTimeout(() => reject(/* @__PURE__ */ new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
		})]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
function clampLimit(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	const v = Math.floor(value);
	return v > 0 ? v : void 0;
}
function resolveExtractLimits(limits) {
	return {
		maxArchiveBytes: clampLimit(limits?.maxArchiveBytes) ?? 268435456,
		maxEntries: clampLimit(limits?.maxEntries) ?? 5e4,
		maxExtractedBytes: clampLimit(limits?.maxExtractedBytes) ?? 536870912,
		maxEntryBytes: clampLimit(limits?.maxEntryBytes) ?? 268435456
	};
}
function assertArchiveEntryCountWithinLimit(entryCount, limits) {
	if (entryCount > limits.maxEntries) throw new Error(ERROR_ARCHIVE_ENTRY_COUNT_EXCEEDS_LIMIT);
}
function createByteBudgetTracker(limits) {
	let entryBytes = 0;
	let extractedBytes = 0;
	const addBytes = (bytes) => {
		const b = Math.max(0, Math.floor(bytes));
		if (b === 0) return;
		entryBytes += b;
		if (entryBytes > limits.maxEntryBytes) throw new Error(ERROR_ARCHIVE_ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
		extractedBytes += b;
		if (extractedBytes > limits.maxExtractedBytes) throw new Error(ERROR_ARCHIVE_EXTRACTED_SIZE_EXCEEDS_LIMIT);
	};
	return {
		startEntry() {
			entryBytes = 0;
		},
		addBytes,
		addEntrySize(size) {
			const s = Math.max(0, Math.floor(size));
			if (s > limits.maxEntryBytes) throw new Error(ERROR_ARCHIVE_ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
			addBytes(s);
		}
	};
}
function createExtractBudgetTransform(params) {
	return new Transform({ transform(chunk, _encoding, callback) {
		try {
			const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
			params.onChunkBytes(buf.byteLength);
			callback(null, buf);
		} catch (err) {
			callback(err instanceof Error ? err : new Error(String(err)));
		}
	} });
}
function symlinkTraversalError(originalPath) {
	return createArchiveSymlinkTraversalError(originalPath);
}
async function openZipOutputFile(params) {
	try {
		return await openWritableFileWithinRoot({
			rootDir: params.destinationRealDir,
			relativePath: params.relPath,
			mkdir: false,
			mode: 438
		});
	} catch (err) {
		if (err instanceof SafeOpenError && (err.code === "invalid-path" || err.code === "outside-workspace" || err.code === "path-mismatch")) throw symlinkTraversalError(params.originalPath);
		throw err;
	}
}
async function cleanupPartialRegularFile(filePath) {
	let stat;
	try {
		stat = await fs$1.lstat(filePath);
	} catch (err) {
		if (isNotFoundPathError(err)) return;
		throw err;
	}
	if (stat.isFile()) await fs$1.unlink(filePath).catch(() => void 0);
}
function buildArchiveAtomicTempPath(targetPath) {
	return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
}
async function verifyZipWriteResult(params) {
	const opened = await openFileWithinRoot({
		rootDir: params.destinationRealDir,
		relativePath: params.relPath,
		rejectHardlinks: true
	});
	try {
		if (!sameFileIdentity(opened.stat, params.expectedStat)) throw new SafeOpenError("path-mismatch", "path changed during zip extract");
		return opened.realPath;
	} finally {
		await opened.handle.close().catch(() => void 0);
	}
}
async function readZipEntryStream(entry) {
	if (typeof entry.nodeStream === "function") return entry.nodeStream();
	const buf = await entry.async("nodebuffer");
	return Readable.from(buf);
}
function resolveZipOutputPath(params) {
	validateArchiveEntryPath(params.entryPath);
	const relPath = stripArchivePath(params.entryPath, params.strip);
	if (!relPath) return null;
	validateArchiveEntryPath(relPath);
	return {
		relPath,
		outPath: resolveArchiveOutputPath({
			rootDir: params.destinationDir,
			relPath,
			originalPath: params.entryPath
		})
	};
}
async function prepareZipOutputPath(params) {
	await prepareArchiveOutputPath(params);
}
async function writeZipFileEntry(params) {
	const opened = await openZipOutputFile({
		relPath: params.relPath,
		originalPath: params.entry.name,
		destinationRealDir: params.destinationRealDir
	});
	params.budget.startEntry();
	const readable = await readZipEntryStream(params.entry);
	const destinationPath = opened.openedRealPath;
	const targetMode = opened.openedStat.mode & 511;
	await opened.handle.close().catch(() => void 0);
	let tempHandle = null;
	let tempPath = null;
	let tempStat = null;
	let handleClosedByStream = false;
	try {
		tempPath = buildArchiveAtomicTempPath(destinationPath);
		tempHandle = await fs$1.open(tempPath, OPEN_WRITE_CREATE_FLAGS, targetMode || 438);
		const writable = tempHandle.createWriteStream();
		writable.once("close", () => {
			handleClosedByStream = true;
		});
		await pipeline(readable, createExtractBudgetTransform({ onChunkBytes: params.budget.addBytes }), writable);
		tempStat = await fs$1.stat(tempPath);
		if (!tempStat) throw new Error("zip temp write did not produce file metadata");
		if (!handleClosedByStream) {
			await tempHandle.close().catch(() => void 0);
			handleClosedByStream = true;
		}
		tempHandle = null;
		await fs$1.rename(tempPath, destinationPath);
		tempPath = null;
		const verifiedPath = await verifyZipWriteResult({
			destinationRealDir: params.destinationRealDir,
			relPath: params.relPath,
			expectedStat: tempStat
		});
		if (typeof params.entry.unixPermissions === "number") {
			const mode = params.entry.unixPermissions & 511;
			if (mode !== 0) await fs$1.chmod(verifiedPath, mode).catch(() => void 0);
		}
	} catch (err) {
		if (tempPath) await fs$1.rm(tempPath, { force: true }).catch(() => void 0);
		else await cleanupPartialRegularFile(destinationPath).catch(() => void 0);
		if (err instanceof SafeOpenError) throw symlinkTraversalError(params.entry.name);
		throw err;
	} finally {
		if (tempHandle && !handleClosedByStream) await tempHandle.close().catch(() => void 0);
	}
}
async function extractZip(params) {
	const limits = resolveExtractLimits(params.limits);
	const destinationRealDir = await prepareArchiveDestinationDir(params.destDir);
	if ((await fs$1.stat(params.archivePath)).size > limits.maxArchiveBytes) throw new Error(ERROR_ARCHIVE_SIZE_EXCEEDS_LIMIT);
	const buffer = await fs$1.readFile(params.archivePath);
	const zip = await JSZip.loadAsync(buffer);
	const entries = Object.values(zip.files);
	const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
	assertArchiveEntryCountWithinLimit(entries.length, limits);
	const budget = createByteBudgetTracker(limits);
	for (const entry of entries) {
		const output = resolveZipOutputPath({
			entryPath: entry.name,
			strip,
			destinationDir: params.destDir
		});
		if (!output) continue;
		await prepareZipOutputPath({
			destinationDir: params.destDir,
			destinationRealDir,
			relPath: output.relPath,
			outPath: output.outPath,
			originalPath: entry.name,
			isDirectory: entry.dir
		});
		if (entry.dir) continue;
		await writeZipFileEntry({
			entry,
			relPath: output.relPath,
			destinationRealDir,
			budget
		});
	}
}
const BLOCKED_TAR_ENTRY_TYPES = new Set([
	"SymbolicLink",
	"Link",
	"BlockDevice",
	"CharacterDevice",
	"FIFO",
	"Socket"
]);
function readTarEntryInfo(entry) {
	return {
		path: typeof entry === "object" && entry !== null && "path" in entry ? String(entry.path) : "",
		type: typeof entry === "object" && entry !== null && "type" in entry ? String(entry.type) : "",
		size: typeof entry === "object" && entry !== null && "size" in entry && typeof entry.size === "number" && Number.isFinite(entry.size) ? Math.max(0, Math.floor(entry.size)) : 0
	};
}
function createTarEntryPreflightChecker(params) {
	const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
	const limits = resolveExtractLimits(params.limits);
	let entryCount = 0;
	const budget = createByteBudgetTracker(limits);
	return (entry) => {
		validateArchiveEntryPath(entry.path, { escapeLabel: params.escapeLabel });
		const relPath = stripArchivePath(entry.path, strip);
		if (!relPath) return;
		validateArchiveEntryPath(relPath, { escapeLabel: params.escapeLabel });
		resolveArchiveOutputPath({
			rootDir: params.rootDir,
			relPath,
			originalPath: entry.path,
			escapeLabel: params.escapeLabel
		});
		if (BLOCKED_TAR_ENTRY_TYPES.has(entry.type)) throw new Error(`tar entry is a link: ${entry.path}`);
		entryCount += 1;
		assertArchiveEntryCountWithinLimit(entryCount, limits);
		budget.addEntrySize(entry.size);
	};
}
async function extractArchive(params) {
	const kind = params.kind ?? resolveArchiveKind(params.archivePath);
	if (!kind) throw new Error(`unsupported archive: ${params.archivePath}`);
	const label = kind === "zip" ? "extract zip" : "extract tar";
	if (kind === "tar") {
		await withTimeout((async () => {
			const limits = resolveExtractLimits(params.limits);
			if ((await fs$1.stat(params.archivePath)).size > limits.maxArchiveBytes) throw new Error(ERROR_ARCHIVE_SIZE_EXCEEDS_LIMIT);
			const destinationRealDir = await prepareArchiveDestinationDir(params.destDir);
			await withStagedArchiveDestination({
				destinationRealDir,
				run: async (stagingDir) => {
					const checkTarEntrySafety = createTarEntryPreflightChecker({
						rootDir: destinationRealDir,
						stripComponents: params.stripComponents,
						limits
					});
					await tar.x({
						file: params.archivePath,
						cwd: stagingDir,
						strip: Math.max(0, Math.floor(params.stripComponents ?? 0)),
						gzip: params.tarGzip,
						preservePaths: false,
						strict: true,
						onReadEntry(entry) {
							try {
								checkTarEntrySafety(readTarEntryInfo(entry));
							} catch (err) {
								const error = err instanceof Error ? err : new Error(String(err));
								this.abort?.(error);
							}
						}
					});
					await mergeExtractedTreeIntoDestination({
						sourceDir: stagingDir,
						destinationDir: destinationRealDir,
						destinationRealDir
					});
				}
			});
		})(), params.timeoutMs, label);
		return;
	}
	await withTimeout(extractZip({
		archivePath: params.archivePath,
		destDir: params.destDir,
		stripComponents: params.stripComponents,
		limits: params.limits
	}), params.timeoutMs, label);
}
async function fileExists(filePath) {
	try {
		await fs$1.stat(filePath);
		return true;
	} catch {
		return false;
	}
}
async function readJsonFile(filePath) {
	const raw = await fs$1.readFile(filePath, "utf-8");
	return JSON.parse(raw);
}
//#endregion
//#region src/infra/install-safe-path.ts
function unscopedPackageName(name) {
	const trimmed = name.trim();
	if (!trimmed) return trimmed;
	return trimmed.includes("/") ? trimmed.split("/").pop() ?? trimmed : trimmed;
}
function safeDirName(input) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	return trimmed.replaceAll("/", "__").replaceAll("\\", "__");
}
function safePathSegmentHashed(input) {
	const trimmed = input.trim();
	const base = trimmed.replaceAll(/[\\/]/g, "-").replaceAll(/[^a-zA-Z0-9._-]/g, "-").replaceAll(/-+/g, "-").replaceAll(/^-+/g, "").replaceAll(/-+$/g, "");
	const normalized = base.length > 0 ? base : "skill";
	const safe = normalized === "." || normalized === ".." ? "skill" : normalized;
	const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 10);
	if (safe !== trimmed) return `${safe.length > 50 ? safe.slice(0, 50) : safe}-${hash}`;
	if (safe.length > 60) return `${safe.slice(0, 50)}-${hash}`;
	return safe;
}
function resolveSafeInstallDir(params) {
	const targetDir = path.join(params.baseDir, safeDirName(params.id));
	const resolvedBase = path.resolve(params.baseDir);
	const resolvedTarget = path.resolve(targetDir);
	const relative = path.relative(resolvedBase, resolvedTarget);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return {
		ok: false,
		error: params.invalidNameMessage
	};
	return {
		ok: true,
		path: targetDir
	};
}
async function assertCanonicalPathWithinBase(params) {
	const baseDir = path.resolve(params.baseDir);
	const candidatePath = path.resolve(params.candidatePath);
	if (!isPathInside(baseDir, candidatePath)) throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
	const baseLstat = await fs$1.lstat(baseDir);
	if (!baseLstat.isDirectory() || baseLstat.isSymbolicLink()) throw new Error(`Invalid ${params.boundaryLabel}: base directory must be a real directory`);
	const baseRealPath = await fs$1.realpath(baseDir);
	const validateDirectory = async (dirPath) => {
		const dirLstat = await fs$1.lstat(dirPath);
		if (!dirLstat.isDirectory() || dirLstat.isSymbolicLink()) throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
		if (!isPathInside(baseRealPath, await fs$1.realpath(dirPath))) throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
	};
	try {
		await validateDirectory(candidatePath);
		return;
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	await validateDirectory(path.dirname(candidatePath));
}
//#endregion
export { unscopedPackageName as a, fileExists as c, resolvePackedRootDir as d, mergeExtractedTreeIntoDestination as f, isWindowsDrivePath as h, safePathSegmentHashed as i, readJsonFile as l, withStagedArchiveDestination as m, resolveSafeInstallDir as n, createTarEntryPreflightChecker as o, prepareArchiveDestinationDir as p, safeDirName as r, extractArchive as s, assertCanonicalPathWithinBase as t, resolveArchiveKind as u };
