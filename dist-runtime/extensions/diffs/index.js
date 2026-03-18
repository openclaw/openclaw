import { r as __exportAll } from "../../chunk-DORXReHP.js";
import { n as init_tmp_openclaw_dir, r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-DgEKZnX6.js";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs$1 from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { chromium } from "playwright-core";
//#region src/plugin-sdk/diffs.ts
init_tmp_openclaw_dir();
//#endregion
//#region extensions/diffs/src/types.ts
const DIFF_LAYOUTS = ["unified", "split"];
const DIFF_MODES = [
	"view",
	"image",
	"file",
	"both"
];
const DIFF_THEMES = ["light", "dark"];
const DIFF_INDICATORS = [
	"bars",
	"classic",
	"none"
];
const DIFF_IMAGE_QUALITY_PRESETS = [
	"standard",
	"hq",
	"print"
];
const DIFF_OUTPUT_FORMATS = ["png", "pdf"];
const DIFF_ARTIFACT_ID_PATTERN = /^[0-9a-f]{20}$/;
const DIFF_ARTIFACT_TOKEN_PATTERN = /^[0-9a-f]{48}$/;
//#endregion
//#region extensions/diffs/src/config.ts
const DEFAULT_IMAGE_QUALITY_PROFILES = {
	standard: {
		scale: 2,
		maxWidth: 960,
		maxPixels: 8e6
	},
	hq: {
		scale: 2.5,
		maxWidth: 1200,
		maxPixels: 14e6
	},
	print: {
		scale: 3,
		maxWidth: 1400,
		maxPixels: 24e6
	}
};
const DEFAULT_DIFFS_TOOL_DEFAULTS = {
	fontFamily: "Fira Code",
	fontSize: 15,
	lineSpacing: 1.6,
	layout: "unified",
	showLineNumbers: true,
	diffIndicators: "bars",
	wordWrap: true,
	background: true,
	theme: "dark",
	fileFormat: "png",
	fileQuality: "standard",
	fileScale: DEFAULT_IMAGE_QUALITY_PROFILES.standard.scale,
	fileMaxWidth: DEFAULT_IMAGE_QUALITY_PROFILES.standard.maxWidth,
	mode: "both"
};
const DEFAULT_DIFFS_PLUGIN_SECURITY = { allowRemoteViewer: false };
const diffsPluginConfigSchema = {
	safeParse(value) {
		if (value === void 0) return {
			success: true,
			data: void 0
		};
		try {
			return {
				success: true,
				data: resolveDiffsPluginDefaults(value)
			};
		} catch (error) {
			return {
				success: false,
				error: { issues: [{
					path: [],
					message: error instanceof Error ? error.message : String(error)
				}] }
			};
		}
	},
	jsonSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			defaults: {
				type: "object",
				additionalProperties: false,
				properties: {
					fontFamily: {
						type: "string",
						default: DEFAULT_DIFFS_TOOL_DEFAULTS.fontFamily
					},
					fontSize: {
						type: "number",
						minimum: 10,
						maximum: 24,
						default: DEFAULT_DIFFS_TOOL_DEFAULTS.fontSize
					},
					lineSpacing: {
						type: "number",
						minimum: 1,
						maximum: 3,
						default: DEFAULT_DIFFS_TOOL_DEFAULTS.lineSpacing
					},
					layout: {
						type: "string",
						enum: [...DIFF_LAYOUTS],
						default: DEFAULT_DIFFS_TOOL_DEFAULTS.layout
					},
					showLineNumbers: {
						type: "boolean",
						default: DEFAULT_DIFFS_TOOL_DEFAULTS.showLineNumbers
					},
					diffIndicators: {
						type: "string",
						enum: [...DIFF_INDICATORS],
						default: DEFAULT_DIFFS_TOOL_DEFAULTS.diffIndicators
					},
					wordWrap: {
						type: "boolean",
						default: DEFAULT_DIFFS_TOOL_DEFAULTS.wordWrap
					},
					background: {
						type: "boolean",
						default: DEFAULT_DIFFS_TOOL_DEFAULTS.background
					},
					theme: {
						type: "string",
						enum: [...DIFF_THEMES],
						default: DEFAULT_DIFFS_TOOL_DEFAULTS.theme
					},
					fileFormat: {
						type: "string",
						enum: [...DIFF_OUTPUT_FORMATS],
						default: DEFAULT_DIFFS_TOOL_DEFAULTS.fileFormat
					},
					format: {
						type: "string",
						enum: [...DIFF_OUTPUT_FORMATS]
					},
					fileQuality: {
						type: "string",
						enum: [...DIFF_IMAGE_QUALITY_PRESETS],
						default: DEFAULT_DIFFS_TOOL_DEFAULTS.fileQuality
					},
					fileScale: {
						type: "number",
						minimum: 1,
						maximum: 4,
						default: DEFAULT_DIFFS_TOOL_DEFAULTS.fileScale
					},
					fileMaxWidth: {
						type: "number",
						minimum: 640,
						maximum: 2400,
						default: DEFAULT_DIFFS_TOOL_DEFAULTS.fileMaxWidth
					},
					imageFormat: {
						type: "string",
						enum: [...DIFF_OUTPUT_FORMATS]
					},
					imageQuality: {
						type: "string",
						enum: [...DIFF_IMAGE_QUALITY_PRESETS]
					},
					imageScale: {
						type: "number",
						minimum: 1,
						maximum: 4
					},
					imageMaxWidth: {
						type: "number",
						minimum: 640,
						maximum: 2400
					},
					mode: {
						type: "string",
						enum: [...DIFF_MODES],
						default: DEFAULT_DIFFS_TOOL_DEFAULTS.mode
					}
				}
			},
			security: {
				type: "object",
				additionalProperties: false,
				properties: { allowRemoteViewer: {
					type: "boolean",
					default: DEFAULT_DIFFS_PLUGIN_SECURITY.allowRemoteViewer
				} }
			}
		}
	}
};
function resolveDiffsPluginDefaults(config) {
	if (!config || typeof config !== "object" || Array.isArray(config)) return { ...DEFAULT_DIFFS_TOOL_DEFAULTS };
	const defaults = config.defaults;
	if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) return { ...DEFAULT_DIFFS_TOOL_DEFAULTS };
	const fileQuality = normalizeFileQuality$1(defaults.fileQuality ?? defaults.imageQuality);
	const profile = DEFAULT_IMAGE_QUALITY_PROFILES[fileQuality];
	return {
		fontFamily: normalizeFontFamily(defaults.fontFamily),
		fontSize: normalizeFontSize(defaults.fontSize),
		lineSpacing: normalizeLineSpacing(defaults.lineSpacing),
		layout: normalizeLayout$1(defaults.layout),
		showLineNumbers: defaults.showLineNumbers !== false,
		diffIndicators: normalizeDiffIndicators(defaults.diffIndicators),
		wordWrap: defaults.wordWrap !== false,
		background: defaults.background !== false,
		theme: normalizeTheme$2(defaults.theme),
		fileFormat: normalizeFileFormat(defaults.fileFormat ?? defaults.imageFormat ?? defaults.format),
		fileQuality,
		fileScale: normalizeFileScale(defaults.fileScale ?? defaults.imageScale, profile.scale),
		fileMaxWidth: normalizeFileMaxWidth(defaults.fileMaxWidth ?? defaults.imageMaxWidth, profile.maxWidth),
		mode: normalizeMode$1(defaults.mode)
	};
}
function resolveDiffsPluginSecurity(config) {
	if (!config || typeof config !== "object" || Array.isArray(config)) return { ...DEFAULT_DIFFS_PLUGIN_SECURITY };
	const security = config.security;
	if (!security || typeof security !== "object" || Array.isArray(security)) return { ...DEFAULT_DIFFS_PLUGIN_SECURITY };
	return { allowRemoteViewer: security.allowRemoteViewer === true };
}
function normalizeFontFamily(fontFamily) {
	return fontFamily?.trim() || DEFAULT_DIFFS_TOOL_DEFAULTS.fontFamily;
}
function normalizeFontSize(fontSize) {
	if (fontSize === void 0 || !Number.isFinite(fontSize)) return DEFAULT_DIFFS_TOOL_DEFAULTS.fontSize;
	const rounded = Math.floor(fontSize);
	return Math.min(Math.max(rounded, 10), 24);
}
function normalizeLineSpacing(lineSpacing) {
	if (lineSpacing === void 0 || !Number.isFinite(lineSpacing)) return DEFAULT_DIFFS_TOOL_DEFAULTS.lineSpacing;
	return Math.min(Math.max(lineSpacing, 1), 3);
}
function normalizeLayout$1(layout) {
	return layout && DIFF_LAYOUTS.includes(layout) ? layout : DEFAULT_DIFFS_TOOL_DEFAULTS.layout;
}
function normalizeDiffIndicators(diffIndicators) {
	return diffIndicators && DIFF_INDICATORS.includes(diffIndicators) ? diffIndicators : DEFAULT_DIFFS_TOOL_DEFAULTS.diffIndicators;
}
function normalizeTheme$2(theme) {
	return theme && DIFF_THEMES.includes(theme) ? theme : DEFAULT_DIFFS_TOOL_DEFAULTS.theme;
}
function normalizeFileFormat(fileFormat) {
	return fileFormat && DIFF_OUTPUT_FORMATS.includes(fileFormat) ? fileFormat : DEFAULT_DIFFS_TOOL_DEFAULTS.fileFormat;
}
function normalizeFileQuality$1(fileQuality) {
	return fileQuality && DIFF_IMAGE_QUALITY_PRESETS.includes(fileQuality) ? fileQuality : DEFAULT_DIFFS_TOOL_DEFAULTS.fileQuality;
}
function normalizeFileScale(fileScale, fallback) {
	if (fileScale === void 0 || !Number.isFinite(fileScale)) return fallback;
	const rounded = Math.round(fileScale * 100) / 100;
	return Math.min(Math.max(rounded, 1), 4);
}
function normalizeFileMaxWidth(fileMaxWidth, fallback) {
	if (fileMaxWidth === void 0 || !Number.isFinite(fileMaxWidth)) return fallback;
	const rounded = Math.round(fileMaxWidth);
	return Math.min(Math.max(rounded, 640), 2400);
}
function normalizeMode$1(mode) {
	return mode && DIFF_MODES.includes(mode) ? mode : DEFAULT_DIFFS_TOOL_DEFAULTS.mode;
}
function resolveDiffImageRenderOptions(params) {
	const format = normalizeFileFormat(params.fileFormat ?? params.imageFormat ?? params.format ?? params.defaults.fileFormat);
	const qualityOverrideProvided = params.fileQuality !== void 0 || params.imageQuality !== void 0;
	const qualityPreset = normalizeFileQuality$1(params.fileQuality ?? params.imageQuality ?? params.defaults.fileQuality);
	const profile = DEFAULT_IMAGE_QUALITY_PROFILES[qualityPreset];
	return {
		format,
		qualityPreset,
		scale: normalizeFileScale(params.fileScale ?? params.imageScale, qualityOverrideProvided ? profile.scale : params.defaults.fileScale),
		maxWidth: normalizeFileMaxWidth(params.fileMaxWidth ?? params.imageMaxWidth, qualityOverrideProvided ? profile.maxWidth : params.defaults.fileMaxWidth),
		maxPixels: profile.maxPixels
	};
}
//#endregion
//#region extensions/diffs/src/viewer-assets.ts
const VIEWER_ASSET_PREFIX = "/plugins/diffs/assets/";
const VIEWER_LOADER_PATH = `${VIEWER_ASSET_PREFIX}viewer.js`;
const VIEWER_RUNTIME_PATH = `${VIEWER_ASSET_PREFIX}viewer-runtime.js`;
const VIEWER_RUNTIME_FILE_URL = new URL("../assets/viewer-runtime.js", import.meta.url);
let runtimeAssetCache = null;
async function getServedViewerAsset(pathname) {
	if (pathname !== VIEWER_LOADER_PATH && pathname !== VIEWER_RUNTIME_PATH) return null;
	const assets = await loadViewerAssets();
	if (pathname === VIEWER_LOADER_PATH) return {
		body: assets.loaderBody,
		contentType: "text/javascript; charset=utf-8"
	};
	if (pathname === VIEWER_RUNTIME_PATH) return {
		body: assets.runtimeBody,
		contentType: "text/javascript; charset=utf-8"
	};
	return null;
}
async function loadViewerAssets() {
	const runtimePath = fileURLToPath(VIEWER_RUNTIME_FILE_URL);
	const runtimeStat = await fs$1.stat(runtimePath);
	if (runtimeAssetCache && runtimeAssetCache.mtimeMs === runtimeStat.mtimeMs) return runtimeAssetCache;
	const runtimeBody = await fs$1.readFile(runtimePath);
	const hash = crypto.createHash("sha1").update(runtimeBody).digest("hex").slice(0, 12);
	runtimeAssetCache = {
		mtimeMs: runtimeStat.mtimeMs,
		runtimeBody,
		loaderBody: `import "${VIEWER_RUNTIME_PATH}?v=${hash}";\n`
	};
	return runtimeAssetCache;
}
//#endregion
//#region extensions/diffs/src/http.ts
const VIEW_PREFIX = "/plugins/diffs/view/";
const VIEWER_MAX_FAILURES_PER_WINDOW = 40;
const VIEWER_FAILURE_WINDOW_MS = 6e4;
const VIEWER_LOCKOUT_MS = 6e4;
const VIEWER_LIMITER_MAX_KEYS = 2048;
const VIEWER_CONTENT_SECURITY_POLICY = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self' data:",
	"connect-src 'none'",
	"base-uri 'none'",
	"frame-ancestors 'self'",
	"object-src 'none'"
].join("; ");
function createDiffsHttpHandler(params) {
	const viewerFailureLimiter = new ViewerFailureLimiter();
	return async (req, res) => {
		const parsed = parseRequestUrl(req.url);
		if (!parsed) return false;
		if (parsed.pathname.startsWith("/plugins/diffs/assets/")) return await serveAsset(req, res, parsed.pathname, params.logger);
		if (!parsed.pathname.startsWith(VIEW_PREFIX)) return false;
		const access = resolveViewerAccess(req);
		if (!access.localRequest && params.allowRemoteViewer !== true) {
			respondText(res, 404, "Diff not found");
			return true;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			respondText(res, 405, "Method not allowed");
			return true;
		}
		if (!access.localRequest) {
			const throttled = viewerFailureLimiter.check(access.remoteKey);
			if (!throttled.allowed) {
				res.statusCode = 429;
				setSharedHeaders(res, "text/plain; charset=utf-8");
				res.setHeader("Retry-After", String(Math.max(1, Math.ceil(throttled.retryAfterMs / 1e3))));
				res.end("Too Many Requests");
				return true;
			}
		}
		const pathParts = parsed.pathname.split("/").filter(Boolean);
		const id = pathParts[3];
		const token = pathParts[4];
		if (!id || !token || !DIFF_ARTIFACT_ID_PATTERN.test(id) || !DIFF_ARTIFACT_TOKEN_PATTERN.test(token)) {
			recordRemoteFailure(viewerFailureLimiter, access);
			respondText(res, 404, "Diff not found");
			return true;
		}
		if (!await params.store.getArtifact(id, token)) {
			recordRemoteFailure(viewerFailureLimiter, access);
			respondText(res, 404, "Diff not found or expired");
			return true;
		}
		try {
			const html = await params.store.readHtml(id);
			resetRemoteFailures(viewerFailureLimiter, access);
			res.statusCode = 200;
			setSharedHeaders(res, "text/html; charset=utf-8");
			res.setHeader("content-security-policy", VIEWER_CONTENT_SECURITY_POLICY);
			if (req.method === "HEAD") res.end();
			else res.end(html);
			return true;
		} catch (error) {
			recordRemoteFailure(viewerFailureLimiter, access);
			params.logger?.warn(`Failed to serve diff artifact ${id}: ${String(error)}`);
			respondText(res, 500, "Failed to load diff");
			return true;
		}
	};
}
function parseRequestUrl(rawUrl) {
	if (!rawUrl) return null;
	try {
		return new URL(rawUrl, "http://127.0.0.1");
	} catch {
		return null;
	}
}
async function serveAsset(req, res, pathname, logger) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		respondText(res, 405, "Method not allowed");
		return true;
	}
	try {
		const asset = await getServedViewerAsset(pathname);
		if (!asset) {
			respondText(res, 404, "Asset not found");
			return true;
		}
		res.statusCode = 200;
		setSharedHeaders(res, asset.contentType);
		if (req.method === "HEAD") res.end();
		else res.end(asset.body);
		return true;
	} catch (error) {
		logger?.warn(`Failed to serve diffs asset ${pathname}: ${String(error)}`);
		respondText(res, 500, "Failed to load asset");
		return true;
	}
}
function respondText(res, statusCode, body) {
	res.statusCode = statusCode;
	setSharedHeaders(res, "text/plain; charset=utf-8");
	res.end(body);
}
function setSharedHeaders(res, contentType) {
	res.setHeader("cache-control", "no-store, max-age=0");
	res.setHeader("content-type", contentType);
	res.setHeader("x-content-type-options", "nosniff");
	res.setHeader("referrer-policy", "no-referrer");
}
function normalizeRemoteClientKey(remoteAddress) {
	const normalized = remoteAddress?.trim().toLowerCase();
	if (!normalized) return "unknown";
	return normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
}
function isLoopbackClientIp(clientIp) {
	return clientIp === "127.0.0.1" || clientIp === "::1";
}
function hasProxyForwardingHints(req) {
	const headers = req.headers ?? {};
	return Boolean(headers["x-forwarded-for"] || headers["x-real-ip"] || headers.forwarded || headers["x-forwarded-host"] || headers["x-forwarded-proto"]);
}
function resolveViewerAccess(req) {
	const remoteKey = normalizeRemoteClientKey(req.socket?.remoteAddress);
	return {
		remoteKey,
		localRequest: isLoopbackClientIp(remoteKey) && !hasProxyForwardingHints(req)
	};
}
function recordRemoteFailure(limiter, access) {
	if (!access.localRequest) limiter.recordFailure(access.remoteKey);
}
function resetRemoteFailures(limiter, access) {
	if (!access.localRequest) limiter.reset(access.remoteKey);
}
var ViewerFailureLimiter = class {
	constructor() {
		this.failures = /* @__PURE__ */ new Map();
	}
	check(key) {
		this.prune();
		const state = this.failures.get(key);
		if (!state) return {
			allowed: true,
			retryAfterMs: 0
		};
		const now = Date.now();
		if (state.lockUntilMs > now) return {
			allowed: false,
			retryAfterMs: state.lockUntilMs - now
		};
		if (now - state.windowStartMs >= VIEWER_FAILURE_WINDOW_MS) {
			this.failures.delete(key);
			return {
				allowed: true,
				retryAfterMs: 0
			};
		}
		return {
			allowed: true,
			retryAfterMs: 0
		};
	}
	recordFailure(key) {
		this.prune();
		const now = Date.now();
		const current = this.failures.get(key);
		const next = !current || now - current.windowStartMs >= VIEWER_FAILURE_WINDOW_MS ? {
			windowStartMs: now,
			failures: 1,
			lockUntilMs: 0
		} : {
			...current,
			failures: current.failures + 1
		};
		if (next.failures >= VIEWER_MAX_FAILURES_PER_WINDOW) next.lockUntilMs = now + VIEWER_LOCKOUT_MS;
		this.failures.set(key, next);
	}
	reset(key) {
		this.failures.delete(key);
	}
	prune() {
		if (this.failures.size < VIEWER_LIMITER_MAX_KEYS) return;
		const now = Date.now();
		for (const [key, state] of this.failures) {
			if (state.lockUntilMs <= now && now - state.windowStartMs >= VIEWER_FAILURE_WINDOW_MS) this.failures.delete(key);
			if (this.failures.size < VIEWER_LIMITER_MAX_KEYS) return;
		}
		if (this.failures.size >= VIEWER_LIMITER_MAX_KEYS) this.failures.clear();
	}
};
//#endregion
//#region extensions/diffs/src/prompt-guidance.ts
const DIFFS_AGENT_GUIDANCE = [
	"When you need to show edits as a real diff, prefer the `diffs` tool instead of writing a manual summary.",
	"It accepts either `before` + `after` text or a unified `patch`.",
	"`mode=view` returns `details.viewerUrl` for canvas use; `mode=file` returns `details.filePath`; `mode=both` returns both.",
	"If you need to send the rendered file, use the `message` tool with `path` or `filePath`.",
	"Include `path` when you know the filename, and omit presentation overrides unless needed."
].join("\n");
//#endregion
//#region extensions/diffs/src/store.ts
const DEFAULT_TTL_MS = 1800 * 1e3;
const MAX_TTL_MS = 360 * 60 * 1e3;
const SWEEP_FALLBACK_AGE_MS = 1440 * 60 * 1e3;
const DEFAULT_CLEANUP_INTERVAL_MS = 300 * 1e3;
const VIEWER_PREFIX = "/plugins/diffs/view";
var DiffArtifactStore = class {
	constructor(params) {
		this.cleanupInFlight = null;
		this.nextCleanupAt = 0;
		this.rootDir = path.resolve(params.rootDir);
		this.logger = params.logger;
		this.cleanupIntervalMs = params.cleanupIntervalMs === void 0 ? DEFAULT_CLEANUP_INTERVAL_MS : Math.max(0, Math.floor(params.cleanupIntervalMs));
	}
	async createArtifact(params) {
		await this.ensureRoot();
		const id = crypto.randomBytes(10).toString("hex");
		const token = crypto.randomBytes(24).toString("hex");
		const artifactDir = this.artifactDir(id);
		const htmlPath = path.join(artifactDir, "viewer.html");
		const ttlMs = normalizeTtlMs$1(params.ttlMs);
		const createdAt = /* @__PURE__ */ new Date();
		const expiresAt = new Date(createdAt.getTime() + ttlMs);
		const meta = {
			id,
			token,
			title: params.title,
			inputKind: params.inputKind,
			fileCount: params.fileCount,
			createdAt: createdAt.toISOString(),
			expiresAt: expiresAt.toISOString(),
			viewerPath: `${VIEWER_PREFIX}/${id}/${token}`,
			htmlPath
		};
		await fs$1.mkdir(artifactDir, { recursive: true });
		await fs$1.writeFile(htmlPath, params.html, "utf8");
		await this.writeMeta(meta);
		this.scheduleCleanup();
		return meta;
	}
	async getArtifact(id, token) {
		const meta = await this.readMeta(id);
		if (!meta) return null;
		if (meta.token !== token) return null;
		if (isExpired(meta)) {
			await this.deleteArtifact(id);
			return null;
		}
		return meta;
	}
	async readHtml(id) {
		const meta = await this.readMeta(id);
		if (!meta) throw new Error(`Diff artifact not found: ${id}`);
		const htmlPath = this.normalizeStoredPath(meta.htmlPath, "htmlPath");
		return await fs$1.readFile(htmlPath, "utf8");
	}
	async updateFilePath(id, filePath) {
		const meta = await this.readMeta(id);
		if (!meta) throw new Error(`Diff artifact not found: ${id}`);
		const normalizedFilePath = this.normalizeStoredPath(filePath, "filePath");
		const next = {
			...meta,
			filePath: normalizedFilePath,
			imagePath: normalizedFilePath
		};
		await this.writeMeta(next);
		return next;
	}
	async updateImagePath(id, imagePath) {
		return this.updateFilePath(id, imagePath);
	}
	allocateFilePath(id, format = "png") {
		return path.join(this.artifactDir(id), `preview.${format}`);
	}
	async createStandaloneFileArtifact(params = {}) {
		await this.ensureRoot();
		const id = crypto.randomBytes(10).toString("hex");
		const artifactDir = this.artifactDir(id);
		const format = params.format ?? "png";
		const filePath = path.join(artifactDir, `preview.${format}`);
		const ttlMs = normalizeTtlMs$1(params.ttlMs);
		const createdAt = /* @__PURE__ */ new Date();
		const expiresAt = new Date(createdAt.getTime() + ttlMs).toISOString();
		const meta = {
			kind: "standalone_file",
			id,
			createdAt: createdAt.toISOString(),
			expiresAt,
			filePath: this.normalizeStoredPath(filePath, "filePath")
		};
		await fs$1.mkdir(artifactDir, { recursive: true });
		await this.writeStandaloneMeta(meta);
		this.scheduleCleanup();
		return {
			id,
			filePath: meta.filePath,
			expiresAt: meta.expiresAt
		};
	}
	allocateImagePath(id, format = "png") {
		return this.allocateFilePath(id, format);
	}
	scheduleCleanup() {
		this.maybeCleanupExpired();
	}
	async cleanupExpired() {
		await this.ensureRoot();
		const entries = await fs$1.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
		const now = Date.now();
		await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
			const id = entry.name;
			const meta = await this.readMeta(id);
			if (meta) {
				if (isExpired(meta)) await this.deleteArtifact(id);
				return;
			}
			const standaloneMeta = await this.readStandaloneMeta(id);
			if (standaloneMeta) {
				if (isExpired(standaloneMeta)) await this.deleteArtifact(id);
				return;
			}
			const artifactPath = this.artifactDir(id);
			const stat = await fs$1.stat(artifactPath).catch(() => null);
			if (!stat) return;
			if (now - stat.mtimeMs > SWEEP_FALLBACK_AGE_MS) await this.deleteArtifact(id);
		}));
	}
	async ensureRoot() {
		await fs$1.mkdir(this.rootDir, { recursive: true });
	}
	maybeCleanupExpired() {
		const now = Date.now();
		if (this.cleanupInFlight || now < this.nextCleanupAt) return;
		this.nextCleanupAt = now + this.cleanupIntervalMs;
		const cleanupPromise = this.cleanupExpired().catch((error) => {
			this.nextCleanupAt = 0;
			this.logger?.warn(`Failed to clean expired diff artifacts: ${String(error)}`);
		}).finally(() => {
			if (this.cleanupInFlight === cleanupPromise) this.cleanupInFlight = null;
		});
		this.cleanupInFlight = cleanupPromise;
	}
	artifactDir(id) {
		return this.resolveWithinRoot(id);
	}
	async writeMeta(meta) {
		await this.writeJsonMeta(meta.id, "meta.json", meta);
	}
	async readMeta(id) {
		const parsed = await this.readJsonMeta(id, "meta.json", "diff artifact");
		if (!parsed) return null;
		return parsed;
	}
	async writeStandaloneMeta(meta) {
		await this.writeJsonMeta(meta.id, "file-meta.json", meta);
	}
	async readStandaloneMeta(id) {
		const parsed = await this.readJsonMeta(id, "file-meta.json", "standalone diff");
		if (!parsed) return null;
		try {
			const value = parsed;
			if (value.kind !== "standalone_file" || typeof value.id !== "string" || typeof value.createdAt !== "string" || typeof value.expiresAt !== "string" || typeof value.filePath !== "string") return null;
			return {
				kind: value.kind,
				id: value.id,
				createdAt: value.createdAt,
				expiresAt: value.expiresAt,
				filePath: this.normalizeStoredPath(value.filePath, "filePath")
			};
		} catch (error) {
			this.logger?.warn(`Failed to normalize standalone diff metadata for ${id}: ${String(error)}`);
			return null;
		}
	}
	metaFilePath(id, fileName) {
		return path.join(this.artifactDir(id), fileName);
	}
	async writeJsonMeta(id, fileName, data) {
		await fs$1.writeFile(this.metaFilePath(id, fileName), JSON.stringify(data, null, 2), "utf8");
	}
	async readJsonMeta(id, fileName, context) {
		try {
			const raw = await fs$1.readFile(this.metaFilePath(id, fileName), "utf8");
			return JSON.parse(raw);
		} catch (error) {
			if (isFileNotFound(error)) return null;
			this.logger?.warn(`Failed to read ${context} metadata for ${id}: ${String(error)}`);
			return null;
		}
	}
	async deleteArtifact(id) {
		await fs$1.rm(this.artifactDir(id), {
			recursive: true,
			force: true
		}).catch(() => {});
	}
	resolveWithinRoot(...parts) {
		const candidate = path.resolve(this.rootDir, ...parts);
		this.assertWithinRoot(candidate);
		return candidate;
	}
	normalizeStoredPath(rawPath, label) {
		const candidate = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(this.rootDir, rawPath);
		this.assertWithinRoot(candidate, label);
		return candidate;
	}
	assertWithinRoot(candidate, label = "path") {
		const relative = path.relative(this.rootDir, candidate);
		if (relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) return;
		throw new Error(`Diff artifact ${label} escapes store root: ${candidate}`);
	}
};
function normalizeTtlMs$1(value) {
	if (!Number.isFinite(value) || value === void 0) return DEFAULT_TTL_MS;
	const rounded = Math.floor(value);
	if (rounded <= 0) return DEFAULT_TTL_MS;
	return Math.min(rounded, MAX_TTL_MS);
}
function isExpired(meta) {
	const expiresAt = Date.parse(meta.expiresAt);
	if (!Number.isFinite(expiresAt)) return true;
	return Date.now() >= expiresAt;
}
function isFileNotFound(error) {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
//#endregion
//#region extensions/diffs/src/browser.ts
const DEFAULT_BROWSER_IDLE_MS = 3e4;
const SHARED_BROWSER_KEY = "__default__";
const IMAGE_SIZE_LIMIT_ERROR = "Diff frame did not render within image size limits.";
const PDF_REFERENCE_PAGE_HEIGHT_PX = 1056;
const MAX_PDF_PAGES = 50;
let sharedBrowserState = null;
let executablePathCache = null;
var PlaywrightDiffScreenshotter = class {
	constructor(params) {
		this.config = params.config;
		this.browserIdleMs = params.browserIdleMs ?? DEFAULT_BROWSER_IDLE_MS;
	}
	async screenshotHtml(params) {
		await fs$1.mkdir(path.dirname(params.outputPath), { recursive: true });
		const lease = await acquireSharedBrowser({
			config: this.config,
			idleMs: this.browserIdleMs
		});
		let page;
		let currentScale = params.image.scale;
		const maxRetries = 2;
		try {
			for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
				page = await lease.browser.newPage({
					viewport: {
						width: Math.max(Math.ceil(params.image.maxWidth + 240), 1200),
						height: 900
					},
					deviceScaleFactor: currentScale,
					colorScheme: params.theme
				});
				await page.route("**/*", async (route) => {
					const requestUrl = route.request().url();
					if (requestUrl === "about:blank" || requestUrl.startsWith("data:")) {
						await route.continue();
						return;
					}
					let parsed;
					try {
						parsed = new URL(requestUrl);
					} catch {
						await route.abort();
						return;
					}
					if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
						await route.abort();
						return;
					}
					if (!parsed.pathname.startsWith("/plugins/diffs/assets/")) {
						await route.abort();
						return;
					}
					const pathname = parsed.pathname;
					const asset = await getServedViewerAsset(pathname);
					if (!asset) {
						await route.abort();
						return;
					}
					await route.fulfill({
						status: 200,
						contentType: asset.contentType,
						body: asset.body
					});
				});
				await page.setContent(injectBaseHref(params.html), { waitUntil: "load" });
				await page.waitForFunction(() => {
					if (document.documentElement.dataset.openclawDiffsReady === "true") return true;
					return [...document.querySelectorAll("[data-openclaw-diff-host]")].every((element) => {
						return element instanceof HTMLElement && element.shadowRoot?.querySelector("[data-diffs]");
					});
				}, { timeout: 1e4 });
				await page.evaluate(async () => {
					await document.fonts.ready;
				});
				await page.evaluate(() => {
					const frame = document.querySelector(".oc-frame");
					if (frame instanceof HTMLElement) frame.dataset.renderMode = "image";
				});
				const frame = page.locator(".oc-frame");
				await frame.waitFor();
				const initialBox = await frame.boundingBox();
				if (!initialBox) throw new Error("Diff frame did not render.");
				const isPdf = params.image.format === "pdf";
				const padding = isPdf ? 0 : 20;
				const clipWidth = Math.ceil(initialBox.width + padding * 2);
				const clipHeight = Math.ceil(Math.max(initialBox.height + padding * 2, 320));
				await page.setViewportSize({
					width: Math.max(clipWidth + padding, 900),
					height: Math.max(clipHeight + padding, 700)
				});
				const box = await frame.boundingBox();
				if (!box) throw new Error("Diff frame was lost after resizing.");
				if (isPdf) {
					await page.emulateMedia({ media: "screen" });
					await page.evaluate(() => {
						const html = document.documentElement;
						const body = document.body;
						const frame = document.querySelector(".oc-frame");
						html.style.background = "transparent";
						body.style.margin = "0";
						body.style.padding = "0";
						body.style.background = "transparent";
						body.style.setProperty("-webkit-print-color-adjust", "exact");
						if (frame instanceof HTMLElement) frame.style.margin = "0";
					});
					const pdfBox = await frame.boundingBox();
					if (!pdfBox) throw new Error("Diff frame was lost before PDF render.");
					const pdfWidth = Math.max(Math.ceil(pdfBox.width), 1);
					const pdfHeight = Math.max(Math.ceil(pdfBox.height), 1);
					const estimatedPixels = pdfWidth * pdfHeight;
					const estimatedPages = Math.ceil(pdfHeight / PDF_REFERENCE_PAGE_HEIGHT_PX);
					if (estimatedPixels > params.image.maxPixels || estimatedPages > MAX_PDF_PAGES) throw new Error(IMAGE_SIZE_LIMIT_ERROR);
					await page.pdf({
						path: params.outputPath,
						width: `${pdfWidth}px`,
						height: `${pdfHeight}px`,
						printBackground: true,
						margin: {
							top: "0",
							right: "0",
							bottom: "0",
							left: "0"
						}
					});
					return params.outputPath;
				}
				const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
				const rawX = Math.max(box.x - padding, 0);
				const rawY = Math.max(box.y - padding, 0);
				const rawRight = rawX + clipWidth;
				const rawBottom = rawY + clipHeight;
				const x = Math.floor(rawX * dpr) / dpr;
				const y = Math.floor(rawY * dpr) / dpr;
				const right = Math.ceil(rawRight * dpr) / dpr;
				const bottom = Math.ceil(rawBottom * dpr) / dpr;
				const cssWidth = Math.max(right - x, 1);
				const cssHeight = Math.max(bottom - y, 1);
				if (cssWidth * cssHeight * dpr * dpr > params.image.maxPixels) {
					if (currentScale > 1) {
						const maxScaleForPixels = Math.sqrt(params.image.maxPixels / (cssWidth * cssHeight));
						const reducedScale = Math.max(1, Math.round(Math.min(currentScale, maxScaleForPixels) * 100) / 100);
						if (reducedScale < currentScale - .01 && attempt < maxRetries) {
							await page.close().catch(() => {});
							page = void 0;
							currentScale = reducedScale;
							continue;
						}
					}
					throw new Error(IMAGE_SIZE_LIMIT_ERROR);
				}
				await page.screenshot({
					path: params.outputPath,
					type: "png",
					scale: "device",
					clip: {
						x,
						y,
						width: cssWidth,
						height: cssHeight
					}
				});
				return params.outputPath;
			}
			throw new Error(IMAGE_SIZE_LIMIT_ERROR);
		} catch (error) {
			if (error instanceof Error && error.message === IMAGE_SIZE_LIMIT_ERROR) throw error;
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Diff PNG/PDF rendering requires a Chromium-compatible browser. Set browser.executablePath or install Chrome/Chromium. ${reason}`);
		} finally {
			await page?.close().catch(() => {});
			await lease.release();
		}
	}
};
function injectBaseHref(html) {
	if (html.includes("<base ")) return html;
	return html.replace("<head>", "<head><base href=\"http://127.0.0.1/\" />");
}
async function resolveBrowserExecutablePath(config) {
	const cacheKey = JSON.stringify({
		configPath: config.browser?.executablePath?.trim() || "",
		env: [
			process.env.OPENCLAW_BROWSER_EXECUTABLE_PATH ?? "",
			process.env.BROWSER_EXECUTABLE_PATH ?? "",
			process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? ""
		],
		path: process.env.PATH ?? ""
	});
	if (executablePathCache?.key === cacheKey) return await executablePathCache.valuePromise;
	const valuePromise = resolveBrowserExecutablePathUncached(config).catch((error) => {
		if (executablePathCache?.valuePromise === valuePromise) executablePathCache = null;
		throw error;
	});
	executablePathCache = {
		key: cacheKey,
		valuePromise
	};
	return await valuePromise;
}
async function resolveBrowserExecutablePathUncached(config) {
	const configPath = config.browser?.executablePath?.trim();
	if (configPath) {
		await assertExecutable(configPath, "browser.executablePath");
		return configPath;
	}
	const envCandidates = [
		process.env.OPENCLAW_BROWSER_EXECUTABLE_PATH,
		process.env.BROWSER_EXECUTABLE_PATH,
		process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
	].map((value) => value?.trim()).filter((value) => Boolean(value));
	for (const candidate of envCandidates) if (await isExecutable(candidate)) return candidate;
	for (const candidate of await collectExecutableCandidates()) if (await isExecutable(candidate)) return candidate;
}
async function acquireSharedBrowser(params) {
	const executablePath = await resolveBrowserExecutablePath(params.config);
	const desiredKey = executablePath || SHARED_BROWSER_KEY;
	if (sharedBrowserState && sharedBrowserState.key !== desiredKey) await closeSharedBrowser();
	if (!sharedBrowserState) {
		const browserPromise = chromium.launch({
			headless: true,
			...executablePath ? { executablePath } : {},
			args: ["--disable-dev-shm-usage"]
		}).then((browser) => {
			if (sharedBrowserState?.browserPromise === browserPromise) {
				sharedBrowserState.browser = browser;
				browser.on("disconnected", () => {
					if (sharedBrowserState?.browser === browser) {
						clearIdleTimer(sharedBrowserState);
						sharedBrowserState = null;
					}
				});
			}
			return browser;
		}).catch((error) => {
			if (sharedBrowserState?.browserPromise === browserPromise) sharedBrowserState = null;
			throw error;
		});
		sharedBrowserState = {
			browserPromise,
			idleTimer: null,
			key: desiredKey,
			users: 0
		};
	}
	clearIdleTimer(sharedBrowserState);
	const state = sharedBrowserState;
	const browser = await state.browserPromise;
	state.users += 1;
	let released = false;
	return {
		browser,
		release: async () => {
			if (released) return;
			released = true;
			state.users = Math.max(0, state.users - 1);
			if (state.users === 0) scheduleIdleBrowserClose(state, params.idleMs);
		}
	};
}
function scheduleIdleBrowserClose(state, idleMs) {
	clearIdleTimer(state);
	state.idleTimer = setTimeout(() => {
		if (sharedBrowserState === state && state.users === 0) closeSharedBrowser();
	}, idleMs);
}
function clearIdleTimer(state) {
	if (!state.idleTimer) return;
	clearTimeout(state.idleTimer);
	state.idleTimer = null;
}
async function closeSharedBrowser() {
	const state = sharedBrowserState;
	if (!state) return;
	sharedBrowserState = null;
	clearIdleTimer(state);
	await (state.browser ?? await state.browserPromise.catch(() => null))?.close().catch(() => {});
}
async function collectExecutableCandidates() {
	const candidates = /* @__PURE__ */ new Set();
	for (const command of pathCommandsForPlatform()) {
		const resolved = await findExecutableInPath(command);
		if (resolved) candidates.add(resolved);
	}
	for (const candidate of commonExecutablePathsForPlatform()) candidates.add(candidate);
	return [...candidates];
}
function pathCommandsForPlatform() {
	if (process.platform === "win32") return [
		"chrome.exe",
		"msedge.exe",
		"brave.exe"
	];
	if (process.platform === "darwin") return [
		"google-chrome",
		"chromium",
		"msedge",
		"brave-browser",
		"brave"
	];
	return [
		"chromium",
		"chromium-browser",
		"google-chrome",
		"google-chrome-stable",
		"msedge",
		"brave-browser",
		"brave"
	];
}
function commonExecutablePathsForPlatform() {
	if (process.platform === "darwin") return [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
	];
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA ?? "";
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		return [
			path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
			path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
			path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
			path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
			path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
			path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
			path.join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
		];
	}
	return [
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/msedge",
		"/usr/bin/brave-browser",
		"/snap/bin/chromium"
	];
}
async function findExecutableInPath(command) {
	const pathValue = process.env.PATH;
	if (!pathValue) return;
	for (const directory of pathValue.split(path.delimiter)) {
		if (!directory) continue;
		const candidate = path.join(directory, command);
		if (await isExecutable(candidate)) return candidate;
	}
}
async function assertExecutable(candidate, label) {
	if (!await isExecutable(candidate)) throw new Error(`${label} not found or not executable: ${candidate}`);
}
async function isExecutable(candidate) {
	try {
		await fs$1.access(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/constants.js
const COMMIT_METADATA_SPLIT = /(?=^From [a-f0-9]+ .+$)/m;
const GIT_DIFF_FILE_BREAK_REGEX = /(?=^diff --git)/gm;
const UNIFIED_DIFF_FILE_BREAK_REGEX = /(?=^---\s+\S)/gm;
const FILE_CONTEXT_BLOB = /(?=^@@ )/gm;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?/m;
const SPLIT_WITH_NEWLINES = /(?<=\n)/;
const FILENAME_HEADER_REGEX = /^(---|\+\+\+)\s+([^\t\r\n]+)/;
const FILENAME_HEADER_REGEX_GIT = /^(---|\+\+\+)\s+[ab]\/([^\t\r\n]+)/;
const ALTERNATE_FILE_NAMES_GIT = /^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+?)"|b\/(.+?))$/;
const FILE_MODE_FROM_INDEX = /^index (?:[0-9a-f]+)\.\.(?:[0-9a-f]+)(?: (\d+))?/;
const HEADER_METADATA_SLOT_ID = "header-metadata";
const DEFAULT_THEMES = {
	dark: "pierre-dark",
	light: "pierre-light"
};
const UNSAFE_CSS_ATTRIBUTE = "data-unsafe-css";
const CORE_CSS_ATTRIBUTE = "data-core-css";
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/highlighter/languages/constants.js
const ResolvedLanguages = /* @__PURE__ */ new Map();
const ResolvingLanguages = /* @__PURE__ */ new Map();
const AttachedLanguages = /* @__PURE__ */ new Set();
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/highlighter/languages/areLanguagesAttached.js
function areLanguagesAttached(languages) {
	for (const language of Array.isArray(languages) ? languages : [languages]) if (!AttachedLanguages.has(language)) return false;
	return true;
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/highlighter/languages/attachResolvedLanguages.js
function attachResolvedLanguages(resolvedLanguages, highlighter) {
	resolvedLanguages = Array.isArray(resolvedLanguages) ? resolvedLanguages : [resolvedLanguages];
	for (const resolvedLang of resolvedLanguages) {
		if (AttachedLanguages.has(resolvedLang.name)) continue;
		let lang = ResolvedLanguages.get(resolvedLang.name);
		if (lang == null) {
			lang = resolvedLang;
			ResolvedLanguages.set(resolvedLang.name, lang);
		}
		AttachedLanguages.add(lang.name);
		highlighter.loadLanguageSync(lang.data);
	}
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/isWorkerContext.js
function isWorkerContext() {
	return typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope;
}
//#endregion
//#region node_modules/.pnpm/@shikijs+types@3.23.0/node_modules/@shikijs/types/dist/index.mjs
var ShikiError$2 = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ShikiError";
	}
};
//#endregion
//#region node_modules/.pnpm/@shikijs+vscode-textmate@10.0.2/node_modules/@shikijs/vscode-textmate/dist/index.js
function clone(something) {
	return doClone(something);
}
function doClone(something) {
	if (Array.isArray(something)) return cloneArray(something);
	if (something instanceof RegExp) return something;
	if (typeof something === "object") return cloneObj(something);
	return something;
}
function cloneArray(arr) {
	let r = [];
	for (let i = 0, len = arr.length; i < len; i++) r[i] = doClone(arr[i]);
	return r;
}
function cloneObj(obj) {
	let r = {};
	for (let key in obj) r[key] = doClone(obj[key]);
	return r;
}
function mergeObjects(target, ...sources) {
	sources.forEach((source) => {
		for (let key in source) target[key] = source[key];
	});
	return target;
}
function basename$1(path) {
	const idx = ~path.lastIndexOf("/") || ~path.lastIndexOf("\\");
	if (idx === 0) return path;
	else if (~idx === path.length - 1) return basename$1(path.substring(0, path.length - 1));
	else return path.substr(~idx + 1);
}
var CAPTURING_REGEX_SOURCE = /\$(\d+)|\${(\d+):\/(downcase|upcase)}/g;
var RegexSource = class {
	static hasCaptures(regexSource) {
		if (regexSource === null) return false;
		CAPTURING_REGEX_SOURCE.lastIndex = 0;
		return CAPTURING_REGEX_SOURCE.test(regexSource);
	}
	static replaceCaptures(regexSource, captureSource, captureIndices) {
		return regexSource.replace(CAPTURING_REGEX_SOURCE, (match, index, commandIndex, command) => {
			let capture = captureIndices[parseInt(index || commandIndex, 10)];
			if (capture) {
				let result = captureSource.substring(capture.start, capture.end);
				while (result[0] === ".") result = result.substring(1);
				switch (command) {
					case "downcase": return result.toLowerCase();
					case "upcase": return result.toUpperCase();
					default: return result;
				}
			} else return match;
		});
	}
};
function strcmp(a, b) {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}
function strArrCmp(a, b) {
	if (a === null && b === null) return 0;
	if (!a) return -1;
	if (!b) return 1;
	let len1 = a.length;
	let len2 = b.length;
	if (len1 === len2) {
		for (let i = 0; i < len1; i++) {
			let res = strcmp(a[i], b[i]);
			if (res !== 0) return res;
		}
		return 0;
	}
	return len1 - len2;
}
function isValidHexColor(hex) {
	if (/^#[0-9a-f]{6}$/i.test(hex)) return true;
	if (/^#[0-9a-f]{8}$/i.test(hex)) return true;
	if (/^#[0-9a-f]{3}$/i.test(hex)) return true;
	if (/^#[0-9a-f]{4}$/i.test(hex)) return true;
	return false;
}
function escapeRegExpCharacters(value) {
	return value.replace(/[\-\\\{\}\*\+\?\|\^\$\.\,\[\]\(\)\#\s]/g, "\\$&");
}
var CachedFn = class {
	constructor(fn) {
		this.fn = fn;
	}
	cache = /* @__PURE__ */ new Map();
	get(key) {
		if (this.cache.has(key)) return this.cache.get(key);
		const value = this.fn(key);
		this.cache.set(key, value);
		return value;
	}
};
var Theme = class {
	constructor(_colorMap, _defaults, _root) {
		this._colorMap = _colorMap;
		this._defaults = _defaults;
		this._root = _root;
	}
	static createFromRawTheme(source, colorMap) {
		return this.createFromParsedTheme(parseTheme(source), colorMap);
	}
	static createFromParsedTheme(source, colorMap) {
		return resolveParsedThemeRules(source, colorMap);
	}
	_cachedMatchRoot = new CachedFn((scopeName) => this._root.match(scopeName));
	getColorMap() {
		return this._colorMap.getColorMap();
	}
	getDefaults() {
		return this._defaults;
	}
	match(scopePath) {
		if (scopePath === null) return this._defaults;
		const scopeName = scopePath.scopeName;
		const effectiveRule = this._cachedMatchRoot.get(scopeName).find((v) => _scopePathMatchesParentScopes(scopePath.parent, v.parentScopes));
		if (!effectiveRule) return null;
		return new StyleAttributes(effectiveRule.fontStyle, effectiveRule.foreground, effectiveRule.background);
	}
};
var ScopeStack = class _ScopeStack {
	constructor(parent, scopeName) {
		this.parent = parent;
		this.scopeName = scopeName;
	}
	static push(path, scopeNames) {
		for (const name of scopeNames) path = new _ScopeStack(path, name);
		return path;
	}
	static from(...segments) {
		let result = null;
		for (let i = 0; i < segments.length; i++) result = new _ScopeStack(result, segments[i]);
		return result;
	}
	push(scopeName) {
		return new _ScopeStack(this, scopeName);
	}
	getSegments() {
		let item = this;
		const result = [];
		while (item) {
			result.push(item.scopeName);
			item = item.parent;
		}
		result.reverse();
		return result;
	}
	toString() {
		return this.getSegments().join(" ");
	}
	extends(other) {
		if (this === other) return true;
		if (this.parent === null) return false;
		return this.parent.extends(other);
	}
	getExtensionIfDefined(base) {
		const result = [];
		let item = this;
		while (item && item !== base) {
			result.push(item.scopeName);
			item = item.parent;
		}
		return item === base ? result.reverse() : void 0;
	}
};
function _scopePathMatchesParentScopes(scopePath, parentScopes) {
	if (parentScopes.length === 0) return true;
	for (let index = 0; index < parentScopes.length; index++) {
		let scopePattern = parentScopes[index];
		let scopeMustMatch = false;
		if (scopePattern === ">") {
			if (index === parentScopes.length - 1) return false;
			scopePattern = parentScopes[++index];
			scopeMustMatch = true;
		}
		while (scopePath) {
			if (_matchesScope(scopePath.scopeName, scopePattern)) break;
			if (scopeMustMatch) return false;
			scopePath = scopePath.parent;
		}
		if (!scopePath) return false;
		scopePath = scopePath.parent;
	}
	return true;
}
function _matchesScope(scopeName, scopePattern) {
	return scopePattern === scopeName || scopeName.startsWith(scopePattern) && scopeName[scopePattern.length] === ".";
}
var StyleAttributes = class {
	constructor(fontStyle, foregroundId, backgroundId) {
		this.fontStyle = fontStyle;
		this.foregroundId = foregroundId;
		this.backgroundId = backgroundId;
	}
};
function parseTheme(source) {
	if (!source) return [];
	if (!source.settings || !Array.isArray(source.settings)) return [];
	let settings = source.settings;
	let result = [], resultLen = 0;
	for (let i = 0, len = settings.length; i < len; i++) {
		let entry = settings[i];
		if (!entry.settings) continue;
		let scopes;
		if (typeof entry.scope === "string") {
			let _scope = entry.scope;
			_scope = _scope.replace(/^[,]+/, "");
			_scope = _scope.replace(/[,]+$/, "");
			scopes = _scope.split(",");
		} else if (Array.isArray(entry.scope)) scopes = entry.scope;
		else scopes = [""];
		let fontStyle = -1;
		if (typeof entry.settings.fontStyle === "string") {
			fontStyle = 0;
			let segments = entry.settings.fontStyle.split(" ");
			for (let j = 0, lenJ = segments.length; j < lenJ; j++) switch (segments[j]) {
				case "italic":
					fontStyle = fontStyle | 1;
					break;
				case "bold":
					fontStyle = fontStyle | 2;
					break;
				case "underline":
					fontStyle = fontStyle | 4;
					break;
				case "strikethrough":
					fontStyle = fontStyle | 8;
					break;
			}
		}
		let foreground = null;
		if (typeof entry.settings.foreground === "string" && isValidHexColor(entry.settings.foreground)) foreground = entry.settings.foreground;
		let background = null;
		if (typeof entry.settings.background === "string" && isValidHexColor(entry.settings.background)) background = entry.settings.background;
		for (let j = 0, lenJ = scopes.length; j < lenJ; j++) {
			let segments = scopes[j].trim().split(" ");
			let scope = segments[segments.length - 1];
			let parentScopes = null;
			if (segments.length > 1) {
				parentScopes = segments.slice(0, segments.length - 1);
				parentScopes.reverse();
			}
			result[resultLen++] = new ParsedThemeRule(scope, parentScopes, i, fontStyle, foreground, background);
		}
	}
	return result;
}
var ParsedThemeRule = class {
	constructor(scope, parentScopes, index, fontStyle, foreground, background) {
		this.scope = scope;
		this.parentScopes = parentScopes;
		this.index = index;
		this.fontStyle = fontStyle;
		this.foreground = foreground;
		this.background = background;
	}
};
var FontStyle = /* @__PURE__ */ ((FontStyle2) => {
	FontStyle2[FontStyle2["NotSet"] = -1] = "NotSet";
	FontStyle2[FontStyle2["None"] = 0] = "None";
	FontStyle2[FontStyle2["Italic"] = 1] = "Italic";
	FontStyle2[FontStyle2["Bold"] = 2] = "Bold";
	FontStyle2[FontStyle2["Underline"] = 4] = "Underline";
	FontStyle2[FontStyle2["Strikethrough"] = 8] = "Strikethrough";
	return FontStyle2;
})(FontStyle || {});
function resolveParsedThemeRules(parsedThemeRules, _colorMap) {
	parsedThemeRules.sort((a, b) => {
		let r = strcmp(a.scope, b.scope);
		if (r !== 0) return r;
		r = strArrCmp(a.parentScopes, b.parentScopes);
		if (r !== 0) return r;
		return a.index - b.index;
	});
	let defaultFontStyle = 0;
	let defaultForeground = "#000000";
	let defaultBackground = "#ffffff";
	while (parsedThemeRules.length >= 1 && parsedThemeRules[0].scope === "") {
		let incomingDefaults = parsedThemeRules.shift();
		if (incomingDefaults.fontStyle !== -1) defaultFontStyle = incomingDefaults.fontStyle;
		if (incomingDefaults.foreground !== null) defaultForeground = incomingDefaults.foreground;
		if (incomingDefaults.background !== null) defaultBackground = incomingDefaults.background;
	}
	let colorMap = new ColorMap(_colorMap);
	let defaults = new StyleAttributes(defaultFontStyle, colorMap.getId(defaultForeground), colorMap.getId(defaultBackground));
	let root = new ThemeTrieElement(new ThemeTrieElementRule(0, null, -1, 0, 0), []);
	for (let i = 0, len = parsedThemeRules.length; i < len; i++) {
		let rule = parsedThemeRules[i];
		root.insert(0, rule.scope, rule.parentScopes, rule.fontStyle, colorMap.getId(rule.foreground), colorMap.getId(rule.background));
	}
	return new Theme(colorMap, defaults, root);
}
var ColorMap = class {
	_isFrozen;
	_lastColorId;
	_id2color;
	_color2id;
	constructor(_colorMap) {
		this._lastColorId = 0;
		this._id2color = [];
		this._color2id = /* @__PURE__ */ Object.create(null);
		if (Array.isArray(_colorMap)) {
			this._isFrozen = true;
			for (let i = 0, len = _colorMap.length; i < len; i++) {
				this._color2id[_colorMap[i]] = i;
				this._id2color[i] = _colorMap[i];
			}
		} else this._isFrozen = false;
	}
	getId(color) {
		if (color === null) return 0;
		color = color.toUpperCase();
		let value = this._color2id[color];
		if (value) return value;
		if (this._isFrozen) throw new Error(`Missing color in color map - ${color}`);
		value = ++this._lastColorId;
		this._color2id[color] = value;
		this._id2color[value] = color;
		return value;
	}
	getColorMap() {
		return this._id2color.slice(0);
	}
};
var emptyParentScopes = Object.freeze([]);
var ThemeTrieElementRule = class _ThemeTrieElementRule {
	scopeDepth;
	parentScopes;
	fontStyle;
	foreground;
	background;
	constructor(scopeDepth, parentScopes, fontStyle, foreground, background) {
		this.scopeDepth = scopeDepth;
		this.parentScopes = parentScopes || emptyParentScopes;
		this.fontStyle = fontStyle;
		this.foreground = foreground;
		this.background = background;
	}
	clone() {
		return new _ThemeTrieElementRule(this.scopeDepth, this.parentScopes, this.fontStyle, this.foreground, this.background);
	}
	static cloneArr(arr) {
		let r = [];
		for (let i = 0, len = arr.length; i < len; i++) r[i] = arr[i].clone();
		return r;
	}
	acceptOverwrite(scopeDepth, fontStyle, foreground, background) {
		if (this.scopeDepth > scopeDepth) console.log("how did this happen?");
		else this.scopeDepth = scopeDepth;
		if (fontStyle !== -1) this.fontStyle = fontStyle;
		if (foreground !== 0) this.foreground = foreground;
		if (background !== 0) this.background = background;
	}
};
var ThemeTrieElement = class _ThemeTrieElement {
	constructor(_mainRule, rulesWithParentScopes = [], _children = {}) {
		this._mainRule = _mainRule;
		this._children = _children;
		this._rulesWithParentScopes = rulesWithParentScopes;
	}
	_rulesWithParentScopes;
	static _cmpBySpecificity(a, b) {
		if (a.scopeDepth !== b.scopeDepth) return b.scopeDepth - a.scopeDepth;
		let aParentIndex = 0;
		let bParentIndex = 0;
		while (true) {
			if (a.parentScopes[aParentIndex] === ">") aParentIndex++;
			if (b.parentScopes[bParentIndex] === ">") bParentIndex++;
			if (aParentIndex >= a.parentScopes.length || bParentIndex >= b.parentScopes.length) break;
			const parentScopeLengthDiff = b.parentScopes[bParentIndex].length - a.parentScopes[aParentIndex].length;
			if (parentScopeLengthDiff !== 0) return parentScopeLengthDiff;
			aParentIndex++;
			bParentIndex++;
		}
		return b.parentScopes.length - a.parentScopes.length;
	}
	match(scope) {
		if (scope !== "") {
			let dotIndex = scope.indexOf(".");
			let head;
			let tail;
			if (dotIndex === -1) {
				head = scope;
				tail = "";
			} else {
				head = scope.substring(0, dotIndex);
				tail = scope.substring(dotIndex + 1);
			}
			if (this._children.hasOwnProperty(head)) return this._children[head].match(tail);
		}
		const rules = this._rulesWithParentScopes.concat(this._mainRule);
		rules.sort(_ThemeTrieElement._cmpBySpecificity);
		return rules;
	}
	insert(scopeDepth, scope, parentScopes, fontStyle, foreground, background) {
		if (scope === "") {
			this._doInsertHere(scopeDepth, parentScopes, fontStyle, foreground, background);
			return;
		}
		let dotIndex = scope.indexOf(".");
		let head;
		let tail;
		if (dotIndex === -1) {
			head = scope;
			tail = "";
		} else {
			head = scope.substring(0, dotIndex);
			tail = scope.substring(dotIndex + 1);
		}
		let child;
		if (this._children.hasOwnProperty(head)) child = this._children[head];
		else {
			child = new _ThemeTrieElement(this._mainRule.clone(), ThemeTrieElementRule.cloneArr(this._rulesWithParentScopes));
			this._children[head] = child;
		}
		child.insert(scopeDepth + 1, tail, parentScopes, fontStyle, foreground, background);
	}
	_doInsertHere(scopeDepth, parentScopes, fontStyle, foreground, background) {
		if (parentScopes === null) {
			this._mainRule.acceptOverwrite(scopeDepth, fontStyle, foreground, background);
			return;
		}
		for (let i = 0, len = this._rulesWithParentScopes.length; i < len; i++) {
			let rule = this._rulesWithParentScopes[i];
			if (strArrCmp(rule.parentScopes, parentScopes) === 0) {
				rule.acceptOverwrite(scopeDepth, fontStyle, foreground, background);
				return;
			}
		}
		if (fontStyle === -1) fontStyle = this._mainRule.fontStyle;
		if (foreground === 0) foreground = this._mainRule.foreground;
		if (background === 0) background = this._mainRule.background;
		this._rulesWithParentScopes.push(new ThemeTrieElementRule(scopeDepth, parentScopes, fontStyle, foreground, background));
	}
};
var EncodedTokenMetadata = class _EncodedTokenMetadata {
	static toBinaryStr(encodedTokenAttributes) {
		return encodedTokenAttributes.toString(2).padStart(32, "0");
	}
	static print(encodedTokenAttributes) {
		const languageId = _EncodedTokenMetadata.getLanguageId(encodedTokenAttributes);
		const tokenType = _EncodedTokenMetadata.getTokenType(encodedTokenAttributes);
		const fontStyle = _EncodedTokenMetadata.getFontStyle(encodedTokenAttributes);
		const foreground = _EncodedTokenMetadata.getForeground(encodedTokenAttributes);
		const background = _EncodedTokenMetadata.getBackground(encodedTokenAttributes);
		console.log({
			languageId,
			tokenType,
			fontStyle,
			foreground,
			background
		});
	}
	static getLanguageId(encodedTokenAttributes) {
		return (encodedTokenAttributes & 255) >>> 0;
	}
	static getTokenType(encodedTokenAttributes) {
		return (encodedTokenAttributes & 768) >>> 8;
	}
	static containsBalancedBrackets(encodedTokenAttributes) {
		return (encodedTokenAttributes & 1024) !== 0;
	}
	static getFontStyle(encodedTokenAttributes) {
		return (encodedTokenAttributes & 30720) >>> 11;
	}
	static getForeground(encodedTokenAttributes) {
		return (encodedTokenAttributes & 16744448) >>> 15;
	}
	static getBackground(encodedTokenAttributes) {
		return (encodedTokenAttributes & 4278190080) >>> 24;
	}
	/**
	* Updates the fields in `metadata`.
	* A value of `0`, `NotSet` or `null` indicates that the corresponding field should be left as is.
	*/
	static set(encodedTokenAttributes, languageId, tokenType, containsBalancedBrackets, fontStyle, foreground, background) {
		let _languageId = _EncodedTokenMetadata.getLanguageId(encodedTokenAttributes);
		let _tokenType = _EncodedTokenMetadata.getTokenType(encodedTokenAttributes);
		let _containsBalancedBracketsBit = _EncodedTokenMetadata.containsBalancedBrackets(encodedTokenAttributes) ? 1 : 0;
		let _fontStyle = _EncodedTokenMetadata.getFontStyle(encodedTokenAttributes);
		let _foreground = _EncodedTokenMetadata.getForeground(encodedTokenAttributes);
		let _background = _EncodedTokenMetadata.getBackground(encodedTokenAttributes);
		if (languageId !== 0) _languageId = languageId;
		if (tokenType !== 8) _tokenType = fromOptionalTokenType(tokenType);
		if (containsBalancedBrackets !== null) _containsBalancedBracketsBit = containsBalancedBrackets ? 1 : 0;
		if (fontStyle !== -1) _fontStyle = fontStyle;
		if (foreground !== 0) _foreground = foreground;
		if (background !== 0) _background = background;
		return (_languageId << 0 | _tokenType << 8 | _containsBalancedBracketsBit << 10 | _fontStyle << 11 | _foreground << 15 | _background << 24) >>> 0;
	}
};
function toOptionalTokenType(standardType) {
	return standardType;
}
function fromOptionalTokenType(standardType) {
	return standardType;
}
function createMatchers(selector, matchesName) {
	const results = [];
	const tokenizer = newTokenizer(selector);
	let token = tokenizer.next();
	while (token !== null) {
		let priority = 0;
		if (token.length === 2 && token.charAt(1) === ":") {
			switch (token.charAt(0)) {
				case "R":
					priority = 1;
					break;
				case "L":
					priority = -1;
					break;
				default: console.log(`Unknown priority ${token} in scope selector`);
			}
			token = tokenizer.next();
		}
		let matcher = parseConjunction();
		results.push({
			matcher,
			priority
		});
		if (token !== ",") break;
		token = tokenizer.next();
	}
	return results;
	function parseOperand() {
		if (token === "-") {
			token = tokenizer.next();
			const expressionToNegate = parseOperand();
			return (matcherInput) => !!expressionToNegate && !expressionToNegate(matcherInput);
		}
		if (token === "(") {
			token = tokenizer.next();
			const expressionInParents = parseInnerExpression();
			if (token === ")") token = tokenizer.next();
			return expressionInParents;
		}
		if (isIdentifier(token)) {
			const identifiers = [];
			do {
				identifiers.push(token);
				token = tokenizer.next();
			} while (isIdentifier(token));
			return (matcherInput) => matchesName(identifiers, matcherInput);
		}
		return null;
	}
	function parseConjunction() {
		const matchers = [];
		let matcher = parseOperand();
		while (matcher) {
			matchers.push(matcher);
			matcher = parseOperand();
		}
		return (matcherInput) => matchers.every((matcher2) => matcher2(matcherInput));
	}
	function parseInnerExpression() {
		const matchers = [];
		let matcher = parseConjunction();
		while (matcher) {
			matchers.push(matcher);
			if (token === "|" || token === ",") do
				token = tokenizer.next();
			while (token === "|" || token === ",");
			else break;
			matcher = parseConjunction();
		}
		return (matcherInput) => matchers.some((matcher2) => matcher2(matcherInput));
	}
}
function isIdentifier(token) {
	return !!token && !!token.match(/[\w\.:]+/);
}
function newTokenizer(input) {
	let regex = /([LR]:|[\w\.:][\w\.:\-]*|[\,\|\-\(\)])/g;
	let match = regex.exec(input);
	return { next: () => {
		if (!match) return null;
		const res = match[0];
		match = regex.exec(input);
		return res;
	} };
}
function disposeOnigString(str) {
	if (typeof str.dispose === "function") str.dispose();
}
var TopLevelRuleReference = class {
	constructor(scopeName) {
		this.scopeName = scopeName;
	}
	toKey() {
		return this.scopeName;
	}
};
var TopLevelRepositoryRuleReference = class {
	constructor(scopeName, ruleName) {
		this.scopeName = scopeName;
		this.ruleName = ruleName;
	}
	toKey() {
		return `${this.scopeName}#${this.ruleName}`;
	}
};
var ExternalReferenceCollector = class {
	_references = [];
	_seenReferenceKeys = /* @__PURE__ */ new Set();
	get references() {
		return this._references;
	}
	visitedRule = /* @__PURE__ */ new Set();
	add(reference) {
		const key = reference.toKey();
		if (this._seenReferenceKeys.has(key)) return;
		this._seenReferenceKeys.add(key);
		this._references.push(reference);
	}
};
var ScopeDependencyProcessor = class {
	constructor(repo, initialScopeName) {
		this.repo = repo;
		this.initialScopeName = initialScopeName;
		this.seenFullScopeRequests.add(this.initialScopeName);
		this.Q = [new TopLevelRuleReference(this.initialScopeName)];
	}
	seenFullScopeRequests = /* @__PURE__ */ new Set();
	seenPartialScopeRequests = /* @__PURE__ */ new Set();
	Q;
	processQueue() {
		const q = this.Q;
		this.Q = [];
		const deps = new ExternalReferenceCollector();
		for (const dep of q) collectReferencesOfReference(dep, this.initialScopeName, this.repo, deps);
		for (const dep of deps.references) if (dep instanceof TopLevelRuleReference) {
			if (this.seenFullScopeRequests.has(dep.scopeName)) continue;
			this.seenFullScopeRequests.add(dep.scopeName);
			this.Q.push(dep);
		} else {
			if (this.seenFullScopeRequests.has(dep.scopeName)) continue;
			if (this.seenPartialScopeRequests.has(dep.toKey())) continue;
			this.seenPartialScopeRequests.add(dep.toKey());
			this.Q.push(dep);
		}
	}
};
function collectReferencesOfReference(reference, baseGrammarScopeName, repo, result) {
	const selfGrammar = repo.lookup(reference.scopeName);
	if (!selfGrammar) {
		if (reference.scopeName === baseGrammarScopeName) throw new Error(`No grammar provided for <${baseGrammarScopeName}>`);
		return;
	}
	const baseGrammar = repo.lookup(baseGrammarScopeName);
	if (reference instanceof TopLevelRuleReference) collectExternalReferencesInTopLevelRule({
		baseGrammar,
		selfGrammar
	}, result);
	else collectExternalReferencesInTopLevelRepositoryRule(reference.ruleName, {
		baseGrammar,
		selfGrammar,
		repository: selfGrammar.repository
	}, result);
	const injections = repo.injections(reference.scopeName);
	if (injections) for (const injection of injections) result.add(new TopLevelRuleReference(injection));
}
function collectExternalReferencesInTopLevelRepositoryRule(ruleName, context, result) {
	if (context.repository && context.repository[ruleName]) {
		const rule = context.repository[ruleName];
		collectExternalReferencesInRules([rule], context, result);
	}
}
function collectExternalReferencesInTopLevelRule(context, result) {
	if (context.selfGrammar.patterns && Array.isArray(context.selfGrammar.patterns)) collectExternalReferencesInRules(context.selfGrammar.patterns, {
		...context,
		repository: context.selfGrammar.repository
	}, result);
	if (context.selfGrammar.injections) collectExternalReferencesInRules(Object.values(context.selfGrammar.injections), {
		...context,
		repository: context.selfGrammar.repository
	}, result);
}
function collectExternalReferencesInRules(rules, context, result) {
	for (const rule of rules) {
		if (result.visitedRule.has(rule)) continue;
		result.visitedRule.add(rule);
		const patternRepository = rule.repository ? mergeObjects({}, context.repository, rule.repository) : context.repository;
		if (Array.isArray(rule.patterns)) collectExternalReferencesInRules(rule.patterns, {
			...context,
			repository: patternRepository
		}, result);
		const include = rule.include;
		if (!include) continue;
		const reference = parseInclude(include);
		switch (reference.kind) {
			case 0:
				collectExternalReferencesInTopLevelRule({
					...context,
					selfGrammar: context.baseGrammar
				}, result);
				break;
			case 1:
				collectExternalReferencesInTopLevelRule(context, result);
				break;
			case 2:
				collectExternalReferencesInTopLevelRepositoryRule(reference.ruleName, {
					...context,
					repository: patternRepository
				}, result);
				break;
			case 3:
			case 4:
				const selfGrammar = reference.scopeName === context.selfGrammar.scopeName ? context.selfGrammar : reference.scopeName === context.baseGrammar.scopeName ? context.baseGrammar : void 0;
				if (selfGrammar) {
					const newContext = {
						baseGrammar: context.baseGrammar,
						selfGrammar,
						repository: patternRepository
					};
					if (reference.kind === 4) collectExternalReferencesInTopLevelRepositoryRule(reference.ruleName, newContext, result);
					else collectExternalReferencesInTopLevelRule(newContext, result);
				} else if (reference.kind === 4) result.add(new TopLevelRepositoryRuleReference(reference.scopeName, reference.ruleName));
				else result.add(new TopLevelRuleReference(reference.scopeName));
				break;
		}
	}
}
var BaseReference = class {
	kind = 0;
};
var SelfReference = class {
	kind = 1;
};
var RelativeReference = class {
	constructor(ruleName) {
		this.ruleName = ruleName;
	}
	kind = 2;
};
var TopLevelReference = class {
	constructor(scopeName) {
		this.scopeName = scopeName;
	}
	kind = 3;
};
var TopLevelRepositoryReference = class {
	constructor(scopeName, ruleName) {
		this.scopeName = scopeName;
		this.ruleName = ruleName;
	}
	kind = 4;
};
function parseInclude(include) {
	if (include === "$base") return new BaseReference();
	else if (include === "$self") return new SelfReference();
	const indexOfSharp = include.indexOf("#");
	if (indexOfSharp === -1) return new TopLevelReference(include);
	else if (indexOfSharp === 0) return new RelativeReference(include.substring(1));
	else return new TopLevelRepositoryReference(include.substring(0, indexOfSharp), include.substring(indexOfSharp + 1));
}
var HAS_BACK_REFERENCES = /\\(\d+)/;
var BACK_REFERENCING_END = /\\(\d+)/g;
var endRuleId = -1;
var whileRuleId = -2;
function ruleIdFromNumber(id) {
	return id;
}
function ruleIdToNumber(id) {
	return id;
}
var Rule = class {
	$location;
	id;
	_nameIsCapturing;
	_name;
	_contentNameIsCapturing;
	_contentName;
	constructor($location, id, name, contentName) {
		this.$location = $location;
		this.id = id;
		this._name = name || null;
		this._nameIsCapturing = RegexSource.hasCaptures(this._name);
		this._contentName = contentName || null;
		this._contentNameIsCapturing = RegexSource.hasCaptures(this._contentName);
	}
	get debugName() {
		const location = this.$location ? `${basename$1(this.$location.filename)}:${this.$location.line}` : "unknown";
		return `${this.constructor.name}#${this.id} @ ${location}`;
	}
	getName(lineText, captureIndices) {
		if (!this._nameIsCapturing || this._name === null || lineText === null || captureIndices === null) return this._name;
		return RegexSource.replaceCaptures(this._name, lineText, captureIndices);
	}
	getContentName(lineText, captureIndices) {
		if (!this._contentNameIsCapturing || this._contentName === null) return this._contentName;
		return RegexSource.replaceCaptures(this._contentName, lineText, captureIndices);
	}
};
var CaptureRule = class extends Rule {
	retokenizeCapturedWithRuleId;
	constructor($location, id, name, contentName, retokenizeCapturedWithRuleId) {
		super($location, id, name, contentName);
		this.retokenizeCapturedWithRuleId = retokenizeCapturedWithRuleId;
	}
	dispose() {}
	collectPatterns(grammar, out) {
		throw new Error("Not supported!");
	}
	compile(grammar, endRegexSource) {
		throw new Error("Not supported!");
	}
	compileAG(grammar, endRegexSource, allowA, allowG) {
		throw new Error("Not supported!");
	}
};
var MatchRule = class extends Rule {
	_match;
	captures;
	_cachedCompiledPatterns;
	constructor($location, id, name, match, captures) {
		super($location, id, name, null);
		this._match = new RegExpSource(match, this.id);
		this.captures = captures;
		this._cachedCompiledPatterns = null;
	}
	dispose() {
		if (this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns.dispose();
			this._cachedCompiledPatterns = null;
		}
	}
	get debugMatchRegExp() {
		return `${this._match.source}`;
	}
	collectPatterns(grammar, out) {
		out.push(this._match);
	}
	compile(grammar, endRegexSource) {
		return this._getCachedCompiledPatterns(grammar).compile(grammar);
	}
	compileAG(grammar, endRegexSource, allowA, allowG) {
		return this._getCachedCompiledPatterns(grammar).compileAG(grammar, allowA, allowG);
	}
	_getCachedCompiledPatterns(grammar) {
		if (!this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns = new RegExpSourceList();
			this.collectPatterns(grammar, this._cachedCompiledPatterns);
		}
		return this._cachedCompiledPatterns;
	}
};
var IncludeOnlyRule = class extends Rule {
	hasMissingPatterns;
	patterns;
	_cachedCompiledPatterns;
	constructor($location, id, name, contentName, patterns) {
		super($location, id, name, contentName);
		this.patterns = patterns.patterns;
		this.hasMissingPatterns = patterns.hasMissingPatterns;
		this._cachedCompiledPatterns = null;
	}
	dispose() {
		if (this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns.dispose();
			this._cachedCompiledPatterns = null;
		}
	}
	collectPatterns(grammar, out) {
		for (const pattern of this.patterns) grammar.getRule(pattern).collectPatterns(grammar, out);
	}
	compile(grammar, endRegexSource) {
		return this._getCachedCompiledPatterns(grammar).compile(grammar);
	}
	compileAG(grammar, endRegexSource, allowA, allowG) {
		return this._getCachedCompiledPatterns(grammar).compileAG(grammar, allowA, allowG);
	}
	_getCachedCompiledPatterns(grammar) {
		if (!this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns = new RegExpSourceList();
			this.collectPatterns(grammar, this._cachedCompiledPatterns);
		}
		return this._cachedCompiledPatterns;
	}
};
var BeginEndRule = class extends Rule {
	_begin;
	beginCaptures;
	_end;
	endHasBackReferences;
	endCaptures;
	applyEndPatternLast;
	hasMissingPatterns;
	patterns;
	_cachedCompiledPatterns;
	constructor($location, id, name, contentName, begin, beginCaptures, end, endCaptures, applyEndPatternLast, patterns) {
		super($location, id, name, contentName);
		this._begin = new RegExpSource(begin, this.id);
		this.beginCaptures = beginCaptures;
		this._end = new RegExpSource(end ? end : "￿", -1);
		this.endHasBackReferences = this._end.hasBackReferences;
		this.endCaptures = endCaptures;
		this.applyEndPatternLast = applyEndPatternLast || false;
		this.patterns = patterns.patterns;
		this.hasMissingPatterns = patterns.hasMissingPatterns;
		this._cachedCompiledPatterns = null;
	}
	dispose() {
		if (this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns.dispose();
			this._cachedCompiledPatterns = null;
		}
	}
	get debugBeginRegExp() {
		return `${this._begin.source}`;
	}
	get debugEndRegExp() {
		return `${this._end.source}`;
	}
	getEndWithResolvedBackReferences(lineText, captureIndices) {
		return this._end.resolveBackReferences(lineText, captureIndices);
	}
	collectPatterns(grammar, out) {
		out.push(this._begin);
	}
	compile(grammar, endRegexSource) {
		return this._getCachedCompiledPatterns(grammar, endRegexSource).compile(grammar);
	}
	compileAG(grammar, endRegexSource, allowA, allowG) {
		return this._getCachedCompiledPatterns(grammar, endRegexSource).compileAG(grammar, allowA, allowG);
	}
	_getCachedCompiledPatterns(grammar, endRegexSource) {
		if (!this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns = new RegExpSourceList();
			for (const pattern of this.patterns) grammar.getRule(pattern).collectPatterns(grammar, this._cachedCompiledPatterns);
			if (this.applyEndPatternLast) this._cachedCompiledPatterns.push(this._end.hasBackReferences ? this._end.clone() : this._end);
			else this._cachedCompiledPatterns.unshift(this._end.hasBackReferences ? this._end.clone() : this._end);
		}
		if (this._end.hasBackReferences) if (this.applyEndPatternLast) this._cachedCompiledPatterns.setSource(this._cachedCompiledPatterns.length() - 1, endRegexSource);
		else this._cachedCompiledPatterns.setSource(0, endRegexSource);
		return this._cachedCompiledPatterns;
	}
};
var BeginWhileRule = class extends Rule {
	_begin;
	beginCaptures;
	whileCaptures;
	_while;
	whileHasBackReferences;
	hasMissingPatterns;
	patterns;
	_cachedCompiledPatterns;
	_cachedCompiledWhilePatterns;
	constructor($location, id, name, contentName, begin, beginCaptures, _while, whileCaptures, patterns) {
		super($location, id, name, contentName);
		this._begin = new RegExpSource(begin, this.id);
		this.beginCaptures = beginCaptures;
		this.whileCaptures = whileCaptures;
		this._while = new RegExpSource(_while, whileRuleId);
		this.whileHasBackReferences = this._while.hasBackReferences;
		this.patterns = patterns.patterns;
		this.hasMissingPatterns = patterns.hasMissingPatterns;
		this._cachedCompiledPatterns = null;
		this._cachedCompiledWhilePatterns = null;
	}
	dispose() {
		if (this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns.dispose();
			this._cachedCompiledPatterns = null;
		}
		if (this._cachedCompiledWhilePatterns) {
			this._cachedCompiledWhilePatterns.dispose();
			this._cachedCompiledWhilePatterns = null;
		}
	}
	get debugBeginRegExp() {
		return `${this._begin.source}`;
	}
	get debugWhileRegExp() {
		return `${this._while.source}`;
	}
	getWhileWithResolvedBackReferences(lineText, captureIndices) {
		return this._while.resolveBackReferences(lineText, captureIndices);
	}
	collectPatterns(grammar, out) {
		out.push(this._begin);
	}
	compile(grammar, endRegexSource) {
		return this._getCachedCompiledPatterns(grammar).compile(grammar);
	}
	compileAG(grammar, endRegexSource, allowA, allowG) {
		return this._getCachedCompiledPatterns(grammar).compileAG(grammar, allowA, allowG);
	}
	_getCachedCompiledPatterns(grammar) {
		if (!this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns = new RegExpSourceList();
			for (const pattern of this.patterns) grammar.getRule(pattern).collectPatterns(grammar, this._cachedCompiledPatterns);
		}
		return this._cachedCompiledPatterns;
	}
	compileWhile(grammar, endRegexSource) {
		return this._getCachedCompiledWhilePatterns(grammar, endRegexSource).compile(grammar);
	}
	compileWhileAG(grammar, endRegexSource, allowA, allowG) {
		return this._getCachedCompiledWhilePatterns(grammar, endRegexSource).compileAG(grammar, allowA, allowG);
	}
	_getCachedCompiledWhilePatterns(grammar, endRegexSource) {
		if (!this._cachedCompiledWhilePatterns) {
			this._cachedCompiledWhilePatterns = new RegExpSourceList();
			this._cachedCompiledWhilePatterns.push(this._while.hasBackReferences ? this._while.clone() : this._while);
		}
		if (this._while.hasBackReferences) this._cachedCompiledWhilePatterns.setSource(0, endRegexSource ? endRegexSource : "￿");
		return this._cachedCompiledWhilePatterns;
	}
};
var RuleFactory = class _RuleFactory {
	static createCaptureRule(helper, $location, name, contentName, retokenizeCapturedWithRuleId) {
		return helper.registerRule((id) => {
			return new CaptureRule($location, id, name, contentName, retokenizeCapturedWithRuleId);
		});
	}
	static getCompiledRuleId(desc, helper, repository) {
		if (!desc.id) helper.registerRule((id) => {
			desc.id = id;
			if (desc.match) return new MatchRule(desc.$vscodeTextmateLocation, desc.id, desc.name, desc.match, _RuleFactory._compileCaptures(desc.captures, helper, repository));
			if (typeof desc.begin === "undefined") {
				if (desc.repository) repository = mergeObjects({}, repository, desc.repository);
				let patterns = desc.patterns;
				if (typeof patterns === "undefined" && desc.include) patterns = [{ include: desc.include }];
				return new IncludeOnlyRule(desc.$vscodeTextmateLocation, desc.id, desc.name, desc.contentName, _RuleFactory._compilePatterns(patterns, helper, repository));
			}
			if (desc.while) return new BeginWhileRule(desc.$vscodeTextmateLocation, desc.id, desc.name, desc.contentName, desc.begin, _RuleFactory._compileCaptures(desc.beginCaptures || desc.captures, helper, repository), desc.while, _RuleFactory._compileCaptures(desc.whileCaptures || desc.captures, helper, repository), _RuleFactory._compilePatterns(desc.patterns, helper, repository));
			return new BeginEndRule(desc.$vscodeTextmateLocation, desc.id, desc.name, desc.contentName, desc.begin, _RuleFactory._compileCaptures(desc.beginCaptures || desc.captures, helper, repository), desc.end, _RuleFactory._compileCaptures(desc.endCaptures || desc.captures, helper, repository), desc.applyEndPatternLast, _RuleFactory._compilePatterns(desc.patterns, helper, repository));
		});
		return desc.id;
	}
	static _compileCaptures(captures, helper, repository) {
		let r = [];
		if (captures) {
			let maximumCaptureId = 0;
			for (const captureId in captures) {
				if (captureId === "$vscodeTextmateLocation") continue;
				const numericCaptureId = parseInt(captureId, 10);
				if (numericCaptureId > maximumCaptureId) maximumCaptureId = numericCaptureId;
			}
			for (let i = 0; i <= maximumCaptureId; i++) r[i] = null;
			for (const captureId in captures) {
				if (captureId === "$vscodeTextmateLocation") continue;
				const numericCaptureId = parseInt(captureId, 10);
				let retokenizeCapturedWithRuleId = 0;
				if (captures[captureId].patterns) retokenizeCapturedWithRuleId = _RuleFactory.getCompiledRuleId(captures[captureId], helper, repository);
				r[numericCaptureId] = _RuleFactory.createCaptureRule(helper, captures[captureId].$vscodeTextmateLocation, captures[captureId].name, captures[captureId].contentName, retokenizeCapturedWithRuleId);
			}
		}
		return r;
	}
	static _compilePatterns(patterns, helper, repository) {
		let r = [];
		if (patterns) for (let i = 0, len = patterns.length; i < len; i++) {
			const pattern = patterns[i];
			let ruleId = -1;
			if (pattern.include) {
				const reference = parseInclude(pattern.include);
				switch (reference.kind) {
					case 0:
					case 1:
						ruleId = _RuleFactory.getCompiledRuleId(repository[pattern.include], helper, repository);
						break;
					case 2:
						let localIncludedRule = repository[reference.ruleName];
						if (localIncludedRule) ruleId = _RuleFactory.getCompiledRuleId(localIncludedRule, helper, repository);
						break;
					case 3:
					case 4:
						const externalGrammarName = reference.scopeName;
						const externalGrammarInclude = reference.kind === 4 ? reference.ruleName : null;
						const externalGrammar = helper.getExternalGrammar(externalGrammarName, repository);
						if (externalGrammar) if (externalGrammarInclude) {
							let externalIncludedRule = externalGrammar.repository[externalGrammarInclude];
							if (externalIncludedRule) ruleId = _RuleFactory.getCompiledRuleId(externalIncludedRule, helper, externalGrammar.repository);
						} else ruleId = _RuleFactory.getCompiledRuleId(externalGrammar.repository.$self, helper, externalGrammar.repository);
						break;
				}
			} else ruleId = _RuleFactory.getCompiledRuleId(pattern, helper, repository);
			if (ruleId !== -1) {
				const rule = helper.getRule(ruleId);
				let skipRule = false;
				if (rule instanceof IncludeOnlyRule || rule instanceof BeginEndRule || rule instanceof BeginWhileRule) {
					if (rule.hasMissingPatterns && rule.patterns.length === 0) skipRule = true;
				}
				if (skipRule) continue;
				r.push(ruleId);
			}
		}
		return {
			patterns: r,
			hasMissingPatterns: (patterns ? patterns.length : 0) !== r.length
		};
	}
};
var RegExpSource = class _RegExpSource {
	source;
	ruleId;
	hasAnchor;
	hasBackReferences;
	_anchorCache;
	constructor(regExpSource, ruleId) {
		if (regExpSource && typeof regExpSource === "string") {
			const len = regExpSource.length;
			let lastPushedPos = 0;
			let output = [];
			let hasAnchor = false;
			for (let pos = 0; pos < len; pos++) if (regExpSource.charAt(pos) === "\\") {
				if (pos + 1 < len) {
					const nextCh = regExpSource.charAt(pos + 1);
					if (nextCh === "z") {
						output.push(regExpSource.substring(lastPushedPos, pos));
						output.push("$(?!\\n)(?<!\\n)");
						lastPushedPos = pos + 2;
					} else if (nextCh === "A" || nextCh === "G") hasAnchor = true;
					pos++;
				}
			}
			this.hasAnchor = hasAnchor;
			if (lastPushedPos === 0) this.source = regExpSource;
			else {
				output.push(regExpSource.substring(lastPushedPos, len));
				this.source = output.join("");
			}
		} else {
			this.hasAnchor = false;
			this.source = regExpSource;
		}
		if (this.hasAnchor) this._anchorCache = this._buildAnchorCache();
		else this._anchorCache = null;
		this.ruleId = ruleId;
		if (typeof this.source === "string") this.hasBackReferences = HAS_BACK_REFERENCES.test(this.source);
		else this.hasBackReferences = false;
	}
	clone() {
		return new _RegExpSource(this.source, this.ruleId);
	}
	setSource(newSource) {
		if (this.source === newSource) return;
		this.source = newSource;
		if (this.hasAnchor) this._anchorCache = this._buildAnchorCache();
	}
	resolveBackReferences(lineText, captureIndices) {
		if (typeof this.source !== "string") throw new Error("This method should only be called if the source is a string");
		let capturedValues = captureIndices.map((capture) => {
			return lineText.substring(capture.start, capture.end);
		});
		BACK_REFERENCING_END.lastIndex = 0;
		return this.source.replace(BACK_REFERENCING_END, (match, g1) => {
			return escapeRegExpCharacters(capturedValues[parseInt(g1, 10)] || "");
		});
	}
	_buildAnchorCache() {
		if (typeof this.source !== "string") throw new Error("This method should only be called if the source is a string");
		let A0_G0_result = [];
		let A0_G1_result = [];
		let A1_G0_result = [];
		let A1_G1_result = [];
		let pos, len, ch, nextCh;
		for (pos = 0, len = this.source.length; pos < len; pos++) {
			ch = this.source.charAt(pos);
			A0_G0_result[pos] = ch;
			A0_G1_result[pos] = ch;
			A1_G0_result[pos] = ch;
			A1_G1_result[pos] = ch;
			if (ch === "\\") {
				if (pos + 1 < len) {
					nextCh = this.source.charAt(pos + 1);
					if (nextCh === "A") {
						A0_G0_result[pos + 1] = "￿";
						A0_G1_result[pos + 1] = "￿";
						A1_G0_result[pos + 1] = "A";
						A1_G1_result[pos + 1] = "A";
					} else if (nextCh === "G") {
						A0_G0_result[pos + 1] = "￿";
						A0_G1_result[pos + 1] = "G";
						A1_G0_result[pos + 1] = "￿";
						A1_G1_result[pos + 1] = "G";
					} else {
						A0_G0_result[pos + 1] = nextCh;
						A0_G1_result[pos + 1] = nextCh;
						A1_G0_result[pos + 1] = nextCh;
						A1_G1_result[pos + 1] = nextCh;
					}
					pos++;
				}
			}
		}
		return {
			A0_G0: A0_G0_result.join(""),
			A0_G1: A0_G1_result.join(""),
			A1_G0: A1_G0_result.join(""),
			A1_G1: A1_G1_result.join("")
		};
	}
	resolveAnchors(allowA, allowG) {
		if (!this.hasAnchor || !this._anchorCache || typeof this.source !== "string") return this.source;
		if (allowA) if (allowG) return this._anchorCache.A1_G1;
		else return this._anchorCache.A1_G0;
		else if (allowG) return this._anchorCache.A0_G1;
		else return this._anchorCache.A0_G0;
	}
};
var RegExpSourceList = class {
	_items;
	_hasAnchors;
	_cached;
	_anchorCache;
	constructor() {
		this._items = [];
		this._hasAnchors = false;
		this._cached = null;
		this._anchorCache = {
			A0_G0: null,
			A0_G1: null,
			A1_G0: null,
			A1_G1: null
		};
	}
	dispose() {
		this._disposeCaches();
	}
	_disposeCaches() {
		if (this._cached) {
			this._cached.dispose();
			this._cached = null;
		}
		if (this._anchorCache.A0_G0) {
			this._anchorCache.A0_G0.dispose();
			this._anchorCache.A0_G0 = null;
		}
		if (this._anchorCache.A0_G1) {
			this._anchorCache.A0_G1.dispose();
			this._anchorCache.A0_G1 = null;
		}
		if (this._anchorCache.A1_G0) {
			this._anchorCache.A1_G0.dispose();
			this._anchorCache.A1_G0 = null;
		}
		if (this._anchorCache.A1_G1) {
			this._anchorCache.A1_G1.dispose();
			this._anchorCache.A1_G1 = null;
		}
	}
	push(item) {
		this._items.push(item);
		this._hasAnchors = this._hasAnchors || item.hasAnchor;
	}
	unshift(item) {
		this._items.unshift(item);
		this._hasAnchors = this._hasAnchors || item.hasAnchor;
	}
	length() {
		return this._items.length;
	}
	setSource(index, newSource) {
		if (this._items[index].source !== newSource) {
			this._disposeCaches();
			this._items[index].setSource(newSource);
		}
	}
	compile(onigLib) {
		if (!this._cached) this._cached = new CompiledRule(onigLib, this._items.map((e) => e.source), this._items.map((e) => e.ruleId));
		return this._cached;
	}
	compileAG(onigLib, allowA, allowG) {
		if (!this._hasAnchors) return this.compile(onigLib);
		else if (allowA) if (allowG) {
			if (!this._anchorCache.A1_G1) this._anchorCache.A1_G1 = this._resolveAnchors(onigLib, allowA, allowG);
			return this._anchorCache.A1_G1;
		} else {
			if (!this._anchorCache.A1_G0) this._anchorCache.A1_G0 = this._resolveAnchors(onigLib, allowA, allowG);
			return this._anchorCache.A1_G0;
		}
		else if (allowG) {
			if (!this._anchorCache.A0_G1) this._anchorCache.A0_G1 = this._resolveAnchors(onigLib, allowA, allowG);
			return this._anchorCache.A0_G1;
		} else {
			if (!this._anchorCache.A0_G0) this._anchorCache.A0_G0 = this._resolveAnchors(onigLib, allowA, allowG);
			return this._anchorCache.A0_G0;
		}
	}
	_resolveAnchors(onigLib, allowA, allowG) {
		return new CompiledRule(onigLib, this._items.map((e) => e.resolveAnchors(allowA, allowG)), this._items.map((e) => e.ruleId));
	}
};
var CompiledRule = class {
	constructor(onigLib, regExps, rules) {
		this.regExps = regExps;
		this.rules = rules;
		this.scanner = onigLib.createOnigScanner(regExps);
	}
	scanner;
	dispose() {
		if (typeof this.scanner.dispose === "function") this.scanner.dispose();
	}
	toString() {
		const r = [];
		for (let i = 0, len = this.rules.length; i < len; i++) r.push("   - " + this.rules[i] + ": " + this.regExps[i]);
		return r.join("\n");
	}
	findNextMatchSync(string, startPosition, options) {
		const result = this.scanner.findNextMatchSync(string, startPosition, options);
		if (!result) return null;
		return {
			ruleId: this.rules[result.index],
			captureIndices: result.captureIndices
		};
	}
};
var BasicScopeAttributes = class {
	constructor(languageId, tokenType) {
		this.languageId = languageId;
		this.tokenType = tokenType;
	}
};
var BasicScopeAttributesProvider = class _BasicScopeAttributesProvider {
	_defaultAttributes;
	_embeddedLanguagesMatcher;
	constructor(initialLanguageId, embeddedLanguages) {
		this._defaultAttributes = new BasicScopeAttributes(initialLanguageId, 8);
		this._embeddedLanguagesMatcher = new ScopeMatcher(Object.entries(embeddedLanguages || {}));
	}
	getDefaultAttributes() {
		return this._defaultAttributes;
	}
	getBasicScopeAttributes(scopeName) {
		if (scopeName === null) return _BasicScopeAttributesProvider._NULL_SCOPE_METADATA;
		return this._getBasicScopeAttributes.get(scopeName);
	}
	static _NULL_SCOPE_METADATA = new BasicScopeAttributes(0, 0);
	_getBasicScopeAttributes = new CachedFn((scopeName) => {
		return new BasicScopeAttributes(this._scopeToLanguage(scopeName), this._toStandardTokenType(scopeName));
	});
	/**
	* Given a produced TM scope, return the language that token describes or null if unknown.
	* e.g. source.html => html, source.css.embedded.html => css, punctuation.definition.tag.html => null
	*/
	_scopeToLanguage(scope) {
		return this._embeddedLanguagesMatcher.match(scope) || 0;
	}
	_toStandardTokenType(scopeName) {
		const m = scopeName.match(_BasicScopeAttributesProvider.STANDARD_TOKEN_TYPE_REGEXP);
		if (!m) return 8;
		switch (m[1]) {
			case "comment": return 1;
			case "string": return 2;
			case "regex": return 3;
			case "meta.embedded": return 0;
		}
		throw new Error("Unexpected match for standard token type!");
	}
	static STANDARD_TOKEN_TYPE_REGEXP = /\b(comment|string|regex|meta\.embedded)\b/;
};
var ScopeMatcher = class {
	values;
	scopesRegExp;
	constructor(values) {
		if (values.length === 0) {
			this.values = null;
			this.scopesRegExp = null;
		} else {
			this.values = new Map(values);
			const escapedScopes = values.map(([scopeName, value]) => escapeRegExpCharacters(scopeName));
			escapedScopes.sort();
			escapedScopes.reverse();
			this.scopesRegExp = new RegExp(`^((${escapedScopes.join(")|(")}))($|\\.)`, "");
		}
	}
	match(scope) {
		if (!this.scopesRegExp) return;
		const m = scope.match(this.scopesRegExp);
		if (!m) return;
		return this.values.get(m[1]);
	}
};
typeof process !== "undefined" && process.env["VSCODE_TEXTMATE_DEBUG"];
var UseOnigurumaFindOptions = false;
var TokenizeStringResult = class {
	constructor(stack, stoppedEarly) {
		this.stack = stack;
		this.stoppedEarly = stoppedEarly;
	}
};
function _tokenizeString(grammar, lineText, isFirstLine, linePos, stack, lineTokens, checkWhileConditions, timeLimit) {
	const lineLength = lineText.content.length;
	let STOP = false;
	let anchorPosition = -1;
	if (checkWhileConditions) {
		const whileCheckResult = _checkWhileConditions(grammar, lineText, isFirstLine, linePos, stack, lineTokens);
		stack = whileCheckResult.stack;
		linePos = whileCheckResult.linePos;
		isFirstLine = whileCheckResult.isFirstLine;
		anchorPosition = whileCheckResult.anchorPosition;
	}
	const startTime = Date.now();
	while (!STOP) {
		if (timeLimit !== 0) {
			if (Date.now() - startTime > timeLimit) return new TokenizeStringResult(stack, true);
		}
		scanNext();
	}
	return new TokenizeStringResult(stack, false);
	function scanNext() {
		const r = matchRuleOrInjections(grammar, lineText, isFirstLine, linePos, stack, anchorPosition);
		if (!r) {
			lineTokens.produce(stack, lineLength);
			STOP = true;
			return;
		}
		const captureIndices = r.captureIndices;
		const matchedRuleId = r.matchedRuleId;
		const hasAdvanced = captureIndices && captureIndices.length > 0 ? captureIndices[0].end > linePos : false;
		if (matchedRuleId === endRuleId) {
			const poppedRule = stack.getRule(grammar);
			lineTokens.produce(stack, captureIndices[0].start);
			stack = stack.withContentNameScopesList(stack.nameScopesList);
			handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, poppedRule.endCaptures, captureIndices);
			lineTokens.produce(stack, captureIndices[0].end);
			const popped = stack;
			stack = stack.parent;
			anchorPosition = popped.getAnchorPos();
			if (!hasAdvanced && popped.getEnterPos() === linePos) {
				stack = popped;
				lineTokens.produce(stack, lineLength);
				STOP = true;
				return;
			}
		} else {
			const _rule = grammar.getRule(matchedRuleId);
			lineTokens.produce(stack, captureIndices[0].start);
			const beforePush = stack;
			const scopeName = _rule.getName(lineText.content, captureIndices);
			const nameScopesList = stack.contentNameScopesList.pushAttributed(scopeName, grammar);
			stack = stack.push(matchedRuleId, linePos, anchorPosition, captureIndices[0].end === lineLength, null, nameScopesList, nameScopesList);
			if (_rule instanceof BeginEndRule) {
				const pushedRule = _rule;
				handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, pushedRule.beginCaptures, captureIndices);
				lineTokens.produce(stack, captureIndices[0].end);
				anchorPosition = captureIndices[0].end;
				const contentName = pushedRule.getContentName(lineText.content, captureIndices);
				const contentNameScopesList = nameScopesList.pushAttributed(contentName, grammar);
				stack = stack.withContentNameScopesList(contentNameScopesList);
				if (pushedRule.endHasBackReferences) stack = stack.withEndRule(pushedRule.getEndWithResolvedBackReferences(lineText.content, captureIndices));
				if (!hasAdvanced && beforePush.hasSameRuleAs(stack)) {
					stack = stack.pop();
					lineTokens.produce(stack, lineLength);
					STOP = true;
					return;
				}
			} else if (_rule instanceof BeginWhileRule) {
				const pushedRule = _rule;
				handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, pushedRule.beginCaptures, captureIndices);
				lineTokens.produce(stack, captureIndices[0].end);
				anchorPosition = captureIndices[0].end;
				const contentName = pushedRule.getContentName(lineText.content, captureIndices);
				const contentNameScopesList = nameScopesList.pushAttributed(contentName, grammar);
				stack = stack.withContentNameScopesList(contentNameScopesList);
				if (pushedRule.whileHasBackReferences) stack = stack.withEndRule(pushedRule.getWhileWithResolvedBackReferences(lineText.content, captureIndices));
				if (!hasAdvanced && beforePush.hasSameRuleAs(stack)) {
					stack = stack.pop();
					lineTokens.produce(stack, lineLength);
					STOP = true;
					return;
				}
			} else {
				handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, _rule.captures, captureIndices);
				lineTokens.produce(stack, captureIndices[0].end);
				stack = stack.pop();
				if (!hasAdvanced) {
					stack = stack.safePop();
					lineTokens.produce(stack, lineLength);
					STOP = true;
					return;
				}
			}
		}
		if (captureIndices[0].end > linePos) {
			linePos = captureIndices[0].end;
			isFirstLine = false;
		}
	}
}
function _checkWhileConditions(grammar, lineText, isFirstLine, linePos, stack, lineTokens) {
	let anchorPosition = stack.beginRuleCapturedEOL ? 0 : -1;
	const whileRules = [];
	for (let node = stack; node; node = node.pop()) {
		const nodeRule = node.getRule(grammar);
		if (nodeRule instanceof BeginWhileRule) whileRules.push({
			rule: nodeRule,
			stack: node
		});
	}
	for (let whileRule = whileRules.pop(); whileRule; whileRule = whileRules.pop()) {
		const { ruleScanner, findOptions } = prepareRuleWhileSearch(whileRule.rule, grammar, whileRule.stack.endRule, isFirstLine, linePos === anchorPosition);
		const r = ruleScanner.findNextMatchSync(lineText, linePos, findOptions);
		if (r) {
			if (r.ruleId !== whileRuleId) {
				stack = whileRule.stack.pop();
				break;
			}
			if (r.captureIndices && r.captureIndices.length) {
				lineTokens.produce(whileRule.stack, r.captureIndices[0].start);
				handleCaptures(grammar, lineText, isFirstLine, whileRule.stack, lineTokens, whileRule.rule.whileCaptures, r.captureIndices);
				lineTokens.produce(whileRule.stack, r.captureIndices[0].end);
				anchorPosition = r.captureIndices[0].end;
				if (r.captureIndices[0].end > linePos) {
					linePos = r.captureIndices[0].end;
					isFirstLine = false;
				}
			}
		} else {
			stack = whileRule.stack.pop();
			break;
		}
	}
	return {
		stack,
		linePos,
		anchorPosition,
		isFirstLine
	};
}
function matchRuleOrInjections(grammar, lineText, isFirstLine, linePos, stack, anchorPosition) {
	const matchResult = matchRule(grammar, lineText, isFirstLine, linePos, stack, anchorPosition);
	const injections = grammar.getInjections();
	if (injections.length === 0) return matchResult;
	const injectionResult = matchInjections(injections, grammar, lineText, isFirstLine, linePos, stack, anchorPosition);
	if (!injectionResult) return matchResult;
	if (!matchResult) return injectionResult;
	const matchResultScore = matchResult.captureIndices[0].start;
	const injectionResultScore = injectionResult.captureIndices[0].start;
	if (injectionResultScore < matchResultScore || injectionResult.priorityMatch && injectionResultScore === matchResultScore) return injectionResult;
	return matchResult;
}
function matchRule(grammar, lineText, isFirstLine, linePos, stack, anchorPosition) {
	const { ruleScanner, findOptions } = prepareRuleSearch(stack.getRule(grammar), grammar, stack.endRule, isFirstLine, linePos === anchorPosition);
	const r = ruleScanner.findNextMatchSync(lineText, linePos, findOptions);
	if (r) return {
		captureIndices: r.captureIndices,
		matchedRuleId: r.ruleId
	};
	return null;
}
function matchInjections(injections, grammar, lineText, isFirstLine, linePos, stack, anchorPosition) {
	let bestMatchRating = Number.MAX_VALUE;
	let bestMatchCaptureIndices = null;
	let bestMatchRuleId;
	let bestMatchResultPriority = 0;
	const scopes = stack.contentNameScopesList.getScopeNames();
	for (let i = 0, len = injections.length; i < len; i++) {
		const injection = injections[i];
		if (!injection.matcher(scopes)) continue;
		const { ruleScanner, findOptions } = prepareRuleSearch(grammar.getRule(injection.ruleId), grammar, null, isFirstLine, linePos === anchorPosition);
		const matchResult = ruleScanner.findNextMatchSync(lineText, linePos, findOptions);
		if (!matchResult) continue;
		const matchRating = matchResult.captureIndices[0].start;
		if (matchRating >= bestMatchRating) continue;
		bestMatchRating = matchRating;
		bestMatchCaptureIndices = matchResult.captureIndices;
		bestMatchRuleId = matchResult.ruleId;
		bestMatchResultPriority = injection.priority;
		if (bestMatchRating === linePos) break;
	}
	if (bestMatchCaptureIndices) return {
		priorityMatch: bestMatchResultPriority === -1,
		captureIndices: bestMatchCaptureIndices,
		matchedRuleId: bestMatchRuleId
	};
	return null;
}
function prepareRuleSearch(rule, grammar, endRegexSource, allowA, allowG) {
	if (UseOnigurumaFindOptions) return {
		ruleScanner: rule.compile(grammar, endRegexSource),
		findOptions: getFindOptions(allowA, allowG)
	};
	return {
		ruleScanner: rule.compileAG(grammar, endRegexSource, allowA, allowG),
		findOptions: 0
	};
}
function prepareRuleWhileSearch(rule, grammar, endRegexSource, allowA, allowG) {
	if (UseOnigurumaFindOptions) return {
		ruleScanner: rule.compileWhile(grammar, endRegexSource),
		findOptions: getFindOptions(allowA, allowG)
	};
	return {
		ruleScanner: rule.compileWhileAG(grammar, endRegexSource, allowA, allowG),
		findOptions: 0
	};
}
function getFindOptions(allowA, allowG) {
	let options = 0;
	if (!allowA) options |= 1;
	if (!allowG) options |= 4;
	return options;
}
function handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, captures, captureIndices) {
	if (captures.length === 0) return;
	const lineTextContent = lineText.content;
	const len = Math.min(captures.length, captureIndices.length);
	const localStack = [];
	const maxEnd = captureIndices[0].end;
	for (let i = 0; i < len; i++) {
		const captureRule = captures[i];
		if (captureRule === null) continue;
		const captureIndex = captureIndices[i];
		if (captureIndex.length === 0) continue;
		if (captureIndex.start > maxEnd) break;
		while (localStack.length > 0 && localStack[localStack.length - 1].endPos <= captureIndex.start) {
			lineTokens.produceFromScopes(localStack[localStack.length - 1].scopes, localStack[localStack.length - 1].endPos);
			localStack.pop();
		}
		if (localStack.length > 0) lineTokens.produceFromScopes(localStack[localStack.length - 1].scopes, captureIndex.start);
		else lineTokens.produce(stack, captureIndex.start);
		if (captureRule.retokenizeCapturedWithRuleId) {
			const scopeName = captureRule.getName(lineTextContent, captureIndices);
			const nameScopesList = stack.contentNameScopesList.pushAttributed(scopeName, grammar);
			const contentName = captureRule.getContentName(lineTextContent, captureIndices);
			const contentNameScopesList = nameScopesList.pushAttributed(contentName, grammar);
			const stackClone = stack.push(captureRule.retokenizeCapturedWithRuleId, captureIndex.start, -1, false, null, nameScopesList, contentNameScopesList);
			const onigSubStr = grammar.createOnigString(lineTextContent.substring(0, captureIndex.end));
			_tokenizeString(grammar, onigSubStr, isFirstLine && captureIndex.start === 0, captureIndex.start, stackClone, lineTokens, false, 0);
			disposeOnigString(onigSubStr);
			continue;
		}
		const captureRuleScopeName = captureRule.getName(lineTextContent, captureIndices);
		if (captureRuleScopeName !== null) {
			const captureRuleScopesList = (localStack.length > 0 ? localStack[localStack.length - 1].scopes : stack.contentNameScopesList).pushAttributed(captureRuleScopeName, grammar);
			localStack.push(new LocalStackElement(captureRuleScopesList, captureIndex.end));
		}
	}
	while (localStack.length > 0) {
		lineTokens.produceFromScopes(localStack[localStack.length - 1].scopes, localStack[localStack.length - 1].endPos);
		localStack.pop();
	}
}
var LocalStackElement = class {
	scopes;
	endPos;
	constructor(scopes, endPos) {
		this.scopes = scopes;
		this.endPos = endPos;
	}
};
function createGrammar(scopeName, grammar, initialLanguage, embeddedLanguages, tokenTypes, balancedBracketSelectors, grammarRepository, onigLib) {
	return new Grammar(scopeName, grammar, initialLanguage, embeddedLanguages, tokenTypes, balancedBracketSelectors, grammarRepository, onigLib);
}
function collectInjections(result, selector, rule, ruleFactoryHelper, grammar) {
	const matchers = createMatchers(selector, nameMatcher);
	const ruleId = RuleFactory.getCompiledRuleId(rule, ruleFactoryHelper, grammar.repository);
	for (const matcher of matchers) result.push({
		debugSelector: selector,
		matcher: matcher.matcher,
		ruleId,
		grammar,
		priority: matcher.priority
	});
}
function nameMatcher(identifers, scopes) {
	if (scopes.length < identifers.length) return false;
	let lastIndex = 0;
	return identifers.every((identifier) => {
		for (let i = lastIndex; i < scopes.length; i++) if (scopesAreMatching(scopes[i], identifier)) {
			lastIndex = i + 1;
			return true;
		}
		return false;
	});
}
function scopesAreMatching(thisScopeName, scopeName) {
	if (!thisScopeName) return false;
	if (thisScopeName === scopeName) return true;
	const len = scopeName.length;
	return thisScopeName.length > len && thisScopeName.substr(0, len) === scopeName && thisScopeName[len] === ".";
}
var Grammar = class {
	constructor(_rootScopeName, grammar, initialLanguage, embeddedLanguages, tokenTypes, balancedBracketSelectors, grammarRepository, _onigLib) {
		this._rootScopeName = _rootScopeName;
		this.balancedBracketSelectors = balancedBracketSelectors;
		this._onigLib = _onigLib;
		this._basicScopeAttributesProvider = new BasicScopeAttributesProvider(initialLanguage, embeddedLanguages);
		this._rootId = -1;
		this._lastRuleId = 0;
		this._ruleId2desc = [null];
		this._includedGrammars = {};
		this._grammarRepository = grammarRepository;
		this._grammar = initGrammar(grammar, null);
		this._injections = null;
		this._tokenTypeMatchers = [];
		if (tokenTypes) for (const selector of Object.keys(tokenTypes)) {
			const matchers = createMatchers(selector, nameMatcher);
			for (const matcher of matchers) this._tokenTypeMatchers.push({
				matcher: matcher.matcher,
				type: tokenTypes[selector]
			});
		}
	}
	_rootId;
	_lastRuleId;
	_ruleId2desc;
	_includedGrammars;
	_grammarRepository;
	_grammar;
	_injections;
	_basicScopeAttributesProvider;
	_tokenTypeMatchers;
	get themeProvider() {
		return this._grammarRepository;
	}
	dispose() {
		for (const rule of this._ruleId2desc) if (rule) rule.dispose();
	}
	createOnigScanner(sources) {
		return this._onigLib.createOnigScanner(sources);
	}
	createOnigString(sources) {
		return this._onigLib.createOnigString(sources);
	}
	getMetadataForScope(scope) {
		return this._basicScopeAttributesProvider.getBasicScopeAttributes(scope);
	}
	_collectInjections() {
		const grammarRepository = {
			lookup: (scopeName2) => {
				if (scopeName2 === this._rootScopeName) return this._grammar;
				return this.getExternalGrammar(scopeName2);
			},
			injections: (scopeName2) => {
				return this._grammarRepository.injections(scopeName2);
			}
		};
		const result = [];
		const scopeName = this._rootScopeName;
		const grammar = grammarRepository.lookup(scopeName);
		if (grammar) {
			const rawInjections = grammar.injections;
			if (rawInjections) for (let expression in rawInjections) collectInjections(result, expression, rawInjections[expression], this, grammar);
			const injectionScopeNames = this._grammarRepository.injections(scopeName);
			if (injectionScopeNames) injectionScopeNames.forEach((injectionScopeName) => {
				const injectionGrammar = this.getExternalGrammar(injectionScopeName);
				if (injectionGrammar) {
					const selector = injectionGrammar.injectionSelector;
					if (selector) collectInjections(result, selector, injectionGrammar, this, injectionGrammar);
				}
			});
		}
		result.sort((i1, i2) => i1.priority - i2.priority);
		return result;
	}
	getInjections() {
		if (this._injections === null) this._injections = this._collectInjections();
		return this._injections;
	}
	registerRule(factory) {
		const id = ++this._lastRuleId;
		const result = factory(ruleIdFromNumber(id));
		this._ruleId2desc[id] = result;
		return result;
	}
	getRule(ruleId) {
		return this._ruleId2desc[ruleIdToNumber(ruleId)];
	}
	getExternalGrammar(scopeName, repository) {
		if (this._includedGrammars[scopeName]) return this._includedGrammars[scopeName];
		else if (this._grammarRepository) {
			const rawIncludedGrammar = this._grammarRepository.lookup(scopeName);
			if (rawIncludedGrammar) {
				this._includedGrammars[scopeName] = initGrammar(rawIncludedGrammar, repository && repository.$base);
				return this._includedGrammars[scopeName];
			}
		}
	}
	tokenizeLine(lineText, prevState, timeLimit = 0) {
		const r = this._tokenize(lineText, prevState, false, timeLimit);
		return {
			tokens: r.lineTokens.getResult(r.ruleStack, r.lineLength),
			ruleStack: r.ruleStack,
			stoppedEarly: r.stoppedEarly
		};
	}
	tokenizeLine2(lineText, prevState, timeLimit = 0) {
		const r = this._tokenize(lineText, prevState, true, timeLimit);
		return {
			tokens: r.lineTokens.getBinaryResult(r.ruleStack, r.lineLength),
			ruleStack: r.ruleStack,
			stoppedEarly: r.stoppedEarly
		};
	}
	_tokenize(lineText, prevState, emitBinaryTokens, timeLimit) {
		if (this._rootId === -1) {
			this._rootId = RuleFactory.getCompiledRuleId(this._grammar.repository.$self, this, this._grammar.repository);
			this.getInjections();
		}
		let isFirstLine;
		if (!prevState || prevState === StateStackImpl.NULL) {
			isFirstLine = true;
			const rawDefaultMetadata = this._basicScopeAttributesProvider.getDefaultAttributes();
			const defaultStyle = this.themeProvider.getDefaults();
			const defaultMetadata = EncodedTokenMetadata.set(0, rawDefaultMetadata.languageId, rawDefaultMetadata.tokenType, null, defaultStyle.fontStyle, defaultStyle.foregroundId, defaultStyle.backgroundId);
			const rootScopeName = this.getRule(this._rootId).getName(null, null);
			let scopeList;
			if (rootScopeName) scopeList = AttributedScopeStack.createRootAndLookUpScopeName(rootScopeName, defaultMetadata, this);
			else scopeList = AttributedScopeStack.createRoot("unknown", defaultMetadata);
			prevState = new StateStackImpl(null, this._rootId, -1, -1, false, null, scopeList, scopeList);
		} else {
			isFirstLine = false;
			prevState.reset();
		}
		lineText = lineText + "\n";
		const onigLineText = this.createOnigString(lineText);
		const lineLength = onigLineText.content.length;
		const lineTokens = new LineTokens(emitBinaryTokens, lineText, this._tokenTypeMatchers, this.balancedBracketSelectors);
		const r = _tokenizeString(this, onigLineText, isFirstLine, 0, prevState, lineTokens, true, timeLimit);
		disposeOnigString(onigLineText);
		return {
			lineLength,
			lineTokens,
			ruleStack: r.stack,
			stoppedEarly: r.stoppedEarly
		};
	}
};
function initGrammar(grammar, base) {
	grammar = clone(grammar);
	grammar.repository = grammar.repository || {};
	grammar.repository.$self = {
		$vscodeTextmateLocation: grammar.$vscodeTextmateLocation,
		patterns: grammar.patterns,
		name: grammar.scopeName
	};
	grammar.repository.$base = base || grammar.repository.$self;
	return grammar;
}
var AttributedScopeStack = class _AttributedScopeStack {
	/**
	* Invariant:
	* ```
	* if (parent && !scopePath.extends(parent.scopePath)) {
	* 	throw new Error();
	* }
	* ```
	*/
	constructor(parent, scopePath, tokenAttributes) {
		this.parent = parent;
		this.scopePath = scopePath;
		this.tokenAttributes = tokenAttributes;
	}
	static fromExtension(namesScopeList, contentNameScopesList) {
		let current = namesScopeList;
		let scopeNames = namesScopeList?.scopePath ?? null;
		for (const frame of contentNameScopesList) {
			scopeNames = ScopeStack.push(scopeNames, frame.scopeNames);
			current = new _AttributedScopeStack(current, scopeNames, frame.encodedTokenAttributes);
		}
		return current;
	}
	static createRoot(scopeName, tokenAttributes) {
		return new _AttributedScopeStack(null, new ScopeStack(null, scopeName), tokenAttributes);
	}
	static createRootAndLookUpScopeName(scopeName, tokenAttributes, grammar) {
		const rawRootMetadata = grammar.getMetadataForScope(scopeName);
		const scopePath = new ScopeStack(null, scopeName);
		const rootStyle = grammar.themeProvider.themeMatch(scopePath);
		return new _AttributedScopeStack(null, scopePath, _AttributedScopeStack.mergeAttributes(tokenAttributes, rawRootMetadata, rootStyle));
	}
	get scopeName() {
		return this.scopePath.scopeName;
	}
	toString() {
		return this.getScopeNames().join(" ");
	}
	equals(other) {
		return _AttributedScopeStack.equals(this, other);
	}
	static equals(a, b) {
		do {
			if (a === b) return true;
			if (!a && !b) return true;
			if (!a || !b) return false;
			if (a.scopeName !== b.scopeName || a.tokenAttributes !== b.tokenAttributes) return false;
			a = a.parent;
			b = b.parent;
		} while (true);
	}
	static mergeAttributes(existingTokenAttributes, basicScopeAttributes, styleAttributes) {
		let fontStyle = -1;
		let foreground = 0;
		let background = 0;
		if (styleAttributes !== null) {
			fontStyle = styleAttributes.fontStyle;
			foreground = styleAttributes.foregroundId;
			background = styleAttributes.backgroundId;
		}
		return EncodedTokenMetadata.set(existingTokenAttributes, basicScopeAttributes.languageId, basicScopeAttributes.tokenType, null, fontStyle, foreground, background);
	}
	pushAttributed(scopePath, grammar) {
		if (scopePath === null) return this;
		if (scopePath.indexOf(" ") === -1) return _AttributedScopeStack._pushAttributed(this, scopePath, grammar);
		const scopes = scopePath.split(/ /g);
		let result = this;
		for (const scope of scopes) result = _AttributedScopeStack._pushAttributed(result, scope, grammar);
		return result;
	}
	static _pushAttributed(target, scopeName, grammar) {
		const rawMetadata = grammar.getMetadataForScope(scopeName);
		const newPath = target.scopePath.push(scopeName);
		const scopeThemeMatchResult = grammar.themeProvider.themeMatch(newPath);
		return new _AttributedScopeStack(target, newPath, _AttributedScopeStack.mergeAttributes(target.tokenAttributes, rawMetadata, scopeThemeMatchResult));
	}
	getScopeNames() {
		return this.scopePath.getSegments();
	}
	getExtensionIfDefined(base) {
		const result = [];
		let self = this;
		while (self && self !== base) {
			result.push({
				encodedTokenAttributes: self.tokenAttributes,
				scopeNames: self.scopePath.getExtensionIfDefined(self.parent?.scopePath ?? null)
			});
			self = self.parent;
		}
		return self === base ? result.reverse() : void 0;
	}
};
var StateStackImpl = class _StateStackImpl {
	/**
	* Invariant:
	* ```
	* if (contentNameScopesList !== nameScopesList && contentNameScopesList?.parent !== nameScopesList) {
	* 	throw new Error();
	* }
	* if (this.parent && !nameScopesList.extends(this.parent.contentNameScopesList)) {
	* 	throw new Error();
	* }
	* ```
	*/
	constructor(parent, ruleId, enterPos, anchorPos, beginRuleCapturedEOL, endRule, nameScopesList, contentNameScopesList) {
		this.parent = parent;
		this.ruleId = ruleId;
		this.beginRuleCapturedEOL = beginRuleCapturedEOL;
		this.endRule = endRule;
		this.nameScopesList = nameScopesList;
		this.contentNameScopesList = contentNameScopesList;
		this.depth = this.parent ? this.parent.depth + 1 : 1;
		this._enterPos = enterPos;
		this._anchorPos = anchorPos;
	}
	_stackElementBrand = void 0;
	static NULL = new _StateStackImpl(null, 0, 0, 0, false, null, null, null);
	/**
	* The position on the current line where this state was pushed.
	* This is relevant only while tokenizing a line, to detect endless loops.
	* Its value is meaningless across lines.
	*/
	_enterPos;
	/**
	* The captured anchor position when this stack element was pushed.
	* This is relevant only while tokenizing a line, to restore the anchor position when popping.
	* Its value is meaningless across lines.
	*/
	_anchorPos;
	/**
	* The depth of the stack.
	*/
	depth;
	equals(other) {
		if (other === null) return false;
		return _StateStackImpl._equals(this, other);
	}
	static _equals(a, b) {
		if (a === b) return true;
		if (!this._structuralEquals(a, b)) return false;
		return AttributedScopeStack.equals(a.contentNameScopesList, b.contentNameScopesList);
	}
	/**
	* A structural equals check. Does not take into account `scopes`.
	*/
	static _structuralEquals(a, b) {
		do {
			if (a === b) return true;
			if (!a && !b) return true;
			if (!a || !b) return false;
			if (a.depth !== b.depth || a.ruleId !== b.ruleId || a.endRule !== b.endRule) return false;
			a = a.parent;
			b = b.parent;
		} while (true);
	}
	clone() {
		return this;
	}
	static _reset(el) {
		while (el) {
			el._enterPos = -1;
			el._anchorPos = -1;
			el = el.parent;
		}
	}
	reset() {
		_StateStackImpl._reset(this);
	}
	pop() {
		return this.parent;
	}
	safePop() {
		if (this.parent) return this.parent;
		return this;
	}
	push(ruleId, enterPos, anchorPos, beginRuleCapturedEOL, endRule, nameScopesList, contentNameScopesList) {
		return new _StateStackImpl(this, ruleId, enterPos, anchorPos, beginRuleCapturedEOL, endRule, nameScopesList, contentNameScopesList);
	}
	getEnterPos() {
		return this._enterPos;
	}
	getAnchorPos() {
		return this._anchorPos;
	}
	getRule(grammar) {
		return grammar.getRule(this.ruleId);
	}
	toString() {
		const r = [];
		this._writeString(r, 0);
		return "[" + r.join(",") + "]";
	}
	_writeString(res, outIndex) {
		if (this.parent) outIndex = this.parent._writeString(res, outIndex);
		res[outIndex++] = `(${this.ruleId}, ${this.nameScopesList?.toString()}, ${this.contentNameScopesList?.toString()})`;
		return outIndex;
	}
	withContentNameScopesList(contentNameScopeStack) {
		if (this.contentNameScopesList === contentNameScopeStack) return this;
		return this.parent.push(this.ruleId, this._enterPos, this._anchorPos, this.beginRuleCapturedEOL, this.endRule, this.nameScopesList, contentNameScopeStack);
	}
	withEndRule(endRule) {
		if (this.endRule === endRule) return this;
		return new _StateStackImpl(this.parent, this.ruleId, this._enterPos, this._anchorPos, this.beginRuleCapturedEOL, endRule, this.nameScopesList, this.contentNameScopesList);
	}
	hasSameRuleAs(other) {
		let el = this;
		while (el && el._enterPos === other._enterPos) {
			if (el.ruleId === other.ruleId) return true;
			el = el.parent;
		}
		return false;
	}
	toStateStackFrame() {
		return {
			ruleId: ruleIdToNumber(this.ruleId),
			beginRuleCapturedEOL: this.beginRuleCapturedEOL,
			endRule: this.endRule,
			nameScopesList: this.nameScopesList?.getExtensionIfDefined(this.parent?.nameScopesList ?? null) ?? [],
			contentNameScopesList: this.contentNameScopesList?.getExtensionIfDefined(this.nameScopesList) ?? []
		};
	}
	static pushFrame(self, frame) {
		const namesScopeList = AttributedScopeStack.fromExtension(self?.nameScopesList ?? null, frame.nameScopesList);
		return new _StateStackImpl(self, ruleIdFromNumber(frame.ruleId), frame.enterPos ?? -1, frame.anchorPos ?? -1, frame.beginRuleCapturedEOL, frame.endRule, namesScopeList, AttributedScopeStack.fromExtension(namesScopeList, frame.contentNameScopesList));
	}
};
var BalancedBracketSelectors = class {
	balancedBracketScopes;
	unbalancedBracketScopes;
	allowAny = false;
	constructor(balancedBracketScopes, unbalancedBracketScopes) {
		this.balancedBracketScopes = balancedBracketScopes.flatMap((selector) => {
			if (selector === "*") {
				this.allowAny = true;
				return [];
			}
			return createMatchers(selector, nameMatcher).map((m) => m.matcher);
		});
		this.unbalancedBracketScopes = unbalancedBracketScopes.flatMap((selector) => createMatchers(selector, nameMatcher).map((m) => m.matcher));
	}
	get matchesAlways() {
		return this.allowAny && this.unbalancedBracketScopes.length === 0;
	}
	get matchesNever() {
		return this.balancedBracketScopes.length === 0 && !this.allowAny;
	}
	match(scopes) {
		for (const excluder of this.unbalancedBracketScopes) if (excluder(scopes)) return false;
		for (const includer of this.balancedBracketScopes) if (includer(scopes)) return true;
		return this.allowAny;
	}
};
var LineTokens = class {
	constructor(emitBinaryTokens, lineText, tokenTypeOverrides, balancedBracketSelectors) {
		this.balancedBracketSelectors = balancedBracketSelectors;
		this._emitBinaryTokens = emitBinaryTokens;
		this._tokenTypeOverrides = tokenTypeOverrides;
		this._lineText = null;
		this._tokens = [];
		this._binaryTokens = [];
		this._lastTokenEndIndex = 0;
	}
	_emitBinaryTokens;
	/**
	* defined only if `false`.
	*/
	_lineText;
	/**
	* used only if `_emitBinaryTokens` is false.
	*/
	_tokens;
	/**
	* used only if `_emitBinaryTokens` is true.
	*/
	_binaryTokens;
	_lastTokenEndIndex;
	_tokenTypeOverrides;
	produce(stack, endIndex) {
		this.produceFromScopes(stack.contentNameScopesList, endIndex);
	}
	produceFromScopes(scopesList, endIndex) {
		if (this._lastTokenEndIndex >= endIndex) return;
		if (this._emitBinaryTokens) {
			let metadata = scopesList?.tokenAttributes ?? 0;
			let containsBalancedBrackets = false;
			if (this.balancedBracketSelectors?.matchesAlways) containsBalancedBrackets = true;
			if (this._tokenTypeOverrides.length > 0 || this.balancedBracketSelectors && !this.balancedBracketSelectors.matchesAlways && !this.balancedBracketSelectors.matchesNever) {
				const scopes2 = scopesList?.getScopeNames() ?? [];
				for (const tokenType of this._tokenTypeOverrides) if (tokenType.matcher(scopes2)) metadata = EncodedTokenMetadata.set(metadata, 0, toOptionalTokenType(tokenType.type), null, -1, 0, 0);
				if (this.balancedBracketSelectors) containsBalancedBrackets = this.balancedBracketSelectors.match(scopes2);
			}
			if (containsBalancedBrackets) metadata = EncodedTokenMetadata.set(metadata, 0, 8, containsBalancedBrackets, -1, 0, 0);
			if (this._binaryTokens.length > 0 && this._binaryTokens[this._binaryTokens.length - 1] === metadata) {
				this._lastTokenEndIndex = endIndex;
				return;
			}
			this._binaryTokens.push(this._lastTokenEndIndex);
			this._binaryTokens.push(metadata);
			this._lastTokenEndIndex = endIndex;
			return;
		}
		const scopes = scopesList?.getScopeNames() ?? [];
		this._tokens.push({
			startIndex: this._lastTokenEndIndex,
			endIndex,
			scopes
		});
		this._lastTokenEndIndex = endIndex;
	}
	getResult(stack, lineLength) {
		if (this._tokens.length > 0 && this._tokens[this._tokens.length - 1].startIndex === lineLength - 1) this._tokens.pop();
		if (this._tokens.length === 0) {
			this._lastTokenEndIndex = -1;
			this.produce(stack, lineLength);
			this._tokens[this._tokens.length - 1].startIndex = 0;
		}
		return this._tokens;
	}
	getBinaryResult(stack, lineLength) {
		if (this._binaryTokens.length > 0 && this._binaryTokens[this._binaryTokens.length - 2] === lineLength - 1) {
			this._binaryTokens.pop();
			this._binaryTokens.pop();
		}
		if (this._binaryTokens.length === 0) {
			this._lastTokenEndIndex = -1;
			this.produce(stack, lineLength);
			this._binaryTokens[this._binaryTokens.length - 2] = 0;
		}
		const result = new Uint32Array(this._binaryTokens.length);
		for (let i = 0, len = this._binaryTokens.length; i < len; i++) result[i] = this._binaryTokens[i];
		return result;
	}
};
var SyncRegistry = class {
	constructor(theme, _onigLib) {
		this._onigLib = _onigLib;
		this._theme = theme;
	}
	_grammars = /* @__PURE__ */ new Map();
	_rawGrammars = /* @__PURE__ */ new Map();
	_injectionGrammars = /* @__PURE__ */ new Map();
	_theme;
	dispose() {
		for (const grammar of this._grammars.values()) grammar.dispose();
	}
	setTheme(theme) {
		this._theme = theme;
	}
	getColorMap() {
		return this._theme.getColorMap();
	}
	/**
	* Add `grammar` to registry and return a list of referenced scope names
	*/
	addGrammar(grammar, injectionScopeNames) {
		this._rawGrammars.set(grammar.scopeName, grammar);
		if (injectionScopeNames) this._injectionGrammars.set(grammar.scopeName, injectionScopeNames);
	}
	/**
	* Lookup a raw grammar.
	*/
	lookup(scopeName) {
		return this._rawGrammars.get(scopeName);
	}
	/**
	* Returns the injections for the given grammar
	*/
	injections(targetScope) {
		return this._injectionGrammars.get(targetScope);
	}
	/**
	* Get the default theme settings
	*/
	getDefaults() {
		return this._theme.getDefaults();
	}
	/**
	* Match a scope in the theme.
	*/
	themeMatch(scopePath) {
		return this._theme.match(scopePath);
	}
	/**
	* Lookup a grammar.
	*/
	grammarForScopeName(scopeName, initialLanguage, embeddedLanguages, tokenTypes, balancedBracketSelectors) {
		if (!this._grammars.has(scopeName)) {
			let rawGrammar = this._rawGrammars.get(scopeName);
			if (!rawGrammar) return null;
			this._grammars.set(scopeName, createGrammar(scopeName, rawGrammar, initialLanguage, embeddedLanguages, tokenTypes, balancedBracketSelectors, this, this._onigLib));
		}
		return this._grammars.get(scopeName);
	}
};
var Registry$1 = class {
	_options;
	_syncRegistry;
	_ensureGrammarCache;
	constructor(options) {
		this._options = options;
		this._syncRegistry = new SyncRegistry(Theme.createFromRawTheme(options.theme, options.colorMap), options.onigLib);
		this._ensureGrammarCache = /* @__PURE__ */ new Map();
	}
	dispose() {
		this._syncRegistry.dispose();
	}
	/**
	* Change the theme. Once called, no previous `ruleStack` should be used anymore.
	*/
	setTheme(theme, colorMap) {
		this._syncRegistry.setTheme(Theme.createFromRawTheme(theme, colorMap));
	}
	/**
	* Returns a lookup array for color ids.
	*/
	getColorMap() {
		return this._syncRegistry.getColorMap();
	}
	/**
	* Load the grammar for `scopeName` and all referenced included grammars asynchronously.
	* Please do not use language id 0.
	*/
	loadGrammarWithEmbeddedLanguages(initialScopeName, initialLanguage, embeddedLanguages) {
		return this.loadGrammarWithConfiguration(initialScopeName, initialLanguage, { embeddedLanguages });
	}
	/**
	* Load the grammar for `scopeName` and all referenced included grammars asynchronously.
	* Please do not use language id 0.
	*/
	loadGrammarWithConfiguration(initialScopeName, initialLanguage, configuration) {
		return this._loadGrammar(initialScopeName, initialLanguage, configuration.embeddedLanguages, configuration.tokenTypes, new BalancedBracketSelectors(configuration.balancedBracketSelectors || [], configuration.unbalancedBracketSelectors || []));
	}
	/**
	* Load the grammar for `scopeName` and all referenced included grammars asynchronously.
	*/
	loadGrammar(initialScopeName) {
		return this._loadGrammar(initialScopeName, 0, null, null, null);
	}
	_loadGrammar(initialScopeName, initialLanguage, embeddedLanguages, tokenTypes, balancedBracketSelectors) {
		const dependencyProcessor = new ScopeDependencyProcessor(this._syncRegistry, initialScopeName);
		while (dependencyProcessor.Q.length > 0) {
			dependencyProcessor.Q.map((request) => this._loadSingleGrammar(request.scopeName));
			dependencyProcessor.processQueue();
		}
		return this._grammarForScopeName(initialScopeName, initialLanguage, embeddedLanguages, tokenTypes, balancedBracketSelectors);
	}
	_loadSingleGrammar(scopeName) {
		if (!this._ensureGrammarCache.has(scopeName)) {
			this._doLoadSingleGrammar(scopeName);
			this._ensureGrammarCache.set(scopeName, true);
		}
	}
	_doLoadSingleGrammar(scopeName) {
		const grammar = this._options.loadGrammar(scopeName);
		if (grammar) {
			const injections = typeof this._options.getInjections === "function" ? this._options.getInjections(scopeName) : void 0;
			this._syncRegistry.addGrammar(grammar, injections);
		}
	}
	/**
	* Adds a rawGrammar.
	*/
	addGrammar(rawGrammar, injections = [], initialLanguage = 0, embeddedLanguages = null) {
		this._syncRegistry.addGrammar(rawGrammar, injections);
		return this._grammarForScopeName(rawGrammar.scopeName, initialLanguage, embeddedLanguages);
	}
	/**
	* Get the grammar for `scopeName`. The grammar must first be created via `loadGrammar` or `addGrammar`.
	*/
	_grammarForScopeName(scopeName, initialLanguage = 0, embeddedLanguages = null, tokenTypes = null, balancedBracketSelectors = null) {
		return this._syncRegistry.grammarForScopeName(scopeName, initialLanguage, embeddedLanguages, tokenTypes, balancedBracketSelectors);
	}
};
var INITIAL = StateStackImpl.NULL;
//#endregion
//#region node_modules/.pnpm/html-void-elements@3.0.0/node_modules/html-void-elements/index.js
/**
* List of HTML void tag names.
*
* @type {Array<string>}
*/
const htmlVoidElements = [
	"area",
	"base",
	"basefont",
	"bgsound",
	"br",
	"col",
	"command",
	"embed",
	"frame",
	"hr",
	"image",
	"img",
	"input",
	"keygen",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr"
];
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/util/schema.js
/**
* @import {Schema as SchemaType, Space} from 'property-information'
*/
/** @type {SchemaType} */
var Schema = class {
	/**
	* @param {SchemaType['property']} property
	*   Property.
	* @param {SchemaType['normal']} normal
	*   Normal.
	* @param {Space | undefined} [space]
	*   Space.
	* @returns
	*   Schema.
	*/
	constructor(property, normal, space) {
		this.normal = normal;
		this.property = property;
		if (space) this.space = space;
	}
};
Schema.prototype.normal = {};
Schema.prototype.property = {};
Schema.prototype.space = void 0;
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/util/merge.js
/**
* @import {Info, Space} from 'property-information'
*/
/**
* @param {ReadonlyArray<Schema>} definitions
*   Definitions.
* @param {Space | undefined} [space]
*   Space.
* @returns {Schema}
*   Schema.
*/
function merge(definitions, space) {
	/** @type {Record<string, Info>} */
	const property = {};
	/** @type {Record<string, string>} */
	const normal = {};
	for (const definition of definitions) {
		Object.assign(property, definition.property);
		Object.assign(normal, definition.normal);
	}
	return new Schema(property, normal, space);
}
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/normalize.js
/**
* Get the cleaned case insensitive form of an attribute or property.
*
* @param {string} value
*   An attribute-like or property-like name.
* @returns {string}
*   Value that can be used to look up the properly cased property on a
*   `Schema`.
*/
function normalize(value) {
	return value.toLowerCase();
}
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/util/info.js
/**
* @import {Info as InfoType} from 'property-information'
*/
/** @type {InfoType} */
var Info = class {
	/**
	* @param {string} property
	*   Property.
	* @param {string} attribute
	*   Attribute.
	* @returns
	*   Info.
	*/
	constructor(property, attribute) {
		this.attribute = attribute;
		this.property = property;
	}
};
Info.prototype.attribute = "";
Info.prototype.booleanish = false;
Info.prototype.boolean = false;
Info.prototype.commaOrSpaceSeparated = false;
Info.prototype.commaSeparated = false;
Info.prototype.defined = false;
Info.prototype.mustUseProperty = false;
Info.prototype.number = false;
Info.prototype.overloadedBoolean = false;
Info.prototype.property = "";
Info.prototype.spaceSeparated = false;
Info.prototype.space = void 0;
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/util/types.js
var types_exports = /* @__PURE__ */ __exportAll({
	boolean: () => boolean,
	booleanish: () => booleanish,
	commaOrSpaceSeparated: () => commaOrSpaceSeparated,
	commaSeparated: () => commaSeparated,
	number: () => number,
	overloadedBoolean: () => overloadedBoolean,
	spaceSeparated: () => spaceSeparated
});
let powers = 0;
const boolean = increment();
const booleanish = increment();
const overloadedBoolean = increment();
const number = increment();
const spaceSeparated = increment();
const commaSeparated = increment();
const commaOrSpaceSeparated = increment();
function increment() {
	return 2 ** ++powers;
}
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/util/defined-info.js
/**
* @import {Space} from 'property-information'
*/
const checks = Object.keys(types_exports);
var DefinedInfo = class extends Info {
	/**
	* @constructor
	* @param {string} property
	*   Property.
	* @param {string} attribute
	*   Attribute.
	* @param {number | null | undefined} [mask]
	*   Mask.
	* @param {Space | undefined} [space]
	*   Space.
	* @returns
	*   Info.
	*/
	constructor(property, attribute, mask, space) {
		let index = -1;
		super(property, attribute);
		mark(this, "space", space);
		if (typeof mask === "number") while (++index < checks.length) {
			const check = checks[index];
			mark(this, checks[index], (mask & types_exports[check]) === types_exports[check]);
		}
	}
};
DefinedInfo.prototype.defined = true;
/**
* @template {keyof DefinedInfo} Key
*   Key type.
* @param {DefinedInfo} values
*   Info.
* @param {Key} key
*   Key.
* @param {DefinedInfo[Key]} value
*   Value.
* @returns {undefined}
*   Nothing.
*/
function mark(values, key, value) {
	if (value) values[key] = value;
}
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/util/create.js
/**
* @import {Info, Space} from 'property-information'
*/
/**
* @typedef Definition
*   Definition of a schema.
* @property {Record<string, string> | undefined} [attributes]
*   Normalzed names to special attribute case.
* @property {ReadonlyArray<string> | undefined} [mustUseProperty]
*   Normalized names that must be set as properties.
* @property {Record<string, number | null>} properties
*   Property names to their types.
* @property {Space | undefined} [space]
*   Space.
* @property {Transform} transform
*   Transform a property name.
*/
/**
* @callback Transform
*   Transform.
* @param {Record<string, string>} attributes
*   Attributes.
* @param {string} property
*   Property.
* @returns {string}
*   Attribute.
*/
/**
* @param {Definition} definition
*   Definition.
* @returns {Schema}
*   Schema.
*/
function create(definition) {
	/** @type {Record<string, Info>} */
	const properties = {};
	/** @type {Record<string, string>} */
	const normals = {};
	for (const [property, value] of Object.entries(definition.properties)) {
		const info = new DefinedInfo(property, definition.transform(definition.attributes || {}, property), value, definition.space);
		if (definition.mustUseProperty && definition.mustUseProperty.includes(property)) info.mustUseProperty = true;
		properties[property] = info;
		normals[normalize(property)] = property;
		normals[normalize(info.attribute)] = property;
	}
	return new Schema(properties, normals, definition.space);
}
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/aria.js
const aria = create({
	properties: {
		ariaActiveDescendant: null,
		ariaAtomic: booleanish,
		ariaAutoComplete: null,
		ariaBusy: booleanish,
		ariaChecked: booleanish,
		ariaColCount: number,
		ariaColIndex: number,
		ariaColSpan: number,
		ariaControls: spaceSeparated,
		ariaCurrent: null,
		ariaDescribedBy: spaceSeparated,
		ariaDetails: null,
		ariaDisabled: booleanish,
		ariaDropEffect: spaceSeparated,
		ariaErrorMessage: null,
		ariaExpanded: booleanish,
		ariaFlowTo: spaceSeparated,
		ariaGrabbed: booleanish,
		ariaHasPopup: null,
		ariaHidden: booleanish,
		ariaInvalid: null,
		ariaKeyShortcuts: null,
		ariaLabel: null,
		ariaLabelledBy: spaceSeparated,
		ariaLevel: number,
		ariaLive: null,
		ariaModal: booleanish,
		ariaMultiLine: booleanish,
		ariaMultiSelectable: booleanish,
		ariaOrientation: null,
		ariaOwns: spaceSeparated,
		ariaPlaceholder: null,
		ariaPosInSet: number,
		ariaPressed: booleanish,
		ariaReadOnly: booleanish,
		ariaRelevant: null,
		ariaRequired: booleanish,
		ariaRoleDescription: spaceSeparated,
		ariaRowCount: number,
		ariaRowIndex: number,
		ariaRowSpan: number,
		ariaSelected: booleanish,
		ariaSetSize: number,
		ariaSort: null,
		ariaValueMax: number,
		ariaValueMin: number,
		ariaValueNow: number,
		ariaValueText: null,
		role: null
	},
	transform(_, property) {
		return property === "role" ? property : "aria-" + property.slice(4).toLowerCase();
	}
});
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/util/case-sensitive-transform.js
/**
* @param {Record<string, string>} attributes
*   Attributes.
* @param {string} attribute
*   Attribute.
* @returns {string}
*   Transformed attribute.
*/
function caseSensitiveTransform(attributes, attribute) {
	return attribute in attributes ? attributes[attribute] : attribute;
}
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/util/case-insensitive-transform.js
/**
* @param {Record<string, string>} attributes
*   Attributes.
* @param {string} property
*   Property.
* @returns {string}
*   Transformed property.
*/
function caseInsensitiveTransform(attributes, property) {
	return caseSensitiveTransform(attributes, property.toLowerCase());
}
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/html.js
const html$3 = create({
	attributes: {
		acceptcharset: "accept-charset",
		classname: "class",
		htmlfor: "for",
		httpequiv: "http-equiv"
	},
	mustUseProperty: [
		"checked",
		"multiple",
		"muted",
		"selected"
	],
	properties: {
		abbr: null,
		accept: commaSeparated,
		acceptCharset: spaceSeparated,
		accessKey: spaceSeparated,
		action: null,
		allow: null,
		allowFullScreen: boolean,
		allowPaymentRequest: boolean,
		allowUserMedia: boolean,
		alt: null,
		as: null,
		async: boolean,
		autoCapitalize: null,
		autoComplete: spaceSeparated,
		autoFocus: boolean,
		autoPlay: boolean,
		blocking: spaceSeparated,
		capture: null,
		charSet: null,
		checked: boolean,
		cite: null,
		className: spaceSeparated,
		cols: number,
		colSpan: null,
		content: null,
		contentEditable: booleanish,
		controls: boolean,
		controlsList: spaceSeparated,
		coords: number | commaSeparated,
		crossOrigin: null,
		data: null,
		dateTime: null,
		decoding: null,
		default: boolean,
		defer: boolean,
		dir: null,
		dirName: null,
		disabled: boolean,
		download: overloadedBoolean,
		draggable: booleanish,
		encType: null,
		enterKeyHint: null,
		fetchPriority: null,
		form: null,
		formAction: null,
		formEncType: null,
		formMethod: null,
		formNoValidate: boolean,
		formTarget: null,
		headers: spaceSeparated,
		height: number,
		hidden: overloadedBoolean,
		high: number,
		href: null,
		hrefLang: null,
		htmlFor: spaceSeparated,
		httpEquiv: spaceSeparated,
		id: null,
		imageSizes: null,
		imageSrcSet: null,
		inert: boolean,
		inputMode: null,
		integrity: null,
		is: null,
		isMap: boolean,
		itemId: null,
		itemProp: spaceSeparated,
		itemRef: spaceSeparated,
		itemScope: boolean,
		itemType: spaceSeparated,
		kind: null,
		label: null,
		lang: null,
		language: null,
		list: null,
		loading: null,
		loop: boolean,
		low: number,
		manifest: null,
		max: null,
		maxLength: number,
		media: null,
		method: null,
		min: null,
		minLength: number,
		multiple: boolean,
		muted: boolean,
		name: null,
		nonce: null,
		noModule: boolean,
		noValidate: boolean,
		onAbort: null,
		onAfterPrint: null,
		onAuxClick: null,
		onBeforeMatch: null,
		onBeforePrint: null,
		onBeforeToggle: null,
		onBeforeUnload: null,
		onBlur: null,
		onCancel: null,
		onCanPlay: null,
		onCanPlayThrough: null,
		onChange: null,
		onClick: null,
		onClose: null,
		onContextLost: null,
		onContextMenu: null,
		onContextRestored: null,
		onCopy: null,
		onCueChange: null,
		onCut: null,
		onDblClick: null,
		onDrag: null,
		onDragEnd: null,
		onDragEnter: null,
		onDragExit: null,
		onDragLeave: null,
		onDragOver: null,
		onDragStart: null,
		onDrop: null,
		onDurationChange: null,
		onEmptied: null,
		onEnded: null,
		onError: null,
		onFocus: null,
		onFormData: null,
		onHashChange: null,
		onInput: null,
		onInvalid: null,
		onKeyDown: null,
		onKeyPress: null,
		onKeyUp: null,
		onLanguageChange: null,
		onLoad: null,
		onLoadedData: null,
		onLoadedMetadata: null,
		onLoadEnd: null,
		onLoadStart: null,
		onMessage: null,
		onMessageError: null,
		onMouseDown: null,
		onMouseEnter: null,
		onMouseLeave: null,
		onMouseMove: null,
		onMouseOut: null,
		onMouseOver: null,
		onMouseUp: null,
		onOffline: null,
		onOnline: null,
		onPageHide: null,
		onPageShow: null,
		onPaste: null,
		onPause: null,
		onPlay: null,
		onPlaying: null,
		onPopState: null,
		onProgress: null,
		onRateChange: null,
		onRejectionHandled: null,
		onReset: null,
		onResize: null,
		onScroll: null,
		onScrollEnd: null,
		onSecurityPolicyViolation: null,
		onSeeked: null,
		onSeeking: null,
		onSelect: null,
		onSlotChange: null,
		onStalled: null,
		onStorage: null,
		onSubmit: null,
		onSuspend: null,
		onTimeUpdate: null,
		onToggle: null,
		onUnhandledRejection: null,
		onUnload: null,
		onVolumeChange: null,
		onWaiting: null,
		onWheel: null,
		open: boolean,
		optimum: number,
		pattern: null,
		ping: spaceSeparated,
		placeholder: null,
		playsInline: boolean,
		popover: null,
		popoverTarget: null,
		popoverTargetAction: null,
		poster: null,
		preload: null,
		readOnly: boolean,
		referrerPolicy: null,
		rel: spaceSeparated,
		required: boolean,
		reversed: boolean,
		rows: number,
		rowSpan: number,
		sandbox: spaceSeparated,
		scope: null,
		scoped: boolean,
		seamless: boolean,
		selected: boolean,
		shadowRootClonable: boolean,
		shadowRootDelegatesFocus: boolean,
		shadowRootMode: null,
		shape: null,
		size: number,
		sizes: null,
		slot: null,
		span: number,
		spellCheck: booleanish,
		src: null,
		srcDoc: null,
		srcLang: null,
		srcSet: null,
		start: number,
		step: null,
		style: null,
		tabIndex: number,
		target: null,
		title: null,
		translate: null,
		type: null,
		typeMustMatch: boolean,
		useMap: null,
		value: booleanish,
		width: number,
		wrap: null,
		writingSuggestions: null,
		align: null,
		aLink: null,
		archive: spaceSeparated,
		axis: null,
		background: null,
		bgColor: null,
		border: number,
		borderColor: null,
		bottomMargin: number,
		cellPadding: null,
		cellSpacing: null,
		char: null,
		charOff: null,
		classId: null,
		clear: null,
		code: null,
		codeBase: null,
		codeType: null,
		color: null,
		compact: boolean,
		declare: boolean,
		event: null,
		face: null,
		frame: null,
		frameBorder: null,
		hSpace: number,
		leftMargin: number,
		link: null,
		longDesc: null,
		lowSrc: null,
		marginHeight: number,
		marginWidth: number,
		noResize: boolean,
		noHref: boolean,
		noShade: boolean,
		noWrap: boolean,
		object: null,
		profile: null,
		prompt: null,
		rev: null,
		rightMargin: number,
		rules: null,
		scheme: null,
		scrolling: booleanish,
		standby: null,
		summary: null,
		text: null,
		topMargin: number,
		valueType: null,
		version: null,
		vAlign: null,
		vLink: null,
		vSpace: number,
		allowTransparency: null,
		autoCorrect: null,
		autoSave: null,
		disablePictureInPicture: boolean,
		disableRemotePlayback: boolean,
		prefix: null,
		property: null,
		results: number,
		security: null,
		unselectable: null
	},
	space: "html",
	transform: caseInsensitiveTransform
});
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/svg.js
const svg$1 = create({
	attributes: {
		accentHeight: "accent-height",
		alignmentBaseline: "alignment-baseline",
		arabicForm: "arabic-form",
		baselineShift: "baseline-shift",
		capHeight: "cap-height",
		className: "class",
		clipPath: "clip-path",
		clipRule: "clip-rule",
		colorInterpolation: "color-interpolation",
		colorInterpolationFilters: "color-interpolation-filters",
		colorProfile: "color-profile",
		colorRendering: "color-rendering",
		crossOrigin: "crossorigin",
		dataType: "datatype",
		dominantBaseline: "dominant-baseline",
		enableBackground: "enable-background",
		fillOpacity: "fill-opacity",
		fillRule: "fill-rule",
		floodColor: "flood-color",
		floodOpacity: "flood-opacity",
		fontFamily: "font-family",
		fontSize: "font-size",
		fontSizeAdjust: "font-size-adjust",
		fontStretch: "font-stretch",
		fontStyle: "font-style",
		fontVariant: "font-variant",
		fontWeight: "font-weight",
		glyphName: "glyph-name",
		glyphOrientationHorizontal: "glyph-orientation-horizontal",
		glyphOrientationVertical: "glyph-orientation-vertical",
		hrefLang: "hreflang",
		horizAdvX: "horiz-adv-x",
		horizOriginX: "horiz-origin-x",
		horizOriginY: "horiz-origin-y",
		imageRendering: "image-rendering",
		letterSpacing: "letter-spacing",
		lightingColor: "lighting-color",
		markerEnd: "marker-end",
		markerMid: "marker-mid",
		markerStart: "marker-start",
		navDown: "nav-down",
		navDownLeft: "nav-down-left",
		navDownRight: "nav-down-right",
		navLeft: "nav-left",
		navNext: "nav-next",
		navPrev: "nav-prev",
		navRight: "nav-right",
		navUp: "nav-up",
		navUpLeft: "nav-up-left",
		navUpRight: "nav-up-right",
		onAbort: "onabort",
		onActivate: "onactivate",
		onAfterPrint: "onafterprint",
		onBeforePrint: "onbeforeprint",
		onBegin: "onbegin",
		onCancel: "oncancel",
		onCanPlay: "oncanplay",
		onCanPlayThrough: "oncanplaythrough",
		onChange: "onchange",
		onClick: "onclick",
		onClose: "onclose",
		onCopy: "oncopy",
		onCueChange: "oncuechange",
		onCut: "oncut",
		onDblClick: "ondblclick",
		onDrag: "ondrag",
		onDragEnd: "ondragend",
		onDragEnter: "ondragenter",
		onDragExit: "ondragexit",
		onDragLeave: "ondragleave",
		onDragOver: "ondragover",
		onDragStart: "ondragstart",
		onDrop: "ondrop",
		onDurationChange: "ondurationchange",
		onEmptied: "onemptied",
		onEnd: "onend",
		onEnded: "onended",
		onError: "onerror",
		onFocus: "onfocus",
		onFocusIn: "onfocusin",
		onFocusOut: "onfocusout",
		onHashChange: "onhashchange",
		onInput: "oninput",
		onInvalid: "oninvalid",
		onKeyDown: "onkeydown",
		onKeyPress: "onkeypress",
		onKeyUp: "onkeyup",
		onLoad: "onload",
		onLoadedData: "onloadeddata",
		onLoadedMetadata: "onloadedmetadata",
		onLoadStart: "onloadstart",
		onMessage: "onmessage",
		onMouseDown: "onmousedown",
		onMouseEnter: "onmouseenter",
		onMouseLeave: "onmouseleave",
		onMouseMove: "onmousemove",
		onMouseOut: "onmouseout",
		onMouseOver: "onmouseover",
		onMouseUp: "onmouseup",
		onMouseWheel: "onmousewheel",
		onOffline: "onoffline",
		onOnline: "ononline",
		onPageHide: "onpagehide",
		onPageShow: "onpageshow",
		onPaste: "onpaste",
		onPause: "onpause",
		onPlay: "onplay",
		onPlaying: "onplaying",
		onPopState: "onpopstate",
		onProgress: "onprogress",
		onRateChange: "onratechange",
		onRepeat: "onrepeat",
		onReset: "onreset",
		onResize: "onresize",
		onScroll: "onscroll",
		onSeeked: "onseeked",
		onSeeking: "onseeking",
		onSelect: "onselect",
		onShow: "onshow",
		onStalled: "onstalled",
		onStorage: "onstorage",
		onSubmit: "onsubmit",
		onSuspend: "onsuspend",
		onTimeUpdate: "ontimeupdate",
		onToggle: "ontoggle",
		onUnload: "onunload",
		onVolumeChange: "onvolumechange",
		onWaiting: "onwaiting",
		onZoom: "onzoom",
		overlinePosition: "overline-position",
		overlineThickness: "overline-thickness",
		paintOrder: "paint-order",
		panose1: "panose-1",
		pointerEvents: "pointer-events",
		referrerPolicy: "referrerpolicy",
		renderingIntent: "rendering-intent",
		shapeRendering: "shape-rendering",
		stopColor: "stop-color",
		stopOpacity: "stop-opacity",
		strikethroughPosition: "strikethrough-position",
		strikethroughThickness: "strikethrough-thickness",
		strokeDashArray: "stroke-dasharray",
		strokeDashOffset: "stroke-dashoffset",
		strokeLineCap: "stroke-linecap",
		strokeLineJoin: "stroke-linejoin",
		strokeMiterLimit: "stroke-miterlimit",
		strokeOpacity: "stroke-opacity",
		strokeWidth: "stroke-width",
		tabIndex: "tabindex",
		textAnchor: "text-anchor",
		textDecoration: "text-decoration",
		textRendering: "text-rendering",
		transformOrigin: "transform-origin",
		typeOf: "typeof",
		underlinePosition: "underline-position",
		underlineThickness: "underline-thickness",
		unicodeBidi: "unicode-bidi",
		unicodeRange: "unicode-range",
		unitsPerEm: "units-per-em",
		vAlphabetic: "v-alphabetic",
		vHanging: "v-hanging",
		vIdeographic: "v-ideographic",
		vMathematical: "v-mathematical",
		vectorEffect: "vector-effect",
		vertAdvY: "vert-adv-y",
		vertOriginX: "vert-origin-x",
		vertOriginY: "vert-origin-y",
		wordSpacing: "word-spacing",
		writingMode: "writing-mode",
		xHeight: "x-height",
		playbackOrder: "playbackorder",
		timelineBegin: "timelinebegin"
	},
	properties: {
		about: commaOrSpaceSeparated,
		accentHeight: number,
		accumulate: null,
		additive: null,
		alignmentBaseline: null,
		alphabetic: number,
		amplitude: number,
		arabicForm: null,
		ascent: number,
		attributeName: null,
		attributeType: null,
		azimuth: number,
		bandwidth: null,
		baselineShift: null,
		baseFrequency: null,
		baseProfile: null,
		bbox: null,
		begin: null,
		bias: number,
		by: null,
		calcMode: null,
		capHeight: number,
		className: spaceSeparated,
		clip: null,
		clipPath: null,
		clipPathUnits: null,
		clipRule: null,
		color: null,
		colorInterpolation: null,
		colorInterpolationFilters: null,
		colorProfile: null,
		colorRendering: null,
		content: null,
		contentScriptType: null,
		contentStyleType: null,
		crossOrigin: null,
		cursor: null,
		cx: null,
		cy: null,
		d: null,
		dataType: null,
		defaultAction: null,
		descent: number,
		diffuseConstant: number,
		direction: null,
		display: null,
		dur: null,
		divisor: number,
		dominantBaseline: null,
		download: boolean,
		dx: null,
		dy: null,
		edgeMode: null,
		editable: null,
		elevation: number,
		enableBackground: null,
		end: null,
		event: null,
		exponent: number,
		externalResourcesRequired: null,
		fill: null,
		fillOpacity: number,
		fillRule: null,
		filter: null,
		filterRes: null,
		filterUnits: null,
		floodColor: null,
		floodOpacity: null,
		focusable: null,
		focusHighlight: null,
		fontFamily: null,
		fontSize: null,
		fontSizeAdjust: null,
		fontStretch: null,
		fontStyle: null,
		fontVariant: null,
		fontWeight: null,
		format: null,
		fr: null,
		from: null,
		fx: null,
		fy: null,
		g1: commaSeparated,
		g2: commaSeparated,
		glyphName: commaSeparated,
		glyphOrientationHorizontal: null,
		glyphOrientationVertical: null,
		glyphRef: null,
		gradientTransform: null,
		gradientUnits: null,
		handler: null,
		hanging: number,
		hatchContentUnits: null,
		hatchUnits: null,
		height: null,
		href: null,
		hrefLang: null,
		horizAdvX: number,
		horizOriginX: number,
		horizOriginY: number,
		id: null,
		ideographic: number,
		imageRendering: null,
		initialVisibility: null,
		in: null,
		in2: null,
		intercept: number,
		k: number,
		k1: number,
		k2: number,
		k3: number,
		k4: number,
		kernelMatrix: commaOrSpaceSeparated,
		kernelUnitLength: null,
		keyPoints: null,
		keySplines: null,
		keyTimes: null,
		kerning: null,
		lang: null,
		lengthAdjust: null,
		letterSpacing: null,
		lightingColor: null,
		limitingConeAngle: number,
		local: null,
		markerEnd: null,
		markerMid: null,
		markerStart: null,
		markerHeight: null,
		markerUnits: null,
		markerWidth: null,
		mask: null,
		maskContentUnits: null,
		maskUnits: null,
		mathematical: null,
		max: null,
		media: null,
		mediaCharacterEncoding: null,
		mediaContentEncodings: null,
		mediaSize: number,
		mediaTime: null,
		method: null,
		min: null,
		mode: null,
		name: null,
		navDown: null,
		navDownLeft: null,
		navDownRight: null,
		navLeft: null,
		navNext: null,
		navPrev: null,
		navRight: null,
		navUp: null,
		navUpLeft: null,
		navUpRight: null,
		numOctaves: null,
		observer: null,
		offset: null,
		onAbort: null,
		onActivate: null,
		onAfterPrint: null,
		onBeforePrint: null,
		onBegin: null,
		onCancel: null,
		onCanPlay: null,
		onCanPlayThrough: null,
		onChange: null,
		onClick: null,
		onClose: null,
		onCopy: null,
		onCueChange: null,
		onCut: null,
		onDblClick: null,
		onDrag: null,
		onDragEnd: null,
		onDragEnter: null,
		onDragExit: null,
		onDragLeave: null,
		onDragOver: null,
		onDragStart: null,
		onDrop: null,
		onDurationChange: null,
		onEmptied: null,
		onEnd: null,
		onEnded: null,
		onError: null,
		onFocus: null,
		onFocusIn: null,
		onFocusOut: null,
		onHashChange: null,
		onInput: null,
		onInvalid: null,
		onKeyDown: null,
		onKeyPress: null,
		onKeyUp: null,
		onLoad: null,
		onLoadedData: null,
		onLoadedMetadata: null,
		onLoadStart: null,
		onMessage: null,
		onMouseDown: null,
		onMouseEnter: null,
		onMouseLeave: null,
		onMouseMove: null,
		onMouseOut: null,
		onMouseOver: null,
		onMouseUp: null,
		onMouseWheel: null,
		onOffline: null,
		onOnline: null,
		onPageHide: null,
		onPageShow: null,
		onPaste: null,
		onPause: null,
		onPlay: null,
		onPlaying: null,
		onPopState: null,
		onProgress: null,
		onRateChange: null,
		onRepeat: null,
		onReset: null,
		onResize: null,
		onScroll: null,
		onSeeked: null,
		onSeeking: null,
		onSelect: null,
		onShow: null,
		onStalled: null,
		onStorage: null,
		onSubmit: null,
		onSuspend: null,
		onTimeUpdate: null,
		onToggle: null,
		onUnload: null,
		onVolumeChange: null,
		onWaiting: null,
		onZoom: null,
		opacity: null,
		operator: null,
		order: null,
		orient: null,
		orientation: null,
		origin: null,
		overflow: null,
		overlay: null,
		overlinePosition: number,
		overlineThickness: number,
		paintOrder: null,
		panose1: null,
		path: null,
		pathLength: number,
		patternContentUnits: null,
		patternTransform: null,
		patternUnits: null,
		phase: null,
		ping: spaceSeparated,
		pitch: null,
		playbackOrder: null,
		pointerEvents: null,
		points: null,
		pointsAtX: number,
		pointsAtY: number,
		pointsAtZ: number,
		preserveAlpha: null,
		preserveAspectRatio: null,
		primitiveUnits: null,
		propagate: null,
		property: commaOrSpaceSeparated,
		r: null,
		radius: null,
		referrerPolicy: null,
		refX: null,
		refY: null,
		rel: commaOrSpaceSeparated,
		rev: commaOrSpaceSeparated,
		renderingIntent: null,
		repeatCount: null,
		repeatDur: null,
		requiredExtensions: commaOrSpaceSeparated,
		requiredFeatures: commaOrSpaceSeparated,
		requiredFonts: commaOrSpaceSeparated,
		requiredFormats: commaOrSpaceSeparated,
		resource: null,
		restart: null,
		result: null,
		rotate: null,
		rx: null,
		ry: null,
		scale: null,
		seed: null,
		shapeRendering: null,
		side: null,
		slope: null,
		snapshotTime: null,
		specularConstant: number,
		specularExponent: number,
		spreadMethod: null,
		spacing: null,
		startOffset: null,
		stdDeviation: null,
		stemh: null,
		stemv: null,
		stitchTiles: null,
		stopColor: null,
		stopOpacity: null,
		strikethroughPosition: number,
		strikethroughThickness: number,
		string: null,
		stroke: null,
		strokeDashArray: commaOrSpaceSeparated,
		strokeDashOffset: null,
		strokeLineCap: null,
		strokeLineJoin: null,
		strokeMiterLimit: number,
		strokeOpacity: number,
		strokeWidth: null,
		style: null,
		surfaceScale: number,
		syncBehavior: null,
		syncBehaviorDefault: null,
		syncMaster: null,
		syncTolerance: null,
		syncToleranceDefault: null,
		systemLanguage: commaOrSpaceSeparated,
		tabIndex: number,
		tableValues: null,
		target: null,
		targetX: number,
		targetY: number,
		textAnchor: null,
		textDecoration: null,
		textRendering: null,
		textLength: null,
		timelineBegin: null,
		title: null,
		transformBehavior: null,
		type: null,
		typeOf: commaOrSpaceSeparated,
		to: null,
		transform: null,
		transformOrigin: null,
		u1: null,
		u2: null,
		underlinePosition: number,
		underlineThickness: number,
		unicode: null,
		unicodeBidi: null,
		unicodeRange: null,
		unitsPerEm: number,
		values: null,
		vAlphabetic: number,
		vMathematical: number,
		vectorEffect: null,
		vHanging: number,
		vIdeographic: number,
		version: null,
		vertAdvY: number,
		vertOriginX: number,
		vertOriginY: number,
		viewBox: null,
		viewTarget: null,
		visibility: null,
		width: null,
		widths: null,
		wordSpacing: null,
		writingMode: null,
		x: null,
		x1: null,
		x2: null,
		xChannelSelector: null,
		xHeight: number,
		y: null,
		y1: null,
		y2: null,
		yChannelSelector: null,
		z: null,
		zoomAndPan: null
	},
	space: "svg",
	transform: caseSensitiveTransform
});
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/xlink.js
const xlink = create({
	properties: {
		xLinkActuate: null,
		xLinkArcRole: null,
		xLinkHref: null,
		xLinkRole: null,
		xLinkShow: null,
		xLinkTitle: null,
		xLinkType: null
	},
	space: "xlink",
	transform(_, property) {
		return "xlink:" + property.slice(5).toLowerCase();
	}
});
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/xmlns.js
const xmlns = create({
	attributes: { xmlnsxlink: "xmlns:xlink" },
	properties: {
		xmlnsXLink: null,
		xmlns: null
	},
	space: "xmlns",
	transform: caseInsensitiveTransform
});
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/xml.js
const xml = create({
	properties: {
		xmlBase: null,
		xmlLang: null,
		xmlSpace: null
	},
	space: "xml",
	transform(_, property) {
		return "xml:" + property.slice(3).toLowerCase();
	}
});
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/lib/find.js
/**
* @import {Schema} from 'property-information'
*/
const cap = /[A-Z]/g;
const dash = /-[a-z]/g;
const valid = /^data[-\w.:]+$/i;
/**
* Look up info on a property.
*
* In most cases the given `schema` contains info on the property.
* All standard,
* most legacy,
* and some non-standard properties are supported.
* For these cases,
* the returned `Info` has hints about the value of the property.
*
* `name` can also be a valid data attribute or property,
* in which case an `Info` object with the correctly cased `attribute` and
* `property` is returned.
*
* `name` can be an unknown attribute,
* in which case an `Info` object with `attribute` and `property` set to the
* given name is returned.
* It is not recommended to provide unsupported legacy or recently specced
* properties.
*
*
* @param {Schema} schema
*   Schema;
*   either the `html` or `svg` export.
* @param {string} value
*   An attribute-like or property-like name;
*   it will be passed through `normalize` to hopefully find the correct info.
* @returns {Info}
*   Info.
*/
function find(schema, value) {
	const normal = normalize(value);
	let property = value;
	let Type = Info;
	if (normal in schema.normal) return schema.property[schema.normal[normal]];
	if (normal.length > 4 && normal.slice(0, 4) === "data" && valid.test(value)) {
		if (value.charAt(4) === "-") {
			const rest = value.slice(5).replace(dash, camelcase);
			property = "data" + rest.charAt(0).toUpperCase() + rest.slice(1);
		} else {
			const rest = value.slice(4);
			if (!dash.test(rest)) {
				let dashes = rest.replace(cap, kebab);
				if (dashes.charAt(0) !== "-") dashes = "-" + dashes;
				value = "data" + dashes;
			}
		}
		Type = DefinedInfo;
	}
	return new Type(property, value);
}
/**
* @param {string} $0
*   Value.
* @returns {string}
*   Kebab.
*/
function kebab($0) {
	return "-" + $0.toLowerCase();
}
/**
* @param {string} $0
*   Value.
* @returns {string}
*   Camel.
*/
function camelcase($0) {
	return $0.charAt(1).toUpperCase();
}
//#endregion
//#region node_modules/.pnpm/property-information@7.1.0/node_modules/property-information/index.js
const html$2 = merge([
	aria,
	html$3,
	xlink,
	xmlns,
	xml
], "html");
const svg = merge([
	aria,
	svg$1,
	xlink,
	xmlns,
	xml
], "svg");
//#endregion
//#region node_modules/.pnpm/zwitch@2.0.4/node_modules/zwitch/index.js
/**
* @callback Handler
*   Handle a value, with a certain ID field set to a certain value.
*   The ID field is passed to `zwitch`, and it’s value is this function’s
*   place on the `handlers` record.
* @param {...any} parameters
*   Arbitrary parameters passed to the zwitch.
*   The first will be an object with a certain ID field set to a certain value.
* @returns {any}
*   Anything!
*/
/**
* @callback UnknownHandler
*   Handle values that do have a certain ID field, but it’s set to a value
*   that is not listed in the `handlers` record.
* @param {unknown} value
*   An object with a certain ID field set to an unknown value.
* @param {...any} rest
*   Arbitrary parameters passed to the zwitch.
* @returns {any}
*   Anything!
*/
/**
* @callback InvalidHandler
*   Handle values that do not have a certain ID field.
* @param {unknown} value
*   Any unknown value.
* @param {...any} rest
*   Arbitrary parameters passed to the zwitch.
* @returns {void|null|undefined|never}
*   This should crash or return nothing.
*/
/**
* @template {InvalidHandler} [Invalid=InvalidHandler]
* @template {UnknownHandler} [Unknown=UnknownHandler]
* @template {Record<string, Handler>} [Handlers=Record<string, Handler>]
* @typedef Options
*   Configuration (required).
* @property {Invalid} [invalid]
*   Handler to use for invalid values.
* @property {Unknown} [unknown]
*   Handler to use for unknown values.
* @property {Handlers} [handlers]
*   Handlers to use.
*/
const own$2 = {}.hasOwnProperty;
/**
* Handle values based on a field.
*
* @template {InvalidHandler} [Invalid=InvalidHandler]
* @template {UnknownHandler} [Unknown=UnknownHandler]
* @template {Record<string, Handler>} [Handlers=Record<string, Handler>]
* @param {string} key
*   Field to switch on.
* @param {Options<Invalid, Unknown, Handlers>} [options]
*   Configuration (required).
* @returns {{unknown: Unknown, invalid: Invalid, handlers: Handlers, (...parameters: Parameters<Handlers[keyof Handlers]>): ReturnType<Handlers[keyof Handlers]>, (...parameters: Parameters<Unknown>): ReturnType<Unknown>}}
*/
function zwitch(key, options) {
	const settings = options || {};
	/**
	* Handle one value.
	*
	* Based on the bound `key`, a respective handler will be called.
	* If `value` is not an object, or doesn’t have a `key` property, the special
	* “invalid” handler will be called.
	* If `value` has an unknown `key`, the special “unknown” handler will be
	* called.
	*
	* All arguments, and the context object, are passed through to the handler,
	* and it’s result is returned.
	*
	* @this {unknown}
	*   Any context object.
	* @param {unknown} [value]
	*   Any value.
	* @param {...unknown} parameters
	*   Arbitrary parameters passed to the zwitch.
	* @property {Handler} invalid
	*   Handle for values that do not have a certain ID field.
	* @property {Handler} unknown
	*   Handle values that do have a certain ID field, but it’s set to a value
	*   that is not listed in the `handlers` record.
	* @property {Handlers} handlers
	*   Record of handlers.
	* @returns {unknown}
	*   Anything.
	*/
	function one(value, ...parameters) {
		/** @type {Handler|undefined} */
		let fn = one.invalid;
		const handlers = one.handlers;
		if (value && own$2.call(value, key)) {
			const id = String(value[key]);
			fn = own$2.call(handlers, id) ? handlers[id] : one.unknown;
		}
		if (fn) return fn.call(this, value, ...parameters);
	}
	one.handlers = settings.handlers || {};
	one.invalid = settings.invalid;
	one.unknown = settings.unknown;
	return one;
}
//#endregion
//#region node_modules/.pnpm/stringify-entities@4.0.4/node_modules/stringify-entities/lib/core.js
/**
* @typedef CoreOptions
* @property {ReadonlyArray<string>} [subset=[]]
*   Whether to only escape the given subset of characters.
* @property {boolean} [escapeOnly=false]
*   Whether to only escape possibly dangerous characters.
*   Those characters are `"`, `&`, `'`, `<`, `>`, and `` ` ``.
*
* @typedef FormatOptions
* @property {(code: number, next: number, options: CoreWithFormatOptions) => string} format
*   Format strategy.
*
* @typedef {CoreOptions & FormatOptions & import('./util/format-smart.js').FormatSmartOptions} CoreWithFormatOptions
*/
const defaultSubsetRegex = /["&'<>`]/g;
const surrogatePairsRegex = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
const controlCharactersRegex = /[\x01-\t\v\f\x0E-\x1F\x7F\x81\x8D\x8F\x90\x9D\xA0-\uFFFF]/g;
const regexEscapeRegex = /[|\\{}()[\]^$+*?.]/g;
/** @type {WeakMap<ReadonlyArray<string>, RegExp>} */
const subsetToRegexCache = /* @__PURE__ */ new WeakMap();
/**
* Encode certain characters in `value`.
*
* @param {string} value
* @param {CoreWithFormatOptions} options
* @returns {string}
*/
function core(value, options) {
	value = value.replace(options.subset ? charactersToExpressionCached(options.subset) : defaultSubsetRegex, basic);
	if (options.subset || options.escapeOnly) return value;
	return value.replace(surrogatePairsRegex, surrogate).replace(controlCharactersRegex, basic);
	/**
	* @param {string} pair
	* @param {number} index
	* @param {string} all
	*/
	function surrogate(pair, index, all) {
		return options.format((pair.charCodeAt(0) - 55296) * 1024 + pair.charCodeAt(1) - 56320 + 65536, all.charCodeAt(index + 2), options);
	}
	/**
	* @param {string} character
	* @param {number} index
	* @param {string} all
	*/
	function basic(character, index, all) {
		return options.format(character.charCodeAt(0), all.charCodeAt(index + 1), options);
	}
}
/**
* A wrapper function that caches the result of `charactersToExpression` with a WeakMap.
* This can improve performance when tooling calls `charactersToExpression` repeatedly
* with the same subset.
*
* @param {ReadonlyArray<string>} subset
* @returns {RegExp}
*/
function charactersToExpressionCached(subset) {
	let cached = subsetToRegexCache.get(subset);
	if (!cached) {
		cached = charactersToExpression(subset);
		subsetToRegexCache.set(subset, cached);
	}
	return cached;
}
/**
* @param {ReadonlyArray<string>} subset
* @returns {RegExp}
*/
function charactersToExpression(subset) {
	/** @type {Array<string>} */
	const groups = [];
	let index = -1;
	while (++index < subset.length) groups.push(subset[index].replace(regexEscapeRegex, "\\$&"));
	return new RegExp("(?:" + groups.join("|") + ")", "g");
}
//#endregion
//#region node_modules/.pnpm/stringify-entities@4.0.4/node_modules/stringify-entities/lib/util/to-hexadecimal.js
const hexadecimalRegex = /[\dA-Fa-f]/;
/**
* Configurable ways to encode characters as hexadecimal references.
*
* @param {number} code
* @param {number} next
* @param {boolean|undefined} omit
* @returns {string}
*/
function toHexadecimal(code, next, omit) {
	const value = "&#x" + code.toString(16).toUpperCase();
	return omit && next && !hexadecimalRegex.test(String.fromCharCode(next)) ? value : value + ";";
}
//#endregion
//#region node_modules/.pnpm/stringify-entities@4.0.4/node_modules/stringify-entities/lib/util/to-decimal.js
const decimalRegex = /\d/;
/**
* Configurable ways to encode characters as decimal references.
*
* @param {number} code
* @param {number} next
* @param {boolean|undefined} omit
* @returns {string}
*/
function toDecimal(code, next, omit) {
	const value = "&#" + String(code);
	return omit && next && !decimalRegex.test(String.fromCharCode(next)) ? value : value + ";";
}
//#endregion
//#region node_modules/.pnpm/character-entities-legacy@3.0.0/node_modules/character-entities-legacy/index.js
/**
* List of legacy HTML named character references that don’t need a trailing semicolon.
*
* @type {Array<string>}
*/
const characterEntitiesLegacy = [
	"AElig",
	"AMP",
	"Aacute",
	"Acirc",
	"Agrave",
	"Aring",
	"Atilde",
	"Auml",
	"COPY",
	"Ccedil",
	"ETH",
	"Eacute",
	"Ecirc",
	"Egrave",
	"Euml",
	"GT",
	"Iacute",
	"Icirc",
	"Igrave",
	"Iuml",
	"LT",
	"Ntilde",
	"Oacute",
	"Ocirc",
	"Ograve",
	"Oslash",
	"Otilde",
	"Ouml",
	"QUOT",
	"REG",
	"THORN",
	"Uacute",
	"Ucirc",
	"Ugrave",
	"Uuml",
	"Yacute",
	"aacute",
	"acirc",
	"acute",
	"aelig",
	"agrave",
	"amp",
	"aring",
	"atilde",
	"auml",
	"brvbar",
	"ccedil",
	"cedil",
	"cent",
	"copy",
	"curren",
	"deg",
	"divide",
	"eacute",
	"ecirc",
	"egrave",
	"eth",
	"euml",
	"frac12",
	"frac14",
	"frac34",
	"gt",
	"iacute",
	"icirc",
	"iexcl",
	"igrave",
	"iquest",
	"iuml",
	"laquo",
	"lt",
	"macr",
	"micro",
	"middot",
	"nbsp",
	"not",
	"ntilde",
	"oacute",
	"ocirc",
	"ograve",
	"ordf",
	"ordm",
	"oslash",
	"otilde",
	"ouml",
	"para",
	"plusmn",
	"pound",
	"quot",
	"raquo",
	"reg",
	"sect",
	"shy",
	"sup1",
	"sup2",
	"sup3",
	"szlig",
	"thorn",
	"times",
	"uacute",
	"ucirc",
	"ugrave",
	"uml",
	"uuml",
	"yacute",
	"yen",
	"yuml"
];
//#endregion
//#region node_modules/.pnpm/character-entities-html4@2.1.0/node_modules/character-entities-html4/index.js
/**
* Map of named character references from HTML 4.
*
* @type {Record<string, string>}
*/
const characterEntitiesHtml4 = {
	nbsp: "\xA0",
	iexcl: "¡",
	cent: "¢",
	pound: "£",
	curren: "¤",
	yen: "¥",
	brvbar: "¦",
	sect: "§",
	uml: "¨",
	copy: "©",
	ordf: "ª",
	laquo: "«",
	not: "¬",
	shy: "­",
	reg: "®",
	macr: "¯",
	deg: "°",
	plusmn: "±",
	sup2: "²",
	sup3: "³",
	acute: "´",
	micro: "µ",
	para: "¶",
	middot: "·",
	cedil: "¸",
	sup1: "¹",
	ordm: "º",
	raquo: "»",
	frac14: "¼",
	frac12: "½",
	frac34: "¾",
	iquest: "¿",
	Agrave: "À",
	Aacute: "Á",
	Acirc: "Â",
	Atilde: "Ã",
	Auml: "Ä",
	Aring: "Å",
	AElig: "Æ",
	Ccedil: "Ç",
	Egrave: "È",
	Eacute: "É",
	Ecirc: "Ê",
	Euml: "Ë",
	Igrave: "Ì",
	Iacute: "Í",
	Icirc: "Î",
	Iuml: "Ï",
	ETH: "Ð",
	Ntilde: "Ñ",
	Ograve: "Ò",
	Oacute: "Ó",
	Ocirc: "Ô",
	Otilde: "Õ",
	Ouml: "Ö",
	times: "×",
	Oslash: "Ø",
	Ugrave: "Ù",
	Uacute: "Ú",
	Ucirc: "Û",
	Uuml: "Ü",
	Yacute: "Ý",
	THORN: "Þ",
	szlig: "ß",
	agrave: "à",
	aacute: "á",
	acirc: "â",
	atilde: "ã",
	auml: "ä",
	aring: "å",
	aelig: "æ",
	ccedil: "ç",
	egrave: "è",
	eacute: "é",
	ecirc: "ê",
	euml: "ë",
	igrave: "ì",
	iacute: "í",
	icirc: "î",
	iuml: "ï",
	eth: "ð",
	ntilde: "ñ",
	ograve: "ò",
	oacute: "ó",
	ocirc: "ô",
	otilde: "õ",
	ouml: "ö",
	divide: "÷",
	oslash: "ø",
	ugrave: "ù",
	uacute: "ú",
	ucirc: "û",
	uuml: "ü",
	yacute: "ý",
	thorn: "þ",
	yuml: "ÿ",
	fnof: "ƒ",
	Alpha: "Α",
	Beta: "Β",
	Gamma: "Γ",
	Delta: "Δ",
	Epsilon: "Ε",
	Zeta: "Ζ",
	Eta: "Η",
	Theta: "Θ",
	Iota: "Ι",
	Kappa: "Κ",
	Lambda: "Λ",
	Mu: "Μ",
	Nu: "Ν",
	Xi: "Ξ",
	Omicron: "Ο",
	Pi: "Π",
	Rho: "Ρ",
	Sigma: "Σ",
	Tau: "Τ",
	Upsilon: "Υ",
	Phi: "Φ",
	Chi: "Χ",
	Psi: "Ψ",
	Omega: "Ω",
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	epsilon: "ε",
	zeta: "ζ",
	eta: "η",
	theta: "θ",
	iota: "ι",
	kappa: "κ",
	lambda: "λ",
	mu: "μ",
	nu: "ν",
	xi: "ξ",
	omicron: "ο",
	pi: "π",
	rho: "ρ",
	sigmaf: "ς",
	sigma: "σ",
	tau: "τ",
	upsilon: "υ",
	phi: "φ",
	chi: "χ",
	psi: "ψ",
	omega: "ω",
	thetasym: "ϑ",
	upsih: "ϒ",
	piv: "ϖ",
	bull: "•",
	hellip: "…",
	prime: "′",
	Prime: "″",
	oline: "‾",
	frasl: "⁄",
	weierp: "℘",
	image: "ℑ",
	real: "ℜ",
	trade: "™",
	alefsym: "ℵ",
	larr: "←",
	uarr: "↑",
	rarr: "→",
	darr: "↓",
	harr: "↔",
	crarr: "↵",
	lArr: "⇐",
	uArr: "⇑",
	rArr: "⇒",
	dArr: "⇓",
	hArr: "⇔",
	forall: "∀",
	part: "∂",
	exist: "∃",
	empty: "∅",
	nabla: "∇",
	isin: "∈",
	notin: "∉",
	ni: "∋",
	prod: "∏",
	sum: "∑",
	minus: "−",
	lowast: "∗",
	radic: "√",
	prop: "∝",
	infin: "∞",
	ang: "∠",
	and: "∧",
	or: "∨",
	cap: "∩",
	cup: "∪",
	int: "∫",
	there4: "∴",
	sim: "∼",
	cong: "≅",
	asymp: "≈",
	ne: "≠",
	equiv: "≡",
	le: "≤",
	ge: "≥",
	sub: "⊂",
	sup: "⊃",
	nsub: "⊄",
	sube: "⊆",
	supe: "⊇",
	oplus: "⊕",
	otimes: "⊗",
	perp: "⊥",
	sdot: "⋅",
	lceil: "⌈",
	rceil: "⌉",
	lfloor: "⌊",
	rfloor: "⌋",
	lang: "〈",
	rang: "〉",
	loz: "◊",
	spades: "♠",
	clubs: "♣",
	hearts: "♥",
	diams: "♦",
	quot: "\"",
	amp: "&",
	lt: "<",
	gt: ">",
	OElig: "Œ",
	oelig: "œ",
	Scaron: "Š",
	scaron: "š",
	Yuml: "Ÿ",
	circ: "ˆ",
	tilde: "˜",
	ensp: " ",
	emsp: " ",
	thinsp: " ",
	zwnj: "‌",
	zwj: "‍",
	lrm: "‎",
	rlm: "‏",
	ndash: "–",
	mdash: "—",
	lsquo: "‘",
	rsquo: "’",
	sbquo: "‚",
	ldquo: "“",
	rdquo: "”",
	bdquo: "„",
	dagger: "†",
	Dagger: "‡",
	permil: "‰",
	lsaquo: "‹",
	rsaquo: "›",
	euro: "€"
};
//#endregion
//#region node_modules/.pnpm/stringify-entities@4.0.4/node_modules/stringify-entities/lib/constant/dangerous.js
/**
* List of legacy (that don’t need a trailing `;`) named references which could,
* depending on what follows them, turn into a different meaning
*
* @type {Array<string>}
*/
const dangerous = [
	"cent",
	"copy",
	"divide",
	"gt",
	"lt",
	"not",
	"para",
	"times"
];
//#endregion
//#region node_modules/.pnpm/stringify-entities@4.0.4/node_modules/stringify-entities/lib/util/to-named.js
const own$1 = {}.hasOwnProperty;
/**
* `characterEntitiesHtml4` but inverted.
*
* @type {Record<string, string>}
*/
const characters = {};
/** @type {string} */
let key;
for (key in characterEntitiesHtml4) if (own$1.call(characterEntitiesHtml4, key)) characters[characterEntitiesHtml4[key]] = key;
const notAlphanumericRegex = /[^\dA-Za-z]/;
/**
* Configurable ways to encode characters as named references.
*
* @param {number} code
* @param {number} next
* @param {boolean|undefined} omit
* @param {boolean|undefined} attribute
* @returns {string}
*/
function toNamed(code, next, omit, attribute) {
	const character = String.fromCharCode(code);
	if (own$1.call(characters, character)) {
		const name = characters[character];
		const value = "&" + name;
		if (omit && characterEntitiesLegacy.includes(name) && !dangerous.includes(name) && (!attribute || next && next !== 61 && notAlphanumericRegex.test(String.fromCharCode(next)))) return value;
		return value + ";";
	}
	return "";
}
//#endregion
//#region node_modules/.pnpm/stringify-entities@4.0.4/node_modules/stringify-entities/lib/util/format-smart.js
/**
* @typedef FormatSmartOptions
* @property {boolean} [useNamedReferences=false]
*   Prefer named character references (`&amp;`) where possible.
* @property {boolean} [useShortestReferences=false]
*   Prefer the shortest possible reference, if that results in less bytes.
*   **Note**: `useNamedReferences` can be omitted when using `useShortestReferences`.
* @property {boolean} [omitOptionalSemicolons=false]
*   Whether to omit semicolons when possible.
*   **Note**: This creates what HTML calls “parse errors” but is otherwise still valid HTML — don’t use this except when building a minifier.
*   Omitting semicolons is possible for certain named and numeric references in some cases.
* @property {boolean} [attribute=false]
*   Create character references which don’t fail in attributes.
*   **Note**: `attribute` only applies when operating dangerously with
*   `omitOptionalSemicolons: true`.
*/
/**
* Configurable ways to encode a character yielding pretty or small results.
*
* @param {number} code
* @param {number} next
* @param {FormatSmartOptions} options
* @returns {string}
*/
function formatSmart(code, next, options) {
	let numeric = toHexadecimal(code, next, options.omitOptionalSemicolons);
	/** @type {string|undefined} */
	let named;
	if (options.useNamedReferences || options.useShortestReferences) named = toNamed(code, next, options.omitOptionalSemicolons, options.attribute);
	if ((options.useShortestReferences || !named) && options.useShortestReferences) {
		const decimal = toDecimal(code, next, options.omitOptionalSemicolons);
		if (decimal.length < numeric.length) numeric = decimal;
	}
	return named && (!options.useShortestReferences || named.length < numeric.length) ? named : numeric;
}
//#endregion
//#region node_modules/.pnpm/stringify-entities@4.0.4/node_modules/stringify-entities/lib/index.js
/**
* @typedef {import('./core.js').CoreOptions & import('./util/format-smart.js').FormatSmartOptions} Options
* @typedef {import('./core.js').CoreOptions} LightOptions
*/
/**
* Encode special characters in `value`.
*
* @param {string} value
*   Value to encode.
* @param {Options} [options]
*   Configuration.
* @returns {string}
*   Encoded value.
*/
function stringifyEntities(value, options) {
	return core(value, Object.assign({ format: formatSmart }, options));
}
//#endregion
//#region node_modules/.pnpm/hast-util-to-html@9.0.5/node_modules/hast-util-to-html/lib/handle/comment.js
/**
* @import {Comment, Parents} from 'hast'
* @import {State} from '../index.js'
*/
const htmlCommentRegex = /^>|^->|<!--|-->|--!>|<!-$/g;
const bogusCommentEntitySubset = [">"];
const commentEntitySubset = ["<", ">"];
/**
* Serialize a comment.
*
* @param {Comment} node
*   Node to handle.
* @param {number | undefined} _1
*   Index of `node` in `parent.
* @param {Parents | undefined} _2
*   Parent of `node`.
* @param {State} state
*   Info passed around about the current state.
* @returns {string}
*   Serialized node.
*/
function comment(node, _1, _2, state) {
	return state.settings.bogusComments ? "<?" + stringifyEntities(node.value, Object.assign({}, state.settings.characterReferences, { subset: bogusCommentEntitySubset })) + ">" : "<!--" + node.value.replace(htmlCommentRegex, encode) + "-->";
	/**
	* @param {string} $0
	*/
	function encode($0) {
		return stringifyEntities($0, Object.assign({}, state.settings.characterReferences, { subset: commentEntitySubset }));
	}
}
//#endregion
//#region node_modules/.pnpm/hast-util-to-html@9.0.5/node_modules/hast-util-to-html/lib/handle/doctype.js
/**
* @import {Doctype, Parents} from 'hast'
* @import {State} from '../index.js'
*/
/**
* Serialize a doctype.
*
* @param {Doctype} _1
*   Node to handle.
* @param {number | undefined} _2
*   Index of `node` in `parent.
* @param {Parents | undefined} _3
*   Parent of `node`.
* @param {State} state
*   Info passed around about the current state.
* @returns {string}
*   Serialized node.
*/
function doctype(_1, _2, _3, state) {
	return "<!" + (state.settings.upperDoctype ? "DOCTYPE" : "doctype") + (state.settings.tightDoctype ? "" : " ") + "html>";
}
//#endregion
//#region node_modules/.pnpm/ccount@2.0.1/node_modules/ccount/index.js
/**
* Count how often a character (or substring) is used in a string.
*
* @param {string} value
*   Value to search in.
* @param {string} character
*   Character (or substring) to look for.
* @return {number}
*   Number of times `character` occurred in `value`.
*/
function ccount(value, character) {
	const source = String(value);
	if (typeof character !== "string") throw new TypeError("Expected character");
	let count = 0;
	let index = source.indexOf(character);
	while (index !== -1) {
		count++;
		index = source.indexOf(character, index + character.length);
	}
	return count;
}
//#endregion
//#region node_modules/.pnpm/comma-separated-tokens@2.0.3/node_modules/comma-separated-tokens/index.js
/**
* Serialize an array of strings or numbers to comma-separated tokens.
*
* @param {Array<string|number>} values
*   List of tokens.
* @param {Options} [options]
*   Configuration for `stringify` (optional).
* @returns {string}
*   Comma-separated tokens.
*/
function stringify$2(values, options) {
	const settings = options || {};
	return (values[values.length - 1] === "" ? [...values, ""] : values).join((settings.padRight ? " " : "") + "," + (settings.padLeft === false ? "" : " ")).trim();
}
//#endregion
//#region node_modules/.pnpm/space-separated-tokens@2.0.2/node_modules/space-separated-tokens/index.js
/**
* Serialize an array of strings as space separated-tokens.
*
* @param {Array<string|number>} values
*   List of tokens.
* @returns {string}
*   Space-separated tokens.
*/
function stringify$1(values) {
	return values.join(" ").trim();
}
//#endregion
//#region node_modules/.pnpm/hast-util-whitespace@3.0.0/node_modules/hast-util-whitespace/lib/index.js
/**
* @typedef {import('hast').Nodes} Nodes
*/
const re$1 = /[ \t\n\f\r]/g;
/**
* Check if the given value is *inter-element whitespace*.
*
* @param {Nodes | string} thing
*   Thing to check (`Node` or `string`).
* @returns {boolean}
*   Whether the `value` is inter-element whitespace (`boolean`): consisting of
*   zero or more of space, tab (`\t`), line feed (`\n`), carriage return
*   (`\r`), or form feed (`\f`); if a node is passed it must be a `Text` node,
*   whose `value` field is checked.
*/
function whitespace(thing) {
	return typeof thing === "object" ? thing.type === "text" ? empty(thing.value) : false : empty(thing);
}
/**
* @param {string} value
* @returns {boolean}
*/
function empty(value) {
	return value.replace(re$1, "") === "";
}
//#endregion
//#region node_modules/.pnpm/hast-util-to-html@9.0.5/node_modules/hast-util-to-html/lib/omission/util/siblings.js
/**
* @import {Parents, RootContent} from 'hast'
*/
const siblingAfter = siblings(1);
const siblingBefore = siblings(-1);
/** @type {Array<RootContent>} */
const emptyChildren$1 = [];
/**
* Factory to check siblings in a direction.
*
* @param {number} increment
*/
function siblings(increment) {
	return sibling;
	/**
	* Find applicable siblings in a direction.
	*
	* @template {Parents} Parent
	*   Parent type.
	* @param {Parent | undefined} parent
	*   Parent.
	* @param {number | undefined} index
	*   Index of child in `parent`.
	* @param {boolean | undefined} [includeWhitespace=false]
	*   Whether to include whitespace (default: `false`).
	* @returns {Parent extends {children: Array<infer Child>} ? Child | undefined : never}
	*   Child of parent.
	*/
	function sibling(parent, index, includeWhitespace) {
		const siblings = parent ? parent.children : emptyChildren$1;
		let offset = (index || 0) + increment;
		let next = siblings[offset];
		if (!includeWhitespace) while (next && whitespace(next)) {
			offset += increment;
			next = siblings[offset];
		}
		return next;
	}
}
//#endregion
//#region node_modules/.pnpm/hast-util-to-html@9.0.5/node_modules/hast-util-to-html/lib/omission/omission.js
/**
* @import {Element, Parents} from 'hast'
*/
/**
* @callback OmitHandle
*   Check if a tag can be omitted.
* @param {Element} element
*   Element to check.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether to omit a tag.
*
*/
const own = {}.hasOwnProperty;
/**
* Factory to check if a given node can have a tag omitted.
*
* @param {Record<string, OmitHandle>} handlers
*   Omission handlers, where each key is a tag name, and each value is the
*   corresponding handler.
* @returns {OmitHandle}
*   Whether to omit a tag of an element.
*/
function omission(handlers) {
	return omit;
	/**
	* Check if a given node can have a tag omitted.
	*
	* @type {OmitHandle}
	*/
	function omit(node, index, parent) {
		return own.call(handlers, node.tagName) && handlers[node.tagName](node, index, parent);
	}
}
//#endregion
//#region node_modules/.pnpm/hast-util-to-html@9.0.5/node_modules/hast-util-to-html/lib/omission/closing.js
/**
* @import {Element, Parents} from 'hast'
*/
const closing = omission({
	body: body$1,
	caption: headOrColgroupOrCaption,
	colgroup: headOrColgroupOrCaption,
	dd,
	dt,
	head: headOrColgroupOrCaption,
	html: html$1,
	li,
	optgroup,
	option,
	p,
	rp: rubyElement,
	rt: rubyElement,
	tbody: tbody$1,
	td: cells,
	tfoot,
	th: cells,
	thead,
	tr
});
/**
* Macro for `</head>`, `</colgroup>`, and `</caption>`.
*
* @param {Element} _
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the closing tag can be omitted.
*/
function headOrColgroupOrCaption(_, index, parent) {
	const next = siblingAfter(parent, index, true);
	return !next || next.type !== "comment" && !(next.type === "text" && whitespace(next.value.charAt(0)));
}
/**
* Whether to omit `</html>`.
*
* @param {Element} _
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the closing tag can be omitted.
*/
function html$1(_, index, parent) {
	const next = siblingAfter(parent, index);
	return !next || next.type !== "comment";
}
/**
* Whether to omit `</body>`.
*
* @param {Element} _
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the closing tag can be omitted.
*/
function body$1(_, index, parent) {
	const next = siblingAfter(parent, index);
	return !next || next.type !== "comment";
}
/**
* Whether to omit `</p>`.
*
* @param {Element} _
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the closing tag can be omitted.
*/
function p(_, index, parent) {
	const next = siblingAfter(parent, index);
	return next ? next.type === "element" && (next.tagName === "address" || next.tagName === "article" || next.tagName === "aside" || next.tagName === "blockquote" || next.tagName === "details" || next.tagName === "div" || next.tagName === "dl" || next.tagName === "fieldset" || next.tagName === "figcaption" || next.tagName === "figure" || next.tagName === "footer" || next.tagName === "form" || next.tagName === "h1" || next.tagName === "h2" || next.tagName === "h3" || next.tagName === "h4" || next.tagName === "h5" || next.tagName === "h6" || next.tagName === "header" || next.tagName === "hgroup" || next.tagName === "hr" || next.tagName === "main" || next.tagName === "menu" || next.tagName === "nav" || next.tagName === "ol" || next.tagName === "p" || next.tagName === "pre" || next.tagName === "section" || next.tagName === "table" || next.tagName === "ul") : !parent || !(parent.type === "element" && (parent.tagName === "a" || parent.tagName === "audio" || parent.tagName === "del" || parent.tagName === "ins" || parent.tagName === "map" || parent.tagName === "noscript" || parent.tagName === "video"));
}
/**
* Whether to omit `</li>`.
*
* @param {Element} _
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the closing tag can be omitted.
*/
function li(_, index, parent) {
	const next = siblingAfter(parent, index);
	return !next || next.type === "element" && next.tagName === "li";
}
/**
* Whether to omit `</dt>`.
*
* @param {Element} _
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the closing tag can be omitted.
*/
function dt(_, index, parent) {
	const next = siblingAfter(parent, index);
	return Boolean(next && next.type === "element" && (next.tagName === "dt" || next.tagName === "dd"));
}
/**
* Whether to omit `</dd>`.
*
* @param {Element} _
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the closing tag can be omitted.
*/
function dd(_, index, parent) {
	const next = siblingAfter(parent, index);
	return !next || next.type === "element" && (next.tagName === "dt" || next.tagName === "dd");
}
/**
* Whether to omit `</rt>` or `</rp>`.
*
* @param {Element} _
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the closing tag can be omitted.
*/
function rubyElement(_, index, parent) {
	const next = siblingAfter(parent, index);
	return !next || next.type === "element" && (next.tagName === "rp" || next.tagName === "rt");
}
/**
* Whether to omit `</optgroup>`.
*
* @param {Element} _
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the closing tag can be omitted.
*/
function optgroup(_, index, parent) {
	const next = siblingAfter(parent, index);
	return !next || next.type === "element" && next.tagName === "optgroup";
}
/**
* Whether to omit `</option>`.
*
* @param {Element} _
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the closing tag can be omitted.
*/
function option(_, index, parent) {
	const next = siblingAfter(parent, index);
	return !next || next.type === "element" && (next.tagName === "option" || next.tagName === "optgroup");
}
/**
* Whether to omit `</thead>`.
*
* @param {Element} _
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the closing tag can be omitted.
*/
function thead(_, index, parent) {
	const next = siblingAfter(parent, index);
	return Boolean(next && next.type === "element" && (next.tagName === "tbody" || next.tagName === "tfoot"));
}
/**
* Whether to omit `</tbody>`.
*
* @param {Element} _
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the closing tag can be omitted.
*/
function tbody$1(_, index, parent) {
	const next = siblingAfter(parent, index);
	return !next || next.type === "element" && (next.tagName === "tbody" || next.tagName === "tfoot");
}
/**
* Whether to omit `</tfoot>`.
*
* @param {Element} _
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the closing tag can be omitted.
*/
function tfoot(_, index, parent) {
	return !siblingAfter(parent, index);
}
/**
* Whether to omit `</tr>`.
*
* @param {Element} _
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the closing tag can be omitted.
*/
function tr(_, index, parent) {
	const next = siblingAfter(parent, index);
	return !next || next.type === "element" && next.tagName === "tr";
}
/**
* Whether to omit `</td>` or `</th>`.
*
* @param {Element} _
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the closing tag can be omitted.
*/
function cells(_, index, parent) {
	const next = siblingAfter(parent, index);
	return !next || next.type === "element" && (next.tagName === "td" || next.tagName === "th");
}
//#endregion
//#region node_modules/.pnpm/hast-util-to-html@9.0.5/node_modules/hast-util-to-html/lib/omission/opening.js
/**
* @import {Element, Parents} from 'hast'
*/
const opening = omission({
	body,
	colgroup,
	head,
	html,
	tbody
});
/**
* Whether to omit `<html>`.
*
* @param {Element} node
*   Element.
* @returns {boolean}
*   Whether the opening tag can be omitted.
*/
function html(node) {
	const head = siblingAfter(node, -1);
	return !head || head.type !== "comment";
}
/**
* Whether to omit `<head>`.
*
* @param {Element} node
*   Element.
* @returns {boolean}
*   Whether the opening tag can be omitted.
*/
function head(node) {
	/** @type {Set<string>} */
	const seen = /* @__PURE__ */ new Set();
	for (const child of node.children) if (child.type === "element" && (child.tagName === "base" || child.tagName === "title")) {
		if (seen.has(child.tagName)) return false;
		seen.add(child.tagName);
	}
	const child = node.children[0];
	return !child || child.type === "element";
}
/**
* Whether to omit `<body>`.
*
* @param {Element} node
*   Element.
* @returns {boolean}
*   Whether the opening tag can be omitted.
*/
function body(node) {
	const head = siblingAfter(node, -1, true);
	return !head || head.type !== "comment" && !(head.type === "text" && whitespace(head.value.charAt(0))) && !(head.type === "element" && (head.tagName === "meta" || head.tagName === "link" || head.tagName === "script" || head.tagName === "style" || head.tagName === "template"));
}
/**
* Whether to omit `<colgroup>`.
* The spec describes some logic for the opening tag, but it’s easier to
* implement in the closing tag, to the same effect, so we handle it there
* instead.
*
* @param {Element} node
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the opening tag can be omitted.
*/
function colgroup(node, index, parent) {
	const previous = siblingBefore(parent, index);
	const head = siblingAfter(node, -1, true);
	if (parent && previous && previous.type === "element" && previous.tagName === "colgroup" && closing(previous, parent.children.indexOf(previous), parent)) return false;
	return Boolean(head && head.type === "element" && head.tagName === "col");
}
/**
* Whether to omit `<tbody>`.
*
* @param {Element} node
*   Element.
* @param {number | undefined} index
*   Index of element in parent.
* @param {Parents | undefined} parent
*   Parent of element.
* @returns {boolean}
*   Whether the opening tag can be omitted.
*/
function tbody(node, index, parent) {
	const previous = siblingBefore(parent, index);
	const head = siblingAfter(node, -1);
	if (parent && previous && previous.type === "element" && (previous.tagName === "thead" || previous.tagName === "tbody") && closing(previous, parent.children.indexOf(previous), parent)) return false;
	return Boolean(head && head.type === "element" && head.tagName === "tr");
}
//#endregion
//#region node_modules/.pnpm/hast-util-to-html@9.0.5/node_modules/hast-util-to-html/lib/handle/element.js
/**
* @import {Element, Parents, Properties} from 'hast'
* @import {State} from '../index.js'
*/
/**
* Maps of subsets.
*
* Each value is a matrix of tuples.
* The value at `0` causes parse errors, the value at `1` is valid.
* Of both, the value at `0` is unsafe, and the value at `1` is safe.
*
* @type {Record<'double' | 'name' | 'single' | 'unquoted', Array<[Array<string>, Array<string>]>>}
*/
const constants$1 = {
	name: [["	\n\f\r &/=>".split(""), "	\n\f\r \"&'/=>`".split("")], ["\0	\n\f\r \"&'/<=>".split(""), "\0	\n\f\r \"&'/<=>`".split("")]],
	unquoted: [["	\n\f\r &>".split(""), "\0	\n\f\r \"&'<=>`".split("")], ["\0	\n\f\r \"&'<=>`".split(""), "\0	\n\f\r \"&'<=>`".split("")]],
	single: [["&'".split(""), "\"&'`".split("")], ["\0&'".split(""), "\0\"&'`".split("")]],
	double: [["\"&".split(""), "\"&'`".split("")], ["\0\"&".split(""), "\0\"&'`".split("")]]
};
/**
* Serialize an element node.
*
* @param {Element} node
*   Node to handle.
* @param {number | undefined} index
*   Index of `node` in `parent.
* @param {Parents | undefined} parent
*   Parent of `node`.
* @param {State} state
*   Info passed around about the current state.
* @returns {string}
*   Serialized node.
*/
function element(node, index, parent, state) {
	const schema = state.schema;
	const omit = schema.space === "svg" ? false : state.settings.omitOptionalTags;
	let selfClosing = schema.space === "svg" ? state.settings.closeEmptyElements : state.settings.voids.includes(node.tagName.toLowerCase());
	/** @type {Array<string>} */
	const parts = [];
	/** @type {string} */
	let last;
	if (schema.space === "html" && node.tagName === "svg") state.schema = svg;
	const attributes = serializeAttributes(state, node.properties);
	const content = state.all(schema.space === "html" && node.tagName === "template" ? node.content : node);
	state.schema = schema;
	if (content) selfClosing = false;
	if (attributes || !omit || !opening(node, index, parent)) {
		parts.push("<", node.tagName, attributes ? " " + attributes : "");
		if (selfClosing && (schema.space === "svg" || state.settings.closeSelfClosing)) {
			last = attributes.charAt(attributes.length - 1);
			if (!state.settings.tightSelfClosing || last === "/" || last && last !== "\"" && last !== "'") parts.push(" ");
			parts.push("/");
		}
		parts.push(">");
	}
	parts.push(content);
	if (!selfClosing && (!omit || !closing(node, index, parent))) parts.push("</" + node.tagName + ">");
	return parts.join("");
}
/**
* @param {State} state
* @param {Properties | null | undefined} properties
* @returns {string}
*/
function serializeAttributes(state, properties) {
	/** @type {Array<string>} */
	const values = [];
	let index = -1;
	/** @type {string} */
	let key;
	if (properties) {
		for (key in properties) if (properties[key] !== null && properties[key] !== void 0) {
			const value = serializeAttribute(state, key, properties[key]);
			if (value) values.push(value);
		}
	}
	while (++index < values.length) {
		const last = state.settings.tightAttributes ? values[index].charAt(values[index].length - 1) : void 0;
		if (index !== values.length - 1 && last !== "\"" && last !== "'") values[index] += " ";
	}
	return values.join("");
}
/**
* @param {State} state
* @param {string} key
* @param {Properties[keyof Properties]} value
* @returns {string}
*/
function serializeAttribute(state, key, value) {
	const info = find(state.schema, key);
	const x = state.settings.allowParseErrors && state.schema.space === "html" ? 0 : 1;
	const y = state.settings.allowDangerousCharacters ? 0 : 1;
	let quote = state.quote;
	/** @type {string | undefined} */
	let result;
	if (info.overloadedBoolean && (value === info.attribute || value === "")) value = true;
	else if ((info.boolean || info.overloadedBoolean) && (typeof value !== "string" || value === info.attribute || value === "")) value = Boolean(value);
	if (value === null || value === void 0 || value === false || typeof value === "number" && Number.isNaN(value)) return "";
	const name = stringifyEntities(info.attribute, Object.assign({}, state.settings.characterReferences, { subset: constants$1.name[x][y] }));
	if (value === true) return name;
	value = Array.isArray(value) ? (info.commaSeparated ? stringify$2 : stringify$1)(value, { padLeft: !state.settings.tightCommaSeparatedLists }) : String(value);
	if (state.settings.collapseEmptyAttributes && !value) return name;
	if (state.settings.preferUnquoted) result = stringifyEntities(value, Object.assign({}, state.settings.characterReferences, {
		attribute: true,
		subset: constants$1.unquoted[x][y]
	}));
	if (result !== value) {
		if (state.settings.quoteSmart && ccount(value, quote) > ccount(value, state.alternative)) quote = state.alternative;
		result = quote + stringifyEntities(value, Object.assign({}, state.settings.characterReferences, {
			subset: (quote === "'" ? constants$1.single : constants$1.double)[x][y],
			attribute: true
		})) + quote;
	}
	return name + (result ? "=" + result : result);
}
//#endregion
//#region node_modules/.pnpm/hast-util-to-html@9.0.5/node_modules/hast-util-to-html/lib/handle/text.js
/**
* @import {Parents, Text} from 'hast'
* @import {Raw} from 'mdast-util-to-hast'
* @import {State} from '../index.js'
*/
const textEntitySubset = ["<", "&"];
/**
* Serialize a text node.
*
* @param {Raw | Text} node
*   Node to handle.
* @param {number | undefined} _
*   Index of `node` in `parent.
* @param {Parents | undefined} parent
*   Parent of `node`.
* @param {State} state
*   Info passed around about the current state.
* @returns {string}
*   Serialized node.
*/
function text(node, _, parent, state) {
	return parent && parent.type === "element" && (parent.tagName === "script" || parent.tagName === "style") ? node.value : stringifyEntities(node.value, Object.assign({}, state.settings.characterReferences, { subset: textEntitySubset }));
}
//#endregion
//#region node_modules/.pnpm/hast-util-to-html@9.0.5/node_modules/hast-util-to-html/lib/handle/raw.js
/**
* @import {Parents} from 'hast'
* @import {Raw} from 'mdast-util-to-hast'
* @import {State} from '../index.js'
*/
/**
* Serialize a raw node.
*
* @param {Raw} node
*   Node to handle.
* @param {number | undefined} index
*   Index of `node` in `parent.
* @param {Parents | undefined} parent
*   Parent of `node`.
* @param {State} state
*   Info passed around about the current state.
* @returns {string}
*   Serialized node.
*/
function raw(node, index, parent, state) {
	return state.settings.allowDangerousHtml ? node.value : text(node, index, parent, state);
}
//#endregion
//#region node_modules/.pnpm/hast-util-to-html@9.0.5/node_modules/hast-util-to-html/lib/handle/root.js
/**
* @import {Parents, Root} from 'hast'
* @import {State} from '../index.js'
*/
/**
* Serialize a root.
*
* @param {Root} node
*   Node to handle.
* @param {number | undefined} _1
*   Index of `node` in `parent.
* @param {Parents | undefined} _2
*   Parent of `node`.
* @param {State} state
*   Info passed around about the current state.
* @returns {string}
*   Serialized node.
*/
function root(node, _1, _2, state) {
	return state.all(node);
}
//#endregion
//#region node_modules/.pnpm/hast-util-to-html@9.0.5/node_modules/hast-util-to-html/lib/handle/index.js
/**
* @import {Nodes, Parents} from 'hast'
* @import {State} from '../index.js'
*/
/**
* @type {(node: Nodes, index: number | undefined, parent: Parents | undefined, state: State) => string}
*/
const handle = zwitch("type", {
	invalid,
	unknown,
	handlers: {
		comment,
		doctype,
		element,
		raw,
		root,
		text
	}
});
/**
* Fail when a non-node is found in the tree.
*
* @param {unknown} node
*   Unknown value.
* @returns {never}
*   Never.
*/
function invalid(node) {
	throw new Error("Expected node, not `" + node + "`");
}
/**
* Fail when a node with an unknown type is found in the tree.
*
* @param {unknown} node_
*  Unknown node.
* @returns {never}
*   Never.
*/
function unknown(node_) {
	const node = node_;
	throw new Error("Cannot compile unknown node `" + node.type + "`");
}
//#endregion
//#region node_modules/.pnpm/hast-util-to-html@9.0.5/node_modules/hast-util-to-html/lib/index.js
/**
* @import {Nodes, Parents, RootContent} from 'hast'
* @import {Schema} from 'property-information'
* @import {Options as StringifyEntitiesOptions} from 'stringify-entities'
*/
/**
* @typedef {Omit<StringifyEntitiesOptions, 'attribute' | 'escapeOnly' | 'subset'>} CharacterReferences
*
* @typedef Options
*   Configuration.
* @property {boolean | null | undefined} [allowDangerousCharacters=false]
*   Do not encode some characters which cause XSS vulnerabilities in older
*   browsers (default: `false`).
*
*   > ⚠️ **Danger**: only set this if you completely trust the content.
* @property {boolean | null | undefined} [allowDangerousHtml=false]
*   Allow `raw` nodes and insert them as raw HTML (default: `false`).
*
*   When `false`, `Raw` nodes are encoded.
*
*   > ⚠️ **Danger**: only set this if you completely trust the content.
* @property {boolean | null | undefined} [allowParseErrors=false]
*   Do not encode characters which cause parse errors (even though they work),
*   to save bytes (default: `false`).
*
*   Not used in the SVG space.
*
*   > 👉 **Note**: intentionally creates parse errors in markup (how parse
*   > errors are handled is well defined, so this works but isn’t pretty).
* @property {boolean | null | undefined} [bogusComments=false]
*   Use “bogus comments” instead of comments to save byes: `<?charlie>`
*   instead of `<!--charlie-->` (default: `false`).
*
*   > 👉 **Note**: intentionally creates parse errors in markup (how parse
*   > errors are handled is well defined, so this works but isn’t pretty).
* @property {CharacterReferences | null | undefined} [characterReferences]
*   Configure how to serialize character references (optional).
* @property {boolean | null | undefined} [closeEmptyElements=false]
*   Close SVG elements without any content with slash (`/`) on the opening tag
*   instead of an end tag: `<circle />` instead of `<circle></circle>`
*   (default: `false`).
*
*   See `tightSelfClosing` to control whether a space is used before the
*   slash.
*
*   Not used in the HTML space.
* @property {boolean | null | undefined} [closeSelfClosing=false]
*   Close self-closing nodes with an extra slash (`/`): `<img />` instead of
*   `<img>` (default: `false`).
*
*   See `tightSelfClosing` to control whether a space is used before the
*   slash.
*
*   Not used in the SVG space.
* @property {boolean | null | undefined} [collapseEmptyAttributes=false]
*   Collapse empty attributes: get `class` instead of `class=""` (default:
*   `false`).
*
*   Not used in the SVG space.
*
*   > 👉 **Note**: boolean attributes (such as `hidden`) are always collapsed.
* @property {boolean | null | undefined} [omitOptionalTags=false]
*   Omit optional opening and closing tags (default: `false`).
*
*   For example, in `<ol><li>one</li><li>two</li></ol>`, both `</li>` closing
*   tags can be omitted.
*   The first because it’s followed by another `li`, the last because it’s
*   followed by nothing.
*
*   Not used in the SVG space.
* @property {boolean | null | undefined} [preferUnquoted=false]
*   Leave attributes unquoted if that results in less bytes (default: `false`).
*
*   Not used in the SVG space.
* @property {boolean | null | undefined} [quoteSmart=false]
*   Use the other quote if that results in less bytes (default: `false`).
* @property {Quote | null | undefined} [quote='"']
*   Preferred quote to use (default: `'"'`).
* @property {Space | null | undefined} [space='html']
*   When an `<svg>` element is found in the HTML space, this package already
*   automatically switches to and from the SVG space when entering and exiting
*   it (default: `'html'`).
*
*   > 👉 **Note**: hast is not XML.
*   > It supports SVG as embedded in HTML.
*   > It does not support the features available in XML.
*   > Passing SVG might break but fragments of modern SVG should be fine.
*   > Use [`xast`][xast] if you need to support SVG as XML.
* @property {boolean | null | undefined} [tightAttributes=false]
*   Join attributes together, without whitespace, if possible: get
*   `class="a b"title="c d"` instead of `class="a b" title="c d"` to save
*   bytes (default: `false`).
*
*   Not used in the SVG space.
*
*   > 👉 **Note**: intentionally creates parse errors in markup (how parse
*   > errors are handled is well defined, so this works but isn’t pretty).
* @property {boolean | null | undefined} [tightCommaSeparatedLists=false]
*   Join known comma-separated attribute values with just a comma (`,`),
*   instead of padding them on the right as well (`,␠`, where `␠` represents a
*   space) (default: `false`).
* @property {boolean | null | undefined} [tightDoctype=false]
*   Drop unneeded spaces in doctypes: `<!doctypehtml>` instead of
*   `<!doctype html>` to save bytes (default: `false`).
*
*   > 👉 **Note**: intentionally creates parse errors in markup (how parse
*   > errors are handled is well defined, so this works but isn’t pretty).
* @property {boolean | null | undefined} [tightSelfClosing=false]
*   Do not use an extra space when closing self-closing elements: `<img/>`
*   instead of `<img />` (default: `false`).
*
*   > 👉 **Note**: only used if `closeSelfClosing: true` or
*   > `closeEmptyElements: true`.
* @property {boolean | null | undefined} [upperDoctype=false]
*   Use a `<!DOCTYPE…` instead of `<!doctype…` (default: `false`).
*
*   Useless except for XHTML.
* @property {ReadonlyArray<string> | null | undefined} [voids]
*   Tag names of elements to serialize without closing tag (default: `html-void-elements`).
*
*   Not used in the SVG space.
*
*   > 👉 **Note**: It’s highly unlikely that you want to pass this, because
*   > hast is not for XML, and HTML will not add more void elements.
*
* @typedef {'"' | "'"} Quote
*   HTML quotes for attribute values.
*
* @typedef {Omit<Required<{[key in keyof Options]: Exclude<Options[key], null | undefined>}>, 'space' | 'quote'>} Settings
*
* @typedef {'html' | 'svg'} Space
*   Namespace.
*
* @typedef State
*   Info passed around about the current state.
* @property {(node: Parents | undefined) => string} all
*   Serialize the children of a parent node.
* @property {Quote} alternative
*   Alternative quote.
* @property {(node: Nodes, index: number | undefined, parent: Parents | undefined) => string} one
*   Serialize one node.
* @property {Quote} quote
*   Preferred quote.
* @property {Schema} schema
*   Current schema.
* @property {Settings} settings
*   User configuration.
*/
/** @type {Options} */
const emptyOptions = {};
/** @type {CharacterReferences} */
const emptyCharacterReferences = {};
/** @type {Array<never>} */
const emptyChildren = [];
/**
* Serialize hast as HTML.
*
* @param {Array<RootContent> | Nodes} tree
*   Tree to serialize.
* @param {Options | null | undefined} [options]
*   Configuration (optional).
* @returns {string}
*   Serialized HTML.
*/
function toHtml(tree, options) {
	const options_ = options || emptyOptions;
	const quote = options_.quote || "\"";
	const alternative = quote === "\"" ? "'" : "\"";
	if (quote !== "\"" && quote !== "'") throw new Error("Invalid quote `" + quote + "`, expected `'` or `\"`");
	return {
		one,
		all,
		settings: {
			omitOptionalTags: options_.omitOptionalTags || false,
			allowParseErrors: options_.allowParseErrors || false,
			allowDangerousCharacters: options_.allowDangerousCharacters || false,
			quoteSmart: options_.quoteSmart || false,
			preferUnquoted: options_.preferUnquoted || false,
			tightAttributes: options_.tightAttributes || false,
			upperDoctype: options_.upperDoctype || false,
			tightDoctype: options_.tightDoctype || false,
			bogusComments: options_.bogusComments || false,
			tightCommaSeparatedLists: options_.tightCommaSeparatedLists || false,
			tightSelfClosing: options_.tightSelfClosing || false,
			collapseEmptyAttributes: options_.collapseEmptyAttributes || false,
			allowDangerousHtml: options_.allowDangerousHtml || false,
			voids: options_.voids || htmlVoidElements,
			characterReferences: options_.characterReferences || emptyCharacterReferences,
			closeSelfClosing: options_.closeSelfClosing || false,
			closeEmptyElements: options_.closeEmptyElements || false
		},
		schema: options_.space === "svg" ? svg : html$2,
		quote,
		alternative
	}.one(Array.isArray(tree) ? {
		type: "root",
		children: tree
	} : tree, void 0, void 0);
}
/**
* Serialize a node.
*
* @this {State}
*   Info passed around about the current state.
* @param {Nodes} node
*   Node to handle.
* @param {number | undefined} index
*   Index of `node` in `parent.
* @param {Parents | undefined} parent
*   Parent of `node`.
* @returns {string}
*   Serialized node.
*/
function one(node, index, parent) {
	return handle(node, index, parent, this);
}
/**
* Serialize all children of `parent`.
*
* @this {State}
*   Info passed around about the current state.
* @param {Parents | undefined} parent
*   Parent whose children to serialize.
* @returns {string}
*/
function all(parent) {
	/** @type {Array<string>} */
	const results = [];
	const children = parent && parent.children || emptyChildren;
	let index = -1;
	while (++index < children.length) results[index] = this.one(children[index], index, parent);
	return results.join("");
}
//#endregion
//#region node_modules/.pnpm/@shikijs+core@3.23.0/node_modules/@shikijs/core/dist/index.mjs
function resolveColorReplacements(theme, options) {
	const replacements = typeof theme === "string" ? {} : { ...theme.colorReplacements };
	const themeName = typeof theme === "string" ? theme : theme.name;
	for (const [key, value] of Object.entries(options?.colorReplacements || {})) if (typeof value === "string") replacements[key] = value;
	else if (key === themeName) Object.assign(replacements, value);
	return replacements;
}
function applyColorReplacements(color, replacements) {
	if (!color) return color;
	return replacements?.[color?.toLowerCase()] || color;
}
function toArray(x) {
	return Array.isArray(x) ? x : [x];
}
async function normalizeGetter(p) {
	return Promise.resolve(typeof p === "function" ? p() : p).then((r) => r.default || r);
}
function isPlainLang(lang) {
	return !lang || [
		"plaintext",
		"txt",
		"text",
		"plain"
	].includes(lang);
}
function isSpecialLang(lang) {
	return lang === "ansi" || isPlainLang(lang);
}
function isNoneTheme(theme) {
	return theme === "none";
}
function isSpecialTheme(theme) {
	return isNoneTheme(theme);
}
function addClassToHast(node, className) {
	if (!className) return node;
	node.properties ||= {};
	node.properties.class ||= [];
	if (typeof node.properties.class === "string") node.properties.class = node.properties.class.split(/\s+/g);
	if (!Array.isArray(node.properties.class)) node.properties.class = [];
	const targets = Array.isArray(className) ? className : className.split(/\s+/g);
	for (const c of targets) if (c && !node.properties.class.includes(c)) node.properties.class.push(c);
	return node;
}
function splitLines$1(code, preserveEnding = false) {
	if (code.length === 0) return [["", 0]];
	const parts = code.split(/(\r?\n)/g);
	let index = 0;
	const lines = [];
	for (let i = 0; i < parts.length; i += 2) {
		const line = preserveEnding ? parts[i] + (parts[i + 1] || "") : parts[i];
		lines.push([line, index]);
		index += parts[i].length;
		index += parts[i + 1]?.length || 0;
	}
	return lines;
}
function createPositionConverter(code) {
	const lines = splitLines$1(code, true).map(([line]) => line);
	function indexToPos(index) {
		if (index === code.length) return {
			line: lines.length - 1,
			character: lines[lines.length - 1].length
		};
		let character = index;
		let line = 0;
		for (const lineText of lines) {
			if (character < lineText.length) break;
			character -= lineText.length;
			line++;
		}
		return {
			line,
			character
		};
	}
	function posToIndex(line, character) {
		let index = 0;
		for (let i = 0; i < line; i++) index += lines[i].length;
		index += character;
		return index;
	}
	return {
		lines,
		indexToPos,
		posToIndex
	};
}
function guessEmbeddedLanguages(code, _lang, highlighter) {
	const langs = /* @__PURE__ */ new Set();
	for (const match of code.matchAll(/:?lang=["']([^"']+)["']/g)) {
		const lang = match[1].toLowerCase().trim();
		if (lang) langs.add(lang);
	}
	for (const match of code.matchAll(/(?:```|~~~)([\w-]+)/g)) {
		const lang = match[1].toLowerCase().trim();
		if (lang) langs.add(lang);
	}
	for (const match of code.matchAll(/\\begin\{([\w-]+)\}/g)) {
		const lang = match[1].toLowerCase().trim();
		if (lang) langs.add(lang);
	}
	for (const match of code.matchAll(/<script\s+(?:type|lang)=["']([^"']+)["']/gi)) {
		const fullType = match[1].toLowerCase().trim();
		const lang = fullType.includes("/") ? fullType.split("/").pop() : fullType;
		if (lang) langs.add(lang);
	}
	if (!highlighter) return Array.from(langs);
	const bundle = highlighter.getBundledLanguages();
	return Array.from(langs).filter((l) => l && bundle[l]);
}
const DEFAULT_COLOR_LIGHT_DARK = "light-dark()";
const COLOR_KEYS = ["color", "background-color"];
function splitToken(token, offsets) {
	let lastOffset = 0;
	const tokens = [];
	for (const offset of offsets) {
		if (offset > lastOffset) tokens.push({
			...token,
			content: token.content.slice(lastOffset, offset),
			offset: token.offset + lastOffset
		});
		lastOffset = offset;
	}
	if (lastOffset < token.content.length) tokens.push({
		...token,
		content: token.content.slice(lastOffset),
		offset: token.offset + lastOffset
	});
	return tokens;
}
function splitTokens(tokens, breakpoints) {
	const sorted = Array.from(breakpoints instanceof Set ? breakpoints : new Set(breakpoints)).sort((a, b) => a - b);
	if (!sorted.length) return tokens;
	return tokens.map((line) => {
		return line.flatMap((token) => {
			const breakpointsInToken = sorted.filter((i) => token.offset < i && i < token.offset + token.content.length).map((i) => i - token.offset).sort((a, b) => a - b);
			if (!breakpointsInToken.length) return token;
			return splitToken(token, breakpointsInToken);
		});
	});
}
function flatTokenVariants(merged, variantsOrder, cssVariablePrefix, defaultColor, colorsRendering = "css-vars") {
	const token = {
		content: merged.content,
		explanation: merged.explanation,
		offset: merged.offset
	};
	const styles = variantsOrder.map((t) => getTokenStyleObject(merged.variants[t]));
	const styleKeys = new Set(styles.flatMap((t) => Object.keys(t)));
	const mergedStyles = {};
	const varKey = (idx, key) => {
		const keyName = key === "color" ? "" : key === "background-color" ? "-bg" : `-${key}`;
		return cssVariablePrefix + variantsOrder[idx] + (key === "color" ? "" : keyName);
	};
	styles.forEach((cur, idx) => {
		for (const key of styleKeys) {
			const value = cur[key] || "inherit";
			if (idx === 0 && defaultColor && COLOR_KEYS.includes(key)) if (defaultColor === DEFAULT_COLOR_LIGHT_DARK && styles.length > 1) {
				const lightIndex = variantsOrder.findIndex((t) => t === "light");
				const darkIndex = variantsOrder.findIndex((t) => t === "dark");
				if (lightIndex === -1 || darkIndex === -1) throw new ShikiError$2("When using `defaultColor: \"light-dark()\"`, you must provide both `light` and `dark` themes");
				mergedStyles[key] = `light-dark(${styles[lightIndex][key] || "inherit"}, ${styles[darkIndex][key] || "inherit"})`;
				if (colorsRendering === "css-vars") mergedStyles[varKey(idx, key)] = value;
			} else mergedStyles[key] = value;
			else if (colorsRendering === "css-vars") mergedStyles[varKey(idx, key)] = value;
		}
	});
	token.htmlStyle = mergedStyles;
	return token;
}
function getTokenStyleObject(token) {
	const styles = {};
	if (token.color) styles.color = token.color;
	if (token.bgColor) styles["background-color"] = token.bgColor;
	if (token.fontStyle) {
		if (token.fontStyle & FontStyle.Italic) styles["font-style"] = "italic";
		if (token.fontStyle & FontStyle.Bold) styles["font-weight"] = "bold";
		const decorations = [];
		if (token.fontStyle & FontStyle.Underline) decorations.push("underline");
		if (token.fontStyle & FontStyle.Strikethrough) decorations.push("line-through");
		if (decorations.length) styles["text-decoration"] = decorations.join(" ");
	}
	return styles;
}
function stringifyTokenStyle(token) {
	if (typeof token === "string") return token;
	return Object.entries(token).map(([key, value]) => `${key}:${value}`).join(";");
}
const _grammarStateMap = /* @__PURE__ */ new WeakMap();
function setLastGrammarStateToMap(keys, state) {
	_grammarStateMap.set(keys, state);
}
function getLastGrammarStateFromMap(keys) {
	return _grammarStateMap.get(keys);
}
var GrammarState = class GrammarState {
	/**
	* Theme to Stack mapping
	*/
	_stacks = {};
	lang;
	get themes() {
		return Object.keys(this._stacks);
	}
	get theme() {
		return this.themes[0];
	}
	get _stack() {
		return this._stacks[this.theme];
	}
	/**
	* Static method to create a initial grammar state.
	*/
	static initial(lang, themes) {
		return new GrammarState(Object.fromEntries(toArray(themes).map((theme) => [theme, INITIAL])), lang);
	}
	constructor(...args) {
		if (args.length === 2) {
			const [stacksMap, lang] = args;
			this.lang = lang;
			this._stacks = stacksMap;
		} else {
			const [stack, lang, theme] = args;
			this.lang = lang;
			this._stacks = { [theme]: stack };
		}
	}
	/**
	* Get the internal stack object.
	* @internal
	*/
	getInternalStack(theme = this.theme) {
		return this._stacks[theme];
	}
	getScopes(theme = this.theme) {
		return getScopes(this._stacks[theme]);
	}
	toJSON() {
		return {
			lang: this.lang,
			theme: this.theme,
			themes: this.themes,
			scopes: this.getScopes()
		};
	}
};
function getScopes(stack) {
	const scopes = [];
	const visited = /* @__PURE__ */ new Set();
	function pushScope(stack2) {
		if (visited.has(stack2)) return;
		visited.add(stack2);
		const name = stack2?.nameScopesList?.scopeName;
		if (name) scopes.push(name);
		if (stack2.parent) pushScope(stack2.parent);
	}
	pushScope(stack);
	return scopes;
}
function getGrammarStack(state, theme) {
	if (!(state instanceof GrammarState)) throw new ShikiError$2("Invalid grammar state");
	return state.getInternalStack(theme);
}
function transformerDecorations() {
	const map = /* @__PURE__ */ new WeakMap();
	function getContext(shiki) {
		if (!map.has(shiki.meta)) {
			let normalizePosition = function(p) {
				if (typeof p === "number") {
					if (p < 0 || p > shiki.source.length) throw new ShikiError$2(`Invalid decoration offset: ${p}. Code length: ${shiki.source.length}`);
					return {
						...converter.indexToPos(p),
						offset: p
					};
				} else {
					const line = converter.lines[p.line];
					if (line === void 0) throw new ShikiError$2(`Invalid decoration position ${JSON.stringify(p)}. Lines length: ${converter.lines.length}`);
					let character = p.character;
					if (character < 0) character = line.length + character;
					if (character < 0 || character > line.length) throw new ShikiError$2(`Invalid decoration position ${JSON.stringify(p)}. Line ${p.line} length: ${line.length}`);
					return {
						...p,
						character,
						offset: converter.posToIndex(p.line, character)
					};
				}
			};
			const converter = createPositionConverter(shiki.source);
			const decorations = (shiki.options.decorations || []).map((d) => ({
				...d,
				start: normalizePosition(d.start),
				end: normalizePosition(d.end)
			}));
			verifyIntersections(decorations);
			map.set(shiki.meta, {
				decorations,
				converter,
				source: shiki.source
			});
		}
		return map.get(shiki.meta);
	}
	return {
		name: "shiki:decorations",
		tokens(tokens) {
			if (!this.options.decorations?.length) return;
			return splitTokens(tokens, getContext(this).decorations.flatMap((d) => [d.start.offset, d.end.offset]));
		},
		code(codeEl) {
			if (!this.options.decorations?.length) return;
			const ctx = getContext(this);
			const lines = Array.from(codeEl.children).filter((i) => i.type === "element" && i.tagName === "span");
			if (lines.length !== ctx.converter.lines.length) throw new ShikiError$2(`Number of lines in code element (${lines.length}) does not match the number of lines in the source (${ctx.converter.lines.length}). Failed to apply decorations.`);
			function applyLineSection(line, start, end, decoration) {
				const lineEl = lines[line];
				let text = "";
				let startIndex = -1;
				let endIndex = -1;
				if (start === 0) startIndex = 0;
				if (end === 0) endIndex = 0;
				if (end === Number.POSITIVE_INFINITY) endIndex = lineEl.children.length;
				if (startIndex === -1 || endIndex === -1) for (let i = 0; i < lineEl.children.length; i++) {
					text += stringify(lineEl.children[i]);
					if (startIndex === -1 && text.length === start) startIndex = i + 1;
					if (endIndex === -1 && text.length === end) endIndex = i + 1;
				}
				if (startIndex === -1) throw new ShikiError$2(`Failed to find start index for decoration ${JSON.stringify(decoration.start)}`);
				if (endIndex === -1) throw new ShikiError$2(`Failed to find end index for decoration ${JSON.stringify(decoration.end)}`);
				const children = lineEl.children.slice(startIndex, endIndex);
				if (!decoration.alwaysWrap && children.length === lineEl.children.length) applyDecoration(lineEl, decoration, "line");
				else if (!decoration.alwaysWrap && children.length === 1 && children[0].type === "element") applyDecoration(children[0], decoration, "token");
				else {
					const wrapper = {
						type: "element",
						tagName: "span",
						properties: {},
						children
					};
					applyDecoration(wrapper, decoration, "wrapper");
					lineEl.children.splice(startIndex, children.length, wrapper);
				}
			}
			function applyLine(line, decoration) {
				lines[line] = applyDecoration(lines[line], decoration, "line");
			}
			function applyDecoration(el, decoration, type) {
				const properties = decoration.properties || {};
				const transform = decoration.transform || ((i) => i);
				el.tagName = decoration.tagName || "span";
				el.properties = {
					...el.properties,
					...properties,
					class: el.properties.class
				};
				if (decoration.properties?.class) addClassToHast(el, decoration.properties.class);
				el = transform(el, type) || el;
				return el;
			}
			const lineApplies = [];
			const sorted = ctx.decorations.sort((a, b) => b.start.offset - a.start.offset || a.end.offset - b.end.offset);
			for (const decoration of sorted) {
				const { start, end } = decoration;
				if (start.line === end.line) applyLineSection(start.line, start.character, end.character, decoration);
				else if (start.line < end.line) {
					applyLineSection(start.line, start.character, Number.POSITIVE_INFINITY, decoration);
					for (let i = start.line + 1; i < end.line; i++) lineApplies.unshift(() => applyLine(i, decoration));
					applyLineSection(end.line, 0, end.character, decoration);
				}
			}
			lineApplies.forEach((i) => i());
		}
	};
}
function verifyIntersections(items) {
	for (let i = 0; i < items.length; i++) {
		const foo = items[i];
		if (foo.start.offset > foo.end.offset) throw new ShikiError$2(`Invalid decoration range: ${JSON.stringify(foo.start)} - ${JSON.stringify(foo.end)}`);
		for (let j = i + 1; j < items.length; j++) {
			const bar = items[j];
			const isFooHasBarStart = foo.start.offset <= bar.start.offset && bar.start.offset < foo.end.offset;
			const isFooHasBarEnd = foo.start.offset < bar.end.offset && bar.end.offset <= foo.end.offset;
			const isBarHasFooStart = bar.start.offset <= foo.start.offset && foo.start.offset < bar.end.offset;
			const isBarHasFooEnd = bar.start.offset < foo.end.offset && foo.end.offset <= bar.end.offset;
			if (isFooHasBarStart || isFooHasBarEnd || isBarHasFooStart || isBarHasFooEnd) {
				if (isFooHasBarStart && isFooHasBarEnd) continue;
				if (isBarHasFooStart && isBarHasFooEnd) continue;
				if (isBarHasFooStart && foo.start.offset === foo.end.offset) continue;
				if (isFooHasBarEnd && bar.start.offset === bar.end.offset) continue;
				throw new ShikiError$2(`Decorations ${JSON.stringify(foo.start)} and ${JSON.stringify(bar.start)} intersect.`);
			}
		}
	}
}
function stringify(el) {
	if (el.type === "text") return el.value;
	if (el.type === "element") return el.children.map(stringify).join("");
	return "";
}
const builtInTransformers = [/* @__PURE__ */ transformerDecorations()];
function getTransformers(options) {
	const transformers = sortTransformersByEnforcement(options.transformers || []);
	return [
		...transformers.pre,
		...transformers.normal,
		...transformers.post,
		...builtInTransformers
	];
}
function sortTransformersByEnforcement(transformers) {
	const pre = [];
	const post = [];
	const normal = [];
	for (const transformer of transformers) switch (transformer.enforce) {
		case "pre":
			pre.push(transformer);
			break;
		case "post":
			post.push(transformer);
			break;
		default: normal.push(transformer);
	}
	return {
		pre,
		post,
		normal
	};
}
var namedColors = [
	"black",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"white",
	"brightBlack",
	"brightRed",
	"brightGreen",
	"brightYellow",
	"brightBlue",
	"brightMagenta",
	"brightCyan",
	"brightWhite"
];
var decorations = {
	1: "bold",
	2: "dim",
	3: "italic",
	4: "underline",
	7: "reverse",
	8: "hidden",
	9: "strikethrough"
};
function findSequence(value, position) {
	const nextEscape = value.indexOf("\x1B", position);
	if (nextEscape !== -1) {
		if (value[nextEscape + 1] === "[") {
			const nextClose = value.indexOf("m", nextEscape);
			if (nextClose !== -1) return {
				sequence: value.substring(nextEscape + 2, nextClose).split(";"),
				startPosition: nextEscape,
				position: nextClose + 1
			};
		}
	}
	return { position: value.length };
}
function parseColor(sequence) {
	const colorMode = sequence.shift();
	if (colorMode === "2") {
		const rgb = sequence.splice(0, 3).map((x) => Number.parseInt(x));
		if (rgb.length !== 3 || rgb.some((x) => Number.isNaN(x))) return;
		return {
			type: "rgb",
			rgb
		};
	} else if (colorMode === "5") {
		const index = sequence.shift();
		if (index) return {
			type: "table",
			index: Number(index)
		};
	}
}
function parseSequence(sequence) {
	const commands = [];
	while (sequence.length > 0) {
		const code = sequence.shift();
		if (!code) continue;
		const codeInt = Number.parseInt(code);
		if (Number.isNaN(codeInt)) continue;
		if (codeInt === 0) commands.push({ type: "resetAll" });
		else if (codeInt <= 9) {
			if (decorations[codeInt]) commands.push({
				type: "setDecoration",
				value: decorations[codeInt]
			});
		} else if (codeInt <= 29) {
			const decoration = decorations[codeInt - 20];
			if (decoration) {
				commands.push({
					type: "resetDecoration",
					value: decoration
				});
				if (decoration === "dim") commands.push({
					type: "resetDecoration",
					value: "bold"
				});
			}
		} else if (codeInt <= 37) commands.push({
			type: "setForegroundColor",
			value: {
				type: "named",
				name: namedColors[codeInt - 30]
			}
		});
		else if (codeInt === 38) {
			const color = parseColor(sequence);
			if (color) commands.push({
				type: "setForegroundColor",
				value: color
			});
		} else if (codeInt === 39) commands.push({ type: "resetForegroundColor" });
		else if (codeInt <= 47) commands.push({
			type: "setBackgroundColor",
			value: {
				type: "named",
				name: namedColors[codeInt - 40]
			}
		});
		else if (codeInt === 48) {
			const color = parseColor(sequence);
			if (color) commands.push({
				type: "setBackgroundColor",
				value: color
			});
		} else if (codeInt === 49) commands.push({ type: "resetBackgroundColor" });
		else if (codeInt === 53) commands.push({
			type: "setDecoration",
			value: "overline"
		});
		else if (codeInt === 55) commands.push({
			type: "resetDecoration",
			value: "overline"
		});
		else if (codeInt >= 90 && codeInt <= 97) commands.push({
			type: "setForegroundColor",
			value: {
				type: "named",
				name: namedColors[codeInt - 90 + 8]
			}
		});
		else if (codeInt >= 100 && codeInt <= 107) commands.push({
			type: "setBackgroundColor",
			value: {
				type: "named",
				name: namedColors[codeInt - 100 + 8]
			}
		});
	}
	return commands;
}
function createAnsiSequenceParser() {
	let foreground = null;
	let background = null;
	let decorations2 = /* @__PURE__ */ new Set();
	return { parse(value) {
		const tokens = [];
		let position = 0;
		do {
			const findResult = findSequence(value, position);
			const text = findResult.sequence ? value.substring(position, findResult.startPosition) : value.substring(position);
			if (text.length > 0) tokens.push({
				value: text,
				foreground,
				background,
				decorations: new Set(decorations2)
			});
			if (findResult.sequence) {
				const commands = parseSequence(findResult.sequence);
				for (const styleToken of commands) if (styleToken.type === "resetAll") {
					foreground = null;
					background = null;
					decorations2.clear();
				} else if (styleToken.type === "resetForegroundColor") foreground = null;
				else if (styleToken.type === "resetBackgroundColor") background = null;
				else if (styleToken.type === "resetDecoration") decorations2.delete(styleToken.value);
				for (const styleToken of commands) if (styleToken.type === "setForegroundColor") foreground = styleToken.value;
				else if (styleToken.type === "setBackgroundColor") background = styleToken.value;
				else if (styleToken.type === "setDecoration") decorations2.add(styleToken.value);
			}
			position = findResult.position;
		} while (position < value.length);
		return tokens;
	} };
}
var defaultNamedColorsMap = {
	black: "#000000",
	red: "#bb0000",
	green: "#00bb00",
	yellow: "#bbbb00",
	blue: "#0000bb",
	magenta: "#ff00ff",
	cyan: "#00bbbb",
	white: "#eeeeee",
	brightBlack: "#555555",
	brightRed: "#ff5555",
	brightGreen: "#00ff00",
	brightYellow: "#ffff55",
	brightBlue: "#5555ff",
	brightMagenta: "#ff55ff",
	brightCyan: "#55ffff",
	brightWhite: "#ffffff"
};
function createColorPalette(namedColorsMap = defaultNamedColorsMap) {
	function namedColor(name) {
		return namedColorsMap[name];
	}
	function rgbColor(rgb) {
		return `#${rgb.map((x) => Math.max(0, Math.min(x, 255)).toString(16).padStart(2, "0")).join("")}`;
	}
	let colorTable;
	function getColorTable() {
		if (colorTable) return colorTable;
		colorTable = [];
		for (let i = 0; i < namedColors.length; i++) colorTable.push(namedColor(namedColors[i]));
		let levels = [
			0,
			95,
			135,
			175,
			215,
			255
		];
		for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) colorTable.push(rgbColor([
			levels[r],
			levels[g],
			levels[b]
		]));
		let level = 8;
		for (let i = 0; i < 24; i++, level += 10) colorTable.push(rgbColor([
			level,
			level,
			level
		]));
		return colorTable;
	}
	function tableColor(index) {
		return getColorTable()[index];
	}
	function value(color) {
		switch (color.type) {
			case "named": return namedColor(color.name);
			case "rgb": return rgbColor(color.rgb);
			case "table": return tableColor(color.index);
		}
	}
	return { value };
}
const defaultAnsiColors = {
	black: "#000000",
	red: "#cd3131",
	green: "#0DBC79",
	yellow: "#E5E510",
	blue: "#2472C8",
	magenta: "#BC3FBC",
	cyan: "#11A8CD",
	white: "#E5E5E5",
	brightBlack: "#666666",
	brightRed: "#F14C4C",
	brightGreen: "#23D18B",
	brightYellow: "#F5F543",
	brightBlue: "#3B8EEA",
	brightMagenta: "#D670D6",
	brightCyan: "#29B8DB",
	brightWhite: "#FFFFFF"
};
function tokenizeAnsiWithTheme(theme, fileContents, options) {
	const colorReplacements = resolveColorReplacements(theme, options);
	const lines = splitLines$1(fileContents);
	const colorPalette = createColorPalette(Object.fromEntries(namedColors.map((name) => {
		const key = `terminal.ansi${name[0].toUpperCase()}${name.substring(1)}`;
		return [name, theme.colors?.[key] || defaultAnsiColors[name]];
	})));
	const parser = createAnsiSequenceParser();
	return lines.map((line) => parser.parse(line[0]).map((token) => {
		let color;
		let bgColor;
		if (token.decorations.has("reverse")) {
			color = token.background ? colorPalette.value(token.background) : theme.bg;
			bgColor = token.foreground ? colorPalette.value(token.foreground) : theme.fg;
		} else {
			color = token.foreground ? colorPalette.value(token.foreground) : theme.fg;
			bgColor = token.background ? colorPalette.value(token.background) : void 0;
		}
		color = applyColorReplacements(color, colorReplacements);
		bgColor = applyColorReplacements(bgColor, colorReplacements);
		if (token.decorations.has("dim")) color = dimColor(color);
		let fontStyle = FontStyle.None;
		if (token.decorations.has("bold")) fontStyle |= FontStyle.Bold;
		if (token.decorations.has("italic")) fontStyle |= FontStyle.Italic;
		if (token.decorations.has("underline")) fontStyle |= FontStyle.Underline;
		if (token.decorations.has("strikethrough")) fontStyle |= FontStyle.Strikethrough;
		return {
			content: token.value,
			offset: line[1],
			color,
			bgColor,
			fontStyle
		};
	}));
}
function dimColor(color) {
	const hexMatch = color.match(/#([0-9a-f]{3,8})/i);
	if (hexMatch) {
		const hex = hexMatch[1];
		if (hex.length === 8) {
			const alpha = Math.round(Number.parseInt(hex.slice(6, 8), 16) / 2).toString(16).padStart(2, "0");
			return `#${hex.slice(0, 6)}${alpha}`;
		} else if (hex.length === 6) return `#${hex}80`;
		else if (hex.length === 4) {
			const r = hex[0];
			const g = hex[1];
			const b = hex[2];
			const a = hex[3];
			return `#${r}${r}${g}${g}${b}${b}${Math.round(Number.parseInt(`${a}${a}`, 16) / 2).toString(16).padStart(2, "0")}`;
		} else if (hex.length === 3) {
			const r = hex[0];
			const g = hex[1];
			const b = hex[2];
			return `#${r}${r}${g}${g}${b}${b}80`;
		}
	}
	const cssVarMatch = color.match(/var\((--[\w-]+-ansi-[\w-]+)\)/);
	if (cssVarMatch) return `var(${cssVarMatch[1]}-dim)`;
	return color;
}
function codeToTokensBase$1(internal, code, options = {}) {
	const { theme: themeName = internal.getLoadedThemes()[0] } = options;
	const lang = internal.resolveLangAlias(options.lang || "text");
	if (isPlainLang(lang) || isNoneTheme(themeName)) return splitLines$1(code).map((line) => [{
		content: line[0],
		offset: line[1]
	}]);
	const { theme, colorMap } = internal.setTheme(themeName);
	if (lang === "ansi") return tokenizeAnsiWithTheme(theme, code, options);
	const _grammar = internal.getLanguage(options.lang || "text");
	if (options.grammarState) {
		if (options.grammarState.lang !== _grammar.name) throw new ShikiError$2(`Grammar state language "${options.grammarState.lang}" does not match highlight language "${_grammar.name}"`);
		if (!options.grammarState.themes.includes(theme.name)) throw new ShikiError$2(`Grammar state themes "${options.grammarState.themes}" do not contain highlight theme "${theme.name}"`);
	}
	return tokenizeWithTheme(code, _grammar, theme, colorMap, options);
}
function getLastGrammarState$1(...args) {
	if (args.length === 2) return getLastGrammarStateFromMap(args[1]);
	const [internal, code, options = {}] = args;
	const { lang = "text", theme: themeName = internal.getLoadedThemes()[0] } = options;
	if (isPlainLang(lang) || isNoneTheme(themeName)) throw new ShikiError$2("Plain language does not have grammar state");
	if (lang === "ansi") throw new ShikiError$2("ANSI language does not have grammar state");
	const { theme, colorMap } = internal.setTheme(themeName);
	const _grammar = internal.getLanguage(lang);
	return new GrammarState(_tokenizeWithTheme(code, _grammar, theme, colorMap, options).stateStack, _grammar.name, theme.name);
}
function tokenizeWithTheme(code, grammar, theme, colorMap, options) {
	const result = _tokenizeWithTheme(code, grammar, theme, colorMap, options);
	const grammarState = new GrammarState(result.stateStack, grammar.name, theme.name);
	setLastGrammarStateToMap(result.tokens, grammarState);
	return result.tokens;
}
function _tokenizeWithTheme(code, grammar, theme, colorMap, options) {
	const colorReplacements = resolveColorReplacements(theme, options);
	const { tokenizeMaxLineLength = 0, tokenizeTimeLimit = 500 } = options;
	const lines = splitLines$1(code);
	let stateStack = options.grammarState ? getGrammarStack(options.grammarState, theme.name) ?? INITIAL : options.grammarContextCode != null ? _tokenizeWithTheme(options.grammarContextCode, grammar, theme, colorMap, {
		...options,
		grammarState: void 0,
		grammarContextCode: void 0
	}).stateStack : INITIAL;
	let actual = [];
	const final = [];
	for (let i = 0, len = lines.length; i < len; i++) {
		const [line, lineOffset] = lines[i];
		if (line === "") {
			actual = [];
			final.push([]);
			continue;
		}
		if (tokenizeMaxLineLength > 0 && line.length >= tokenizeMaxLineLength) {
			actual = [];
			final.push([{
				content: line,
				offset: lineOffset,
				color: "",
				fontStyle: 0
			}]);
			continue;
		}
		let resultWithScopes;
		let tokensWithScopes;
		let tokensWithScopesIndex;
		if (options.includeExplanation) {
			resultWithScopes = grammar.tokenizeLine(line, stateStack, tokenizeTimeLimit);
			tokensWithScopes = resultWithScopes.tokens;
			tokensWithScopesIndex = 0;
		}
		const result = grammar.tokenizeLine2(line, stateStack, tokenizeTimeLimit);
		const tokensLength = result.tokens.length / 2;
		for (let j = 0; j < tokensLength; j++) {
			const startIndex = result.tokens[2 * j];
			const nextStartIndex = j + 1 < tokensLength ? result.tokens[2 * j + 2] : line.length;
			if (startIndex === nextStartIndex) continue;
			const metadata = result.tokens[2 * j + 1];
			const color = applyColorReplacements(colorMap[EncodedTokenMetadata.getForeground(metadata)], colorReplacements);
			const fontStyle = EncodedTokenMetadata.getFontStyle(metadata);
			const token = {
				content: line.substring(startIndex, nextStartIndex),
				offset: lineOffset + startIndex,
				color,
				fontStyle
			};
			if (options.includeExplanation) {
				const themeSettingsSelectors = [];
				if (options.includeExplanation !== "scopeName") for (const setting of theme.settings) {
					let selectors;
					switch (typeof setting.scope) {
						case "string":
							selectors = setting.scope.split(/,/).map((scope) => scope.trim());
							break;
						case "object":
							selectors = setting.scope;
							break;
						default: continue;
					}
					themeSettingsSelectors.push({
						settings: setting,
						selectors: selectors.map((selector) => selector.split(/ /))
					});
				}
				token.explanation = [];
				let offset = 0;
				while (startIndex + offset < nextStartIndex) {
					const tokenWithScopes = tokensWithScopes[tokensWithScopesIndex];
					const tokenWithScopesText = line.substring(tokenWithScopes.startIndex, tokenWithScopes.endIndex);
					offset += tokenWithScopesText.length;
					token.explanation.push({
						content: tokenWithScopesText,
						scopes: options.includeExplanation === "scopeName" ? explainThemeScopesNameOnly(tokenWithScopes.scopes) : explainThemeScopesFull(themeSettingsSelectors, tokenWithScopes.scopes)
					});
					tokensWithScopesIndex += 1;
				}
			}
			actual.push(token);
		}
		final.push(actual);
		actual = [];
		stateStack = result.ruleStack;
	}
	return {
		tokens: final,
		stateStack
	};
}
function explainThemeScopesNameOnly(scopes) {
	return scopes.map((scope) => ({ scopeName: scope }));
}
function explainThemeScopesFull(themeSelectors, scopes) {
	const result = [];
	for (let i = 0, len = scopes.length; i < len; i++) {
		const scope = scopes[i];
		result[i] = {
			scopeName: scope,
			themeMatches: explainThemeScope(themeSelectors, scope, scopes.slice(0, i))
		};
	}
	return result;
}
function matchesOne(selector, scope) {
	return selector === scope || scope.substring(0, selector.length) === selector && scope[selector.length] === ".";
}
function matches(selectors, scope, parentScopes) {
	if (!matchesOne(selectors[selectors.length - 1], scope)) return false;
	let selectorParentIndex = selectors.length - 2;
	let parentIndex = parentScopes.length - 1;
	while (selectorParentIndex >= 0 && parentIndex >= 0) {
		if (matchesOne(selectors[selectorParentIndex], parentScopes[parentIndex])) selectorParentIndex -= 1;
		parentIndex -= 1;
	}
	if (selectorParentIndex === -1) return true;
	return false;
}
function explainThemeScope(themeSettingsSelectors, scope, parentScopes) {
	const result = [];
	for (const { selectors, settings } of themeSettingsSelectors) for (const selectorPieces of selectors) if (matches(selectorPieces, scope, parentScopes)) {
		result.push(settings);
		break;
	}
	return result;
}
function codeToTokensWithThemes$1(internal, code, options) {
	const themes = Object.entries(options.themes).filter((i) => i[1]).map((i) => ({
		color: i[0],
		theme: i[1]
	}));
	const themedTokens = themes.map((t) => {
		const tokens2 = codeToTokensBase$1(internal, code, {
			...options,
			theme: t.theme
		});
		return {
			tokens: tokens2,
			state: getLastGrammarStateFromMap(tokens2),
			theme: typeof t.theme === "string" ? t.theme : t.theme.name
		};
	});
	const tokens = syncThemesTokenization(...themedTokens.map((i) => i.tokens));
	const mergedTokens = tokens[0].map((line, lineIdx) => line.map((_token, tokenIdx) => {
		const mergedToken = {
			content: _token.content,
			variants: {},
			offset: _token.offset
		};
		if ("includeExplanation" in options && options.includeExplanation) mergedToken.explanation = _token.explanation;
		tokens.forEach((t, themeIdx) => {
			const { content: _, explanation: __, offset: ___, ...styles } = t[lineIdx][tokenIdx];
			mergedToken.variants[themes[themeIdx].color] = styles;
		});
		return mergedToken;
	}));
	const mergedGrammarState = themedTokens[0].state ? new GrammarState(Object.fromEntries(themedTokens.map((s) => [s.theme, s.state?.getInternalStack(s.theme)])), themedTokens[0].state.lang) : void 0;
	if (mergedGrammarState) setLastGrammarStateToMap(mergedTokens, mergedGrammarState);
	return mergedTokens;
}
function syncThemesTokenization(...themes) {
	const outThemes = themes.map(() => []);
	const count = themes.length;
	for (let i = 0; i < themes[0].length; i++) {
		const lines = themes.map((t) => t[i]);
		const outLines = outThemes.map(() => []);
		outThemes.forEach((t, i2) => t.push(outLines[i2]));
		const indexes = lines.map(() => 0);
		const current = lines.map((l) => l[0]);
		while (current.every((t) => t)) {
			const minLength = Math.min(...current.map((t) => t.content.length));
			for (let n = 0; n < count; n++) {
				const token = current[n];
				if (token.content.length === minLength) {
					outLines[n].push(token);
					indexes[n] += 1;
					current[n] = lines[n][indexes[n]];
				} else {
					outLines[n].push({
						...token,
						content: token.content.slice(0, minLength)
					});
					current[n] = {
						...token,
						content: token.content.slice(minLength),
						offset: token.offset + minLength
					};
				}
			}
		}
	}
	return outThemes;
}
function codeToTokens$1(internal, code, options) {
	let bg;
	let fg;
	let tokens;
	let themeName;
	let rootStyle;
	let grammarState;
	if ("themes" in options) {
		const { defaultColor = "light", cssVariablePrefix = "--shiki-", colorsRendering = "css-vars" } = options;
		const themes = Object.entries(options.themes).filter((i) => i[1]).map((i) => ({
			color: i[0],
			theme: i[1]
		})).sort((a, b) => a.color === defaultColor ? -1 : b.color === defaultColor ? 1 : 0);
		if (themes.length === 0) throw new ShikiError$2("`themes` option must not be empty");
		const themeTokens = codeToTokensWithThemes$1(internal, code, options);
		grammarState = getLastGrammarStateFromMap(themeTokens);
		if (defaultColor && DEFAULT_COLOR_LIGHT_DARK !== defaultColor && !themes.find((t) => t.color === defaultColor)) throw new ShikiError$2(`\`themes\` option must contain the defaultColor key \`${defaultColor}\``);
		const themeRegs = themes.map((t) => internal.getTheme(t.theme));
		const themesOrder = themes.map((t) => t.color);
		tokens = themeTokens.map((line) => line.map((token) => flatTokenVariants(token, themesOrder, cssVariablePrefix, defaultColor, colorsRendering)));
		if (grammarState) setLastGrammarStateToMap(tokens, grammarState);
		const themeColorReplacements = themes.map((t) => resolveColorReplacements(t.theme, options));
		fg = mapThemeColors(themes, themeRegs, themeColorReplacements, cssVariablePrefix, defaultColor, "fg", colorsRendering);
		bg = mapThemeColors(themes, themeRegs, themeColorReplacements, cssVariablePrefix, defaultColor, "bg", colorsRendering);
		themeName = `shiki-themes ${themeRegs.map((t) => t.name).join(" ")}`;
		rootStyle = defaultColor ? void 0 : [fg, bg].join(";");
	} else if ("theme" in options) {
		const colorReplacements = resolveColorReplacements(options.theme, options);
		tokens = codeToTokensBase$1(internal, code, options);
		const _theme = internal.getTheme(options.theme);
		bg = applyColorReplacements(_theme.bg, colorReplacements);
		fg = applyColorReplacements(_theme.fg, colorReplacements);
		themeName = _theme.name;
		grammarState = getLastGrammarStateFromMap(tokens);
	} else throw new ShikiError$2("Invalid options, either `theme` or `themes` must be provided");
	return {
		tokens,
		fg,
		bg,
		themeName,
		rootStyle,
		grammarState
	};
}
function mapThemeColors(themes, themeRegs, themeColorReplacements, cssVariablePrefix, defaultColor, property, colorsRendering) {
	return themes.map((t, idx) => {
		const value = applyColorReplacements(themeRegs[idx][property], themeColorReplacements[idx]) || "inherit";
		const cssVar = `${cssVariablePrefix + t.color}${property === "bg" ? "-bg" : ""}:${value}`;
		if (idx === 0 && defaultColor) {
			if (defaultColor === DEFAULT_COLOR_LIGHT_DARK && themes.length > 1) {
				const lightIndex = themes.findIndex((t2) => t2.color === "light");
				const darkIndex = themes.findIndex((t2) => t2.color === "dark");
				if (lightIndex === -1 || darkIndex === -1) throw new ShikiError$2("When using `defaultColor: \"light-dark()\"`, you must provide both `light` and `dark` themes");
				return `light-dark(${applyColorReplacements(themeRegs[lightIndex][property], themeColorReplacements[lightIndex]) || "inherit"}, ${applyColorReplacements(themeRegs[darkIndex][property], themeColorReplacements[darkIndex]) || "inherit"});${cssVar}`;
			}
			return value;
		}
		if (colorsRendering === "css-vars") return cssVar;
		return null;
	}).filter((i) => !!i).join(";");
}
function codeToHast$1(internal, code, options, transformerContext = {
	meta: {},
	options,
	codeToHast: (_code, _options) => codeToHast$1(internal, _code, _options),
	codeToTokens: (_code, _options) => codeToTokens$1(internal, _code, _options)
}) {
	let input = code;
	for (const transformer of getTransformers(options)) input = transformer.preprocess?.call(transformerContext, input, options) || input;
	let { tokens, fg, bg, themeName, rootStyle, grammarState } = codeToTokens$1(internal, input, options);
	const { mergeWhitespaces = true, mergeSameStyleTokens = false } = options;
	if (mergeWhitespaces === true) tokens = mergeWhitespaceTokens(tokens);
	else if (mergeWhitespaces === "never") tokens = splitWhitespaceTokens(tokens);
	if (mergeSameStyleTokens) tokens = mergeAdjacentStyledTokens(tokens);
	const contextSource = {
		...transformerContext,
		get source() {
			return input;
		}
	};
	for (const transformer of getTransformers(options)) tokens = transformer.tokens?.call(contextSource, tokens) || tokens;
	return tokensToHast(tokens, {
		...options,
		fg,
		bg,
		themeName,
		rootStyle: options.rootStyle === false ? false : options.rootStyle ?? rootStyle
	}, contextSource, grammarState);
}
function tokensToHast(tokens, options, transformerContext, grammarState = getLastGrammarStateFromMap(tokens)) {
	const transformers = getTransformers(options);
	const lines = [];
	const root = {
		type: "root",
		children: []
	};
	const { structure = "classic", tabindex = "0" } = options;
	const properties = { class: `shiki ${options.themeName || ""}` };
	if (options.rootStyle !== false) if (options.rootStyle != null) properties.style = options.rootStyle;
	else properties.style = `background-color:${options.bg};color:${options.fg}`;
	if (tabindex !== false && tabindex != null) properties.tabindex = tabindex.toString();
	for (const [key, value] of Object.entries(options.meta || {})) if (!key.startsWith("_")) properties[key] = value;
	let preNode = {
		type: "element",
		tagName: "pre",
		properties,
		children: [],
		data: options.data
	};
	let codeNode = {
		type: "element",
		tagName: "code",
		properties: {},
		children: lines
	};
	const lineNodes = [];
	const context = {
		...transformerContext,
		structure,
		addClassToHast,
		get source() {
			return transformerContext.source;
		},
		get tokens() {
			return tokens;
		},
		get options() {
			return options;
		},
		get root() {
			return root;
		},
		get pre() {
			return preNode;
		},
		get code() {
			return codeNode;
		},
		get lines() {
			return lineNodes;
		}
	};
	tokens.forEach((line, idx) => {
		if (idx) {
			if (structure === "inline") root.children.push({
				type: "element",
				tagName: "br",
				properties: {},
				children: []
			});
			else if (structure === "classic") lines.push({
				type: "text",
				value: "\n"
			});
		}
		let lineNode = {
			type: "element",
			tagName: "span",
			properties: { class: "line" },
			children: []
		};
		let col = 0;
		for (const token of line) {
			let tokenNode = {
				type: "element",
				tagName: "span",
				properties: { ...token.htmlAttrs },
				children: [{
					type: "text",
					value: token.content
				}]
			};
			const style = stringifyTokenStyle(token.htmlStyle || getTokenStyleObject(token));
			if (style) tokenNode.properties.style = style;
			for (const transformer of transformers) tokenNode = transformer?.span?.call(context, tokenNode, idx + 1, col, lineNode, token) || tokenNode;
			if (structure === "inline") root.children.push(tokenNode);
			else if (structure === "classic") lineNode.children.push(tokenNode);
			col += token.content.length;
		}
		if (structure === "classic") {
			for (const transformer of transformers) lineNode = transformer?.line?.call(context, lineNode, idx + 1) || lineNode;
			lineNodes.push(lineNode);
			lines.push(lineNode);
		} else if (structure === "inline") lineNodes.push(lineNode);
	});
	if (structure === "classic") {
		for (const transformer of transformers) codeNode = transformer?.code?.call(context, codeNode) || codeNode;
		preNode.children.push(codeNode);
		for (const transformer of transformers) preNode = transformer?.pre?.call(context, preNode) || preNode;
		root.children.push(preNode);
	} else if (structure === "inline") {
		const syntheticLines = [];
		let currentLine = {
			type: "element",
			tagName: "span",
			properties: { class: "line" },
			children: []
		};
		for (const child of root.children) if (child.type === "element" && child.tagName === "br") {
			syntheticLines.push(currentLine);
			currentLine = {
				type: "element",
				tagName: "span",
				properties: { class: "line" },
				children: []
			};
		} else if (child.type === "element" || child.type === "text") currentLine.children.push(child);
		syntheticLines.push(currentLine);
		let transformedCode = {
			type: "element",
			tagName: "code",
			properties: {},
			children: syntheticLines
		};
		for (const transformer of transformers) transformedCode = transformer?.code?.call(context, transformedCode) || transformedCode;
		root.children = [];
		for (let i = 0; i < transformedCode.children.length; i++) {
			if (i > 0) root.children.push({
				type: "element",
				tagName: "br",
				properties: {},
				children: []
			});
			const line = transformedCode.children[i];
			if (line.type === "element") root.children.push(...line.children);
		}
	}
	let result = root;
	for (const transformer of transformers) result = transformer?.root?.call(context, result) || result;
	if (grammarState) setLastGrammarStateToMap(result, grammarState);
	return result;
}
function mergeWhitespaceTokens(tokens) {
	return tokens.map((line) => {
		const newLine = [];
		let carryOnContent = "";
		let firstOffset;
		line.forEach((token, idx) => {
			const couldMerge = !(token.fontStyle && (token.fontStyle & FontStyle.Underline || token.fontStyle & FontStyle.Strikethrough));
			if (couldMerge && token.content.match(/^\s+$/) && line[idx + 1]) {
				if (firstOffset === void 0) firstOffset = token.offset;
				carryOnContent += token.content;
			} else if (carryOnContent) {
				if (couldMerge) newLine.push({
					...token,
					offset: firstOffset,
					content: carryOnContent + token.content
				});
				else newLine.push({
					content: carryOnContent,
					offset: firstOffset
				}, token);
				firstOffset = void 0;
				carryOnContent = "";
			} else newLine.push(token);
		});
		return newLine;
	});
}
function splitWhitespaceTokens(tokens) {
	return tokens.map((line) => {
		return line.flatMap((token) => {
			if (token.content.match(/^\s+$/)) return token;
			const match = token.content.match(/^(\s*)(.*?)(\s*)$/);
			if (!match) return token;
			const [, leading, content, trailing] = match;
			if (!leading && !trailing) return token;
			const expanded = [{
				...token,
				offset: token.offset + leading.length,
				content
			}];
			if (leading) expanded.unshift({
				content: leading,
				offset: token.offset
			});
			if (trailing) expanded.push({
				content: trailing,
				offset: token.offset + leading.length + content.length
			});
			return expanded;
		});
	});
}
function mergeAdjacentStyledTokens(tokens) {
	return tokens.map((line) => {
		const newLine = [];
		for (const token of line) {
			if (newLine.length === 0) {
				newLine.push({ ...token });
				continue;
			}
			const prevToken = newLine[newLine.length - 1];
			const prevStyle = stringifyTokenStyle(prevToken.htmlStyle || getTokenStyleObject(prevToken));
			const currentStyle = stringifyTokenStyle(token.htmlStyle || getTokenStyleObject(token));
			const isPrevDecorated = prevToken.fontStyle && (prevToken.fontStyle & FontStyle.Underline || prevToken.fontStyle & FontStyle.Strikethrough);
			const isDecorated = token.fontStyle && (token.fontStyle & FontStyle.Underline || token.fontStyle & FontStyle.Strikethrough);
			if (!isPrevDecorated && !isDecorated && prevStyle === currentStyle) prevToken.content += token.content;
			else newLine.push({ ...token });
		}
		return newLine;
	});
}
const hastToHtml = toHtml;
function codeToHtml$1(internal, code, options) {
	const context = {
		meta: {},
		options,
		codeToHast: (_code, _options) => codeToHast$1(internal, _code, _options),
		codeToTokens: (_code, _options) => codeToTokens$1(internal, _code, _options)
	};
	let result = hastToHtml(codeToHast$1(internal, code, options, context));
	for (const transformer of getTransformers(options)) result = transformer.postprocess?.call(context, result, options) || result;
	return result;
}
const VSCODE_FALLBACK_EDITOR_FG = {
	light: "#333333",
	dark: "#bbbbbb"
};
const VSCODE_FALLBACK_EDITOR_BG = {
	light: "#fffffe",
	dark: "#1e1e1e"
};
const RESOLVED_KEY = "__shiki_resolved";
function normalizeTheme$1(rawTheme) {
	if (rawTheme?.[RESOLVED_KEY]) return rawTheme;
	const theme = { ...rawTheme };
	if (theme.tokenColors && !theme.settings) {
		theme.settings = theme.tokenColors;
		delete theme.tokenColors;
	}
	theme.type ||= "dark";
	theme.colorReplacements = { ...theme.colorReplacements };
	theme.settings ||= [];
	let { bg, fg } = theme;
	if (!bg || !fg) {
		const globalSetting = theme.settings ? theme.settings.find((s) => !s.name && !s.scope) : void 0;
		if (globalSetting?.settings?.foreground) fg = globalSetting.settings.foreground;
		if (globalSetting?.settings?.background) bg = globalSetting.settings.background;
		if (!fg && theme?.colors?.["editor.foreground"]) fg = theme.colors["editor.foreground"];
		if (!bg && theme?.colors?.["editor.background"]) bg = theme.colors["editor.background"];
		if (!fg) fg = theme.type === "light" ? VSCODE_FALLBACK_EDITOR_FG.light : VSCODE_FALLBACK_EDITOR_FG.dark;
		if (!bg) bg = theme.type === "light" ? VSCODE_FALLBACK_EDITOR_BG.light : VSCODE_FALLBACK_EDITOR_BG.dark;
		theme.fg = fg;
		theme.bg = bg;
	}
	if (!(theme.settings[0] && theme.settings[0].settings && !theme.settings[0].scope)) theme.settings.unshift({ settings: {
		foreground: theme.fg,
		background: theme.bg
	} });
	let replacementCount = 0;
	const replacementMap = /* @__PURE__ */ new Map();
	function getReplacementColor(value) {
		if (replacementMap.has(value)) return replacementMap.get(value);
		replacementCount += 1;
		const hex = `#${replacementCount.toString(16).padStart(8, "0").toLowerCase()}`;
		if (theme.colorReplacements?.[`#${hex}`]) return getReplacementColor(value);
		replacementMap.set(value, hex);
		return hex;
	}
	theme.settings = theme.settings.map((setting) => {
		const replaceFg = setting.settings?.foreground && !setting.settings.foreground.startsWith("#");
		const replaceBg = setting.settings?.background && !setting.settings.background.startsWith("#");
		if (!replaceFg && !replaceBg) return setting;
		const clone = {
			...setting,
			settings: { ...setting.settings }
		};
		if (replaceFg) {
			const replacement = getReplacementColor(setting.settings.foreground);
			theme.colorReplacements[replacement] = setting.settings.foreground;
			clone.settings.foreground = replacement;
		}
		if (replaceBg) {
			const replacement = getReplacementColor(setting.settings.background);
			theme.colorReplacements[replacement] = setting.settings.background;
			clone.settings.background = replacement;
		}
		return clone;
	});
	for (const key of Object.keys(theme.colors || {})) if (key === "editor.foreground" || key === "editor.background" || key.startsWith("terminal.ansi")) {
		if (!theme.colors[key]?.startsWith("#")) {
			const replacement = getReplacementColor(theme.colors[key]);
			theme.colorReplacements[replacement] = theme.colors[key];
			theme.colors[key] = replacement;
		}
	}
	Object.defineProperty(theme, RESOLVED_KEY, {
		enumerable: false,
		writable: false,
		value: true
	});
	return theme;
}
async function resolveLangs(langs) {
	return Array.from(new Set((await Promise.all(langs.filter((l) => !isSpecialLang(l)).map(async (lang) => await normalizeGetter(lang).then((r) => Array.isArray(r) ? r : [r])))).flat()));
}
async function resolveThemes(themes) {
	return (await Promise.all(themes.map(async (theme) => isSpecialTheme(theme) ? null : normalizeTheme$1(await normalizeGetter(theme))))).filter((i) => !!i);
}
let _emitDeprecation = 3;
function warnDeprecated(message, version = 3) {
	if (typeof _emitDeprecation === "number" && version > _emitDeprecation) return;
	console.trace(`[SHIKI DEPRECATE]: ${message}`);
}
var ShikiError$1 = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ShikiError";
	}
};
function resolveLangAlias(name, alias) {
	if (!alias) return name;
	if (alias[name]) {
		const resolved = /* @__PURE__ */ new Set([name]);
		while (alias[name]) {
			name = alias[name];
			if (resolved.has(name)) throw new ShikiError$1(`Circular alias \`${Array.from(resolved).join(" -> ")} -> ${name}\``);
			resolved.add(name);
		}
	}
	return name;
}
var Registry = class extends Registry$1 {
	constructor(_resolver, _themes, _langs, _alias = {}) {
		super(_resolver);
		this._resolver = _resolver;
		this._themes = _themes;
		this._langs = _langs;
		this._alias = _alias;
		this._themes.map((t) => this.loadTheme(t));
		this.loadLanguages(this._langs);
	}
	_resolvedThemes = /* @__PURE__ */ new Map();
	_resolvedGrammars = /* @__PURE__ */ new Map();
	_langMap = /* @__PURE__ */ new Map();
	_langGraph = /* @__PURE__ */ new Map();
	_textmateThemeCache = /* @__PURE__ */ new WeakMap();
	_loadedThemesCache = null;
	_loadedLanguagesCache = null;
	getTheme(theme) {
		if (typeof theme === "string") return this._resolvedThemes.get(theme);
		else return this.loadTheme(theme);
	}
	loadTheme(theme) {
		const _theme = normalizeTheme$1(theme);
		if (_theme.name) {
			this._resolvedThemes.set(_theme.name, _theme);
			this._loadedThemesCache = null;
		}
		return _theme;
	}
	getLoadedThemes() {
		if (!this._loadedThemesCache) this._loadedThemesCache = [...this._resolvedThemes.keys()];
		return this._loadedThemesCache;
	}
	setTheme(theme) {
		let textmateTheme = this._textmateThemeCache.get(theme);
		if (!textmateTheme) {
			textmateTheme = Theme.createFromRawTheme(theme);
			this._textmateThemeCache.set(theme, textmateTheme);
		}
		this._syncRegistry.setTheme(textmateTheme);
	}
	getGrammar(name) {
		name = resolveLangAlias(name, this._alias);
		return this._resolvedGrammars.get(name);
	}
	loadLanguage(lang) {
		if (this.getGrammar(lang.name)) return;
		const embeddedLazilyBy = new Set([...this._langMap.values()].filter((i) => i.embeddedLangsLazy?.includes(lang.name)));
		this._resolver.addLanguage(lang);
		const grammarConfig = {
			balancedBracketSelectors: lang.balancedBracketSelectors || ["*"],
			unbalancedBracketSelectors: lang.unbalancedBracketSelectors || []
		};
		this._syncRegistry._rawGrammars.set(lang.scopeName, lang);
		const g = this.loadGrammarWithConfiguration(lang.scopeName, 1, grammarConfig);
		g.name = lang.name;
		this._resolvedGrammars.set(lang.name, g);
		if (lang.aliases) lang.aliases.forEach((alias) => {
			this._alias[alias] = lang.name;
		});
		this._loadedLanguagesCache = null;
		if (embeddedLazilyBy.size) for (const e of embeddedLazilyBy) {
			this._resolvedGrammars.delete(e.name);
			this._loadedLanguagesCache = null;
			this._syncRegistry?._injectionGrammars?.delete(e.scopeName);
			this._syncRegistry?._grammars?.delete(e.scopeName);
			this.loadLanguage(this._langMap.get(e.name));
		}
	}
	dispose() {
		super.dispose();
		this._resolvedThemes.clear();
		this._resolvedGrammars.clear();
		this._langMap.clear();
		this._langGraph.clear();
		this._loadedThemesCache = null;
	}
	loadLanguages(langs) {
		for (const lang of langs) this.resolveEmbeddedLanguages(lang);
		const langsGraphArray = Array.from(this._langGraph.entries());
		const missingLangs = langsGraphArray.filter(([_, lang]) => !lang);
		if (missingLangs.length) {
			const dependents = langsGraphArray.filter(([_, lang]) => {
				if (!lang) return false;
				return (lang.embeddedLanguages || lang.embeddedLangs)?.some((l) => missingLangs.map(([name]) => name).includes(l));
			}).filter((lang) => !missingLangs.includes(lang));
			throw new ShikiError$1(`Missing languages ${missingLangs.map(([name]) => `\`${name}\``).join(", ")}, required by ${dependents.map(([name]) => `\`${name}\``).join(", ")}`);
		}
		for (const [_, lang] of langsGraphArray) this._resolver.addLanguage(lang);
		for (const [_, lang] of langsGraphArray) this.loadLanguage(lang);
	}
	getLoadedLanguages() {
		if (!this._loadedLanguagesCache) this._loadedLanguagesCache = [.../* @__PURE__ */ new Set([...this._resolvedGrammars.keys(), ...Object.keys(this._alias)])];
		return this._loadedLanguagesCache;
	}
	resolveEmbeddedLanguages(lang) {
		this._langMap.set(lang.name, lang);
		this._langGraph.set(lang.name, lang);
		const embedded = lang.embeddedLanguages ?? lang.embeddedLangs;
		if (embedded) for (const embeddedLang of embedded) this._langGraph.set(embeddedLang, this._langMap.get(embeddedLang));
	}
};
var Resolver = class {
	_langs = /* @__PURE__ */ new Map();
	_scopeToLang = /* @__PURE__ */ new Map();
	_injections = /* @__PURE__ */ new Map();
	_onigLib;
	constructor(engine, langs) {
		this._onigLib = {
			createOnigScanner: (patterns) => engine.createScanner(patterns),
			createOnigString: (s) => engine.createString(s)
		};
		langs.forEach((i) => this.addLanguage(i));
	}
	get onigLib() {
		return this._onigLib;
	}
	getLangRegistration(langIdOrAlias) {
		return this._langs.get(langIdOrAlias);
	}
	loadGrammar(scopeName) {
		return this._scopeToLang.get(scopeName);
	}
	addLanguage(l) {
		this._langs.set(l.name, l);
		if (l.aliases) l.aliases.forEach((a) => {
			this._langs.set(a, l);
		});
		this._scopeToLang.set(l.scopeName, l);
		if (l.injectTo) l.injectTo.forEach((i) => {
			if (!this._injections.get(i)) this._injections.set(i, []);
			this._injections.get(i).push(l.scopeName);
		});
	}
	getInjections(scopeName) {
		const scopeParts = scopeName.split(".");
		let injections = [];
		for (let i = 1; i <= scopeParts.length; i++) {
			const subScopeName = scopeParts.slice(0, i).join(".");
			injections = [...injections, ...this._injections.get(subScopeName) || []];
		}
		return injections;
	}
};
let instancesCount = 0;
function createShikiInternalSync(options) {
	instancesCount += 1;
	if (options.warnings !== false && instancesCount >= 10 && instancesCount % 10 === 0) console.warn(`[Shiki] ${instancesCount} instances have been created. Shiki is supposed to be used as a singleton, consider refactoring your code to cache your highlighter instance; Or call \`highlighter.dispose()\` to release unused instances.`);
	let isDisposed = false;
	if (!options.engine) throw new ShikiError$1("`engine` option is required for synchronous mode");
	const langs = (options.langs || []).flat(1);
	const themes = (options.themes || []).flat(1).map(normalizeTheme$1);
	const _registry = new Registry(new Resolver(options.engine, langs), themes, langs, options.langAlias);
	let _lastTheme;
	function resolveLangAlias$1(name) {
		return resolveLangAlias(name, options.langAlias);
	}
	function getLanguage(name) {
		ensureNotDisposed();
		const _lang = _registry.getGrammar(typeof name === "string" ? name : name.name);
		if (!_lang) throw new ShikiError$1(`Language \`${name}\` not found, you may need to load it first`);
		return _lang;
	}
	function getTheme(name) {
		if (name === "none") return {
			bg: "",
			fg: "",
			name: "none",
			settings: [],
			type: "dark"
		};
		ensureNotDisposed();
		const _theme = _registry.getTheme(name);
		if (!_theme) throw new ShikiError$1(`Theme \`${name}\` not found, you may need to load it first`);
		return _theme;
	}
	function setTheme(name) {
		ensureNotDisposed();
		const theme = getTheme(name);
		if (_lastTheme !== name) {
			_registry.setTheme(theme);
			_lastTheme = name;
		}
		return {
			theme,
			colorMap: _registry.getColorMap()
		};
	}
	function getLoadedThemes() {
		ensureNotDisposed();
		return _registry.getLoadedThemes();
	}
	function getLoadedLanguages() {
		ensureNotDisposed();
		return _registry.getLoadedLanguages();
	}
	function loadLanguageSync(...langs2) {
		ensureNotDisposed();
		_registry.loadLanguages(langs2.flat(1));
	}
	async function loadLanguage(...langs2) {
		return loadLanguageSync(await resolveLangs(langs2));
	}
	function loadThemeSync(...themes2) {
		ensureNotDisposed();
		for (const theme of themes2.flat(1)) _registry.loadTheme(theme);
	}
	async function loadTheme(...themes2) {
		ensureNotDisposed();
		return loadThemeSync(await resolveThemes(themes2));
	}
	function ensureNotDisposed() {
		if (isDisposed) throw new ShikiError$1("Shiki instance has been disposed");
	}
	function dispose() {
		if (isDisposed) return;
		isDisposed = true;
		_registry.dispose();
		instancesCount -= 1;
	}
	return {
		setTheme,
		getTheme,
		getLanguage,
		getLoadedThemes,
		getLoadedLanguages,
		resolveLangAlias: resolveLangAlias$1,
		loadLanguage,
		loadLanguageSync,
		loadTheme,
		loadThemeSync,
		dispose,
		[Symbol.dispose]: dispose
	};
}
async function createShikiInternal(options) {
	if (!options.engine) warnDeprecated("`engine` option is required. Use `createOnigurumaEngine` or `createJavaScriptRegexEngine` to create an engine.");
	const [themes, langs, engine] = await Promise.all([
		resolveThemes(options.themes || []),
		resolveLangs(options.langs || []),
		options.engine
	]);
	return createShikiInternalSync({
		...options,
		themes,
		langs,
		engine
	});
}
async function createHighlighterCore(options) {
	const internal = await createShikiInternal(options);
	return {
		getLastGrammarState: (...args) => getLastGrammarState$1(internal, ...args),
		codeToTokensBase: (code, options2) => codeToTokensBase$1(internal, code, options2),
		codeToTokensWithThemes: (code, options2) => codeToTokensWithThemes$1(internal, code, options2),
		codeToTokens: (code, options2) => codeToTokens$1(internal, code, options2),
		codeToHast: (code, options2) => codeToHast$1(internal, code, options2),
		codeToHtml: (code, options2) => codeToHtml$1(internal, code, options2),
		getBundledLanguages: () => ({}),
		getBundledThemes: () => ({}),
		...internal,
		getInternalContext: () => internal
	};
}
function createBundledHighlighter(options) {
	const bundledLanguages = options.langs;
	const bundledThemes = options.themes;
	const engine = options.engine;
	async function createHighlighter(options2) {
		function resolveLang(lang) {
			if (typeof lang === "string") {
				lang = options2.langAlias?.[lang] || lang;
				if (isSpecialLang(lang)) return [];
				const bundle = bundledLanguages[lang];
				if (!bundle) throw new ShikiError$2(`Language \`${lang}\` is not included in this bundle. You may want to load it from external source.`);
				return bundle;
			}
			return lang;
		}
		function resolveTheme(theme) {
			if (isSpecialTheme(theme)) return "none";
			if (typeof theme === "string") {
				const bundle = bundledThemes[theme];
				if (!bundle) throw new ShikiError$2(`Theme \`${theme}\` is not included in this bundle. You may want to load it from external source.`);
				return bundle;
			}
			return theme;
		}
		const _themes = (options2.themes ?? []).map((i) => resolveTheme(i));
		const langs = (options2.langs ?? []).map((i) => resolveLang(i));
		const core = await createHighlighterCore({
			engine: options2.engine ?? engine(),
			...options2,
			themes: _themes,
			langs
		});
		return {
			...core,
			loadLanguage(...langs2) {
				return core.loadLanguage(...langs2.map(resolveLang));
			},
			loadTheme(...themes) {
				return core.loadTheme(...themes.map(resolveTheme));
			},
			getBundledLanguages() {
				return bundledLanguages;
			},
			getBundledThemes() {
				return bundledThemes;
			}
		};
	}
	return createHighlighter;
}
function makeSingletonHighlighter(createHighlighter) {
	let _shiki;
	async function getSingletonHighlighter(options = {}) {
		if (!_shiki) {
			_shiki = createHighlighter({
				...options,
				themes: [],
				langs: []
			});
			const s = await _shiki;
			await Promise.all([s.loadTheme(...options.themes || []), s.loadLanguage(...options.langs || [])]);
			return s;
		} else {
			const s = await _shiki;
			await Promise.all([s.loadTheme(...options.themes || []), s.loadLanguage(...options.langs || [])]);
			return s;
		}
	}
	return getSingletonHighlighter;
}
function createSingletonShorthands(createHighlighter, config) {
	const getSingletonHighlighter = makeSingletonHighlighter(createHighlighter);
	async function get(code, options) {
		const shiki = await getSingletonHighlighter({
			langs: [options.lang],
			themes: "theme" in options ? [options.theme] : Object.values(options.themes)
		});
		const langs = await config?.guessEmbeddedLanguages?.(code, options.lang, shiki);
		if (langs) await shiki.loadLanguage(...langs);
		return shiki;
	}
	return {
		getSingletonHighlighter(options) {
			return getSingletonHighlighter(options);
		},
		async codeToHtml(code, options) {
			return (await get(code, options)).codeToHtml(code, options);
		},
		async codeToHast(code, options) {
			return (await get(code, options)).codeToHast(code, options);
		},
		async codeToTokens(code, options) {
			return (await get(code, options)).codeToTokens(code, options);
		},
		async codeToTokensBase(code, options) {
			return (await get(code, options)).codeToTokensBase(code, options);
		},
		async codeToTokensWithThemes(code, options) {
			return (await get(code, options)).codeToTokensWithThemes(code, options);
		},
		async getLastGrammarState(code, options) {
			return (await getSingletonHighlighter({
				langs: [options.lang],
				themes: [options.theme]
			})).getLastGrammarState(code, options);
		}
	};
}
//#endregion
//#region node_modules/.pnpm/shiki@3.23.0/node_modules/shiki/dist/langs.mjs
const bundledLanguagesInfo = [
	{
		"id": "abap",
		"name": "ABAP",
		"import": (() => import("../../abap-bArXO9M3.js"))
	},
	{
		"id": "actionscript-3",
		"name": "ActionScript",
		"import": (() => import("../../actionscript-3-BsUbVka8.js"))
	},
	{
		"id": "ada",
		"name": "Ada",
		"import": (() => import("../../ada-Dx-WwjT6.js"))
	},
	{
		"id": "angular-html",
		"name": "Angular HTML",
		"import": (() => import("../../angular-html-R87yHxMA.js").then((n) => n.n))
	},
	{
		"id": "angular-ts",
		"name": "Angular TypeScript",
		"import": (() => import("../../angular-ts-BglNFSBH.js"))
	},
	{
		"id": "apache",
		"name": "Apache Conf",
		"import": (() => import("../../apache-CdSOyyTA.js"))
	},
	{
		"id": "apex",
		"name": "Apex",
		"import": (() => import("../../apex-CCmLsEd9.js"))
	},
	{
		"id": "apl",
		"name": "APL",
		"import": (() => import("../../apl-C1cDMkzC.js"))
	},
	{
		"id": "applescript",
		"name": "AppleScript",
		"import": (() => import("../../applescript-Bet-141O.js"))
	},
	{
		"id": "ara",
		"name": "Ara",
		"import": (() => import("../../ara-CflDwYiv.js"))
	},
	{
		"id": "asciidoc",
		"name": "AsciiDoc",
		"aliases": ["adoc"],
		"import": (() => import("../../asciidoc-BdVQP-r_.js"))
	},
	{
		"id": "asm",
		"name": "Assembly",
		"import": (() => import("../../asm-CZjh14mb.js"))
	},
	{
		"id": "astro",
		"name": "Astro",
		"import": (() => import("../../astro-9wHe6X26.js"))
	},
	{
		"id": "awk",
		"name": "AWK",
		"import": (() => import("../../awk-BxeIAe-B.js"))
	},
	{
		"id": "ballerina",
		"name": "Ballerina",
		"import": (() => import("../../ballerina-B8W1nk2_.js"))
	},
	{
		"id": "bat",
		"name": "Batch File",
		"aliases": ["batch"],
		"import": (() => import("../../bat-fPpHD0z3.js"))
	},
	{
		"id": "beancount",
		"name": "Beancount",
		"import": (() => import("../../beancount-B47Lf2K9.js"))
	},
	{
		"id": "berry",
		"name": "Berry",
		"aliases": ["be"],
		"import": (() => import("../../berry-BiGjYRs5.js"))
	},
	{
		"id": "bibtex",
		"name": "BibTeX",
		"import": (() => import("../../bibtex-BeQ9lz9O.js"))
	},
	{
		"id": "bicep",
		"name": "Bicep",
		"import": (() => import("../../bicep-WozYgxkK.js"))
	},
	{
		"id": "bird2",
		"name": "BIRD2 Configuration",
		"aliases": ["bird"],
		"import": (() => import("../../bird2-J6qBMH1z.js"))
	},
	{
		"id": "blade",
		"name": "Blade",
		"import": (() => import("../../blade-DZk3t4vn.js"))
	},
	{
		"id": "bsl",
		"name": "1C (Enterprise)",
		"aliases": ["1c"],
		"import": (() => import("../../bsl-CD1Nuq6p.js"))
	},
	{
		"id": "c",
		"name": "C",
		"import": (() => import("../../c-CKEToXVe.js").then((n) => n.n))
	},
	{
		"id": "c3",
		"name": "C3",
		"import": (() => import("../../c3-BeXmvsR_.js"))
	},
	{
		"id": "cadence",
		"name": "Cadence",
		"aliases": ["cdc"],
		"import": (() => import("../../cadence-DTazm7_S.js"))
	},
	{
		"id": "cairo",
		"name": "Cairo",
		"import": (() => import("../../cairo-Ai5nCKKZ.js"))
	},
	{
		"id": "clarity",
		"name": "Clarity",
		"import": (() => import("../../clarity-98WId3CS.js"))
	},
	{
		"id": "clojure",
		"name": "Clojure",
		"aliases": ["clj"],
		"import": (() => import("../../clojure-DK1dYCCi.js"))
	},
	{
		"id": "cmake",
		"name": "CMake",
		"import": (() => import("../../cmake-BTToCxsg.js"))
	},
	{
		"id": "cobol",
		"name": "COBOL",
		"import": (() => import("../../cobol-CJbcDeoz.js"))
	},
	{
		"id": "codeowners",
		"name": "CODEOWNERS",
		"import": (() => import("../../codeowners-RgV8MGji.js"))
	},
	{
		"id": "codeql",
		"name": "CodeQL",
		"aliases": ["ql"],
		"import": (() => import("../../codeql-D61hQc1z.js"))
	},
	{
		"id": "coffee",
		"name": "CoffeeScript",
		"aliases": ["coffeescript"],
		"import": (() => import("../../coffee-DuzUxoeK.js"))
	},
	{
		"id": "common-lisp",
		"name": "Common Lisp",
		"aliases": ["lisp"],
		"import": (() => import("../../common-lisp-C1SuylwT.js"))
	},
	{
		"id": "coq",
		"name": "Coq",
		"import": (() => import("../../coq-4-eXF9ts.js"))
	},
	{
		"id": "cpp",
		"name": "C++",
		"aliases": ["c++"],
		"import": (() => import("../../cpp-CiJ1VK1q.js").then((n) => n.n))
	},
	{
		"id": "crystal",
		"name": "Crystal",
		"import": (() => import("../../crystal-DE6HKrka.js"))
	},
	{
		"id": "csharp",
		"name": "C#",
		"aliases": ["c#", "cs"],
		"import": (() => import("../../csharp-DwHeCIka.js"))
	},
	{
		"id": "css",
		"name": "CSS",
		"import": (() => import("../../css-Dvi0Ud0q.js").then((n) => n.n))
	},
	{
		"id": "csv",
		"name": "CSV",
		"import": (() => import("../../csv-DoAiLSub.js"))
	},
	{
		"id": "cue",
		"name": "CUE",
		"import": (() => import("../../cue-z0KfqCWN.js"))
	},
	{
		"id": "cypher",
		"name": "Cypher",
		"aliases": ["cql"],
		"import": (() => import("../../cypher-yiwf4sJP.js"))
	},
	{
		"id": "d",
		"name": "D",
		"import": (() => import("../../d-BRYq7amS.js"))
	},
	{
		"id": "dart",
		"name": "Dart",
		"import": (() => import("../../dart-CnDuHzss.js"))
	},
	{
		"id": "dax",
		"name": "DAX",
		"import": (() => import("../../dax-CKQ44oqS.js"))
	},
	{
		"id": "desktop",
		"name": "Desktop",
		"import": (() => import("../../desktop-uw3AbNRK.js"))
	},
	{
		"id": "diff",
		"name": "Diff",
		"import": (() => import("../../diff-ByQyjNee.js"))
	},
	{
		"id": "docker",
		"name": "Dockerfile",
		"aliases": ["dockerfile"],
		"import": (() => import("../../docker-BU1fcK34.js"))
	},
	{
		"id": "dotenv",
		"name": "dotEnv",
		"import": (() => import("../../dotenv-DPDMMFiz.js"))
	},
	{
		"id": "dream-maker",
		"name": "Dream Maker",
		"import": (() => import("../../dream-maker-DFv4UYk_.js"))
	},
	{
		"id": "edge",
		"name": "Edge",
		"import": (() => import("../../edge-CCQQKGti.js"))
	},
	{
		"id": "elixir",
		"name": "Elixir",
		"import": (() => import("../../elixir-B2itu09y.js"))
	},
	{
		"id": "elm",
		"name": "Elm",
		"import": (() => import("../../elm-0-fTx76A.js"))
	},
	{
		"id": "emacs-lisp",
		"name": "Emacs Lisp",
		"aliases": ["elisp"],
		"import": (() => import("../../emacs-lisp-DYPmONTq.js"))
	},
	{
		"id": "erb",
		"name": "ERB",
		"import": (() => import("../../erb-DuiDTljp.js"))
	},
	{
		"id": "erlang",
		"name": "Erlang",
		"aliases": ["erl"],
		"import": (() => import("../../erlang-BG6DLXoK.js"))
	},
	{
		"id": "fennel",
		"name": "Fennel",
		"import": (() => import("../../fennel-CTthMvs9.js"))
	},
	{
		"id": "fish",
		"name": "Fish",
		"import": (() => import("../../fish-B7DpCFS-.js"))
	},
	{
		"id": "fluent",
		"name": "Fluent",
		"aliases": ["ftl"],
		"import": (() => import("../../fluent-BFP4XHga.js"))
	},
	{
		"id": "fortran-fixed-form",
		"name": "Fortran (Fixed Form)",
		"aliases": [
			"f",
			"for",
			"f77"
		],
		"import": (() => import("../../fortran-fixed-form-Bbmcaslu.js"))
	},
	{
		"id": "fortran-free-form",
		"name": "Fortran (Free Form)",
		"aliases": [
			"f90",
			"f95",
			"f03",
			"f08",
			"f18"
		],
		"import": (() => import("../../fortran-free-form-DOTddNGd.js"))
	},
	{
		"id": "fsharp",
		"name": "F#",
		"aliases": ["f#", "fs"],
		"import": (() => import("../../fsharp-17Jrkyd3.js"))
	},
	{
		"id": "gdresource",
		"name": "GDResource",
		"aliases": ["tscn", "tres"],
		"import": (() => import("../../gdresource-CzRFDSsL.js"))
	},
	{
		"id": "gdscript",
		"name": "GDScript",
		"aliases": ["gd"],
		"import": (() => import("../../gdscript-CtRCjoDb.js"))
	},
	{
		"id": "gdshader",
		"name": "GDShader",
		"import": (() => import("../../gdshader-BrGf7rBs.js"))
	},
	{
		"id": "genie",
		"name": "Genie",
		"import": (() => import("../../genie-BD8cHknn.js"))
	},
	{
		"id": "gherkin",
		"name": "Gherkin",
		"import": (() => import("../../gherkin-CwrV7U8B.js"))
	},
	{
		"id": "git-commit",
		"name": "Git Commit Message",
		"import": (() => import("../../git-commit-PF7g8obi.js"))
	},
	{
		"id": "git-rebase",
		"name": "Git Rebase Message",
		"import": (() => import("../../git-rebase-CRj1OQKx.js"))
	},
	{
		"id": "gleam",
		"name": "Gleam",
		"import": (() => import("../../gleam-BTTHts1I.js"))
	},
	{
		"id": "glimmer-js",
		"name": "Glimmer JS",
		"aliases": ["gjs"],
		"import": (() => import("../../glimmer-js-QQqAsROl.js"))
	},
	{
		"id": "glimmer-ts",
		"name": "Glimmer TS",
		"aliases": ["gts"],
		"import": (() => import("../../glimmer-ts-D_K_DI3y.js"))
	},
	{
		"id": "glsl",
		"name": "GLSL",
		"import": (() => import("../../glsl-CvSt79W4.js").then((n) => n.n))
	},
	{
		"id": "gn",
		"name": "GN",
		"import": (() => import("../../gn-_4KQYNSV.js"))
	},
	{
		"id": "gnuplot",
		"name": "Gnuplot",
		"import": (() => import("../../gnuplot-COWxehOw.js"))
	},
	{
		"id": "go",
		"name": "Go",
		"import": (() => import("../../go-CAipMa9z.js"))
	},
	{
		"id": "graphql",
		"name": "GraphQL",
		"aliases": ["gql"],
		"import": (() => import("../../graphql-CC3eGH98.js").then((n) => n.n))
	},
	{
		"id": "groovy",
		"name": "Groovy",
		"import": (() => import("../../groovy--K9jX994.js"))
	},
	{
		"id": "hack",
		"name": "Hack",
		"import": (() => import("../../hack-7qr_vhI8.js"))
	},
	{
		"id": "haml",
		"name": "Ruby Haml",
		"import": (() => import("../../haml-CmvaIDy-.js").then((n) => n.n))
	},
	{
		"id": "handlebars",
		"name": "Handlebars",
		"aliases": ["hbs"],
		"import": (() => import("../../handlebars-CZKfIuVy.js"))
	},
	{
		"id": "haskell",
		"name": "Haskell",
		"aliases": ["hs"],
		"import": (() => import("../../haskell-Dy37fLPb.js"))
	},
	{
		"id": "haxe",
		"name": "Haxe",
		"import": (() => import("../../haxe-Ckj8EhPE.js"))
	},
	{
		"id": "hcl",
		"name": "HashiCorp HCL",
		"import": (() => import("../../hcl-B2vnJwiw.js"))
	},
	{
		"id": "hjson",
		"name": "Hjson",
		"import": (() => import("../../hjson-DIRtGSHV.js"))
	},
	{
		"id": "hlsl",
		"name": "HLSL",
		"import": (() => import("../../hlsl-GSR3Aoa5.js"))
	},
	{
		"id": "html",
		"name": "HTML",
		"import": (() => import("../../html-CACJylAD.js").then((n) => n.n))
	},
	{
		"id": "html-derivative",
		"name": "HTML (Derivative)",
		"import": (() => import("../../html-derivative-BTrvsYqj.js"))
	},
	{
		"id": "http",
		"name": "HTTP",
		"import": (() => import("../../http-CAYeMhGx.js"))
	},
	{
		"id": "hurl",
		"name": "Hurl",
		"import": (() => import("../../hurl-CmLe1WYD.js"))
	},
	{
		"id": "hxml",
		"name": "HXML",
		"import": (() => import("../../hxml-B2WbiOqt.js"))
	},
	{
		"id": "hy",
		"name": "Hy",
		"import": (() => import("../../hy-CgWmf2E4.js"))
	},
	{
		"id": "imba",
		"name": "Imba",
		"import": (() => import("../../imba-CshuCt4V.js"))
	},
	{
		"id": "ini",
		"name": "INI",
		"aliases": ["properties"],
		"import": (() => import("../../ini-Ct37RzHT.js"))
	},
	{
		"id": "java",
		"name": "Java",
		"import": (() => import("../../java-D9-bKlRW.js").then((n) => n.n))
	},
	{
		"id": "javascript",
		"name": "JavaScript",
		"aliases": [
			"js",
			"cjs",
			"mjs"
		],
		"import": (() => import("../../javascript-Cfn7mP_w.js").then((n) => n.n))
	},
	{
		"id": "jinja",
		"name": "Jinja",
		"import": (() => import("../../jinja-B05gJGJs.js"))
	},
	{
		"id": "jison",
		"name": "Jison",
		"import": (() => import("../../jison-svT8z102.js"))
	},
	{
		"id": "json",
		"name": "JSON",
		"import": (() => import("../../json-Dg4-CCwp.js").then((n) => n.n))
	},
	{
		"id": "json5",
		"name": "JSON5",
		"import": (() => import("../../json5-DCieI4sG.js"))
	},
	{
		"id": "jsonc",
		"name": "JSON with Comments",
		"import": (() => import("../../jsonc-DThUPyQj.js"))
	},
	{
		"id": "jsonl",
		"name": "JSON Lines",
		"import": (() => import("../../jsonl-DcYzqVoq.js"))
	},
	{
		"id": "jsonnet",
		"name": "Jsonnet",
		"import": (() => import("../../jsonnet-CymaBZ-W.js"))
	},
	{
		"id": "jssm",
		"name": "JSSM",
		"aliases": ["fsl"],
		"import": (() => import("../../jssm-aTIZHoFs.js"))
	},
	{
		"id": "jsx",
		"name": "JSX",
		"import": (() => import("../../jsx-BWbgeb5s.js").then((n) => n.n))
	},
	{
		"id": "julia",
		"name": "Julia",
		"aliases": ["jl"],
		"import": (() => import("../../julia-B9UyMZ1S.js"))
	},
	{
		"id": "just",
		"name": "Just",
		"import": (() => import("../../just-DOjw_qKW.js"))
	},
	{
		"id": "kdl",
		"name": "KDL",
		"import": (() => import("../../kdl-SvtFMr-y.js"))
	},
	{
		"id": "kotlin",
		"name": "Kotlin",
		"aliases": ["kt", "kts"],
		"import": (() => import("../../kotlin-Bl9q8sKz.js"))
	},
	{
		"id": "kusto",
		"name": "Kusto",
		"aliases": ["kql"],
		"import": (() => import("../../kusto-Bmj9_BP-.js"))
	},
	{
		"id": "latex",
		"name": "LaTeX",
		"import": (() => import("../../latex-Cnyrrf1V.js"))
	},
	{
		"id": "lean",
		"name": "Lean 4",
		"aliases": ["lean4"],
		"import": (() => import("../../lean-BkSUP0Y3.js"))
	},
	{
		"id": "less",
		"name": "Less",
		"import": (() => import("../../less-Vo2QbVfn.js"))
	},
	{
		"id": "liquid",
		"name": "Liquid",
		"import": (() => import("../../liquid-DDHnEZFS.js"))
	},
	{
		"id": "llvm",
		"name": "LLVM IR",
		"import": (() => import("../../llvm-FFJQUDNs.js"))
	},
	{
		"id": "log",
		"name": "Log file",
		"import": (() => import("../../log-DnqR4YRO.js"))
	},
	{
		"id": "logo",
		"name": "Logo",
		"import": (() => import("../../logo-CBOTzM9v.js"))
	},
	{
		"id": "lua",
		"name": "Lua",
		"import": (() => import("../../lua-B1cDdEfW.js").then((n) => n.n))
	},
	{
		"id": "luau",
		"name": "Luau",
		"import": (() => import("../../luau-DB2DRj54.js"))
	},
	{
		"id": "make",
		"name": "Makefile",
		"aliases": ["makefile"],
		"import": (() => import("../../make-C8tbRB-c.js"))
	},
	{
		"id": "markdown",
		"name": "Markdown",
		"aliases": ["md"],
		"import": (() => import("../../markdown-DWE_PDJt.js"))
	},
	{
		"id": "marko",
		"name": "Marko",
		"import": (() => import("../../marko-Bf1QDIeA.js"))
	},
	{
		"id": "matlab",
		"name": "MATLAB",
		"import": (() => import("../../matlab-Dh_Tl9PT.js"))
	},
	{
		"id": "mdc",
		"name": "MDC",
		"import": (() => import("../../mdc-BxBCpTNK.js"))
	},
	{
		"id": "mdx",
		"name": "MDX",
		"import": (() => import("../../mdx-BLZ3LNTX.js"))
	},
	{
		"id": "mermaid",
		"name": "Mermaid",
		"aliases": ["mmd"],
		"import": (() => import("../../mermaid-D5T17ChD.js"))
	},
	{
		"id": "mipsasm",
		"name": "MIPS Assembly",
		"aliases": ["mips"],
		"import": (() => import("../../mipsasm-BpTGnKa9.js"))
	},
	{
		"id": "mojo",
		"name": "Mojo",
		"import": (() => import("../../mojo-CUt7zKTK.js"))
	},
	{
		"id": "moonbit",
		"name": "MoonBit",
		"aliases": ["mbt", "mbti"],
		"import": (() => import("../../moonbit-GhWbFg6S.js"))
	},
	{
		"id": "move",
		"name": "Move",
		"import": (() => import("../../move-CQ-MAe_y.js"))
	},
	{
		"id": "narrat",
		"name": "Narrat Language",
		"aliases": ["nar"],
		"import": (() => import("../../narrat-ChO3ExK7.js"))
	},
	{
		"id": "nextflow",
		"name": "Nextflow",
		"aliases": ["nf"],
		"import": (() => import("../../nextflow-C-jWgF1y.js"))
	},
	{
		"id": "nextflow-groovy",
		"name": "nextflow-groovy",
		"import": (() => import("../../nextflow-groovy-UHWUOp6d.js"))
	},
	{
		"id": "nginx",
		"name": "Nginx",
		"import": (() => import("../../nginx-DGhyiwzw.js"))
	},
	{
		"id": "nim",
		"name": "Nim",
		"import": (() => import("../../nim-uZBASywe.js"))
	},
	{
		"id": "nix",
		"name": "Nix",
		"import": (() => import("../../nix-DLLEx2K5.js"))
	},
	{
		"id": "nushell",
		"name": "nushell",
		"aliases": ["nu"],
		"import": (() => import("../../nushell-CEDr-NIZ.js"))
	},
	{
		"id": "objective-c",
		"name": "Objective-C",
		"aliases": ["objc"],
		"import": (() => import("../../objective-c-CAyKTsY0.js"))
	},
	{
		"id": "objective-cpp",
		"name": "Objective-C++",
		"import": (() => import("../../objective-cpp-BZPSCLJa.js"))
	},
	{
		"id": "ocaml",
		"name": "OCaml",
		"import": (() => import("../../ocaml-7p7FlA63.js"))
	},
	{
		"id": "odin",
		"name": "Odin",
		"import": (() => import("../../odin-BbNagp2l.js"))
	},
	{
		"id": "openscad",
		"name": "OpenSCAD",
		"aliases": ["scad"],
		"import": (() => import("../../openscad-7yjTenpX.js"))
	},
	{
		"id": "pascal",
		"name": "Pascal",
		"import": (() => import("../../pascal-BmUXQa-W.js"))
	},
	{
		"id": "perl",
		"name": "Perl",
		"import": (() => import("../../perl-BD82RzFF.js"))
	},
	{
		"id": "php",
		"name": "PHP",
		"import": (() => import("../../php-DpQtRcJM.js"))
	},
	{
		"id": "pkl",
		"name": "Pkl",
		"import": (() => import("../../pkl-DLfynPWu.js"))
	},
	{
		"id": "plsql",
		"name": "PL/SQL",
		"import": (() => import("../../plsql-DZL1c1aI.js"))
	},
	{
		"id": "po",
		"name": "Gettext PO",
		"aliases": ["pot", "potx"],
		"import": (() => import("../../po-BOAteoSa.js"))
	},
	{
		"id": "polar",
		"name": "Polar",
		"import": (() => import("../../polar-Cap_HOSB.js"))
	},
	{
		"id": "postcss",
		"name": "PostCSS",
		"import": (() => import("../../postcss-BRfXosZx.js"))
	},
	{
		"id": "powerquery",
		"name": "PowerQuery",
		"import": (() => import("../../powerquery-DOsLgXZL.js"))
	},
	{
		"id": "powershell",
		"name": "PowerShell",
		"aliases": ["ps", "ps1"],
		"import": (() => import("../../powershell-dqe3hPET.js"))
	},
	{
		"id": "prisma",
		"name": "Prisma",
		"import": (() => import("../../prisma-zDkED50_.js"))
	},
	{
		"id": "prolog",
		"name": "Prolog",
		"import": (() => import("../../prolog-DUBuVRSy.js"))
	},
	{
		"id": "proto",
		"name": "Protocol Buffer 3",
		"aliases": ["protobuf"],
		"import": (() => import("../../proto-DGnJBZML.js"))
	},
	{
		"id": "pug",
		"name": "Pug",
		"aliases": ["jade"],
		"import": (() => import("../../pug-B5qZGtx-.js"))
	},
	{
		"id": "puppet",
		"name": "Puppet",
		"import": (() => import("../../puppet-Bf-kodEH.js"))
	},
	{
		"id": "purescript",
		"name": "PureScript",
		"import": (() => import("../../purescript-C_vEwKA_.js"))
	},
	{
		"id": "python",
		"name": "Python",
		"aliases": ["py"],
		"import": (() => import("../../python-D5bvZTqc.js"))
	},
	{
		"id": "qml",
		"name": "QML",
		"import": (() => import("../../qml-wSYmfqeL.js"))
	},
	{
		"id": "qmldir",
		"name": "QML Directory",
		"import": (() => import("../../qmldir-Bucy90mG.js"))
	},
	{
		"id": "qss",
		"name": "Qt Style Sheets",
		"import": (() => import("../../qss-CcikPxrF.js"))
	},
	{
		"id": "r",
		"name": "R",
		"import": (() => import("../../r-BckmTFiC.js").then((n) => n.n))
	},
	{
		"id": "racket",
		"name": "Racket",
		"import": (() => import("../../racket-C_tjlCMO.js"))
	},
	{
		"id": "raku",
		"name": "Raku",
		"aliases": ["perl6"],
		"import": (() => import("../../raku-C6njj8Hv.js"))
	},
	{
		"id": "razor",
		"name": "ASP.NET Razor",
		"import": (() => import("../../razor-sB8f3GKz.js"))
	},
	{
		"id": "reg",
		"name": "Windows Registry Script",
		"import": (() => import("../../reg-DK2JLREz.js"))
	},
	{
		"id": "regexp",
		"name": "RegExp",
		"aliases": ["regex"],
		"import": (() => import("../../regexp-DVnH6T6Y.js").then((n) => n.n))
	},
	{
		"id": "rel",
		"name": "Rel",
		"import": (() => import("../../rel-CW25WeEE.js"))
	},
	{
		"id": "riscv",
		"name": "RISC-V",
		"import": (() => import("../../riscv-BeNSPc9t.js"))
	},
	{
		"id": "ron",
		"name": "RON",
		"import": (() => import("../../ron-B3-qhQ0F.js"))
	},
	{
		"id": "rosmsg",
		"name": "ROS Interface",
		"import": (() => import("../../rosmsg-DiOPE-pm.js"))
	},
	{
		"id": "rst",
		"name": "reStructuredText",
		"import": (() => import("../../rst-T6gWa82r.js"))
	},
	{
		"id": "ruby",
		"name": "Ruby",
		"aliases": ["rb"],
		"import": (() => import("../../ruby-CqUZ27oR.js"))
	},
	{
		"id": "rust",
		"name": "Rust",
		"aliases": ["rs"],
		"import": (() => import("../../rust-DNZ7TdB1.js"))
	},
	{
		"id": "sas",
		"name": "SAS",
		"import": (() => import("../../sas-LWCpkOM0.js"))
	},
	{
		"id": "sass",
		"name": "Sass",
		"import": (() => import("../../sass-Qvo1SCAI.js"))
	},
	{
		"id": "scala",
		"name": "Scala",
		"import": (() => import("../../scala-C7Pd8v1T.js"))
	},
	{
		"id": "scheme",
		"name": "Scheme",
		"import": (() => import("../../scheme-CRdOCDYj.js"))
	},
	{
		"id": "scss",
		"name": "SCSS",
		"import": (() => import("../../scss-DyPoS3BC.js").then((n) => n.n))
	},
	{
		"id": "sdbl",
		"name": "1C (Query)",
		"aliases": ["1c-query"],
		"import": (() => import("../../sdbl-BIvJLCbE.js"))
	},
	{
		"id": "shaderlab",
		"name": "ShaderLab",
		"aliases": ["shader"],
		"import": (() => import("../../shaderlab-Dbj7T6-4.js"))
	},
	{
		"id": "shellscript",
		"name": "Shell",
		"aliases": [
			"bash",
			"sh",
			"shell",
			"zsh"
		],
		"import": (() => import("../../shellscript-CSCsRaD_.js").then((n) => n.n))
	},
	{
		"id": "shellsession",
		"name": "Shell Session",
		"aliases": ["console"],
		"import": (() => import("../../shellsession-CLgo_6f7.js"))
	},
	{
		"id": "smalltalk",
		"name": "Smalltalk",
		"import": (() => import("../../smalltalk-C1DkdIBf.js"))
	},
	{
		"id": "solidity",
		"name": "Solidity",
		"import": (() => import("../../solidity-Dsx404dp.js"))
	},
	{
		"id": "soy",
		"name": "Closure Templates",
		"aliases": ["closure-templates"],
		"import": (() => import("../../soy-kwJa0gOy.js"))
	},
	{
		"id": "sparql",
		"name": "SPARQL",
		"import": (() => import("../../sparql-BvPkmKf0.js"))
	},
	{
		"id": "splunk",
		"name": "Splunk Query Language",
		"aliases": ["spl"],
		"import": (() => import("../../splunk-2i3JfkOI.js"))
	},
	{
		"id": "sql",
		"name": "SQL",
		"import": (() => import("../../sql-BcrAFFT_.js").then((n) => n.n))
	},
	{
		"id": "ssh-config",
		"name": "SSH Config",
		"import": (() => import("../../ssh-config-T0pzNQNj.js"))
	},
	{
		"id": "stata",
		"name": "Stata",
		"import": (() => import("../../stata-18sOIlsT.js"))
	},
	{
		"id": "stylus",
		"name": "Stylus",
		"aliases": ["styl"],
		"import": (() => import("../../stylus-_wPHvSWP.js"))
	},
	{
		"id": "surrealql",
		"name": "SurrealQL",
		"aliases": ["surql"],
		"import": (() => import("../../surrealql-C691n3Er.js"))
	},
	{
		"id": "svelte",
		"name": "Svelte",
		"import": (() => import("../../svelte-DgZPvvSO.js"))
	},
	{
		"id": "swift",
		"name": "Swift",
		"import": (() => import("../../swift-D0smUN_m.js"))
	},
	{
		"id": "system-verilog",
		"name": "SystemVerilog",
		"import": (() => import("../../system-verilog-OIUQRR85.js"))
	},
	{
		"id": "systemd",
		"name": "Systemd Units",
		"import": (() => import("../../systemd-BTKgWxoL.js"))
	},
	{
		"id": "talonscript",
		"name": "TalonScript",
		"aliases": ["talon"],
		"import": (() => import("../../talonscript-Cuyn3Uo9.js"))
	},
	{
		"id": "tasl",
		"name": "Tasl",
		"import": (() => import("../../tasl-ClT5k2UY.js"))
	},
	{
		"id": "tcl",
		"name": "Tcl",
		"import": (() => import("../../tcl-qxzDeTKg.js"))
	},
	{
		"id": "templ",
		"name": "Templ",
		"import": (() => import("../../templ-CCstuWYB.js"))
	},
	{
		"id": "terraform",
		"name": "Terraform",
		"aliases": ["tf", "tfvars"],
		"import": (() => import("../../terraform-CHSAN5eA.js"))
	},
	{
		"id": "tex",
		"name": "TeX",
		"import": (() => import("../../tex-DGeV52aD.js"))
	},
	{
		"id": "toml",
		"name": "TOML",
		"import": (() => import("../../toml-5B9JP9o1.js"))
	},
	{
		"id": "ts-tags",
		"name": "TypeScript with Tags",
		"aliases": ["lit"],
		"import": (() => import("../../ts-tags-BRaHEvg8.js"))
	},
	{
		"id": "tsv",
		"name": "TSV",
		"import": (() => import("../../tsv-ByuGCTow.js"))
	},
	{
		"id": "tsx",
		"name": "TSX",
		"import": (() => import("../../tsx-Dwo1Df-r.js").then((n) => n.n))
	},
	{
		"id": "turtle",
		"name": "Turtle",
		"import": (() => import("../../turtle-CltIh6a1.js"))
	},
	{
		"id": "twig",
		"name": "Twig",
		"import": (() => import("../../twig-DnuPh02k.js"))
	},
	{
		"id": "typescript",
		"name": "TypeScript",
		"aliases": [
			"ts",
			"cts",
			"mts"
		],
		"import": (() => import("../../typescript-B9JlZPhb.js").then((n) => n.n))
	},
	{
		"id": "typespec",
		"name": "TypeSpec",
		"aliases": ["tsp"],
		"import": (() => import("../../typespec-BxmuMO6s.js"))
	},
	{
		"id": "typst",
		"name": "Typst",
		"aliases": ["typ"],
		"import": (() => import("../../typst-Clnsigul.js"))
	},
	{
		"id": "v",
		"name": "V",
		"import": (() => import("../../v-Bia0c3T6.js"))
	},
	{
		"id": "vala",
		"name": "Vala",
		"import": (() => import("../../vala-DADXmi_L.js"))
	},
	{
		"id": "vb",
		"name": "Visual Basic",
		"aliases": ["cmd"],
		"import": (() => import("../../vb-mOBIr9IK.js"))
	},
	{
		"id": "verilog",
		"name": "Verilog",
		"import": (() => import("../../verilog-B7QJ7KC5.js"))
	},
	{
		"id": "vhdl",
		"name": "VHDL",
		"import": (() => import("../../vhdl-Ba_BuoPG.js"))
	},
	{
		"id": "viml",
		"name": "Vim Script",
		"aliases": ["vim", "vimscript"],
		"import": (() => import("../../viml-8Iqz2ngJ.js"))
	},
	{
		"id": "vue",
		"name": "Vue",
		"import": (() => import("../../vue-B3vqGVCv.js"))
	},
	{
		"id": "vue-html",
		"name": "Vue HTML",
		"import": (() => import("../../vue-html-DYLiqxoB.js"))
	},
	{
		"id": "vue-vine",
		"name": "Vue Vine",
		"import": (() => import("../../vue-vine-DoKPeNsv.js"))
	},
	{
		"id": "vyper",
		"name": "Vyper",
		"aliases": ["vy"],
		"import": (() => import("../../vyper-MV1UqEDQ.js"))
	},
	{
		"id": "wasm",
		"name": "WebAssembly",
		"import": (() => import("../../wasm-bHgPba50.js"))
	},
	{
		"id": "wenyan",
		"name": "Wenyan",
		"aliases": ["文言"],
		"import": (() => import("../../wenyan-Duo1goRI.js"))
	},
	{
		"id": "wgsl",
		"name": "WGSL",
		"import": (() => import("../../wgsl-CPIDpKAI.js"))
	},
	{
		"id": "wikitext",
		"name": "Wikitext",
		"aliases": ["mediawiki", "wiki"],
		"import": (() => import("../../wikitext-DES1DyRo.js"))
	},
	{
		"id": "wit",
		"name": "WebAssembly Interface Types",
		"import": (() => import("../../wit-CoNRTBV4.js"))
	},
	{
		"id": "wolfram",
		"name": "Wolfram",
		"aliases": ["wl"],
		"import": (() => import("../../wolfram-CytZ5VFm.js"))
	},
	{
		"id": "xml",
		"name": "XML",
		"import": (() => import("../../xml-4148ngfF.js").then((n) => n.n))
	},
	{
		"id": "xsl",
		"name": "XSL",
		"import": (() => import("../../xsl-Bi11tH16.js"))
	},
	{
		"id": "yaml",
		"name": "YAML",
		"aliases": ["yml"],
		"import": (() => import("../../yaml-CNJp_AkF.js").then((n) => n.n))
	},
	{
		"id": "zenscript",
		"name": "ZenScript",
		"import": (() => import("../../zenscript-BVOHz8wi.js"))
	},
	{
		"id": "zig",
		"name": "Zig",
		"import": (() => import("../../zig-CGeFho3g.js"))
	}
];
const bundledLanguagesBase = Object.fromEntries(bundledLanguagesInfo.map((i) => [i.id, i.import]));
const bundledLanguagesAlias = Object.fromEntries(bundledLanguagesInfo.flatMap((i) => i.aliases?.map((a) => [a, i.import]) || []));
const bundledLanguages = {
	...bundledLanguagesBase,
	...bundledLanguagesAlias
};
const bundledThemes = Object.fromEntries([
	{
		"id": "andromeeda",
		"displayName": "Andromeeda",
		"type": "dark",
		"import": (() => import("../../andromeeda-DgOgdTmj.js"))
	},
	{
		"id": "aurora-x",
		"displayName": "Aurora X",
		"type": "dark",
		"import": (() => import("../../aurora-x-Lzhub_kG.js"))
	},
	{
		"id": "ayu-dark",
		"displayName": "Ayu Dark",
		"type": "dark",
		"import": (() => import("../../ayu-dark-Dyo0nCoi.js"))
	},
	{
		"id": "ayu-light",
		"displayName": "Ayu Light",
		"type": "light",
		"import": (() => import("../../ayu-light-DrGGOeFY.js"))
	},
	{
		"id": "ayu-mirage",
		"displayName": "Ayu Mirage",
		"type": "dark",
		"import": (() => import("../../ayu-mirage-B285wZ6g.js"))
	},
	{
		"id": "catppuccin-frappe",
		"displayName": "Catppuccin Frappé",
		"type": "dark",
		"import": (() => import("../../catppuccin-frappe-D6y8uFFi.js"))
	},
	{
		"id": "catppuccin-latte",
		"displayName": "Catppuccin Latte",
		"type": "light",
		"import": (() => import("../../catppuccin-latte-BhrehRyM.js"))
	},
	{
		"id": "catppuccin-macchiato",
		"displayName": "Catppuccin Macchiato",
		"type": "dark",
		"import": (() => import("../../catppuccin-macchiato-D_6VU4rh.js"))
	},
	{
		"id": "catppuccin-mocha",
		"displayName": "Catppuccin Mocha",
		"type": "dark",
		"import": (() => import("../../catppuccin-mocha-BIB7DRDC.js"))
	},
	{
		"id": "dark-plus",
		"displayName": "Dark Plus",
		"type": "dark",
		"import": (() => import("../../dark-plus-CwJO4CPL.js"))
	},
	{
		"id": "dracula",
		"displayName": "Dracula Theme",
		"type": "dark",
		"import": (() => import("../../dracula-DDL0Ya2Z.js"))
	},
	{
		"id": "dracula-soft",
		"displayName": "Dracula Theme Soft",
		"type": "dark",
		"import": (() => import("../../dracula-soft-YLYc9kec.js"))
	},
	{
		"id": "everforest-dark",
		"displayName": "Everforest Dark",
		"type": "dark",
		"import": (() => import("../../everforest-dark-Ca8Djws6.js"))
	},
	{
		"id": "everforest-light",
		"displayName": "Everforest Light",
		"type": "light",
		"import": (() => import("../../everforest-light-DX2Y1C7a.js"))
	},
	{
		"id": "github-dark",
		"displayName": "GitHub Dark",
		"type": "dark",
		"import": (() => import("../../github-dark-BTwR9izg.js"))
	},
	{
		"id": "github-dark-default",
		"displayName": "GitHub Dark Default",
		"type": "dark",
		"import": (() => import("../../github-dark-default-B4p9PKwF.js"))
	},
	{
		"id": "github-dark-dimmed",
		"displayName": "GitHub Dark Dimmed",
		"type": "dark",
		"import": (() => import("../../github-dark-dimmed-CcaxCSDd.js"))
	},
	{
		"id": "github-dark-high-contrast",
		"displayName": "GitHub Dark High Contrast",
		"type": "dark",
		"import": (() => import("../../github-dark-high-contrast-0LM2zPrl.js"))
	},
	{
		"id": "github-light",
		"displayName": "GitHub Light",
		"type": "light",
		"import": (() => import("../../github-light-C2ss1BjO.js"))
	},
	{
		"id": "github-light-default",
		"displayName": "GitHub Light Default",
		"type": "light",
		"import": (() => import("../../github-light-default-BKMKfwB8.js"))
	},
	{
		"id": "github-light-high-contrast",
		"displayName": "GitHub Light High Contrast",
		"type": "light",
		"import": (() => import("../../github-light-high-contrast-BIu8nxDY.js"))
	},
	{
		"id": "gruvbox-dark-hard",
		"displayName": "Gruvbox Dark Hard",
		"type": "dark",
		"import": (() => import("../../gruvbox-dark-hard-DgaGUVBT.js"))
	},
	{
		"id": "gruvbox-dark-medium",
		"displayName": "Gruvbox Dark Medium",
		"type": "dark",
		"import": (() => import("../../gruvbox-dark-medium-BubpXsFa.js"))
	},
	{
		"id": "gruvbox-dark-soft",
		"displayName": "Gruvbox Dark Soft",
		"type": "dark",
		"import": (() => import("../../gruvbox-dark-soft-BoRuYhHs.js"))
	},
	{
		"id": "gruvbox-light-hard",
		"displayName": "Gruvbox Light Hard",
		"type": "light",
		"import": (() => import("../../gruvbox-light-hard-BKr_Ogga.js"))
	},
	{
		"id": "gruvbox-light-medium",
		"displayName": "Gruvbox Light Medium",
		"type": "light",
		"import": (() => import("../../gruvbox-light-medium-BS-5muD8.js"))
	},
	{
		"id": "gruvbox-light-soft",
		"displayName": "Gruvbox Light Soft",
		"type": "light",
		"import": (() => import("../../gruvbox-light-soft-BxBkU2dL.js"))
	},
	{
		"id": "horizon",
		"displayName": "Horizon",
		"type": "dark",
		"import": (() => import("../../horizon-BMdovdn2.js"))
	},
	{
		"id": "horizon-bright",
		"displayName": "Horizon Bright",
		"type": "dark",
		"import": (() => import("../../horizon-bright-Ca_kCHlZ.js"))
	},
	{
		"id": "houston",
		"displayName": "Houston",
		"type": "dark",
		"import": (() => import("../../houston-DtqsG9wI.js"))
	},
	{
		"id": "kanagawa-dragon",
		"displayName": "Kanagawa Dragon",
		"type": "dark",
		"import": (() => import("../../kanagawa-dragon-DphVSeFM.js"))
	},
	{
		"id": "kanagawa-lotus",
		"displayName": "Kanagawa Lotus",
		"type": "light",
		"import": (() => import("../../kanagawa-lotus-CdI9JnuL.js"))
	},
	{
		"id": "kanagawa-wave",
		"displayName": "Kanagawa Wave",
		"type": "dark",
		"import": (() => import("../../kanagawa-wave-7JWSAzFP.js"))
	},
	{
		"id": "laserwave",
		"displayName": "LaserWave",
		"type": "dark",
		"import": (() => import("../../laserwave-Dii_TQSw.js"))
	},
	{
		"id": "light-plus",
		"displayName": "Light Plus",
		"type": "light",
		"import": (() => import("../../light-plus-BYLZucXH.js"))
	},
	{
		"id": "material-theme",
		"displayName": "Material Theme",
		"type": "dark",
		"import": (() => import("../../material-theme-Bz94lvk8.js"))
	},
	{
		"id": "material-theme-darker",
		"displayName": "Material Theme Darker",
		"type": "dark",
		"import": (() => import("../../material-theme-darker-DzzsCIv8.js"))
	},
	{
		"id": "material-theme-lighter",
		"displayName": "Material Theme Lighter",
		"type": "light",
		"import": (() => import("../../material-theme-lighter-DlDhZpKG.js"))
	},
	{
		"id": "material-theme-ocean",
		"displayName": "Material Theme Ocean",
		"type": "dark",
		"import": (() => import("../../material-theme-ocean-BrULqHnP.js"))
	},
	{
		"id": "material-theme-palenight",
		"displayName": "Material Theme Palenight",
		"type": "dark",
		"import": (() => import("../../material-theme-palenight-B41cbJak.js"))
	},
	{
		"id": "min-dark",
		"displayName": "Min Dark",
		"type": "dark",
		"import": (() => import("../../min-dark-D7szBQaW.js"))
	},
	{
		"id": "min-light",
		"displayName": "Min Light",
		"type": "light",
		"import": (() => import("../../min-light-C_ghyHuD.js"))
	},
	{
		"id": "monokai",
		"displayName": "Monokai",
		"type": "dark",
		"import": (() => import("../../monokai-uD-PnSLb.js"))
	},
	{
		"id": "night-owl",
		"displayName": "Night Owl",
		"type": "dark",
		"import": (() => import("../../night-owl-BJxm7Pph.js"))
	},
	{
		"id": "night-owl-light",
		"displayName": "Night Owl Light",
		"type": "light",
		"import": (() => import("../../night-owl-light-B1Cglljy.js"))
	},
	{
		"id": "nord",
		"displayName": "Nord",
		"type": "dark",
		"import": (() => import("../../nord-yYI_IYCA.js"))
	},
	{
		"id": "one-dark-pro",
		"displayName": "One Dark Pro",
		"type": "dark",
		"import": (() => import("../../one-dark-pro-DSx_OXl_.js"))
	},
	{
		"id": "one-light",
		"displayName": "One Light",
		"type": "light",
		"import": (() => import("../../one-light-C8Q7GAPh.js"))
	},
	{
		"id": "plastic",
		"displayName": "Plastic",
		"type": "dark",
		"import": (() => import("../../plastic-CblP6-7c.js"))
	},
	{
		"id": "poimandres",
		"displayName": "Poimandres",
		"type": "dark",
		"import": (() => import("../../poimandres-CQKDVyzY.js"))
	},
	{
		"id": "red",
		"displayName": "Red",
		"type": "dark",
		"import": (() => import("../../red-CBG1iRc9.js"))
	},
	{
		"id": "rose-pine",
		"displayName": "Rosé Pine",
		"type": "dark",
		"import": (() => import("../../rose-pine-dzeH7z7Y.js"))
	},
	{
		"id": "rose-pine-dawn",
		"displayName": "Rosé Pine Dawn",
		"type": "light",
		"import": (() => import("../../rose-pine-dawn-BaoZdccJ.js"))
	},
	{
		"id": "rose-pine-moon",
		"displayName": "Rosé Pine Moon",
		"type": "dark",
		"import": (() => import("../../rose-pine-moon-BywR3TKj.js"))
	},
	{
		"id": "slack-dark",
		"displayName": "Slack Dark",
		"type": "dark",
		"import": (() => import("../../slack-dark-CX50qebL.js"))
	},
	{
		"id": "slack-ochin",
		"displayName": "Slack Ochin",
		"type": "light",
		"import": (() => import("../../slack-ochin-BE00NYs5.js"))
	},
	{
		"id": "snazzy-light",
		"displayName": "Snazzy Light",
		"type": "light",
		"import": (() => import("../../snazzy-light-CRbtB_Dp.js"))
	},
	{
		"id": "solarized-dark",
		"displayName": "Solarized Dark",
		"type": "dark",
		"import": (() => import("../../solarized-dark-D8FmcYum.js"))
	},
	{
		"id": "solarized-light",
		"displayName": "Solarized Light",
		"type": "light",
		"import": (() => import("../../solarized-light-C6iN0huS.js"))
	},
	{
		"id": "synthwave-84",
		"displayName": "Synthwave '84",
		"type": "dark",
		"import": (() => import("../../synthwave-84-CNcvEesU.js"))
	},
	{
		"id": "tokyo-night",
		"displayName": "Tokyo Night",
		"type": "dark",
		"import": (() => import("../../tokyo-night-KAKMufQd.js"))
	},
	{
		"id": "vesper",
		"displayName": "Vesper",
		"type": "dark",
		"import": (() => import("../../vesper-keMzELfu.js"))
	},
	{
		"id": "vitesse-black",
		"displayName": "Vitesse Black",
		"type": "dark",
		"import": (() => import("../../vitesse-black-CYwXH4_d.js"))
	},
	{
		"id": "vitesse-dark",
		"displayName": "Vitesse Dark",
		"type": "dark",
		"import": (() => import("../../vitesse-dark-D2OZomMM.js"))
	},
	{
		"id": "vitesse-light",
		"displayName": "Vitesse Light",
		"type": "light",
		"import": (() => import("../../vitesse-light-9kxwzgIJ.js"))
	}
].map((i) => [i.id, i.import]));
//#endregion
//#region node_modules/.pnpm/@shikijs+engine-oniguruma@3.23.0/node_modules/@shikijs/engine-oniguruma/dist/index.mjs
var ShikiError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ShikiError";
	}
};
function getHeapMax() {
	return 2147483648;
}
function _emscripten_get_now() {
	return typeof performance !== "undefined" ? performance.now() : Date.now();
}
const alignUp = (x, multiple) => x + (multiple - x % multiple) % multiple;
async function main(init) {
	let wasmMemory;
	let buffer;
	const binding = {};
	function updateGlobalBufferAndViews(buf) {
		buffer = buf;
		binding.HEAPU8 = new Uint8Array(buf);
		binding.HEAPU32 = new Uint32Array(buf);
	}
	function _emscripten_memcpy_big(dest, src, num) {
		binding.HEAPU8.copyWithin(dest, src, src + num);
	}
	function emscripten_realloc_buffer(size) {
		try {
			wasmMemory.grow(size - buffer.byteLength + 65535 >>> 16);
			updateGlobalBufferAndViews(wasmMemory.buffer);
			return 1;
		} catch {}
	}
	function _emscripten_resize_heap(requestedSize) {
		const oldSize = binding.HEAPU8.length;
		requestedSize = requestedSize >>> 0;
		const maxHeapSize = getHeapMax();
		if (requestedSize > maxHeapSize) return false;
		for (let cutDown = 1; cutDown <= 4; cutDown *= 2) {
			let overGrownHeapSize = oldSize * (1 + .2 / cutDown);
			overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
			if (emscripten_realloc_buffer(Math.min(maxHeapSize, alignUp(Math.max(requestedSize, overGrownHeapSize), 65536)))) return true;
		}
		return false;
	}
	const UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder("utf8") : void 0;
	function UTF8ArrayToString(heapOrArray, idx, maxBytesToRead = 1024) {
		const endIdx = idx + maxBytesToRead;
		let endPtr = idx;
		while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
		if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
		let str = "";
		while (idx < endPtr) {
			let u0 = heapOrArray[idx++];
			if (!(u0 & 128)) {
				str += String.fromCharCode(u0);
				continue;
			}
			const u1 = heapOrArray[idx++] & 63;
			if ((u0 & 224) === 192) {
				str += String.fromCharCode((u0 & 31) << 6 | u1);
				continue;
			}
			const u2 = heapOrArray[idx++] & 63;
			if ((u0 & 240) === 224) u0 = (u0 & 15) << 12 | u1 << 6 | u2;
			else u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
			if (u0 < 65536) str += String.fromCharCode(u0);
			else {
				const ch = u0 - 65536;
				str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
			}
		}
		return str;
	}
	function UTF8ToString(ptr, maxBytesToRead) {
		return ptr ? UTF8ArrayToString(binding.HEAPU8, ptr, maxBytesToRead) : "";
	}
	const asmLibraryArg = {
		emscripten_get_now: _emscripten_get_now,
		emscripten_memcpy_big: _emscripten_memcpy_big,
		emscripten_resize_heap: _emscripten_resize_heap,
		fd_write: () => 0
	};
	async function createWasm() {
		const exports$1 = await init({
			env: asmLibraryArg,
			wasi_snapshot_preview1: asmLibraryArg
		});
		wasmMemory = exports$1.memory;
		updateGlobalBufferAndViews(wasmMemory.buffer);
		Object.assign(binding, exports$1);
		binding.UTF8ToString = UTF8ToString;
	}
	await createWasm();
	return binding;
}
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, {
	enumerable: true,
	configurable: true,
	writable: true,
	value
}) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
let onigBinding = null;
function throwLastOnigError(onigBinding2) {
	throw new ShikiError(onigBinding2.UTF8ToString(onigBinding2.getLastOnigError()));
}
var UtfString = class UtfString {
	constructor(str) {
		__publicField(this, "utf16Length");
		__publicField(this, "utf8Length");
		__publicField(this, "utf16Value");
		__publicField(this, "utf8Value");
		__publicField(this, "utf16OffsetToUtf8");
		__publicField(this, "utf8OffsetToUtf16");
		const utf16Length = str.length;
		const utf8Length = UtfString._utf8ByteLength(str);
		const computeIndicesMapping = utf8Length !== utf16Length;
		const utf16OffsetToUtf8 = computeIndicesMapping ? new Uint32Array(utf16Length + 1) : null;
		if (computeIndicesMapping) utf16OffsetToUtf8[utf16Length] = utf8Length;
		const utf8OffsetToUtf16 = computeIndicesMapping ? new Uint32Array(utf8Length + 1) : null;
		if (computeIndicesMapping) utf8OffsetToUtf16[utf8Length] = utf16Length;
		const utf8Value = new Uint8Array(utf8Length);
		let i8 = 0;
		for (let i16 = 0; i16 < utf16Length; i16++) {
			const charCode = str.charCodeAt(i16);
			let codePoint = charCode;
			let wasSurrogatePair = false;
			if (charCode >= 55296 && charCode <= 56319) {
				if (i16 + 1 < utf16Length) {
					const nextCharCode = str.charCodeAt(i16 + 1);
					if (nextCharCode >= 56320 && nextCharCode <= 57343) {
						codePoint = (charCode - 55296 << 10) + 65536 | nextCharCode - 56320;
						wasSurrogatePair = true;
					}
				}
			}
			if (computeIndicesMapping) {
				utf16OffsetToUtf8[i16] = i8;
				if (wasSurrogatePair) utf16OffsetToUtf8[i16 + 1] = i8;
				if (codePoint <= 127) utf8OffsetToUtf16[i8 + 0] = i16;
				else if (codePoint <= 2047) {
					utf8OffsetToUtf16[i8 + 0] = i16;
					utf8OffsetToUtf16[i8 + 1] = i16;
				} else if (codePoint <= 65535) {
					utf8OffsetToUtf16[i8 + 0] = i16;
					utf8OffsetToUtf16[i8 + 1] = i16;
					utf8OffsetToUtf16[i8 + 2] = i16;
				} else {
					utf8OffsetToUtf16[i8 + 0] = i16;
					utf8OffsetToUtf16[i8 + 1] = i16;
					utf8OffsetToUtf16[i8 + 2] = i16;
					utf8OffsetToUtf16[i8 + 3] = i16;
				}
			}
			if (codePoint <= 127) utf8Value[i8++] = codePoint;
			else if (codePoint <= 2047) {
				utf8Value[i8++] = 192 | (codePoint & 1984) >>> 6;
				utf8Value[i8++] = 128 | (codePoint & 63) >>> 0;
			} else if (codePoint <= 65535) {
				utf8Value[i8++] = 224 | (codePoint & 61440) >>> 12;
				utf8Value[i8++] = 128 | (codePoint & 4032) >>> 6;
				utf8Value[i8++] = 128 | (codePoint & 63) >>> 0;
			} else {
				utf8Value[i8++] = 240 | (codePoint & 1835008) >>> 18;
				utf8Value[i8++] = 128 | (codePoint & 258048) >>> 12;
				utf8Value[i8++] = 128 | (codePoint & 4032) >>> 6;
				utf8Value[i8++] = 128 | (codePoint & 63) >>> 0;
			}
			if (wasSurrogatePair) i16++;
		}
		this.utf16Length = utf16Length;
		this.utf8Length = utf8Length;
		this.utf16Value = str;
		this.utf8Value = utf8Value;
		this.utf16OffsetToUtf8 = utf16OffsetToUtf8;
		this.utf8OffsetToUtf16 = utf8OffsetToUtf16;
	}
	static _utf8ByteLength(str) {
		let result = 0;
		for (let i = 0, len = str.length; i < len; i++) {
			const charCode = str.charCodeAt(i);
			let codepoint = charCode;
			let wasSurrogatePair = false;
			if (charCode >= 55296 && charCode <= 56319) {
				if (i + 1 < len) {
					const nextCharCode = str.charCodeAt(i + 1);
					if (nextCharCode >= 56320 && nextCharCode <= 57343) {
						codepoint = (charCode - 55296 << 10) + 65536 | nextCharCode - 56320;
						wasSurrogatePair = true;
					}
				}
			}
			if (codepoint <= 127) result += 1;
			else if (codepoint <= 2047) result += 2;
			else if (codepoint <= 65535) result += 3;
			else result += 4;
			if (wasSurrogatePair) i++;
		}
		return result;
	}
	createString(onigBinding2) {
		const result = onigBinding2.omalloc(this.utf8Length);
		onigBinding2.HEAPU8.set(this.utf8Value, result);
		return result;
	}
};
const _OnigString = class _OnigString {
	constructor(str) {
		__publicField(this, "id", ++_OnigString.LAST_ID);
		__publicField(this, "_onigBinding");
		__publicField(this, "content");
		__publicField(this, "utf16Length");
		__publicField(this, "utf8Length");
		__publicField(this, "utf16OffsetToUtf8");
		__publicField(this, "utf8OffsetToUtf16");
		__publicField(this, "ptr");
		if (!onigBinding) throw new ShikiError("Must invoke loadWasm first.");
		this._onigBinding = onigBinding;
		this.content = str;
		const utfString = new UtfString(str);
		this.utf16Length = utfString.utf16Length;
		this.utf8Length = utfString.utf8Length;
		this.utf16OffsetToUtf8 = utfString.utf16OffsetToUtf8;
		this.utf8OffsetToUtf16 = utfString.utf8OffsetToUtf16;
		if (this.utf8Length < 1e4 && !_OnigString._sharedPtrInUse) {
			if (!_OnigString._sharedPtr) _OnigString._sharedPtr = onigBinding.omalloc(1e4);
			_OnigString._sharedPtrInUse = true;
			onigBinding.HEAPU8.set(utfString.utf8Value, _OnigString._sharedPtr);
			this.ptr = _OnigString._sharedPtr;
		} else this.ptr = utfString.createString(onigBinding);
	}
	convertUtf8OffsetToUtf16(utf8Offset) {
		if (this.utf8OffsetToUtf16) {
			if (utf8Offset < 0) return 0;
			if (utf8Offset > this.utf8Length) return this.utf16Length;
			return this.utf8OffsetToUtf16[utf8Offset];
		}
		return utf8Offset;
	}
	convertUtf16OffsetToUtf8(utf16Offset) {
		if (this.utf16OffsetToUtf8) {
			if (utf16Offset < 0) return 0;
			if (utf16Offset > this.utf16Length) return this.utf8Length;
			return this.utf16OffsetToUtf8[utf16Offset];
		}
		return utf16Offset;
	}
	dispose() {
		if (this.ptr === _OnigString._sharedPtr) _OnigString._sharedPtrInUse = false;
		else this._onigBinding.ofree(this.ptr);
	}
};
__publicField(_OnigString, "LAST_ID", 0);
__publicField(_OnigString, "_sharedPtr", 0);
__publicField(_OnigString, "_sharedPtrInUse", false);
let OnigString = _OnigString;
var OnigScanner = class {
	constructor(patterns) {
		__publicField(this, "_onigBinding");
		__publicField(this, "_ptr");
		if (!onigBinding) throw new ShikiError("Must invoke loadWasm first.");
		const strPtrsArr = [];
		const strLenArr = [];
		for (let i = 0, len = patterns.length; i < len; i++) {
			const utfString = new UtfString(patterns[i]);
			strPtrsArr[i] = utfString.createString(onigBinding);
			strLenArr[i] = utfString.utf8Length;
		}
		const strPtrsPtr = onigBinding.omalloc(4 * patterns.length);
		onigBinding.HEAPU32.set(strPtrsArr, strPtrsPtr / 4);
		const strLenPtr = onigBinding.omalloc(4 * patterns.length);
		onigBinding.HEAPU32.set(strLenArr, strLenPtr / 4);
		const scannerPtr = onigBinding.createOnigScanner(strPtrsPtr, strLenPtr, patterns.length);
		for (let i = 0, len = patterns.length; i < len; i++) onigBinding.ofree(strPtrsArr[i]);
		onigBinding.ofree(strLenPtr);
		onigBinding.ofree(strPtrsPtr);
		if (scannerPtr === 0) throwLastOnigError(onigBinding);
		this._onigBinding = onigBinding;
		this._ptr = scannerPtr;
	}
	dispose() {
		this._onigBinding.freeOnigScanner(this._ptr);
	}
	findNextMatchSync(string, startPosition, arg) {
		let options = 0;
		if (typeof arg === "number") options = arg;
		if (typeof string === "string") {
			string = new OnigString(string);
			const result = this._findNextMatchSync(string, startPosition, false, options);
			string.dispose();
			return result;
		}
		return this._findNextMatchSync(string, startPosition, false, options);
	}
	_findNextMatchSync(string, startPosition, debugCall, options) {
		const onigBinding2 = this._onigBinding;
		const resultPtr = onigBinding2.findNextOnigScannerMatch(this._ptr, string.id, string.ptr, string.utf8Length, string.convertUtf16OffsetToUtf8(startPosition), options);
		if (resultPtr === 0) return null;
		const HEAPU32 = onigBinding2.HEAPU32;
		let offset = resultPtr / 4;
		const index = HEAPU32[offset++];
		const count = HEAPU32[offset++];
		const captureIndices = [];
		for (let i = 0; i < count; i++) {
			const beg = string.convertUtf8OffsetToUtf16(HEAPU32[offset++]);
			const end = string.convertUtf8OffsetToUtf16(HEAPU32[offset++]);
			captureIndices[i] = {
				start: beg,
				end,
				length: end - beg
			};
		}
		return {
			index,
			captureIndices
		};
	}
};
function isInstantiatorOptionsObject(dataOrOptions) {
	return typeof dataOrOptions.instantiator === "function";
}
function isInstantiatorModule(dataOrOptions) {
	return typeof dataOrOptions.default === "function";
}
function isDataOptionsObject(dataOrOptions) {
	return typeof dataOrOptions.data !== "undefined";
}
function isResponse(dataOrOptions) {
	return typeof Response !== "undefined" && dataOrOptions instanceof Response;
}
function isArrayBuffer(data) {
	return typeof ArrayBuffer !== "undefined" && (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) || typeof Buffer !== "undefined" && Buffer.isBuffer?.(data) || typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer || typeof Uint32Array !== "undefined" && data instanceof Uint32Array;
}
let initPromise;
function loadWasm(options) {
	if (initPromise) return initPromise;
	async function _load() {
		onigBinding = await main(async (info) => {
			let instance = options;
			instance = await instance;
			if (typeof instance === "function") instance = await instance(info);
			if (typeof instance === "function") instance = await instance(info);
			if (isInstantiatorOptionsObject(instance)) instance = await instance.instantiator(info);
			else if (isInstantiatorModule(instance)) instance = await instance.default(info);
			else {
				if (isDataOptionsObject(instance)) instance = instance.data;
				if (isResponse(instance)) if (typeof WebAssembly.instantiateStreaming === "function") instance = await _makeResponseStreamingLoader(instance)(info);
				else instance = await _makeResponseNonStreamingLoader(instance)(info);
				else if (isArrayBuffer(instance)) instance = await _makeArrayBufferLoader(instance)(info);
				else if (instance instanceof WebAssembly.Module) instance = await _makeArrayBufferLoader(instance)(info);
				else if ("default" in instance && instance.default instanceof WebAssembly.Module) instance = await _makeArrayBufferLoader(instance.default)(info);
			}
			if ("instance" in instance) instance = instance.instance;
			if ("exports" in instance) instance = instance.exports;
			return instance;
		});
	}
	initPromise = _load();
	return initPromise;
}
function _makeArrayBufferLoader(data) {
	return (importObject) => WebAssembly.instantiate(data, importObject);
}
function _makeResponseStreamingLoader(data) {
	return (importObject) => WebAssembly.instantiateStreaming(data, importObject);
}
function _makeResponseNonStreamingLoader(data) {
	return async (importObject) => {
		const arrayBuffer = await data.arrayBuffer();
		return WebAssembly.instantiate(arrayBuffer, importObject);
	};
}
async function createOnigurumaEngine(options) {
	if (options) await loadWasm(options);
	return {
		createScanner(patterns) {
			return new OnigScanner(patterns.map((p) => typeof p === "string" ? p : p.source));
		},
		createString(s) {
			return new OnigString(s);
		}
	};
}
//#endregion
//#region node_modules/.pnpm/shiki@3.23.0/node_modules/shiki/dist/bundle-full.mjs
const createHighlighter = /* @__PURE__ */ createBundledHighlighter({
	langs: bundledLanguages,
	themes: bundledThemes,
	engine: () => createOnigurumaEngine(import("../../wasm-DwBOe5El.js"))
});
const { codeToHtml, codeToHast, codeToTokens, codeToTokensBase, codeToTokensWithThemes, getSingletonHighlighter, getLastGrammarState } = /* @__PURE__ */ createSingletonShorthands(createHighlighter, { guessEmbeddedLanguages });
//#endregion
//#region node_modules/.pnpm/oniguruma-parser@0.12.1/node_modules/oniguruma-parser/dist/utils.js
function r$2(e) {
	if ([...e].length !== 1) throw new Error(`Expected "${e}" to be a single code point`);
	return e.codePointAt(0);
}
function l$1(e, t, n) {
	return e.has(t) || e.set(t, n), e.get(t);
}
const i = new Set([
	"alnum",
	"alpha",
	"ascii",
	"blank",
	"cntrl",
	"digit",
	"graph",
	"lower",
	"print",
	"punct",
	"space",
	"upper",
	"word",
	"xdigit"
]), o$1 = String.raw;
function u(e, t) {
	if (e == null) throw new Error(t ?? "Value expected");
	return e;
}
//#endregion
//#region node_modules/.pnpm/oniguruma-parser@0.12.1/node_modules/oniguruma-parser/dist/tokenizer/tokenize.js
const m$1 = o$1`\[\^?`, b$1 = `c.? | C(?:-.?)?|${o$1`[pP]\{(?:\^?[-\x20_]*[A-Za-z][-\x20\w]*\})?`}|${o$1`x[89A-Fa-f]\p{AHex}(?:\\x[89A-Fa-f]\p{AHex})*`}|${o$1`u(?:\p{AHex}{4})? | x\{[^\}]*\}? | x\p{AHex}{0,2}`}|${o$1`o\{[^\}]*\}?`}|${o$1`\d{1,3}`}`, y$1 = /[?*+][?+]?|\{(?:\d+(?:,\d*)?|,\d+)\}\??/, C$1 = new RegExp(o$1`
  \\ (?:
    ${b$1}
    | [gk]<[^>]*>?
    | [gk]'[^']*'?
    | .
  )
  | \( (?:
    \? (?:
      [:=!>({]
      | <[=!]
      | <[^>]*>
      | '[^']*'
      | ~\|?
      | #(?:[^)\\]|\\.?)*
      | [^:)]*[:)]
    )?
    | \*[^\)]*\)?
  )?
  | (?:${y$1.source})+
  | ${m$1}
  | .
`.replace(/\s+/g, ""), "gsu"), T$1 = new RegExp(o$1`
  \\ (?:
    ${b$1}
    | .
  )
  | \[:(?:\^?\p{Alpha}+|\^):\]
  | ${m$1}
  | &&
  | .
`.replace(/\s+/g, ""), "gsu");
function M$1(e, n = {}) {
	const t = {
		flags: "",
		...n,
		rules: {
			captureGroup: !1,
			singleline: !1,
			...n.rules
		}
	};
	if (typeof e != "string") throw new Error("String expected as pattern");
	const o = Y(t.flags), s = [o.extended], a = {
		captureGroup: t.rules.captureGroup,
		getCurrentModX() {
			return s.at(-1);
		},
		numOpenGroups: 0,
		popModX() {
			s.pop();
		},
		pushModX(u) {
			s.push(u);
		},
		replaceCurrentModX(u) {
			s[s.length - 1] = u;
		},
		singleline: t.rules.singleline
	};
	let r = [], i;
	for (C$1.lastIndex = 0; i = C$1.exec(e);) {
		const u = F$1(a, e, i[0], C$1.lastIndex);
		u.tokens ? r.push(...u.tokens) : u.token && r.push(u.token), u.lastIndex !== void 0 && (C$1.lastIndex = u.lastIndex);
	}
	const l = [];
	let c = 0;
	r.filter((u) => u.type === "GroupOpen").forEach((u) => {
		u.kind === "capturing" ? u.number = ++c : u.raw === "(" && l.push(u);
	}), c || l.forEach((u, S) => {
		u.kind = "capturing", u.number = S + 1;
	});
	const g = c || l.length;
	return {
		tokens: r.map((u) => u.type === "EscapedNumber" ? ee$1(u, g) : u).flat(),
		flags: o
	};
}
function F$1(e, n, t, o) {
	const [s, a] = t;
	if (t === "[" || t === "[^") {
		const r = K$1(n, t, o);
		return {
			tokens: r.tokens,
			lastIndex: r.lastIndex
		};
	}
	if (s === "\\") {
		if ("AbBGyYzZ".includes(a)) return { token: w$1(t, t) };
		if (/^\\g[<']/.test(t)) {
			if (!/^\\g(?:<[^>]+>|'[^']+')$/.test(t)) throw new Error(`Invalid group name "${t}"`);
			return { token: R$1(t) };
		}
		if (/^\\k[<']/.test(t)) {
			if (!/^\\k(?:<[^>]+>|'[^']+')$/.test(t)) throw new Error(`Invalid group name "${t}"`);
			return { token: A$1(t) };
		}
		if (a === "K") return { token: I$1("keep", t) };
		if (a === "N" || a === "R") return { token: k$1("newline", t, { negate: a === "N" }) };
		if (a === "O") return { token: k$1("any", t) };
		if (a === "X") return { token: k$1("text_segment", t) };
		const r = x(t, { inCharClass: !1 });
		return Array.isArray(r) ? { tokens: r } : { token: r };
	}
	if (s === "(") {
		if (a === "*") return { token: j(t) };
		if (t === "(?{") throw new Error(`Unsupported callout "${t}"`);
		if (t.startsWith("(?#")) {
			if (n[o] !== ")") throw new Error("Unclosed comment group \"(?#\"");
			return { lastIndex: o + 1 };
		}
		if (/^\(\?[-imx]+[:)]$/.test(t)) return { token: L$1(t, e) };
		if (e.pushModX(e.getCurrentModX()), e.numOpenGroups++, t === "(" && !e.captureGroup || t === "(?:") return { token: f$1("group", t) };
		if (t === "(?>") return { token: f$1("atomic", t) };
		if (t === "(?=" || t === "(?!" || t === "(?<=" || t === "(?<!") return { token: f$1(t[2] === "<" ? "lookbehind" : "lookahead", t, { negate: t.endsWith("!") }) };
		if (t === "(" && e.captureGroup || t.startsWith("(?<") && t.endsWith(">") || t.startsWith("(?'") && t.endsWith("'")) return { token: f$1("capturing", t, { ...t !== "(" && { name: t.slice(3, -1) } }) };
		if (t.startsWith("(?~")) {
			if (t === "(?~|") throw new Error(`Unsupported absence function kind "${t}"`);
			return { token: f$1("absence_repeater", t) };
		}
		throw t === "(?(" ? /* @__PURE__ */ new Error(`Unsupported conditional "${t}"`) : /* @__PURE__ */ new Error(`Invalid or unsupported group option "${t}"`);
	}
	if (t === ")") {
		if (e.popModX(), e.numOpenGroups--, e.numOpenGroups < 0) throw new Error("Unmatched \")\"");
		return { token: Q$1(t) };
	}
	if (e.getCurrentModX()) {
		if (t === "#") {
			const r = n.indexOf(`
`, o);
			return { lastIndex: r === -1 ? n.length : r };
		}
		if (/^\s$/.test(t)) {
			const r = /\s+/y;
			return r.lastIndex = o, { lastIndex: r.exec(n) ? r.lastIndex : o };
		}
	}
	if (t === ".") return { token: k$1("dot", t) };
	if (t === "^" || t === "$") return { token: w$1(e.singleline ? {
		"^": o$1`\A`,
		$: o$1`\Z`
	}[t] : t, t) };
	return t === "|" ? { token: P$1(t) } : y$1.test(t) ? { tokens: te$1(t) } : { token: d(r$2(t), t) };
}
function K$1(e, n, t) {
	const o = [E$1(n[1] === "^", n)];
	let s = 1, a;
	for (T$1.lastIndex = t; a = T$1.exec(e);) {
		const r = a[0];
		if (r[0] === "[" && r[1] !== ":") s++, o.push(E$1(r[1] === "^", r));
		else if (r === "]") {
			if (o.at(-1).type === "CharacterClassOpen") o.push(d(93, r));
			else if (s--, o.push(z$1(r)), !s) break;
		} else {
			const i = X$1(r);
			Array.isArray(i) ? o.push(...i) : o.push(i);
		}
	}
	return {
		tokens: o,
		lastIndex: T$1.lastIndex || e.length
	};
}
function X$1(e) {
	if (e[0] === "\\") return x(e, { inCharClass: !0 });
	if (e[0] === "[") {
		const n = /\[:(?<negate>\^?)(?<name>[a-z]+):\]/.exec(e);
		if (!n || !i.has(n.groups.name)) throw new Error(`Invalid POSIX class "${e}"`);
		return k$1("posix", e, {
			value: n.groups.name,
			negate: !!n.groups.negate
		});
	}
	return e === "-" ? U$1(e) : e === "&&" ? H(e) : d(r$2(e), e);
}
function x(e, { inCharClass: n }) {
	const t = e[1];
	if (t === "c" || t === "C") return Z(e);
	if ("dDhHsSwW".includes(t)) return q(e);
	if (e.startsWith(o$1`\o{`)) throw new Error(`Incomplete, invalid, or unsupported octal code point "${e}"`);
	if (/^\\[pP]\{/.test(e)) {
		if (e.length === 3) throw new Error(`Incomplete or invalid Unicode property "${e}"`);
		return V$1(e);
	}
	if (/^\\x[89A-Fa-f]\p{AHex}/u.test(e)) try {
		const o = e.split(/\\x/).slice(1).map((i) => parseInt(i, 16)), s = new TextDecoder("utf-8", {
			ignoreBOM: !0,
			fatal: !0
		}).decode(new Uint8Array(o)), a = new TextEncoder();
		return [...s].map((i) => {
			const l = [...a.encode(i)].map((c) => `\\x${c.toString(16)}`).join("");
			return d(r$2(i), l);
		});
	} catch {
		throw new Error(`Multibyte code "${e}" incomplete or invalid in Oniguruma`);
	}
	if (t === "u" || t === "x") return d(J$1(e), e);
	if ($$1.has(t)) return d($$1.get(t), e);
	if (/\d/.test(t)) return W$1(n, e);
	if (e === "\\") throw new Error(o$1`Incomplete escape "\"`);
	if (t === "M") throw new Error(`Unsupported meta "${e}"`);
	if ([...e].length === 2) return d(e.codePointAt(1), e);
	throw new Error(`Unexpected escape "${e}"`);
}
function P$1(e) {
	return {
		type: "Alternator",
		raw: e
	};
}
function w$1(e, n) {
	return {
		type: "Assertion",
		kind: e,
		raw: n
	};
}
function A$1(e) {
	return {
		type: "Backreference",
		raw: e
	};
}
function d(e, n) {
	return {
		type: "Character",
		value: e,
		raw: n
	};
}
function z$1(e) {
	return {
		type: "CharacterClassClose",
		raw: e
	};
}
function U$1(e) {
	return {
		type: "CharacterClassHyphen",
		raw: e
	};
}
function H(e) {
	return {
		type: "CharacterClassIntersector",
		raw: e
	};
}
function E$1(e, n) {
	return {
		type: "CharacterClassOpen",
		negate: e,
		raw: n
	};
}
function k$1(e, n, t = {}) {
	return {
		type: "CharacterSet",
		kind: e,
		...t,
		raw: n
	};
}
function I$1(e, n, t = {}) {
	return e === "keep" ? {
		type: "Directive",
		kind: e,
		raw: n
	} : {
		type: "Directive",
		kind: e,
		flags: u(t.flags),
		raw: n
	};
}
function W$1(e, n) {
	return {
		type: "EscapedNumber",
		inCharClass: e,
		raw: n
	};
}
function Q$1(e) {
	return {
		type: "GroupClose",
		raw: e
	};
}
function f$1(e, n, t = {}) {
	return {
		type: "GroupOpen",
		kind: e,
		...t,
		raw: n
	};
}
function D$1(e, n, t, o) {
	return {
		type: "NamedCallout",
		kind: e,
		tag: n,
		arguments: t,
		raw: o
	};
}
function _$1(e, n, t, o) {
	return {
		type: "Quantifier",
		kind: e,
		min: n,
		max: t,
		raw: o
	};
}
function R$1(e) {
	return {
		type: "Subroutine",
		raw: e
	};
}
const B$1 = new Set([
	"COUNT",
	"CMP",
	"ERROR",
	"FAIL",
	"MAX",
	"MISMATCH",
	"SKIP",
	"TOTAL_COUNT"
]), $$1 = new Map([
	["a", 7],
	["b", 8],
	["e", 27],
	["f", 12],
	["n", 10],
	["r", 13],
	["t", 9],
	["v", 11]
]);
function Z(e) {
	const n = e[1] === "c" ? e[2] : e[3];
	if (!n || !/[A-Za-z]/.test(n)) throw new Error(`Unsupported control character "${e}"`);
	return d(r$2(n.toUpperCase()) - 64, e);
}
function L$1(e, n) {
	let { on: t, off: o } = /^\(\?(?<on>[imx]*)(?:-(?<off>[-imx]*))?/.exec(e).groups;
	o ??= "";
	const s = (n.getCurrentModX() || t.includes("x")) && !o.includes("x"), a = v(t), r = v(o), i = {};
	if (a && (i.enable = a), r && (i.disable = r), e.endsWith(")")) return n.replaceCurrentModX(s), I$1("flags", e, { flags: i });
	if (e.endsWith(":")) return n.pushModX(s), n.numOpenGroups++, f$1("group", e, { ...(a || r) && { flags: i } });
	throw new Error(`Unexpected flag modifier "${e}"`);
}
function j(e) {
	const n = /\(\*(?<name>[A-Za-z_]\w*)?(?:\[(?<tag>(?:[A-Za-z_]\w*)?)\])?(?:\{(?<args>[^}]*)\})?\)/.exec(e);
	if (!n) throw new Error(`Incomplete or invalid named callout "${e}"`);
	const { name: t, tag: o, args: s } = n.groups;
	if (!t) throw new Error(`Invalid named callout "${e}"`);
	if (o === "") throw new Error(`Named callout tag with empty value not allowed "${e}"`);
	const a = s ? s.split(",").filter((g) => g !== "").map((g) => /^[+-]?\d+$/.test(g) ? +g : g) : [], [r, i, l] = a, c = B$1.has(t) ? t.toLowerCase() : "custom";
	switch (c) {
		case "fail":
		case "mismatch":
		case "skip":
			if (a.length > 0) throw new Error(`Named callout arguments not allowed "${a}"`);
			break;
		case "error":
			if (a.length > 1) throw new Error(`Named callout allows only one argument "${a}"`);
			if (typeof r == "string") throw new Error(`Named callout argument must be a number "${r}"`);
			break;
		case "max":
			if (!a.length || a.length > 2) throw new Error(`Named callout must have one or two arguments "${a}"`);
			if (typeof r == "string" && !/^[A-Za-z_]\w*$/.test(r)) throw new Error(`Named callout argument one must be a tag or number "${r}"`);
			if (a.length === 2 && (typeof i == "number" || !/^[<>X]$/.test(i))) throw new Error(`Named callout optional argument two must be '<', '>', or 'X' "${i}"`);
			break;
		case "count":
		case "total_count":
			if (a.length > 1) throw new Error(`Named callout allows only one argument "${a}"`);
			if (a.length === 1 && (typeof r == "number" || !/^[<>X]$/.test(r))) throw new Error(`Named callout optional argument must be '<', '>', or 'X' "${r}"`);
			break;
		case "cmp":
			if (a.length !== 3) throw new Error(`Named callout must have three arguments "${a}"`);
			if (typeof r == "string" && !/^[A-Za-z_]\w*$/.test(r)) throw new Error(`Named callout argument one must be a tag or number "${r}"`);
			if (typeof i == "number" || !/^(?:[<>!=]=|[<>])$/.test(i)) throw new Error(`Named callout argument two must be '==', '!=', '>', '<', '>=', or '<=' "${i}"`);
			if (typeof l == "string" && !/^[A-Za-z_]\w*$/.test(l)) throw new Error(`Named callout argument three must be a tag or number "${l}"`);
			break;
		case "custom": throw new Error(`Undefined callout name "${t}"`);
		default: throw new Error(`Unexpected named callout kind "${c}"`);
	}
	return D$1(c, o ?? null, s?.split(",") ?? null, e);
}
function O$1(e) {
	let n = null, t, o;
	if (e[0] === "{") {
		const { minStr: s, maxStr: a } = /^\{(?<minStr>\d*)(?:,(?<maxStr>\d*))?/.exec(e).groups, r = 1e5;
		if (+s > r || a && +a > r) throw new Error("Quantifier value unsupported in Oniguruma");
		if (t = +s, o = a === void 0 ? +s : a === "" ? Infinity : +a, t > o && (n = "possessive", [t, o] = [o, t]), e.endsWith("?")) {
			if (n === "possessive") throw new Error("Unsupported possessive interval quantifier chain with \"?\"");
			n = "lazy";
		} else n || (n = "greedy");
	} else t = e[0] === "+" ? 1 : 0, o = e[0] === "?" ? 1 : Infinity, n = e[1] === "+" ? "possessive" : e[1] === "?" ? "lazy" : "greedy";
	return _$1(n, t, o, e);
}
function q(e) {
	const n = e[1].toLowerCase();
	return k$1({
		d: "digit",
		h: "hex",
		s: "space",
		w: "word"
	}[n], e, { negate: e[1] !== n });
}
function V$1(e) {
	const { p: n, neg: t, value: o } = /^\\(?<p>[pP])\{(?<neg>\^?)(?<value>[^}]+)/.exec(e).groups;
	return k$1("property", e, {
		value: o,
		negate: n === "P" && !t || n === "p" && !!t
	});
}
function v(e) {
	const n = {};
	return e.includes("i") && (n.ignoreCase = !0), e.includes("m") && (n.dotAll = !0), e.includes("x") && (n.extended = !0), Object.keys(n).length ? n : null;
}
function Y(e) {
	const n = {
		ignoreCase: !1,
		dotAll: !1,
		extended: !1,
		digitIsAscii: !1,
		posixIsAscii: !1,
		spaceIsAscii: !1,
		wordIsAscii: !1,
		textSegmentMode: null
	};
	for (let t = 0; t < e.length; t++) {
		const o = e[t];
		if (!"imxDPSWy".includes(o)) throw new Error(`Invalid flag "${o}"`);
		if (o === "y") {
			if (!/^y{[gw]}/.test(e.slice(t))) throw new Error("Invalid or unspecified flag \"y\" mode");
			n.textSegmentMode = e[t + 2] === "g" ? "grapheme" : "word", t += 3;
			continue;
		}
		n[{
			i: "ignoreCase",
			m: "dotAll",
			x: "extended",
			D: "digitIsAscii",
			P: "posixIsAscii",
			S: "spaceIsAscii",
			W: "wordIsAscii"
		}[o]] = !0;
	}
	return n;
}
function J$1(e) {
	if (/^(?:\\u(?!\p{AHex}{4})|\\x(?!\p{AHex}{1,2}|\{\p{AHex}{1,8}\}))/u.test(e)) throw new Error(`Incomplete or invalid escape "${e}"`);
	const n = e[2] === "{" ? /^\\x\{\s*(?<hex>\p{AHex}+)/u.exec(e).groups.hex : e.slice(2);
	return parseInt(n, 16);
}
function ee$1(e, n) {
	const { raw: t, inCharClass: o } = e, s = t.slice(1);
	if (!o && (s !== "0" && s.length === 1 || s[0] !== "0" && +s <= n)) return [A$1(t)];
	const a = [], r = s.match(/^[0-7]+|\d/g);
	for (let i = 0; i < r.length; i++) {
		const l = r[i];
		let c;
		if (i === 0 && l !== "8" && l !== "9") {
			if (c = parseInt(l, 8), c > 127) throw new Error(o$1`Octal encoded byte above 177 unsupported "${t}"`);
		} else c = r$2(l);
		a.push(d(c, (i === 0 ? "\\" : "") + l));
	}
	return a;
}
function te$1(e) {
	const n = [], t = new RegExp(y$1, "gy");
	let o;
	for (; o = t.exec(e);) {
		const s = o[0];
		if (s[0] === "{") {
			const a = /^\{(?<min>\d+),(?<max>\d+)\}\??$/.exec(s);
			if (a) {
				const { min: r, max: i } = a.groups;
				if (+r > +i && s.endsWith("?")) {
					t.lastIndex--, n.push(O$1(s.slice(0, -1)));
					continue;
				}
			}
		}
		n.push(O$1(s));
	}
	return n;
}
//#endregion
//#region node_modules/.pnpm/oniguruma-parser@0.12.1/node_modules/oniguruma-parser/dist/parser/node-utils.js
function o(e, t) {
	if (!Array.isArray(e.body)) throw new Error("Expected node with body array");
	if (e.body.length !== 1) return !1;
	const r = e.body[0];
	return !t || Object.keys(t).every((n) => t[n] === r[n]);
}
function s(e) {
	return y.has(e.type);
}
const y = new Set([
	"AbsenceFunction",
	"Backreference",
	"CapturingGroup",
	"Character",
	"CharacterClass",
	"CharacterSet",
	"Group",
	"Quantifier",
	"Subroutine"
]);
//#endregion
//#region node_modules/.pnpm/oniguruma-parser@0.12.1/node_modules/oniguruma-parser/dist/parser/parse.js
function J(e, r = {}) {
	const n = {
		flags: "",
		normalizeUnknownPropertyNames: !1,
		skipBackrefValidation: !1,
		skipLookbehindValidation: !1,
		skipPropertyNameValidation: !1,
		unicodePropertyMap: null,
		...r,
		rules: {
			captureGroup: !1,
			singleline: !1,
			...r.rules
		}
	}, t = M$1(e, {
		flags: n.flags,
		rules: {
			captureGroup: n.rules.captureGroup,
			singleline: n.rules.singleline
		}
	}), s = (p, N) => {
		const u = t.tokens[o.nextIndex];
		switch (o.parent = p, o.nextIndex++, u.type) {
			case "Alternator": return b();
			case "Assertion": return W(u);
			case "Backreference": return X(u, o);
			case "Character": return m(u.value, { useLastValid: !!N.isCheckingRangeEnd });
			case "CharacterClassHyphen": return ee(u, o, N);
			case "CharacterClassOpen": return re(u, o, N);
			case "CharacterSet": return ne(u, o);
			case "Directive": return I(u.kind, { flags: u.flags });
			case "GroupOpen": return te(u, o, N);
			case "NamedCallout": return U(u.kind, u.tag, u.arguments);
			case "Quantifier": return oe(u, o);
			case "Subroutine": return ae(u, o);
			default: throw new Error(`Unexpected token type "${u.type}"`);
		}
	}, o = {
		capturingGroups: [],
		hasNumberedRef: !1,
		namedGroupsByName: /* @__PURE__ */ new Map(),
		nextIndex: 0,
		normalizeUnknownPropertyNames: n.normalizeUnknownPropertyNames,
		parent: null,
		skipBackrefValidation: n.skipBackrefValidation,
		skipLookbehindValidation: n.skipLookbehindValidation,
		skipPropertyNameValidation: n.skipPropertyNameValidation,
		subroutines: [],
		tokens: t.tokens,
		unicodePropertyMap: n.unicodePropertyMap,
		walk: s
	}, i = B(T(t.flags));
	let d = i.body[0];
	for (; o.nextIndex < t.tokens.length;) {
		const p = s(d, {});
		p.type === "Alternative" ? (i.body.push(p), d = p) : d.body.push(p);
	}
	const { capturingGroups: a, hasNumberedRef: l, namedGroupsByName: c, subroutines: f } = o;
	if (l && c.size && !n.rules.captureGroup) throw new Error("Numbered backref/subroutine not allowed when using named capture");
	for (const { ref: p } of f) if (typeof p == "number") {
		if (p > a.length) throw new Error("Subroutine uses a group number that's not defined");
		p && (a[p - 1].isSubroutined = !0);
	} else if (c.has(p)) {
		if (c.get(p).length > 1) throw new Error(o$1`Subroutine uses a duplicate group name "\g<${p}>"`);
		c.get(p)[0].isSubroutined = !0;
	} else throw new Error(o$1`Subroutine uses a group name that's not defined "\g<${p}>"`);
	return i;
}
function W({ kind: e }) {
	return F(u({
		"^": "line_start",
		$: "line_end",
		"\\A": "string_start",
		"\\b": "word_boundary",
		"\\B": "word_boundary",
		"\\G": "search_start",
		"\\y": "text_segment_boundary",
		"\\Y": "text_segment_boundary",
		"\\z": "string_end",
		"\\Z": "string_end_newline"
	}[e], `Unexpected assertion kind "${e}"`), { negate: e === o$1`\B` || e === o$1`\Y` });
}
function X({ raw: e }, r) {
	const n = /^\\k[<']/.test(e), t = n ? e.slice(3, -1) : e.slice(1), s = (o, i = !1) => {
		const d = r.capturingGroups.length;
		let a = !1;
		if (o > d) if (r.skipBackrefValidation) a = !0;
		else throw new Error(`Not enough capturing groups defined to the left "${e}"`);
		return r.hasNumberedRef = !0, k(i ? d + 1 - o : o, { orphan: a });
	};
	if (n) {
		const o = /^(?<sign>-?)0*(?<num>[1-9]\d*)$/.exec(t);
		if (o) return s(+o.groups.num, !!o.groups.sign);
		if (/[-+]/.test(t)) throw new Error(`Invalid backref name "${e}"`);
		if (!r.namedGroupsByName.has(t)) throw new Error(`Group name not defined to the left "${e}"`);
		return k(t);
	}
	return s(+t);
}
function ee(e, r, n) {
	const { tokens: t, walk: s } = r, o = r.parent, i = o.body.at(-1), d = t[r.nextIndex];
	if (!n.isCheckingRangeEnd && i && i.type !== "CharacterClass" && i.type !== "CharacterClassRange" && d && d.type !== "CharacterClassOpen" && d.type !== "CharacterClassClose" && d.type !== "CharacterClassIntersector") {
		const a = s(o, {
			...n,
			isCheckingRangeEnd: !0
		});
		if (i.type === "Character" && a.type === "Character") return o.body.pop(), L(i, a);
		throw new Error("Invalid character class range");
	}
	return m(r$2("-"));
}
function re({ negate: e }, r, n) {
	const { tokens: t, walk: s } = r, o = t[r.nextIndex], i = [C()];
	let d = z(o);
	for (; d.type !== "CharacterClassClose";) {
		if (d.type === "CharacterClassIntersector") i.push(C()), r.nextIndex++;
		else {
			const l = i.at(-1);
			l.body.push(s(l, n));
		}
		d = z(t[r.nextIndex], o);
	}
	const a = C({ negate: e });
	return i.length === 1 ? a.body = i[0].body : (a.kind = "intersection", a.body = i.map((l) => l.body.length === 1 ? l.body[0] : l)), r.nextIndex++, a;
}
function ne({ kind: e, negate: r, value: n }, t) {
	const { normalizeUnknownPropertyNames: s, skipPropertyNameValidation: o, unicodePropertyMap: i$1 } = t;
	if (e === "property") {
		const d = w(n);
		if (i.has(d) && !i$1?.has(d)) e = "posix", n = d;
		else return Q(n, {
			negate: r,
			normalizeUnknownPropertyNames: s,
			skipPropertyNameValidation: o,
			unicodePropertyMap: i$1
		});
	}
	return e === "posix" ? R(n, { negate: r }) : E(e, { negate: r });
}
function te(e, r, n) {
	const { tokens: t, capturingGroups: s, namedGroupsByName: o, skipLookbehindValidation: i, walk: d } = r, a = ie(e), l = a.type === "AbsenceFunction", c = $(a), f = c && a.negate;
	if (a.type === "CapturingGroup" && (s.push(a), a.name && l$1(o, a.name, []).push(a)), l && n.isInAbsenceFunction) throw new Error("Nested absence function not supported by Oniguruma");
	let p = D(t[r.nextIndex]);
	for (; p.type !== "GroupClose";) {
		if (p.type === "Alternator") a.body.push(b()), r.nextIndex++;
		else {
			const N = a.body.at(-1), u = d(N, {
				...n,
				isInAbsenceFunction: n.isInAbsenceFunction || l,
				isInLookbehind: n.isInLookbehind || c,
				isInNegLookbehind: n.isInNegLookbehind || f
			});
			if (N.body.push(u), (c || n.isInLookbehind) && !i) {
				const v = "Lookbehind includes a pattern not allowed by Oniguruma";
				if (f || n.isInNegLookbehind) {
					if (M(u) || u.type === "CapturingGroup") throw new Error(v);
				} else if (M(u) || $(u) && u.negate) throw new Error(v);
			}
		}
		p = D(t[r.nextIndex]);
	}
	return r.nextIndex++, a;
}
function oe({ kind: e, min: r, max: n }, t) {
	const s$1 = t.parent, o = s$1.body.at(-1);
	if (!o || !s(o)) throw new Error("Quantifier requires a repeatable token");
	const i = _(e, r, n, o);
	return s$1.body.pop(), i;
}
function ae({ raw: e }, r) {
	const { capturingGroups: n, subroutines: t } = r;
	let s = e.slice(3, -1);
	const o = /^(?<sign>[-+]?)0*(?<num>[1-9]\d*)$/.exec(s);
	if (o) {
		const d = +o.groups.num, a = n.length;
		if (r.hasNumberedRef = !0, s = {
			"": d,
			"+": a + d,
			"-": a + 1 - d
		}[o.groups.sign], s < 1) throw new Error("Invalid subroutine number");
	} else s === "0" && (s = 0);
	const i = O(s);
	return t.push(i), i;
}
function G(e, r) {
	if (e !== "repeater") throw new Error(`Unexpected absence function kind "${e}"`);
	return {
		type: "AbsenceFunction",
		kind: e,
		body: h(r?.body)
	};
}
function b(e) {
	return {
		type: "Alternative",
		body: V(e?.body)
	};
}
function F(e, r) {
	const n = {
		type: "Assertion",
		kind: e
	};
	return (e === "word_boundary" || e === "text_segment_boundary") && (n.negate = !!r?.negate), n;
}
function k(e, r) {
	const n = !!r?.orphan;
	return {
		type: "Backreference",
		ref: e,
		...n && { orphan: n }
	};
}
function P(e, r) {
	const n = {
		name: void 0,
		isSubroutined: !1,
		...r
	};
	if (n.name !== void 0 && !se(n.name)) throw new Error(`Group name "${n.name}" invalid in Oniguruma`);
	return {
		type: "CapturingGroup",
		number: e,
		...n.name && { name: n.name },
		...n.isSubroutined && { isSubroutined: n.isSubroutined },
		body: h(r?.body)
	};
}
function m(e, r) {
	const n = {
		useLastValid: !1,
		...r
	};
	if (e > 1114111) {
		const t = e.toString(16);
		if (n.useLastValid) e = 1114111;
		else throw e > 1310719 ? /* @__PURE__ */ new Error(`Invalid code point out of range "\\x{${t}}"`) : /* @__PURE__ */ new Error(`Invalid code point out of range in JS "\\x{${t}}"`);
	}
	return {
		type: "Character",
		value: e
	};
}
function C(e) {
	const r = {
		kind: "union",
		negate: !1,
		...e
	};
	return {
		type: "CharacterClass",
		kind: r.kind,
		negate: r.negate,
		body: V(e?.body)
	};
}
function L(e, r) {
	if (r.value < e.value) throw new Error("Character class range out of order");
	return {
		type: "CharacterClassRange",
		min: e,
		max: r
	};
}
function E(e, r) {
	const n = !!r?.negate, t = {
		type: "CharacterSet",
		kind: e
	};
	return (e === "digit" || e === "hex" || e === "newline" || e === "space" || e === "word") && (t.negate = n), (e === "text_segment" || e === "newline" && !n) && (t.variableLength = !0), t;
}
function I(e, r = {}) {
	if (e === "keep") return {
		type: "Directive",
		kind: e
	};
	if (e === "flags") return {
		type: "Directive",
		kind: e,
		flags: u(r.flags)
	};
	throw new Error(`Unexpected directive kind "${e}"`);
}
function T(e) {
	return {
		type: "Flags",
		...e
	};
}
function A(e) {
	const r = e?.atomic, n = e?.flags;
	if (r && n) throw new Error("Atomic group cannot have flags");
	return {
		type: "Group",
		...r && { atomic: r },
		...n && { flags: n },
		body: h(e?.body)
	};
}
function K(e) {
	const r = {
		behind: !1,
		negate: !1,
		...e
	};
	return {
		type: "LookaroundAssertion",
		kind: r.behind ? "lookbehind" : "lookahead",
		negate: r.negate,
		body: h(e?.body)
	};
}
function U(e, r, n) {
	return {
		type: "NamedCallout",
		kind: e,
		tag: r,
		arguments: n
	};
}
function R(e, r) {
	const n = !!r?.negate;
	if (!i.has(e)) throw new Error(`Invalid POSIX class "${e}"`);
	return {
		type: "CharacterSet",
		kind: "posix",
		value: e,
		negate: n
	};
}
function _(e, r, n, t) {
	if (r > n) throw new Error("Invalid reversed quantifier range");
	return {
		type: "Quantifier",
		kind: e,
		min: r,
		max: n,
		body: t
	};
}
function B(e, r) {
	return {
		type: "Regex",
		body: h(r?.body),
		flags: e
	};
}
function O(e) {
	return {
		type: "Subroutine",
		ref: e
	};
}
function Q(e, r) {
	const n = {
		negate: !1,
		normalizeUnknownPropertyNames: !1,
		skipPropertyNameValidation: !1,
		unicodePropertyMap: null,
		...r
	};
	let t = n.unicodePropertyMap?.get(w(e));
	if (!t) {
		if (n.normalizeUnknownPropertyNames) t = de(e);
		else if (n.unicodePropertyMap && !n.skipPropertyNameValidation) throw new Error(o$1`Invalid Unicode property "\p{${e}}"`);
	}
	return {
		type: "CharacterSet",
		kind: "property",
		value: t ?? e,
		negate: n.negate
	};
}
function ie({ flags: e, kind: r, name: n, negate: t, number: s }) {
	switch (r) {
		case "absence_repeater": return G("repeater");
		case "atomic": return A({ atomic: !0 });
		case "capturing": return P(s, { name: n });
		case "group": return A({ flags: e });
		case "lookahead":
		case "lookbehind": return K({
			behind: r === "lookbehind",
			negate: t
		});
		default: throw new Error(`Unexpected group kind "${r}"`);
	}
}
function h(e) {
	if (e === void 0) e = [b()];
	else if (!Array.isArray(e) || !e.length || !e.every((r) => r.type === "Alternative")) throw new Error("Invalid body; expected array of one or more Alternative nodes");
	return e;
}
function V(e) {
	if (e === void 0) e = [];
	else if (!Array.isArray(e) || !e.every((r) => !!r.type)) throw new Error("Invalid body; expected array of nodes");
	return e;
}
function M(e) {
	return e.type === "LookaroundAssertion" && e.kind === "lookahead";
}
function $(e) {
	return e.type === "LookaroundAssertion" && e.kind === "lookbehind";
}
function se(e) {
	return /^[\p{Alpha}\p{Pc}][^)]*$/u.test(e);
}
function de(e) {
	return e.trim().replace(/[- _]+/g, "_").replace(/[A-Z][a-z]+(?=[A-Z])/g, "$&_").replace(/[A-Za-z]+/g, (r) => r[0].toUpperCase() + r.slice(1).toLowerCase());
}
function w(e) {
	return e.replace(/[- _]+/g, "").toLowerCase();
}
function z(e, r) {
	return u(e, `${r?.type === "Character" && r.value === 93 ? "Empty" : "Unclosed"} character class`);
}
function D(e) {
	return u(e, "Unclosed group");
}
//#endregion
//#region node_modules/.pnpm/oniguruma-parser@0.12.1/node_modules/oniguruma-parser/dist/traverser/traverse.js
function S(a, v, N = null) {
	function u$1(e, s) {
		for (let t = 0; t < e.length; t++) {
			const r = n(e[t], s, t, e);
			t = Math.max(-1, t + r);
		}
	}
	function n(e, s = null, t = null, r = null) {
		let i = 0, c = !1;
		const d = {
			node: e,
			parent: s,
			key: t,
			container: r,
			root: a,
			remove() {
				f(r).splice(Math.max(0, l(t) + i), 1), i--, c = !0;
			},
			removeAllNextSiblings() {
				return f(r).splice(l(t) + 1);
			},
			removeAllPrevSiblings() {
				const o = l(t) + i;
				return i -= o, f(r).splice(0, Math.max(0, o));
			},
			replaceWith(o, y = {}) {
				const b = !!y.traverse;
				r ? r[Math.max(0, l(t) + i)] = o : u(s, "Can't replace root node")[t] = o, b && n(o, s, t, r), c = !0;
			},
			replaceWithMultiple(o, y = {}) {
				const b = !!y.traverse;
				if (f(r).splice(Math.max(0, l(t) + i), 1, ...o), i += o.length - 1, b) {
					let g = 0;
					for (let x = 0; x < o.length; x++) g += n(o[x], s, l(t) + x + g, r);
				}
				c = !0;
			},
			skip() {
				c = !0;
			}
		}, { type: m } = e, h = v["*"], p = v[m], R = typeof h == "function" ? h : h?.enter, P = typeof p == "function" ? p : p?.enter;
		if (R?.(d, N), P?.(d, N), !c) switch (m) {
			case "AbsenceFunction":
			case "CapturingGroup":
			case "Group":
				u$1(e.body, e);
				break;
			case "Alternative":
			case "CharacterClass":
				u$1(e.body, e);
				break;
			case "Assertion":
			case "Backreference":
			case "Character":
			case "CharacterSet":
			case "Directive":
			case "Flags":
			case "NamedCallout":
			case "Subroutine": break;
			case "CharacterClassRange":
				n(e.min, e, "min"), n(e.max, e, "max");
				break;
			case "LookaroundAssertion":
				u$1(e.body, e);
				break;
			case "Quantifier":
				n(e.body, e, "body");
				break;
			case "Regex":
				u$1(e.body, e), n(e.flags, e, "flags");
				break;
			default: throw new Error(`Unexpected node type "${m}"`);
		}
		return p?.exit?.(d, N), h?.exit?.(d, N), i;
	}
	return n(a), a;
}
function f(a) {
	if (!Array.isArray(a)) throw new Error("Container expected");
	return a;
}
function l(a) {
	if (typeof a != "number") throw new Error("Numeric key expected");
	return a;
}
//#endregion
//#region node_modules/.pnpm/regex@6.1.0/node_modules/regex/src/utils-internals.js
const noncapturingDelim = String.raw`\(\?(?:[:=!>A-Za-z\-]|<[=!]|\(DEFINE\))`;
/**
Updates the array in place by incrementing each value greater than or equal to the threshold.
@param {Array<number>} arr
@param {number} threshold
*/
function incrementIfAtLeast$1(arr, threshold) {
	for (let i = 0; i < arr.length; i++) if (arr[i] >= threshold) arr[i]++;
}
/**
@param {string} str
@param {number} pos
@param {string} oldValue
@param {string} newValue
@returns {string}
*/
function spliceStr(str, pos, oldValue, newValue) {
	return str.slice(0, pos) + newValue + str.slice(pos + oldValue.length);
}
//#endregion
//#region node_modules/.pnpm/regex-utilities@2.3.0/node_modules/regex-utilities/src/index.js
const Context = Object.freeze({
	DEFAULT: "DEFAULT",
	CHAR_CLASS: "CHAR_CLASS"
});
/**
Replaces all unescaped instances of a regex pattern in the given context, using a replacement
string or callback.

Doesn't skip over complete multicharacter tokens (only `\` plus its folowing char) so must be used
with knowledge of what's safe to do given regex syntax. Assumes UnicodeSets-mode syntax.
@param {string} expression Search target
@param {string} needle Search as a regex pattern, with flags `su` applied
@param {string | (match: RegExpExecArray, details: {
context: 'DEFAULT' | 'CHAR_CLASS';
negated: boolean;
}) => string} replacement
@param {'DEFAULT' | 'CHAR_CLASS'} [context] All contexts if not specified
@returns {string} Updated expression
@example
const str = '.\\.\\\\.[[\\.].].';
replaceUnescaped(str, '\\.', '@');
// → '@\\.\\\\@[[\\.]@]@'
replaceUnescaped(str, '\\.', '@', Context.DEFAULT);
// → '@\\.\\\\@[[\\.].]@'
replaceUnescaped(str, '\\.', '@', Context.CHAR_CLASS);
// → '.\\.\\\\.[[\\.]@].'
*/
function replaceUnescaped(expression, needle, replacement, context) {
	const re = new RegExp(String.raw`${needle}|(?<$skip>\[\^?|\\?.)`, "gsu");
	const negated = [false];
	let numCharClassesOpen = 0;
	let result = "";
	for (const match of expression.matchAll(re)) {
		const { 0: m, groups: { $skip } } = match;
		if (!$skip && (!context || context === Context.DEFAULT === !numCharClassesOpen)) {
			if (replacement instanceof Function) result += replacement(match, {
				context: numCharClassesOpen ? Context.CHAR_CLASS : Context.DEFAULT,
				negated: negated[negated.length - 1]
			});
			else result += replacement;
			continue;
		}
		if (m[0] === "[") {
			numCharClassesOpen++;
			negated.push(m[1] === "^");
		} else if (m === "]" && numCharClassesOpen) {
			numCharClassesOpen--;
			negated.pop();
		}
		result += m;
	}
	return result;
}
/**
Runs a callback for each unescaped instance of a regex pattern in the given context.

Doesn't skip over complete multicharacter tokens (only `\` plus its folowing char) so must be used
with knowledge of what's safe to do given regex syntax. Assumes UnicodeSets-mode syntax.
@param {string} expression Search target
@param {string} needle Search as a regex pattern, with flags `su` applied
@param {(match: RegExpExecArray, details: {
context: 'DEFAULT' | 'CHAR_CLASS';
negated: boolean;
}) => void} callback
@param {'DEFAULT' | 'CHAR_CLASS'} [context] All contexts if not specified
*/
function forEachUnescaped(expression, needle, callback, context) {
	replaceUnescaped(expression, needle, callback, context);
}
/**
Returns a match object for the first unescaped instance of a regex pattern in the given context, or
`null`.

Doesn't skip over complete multicharacter tokens (only `\` plus its folowing char) so must be used
with knowledge of what's safe to do given regex syntax. Assumes UnicodeSets-mode syntax.
@param {string} expression Search target
@param {string} needle Search as a regex pattern, with flags `su` applied
@param {number} [pos] Offset to start the search
@param {'DEFAULT' | 'CHAR_CLASS'} [context] All contexts if not specified
@returns {RegExpExecArray | null}
*/
function execUnescaped(expression, needle, pos = 0, context) {
	if (!new RegExp(needle, "su").test(expression)) return null;
	const re = new RegExp(`${needle}|(?<$skip>\\\\?.)`, "gsu");
	re.lastIndex = pos;
	let numCharClassesOpen = 0;
	let match;
	while (match = re.exec(expression)) {
		const { 0: m, groups: { $skip } } = match;
		if (!$skip && (!context || context === Context.DEFAULT === !numCharClassesOpen)) return match;
		if (m === "[") numCharClassesOpen++;
		else if (m === "]" && numCharClassesOpen) numCharClassesOpen--;
		if (re.lastIndex == match.index) re.lastIndex++;
	}
	return null;
}
/**
Checks whether an unescaped instance of a regex pattern appears in the given context.

Doesn't skip over complete multicharacter tokens (only `\` plus its folowing char) so must be used
with knowledge of what's safe to do given regex syntax. Assumes UnicodeSets-mode syntax.
@param {string} expression Search target
@param {string} needle Search as a regex pattern, with flags `su` applied
@param {'DEFAULT' | 'CHAR_CLASS'} [context] All contexts if not specified
@returns {boolean} Whether the pattern was found
*/
function hasUnescaped(expression, needle, context) {
	return !!execUnescaped(expression, needle, 0, context);
}
/**
Extracts the full contents of a group (subpattern) from the given expression, accounting for
escaped characters, nested groups, and character classes. The group is identified by the position
where its contents start (the string index just after the group's opening delimiter). Returns the
rest of the string if the group is unclosed.

Assumes UnicodeSets-mode syntax.
@param {string} expression Search target
@param {number} contentsStartPos
@returns {string}
*/
function getGroupContents(expression, contentsStartPos) {
	const token = /\\?./gsu;
	token.lastIndex = contentsStartPos;
	let contentsEndPos = expression.length;
	let numCharClassesOpen = 0;
	let numGroupsOpen = 1;
	let match;
	while (match = token.exec(expression)) {
		const [m] = match;
		if (m === "[") numCharClassesOpen++;
		else if (!numCharClassesOpen) {
			if (m === "(") numGroupsOpen++;
			else if (m === ")") {
				numGroupsOpen--;
				if (!numGroupsOpen) {
					contentsEndPos = match.index;
					break;
				}
			}
		} else if (m === "]") numCharClassesOpen--;
	}
	return expression.slice(contentsStartPos, contentsEndPos);
}
//#endregion
//#region node_modules/.pnpm/regex@6.1.0/node_modules/regex/src/atomic.js
/**
@import {PluginData, PluginResult} from './regex.js';
*/
const atomicPluginToken = new RegExp(String.raw`(?<noncapturingStart>${noncapturingDelim})|(?<capturingStart>\((?:\?<[^>]+>)?)|\\?.`, "gsu");
/**
Apply transformations for atomic groups: `(?>…)`.
@param {string} expression
@param {PluginData} [data]
@returns {Required<PluginResult>}
*/
function atomic(expression, data) {
	const hiddenCaptures = data?.hiddenCaptures ?? [];
	let captureTransfers = data?.captureTransfers ?? /* @__PURE__ */ new Map();
	if (!/\(\?>/.test(expression)) return {
		pattern: expression,
		captureTransfers,
		hiddenCaptures
	};
	const aGDelim = "(?>";
	const emulatedAGDelim = "(?:(?=(";
	const captureNumMap = [0];
	const addedHiddenCaptures = [];
	let numCapturesBeforeAG = 0;
	let numAGs = 0;
	let aGPos = NaN;
	let hasProcessedAG;
	do {
		hasProcessedAG = false;
		let numCharClassesOpen = 0;
		let numGroupsOpenInAG = 0;
		let inAG = false;
		let match;
		atomicPluginToken.lastIndex = Number.isNaN(aGPos) ? 0 : aGPos + 7;
		while (match = atomicPluginToken.exec(expression)) {
			const { 0: m, index, groups: { capturingStart, noncapturingStart } } = match;
			if (m === "[") numCharClassesOpen++;
			else if (!numCharClassesOpen) {
				if (m === aGDelim && !inAG) {
					aGPos = index;
					inAG = true;
				} else if (inAG && noncapturingStart) numGroupsOpenInAG++;
				else if (capturingStart) if (inAG) numGroupsOpenInAG++;
				else {
					numCapturesBeforeAG++;
					captureNumMap.push(numCapturesBeforeAG + numAGs);
				}
				else if (m === ")" && inAG) {
					if (!numGroupsOpenInAG) {
						numAGs++;
						const addedCaptureNum = numCapturesBeforeAG + numAGs;
						expression = `${expression.slice(0, aGPos)}${emulatedAGDelim}${expression.slice(aGPos + 3, index)}))<$$${addedCaptureNum}>)${expression.slice(index + 1)}`;
						hasProcessedAG = true;
						addedHiddenCaptures.push(addedCaptureNum);
						incrementIfAtLeast$1(hiddenCaptures, addedCaptureNum);
						if (captureTransfers.size) {
							const newCaptureTransfers = /* @__PURE__ */ new Map();
							captureTransfers.forEach((from, to) => {
								newCaptureTransfers.set(to >= addedCaptureNum ? to + 1 : to, from.map((f) => f >= addedCaptureNum ? f + 1 : f));
							});
							captureTransfers = newCaptureTransfers;
						}
						break;
					}
					numGroupsOpenInAG--;
				}
			} else if (m === "]") numCharClassesOpen--;
		}
	} while (hasProcessedAG);
	hiddenCaptures.push(...addedHiddenCaptures);
	expression = replaceUnescaped(expression, String.raw`\\(?<backrefNum>[1-9]\d*)|<\$\$(?<wrappedBackrefNum>\d+)>`, ({ 0: m, groups: { backrefNum, wrappedBackrefNum } }) => {
		if (backrefNum) {
			const bNum = +backrefNum;
			if (bNum > captureNumMap.length - 1) throw new Error(`Backref "${m}" greater than number of captures`);
			return `\\${captureNumMap[bNum]}`;
		}
		return `\\${wrappedBackrefNum}`;
	}, Context.DEFAULT);
	return {
		pattern: expression,
		captureTransfers,
		hiddenCaptures
	};
}
const baseQuantifier = String.raw`(?:[?*+]|\{\d+(?:,\d*)?\})`;
const possessivePluginToken = new RegExp(String.raw`
\\(?: \d+
  | c[A-Za-z]
  | [gk]<[^>]+>
  | [pPu]\{[^\}]+\}
  | u[A-Fa-f\d]{4}
  | x[A-Fa-f\d]{2}
  )
| \((?: \? (?: [:=!>]
  | <(?:[=!]|[^>]+>)
  | [A-Za-z\-]+:
  | \(DEFINE\)
  ))?
| (?<qBase>${baseQuantifier})(?<qMod>[?+]?)(?<invalidQ>[?*+\{]?)
| \\?.
`.replace(/\s+/g, ""), "gsu");
/**
Transform posessive quantifiers into atomic groups. The posessessive quantifiers are:
`?+`, `*+`, `++`, `{N}+`, `{N,}+`, `{N,N}+`.
This follows Java, PCRE, Perl, and Python.
Possessive quantifiers in Oniguruma and Onigmo are only: `?+`, `*+`, `++`.
@param {string} expression
@returns {PluginResult}
*/
function possessive(expression) {
	if (!new RegExp(`${baseQuantifier}\\+`).test(expression)) return { pattern: expression };
	const openGroupIndices = [];
	let lastGroupIndex = null;
	let lastCharClassIndex = null;
	let lastToken = "";
	let numCharClassesOpen = 0;
	let match;
	possessivePluginToken.lastIndex = 0;
	while (match = possessivePluginToken.exec(expression)) {
		const { 0: m, index, groups: { qBase, qMod, invalidQ } } = match;
		if (m === "[") {
			if (!numCharClassesOpen) lastCharClassIndex = index;
			numCharClassesOpen++;
		} else if (m === "]") if (numCharClassesOpen) numCharClassesOpen--;
		else lastCharClassIndex = null;
		else if (!numCharClassesOpen) {
			if (qMod === "+" && lastToken && !lastToken.startsWith("(")) {
				if (invalidQ) throw new Error(`Invalid quantifier "${m}"`);
				let charsAdded = -1;
				if (/^\{\d+\}$/.test(qBase)) expression = spliceStr(expression, index + qBase.length, qMod, "");
				else {
					if (lastToken === ")" || lastToken === "]") {
						const nodeIndex = lastToken === ")" ? lastGroupIndex : lastCharClassIndex;
						if (nodeIndex === null) throw new Error(`Invalid unmatched "${lastToken}"`);
						expression = `${expression.slice(0, nodeIndex)}(?>${expression.slice(nodeIndex, index)}${qBase})${expression.slice(index + m.length)}`;
					} else expression = `${expression.slice(0, index - lastToken.length)}(?>${lastToken}${qBase})${expression.slice(index + m.length)}`;
					charsAdded += 4;
				}
				possessivePluginToken.lastIndex += charsAdded;
			} else if (m[0] === "(") openGroupIndices.push(index);
			else if (m === ")") lastGroupIndex = openGroupIndices.length ? openGroupIndices.pop() : null;
		}
		lastToken = m;
	}
	return { pattern: expression };
}
//#endregion
//#region node_modules/.pnpm/regex-recursion@6.0.2/node_modules/regex-recursion/src/index.js
const r$1 = String.raw;
const recursiveToken = r$1`\(\?R=(?<rDepth>[^\)]+)\)|${r$1`\\g<(?<gRNameOrNum>[^>&]+)&R=(?<gRDepth>[^>]+)>`}`;
const namedCaptureDelim = r$1`\(\?<(?![=!])(?<captureName>[^>]+)>`;
const captureDelim = r$1`${namedCaptureDelim}|(?<unnamed>\()(?!\?)`;
const token = new RegExp(r$1`${namedCaptureDelim}|${recursiveToken}|\(\?|\\?.`, "gsu");
const overlappingRecursionMsg = "Cannot use multiple overlapping recursions";
/**
@param {string} pattern
@param {{
flags?: string;
captureTransfers?: Map<number, Array<number>>;
hiddenCaptures?: Array<number>;
mode?: 'plugin' | 'external';
}} [data]
@returns {{
pattern: string;
captureTransfers: Map<number, Array<number>>;
hiddenCaptures: Array<number>;
}}
*/
function recursion(pattern, data) {
	const { hiddenCaptures, mode } = {
		hiddenCaptures: [],
		mode: "plugin",
		...data
	};
	let captureTransfers = data?.captureTransfers ?? /* @__PURE__ */ new Map();
	if (!new RegExp(recursiveToken, "su").test(pattern)) return {
		pattern,
		captureTransfers,
		hiddenCaptures
	};
	if (mode === "plugin" && hasUnescaped(pattern, r$1`\(\?\(DEFINE\)`, Context.DEFAULT)) throw new Error("DEFINE groups cannot be used with recursion");
	const addedHiddenCaptures = [];
	const hasNumberedBackref = hasUnescaped(pattern, r$1`\\[1-9]`, Context.DEFAULT);
	const groupContentsStartPos = /* @__PURE__ */ new Map();
	const openGroups = [];
	let hasRecursed = false;
	let numCharClassesOpen = 0;
	let numCapturesPassed = 0;
	let match;
	token.lastIndex = 0;
	while (match = token.exec(pattern)) {
		const { 0: m, groups: { captureName, rDepth, gRNameOrNum, gRDepth } } = match;
		if (m === "[") numCharClassesOpen++;
		else if (!numCharClassesOpen) {
			if (rDepth) {
				assertMaxInBounds(rDepth);
				if (hasRecursed) throw new Error(overlappingRecursionMsg);
				if (hasNumberedBackref) throw new Error(`${mode === "external" ? "Backrefs" : "Numbered backrefs"} cannot be used with global recursion`);
				const left = pattern.slice(0, match.index);
				const right = pattern.slice(token.lastIndex);
				if (hasUnescaped(right, recursiveToken, Context.DEFAULT)) throw new Error(overlappingRecursionMsg);
				const reps = +rDepth - 1;
				pattern = makeRecursive(left, right, reps, false, hiddenCaptures, addedHiddenCaptures, numCapturesPassed);
				captureTransfers = mapCaptureTransfers(captureTransfers, left, reps, addedHiddenCaptures.length, 0, numCapturesPassed);
				break;
			} else if (gRNameOrNum) {
				assertMaxInBounds(gRDepth);
				let isWithinReffedGroup = false;
				for (const g of openGroups) if (g.name === gRNameOrNum || g.num === +gRNameOrNum) {
					isWithinReffedGroup = true;
					if (g.hasRecursedWithin) throw new Error(overlappingRecursionMsg);
					break;
				}
				if (!isWithinReffedGroup) throw new Error(r$1`Recursive \g cannot be used outside the referenced group "${mode === "external" ? gRNameOrNum : r$1`\g<${gRNameOrNum}&R=${gRDepth}>`}"`);
				const startPos = groupContentsStartPos.get(gRNameOrNum);
				const groupContents = getGroupContents(pattern, startPos);
				if (hasNumberedBackref && hasUnescaped(groupContents, r$1`${namedCaptureDelim}|\((?!\?)`, Context.DEFAULT)) throw new Error(`${mode === "external" ? "Backrefs" : "Numbered backrefs"} cannot be used with recursion of capturing groups`);
				const groupContentsLeft = pattern.slice(startPos, match.index);
				const groupContentsRight = groupContents.slice(groupContentsLeft.length + m.length);
				const numAddedHiddenCapturesPreExpansion = addedHiddenCaptures.length;
				const reps = +gRDepth - 1;
				const expansion = makeRecursive(groupContentsLeft, groupContentsRight, reps, true, hiddenCaptures, addedHiddenCaptures, numCapturesPassed);
				captureTransfers = mapCaptureTransfers(captureTransfers, groupContentsLeft, reps, addedHiddenCaptures.length - numAddedHiddenCapturesPreExpansion, numAddedHiddenCapturesPreExpansion, numCapturesPassed);
				pattern = `${pattern.slice(0, startPos)}${expansion}${pattern.slice(startPos + groupContents.length)}`;
				token.lastIndex += expansion.length - m.length - groupContentsLeft.length - groupContentsRight.length;
				openGroups.forEach((g) => g.hasRecursedWithin = true);
				hasRecursed = true;
			} else if (captureName) {
				numCapturesPassed++;
				groupContentsStartPos.set(String(numCapturesPassed), token.lastIndex);
				groupContentsStartPos.set(captureName, token.lastIndex);
				openGroups.push({
					num: numCapturesPassed,
					name: captureName
				});
			} else if (m[0] === "(") {
				const isUnnamedCapture = m === "(";
				if (isUnnamedCapture) {
					numCapturesPassed++;
					groupContentsStartPos.set(String(numCapturesPassed), token.lastIndex);
				}
				openGroups.push(isUnnamedCapture ? { num: numCapturesPassed } : {});
			} else if (m === ")") openGroups.pop();
		} else if (m === "]") numCharClassesOpen--;
	}
	hiddenCaptures.push(...addedHiddenCaptures);
	return {
		pattern,
		captureTransfers,
		hiddenCaptures
	};
}
/**
@param {string} max
*/
function assertMaxInBounds(max) {
	const errMsg = `Max depth must be integer between 2 and 100; used ${max}`;
	if (!/^[1-9]\d*$/.test(max)) throw new Error(errMsg);
	max = +max;
	if (max < 2 || max > 100) throw new Error(errMsg);
}
/**
@param {string} left
@param {string} right
@param {number} reps
@param {boolean} isSubpattern
@param {Array<number>} hiddenCaptures
@param {Array<number>} addedHiddenCaptures
@param {number} numCapturesPassed
@returns {string}
*/
function makeRecursive(left, right, reps, isSubpattern, hiddenCaptures, addedHiddenCaptures, numCapturesPassed) {
	const namesInRecursed = /* @__PURE__ */ new Set();
	if (isSubpattern) forEachUnescaped(left + right, namedCaptureDelim, ({ groups: { captureName } }) => {
		namesInRecursed.add(captureName);
	}, Context.DEFAULT);
	const rest = [
		reps,
		isSubpattern ? namesInRecursed : null,
		hiddenCaptures,
		addedHiddenCaptures,
		numCapturesPassed
	];
	return `${left}${repeatWithDepth(`(?:${left}`, "forward", ...rest)}(?:)${repeatWithDepth(`${right})`, "backward", ...rest)}${right}`;
}
/**
@param {string} pattern
@param {'forward' | 'backward'} direction
@param {number} reps
@param {Set<string> | null} namesInRecursed
@param {Array<number>} hiddenCaptures
@param {Array<number>} addedHiddenCaptures
@param {number} numCapturesPassed
@returns {string}
*/
function repeatWithDepth(pattern, direction, reps, namesInRecursed, hiddenCaptures, addedHiddenCaptures, numCapturesPassed) {
	const startNum = 2;
	const getDepthNum = (i) => direction === "forward" ? i + startNum : reps - i + startNum - 1;
	let result = "";
	for (let i = 0; i < reps; i++) {
		const depthNum = getDepthNum(i);
		result += replaceUnescaped(pattern, r$1`${captureDelim}|\\k<(?<backref>[^>]+)>`, ({ 0: m, groups: { captureName, unnamed, backref } }) => {
			if (backref && namesInRecursed && !namesInRecursed.has(backref)) return m;
			const suffix = `_$${depthNum}`;
			if (unnamed || captureName) {
				const addedCaptureNum = numCapturesPassed + addedHiddenCaptures.length + 1;
				addedHiddenCaptures.push(addedCaptureNum);
				incrementIfAtLeast(hiddenCaptures, addedCaptureNum);
				return unnamed ? m : `(?<${captureName}${suffix}>`;
			}
			return r$1`\k<${backref}${suffix}>`;
		}, Context.DEFAULT);
	}
	return result;
}
/**
Updates the array in place by incrementing each value greater than or equal to the threshold.
@param {Array<number>} arr
@param {number} threshold
*/
function incrementIfAtLeast(arr, threshold) {
	for (let i = 0; i < arr.length; i++) if (arr[i] >= threshold) arr[i]++;
}
/**
@param {Map<number, Array<number>>} captureTransfers
@param {string} left
@param {number} reps
@param {number} numCapturesAddedInExpansion
@param {number} numAddedHiddenCapturesPreExpansion
@param {number} numCapturesPassed
@returns {Map<number, Array<number>>}
*/
function mapCaptureTransfers(captureTransfers, left, reps, numCapturesAddedInExpansion, numAddedHiddenCapturesPreExpansion, numCapturesPassed) {
	if (captureTransfers.size && numCapturesAddedInExpansion) {
		let numCapturesInLeft = 0;
		forEachUnescaped(left, captureDelim, () => numCapturesInLeft++, Context.DEFAULT);
		const recursionDelimCaptureNum = numCapturesPassed - numCapturesInLeft + numAddedHiddenCapturesPreExpansion;
		const newCaptureTransfers = /* @__PURE__ */ new Map();
		captureTransfers.forEach((from, to) => {
			const numCapturesInRight = (numCapturesAddedInExpansion - numCapturesInLeft * reps) / reps;
			const numCapturesAddedInLeft = numCapturesInLeft * reps;
			const newTo = to > recursionDelimCaptureNum + numCapturesInLeft ? to + numCapturesAddedInExpansion : to;
			const newFrom = [];
			for (const f of from) if (f <= recursionDelimCaptureNum) newFrom.push(f);
			else if (f > recursionDelimCaptureNum + numCapturesInLeft + numCapturesInRight) newFrom.push(f + numCapturesAddedInExpansion);
			else if (f <= recursionDelimCaptureNum + numCapturesInLeft) for (let i = 0; i <= reps; i++) newFrom.push(f + numCapturesInLeft * i);
			else for (let i = 0; i <= reps; i++) newFrom.push(f + numCapturesAddedInLeft + numCapturesInRight * i);
			newCaptureTransfers.set(newTo, newFrom);
		});
		return newCaptureTransfers;
	}
	return captureTransfers;
}
//#endregion
//#region node_modules/.pnpm/oniguruma-to-es@4.3.4/node_modules/oniguruma-to-es/dist/esm/index.js
var cp = String.fromCodePoint;
var r = String.raw;
var envFlags = {
	flagGroups: true,
	unicodeSets: true
};
envFlags.bugFlagVLiteralHyphenIsRange = envFlags.unicodeSets ? (() => {
	try {
		new RegExp(r`[\d\-a]`, "v");
	} catch {
		return true;
	}
	return false;
})() : false;
envFlags.bugNestedClassIgnoresNegation = envFlags.unicodeSets && (/* @__PURE__ */ new RegExp("[[^a]]", "v")).test("a");
function getNewCurrentFlags(current, { enable, disable }) {
	return {
		dotAll: !disable?.dotAll && !!(enable?.dotAll || current.dotAll),
		ignoreCase: !disable?.ignoreCase && !!(enable?.ignoreCase || current.ignoreCase)
	};
}
function getOrInsert(map, key, defaultValue) {
	if (!map.has(key)) map.set(key, defaultValue);
	return map.get(key);
}
function isMinTarget(target, min) {
	return EsVersion[target] >= EsVersion[min];
}
function throwIfNullish(value, msg) {
	if (value == null) throw new Error(msg ?? "Value expected");
	return value;
}
var EsVersion = {
	ES2025: 2025,
	ES2024: 2024,
	ES2018: 2018
};
var Target = (
/** @type {const} */
{
	auto: "auto",
	ES2025: "ES2025",
	ES2024: "ES2024",
	ES2018: "ES2018"
});
function getOptions(options = {}) {
	if ({}.toString.call(options) !== "[object Object]") throw new Error("Unexpected options");
	if (options.target !== void 0 && !Target[options.target]) throw new Error(`Unexpected target "${options.target}"`);
	const opts = {
		accuracy: "default",
		avoidSubclass: false,
		flags: "",
		global: false,
		hasIndices: false,
		lazyCompileLength: Infinity,
		target: "auto",
		verbose: false,
		...options,
		rules: {
			allowOrphanBackrefs: false,
			asciiWordBoundaries: false,
			captureGroup: false,
			recursionLimit: 20,
			singleline: false,
			...options.rules
		}
	};
	if (opts.target === "auto") opts.target = envFlags.flagGroups ? "ES2025" : envFlags.unicodeSets ? "ES2024" : "ES2018";
	return opts;
}
var asciiSpaceChar = "[	-\r ]";
var CharsWithoutIgnoreCaseExpansion = /* @__PURE__ */ new Set([cp(304), cp(305)]);
var defaultWordChar = r`[\p{L}\p{M}\p{N}\p{Pc}]`;
function getIgnoreCaseMatchChars(char) {
	if (CharsWithoutIgnoreCaseExpansion.has(char)) return [char];
	const set = /* @__PURE__ */ new Set();
	const lower = char.toLowerCase();
	const upper = lower.toUpperCase();
	const title = LowerToTitleCaseMap.get(lower);
	const altLower = LowerToAlternativeLowerCaseMap.get(lower);
	const altUpper = LowerToAlternativeUpperCaseMap.get(lower);
	if ([...upper].length === 1) set.add(upper);
	altUpper && set.add(altUpper);
	title && set.add(title);
	set.add(lower);
	altLower && set.add(altLower);
	return [...set];
}
var JsUnicodePropertyMap = /* @__PURE__ */ new Map(`C Other
Cc Control cntrl
Cf Format
Cn Unassigned
Co Private_Use
Cs Surrogate
L Letter
LC Cased_Letter
Ll Lowercase_Letter
Lm Modifier_Letter
Lo Other_Letter
Lt Titlecase_Letter
Lu Uppercase_Letter
M Mark Combining_Mark
Mc Spacing_Mark
Me Enclosing_Mark
Mn Nonspacing_Mark
N Number
Nd Decimal_Number digit
Nl Letter_Number
No Other_Number
P Punctuation punct
Pc Connector_Punctuation
Pd Dash_Punctuation
Pe Close_Punctuation
Pf Final_Punctuation
Pi Initial_Punctuation
Po Other_Punctuation
Ps Open_Punctuation
S Symbol
Sc Currency_Symbol
Sk Modifier_Symbol
Sm Math_Symbol
So Other_Symbol
Z Separator
Zl Line_Separator
Zp Paragraph_Separator
Zs Space_Separator
ASCII
ASCII_Hex_Digit AHex
Alphabetic Alpha
Any
Assigned
Bidi_Control Bidi_C
Bidi_Mirrored Bidi_M
Case_Ignorable CI
Cased
Changes_When_Casefolded CWCF
Changes_When_Casemapped CWCM
Changes_When_Lowercased CWL
Changes_When_NFKC_Casefolded CWKCF
Changes_When_Titlecased CWT
Changes_When_Uppercased CWU
Dash
Default_Ignorable_Code_Point DI
Deprecated Dep
Diacritic Dia
Emoji
Emoji_Component EComp
Emoji_Modifier EMod
Emoji_Modifier_Base EBase
Emoji_Presentation EPres
Extended_Pictographic ExtPict
Extender Ext
Grapheme_Base Gr_Base
Grapheme_Extend Gr_Ext
Hex_Digit Hex
IDS_Binary_Operator IDSB
IDS_Trinary_Operator IDST
ID_Continue IDC
ID_Start IDS
Ideographic Ideo
Join_Control Join_C
Logical_Order_Exception LOE
Lowercase Lower
Math
Noncharacter_Code_Point NChar
Pattern_Syntax Pat_Syn
Pattern_White_Space Pat_WS
Quotation_Mark QMark
Radical
Regional_Indicator RI
Sentence_Terminal STerm
Soft_Dotted SD
Terminal_Punctuation Term
Unified_Ideograph UIdeo
Uppercase Upper
Variation_Selector VS
White_Space space
XID_Continue XIDC
XID_Start XIDS`.split(/\s/).map((p) => [w(p), p]));
var LowerToAlternativeLowerCaseMap = /* @__PURE__ */ new Map([["s", cp(383)], [cp(383), "s"]]);
var LowerToAlternativeUpperCaseMap = /* @__PURE__ */ new Map([
	[cp(223), cp(7838)],
	[cp(107), cp(8490)],
	[cp(229), cp(8491)],
	[cp(969), cp(8486)]
]);
var LowerToTitleCaseMap = new Map([
	titleEntry(453),
	titleEntry(456),
	titleEntry(459),
	titleEntry(498),
	...titleRange(8072, 8079),
	...titleRange(8088, 8095),
	...titleRange(8104, 8111),
	titleEntry(8124),
	titleEntry(8140),
	titleEntry(8188)
]);
var PosixClassMap = /* @__PURE__ */ new Map([
	["alnum", r`[\p{Alpha}\p{Nd}]`],
	["alpha", r`\p{Alpha}`],
	["ascii", r`\p{ASCII}`],
	["blank", r`[\p{Zs}\t]`],
	["cntrl", r`\p{Cc}`],
	["digit", r`\p{Nd}`],
	["graph", r`[\P{space}&&\P{Cc}&&\P{Cn}&&\P{Cs}]`],
	["lower", r`\p{Lower}`],
	["print", r`[[\P{space}&&\P{Cc}&&\P{Cn}&&\P{Cs}]\p{Zs}]`],
	["punct", r`[\p{P}\p{S}]`],
	["space", r`\p{space}`],
	["upper", r`\p{Upper}`],
	["word", r`[\p{Alpha}\p{M}\p{Nd}\p{Pc}]`],
	["xdigit", r`\p{AHex}`]
]);
function range(start, end) {
	const range2 = [];
	for (let i = start; i <= end; i++) range2.push(i);
	return range2;
}
function titleEntry(codePoint) {
	const char = cp(codePoint);
	return [char.toLowerCase(), char];
}
function titleRange(start, end) {
	return range(start, end).map((codePoint) => titleEntry(codePoint));
}
var UnicodePropertiesWithSpecificCase = /* @__PURE__ */ new Set([
	"Lower",
	"Lowercase",
	"Upper",
	"Uppercase",
	"Ll",
	"Lowercase_Letter",
	"Lt",
	"Titlecase_Letter",
	"Lu",
	"Uppercase_Letter"
]);
function transform(ast, options) {
	const opts = {
		accuracy: "default",
		asciiWordBoundaries: false,
		avoidSubclass: false,
		bestEffortTarget: "ES2025",
		...options
	};
	addParentProperties(ast);
	const firstPassState = {
		accuracy: opts.accuracy,
		asciiWordBoundaries: opts.asciiWordBoundaries,
		avoidSubclass: opts.avoidSubclass,
		flagDirectivesByAlt: /* @__PURE__ */ new Map(),
		jsGroupNameMap: /* @__PURE__ */ new Map(),
		minTargetEs2024: isMinTarget(opts.bestEffortTarget, "ES2024"),
		passedLookbehind: false,
		strategy: null,
		subroutineRefMap: /* @__PURE__ */ new Map(),
		supportedGNodes: /* @__PURE__ */ new Set(),
		digitIsAscii: ast.flags.digitIsAscii,
		spaceIsAscii: ast.flags.spaceIsAscii,
		wordIsAscii: ast.flags.wordIsAscii
	};
	S(ast, FirstPassVisitor, firstPassState);
	const globalFlags = {
		dotAll: ast.flags.dotAll,
		ignoreCase: ast.flags.ignoreCase
	};
	const secondPassState = {
		currentFlags: globalFlags,
		prevFlags: null,
		globalFlags,
		groupOriginByCopy: /* @__PURE__ */ new Map(),
		groupsByName: /* @__PURE__ */ new Map(),
		multiplexCapturesToLeftByRef: /* @__PURE__ */ new Map(),
		openRefs: /* @__PURE__ */ new Map(),
		reffedNodesByReferencer: /* @__PURE__ */ new Map(),
		subroutineRefMap: firstPassState.subroutineRefMap
	};
	S(ast, SecondPassVisitor, secondPassState);
	S(ast, ThirdPassVisitor, {
		groupsByName: secondPassState.groupsByName,
		highestOrphanBackref: 0,
		numCapturesToLeft: 0,
		reffedNodesByReferencer: secondPassState.reffedNodesByReferencer
	});
	ast._originMap = secondPassState.groupOriginByCopy;
	ast._strategy = firstPassState.strategy;
	return ast;
}
var FirstPassVisitor = {
	AbsenceFunction({ node, parent, replaceWith }) {
		const { body, kind } = node;
		if (kind === "repeater") {
			const innerGroup = A();
			innerGroup.body[0].body.push(K({
				negate: true,
				body
			}), Q("Any"));
			const outerGroup = A();
			outerGroup.body[0].body.push(_("greedy", 0, Infinity, innerGroup));
			replaceWith(setParentDeep(outerGroup, parent), { traverse: true });
		} else throw new Error(`Unsupported absence function "(?~|"`);
	},
	Alternative: {
		enter({ node, parent, key }, { flagDirectivesByAlt }) {
			const flagDirectives = node.body.filter((el) => el.kind === "flags");
			for (let i = key + 1; i < parent.body.length; i++) {
				const forwardSiblingAlt = parent.body[i];
				getOrInsert(flagDirectivesByAlt, forwardSiblingAlt, []).push(...flagDirectives);
			}
		},
		exit({ node }, { flagDirectivesByAlt }) {
			if (flagDirectivesByAlt.get(node)?.length) {
				const flags = getCombinedFlagModsFromFlagNodes(flagDirectivesByAlt.get(node));
				if (flags) {
					const flagGroup = A({ flags });
					flagGroup.body[0].body = node.body;
					node.body = [setParentDeep(flagGroup, node)];
				}
			}
		}
	},
	Assertion({ node, parent, key, container, root, remove, replaceWith }, state) {
		const { kind, negate } = node;
		const { asciiWordBoundaries, avoidSubclass, supportedGNodes, wordIsAscii } = state;
		if (kind === "text_segment_boundary") throw new Error(`Unsupported text segment boundary "\\${negate ? "Y" : "y"}"`);
		else if (kind === "line_end") replaceWith(setParentDeep(K({ body: [b({ body: [F("string_end")] }), b({ body: [m(10)] })] }), parent));
		else if (kind === "line_start") replaceWith(setParentDeep(parseFragment(r`(?<=\A|\n(?!\z))`, { skipLookbehindValidation: true }), parent));
		else if (kind === "search_start") if (supportedGNodes.has(node)) {
			root.flags.sticky = true;
			remove();
		} else {
			const prev = container[key - 1];
			if (prev && isAlwaysNonZeroLength(prev)) replaceWith(setParentDeep(K({ negate: true }), parent));
			else if (avoidSubclass) throw new Error(r`Uses "\G" in a way that requires a subclass`);
			else {
				replaceWith(setParent(F("string_start"), parent));
				state.strategy = "clip_search";
			}
		}
		else if (kind === "string_end" || kind === "string_start") {} else if (kind === "string_end_newline") replaceWith(setParentDeep(parseFragment(r`(?=\n?\z)`), parent));
		else if (kind === "word_boundary") {
			if (!wordIsAscii && !asciiWordBoundaries) {
				const b = `(?:(?<=${defaultWordChar})(?!${defaultWordChar})|(?<!${defaultWordChar})(?=${defaultWordChar}))`;
				const B = `(?:(?<=${defaultWordChar})(?=${defaultWordChar})|(?<!${defaultWordChar})(?!${defaultWordChar}))`;
				replaceWith(setParentDeep(parseFragment(negate ? B : b), parent));
			}
		} else throw new Error(`Unexpected assertion kind "${kind}"`);
	},
	Backreference({ node }, { jsGroupNameMap }) {
		let { ref } = node;
		if (typeof ref === "string" && !isValidJsGroupName(ref)) {
			ref = getAndStoreJsGroupName(ref, jsGroupNameMap);
			node.ref = ref;
		}
	},
	CapturingGroup({ node }, { jsGroupNameMap, subroutineRefMap }) {
		let { name } = node;
		if (name && !isValidJsGroupName(name)) {
			name = getAndStoreJsGroupName(name, jsGroupNameMap);
			node.name = name;
		}
		subroutineRefMap.set(node.number, node);
		if (name) subroutineRefMap.set(name, node);
	},
	CharacterClassRange({ node, parent, replaceWith }) {
		if (parent.kind === "intersection") replaceWith(setParentDeep(C({ body: [node] }), parent), { traverse: true });
	},
	CharacterSet({ node, parent, replaceWith }, { accuracy, minTargetEs2024, digitIsAscii, spaceIsAscii, wordIsAscii }) {
		const { kind, negate, value } = node;
		if (digitIsAscii && (kind === "digit" || value === "digit")) {
			replaceWith(setParent(E("digit", { negate }), parent));
			return;
		}
		if (spaceIsAscii && (kind === "space" || value === "space")) {
			replaceWith(setParentDeep(setNegate(parseFragment(asciiSpaceChar), negate), parent));
			return;
		}
		if (wordIsAscii && (kind === "word" || value === "word")) {
			replaceWith(setParent(E("word", { negate }), parent));
			return;
		}
		if (kind === "any") replaceWith(setParent(Q("Any"), parent));
		else if (kind === "digit") replaceWith(setParent(Q("Nd", { negate }), parent));
		else if (kind === "dot") {} else if (kind === "text_segment") {
			if (accuracy === "strict") throw new Error(r`Use of "\X" requires non-strict accuracy`);
			const eBase = "\\p{Emoji}(?:\\p{EMod}|\\uFE0F\\u20E3?|[\\x{E0020}-\\x{E007E}]+\\x{E007F})?";
			const emoji = r`\p{RI}{2}|${eBase}(?:\u200D${eBase})*`;
			replaceWith(setParentDeep(parseFragment(r`(?>\r\n|${minTargetEs2024 ? r`\p{RGI_Emoji}` : emoji}|\P{M}\p{M}*)`, { skipPropertyNameValidation: true }), parent));
		} else if (kind === "hex") replaceWith(setParent(Q("AHex", { negate }), parent));
		else if (kind === "newline") replaceWith(setParentDeep(parseFragment(negate ? "[^\n]" : "(?>\r\n?|[\n\v\f\u2028\u2029])"), parent));
		else if (kind === "posix") if (!minTargetEs2024 && (value === "graph" || value === "print")) {
			if (accuracy === "strict") throw new Error(`POSIX class "${value}" requires min target ES2024 or non-strict accuracy`);
			let ascii = {
				graph: "!-~",
				print: " -~"
			}[value];
			if (negate) ascii = `\0-${cp(ascii.codePointAt(0) - 1)}${cp(ascii.codePointAt(2) + 1)}-\u{10FFFF}`;
			replaceWith(setParentDeep(parseFragment(`[${ascii}]`), parent));
		} else replaceWith(setParentDeep(setNegate(parseFragment(PosixClassMap.get(value)), negate), parent));
		else if (kind === "property") {
			if (!JsUnicodePropertyMap.has(w(value))) node.key = "sc";
		} else if (kind === "space") replaceWith(setParent(Q("space", { negate }), parent));
		else if (kind === "word") replaceWith(setParentDeep(setNegate(parseFragment(defaultWordChar), negate), parent));
		else throw new Error(`Unexpected character set kind "${kind}"`);
	},
	Directive({ node, parent, root, remove, replaceWith, removeAllPrevSiblings, removeAllNextSiblings }) {
		const { kind, flags } = node;
		if (kind === "flags") if (!flags.enable && !flags.disable) remove();
		else {
			const flagGroup = A({ flags });
			flagGroup.body[0].body = removeAllNextSiblings();
			replaceWith(setParentDeep(flagGroup, parent), { traverse: true });
		}
		else if (kind === "keep") {
			const firstAlt = root.body[0];
			const topLevel = root.body.length === 1 && o(firstAlt, { type: "Group" }) && firstAlt.body[0].body.length === 1 ? firstAlt.body[0] : root;
			if (parent.parent !== topLevel || topLevel.body.length > 1) throw new Error(r`Uses "\K" in a way that's unsupported`);
			const lookbehind = K({ behind: true });
			lookbehind.body[0].body = removeAllPrevSiblings();
			replaceWith(setParentDeep(lookbehind, parent));
		} else throw new Error(`Unexpected directive kind "${kind}"`);
	},
	Flags({ node, parent }) {
		if (node.posixIsAscii) throw new Error("Unsupported flag \"P\"");
		if (node.textSegmentMode === "word") throw new Error("Unsupported flag \"y{w}\"");
		[
			"digitIsAscii",
			"extended",
			"posixIsAscii",
			"spaceIsAscii",
			"wordIsAscii",
			"textSegmentMode"
		].forEach((f) => delete node[f]);
		Object.assign(node, {
			global: false,
			hasIndices: false,
			multiline: false,
			sticky: node.sticky ?? false
		});
		parent.options = {
			disable: {
				x: true,
				n: true
			},
			force: { v: true }
		};
	},
	Group({ node }) {
		if (!node.flags) return;
		const { enable, disable } = node.flags;
		enable?.extended && delete enable.extended;
		disable?.extended && delete disable.extended;
		enable?.dotAll && disable?.dotAll && delete enable.dotAll;
		enable?.ignoreCase && disable?.ignoreCase && delete enable.ignoreCase;
		enable && !Object.keys(enable).length && delete node.flags.enable;
		disable && !Object.keys(disable).length && delete node.flags.disable;
		!node.flags.enable && !node.flags.disable && delete node.flags;
	},
	LookaroundAssertion({ node }, state) {
		const { kind } = node;
		if (kind === "lookbehind") state.passedLookbehind = true;
	},
	NamedCallout({ node, parent, replaceWith }) {
		const { kind } = node;
		if (kind === "fail") replaceWith(setParentDeep(K({ negate: true }), parent));
		else throw new Error(`Unsupported named callout "(*${kind.toUpperCase()}"`);
	},
	Quantifier({ node }) {
		if (node.body.type === "Quantifier") {
			const group = A();
			group.body[0].body.push(node.body);
			node.body = setParentDeep(group, node);
		}
	},
	Regex: {
		enter({ node }, { supportedGNodes }) {
			const leadingGs = [];
			let hasAltWithLeadG = false;
			let hasAltWithoutLeadG = false;
			for (const alt of node.body) if (alt.body.length === 1 && alt.body[0].kind === "search_start") alt.body.pop();
			else {
				const leadingG = getLeadingG(alt.body);
				if (leadingG) {
					hasAltWithLeadG = true;
					Array.isArray(leadingG) ? leadingGs.push(...leadingG) : leadingGs.push(leadingG);
				} else hasAltWithoutLeadG = true;
			}
			if (hasAltWithLeadG && !hasAltWithoutLeadG) leadingGs.forEach((g) => supportedGNodes.add(g));
		},
		exit(_, { accuracy, passedLookbehind, strategy }) {
			if (accuracy === "strict" && passedLookbehind && strategy) throw new Error(r`Uses "\G" in a way that requires non-strict accuracy`);
		}
	},
	Subroutine({ node }, { jsGroupNameMap }) {
		let { ref } = node;
		if (typeof ref === "string" && !isValidJsGroupName(ref)) {
			ref = getAndStoreJsGroupName(ref, jsGroupNameMap);
			node.ref = ref;
		}
	}
};
var SecondPassVisitor = {
	Backreference({ node }, { multiplexCapturesToLeftByRef, reffedNodesByReferencer }) {
		const { orphan, ref } = node;
		if (!orphan) reffedNodesByReferencer.set(node, [...multiplexCapturesToLeftByRef.get(ref).map(({ node: node2 }) => node2)]);
	},
	CapturingGroup: {
		enter({ node, parent, replaceWith, skip }, { groupOriginByCopy, groupsByName, multiplexCapturesToLeftByRef, openRefs, reffedNodesByReferencer }) {
			const origin = groupOriginByCopy.get(node);
			if (origin && openRefs.has(node.number)) {
				const recursion2 = setParent(createRecursion(node.number), parent);
				reffedNodesByReferencer.set(recursion2, openRefs.get(node.number));
				replaceWith(recursion2);
				return;
			}
			openRefs.set(node.number, node);
			multiplexCapturesToLeftByRef.set(node.number, []);
			if (node.name) getOrInsert(multiplexCapturesToLeftByRef, node.name, []);
			const multiplexNodes = multiplexCapturesToLeftByRef.get(node.name ?? node.number);
			for (let i = 0; i < multiplexNodes.length; i++) {
				const multiplex = multiplexNodes[i];
				if (origin === multiplex.node || origin && origin === multiplex.origin || node === multiplex.origin) {
					multiplexNodes.splice(i, 1);
					break;
				}
			}
			multiplexCapturesToLeftByRef.get(node.number).push({
				node,
				origin
			});
			if (node.name) multiplexCapturesToLeftByRef.get(node.name).push({
				node,
				origin
			});
			if (node.name) {
				const groupsWithSameName = getOrInsert(groupsByName, node.name, /* @__PURE__ */ new Map());
				let hasDuplicateNameToRemove = false;
				if (origin) hasDuplicateNameToRemove = true;
				else for (const groupInfo of groupsWithSameName.values()) if (!groupInfo.hasDuplicateNameToRemove) {
					hasDuplicateNameToRemove = true;
					break;
				}
				groupsByName.get(node.name).set(node, {
					node,
					hasDuplicateNameToRemove
				});
			}
		},
		exit({ node }, { openRefs }) {
			openRefs.delete(node.number);
		}
	},
	Group: {
		enter({ node }, state) {
			state.prevFlags = state.currentFlags;
			if (node.flags) state.currentFlags = getNewCurrentFlags(state.currentFlags, node.flags);
		},
		exit(_, state) {
			state.currentFlags = state.prevFlags;
		}
	},
	Subroutine({ node, parent, replaceWith }, state) {
		const { isRecursive, ref } = node;
		if (isRecursive) {
			let reffed = parent;
			while (reffed = reffed.parent) if (reffed.type === "CapturingGroup" && (reffed.name === ref || reffed.number === ref)) break;
			state.reffedNodesByReferencer.set(node, reffed);
			return;
		}
		const reffedGroupNode = state.subroutineRefMap.get(ref);
		const isGlobalRecursion = ref === 0;
		const expandedSubroutine = isGlobalRecursion ? createRecursion(0) : cloneCapturingGroup(reffedGroupNode, state.groupOriginByCopy, null);
		let replacement = expandedSubroutine;
		if (!isGlobalRecursion) {
			const reffedGroupFlagMods = getCombinedFlagModsFromFlagNodes(getAllParents(reffedGroupNode, (p) => p.type === "Group" && !!p.flags));
			const reffedGroupFlags = reffedGroupFlagMods ? getNewCurrentFlags(state.globalFlags, reffedGroupFlagMods) : state.globalFlags;
			if (!areFlagsEqual(reffedGroupFlags, state.currentFlags)) {
				replacement = A({ flags: getFlagModsFromFlags(reffedGroupFlags) });
				replacement.body[0].body.push(expandedSubroutine);
			}
		}
		replaceWith(setParentDeep(replacement, parent), { traverse: !isGlobalRecursion });
	}
};
var ThirdPassVisitor = {
	Backreference({ node, parent, replaceWith }, state) {
		if (node.orphan) {
			state.highestOrphanBackref = Math.max(state.highestOrphanBackref, node.ref);
			return;
		}
		const participants = state.reffedNodesByReferencer.get(node).filter((reffed) => canParticipateWithNode(reffed, node));
		if (!participants.length) replaceWith(setParentDeep(K({ negate: true }), parent));
		else if (participants.length > 1) replaceWith(setParentDeep(A({
			atomic: true,
			body: participants.reverse().map((reffed) => b({ body: [k(reffed.number)] }))
		}), parent));
		else node.ref = participants[0].number;
	},
	CapturingGroup({ node }, state) {
		node.number = ++state.numCapturesToLeft;
		if (node.name) {
			if (state.groupsByName.get(node.name).get(node).hasDuplicateNameToRemove) delete node.name;
		}
	},
	Regex: { exit({ node }, state) {
		const numCapsNeeded = Math.max(state.highestOrphanBackref - state.numCapturesToLeft, 0);
		for (let i = 0; i < numCapsNeeded; i++) {
			const emptyCapture = P();
			node.body.at(-1).body.push(emptyCapture);
		}
	} },
	Subroutine({ node }, state) {
		if (!node.isRecursive || node.ref === 0) return;
		node.ref = state.reffedNodesByReferencer.get(node).number;
	}
};
function addParentProperties(root) {
	S(root, { "*"({ node, parent }) {
		node.parent = parent;
	} });
}
function areFlagsEqual(a, b) {
	return a.dotAll === b.dotAll && a.ignoreCase === b.ignoreCase;
}
function canParticipateWithNode(capture, node) {
	let rightmostPoint = node;
	do {
		if (rightmostPoint.type === "Regex") return false;
		if (rightmostPoint.type === "Alternative") continue;
		if (rightmostPoint === capture) return false;
		const kidsOfParent = getKids(rightmostPoint.parent);
		for (const kid of kidsOfParent) {
			if (kid === rightmostPoint) break;
			if (kid === capture || isAncestorOf(kid, capture)) return true;
		}
	} while (rightmostPoint = rightmostPoint.parent);
	throw new Error("Unexpected path");
}
function cloneCapturingGroup(obj, originMap, up, up2) {
	const store = Array.isArray(obj) ? [] : {};
	for (const [key, value] of Object.entries(obj)) if (key === "parent") store.parent = Array.isArray(up) ? up2 : up;
	else if (value && typeof value === "object") store[key] = cloneCapturingGroup(value, originMap, store, up);
	else {
		if (key === "type" && value === "CapturingGroup") originMap.set(store, originMap.get(obj) ?? obj);
		store[key] = value;
	}
	return store;
}
function createRecursion(ref) {
	const node = O(ref);
	node.isRecursive = true;
	return node;
}
function getAllParents(node, filterFn) {
	const results = [];
	while (node = node.parent) if (!filterFn || filterFn(node)) results.push(node);
	return results;
}
function getAndStoreJsGroupName(name, map) {
	if (map.has(name)) return map.get(name);
	const jsName = `$${map.size}_${name.replace(/^[^$_\p{IDS}]|[^$\u200C\u200D\p{IDC}]/gu, "_")}`;
	map.set(name, jsName);
	return jsName;
}
function getCombinedFlagModsFromFlagNodes(flagNodes) {
	const flagProps = ["dotAll", "ignoreCase"];
	const combinedFlags = {
		enable: {},
		disable: {}
	};
	flagNodes.forEach(({ flags }) => {
		flagProps.forEach((prop) => {
			if (flags.enable?.[prop]) {
				delete combinedFlags.disable[prop];
				combinedFlags.enable[prop] = true;
			}
			if (flags.disable?.[prop]) combinedFlags.disable[prop] = true;
		});
	});
	if (!Object.keys(combinedFlags.enable).length) delete combinedFlags.enable;
	if (!Object.keys(combinedFlags.disable).length) delete combinedFlags.disable;
	if (combinedFlags.enable || combinedFlags.disable) return combinedFlags;
	return null;
}
function getFlagModsFromFlags({ dotAll, ignoreCase }) {
	const mods = {};
	if (dotAll || ignoreCase) {
		mods.enable = {};
		dotAll && (mods.enable.dotAll = true);
		ignoreCase && (mods.enable.ignoreCase = true);
	}
	if (!dotAll || !ignoreCase) {
		mods.disable = {};
		!dotAll && (mods.disable.dotAll = true);
		!ignoreCase && (mods.disable.ignoreCase = true);
	}
	return mods;
}
function getKids(node) {
	if (!node) throw new Error("Node expected");
	const { body } = node;
	return Array.isArray(body) ? body : body ? [body] : null;
}
function getLeadingG(els) {
	const firstToConsider = els.find((el) => el.kind === "search_start" || isLoneGLookaround(el, { negate: false }) || !isAlwaysZeroLength(el));
	if (!firstToConsider) return null;
	if (firstToConsider.kind === "search_start") return firstToConsider;
	if (firstToConsider.type === "LookaroundAssertion") return firstToConsider.body[0].body[0];
	if (firstToConsider.type === "CapturingGroup" || firstToConsider.type === "Group") {
		const gNodesForGroup = [];
		for (const alt of firstToConsider.body) {
			const leadingG = getLeadingG(alt.body);
			if (!leadingG) return null;
			Array.isArray(leadingG) ? gNodesForGroup.push(...leadingG) : gNodesForGroup.push(leadingG);
		}
		return gNodesForGroup;
	}
	return null;
}
function isAncestorOf(node, descendant) {
	const kids = getKids(node) ?? [];
	for (const kid of kids) if (kid === descendant || isAncestorOf(kid, descendant)) return true;
	return false;
}
function isAlwaysZeroLength({ type }) {
	return type === "Assertion" || type === "Directive" || type === "LookaroundAssertion";
}
function isAlwaysNonZeroLength(node) {
	const types = [
		"Character",
		"CharacterClass",
		"CharacterSet"
	];
	return types.includes(node.type) || node.type === "Quantifier" && node.min && types.includes(node.body.type);
}
function isLoneGLookaround(node, options) {
	const opts = {
		negate: null,
		...options
	};
	return node.type === "LookaroundAssertion" && (opts.negate === null || node.negate === opts.negate) && node.body.length === 1 && o(node.body[0], {
		type: "Assertion",
		kind: "search_start"
	});
}
function isValidJsGroupName(name) {
	return /^[$_\p{IDS}][$\u200C\u200D\p{IDC}]*$/u.test(name);
}
function parseFragment(pattern, options) {
	const alts = J(pattern, {
		...options,
		unicodePropertyMap: JsUnicodePropertyMap
	}).body;
	if (alts.length > 1 || alts[0].body.length > 1) return A({ body: alts });
	return alts[0].body[0];
}
function setNegate(node, negate) {
	node.negate = negate;
	return node;
}
function setParent(node, parent) {
	node.parent = parent;
	return node;
}
function setParentDeep(node, parent) {
	addParentProperties(node);
	node.parent = parent;
	return node;
}
function generate(ast, options) {
	const opts = getOptions(options);
	const minTargetEs2024 = isMinTarget(opts.target, "ES2024");
	const minTargetEs2025 = isMinTarget(opts.target, "ES2025");
	const recursionLimit = opts.rules.recursionLimit;
	if (!Number.isInteger(recursionLimit) || recursionLimit < 2 || recursionLimit > 20) throw new Error("Invalid recursionLimit; use 2-20");
	let hasCaseInsensitiveNode = null;
	let hasCaseSensitiveNode = null;
	if (!minTargetEs2025) {
		const iStack = [ast.flags.ignoreCase];
		S(ast, FlagModifierVisitor, {
			getCurrentModI: () => iStack.at(-1),
			popModI() {
				iStack.pop();
			},
			pushModI(isIOn) {
				iStack.push(isIOn);
			},
			setHasCasedChar() {
				if (iStack.at(-1)) hasCaseInsensitiveNode = true;
				else hasCaseSensitiveNode = true;
			}
		});
	}
	const appliedGlobalFlags = {
		dotAll: ast.flags.dotAll,
		ignoreCase: !!((ast.flags.ignoreCase || hasCaseInsensitiveNode) && !hasCaseSensitiveNode)
	};
	let lastNode = ast;
	const state = {
		accuracy: opts.accuracy,
		appliedGlobalFlags,
		captureMap: /* @__PURE__ */ new Map(),
		currentFlags: {
			dotAll: ast.flags.dotAll,
			ignoreCase: ast.flags.ignoreCase
		},
		inCharClass: false,
		lastNode,
		originMap: ast._originMap,
		recursionLimit,
		useAppliedIgnoreCase: !!(!minTargetEs2025 && hasCaseInsensitiveNode && hasCaseSensitiveNode),
		useFlagMods: minTargetEs2025,
		useFlagV: minTargetEs2024,
		verbose: opts.verbose
	};
	function gen(node) {
		state.lastNode = lastNode;
		lastNode = node;
		return throwIfNullish(generator[node.type], `Unexpected node type "${node.type}"`)(node, state, gen);
	}
	const result = {
		pattern: ast.body.map(gen).join("|"),
		flags: gen(ast.flags),
		options: { ...ast.options }
	};
	if (!minTargetEs2024) {
		delete result.options.force.v;
		result.options.disable.v = true;
		result.options.unicodeSetsPlugin = null;
	}
	result._captureTransfers = /* @__PURE__ */ new Map();
	result._hiddenCaptures = [];
	state.captureMap.forEach((value, key) => {
		if (value.hidden) result._hiddenCaptures.push(key);
		if (value.transferTo) getOrInsert(result._captureTransfers, value.transferTo, []).push(key);
	});
	return result;
}
var FlagModifierVisitor = {
	"*": {
		enter({ node }, state) {
			if (isAnyGroup(node)) {
				const currentModI = state.getCurrentModI();
				state.pushModI(node.flags ? getNewCurrentFlags({ ignoreCase: currentModI }, node.flags).ignoreCase : currentModI);
			}
		},
		exit({ node }, state) {
			if (isAnyGroup(node)) state.popModI();
		}
	},
	Backreference(_, state) {
		state.setHasCasedChar();
	},
	Character({ node }, state) {
		if (charHasCase(cp(node.value))) state.setHasCasedChar();
	},
	CharacterClassRange({ node, skip }, state) {
		skip();
		if (getCasesOutsideCharClassRange(node, { firstOnly: true }).length) state.setHasCasedChar();
	},
	CharacterSet({ node }, state) {
		if (node.kind === "property" && UnicodePropertiesWithSpecificCase.has(node.value)) state.setHasCasedChar();
	}
};
var generator = {
	Alternative({ body }, _, gen) {
		return body.map(gen).join("");
	},
	Assertion({ kind, negate }) {
		if (kind === "string_end") return "$";
		if (kind === "string_start") return "^";
		if (kind === "word_boundary") return negate ? r`\B` : r`\b`;
		throw new Error(`Unexpected assertion kind "${kind}"`);
	},
	Backreference({ ref }, state) {
		if (typeof ref !== "number") throw new Error("Unexpected named backref in transformed AST");
		if (!state.useFlagMods && state.accuracy === "strict" && state.currentFlags.ignoreCase && !state.captureMap.get(ref).ignoreCase) throw new Error("Use of case-insensitive backref to case-sensitive group requires target ES2025 or non-strict accuracy");
		return "\\" + ref;
	},
	CapturingGroup(node, state, gen) {
		const { body, name, number } = node;
		const data = { ignoreCase: state.currentFlags.ignoreCase };
		const origin = state.originMap.get(node);
		if (origin) {
			data.hidden = true;
			if (number > origin.number) data.transferTo = origin.number;
		}
		state.captureMap.set(number, data);
		return `(${name ? `?<${name}>` : ""}${body.map(gen).join("|")})`;
	},
	Character({ value }, state) {
		const char = cp(value);
		const escaped = getCharEscape(value, {
			escDigit: state.lastNode.type === "Backreference",
			inCharClass: state.inCharClass,
			useFlagV: state.useFlagV
		});
		if (escaped !== char) return escaped;
		if (state.useAppliedIgnoreCase && state.currentFlags.ignoreCase && charHasCase(char)) {
			const cases = getIgnoreCaseMatchChars(char);
			return state.inCharClass ? cases.join("") : cases.length > 1 ? `[${cases.join("")}]` : cases[0];
		}
		return char;
	},
	CharacterClass(node, state, gen) {
		const { kind, negate, parent } = node;
		let { body } = node;
		if (kind === "intersection" && !state.useFlagV) throw new Error("Use of character class intersection requires min target ES2024");
		if (envFlags.bugFlagVLiteralHyphenIsRange && state.useFlagV && body.some(isLiteralHyphen)) body = [m(45), ...body.filter((kid) => !isLiteralHyphen(kid))];
		const genClass = () => `[${negate ? "^" : ""}${body.map(gen).join(kind === "intersection" ? "&&" : "")}]`;
		if (!state.inCharClass) {
			if ((!state.useFlagV || envFlags.bugNestedClassIgnoresNegation) && !negate) {
				const negatedChildClasses = body.filter((kid) => kid.type === "CharacterClass" && kid.kind === "union" && kid.negate);
				if (negatedChildClasses.length) {
					const group = A();
					const groupFirstAlt = group.body[0];
					group.parent = parent;
					groupFirstAlt.parent = group;
					body = body.filter((kid) => !negatedChildClasses.includes(kid));
					node.body = body;
					if (body.length) {
						node.parent = groupFirstAlt;
						groupFirstAlt.body.push(node);
					} else group.body.pop();
					negatedChildClasses.forEach((cc) => {
						const newAlt = b({ body: [cc] });
						cc.parent = newAlt;
						newAlt.parent = group;
						group.body.push(newAlt);
					});
					return gen(group);
				}
			}
			state.inCharClass = true;
			const result = genClass();
			state.inCharClass = false;
			return result;
		}
		const firstEl = body[0];
		if (kind === "union" && !negate && firstEl && ((!state.useFlagV || !state.verbose) && parent.kind === "union" && !(envFlags.bugFlagVLiteralHyphenIsRange && state.useFlagV) || !state.verbose && parent.kind === "intersection" && body.length === 1 && firstEl.type !== "CharacterClassRange")) return body.map(gen).join("");
		if (!state.useFlagV && parent.type === "CharacterClass") throw new Error("Uses nested character class in a way that requires min target ES2024");
		return genClass();
	},
	CharacterClassRange(node, state) {
		const min = node.min.value;
		const max = node.max.value;
		const escOpts = {
			escDigit: false,
			inCharClass: true,
			useFlagV: state.useFlagV
		};
		const minStr = getCharEscape(min, escOpts);
		const maxStr = getCharEscape(max, escOpts);
		const extraChars = /* @__PURE__ */ new Set();
		if (state.useAppliedIgnoreCase && state.currentFlags.ignoreCase) getCodePointRangesFromChars(getCasesOutsideCharClassRange(node)).forEach((value) => {
			extraChars.add(Array.isArray(value) ? `${getCharEscape(value[0], escOpts)}-${getCharEscape(value[1], escOpts)}` : getCharEscape(value, escOpts));
		});
		return `${minStr}-${maxStr}${[...extraChars].join("")}`;
	},
	CharacterSet({ kind, negate, value, key }, state) {
		if (kind === "dot") return state.currentFlags.dotAll ? state.appliedGlobalFlags.dotAll || state.useFlagMods ? "." : "[^]" : r`[^\n]`;
		if (kind === "digit") return negate ? r`\D` : r`\d`;
		if (kind === "property") {
			if (state.useAppliedIgnoreCase && state.currentFlags.ignoreCase && UnicodePropertiesWithSpecificCase.has(value)) throw new Error(`Unicode property "${value}" can't be case-insensitive when other chars have specific case`);
			return `${negate ? r`\P` : r`\p`}{${key ? `${key}=` : ""}${value}}`;
		}
		if (kind === "word") return negate ? r`\W` : r`\w`;
		throw new Error(`Unexpected character set kind "${kind}"`);
	},
	Flags(node, state) {
		return (state.appliedGlobalFlags.ignoreCase ? "i" : "") + (node.dotAll ? "s" : "") + (node.sticky ? "y" : "");
	},
	Group({ atomic: atomic2, body, flags, parent }, state, gen) {
		const currentFlags = state.currentFlags;
		if (flags) state.currentFlags = getNewCurrentFlags(currentFlags, flags);
		const contents = body.map(gen).join("|");
		const result = !state.verbose && body.length === 1 && parent.type !== "Quantifier" && !atomic2 && (!state.useFlagMods || !flags) ? contents : `(?${getGroupPrefix(atomic2, flags, state.useFlagMods)}${contents})`;
		state.currentFlags = currentFlags;
		return result;
	},
	LookaroundAssertion({ body, kind, negate }, _, gen) {
		return `(?${`${kind === "lookahead" ? "" : "<"}${negate ? "!" : "="}`}${body.map(gen).join("|")})`;
	},
	Quantifier(node, _, gen) {
		return gen(node.body) + getQuantifierStr(node);
	},
	Subroutine({ isRecursive, ref }, state) {
		if (!isRecursive) throw new Error("Unexpected non-recursive subroutine in transformed AST");
		const limit = state.recursionLimit;
		return ref === 0 ? `(?R=${limit})` : r`\g<${ref}&R=${limit}>`;
	}
};
var BaseEscapeChars = /* @__PURE__ */ new Set([
	"$",
	"(",
	")",
	"*",
	"+",
	".",
	"?",
	"[",
	"\\",
	"]",
	"^",
	"{",
	"|",
	"}"
]);
var CharClassEscapeChars = /* @__PURE__ */ new Set([
	"-",
	"\\",
	"]",
	"^",
	"["
]);
var CharClassEscapeCharsFlagV = /* @__PURE__ */ new Set([
	"(",
	")",
	"-",
	"/",
	"[",
	"\\",
	"]",
	"^",
	"{",
	"|",
	"}",
	"!",
	"#",
	"$",
	"%",
	"&",
	"*",
	"+",
	",",
	".",
	":",
	";",
	"<",
	"=",
	">",
	"?",
	"@",
	"`",
	"~"
]);
var CharCodeEscapeMap = /* @__PURE__ */ new Map([
	[9, r`\t`],
	[10, r`\n`],
	[11, r`\v`],
	[12, r`\f`],
	[13, r`\r`],
	[8232, r`\u2028`],
	[8233, r`\u2029`],
	[65279, r`\uFEFF`]
]);
var casedRe = /^\p{Cased}$/u;
function charHasCase(char) {
	return casedRe.test(char);
}
function getCasesOutsideCharClassRange(node, options) {
	const firstOnly = !!options?.firstOnly;
	const min = node.min.value;
	const max = node.max.value;
	const found = [];
	if (min < 65 && (max === 65535 || max >= 131071) || min === 65536 && max >= 131071) return found;
	for (let i = min; i <= max; i++) {
		const char = cp(i);
		if (!charHasCase(char)) continue;
		const charsOutsideRange = getIgnoreCaseMatchChars(char).filter((caseOfChar) => {
			const num = caseOfChar.codePointAt(0);
			return num < min || num > max;
		});
		if (charsOutsideRange.length) {
			found.push(...charsOutsideRange);
			if (firstOnly) break;
		}
	}
	return found;
}
function getCharEscape(codePoint, { escDigit, inCharClass, useFlagV }) {
	if (CharCodeEscapeMap.has(codePoint)) return CharCodeEscapeMap.get(codePoint);
	if (codePoint < 32 || codePoint > 126 && codePoint < 160 || codePoint > 262143 || escDigit && isDigitCharCode(codePoint)) return codePoint > 255 ? `\\u{${codePoint.toString(16).toUpperCase()}}` : `\\x${codePoint.toString(16).toUpperCase().padStart(2, "0")}`;
	const escapeChars = inCharClass ? useFlagV ? CharClassEscapeCharsFlagV : CharClassEscapeChars : BaseEscapeChars;
	const char = cp(codePoint);
	return (escapeChars.has(char) ? "\\" : "") + char;
}
function getCodePointRangesFromChars(chars) {
	const codePoints = chars.map((char) => char.codePointAt(0)).sort((a, b) => a - b);
	const values = [];
	let start = null;
	for (let i = 0; i < codePoints.length; i++) if (codePoints[i + 1] === codePoints[i] + 1) start ??= codePoints[i];
	else if (start === null) values.push(codePoints[i]);
	else {
		values.push([start, codePoints[i]]);
		start = null;
	}
	return values;
}
function getGroupPrefix(atomic2, flagMods, useFlagMods) {
	if (atomic2) return ">";
	let mods = "";
	if (flagMods && useFlagMods) {
		const { enable, disable } = flagMods;
		mods = (enable?.ignoreCase ? "i" : "") + (enable?.dotAll ? "s" : "") + (disable ? "-" : "") + (disable?.ignoreCase ? "i" : "") + (disable?.dotAll ? "s" : "");
	}
	return `${mods}:`;
}
function getQuantifierStr({ kind, max, min }) {
	let base;
	if (!min && max === 1) base = "?";
	else if (!min && max === Infinity) base = "*";
	else if (min === 1 && max === Infinity) base = "+";
	else if (min === max) base = `{${min}}`;
	else base = `{${min},${max === Infinity ? "" : max}}`;
	return base + {
		greedy: "",
		lazy: "?",
		possessive: "+"
	}[kind];
}
function isAnyGroup({ type }) {
	return type === "CapturingGroup" || type === "Group" || type === "LookaroundAssertion";
}
function isDigitCharCode(value) {
	return value > 47 && value < 58;
}
function isLiteralHyphen({ type, value }) {
	return type === "Character" && value === 45;
}
var EmulatedRegExp = class _EmulatedRegExp extends RegExp {
	/**
	@type {Map<number, {
	hidden?: true;
	transferTo?: number;
	}>}
	*/
	#captureMap = /* @__PURE__ */ new Map();
	/**
	@type {RegExp | EmulatedRegExp | null}
	*/
	#compiled = null;
	/**
	@type {string}
	*/
	#pattern;
	/**
	@type {Map<number, string>?}
	*/
	#nameMap = null;
	/**
	@type {string?}
	*/
	#strategy = null;
	/**
	Can be used to serialize the instance.
	@type {EmulatedRegExpOptions}
	*/
	rawOptions = {};
	get source() {
		return this.#pattern || "(?:)";
	}
	/**
	@overload
	@param {string} pattern
	@param {string} [flags]
	@param {EmulatedRegExpOptions} [options]
	*/
	/**
	@overload
	@param {EmulatedRegExp} pattern
	@param {string} [flags]
	*/
	constructor(pattern, flags, options) {
		const lazyCompile = !!options?.lazyCompile;
		if (pattern instanceof RegExp) {
			if (options) throw new Error("Cannot provide options when copying a regexp");
			const re = pattern;
			super(re, flags);
			this.#pattern = re.source;
			if (re instanceof _EmulatedRegExp) {
				this.#captureMap = re.#captureMap;
				this.#nameMap = re.#nameMap;
				this.#strategy = re.#strategy;
				this.rawOptions = re.rawOptions;
			}
		} else {
			const opts = {
				hiddenCaptures: [],
				strategy: null,
				transfers: [],
				...options
			};
			super(lazyCompile ? "" : pattern, flags);
			this.#pattern = pattern;
			this.#captureMap = createCaptureMap(opts.hiddenCaptures, opts.transfers);
			this.#strategy = opts.strategy;
			this.rawOptions = options ?? {};
		}
		if (!lazyCompile) this.#compiled = this;
	}
	/**
	Called internally by all String/RegExp methods that use regexes.
	@override
	@param {string} str
	@returns {RegExpExecArray?}
	*/
	exec(str) {
		if (!this.#compiled) {
			const { lazyCompile, ...rest } = this.rawOptions;
			this.#compiled = new _EmulatedRegExp(this.#pattern, this.flags, rest);
		}
		const useLastIndex = this.global || this.sticky;
		const pos = this.lastIndex;
		if (this.#strategy === "clip_search" && useLastIndex && pos) {
			this.lastIndex = 0;
			const match = this.#execCore(str.slice(pos));
			if (match) {
				adjustMatchDetailsForOffset(match, pos, str, this.hasIndices);
				this.lastIndex += pos;
			}
			return match;
		}
		return this.#execCore(str);
	}
	/**
	Adds support for hidden and transfer captures.
	@param {string} str
	@returns
	*/
	#execCore(str) {
		this.#compiled.lastIndex = this.lastIndex;
		const match = super.exec.call(this.#compiled, str);
		this.lastIndex = this.#compiled.lastIndex;
		if (!match || !this.#captureMap.size) return match;
		const matchCopy = [...match];
		match.length = 1;
		let indicesCopy;
		if (this.hasIndices) {
			indicesCopy = [...match.indices];
			match.indices.length = 1;
		}
		const mappedNums = [0];
		for (let i = 1; i < matchCopy.length; i++) {
			const { hidden, transferTo } = this.#captureMap.get(i) ?? {};
			if (hidden) mappedNums.push(null);
			else {
				mappedNums.push(match.length);
				match.push(matchCopy[i]);
				if (this.hasIndices) match.indices.push(indicesCopy[i]);
			}
			if (transferTo && matchCopy[i] !== void 0) {
				const to = mappedNums[transferTo];
				if (!to) throw new Error(`Invalid capture transfer to "${to}"`);
				match[to] = matchCopy[i];
				if (this.hasIndices) match.indices[to] = indicesCopy[i];
				if (match.groups) {
					if (!this.#nameMap) this.#nameMap = createNameMap(this.source);
					const name = this.#nameMap.get(transferTo);
					if (name) {
						match.groups[name] = matchCopy[i];
						if (this.hasIndices) match.indices.groups[name] = indicesCopy[i];
					}
				}
			}
		}
		return match;
	}
};
function adjustMatchDetailsForOffset(match, offset, input, hasIndices) {
	match.index += offset;
	match.input = input;
	if (hasIndices) {
		const indices = match.indices;
		for (let i = 0; i < indices.length; i++) {
			const arr = indices[i];
			if (arr) indices[i] = [arr[0] + offset, arr[1] + offset];
		}
		const groupIndices = indices.groups;
		if (groupIndices) Object.keys(groupIndices).forEach((key) => {
			const arr = groupIndices[key];
			if (arr) groupIndices[key] = [arr[0] + offset, arr[1] + offset];
		});
	}
}
function createCaptureMap(hiddenCaptures, transfers) {
	const captureMap = /* @__PURE__ */ new Map();
	for (const num of hiddenCaptures) captureMap.set(num, { hidden: true });
	for (const [to, from] of transfers) for (const num of from) getOrInsert(captureMap, num, {}).transferTo = to;
	return captureMap;
}
function createNameMap(pattern) {
	const re = /(?<capture>\((?:\?<(?![=!])(?<name>[^>]+)>|(?!\?)))|\\?./gsu;
	const map = /* @__PURE__ */ new Map();
	let numCharClassesOpen = 0;
	let numCaptures = 0;
	let match;
	while (match = re.exec(pattern)) {
		const { 0: m, groups: { capture, name } } = match;
		if (m === "[") numCharClassesOpen++;
		else if (!numCharClassesOpen) {
			if (capture) {
				numCaptures++;
				if (name) map.set(numCaptures, name);
			}
		} else if (m === "]") numCharClassesOpen--;
	}
	return map;
}
function toRegExp(pattern, options) {
	const d = toRegExpDetails(pattern, options);
	if (d.options) return new EmulatedRegExp(d.pattern, d.flags, d.options);
	return new RegExp(d.pattern, d.flags);
}
function toRegExpDetails(pattern, options) {
	const opts = getOptions(options);
	const regexPlusAst = transform(J(pattern, {
		flags: opts.flags,
		normalizeUnknownPropertyNames: true,
		rules: {
			captureGroup: opts.rules.captureGroup,
			singleline: opts.rules.singleline
		},
		skipBackrefValidation: opts.rules.allowOrphanBackrefs,
		unicodePropertyMap: JsUnicodePropertyMap
	}), {
		accuracy: opts.accuracy,
		asciiWordBoundaries: opts.rules.asciiWordBoundaries,
		avoidSubclass: opts.avoidSubclass,
		bestEffortTarget: opts.target
	});
	const generated = generate(regexPlusAst, opts);
	const recursionResult = recursion(generated.pattern, {
		captureTransfers: generated._captureTransfers,
		hiddenCaptures: generated._hiddenCaptures,
		mode: "external"
	});
	const atomicResult = atomic(possessive(recursionResult.pattern).pattern, {
		captureTransfers: recursionResult.captureTransfers,
		hiddenCaptures: recursionResult.hiddenCaptures
	});
	const details = {
		pattern: atomicResult.pattern,
		flags: `${opts.hasIndices ? "d" : ""}${opts.global ? "g" : ""}${generated.flags}${generated.options.disable.v ? "u" : "v"}`
	};
	if (opts.avoidSubclass) {
		if (opts.lazyCompileLength !== Infinity) throw new Error("Lazy compilation requires subclass");
	} else {
		const hiddenCaptures = atomicResult.hiddenCaptures.sort((a, b) => a - b);
		const transfers = Array.from(atomicResult.captureTransfers);
		const strategy = regexPlusAst._strategy;
		const lazyCompile = details.pattern.length >= opts.lazyCompileLength;
		if (hiddenCaptures.length || transfers.length || strategy || lazyCompile) details.options = {
			...hiddenCaptures.length && { hiddenCaptures },
			...transfers.length && { transfers },
			...strategy && { strategy },
			...lazyCompile && { lazyCompile }
		};
	}
	return details;
}
//#endregion
//#region node_modules/.pnpm/@shikijs+engine-javascript@3.23.0/node_modules/@shikijs/engine-javascript/dist/shared/engine-javascript.hzpS1_41.mjs
const MAX = 4294967295;
var JavaScriptScanner = class {
	constructor(patterns, options = {}) {
		this.patterns = patterns;
		this.options = options;
		const { forgiving = false, cache, regexConstructor } = options;
		if (!regexConstructor) throw new Error("Option `regexConstructor` is not provided");
		this.regexps = patterns.map((p) => {
			if (typeof p !== "string") return p;
			const cached = cache?.get(p);
			if (cached) {
				if (cached instanceof RegExp) return cached;
				if (forgiving) return null;
				throw cached;
			}
			try {
				const regex = regexConstructor(p);
				cache?.set(p, regex);
				return regex;
			} catch (e) {
				cache?.set(p, e);
				if (forgiving) return null;
				throw e;
			}
		});
	}
	regexps;
	findNextMatchSync(string, startPosition, _options) {
		const str = typeof string === "string" ? string : string.content;
		const pending = [];
		function toResult(index, match, offset = 0) {
			return {
				index,
				captureIndices: match.indices.map((indice) => {
					if (indice == null) return {
						start: MAX,
						end: MAX,
						length: 0
					};
					return {
						start: indice[0] + offset,
						end: indice[1] + offset,
						length: indice[1] - indice[0]
					};
				})
			};
		}
		for (let i = 0; i < this.regexps.length; i++) {
			const regexp = this.regexps[i];
			if (!regexp) continue;
			try {
				regexp.lastIndex = startPosition;
				const match = regexp.exec(str);
				if (!match) continue;
				if (match.index === startPosition) return toResult(i, match, 0);
				pending.push([
					i,
					match,
					0
				]);
			} catch (e) {
				if (this.options.forgiving) continue;
				throw e;
			}
		}
		if (pending.length) {
			const minIndex = Math.min(...pending.map((m) => m[1].index));
			for (const [i, match, offset] of pending) if (match.index === minIndex) return toResult(i, match, offset);
		}
		return null;
	}
};
//#endregion
//#region node_modules/.pnpm/@shikijs+engine-javascript@3.23.0/node_modules/@shikijs/engine-javascript/dist/engine-compile.mjs
function defaultJavaScriptRegexConstructor(pattern, options) {
	return toRegExp(pattern, {
		global: true,
		hasIndices: true,
		lazyCompileLength: 3e3,
		rules: {
			allowOrphanBackrefs: true,
			asciiWordBoundaries: true,
			captureGroup: true,
			recursionLimit: 5,
			singleline: true
		},
		...options
	});
}
function createJavaScriptRegexEngine(options = {}) {
	const _options = Object.assign({
		target: "auto",
		cache: /* @__PURE__ */ new Map()
	}, options);
	_options.regexConstructor ||= (pattern) => defaultJavaScriptRegexConstructor(pattern, { target: _options.target });
	return {
		createScanner(patterns) {
			return new JavaScriptScanner(patterns, _options);
		},
		createString(s) {
			return { content: s };
		}
	};
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/highlighter/languages/resolveLanguage.js
async function resolveLanguage(lang) {
	if (isWorkerContext()) throw new Error(`resolveLanguage("${lang}") cannot be called from a worker context. Languages must be pre-resolved on the main thread and passed to the worker via the resolvedLanguages parameter.`);
	const resolver = ResolvingLanguages.get(lang);
	if (resolver != null) return resolver;
	try {
		const loader = bundledLanguages[lang];
		if (loader == null) throw new Error(`resolveLanguage: "${lang}" not found in bundled languages`);
		const resolver$1 = loader().then(({ default: data }) => {
			const resolvedLang = {
				name: lang,
				data
			};
			if (!ResolvedLanguages.has(lang)) ResolvedLanguages.set(lang, resolvedLang);
			return resolvedLang;
		});
		ResolvingLanguages.set(lang, resolver$1);
		return await resolver$1;
	} finally {
		ResolvingLanguages.delete(lang);
	}
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/highlighter/languages/getResolvedOrResolveLanguage.js
function getResolvedOrResolveLanguage(language) {
	return ResolvedLanguages.get(language) ?? resolveLanguage(language);
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/highlighter/themes/constants.js
const ResolvedThemes = /* @__PURE__ */ new Map();
const ResolvingThemes = /* @__PURE__ */ new Map();
const RegisteredCustomThemes = /* @__PURE__ */ new Map();
const AttachedThemes = /* @__PURE__ */ new Set();
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/highlighter/themes/attachResolvedThemes.js
function attachResolvedThemes(themes, highlighter) {
	themes = Array.isArray(themes) ? themes : [themes];
	for (let themeRef of themes) {
		let resolvedTheme;
		if (typeof themeRef === "string") {
			resolvedTheme = ResolvedThemes.get(themeRef);
			if (resolvedTheme == null) throw new Error(`loadResolvedThemes: ${themeRef} is not resolved, you must resolve it before calling loadResolvedThemes`);
		} else {
			resolvedTheme = themeRef;
			themeRef = themeRef.name;
			if (!ResolvedThemes.has(themeRef)) ResolvedThemes.set(themeRef, resolvedTheme);
		}
		if (AttachedThemes.has(themeRef)) continue;
		AttachedThemes.add(themeRef);
		highlighter.loadThemeSync(resolvedTheme);
	}
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/highlighter/themes/resolveTheme.js
async function resolveTheme(themeName) {
	if (isWorkerContext()) throw new Error(`resolveTheme("${themeName}") cannot be called from a worker context. Themes must be pre-resolved on the main thread and passed to the worker via the resolvedLanguages parameter.`);
	const resolver = ResolvingThemes.get(themeName);
	if (resolver != null) return resolver;
	try {
		const loader = RegisteredCustomThemes.get(themeName) ?? bundledThemes[themeName];
		if (loader == null) throw new Error(`resolveTheme: No valid loader for ${themeName}`);
		const resolver$1 = loader().then((result) => {
			return normalizeAndCacheResolvedTheme(themeName, "default" in result ? result.default : result);
		});
		ResolvingThemes.set(themeName, resolver$1);
		const theme = await resolver$1;
		if (theme.name !== themeName) throw new Error(`resolvedTheme: themeName: ${themeName} does not match theme.name: ${theme.name}`);
		ResolvedThemes.set(theme.name, theme);
		return theme;
	} finally {
		ResolvingThemes.delete(themeName);
	}
}
function normalizeAndCacheResolvedTheme(themeName, themeData) {
	const resolvedTheme = ResolvedThemes.get(themeName);
	if (resolvedTheme != null) return resolvedTheme;
	themeData = normalizeTheme$1(themeData);
	ResolvedThemes.set(themeName, themeData);
	return themeData;
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/highlighter/themes/getResolvedOrResolveTheme.js
function getResolvedOrResolveTheme(themeName) {
	return ResolvedThemes.get(themeName) ?? resolveTheme(themeName);
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/highlighter/themes/registerCustomTheme.js
function registerCustomTheme(themeName, loader) {
	if (RegisteredCustomThemes.has(themeName)) {
		console.error("SharedHighlight.registerCustomTheme: theme name already registered", themeName);
		return;
	}
	RegisteredCustomThemes.set(themeName, loader);
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/highlighter/shared_highlighter.js
let highlighter;
async function getSharedHighlighter({ themes, langs }) {
	highlighter ??= createHighlighter({
		themes: [],
		langs: ["text"],
		engine: createJavaScriptRegexEngine()
	});
	const instance = isHighlighterLoading(highlighter) ? await highlighter : highlighter;
	highlighter = instance;
	const languageLoaders = [];
	for (const language of langs) {
		if (language === "text" || language === "ansi") continue;
		const maybeResolvedLanguage = getResolvedOrResolveLanguage(language);
		if ("then" in maybeResolvedLanguage) languageLoaders.push(maybeResolvedLanguage);
		else attachResolvedLanguages(maybeResolvedLanguage, instance);
	}
	const themeLoaders = [];
	for (const themeName of themes) {
		const maybeResolvedTheme = getResolvedOrResolveTheme(themeName);
		if ("then" in maybeResolvedTheme) themeLoaders.push(maybeResolvedTheme);
		else attachResolvedThemes(maybeResolvedTheme, highlighter);
	}
	if (languageLoaders.length > 0 || themeLoaders.length > 0) await Promise.all([Promise.all(languageLoaders).then((languages) => {
		attachResolvedLanguages(languages, instance);
	}), Promise.all(themeLoaders).then((themes$1) => {
		attachResolvedThemes(themes$1, instance);
	})]);
	return instance;
}
function getHighlighterIfLoaded() {
	if (highlighter != null && !("then" in highlighter)) return highlighter;
}
function isHighlighterLoading(h = highlighter) {
	return h != null && "then" in h;
}
registerCustomTheme("pierre-dark", () => {
	return import("../../pierre-dark-CvX72CLs.js");
});
registerCustomTheme("pierre-light", () => {
	return import("../../pierre-light-DOfMInL_.js");
});
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/getThemes.js
function getThemes(theme = DEFAULT_THEMES) {
	const themesArr = [];
	if (typeof theme === "string") themesArr.push(theme);
	else {
		themesArr.push(theme.dark);
		themesArr.push(theme.light);
	}
	return themesArr;
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/highlighter/themes/areThemesAttached.js
function areThemesAttached(themes) {
	for (const theme of getThemes(themes)) if (!AttachedThemes.has(theme)) return false;
	return true;
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/areThemesEqual.js
function areThemesEqual(themeA, themeB) {
	if (themeA == null || themeB == null || typeof themeA === "string" || typeof themeB === "string") return themeA === themeB;
	return themeA.dark === themeB.dark && themeA.light === themeB.light;
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/hast_utils.js
function createTextNodeElement(value) {
	return {
		type: "text",
		value
	};
}
function createHastElement({ tagName, children = [], properties = {} }) {
	return {
		type: "element",
		tagName,
		properties,
		children
	};
}
function createIconElement({ name, width = 16, height = 16, properties }) {
	return createHastElement({
		tagName: "svg",
		properties: {
			width,
			height,
			viewBox: "0 0 16 16",
			...properties
		},
		children: [createHastElement({
			tagName: "use",
			properties: { href: `#${name.replace(/^#/, "")}` }
		})]
	});
}
function findCodeElement(nodes) {
	let firstChild = nodes.children[0];
	while (firstChild != null) {
		if (firstChild.type === "element" && firstChild.tagName === "code") return firstChild;
		if ("children" in firstChild) firstChild = firstChild.children[0];
		else firstChild = null;
	}
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/createAnnotationElement.js
function createAnnotationElement(span) {
	return createHastElement({
		tagName: "div",
		children: [createHastElement({
			tagName: "div",
			children: span.annotations?.map((slotId) => createHastElement({
				tagName: "slot",
				properties: { name: slotId }
			})),
			properties: { "data-annotation-content": "" }
		})],
		properties: { "data-line-annotation": `${span.hunkIndex},${span.lineIndex}` }
	});
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/getIconForType.js
function getIconForType(type) {
	switch (type) {
		case "file": return "diffs-icon-file-code";
		case "change": return "diffs-icon-symbol-modified";
		case "new": return "diffs-icon-symbol-added";
		case "deleted": return "diffs-icon-symbol-deleted";
		case "rename-pure":
		case "rename-changed": return "diffs-icon-symbol-moved";
	}
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/createFileHeaderElement.js
function createFileHeaderElement({ fileOrDiff, themeStyles, themeType }) {
	const fileDiff = "type" in fileOrDiff ? fileOrDiff : void 0;
	const properties = {
		"data-diffs-header": "",
		"data-change-type": fileDiff?.type,
		"data-theme-type": themeType !== "system" ? themeType : void 0,
		style: themeStyles
	};
	return createHastElement({
		tagName: "div",
		children: [createHeaderElement({
			name: fileOrDiff.name,
			prevName: "prevName" in fileOrDiff ? fileOrDiff.prevName : void 0,
			iconType: fileDiff?.type ?? "file"
		}), createMetadataElement(fileDiff)],
		properties
	});
}
function createHeaderElement({ name, prevName, iconType }) {
	const children = [createIconElement({
		name: getIconForType(iconType),
		properties: { "data-change-icon": iconType }
	})];
	if (prevName != null) {
		children.push(createHastElement({
			tagName: "div",
			children: [createTextNodeElement(prevName)],
			properties: { "data-prev-name": "" }
		}));
		children.push(createIconElement({
			name: "diffs-icon-arrow-right-short",
			properties: { "data-rename-icon": "" }
		}));
	}
	children.push(createHastElement({
		tagName: "div",
		children: [createTextNodeElement(name)],
		properties: { "data-title": "" }
	}));
	return createHastElement({
		tagName: "div",
		children,
		properties: { "data-header-content": "" }
	});
}
function createMetadataElement(fileDiff) {
	const children = [];
	if (fileDiff != null) {
		let additions = 0;
		let deletions = 0;
		for (const hunk of fileDiff.hunks) {
			additions += hunk.additionLines;
			deletions += hunk.deletionLines;
		}
		if (deletions > 0 || additions === 0) children.push(createHastElement({
			tagName: "span",
			children: [createTextNodeElement(`-${deletions}`)],
			properties: { "data-deletions-count": "" }
		}));
		if (additions > 0 || deletions === 0) children.push(createHastElement({
			tagName: "span",
			children: [createTextNodeElement(`+${additions}`)],
			properties: { "data-additions-count": "" }
		}));
	}
	children.push(createHastElement({
		tagName: "slot",
		properties: { name: HEADER_METADATA_SLOT_ID }
	}));
	return createHastElement({
		tagName: "div",
		children,
		properties: { "data-metadata": "" }
	});
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/createPreElement.js
function createPreElement(options) {
	return createHastElement({
		tagName: "pre",
		properties: createPreWrapperProperties(options)
	});
}
function createPreWrapperProperties({ diffIndicators, disableBackground, disableLineNumbers, overflow, split, themeType, themeStyles, totalLines }) {
	const properties = {
		"data-diffs": "",
		"data-type": split ? "split" : "file",
		"data-overflow": overflow,
		"data-disable-line-numbers": disableLineNumbers ? "" : void 0,
		"data-background": !disableBackground ? "" : void 0,
		"data-indicators": diffIndicators === "bars" || diffIndicators === "classic" ? diffIndicators : void 0,
		"data-theme-type": themeType !== "system" ? themeType : void 0,
		style: themeStyles,
		tabIndex: 0
	};
	properties.style += `--diffs-min-number-column-width-default:${`${totalLines}`.length}ch;`;
	return properties;
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/getFiletypeFromFileName.js
const EXTENSION_TO_FILE_FORMAT = {
	"1c": "1c",
	abap: "abap",
	as: "actionscript-3",
	ada: "ada",
	adb: "ada",
	ads: "ada",
	adoc: "asciidoc",
	asciidoc: "asciidoc",
	"component.html": "angular-html",
	"component.ts": "angular-ts",
	conf: "nginx",
	htaccess: "apache",
	cls: "tex",
	trigger: "apex",
	apl: "apl",
	applescript: "applescript",
	scpt: "applescript",
	ara: "ara",
	asm: "asm",
	s: "riscv",
	astro: "astro",
	awk: "awk",
	bal: "ballerina",
	sh: "zsh",
	bash: "zsh",
	bat: "cmd",
	cmd: "cmd",
	be: "berry",
	beancount: "beancount",
	bib: "bibtex",
	bicep: "bicep",
	"blade.php": "blade",
	bsl: "bsl",
	c: "c",
	h: "objective-cpp",
	cs: "csharp",
	cpp: "cpp",
	hpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	hh: "cpp",
	cdc: "cdc",
	cairo: "cairo",
	clar: "clarity",
	clj: "clojure",
	cljs: "clojure",
	cljc: "clojure",
	soy: "soy",
	cmake: "cmake",
	"CMakeLists.txt": "cmake",
	cob: "cobol",
	cbl: "cobol",
	cobol: "cobol",
	CODEOWNERS: "codeowners",
	ql: "ql",
	coffee: "coffeescript",
	lisp: "lisp",
	cl: "lisp",
	lsp: "lisp",
	log: "log",
	v: "verilog",
	cql: "cql",
	cr: "crystal",
	css: "css",
	csv: "csv",
	cue: "cue",
	cypher: "cypher",
	cyp: "cypher",
	d: "d",
	dart: "dart",
	dax: "dax",
	desktop: "desktop",
	diff: "diff",
	patch: "diff",
	Dockerfile: "dockerfile",
	dockerfile: "dockerfile",
	env: "dotenv",
	dm: "dream-maker",
	edge: "edge",
	el: "emacs-lisp",
	ex: "elixir",
	exs: "elixir",
	elm: "elm",
	erb: "erb",
	erl: "erlang",
	hrl: "erlang",
	f: "fortran-fixed-form",
	for: "fortran-fixed-form",
	fs: "fsharp",
	fsi: "fsharp",
	fsx: "fsharp",
	f03: "f03",
	f08: "f08",
	f18: "f18",
	f77: "f77",
	f90: "fortran-free-form",
	f95: "fortran-free-form",
	fnl: "fennel",
	fish: "fish",
	ftl: "ftl",
	tres: "gdresource",
	res: "gdresource",
	gd: "gdscript",
	gdshader: "gdshader",
	gs: "genie",
	feature: "gherkin",
	COMMIT_EDITMSG: "git-commit",
	"git-rebase-todo": "git-rebase",
	gjs: "glimmer-js",
	gleam: "gleam",
	gts: "glimmer-ts",
	glsl: "glsl",
	vert: "glsl",
	frag: "glsl",
	shader: "shaderlab",
	gp: "gnuplot",
	plt: "gnuplot",
	gnuplot: "gnuplot",
	go: "go",
	graphql: "graphql",
	gql: "graphql",
	groovy: "groovy",
	gvy: "groovy",
	hack: "hack",
	haml: "haml",
	hbs: "handlebars",
	handlebars: "handlebars",
	hs: "haskell",
	lhs: "haskell",
	hx: "haxe",
	hcl: "hcl",
	hjson: "hjson",
	hlsl: "hlsl",
	fx: "hlsl",
	html: "html",
	htm: "html",
	http: "http",
	rest: "http",
	hxml: "hxml",
	hy: "hy",
	imba: "imba",
	ini: "ini",
	cfg: "ini",
	jade: "pug",
	pug: "pug",
	java: "java",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jinja: "jinja",
	jinja2: "jinja",
	j2: "jinja",
	jison: "jison",
	jl: "julia",
	json: "json",
	json5: "json5",
	jsonc: "jsonc",
	jsonl: "jsonl",
	jsonnet: "jsonnet",
	libsonnet: "jsonnet",
	jssm: "jssm",
	jsx: "jsx",
	kt: "kotlin",
	kts: "kts",
	kql: "kusto",
	tex: "tex",
	ltx: "tex",
	lean: "lean4",
	less: "less",
	liquid: "liquid",
	lit: "lit",
	ll: "llvm",
	logo: "logo",
	lua: "lua",
	luau: "luau",
	Makefile: "makefile",
	mk: "makefile",
	makefile: "makefile",
	md: "markdown",
	markdown: "markdown",
	marko: "marko",
	m: "wolfram",
	mat: "matlab",
	mdc: "mdc",
	mdx: "mdx",
	wiki: "wikitext",
	mediawiki: "wikitext",
	mmd: "mermaid",
	mermaid: "mermaid",
	mips: "mipsasm",
	mojo: "mojo",
	"🔥": "mojo",
	move: "move",
	nar: "narrat",
	nf: "nextflow",
	nim: "nim",
	nims: "nim",
	nimble: "nim",
	nix: "nix",
	nu: "nushell",
	mm: "objective-cpp",
	ml: "ocaml",
	mli: "ocaml",
	mll: "ocaml",
	mly: "ocaml",
	pas: "pascal",
	p: "pascal",
	pl: "prolog",
	pm: "perl",
	t: "perl",
	raku: "raku",
	p6: "raku",
	pl6: "raku",
	php: "php",
	phtml: "php",
	pls: "plsql",
	sql: "sql",
	po: "po",
	polar: "polar",
	pcss: "postcss",
	pot: "pot",
	potx: "potx",
	pq: "powerquery",
	pqm: "powerquery",
	ps1: "powershell",
	psm1: "powershell",
	psd1: "powershell",
	prisma: "prisma",
	pro: "prolog",
	P: "prolog",
	properties: "properties",
	proto: "protobuf",
	pp: "puppet",
	purs: "purescript",
	py: "python",
	pyw: "python",
	pyi: "python",
	qml: "qml",
	qmldir: "qmldir",
	qss: "qss",
	r: "r",
	R: "r",
	rkt: "racket",
	rktl: "racket",
	razor: "razor",
	cshtml: "razor",
	rb: "ruby",
	rbw: "ruby",
	reg: "reg",
	regex: "regexp",
	rel: "rel",
	rs: "rust",
	rst: "rst",
	rake: "ruby",
	gemspec: "ruby",
	sas: "sas",
	sass: "sass",
	scala: "scala",
	sc: "scala",
	scm: "scheme",
	ss: "scheme",
	sld: "scheme",
	scss: "scss",
	sdbl: "sdbl",
	shadergraph: "shader",
	st: "smalltalk",
	sol: "solidity",
	sparql: "sparql",
	rq: "sparql",
	spl: "splunk",
	config: "ssh-config",
	do: "stata",
	ado: "stata",
	dta: "stata",
	styl: "stylus",
	stylus: "stylus",
	svelte: "svelte",
	swift: "swift",
	sv: "system-verilog",
	svh: "system-verilog",
	service: "systemd",
	socket: "systemd",
	device: "systemd",
	timer: "systemd",
	talon: "talonscript",
	tasl: "tasl",
	tcl: "tcl",
	templ: "templ",
	tf: "tf",
	tfvars: "tfvars",
	toml: "toml",
	ts: "typescript",
	tsp: "typespec",
	tsv: "tsv",
	tsx: "tsx",
	ttl: "turtle",
	twig: "twig",
	typ: "typst",
	vv: "v",
	vala: "vala",
	vapi: "vala",
	vb: "vb",
	vbs: "vb",
	bas: "vb",
	vh: "verilog",
	vhd: "vhdl",
	vhdl: "vhdl",
	vim: "vimscript",
	vue: "vue",
	"vine.ts": "vue-vine",
	vy: "vyper",
	wasm: "wasm",
	wat: "wasm",
	wy: "文言",
	wgsl: "wgsl",
	wit: "wit",
	wl: "wolfram",
	nb: "wolfram",
	xml: "xml",
	xsl: "xsl",
	xslt: "xsl",
	yaml: "yaml",
	yml: "yml",
	zs: "zenscript",
	zig: "zig",
	zsh: "zsh",
	sty: "tex"
};
function getFiletypeFromFileName(fileName) {
	if (EXTENSION_TO_FILE_FORMAT[fileName] != null) return EXTENSION_TO_FILE_FORMAT[fileName];
	const compoundMatch = fileName.match(/\.([^/\\]+\.[^/\\]+)$/);
	if (compoundMatch != null && EXTENSION_TO_FILE_FORMAT[compoundMatch[1]] != null) return EXTENSION_TO_FILE_FORMAT[compoundMatch[1]] ?? "text";
	return EXTENSION_TO_FILE_FORMAT[fileName.match(/\.([^.]+)$/)?.[1] ?? ""] ?? "text";
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/getHighlighterOptions.js
function getHighlighterOptions(lang, options) {
	return {
		langs: [lang ?? "text"],
		themes: getThemes(options.theme)
	};
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/getLineAnnotationName.js
function getLineAnnotationName(annotation) {
	return `annotation-${"side" in annotation ? `${annotation.side}-` : ""}${annotation.lineNumber}`;
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/cleanLastNewline.js
function cleanLastNewline(contents) {
	return contents.replace(/\n$|\r\n$/, "");
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/processLine.js
function processLine(node, line, state) {
	const lineInfo = typeof state.lineInfo === "function" ? state.lineInfo(line) : state.lineInfo[line];
	if (lineInfo == null) {
		console.error({
			node,
			line,
			state
		});
		throw new Error(`processLine: line ${line}, contains no state.lineInfo`);
	}
	node.tagName = "span";
	node.properties["data-column-content"] = "";
	if (node.children.length === 0) node.children.push(createTextNodeElement("\n"));
	return createHastElement({
		tagName: "div",
		children: [createHastElement({
			tagName: "span",
			children: [createHastElement({
				tagName: "span",
				children: [{
					type: "text",
					value: `${lineInfo.lineNumber}`
				}],
				properties: { "data-line-number-content": "" }
			})],
			properties: { "data-column-number": "" }
		}), node],
		properties: {
			"data-line": lineInfo.lineNumber,
			"data-alt-line": lineInfo.altLineNumber,
			"data-line-type": lineInfo.type,
			"data-line-index": lineInfo.lineIndex
		}
	});
}
//#endregion
//#region node_modules/.pnpm/@shikijs+transformers@3.23.0/node_modules/@shikijs/transformers/dist/index.mjs
function transformerStyleToClass(options = {}) {
	const { classPrefix = "__shiki_", classSuffix = "", classReplacer = (className) => className } = options;
	const classToStyle = /* @__PURE__ */ new Map();
	function stringifyStyle(style) {
		return Object.entries(style).map(([key, value]) => `${key}:${value}`).join(";");
	}
	function registerStyle(style) {
		let className = classPrefix + cyrb53(typeof style === "string" ? style : stringifyStyle(style)) + classSuffix;
		className = classReplacer(className);
		if (!classToStyle.has(className)) classToStyle.set(className, typeof style === "string" ? style : { ...style });
		return className;
	}
	return {
		name: "@shikijs/transformers:style-to-class",
		pre(t) {
			if (!t.properties.style) return;
			const className = registerStyle(t.properties.style);
			delete t.properties.style;
			this.addClassToHast(t, className);
		},
		tokens(lines) {
			for (const line of lines) for (const token of line) {
				if (!token.htmlStyle) continue;
				const className = registerStyle(token.htmlStyle);
				token.htmlStyle = {};
				token.htmlAttrs ||= {};
				if (!token.htmlAttrs.class) token.htmlAttrs.class = className;
				else token.htmlAttrs.class += ` ${className}`;
			}
		},
		getClassRegistry() {
			return classToStyle;
		},
		getCSS() {
			let css = "";
			for (const [className, style] of classToStyle.entries()) css += `.${className}{${typeof style === "string" ? style : stringifyStyle(style)}}`;
			return css;
		},
		clearRegistry() {
			classToStyle.clear();
		}
	};
}
function cyrb53(str, seed = 0) {
	let h1 = 3735928559 ^ seed;
	let h2 = 1103547991 ^ seed;
	for (let i = 0, ch; i < str.length; i++) {
		ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507);
	h1 ^= Math.imul(h2 ^ h2 >>> 13, 3266489909);
	h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507);
	h2 ^= Math.imul(h1 ^ h1 >>> 13, 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).slice(0, 6);
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/createTransformerWithState.js
function createTransformerWithState(useCSSClasses = false) {
	const state = { lineInfo: {} };
	const transformers = [{
		line(node) {
			delete node.properties.class;
			return node;
		},
		pre(pre) {
			const code = findCodeElement(pre);
			const children = [];
			if (code != null) {
				let index = 1;
				for (const node of code.children) {
					if (node.type !== "element") continue;
					children.push(processLine(node, index, state));
					index++;
				}
				code.children = children;
			}
			return pre;
		}
	}];
	if (useCSSClasses) transformers.push(tokenStyleNormalizer, toClass);
	return {
		state,
		transformers,
		toClass
	};
}
const toClass = transformerStyleToClass({ classPrefix: "hl-" });
const tokenStyleNormalizer = {
	name: "token-style-normalizer",
	tokens(lines) {
		for (const line of lines) for (const token of line) {
			if (token.htmlStyle != null) continue;
			const style = {};
			if (token.color != null) style.color = token.color;
			if (token.bgColor != null) style["background-color"] = token.bgColor;
			if (token.fontStyle != null && token.fontStyle !== 0) {
				if ((token.fontStyle & 1) !== 0) style["font-style"] = "italic";
				if ((token.fontStyle & 2) !== 0) style["font-weight"] = "bold";
				if ((token.fontStyle & 4) !== 0) style["text-decoration"] = "underline";
			}
			if (Object.keys(style).length > 0) token.htmlStyle = style;
		}
	}
};
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/formatCSSVariablePrefix.js
function formatCSSVariablePrefix(type) {
	return `--${type === "token" ? "diffs-token" : "diffs"}-`;
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/getHighlighterThemeStyles.js
function getHighlighterThemeStyles({ theme = DEFAULT_THEMES, highlighter, prefix }) {
	let styles = "";
	if (typeof theme === "string") {
		const themeData = highlighter.getTheme(theme);
		styles += `color:${themeData.fg};`;
		styles += `background-color:${themeData.bg};`;
		styles += `${formatCSSVariablePrefix("global")}fg:${themeData.fg};`;
		styles += `${formatCSSVariablePrefix("global")}bg:${themeData.bg};`;
		styles += getThemeVariables(themeData, prefix);
	} else {
		let themeData = highlighter.getTheme(theme.dark);
		styles += `${formatCSSVariablePrefix("global")}dark:${themeData.fg};`;
		styles += `${formatCSSVariablePrefix("global")}dark-bg:${themeData.bg};`;
		styles += getThemeVariables(themeData, "dark");
		themeData = highlighter.getTheme(theme.light);
		styles += `${formatCSSVariablePrefix("global")}light:${themeData.fg};`;
		styles += `${formatCSSVariablePrefix("global")}light-bg:${themeData.bg};`;
		styles += getThemeVariables(themeData, "light");
	}
	return styles;
}
function getThemeVariables(themeData, modePrefix) {
	modePrefix = modePrefix != null ? `${modePrefix}-` : "";
	let styles = "";
	const additionGreen = themeData.colors?.["gitDecoration.addedResourceForeground"] ?? themeData.colors?.["terminal.ansiGreen"];
	if (additionGreen != null) styles += `${formatCSSVariablePrefix("global")}${modePrefix}addition-color:${additionGreen};`;
	const deletionRed = themeData.colors?.["gitDecoration.deletedResourceForeground"] ?? themeData.colors?.["terminal.ansiRed"];
	if (deletionRed != null) styles += `${formatCSSVariablePrefix("global")}${modePrefix}deletion-color:${deletionRed};`;
	const modifiedBlue = themeData.colors?.["gitDecoration.modifiedResourceForeground"] ?? themeData.colors?.["terminal.ansiBlue"];
	if (modifiedBlue != null) styles += `${formatCSSVariablePrefix("global")}${modePrefix}modified-color:${modifiedBlue};`;
	return styles;
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/getLineNodes.js
function getLineNodes(nodes) {
	let firstChild = nodes.children[0];
	while (firstChild != null) {
		if (firstChild.type === "element" && firstChild.tagName === "code") return firstChild.children;
		if ("children" in firstChild) firstChild = firstChild.children[0];
		else firstChild = null;
	}
	console.error(nodes);
	throw new Error("getLineNodes: Unable to find children");
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/sprite.js
const SVGSpriteSheet = `<svg data-icon-sprite aria-hidden="true" width="0" height="0">
  <symbol id="diffs-icon-arrow-right-short" viewBox="0 0 16 16">
    <path d="M8.47 4.22a.75.75 0 0 0 0 1.06l1.97 1.97H3.75a.75.75 0 0 0 0 1.5h6.69l-1.97 1.97a.75.75 0 1 0 1.06 1.06l3.25-3.25a.75.75 0 0 0 0-1.06L9.53 4.22a.75.75 0 0 0-1.06 0"/>
  </symbol>
  <symbol id="diffs-icon-brand-github" viewBox="0 0 16 16">
    <path d="M8 0c4.42 0 8 3.58 8 8a8.01 8.01 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27s-1.36.09-2 .27c-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8"/>
  </symbol>
  <symbol id="diffs-icon-chevron" viewBox="0 0 16 16">
    <path d="M1.47 4.47a.75.75 0 0 1 1.06 0L8 9.94l5.47-5.47a.75.75 0 1 1 1.06 1.06l-6 6a.75.75 0 0 1-1.06 0l-6-6a.75.75 0 0 1 0-1.06"/>
  </symbol>
  <symbol id="diffs-icon-chevrons-narrow" viewBox="0 0 10 16">
    <path d="M4.47 2.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1-1.06 1.06L5 3.81 2.28 6.53a.75.75 0 0 1-1.06-1.06zM1.22 9.47a.75.75 0 0 1 1.06 0L5 12.19l2.72-2.72a.75.75 0 0 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0l-3.25-3.25a.75.75 0 0 1 0-1.06"/>
  </symbol>
  <symbol id="diffs-icon-diff-split" viewBox="0 0 16 16">
    <path d="M14 0H8.5v16H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2m-1.5 6.5v1h1a.5.5 0 0 1 0 1h-1v1a.5.5 0 0 1-1 0v-1h-1a.5.5 0 0 1 0-1h1v-1a.5.5 0 0 1 1 0"/><path d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5.5V0zm.5 7.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1" opacity=".3"/>
  </symbol>
  <symbol id="diffs-icon-diff-unified" viewBox="0 0 16 16">
    <path fill-rule="evenodd" d="M16 14a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8.5h16zm-8-4a.5.5 0 0 0-.5.5v1h-1a.5.5 0 0 0 0 1h1v1a.5.5 0 0 0 1 0v-1h1a.5.5 0 0 0 0-1h-1v-1A.5.5 0 0 0 8 10" clip-rule="evenodd"/><path fill-rule="evenodd" d="M14 0a2 2 0 0 1 2 2v5.5H0V2a2 2 0 0 1 2-2zM6.5 3.5a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1z" clip-rule="evenodd" opacity=".4"/>
  </symbol>
  <symbol id="diffs-icon-expand" viewBox="0 0 16 16">
    <path d="M3.47 5.47a.75.75 0 0 1 1.06 0L8 8.94l3.47-3.47a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 0-1.06"/>
  </symbol>
  <symbol id="diffs-icon-expand-all" viewBox="0 0 16 16">
    <path d="M11.47 9.47a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 1 1 1.06-1.06L8 12.94zM7.526 1.418a.75.75 0 0 1 1.004.052l4 4a.75.75 0 1 1-1.06 1.06L8 3.06 4.53 6.53a.75.75 0 1 1-1.06-1.06l4-4z"/>
  </symbol>
  <symbol id="diffs-icon-file-code" viewBox="0 0 16 16">
    <path d="M10.75 0c.199 0 .39.08.53.22l3.5 3.5c.14.14.22.331.22.53v9A2.75 2.75 0 0 1 12.25 16h-8.5A2.75 2.75 0 0 1 1 13.25V2.75A2.75 2.75 0 0 1 3.75 0zm-7 1.5c-.69 0-1.25.56-1.25 1.25v10.5c0 .69.56 1.25 1.25 1.25h8.5c.69 0 1.25-.56 1.25-1.25V5h-1.25A2.25 2.25 0 0 1 10 2.75V1.5z"/><path d="M7.248 6.19a.75.75 0 0 1 .063 1.058L5.753 9l1.558 1.752a.75.75 0 0 1-1.122.996l-2-2.25a.75.75 0 0 1 0-.996l2-2.25a.75.75 0 0 1 1.06-.063M8.69 7.248a.75.75 0 1 1 1.12-.996l2 2.25a.75.75 0 0 1 0 .996l-2 2.25a.75.75 0 1 1-1.12-.996L10.245 9z"/>
  </symbol>
  <symbol id="diffs-icon-symbol-added" viewBox="0 0 16 16">
    <path d="M8 4a.75.75 0 0 1 .75.75v2.5h2.5a.75.75 0 0 1 0 1.5h-2.5v2.5a.75.75 0 0 1-1.5 0v-2.5h-2.5a.75.75 0 0 1 0-1.5h2.5v-2.5A.75.75 0 0 1 8 4"/><path d="M1.788 4.296c.196-.88.478-1.381.802-1.706s.826-.606 1.706-.802C5.194 1.588 6.387 1.5 8 1.5s2.806.088 3.704.288c.88.196 1.381.478 1.706.802s.607.826.802 1.706c.2.898.288 2.091.288 3.704s-.088 2.806-.288 3.704c-.195.88-.478 1.381-.802 1.706s-.826.607-1.706.802c-.898.2-2.091.288-3.704.288s-2.806-.088-3.704-.288c-.88-.195-1.381-.478-1.706-.802s-.606-.826-.802-1.706C1.588 10.806 1.5 9.613 1.5 8s.088-2.806.288-3.704M8 0C1.412 0 0 1.412 0 8s1.412 8 8 8 8-1.412 8-8-1.412-8-8-8"/>
  </symbol>
  <symbol id="diffs-icon-symbol-deleted" viewBox="0 0 16 16">
    <path d="M4 8a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 4 8"/><path d="M1.788 4.296c.196-.88.478-1.381.802-1.706s.826-.606 1.706-.802C5.194 1.588 6.387 1.5 8 1.5s2.806.088 3.704.288c.88.196 1.381.478 1.706.802s.607.826.802 1.706c.2.898.288 2.091.288 3.704s-.088 2.806-.288 3.704c-.195.88-.478 1.381-.802 1.706s-.826.607-1.706.802c-.898.2-2.091.288-3.704.288s-2.806-.088-3.704-.288c-.88-.195-1.381-.478-1.706-.802s-.606-.826-.802-1.706C1.588 10.806 1.5 9.613 1.5 8s.088-2.806.288-3.704M8 0C1.412 0 0 1.412 0 8s1.412 8 8 8 8-1.412 8-8-1.412-8-8-8"/>
  </symbol>
  <symbol id="diffs-icon-symbol-diffstat" viewBox="0 0 16 16">
    <path d="M1.788 4.296c.196-.88.478-1.381.802-1.706s.826-.606 1.706-.802C5.194 1.588 6.387 1.5 8 1.5s2.806.088 3.704.288c.88.196 1.381.478 1.706.802s.607.826.802 1.706c.2.898.288 2.091.288 3.704s-.088 2.806-.288 3.704c-.195.88-.478 1.381-.802 1.706s-.826.607-1.706.802c-.898.2-2.091.288-3.704.288s-2.806-.088-3.704-.288c-.88-.195-1.381-.478-1.706-.802s-.606-.826-.802-1.706C1.588 10.806 1.5 9.613 1.5 8s.088-2.806.288-3.704M8 0C1.412 0 0 1.412 0 8s1.412 8 8 8 8-1.412 8-8-1.412-8-8-8"/><path d="M8.75 4.296a.75.75 0 0 0-1.5 0V6.25h-2a.75.75 0 0 0 0 1.5h2v1.5h1.5v-1.5h2a.75.75 0 0 0 0-1.5h-2zM5.25 10a.75.75 0 0 0 0 1.5h5.5a.75.75 0 0 0 0-1.5z"/>
  </symbol>
  <symbol id="diffs-icon-symbol-ignored" viewBox="0 0 16 16">
    <path d="M1.5 8c0 1.613.088 2.806.288 3.704.196.88.478 1.381.802 1.706s.826.607 1.706.802c.898.2 2.091.288 3.704.288s2.806-.088 3.704-.288c.88-.195 1.381-.478 1.706-.802s.607-.826.802-1.706c.2-.898.288-2.091.288-3.704s-.088-2.806-.288-3.704c-.195-.88-.478-1.381-.802-1.706s-.826-.606-1.706-.802C10.806 1.588 9.613 1.5 8 1.5s-2.806.088-3.704.288c-.88.196-1.381.478-1.706.802s-.606.826-.802 1.706C1.588 5.194 1.5 6.387 1.5 8M0 8c0-6.588 1.412-8 8-8s8 1.412 8 8-1.412 8-8 8-8-1.412-8-8m11.53-2.47a.75.75 0 0 0-1.06-1.06l-6 6a.75.75 0 1 0 1.06 1.06z"/>
  </symbol>
  <symbol id="diffs-icon-symbol-modified" viewBox="0 0 16 16">
    <path d="M1.5 8c0 1.613.088 2.806.288 3.704.196.88.478 1.381.802 1.706s.826.607 1.706.802c.898.2 2.091.288 3.704.288s2.806-.088 3.704-.288c.88-.195 1.381-.478 1.706-.802s.607-.826.802-1.706c.2-.898.288-2.091.288-3.704s-.088-2.806-.288-3.704c-.195-.88-.478-1.381-.802-1.706s-.826-.606-1.706-.802C10.806 1.588 9.613 1.5 8 1.5s-2.806.088-3.704.288c-.88.196-1.381.478-1.706.802s-.606.826-.802 1.706C1.588 5.194 1.5 6.387 1.5 8M0 8c0-6.588 1.412-8 8-8s8 1.412 8 8-1.412 8-8 8-8-1.412-8-8m8 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6"/>
  </symbol>
  <symbol id="diffs-icon-symbol-moved" viewBox="0 0 16 16">
    <path d="M1.788 4.296c.196-.88.478-1.381.802-1.706s.826-.606 1.706-.802C5.194 1.588 6.387 1.5 8 1.5s2.806.088 3.704.288c.88.196 1.381.478 1.706.802s.607.826.802 1.706c.2.898.288 2.091.288 3.704s-.088 2.806-.288 3.704c-.195.88-.478 1.381-.802 1.706s-.826.607-1.706.802c-.898.2-2.091.288-3.704.288s-2.806-.088-3.704-.288c-.88-.195-1.381-.478-1.706-.802s-.606-.826-.802-1.706C1.588 10.806 1.5 9.613 1.5 8s.088-2.806.288-3.704M8 0C1.412 0 0 1.412 0 8s1.412 8 8 8 8-1.412 8-8-1.412-8-8-8"/><path d="M8.495 4.695a.75.75 0 0 0-.05 1.06L10.486 8l-2.041 2.246a.75.75 0 0 0 1.11 1.008l2.5-2.75a.75.75 0 0 0 0-1.008l-2.5-2.75a.75.75 0 0 0-1.06-.051m-4 0a.75.75 0 0 0-.05 1.06l2.044 2.248-1.796 1.995a.75.75 0 0 0 1.114 1.004l2.25-2.5a.75.75 0 0 0-.002-1.007l-2.5-2.75a.75.75 0 0 0-1.06-.05"/>
  </symbol>
  <symbol id="diffs-icon-symbol-ref" viewBox="0 0 16 16">
    <path d="M1.5 8c0 1.613.088 2.806.288 3.704.196.88.478 1.381.802 1.706.286.286.71.54 1.41.73V1.86c-.7.19-1.124.444-1.41.73-.324.325-.606.826-.802 1.706C1.588 5.194 1.5 6.387 1.5 8m4 6.397c.697.07 1.522.103 2.5.103 1.613 0 2.806-.088 3.704-.288.88-.195 1.381-.478 1.706-.802s.607-.826.802-1.706c.2-.898.288-2.091.288-3.704s-.088-2.806-.288-3.704c-.195-.88-.478-1.381-.802-1.706s-.826-.606-1.706-.802C10.806 1.588 9.613 1.5 8 1.5c-.978 0-1.803.033-2.5.103zM0 8c0-6.588 1.412-8 8-8s8 1.412 8 8-1.412 8-8 8-8-1.412-8-8m7-2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z"/>
  </symbol>
</svg>`;
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/style.js
var style_default = "@layer base, theme, unsafe;\n\n@layer base {\n  :host {\n    --diffs-bg: #fff;\n    --diffs-fg: #000;\n    --diffs-font-fallback:\n      'SF Mono', Monaco, Consolas, 'Ubuntu Mono', 'Liberation Mono',\n      'Courier New', monospace;\n    --diffs-header-font-fallback:\n      system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue',\n      'Noto Sans', 'Liberation Sans', Arial, sans-serif;\n\n    --diffs-mixer: light-dark(black, white);\n    --diffs-gap-fallback: 8px;\n\n    /*\n    // Available CSS Color Overrides\n    --diffs-bg-buffer-override\n    --diffs-bg-hover-override\n    --diffs-bg-context-override\n    --diffs-bg-separator-override\n\n    --diffs-fg-number-override\n    --diffs-fg-number-addition-override\n    --diffs-fg-number-deletion-override\n\n    --diffs-deletion-color-override\n    --diffs-addition-color-override\n    --diffs-modified-color-override\n\n    --diffs-bg-deletion-override\n    --diffs-bg-deletion-number-override\n    --diffs-bg-deletion-hover-override\n    --diffs-bg-deletion-emphasis-override\n\n    --diffs-bg-addition-override\n    --diffs-bg-addition-number-override\n    --diffs-bg-addition-hover-override\n    --diffs-bg-addition-emphasis-override\n\n    // Line Selection Color Overrides (for enableLineSelection)\n    --diffs-selection-color-override\n    --diffs-bg-selection-override\n    --diffs-bg-selection-number-override\n    --diffs-bg-selection-background-override\n    --diffs-bg-selection-number-background-override\n\n    // Available CSS Layout Overrides\n    --diffs-gap-inline\n    --diffs-gap-block\n    --diffs-gap-style\n    --diffs-tab-size\n  */\n\n    color-scheme: light dark;\n    display: block;\n    font-family: var(\n      --diffs-header-font-family,\n      var(--diffs-header-font-fallback)\n    );\n    font-size: var(--diffs-font-size, 13px);\n    line-height: var(--diffs-line-height, 20px);\n    font-feature-settings: var(--diffs-font-features);\n  }\n\n  /* NOTE(mdo): Some semantic HTML elements (e.g. `pre`, `code`) have default\n * user-agent styles. These must be overridden to use our custom styles. */\n  pre,\n  code,\n  [data-error-wrapper] {\n    margin: 0;\n    padding: 0;\n    display: block;\n    outline: none;\n    font-family: var(--diffs-font-family, var(--diffs-font-fallback));\n  }\n\n  *,\n  *::before,\n  *::after {\n    box-sizing: border-box;\n  }\n\n  [data-icon-sprite] {\n    display: none;\n  }\n\n  /* NOTE(mdo): Headers and separators are within pre/code, so we need to reset\n * their font-family explicitly. */\n  [data-diffs-header],\n  [data-separator] {\n    font-family: var(\n      --diffs-header-font-family,\n      var(--diffs-header-font-fallback)\n    );\n  }\n\n  [data-file-info] {\n    padding: 10px;\n    font-weight: 700;\n    color: var(--fg);\n    /* NOTE(amadeus): we cannot use 'in oklch' because current versions of cursor\n   * and vscode use an older build of chrome that appears to have a bug with\n   * color-mix and 'in oklch', so use 'in lab' instead */\n    background-color: color-mix(in lab, var(--bg) 98%, var(--fg));\n    border-block: 1px solid color-mix(in lab, var(--bg) 95%, var(--fg));\n  }\n\n  [data-diffs-header],\n  [data-diffs],\n  [data-error-wrapper] {\n    --diffs-bg: light-dark(var(--diffs-light-bg), var(--diffs-dark-bg));\n    /* NOTE(amadeus): we cannot use 'in oklch' because current versions of cursor\n   * and vscode use an older build of chrome that appears to have a bug with\n   * color-mix and 'in oklch', so use 'in lab' instead */\n    --diffs-bg-buffer: var(\n      --diffs-bg-buffer-override,\n      light-dark(\n        color-mix(in lab, var(--diffs-bg) 92%, var(--diffs-mixer)),\n        color-mix(in lab, var(--diffs-bg) 92%, var(--diffs-mixer))\n      )\n    );\n    --diffs-bg-hover: var(\n      --diffs-bg-hover-override,\n      light-dark(\n        color-mix(in lab, var(--diffs-bg) 97%, var(--diffs-mixer)),\n        color-mix(in lab, var(--diffs-bg) 91%, var(--diffs-mixer))\n      )\n    );\n    --diffs-bg-context: var(\n      --diffs-bg-context-override,\n      light-dark(\n        color-mix(in lab, var(--diffs-bg) 98.5%, var(--diffs-mixer)),\n        color-mix(in lab, var(--diffs-bg) 92.5%, var(--diffs-mixer))\n      )\n    );\n    --diffs-bg-separator: var(\n      --diffs-bg-separator-override,\n      light-dark(\n        color-mix(in lab, var(--diffs-bg) 96%, var(--diffs-mixer)),\n        color-mix(in lab, var(--diffs-bg) 85%, var(--diffs-mixer))\n      )\n    );\n\n    --diffs-fg: light-dark(var(--diffs-light), var(--diffs-dark));\n    --diffs-fg-number: var(\n      --diffs-fg-number-override,\n      light-dark(\n        color-mix(in lab, var(--diffs-fg) 65%, var(--diffs-bg)),\n        color-mix(in lab, var(--diffs-fg) 65%, var(--diffs-bg))\n      )\n    );\n\n    --diffs-deletion-base: var(\n      --diffs-deletion-color-override,\n      light-dark(\n        var(\n          --diffs-light-deletion-color,\n          var(--diffs-deletion-color, rgb(255, 0, 0))\n        ),\n        var(\n          --diffs-dark-deletion-color,\n          var(--diffs-deletion-color, rgb(255, 0, 0))\n        )\n      )\n    );\n    --diffs-addition-base: var(\n      --diffs-addition-color-override,\n      light-dark(\n        var(\n          --diffs-light-addition-color,\n          var(--diffs-addition-color, rgb(0, 255, 0))\n        ),\n        var(\n          --diffs-dark-addition-color,\n          var(--diffs-addition-color, rgb(0, 255, 0))\n        )\n      )\n    );\n    --diffs-modified-base: var(\n      --diffs-modified-color-override,\n      light-dark(\n        var(\n          --diffs-light-modified-color,\n          var(--diffs-modified-color, rgb(0, 0, 255))\n        ),\n        var(\n          --diffs-dark-modified-color,\n          var(--diffs-modified-color, rgb(0, 0, 255))\n        )\n      )\n    );\n\n    /* NOTE(amadeus): we cannot use 'in oklch' because current versions of cursor\n   * and vscode use an older build of chrome that appears to have a bug with\n   * color-mix and 'in oklch', so use 'in lab' instead */\n    --diffs-bg-deletion: var(\n      --diffs-bg-deletion-override,\n      light-dark(\n        color-mix(in lab, var(--diffs-bg) 88%, var(--diffs-deletion-base)),\n        color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-deletion-base))\n      )\n    );\n    --diffs-bg-deletion-number: var(\n      --diffs-bg-deletion-number-override,\n      light-dark(\n        color-mix(in lab, var(--diffs-bg) 91%, var(--diffs-deletion-base)),\n        color-mix(in lab, var(--diffs-bg) 85%, var(--diffs-deletion-base))\n      )\n    );\n    --diffs-bg-deletion-hover: var(\n      --diffs-bg-deletion-hover-override,\n      light-dark(\n        color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-deletion-base)),\n        color-mix(in lab, var(--diffs-bg) 75%, var(--diffs-deletion-base))\n      )\n    );\n    --diffs-bg-deletion-emphasis: var(\n      --diffs-bg-deletion-emphasis-override,\n      light-dark(\n        rgb(from var(--diffs-deletion-base) r g b / 0.15),\n        rgb(from var(--diffs-deletion-base) r g b / 0.2)\n      )\n    );\n\n    --diffs-bg-addition: var(\n      --diffs-bg-addition-override,\n      light-dark(\n        color-mix(in lab, var(--diffs-bg) 88%, var(--diffs-addition-base)),\n        color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-addition-base))\n      )\n    );\n    --diffs-bg-addition-number: var(\n      --diffs-bg-addition-number-override,\n      light-dark(\n        color-mix(in lab, var(--diffs-bg) 91%, var(--diffs-addition-base)),\n        color-mix(in lab, var(--diffs-bg) 85%, var(--diffs-addition-base))\n      )\n    );\n    --diffs-bg-addition-hover: var(\n      --diffs-bg-addition-hover-override,\n      light-dark(\n        color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-addition-base)),\n        color-mix(in lab, var(--diffs-bg) 70%, var(--diffs-addition-base))\n      )\n    );\n    --diffs-bg-addition-emphasis: var(\n      --diffs-bg-addition-emphasis-override,\n      light-dark(\n        rgb(from var(--diffs-addition-base) r g b / 0.15),\n        rgb(from var(--diffs-addition-base) r g b / 0.2)\n      )\n    );\n\n    --diffs-selection-base: var(--diffs-modified-base);\n    --diffs-selection-number-fg: light-dark(\n      color-mix(in lab, var(--diffs-selection-base) 65%, var(--diffs-mixer)),\n      color-mix(in lab, var(--diffs-selection-base) 75%, var(--diffs-mixer))\n    );\n    --diffs-bg-selection: var(\n      --diffs-bg-selection-override,\n      light-dark(\n        color-mix(in lab, var(--diffs-bg) 82%, var(--diffs-selection-base)),\n        color-mix(in lab, var(--diffs-bg) 75%, var(--diffs-selection-base))\n      )\n    );\n    --diffs-bg-selection-number: var(\n      --diffs-bg-selection-number-override,\n      light-dark(\n        color-mix(in lab, var(--diffs-bg) 75%, var(--diffs-selection-base)),\n        color-mix(in lab, var(--diffs-bg) 60%, var(--diffs-selection-base))\n      )\n    );\n\n    background-color: var(--diffs-bg);\n    color: var(--diffs-fg);\n  }\n\n  [data-diffs] {\n    --diffs-code-grid: minmax(min-content, max-content) 1fr;\n\n    [data-column-content] span {\n      color: light-dark(\n        var(--diffs-token-light, var(--diffs-light)),\n        var(--diffs-token-dark, var(--diffs-dark))\n      );\n      font-weight: var(--diffs-token-light-font-weight, inherit);\n      font-style: var(--diffs-token-light-font-style, inherit);\n      -webkit-text-decoration: var(--diffs-token-light-text-decoration, inherit);\n              text-decoration: var(--diffs-token-light-text-decoration, inherit);\n    }\n  }\n\n  /* Since span is a pretty innocuous selector, we need to make sure we don't\n   * apply tokenized BG colors to diff-spans */\n  [data-column-content] span:not([data-diff-span]) {\n    background-color: light-dark(\n      var(--diffs-token-light-bg, inherit),\n      var(--diffs-token-dark-bg, inherit)\n    );\n  }\n\n  [data-column-content] {\n    background-color: var(--diffs-line-bg, 'transparent');\n    grid-column: 2 / 3;\n  }\n\n  [data-diffs][data-dehydrated] {\n    --diffs-code-grid: minmax(min-content, max-content) minmax(0, 1fr);\n  }\n\n  @media (prefers-color-scheme: dark) {\n    [data-diffs-header],\n    [data-diffs] {\n      color-scheme: dark;\n    }\n\n    [data-diffs] [data-column-content] span {\n      font-weight: var(--diffs-token-dark-font-weight, inherit);\n      font-style: var(--diffs-token-dark-font-style, inherit);\n      -webkit-text-decoration: var(--diffs-token-dark-text-decoration, inherit);\n              text-decoration: var(--diffs-token-dark-text-decoration, inherit);\n    }\n  }\n\n  [data-diffs-header][data-theme-type='light'],\n  [data-diffs][data-theme-type='light'] {\n    color-scheme: light;\n  }\n\n  [data-diffs][data-theme-type='light'] [data-column-content] span {\n    font-weight: var(--diffs-token-light-font-weight, inherit);\n    font-style: var(--diffs-token-light-font-style, inherit);\n    -webkit-text-decoration: var(--diffs-token-light-text-decoration, inherit);\n            text-decoration: var(--diffs-token-light-text-decoration, inherit);\n  }\n\n  [data-diffs-header][data-theme-type='dark'],\n  [data-diffs][data-theme-type='dark'] {\n    color-scheme: dark;\n  }\n\n  [data-diffs][data-theme-type='dark'] [data-column-content] span {\n    font-weight: var(--diffs-token-dark-font-weight, inherit);\n    font-style: var(--diffs-token-dark-font-style, inherit);\n    -webkit-text-decoration: var(--diffs-token-dark-text-decoration, inherit);\n            text-decoration: var(--diffs-token-dark-text-decoration, inherit);\n  }\n\n  [data-type='split'][data-overflow='wrap'] {\n    display: grid;\n    grid-auto-flow: dense;\n    grid-template-columns: repeat(2, var(--diffs-code-grid));\n  }\n\n  [data-type='split'][data-overflow='scroll'] {\n    display: grid;\n    grid-template-columns: 1fr 1fr;\n    gap: 2px;\n  }\n\n  [data-code] {\n    display: block;\n    display: grid;\n    grid-auto-flow: dense;\n    grid-template-columns: var(--diffs-code-grid);\n    overflow: scroll clip;\n    overscroll-behavior-x: none;\n    tab-size: var(--diffs-tab-size, 2);\n    align-self: flex-start;\n    padding-top: var(--diffs-gap-block, var(--diffs-gap-fallback));\n    padding-bottom: max(\n      0px,\n      calc(var(--diffs-gap-block, var(--diffs-gap-fallback)) - 6px)\n    );\n  }\n\n  [data-code]::-webkit-scrollbar {\n    width: 0;\n    height: 6px;\n  }\n\n  [data-code]::-webkit-scrollbar-track {\n    background: transparent;\n  }\n\n  [data-code]::-webkit-scrollbar-thumb {\n    background-color: transparent;\n    border: 1px solid transparent;\n    background-clip: content-box;\n    border-radius: 3px;\n  }\n\n  [data-diffs]:hover [data-code]::-webkit-scrollbar-thumb {\n    background-color: var(--diffs-bg-context);\n  }\n\n  [data-code]::-webkit-scrollbar-corner {\n    background-color: transparent;\n  }\n\n  /*\n   * If we apply these rules globally it will mean that webkit will opt into the\n   * standards compliant version of custom css scrollbars, which we do not want\n   * because the custom stuff will look better\n  */\n  @supports (-moz-appearance: none) {\n    [data-code] {\n      scrollbar-width: thin;\n      scrollbar-color: var(--diffs-bg-context) transparent;\n      padding-bottom: var(--diffs-gap-block, var(--diffs-gap-fallback));\n    }\n  }\n\n  [data-diffs][data-type='split'][data-overflow='wrap'] {\n    padding-block: var(--diffs-gap-block, var(--diffs-gap-fallback));\n  }\n\n  [data-diffs-header] ~ [data-diffs] [data-code],\n  [data-diffs-header] ~ [data-diffs][data-overflow='wrap'] {\n    padding-top: 0;\n  }\n\n  [data-type='split'][data-overflow='wrap'] [data-code] {\n    display: contents;\n  }\n\n  [data-line-annotation],\n  [data-no-newline],\n  [data-line] {\n    position: relative;\n    display: grid;\n    grid-template-columns: subgrid;\n    grid-column: 1 / 3;\n  }\n\n  [data-line-annotation][data-selected-line] {\n    background-color: unset;\n\n    &::before {\n      content: '';\n      position: sticky;\n      top: 0;\n      left: 0;\n      display: block;\n      border-right: var(--diffs-gap-style, 1px solid var(--diffs-bg));\n      background-color: var(--diffs-bg-selection-number);\n    }\n\n    [data-annotation-content] {\n      background-color: var(--diffs-bg-selection);\n    }\n  }\n\n  [data-interactive-lines] [data-line] {\n    cursor: pointer;\n  }\n\n  [data-buffer] {\n    position: sticky;\n    left: 0;\n    grid-column: 1 / 3;\n    -webkit-user-select: none;\n            user-select: none;\n    /* We multiply by 1.414 (√2) to better approximate the diagonal repeat distance */\n    background-image: repeating-linear-gradient(\n      -45deg,\n      transparent,\n      transparent calc(3px * 1.414),\n      var(--diffs-bg-buffer) calc(3px * 1.414),\n      var(--diffs-bg-buffer) calc(4px * 1.414)\n    );\n    min-height: 1lh;\n    width: var(--diffs-column-width, auto);\n  }\n\n  [data-separator] {\n    grid-column: span 2;\n  }\n\n  [data-separator='metadata'],\n  [data-separator]:empty {\n    min-height: 4px;\n    background-color: var(--diffs-bg-separator);\n    display: grid;\n    grid-template-columns: subgrid;\n  }\n\n  [data-separator-wrapper] {\n    -webkit-user-select: none;\n            user-select: none;\n    fill: currentColor;\n    overflow: hidden;\n  }\n\n  [data-separator='metadata'] [data-separator-wrapper] {\n    grid-column: 2 / 3;\n    width: var(--diffs-column-content-width);\n    position: sticky;\n    left: var(--diffs-column-number-width);\n    padding: 4px 1ch;\n  }\n\n  [data-separator='line-info'] {\n    margin-block: var(--diffs-gap-block, var(--diffs-gap-fallback));\n  }\n\n  [data-separator='line-info'][data-separator-first] {\n    margin-top: 0;\n  }\n\n  [data-separator='line-info'][data-separator-last] {\n    margin-bottom: 0;\n  }\n\n  [data-separator='line-info'] [data-separator-wrapper] {\n    position: sticky;\n    display: flex;\n    align-items: center;\n    gap: 2px;\n    width: auto;\n    width: calc(var(--diffs-column-width) - var(--diffs-gap-fallback));\n    border-radius: 6px;\n  }\n\n  @media (pointer: fine) {\n    [data-separator-wrapper][data-separator-multi-button] {\n      display: grid;\n      grid-template-columns: auto minmax(0, 1fr);\n      grid-template-rows: 15px 15px;\n\n      [data-expand-button] {\n        height: 15px;\n      }\n    }\n\n    [data-type='split']\n      [data-additions]\n      [data-separator-wrapper][data-separator-multi-button] {\n      grid-template-columns: minmax(0, 1fr) auto;\n    }\n\n    [data-type='split'] [data-additions] [data-expand-button] {\n      grid-column: 2;\n    }\n\n    [data-type='split'] [data-additions] [data-separator-content] {\n      grid-column: 1;\n    }\n  }\n\n  [data-expand-button],\n  [data-separator-content] {\n    display: flex;\n    align-items: center;\n    background-color: var(--diffs-bg-separator);\n  }\n\n  [data-expand-button] {\n    justify-content: center;\n    flex-shrink: 0;\n    cursor: pointer;\n    width: 32px;\n    height: 32px;\n    opacity: 0.65;\n  }\n\n  [data-hover-slot] {\n    position: absolute;\n    top: 0;\n    bottom: 0;\n    right: 0;\n    display: flex;\n    justify-content: flex-end;\n  }\n\n  @media (pointer: fine) {\n    [data-expand-button]:hover {\n      opacity: 1;\n    }\n\n    [data-line]:hover {\n      z-index: 2;\n    }\n  }\n\n  [data-expand-down] [data-icon] {\n    transform: scaleY(-1);\n  }\n\n  [data-separator-content] {\n    flex: 1 1 auto;\n    padding: 0 1ch;\n    height: 32px;\n    opacity: 0.65;\n    overflow: hidden;\n    justify-content: flex-start;\n\n    grid-column: 2;\n    grid-row: 1 / -1;\n  }\n\n  [data-unmodified-lines] {\n    display: block;\n    overflow: hidden;\n    min-width: 0;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n    flex: 0 1 auto;\n  }\n\n  [data-type='split'] [data-additions] [data-separator-content] {\n    justify-content: flex-end;\n  }\n\n  [data-type='file']\n    [data-code]\n    [data-separator='line-info']\n    [data-separator-wrapper] {\n    left: var(--diffs-gap-inline, var(--diffs-gap-fallback));\n    margin-left: var(--diffs-gap-inline, var(--diffs-gap-fallback));\n    margin-right: var(--diffs-gap-inline, var(--diffs-gap-fallback));\n    width: calc(\n      var(--diffs-column-width) -\n        (var(--diffs-gap-inline, var(--diffs-gap-fallback)) * 2)\n    );\n  }\n\n  [data-type='split']\n    [data-deletions]\n    [data-separator='line-info']\n    [data-separator-wrapper] {\n    left: var(--diffs-gap-fallback);\n    margin-left: var(--diffs-gap-fallback);\n    border-top-right-radius: 0;\n    border-bottom-right-radius: 0;\n  }\n\n  [data-type='split']\n    [data-additions]\n    [data-separator='line-info']\n    [data-separator-wrapper] {\n    left: 0;\n    margin-right: var(--diffs-gap-inline, var(--diffs-gap-fallback));\n    border-top-left-radius: 0;\n    border-bottom-left-radius: 0;\n    flex-direction: row-reverse;\n  }\n\n  [data-line] {\n    background-color: var(--diffs-bg);\n    color: var(--diffs-fg);\n  }\n\n  [data-type='split'][data-overflow='wrap'] [data-deletions] {\n    [data-line-annotation],\n    [data-buffer],\n    [data-line],\n    [data-separator] {\n      grid-column: 1 / 3;\n    }\n  }\n\n  [data-line-annotation] {\n    min-height: var(--diffs-annotation-min-height, 0);\n    background-color: var(--diffs-bg-context);\n    z-index: 3;\n  }\n\n  [data-type='split'][data-overflow='wrap'] [data-additions] {\n    [data-line-annotation],\n    [data-buffer],\n    [data-line],\n    [data-separator] {\n      margin-left: 2px;\n      grid-column: 3 / 5;\n    }\n  }\n\n  [data-separator='custom'] {\n    display: grid;\n    grid-template-columns: subgrid;\n  }\n\n  [data-column-content],\n  [data-column-number] {\n    position: relative;\n    padding-inline: 1ch;\n  }\n\n  [data-indicators='classic'] [data-column-content] {\n    padding-inline-start: 2ch;\n  }\n\n  [data-indicators='classic'] {\n    [data-line-type='change-addition'] [data-column-content]::before,\n    [data-line-type='change-deletion'] [data-column-content]::before {\n      display: inline-block;\n      width: 1ch;\n      height: 1lh;\n      position: absolute;\n      top: 0;\n      left: 0;\n      -webkit-user-select: none;\n              user-select: none;\n    }\n\n    [data-line-type='change-addition'] [data-column-content]::before {\n      content: '+';\n      color: var(--diffs-addition-base);\n    }\n\n    [data-line-type='change-deletion'] [data-column-content]::before {\n      content: '-';\n      color: var(--diffs-deletion-base);\n    }\n  }\n\n  [data-indicators='bars'] {\n    [data-line-type='change-deletion'] [data-column-number]::before,\n    [data-line-type='change-addition'] [data-column-number]::before {\n      content: '';\n      display: block;\n      width: 4px;\n      height: 100%;\n      position: absolute;\n      top: 0;\n      left: 0;\n      -webkit-user-select: none;\n              user-select: none;\n    }\n\n    [data-line-type='change-deletion'] [data-column-number]::before {\n      background-image: linear-gradient(\n        0deg,\n        var(--diffs-bg-deletion) 50%,\n        var(--diffs-deletion-base) 50%\n      );\n      background-repeat: repeat;\n      background-size: 2px 2px;\n      background-size: calc(1lh / round(1lh / 2px)) calc(1lh / round(1lh / 2px));\n    }\n\n    [data-line-type='change-addition'] [data-column-number]::before {\n      background-color: var(--diffs-addition-base);\n    }\n  }\n\n  [data-overflow='wrap'] [data-column-content],\n  [data-overflow='wrap'] [data-annotation-content] {\n    white-space: pre-wrap;\n    word-break: break-word;\n  }\n\n  [data-overflow='scroll'] [data-column-content] {\n    white-space: pre;\n    min-height: 1lh;\n  }\n\n  [data-column-number] {\n    grid-column: 1 / 2;\n    box-sizing: content-box;\n    text-align: right;\n    position: sticky;\n    left: 0;\n    -webkit-user-select: none;\n            user-select: none;\n    background-color: var(--diffs-bg);\n    color: var(--diffs-fg-number);\n    z-index: 1;\n    min-width: var(\n      --diffs-min-number-column-width,\n      var(--diffs-min-number-column-width-default, 3ch)\n    );\n    padding-left: 2ch;\n    border-right: var(--diffs-gap-style, 1px solid var(--diffs-bg));\n  }\n\n  [data-disable-line-numbers] {\n    &[data-indicators='bars'] [data-column-number] {\n      min-width: 4px;\n      border-right: var(--diffs-gap-style, 1px solid var(--diffs-bg));\n    }\n\n    [data-column-number] {\n      border-right: none;\n      min-width: 0;\n      padding: 0;\n    }\n\n    [data-line-number-content] {\n      display: none;\n    }\n\n    [data-hover-slot] {\n      right: unset;\n      left: 0;\n      justify-content: flex-start;\n    }\n\n    &[data-indicators='bars'] [data-hover-slot] {\n      /* Using 5px here because theres a 1px separator after the bar */\n      left: 5px;\n    }\n  }\n\n  [data-interactive-line-numbers] [data-column-number] {\n    cursor: pointer;\n  }\n\n  [data-diff-span] {\n    border-radius: 3px;\n    -webkit-box-decoration-break: clone;\n            box-decoration-break: clone;\n  }\n\n  [data-line-type='change-addition'] {\n    [data-column-number] {\n      color: var(\n        --diffs-fg-number-addition-override,\n        var(--diffs-addition-base)\n      );\n    }\n\n    [data-diff-span] {\n      background-color: var(--diffs-bg-addition-emphasis);\n    }\n  }\n\n  [data-line-type='change-deletion'] {\n    [data-column-number] {\n      color: var(\n        --diffs-fg-number-deletion-override,\n        var(--diffs-deletion-base)\n      );\n    }\n\n    [data-diff-span] {\n      background-color: var(--diffs-bg-deletion-emphasis);\n    }\n  }\n\n  [data-background] [data-line-type='change-addition'] {\n    --diffs-line-bg: var(--diffs-bg-addition);\n\n    [data-column-number] {\n      background-color: var(--diffs-bg-addition-number);\n    }\n  }\n\n  [data-background] [data-line-type='change-deletion'] {\n    --diffs-line-bg: var(--diffs-bg-deletion);\n\n    [data-column-number] {\n      background-color: var(--diffs-bg-deletion-number);\n    }\n  }\n\n  [data-line-type='context-expanded'] {\n    --diffs-line-bg: var(--diffs-bg-context);\n\n    [data-column-number] {\n      background-color: var(--diffs-bg-context);\n    }\n  }\n\n  /* By wrapping hovers in a pointer: fine, we ensure that mobile devices don't\n*  require a double click */\n  @media (pointer: fine) {\n    [data-line]:hover:not([data-selected-line]) {\n      [data-column-number],\n      [data-column-content] {\n        background-color: var(--diffs-bg-hover);\n      }\n    }\n\n    [data-background] [data-line]:hover:not([data-selected-line]) {\n      &[data-line-type='change-deletion'] [data-column-number],\n      &[data-line-type='change-deletion'] [data-column-content] {\n        background-color: var(--diffs-bg-deletion-hover);\n      }\n\n      &[data-line-type='change-addition'] [data-column-number],\n      &[data-line-type='change-addition'] [data-column-content] {\n        background-color: var(--diffs-bg-addition-hover);\n      }\n    }\n  }\n\n  [data-diffs-header] {\n    display: flex;\n    flex-direction: row;\n    justify-content: space-between;\n    align-items: center;\n    gap: var(--diffs-gap-inline, var(--diffs-gap-fallback));\n    min-height: calc(\n      1lh + (var(--diffs-gap-block, var(--diffs-gap-fallback)) * 3)\n    );\n    padding-inline: 16px;\n  }\n\n  [data-header-content] {\n    display: flex;\n    flex-direction: row;\n    align-items: center;\n    gap: var(--diffs-gap-inline, var(--diffs-gap-fallback));\n    min-width: 0;\n    white-space: nowrap;\n  }\n\n  [data-header-content] [data-prev-name],\n  [data-header-content] [data-title] {\n    direction: rtl;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    min-width: 0;\n    white-space: nowrap;\n  }\n\n  [data-prev-name] {\n    opacity: 0.7;\n  }\n\n  [data-rename-icon] {\n    fill: currentColor;\n    flex-shrink: 0;\n    flex-grow: 0;\n  }\n\n  [data-diffs-header] [data-metadata] {\n    display: flex;\n    align-items: center;\n    gap: 1ch;\n    white-space: nowrap;\n  }\n\n  [data-diffs-header] [data-additions-count] {\n    font-family: var(--diffs-font-family, var(--diffs-font-fallback));\n    color: var(--diffs-addition-base);\n  }\n\n  [data-diffs-header] [data-deletions-count] {\n    font-family: var(--diffs-font-family, var(--diffs-font-fallback));\n    color: var(--diffs-deletion-base);\n  }\n\n  [data-no-newline] {\n    -webkit-user-select: none;\n            user-select: none;\n\n    [data-column-content] {\n      opacity: 0.6;\n    }\n  }\n\n  [data-annotation-content] {\n    position: sticky;\n    left: var(--diffs-column-number-width, 0);\n    grid-column: 2 / -1;\n    width: var(--diffs-column-content-width, auto);\n    align-self: flex-start;\n    z-index: 2;\n    height: 100%;\n  }\n\n  /* Undo some of the stuff that the 'pre' tag does */\n  [data-annotation-slot] {\n    text-wrap-mode: wrap;\n    word-break: normal;\n    white-space-collapse: collapse;\n  }\n\n  [data-change-icon] {\n    fill: currentColor;\n    flex-shrink: 0;\n  }\n\n  [data-change-icon='change'],\n  [data-change-icon='rename-pure'],\n  [data-change-icon='rename-changed'] {\n    color: var(--diffs-modified-base);\n  }\n\n  [data-change-icon='new'] {\n    color: var(--diffs-addition-base);\n  }\n\n  [data-change-icon='deleted'] {\n    color: var(--diffs-deletion-base);\n  }\n\n  [data-change-icon='file'] {\n    opacity: 0.6;\n  }\n\n  /* Line selection highlighting */\n  [data-line-type='context'][data-selected-line] {\n    [data-column-number] {\n      color: var(--diffs-selection-number-fg);\n      background-color: var(--diffs-bg-selection-number);\n    }\n\n    [data-column-content] {\n      background-color: var(--diffs-bg-selection);\n    }\n  }\n\n  [data-line-type='context-expanded'],\n  [data-line-type='change-addition'],\n  [data-line-type='change-deletion'] {\n    &[data-selected-line] {\n      [data-column-content] {\n        background-color: light-dark(\n          color-mix(\n            in lab,\n            var(--diffs-line-bg, var(--diffs-bg)) 82%,\n            var(--diffs-selection-base)\n          ),\n          color-mix(\n            in lab,\n            var(--diffs-line-bg, var(--diffs-bg)) 75%,\n            var(--diffs-selection-base)\n          )\n        );\n      }\n\n      [data-column-number] {\n        color: var(--diffs-selection-number-fg);\n        background-color: light-dark(\n          color-mix(\n            in lab,\n            var(--diffs-line-bg, var(--diffs-bg)) 75%,\n            var(--diffs-selection-base)\n          ),\n          color-mix(\n            in lab,\n            var(--diffs-line-bg, var(--diffs-bg)) 60%,\n            var(--diffs-selection-base)\n          )\n        );\n      }\n    }\n  }\n\n  [data-error-wrapper] {\n    overflow: auto;\n    padding: var(--diffs-gap-block, var(--diffs-gap-fallback))\n      var(--diffs-gap-inline, var(--diffs-gap-fallback));\n    max-height: 400px;\n    scrollbar-width: none;\n\n    [data-error-message] {\n      font-weight: bold;\n      font-size: 18px;\n      color: var(--diffs-deletion-base);\n    }\n\n    [data-error-stack] {\n      color: var(--diffs-fg-number);\n    }\n  }\n}\n";
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/cssWrappers.js
const LAYER_ORDER = `@layer base, theme, unsafe;`;
function wrapCoreCSS(mainCSS) {
	return `${LAYER_ORDER}
${style_default}
@layer theme {
  ${mainCSS}
}`;
}
function wrapUnsafeCSS(unsafeCSS) {
	return `${LAYER_ORDER}
@layer unsafe {
  ${unsafeCSS}
}`;
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/createEmptyRowBuffer.js
function createEmptyRowBuffer(size) {
	return createHastElement({
		tagName: "div",
		properties: {
			"data-buffer": "",
			style: `grid-row: span ${size};min-height:calc(${size} * 1lh)`
		}
	});
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/createNoNewlineElement.js
function createNoNewlineElement(type) {
	return createHastElement({
		tagName: "div",
		children: [createHastElement({
			tagName: "span",
			properties: { "data-column-number": "" }
		}), createHastElement({
			tagName: "span",
			children: [createTextNodeElement("No newline at end of file")],
			properties: { "data-column-content": "" }
		})],
		properties: {
			"data-no-newline": "",
			"data-line-type": type
		}
	});
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/createSeparator.js
function createExpandButton(type) {
	return createHastElement({
		tagName: "div",
		children: [createIconElement({
			name: type === "both" ? "diffs-icon-expand-all" : "diffs-icon-expand",
			properties: { "data-icon": "" }
		})],
		properties: {
			"data-expand-button": "",
			"data-expand-both": type === "both" ? "" : void 0,
			"data-expand-up": type === "up" ? "" : void 0,
			"data-expand-down": type === "down" ? "" : void 0
		}
	});
}
function createSeparator({ type, content, expandIndex, chunked = false, slotName, isFirstHunk, isLastHunk }) {
	const children = [];
	if (type === "metadata" && content != null) children.push(createHastElement({
		tagName: "div",
		children: [createTextNodeElement(content)],
		properties: { "data-separator-wrapper": "" }
	}));
	if (type === "line-info" && content != null) {
		const contentChildren = [];
		if (expandIndex != null) if (!chunked) contentChildren.push(createExpandButton(!isFirstHunk && !isLastHunk ? "both" : isFirstHunk ? "down" : "up"));
		else {
			if (!isFirstHunk) contentChildren.push(createExpandButton("up"));
			if (!isLastHunk) contentChildren.push(createExpandButton("down"));
		}
		contentChildren.push(createHastElement({
			tagName: "div",
			children: [createHastElement({
				tagName: "span",
				children: [createTextNodeElement(content)],
				properties: { "data-unmodified-lines": "" }
			})],
			properties: { "data-separator-content": "" }
		}));
		children.push(createHastElement({
			tagName: "div",
			children: contentChildren,
			properties: {
				"data-separator-wrapper": "",
				"data-separator-multi-button": contentChildren.length > 2 ? "" : void 0
			}
		}));
	}
	if (type === "custom" && slotName != null) children.push(createHastElement({
		tagName: "slot",
		properties: { name: slotName }
	}));
	return createHastElement({
		tagName: "div",
		children,
		properties: {
			"data-separator": children.length === 0 ? "" : type,
			"data-expand-index": expandIndex,
			"data-separator-first": isFirstHunk ? "" : void 0,
			"data-separator-last": isLastHunk ? "" : void 0
		}
	});
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/getHunkSeparatorSlotName.js
function getHunkSeparatorSlotName(type, hunkIndex) {
	return `hunk-separator-${type}-${hunkIndex}`;
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/getTotalLineCountFromHunks.js
function getTotalLineCountFromHunks(hunks) {
	const lastHunk = hunks[hunks.length - 1];
	if (lastHunk == null) return 0;
	return Math.max(lastHunk.additionStart + lastHunk.additionCount, lastHunk.deletionStart + lastHunk.deletionCount);
}
//#endregion
//#region node_modules/.pnpm/diff@8.0.3/node_modules/diff/libesm/diff/base.js
var Diff = class {
	diff(oldStr, newStr, options = {}) {
		let callback;
		if (typeof options === "function") {
			callback = options;
			options = {};
		} else if ("callback" in options) callback = options.callback;
		const oldString = this.castInput(oldStr, options);
		const newString = this.castInput(newStr, options);
		const oldTokens = this.removeEmpty(this.tokenize(oldString, options));
		const newTokens = this.removeEmpty(this.tokenize(newString, options));
		return this.diffWithOptionsObj(oldTokens, newTokens, options, callback);
	}
	diffWithOptionsObj(oldTokens, newTokens, options, callback) {
		var _a;
		const done = (value) => {
			value = this.postProcess(value, options);
			if (callback) {
				setTimeout(function() {
					callback(value);
				}, 0);
				return;
			} else return value;
		};
		const newLen = newTokens.length, oldLen = oldTokens.length;
		let editLength = 1;
		let maxEditLength = newLen + oldLen;
		if (options.maxEditLength != null) maxEditLength = Math.min(maxEditLength, options.maxEditLength);
		const maxExecutionTime = (_a = options.timeout) !== null && _a !== void 0 ? _a : Infinity;
		const abortAfterTimestamp = Date.now() + maxExecutionTime;
		const bestPath = [{
			oldPos: -1,
			lastComponent: void 0
		}];
		let newPos = this.extractCommon(bestPath[0], newTokens, oldTokens, 0, options);
		if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) return done(this.buildValues(bestPath[0].lastComponent, newTokens, oldTokens));
		let minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;
		const execEditLength = () => {
			for (let diagonalPath = Math.max(minDiagonalToConsider, -editLength); diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
				let basePath;
				const removePath = bestPath[diagonalPath - 1], addPath = bestPath[diagonalPath + 1];
				if (removePath) bestPath[diagonalPath - 1] = void 0;
				let canAdd = false;
				if (addPath) {
					const addPathNewPos = addPath.oldPos - diagonalPath;
					canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
				}
				const canRemove = removePath && removePath.oldPos + 1 < oldLen;
				if (!canAdd && !canRemove) {
					bestPath[diagonalPath] = void 0;
					continue;
				}
				if (!canRemove || canAdd && removePath.oldPos < addPath.oldPos) basePath = this.addToPath(addPath, true, false, 0, options);
				else basePath = this.addToPath(removePath, false, true, 1, options);
				newPos = this.extractCommon(basePath, newTokens, oldTokens, diagonalPath, options);
				if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) return done(this.buildValues(basePath.lastComponent, newTokens, oldTokens)) || true;
				else {
					bestPath[diagonalPath] = basePath;
					if (basePath.oldPos + 1 >= oldLen) maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
					if (newPos + 1 >= newLen) minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
				}
			}
			editLength++;
		};
		if (callback) (function exec() {
			setTimeout(function() {
				if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) return callback(void 0);
				if (!execEditLength()) exec();
			}, 0);
		})();
		else while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
			const ret = execEditLength();
			if (ret) return ret;
		}
	}
	addToPath(path, added, removed, oldPosInc, options) {
		const last = path.lastComponent;
		if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) return {
			oldPos: path.oldPos + oldPosInc,
			lastComponent: {
				count: last.count + 1,
				added,
				removed,
				previousComponent: last.previousComponent
			}
		};
		else return {
			oldPos: path.oldPos + oldPosInc,
			lastComponent: {
				count: 1,
				added,
				removed,
				previousComponent: last
			}
		};
	}
	extractCommon(basePath, newTokens, oldTokens, diagonalPath, options) {
		const newLen = newTokens.length, oldLen = oldTokens.length;
		let oldPos = basePath.oldPos, newPos = oldPos - diagonalPath, commonCount = 0;
		while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(oldTokens[oldPos + 1], newTokens[newPos + 1], options)) {
			newPos++;
			oldPos++;
			commonCount++;
			if (options.oneChangePerToken) basePath.lastComponent = {
				count: 1,
				previousComponent: basePath.lastComponent,
				added: false,
				removed: false
			};
		}
		if (commonCount && !options.oneChangePerToken) basePath.lastComponent = {
			count: commonCount,
			previousComponent: basePath.lastComponent,
			added: false,
			removed: false
		};
		basePath.oldPos = oldPos;
		return newPos;
	}
	equals(left, right, options) {
		if (options.comparator) return options.comparator(left, right);
		else return left === right || !!options.ignoreCase && left.toLowerCase() === right.toLowerCase();
	}
	removeEmpty(array) {
		const ret = [];
		for (let i = 0; i < array.length; i++) if (array[i]) ret.push(array[i]);
		return ret;
	}
	castInput(value, options) {
		return value;
	}
	tokenize(value, options) {
		return Array.from(value);
	}
	join(chars) {
		return chars.join("");
	}
	postProcess(changeObjects, options) {
		return changeObjects;
	}
	get useLongestToken() {
		return false;
	}
	buildValues(lastComponent, newTokens, oldTokens) {
		const components = [];
		let nextComponent;
		while (lastComponent) {
			components.push(lastComponent);
			nextComponent = lastComponent.previousComponent;
			delete lastComponent.previousComponent;
			lastComponent = nextComponent;
		}
		components.reverse();
		const componentLen = components.length;
		let componentPos = 0, newPos = 0, oldPos = 0;
		for (; componentPos < componentLen; componentPos++) {
			const component = components[componentPos];
			if (!component.removed) {
				if (!component.added && this.useLongestToken) {
					let value = newTokens.slice(newPos, newPos + component.count);
					value = value.map(function(value, i) {
						const oldValue = oldTokens[oldPos + i];
						return oldValue.length > value.length ? oldValue : value;
					});
					component.value = this.join(value);
				} else component.value = this.join(newTokens.slice(newPos, newPos + component.count));
				newPos += component.count;
				if (!component.added) oldPos += component.count;
			} else {
				component.value = this.join(oldTokens.slice(oldPos, oldPos + component.count));
				oldPos += component.count;
			}
		}
		return components;
	}
};
//#endregion
//#region node_modules/.pnpm/diff@8.0.3/node_modules/diff/libesm/diff/character.js
var CharacterDiff = class extends Diff {};
const characterDiff = new CharacterDiff();
function diffChars(oldStr, newStr, options) {
	return characterDiff.diff(oldStr, newStr, options);
}
//#endregion
//#region node_modules/.pnpm/diff@8.0.3/node_modules/diff/libesm/util/string.js
function longestCommonPrefix(str1, str2) {
	let i;
	for (i = 0; i < str1.length && i < str2.length; i++) if (str1[i] != str2[i]) return str1.slice(0, i);
	return str1.slice(0, i);
}
function longestCommonSuffix(str1, str2) {
	let i;
	if (!str1 || !str2 || str1[str1.length - 1] != str2[str2.length - 1]) return "";
	for (i = 0; i < str1.length && i < str2.length; i++) if (str1[str1.length - (i + 1)] != str2[str2.length - (i + 1)]) return str1.slice(-i);
	return str1.slice(-i);
}
function replacePrefix(string, oldPrefix, newPrefix) {
	if (string.slice(0, oldPrefix.length) != oldPrefix) throw Error(`string ${JSON.stringify(string)} doesn't start with prefix ${JSON.stringify(oldPrefix)}; this is a bug`);
	return newPrefix + string.slice(oldPrefix.length);
}
function replaceSuffix(string, oldSuffix, newSuffix) {
	if (!oldSuffix) return string + newSuffix;
	if (string.slice(-oldSuffix.length) != oldSuffix) throw Error(`string ${JSON.stringify(string)} doesn't end with suffix ${JSON.stringify(oldSuffix)}; this is a bug`);
	return string.slice(0, -oldSuffix.length) + newSuffix;
}
function removePrefix(string, oldPrefix) {
	return replacePrefix(string, oldPrefix, "");
}
function removeSuffix(string, oldSuffix) {
	return replaceSuffix(string, oldSuffix, "");
}
function maximumOverlap(string1, string2) {
	return string2.slice(0, overlapCount(string1, string2));
}
function overlapCount(a, b) {
	let startA = 0;
	if (a.length > b.length) startA = a.length - b.length;
	let endB = b.length;
	if (a.length < b.length) endB = a.length;
	const map = Array(endB);
	let k = 0;
	map[0] = 0;
	for (let j = 1; j < endB; j++) {
		if (b[j] == b[k]) map[j] = map[k];
		else map[j] = k;
		while (k > 0 && b[j] != b[k]) k = map[k];
		if (b[j] == b[k]) k++;
	}
	k = 0;
	for (let i = startA; i < a.length; i++) {
		while (k > 0 && a[i] != b[k]) k = map[k];
		if (a[i] == b[k]) k++;
	}
	return k;
}
function trailingWs(string) {
	let i;
	for (i = string.length - 1; i >= 0; i--) if (!string[i].match(/\s/)) break;
	return string.substring(i + 1);
}
function leadingWs(string) {
	const match = string.match(/^\s*/);
	return match ? match[0] : "";
}
//#endregion
//#region node_modules/.pnpm/diff@8.0.3/node_modules/diff/libesm/diff/word.js
const extendedWordChars = "a-zA-Z0-9_\\u{AD}\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2C6}\\u{2C8}-\\u{2D7}\\u{2DE}-\\u{2FF}\\u{1E00}-\\u{1EFF}";
const tokenizeIncludingWhitespace = new RegExp(`[${extendedWordChars}]+|\\s+|[^${extendedWordChars}]`, "ug");
var WordDiff = class extends Diff {
	equals(left, right, options) {
		if (options.ignoreCase) {
			left = left.toLowerCase();
			right = right.toLowerCase();
		}
		return left.trim() === right.trim();
	}
	tokenize(value, options = {}) {
		let parts;
		if (options.intlSegmenter) {
			const segmenter = options.intlSegmenter;
			if (segmenter.resolvedOptions().granularity != "word") throw new Error("The segmenter passed must have a granularity of \"word\"");
			parts = [];
			for (const segmentObj of Array.from(segmenter.segment(value))) {
				const segment = segmentObj.segment;
				if (parts.length && /\s/.test(parts[parts.length - 1]) && /\s/.test(segment)) parts[parts.length - 1] += segment;
				else parts.push(segment);
			}
		} else parts = value.match(tokenizeIncludingWhitespace) || [];
		const tokens = [];
		let prevPart = null;
		parts.forEach((part) => {
			if (/\s/.test(part)) if (prevPart == null) tokens.push(part);
			else tokens.push(tokens.pop() + part);
			else if (prevPart != null && /\s/.test(prevPart)) if (tokens[tokens.length - 1] == prevPart) tokens.push(tokens.pop() + part);
			else tokens.push(prevPart + part);
			else tokens.push(part);
			prevPart = part;
		});
		return tokens;
	}
	join(tokens) {
		return tokens.map((token, i) => {
			if (i == 0) return token;
			else return token.replace(/^\s+/, "");
		}).join("");
	}
	postProcess(changes, options) {
		if (!changes || options.oneChangePerToken) return changes;
		let lastKeep = null;
		let insertion = null;
		let deletion = null;
		changes.forEach((change) => {
			if (change.added) insertion = change;
			else if (change.removed) deletion = change;
			else {
				if (insertion || deletion) dedupeWhitespaceInChangeObjects(lastKeep, deletion, insertion, change);
				lastKeep = change;
				insertion = null;
				deletion = null;
			}
		});
		if (insertion || deletion) dedupeWhitespaceInChangeObjects(lastKeep, deletion, insertion, null);
		return changes;
	}
};
new WordDiff();
function dedupeWhitespaceInChangeObjects(startKeep, deletion, insertion, endKeep) {
	if (deletion && insertion) {
		const oldWsPrefix = leadingWs(deletion.value);
		const oldWsSuffix = trailingWs(deletion.value);
		const newWsPrefix = leadingWs(insertion.value);
		const newWsSuffix = trailingWs(insertion.value);
		if (startKeep) {
			const commonWsPrefix = longestCommonPrefix(oldWsPrefix, newWsPrefix);
			startKeep.value = replaceSuffix(startKeep.value, newWsPrefix, commonWsPrefix);
			deletion.value = removePrefix(deletion.value, commonWsPrefix);
			insertion.value = removePrefix(insertion.value, commonWsPrefix);
		}
		if (endKeep) {
			const commonWsSuffix = longestCommonSuffix(oldWsSuffix, newWsSuffix);
			endKeep.value = replacePrefix(endKeep.value, newWsSuffix, commonWsSuffix);
			deletion.value = removeSuffix(deletion.value, commonWsSuffix);
			insertion.value = removeSuffix(insertion.value, commonWsSuffix);
		}
	} else if (insertion) {
		if (startKeep) {
			const ws = leadingWs(insertion.value);
			insertion.value = insertion.value.substring(ws.length);
		}
		if (endKeep) {
			const ws = leadingWs(endKeep.value);
			endKeep.value = endKeep.value.substring(ws.length);
		}
	} else if (startKeep && endKeep) {
		const newWsFull = leadingWs(endKeep.value), delWsStart = leadingWs(deletion.value), delWsEnd = trailingWs(deletion.value);
		const newWsStart = longestCommonPrefix(newWsFull, delWsStart);
		deletion.value = removePrefix(deletion.value, newWsStart);
		const newWsEnd = longestCommonSuffix(removePrefix(newWsFull, newWsStart), delWsEnd);
		deletion.value = removeSuffix(deletion.value, newWsEnd);
		endKeep.value = replacePrefix(endKeep.value, newWsFull, newWsEnd);
		startKeep.value = replaceSuffix(startKeep.value, newWsFull, newWsFull.slice(0, newWsFull.length - newWsEnd.length));
	} else if (endKeep) {
		const endKeepWsPrefix = leadingWs(endKeep.value);
		const overlap = maximumOverlap(trailingWs(deletion.value), endKeepWsPrefix);
		deletion.value = removeSuffix(deletion.value, overlap);
	} else if (startKeep) {
		const overlap = maximumOverlap(trailingWs(startKeep.value), leadingWs(deletion.value));
		deletion.value = removePrefix(deletion.value, overlap);
	}
}
var WordsWithSpaceDiff = class extends Diff {
	tokenize(value) {
		const regex = new RegExp(`(\\r?\\n)|[${extendedWordChars}]+|[^\\S\\n\\r]+|[^${extendedWordChars}]`, "ug");
		return value.match(regex) || [];
	}
};
const wordsWithSpaceDiff = new WordsWithSpaceDiff();
function diffWordsWithSpace(oldStr, newStr, options) {
	return wordsWithSpaceDiff.diff(oldStr, newStr, options);
}
//#endregion
//#region node_modules/.pnpm/diff@8.0.3/node_modules/diff/libesm/diff/line.js
var LineDiff = class extends Diff {
	constructor() {
		super(...arguments);
		this.tokenize = tokenize;
	}
	equals(left, right, options) {
		if (options.ignoreWhitespace) {
			if (!options.newlineIsToken || !left.includes("\n")) left = left.trim();
			if (!options.newlineIsToken || !right.includes("\n")) right = right.trim();
		} else if (options.ignoreNewlineAtEof && !options.newlineIsToken) {
			if (left.endsWith("\n")) left = left.slice(0, -1);
			if (right.endsWith("\n")) right = right.slice(0, -1);
		}
		return super.equals(left, right, options);
	}
};
const lineDiff = new LineDiff();
function diffLines(oldStr, newStr, options) {
	return lineDiff.diff(oldStr, newStr, options);
}
function tokenize(value, options) {
	if (options.stripTrailingCr) value = value.replace(/\r\n/g, "\n");
	const retLines = [], linesAndNewlines = value.split(/(\n|\r\n)/);
	if (!linesAndNewlines[linesAndNewlines.length - 1]) linesAndNewlines.pop();
	for (let i = 0; i < linesAndNewlines.length; i++) {
		const line = linesAndNewlines[i];
		if (i % 2 && !options.newlineIsToken) retLines[retLines.length - 1] += line;
		else retLines.push(line);
	}
	return retLines;
}
//#endregion
//#region node_modules/.pnpm/diff@8.0.3/node_modules/diff/libesm/diff/sentence.js
function isSentenceEndPunct(char) {
	return char == "." || char == "!" || char == "?";
}
var SentenceDiff = class extends Diff {
	tokenize(value) {
		var _a;
		const result = [];
		let tokenStartI = 0;
		for (let i = 0; i < value.length; i++) {
			if (i == value.length - 1) {
				result.push(value.slice(tokenStartI));
				break;
			}
			if (isSentenceEndPunct(value[i]) && value[i + 1].match(/\s/)) {
				result.push(value.slice(tokenStartI, i + 1));
				i = tokenStartI = i + 1;
				while ((_a = value[i + 1]) === null || _a === void 0 ? void 0 : _a.match(/\s/)) i++;
				result.push(value.slice(tokenStartI, i + 1));
				tokenStartI = i + 1;
			}
		}
		return result;
	}
};
new SentenceDiff();
//#endregion
//#region node_modules/.pnpm/diff@8.0.3/node_modules/diff/libesm/diff/css.js
var CssDiff = class extends Diff {
	tokenize(value) {
		return value.split(/([{}:;,]|\s+)/);
	}
};
new CssDiff();
//#endregion
//#region node_modules/.pnpm/diff@8.0.3/node_modules/diff/libesm/diff/json.js
var JsonDiff = class extends Diff {
	constructor() {
		super(...arguments);
		this.tokenize = tokenize;
	}
	get useLongestToken() {
		return true;
	}
	castInput(value, options) {
		const { undefinedReplacement, stringifyReplacer = (k, v) => typeof v === "undefined" ? undefinedReplacement : v } = options;
		return typeof value === "string" ? value : JSON.stringify(canonicalize(value, null, null, stringifyReplacer), null, "  ");
	}
	equals(left, right, options) {
		return super.equals(left.replace(/,([\r\n])/g, "$1"), right.replace(/,([\r\n])/g, "$1"), options);
	}
};
new JsonDiff();
function canonicalize(obj, stack, replacementStack, replacer, key) {
	stack = stack || [];
	replacementStack = replacementStack || [];
	if (replacer) obj = replacer(key === void 0 ? "" : key, obj);
	let i;
	for (i = 0; i < stack.length; i += 1) if (stack[i] === obj) return replacementStack[i];
	let canonicalizedObj;
	if ("[object Array]" === Object.prototype.toString.call(obj)) {
		stack.push(obj);
		canonicalizedObj = new Array(obj.length);
		replacementStack.push(canonicalizedObj);
		for (i = 0; i < obj.length; i += 1) canonicalizedObj[i] = canonicalize(obj[i], stack, replacementStack, replacer, String(i));
		stack.pop();
		replacementStack.pop();
		return canonicalizedObj;
	}
	if (obj && obj.toJSON) obj = obj.toJSON();
	if (typeof obj === "object" && obj !== null) {
		stack.push(obj);
		canonicalizedObj = {};
		replacementStack.push(canonicalizedObj);
		const sortedKeys = [];
		let key;
		for (key in obj)
 /* istanbul ignore else */
		if (Object.prototype.hasOwnProperty.call(obj, key)) sortedKeys.push(key);
		sortedKeys.sort();
		for (i = 0; i < sortedKeys.length; i += 1) {
			key = sortedKeys[i];
			canonicalizedObj[key] = canonicalize(obj[key], stack, replacementStack, replacer, key);
		}
		stack.pop();
		replacementStack.pop();
	} else canonicalizedObj = obj;
	return canonicalizedObj;
}
//#endregion
//#region node_modules/.pnpm/diff@8.0.3/node_modules/diff/libesm/diff/array.js
var ArrayDiff = class extends Diff {
	tokenize(value) {
		return value.slice();
	}
	join(value) {
		return value;
	}
	removeEmpty(value) {
		return value;
	}
};
new ArrayDiff();
//#endregion
//#region node_modules/.pnpm/diff@8.0.3/node_modules/diff/libesm/patch/create.js
const INCLUDE_HEADERS = {
	includeIndex: true,
	includeUnderline: true,
	includeFileHeaders: true
};
function structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
	let optionsObj;
	if (!options) optionsObj = {};
	else if (typeof options === "function") optionsObj = { callback: options };
	else optionsObj = options;
	if (typeof optionsObj.context === "undefined") optionsObj.context = 4;
	const context = optionsObj.context;
	if (optionsObj.newlineIsToken) throw new Error("newlineIsToken may not be used with patch-generation functions, only with diffing functions");
	if (!optionsObj.callback) return diffLinesResultToPatch(diffLines(oldStr, newStr, optionsObj));
	else {
		const { callback } = optionsObj;
		diffLines(oldStr, newStr, Object.assign(Object.assign({}, optionsObj), { callback: (diff) => {
			callback(diffLinesResultToPatch(diff));
		} }));
	}
	function diffLinesResultToPatch(diff) {
		if (!diff) return;
		diff.push({
			value: "",
			lines: []
		});
		function contextLines(lines) {
			return lines.map(function(entry) {
				return " " + entry;
			});
		}
		const hunks = [];
		let oldRangeStart = 0, newRangeStart = 0, curRange = [], oldLine = 1, newLine = 1;
		for (let i = 0; i < diff.length; i++) {
			const current = diff[i], lines = current.lines || splitLines(current.value);
			current.lines = lines;
			if (current.added || current.removed) {
				if (!oldRangeStart) {
					const prev = diff[i - 1];
					oldRangeStart = oldLine;
					newRangeStart = newLine;
					if (prev) {
						curRange = context > 0 ? contextLines(prev.lines.slice(-context)) : [];
						oldRangeStart -= curRange.length;
						newRangeStart -= curRange.length;
					}
				}
				for (const line of lines) curRange.push((current.added ? "+" : "-") + line);
				if (current.added) newLine += lines.length;
				else oldLine += lines.length;
			} else {
				if (oldRangeStart) if (lines.length <= context * 2 && i < diff.length - 2) for (const line of contextLines(lines)) curRange.push(line);
				else {
					const contextSize = Math.min(lines.length, context);
					for (const line of contextLines(lines.slice(0, contextSize))) curRange.push(line);
					const hunk = {
						oldStart: oldRangeStart,
						oldLines: oldLine - oldRangeStart + contextSize,
						newStart: newRangeStart,
						newLines: newLine - newRangeStart + contextSize,
						lines: curRange
					};
					hunks.push(hunk);
					oldRangeStart = 0;
					newRangeStart = 0;
					curRange = [];
				}
				oldLine += lines.length;
				newLine += lines.length;
			}
		}
		for (const hunk of hunks) for (let i = 0; i < hunk.lines.length; i++) if (hunk.lines[i].endsWith("\n")) hunk.lines[i] = hunk.lines[i].slice(0, -1);
		else {
			hunk.lines.splice(i + 1, 0, "\\ No newline at end of file");
			i++;
		}
		return {
			oldFileName,
			newFileName,
			oldHeader,
			newHeader,
			hunks
		};
	}
}
/**
* creates a unified diff patch.
* @param patch either a single structured patch object (as returned by `structuredPatch`) or an array of them (as returned by `parsePatch`)
*/
function formatPatch(patch, headerOptions) {
	if (!headerOptions) headerOptions = INCLUDE_HEADERS;
	if (Array.isArray(patch)) {
		if (patch.length > 1 && !headerOptions.includeFileHeaders) throw new Error("Cannot omit file headers on a multi-file patch. (The result would be unparseable; how would a tool trying to apply the patch know which changes are to which file?)");
		return patch.map((p) => formatPatch(p, headerOptions)).join("\n");
	}
	const ret = [];
	if (headerOptions.includeIndex && patch.oldFileName == patch.newFileName) ret.push("Index: " + patch.oldFileName);
	if (headerOptions.includeUnderline) ret.push("===================================================================");
	if (headerOptions.includeFileHeaders) {
		ret.push("--- " + patch.oldFileName + (typeof patch.oldHeader === "undefined" ? "" : "	" + patch.oldHeader));
		ret.push("+++ " + patch.newFileName + (typeof patch.newHeader === "undefined" ? "" : "	" + patch.newHeader));
	}
	for (let i = 0; i < patch.hunks.length; i++) {
		const hunk = patch.hunks[i];
		if (hunk.oldLines === 0) hunk.oldStart -= 1;
		if (hunk.newLines === 0) hunk.newStart -= 1;
		ret.push("@@ -" + hunk.oldStart + "," + hunk.oldLines + " +" + hunk.newStart + "," + hunk.newLines + " @@");
		for (const line of hunk.lines) ret.push(line);
	}
	return ret.join("\n") + "\n";
}
function createTwoFilesPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
	if (typeof options === "function") options = { callback: options };
	if (!(options === null || options === void 0 ? void 0 : options.callback)) {
		const patchObj = structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options);
		if (!patchObj) return;
		return formatPatch(patchObj, options === null || options === void 0 ? void 0 : options.headerOptions);
	} else {
		const { callback } = options;
		structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, Object.assign(Object.assign({}, options), { callback: (patchObj) => {
			if (!patchObj) callback(void 0);
			else callback(formatPatch(patchObj, options.headerOptions));
		} }));
	}
}
/**
* Split `text` into an array of lines, including the trailing newline character (where present)
*/
function splitLines(text) {
	const hasTrailingNl = text.endsWith("\n");
	const result = text.split("\n").map((line) => line + "\n");
	if (hasTrailingNl) result.pop();
	else result.push(result.pop().slice(0, -1));
	return result;
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/parseDiffDecorations.js
function createDiffSpanDecoration({ line, spanStart, spanLength }) {
	return {
		start: {
			line,
			character: spanStart
		},
		end: {
			line,
			character: spanStart + spanLength
		},
		properties: { "data-diff-span": "" },
		alwaysWrap: true
	};
}
function pushOrJoinSpan({ item, arr, enableJoin, isNeutral = false, isLastItem = false }) {
	const lastItem = arr[arr.length - 1];
	if (lastItem == null || isLastItem || !enableJoin) {
		arr.push([isNeutral ? 0 : 1, item.value]);
		return;
	}
	const isLastItemNeutral = lastItem[0] === 0;
	if (isNeutral === isLastItemNeutral || isNeutral && item.value.length === 1 && !isLastItemNeutral) {
		lastItem[1] += item.value;
		return;
	}
	arr.push([isNeutral ? 0 : 1, item.value]);
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/renderDiffWithHighlighter.js
function renderDiffWithHighlighter(diff, highlighter, options, forcePlainText = false) {
	const baseThemeType = (() => {
		const theme = options.theme ?? DEFAULT_THEMES;
		if (typeof theme === "string") return highlighter.getTheme(theme).type;
	})();
	const themeStyles = getHighlighterThemeStyles({
		theme: options.theme,
		highlighter
	});
	if (diff.newLines != null && diff.oldLines != null) {
		const { oldContent, newContent, oldInfo, newInfo, oldDecorations, newDecorations } = processLines({
			hunks: diff.hunks,
			oldLines: diff.oldLines,
			newLines: diff.newLines,
			lineDiffType: options.lineDiffType
		});
		return {
			code: renderTwoFiles({
				oldFile: {
					name: diff.prevName ?? diff.name,
					contents: oldContent
				},
				oldInfo,
				oldDecorations,
				newFile: {
					name: diff.name,
					contents: newContent
				},
				newInfo,
				newDecorations,
				highlighter,
				options,
				languageOverride: forcePlainText ? "text" : diff.lang
			}),
			themeStyles,
			baseThemeType
		};
	}
	const hunks = [];
	let splitLineIndex = 0;
	let unifiedLineIndex = 0;
	for (const hunk of diff.hunks) {
		const { oldContent, newContent, oldInfo, newInfo, oldDecorations, newDecorations, splitLineIndex: newSplitLineIndex, unifiedLineIndex: newUnifiedLineIndex } = processLines({
			hunks: [hunk],
			splitLineIndex,
			unifiedLineIndex,
			lineDiffType: options.lineDiffType
		});
		const oldFile = {
			name: diff.prevName ?? diff.name,
			contents: oldContent
		};
		const newFile = {
			name: diff.name,
			contents: newContent
		};
		hunks.push(renderTwoFiles({
			oldFile,
			oldInfo,
			oldDecorations,
			newFile,
			newInfo,
			newDecorations,
			highlighter,
			options,
			languageOverride: forcePlainText ? "text" : diff.lang
		}));
		splitLineIndex = newSplitLineIndex;
		unifiedLineIndex = newUnifiedLineIndex;
	}
	return {
		code: (() => {
			if (hunks.length <= 1) {
				const hunk = hunks[0] ?? {
					oldLines: [],
					newLines: []
				};
				if (hunk.newLines.length === 0 || hunk.oldLines.length === 0) return hunk;
			}
			return { hunks };
		})(),
		themeStyles,
		baseThemeType
	};
}
function computeLineDiffDecorations({ oldLine, newLine, oldLineIndex, newLineIndex, oldDecorations, newDecorations, lineDiffType }) {
	if (oldLine == null || newLine == null || lineDiffType === "none") return;
	oldLine = cleanLastNewline(oldLine);
	newLine = cleanLastNewline(newLine);
	const lineDiff = lineDiffType === "char" ? diffChars(oldLine, newLine) : diffWordsWithSpace(oldLine, newLine);
	const deletionSpans = [];
	const additionSpans = [];
	const enableJoin = lineDiffType === "word-alt";
	for (const item of lineDiff) {
		const isLastItem = item === lineDiff[lineDiff.length - 1];
		if (!item.added && !item.removed) {
			pushOrJoinSpan({
				item,
				arr: deletionSpans,
				enableJoin,
				isNeutral: true,
				isLastItem
			});
			pushOrJoinSpan({
				item,
				arr: additionSpans,
				enableJoin,
				isNeutral: true,
				isLastItem
			});
		} else if (item.removed) pushOrJoinSpan({
			item,
			arr: deletionSpans,
			enableJoin,
			isLastItem
		});
		else pushOrJoinSpan({
			item,
			arr: additionSpans,
			enableJoin,
			isLastItem
		});
	}
	let spanIndex = 0;
	for (const span of deletionSpans) {
		if (span[0] === 1) oldDecorations.push(createDiffSpanDecoration({
			line: oldLineIndex - 1,
			spanStart: spanIndex,
			spanLength: span[1].length
		}));
		spanIndex += span[1].length;
	}
	spanIndex = 0;
	for (const span of additionSpans) {
		if (span[0] === 1) newDecorations.push(createDiffSpanDecoration({
			line: newLineIndex - 1,
			spanStart: spanIndex,
			spanLength: span[1].length
		}));
		spanIndex += span[1].length;
	}
}
function processLines({ hunks, oldLines, newLines, splitLineIndex = 0, unifiedLineIndex = 0, lineDiffType }) {
	const oldInfo = {};
	const newInfo = {};
	const oldDecorations = [];
	const newDecorations = [];
	let newLineIndex = 1;
	let oldLineIndex = 1;
	let newLineNumber = 1;
	let oldLineNumber = 1;
	let oldContent = "";
	let newContent = "";
	for (const hunk of hunks) {
		while (oldLines != null && newLines != null && newLineIndex < hunk.additionStart && oldLineIndex < hunk.deletionStart) {
			oldInfo[oldLineIndex] = {
				type: "context-expanded",
				lineNumber: oldLineNumber,
				altLineNumber: newLineNumber,
				lineIndex: `${unifiedLineIndex},${splitLineIndex}`
			};
			newInfo[newLineIndex] = {
				type: "context-expanded",
				lineNumber: newLineNumber,
				altLineNumber: oldLineNumber,
				lineIndex: `${unifiedLineIndex},${splitLineIndex}`
			};
			oldContent += oldLines[oldLineIndex - 1];
			newContent += newLines[newLineIndex - 1];
			oldLineIndex++;
			newLineIndex++;
			oldLineNumber++;
			newLineNumber++;
			splitLineIndex++;
			unifiedLineIndex++;
		}
		oldLineNumber = hunk.deletionStart;
		newLineNumber = hunk.additionStart;
		for (const hunkContent of hunk.hunkContent) if (hunkContent.type === "context") for (const line of hunkContent.lines) {
			oldInfo[oldLineIndex] = {
				type: "context",
				lineNumber: oldLineNumber,
				altLineNumber: newLineNumber,
				lineIndex: `${unifiedLineIndex},${splitLineIndex}`
			};
			newInfo[newLineIndex] = {
				type: "context",
				lineNumber: newLineNumber,
				altLineNumber: oldLineNumber,
				lineIndex: `${unifiedLineIndex},${splitLineIndex}`
			};
			oldContent += line;
			newContent += line;
			oldLineIndex++;
			newLineIndex++;
			newLineNumber++;
			oldLineNumber++;
			splitLineIndex++;
			unifiedLineIndex++;
		}
		else {
			const len = Math.max(hunkContent.additions.length, hunkContent.deletions.length);
			let i = 0;
			let _unifiedLineIndex = unifiedLineIndex;
			while (i < len) {
				const oldLine = hunkContent.deletions[i];
				const newLine = hunkContent.additions[i];
				computeLineDiffDecorations({
					newLine,
					oldLine,
					oldLineIndex,
					newLineIndex,
					oldDecorations,
					newDecorations,
					lineDiffType
				});
				if (oldLine != null) {
					oldInfo[oldLineIndex] = {
						type: "change-deletion",
						lineNumber: oldLineNumber,
						lineIndex: `${_unifiedLineIndex},${splitLineIndex}`
					};
					oldContent += oldLine;
					oldLineIndex++;
					oldLineNumber++;
				}
				if (newLine != null) {
					newInfo[newLineIndex] = {
						type: "change-addition",
						lineNumber: newLineNumber,
						lineIndex: `${_unifiedLineIndex + hunkContent.deletions.length},${splitLineIndex}`
					};
					newContent += newLine;
					newLineIndex++;
					newLineNumber++;
				}
				splitLineIndex++;
				_unifiedLineIndex++;
				i++;
			}
			unifiedLineIndex += hunkContent.additions.length + hunkContent.deletions.length;
		}
		if (oldLines == null || newLines == null || hunk !== hunks[hunks.length - 1]) continue;
		while (oldLineIndex <= oldLines.length || newLineIndex <= oldLines.length) {
			const oldLine = oldLines[oldLineIndex - 1];
			const newLine = newLines[newLineIndex - 1];
			if (oldLine == null && newLine == null) break;
			if (oldLine != null) {
				oldInfo[oldLineIndex] = {
					type: "context-expanded",
					lineNumber: oldLineNumber,
					altLineNumber: newLineNumber,
					lineIndex: `${unifiedLineIndex},${splitLineIndex}`
				};
				oldContent += oldLine;
				oldLineIndex++;
				oldLineNumber++;
			}
			if (newLine != null) {
				newInfo[newLineIndex] = {
					type: "context-expanded",
					lineNumber: newLineNumber,
					altLineNumber: oldLineNumber,
					lineIndex: `${unifiedLineIndex},${splitLineIndex}`
				};
				newContent += newLine;
				newLineIndex++;
				newLineNumber++;
			}
			splitLineIndex++;
			unifiedLineIndex++;
		}
	}
	return {
		oldContent,
		newContent,
		oldInfo,
		newInfo,
		oldDecorations,
		newDecorations,
		splitLineIndex,
		unifiedLineIndex
	};
}
function renderTwoFiles({ oldFile, newFile, oldInfo, newInfo, highlighter, oldDecorations, newDecorations, languageOverride, options: { theme: themeOrThemes = DEFAULT_THEMES, ...options } }) {
	const oldLang = languageOverride ?? getFiletypeFromFileName(oldFile.name);
	const newLang = languageOverride ?? getFiletypeFromFileName(newFile.name);
	const { state, transformers } = createTransformerWithState();
	const hastConfig = typeof themeOrThemes === "string" ? {
		...options,
		lang: "text",
		theme: themeOrThemes,
		transformers,
		decorations: void 0,
		defaultColor: false,
		cssVariablePrefix: formatCSSVariablePrefix("token")
	} : {
		...options,
		lang: "text",
		themes: themeOrThemes,
		transformers,
		decorations: void 0,
		defaultColor: false,
		cssVariablePrefix: formatCSSVariablePrefix("token")
	};
	return {
		oldLines: (() => {
			if (oldFile.contents === "") return [];
			hastConfig.lang = oldLang;
			state.lineInfo = oldInfo;
			hastConfig.decorations = oldDecorations;
			return getLineNodes(highlighter.codeToHast(cleanLastNewline(oldFile.contents), hastConfig));
		})(),
		newLines: (() => {
			if (newFile.contents === "") return [];
			hastConfig.lang = newLang;
			hastConfig.decorations = newDecorations;
			state.lineInfo = newInfo;
			return getLineNodes(highlighter.codeToHast(cleanLastNewline(newFile.contents), hastConfig));
		})()
	};
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/renderers/DiffHunksRenderer.js
const EXPANDED_REGION = {
	fromStart: 0,
	fromEnd: 0
};
var DiffHunksRenderer = class {
	highlighter;
	diff;
	expandedHunks = /* @__PURE__ */ new Map();
	deletionAnnotations = {};
	additionAnnotations = {};
	computedLang = "text";
	renderCache;
	constructor(options = { theme: DEFAULT_THEMES }, onRenderUpdate, workerManager) {
		this.options = options;
		this.onRenderUpdate = onRenderUpdate;
		this.workerManager = workerManager;
		if (workerManager?.isWorkingPool() !== true) this.highlighter = areThemesAttached(options.theme ?? DEFAULT_THEMES) ? getHighlighterIfLoaded() : void 0;
	}
	cleanUp() {
		this.highlighter = void 0;
		this.diff = void 0;
		this.renderCache = void 0;
		this.workerManager = void 0;
		this.onRenderUpdate = void 0;
	}
	setOptions(options) {
		this.options = options;
	}
	mergeOptions(options) {
		this.options = {
			...this.options,
			...options
		};
	}
	setThemeType(themeType) {
		if (this.getOptionsWithDefaults().themeType === themeType) return;
		this.mergeOptions({ themeType });
	}
	expandHunk(index, direction) {
		const { expansionLineCount } = this.getOptionsWithDefaults();
		const region = this.expandedHunks.get(index) ?? {
			fromStart: 0,
			fromEnd: 0
		};
		if (direction === "up" || direction === "both") region.fromStart += expansionLineCount;
		if (direction === "down" || direction === "both") region.fromEnd += expansionLineCount;
		this.expandedHunks.set(index, region);
	}
	setLineAnnotations(lineAnnotations) {
		this.additionAnnotations = {};
		this.deletionAnnotations = {};
		for (const annotation of lineAnnotations) {
			const map = (() => {
				switch (annotation.side) {
					case "deletions": return this.deletionAnnotations;
					case "additions": return this.additionAnnotations;
				}
			})();
			const arr = map[annotation.lineNumber] ?? [];
			map[annotation.lineNumber] = arr;
			arr.push(annotation);
		}
	}
	getOptionsWithDefaults() {
		const { diffIndicators = "bars", diffStyle = "split", disableBackground = false, disableFileHeader = false, disableLineNumbers = false, expandUnchanged = false, expansionLineCount = 100, hunkSeparators = "line-info", lineDiffType = "word-alt", maxLineDiffLength = 1e3, overflow = "scroll", theme = DEFAULT_THEMES, themeType = "system", tokenizeMaxLineLength = 1e3, useCSSClasses = false } = this.options;
		return {
			diffIndicators,
			diffStyle,
			disableBackground,
			disableFileHeader,
			disableLineNumbers,
			expandUnchanged,
			expansionLineCount,
			hunkSeparators,
			lineDiffType,
			maxLineDiffLength,
			overflow,
			theme: this.workerManager?.getDiffRenderOptions().theme ?? theme,
			themeType,
			tokenizeMaxLineLength,
			useCSSClasses
		};
	}
	async initializeHighlighter() {
		this.highlighter = await getSharedHighlighter(getHighlighterOptions(this.computedLang, this.options));
		return this.highlighter;
	}
	hydrate(diff) {
		if (diff == null) return;
		this.diff = diff;
		const { options } = this.getRenderOptions(diff);
		let cache = this.workerManager?.getDiffResultCache(diff);
		if (cache != null && !areRenderOptionsEqual(options, cache.options)) cache = void 0;
		this.renderCache ??= {
			diff,
			highlighted: true,
			options,
			result: cache?.result
		};
		if (this.workerManager?.isWorkingPool() === true && this.renderCache.result == null) this.workerManager.highlightDiffAST(this, this.diff);
		else this.asyncHighlight(diff).then(({ result, options: options$1 }) => {
			this.onHighlightSuccess(diff, result, options$1);
		});
	}
	getRenderOptions(diff) {
		const options = (() => {
			if (this.workerManager?.isWorkingPool() === true) return this.workerManager.getDiffRenderOptions();
			const { theme, tokenizeMaxLineLength, lineDiffType } = this.getOptionsWithDefaults();
			return {
				theme,
				tokenizeMaxLineLength,
				lineDiffType
			};
		})();
		this.getOptionsWithDefaults();
		const { renderCache } = this;
		if (renderCache?.result == null) return {
			options,
			forceRender: true
		};
		if (diff !== renderCache.diff || !areRenderOptionsEqual(options, renderCache.options)) return {
			options,
			forceRender: true
		};
		return {
			options,
			forceRender: false
		};
	}
	renderDiff(diff = this.renderCache?.diff) {
		if (diff == null) return;
		const cache = this.workerManager?.getDiffResultCache(diff);
		if (cache != null && this.renderCache == null) this.renderCache = {
			diff,
			highlighted: true,
			...cache
		};
		const { options, forceRender } = this.getRenderOptions(diff);
		this.renderCache ??= {
			diff,
			highlighted: false,
			options,
			result: void 0
		};
		if (this.workerManager?.isWorkingPool() === true) {
			this.renderCache.result ??= this.workerManager.getPlainDiffAST(diff);
			if (!this.renderCache.highlighted || forceRender) this.workerManager.highlightDiffAST(this, diff);
		} else {
			this.computedLang = diff.lang ?? getFiletypeFromFileName(diff.name);
			const hasThemes = this.highlighter != null && areThemesAttached(options.theme);
			const hasLangs = this.highlighter != null && areLanguagesAttached(this.computedLang);
			if (this.highlighter != null && hasThemes && (forceRender || !this.renderCache.highlighted && hasLangs || this.renderCache.result == null)) {
				const { result, options: options$1 } = this.renderDiffWithHighlighter(diff, this.highlighter, !hasLangs);
				this.renderCache = {
					diff,
					options: options$1,
					highlighted: hasLangs,
					result
				};
			}
			if (!hasThemes || !hasLangs) this.asyncHighlight(diff).then(({ result, options: options$1 }) => {
				this.onHighlightSuccess(diff, result, options$1);
			});
		}
		return this.renderCache.result != null ? this.processDiffResult(this.renderCache.diff, this.renderCache.result) : void 0;
	}
	async asyncRender(diff) {
		const { result } = await this.asyncHighlight(diff);
		return this.processDiffResult(diff, result);
	}
	createPreElement(split, totalLines, themeStyles, baseThemeType) {
		const { diffIndicators, disableBackground, disableLineNumbers, overflow, themeType } = this.getOptionsWithDefaults();
		return createPreElement({
			diffIndicators,
			disableBackground,
			disableLineNumbers,
			overflow,
			themeStyles,
			split,
			themeType: baseThemeType ?? themeType,
			totalLines
		});
	}
	async asyncHighlight(diff) {
		this.computedLang = diff.lang ?? getFiletypeFromFileName(diff.name);
		const hasThemes = this.highlighter != null && areThemesAttached(this.options.theme ?? DEFAULT_THEMES);
		const hasLangs = this.highlighter != null && areLanguagesAttached(this.computedLang);
		if (this.highlighter == null || !hasThemes || !hasLangs) this.highlighter = await this.initializeHighlighter();
		return this.renderDiffWithHighlighter(diff, this.highlighter);
	}
	renderDiffWithHighlighter(diff, highlighter, plainText = false) {
		const { options } = this.getRenderOptions(diff);
		return {
			result: renderDiffWithHighlighter(diff, highlighter, options, plainText),
			options
		};
	}
	onHighlightSuccess(diff, result, options) {
		if (this.renderCache == null) return;
		const triggerRenderUpdate = this.renderCache.diff !== diff || !this.renderCache.highlighted || !areRenderOptionsEqual(this.renderCache.options, options);
		this.renderCache = {
			diff,
			options,
			highlighted: true,
			result
		};
		if (triggerRenderUpdate) this.onRenderUpdate?.();
	}
	onHighlightError(error) {
		console.error(error);
	}
	processDiffResult(fileDiff, { code, themeStyles, baseThemeType }) {
		const { diffStyle, disableFileHeader } = this.getOptionsWithDefaults();
		this.diff = fileDiff;
		const unified = diffStyle === "unified";
		let additionsAST = [];
		let deletionsAST = [];
		let unifiedAST = [];
		let hunkIndex = 0;
		const hunkData = [];
		let prevHunk;
		let lineIndex = 0;
		for (const hunk of fileDiff.hunks) {
			lineIndex += hunk.collapsedBefore;
			lineIndex = this.renderHunks({
				ast: code,
				hunk,
				prevHunk,
				hunkIndex,
				isLastHunk: hunkIndex === fileDiff.hunks.length - 1,
				additionsAST,
				deletionsAST,
				unifiedAST,
				hunkData,
				lineIndex
			});
			hunkIndex++;
			prevHunk = hunk;
		}
		const totalLines = Math.max(getTotalLineCountFromHunks(fileDiff.hunks), fileDiff.newLines?.length ?? 0, fileDiff.oldLines?.length ?? 0);
		additionsAST = !unified && (code.hunks != null || code.newLines.length > 0) ? additionsAST : void 0;
		deletionsAST = !unified && (code.hunks != null || code.oldLines.length > 0) ? deletionsAST : void 0;
		unifiedAST = unifiedAST.length > 0 ? unifiedAST : void 0;
		const preNode = this.createPreElement(deletionsAST != null && additionsAST != null, totalLines, themeStyles, baseThemeType);
		return {
			additionsAST,
			deletionsAST,
			unifiedAST,
			hunkData,
			preNode,
			themeStyles,
			baseThemeType,
			headerElement: !disableFileHeader ? this.renderHeader(this.diff, themeStyles, baseThemeType) : void 0,
			totalLines,
			css: ""
		};
	}
	renderFullAST(result, children = []) {
		if (result.unifiedAST != null) children.push(createHastElement({
			tagName: "code",
			children: result.unifiedAST,
			properties: {
				"data-code": "",
				"data-unified": ""
			}
		}));
		if (result.deletionsAST != null) children.push(createHastElement({
			tagName: "code",
			children: result.deletionsAST,
			properties: {
				"data-code": "",
				"data-deletions": ""
			}
		}));
		if (result.additionsAST != null) children.push(createHastElement({
			tagName: "code",
			children: result.additionsAST,
			properties: {
				"data-code": "",
				"data-additions": ""
			}
		}));
		return {
			...result.preNode,
			children
		};
	}
	renderFullHTML(result, tempChildren = []) {
		return toHtml(this.renderFullAST(result, tempChildren));
	}
	renderPartialHTML(children, columnType) {
		if (columnType == null) return toHtml(children);
		return toHtml(createHastElement({
			tagName: "code",
			children,
			properties: {
				"data-code": "",
				[`data-${columnType}`]: ""
			}
		}));
	}
	renderCollapsedHunks({ ast, hunkData, hunkIndex, hunkSpecs, isFirstHunk, isLastHunk, rangeSize, lineIndex, additionLineNumber, deletionLineNumber, unifiedAST, deletionsAST, additionsAST }) {
		if (rangeSize <= 0) return;
		const { hunkSeparators, expandUnchanged, diffStyle, expansionLineCount } = this.getOptionsWithDefaults();
		const expandable = ast.hunks == null && ast.newLines.length > 0 && ast.oldLines.length > 0;
		const expandedRegion = this.expandedHunks.get(hunkIndex) ?? EXPANDED_REGION;
		const chunked = rangeSize > expansionLineCount;
		const collapsedLines = Math.max(!expandUnchanged ? rangeSize - (expandedRegion.fromEnd + expandedRegion.fromStart) : 0, 0);
		const pushHunkSeparator = ({ type, linesAST }) => {
			if (hunkSeparators === "line-info" || hunkSeparators === "custom") {
				const slotName = getHunkSeparatorSlotName(type, hunkIndex);
				linesAST.push(createSeparator({
					type: hunkSeparators,
					content: getModifiedLinesString(collapsedLines),
					expandIndex: expandable ? hunkIndex : void 0,
					chunked,
					slotName,
					isFirstHunk,
					isLastHunk
				}));
				hunkData.push({
					slotName,
					hunkIndex,
					lines: collapsedLines,
					type,
					expandable: expandable ? {
						up: expandable && !isFirstHunk,
						down: expandable,
						chunked
					} : void 0
				});
			} else if (hunkSeparators === "metadata" && hunkSpecs != null) linesAST.push(createSeparator({
				type: "metadata",
				content: hunkSpecs,
				isFirstHunk,
				isLastHunk
			}));
			else if (hunkSeparators === "simple" && hunkIndex > 0) linesAST.push(createSeparator({
				type: "simple",
				isFirstHunk,
				isLastHunk: false
			}));
		};
		const renderRange = ({ rangeLen, fromStart }) => {
			if (ast.newLines == null || ast.oldLines == null) return;
			const offset = isLastHunk ? 0 : fromStart ? rangeSize : rangeLen;
			let dLineNumber = deletionLineNumber - offset;
			let aLineNumber = additionLineNumber - offset;
			let lIndex = lineIndex - offset;
			for (let i = 0; i < rangeLen; i++) {
				const oldLine = ast.oldLines[dLineNumber];
				const newLine = ast.newLines[aLineNumber];
				if (oldLine == null || newLine == null) {
					console.error({
						aLineNumber,
						dLineNumber,
						ast
					});
					throw new Error("DiffHunksRenderer.renderHunks prefill context invalid. Must include data for old and new lines");
				}
				dLineNumber++;
				aLineNumber++;
				if (diffStyle === "unified") this.pushLineWithAnnotation({
					newLine,
					unifiedAST,
					unifiedSpan: this.getAnnotations("unified", dLineNumber, aLineNumber, hunkIndex, lIndex)
				});
				else this.pushLineWithAnnotation({
					newLine,
					oldLine,
					additionsAST,
					deletionsAST,
					...this.getAnnotations("split", dLineNumber, aLineNumber, hunkIndex, lIndex)
				});
				lIndex++;
			}
		};
		if (expandable) renderRange({
			rangeLen: Math.min(collapsedLines === 0 || expandUnchanged ? rangeSize : expandedRegion.fromStart, rangeSize),
			fromStart: true
		});
		if (collapsedLines > 0) if (diffStyle === "unified") pushHunkSeparator({
			type: "unified",
			linesAST: unifiedAST
		});
		else {
			pushHunkSeparator({
				type: "deletions",
				linesAST: deletionsAST
			});
			pushHunkSeparator({
				type: "additions",
				linesAST: additionsAST
			});
		}
		if (collapsedLines > 0 && expandedRegion.fromEnd > 0 && !isLastHunk) renderRange({
			rangeLen: Math.min(expandedRegion.fromEnd, rangeSize),
			fromStart: false
		});
	}
	renderHunks({ hunk, hunkData, hunkIndex, lineIndex, isLastHunk, prevHunk, ast, deletionsAST, additionsAST, unifiedAST }) {
		const { diffStyle } = this.getOptionsWithDefaults();
		const unified = diffStyle === "unified";
		let additionLineNumber = hunk.additionStart - 1;
		let deletionLineNumber = hunk.deletionStart - 1;
		this.renderCollapsedHunks({
			additionLineNumber,
			additionsAST,
			ast,
			deletionLineNumber,
			deletionsAST,
			hunkData,
			hunkIndex,
			hunkSpecs: hunk.hunkSpecs,
			isFirstHunk: prevHunk == null,
			isLastHunk: false,
			lineIndex,
			rangeSize: Math.max(hunk.collapsedBefore, 0),
			unifiedAST
		});
		let { oldLines, newLines, oldIndex, newIndex } = (() => {
			if (ast.hunks != null) {
				const lineHunk = ast.hunks[hunkIndex];
				if (lineHunk == null) {
					console.error({
						ast,
						hunkIndex
					});
					throw new Error(`DiffHunksRenderer.renderHunks: lineHunk doesn't exist`);
				}
				return {
					oldLines: lineHunk.oldLines,
					newLines: lineHunk.newLines,
					oldIndex: 0,
					newIndex: 0
				};
			}
			return {
				oldLines: ast.oldLines,
				newLines: ast.newLines,
				oldIndex: deletionLineNumber,
				newIndex: additionLineNumber
			};
		})();
		for (const hunkContent of hunk.hunkContent) if (hunkContent.type === "context") {
			const { length: len } = hunkContent.lines;
			for (let i = 0; i < len; i++) {
				const oldLine = oldLines[oldIndex];
				const newLine = newLines[newIndex];
				oldIndex++;
				newIndex++;
				additionLineNumber++;
				deletionLineNumber++;
				if (unified) {
					if (newLine == null) throw new Error("DiffHunksRenderer.renderHunks: newLine doesnt exist for context...");
					this.pushLineWithAnnotation({
						newLine,
						unifiedAST,
						unifiedSpan: this.getAnnotations("unified", deletionLineNumber, additionLineNumber, hunkIndex, lineIndex)
					});
				} else {
					if (newLine == null || oldLine == null) throw new Error("DiffHunksRenderer.renderHunks: newLine or oldLine doesnt exist for context...");
					this.pushLineWithAnnotation({
						oldLine,
						newLine,
						deletionsAST,
						additionsAST,
						...this.getAnnotations("split", deletionLineNumber, additionLineNumber, hunkIndex, lineIndex)
					});
				}
				lineIndex++;
			}
			if (hunkContent.noEOFCR) {
				const node = createNoNewlineElement("context");
				if (unified) unifiedAST.push(node);
				else {
					deletionsAST.push(node);
					additionsAST.push(node);
				}
			}
		} else {
			const { length: dLen } = hunkContent.deletions;
			const { length: aLen } = hunkContent.additions;
			const len = unified ? dLen + aLen : Math.max(dLen, aLen);
			let spanSize = 0;
			for (let i = 0; i < len; i++) {
				const { oldLine, newLine } = (() => {
					let oldLine$1 = oldLines[oldIndex];
					let newLine$1 = newLines[newIndex];
					if (unified) if (i < dLen) newLine$1 = void 0;
					else oldLine$1 = void 0;
					else {
						if (i >= dLen) oldLine$1 = void 0;
						if (i >= aLen) newLine$1 = void 0;
					}
					if (oldLine$1 == null && newLine$1 == null) {
						console.error({
							i,
							len,
							ast,
							hunkContent
						});
						throw new Error("renderHunks: oldLine and newLine are null, something is wrong");
					}
					return {
						oldLine: oldLine$1,
						newLine: newLine$1
					};
				})();
				if (oldLine != null) {
					oldIndex++;
					deletionLineNumber++;
				}
				if (newLine != null) {
					newIndex++;
					additionLineNumber++;
				}
				if (unified) {
					this.pushLineWithAnnotation({
						oldLine,
						newLine,
						unifiedAST,
						unifiedSpan: this.getAnnotations("unified", oldLine != null ? deletionLineNumber : void 0, newLine != null ? additionLineNumber : void 0, hunkIndex, lineIndex)
					});
					lineIndex++;
				} else {
					if (oldLine == null || newLine == null) spanSize++;
					const annotationSpans = this.getAnnotations("split", oldLine != null ? deletionLineNumber : void 0, newLine != null ? additionLineNumber : void 0, hunkIndex, lineIndex);
					if (annotationSpans != null) {
						if (spanSize > 0) {
							if (aLen > dLen) deletionsAST.push(createEmptyRowBuffer(spanSize));
							else additionsAST.push(createEmptyRowBuffer(spanSize));
							spanSize = 0;
						}
					}
					this.pushLineWithAnnotation({
						newLine,
						oldLine,
						deletionsAST,
						additionsAST,
						...annotationSpans
					});
					lineIndex++;
				}
			}
			if (!unified) {
				if (spanSize > 0) {
					if (aLen > dLen) deletionsAST.push(createEmptyRowBuffer(spanSize));
					else additionsAST.push(createEmptyRowBuffer(spanSize));
					spanSize = 0;
				}
				if (hunkContent.noEOFCRDeletions) {
					deletionsAST.push(createNoNewlineElement("change-deletion"));
					if (!hunkContent.noEOFCRAdditions) additionsAST.push(createEmptyRowBuffer(1));
				}
				if (hunkContent.noEOFCRAdditions) {
					additionsAST.push(createNoNewlineElement("change-addition"));
					if (!hunkContent.noEOFCRDeletions) deletionsAST.push(createEmptyRowBuffer(1));
				}
			}
		}
		if (isLastHunk && ast.newLines != null && ast.newLines.length > 0) this.renderCollapsedHunks({
			additionLineNumber,
			additionsAST,
			ast,
			deletionLineNumber,
			deletionsAST,
			hunkData,
			hunkIndex: hunkIndex + 1,
			hunkSpecs: void 0,
			isFirstHunk: false,
			isLastHunk: true,
			lineIndex,
			rangeSize: Math.max(ast.newLines.length - Math.max(hunk.additionStart + hunk.additionCount - 1, 0), 0),
			unifiedAST
		});
		return lineIndex;
	}
	pushLineWithAnnotation({ newLine, oldLine, unifiedAST, additionsAST, deletionsAST, unifiedSpan, deletionSpan, additionSpan }) {
		if (unifiedAST != null) {
			if (oldLine != null) unifiedAST.push(oldLine);
			else if (newLine != null) unifiedAST.push(newLine);
			if (unifiedSpan != null) unifiedAST.push(createAnnotationElement(unifiedSpan));
		} else if (deletionsAST != null && additionsAST != null) {
			if (oldLine != null) deletionsAST.push(oldLine);
			if (newLine != null) additionsAST.push(newLine);
			if (deletionSpan != null) deletionsAST.push(createAnnotationElement(deletionSpan));
			if (additionSpan != null) additionsAST.push(createAnnotationElement(additionSpan));
		}
	}
	getAnnotations(type, oldLineNumber, newLineNumber, hunkIndex, lineIndex) {
		const deletionSpan = {
			type: "annotation",
			hunkIndex,
			lineIndex,
			annotations: []
		};
		if (oldLineNumber != null) for (const anno of this.deletionAnnotations[oldLineNumber] ?? []) deletionSpan.annotations.push(getLineAnnotationName(anno));
		const additionSpan = {
			type: "annotation",
			hunkIndex,
			lineIndex,
			annotations: []
		};
		if (newLineNumber != null) for (const anno of this.additionAnnotations[newLineNumber] ?? []) (type === "unified" ? deletionSpan : additionSpan).annotations.push(getLineAnnotationName(anno));
		if (type === "unified") {
			if (deletionSpan.annotations.length > 0) return deletionSpan;
			return;
		}
		if (additionSpan.annotations.length === 0 && deletionSpan.annotations.length === 0) return;
		return {
			deletionSpan,
			additionSpan
		};
	}
	renderHeader(diff, themeStyles, baseThemeType) {
		const { themeType } = this.getOptionsWithDefaults();
		return createFileHeaderElement({
			fileOrDiff: diff,
			themeStyles,
			themeType: baseThemeType ?? themeType
		});
	}
};
function areRenderOptionsEqual(optionsA, optionsB) {
	return areThemesEqual(optionsA.theme, optionsB.theme) && optionsA.tokenizeMaxLineLength === optionsB.tokenizeMaxLineLength && optionsA.lineDiffType === optionsB.lineDiffType;
}
function getModifiedLinesString(lines) {
	return `${lines} unmodified line${lines > 1 ? "s" : ""}`;
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/parseLineType.js
function parseLineType(line) {
	const firstChar = line[0];
	if (firstChar !== "+" && firstChar !== "-" && firstChar !== " " && firstChar !== "\\") {
		console.error(`parseLineType: Invalid firstChar: "${firstChar}", full line: "${line}"`);
		return;
	}
	const processedLine = line.substring(1);
	return {
		line: processedLine === "" ? "\n" : processedLine,
		type: firstChar === " " ? "context" : firstChar === "\\" ? "metadata" : firstChar === "+" ? "addition" : "deletion"
	};
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/parsePatchFiles.js
function processPatch(data, cacheKeyPrefix) {
	const isGitDiff = GIT_DIFF_FILE_BREAK_REGEX.test(data);
	const rawFiles = data.split(isGitDiff ? GIT_DIFF_FILE_BREAK_REGEX : UNIFIED_DIFF_FILE_BREAK_REGEX);
	let patchMetadata;
	const files = [];
	let currentFile;
	for (const file of rawFiles) {
		if (isGitDiff && !GIT_DIFF_FILE_BREAK_REGEX.test(file)) {
			if (patchMetadata == null) patchMetadata = file;
			else console.error("parsePatchContent: unknown file blob:", file);
			continue;
		} else if (!isGitDiff && !UNIFIED_DIFF_FILE_BREAK_REGEX.test(file)) {
			if (patchMetadata == null) patchMetadata = file;
			else console.error("parsePatchContent: unknown file blob:", file);
			continue;
		}
		let lastHunkEnd = 0;
		const hunks = file.split(FILE_CONTEXT_BLOB);
		currentFile = void 0;
		for (const hunk of hunks) {
			const lines = hunk.split(SPLIT_WITH_NEWLINES);
			const firstLine = lines.shift();
			if (firstLine == null) {
				console.error("parsePatchContent: invalid hunk", hunk);
				continue;
			}
			const match = firstLine.match(HUNK_HEADER);
			const hunkContent = [];
			let additionLines = 0;
			let deletionLines = 0;
			if (match == null || currentFile == null) {
				if (currentFile != null) {
					console.error("parsePatchContent: Invalid hunk", hunk);
					continue;
				}
				currentFile = {
					name: "",
					prevName: void 0,
					type: "change",
					hunks: [],
					splitLineCount: 0,
					unifiedLineCount: 0,
					cacheKey: cacheKeyPrefix != null ? `${cacheKeyPrefix}-${files.length}` : void 0
				};
				lines.unshift(firstLine);
				for (const line of lines) {
					const filenameMatch = line.match(isGitDiff ? FILENAME_HEADER_REGEX_GIT : FILENAME_HEADER_REGEX);
					if (line.startsWith("diff --git")) {
						const [, , prevName, , name] = line.trim().match(ALTERNATE_FILE_NAMES_GIT) ?? [];
						currentFile.name = name.trim();
						if (prevName !== name) currentFile.prevName = prevName.trim();
					} else if (filenameMatch != null) {
						const [, type, fileName] = filenameMatch;
						if (type === "---" && fileName !== "/dev/null") {
							currentFile.prevName = fileName.trim();
							currentFile.name = fileName.trim();
						} else if (type === "+++" && fileName !== "/dev/null") currentFile.name = fileName.trim();
					} else if (isGitDiff) {
						if (line.startsWith("new mode ")) currentFile.mode = line.replace("new mode", "").trim();
						if (line.startsWith("old mode ")) currentFile.oldMode = line.replace("old mode", "").trim();
						if (line.startsWith("new file mode")) {
							currentFile.type = "new";
							currentFile.mode = line.replace("new file mode", "").trim();
						}
						if (line.startsWith("deleted file mode")) {
							currentFile.type = "deleted";
							currentFile.mode = line.replace("deleted file mode", "").trim();
						}
						if (line.startsWith("similarity index")) if (line.startsWith("similarity index 100%")) currentFile.type = "rename-pure";
						else currentFile.type = "rename-changed";
						if (line.startsWith("index ")) {
							const [, mode] = line.trim().match(FILE_MODE_FROM_INDEX) ?? [];
							if (mode != null) currentFile.mode = mode;
						}
						if (line.startsWith("rename from ")) currentFile.prevName = line.replace("rename from ", "");
						if (line.startsWith("rename to ")) currentFile.name = line.replace("rename to ", "").trim();
					}
				}
				continue;
			} else {
				let currentContent;
				let lastLineType;
				while (lines.length > 0 && (lines[lines.length - 1] === "\n" || lines[lines.length - 1] === "")) lines.pop();
				for (const rawLine of lines) {
					const parsedLine = parseLineType(rawLine);
					if (parsedLine == null) continue;
					const { type, line } = parsedLine;
					if (type === "addition") {
						if (currentContent == null || currentContent.type !== "change") {
							currentContent = createContentGroup("change");
							hunkContent.push(currentContent);
						}
						currentContent.additions.push(line);
						additionLines++;
						lastLineType = "addition";
					} else if (type === "deletion") {
						if (currentContent == null || currentContent.type !== "change") {
							currentContent = createContentGroup("change");
							hunkContent.push(currentContent);
						}
						currentContent.deletions.push(line);
						deletionLines++;
						lastLineType = "deletion";
					} else if (type === "context") {
						if (currentContent == null || currentContent.type !== "context") {
							currentContent = createContentGroup("context");
							hunkContent.push(currentContent);
						}
						currentContent.lines.push(line);
						lastLineType = "context";
					} else if (type === "metadata" && currentContent != null) {
						if (currentContent.type === "context") currentContent.noEOFCR = true;
						else if (lastLineType === "deletion") {
							currentContent.noEOFCRDeletions = true;
							const lastIndex = currentContent.deletions.length - 1;
							if (lastIndex >= 0) currentContent.deletions[lastIndex] = cleanLastNewline(currentContent.deletions[lastIndex]);
						} else if (lastLineType === "addition") {
							currentContent.noEOFCRAdditions = true;
							const lastIndex = currentContent.additions.length - 1;
							if (lastIndex >= 0) currentContent.additions[lastIndex] = cleanLastNewline(currentContent.additions[lastIndex]);
						}
					}
				}
			}
			const hunkData = {
				collapsedBefore: 0,
				splitLineCount: 0,
				splitLineStart: 0,
				unifiedLineCount: 0,
				unifiedLineStart: 0,
				additionCount: parseInt(match[4] ?? "1"),
				additionStart: parseInt(match[3]),
				additionLines,
				deletionCount: parseInt(match[2] ?? "1"),
				deletionStart: parseInt(match[1]),
				deletionLines,
				hunkContent,
				hunkContext: match[5],
				hunkSpecs: firstLine
			};
			if (isNaN(hunkData.additionCount) || isNaN(hunkData.deletionCount) || isNaN(hunkData.additionStart) || isNaN(hunkData.deletionStart)) {
				console.error("parsePatchContent: invalid hunk metadata", hunkData);
				continue;
			}
			hunkData.collapsedBefore = Math.max(hunkData.additionStart - 1 - lastHunkEnd, 0);
			currentFile.hunks.push(hunkData);
			lastHunkEnd = hunkData.additionStart + hunkData.additionCount - 1;
			for (const content of hunkContent) if (content.type === "context") {
				hunkData.splitLineCount += content.lines.length;
				hunkData.unifiedLineCount += content.lines.length;
			} else {
				hunkData.splitLineCount += Math.max(content.additions.length, content.deletions.length);
				hunkData.unifiedLineCount += content.deletions.length + content.additions.length;
			}
			hunkData.splitLineStart = currentFile.splitLineCount;
			hunkData.unifiedLineStart = currentFile.unifiedLineCount;
			currentFile.splitLineCount += hunkData.splitLineCount;
			currentFile.unifiedLineCount += hunkData.unifiedLineCount;
		}
		if (currentFile != null) {
			if (!isGitDiff && currentFile.prevName != null && currentFile.name !== currentFile.prevName) if (currentFile.hunks.length > 0) currentFile.type = "rename-changed";
			else currentFile.type = "rename-pure";
			if (currentFile.type !== "rename-pure" && currentFile.type !== "rename-changed") currentFile.prevName = void 0;
			files.push(currentFile);
		}
	}
	return {
		patchMetadata,
		files
	};
}
/**
* Parses a patch file string into an array of parsed patches.
*
* @param data - The raw patch file content (supports multi-commit patches)
* @param cacheKeyPrefix - Optional prefix for generating cache keys. When provided,
*   each file in the patch will get a cache key in the format `prefix-patchIndex-fileIndex`.
*   This enables caching of rendered diff results in the worker pool.
*/
function parsePatchFiles(data, cacheKeyPrefix) {
	const patches = [];
	for (const patch of data.split(COMMIT_METADATA_SPLIT)) try {
		patches.push(processPatch(patch, cacheKeyPrefix != null ? `${cacheKeyPrefix}-${patches.length}` : void 0));
	} catch (error) {
		console.error(error);
	}
	return patches;
}
function createContentGroup(type) {
	if (type === "change") return {
		type: "change",
		additions: [],
		deletions: [],
		noEOFCRAdditions: false,
		noEOFCRDeletions: false
	};
	return {
		type: "context",
		lines: [],
		noEOFCR: false
	};
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/parseDiffFromFile.js
/**
* Parses a diff from two file contents objects.
*
* If both `oldFile` and `newFile` have a `cacheKey`, the resulting diff will
* automatically get a combined cache key in the format `oldKey:newKey`.
*/
function parseDiffFromFile(oldFile, newFile, options) {
	const fileData = parsePatchFiles(createTwoFilesPatch(oldFile.name, newFile.name, oldFile.contents, newFile.contents, oldFile.header, newFile.header, options))[0]?.files[0];
	if (fileData == null) throw new Error("parseDiffFrom: FileInvalid diff -- probably need to fix something -- if the files are the same maybe?");
	fileData.oldLines = oldFile.contents.split(SPLIT_WITH_NEWLINES);
	fileData.newLines = newFile.contents.split(SPLIT_WITH_NEWLINES);
	if (oldFile.cacheKey != null && newFile.cacheKey != null) fileData.cacheKey = `${oldFile.cacheKey}:${newFile.cacheKey}`;
	return fileData;
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/utils/createStyleElement.js
function createStyleElement(content, isCoreCSS = false) {
	return createHastElement({
		tagName: "style",
		children: [createTextNodeElement(isCoreCSS ? wrapCoreCSS(content) : wrapUnsafeCSS(content))],
		properties: {
			[CORE_CSS_ATTRIBUTE]: isCoreCSS ? "" : void 0,
			[UNSAFE_CSS_ATTRIBUTE]: !isCoreCSS ? "" : void 0
		}
	});
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/ssr/renderHTML.js
function renderHTML(children) {
	return `${SVGSpriteSheet}${toHtml(children)}`;
}
//#endregion
//#region node_modules/.pnpm/@pierre+diffs@1.0.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@pierre/diffs/dist/ssr/preloadDiffs.js
async function preloadDiffHTML({ fileDiff, oldFile, newFile, options, annotations }) {
	if (fileDiff == null && oldFile != null && newFile != null) fileDiff = parseDiffFromFile(oldFile, newFile);
	if (fileDiff == null) throw new Error("preloadFileDiff: You must pass at least a fileDiff prop or oldFile/newFile props");
	const diffHunksRenderer = new DiffHunksRenderer({
		...options,
		hunkSeparators: typeof options?.hunkSeparators === "function" ? "custom" : options?.hunkSeparators
	});
	if (annotations !== void 0 && annotations.length > 0) diffHunksRenderer.setLineAnnotations(annotations);
	const hunkResult = await diffHunksRenderer.asyncRender(fileDiff);
	const children = [createStyleElement(hunkResult.css, true)];
	if (options?.unsafeCSS != null) children.push(createStyleElement(options.unsafeCSS));
	if (hunkResult.headerElement != null) children.push(hunkResult.headerElement);
	const code = diffHunksRenderer.renderFullAST(hunkResult);
	code.properties["data-dehydrated"] = "";
	children.push(code);
	return renderHTML(children);
}
async function preloadMultiFileDiff({ oldFile, newFile, options, annotations }) {
	return {
		newFile,
		oldFile,
		options,
		annotations,
		prerenderedHTML: await preloadDiffHTML({
			oldFile,
			newFile,
			options,
			annotations
		})
	};
}
async function preloadFileDiff({ fileDiff, options, annotations }) {
	return {
		fileDiff,
		options,
		annotations,
		prerenderedHTML: await preloadDiffHTML({
			fileDiff,
			options,
			annotations
		})
	};
}
//#endregion
//#region extensions/diffs/src/render.ts
const DEFAULT_FILE_NAME = "diff.txt";
const MAX_PATCH_FILE_COUNT = 128;
const MAX_PATCH_TOTAL_LINES = 12e4;
const diffsRequire = createRequire(import.meta.resolve("@pierre/diffs"));
let pierreThemesPatched = false;
function createThemeLoader(themeName, themePath) {
	let cachedTheme;
	return async () => {
		if (cachedTheme) return cachedTheme;
		const raw = await fs$1.readFile(themePath, "utf8");
		cachedTheme = {
			...JSON.parse(raw),
			name: themeName
		};
		return cachedTheme;
	};
}
function patchPierreThemeLoadersForNode24() {
	if (pierreThemesPatched) return;
	try {
		const darkThemePath = diffsRequire.resolve("@pierre/theme/themes/pierre-dark.json");
		const lightThemePath = diffsRequire.resolve("@pierre/theme/themes/pierre-light.json");
		RegisteredCustomThemes.set("pierre-dark", createThemeLoader("pierre-dark", darkThemePath));
		RegisteredCustomThemes.set("pierre-light", createThemeLoader("pierre-light", lightThemePath));
		pierreThemesPatched = true;
	} catch {}
}
patchPierreThemeLoadersForNode24();
function escapeCssString(value) {
	return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}
function escapeHtml(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}
function escapeJsonScript(value) {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}
function buildDiffTitle(input) {
	if (input.title?.trim()) return input.title.trim();
	if (input.kind === "before_after") return input.path?.trim() || "Text diff";
	return "Patch diff";
}
function resolveBeforeAfterFileName(input) {
	if (input.path?.trim()) return input.path.trim();
	if (input.lang?.trim()) return `diff.${input.lang.trim().replace(/^\.+/, "")}`;
	return DEFAULT_FILE_NAME;
}
function buildDiffOptions(options) {
	const fontFamily = escapeCssString(options.presentation.fontFamily);
	const fontSize = Math.max(10, Math.floor(options.presentation.fontSize));
	const lineHeight = Math.max(20, Math.round(fontSize * options.presentation.lineSpacing));
	return {
		theme: {
			light: "pierre-light",
			dark: "pierre-dark"
		},
		diffStyle: options.presentation.layout,
		diffIndicators: options.presentation.diffIndicators,
		disableLineNumbers: !options.presentation.showLineNumbers,
		expandUnchanged: options.expandUnchanged,
		themeType: options.presentation.theme,
		backgroundEnabled: options.presentation.background,
		overflow: options.presentation.wordWrap ? "wrap" : "scroll",
		unsafeCSS: `
      :host {
        --diffs-font-family: "${fontFamily}", "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        --diffs-header-font-family: "${fontFamily}", "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        --diffs-font-size: ${fontSize}px;
        --diffs-line-height: ${lineHeight}px;
      }

      [data-diffs-header] {
        min-height: 64px;
        padding-inline: 18px 14px;
      }

      [data-header-content] {
        gap: 10px;
      }

      [data-metadata] {
        gap: 10px;
      }

      .oc-diff-toolbar {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-inline-start: 6px;
        flex: 0 0 auto;
      }

      .oc-diff-toolbar-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        margin: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        opacity: 0.6;
        line-height: 0;
        overflow: visible;
        transition: opacity 120ms ease;
        flex: 0 0 auto;
      }

      .oc-diff-toolbar-button:hover {
        opacity: 1;
      }

      .oc-diff-toolbar-button[data-active="true"] {
        opacity: 0.92;
      }

      .oc-diff-toolbar-button svg {
        display: block;
        width: 16px;
        height: 16px;
        min-width: 16px;
        min-height: 16px;
        overflow: visible;
        flex: 0 0 auto;
        color: inherit;
        fill: currentColor;
        pointer-events: none;
      }
    `
	};
}
function buildImageRenderOptions(options) {
	return {
		...options,
		presentation: {
			...options.presentation,
			fontSize: Math.max(16, options.presentation.fontSize)
		}
	};
}
function buildRenderVariants(options) {
	return {
		viewerOptions: buildDiffOptions(options),
		imageOptions: buildDiffOptions(buildImageRenderOptions(options))
	};
}
function normalizeSupportedLanguage(value) {
	const normalized = value?.trim();
	return normalized ? normalized : void 0;
}
function buildPayloadLanguages(payload) {
	const langs = /* @__PURE__ */ new Set();
	if (payload.fileDiff?.lang) langs.add(payload.fileDiff.lang);
	if (payload.oldFile?.lang) langs.add(payload.oldFile.lang);
	if (payload.newFile?.lang) langs.add(payload.newFile.lang);
	if (langs.size === 0) langs.add("text");
	return [...langs];
}
function renderDiffCard(payload) {
	return `<section class="oc-diff-card">
    <diffs-container class="oc-diff-host" data-openclaw-diff-host>
      <template shadowrootmode="open">${payload.prerenderedHTML}</template>
    </diffs-container>
    <script type="application/json" data-openclaw-diff-payload>${escapeJsonScript(payload)}<\/script>
  </section>`;
}
function buildHtmlDocument(params) {
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>${escapeHtml(params.title)}</title>
    <style>
      * {
        box-sizing: border-box;
      }

      html,
      body {
        min-height: 100%;
      }

      html {
        background: #05070b;
      }

      body {
        margin: 0;
        min-height: 100vh;
        padding: 22px;
        font-family:
          "Fira Code",
          "SF Mono",
          Monaco,
          Consolas,
          monospace;
        background: #05070b;
        color: #f8fafc;
      }

      body[data-theme="light"] {
        background: #f3f5f8;
        color: #0f172a;
      }

      .oc-frame {
        max-width: 1560px;
        margin: 0 auto;
      }

      .oc-frame[data-render-mode="image"] {
        max-width: ${Math.max(640, Math.round(params.imageMaxWidth))}px;
      }

      [data-openclaw-diff-root] {
        display: grid;
        gap: 18px;
      }

      .oc-diff-card {
        overflow: hidden;
        border-radius: 18px;
        border: 1px solid rgba(148, 163, 184, 0.16);
        background: rgba(15, 23, 42, 0.14);
        box-shadow: 0 18px 48px rgba(2, 6, 23, 0.22);
      }

      body[data-theme="light"] .oc-diff-card {
        border-color: rgba(148, 163, 184, 0.22);
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 14px 32px rgba(15, 23, 42, 0.08);
      }

      .oc-diff-host {
        display: block;
      }

      .oc-frame[data-render-mode="image"] .oc-diff-card {
        min-height: 240px;
      }

      @media (max-width: 720px) {
        body {
          padding: 12px;
        }

        [data-openclaw-diff-root] {
          gap: 12px;
        }
      }
    </style>
  </head>
  <body data-theme="${params.theme}">
    <main class="oc-frame" data-render-mode="${params.runtimeMode}">
      <div data-openclaw-diff-root>
        ${params.bodyHtml}
      </div>
    </main>
    <script type="module" src="${VIEWER_LOADER_PATH}"><\/script>
  </body>
</html>`;
}
function buildRenderedSection(params) {
	return {
		viewer: renderDiffCard(params.viewerPayload),
		image: renderDiffCard(params.imagePayload)
	};
}
function buildRenderedBodies(sections) {
	return {
		viewerBodyHtml: sections.map((section) => section.viewer).join("\n"),
		imageBodyHtml: sections.map((section) => section.image).join("\n")
	};
}
async function renderBeforeAfterDiff(input, options) {
	const fileName = resolveBeforeAfterFileName(input);
	const lang = normalizeSupportedLanguage(input.lang);
	const oldFile = {
		name: fileName,
		contents: input.before,
		...lang ? { lang } : {}
	};
	const newFile = {
		name: fileName,
		contents: input.after,
		...lang ? { lang } : {}
	};
	const { viewerOptions, imageOptions } = buildRenderVariants(options);
	const [viewerResult, imageResult] = await Promise.all([preloadMultiFileDiffWithFallback({
		oldFile,
		newFile,
		options: viewerOptions
	}), preloadMultiFileDiffWithFallback({
		oldFile,
		newFile,
		options: imageOptions
	})]);
	return {
		...buildRenderedBodies([buildRenderedSection({
			viewerPayload: {
				prerenderedHTML: viewerResult.prerenderedHTML,
				oldFile: viewerResult.oldFile,
				newFile: viewerResult.newFile,
				options: viewerOptions,
				langs: buildPayloadLanguages({
					oldFile: viewerResult.oldFile,
					newFile: viewerResult.newFile
				})
			},
			imagePayload: {
				prerenderedHTML: imageResult.prerenderedHTML,
				oldFile: imageResult.oldFile,
				newFile: imageResult.newFile,
				options: imageOptions,
				langs: buildPayloadLanguages({
					oldFile: imageResult.oldFile,
					newFile: imageResult.newFile
				})
			}
		})]),
		fileCount: 1
	};
}
async function renderPatchDiff(input, options) {
	const files = parsePatchFiles(input.patch).flatMap((entry) => entry.files ?? []);
	if (files.length === 0) throw new Error("Patch input did not contain any file diffs.");
	if (files.length > MAX_PATCH_FILE_COUNT) throw new Error(`Patch input contains too many files (max ${MAX_PATCH_FILE_COUNT}).`);
	if (files.reduce((sum, fileDiff) => {
		const splitLines = Number.isFinite(fileDiff.splitLineCount) ? fileDiff.splitLineCount : 0;
		const unifiedLines = Number.isFinite(fileDiff.unifiedLineCount) ? fileDiff.unifiedLineCount : 0;
		return sum + Math.max(splitLines, unifiedLines, 0);
	}, 0) > MAX_PATCH_TOTAL_LINES) throw new Error(`Patch input is too large to render (max ${MAX_PATCH_TOTAL_LINES} lines).`);
	const { viewerOptions, imageOptions } = buildRenderVariants(options);
	return {
		...buildRenderedBodies(await Promise.all(files.map(async (fileDiff) => {
			const [viewerResult, imageResult] = await Promise.all([preloadFileDiffWithFallback({
				fileDiff,
				options: viewerOptions
			}), preloadFileDiffWithFallback({
				fileDiff,
				options: imageOptions
			})]);
			return buildRenderedSection({
				viewerPayload: {
					prerenderedHTML: viewerResult.prerenderedHTML,
					fileDiff: viewerResult.fileDiff,
					options: viewerOptions,
					langs: buildPayloadLanguages({ fileDiff: viewerResult.fileDiff })
				},
				imagePayload: {
					prerenderedHTML: imageResult.prerenderedHTML,
					fileDiff: imageResult.fileDiff,
					options: imageOptions,
					langs: buildPayloadLanguages({ fileDiff: imageResult.fileDiff })
				}
			});
		}))),
		fileCount: files.length
	};
}
async function renderDiffDocument(input, options) {
	const title = buildDiffTitle(input);
	const rendered = input.kind === "before_after" ? await renderBeforeAfterDiff(input, options) : await renderPatchDiff(input, options);
	return {
		html: buildHtmlDocument({
			title,
			bodyHtml: rendered.viewerBodyHtml,
			theme: options.presentation.theme,
			imageMaxWidth: options.image.maxWidth,
			runtimeMode: "viewer"
		}),
		imageHtml: buildHtmlDocument({
			title,
			bodyHtml: rendered.imageBodyHtml,
			theme: options.presentation.theme,
			imageMaxWidth: options.image.maxWidth,
			runtimeMode: "image"
		}),
		title,
		fileCount: rendered.fileCount,
		inputKind: input.kind
	};
}
function shouldFallbackToClientHydration(error) {
	return error instanceof TypeError && error.message.includes("needs an import attribute of \"type: json\"");
}
async function preloadFileDiffWithFallback(params) {
	try {
		return await preloadFileDiff(params);
	} catch (error) {
		if (!shouldFallbackToClientHydration(error)) throw error;
		return {
			fileDiff: params.fileDiff,
			prerenderedHTML: ""
		};
	}
}
async function preloadMultiFileDiffWithFallback(params) {
	try {
		return await preloadMultiFileDiff(params);
	} catch (error) {
		if (!shouldFallbackToClientHydration(error)) throw error;
		return {
			oldFile: params.oldFile,
			newFile: params.newFile,
			prerenderedHTML: ""
		};
	}
}
//#endregion
//#region extensions/diffs/src/url.ts
const DEFAULT_GATEWAY_PORT = 18789;
function buildViewerUrl(params) {
	const normalizedBase = normalizeViewerBaseUrl(params.baseUrl?.trim() || resolveGatewayBaseUrl(params.config));
	const viewerPath = params.viewerPath.startsWith("/") ? params.viewerPath : `/${params.viewerPath}`;
	const parsedBase = new URL(normalizedBase);
	parsedBase.pathname = `${parsedBase.pathname === "/" ? "" : parsedBase.pathname.replace(/\/+$/, "")}${viewerPath}`;
	parsedBase.search = "";
	parsedBase.hash = "";
	return parsedBase.toString();
}
function normalizeViewerBaseUrl(raw) {
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`Invalid baseUrl: ${raw}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`baseUrl must use http or https: ${raw}`);
	if (parsed.search || parsed.hash) throw new Error(`baseUrl must not include query/hash: ${raw}`);
	parsed.search = "";
	parsed.hash = "";
	parsed.pathname = parsed.pathname.replace(/\/+$/, "");
	return parsed.toString().replace(/\/+$/, "");
}
function resolveGatewayBaseUrl(config) {
	const scheme = config.gateway?.tls?.enabled ? "https" : "http";
	const port = typeof config.gateway?.port === "number" ? config.gateway.port : DEFAULT_GATEWAY_PORT;
	const customHost = config.gateway?.customBindHost?.trim();
	if (config.gateway?.bind === "custom" && customHost) return `${scheme}://${customHost}:${port}`;
	return `${scheme}://127.0.0.1:${port}`;
}
//#endregion
//#region extensions/diffs/src/tool.ts
const MAX_BEFORE_AFTER_BYTES = 512 * 1024;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_BYTES = 1024;
const MAX_PATH_BYTES = 2048;
const MAX_LANG_BYTES = 128;
function stringEnum(values, description) {
	return Type.Unsafe({
		type: "string",
		enum: [...values],
		description
	});
}
const DiffsToolSchema = Type.Object({
	before: Type.Optional(Type.String({ description: "Original text content." })),
	after: Type.Optional(Type.String({ description: "Updated text content." })),
	patch: Type.Optional(Type.String({
		description: "Unified diff or patch text.",
		maxLength: MAX_PATCH_BYTES
	})),
	path: Type.Optional(Type.String({
		description: "Display path for before/after input.",
		maxLength: MAX_PATH_BYTES
	})),
	lang: Type.Optional(Type.String({
		description: "Optional language override for before/after input.",
		maxLength: MAX_LANG_BYTES
	})),
	title: Type.Optional(Type.String({
		description: "Optional title for the rendered diff.",
		maxLength: MAX_TITLE_BYTES
	})),
	mode: Type.Optional(stringEnum(DIFF_MODES, "Output mode: view, file, image, or both. Default: both.")),
	theme: Type.Optional(stringEnum(DIFF_THEMES, "Viewer theme. Default: dark.")),
	layout: Type.Optional(stringEnum(DIFF_LAYOUTS, "Diff layout. Default: unified.")),
	fileQuality: Type.Optional(stringEnum(DIFF_IMAGE_QUALITY_PRESETS, "File quality preset: standard, hq, or print.")),
	fileFormat: Type.Optional(stringEnum(DIFF_OUTPUT_FORMATS, "Rendered file format: png or pdf.")),
	fileScale: Type.Optional(Type.Number({
		description: "Optional rendered-file device scale factor override (1-4).",
		minimum: 1,
		maximum: 4
	})),
	fileMaxWidth: Type.Optional(Type.Number({
		description: "Optional rendered-file max width in CSS pixels (640-2400).",
		minimum: 640,
		maximum: 2400
	})),
	imageQuality: Type.Optional(stringEnum(DIFF_IMAGE_QUALITY_PRESETS, "Deprecated alias for fileQuality.")),
	imageFormat: Type.Optional(stringEnum(DIFF_OUTPUT_FORMATS, "Deprecated alias for fileFormat.")),
	imageScale: Type.Optional(Type.Number({
		description: "Deprecated alias for fileScale.",
		minimum: 1,
		maximum: 4
	})),
	imageMaxWidth: Type.Optional(Type.Number({
		description: "Deprecated alias for fileMaxWidth.",
		minimum: 640,
		maximum: 2400
	})),
	expandUnchanged: Type.Optional(Type.Boolean({ description: "Expand unchanged sections instead of collapsing them." })),
	ttlSeconds: Type.Optional(Type.Number({
		description: "Artifact lifetime in seconds. Default: 1800. Maximum: 21600.",
		minimum: 1,
		maximum: 21600
	})),
	baseUrl: Type.Optional(Type.String({ description: "Optional gateway base URL override used when building the viewer URL, for example https://gateway.example.com." }))
}, { additionalProperties: false });
function createDiffsTool(params) {
	return {
		name: "diffs",
		label: "Diffs",
		description: "Create a read-only diff viewer from before/after text or a unified patch. Returns a gateway viewer URL for canvas use and can also render the same diff to a PNG or PDF.",
		parameters: DiffsToolSchema,
		execute: async (_toolCallId, rawParams) => {
			const toolParams = rawParams;
			const input = normalizeDiffInput(toolParams);
			const mode = normalizeMode(toolParams.mode, params.defaults.mode);
			const theme = normalizeTheme(toolParams.theme, params.defaults.theme);
			const layout = normalizeLayout(toolParams.layout, params.defaults.layout);
			const expandUnchanged = toolParams.expandUnchanged === true;
			const ttlMs = normalizeTtlMs(toolParams.ttlSeconds);
			const image = resolveDiffImageRenderOptions({
				defaults: params.defaults,
				fileFormat: normalizeOutputFormat(toolParams.fileFormat ?? toolParams.imageFormat ?? toolParams.format),
				fileQuality: normalizeFileQuality(toolParams.fileQuality ?? toolParams.imageQuality),
				fileScale: toolParams.fileScale ?? toolParams.imageScale,
				fileMaxWidth: toolParams.fileMaxWidth ?? toolParams.imageMaxWidth
			});
			const rendered = await renderDiffDocument(input, {
				presentation: {
					...params.defaults,
					layout,
					theme
				},
				image,
				expandUnchanged
			});
			const screenshotter = params.screenshotter ?? new PlaywrightDiffScreenshotter({ config: params.api.config });
			if (isArtifactOnlyMode(mode)) {
				const artifactFile = await renderDiffArtifactFile({
					screenshotter,
					store: params.store,
					html: rendered.imageHtml,
					theme,
					image,
					ttlMs
				});
				return {
					content: [{
						type: "text",
						text: buildFileArtifactMessage({
							format: image.format,
							filePath: artifactFile.path
						})
					}],
					details: buildArtifactDetails({
						baseDetails: {
							title: rendered.title,
							inputKind: rendered.inputKind,
							fileCount: rendered.fileCount,
							mode
						},
						artifactFile,
						image
					})
				};
			}
			const artifact = await params.store.createArtifact({
				html: rendered.html,
				title: rendered.title,
				inputKind: rendered.inputKind,
				fileCount: rendered.fileCount,
				ttlMs
			});
			const viewerUrl = buildViewerUrl({
				config: params.api.config,
				viewerPath: artifact.viewerPath,
				baseUrl: normalizeBaseUrl(toolParams.baseUrl)
			});
			const baseDetails = {
				artifactId: artifact.id,
				viewerUrl,
				viewerPath: artifact.viewerPath,
				title: artifact.title,
				expiresAt: artifact.expiresAt,
				inputKind: artifact.inputKind,
				fileCount: artifact.fileCount,
				mode
			};
			if (mode === "view") return {
				content: [{
					type: "text",
					text: `Diff viewer ready.\n${viewerUrl}`
				}],
				details: baseDetails
			};
			try {
				const artifactFile = await renderDiffArtifactFile({
					screenshotter,
					store: params.store,
					artifactId: artifact.id,
					html: rendered.imageHtml,
					theme,
					image
				});
				await params.store.updateFilePath(artifact.id, artifactFile.path);
				return {
					content: [{
						type: "text",
						text: buildFileArtifactMessage({
							format: image.format,
							filePath: artifactFile.path,
							viewerUrl
						})
					}],
					details: buildArtifactDetails({
						baseDetails,
						artifactFile,
						image
					})
				};
			} catch (error) {
				if (mode === "both") return {
					content: [{
						type: "text",
						text: `Diff viewer ready.\n${viewerUrl}\nFile rendering failed: ${error instanceof Error ? error.message : String(error)}`
					}],
					details: {
						...baseDetails,
						fileError: error instanceof Error ? error.message : String(error),
						imageError: error instanceof Error ? error.message : String(error)
					}
				};
				throw error;
			}
		}
	};
}
function normalizeFileQuality(fileQuality) {
	return fileQuality && DIFF_IMAGE_QUALITY_PRESETS.includes(fileQuality) ? fileQuality : void 0;
}
function normalizeOutputFormat(format) {
	return format && DIFF_OUTPUT_FORMATS.includes(format) ? format : void 0;
}
function isArtifactOnlyMode(mode) {
	return mode === "image" || mode === "file";
}
function buildArtifactDetails(params) {
	return {
		...params.baseDetails,
		filePath: params.artifactFile.path,
		imagePath: params.artifactFile.path,
		path: params.artifactFile.path,
		fileBytes: params.artifactFile.bytes,
		imageBytes: params.artifactFile.bytes,
		format: params.image.format,
		fileFormat: params.image.format,
		fileQuality: params.image.qualityPreset,
		imageQuality: params.image.qualityPreset,
		fileScale: params.image.scale,
		imageScale: params.image.scale,
		fileMaxWidth: params.image.maxWidth,
		imageMaxWidth: params.image.maxWidth
	};
}
function buildFileArtifactMessage(params) {
	const lines = params.viewerUrl ? [`Diff viewer: ${params.viewerUrl}`] : [];
	lines.push(`Diff ${params.format.toUpperCase()} generated at: ${params.filePath}`);
	lines.push("Use the `message` tool with `path` or `filePath` to send this file.");
	return lines.join("\n");
}
async function renderDiffArtifactFile(params) {
	const outputPath = params.artifactId ? params.store.allocateFilePath(params.artifactId, params.image.format) : (await params.store.createStandaloneFileArtifact({
		format: params.image.format,
		ttlMs: params.ttlMs
	})).filePath;
	await params.screenshotter.screenshotHtml({
		html: params.html,
		outputPath,
		theme: params.theme,
		image: params.image
	});
	return {
		path: outputPath,
		bytes: (await fs$1.stat(outputPath)).size
	};
}
function normalizeDiffInput(params) {
	const patch = params.patch?.trim();
	const before = params.before;
	const after = params.after;
	if (patch) {
		assertMaxBytes(patch, "patch", MAX_PATCH_BYTES);
		if (before !== void 0 || after !== void 0) throw new PluginToolInputError("Provide either patch or before/after input, not both.");
		const title = params.title?.trim();
		if (title) assertMaxBytes(title, "title", MAX_TITLE_BYTES);
		return {
			kind: "patch",
			patch,
			title
		};
	}
	if (before === void 0 || after === void 0) throw new PluginToolInputError("Provide patch or both before and after text.");
	assertMaxBytes(before, "before", MAX_BEFORE_AFTER_BYTES);
	assertMaxBytes(after, "after", MAX_BEFORE_AFTER_BYTES);
	const path = params.path?.trim() || void 0;
	const lang = params.lang?.trim() || void 0;
	const title = params.title?.trim() || void 0;
	if (path) assertMaxBytes(path, "path", MAX_PATH_BYTES);
	if (lang) assertMaxBytes(lang, "lang", MAX_LANG_BYTES);
	if (title) assertMaxBytes(title, "title", MAX_TITLE_BYTES);
	return {
		kind: "before_after",
		before,
		after,
		path,
		lang,
		title
	};
}
function assertMaxBytes(value, label, maxBytes) {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return;
	throw new PluginToolInputError(`${label} exceeds maximum size (${maxBytes} bytes).`);
}
function normalizeBaseUrl(baseUrl) {
	const normalized = baseUrl?.trim();
	if (!normalized) return;
	try {
		return normalizeViewerBaseUrl(normalized);
	} catch {
		throw new PluginToolInputError(`Invalid baseUrl: ${normalized}`);
	}
}
function normalizeMode(mode, fallback) {
	return mode && DIFF_MODES.includes(mode) ? mode : fallback;
}
function normalizeTheme(theme, fallback) {
	return theme && DIFF_THEMES.includes(theme) ? theme : fallback;
}
function normalizeLayout(layout, fallback) {
	return layout && DIFF_LAYOUTS.includes(layout) ? layout : fallback;
}
function normalizeTtlMs(ttlSeconds) {
	if (!Number.isFinite(ttlSeconds) || ttlSeconds === void 0) return;
	return Math.floor(ttlSeconds * 1e3);
}
var PluginToolInputError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ToolInputError";
	}
};
//#endregion
//#region extensions/diffs/index.ts
const plugin = {
	id: "diffs",
	name: "Diffs",
	description: "Read-only diff viewer and PNG/PDF renderer for agents.",
	configSchema: diffsPluginConfigSchema,
	register(api) {
		const defaults = resolveDiffsPluginDefaults(api.pluginConfig);
		const security = resolveDiffsPluginSecurity(api.pluginConfig);
		const store = new DiffArtifactStore({
			rootDir: path.join(resolvePreferredOpenClawTmpDir(), "openclaw-diffs"),
			logger: api.logger
		});
		api.registerTool(createDiffsTool({
			api,
			store,
			defaults
		}));
		api.registerHttpRoute({
			path: "/plugins/diffs",
			auth: "plugin",
			match: "prefix",
			handler: createDiffsHttpHandler({
				store,
				logger: api.logger,
				allowRemoteViewer: security.allowRemoteViewer
			})
		});
		api.on("before_prompt_build", async () => ({ prependSystemContext: DIFFS_AGENT_GUIDANCE }));
	}
};
//#endregion
export { plugin as default };
