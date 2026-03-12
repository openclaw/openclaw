import { W as CONFIG_DIR, st as resolveUserPath } from "./entry.js";
import { n as isPathInside, t as extensionUsesSkippedScannerPath } from "./scan-paths-CVkptOYB.js";
import { o as loadPluginManifest } from "./manifest-registry-HLdbjiS7.js";
import { n as MANIFEST_KEY } from "./legacy-names-DNgFuAUV.js";
import { c as resolveArchiveKind, i as unscopedPackageName, n as safeDirName, o as fileExists, s as readJsonFile, t as resolveSafeInstallDir } from "./install-safe-path-CtKGJTZO.js";
import { a as resolveInstallModeOptions, c as withExtractedArchiveRoot, i as installPackageDir, l as resolveArchiveSourcePath, n as finalizeNpmSpecArchiveInstall, o as resolveTimedInstallModeOptions, r as installFromNpmSpecArchiveWithInstaller, s as resolveExistingInstallPath, t as validateRegistryNpmSpec } from "./npm-registry-spec-CkgO6Vzv.js";
import { t as scanDirectoryWithSummary } from "./skill-scanner-DIBfWMz1.js";
import path from "node:path";
import fs from "node:fs/promises";

//#region src/plugins/install.ts
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
async function ensureOpenClawExtensions(manifest) {
	const extensions = manifest[MANIFEST_KEY]?.extensions;
	if (!Array.isArray(extensions)) throw new Error("package.json missing openclaw.extensions");
	const list = extensions.map((e) => typeof e === "string" ? e.trim() : "").filter(Boolean);
	if (list.length === 0) throw new Error("package.json openclaw.extensions is empty");
	return list;
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
	let extensions;
	try {
		extensions = await ensureOpenClawExtensions(manifest);
	} catch (err) {
		return {
			ok: false,
			error: String(err)
		};
	}
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
		error: `plugin id mismatch: expected ${params.expectedPluginId}, got ${pluginId}`
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
	const extensionsDir = params.extensionsDir ? resolveUserPath(params.extensionsDir) : path.join(CONFIG_DIR, "extensions");
	await fs.mkdir(extensionsDir, { recursive: true });
	const targetDirResult = resolveSafeInstallDir({
		baseDir: extensionsDir,
		id: pluginId,
		invalidNameMessage: "invalid plugin name: path traversal detected"
	});
	if (!targetDirResult.ok) return {
		ok: false,
		error: targetDirResult.error
	};
	const targetDir = targetDirResult.path;
	if (mode === "install" && await fileExists(targetDir)) return {
		ok: false,
		error: `plugin already exists: ${targetDir} (delete it first)`
	};
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
			extensionsDir: params.extensionsDir,
			timeoutMs,
			logger,
			mode,
			dryRun: params.dryRun,
			expectedPluginId: params.expectedPluginId
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
		extensionsDir: params.extensionsDir,
		timeoutMs: params.timeoutMs,
		logger: params.logger,
		mode: params.mode,
		dryRun: params.dryRun,
		expectedPluginId: params.expectedPluginId
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
	if (mode === "install" && await fileExists(targetFile)) return {
		ok: false,
		error: `plugin already exists: ${targetFile} (delete it first)`
	};
	if (dryRun) return buildFileInstallResult(pluginId, targetFile);
	logger.info?.(`Installing to ${targetFile}…`);
	await fs.copyFile(filePath, targetFile);
	return buildFileInstallResult(pluginId, targetFile);
}
async function installPluginFromNpmSpec(params) {
	const { logger, timeoutMs, mode, dryRun } = resolveTimedInstallModeOptions(params, defaultLogger);
	const expectedPluginId = params.expectedPluginId;
	const spec = params.spec.trim();
	const specError = validateRegistryNpmSpec(spec);
	if (specError) return {
		ok: false,
		error: specError
	};
	logger.info?.(`Downloading ${spec}…`);
	return finalizeNpmSpecArchiveInstall(await installFromNpmSpecArchiveWithInstaller({
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
}
async function installPluginFromPath(params) {
	const pathResult = await resolveExistingInstallPath(params.path);
	if (!pathResult.ok) return pathResult;
	const { resolvedPath: resolved, stat } = pathResult;
	if (stat.isDirectory()) return await installPluginFromDir({
		dirPath: resolved,
		extensionsDir: params.extensionsDir,
		timeoutMs: params.timeoutMs,
		logger: params.logger,
		mode: params.mode,
		dryRun: params.dryRun,
		expectedPluginId: params.expectedPluginId
	});
	if (resolveArchiveKind(resolved)) return await installPluginFromArchive({
		archivePath: resolved,
		extensionsDir: params.extensionsDir,
		timeoutMs: params.timeoutMs,
		logger: params.logger,
		mode: params.mode,
		dryRun: params.dryRun,
		expectedPluginId: params.expectedPluginId
	});
	return await installPluginFromFile({
		filePath: resolved,
		extensionsDir: params.extensionsDir,
		logger: params.logger,
		mode: params.mode,
		dryRun: params.dryRun
	});
}

//#endregion
//#region src/plugins/installs.ts
function buildNpmResolutionInstallFields(resolution) {
	return {
		resolvedName: resolution?.name,
		resolvedVersion: resolution?.version,
		resolvedSpec: resolution?.resolvedSpec,
		integrity: resolution?.integrity,
		shasum: resolution?.shasum,
		resolvedAt: resolution?.resolvedAt
	};
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
export { resolvePluginInstallDir as a, installPluginFromPath as i, recordPluginInstall as n, installPluginFromNpmSpec as r, buildNpmResolutionInstallFields as t };