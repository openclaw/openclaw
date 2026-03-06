import { t as CONFIG_DIR, v as resolveUserPath } from "./utils-xLjEf_5u.js";
import { o as loadPluginManifest, s as resolvePackageExtensionEntries } from "./manifest-registry-YpcF6BWJ.js";
import { i as isPathInside, r as extensionUsesSkippedScannerPath } from "./legacy-names-DswREgBV.js";
import { S as validateRegistryNpmSpec } from "./skills-LzLwUYxz.js";
import { c as writeFileFromPathWithinRoot } from "./fs-safe-DS4hJvDc.js";
import { a as unscopedPackageName, c as fileExists, l as readJsonFile, n as resolveSafeInstallDir, r as safeDirName, u as resolveArchiveKind } from "./install-safe-path-ChwhEWKt.js";
import { a as installPackageDir, c as resolveTimedInstallModeOptions, d as buildNpmResolutionFields, f as resolveArchiveSourcePath, i as resolveCanonicalInstallTarget, l as resolveExistingInstallPath, n as installFromNpmSpecArchiveWithInstaller, r as ensureInstallTargetAvailable, s as resolveInstallModeOptions, t as finalizeNpmSpecArchiveInstall, u as withExtractedArchiveRoot } from "./npm-pack-install-BMv_lCYA.js";
import { t as scanDirectoryWithSummary } from "./skill-scanner-CzkqG2pN.js";
import path from "node:path";
import fs from "node:fs/promises";

//#region src/plugins/install.ts
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
function validatePluginId(pluginId) {
	if (!pluginId) return "invalid plugin name: missing";
	if (pluginId === "." || pluginId === "..") return "invalid plugin name: reserved path segment";
	if (pluginId.includes("/") || pluginId.includes("\\")) return "invalid plugin name: path separators not allowed";
	return null;
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
		invalidNameMessage: "invalid plugin name: path traversal detected"
	});
	if (!targetDirResult.ok) throw new Error(targetDirResult.error);
	return targetDirResult.path;
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
	const pkgName = typeof manifest.name === "string" ? manifest.name : "";
	const npmPluginId = pkgName ? unscopedPackageName(pkgName) : "plugin";
	const ocManifestResult = loadPluginManifest(params.packageDir);
	const manifestPluginId = ocManifestResult.ok && ocManifestResult.manifest.id ? unscopedPackageName(ocManifestResult.manifest.id) : void 0;
	const pluginId = manifestPluginId ?? npmPluginId;
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
		afterCopy: async () => {
			for (const entry of extensions) {
				const resolvedEntry = path.resolve(targetDir, entry);
				if (!isPathInside(targetDir, resolvedEntry)) {
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
		onExtracted: async (packageDir) => await installPluginFromPackageDir({
			packageDir,
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
	return await installPluginFromPackageDir({
		packageDir: dirPath,
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
export { installPluginFromPath as a, installPluginFromNpmSpec as i, recordPluginInstall as n, resolvePluginInstallDir as o, PLUGIN_INSTALL_ERROR_CODE as r, buildNpmResolutionInstallFields as t };