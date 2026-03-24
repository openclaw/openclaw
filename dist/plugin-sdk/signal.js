import "./github-copilot-token-ClyulAWr.js";
import { Q as SafeOpenError, Tn as normalizeAccountId, Xt as runCommandWithTimeout, an as sameFileIdentity, cn as isPathInside, et as copyFileWithinRoot, nt as openFileWithinRoot, rt as openWritableFileWithinRoot, sn as isNotFoundPathError, wn as DEFAULT_ACCOUNT_ID } from "./query-expansion-DzvS3RFU.js";
import { Ai as normalizeSignalMessagingTarget, Ei as resolveDefaultGroupPolicy, Fi as formatPairingApproveHint, Ii as formatCliCommand, Li as deleteAccountFromConfigSection, Mi as resolveDefaultSignalAccountId, Ni as resolveSignalAccount, Pi as getChatChannelMeta, Ri as setAccountEnabledInConfigSection, Ti as resolveAllowlistProviderRuntimeGroupPolicy, a as SignalConfigSchema, g as formatDocsLink, ji as listSignalAccountIds, ki as looksLikeSignalTargetId, nn as resolveChannelMediaMaxBytes, t as detectBinary } from "./onboard-helpers-DpwFb1Tp.js";
import { a as CONFIG_DIR, h as normalizeE164 } from "./logger-_x5WOezH.js";
import "./paths-D6tDENa_.js";
import "./fetch-BF0xn7kd.js";
import { z } from "zod";
import path from "node:path";
import fs, { constants, createWriteStream } from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import fs$1 from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { request } from "node:https";
import { Readable, Transform } from "node:stream";
import JSZip from "jszip";
import * as tar from "tar";
//#region src/plugins/config-schema.ts
function error(message) {
	return {
		success: false,
		error: { issues: [{
			path: [],
			message
		}] }
	};
}
function emptyPluginConfigSchema() {
	return {
		safeParse(value) {
			if (value === void 0) return {
				success: true,
				data: void 0
			};
			if (!value || typeof value !== "object" || Array.isArray(value)) return error("expected config object");
			if (Object.keys(value).length > 0) return error("config must be empty");
			return {
				success: true,
				data: value
			};
		},
		jsonSchema: {
			type: "object",
			additionalProperties: false,
			properties: {}
		}
	};
}
//#endregion
//#region src/channels/plugins/setup-helpers.ts
function channelHasAccounts(cfg, channelKey) {
	const base = cfg.channels?.[channelKey];
	return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}
