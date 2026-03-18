import { b as resolveUserPath, d as init_utils, t as CONFIG_DIR } from "./utils-BiUV1eIQ.js";
import { Lu as fileExists, Ru as readJsonFile, zu as resolveArchiveKind } from "./auth-profiles-DAOR1fRn.js";
import { f as detectBundleManifestFormat, h as resolvePackageExtensionEntries, i as discoverOpenClawPlugins, m as loadPluginManifest, p as loadBundleManifest } from "./manifest-registry-DZywV-kg.js";
import { g as validateRegistryNpmSpec } from "./env-overrides-Dbt5eAZJ.js";
import { n as isPathInside, t as extensionUsesSkippedScannerPath } from "./scan-paths-Zo6qyBUS.js";
import { N as writeFileFromPathWithinRoot } from "./query-expansion-V82ct97U.js";
import { t as scanDirectoryWithSummary } from "./skill-scanner-PR6IiKx6.js";
import { a as unscopedPackageName, i as safePathSegmentHashed, n as resolveSafeInstallDir, r as safeDirName } from "./install-safe-path-BmwD_9Ds.js";
import { a as resolveInstallModeOptions, c as installFromNpmSpecArchiveWithInstaller, d as buildNpmResolutionFields, f as resolveArchiveSourcePath, l as resolveExistingInstallPath, n as resolveCanonicalInstallTarget, o as resolveTimedInstallModeOptions, r as installPackageDir, s as finalizeNpmSpecArchiveInstall, t as ensureInstallTargetAvailable, u as withExtractedArchiveRoot } from "./install-target-RUKPUVdS.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/plugins/bundled-sources.ts
function findBundledPluginSourceInMap(params) {
	const targetValue = params.lookup.value.trim();
	if (!targetValue) return;
	if (params.lookup.kind === "pluginId") return params.bundled.get(targetValue);
	for (const source of params.bundled.values()) if (source.npmSpec === targetValue) return source;
}
function resolveBundledPluginSources(params) {
	const discovery = discoverOpenClawPlugins({
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	const bundled = /* @__PURE__ */ new Map();
	for (const candidate of discovery.candidates) {
		if (candidate.origin !== "bundled") continue;
		const manifest = loadPluginManifest(candidate.rootDir, false);
		if (!manifest.ok) continue;
		const pluginId = manifest.manifest.id;
		if (bundled.has(pluginId)) continue;
		const npmSpec = candidate.packageManifest?.install?.npmSpec?.trim() || candidate.packageName?.trim() || void 0;
		bundled.set(pluginId, {
			pluginId,
			localPath: candidate.rootDir,
			npmSpec
		});
	}
	return bundled;
}
function findBundledPluginSource(params) {
	return findBundledPluginSourceInMap({
		bundled: resolveBundledPluginSources({
			workspaceDir: params.workspaceDir,
			env: params.env
		}),
		lookup: params.lookup
	});
}
//#endregion
//#region src/plugins/install.ts
init_utils();
const MISSING_EXTENSIONS_ERROR = "package.json missing openclaw.extensions; update the plugin package to include openclaw.extensions (for example [\"./dist/index.js\"]). See https://docs.openclaw.ai/help/troubleshooting#plugin-install-fails-with-missing-openclaw-extensions";
const PLUGIN_INSTALL_ERROR_CODE = {
	INVALID_NPM_SPEC: "invalid_npm_spec",
	MISSING_OPENCLAW_EXTENSIONS: "missing_openclaw_extensions",
	EMPTY_OPENCLAW_EXTENSIONS: "empty_openclaw_extensions",
	NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
	PLUGIN_ID_MISMATCH: "plugin_id_mismatch"
};
const defaultLogger = {};
function safeFileName(input) {
	return safeDirName(input);
}
function encodePluginInstallDirName(pluginId) {
	const trimmed = pluginId.trim();
	if (!trimmed.includes("/")) return safeDirName(trimmed);
	return `@${safePathSegmentHashed(trimmed)}`;
}
function validatePluginId(pluginId) {
	const trimmed = pluginId.trim();
	if (!trimmed) return "invalid plugin name: missing";
	if (trimmed.includes("\\")) return "invalid plugin name: path separators not allowed";
	const segments = trimmed.split("/");
	if (segments.some((segment) => !segment)) return "invalid plugin name: malformed scope";
	if (segments.some((segment) => segment === "." || segment === "..")) return "invalid plugin name: reserved path segment";
	if (segments.length === 1) {
		if (trimmed.startsWith("@")) return "invalid plugin name: scoped ids must use @scope/name format";
		return null;
	}
	if (segments.length !== 2) return "invalid plugin name: path separators not allowed";
	if (!segments[0]?.startsWith("@") || segments[0].length < 2) return "invalid plugin name: scoped ids must use @scope/name format";
	return null;
}
function matchesExpectedPluginId(params) {
	if (!params.expectedPluginId) return true;
	if (params.expectedPluginId === params.pluginId) return true;
	return !params.manifestPluginId && params.pluginId === params.npmPluginId && params.expectedPluginId === unscopedPackageName(params.npmPluginId);
}
function ensureOpenClawExtensions(params) {
	const resolved = resolvePackageExtensionEntries(params.manifest);
	if (resolved.status === "missing") return {
		ok: false,
		error: MISSING_EXTENSIONS_ERROR,
		code: PLUGIN_INSTALL_ERROR_CODE.MISSING_OPENCLAW_EXTENSIONS
	};
	if (resolved.status === "empty") return {
		ok: false,
		error: "package.json openclaw.extensions is empty",
		code: PLUGIN_INSTALL_ERROR_CODE.EMPTY_OPENCLAW_EXTENSIONS
	};
	return {
		ok: true,
		entries: resolved.entries
	};
}
function isNpmPackageNotFoundMessage(error) {
	const normalized = error.trim();
	if (normalized.startsWith("Package not found on npm:")) return true;
	return /E404|404 not found|not in this registry/i.test(normalized);
}
function buildFileInstallResult(pluginId, targetFile) {
	return {
		ok: true,
		pluginId,
		targetDir: targetFile,
		manifestName: void 0,
		version: void 0,
		extensions: [path.basename(targetFile)]
	};
}
function pickPackageInstallCommonParams(params) {
	return {
		extensionsDir: params.extensionsDir,
		timeoutMs: params.timeoutMs,
		logger: params.logger,
		mode: params.mode,
		dryRun: params.dryRun,
		expectedPluginId: params.expectedPluginId
	};
}
function pickFileInstallCommonParams(params) {
	return {
		extensionsDir: params.extensionsDir,
		logger: params.logger,
		mode: params.mode,
		dryRun: params.dryRun
	};
}
function resolvePluginInstallDir(pluginId, extensionsDir) {
	const extensionsBase = extensionsDir ? resolveUserPath(extensionsDir) : path.join(CONFIG_DIR, "extensions");
	const pluginIdError = validatePluginId(pluginId);
	if (pluginIdError) throw new Error(pluginIdError);
	const targetDirResult = resolveSafeInstallDir({
		baseDir: extensionsBase,
		id: pluginId,
		invalidNameMessage: "invalid plugin name: path traversal detected",
		nameEncoder: encodePluginInstallDirName
	});
	if (!targetDirResult.ok) throw new Error(targetDirResult.error);
	return targetDirResult.path;
}
async function installBundleFromSourceDir(params) {
	const bundleFormat = detectBundleManifestFormat(params.sourceDir);
	if (!bundleFormat) return null;
	const { logger, timeoutMs, mode, dryRun } = resolveTimedInstallModeOptions(params, defaultLogger);
	const manifestRes = loadBundleManifest({
		rootDir: params.sourceDir,
		bundleFormat,
		rejectHardlinks: true
	});
	if (!manifestRes.ok) return {
		ok: false,
		error: manifestRes.error
	};
	const pluginId = manifestRes.manifest.id;
	const pluginIdError = validatePluginId(pluginId);
	if (pluginIdError) return {
		ok: false,
		error: pluginIdError
	};
	if (params.expectedPluginId && params.expectedPluginId !== pluginId) return {
		ok: false,
		error: `plugin id mismatch: expected ${params.expectedPluginId}, got ${pluginId}`,
		code: PLUGIN_INSTALL_ERROR_CODE.PLUGIN_ID_MISMATCH
	};
	try {
		const scanSummary = await scanDirectoryWithSummary(params.sourceDir);
		if (scanSummary.critical > 0) {
			const criticalDetails = scanSummary.findings.filter((f) => f.severity === "critical").map((f) => `${f.message} (${f.file}:${f.line})`).join("; ");
			logger.warn?.(`WARNING: Bundle "${pluginId}" contains dangerous code patterns: ${criticalDetails}`);
		} else if (scanSummary.warn > 0) logger.warn?.(`Bundle "${pluginId}" has ${scanSummary.warn} suspicious code pattern(s). Run "openclaw security audit --deep" for details.`);
	} catch (err) {
		logger.warn?.(`Bundle "${pluginId}" code safety scan failed (${String(err)}). Installation continues; run "openclaw security audit --deep" after install.`);
	}
	const targetDirResult = await resolveCanonicalInstallTarget({
		baseDir: params.extensionsDir ? resolveUserPath(params.extensionsDir) : path.join(CONFIG_DIR, "extensions"),
		id: pluginId,
		invalidNameMessage: "invalid plugin name: path traversal detected",
		boundaryLabel: "extensions directory"
	});
	if (!targetDirResult.ok) return {
		ok: false,
		error: targetDirResult.error
	};
	const targetDir = targetDirResult.targetDir;
	const availability = await ensureInstallTargetAvailable({
		mode,
		targetDir,
		alreadyExistsError: `plugin already exists: ${targetDir} (delete it first)`
	});
	if (!availability.ok) return availability;
	if (dryRun) return {
		ok: true,
		pluginId,
		targetDir,
		manifestName: manifestRes.manifest.name,
		version: manifestRes.manifest.version,
		extensions: []
	};
	const installRes = await installPackageDir({
		sourceDir: params.sourceDir,
		targetDir,
		mode,
		timeoutMs,
		logger,
		copyErrorPrefix: "failed to copy plugin bundle",
		hasDeps: false,
		depsLogMessage: ""
	});
	if (!installRes.ok) return installRes;
	return {
		ok: true,
		pluginId,
		targetDir,
		manifestName: manifestRes.manifest.name,
		version: manifestRes.manifest.version,
		extensions: []
	};
}
async function installPluginFromSourceDir(params) {
	if (await detectNativePackageInstallSource(params.sourceDir)) return await installPluginFromPackageDir({
		packageDir: params.sourceDir,
		...pickPackageInstallCommonParams(params)
	});
	const bundleResult = await installBundleFromSourceDir({
		sourceDir: params.sourceDir,
		...pickPackageInstallCommonParams(params)
	});
	if (bundleResult) return bundleResult;
	return await installPluginFromPackageDir({
		packageDir: params.sourceDir,
		...pickPackageInstallCommonParams(params)
	});
}
async function detectNativePackageInstallSource(packageDir) {
	const manifestPath = path.join(packageDir, "package.json");
	if (!await fileExists(manifestPath)) return false;
	try {
		return ensureOpenClawExtensions({ manifest: await readJsonFile(manifestPath) }).ok;
	} catch {
		return false;
	}
}
async function installPluginFromPackageDir(params) {
	const { logger, timeoutMs, mode, dryRun } = resolveTimedInstallModeOptions(params, defaultLogger);
	const manifestPath = path.join(params.packageDir, "package.json");
	if (!await fileExists(manifestPath)) return {
		ok: false,
		error: "extracted package missing package.json"
	};
	let manifest;
	try {
		manifest = await readJsonFile(manifestPath);
	} catch (err) {
		return {
			ok: false,
			error: `invalid package.json: ${String(err)}`
		};
	}
	const extensionsResult = ensureOpenClawExtensions({ manifest });
	if (!extensionsResult.ok) return {
		ok: false,
		error: extensionsResult.error,
		code: extensionsResult.code
	};
	const extensions = extensionsResult.entries;
	const pkgName = typeof manifest.name === "string" ? manifest.name.trim() : "";
	const npmPluginId = pkgName || "plugin";
	const ocManifestResult = loadPluginManifest(params.packageDir);
	const manifestPluginId = ocManifestResult.ok && ocManifestResult.manifest.id ? ocManifestResult.manifest.id.trim() : void 0;
	const pluginId = manifestPluginId ?? npmPluginId;
	const pluginIdError = validatePluginId(pluginId);
	if (pluginIdError) return {
		ok: false,
		error: pluginIdError
	};
	if (!matchesExpectedPluginId({
		expectedPluginId: params.expectedPluginId,
		pluginId,
		manifestPluginId,
		npmPluginId
	})) return {
		ok: false,
		error: `plugin id mismatch: expected ${params.expectedPluginId}, got ${pluginId}`,
		code: PLUGIN_INSTALL_ERROR_CODE.PLUGIN_ID_MISMATCH
	};
	if (manifestPluginId && manifestPluginId !== npmPluginId) logger.info?.(`Plugin manifest id "${manifestPluginId}" differs from npm package name "${npmPluginId}"; using manifest id as the config key.`);
	const packageDir = path.resolve(params.packageDir);
	const forcedScanEntries = [];
	for (const entry of extensions) {
		const resolvedEntry = path.resolve(packageDir, entry);
		if (!isPathInside(packageDir, resolvedEntry)) {
			logger.warn?.(`extension entry escapes plugin directory and will not be scanned: ${entry}`);
			continue;
		}
		if (extensionUsesSkippedScannerPath(entry)) logger.warn?.(`extension entry is in a hidden/node_modules path and will receive targeted scan coverage: ${entry}`);
		forcedScanEntries.push(resolvedEntry);
	}
	try {
		const scanSummary = await scanDirectoryWithSummary(params.packageDir, { includeFiles: forcedScanEntries });
		if (scanSummary.critical > 0) {
			const criticalDetails = scanSummary.findings.filter((f) => f.severity === "critical").map((f) => `${f.message} (${f.file}:${f.line})`).join("; ");
			logger.warn?.(`WARNING: Plugin "${pluginId}" contains dangerous code patterns: ${criticalDetails}`);
		} else if (scanSummary.warn > 0) logger.warn?.(`Plugin "${pluginId}" has ${scanSummary.warn} suspicious code pattern(s). Run "openclaw security audit --deep" for details.`);
	} catch (err) {
		logger.warn?.(`Plugin "${pluginId}" code safety scan failed (${String(err)}). Installation continues; run "openclaw security audit --deep" after install.`);
	}
	const targetDirResult = await resolveCanonicalInstallTarget({
		baseDir: params.extensionsDir ? resolveUserPath(params.extensionsDir) : path.join(CONFIG_DIR, "extensions"),
		id: pluginId,
		invalidNameMessage: "invalid plugin name: path traversal detected",
		boundaryLabel: "extensions directory",
		nameEncoder: encodePluginInstallDirName
	});
	if (!targetDirResult.ok) return {
		ok: false,
		error: targetDirResult.error
	};
	const targetDir = targetDirResult.targetDir;
	const availability = await ensureInstallTargetAvailable({
		mode,
		targetDir,
		alreadyExistsError: `plugin already exists: ${targetDir} (delete it first)`
	});
	if (!availability.ok) return availability;
	if (dryRun) return {
		ok: true,
		pluginId,
		targetDir,
		manifestName: pkgName || void 0,
		version: typeof manifest.version === "string" ? manifest.version : void 0,
		extensions
	};
	const deps = manifest.dependencies ?? {};
	const hasDeps = Object.keys(deps).length > 0;
	const installRes = await installPackageDir({
		sourceDir: params.packageDir,
		targetDir,
		mode,
		timeoutMs,
		logger,
		copyErrorPrefix: "failed to copy plugin",
		hasDeps,
		depsLogMessage: "Installing plugin dependencies…",
		afterCopy: async (installedDir) => {
			for (const entry of extensions) {
				const resolvedEntry = path.resolve(installedDir, entry);
				if (!isPathInside(installedDir, resolvedEntry)) {
					logger.warn?.(`extension entry escapes plugin directory: ${entry}`);
					continue;
				}
				if (!await fileExists(resolvedEntry)) logger.warn?.(`extension entry not found: ${entry}`);
			}
		}
	});
	if (!installRes.ok) return installRes;
	return {
		ok: true,
		pluginId,
		targetDir,
		manifestName: pkgName || void 0,
		version: typeof manifest.version === "string" ? manifest.version : void 0,
		extensions
	};
}
async function installPluginFromArchive(params) {
	const logger = params.logger ?? defaultLogger;
	const timeoutMs = params.timeoutMs ?? 12e4;
	const mode = params.mode ?? "install";
	const archivePathResult = await resolveArchiveSourcePath(params.archivePath);
	if (!archivePathResult.ok) return archivePathResult;
	const archivePath = archivePathResult.path;
	return await withExtractedArchiveRoot({
		archivePath,
		tempDirPrefix: "openclaw-plugin-",
		timeoutMs,
		logger,
		onExtracted: async (sourceDir) => await installPluginFromSourceDir({
			sourceDir,
			...pickPackageInstallCommonParams({
				extensionsDir: params.extensionsDir,
				timeoutMs,
				logger,
				mode,
				dryRun: params.dryRun,
				expectedPluginId: params.expectedPluginId
			})
		})
	});
}
async function installPluginFromDir(params) {
	const dirPath = resolveUserPath(params.dirPath);
	if (!await fileExists(dirPath)) return {
		ok: false,
		error: `directory not found: ${dirPath}`
	};
	if (!(await fs.stat(dirPath)).isDirectory()) return {
		ok: false,
		error: `not a directory: ${dirPath}`
	};
	return await installPluginFromSourceDir({
		sourceDir: dirPath,
		...pickPackageInstallCommonParams(params)
	});
}
async function installPluginFromFile(params) {
	const { logger, mode, dryRun } = resolveInstallModeOptions(params, defaultLogger);
	const filePath = resolveUserPath(params.filePath);
	if (!await fileExists(filePath)) return {
		ok: false,
		error: `file not found: ${filePath}`
	};
	const extensionsDir = params.extensionsDir ? resolveUserPath(params.extensionsDir) : path.join(CONFIG_DIR, "extensions");
	await fs.mkdir(extensionsDir, { recursive: true });
	const pluginId = path.basename(filePath, path.extname(filePath)) || "plugin";
	const pluginIdError = validatePluginId(pluginId);
	if (pluginIdError) return {
		ok: false,
		error: pluginIdError
	};
	const targetFile = path.join(extensionsDir, `${safeFileName(pluginId)}${path.extname(filePath)}`);
	const availability = await ensureInstallTargetAvailable({
		mode,
		targetDir: targetFile,
		alreadyExistsError: `plugin already exists: ${targetFile} (delete it first)`
	});
	if (!availability.ok) return availability;
	if (dryRun) return buildFileInstallResult(pluginId, targetFile);
	logger.info?.(`Installing to ${targetFile}…`);
	try {
		await writeFileFromPathWithinRoot({
			rootDir: extensionsDir,
			relativePath: path.basename(targetFile),
			sourcePath: filePath
		});
	} catch (err) {
		return {
			ok: false,
			error: String(err)
		};
	}
	return buildFileInstallResult(pluginId, targetFile);
}
async function installPluginFromNpmSpec(params) {
	const { logger, timeoutMs, mode, dryRun } = resolveTimedInstallModeOptions(params, defaultLogger);
	const expectedPluginId = params.expectedPluginId;
	const spec = params.spec.trim();
	const specError = validateRegistryNpmSpec(spec);
	if (specError) return {
		ok: false,
		error: specError,
		code: PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC
	};
	logger.info?.(`Downloading ${spec}…`);
	const finalized = finalizeNpmSpecArchiveInstall(await installFromNpmSpecArchiveWithInstaller({
		tempDirPrefix: "openclaw-npm-pack-",
		spec,
		timeoutMs,
		expectedIntegrity: params.expectedIntegrity,
		onIntegrityDrift: params.onIntegrityDrift,
		warn: (message) => {
			logger.warn?.(message);
		},
		installFromArchive: installPluginFromArchive,
		archiveInstallParams: {
			extensionsDir: params.extensionsDir,
			timeoutMs,
			logger,
			mode,
			dryRun,
			expectedPluginId
		}
	}));
	if (!finalized.ok && isNpmPackageNotFoundMessage(finalized.error)) return {
		ok: false,
		error: finalized.error,
		code: PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND
	};
	return finalized;
}
async function installPluginFromPath(params) {
	const pathResult = await resolveExistingInstallPath(params.path);
	if (!pathResult.ok) return pathResult;
	const { resolvedPath: resolved, stat } = pathResult;
	const packageInstallOptions = pickPackageInstallCommonParams(params);
	if (stat.isDirectory()) return await installPluginFromDir({
		dirPath: resolved,
		...packageInstallOptions
	});
	if (resolveArchiveKind(resolved)) return await installPluginFromArchive({
		archivePath: resolved,
		...packageInstallOptions
	});
	return await installPluginFromFile({
		filePath: resolved,
		...pickFileInstallCommonParams(params)
	});
}
//#endregion
//#region src/plugins/installs.ts
function buildNpmResolutionInstallFields(resolution) {
	return buildNpmResolutionFields(resolution);
}
function recordPluginInstall(cfg, update) {
	const { pluginId, ...record } = update;
	const installs = {
		...cfg.plugins?.installs,
		[pluginId]: {
			...cfg.plugins?.installs?.[pluginId],
			...record,
			installedAt: record.installedAt ?? (/* @__PURE__ */ new Date()).toISOString()
		}
	};
	return {
		...cfg,
		plugins: {
			...cfg.plugins,
			installs: {
				...installs,
				[pluginId]: installs[pluginId]
			}
		}
	};
}
//#endregion
export { installPluginFromPath as a, findBundledPluginSourceInMap as c, installPluginFromNpmSpec as i, resolveBundledPluginSources as l, recordPluginInstall as n, resolvePluginInstallDir as o, PLUGIN_INSTALL_ERROR_CODE as r, findBundledPluginSource as s, buildNpmResolutionInstallFields as t };
