import { y as resolveUserPath } from "./utils-Do8MzKyM.js";
import { Bu as resolveArchiveKind } from "./auth-profiles-DqxBs6Au.js";
import { a as openBoundaryFileSync } from "./filter-Qe6Ch68_.js";
import { t as runCommandWithTimeout } from "./exec-Fh3CK0qE.js";
import { a as installPluginFromPath, i as installPluginFromNpmSpec, l as resolveBundledPluginSources, n as recordPluginInstall, o as resolvePluginInstallDir, r as PLUGIN_INSTALL_ERROR_CODE, t as buildNpmResolutionInstallFields } from "./installs-Ijc1ezqt.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import fs$1 from "node:fs/promises";
//#region src/plugins/marketplace.ts
const DEFAULT_GIT_TIMEOUT_MS = 12e4;
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
	if (hashIndex <= 0 || hashIndex >= trimmed.length - 1) {return { base: trimmed };}
	return {
		base: trimmed.slice(0, hashIndex),
		ref: trimmed.slice(hashIndex + 1).trim() || void 0
	};
}
function toOptionalString(value) {
	if (typeof value !== "string") {return;}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeEntrySource(raw) {
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) {return {
			ok: false,
			error: "empty plugin source"
		};}
		if (isHttpUrl(trimmed)) {return {
			ok: true,
			source: {
				kind: "url",
				url: trimmed
			}
		};}
		return {
			ok: true,
			source: {
				kind: "path",
				path: trimmed
			}
		};
	}
	if (!raw || typeof raw !== "object") {return {
		ok: false,
		error: "plugin source must be a string or object"
	};}
	const rec = raw;
	const kind = toOptionalString(rec.type) ?? toOptionalString(rec.source);
	if (!kind) {return {
		ok: false,
		error: "plugin source object missing \"type\" or \"source\""
	};}
	if (kind === "path") {
		const sourcePath = toOptionalString(rec.path);
		if (!sourcePath) {return {
			ok: false,
			error: "path source missing \"path\""
		};}
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
		if (!repo) {return {
			ok: false,
			error: "github source missing \"repo\""
		};}
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
		if (!url) {return {
			ok: false,
			error: "git source missing \"url\""
		};}
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
		if (!url) {return {
			ok: false,
			error: "git-subdir source missing \"url\""
		};}
		if (!sourcePath) {return {
			ok: false,
			error: "git-subdir source missing \"path\""
		};}
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
		if (!url) {return {
			ok: false,
			error: "url source missing \"url\""
		};}
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
	if (!parsed || typeof parsed !== "object") {return {
		ok: false,
		error: `invalid marketplace JSON at ${sourceLabel}: expected object`
	};}
	const rec = parsed;
	if (!Array.isArray(rec.plugins)) {return {
		ok: false,
		error: `invalid marketplace JSON at ${sourceLabel}: missing plugins[]`
	};}
	const plugins = [];
	for (const entry of rec.plugins) {
		if (!entry || typeof entry !== "object") {return {
			ok: false,
			error: `invalid marketplace entry in ${sourceLabel}: expected object`
		};}
		const plugin = entry;
		const name = toOptionalString(plugin.name);
		if (!name) {return {
			ok: false,
			error: `invalid marketplace entry in ${sourceLabel}: missing name`
		};}
		const normalizedSource = normalizeEntrySource(plugin.source);
		if (!normalizedSource.ok) {return {
			ok: false,
			error: `invalid marketplace entry "${name}" in ${sourceLabel}: ${normalizedSource.error}`
		};}
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
async function pathExists(target) {
	try {
		await fs$1.access(target);
		return true;
	} catch {
		return false;
	}
}
async function readClaudeKnownMarketplaces() {
	const knownPath = resolveUserPath(CLAUDE_KNOWN_MARKETPLACES_PATH);
	if (!await pathExists(knownPath)) {return {};}
	let parsed;
	try {
		parsed = JSON.parse(await fs$1.readFile(knownPath, "utf-8"));
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object") {return {};}
	const entries = parsed;
	const result = {};
	for (const [name, value] of Object.entries(entries)) {
		if (!value || typeof value !== "object") {continue;}
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
	if (!await pathExists(resolved)) {return null;}
	const stat = await fs$1.stat(resolved);
	if (stat.isFile()) {return {
		ok: true,
		rootDir: deriveMarketplaceRootFromManifestPath(resolved),
		manifestPath: resolved
	};}
	if (!stat.isDirectory()) {return {
		ok: false,
		error: `unsupported marketplace source: ${resolved}`
	};}
	const rootDir = path.basename(resolved) === ".claude-plugin" ? path.dirname(resolved) : resolved;
	for (const candidate of MARKETPLACE_MANIFEST_CANDIDATES) {
		const manifestPath = path.join(rootDir, candidate);
		if (await pathExists(manifestPath)) {return {
			ok: true,
			rootDir,
			manifestPath
		};}
	}
	return {
		ok: false,
		error: `marketplace manifest not found under ${resolved}`
	};
}
function normalizeGitCloneSource(source) {
	const split = splitRef(source);
	if (looksLikeGitHubRepoShorthand(split.base)) {return {
		url: `https://github.com/${split.base}.git`,
		ref: split.ref,
		label: split.base
	};}
	if (isGitUrl(source)) {return {
		url: split.base,
		ref: split.ref,
		label: split.base
	};}
	if (isHttpUrl(source)) {try {
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
	}}
	return null;
}
async function cloneMarketplaceRepo(params) {
	const normalized = normalizeGitCloneSource(params.source);
	if (!normalized) {return {
		ok: false,
		error: `unsupported marketplace source: ${params.source}`
	};}
	const tmpDir = await fs$1.mkdtemp(path.join(os.tmpdir(), "openclaw-marketplace-"));
	const repoDir = path.join(tmpDir, "repo");
	const argv = [
		"git",
		"clone",
		"--depth",
		"1"
	];
	if (normalized.ref) {argv.push("--branch", normalized.ref);}
	argv.push(normalized.url, repoDir);
	params.logger?.info?.(`Cloning marketplace source ${normalized.label}...`);
	const res = await runCommandWithTimeout(argv, { timeoutMs: params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS });
	if (res.code !== 0) {
		await fs$1.rm(tmpDir, {
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
			await fs$1.rm(tmpDir, {
				recursive: true,
				force: true
			}).catch(() => void 0);
		}
	};
}
async function loadMarketplace(params) {
	const known = (await readClaudeKnownMarketplaces())[params.source];
	if (known) {
		if (known.installLocation) {
			const local = await resolveLocalMarketplaceSource(known.installLocation);
			if (local?.ok) {
				const parsed = parseMarketplaceManifest(await fs$1.readFile(local.manifestPath, "utf-8"), local.manifestPath);
				if (!parsed.ok) {return parsed;}
				return {
					ok: true,
					marketplace: {
						manifest: parsed.manifest,
						rootDir: local.rootDir,
						sourceLabel: params.source
					}
				};
			}
		}
		const normalizedSource = normalizeEntrySource(known.source);
		if (normalizedSource.ok) {return await loadMarketplace({
			source: marketplaceEntrySourceToInput(normalizedSource.source),
			logger: params.logger,
			timeoutMs: params.timeoutMs
		});}
	}
	const local = await resolveLocalMarketplaceSource(params.source);
	if (local?.ok === false) {return local;}
	if (local?.ok) {
		const parsed = parseMarketplaceManifest(await fs$1.readFile(local.manifestPath, "utf-8"), local.manifestPath);
		if (!parsed.ok) {return parsed;}
		return {
			ok: true,
			marketplace: {
				manifest: parsed.manifest,
				rootDir: local.rootDir,
				sourceLabel: local.manifestPath
			}
		};
	}
	const cloned = await cloneMarketplaceRepo({
		source: params.source,
		timeoutMs: params.timeoutMs,
		logger: params.logger
	});
	if (!cloned.ok) {return cloned;}
	let manifestPath;
	for (const candidate of MARKETPLACE_MANIFEST_CANDIDATES) {
		const next = path.join(cloned.rootDir, candidate);
		if (await pathExists(next)) {
			manifestPath = next;
			break;
		}
	}
	if (!manifestPath) {
		await cloned.cleanup();
		return {
			ok: false,
			error: `marketplace manifest not found in ${cloned.label}`
		};
	}
	const parsed = parseMarketplaceManifest(await fs$1.readFile(manifestPath, "utf-8"), manifestPath);
	if (!parsed.ok) {
		await cloned.cleanup();
		return parsed;
	}
	return {
		ok: true,
		marketplace: {
			manifest: parsed.manifest,
			rootDir: cloned.rootDir,
			sourceLabel: cloned.label,
			cleanup: cloned.cleanup
		}
	};
}
async function downloadUrlToTempFile(url) {
	const response = await fetch(url);
	if (!response.ok) {return {
		ok: false,
		error: `failed to download ${url}: HTTP ${response.status}`
	};}
	const pathname = new URL(url).pathname;
	const fileName = path.basename(pathname) || "plugin.tgz";
	const tmpDir = await fs$1.mkdtemp(path.join(os.tmpdir(), "openclaw-marketplace-download-"));
	const targetPath = path.join(tmpDir, fileName);
	await fs$1.writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
	return {
		ok: true,
		path: targetPath,
		cleanup: async () => {
			await fs$1.rm(tmpDir, {
				recursive: true,
				force: true
			}).catch(() => void 0);
		}
	};
}
function ensureInsideMarketplaceRoot(rootDir, candidate) {
	const resolved = path.resolve(rootDir, candidate);
	const relative = path.relative(rootDir, resolved);
	if (relative === ".." || relative.startsWith(`..${path.sep}`)) {return {
		ok: false,
		error: `plugin source escapes marketplace root: ${candidate}`
	};}
	return {
		ok: true,
		path: resolved
	};
}
async function resolveMarketplaceEntryInstallPath(params) {
	if (params.source.kind === "path") {
		if (isHttpUrl(params.source.path)) {
			if (resolveArchiveKind(params.source.path)) {return await downloadUrlToTempFile(params.source.path);}
			return {
				ok: false,
				error: `unsupported remote plugin path source: ${params.source.path}`
			};
		}
		const resolved = path.isAbsolute(params.source.path) ? {
			ok: true,
			path: params.source.path
		} : ensureInsideMarketplaceRoot(params.marketplaceRootDir, params.source.path);
		if (!resolved.ok) {return resolved;}
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
		if (!cloned.ok) {return cloned;}
		const subPath = params.source.kind === "github" || params.source.kind === "git" ? params.source.path?.trim() || "." : params.source.path.trim();
		const target = ensureInsideMarketplaceRoot(cloned.rootDir, subPath);
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
	if (resolveArchiveKind(params.source.url)) {return await downloadUrlToTempFile(params.source.url);}
	if (!normalizeGitCloneSource(params.source.url)) {return {
		ok: false,
		error: `unsupported URL plugin source: ${params.source.url}`
	};}
	const cloned = await cloneMarketplaceRepo({
		source: params.source.url,
		timeoutMs: params.timeoutMs,
		logger: params.logger
	});
	if (!cloned.ok) {return cloned;}
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
	if (!loaded.ok) {return loaded;}
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
	if (atIndex <= 0 || atIndex >= trimmed.length - 1) {return null;}
	const plugin = trimmed.slice(0, atIndex).trim();
	const marketplaceName = trimmed.slice(atIndex + 1).trim();
	if (!plugin || !marketplaceName || plugin.includes("/")) {return null;}
	const known = (await readClaudeKnownMarketplaces())[marketplaceName];
	if (!known) {return null;}
	if (known.installLocation) {return {
		ok: true,
		plugin,
		marketplaceName,
		marketplaceSource: marketplaceName
	};}
	const normalizedSource = normalizeEntrySource(known.source);
	if (!normalizedSource.ok) {return {
		ok: false,
		error: `known Claude marketplace "${marketplaceName}" has an invalid source: ${normalizedSource.error}`
	};}
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
	if (!loaded.ok) {return loaded;}
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
			logger: params.logger,
			timeoutMs: params.timeoutMs
		});
		if (!resolved.ok) {return resolved;}
		installCleanup = resolved.cleanup;
		const result = await installPluginFromPath({
			path: resolved.path,
			logger: params.logger,
			mode: params.mode,
			dryRun: params.dryRun,
			expectedPluginId: params.expectedPluginId
		});
		if (!result.ok) {return result;}
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
//#region src/plugins/update.ts
function formatNpmInstallFailure(params) {
	if (params.result.code === PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND) {return `Failed to ${params.phase} ${params.pluginId}: npm package not found for ${params.spec}.`;}
	return `Failed to ${params.phase} ${params.pluginId}: ${params.result.error}`;
}
function formatMarketplaceInstallFailure(params) {
	return `Failed to ${params.phase} ${params.pluginId}: ${params.error} (marketplace plugin ${params.marketplacePlugin} from ${params.marketplaceSource}).`;
}
function expectedIntegrityForUpdate(spec, integrity) {
	if (!integrity || !spec) {return;}
	const value = spec.trim();
	if (!value) {return;}
	const at = value.lastIndexOf("@");
	if (at <= 0 || at >= value.length - 1) {return;}
	const version = value.slice(at + 1).trim();
	if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {return;}
	return integrity;
}
async function readInstalledPackageVersion(dir) {
	const opened = openBoundaryFileSync({
		absolutePath: path.join(dir, "package.json"),
		rootPath: dir,
		boundaryLabel: "installed plugin directory"
	});
	if (!opened.ok) {return;}
	try {
		const raw = fs.readFileSync(opened.fd, "utf-8");
		const parsed = JSON.parse(raw);
		return typeof parsed.version === "string" ? parsed.version : void 0;
	} catch {
		return;
	} finally {
		fs.closeSync(opened.fd);
	}
}
function pathsEqual(left, right, env = process.env) {
	if (!left || !right) {return false;}
	return resolveUserPath(left, env) === resolveUserPath(right, env);
}
function buildLoadPathHelpers(existing, env = process.env) {
	let paths = [...existing];
	const resolveSet = () => new Set(paths.map((entry) => resolveUserPath(entry, env)));
	let resolved = resolveSet();
	let changed = false;
	const addPath = (value) => {
		const normalized = resolveUserPath(value, env);
		if (resolved.has(normalized)) {return;}
		paths.push(value);
		resolved.add(normalized);
		changed = true;
	};
	const removePath = (value) => {
		const normalized = resolveUserPath(value, env);
		if (!resolved.has(normalized)) {return;}
		paths = paths.filter((entry) => resolveUserPath(entry, env) !== normalized);
		resolved = resolveSet();
		changed = true;
	};
	return {
		addPath,
		removePath,
		get changed() {
			return changed;
		},
		get paths() {
			return paths;
		}
	};
}
function replacePluginIdInList(entries, fromId, toId) {
	if (!entries || entries.length === 0 || fromId === toId) {return entries;}
	const next = [];
	for (const entry of entries) {
		const value = entry === fromId ? toId : entry;
		if (!next.includes(value)) {next.push(value);}
	}
	return next;
}
function migratePluginConfigId(cfg, fromId, toId) {
	if (fromId === toId) {return cfg;}
	const installs = cfg.plugins?.installs;
	const entries = cfg.plugins?.entries;
	const slots = cfg.plugins?.slots;
	const allow = replacePluginIdInList(cfg.plugins?.allow, fromId, toId);
	const deny = replacePluginIdInList(cfg.plugins?.deny, fromId, toId);
	const nextInstalls = installs ? { ...installs } : void 0;
	if (nextInstalls && fromId in nextInstalls) {
		const record = nextInstalls[fromId];
		if (record && !(toId in nextInstalls)) {nextInstalls[toId] = record;}
		delete nextInstalls[fromId];
	}
	const nextEntries = entries ? { ...entries } : void 0;
	if (nextEntries && fromId in nextEntries) {
		const entry = nextEntries[fromId];
		if (entry) {nextEntries[toId] = nextEntries[toId] ? {
			...entry,
			...nextEntries[toId]
		} : entry;}
		delete nextEntries[fromId];
	}
	const nextSlots = slots?.memory === fromId ? {
		...slots,
		memory: toId
	} : slots;
	return {
		...cfg,
		plugins: {
			...cfg.plugins,
			allow,
			deny,
			entries: nextEntries,
			installs: nextInstalls,
			slots: nextSlots
		}
	};
}
function createPluginUpdateIntegrityDriftHandler(params) {
	return async (drift) => {
		const payload = {
			pluginId: params.pluginId,
			spec: drift.spec,
			expectedIntegrity: drift.expectedIntegrity,
			actualIntegrity: drift.actualIntegrity,
			resolvedSpec: drift.resolution.resolvedSpec,
			resolvedVersion: drift.resolution.version,
			dryRun: params.dryRun
		};
		if (params.onIntegrityDrift) {return await params.onIntegrityDrift(payload);}
		params.logger.warn?.(`Integrity drift for "${params.pluginId}" (${payload.resolvedSpec ?? payload.spec}): expected ${payload.expectedIntegrity}, got ${payload.actualIntegrity}`);
		return true;
	};
}
async function updateNpmInstalledPlugins(params) {
	const logger = params.logger ?? {};
	const installs = params.config.plugins?.installs ?? {};
	const targets = params.pluginIds?.length ? params.pluginIds : Object.keys(installs);
	const outcomes = [];
	let next = params.config;
	let changed = false;
	for (const pluginId of targets) {
		if (params.skipIds?.has(pluginId)) {
			outcomes.push({
				pluginId,
				status: "skipped",
				message: `Skipping "${pluginId}" (already updated).`
			});
			continue;
		}
		const record = installs[pluginId];
		if (!record) {
			outcomes.push({
				pluginId,
				status: "skipped",
				message: `No install record for "${pluginId}".`
			});
			continue;
		}
		if (record.source !== "npm" && record.source !== "marketplace") {
			outcomes.push({
				pluginId,
				status: "skipped",
				message: `Skipping "${pluginId}" (source: ${record.source}).`
			});
			continue;
		}
		if (record.source === "npm" && !record.spec) {
			outcomes.push({
				pluginId,
				status: "skipped",
				message: `Skipping "${pluginId}" (missing npm spec).`
			});
			continue;
		}
		if (record.source === "marketplace" && (!record.marketplaceSource || !record.marketplacePlugin)) {
			outcomes.push({
				pluginId,
				status: "skipped",
				message: `Skipping "${pluginId}" (missing marketplace source metadata).`
			});
			continue;
		}
		let installPath;
		try {
			installPath = record.installPath ?? resolvePluginInstallDir(pluginId);
		} catch (err) {
			outcomes.push({
				pluginId,
				status: "error",
				message: `Invalid install path for "${pluginId}": ${String(err)}`
			});
			continue;
		}
		const currentVersion = await readInstalledPackageVersion(installPath);
		if (params.dryRun) {
			let probe;
			try {
				probe = record.source === "npm" ? await installPluginFromNpmSpec({
					spec: record.spec,
					mode: "update",
					dryRun: true,
					expectedPluginId: pluginId,
					expectedIntegrity: expectedIntegrityForUpdate(record.spec, record.integrity),
					onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
						pluginId,
						dryRun: true,
						logger,
						onIntegrityDrift: params.onIntegrityDrift
					}),
					logger
				}) : await installPluginFromMarketplace({
					marketplace: record.marketplaceSource,
					plugin: record.marketplacePlugin,
					mode: "update",
					dryRun: true,
					expectedPluginId: pluginId,
					logger
				});
			} catch (err) {
				outcomes.push({
					pluginId,
					status: "error",
					message: `Failed to check ${pluginId}: ${String(err)}`
				});
				continue;
			}
			if (!probe.ok) {
				outcomes.push({
					pluginId,
					status: "error",
					message: record.source === "npm" ? formatNpmInstallFailure({
						pluginId,
						spec: record.spec,
						phase: "check",
						result: probe
					}) : formatMarketplaceInstallFailure({
						pluginId,
						marketplaceSource: record.marketplaceSource,
						marketplacePlugin: record.marketplacePlugin,
						phase: "check",
						error: probe.error
					})
				});
				continue;
			}
			const nextVersion = probe.version ?? "unknown";
			const currentLabel = currentVersion ?? "unknown";
			if (currentVersion && probe.version && currentVersion === probe.version) {outcomes.push({
				pluginId,
				status: "unchanged",
				currentVersion: currentVersion ?? void 0,
				nextVersion: probe.version ?? void 0,
				message: `${pluginId} is up to date (${currentLabel}).`
			});}
			else {outcomes.push({
				pluginId,
				status: "updated",
				currentVersion: currentVersion ?? void 0,
				nextVersion: probe.version ?? void 0,
				message: `Would update ${pluginId}: ${currentLabel} -> ${nextVersion}.`
			});}
			continue;
		}
		let result;
		try {
			result = record.source === "npm" ? await installPluginFromNpmSpec({
				spec: record.spec,
				mode: "update",
				expectedPluginId: pluginId,
				expectedIntegrity: expectedIntegrityForUpdate(record.spec, record.integrity),
				onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
					pluginId,
					dryRun: false,
					logger,
					onIntegrityDrift: params.onIntegrityDrift
				}),
				logger
			}) : await installPluginFromMarketplace({
				marketplace: record.marketplaceSource,
				plugin: record.marketplacePlugin,
				mode: "update",
				expectedPluginId: pluginId,
				logger
			});
		} catch (err) {
			outcomes.push({
				pluginId,
				status: "error",
				message: `Failed to update ${pluginId}: ${String(err)}`
			});
			continue;
		}
		if (!result.ok) {
			outcomes.push({
				pluginId,
				status: "error",
				message: record.source === "npm" ? formatNpmInstallFailure({
					pluginId,
					spec: record.spec,
					phase: "update",
					result
				}) : formatMarketplaceInstallFailure({
					pluginId,
					marketplaceSource: record.marketplaceSource,
					marketplacePlugin: record.marketplacePlugin,
					phase: "update",
					error: result.error
				})
			});
			continue;
		}
		const resolvedPluginId = result.pluginId;
		if (resolvedPluginId !== pluginId) {next = migratePluginConfigId(next, pluginId, resolvedPluginId);}
		const nextVersion = result.version ?? await readInstalledPackageVersion(result.targetDir);
		if (record.source === "npm") {next = recordPluginInstall(next, {
			pluginId: resolvedPluginId,
			source: "npm",
			spec: record.spec,
			installPath: result.targetDir,
			version: nextVersion,
			...buildNpmResolutionInstallFields(result.npmResolution)
		});}
		else {
			const marketplaceResult = result;
			next = recordPluginInstall(next, {
				pluginId: resolvedPluginId,
				source: "marketplace",
				installPath: result.targetDir,
				version: nextVersion,
				marketplaceName: marketplaceResult.marketplaceName ?? record.marketplaceName,
				marketplaceSource: record.marketplaceSource,
				marketplacePlugin: record.marketplacePlugin
			});
		}
		changed = true;
		const currentLabel = currentVersion ?? "unknown";
		const nextLabel = nextVersion ?? "unknown";
		if (currentVersion && nextVersion && currentVersion === nextVersion) {outcomes.push({
			pluginId,
			status: "unchanged",
			currentVersion: currentVersion ?? void 0,
			nextVersion: nextVersion ?? void 0,
			message: `${pluginId} already at ${currentLabel}.`
		});}
		else {outcomes.push({
			pluginId,
			status: "updated",
			currentVersion: currentVersion ?? void 0,
			nextVersion: nextVersion ?? void 0,
			message: `Updated ${pluginId}: ${currentLabel} -> ${nextLabel}.`
		});}
	}
	return {
		config: next,
		changed,
		outcomes
	};
}
async function syncPluginsForUpdateChannel(params) {
	const env = params.env ?? process.env;
	const summary = {
		switchedToBundled: [],
		switchedToNpm: [],
		warnings: [],
		errors: []
	};
	const bundled = resolveBundledPluginSources({
		workspaceDir: params.workspaceDir,
		env
	});
	if (bundled.size === 0) {return {
		config: params.config,
		changed: false,
		summary
	};}
	let next = params.config;
	const loadHelpers = buildLoadPathHelpers(next.plugins?.load?.paths ?? [], env);
	const installs = next.plugins?.installs ?? {};
	let changed = false;
	if (params.channel === "dev") {for (const [pluginId, record] of Object.entries(installs)) {
		const bundledInfo = bundled.get(pluginId);
		if (!bundledInfo) continue;
		loadHelpers.addPath(bundledInfo.localPath);
		if (record.source === "path" && pathsEqual(record.sourcePath, bundledInfo.localPath, env)) continue;
		next = recordPluginInstall(next, {
			pluginId,
			source: "path",
			sourcePath: bundledInfo.localPath,
			installPath: bundledInfo.localPath,
			spec: record.spec ?? bundledInfo.npmSpec,
			version: record.version
		});
		summary.switchedToBundled.push(pluginId);
		changed = true;
	}}
	else {for (const [pluginId, record] of Object.entries(installs)) {
		const bundledInfo = bundled.get(pluginId);
		if (!bundledInfo) continue;
		if (record.source === "npm") {
			loadHelpers.removePath(bundledInfo.localPath);
			continue;
		}
		if (record.source !== "path") continue;
		if (!pathsEqual(record.sourcePath, bundledInfo.localPath, env)) continue;
		loadHelpers.addPath(bundledInfo.localPath);
		if (record.source === "path" && pathsEqual(record.sourcePath, bundledInfo.localPath, env) && pathsEqual(record.installPath, bundledInfo.localPath, env)) continue;
		next = recordPluginInstall(next, {
			pluginId,
			source: "path",
			sourcePath: bundledInfo.localPath,
			installPath: bundledInfo.localPath,
			spec: record.spec ?? bundledInfo.npmSpec,
			version: record.version
		});
		changed = true;
	}}
	if (loadHelpers.changed) {
		next = {
			...next,
			plugins: {
				...next.plugins,
				load: {
					...next.plugins?.load,
					paths: loadHelpers.paths
				}
			}
		};
		changed = true;
	}
	return {
		config: next,
		changed,
		summary
	};
}
//#endregion
export { resolveMarketplaceInstallShortcut as a, listMarketplacePlugins as i, updateNpmInstalledPlugins as n, installPluginFromMarketplace as r, syncPluginsForUpdateChannel as t };
