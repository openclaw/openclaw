import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { a as resolveOsHomeRelativePath } from "./home-dir-BOPFpGo8.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { s as resolveArchiveKind } from "./archive-DBeZ8ywX.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import "./path-guards-CBe_wA_B.js";
import { o as tryReadJson } from "./json-files-C2hqjU--.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import "./archive-CBe_wA_B.js";
import { o as redactSensitiveUrlLikeString } from "./redact-sensitive-url-NNYIE41N.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { o as installPluginFromPath } from "./install-BG7jqqYt.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
//#region src/plugins/marketplace.ts
const DEFAULT_GIT_TIMEOUT_MS = 12e4;
const DEFAULT_MARKETPLACE_DOWNLOAD_TIMEOUT_MS = 12e4;
const MAX_MARKETPLACE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MARKETPLACE_MANIFEST_CANDIDATES = [path.join(".claude-plugin", "marketplace.json"), "marketplace.json"];
const CLAUDE_KNOWN_MARKETPLACES_PATH = path.join("~", ".claude", "plugins", "known_marketplaces.json");
function isHttpUrl(value) {
	return /^https?:\/\//i.test(value);
}
function isGitUrl(value) {
	return /^git@/i.test(value) || /^ssh:\/\//i.test(value) || /^https?:\/\/.+\.git(?:#.*)?$/i.test(value);
}
function looksLikeGitHubRepoShorthand(value) {
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.+)?$/.test(value.trim());
}
function splitRef(value) {
	const trimmed = value.trim();
	const hashIndex = trimmed.lastIndexOf("#");
	if (hashIndex <= 0 || hashIndex >= trimmed.length - 1) return { base: trimmed };
	return {
		base: trimmed.slice(0, hashIndex),
		ref: normalizeOptionalString(trimmed.slice(hashIndex + 1))
	};
}
function toOptionalString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeEntrySource(raw) {
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) return {
			ok: false,
			error: "empty plugin source"
		};
		if (isHttpUrl(trimmed)) return {
			ok: true,
			source: {
				kind: "url",
				url: trimmed
			}
		};
		return {
			ok: true,
			source: {
				kind: "path",
				path: trimmed
			}
		};
	}
	if (!raw || typeof raw !== "object") return {
		ok: false,
		error: "plugin source must be a string or object"
	};
	const rec = raw;
	const kind = toOptionalString(rec.type) ?? toOptionalString(rec.source);
	if (!kind) return {
		ok: false,
		error: "plugin source object missing \"type\" or \"source\""
	};
	if (kind === "path") {
		const sourcePath = toOptionalString(rec.path);
		if (!sourcePath) return {
			ok: false,
			error: "path source missing \"path\""
		};
		return {
			ok: true,
			source: {
				kind: "path",
				path: sourcePath
			}
		};
	}
	if (kind === "github") {
		const repo = toOptionalString(rec.repo) ?? toOptionalString(rec.url);
		if (!repo) return {
			ok: false,
			error: "github source missing \"repo\""
		};
		return {
			ok: true,
			source: {
				kind: "github",
				repo,
				path: toOptionalString(rec.path),
				ref: toOptionalString(rec.ref) ?? toOptionalString(rec.branch) ?? toOptionalString(rec.tag)
			}
		};
	}
	if (kind === "git") {
		const url = toOptionalString(rec.url) ?? toOptionalString(rec.repo);
		if (!url) return {
			ok: false,
			error: "git source missing \"url\""
		};
		return {
			ok: true,
			source: {
				kind: "git",
				url,
				path: toOptionalString(rec.path),
				ref: toOptionalString(rec.ref) ?? toOptionalString(rec.branch) ?? toOptionalString(rec.tag)
			}
		};
	}
	if (kind === "git-subdir") {
		const url = toOptionalString(rec.url) ?? toOptionalString(rec.repo);
		const sourcePath = toOptionalString(rec.path) ?? toOptionalString(rec.subdir);
		if (!url) return {
			ok: false,
			error: "git-subdir source missing \"url\""
		};
		if (!sourcePath) return {
			ok: false,
			error: "git-subdir source missing \"path\""
		};
		return {
			ok: true,
			source: {
				kind: "git-subdir",
				url,
				path: sourcePath,
				ref: toOptionalString(rec.ref) ?? toOptionalString(rec.branch) ?? toOptionalString(rec.tag)
			}
		};
	}
	if (kind === "url") {
		const url = toOptionalString(rec.url);
		if (!url) return {
			ok: false,
			error: "url source missing \"url\""
		};
		return {
			ok: true,
			source: {
				kind: "url",
				url
			}
		};
	}
	return {
		ok: false,
		error: `unsupported plugin source kind: ${kind}`
	};
}
function marketplaceEntrySourceToInput(source) {
	switch (source.kind) {
		case "path": return source.path;
		case "github": return `${source.repo}${source.ref ? `#${source.ref}` : ""}`;
		case "git": return `${source.url}${source.ref ? `#${source.ref}` : ""}`;
		case "git-subdir": return `${source.url}${source.ref ? `#${source.ref}` : ""}`;
		case "url": return source.url;
	}
	throw new Error("Unsupported marketplace entry source");
}
function parseMarketplaceManifest(raw, sourceLabel) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return {
			ok: false,
			error: `invalid marketplace JSON at ${sourceLabel}: ${String(err)}`
		};
	}
	if (!parsed || typeof parsed !== "object") return {
		ok: false,
		error: `invalid marketplace JSON at ${sourceLabel}: expected object`
	};
	const rec = parsed;
	if (!Array.isArray(rec.plugins)) return {
		ok: false,
		error: `invalid marketplace JSON at ${sourceLabel}: missing plugins[]`
	};
	const plugins = [];
	for (const entry of rec.plugins) {
		if (!entry || typeof entry !== "object") return {
			ok: false,
			error: `invalid marketplace entry in ${sourceLabel}: expected object`
		};
		const plugin = entry;
		const name = toOptionalString(plugin.name);
		if (!name) return {
			ok: false,
			error: `invalid marketplace entry in ${sourceLabel}: missing name`
		};
		const normalizedSource = normalizeEntrySource(plugin.source);
		if (!normalizedSource.ok) return {
			ok: false,
			error: `invalid marketplace entry "${name}" in ${sourceLabel}: ${normalizedSource.error}`
		};
		plugins.push({
			name,
			version: toOptionalString(plugin.version),
			description: toOptionalString(plugin.description),
			source: normalizedSource.source
		});
	}
	return {
		ok: true,
		manifest: {
			name: toOptionalString(rec.name),
			version: toOptionalString(rec.version),
			plugins
		}
	};
}
async function readClaudeKnownMarketplaces() {
	const knownPath = resolveOsHomeRelativePath(CLAUDE_KNOWN_MARKETPLACES_PATH);
	if (!await pathExists(knownPath)) return {};
	const parsed = await tryReadJson(knownPath);
	if (!parsed || typeof parsed !== "object") return {};
	const entries = parsed;
	const result = {};
	for (const [name, value] of Object.entries(entries)) {
		if (!value || typeof value !== "object") continue;
		const record = value;
		result[name] = {
			installLocation: toOptionalString(record.installLocation),
			source: record.source
		};
	}
	return result;
}
function deriveMarketplaceRootFromManifestPath(manifestPath) {
	const manifestDir = path.dirname(manifestPath);
	return path.basename(manifestDir) === ".claude-plugin" ? path.dirname(manifestDir) : manifestDir;
}
async function resolveLocalMarketplaceSource(input) {
	const resolved = resolveUserPath(input);
	if (!await pathExists(resolved)) return null;
	const stat = await fs.stat(resolved);
	if (stat.isFile()) return {
		ok: true,
		rootDir: deriveMarketplaceRootFromManifestPath(resolved),
		manifestPath: resolved
	};
	if (!stat.isDirectory()) return {
		ok: false,
		error: `unsupported marketplace source: ${resolved}`
	};
	const rootDir = path.basename(resolved) === ".claude-plugin" ? path.dirname(resolved) : resolved;
	for (const candidate of MARKETPLACE_MANIFEST_CANDIDATES) {
		const manifestPath = path.join(rootDir, candidate);
		if (await pathExists(manifestPath)) return {
			ok: true,
			rootDir,
			manifestPath
		};
	}
	return {
		ok: false,
		error: `marketplace manifest not found under ${resolved}`
	};
}
function normalizeGitCloneSource(source) {
	const split = splitRef(source);
	if (looksLikeGitHubRepoShorthand(split.base)) return {
		url: `https://github.com/${split.base}.git`,
		ref: split.ref,
		label: split.base
	};
	if (isGitUrl(source)) return {
		url: split.base,
		ref: split.ref,
		label: split.base
	};
	if (isHttpUrl(source)) try {
		const url = new URL(split.base);
		if (url.hostname !== "github.com") return null;
		const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
		if (parts.length < 2) return null;
		const repo = `${parts[0]}/${parts[1]?.replace(/\.git$/i, "")}`;
		return {
			url: `https://github.com/${repo}.git`,
			ref: split.ref,
			label: repo
		};
	} catch {
		return null;
	}
	return null;
}
async function cloneMarketplaceRepo(params) {
	const normalized = normalizeGitCloneSource(params.source);
	if (!normalized) return {
		ok: false,
		error: `unsupported marketplace source: ${params.source}`
	};
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-marketplace-"));
	const repoDir = path.join(tmpDir, "repo");
	const argv = [
		"git",
		"clone",
		"--depth",
		"1"
	];
	if (normalized.ref) argv.push("--branch", normalized.ref);
	argv.push(normalized.url, repoDir);
	params.logger?.info?.(`Cloning marketplace source ${normalized.label}...`);
	const res = await runCommandWithTimeout(argv, { timeoutMs: params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS });
	if (res.code !== 0) {
		await fs.rm(tmpDir, {
			recursive: true,
			force: true
		}).catch(() => void 0);
		const detail = res.stderr.trim() || res.stdout.trim() || "git clone failed";
		return {
			ok: false,
			error: `failed to clone marketplace source ${normalized.label}: ${detail}`
		};
	}
	return {
		ok: true,
		rootDir: repoDir,
		label: normalized.label,
		cleanup: async () => {
			await fs.rm(tmpDir, {
				recursive: true,
				force: true
			}).catch(() => void 0);
		}
	};
}
async function loadMarketplace(params) {
	const loadMarketplaceFromManifestFile = async (params) => {
		const parsed = parseMarketplaceManifest(await fs.readFile(params.manifestPath, "utf-8"), params.manifestPath);
		if (!parsed.ok) {
			await params.cleanup?.();
			return parsed;
		}
		const validated = await validateMarketplaceManifest({
			manifest: parsed.manifest,
			sourceLabel: params.sourceLabel,
			rootDir: params.rootDir,
			origin: params.origin
		});
		if (!validated.ok) {
			await params.cleanup?.();
			return validated;
		}
		return {
			ok: true,
			marketplace: {
				manifest: validated.manifest,
				rootDir: params.rootDir,
				sourceLabel: params.sourceLabel,
				origin: params.origin,
				cleanup: params.cleanup
			}
		};
	};
	const loadResolvedLocalMarketplace = async (local, sourceLabel) => loadMarketplaceFromManifestFile({
		manifestPath: local.manifestPath,
		sourceLabel,
		rootDir: local.rootDir,
		origin: "local"
	});
	const resolveClonedMarketplaceManifestPath = async (rootDir) => {
		for (const candidate of MARKETPLACE_MANIFEST_CANDIDATES) {
			const next = path.join(rootDir, candidate);
			if (await pathExists(next)) return next;
		}
	};
	const known = (await readClaudeKnownMarketplaces())[params.source];
	if (known) {
		if (known.installLocation) {
			const local = await resolveLocalMarketplaceSource(known.installLocation);
			if (local?.ok) return await loadResolvedLocalMarketplace(local, params.source);
		}
		const normalizedSource = normalizeEntrySource(known.source);
		if (normalizedSource.ok) return await loadMarketplace({
			source: marketplaceEntrySourceToInput(normalizedSource.source),
			logger: params.logger,
			timeoutMs: params.timeoutMs
		});
	}
	const local = await resolveLocalMarketplaceSource(params.source);
	if (local?.ok === false) return local;
	if (local?.ok) return await loadResolvedLocalMarketplace(local, local.manifestPath);
	const cloned = await cloneMarketplaceRepo({
		source: params.source,
		timeoutMs: params.timeoutMs,
		logger: params.logger
	});
	if (!cloned.ok) return cloned;
	const manifestPath = await resolveClonedMarketplaceManifestPath(cloned.rootDir);
	if (!manifestPath) {
		await cloned.cleanup();
		return {
			ok: false,
			error: `marketplace manifest not found in ${cloned.label}`
		};
	}
	return await loadMarketplaceFromManifestFile({
		manifestPath,
		sourceLabel: cloned.label,
		rootDir: cloned.rootDir,
		origin: "remote",
		cleanup: cloned.cleanup
	});
}
function resolveSafeMarketplaceDownloadFileName(url, fallback) {
	const pathname = new URL(url).pathname;
	const fileName = path.basename(pathname).trim() || fallback;
	if (fileName === "." || fileName === ".." || /^[a-zA-Z]:/.test(fileName) || path.isAbsolute(fileName) || fileName.includes("/") || fileName.includes("\\")) throw new Error("invalid download filename");
	return fileName;
}
function resolveMarketplaceDownloadTimeoutMs(timeoutMs) {
	return Math.max(1e3, Math.floor(typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_MARKETPLACE_DOWNLOAD_TIMEOUT_MS));
}
function formatMarketplaceDownloadError(url, detail) {
	return `failed to download ${sanitizeForLog(redactSensitiveUrlLikeString(url))}: ` + sanitizeForLog(detail);
}
function hasStreamingResponseBody(response) {
	return Boolean(response.body && typeof response.body.getReader === "function");
}
async function readMarketplaceChunkWithTimeout(reader, chunkTimeoutMs) {
	let timeoutId;
	let timedOut = false;
	return await new Promise((resolve, reject) => {
		const clear = () => {
			if (timeoutId !== void 0) {
				clearTimeout(timeoutId);
				timeoutId = void 0;
			}
		};
		timeoutId = setTimeout(() => {
			timedOut = true;
			clear();
			reader.cancel().catch(() => void 0);
			reject(/* @__PURE__ */ new Error(`download timed out after ${chunkTimeoutMs}ms`));
		}, chunkTimeoutMs);
		reader.read().then((result) => {
			clear();
			if (!timedOut) resolve(result);
		}, (err) => {
			clear();
			if (!timedOut) reject(err);
		});
	});
}
async function writeMarketplaceChunk(fileHandle, chunk) {
	let offset = 0;
	while (offset < chunk.length) {
		const { bytesWritten } = await fileHandle.write(chunk, offset, chunk.length - offset);
		if (bytesWritten <= 0) throw new Error("failed to write download chunk");
		offset += bytesWritten;
	}
}
async function streamMarketplaceResponseToFile(params) {
	const reader = params.response.body.getReader();
	const fileHandle = await fs.open(params.targetPath, "wx");
	let total = 0;
	try {
		while (true) {
			const { done, value } = await readMarketplaceChunkWithTimeout(reader, params.chunkTimeoutMs);
			if (done) return;
			if (!value?.length) continue;
			const nextTotal = total + value.length;
			if (nextTotal > params.maxBytes) throw new Error(`download too large: ${nextTotal} bytes (limit: ${params.maxBytes} bytes)`);
			await writeMarketplaceChunk(fileHandle, value);
			total = nextTotal;
		}
	} finally {
		await fileHandle.close().catch(() => void 0);
		try {
			reader.releaseLock();
		} catch {}
	}
}
async function downloadUrlToTempFile(url, timeoutMs) {
	let sourceFileName = "plugin.tgz";
	let tmpDir;
	try {
		sourceFileName = resolveSafeMarketplaceDownloadFileName(url, sourceFileName);
		const downloadTimeoutMs = resolveMarketplaceDownloadTimeoutMs(timeoutMs);
		const { response, finalUrl, release } = await fetchWithSsrFGuard({
			url,
			timeoutMs: downloadTimeoutMs,
			auditContext: "marketplace-plugin-download"
		});
		try {
			if (!response.ok) return {
				ok: false,
				error: formatMarketplaceDownloadError(url, `HTTP ${response.status}`)
			};
			if (!response.body) return {
				ok: false,
				error: formatMarketplaceDownloadError(url, "empty response body")
			};
			if (!hasStreamingResponseBody(response)) return {
				ok: false,
				error: formatMarketplaceDownloadError(url, "streaming response body unavailable")
			};
			const contentLength = response.headers.get("content-length");
			if (contentLength) {
				const size = Number(contentLength);
				if (Number.isFinite(size) && size > MAX_MARKETPLACE_ARCHIVE_BYTES) throw new Error(`download too large: ${size} bytes (limit: ${MAX_MARKETPLACE_ARCHIVE_BYTES} bytes)`);
			}
			const finalFileName = resolveSafeMarketplaceDownloadFileName(finalUrl, sourceFileName);
			const fileName = resolveArchiveKind(finalFileName) ? finalFileName : sourceFileName;
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-marketplace-download-"));
			const createdTmpDir = tmpDir;
			const targetPath = path.resolve(createdTmpDir, fileName);
			const relativeTargetPath = path.relative(createdTmpDir, targetPath);
			if (relativeTargetPath === ".." || relativeTargetPath.startsWith(`..${path.sep}`)) throw new Error("invalid download filename");
			await streamMarketplaceResponseToFile({
				response,
				targetPath,
				maxBytes: MAX_MARKETPLACE_ARCHIVE_BYTES,
				chunkTimeoutMs: downloadTimeoutMs
			});
			return {
				ok: true,
				path: targetPath,
				cleanup: async () => {
					await fs.rm(createdTmpDir, {
						recursive: true,
						force: true
					}).catch(() => void 0);
				}
			};
		} finally {
			await release().catch(() => void 0);
		}
	} catch (error) {
		if (tmpDir) await fs.rm(tmpDir, {
			recursive: true,
			force: true
		}).catch(() => void 0);
		return {
			ok: false,
			error: formatMarketplaceDownloadError(url, formatErrorMessage(error))
		};
	}
}
async function ensureInsideMarketplaceRoot(rootDir, candidate, options) {
	const resolved = path.resolve(rootDir, candidate);
	const resolvedExists = await pathExists(resolved);
	const relative = path.relative(rootDir, resolved);
	if (relative === ".." || relative.startsWith(`..${path.sep}`)) return {
		ok: false,
		error: `plugin source escapes marketplace root: ${candidate}`
	};
	if (options?.canonicalRootDir) try {
		if (!(await fs.lstat(options.canonicalRootDir)).isDirectory()) throw new Error("invalid marketplace root");
		const rootRealPath = await fs.realpath(options.canonicalRootDir);
		let existingPath = resolved;
		while (!await pathExists(existingPath)) {
			const parentPath = path.dirname(existingPath);
			if (parentPath === existingPath) throw new Error("unreachable marketplace path");
			existingPath = parentPath;
		}
		if (!isPathInside(rootRealPath, await fs.realpath(existingPath))) throw new Error("marketplace path escapes canonical root");
	} catch (error) {
		if (error instanceof Error && (error.message === "invalid marketplace root" || error.message === "unreachable marketplace path" || error.message === "marketplace path escapes canonical root")) return {
			ok: false,
			error: `plugin source escapes marketplace root: ${candidate}`
		};
		throw error;
	}
	if (!resolvedExists) return {
		ok: false,
		error: `plugin source not found in marketplace root: ${candidate}`
	};
	return {
		ok: true,
		path: resolved
	};
}
async function validateMarketplaceManifest(params) {
	if (params.origin === "local") return {
		ok: true,
		manifest: params.manifest
	};
	const canonicalRootDir = await fs.realpath(params.rootDir);
	for (const plugin of params.manifest.plugins) {
		const source = plugin.source;
		if (source.kind === "path") {
			if (isHttpUrl(source.path)) return {
				ok: false,
				error: `invalid marketplace entry "${plugin.name}" in ${params.sourceLabel}: remote marketplaces may not use HTTP(S) plugin paths`
			};
			if (path.isAbsolute(source.path)) return {
				ok: false,
				error: `invalid marketplace entry "${plugin.name}" in ${params.sourceLabel}: remote marketplaces may only use relative plugin paths`
			};
			const resolved = await ensureInsideMarketplaceRoot(params.rootDir, source.path, { canonicalRootDir });
			if (!resolved.ok) return {
				ok: false,
				error: `invalid marketplace entry "${plugin.name}" in ${params.sourceLabel}: ${resolved.error}`
			};
			continue;
		}
		return {
			ok: false,
			error: `invalid marketplace entry "${plugin.name}" in ${params.sourceLabel}: remote marketplaces may not use ${source.kind} plugin sources`
		};
	}
	return {
		ok: true,
		manifest: params.manifest
	};
}
async function resolveMarketplaceEntryInstallPath(params) {
	if (params.source.kind === "path") {
		if (isHttpUrl(params.source.path)) {
			if (resolveArchiveKind(params.source.path)) return await downloadUrlToTempFile(params.source.path, params.timeoutMs);
			return {
				ok: false,
				error: `unsupported remote plugin path source: ${params.source.path}`
			};
		}
		const canonicalRootDir = params.marketplaceOrigin === "remote" ? await fs.realpath(params.marketplaceRootDir) : void 0;
		const resolved = path.isAbsolute(params.source.path) ? {
			ok: true,
			path: params.source.path
		} : await ensureInsideMarketplaceRoot(params.marketplaceRootDir, params.source.path, { canonicalRootDir });
		if (!resolved.ok) return resolved;
		return {
			ok: true,
			path: resolved.path
		};
	}
	if (params.source.kind === "github" || params.source.kind === "git" || params.source.kind === "git-subdir") {
		const cloned = await cloneMarketplaceRepo({
			source: params.source.kind === "github" ? `${params.source.repo}${params.source.ref ? `#${params.source.ref}` : ""}` : `${params.source.url}${params.source.ref ? `#${params.source.ref}` : ""}`,
			timeoutMs: params.timeoutMs,
			logger: params.logger
		});
		if (!cloned.ok) return cloned;
		const subPath = params.source.kind === "github" || params.source.kind === "git" ? normalizeOptionalString(params.source.path) || "." : params.source.path.trim();
		const canonicalRootDir = await fs.realpath(cloned.rootDir);
		const target = await ensureInsideMarketplaceRoot(cloned.rootDir, subPath, { canonicalRootDir });
		if (!target.ok) {
			await cloned.cleanup();
			return target;
		}
		return {
			ok: true,
			path: target.path,
			cleanup: cloned.cleanup
		};
	}
	if (resolveArchiveKind(params.source.url)) return await downloadUrlToTempFile(params.source.url, params.timeoutMs);
	if (!normalizeGitCloneSource(params.source.url)) return {
		ok: false,
		error: `unsupported URL plugin source: ${params.source.url}`
	};
	const cloned = await cloneMarketplaceRepo({
		source: params.source.url,
		timeoutMs: params.timeoutMs,
		logger: params.logger
	});
	if (!cloned.ok) return cloned;
	return {
		ok: true,
		path: cloned.rootDir,
		cleanup: cloned.cleanup
	};
}
async function listMarketplacePlugins(params) {
	const loaded = await loadMarketplace({
		source: params.marketplace,
		logger: params.logger,
		timeoutMs: params.timeoutMs
	});
	if (!loaded.ok) return loaded;
	try {
		return {
			ok: true,
			manifest: loaded.marketplace.manifest,
			sourceLabel: loaded.marketplace.sourceLabel
		};
	} finally {
		await loaded.marketplace.cleanup?.();
	}
}
async function resolveMarketplaceInstallShortcut(raw) {
	const trimmed = raw.trim();
	const atIndex = trimmed.lastIndexOf("@");
	if (atIndex <= 0 || atIndex >= trimmed.length - 1) return null;
	const plugin = trimmed.slice(0, atIndex).trim();
	const marketplaceName = trimmed.slice(atIndex + 1).trim();
	if (!plugin || !marketplaceName || plugin.includes("/")) return null;
	const known = (await readClaudeKnownMarketplaces())[marketplaceName];
	if (!known) return null;
	if (known.installLocation) return {
		ok: true,
		plugin,
		marketplaceName,
		marketplaceSource: marketplaceName
	};
	const normalizedSource = normalizeEntrySource(known.source);
	if (!normalizedSource.ok) return {
		ok: false,
		error: `known Claude marketplace "${marketplaceName}" has an invalid source: ${normalizedSource.error}`
	};
	return {
		ok: true,
		plugin,
		marketplaceName,
		marketplaceSource: marketplaceName
	};
}
async function installPluginFromMarketplace(params) {
	const loaded = await loadMarketplace({
		source: params.marketplace,
		logger: params.logger,
		timeoutMs: params.timeoutMs
	});
	if (!loaded.ok) return loaded;
	let installCleanup;
	try {
		const entry = loaded.marketplace.manifest.plugins.find((plugin) => plugin.name === params.plugin);
		if (!entry) {
			const known = loaded.marketplace.manifest.plugins.map((plugin) => plugin.name).toSorted();
			return {
				ok: false,
				error: `plugin "${params.plugin}" not found in marketplace ${loaded.marketplace.sourceLabel}` + (known.length > 0 ? ` (available: ${known.join(", ")})` : "")
			};
		}
		const resolved = await resolveMarketplaceEntryInstallPath({
			source: entry.source,
			marketplaceRootDir: loaded.marketplace.rootDir,
			marketplaceOrigin: loaded.marketplace.origin,
			logger: params.logger,
			timeoutMs: params.timeoutMs
		});
		if (!resolved.ok) return resolved;
		installCleanup = resolved.cleanup;
		const result = await installPluginFromPath({
			dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
			path: resolved.path,
			logger: params.logger,
			mode: params.mode,
			extensionsDir: params.extensionsDir,
			timeoutMs: params.timeoutMs,
			dryRun: params.dryRun,
			expectedPluginId: params.expectedPluginId
		});
		if (!result.ok) return result;
		return {
			...result,
			marketplaceName: loaded.marketplace.manifest.name,
			marketplaceVersion: loaded.marketplace.manifest.version,
			marketplacePlugin: entry.name,
			marketplaceSource: params.marketplace,
			marketplaceEntryVersion: entry.version
		};
	} finally {
		await installCleanup?.();
		await loaded.marketplace.cleanup?.();
	}
}
//#endregion
export { listMarketplacePlugins as n, resolveMarketplaceInstallShortcut as r, installPluginFromMarketplace as t };