function shouldStoreNameInAccounts(params) {
	if (params.alwaysUseAccounts) return true;
	if (params.accountId !== "default") return true;
	return channelHasAccounts(params.cfg, params.channelKey);
}
function applyAccountNameToChannelSection(params) {
	const trimmed = params.name?.trim();
	if (!trimmed) return params.cfg;
	const accountId = normalizeAccountId(params.accountId);
	const baseConfig = params.cfg.channels?.[params.channelKey];
	const base = typeof baseConfig === "object" && baseConfig ? baseConfig : void 0;
	if (!shouldStoreNameInAccounts({
		cfg: params.cfg,
		channelKey: params.channelKey,
		accountId,
		alwaysUseAccounts: params.alwaysUseAccounts
	}) && accountId === "default") {
		const safeBase = base ?? {};
		return {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				[params.channelKey]: {
					...safeBase,
					name: trimmed
				}
			}
		};
	}
	const baseAccounts = base?.accounts ?? {};
	const existingAccount = baseAccounts[accountId] ?? {};
	const baseWithoutName = accountId === "default" ? (({ name: _ignored, ...rest }) => rest)(base ?? {}) : base ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...baseWithoutName,
				accounts: {
					...baseAccounts,
					[accountId]: {
						...existingAccount,
						name: trimmed
					}
				}
			}
		}
	};
}
function migrateBaseNameToDefaultAccount(params) {
	if (params.alwaysUseAccounts) return params.cfg;
	const base = params.cfg.channels?.[params.channelKey];
	const baseName = base?.name?.trim();
	if (!baseName) return params.cfg;
	const accounts = { ...base?.accounts };
	const defaultAccount = accounts["default"] ?? {};
	if (!defaultAccount.name) accounts[DEFAULT_ACCOUNT_ID] = {
		...defaultAccount,
		name: baseName
	};
	const { name: _ignored, ...rest } = base ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...rest,
				accounts
			}
		}
	};
}
function patchScopedAccountConfig(params) {
	const accountId = normalizeAccountId(params.accountId);
	const channelConfig = params.cfg.channels?.[params.channelKey];
	const base = typeof channelConfig === "object" && channelConfig ? channelConfig : void 0;
	const ensureChannelEnabled = params.ensureChannelEnabled ?? true;
	const ensureAccountEnabled = params.ensureAccountEnabled ?? ensureChannelEnabled;
	const patch = params.patch;
	const accountPatch = params.accountPatch ?? patch;
	if (accountId === "default") return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...base,
				...ensureChannelEnabled ? { enabled: true } : {},
				...patch
			}
		}
	};
	const accounts = base?.accounts ?? {};
	const existingAccount = accounts[accountId] ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...base,
				...ensureChannelEnabled ? { enabled: true } : {},
				accounts: {
					...accounts,
					[accountId]: {
						...existingAccount,
						...ensureAccountEnabled ? { enabled: typeof existingAccount.enabled === "boolean" ? existingAccount.enabled : true } : {},
						...accountPatch
					}
				}
			}
		}
	};
}
const COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE = new Set([
	"name",
	"token",
	"tokenFile",
	"botToken",
	"appToken",
	"account",
	"signalNumber",
	"authDir",
	"cliPath",
	"dbPath",
	"httpUrl",
	"httpHost",
	"httpPort",
	"webhookPath",
	"webhookUrl",
	"webhookSecret",
	"service",
	"region",
	"homeserver",
	"userId",
	"accessToken",
	"password",
	"deviceName",
	"url",
	"code",
	"dmPolicy",
	"allowFrom",
	"groupPolicy",
	"groupAllowFrom",
	"defaultTo"
]);
const SINGLE_ACCOUNT_KEYS_TO_MOVE_BY_CHANNEL = { telegram: new Set(["streaming"]) };
function shouldMoveSingleAccountChannelKey(params) {
	if (COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE.has(params.key)) return true;
	return SINGLE_ACCOUNT_KEYS_TO_MOVE_BY_CHANNEL[params.channelKey]?.has(params.key) ?? false;
}
function cloneIfObject(value) {
	if (value && typeof value === "object") return structuredClone(value);
	return value;
}
function moveSingleAccountChannelSectionToDefaultAccount(params) {
	const baseConfig = params.cfg.channels?.[params.channelKey];
	const base = typeof baseConfig === "object" && baseConfig ? baseConfig : void 0;
	if (!base) return params.cfg;
	const accounts = base.accounts ?? {};
	if (Object.keys(accounts).length > 0) return params.cfg;
	const keysToMove = Object.entries(base).filter(([key, value]) => key !== "accounts" && key !== "enabled" && value !== void 0 && shouldMoveSingleAccountChannelKey({
		channelKey: params.channelKey,
		key
	})).map(([key]) => key);
	const defaultAccount = {};
	for (const key of keysToMove) {
		const value = base[key];
		defaultAccount[key] = cloneIfObject(value);
	}
	const nextChannel = { ...base };
	for (const key of keysToMove) delete nextChannel[key];
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...nextChannel,
				accounts: {
					...accounts,
					[DEFAULT_ACCOUNT_ID]: defaultAccount
				}
			}
		}
	};
}
//#endregion
//#region src/channels/plugins/config-schema.ts
const AllowFromEntrySchema = z.union([z.string(), z.number()]);
z.array(AllowFromEntrySchema).optional();
function buildChannelConfigSchema(schema) {
	const schemaWithJson = schema;
	if (typeof schemaWithJson.toJSONSchema === "function") return { schema: schemaWithJson.toJSONSchema({
		target: "draft-07",
		unrepresentable: "any"
	}) };
	return { schema: {
		type: "object",
		additionalProperties: true
	} };
}
//#endregion
//#region src/channels/plugins/pairing-message.ts
const PAIRING_APPROVED_MESSAGE = "✅ OpenClaw access approved. Send a message to start chatting.";
//#endregion
//#region src/infra/path-safety.ts
function resolveSafeBaseDir(rootDir) {
	const resolved = path.resolve(rootDir);
	return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}
