import { i as isPathInside, l as resolveSafeBaseDir, p as FsSafeError, r as isNotFoundPathError } from "./path-B5B-_oAT.js";
import { t as normalizeLowercaseStringOrEmpty } from "./string-coerce-Cx5273Cj.js";
import { c as assertAsyncDirectoryGuard, u as createAsyncDirectoryGuard } from "./write-queue-BKRKUV0w.js";
import { c as writeSiblingTempFile, u as withTimeout } from "./fs-safe-DpJlqO1z.js";
import { a as resolveOpenedFileRealPathForHandle, o as root, s as getFsSafeTestHooks, t as resolveSecureTempRoot } from "./secure-temp-dir-GC3bO7Qi.js";
import fs, { constants } from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
//#region node_modules/@openclaw/fs-safe/dist/archive-entry.js
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
//#region node_modules/@openclaw/fs-safe/dist/archive-limits.js
const DEFAULT_MAX_ARCHIVE_BYTES_ZIP = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 5e4;
const DEFAULT_MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const ARCHIVE_LIMIT_ERROR_CODE = {
	ARCHIVE_SIZE_EXCEEDS_LIMIT: "archive-size-exceeds-limit",
	ENTRY_COUNT_EXCEEDS_LIMIT: "archive-entry-count-exceeds-limit",
	ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-entry-extracted-size-exceeds-limit",
	EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-extracted-size-exceeds-limit"
};
const ARCHIVE_LIMIT_ERROR_MESSAGE = {
	[ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT]: "archive size exceeds limit",
	[ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT]: "archive entry count exceeds limit",
	[ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT]: "archive entry extracted size exceeds limit",
	[ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT]: "archive extracted size exceeds limit"
};
var ArchiveLimitError = class extends Error {
	code;
	constructor(code) {
		super(ARCHIVE_LIMIT_ERROR_MESSAGE[code]);
		this.name = "ArchiveLimitError";
		this.code = code;
	}
};
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
	if (entryCount > limits.maxEntries) throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT);
}
function createByteBudgetTracker(limits) {
	let entryBytes = 0;
	let extractedBytes = 0;
	const addBytes = (bytes) => {
		const b = Math.max(0, Math.floor(bytes));
		if (b === 0) return;
		entryBytes += b;
		if (entryBytes > limits.maxEntryBytes) throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
		extractedBytes += b;
		if (extractedBytes > limits.maxExtractedBytes) throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT);
	};
	return {
		startEntry() {
			entryBytes = 0;
		},
		addBytes,
		addEntrySize(size) {
			const s = Math.max(0, Math.floor(size));
			if (s > limits.maxEntryBytes) throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
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
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/archive-kind.js
const TAR_SUFFIXES = [
	".tgz",
	".tar.gz",
	".tar"
];
function resolveArchiveKind(filePath) {
	const lower = normalizeLowercaseStringOrEmpty(filePath);
	if (lower.endsWith(".zip")) return "zip";
	if (TAR_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return "tar";
	return null;
}
async function hasPackedRootMarker(extractDir, rootMarkers) {
	for (const marker of rootMarkers) {
		const trimmed = marker.trim();
		if (!trimmed) continue;
		try {
			await fs$1.stat(path.join(extractDir, trimmed));
			return true;
		} catch {}
	}
	return false;
}
async function resolvePackedRootDir(extractDir, options) {
	const direct = path.join(extractDir, "package");
	try {
		if ((await fs$1.stat(direct)).isDirectory()) return direct;
	} catch {}
	if ((options?.rootMarkers?.length ?? 0) > 0) {
		if (await hasPackedRootMarker(extractDir, options?.rootMarkers ?? [])) return extractDir;
	}
	const dirs = (await fs$1.readdir(extractDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	if (dirs.length !== 1) throw new Error(`unexpected archive layout (dirs: ${dirs.join(", ")})`);
	const onlyDir = dirs[0];
	if (!onlyDir) throw new Error("unexpected archive layout (no package dir found)");
	return path.join(extractDir, onlyDir);
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/archive-staging.js
const ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK = "archive entry traverses symlink in destination";
const ARCHIVE_STAGING_MODE = 448;
var ArchiveSecurityError = class extends Error {
	code;
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
		this.name = "ArchiveSecurityError";
	}
};
function symlinkTraversalError(originalPath) {
	return new ArchiveSecurityError("destination-symlink-traversal", `${ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK}: ${originalPath}`);
}
async function createDirectoryIdentityGuard(dir) {
	try {
		return await createAsyncDirectoryGuard(dir);
	} catch (err) {
		if (err instanceof FsSafeError && err.code === "not-file") throw new ArchiveSecurityError("destination-symlink", "archive destination is a symlink");
		throw err;
	}
}
async function assertDirectoryIdentityGuard(guard) {
	try {
		await assertAsyncDirectoryGuard(guard);
	} catch (err) {
		if (err instanceof FsSafeError) throw new ArchiveSecurityError("destination-symlink-traversal", "archive destination changed during extraction");
		throw err;
	}
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
		if (stat.isSymbolicLink()) throw symlinkTraversalError(params.originalPath);
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
	if (!isPathInside(params.destinationRealDir, resolved)) throw symlinkTraversalError(params.originalPath);
}
async function prepareArchiveOutputPath(params) {
	const targetRoot = await root(params.destinationRealDir);
	const destinationGuard = await createDirectoryIdentityGuard(params.destinationRealDir);
	const relPath = params.relPath.split(path.sep).join(path.posix.sep);
	await assertNoSymlinkTraversal({
		rootDir: params.destinationDir,
		relPath,
		originalPath: params.originalPath
	});
	if (params.isDirectory) {
		await getFsSafeTestHooks()?.beforeArchiveOutputMutation?.("mkdir", params.outPath);
		await assertDirectoryIdentityGuard(destinationGuard);
		await targetRoot.mkdir(relPath);
		await assertDirectoryIdentityGuard(destinationGuard);
		await assertResolvedInsideDestination({
			destinationRealDir: params.destinationRealDir,
			targetPath: params.outPath,
			originalPath: params.originalPath
		});
		return;
	}
	const parentRel = path.posix.dirname(relPath);
	if (parentRel !== ".") {
		await getFsSafeTestHooks()?.beforeArchiveOutputMutation?.("mkdir", path.dirname(params.outPath));
		await assertDirectoryIdentityGuard(destinationGuard);
		await targetRoot.mkdir(parentRel);
		await assertDirectoryIdentityGuard(destinationGuard);
	}
	await assertResolvedInsideDestination({
		destinationRealDir: params.destinationRealDir,
		targetPath: path.dirname(params.outPath),
		originalPath: params.originalPath
	});
}
async function chmodInsideDestinationBestEffort(params) {
	await getFsSafeTestHooks()?.beforeArchiveOutputMutation?.("chmod", params.destinationPath);
	const destinationGuard = await createDirectoryIdentityGuard(params.destinationRealDir);
	await assertDirectoryIdentityGuard(destinationGuard);
	const noFollowFlag = process.platform !== "win32" && "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
	const handle = await fs$1.open(params.destinationPath, fs.constants.O_RDONLY | noFollowFlag).catch(() => null);
	if (!handle) {
		if ((await fs$1.lstat(params.destinationPath).catch(() => null))?.isSymbolicLink()) throw symlinkTraversalError(params.originalPath);
		return;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isDirectory() && !stat.isFile()) return;
		const realPath = await resolveOpenedFileRealPathForHandle(handle, params.destinationPath);
		if (!isPathInside(params.destinationRealDir, realPath)) throw symlinkTraversalError(params.originalPath);
		await handle.chmod(params.mode).catch(() => void 0);
		await assertDirectoryIdentityGuard(destinationGuard);
	} finally {
		await handle.close().catch(() => void 0);
	}
}
async function applyStagedEntryMode(params) {
	const destinationPath = path.join(params.destinationRealDir, params.relPath);
	await assertResolvedInsideDestination({
		destinationRealDir: params.destinationRealDir,
		targetPath: destinationPath,
		originalPath: params.originalPath
	});
	if (params.mode !== 0) await chmodInsideDestinationBestEffort({
		destinationRealDir: params.destinationRealDir,
		destinationPath,
		mode: params.mode,
		originalPath: params.originalPath
	});
}
async function assertExtractedFileHasNoHardlinkAlias(params) {
	const destinationPath = path.join(params.destinationRealDir, params.relPath);
	await assertResolvedInsideDestination({
		destinationRealDir: params.destinationRealDir,
		targetPath: destinationPath,
		originalPath: params.originalPath
	});
	const stat = await fs$1.lstat(destinationPath);
	if (stat.isFile() && stat.nlink > 1) throw symlinkTraversalError(params.originalPath);
}
async function removeExtractedDestinationFile(params) {
	const destinationPath = path.join(params.destinationRealDir, params.relPath);
	let resolved;
	try {
		resolved = await fs$1.realpath(destinationPath);
	} catch {
		return;
	}
	if (!isPathInside(params.destinationRealDir, resolved)) return;
	await fs$1.rm(destinationPath, { force: true }).catch(() => void 0);
}
async function withStagedArchiveDestination(params) {
	const stagingRoot = resolveSecureTempRoot({
		fallbackPrefix: "fs-safe-archive",
		unsafeFallbackLabel: "archive staging temp dir",
		warn: () => void 0
	});
	if (isPathInside(params.destinationRealDir, stagingRoot)) throw new Error(`archive staging root must be outside destination: ${stagingRoot}`);
	const stagingDir = await fs$1.mkdtemp(path.join(stagingRoot, params.stagingDirPrefix ?? "fs-safe-archive-"));
	try {
		await fs$1.chmod(stagingDir, ARCHIVE_STAGING_MODE).catch(() => void 0);
		return await params.run(stagingDir);
	} finally {
		await fs$1.rm(stagingDir, {
			recursive: true,
			force: true
		}).catch(() => void 0);
	}
}
async function mergeExtractedTreeIntoDestination(params) {
	const targetRoot = await root(params.destinationRealDir);
	const walk = async (currentSourceDir) => {
		const entries = await fs$1.readdir(currentSourceDir, { withFileTypes: true });
		for (const entry of entries) {
			const sourcePath = path.join(currentSourceDir, entry.name);
			const relPath = path.relative(params.sourceDir, sourcePath);
			const originalPath = relPath.split(path.sep).join("/");
			const destinationPath = path.join(params.destinationDir, relPath);
			const sourceStat = await fs$1.lstat(sourcePath);
			if (sourceStat.isSymbolicLink()) throw symlinkTraversalError(originalPath);
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
			try {
				await targetRoot.copyIn(relPath, sourcePath, { mkdir: true });
				await assertExtractedFileHasNoHardlinkAlias({
					destinationRealDir: params.destinationRealDir,
					relPath,
					originalPath
				});
				await applyStagedEntryMode({
					destinationRealDir: params.destinationRealDir,
					relPath,
					mode: sourceStat.mode & 511,
					originalPath
				});
			} catch (err) {
				await removeExtractedDestinationFile({
					destinationRealDir: params.destinationRealDir,
					relPath
				});
				if (err instanceof FsSafeError && (err.code === "hardlink" || err.code === "path-alias")) throw symlinkTraversalError(originalPath);
				throw err;
			}
		}
	};
	await walk(params.sourceDir);
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/archive-tar.js
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
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/archive-zip-preflight.js
const ZIP_EOCD_SIGNATURE = 101010256;
const ZIP64_EOCD_SIGNATURE = 101075792;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 117853008;
const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_EOCD_MAX_COMMENT_BYTES = 65535;
const ZIP64_ENTRY_COUNT_SENTINEL = 65535;
const ZIP64_UINT32_SENTINEL = 4294967295;
const ZIP_CENTRAL_FILE_HEADER_SIGNATURE = 33639248;
const ZIP_CENTRAL_FILE_HEADER_MIN_BYTES = 46;
const ZIP_CENTRAL_FILE_HEADER_NAME_LENGTH_OFFSET = 28;
const ZIP_CENTRAL_FILE_HEADER_EXTRA_LENGTH_OFFSET = 30;
const ZIP_CENTRAL_FILE_HEADER_COMMENT_LENGTH_OFFSET = 32;
const ZIP_EOCD_TOTAL_ENTRIES_OFFSET = 10;
const ZIP_EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET = 12;
const ZIP_EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET = 16;
const ZIP_EOCD_COMMENT_LENGTH_OFFSET = 20;
const ZIP64_EOCD_LOCATOR_BYTES = 20;
const ZIP64_EOCD_OFFSET_OFFSET = 8;
const ZIP64_EOCD_TOTAL_ENTRIES_OFFSET = 32;
const ZIP64_EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET = 40;
const ZIP64_EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET = 48;
function asBufferView(buffer) {
	if (Buffer.isBuffer(buffer)) return buffer;
	return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
function readSafeUInt64LE(buffer, offset) {
	const value = buffer.readBigUInt64LE(offset);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
	return Number(value);
}
function findZipEndOfCentralDirectory(buffer) {
	if (buffer.byteLength < ZIP_EOCD_MIN_BYTES) return -1;
	const minOffset = Math.max(0, buffer.byteLength - ZIP_EOCD_MIN_BYTES - ZIP_EOCD_MAX_COMMENT_BYTES);
	for (let offset = buffer.byteLength - ZIP_EOCD_MIN_BYTES; offset >= minOffset; offset -= 1) {
		if (buffer.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue;
		const commentLength = buffer.readUInt16LE(offset + ZIP_EOCD_COMMENT_LENGTH_OFFSET);
		if (offset + ZIP_EOCD_MIN_BYTES + commentLength === buffer.byteLength) return offset;
	}
	return -1;
}
function readZip64CentralDirectoryInfo(buffer, eocdOffset) {
	const locatorOffset = eocdOffset - ZIP64_EOCD_LOCATOR_BYTES;
	if (locatorOffset < 0 || buffer.readUInt32LE(locatorOffset) !== ZIP64_EOCD_LOCATOR_SIGNATURE) return null;
	const zip64EocdOffset = readSafeUInt64LE(buffer, locatorOffset + ZIP64_EOCD_OFFSET_OFFSET);
	if (zip64EocdOffset < 0 || zip64EocdOffset + ZIP64_EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET + 8 > buffer.byteLength || buffer.readUInt32LE(zip64EocdOffset) !== ZIP64_EOCD_SIGNATURE) return null;
	return {
		declaredEntryCount: readSafeUInt64LE(buffer, zip64EocdOffset + ZIP64_EOCD_TOTAL_ENTRIES_OFFSET),
		centralDirectorySize: readSafeUInt64LE(buffer, zip64EocdOffset + ZIP64_EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET),
		centralDirectoryOffset: readSafeUInt64LE(buffer, zip64EocdOffset + ZIP64_EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET),
		endOfCentralDirectoryOffset: eocdOffset
	};
}
function readZipCentralDirectoryInfo(buffer) {
	const eocdOffset = findZipEndOfCentralDirectory(buffer);
	if (eocdOffset < 0) return null;
	const declaredEntryCount = buffer.readUInt16LE(eocdOffset + ZIP_EOCD_TOTAL_ENTRIES_OFFSET);
	const centralDirectorySize = buffer.readUInt32LE(eocdOffset + ZIP_EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET);
	const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + ZIP_EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET);
	if (declaredEntryCount === ZIP64_ENTRY_COUNT_SENTINEL || centralDirectorySize === ZIP64_UINT32_SENTINEL || centralDirectoryOffset === ZIP64_UINT32_SENTINEL) return readZip64CentralDirectoryInfo(buffer, eocdOffset) ?? {
		declaredEntryCount,
		centralDirectoryOffset,
		centralDirectorySize,
		endOfCentralDirectoryOffset: eocdOffset
	};
	return {
		declaredEntryCount,
		centralDirectoryOffset,
		centralDirectorySize,
		endOfCentralDirectoryOffset: eocdOffset
	};
}
function countZipCentralDirectoryHeaders(buffer, info) {
	const start = info.centralDirectoryOffset;
	const declaredEnd = start + info.centralDirectorySize;
	const scanEnd = info.endOfCentralDirectoryOffset;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(declaredEnd) || !Number.isSafeInteger(scanEnd) || start < 0 || declaredEnd < start || scanEnd < start || scanEnd > buffer.byteLength) return null;
	let offset = start;
	let count = 0;
	while (offset < scanEnd) {
		if (scanEnd - offset < ZIP_CENTRAL_FILE_HEADER_MIN_BYTES) break;
		if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_FILE_HEADER_SIGNATURE) break;
		const nameLength = buffer.readUInt16LE(offset + ZIP_CENTRAL_FILE_HEADER_NAME_LENGTH_OFFSET);
		const extraLength = buffer.readUInt16LE(offset + ZIP_CENTRAL_FILE_HEADER_EXTRA_LENGTH_OFFSET);
		const commentLength = buffer.readUInt16LE(offset + ZIP_CENTRAL_FILE_HEADER_COMMENT_LENGTH_OFFSET);
		const nextOffset = offset + ZIP_CENTRAL_FILE_HEADER_MIN_BYTES + nameLength + extraLength + commentLength;
		if (nextOffset <= offset || nextOffset > scanEnd) return null;
		count += 1;
		offset = nextOffset;
	}
	return count > 0 || info.declaredEntryCount === 0 ? count : null;
}
function readZipCentralDirectoryEntryCount(buffer) {
	const view = asBufferView(buffer);
	const info = readZipCentralDirectoryInfo(view);
	if (!info) return null;
	const countedEntryCount = countZipCentralDirectoryHeaders(view, info);
	return countedEntryCount === null ? info.declaredEntryCount : Math.max(info.declaredEntryCount, countedEntryCount);
}
async function loadZipArchiveWithPreflight(buffer, limits) {
	const resolvedLimits = resolveExtractLimits(limits);
	if (buffer.byteLength > resolvedLimits.maxArchiveBytes) throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
	const entryCount = readZipCentralDirectoryEntryCount(buffer);
	if (entryCount !== null) assertArchiveEntryCountWithinLimit(entryCount, resolvedLimits);
	return await (await importOptionalJsZip()).loadAsync(buffer);
}
async function importOptionalJsZip() {
	try {
		const module = await import("jszip");
		const candidate = typeof module === "function" ? module : module.default;
		if (typeof candidate !== "object" && typeof candidate !== "function" || candidate === null || typeof candidate.loadAsync !== "function") throw new Error("Optional archive dependency \"jszip\" does not expose loadAsync().");
		return candidate;
	} catch (err) {
		throw missingOptionalArchiveDependencyError$1("jszip", err);
	}
}
function missingOptionalArchiveDependencyError$1(packageName, cause) {
	return new Error(`Optional archive dependency "${packageName}" is not installed. Install it to use ZIP archive helpers from @openclaw/fs-safe/archive.`, { cause });
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/archive.js
const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in constants;
const OPEN_WRITE_CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const ZIP_UNIX_FILE_TYPE_MASK = 61440;
const ZIP_UNIX_SYMLINK_TYPE = 40960;
function isZipSymlinkEntry(entry) {
	return typeof entry.unixPermissions === "number" && (entry.unixPermissions & ZIP_UNIX_FILE_TYPE_MASK) === ZIP_UNIX_SYMLINK_TYPE;
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
	params.budget.startEntry();
	const readable = await readZipEntryStream(params.entry);
	const destinationPath = params.outPath;
	let tempHandle = null;
	let handleClosedByStream = false;
	try {
		await writeSiblingTempFile({
			dir: path.dirname(destinationPath),
			tempPrefix: `.${path.basename(destinationPath)}.fs-safe-archive`,
			chmodDir: false,
			writeTemp: async (tempPath) => {
				tempHandle = await fs$1.open(tempPath, OPEN_WRITE_CREATE_FLAGS, 438);
				const writable = tempHandle.createWriteStream();
				writable.once("close", () => {
					handleClosedByStream = true;
				});
				await pipeline(readable, createExtractBudgetTransform({ onChunkBytes: params.budget.addBytes }), writable);
				if (!handleClosedByStream) {
					await tempHandle.close().catch(() => void 0);
					handleClosedByStream = true;
				}
				tempHandle = null;
				return destinationPath;
			},
			resolveFinalPath: (filePath) => filePath
		});
		if (typeof params.entry.unixPermissions === "number") {
			const mode = params.entry.unixPermissions & 511;
			if (mode !== 0) await fs$1.chmod(destinationPath, mode).catch(() => void 0);
		}
	} catch (err) {
		throw err;
	} finally {
		const openTempHandle = tempHandle;
		if (openTempHandle && !handleClosedByStream) await openTempHandle.close().catch(() => void 0);
	}
}
async function extractZip(params) {
	const limits = resolveExtractLimits(params.limits);
	const destinationRealDir = await prepareArchiveDestinationDir(params.destDir);
	if ((await fs$1.stat(params.archivePath)).size > limits.maxArchiveBytes) throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
	const zip = await loadZipArchiveWithPreflight(await fs$1.readFile(params.archivePath), limits);
	const entries = Object.values(zip.files);
	const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
	assertArchiveEntryCountWithinLimit(entries.length, limits);
	const budget = createByteBudgetTracker(limits);
	await withStagedArchiveDestination({
		destinationRealDir,
		run: async (stagingDir) => {
			const stagingRealDir = await fs$1.realpath(stagingDir);
			for (const entry of entries) {
				const output = resolveZipOutputPath({
					entryPath: entry.name,
					strip,
					destinationDir: stagingRealDir
				});
				if (!output) continue;
				await prepareZipOutputPath({
					destinationDir: stagingRealDir,
					destinationRealDir: stagingRealDir,
					relPath: output.relPath,
					outPath: output.outPath,
					originalPath: entry.name,
					isDirectory: entry.dir
				});
				if (entry.dir) continue;
				if (isZipSymlinkEntry(entry)) throw new Error(`zip entry is a link: ${entry.name}`);
				await writeZipFileEntry({
					entry,
					outPath: output.outPath,
					budget
				});
			}
			await mergeExtractedTreeIntoDestination({
				sourceDir: stagingRealDir,
				destinationDir: params.destDir,
				destinationRealDir
			});
		}
	});
}
async function extractArchive(params) {
	const kind = params.kind ?? resolveArchiveKind(params.archivePath);
	if (!kind) throw new Error(`unsupported archive: ${params.archivePath}`);
	const label = kind === "zip" ? "extract zip" : "extract tar";
	if (kind === "tar") {
		await withTimeout((async () => {
			const tar = await importOptionalTar();
			const limits = resolveExtractLimits(params.limits);
			if ((await fs$1.stat(params.archivePath)).size > limits.maxArchiveBytes) throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
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
						destinationDir: params.destDir,
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
async function importOptionalTar() {
	try {
		return await import("tar");
	} catch (err) {
		throw missingOptionalArchiveDependencyError("tar", err);
	}
}
function missingOptionalArchiveDependencyError(packageName, cause) {
	return new Error(`Optional archive dependency "${packageName}" is not installed. Install it to use TAR archive helpers from @openclaw/fs-safe/archive.`, { cause });
}
//#endregion
export { prepareArchiveDestinationDir as a, resolvePackedRootDir as c, DEFAULT_MAX_ARCHIVE_BYTES_ZIP as d, DEFAULT_MAX_ENTRIES as f, isWindowsDrivePath as h, mergeExtractedTreeIntoDestination as i, ARCHIVE_LIMIT_ERROR_CODE as l, DEFAULT_MAX_EXTRACTED_BYTES as m, loadZipArchiveWithPreflight as n, withStagedArchiveDestination as o, DEFAULT_MAX_ENTRY_BYTES as p, createTarEntryPreflightChecker as r, resolveArchiveKind as s, extractArchive as t, ArchiveLimitError as u };
