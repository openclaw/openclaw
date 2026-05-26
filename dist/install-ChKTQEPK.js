import { i as resolveSafeInstallDir, n as unscopedPackageName } from "./install-safe-path-DEiFZ_bF.js";
import { p as resolveUserPath, t as CONFIG_DIR } from "./utils-sBTEdeml.js";
import { n as MANIFEST_KEY } from "./legacy-names-CuutNmLC.js";
import { t as parseFrontmatter } from "./frontmatter-D8Mpt4Ck.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/hooks/install.ts
let hookInstallRuntimePromise;
async function loadHookInstallRuntime() {
	hookInstallRuntimePromise ??= import("./install.runtime-C29e7bKM.js");
	return hookInstallRuntimePromise;
}
const defaultLogger = {};
function buildHookInstallForwardParams(params) {
	return {
		dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
		hooksDir: params.hooksDir,
		timeoutMs: params.timeoutMs,
		logger: params.logger,
		mode: params.mode,
		dryRun: params.dryRun,
		expectedHookPackId: params.expectedHookPackId
	};
}
function validateHookId(hookId) {
	if (!hookId) return "invalid hook name: missing";
	if (hookId === "." || hookId === "..") return "invalid hook name: reserved path segment";
	if (hookId.includes("/") || hookId.includes("\\")) return "invalid hook name: path separators not allowed";
	return null;
}
function resolveHookInstallDir(hookId, hooksDir) {
	const hooksBase = hooksDir ? resolveUserPath(hooksDir) : path.join(CONFIG_DIR, "hooks");
	const hookIdError = validateHookId(hookId);
	if (hookIdError) throw new Error(hookIdError);
	const targetDirResult = resolveSafeInstallDir({
		baseDir: hooksBase,
		id: hookId,
		invalidNameMessage: "invalid hook name: path traversal detected"
	});
	if (!targetDirResult.ok) throw new Error(targetDirResult.error);
	return targetDirResult.path;
}
async function ensureOpenClawHooks(manifest) {
	const hooks = manifest[MANIFEST_KEY]?.hooks;
	if (!Array.isArray(hooks)) throw new Error("package.json missing openclaw.hooks");
	const list = hooks.map((e) => typeof e === "string" ? e.trim() : "").filter(Boolean);
	if (list.length === 0) throw new Error("package.json openclaw.hooks is empty");
	return list;
}
async function resolveInstallTargetDir(id, hooksDir) {
	const runtime = await loadHookInstallRuntime();
	const baseHooksDir = hooksDir ? resolveUserPath(hooksDir) : path.join(CONFIG_DIR, "hooks");
	return await runtime.resolveCanonicalInstallTarget({
		baseDir: baseHooksDir,
		id,
		invalidNameMessage: "invalid hook name: path traversal detected",
		boundaryLabel: "hooks directory"
	});
}
async function resolveAvailableHookInstallTarget(params) {
	const runtime = await loadHookInstallRuntime();
	const targetDirResult = await resolveInstallTargetDir(params.id, params.hooksDir);
	if (!targetDirResult.ok) return targetDirResult;
	const targetDir = targetDirResult.targetDir;
	const availability = await runtime.ensureInstallTargetAvailable({
		mode: params.mode,
		targetDir,
		alreadyExistsError: params.alreadyExistsError(targetDir)
	});
	if (!availability.ok) return availability;
	return {
		ok: true,
		targetDir
	};
}
async function installFromResolvedHookDir(resolvedDir, params) {
	const runtime = await loadHookInstallRuntime();
	const manifestPath = path.join(resolvedDir, "package.json");
	if (await runtime.fileExists(manifestPath)) return await installHookPackageFromDir({
		packageDir: resolvedDir,
		hooksDir: params.hooksDir,
		timeoutMs: params.timeoutMs,
		logger: params.logger,
		mode: params.mode,
		dryRun: params.dryRun,
		expectedHookPackId: params.expectedHookPackId
	});
	return await installHookFromDir({
		hookDir: resolvedDir,
		hooksDir: params.hooksDir,
		logger: params.logger,
		mode: params.mode,
		dryRun: params.dryRun,
		expectedHookPackId: params.expectedHookPackId
	});
}
async function resolveHookNameFromDir(hookDir) {
	const runtime = await loadHookInstallRuntime();
	const hookMdPath = path.join(hookDir, "HOOK.md");
	if (!await runtime.fileExists(hookMdPath)) throw new Error(`HOOK.md missing in ${hookDir}`);
	return parseFrontmatter(await fs.readFile(hookMdPath, "utf-8")).name || path.basename(hookDir);
}
async function validateHookDir(hookDir) {
	const runtime = await loadHookInstallRuntime();
	const hookMdPath = path.join(hookDir, "HOOK.md");
	if (!await runtime.fileExists(hookMdPath)) throw new Error(`HOOK.md missing in ${hookDir}`);
	if (!await Promise.all([
		"handler.ts",
		"handler.js",
		"index.ts",
		"index.js"
	].map(async (candidate) => runtime.fileExists(path.join(hookDir, candidate)))).then((results) => results.some(Boolean))) throw new Error(`handler.ts/handler.js/index.ts/index.js missing in ${hookDir}`);
}
async function installHookPackageFromDir(params) {
	const runtime = await loadHookInstallRuntime();
	const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(params, defaultLogger);
	const manifestPath = path.join(params.packageDir, "package.json");
	if (!await runtime.fileExists(manifestPath)) return {
		ok: false,
		error: "package.json missing"
	};
	let manifest;
	try {
		manifest = await runtime.readJsonFile(manifestPath);
	} catch (err) {
		return {
			ok: false,
			error: `invalid package.json: ${String(err)}`
		};
	}
	let hookEntries;
	try {
		hookEntries = await ensureOpenClawHooks(manifest);
	} catch (err) {
		return {
			ok: false,
			error: String(err)
		};
	}
	const pkgName = typeof manifest.name === "string" ? manifest.name : "";
	const hookPackId = pkgName ? unscopedPackageName(pkgName) : path.basename(params.packageDir);
	const hookIdError = validateHookId(hookPackId);
	if (hookIdError) return {
		ok: false,
		error: hookIdError
	};
	if (params.expectedHookPackId && params.expectedHookPackId !== hookPackId) return {
		ok: false,
		error: `hook pack id mismatch: expected ${params.expectedHookPackId}, got ${hookPackId}`
	};
	const target = await resolveAvailableHookInstallTarget({
		id: hookPackId,
		hooksDir: params.hooksDir,
		mode,
		alreadyExistsError: (targetDir) => `hook pack already exists: ${targetDir} (delete it first)`
	});
	if (!target.ok) return target;
	const targetDir = target.targetDir;
	const resolvedHooks = [];
	for (const entry of hookEntries) {
		const hookDir = path.resolve(params.packageDir, entry);
		if (!runtime.isPathInside(params.packageDir, hookDir)) return {
			ok: false,
			error: `openclaw.hooks entry escapes package directory: ${entry}`
		};
		await validateHookDir(hookDir);
		if (!runtime.isPathInsideWithRealpath(params.packageDir, hookDir, { requireRealpath: true })) return {
			ok: false,
			error: `openclaw.hooks entry resolves outside package directory: ${entry}`
		};
		const hookName = await resolveHookNameFromDir(hookDir);
		resolvedHooks.push(hookName);
	}
	if (dryRun) return {
		ok: true,
		hookPackId,
		hooks: resolvedHooks,
		targetDir,
		version: typeof manifest.version === "string" ? manifest.version : void 0
	};
	const installRes = await runtime.installPackageDirWithManifestDeps({
		sourceDir: params.packageDir,
		targetDir,
		mode,
		timeoutMs,
		logger,
		copyErrorPrefix: "failed to copy hook pack",
		depsLogMessage: "Installing hook pack dependencies…",
		manifestDependencies: manifest.dependencies
	});
	if (!installRes.ok) return installRes;
	return {
		ok: true,
		hookPackId,
		hooks: resolvedHooks,
		targetDir,
		version: typeof manifest.version === "string" ? manifest.version : void 0
	};
}
async function installHookFromDir(params) {
	const runtime = await loadHookInstallRuntime();
	const { logger, mode, dryRun } = runtime.resolveInstallModeOptions(params, defaultLogger);
	await validateHookDir(params.hookDir);
	const hookName = await resolveHookNameFromDir(params.hookDir);
	const hookIdError = validateHookId(hookName);
	if (hookIdError) return {
		ok: false,
		error: hookIdError
	};
	if (params.expectedHookPackId && params.expectedHookPackId !== hookName) return {
		ok: false,
		error: `hook id mismatch: expected ${params.expectedHookPackId}, got ${hookName}`
	};
	const target = await resolveAvailableHookInstallTarget({
		id: hookName,
		hooksDir: params.hooksDir,
		mode,
		alreadyExistsError: (targetDir) => `hook already exists: ${targetDir} (delete it first)`
	});
	if (!target.ok) return target;
	const targetDir = target.targetDir;
	if (dryRun) return {
		ok: true,
		hookPackId: hookName,
		hooks: [hookName],
		targetDir
	};
	const installRes = await runtime.installPackageDir({
		sourceDir: params.hookDir,
		targetDir,
		mode,
		timeoutMs: 12e4,
		logger,
		copyErrorPrefix: "failed to copy hook",
		hasDeps: false,
		depsLogMessage: "Installing hook dependencies…"
	});
	if (!installRes.ok) return installRes;
	return {
		ok: true,
		hookPackId: hookName,
		hooks: [hookName],
		targetDir
	};
}
async function installHooksFromArchive(params) {
	const runtime = await loadHookInstallRuntime();
	const logger = params.logger ?? defaultLogger;
	const timeoutMs = params.timeoutMs ?? 12e4;
	const archivePathResult = await runtime.resolveArchiveSourcePath(params.archivePath);
	if (!archivePathResult.ok) return archivePathResult;
	const archivePath = archivePathResult.path;
	return await runtime.withExtractedArchiveRoot({
		archivePath,
		tempDirPrefix: "openclaw-hook-",
		timeoutMs,
		logger,
		onExtracted: async (rootDir) => await installFromResolvedHookDir(rootDir, buildHookInstallForwardParams({
			hooksDir: params.hooksDir,
			timeoutMs,
			logger,
			mode: params.mode,
			dryRun: params.dryRun,
			expectedHookPackId: params.expectedHookPackId
		}))
	});
}
async function installHooksFromNpmSpec(params) {
	const runtime = await loadHookInstallRuntime();
	const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(params, defaultLogger);
	const expectedHookPackId = params.expectedHookPackId;
	const spec = params.spec;
	logger.info?.(`Downloading ${spec.trim()}…`);
	return await runtime.installFromValidatedNpmSpecArchive({
		tempDirPrefix: "openclaw-hook-pack-",
		spec,
		timeoutMs,
		expectedIntegrity: params.expectedIntegrity,
		onIntegrityDrift: params.onIntegrityDrift,
		warn: (message) => {
			logger.warn?.(message);
		},
		installFromArchive: installHooksFromArchive,
		archiveInstallParams: buildHookInstallForwardParams({
			hooksDir: params.hooksDir,
			timeoutMs,
			logger,
			mode,
			dryRun,
			expectedHookPackId
		})
	});
}
async function installHooksFromPath(params) {
	const runtime = await loadHookInstallRuntime();
	const pathResult = await runtime.resolveExistingInstallPath(params.path);
	if (!pathResult.ok) return pathResult;
	const { resolvedPath: resolved, stat } = pathResult;
	const forwardParams = buildHookInstallForwardParams({
		dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
		hooksDir: params.hooksDir,
		timeoutMs: params.timeoutMs,
		logger: params.logger,
		mode: params.mode,
		dryRun: params.dryRun,
		expectedHookPackId: params.expectedHookPackId
	});
	if (stat.isDirectory()) return await installFromResolvedHookDir(resolved, forwardParams);
	if (!runtime.resolveArchiveKind(resolved)) return {
		ok: false,
		error: `unsupported hook file: ${resolved}`
	};
	return await installHooksFromArchive({
		archivePath: resolved,
		...forwardParams
	});
}
//#endregion
export { installHooksFromPath as n, resolveHookInstallDir as r, installHooksFromNpmSpec as t };