//#endregion
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
//#endregion
//#region src/infra/brew.ts
function isExecutable(filePath) {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
function normalizePathValue(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function resolveBrewExecutable(opts) {
	const homeDir = opts?.homeDir ?? os.homedir();
	const env = opts?.env ?? process.env;
	const candidates = [];
	const brewFile = normalizePathValue(env.HOMEBREW_BREW_FILE);
	if (brewFile) candidates.push(brewFile);
	const prefix = normalizePathValue(env.HOMEBREW_PREFIX);
	if (prefix) candidates.push(path.join(prefix, "bin", "brew"));
	candidates.push(path.join(homeDir, ".linuxbrew", "bin", "brew"));
	candidates.push("/home/linuxbrew/.linuxbrew/bin/brew");
	candidates.push("/opt/homebrew/bin/brew", "/usr/local/bin/brew");
	for (const candidate of candidates) if (isExecutable(candidate)) return candidate;
}
//#endregion
//#region src/commands/signal-install.ts
/** @internal Exported for testing. */
async function extractSignalCliArchive(archivePath, installRoot, timeoutMs) {
	await extractArchive({
		archivePath,
		destDir: installRoot,
		timeoutMs
	});
}
/** @internal Exported for testing. */
function looksLikeArchive(name) {
	return name.endsWith(".tar.gz") || name.endsWith(".tgz") || name.endsWith(".zip");
}
/**
* Pick a native release asset from the official GitHub releases.
*
* The official signal-cli releases only publish native (GraalVM) binaries for
* x86-64 Linux.  On architectures where no native asset is available this
* returns `undefined` so the caller can fall back to a different install
* strategy (e.g. Homebrew).
*/
/** @internal Exported for testing. */
function pickAsset(assets, platform, arch) {
	const archives = assets.filter((asset) => Boolean(asset.name && asset.browser_download_url)).filter((a) => looksLikeArchive(a.name.toLowerCase()));
	const byName = (pattern) => archives.find((asset) => pattern.test(asset.name.toLowerCase()));
	if (platform === "linux") {
		if (arch === "x64") return byName(/linux-native/) || byName(/linux/) || archives[0];
		return;
	}
	if (platform === "darwin") return byName(/macos|osx|darwin/) || archives[0];
	if (platform === "win32") return byName(/windows|win/) || archives[0];
	return archives[0];
}
async function downloadToFile(url, dest, maxRedirects = 5) {
	await new Promise((resolve, reject) => {
		const req = request(url, (res) => {
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
				const location = res.headers.location;
				if (!location || maxRedirects <= 0) {
					reject(/* @__PURE__ */ new Error("Redirect loop or missing Location header"));
					return;
				}
				const redirectUrl = new URL(location, url).href;
				resolve(downloadToFile(redirectUrl, dest, maxRedirects - 1));
				return;
			}
			if (!res.statusCode || res.statusCode >= 400) {
				reject(/* @__PURE__ */ new Error(`HTTP ${res.statusCode ?? "?"} downloading file`));
				return;
			}
			pipeline(res, createWriteStream(dest)).then(resolve).catch(reject);
		});
		req.on("error", reject);
		req.end();
	});
}
async function findSignalCliBinary(root) {
	const candidates = [];
	const enqueue = async (dir, depth) => {
		if (depth > 3) return;
		const entries = await fs$1.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await enqueue(full, depth + 1);
			else if (entry.isFile() && entry.name === "signal-cli") candidates.push(full);
		}
	};
	await enqueue(root, 0);
	return candidates[0] ?? null;
}
async function resolveBrewSignalCliPath(brewExe) {
	try {
		const result = await runCommandWithTimeout([
			brewExe,
			"--prefix",
			"signal-cli"
		], { timeoutMs: 1e4 });
		if (result.code === 0 && result.stdout.trim()) {
			const prefix = result.stdout.trim();
			const candidate = path.join(prefix, "bin", "signal-cli");
			try {
				await fs$1.access(candidate);
				return candidate;
			} catch {
				return findSignalCliBinary(prefix);
			}
		}
	} catch {}
	return null;
}
async function installSignalCliViaBrew(runtime) {
	const brewExe = resolveBrewExecutable();
	if (!brewExe) return {
		ok: false,
		error: `No native signal-cli build is available for ${process.arch}. Install Homebrew (https://brew.sh) and try again, or install signal-cli manually.`
	};
	runtime.log(`Installing signal-cli via Homebrew (${brewExe})…`);
	const result = await runCommandWithTimeout([
		brewExe,
		"install",
		"signal-cli"
	], { timeoutMs: 15 * 6e4 });
	if (result.code !== 0) return {
		ok: false,
		error: `brew install signal-cli failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`
	};
	const cliPath = await resolveBrewSignalCliPath(brewExe);
	if (!cliPath) return {
		ok: false,
		error: "brew install succeeded but signal-cli binary was not found."
	};
	let version;
	try {
		version = (await runCommandWithTimeout([cliPath, "--version"], { timeoutMs: 1e4 })).stdout.trim().replace(/^signal-cli\s+/, "") || void 0;
	} catch {}
	return {
		ok: true,
		cliPath,
		version
	};
}
async function installSignalCliFromRelease(runtime) {
	const response = await fetch("https://api.github.com/repos/AsamK/signal-cli/releases/latest", { headers: {
		"User-Agent": "openclaw",
		Accept: "application/vnd.github+json"
	} });
	if (!response.ok) return {
		ok: false,
		error: `Failed to fetch release info (${response.status})`
	};
	const payload = await response.json();
	const version = payload.tag_name?.replace(/^v/, "") ?? "unknown";
	const asset = pickAsset(payload.assets ?? [], process.platform, process.arch);
	if (!asset) return {
		ok: false,
		error: "No compatible release asset found for this platform."
	};
	const tmpDir = await fs$1.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-"));
	const archivePath = path.join(tmpDir, asset.name);
	runtime.log(`Downloading signal-cli ${version} (${asset.name})…`);
	await downloadToFile(asset.browser_download_url, archivePath);
	const installRoot = path.join(CONFIG_DIR, "tools", "signal-cli", version);
	await fs$1.mkdir(installRoot, { recursive: true });
	if (!looksLikeArchive(asset.name.toLowerCase())) return {
		ok: false,
		error: `Unsupported archive type: ${asset.name}`
	};
	try {
		await extractSignalCliArchive(archivePath, installRoot, 6e4);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `Failed to extract ${asset.name}: ${message}`
		};
	}
	const cliPath = await findSignalCliBinary(installRoot);
	if (!cliPath) return {
		ok: false,
		error: `signal-cli binary not found after extracting ${asset.name}`
	};
	await fs$1.chmod(cliPath, 493).catch(() => {});
	return {
		ok: true,
		cliPath,
		version
	};
}
async function installSignalCli(runtime) {
	if (process.platform === "win32") return {
		ok: false,
		error: "Signal CLI auto-install is not supported on Windows yet."
	};
	if (process.platform !== "linux" || process.arch === "x64") return installSignalCliFromRelease(runtime);
	return installSignalCliViaBrew(runtime);
}
//#endregion
//#region src/secrets/provider-env-vars.ts
const PROVIDER_ENV_VARS = {
	openai: ["OPENAI_API_KEY"],
	anthropic: ["ANTHROPIC_API_KEY"],
	google: ["GEMINI_API_KEY"],
	minimax: ["MINIMAX_API_KEY"],
	"minimax-cn": ["MINIMAX_API_KEY"],
	moonshot: ["MOONSHOT_API_KEY"],
	"kimi-coding": ["KIMI_API_KEY", "KIMICODE_API_KEY"],
	synthetic: ["SYNTHETIC_API_KEY"],
	venice: ["VENICE_API_KEY"],
	zai: ["ZAI_API_KEY", "Z_AI_API_KEY"],
	xiaomi: ["XIAOMI_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	"cloudflare-ai-gateway": ["CLOUDFLARE_AI_GATEWAY_API_KEY"],
	litellm: ["LITELLM_API_KEY"],
	"vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
	opencode: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
	"opencode-go": ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
	together: ["TOGETHER_API_KEY"],
	huggingface: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
	qianfan: ["QIANFAN_API_KEY"],
	xai: ["XAI_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	kilocode: ["KILOCODE_API_KEY"],
	modelstudio: ["MODELSTUDIO_API_KEY"],
	volcengine: ["VOLCANO_ENGINE_API_KEY"],
	byteplus: ["BYTEPLUS_API_KEY"]
};
const EXTRA_PROVIDER_AUTH_ENV_VARS = [
	"VOYAGE_API_KEY",
	"GROQ_API_KEY",
	"DEEPGRAM_API_KEY",
	"CEREBRAS_API_KEY",
	"NVIDIA_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"CHUTES_OAUTH_TOKEN",
	"CHUTES_API_KEY",
	"QWEN_OAUTH_TOKEN",
	"QWEN_PORTAL_API_KEY",
	"MINIMAX_OAUTH_TOKEN",
	"OLLAMA_API_KEY",
	"VLLM_API_KEY"
];
const KNOWN_SECRET_ENV_VARS = [...new Set(Object.values(PROVIDER_ENV_VARS).flatMap((keys) => keys))];
[...new Set([...KNOWN_SECRET_ENV_VARS, ...EXTRA_PROVIDER_AUTH_ENV_VARS])];
//#endregion
//#region src/plugin-sdk/onboarding.ts
async function promptAccountId$1(params) {
	const existingIds = params.listAccountIds(params.cfg);
	const initial = params.currentId?.trim() || params.defaultAccountId || "default";
	const choice = await params.prompter.select({
		message: `${params.label} account`,
		options: [...existingIds.map((id) => ({
			value: id,
			label: id === "default" ? "default (primary)" : id
		})), {
			value: "__new__",
			label: "Add a new account"
		}],
		initialValue: initial
	});
	if (choice !== "__new__") return normalizeAccountId(choice);
	const entered = await params.prompter.text({
		message: `New ${params.label} account id`,
		validate: (value) => value?.trim() ? void 0 : "Required"
	});
	const normalized = normalizeAccountId(String(entered));
	if (String(entered).trim() !== normalized) await params.prompter.note(`Normalized account id to "${normalized}".`, `${params.label} account`);
	return normalized;
}
//#endregion
//#region src/channels/plugins/onboarding/helpers.ts
const promptAccountId = async (params) => {
	return await promptAccountId$1(params);
};
function addWildcardAllowFrom(allowFrom) {
	const next = (allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
	if (!next.includes("*")) next.push("*");
	return next;
}
function mergeAllowFromEntries(current, additions) {
	const merged = [...current ?? [], ...additions].map((v) => String(v).trim()).filter(Boolean);
	return [...new Set(merged)];
}
function splitOnboardingEntries(raw) {
	return raw.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
}
function parseOnboardingEntriesWithParser(raw, parseEntry) {
	const parts = splitOnboardingEntries(String(raw ?? ""));
	const entries = [];
	for (const part of parts) {
		const parsed = parseEntry(part);
		if ("error" in parsed) return {
			entries: [],
			error: parsed.error
		};
		entries.push(parsed.value);
	}
	return { entries: normalizeAllowFromEntries(entries) };
}
function parseOnboardingEntriesAllowingWildcard(raw, parseEntry) {
	return parseOnboardingEntriesWithParser(raw, (entry) => {
		if (entry === "*") return { value: "*" };
		return parseEntry(entry);
	});
}
function normalizeAllowFromEntries(entries, normalizeEntry) {
	const normalized = entries.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => {
		if (entry === "*") return "*";
		if (!normalizeEntry) return entry;
		const value = normalizeEntry(entry);
		return typeof value === "string" ? value.trim() : "";
	}).filter(Boolean);
	return [...new Set(normalized)];
}
function resolveOnboardingAccountId(params) {
	return params.accountId?.trim() ? normalizeAccountId(params.accountId) : params.defaultAccountId;
}
async function resolveAccountIdForConfigure(params) {
	const override = params.accountOverride?.trim();
	let accountId = override ? normalizeAccountId(override) : params.defaultAccountId;
	if (params.shouldPromptAccountIds && !override) accountId = await promptAccountId({
		cfg: params.cfg,
		prompter: params.prompter,
		label: params.label,
		currentId: accountId,
		listAccountIds: params.listAccountIds,
		defaultAccountId: params.defaultAccountId
	});
	return accountId;
}
function setAccountAllowFromForChannel(params) {
	const { cfg, channel, accountId, allowFrom } = params;
	return patchConfigForScopedAccount({
		cfg,
		channel,
		accountId,
		patch: { allowFrom },
		ensureEnabled: false
	});
}
function setChannelDmPolicyWithAllowFrom(params) {
	const { cfg, channel, dmPolicy } = params;
	const allowFrom = dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.[channel]?.allowFrom) : void 0;
	return {
		...cfg,
		channels: {
			...cfg.channels,
			[channel]: {
				...cfg.channels?.[channel],
				dmPolicy,
				...allowFrom ? { allowFrom } : {}
			}
		}
	};
}
function setOnboardingChannelEnabled(cfg, channel, enabled) {
	const channelConfig = cfg.channels?.[channel] ?? {};
	return {
		...cfg,
		channels: {
			...cfg.channels,
			[channel]: {
				...channelConfig,
				enabled
			}
		}
	};
}
function patchConfigForScopedAccount(params) {
	const { cfg, channel, accountId, patch, ensureEnabled } = params;
	return patchScopedAccountConfig({
		cfg: accountId === "default" ? cfg : moveSingleAccountChannelSectionToDefaultAccount({
			cfg,
			channelKey: channel
		}),
		channelKey: channel,
		accountId,
		patch,
		ensureChannelEnabled: ensureEnabled,
		ensureAccountEnabled: ensureEnabled
	});
}
function patchChannelConfigForAccount(params) {
	return patchConfigForScopedAccount({
		...params,
		ensureEnabled: true
	});
}
async function promptParsedAllowFromForScopedChannel(params) {
	const accountId = resolveOnboardingAccountId({
		accountId: params.accountId,
		defaultAccountId: params.defaultAccountId
	});
	const existing = params.getExistingAllowFrom({
		cfg: params.cfg,
		accountId
	});
	await params.prompter.note(params.noteLines.join("\n"), params.noteTitle);
	const entry = await params.prompter.text({
		message: params.message,
		placeholder: params.placeholder,
		initialValue: existing[0] ? String(existing[0]) : void 0,
		validate: (value) => {
			const raw = String(value ?? "").trim();
			if (!raw) return "Required";
			return params.parseEntries(raw).error;
		}
	});
	const unique = mergeAllowFromEntries(void 0, params.parseEntries(String(entry)).entries);
	return setAccountAllowFromForChannel({
		cfg: params.cfg,
		channel: params.channel,
		accountId,
		allowFrom: unique
	});
}
//#endregion
//#region src/channels/plugins/onboarding/signal.ts
const channel = "signal";
const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;
const INVALID_SIGNAL_ACCOUNT_ERROR = "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)";
function normalizeSignalAccountInput(value) {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	const digits = normalizeE164(trimmed).slice(1);
	if (!DIGITS_ONLY.test(digits)) return null;
	if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) return null;
	return `+${digits}`;
}
function isUuidLike(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function parseSignalAllowFromEntries(raw) {
	return parseOnboardingEntriesAllowingWildcard(raw, (entry) => {
		if (entry.toLowerCase().startsWith("uuid:")) {
			const id = entry.slice(5).trim();
			if (!id) return { error: "Invalid uuid entry" };
			return { value: `uuid:${id}` };
		}
		if (isUuidLike(entry)) return { value: `uuid:${entry}` };
		const normalized = normalizeSignalAccountInput(entry);
		if (!normalized) return { error: `Invalid entry: ${entry}` };
		return { value: normalized };
	});
}
async function promptSignalAllowFrom(params) {
	return promptParsedAllowFromForScopedChannel({
		cfg: params.cfg,
		channel: "signal",
		accountId: params.accountId,
		defaultAccountId: resolveDefaultSignalAccountId(params.cfg),
		prompter: params.prompter,
		noteTitle: "Signal allowlist",
		noteLines: [
			"Allowlist Signal DMs by sender id.",
			"Examples:",
			"- +15555550123",
			"- uuid:123e4567-e89b-12d3-a456-426614174000",
			"Multiple entries: comma-separated.",
			`Docs: ${formatDocsLink("/signal", "signal")}`
		],
		message: "Signal allowFrom (E.164 or uuid)",
		placeholder: "+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000",
		parseEntries: parseSignalAllowFromEntries,
		getExistingAllowFrom: ({ cfg, accountId }) => {
			return resolveSignalAccount({
				cfg,
				accountId
			}).config.allowFrom ?? [];
		}
	});
}
const signalOnboardingAdapter = {
	channel,
	getStatus: async ({ cfg }) => {
		const configured = listSignalAccountIds(cfg).some((accountId) => resolveSignalAccount({
			cfg,
			accountId
		}).configured);
		const signalCliPath = cfg.channels?.signal?.cliPath ?? "signal-cli";
		const signalCliDetected = await detectBinary(signalCliPath);
		return {
			channel,
			configured,
			statusLines: [`Signal: ${configured ? "configured" : "needs setup"}`, `signal-cli: ${signalCliDetected ? "found" : "missing"} (${signalCliPath})`],
			selectionHint: signalCliDetected ? "signal-cli found" : "signal-cli missing",
			quickstartScore: signalCliDetected ? 1 : 0
		};
	},
	configure: async ({ cfg, runtime, prompter, accountOverrides, shouldPromptAccountIds, options }) => {
		const defaultSignalAccountId = resolveDefaultSignalAccountId(cfg);
		const signalAccountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "Signal",
			accountOverride: accountOverrides.signal,
			shouldPromptAccountIds,
			listAccountIds: listSignalAccountIds,
			defaultAccountId: defaultSignalAccountId
		});
		let next = cfg;
		const accountConfig = resolveSignalAccount({
			cfg: next,
			accountId: signalAccountId
		}).config;
		let resolvedCliPath = accountConfig.cliPath ?? "signal-cli";
		let cliDetected = await detectBinary(resolvedCliPath);
		if (options?.allowSignalInstall) {
			if (await prompter.confirm({
				message: cliDetected ? "signal-cli detected. Reinstall/update now?" : "signal-cli not found. Install now?",
				initialValue: !cliDetected
			})) try {
				const result = await installSignalCli(runtime);
				if (result.ok && result.cliPath) {
					cliDetected = true;
					resolvedCliPath = result.cliPath;
					await prompter.note(`Installed signal-cli at ${result.cliPath}`, "Signal");
				} else if (!result.ok) await prompter.note(result.error ?? "signal-cli install failed.", "Signal");
			} catch (err) {
				await prompter.note(`signal-cli install failed: ${String(err)}`, "Signal");
			}
		}
		if (!cliDetected) await prompter.note("signal-cli not found. Install it, then rerun this step or set channels.signal.cliPath.", "Signal");
		let account = accountConfig.account ?? "";
		if (account) {
			const normalizedExisting = normalizeSignalAccountInput(account);
			if (!normalizedExisting) {
				await prompter.note("Existing Signal account isn't a valid E.164 number. Please enter it again.", "Signal");
				account = "";
			} else {
				account = normalizedExisting;
				if (!await prompter.confirm({
					message: `Signal account set (${account}). Keep it?`,
					initialValue: true
				})) account = "";
			}
		}
		if (!account) account = normalizeSignalAccountInput(String(await prompter.text({
			message: "Signal bot number (E.164)",
			validate: (value) => normalizeSignalAccountInput(String(value ?? "")) ? void 0 : INVALID_SIGNAL_ACCOUNT_ERROR
		}))) ?? "";
		if (account) next = patchChannelConfigForAccount({
			cfg: next,
			channel: "signal",
			accountId: signalAccountId,
			patch: {
				account,
				cliPath: resolvedCliPath ?? "signal-cli"
			}
		});
		await prompter.note([
			"Link device with: signal-cli link -n \"OpenClaw\"",
			"Scan QR in Signal → Linked Devices",
			`Then run: ${formatCliCommand("openclaw gateway call channels.status --params '{\"probe\":true}'")}`,
			`Docs: ${formatDocsLink("/signal", "signal")}`
		].join("\n"), "Signal next steps");
		return {
			cfg: next,
			accountId: signalAccountId
		};
	},
	dmPolicy: {
		label: "Signal",
		channel,
		policyKey: "channels.signal.dmPolicy",
		allowFromKey: "channels.signal.allowFrom",
		getCurrent: (cfg) => cfg.channels?.signal?.dmPolicy ?? "pairing",
		setPolicy: (cfg, policy) => setChannelDmPolicyWithAllowFrom({
			cfg,
			channel: "signal",
			dmPolicy: policy
		}),
		promptAllowFrom: promptSignalAllowFrom
	},
	disable: (cfg) => setOnboardingChannelEnabled(cfg, channel, false)
};
//#endregion
//#region src/plugin-sdk/status-helpers.ts
function createDefaultChannelRuntimeState(accountId, extra) {
	return {
		accountId,
		running: false,
		lastStartAt: null,
		lastStopAt: null,
		lastError: null,
		...extra ?? {}
	};
}
function buildBaseChannelStatusSummary(snapshot) {
	return {
		configured: snapshot.configured ?? false,
		running: snapshot.running ?? false,
		lastStartAt: snapshot.lastStartAt ?? null,
		lastStopAt: snapshot.lastStopAt ?? null,
		lastError: snapshot.lastError ?? null
	};
}
function buildBaseAccountStatusSnapshot(params) {
	const { account, runtime, probe } = params;
	return {
		accountId: account.accountId,
		name: account.name,
		enabled: account.enabled,
		configured: account.configured,
		...buildRuntimeAccountStatusSnapshot({
			runtime,
			probe
		}),
		lastInboundAt: runtime?.lastInboundAt ?? null,
		lastOutboundAt: runtime?.lastOutboundAt ?? null
	};
}
function buildRuntimeAccountStatusSnapshot(params) {
	const { runtime, probe } = params;
	return {
		running: runtime?.running ?? false,
		lastStartAt: runtime?.lastStartAt ?? null,
		lastStopAt: runtime?.lastStopAt ?? null,
		lastError: runtime?.lastError ?? null,
		probe
	};
}
function collectStatusIssuesFromLastError(channel, accounts) {
	return accounts.flatMap((account) => {
		const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
		if (!lastError) return [];
		return [{
			channel,
			accountId: account.accountId,
			kind: "runtime",
			message: `Channel error: ${lastError}`
		}];
	});
}
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, emptyPluginConfigSchema, formatPairingApproveHint, getChatChannelMeta, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, setAccountEnabledInConfigSection, signalOnboardingAdapter };
