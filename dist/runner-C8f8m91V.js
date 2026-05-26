import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as isAbortError } from "./unhandled-rejections-Km9wbHjh.js";
import { m as FsSafeError } from "./path-BlG8lhgR.js";
import { b as assertNoWindowsNetworkPath, w as safeFileURLToPath } from "./fs-safe-CV86zY9G.js";
import { r as openLocalFileSafely } from "./secure-temp-dir-aidxCRgA.js";
import { n as findNormalizedProviderValue } from "./provider-id-zTW9Rdln.js";
import { i as resolveAgentModelPrimaryValue, r as resolveAgentModelFallbackValues } from "./model-input-ChW9XXsQ.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { a as shouldLogVerbose, r as logVerbose } from "./globals-YU5FjfZK.js";
import { a as logWarn } from "./logger-0o2znY2U.js";
import { i as runExec } from "./exec-D4bhAbbv.js";
import "./local-file-access-CBe_wA_B.js";
import { c as kindFromMime, i as getFileExtension, n as detectMime, o as isAudioFileName } from "./mime-DppuT-pZ.js";
import { i as readRemoteMediaBuffer, n as MediaFetchError } from "./fetch-C0wRQZuz.js";
import { a as getDefaultMediaLocalRoots } from "./local-roots-Pi6a9oaK.js";
import { n as isMinimaxVlmProvider, t as isMinimaxVlmModel } from "./minimax-vlm-Bk6rsboX.js";
import { n as normalizeMediaProviderId, t as normalizeMediaExecutionProviderId } from "./provider-id-BETgOIvU.js";
import { d as getMediaUnderstandingProvider, u as buildMediaUnderstandingRegistry } from "./defaults.constants-DeIx7Gbv.js";
import { t as providerSupportsCapability } from "./provider-supports-_vg7HvJF.js";
import { i as resolveModelEntries, o as resolveScopeDecision } from "./resolve-CJVCx0AN.js";
import { t as resolveChannelInboundAttachmentRoots } from "./channel-inbound-roots-U_3CsLmG.js";
import { r as mergeInboundPathRoots, t as isInboundPathAllowed } from "./inbound-path-policy-DEbcUBWg.js";
import { t as buildRandomTempFilePath } from "./temp-download-b1j3o1mX.js";
import "./temp-path-DllZid8c.js";
import { a as runCliEntry, c as fileExists, l as MediaUnderstandingSkipError, o as runProviderEntry, r as formatDecisionSummary, t as buildModelDecision, u as isMediaUnderstandingSkipError } from "./runner.entries-CxY7Q-di.js";
import { constants } from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import os from "node:os";
//#region src/media-understanding/attachments.normalize.ts
function normalizeAttachmentPath(raw) {
	const value = normalizeOptionalString(raw);
	if (!value) return;
	if (value.startsWith("file://")) try {
		return safeFileURLToPath(value);
	} catch {
		return;
	}
	try {
		assertNoWindowsNetworkPath(value, "Attachment path");
	} catch {
		return;
	}
	return value;
}
function normalizeAttachments(ctx) {
	const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : void 0;
	const urlsFromArray = Array.isArray(ctx.MediaUrls) ? ctx.MediaUrls : void 0;
	const typesFromArray = Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : void 0;
	const transcribedIndexes = new Set(Array.isArray(ctx.MediaTranscribedIndexes) ? ctx.MediaTranscribedIndexes.filter((index) => Number.isInteger(index) && index >= 0) : []);
	const resolveMime = (count, index) => {
		const typeHint = normalizeOptionalString(typesFromArray?.[index]);
		if (typeHint) return typeHint;
		return count === 1 ? ctx.MediaType : void 0;
	};
	if (pathsFromArray && pathsFromArray.length > 0) {
		const count = pathsFromArray.length;
		const urls = urlsFromArray && urlsFromArray.length > 0 ? urlsFromArray : void 0;
		return pathsFromArray.map((value, index) => ({
			path: normalizeOptionalString(value),
			url: urls?.[index] ?? ctx.MediaUrl,
			mime: resolveMime(count, index),
			index,
			alreadyTranscribed: transcribedIndexes.has(index)
		})).filter((entry) => Boolean(entry.path ?? normalizeOptionalString(entry.url)));
	}
	if (urlsFromArray && urlsFromArray.length > 0) {
		const count = urlsFromArray.length;
		return urlsFromArray.map((value, index) => ({
			path: void 0,
			url: normalizeOptionalString(value),
			mime: resolveMime(count, index),
			index,
			alreadyTranscribed: transcribedIndexes.has(index)
		})).filter((entry) => Boolean(entry.url));
	}
	const pathValue = normalizeOptionalString(ctx.MediaPath);
	const url = normalizeOptionalString(ctx.MediaUrl);
	if (!pathValue && !url) return [];
	return [{
		path: pathValue || void 0,
		url: url || void 0,
		mime: ctx.MediaType,
		index: 0,
		alreadyTranscribed: transcribedIndexes.has(0)
	}];
}
function resolveAttachmentKind(attachment) {
	const kind = kindFromMime(attachment.mime);
	if (kind === "image" || kind === "audio" || kind === "video") return kind;
	const ext = getFileExtension(attachment.path ?? attachment.url);
	if (!ext) return "unknown";
	if ([
		".mp4",
		".mov",
		".mkv",
		".webm",
		".avi",
		".m4v"
	].includes(ext)) return "video";
	if (isAudioFileName(attachment.path ?? attachment.url)) return "audio";
	if ([
		".png",
		".jpg",
		".jpeg",
		".webp",
		".gif",
		".bmp",
		".tiff",
		".tif"
	].includes(ext)) return "image";
	return "unknown";
}
function isVideoAttachment(attachment) {
	return resolveAttachmentKind(attachment) === "video";
}
function isAudioAttachment(attachment) {
	return resolveAttachmentKind(attachment) === "audio";
}
function isImageAttachment(attachment) {
	return resolveAttachmentKind(attachment) === "image";
}
//#endregion
//#region src/media-understanding/attachments.select.ts
const DEFAULT_MAX_ATTACHMENTS = 1;
function orderAttachments(attachments, prefer) {
	const list = Array.isArray(attachments) ? attachments.filter(isAttachmentRecord) : [];
	if (!prefer || prefer === "first") return list;
	if (prefer === "last") return [...list].toReversed();
	if (prefer === "path") {
		const withPath = list.filter((item) => item.path);
		const withoutPath = list.filter((item) => !item.path);
		return [...withPath, ...withoutPath];
	}
	if (prefer === "url") {
		const withUrl = list.filter((item) => item.url);
		const withoutUrl = list.filter((item) => !item.url);
		return [...withUrl, ...withoutUrl];
	}
	return list;
}
function isAttachmentRecord(value) {
	if (!value || typeof value !== "object") return false;
	const entry = value;
	if (typeof entry.index !== "number") return false;
	if (entry.path !== void 0 && typeof entry.path !== "string") return false;
	if (entry.url !== void 0 && typeof entry.url !== "string") return false;
	if (entry.mime !== void 0 && typeof entry.mime !== "string") return false;
	if (entry.alreadyTranscribed !== void 0 && typeof entry.alreadyTranscribed !== "boolean") return false;
	return true;
}
function selectAttachments(params) {
	const { capability, attachments, policy } = params;
	const matches = (Array.isArray(attachments) ? attachments.filter(isAttachmentRecord) : []).filter((item) => {
		if (capability === "audio" && item.alreadyTranscribed) return false;
		if (capability === "image") return isImageAttachment(item);
		if (capability === "audio") return isAudioAttachment(item);
		return isVideoAttachment(item);
	});
	if (matches.length === 0) return [];
	const ordered = orderAttachments(matches, policy?.prefer);
	const mode = policy?.mode ?? "first";
	const maxAttachments = policy?.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;
	if (mode === "all") return ordered.slice(0, Math.max(1, maxAttachments));
	return ordered.slice(0, 1);
}
//#endregion
//#region src/media-understanding/attachments.cache.ts
const REMOTE_MEDIA_FETCH_RETRY = {
	attempts: 3,
	minDelayMs: 500,
	maxDelayMs: 3e3,
	jitter: .2
};
let defaultLocalPathRoots;
function concreteMime(mime) {
	const normalized = mime?.trim();
	if (!normalized || normalized.endsWith("/*")) return;
	return normalized;
}
function getDefaultLocalPathRoots() {
	defaultLocalPathRoots ??= mergeInboundPathRoots(getDefaultMediaLocalRoots());
	return defaultLocalPathRoots;
}
var MediaAttachmentCache = class {
	constructor(attachments, options) {
		this.entries = /* @__PURE__ */ new Map();
		this.attachments = attachments;
		this.ssrfPolicy = options?.ssrfPolicy;
		this.localPathRoots = options?.includeDefaultLocalPathRoots === false ? mergeInboundPathRoots(options.localPathRoots) : mergeInboundPathRoots(options?.localPathRoots, getDefaultLocalPathRoots());
		this.workspaceDir = options?.workspaceDir ? path.resolve(options.workspaceDir) : void 0;
		for (const attachment of attachments) this.entries.set(attachment.index, { attachment });
	}
	async getBuffer(params) {
		const entry = await this.ensureEntry(params.attachmentIndex);
		const url = entry.attachment.url?.trim();
		if (entry.buffer) {
			if (entry.buffer.length > params.maxBytes) throw new MediaUnderstandingSkipError("maxBytes", `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`);
			return {
				buffer: entry.buffer,
				mime: entry.bufferMime,
				fileName: entry.bufferFileName ?? `media-${params.attachmentIndex + 1}`,
				size: entry.buffer.length
			};
		}
		if (entry.resolvedPath) try {
			const size = await this.ensureLocalStat(entry);
			if (entry.resolvedPath) {
				if (size !== void 0 && size > params.maxBytes) throw new MediaUnderstandingSkipError("maxBytes", `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`);
				const { buffer, filePath } = await this.readLocalBuffer({
					attachmentIndex: params.attachmentIndex,
					filePath: entry.resolvedPath,
					maxBytes: params.maxBytes
				});
				entry.resolvedPath = filePath;
				entry.buffer = buffer;
				entry.bufferMime = entry.bufferMime ?? concreteMime(entry.attachment.mime) ?? await detectMime({
					buffer,
					filePath
				});
				entry.bufferFileName = path.basename(filePath) || `media-${params.attachmentIndex + 1}`;
				return {
					buffer,
					mime: entry.bufferMime,
					fileName: entry.bufferFileName,
					size: buffer.length
				};
			}
		} catch (err) {
			if (!(err instanceof MediaUnderstandingSkipError) || !url || err.reason !== "blocked" && err.reason !== "empty") throw err;
		}
		if (!url) throw new MediaUnderstandingSkipError("empty", `Attachment ${params.attachmentIndex + 1} has no path or URL.`);
		try {
			const fetched = await readRemoteMediaBuffer({
				url,
				timeoutMs: params.timeoutMs,
				maxBytes: params.maxBytes,
				ssrfPolicy: this.ssrfPolicy,
				retry: REMOTE_MEDIA_FETCH_RETRY
			});
			entry.buffer = fetched.buffer;
			entry.bufferMime = concreteMime(entry.attachment.mime) ?? fetched.contentType ?? await detectMime({
				buffer: fetched.buffer,
				filePath: fetched.fileName ?? url
			});
			entry.bufferFileName = fetched.fileName ?? `media-${params.attachmentIndex + 1}`;
			return {
				buffer: fetched.buffer,
				mime: entry.bufferMime,
				fileName: entry.bufferFileName,
				size: fetched.buffer.length
			};
		} catch (err) {
			if (err instanceof MediaFetchError && err.code === "max_bytes") throw new MediaUnderstandingSkipError("maxBytes", `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`);
			if (isAbortError(err)) throw new MediaUnderstandingSkipError("timeout", `Attachment ${params.attachmentIndex + 1} timed out while fetching.`);
			throw err;
		}
	}
	async getPath(params) {
		const entry = await this.ensureEntry(params.attachmentIndex);
		if (entry.resolvedPath) {
			if (params.maxBytes) try {
				const size = await this.ensureLocalStat(entry);
				if (entry.resolvedPath) {
					if (size !== void 0 && size > params.maxBytes) throw new MediaUnderstandingSkipError("maxBytes", `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`);
				}
			} catch (err) {
				if (!(err instanceof MediaUnderstandingSkipError) || err.reason !== "blocked" && err.reason !== "empty") throw err;
			}
			if (entry.resolvedPath) return { path: entry.resolvedPath };
		}
		if (entry.tempPath) {
			if (params.maxBytes && entry.buffer && entry.buffer.length > params.maxBytes) throw new MediaUnderstandingSkipError("maxBytes", `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`);
			return {
				path: entry.tempPath,
				cleanup: entry.tempCleanup
			};
		}
		const maxBytes = params.maxBytes ?? Number.POSITIVE_INFINITY;
		const bufferResult = await this.getBuffer({
			attachmentIndex: params.attachmentIndex,
			maxBytes,
			timeoutMs: params.timeoutMs
		});
		const tmpPath = buildRandomTempFilePath({
			prefix: "openclaw-media",
			extension: path.extname(bufferResult.fileName || "") || ""
		});
		await fs$1.writeFile(tmpPath, bufferResult.buffer);
		entry.tempPath = tmpPath;
		entry.tempCleanup = async () => {
			await fs$1.unlink(tmpPath).catch(() => {});
		};
		return {
			path: tmpPath,
			cleanup: entry.tempCleanup
		};
	}
	async cleanup() {
		const cleanups = [];
		for (const entry of this.entries.values()) if (entry.tempCleanup) {
			cleanups.push(entry.tempCleanup());
			entry.tempCleanup = void 0;
		}
		await Promise.all(cleanups);
	}
	async ensureEntry(attachmentIndex) {
		const existing = this.entries.get(attachmentIndex);
		if (existing) {
			if (!existing.resolvedPath) existing.resolvedPath = this.resolveLocalPath(existing.attachment);
			return existing;
		}
		const attachment = this.attachments.find((item) => item.index === attachmentIndex) ?? { index: attachmentIndex };
		const entry = {
			attachment,
			resolvedPath: this.resolveLocalPath(attachment)
		};
		this.entries.set(attachmentIndex, entry);
		return entry;
	}
	resolveLocalPath(attachment) {
		const rawPath = normalizeAttachmentPath(attachment.path);
		if (!rawPath) return;
		return this.workspaceDir ? path.resolve(this.workspaceDir, rawPath) : path.resolve(rawPath);
	}
	async ensureLocalStat(entry) {
		if (!entry.resolvedPath) return;
		if (!isInboundPathAllowed({
			filePath: entry.resolvedPath,
			roots: this.localPathRoots
		})) {
			entry.resolvedPath = void 0;
			if (shouldLogVerbose()) logVerbose(`Blocked attachment path outside allowed roots: ${entry.attachment.path ?? entry.attachment.url ?? "(unknown)"}`);
			throw new MediaUnderstandingSkipError("blocked", `Attachment ${entry.attachment.index + 1} path is outside allowed roots.`);
		}
		if (entry.statSize !== void 0) return entry.statSize;
		try {
			const currentPath = entry.resolvedPath;
			const opened = await openLocalFileSafely({ filePath: currentPath });
			let canonicalRoots;
			try {
				canonicalRoots = await this.getCanonicalLocalPathRoots();
			} finally {
				await opened.handle.close().catch(() => {});
			}
			if (!isInboundPathAllowed({
				filePath: opened.realPath,
				roots: canonicalRoots
			})) {
				entry.resolvedPath = void 0;
				if (shouldLogVerbose()) logVerbose(`Blocked canonicalized attachment path outside allowed roots: ${opened.realPath}`);
				throw new MediaUnderstandingSkipError("blocked", `Attachment ${entry.attachment.index + 1} path is outside allowed roots.`);
			}
			entry.resolvedPath = opened.realPath;
			entry.statSize = opened.stat.size;
			return opened.stat.size;
		} catch (err) {
			if (err instanceof MediaUnderstandingSkipError) throw err;
			if (err instanceof FsSafeError) {
				entry.resolvedPath = void 0;
				if (err.code === "not-file") throw new MediaUnderstandingSkipError("empty", `Attachment ${entry.attachment.index + 1} path is not a regular file.`);
				if (err.code !== "not-found") throw new MediaUnderstandingSkipError("blocked", `Attachment ${entry.attachment.index + 1} path is outside allowed roots.`);
			} else throw new MediaUnderstandingSkipError("blocked", `Attachment ${entry.attachment.index + 1} could not be canonicalized.`);
			entry.resolvedPath = void 0;
			if (shouldLogVerbose()) logVerbose(`Failed to read attachment ${entry.attachment.index + 1}: ${String(err)}`);
			return;
		}
	}
	async getCanonicalLocalPathRoots() {
		if (this.canonicalLocalPathRoots) return await this.canonicalLocalPathRoots;
		this.canonicalLocalPathRoots = (async () => mergeInboundPathRoots(this.localPathRoots, await Promise.all(this.localPathRoots.map(async (root) => {
			if (root.includes("*")) return root;
			return await fs$1.realpath(root).catch(() => root);
		}))))();
		return await this.canonicalLocalPathRoots;
	}
	async readLocalBuffer(params) {
		let opened;
		try {
			opened = await openLocalFileSafely({ filePath: params.filePath });
			if (opened.stat.size > params.maxBytes) throw new MediaUnderstandingSkipError("maxBytes", `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`);
			const canonicalRoots = await this.getCanonicalLocalPathRoots();
			if (!isInboundPathAllowed({
				filePath: opened.realPath,
				roots: canonicalRoots
			})) throw new MediaUnderstandingSkipError("blocked", `Attachment ${params.attachmentIndex + 1} path is outside allowed roots.`);
			const buffer = await opened.handle.readFile();
			if (buffer.length > params.maxBytes) throw new MediaUnderstandingSkipError("maxBytes", `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`);
			return {
				buffer,
				filePath: opened.realPath
			};
		} catch (err) {
			if (err instanceof FsSafeError) {
				if (err.code === "too-large") throw new MediaUnderstandingSkipError("maxBytes", `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`);
				if (err.code === "not-file" || err.code === "not-found") throw new MediaUnderstandingSkipError("empty", `Attachment ${params.attachmentIndex + 1} path is not a regular file.`);
				throw new MediaUnderstandingSkipError("blocked", `Attachment ${params.attachmentIndex + 1} path is outside allowed roots.`);
			}
			throw err;
		} finally {
			await opened?.handle.close().catch(() => {});
		}
	}
};
//#endregion
//#region src/media-understanding/runner.attachments.ts
function normalizeMediaAttachments(ctx) {
	return normalizeAttachments(ctx);
}
function createMediaAttachmentCache(attachments, options) {
	return new MediaAttachmentCache(attachments, options);
}
//#endregion
//#region src/media-understanding/runner.ts
let cachedHasAvailableAuthForProvider = null;
let cachedModelCatalogApi = null;
async function loadModelCatalogApi() {
	cachedModelCatalogApi ??= await import("./model-catalog-BjZ8JZNF.js");
	return cachedModelCatalogApi;
}
function resolveLiteralProviderApiKey(cfg, providerId) {
	const value = findNormalizedProviderValue(cfg?.models?.providers, providerId)?.apiKey;
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
async function hasProviderAuthAvailable(params) {
	if (resolveLiteralProviderApiKey(params.cfg, params.provider)) return true;
	cachedHasAvailableAuthForProvider ??= (await import("./model-auth-CFJR0pRr.js")).hasAvailableAuthForProvider;
	return await cachedHasAvailableAuthForProvider(params);
}
function resolveConfiguredKeyProviderOrder(params) {
	const configuredProviders = Object.keys(params.cfg.models?.providers ?? {}).map((providerId) => normalizeMediaExecutionProviderId(providerId)).filter(Boolean).filter((providerId, index, values) => values.indexOf(providerId) === index).filter((providerId) => providerSupportsCapability(params.providerRegistry.get(normalizeMediaProviderId(providerId)), params.capability));
	return [...new Set([...configuredProviders, ...params.fallbackProviders])];
}
function resolveConfiguredImageModelId(params) {
	if (isMinimaxVlmProvider(params.providerId)) return;
	return resolveConfiguredImageModel(params)?.id?.trim() || void 0;
}
function resolveConfiguredImageModel(params) {
	return findNormalizedProviderValue(params.cfg.models?.providers, params.providerId)?.models?.find((entry) => {
		const id = entry?.id?.trim();
		return Boolean(id) && entry?.input?.includes("image");
	});
}
function resolveCatalogImageModelId(params) {
	const matches = params.catalog.filter((entry) => normalizeMediaProviderId(entry.provider) === normalizeMediaProviderId(params.providerId) && params.modelSupportsVision(entry));
	if (matches.length === 0) return;
	return normalizeOptionalString((matches.find((entry) => normalizeLowercaseStringOrEmpty(entry.id) === "auto") ?? matches[0])?.id);
}
function resolveDefaultMediaModelFromRegistry(params) {
	return normalizeOptionalString(params.providerRegistry.get(normalizeMediaProviderId(params.providerId))?.defaultModels?.[params.capability]);
}
function resolveAutoMediaKeyProvidersFromRegistry(params) {
	return [...params.providerRegistry.values()].filter((provider) => provider.capabilities?.includes(params.capability) ?? providerSupportsCapability(provider, params.capability)).map((provider) => {
		const priority = provider.autoPriority?.[params.capability];
		return typeof priority === "number" && Number.isFinite(priority) ? {
			provider,
			priority
		} : null;
	}).filter((entry) => entry !== null).toSorted((left, right) => {
		if (left.priority !== right.priority) return left.priority - right.priority;
		return left.provider.id.localeCompare(right.provider.id);
	}).map((entry) => normalizeMediaProviderId(entry.provider.id)).filter(Boolean);
}
async function explicitImageModelVisionStatus(params) {
	if (isMinimaxVlmProvider(params.providerId) && !isMinimaxVlmModel(params.providerId, params.model)) return "unsupported";
	const configured = resolveConfiguredImageModel(params);
	if (configured?.id?.trim() === params.model && configured.input?.includes("image")) return "supported";
	const { findModelInCatalog, loadModelCatalog, modelSupportsVision } = await loadModelCatalogApi();
	const entry = findModelInCatalog(await loadModelCatalog({ config: params.cfg }), params.providerId, params.model);
	if (!entry) return "unknown";
	return modelSupportsVision(entry) ? "supported" : "unsupported";
}
async function resolveAutoImageModelId(params) {
	const explicit = normalizeOptionalString(params.explicitModel);
	if (explicit) {
		if (await explicitImageModelVisionStatus({
			cfg: params.cfg,
			providerId: params.providerId,
			model: explicit
		}) !== "unsupported") return explicit;
	}
	if (isMinimaxVlmProvider(params.providerId)) return "MiniMax-VL-01";
	const configuredModel = resolveConfiguredImageModelId(params);
	if (configuredModel) return configuredModel;
	const defaultModel = resolveDefaultMediaModelFromRegistry({
		providerId: params.providerId,
		capability: "image",
		providerRegistry: params.providerRegistry
	});
	if (defaultModel) return defaultModel;
	const { resolveDefaultMediaModel } = await import("./defaults-1YMoS8_3.js");
	const bundledDefaultModel = resolveDefaultMediaModel({
		cfg: params.cfg,
		providerId: params.providerId,
		capability: "image",
		workspaceDir: params.workspaceDir
	});
	if (bundledDefaultModel) return bundledDefaultModel;
	const { loadModelCatalog, modelSupportsVision } = await loadModelCatalogApi();
	const catalog = await loadModelCatalog({ config: params.cfg });
	return resolveCatalogImageModelId({
		providerId: params.providerId,
		catalog,
		modelSupportsVision
	});
}
function buildProviderRegistry(overrides, cfg) {
	return buildMediaUnderstandingRegistry(overrides, cfg);
}
function resolveMediaAttachmentLocalRoots(params) {
	const workspaceDir = params.ctx.MediaWorkspaceDir ?? params.workspaceDir;
	return mergeInboundPathRoots(getDefaultMediaLocalRoots(), workspaceDir ? [path.resolve(workspaceDir)] : void 0, resolveChannelInboundAttachmentRoots(params));
}
const binaryCache = /* @__PURE__ */ new Map();
const antigravityCliCache = /* @__PURE__ */ new Map();
function clearMediaUnderstandingBinaryCacheForTests() {
	binaryCache.clear();
	antigravityCliCache.clear();
}
function expandHomeDir(value) {
	if (!value.startsWith("~")) return value;
	const home = os.homedir();
	if (value === "~") return home;
	if (value.startsWith("~/")) return path.join(home, value.slice(2));
	return value;
}
function hasPathSeparator(value) {
	return value.includes("/") || value.includes("\\");
}
function candidateBinaryNames(name) {
	if (process.platform !== "win32") return [name];
	if (path.extname(name)) return [name];
	const pathext = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((item) => item.trim()).filter(Boolean).map((item) => item.startsWith(".") ? item : `.${item}`);
	return [name, ...Array.from(new Set(pathext)).map((item) => `${name}${item}`)];
}
async function isExecutable(filePath) {
	try {
		if (!(await fs$1.stat(filePath)).isFile()) return false;
		if (process.platform === "win32") return true;
		await fs$1.access(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
async function findBinary(name) {
	const cached = binaryCache.get(name);
	if (cached) return cached;
	const resolved = (async () => {
		const direct = expandHomeDir(name.trim());
		if (direct && hasPathSeparator(direct)) {
			for (const candidate of candidateBinaryNames(direct)) if (await isExecutable(candidate)) return candidate;
		}
		const searchName = name.trim();
		if (!searchName) return null;
		const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
		const candidates = candidateBinaryNames(searchName);
		for (const entryRaw of pathEntries) {
			const entry = expandHomeDir(entryRaw.trim().replace(/^"(.*)"$/, "$1"));
			if (!entry) continue;
			for (const candidate of candidates) {
				const fullPath = path.join(entry, candidate);
				if (await isExecutable(fullPath)) return fullPath;
			}
		}
		return null;
	})();
	binaryCache.set(name, resolved);
	return resolved;
}
async function hasBinary(name) {
	return Boolean(await findBinary(name));
}
async function probeAntigravityCliCandidate(command) {
	const resolved = await findBinary(command);
	if (!resolved) return null;
	const probeDir = await fs$1.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-antigravity-probe-"));
	try {
		const { stdout } = await runExec(resolved, ["--help"], {
			timeoutMs: 3e3,
			cwd: probeDir
		});
		return stdout.includes("--print") && stdout.includes("--add-dir") && stdout.includes("--sandbox") ? resolved : null;
	} catch {
		return null;
	} finally {
		await fs$1.rm(probeDir, {
			recursive: true,
			force: true
		}).catch(() => {});
	}
}
async function resolveAntigravityCliBinary() {
	const cached = antigravityCliCache.get("agy");
	if (cached) return cached;
	const resolved = (async () => {
		const candidates = [
			process.env.OPENCLAW_ANTIGRAVITY_CLI?.trim(),
			"agy",
			"antigravity"
		].filter((value) => Boolean(value));
		for (const candidate of candidates) {
			const command = await probeAntigravityCliCandidate(candidate);
			if (command) return command;
		}
		return null;
	})();
	antigravityCliCache.set("agy", resolved);
	return resolved;
}
async function resolveLocalWhisperCppEntry() {
	if (!await hasBinary("whisper-cli")) return null;
	const envModel = process.env.WHISPER_CPP_MODEL?.trim();
	const modelPath = envModel && await fileExists(envModel) ? envModel : "/opt/homebrew/share/whisper-cpp/for-tests-ggml-tiny.bin";
	if (!await fileExists(modelPath)) return null;
	return {
		type: "cli",
		command: "whisper-cli",
		args: [
			"-m",
			modelPath,
			"-otxt",
			"-of",
			"{{OutputBase}}",
			"-np",
			"-nt",
			"{{MediaPath}}"
		]
	};
}
async function resolveLocalWhisperEntry() {
	if (!await hasBinary("whisper")) return null;
	return {
		type: "cli",
		command: "whisper",
		args: [
			"--model",
			"turbo",
			"--output_format",
			"txt",
			"--output_dir",
			"{{OutputDir}}",
			"--verbose",
			"False",
			"{{MediaPath}}"
		]
	};
}
async function resolveSherpaOnnxEntry() {
	if (!await hasBinary("sherpa-onnx-offline")) return null;
	const modelDir = process.env.SHERPA_ONNX_MODEL_DIR?.trim();
	if (!modelDir) return null;
	const tokens = path.join(modelDir, "tokens.txt");
	const encoder = path.join(modelDir, "encoder.onnx");
	const decoder = path.join(modelDir, "decoder.onnx");
	const joiner = path.join(modelDir, "joiner.onnx");
	if (!await fileExists(tokens)) return null;
	if (!await fileExists(encoder)) return null;
	if (!await fileExists(decoder)) return null;
	if (!await fileExists(joiner)) return null;
	return {
		type: "cli",
		command: "sherpa-onnx-offline",
		args: [
			`--tokens=${tokens}`,
			`--encoder=${encoder}`,
			`--decoder=${decoder}`,
			`--joiner=${joiner}`,
			"{{MediaPath}}"
		]
	};
}
async function resolveLocalAudioEntry() {
	const sherpa = await resolveSherpaOnnxEntry();
	if (sherpa) return sherpa;
	const whisperCpp = await resolveLocalWhisperCppEntry();
	if (whisperCpp) return whisperCpp;
	return await resolveLocalWhisperEntry();
}
async function resolveAntigravityCliEntry(capability) {
	if (capability === "audio") return null;
	const command = await resolveAntigravityCliBinary();
	if (!command) return null;
	return {
		type: "cli",
		command,
		args: [
			"--sandbox",
			"--add-dir",
			"{{MediaDir}}",
			"--print",
			"{{Prompt}} Inspect {{MediaPath}} and reply with only the requested media description."
		]
	};
}
async function resolveKeyEntry(params) {
	const { cfg, agentDir, workspaceDir, providerRegistry, capability } = params;
	const checkProvider = async (providerId, model) => {
		const provider = getMediaUnderstandingProvider(providerId, providerRegistry);
		if (!provider) return null;
		if (capability === "audio" && !provider.transcribeAudio) return null;
		if (capability === "image" && !provider.describeImage) return null;
		if (capability === "video" && !provider.describeVideo) return null;
		if (!await hasProviderAuthAvailable({
			provider: providerId,
			cfg,
			agentDir,
			workspaceDir
		})) return null;
		const resolvedModel = capability === "image" ? await resolveAutoImageModelId({
			cfg,
			providerId,
			providerRegistry,
			explicitModel: model,
			workspaceDir
		}) : model;
		if (capability === "image" && !resolvedModel) return null;
		return {
			type: "provider",
			provider: providerId,
			model: resolvedModel
		};
	};
	const activeProvider = params.activeModel?.provider?.trim();
	if (activeProvider) {
		const activeEntry = await checkProvider(activeProvider, params.activeModel?.model);
		if (activeEntry) return activeEntry;
	}
	for (const providerId of resolveConfiguredKeyProviderOrder({
		cfg,
		providerRegistry,
		capability,
		fallbackProviders: resolveAutoMediaKeyProvidersFromRegistry({
			capability,
			providerRegistry
		})
	})) {
		const entry = await checkProvider(providerId, void 0);
		if (entry) return entry;
	}
	return null;
}
function resolveImageModelFromAgentDefaults(cfg) {
	const refs = [];
	const primary = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel);
	if (primary?.trim()) refs.push(primary.trim());
	for (const fb of resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel)) if (fb?.trim()) refs.push(fb.trim());
	if (refs.length === 0) return [];
	const entries = [];
	for (const ref of refs) {
		const slashIdx = ref.indexOf("/");
		if (slashIdx <= 0 || slashIdx >= ref.length - 1) continue;
		entries.push({
			type: "provider",
			provider: ref.slice(0, slashIdx),
			model: ref.slice(slashIdx + 1)
		});
	}
	return entries;
}
function hasExplicitImageUnderstandingConfig(params) {
	return (params.config?.models?.length ?? 0) > 0 || resolveImageModelFromAgentDefaults(params.cfg).length > 0;
}
async function resolveAutoEntries(params) {
	if (params.capability === "image") {
		const imageModelEntries = resolveImageModelFromAgentDefaults(params.cfg);
		if (imageModelEntries.length > 0) return imageModelEntries;
	}
	const activeEntry = await resolveActiveModelEntry(params);
	if (activeEntry) return [activeEntry];
	if (params.capability === "audio") {
		const keyEntry = await resolveKeyEntry(params);
		if (keyEntry) return [keyEntry];
		const localAudio = await resolveLocalAudioEntry();
		if (localAudio) return [localAudio];
	}
	const keys = await resolveKeyEntry(params);
	if (keys) return [keys];
	const antigravity = await resolveAntigravityCliEntry(params.capability);
	if (antigravity) return [antigravity];
	return [];
}
async function resolveAutoImageModel(params) {
	const providerRegistry = buildProviderRegistry(void 0, params.cfg);
	const toActive = (entry) => {
		if (!entry || entry.type === "cli") return null;
		const provider = entry.provider;
		const model = entry.model?.trim();
		if (!provider || !model) return null;
		return {
			provider,
			model
		};
	};
	const configuredImageModel = resolveImageModelFromAgentDefaults(params.cfg).map((entry) => toActive(entry)).find((entry) => entry !== null);
	if (configuredImageModel) return configuredImageModel;
	const resolvedActive = toActive(await resolveActiveModelEntry({
		cfg: params.cfg,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		providerRegistry,
		capability: "image",
		activeModel: params.activeModel
	}));
	if (resolvedActive) return resolvedActive;
	return toActive(await resolveKeyEntry({
		cfg: params.cfg,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		providerRegistry,
		capability: "image",
		activeModel: params.activeModel
	}));
}
async function resolveActiveModelEntry(params) {
	const activeProviderRaw = params.activeModel?.provider?.trim();
	if (!activeProviderRaw) return null;
	const providerId = normalizeMediaExecutionProviderId(activeProviderRaw);
	if (!providerId) return null;
	const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
	if (!provider) return null;
	if (params.capability === "audio" && !provider.transcribeAudio) return null;
	if (params.capability === "image" && !provider.describeImage) return null;
	if (params.capability === "video" && !provider.describeVideo) return null;
	if (!await hasProviderAuthAvailable({
		provider: providerId,
		cfg: params.cfg,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir
	})) return null;
	let model;
	if (params.capability === "image") model = await resolveAutoImageModelId({
		cfg: params.cfg,
		providerId,
		providerRegistry: params.providerRegistry,
		explicitModel: params.activeModel?.model,
		workspaceDir: params.workspaceDir
	});
	else if (params.capability === "audio") model = resolveDefaultMediaModelFromRegistry({
		providerId,
		capability: "audio",
		providerRegistry: params.providerRegistry
	});
	else model = params.activeModel?.model;
	if ((params.capability === "image" || params.capability === "audio") && !model) return null;
	return {
		type: "provider",
		provider: providerId,
		model
	};
}
async function runAttachmentEntries(params) {
	const { entries, capability } = params;
	const attempts = [];
	for (const entry of entries) {
		const entryType = entry.type ?? (entry.command ? "cli" : "provider");
		try {
			const result = entryType === "cli" ? await runCliEntry({
				capability,
				entry,
				cfg: params.cfg,
				ctx: params.ctx,
				attachmentIndex: params.attachmentIndex,
				cache: params.cache,
				config: params.config
			}) : await runProviderEntry({
				capability,
				entry,
				cfg: params.cfg,
				ctx: params.ctx,
				attachmentIndex: params.attachmentIndex,
				cache: params.cache,
				agentDir: params.agentDir,
				workspaceDir: params.workspaceDir,
				providerRegistry: params.providerRegistry,
				config: params.config
			});
			if (result) {
				const decision = buildModelDecision({
					entry,
					entryType,
					outcome: "success"
				});
				if (result.provider) decision.provider = result.provider;
				if (result.model) decision.model = result.model;
				attempts.push(decision);
				return {
					output: result,
					attempts
				};
			}
			attempts.push(buildModelDecision({
				entry,
				entryType,
				outcome: "skipped",
				reason: "empty output"
			}));
		} catch (err) {
			if (isMediaUnderstandingSkipError(err)) {
				attempts.push(buildModelDecision({
					entry,
					entryType,
					outcome: "skipped",
					reason: `${err.reason}: ${err.message}`
				}));
				if (shouldLogVerbose()) logVerbose(`Skipping ${capability} model due to ${err.reason}: ${err.message}`);
				continue;
			}
			attempts.push(buildModelDecision({
				entry,
				entryType,
				outcome: "failed",
				reason: String(err)
			}));
			if (shouldLogVerbose()) logVerbose(`${capability} understanding failed: ${String(err)}`);
		}
	}
	return {
		output: null,
		attempts
	};
}
function hasFailedMediaAttempt(attachments) {
	return attachments.some((attachment) => attachment.attempts.some((attempt) => attempt.outcome === "failed"));
}
async function runCapability(params) {
	const { capability, cfg, ctx } = params;
	const config = params.config ?? cfg.tools?.media?.[capability];
	if (config?.enabled === false) return {
		outputs: [],
		decision: {
			capability,
			outcome: "disabled",
			attachments: []
		}
	};
	const attachmentPolicy = config?.attachments;
	const selected = selectAttachments({
		capability,
		attachments: params.media,
		policy: attachmentPolicy
	});
	if (selected.length === 0) return {
		outputs: [],
		decision: {
			capability,
			outcome: "no-attachment",
			attachments: []
		}
	};
	if (resolveScopeDecision({
		scope: config?.scope,
		ctx
	}) === "deny") {
		if (shouldLogVerbose()) logVerbose(`${capability} understanding disabled by scope policy.`);
		return {
			outputs: [],
			decision: {
				capability,
				outcome: "scope-deny",
				attachments: selected.map((item) => ({
					attachmentIndex: item.index,
					attempts: []
				}))
			}
		};
	}
	const activeProvider = params.activeModel?.provider?.trim();
	if (capability === "image" && activeProvider && !isMinimaxVlmProvider(activeProvider) && !hasExplicitImageUnderstandingConfig({
		cfg,
		config
	})) {
		const { findModelInCatalog, loadModelCatalog, modelSupportsVision } = await loadModelCatalogApi();
		if (modelSupportsVision(findModelInCatalog(await loadModelCatalog({ config: cfg }), activeProvider, params.activeModel?.model ?? ""))) {
			if (shouldLogVerbose()) logVerbose("Skipping image understanding: primary model supports vision natively");
			const model = params.activeModel?.model?.trim();
			const reason = "primary model supports vision natively";
			return {
				outputs: [],
				decision: {
					capability,
					outcome: "skipped",
					attachments: selected.map((item) => {
						const attempt = {
							type: "provider",
							provider: activeProvider,
							model: model || void 0,
							outcome: "skipped",
							reason
						};
						return {
							attachmentIndex: item.index,
							attempts: [attempt],
							chosen: attempt
						};
					})
				}
			};
		}
	}
	let resolvedEntries = resolveModelEntries({
		cfg,
		capability,
		config,
		providerRegistry: params.providerRegistry
	});
	if (resolvedEntries.length === 0) resolvedEntries = await resolveAutoEntries({
		cfg,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		providerRegistry: params.providerRegistry,
		capability,
		activeModel: params.activeModel
	});
	if (resolvedEntries.length === 0) return {
		outputs: [],
		decision: {
			capability,
			outcome: "skipped",
			attachments: selected.map((item) => ({
				attachmentIndex: item.index,
				attempts: []
			}))
		}
	};
	const outputs = [];
	const attachmentDecisions = [];
	for (const attachment of selected) {
		const { output, attempts } = await runAttachmentEntries({
			capability,
			cfg,
			ctx,
			attachmentIndex: attachment.index,
			agentDir: params.agentDir,
			workspaceDir: params.workspaceDir,
			providerRegistry: params.providerRegistry,
			cache: params.attachments,
			entries: resolvedEntries,
			config
		});
		if (output) outputs.push(output);
		attachmentDecisions.push({
			attachmentIndex: attachment.index,
			attempts,
			chosen: attempts.find((attempt) => attempt.outcome === "success")
		});
	}
	const decision = {
		capability,
		outcome: outputs.length > 0 ? "success" : hasFailedMediaAttempt(attachmentDecisions) ? "failed" : "skipped",
		attachments: attachmentDecisions
	};
	if (decision.outcome === "failed") logWarn(`media-understanding: ${formatDecisionSummary(decision)}`);
	else if (shouldLogVerbose()) logVerbose(`Media understanding ${formatDecisionSummary(decision)}`);
	return {
		outputs,
		decision
	};
}
//#endregion
export { runCapability as a, MediaAttachmentCache as c, resolveAttachmentKind as d, resolveMediaAttachmentLocalRoots as i, isAudioAttachment as l, clearMediaUnderstandingBinaryCacheForTests as n, createMediaAttachmentCache as o, resolveAutoImageModel as r, normalizeMediaAttachments as s, buildProviderRegistry as t, normalizeAttachments as u };
