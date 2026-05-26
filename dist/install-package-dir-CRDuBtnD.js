import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { r as assertCanonicalPathWithinBase } from "./install-safe-path-DEiFZ_bF.js";
import { c as resolvePackedRootDir, t as extractArchive } from "./archive-DBeZ8ywX.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { t as movePathWithCopyFallback } from "./replace-file-C7_Inj8B.js";
import { m as writeJson, o as tryReadJson } from "./json-files-C2hqjU--.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import "./archive-CBe_wA_B.js";
import { s as withTempDir } from "./install-source-utils-BA9AHTyU.js";
import { n as createSafeNpmInstallEnv, t as createSafeNpmInstallArgs } from "./safe-package-install-CZ0VYBja.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/infra/install-flow.ts
async function resolveExistingInstallPath(inputPath) {
	const resolvedPath = resolveUserPath(inputPath);
	if (!await pathExists(resolvedPath)) return {
		ok: false,
		error: `path not found: ${resolvedPath}`
	};
	return {
		ok: true,
		resolvedPath,
		stat: await fs.stat(resolvedPath)
	};
}
async function withExtractedArchiveRoot(params) {
	return await withTempDir(params.tempDirPrefix, async (tmpDir) => {
		const extractDir = path.join(tmpDir, "extract");
		await fs.mkdir(extractDir, { recursive: true });
		params.logger?.info?.(`Extracting ${params.archivePath}…`);
		try {
			await extractArchive({
				archivePath: params.archivePath,
				destDir: extractDir,
				timeoutMs: params.timeoutMs,
				logger: params.logger
			});
		} catch (err) {
			return {
				ok: false,
				error: `failed to extract archive: ${String(err)}`
			};
		}
		let rootDir = "";
		try {
			rootDir = await resolvePackedRootDir(extractDir, { rootMarkers: params.rootMarkers ? [...params.rootMarkers] : void 0 });
		} catch (err) {
			return {
				ok: false,
				error: String(err)
			};
		}
		return await params.onExtracted(rootDir);
	});
}
//#endregion
//#region src/infra/install-package-dir.ts
const INSTALL_BASE_CHANGED_ERROR_MESSAGE = "install base directory changed during install";
const INSTALL_BASE_CHANGED_ABORT_WARNING = "Install base directory changed during install; aborting staged publish.";
const INSTALL_BASE_CHANGED_BACKUP_WARNING = "Install base directory changed before backup cleanup; leaving backup in place.";
const STAGED_NPM_PROJECT_CONFIG_NAME = ".npmrc";
const STAGED_NPM_PROJECT_CONFIG_PREFIX = ".openclaw-install-hidden-npmrc-";
function isObjectRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
async function sanitizeManifestForNpmInstall(targetDir) {
	const manifestPath = path.join(targetDir, "package.json");
	const parsed = await tryReadJson(manifestPath);
	if (!isObjectRecord(parsed)) return;
	const manifest = parsed;
	const devDependencies = manifest.devDependencies;
	if (!isObjectRecord(devDependencies)) return;
	const filteredEntries = Object.entries(devDependencies).filter(([, rawSpec]) => {
		return !(typeof rawSpec === "string" ? rawSpec.trim() : "").startsWith("workspace:");
	});
	if (filteredEntries.length === Object.keys(devDependencies).length) return;
	if (filteredEntries.length === 0) delete manifest.devDependencies;
	else manifest.devDependencies = Object.fromEntries(filteredEntries);
	await writeJson(manifestPath, manifest, { trailingNewline: true });
}
async function hideProjectNpmConfigForInstall(targetDir) {
	const originalPath = path.join(targetDir, STAGED_NPM_PROJECT_CONFIG_NAME);
	let hiddenDir = "";
	try {
		hiddenDir = await fs.mkdtemp(path.join(targetDir, STAGED_NPM_PROJECT_CONFIG_PREFIX));
		const hiddenPath = path.join(hiddenDir, STAGED_NPM_PROJECT_CONFIG_NAME);
		await fs.rename(originalPath, hiddenPath);
		return {
			hiddenDir,
			originalPath,
			hiddenPath
		};
	} catch (error) {
		if (hiddenDir) await fs.rm(hiddenDir, {
			recursive: true,
			force: true
		}).catch(() => void 0);
		if (error.code === "ENOENT") return null;
		throw error;
	}
}
async function restoreProjectNpmConfigAfterInstall(hiddenConfig) {
	if (!hiddenConfig) return;
	await fs.rename(hiddenConfig.hiddenPath, hiddenConfig.originalPath);
	await fs.rm(hiddenConfig.hiddenDir, {
		recursive: true,
		force: true
	});
}
async function assertInstallBoundaryPaths(params) {
	for (const candidatePath of params.candidatePaths) await assertCanonicalPathWithinBase({
		baseDir: params.installBaseDir,
		candidatePath,
		boundaryLabel: "install directory"
	});
}
function isRelativePathInsideBase(relativePath) {
	return Boolean(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`);
}
function isInstallBaseChangedError(error) {
	return error instanceof Error && error.message === INSTALL_BASE_CHANGED_ERROR_MESSAGE;
}
async function assertInstallBaseStable(params) {
	if (!(await fs.stat(params.installBaseDir)).isDirectory()) throw new Error(INSTALL_BASE_CHANGED_ERROR_MESSAGE);
	if (await fs.realpath(params.installBaseDir) !== params.expectedRealPath) throw new Error(INSTALL_BASE_CHANGED_ERROR_MESSAGE);
}
async function cleanupInstallTempDir(dirPath) {
	if (!dirPath) return;
	await fs.rm(dirPath, {
		recursive: true,
		force: true
	}).catch(() => void 0);
}
async function resolveInstallPublishTarget(params) {
	const installBaseResolved = path.resolve(params.installBaseDir);
	const targetResolved = path.resolve(params.targetDir);
	const targetRelativePath = path.relative(installBaseResolved, targetResolved);
	if (!isRelativePathInsideBase(targetRelativePath)) throw new Error("invalid install target path");
	const installBaseRealPath = await fs.realpath(params.installBaseDir);
	return {
		installBaseRealPath,
		canonicalTargetDir: path.join(installBaseRealPath, targetRelativePath)
	};
}
async function installPackageDir(params) {
	params.logger?.info?.(`Installing to ${params.targetDir}…`);
	const installBaseDir = path.dirname(params.targetDir);
	let initialInstallBaseRealPath;
	try {
		await fs.mkdir(installBaseDir, { recursive: true });
		initialInstallBaseRealPath = await fs.realpath(installBaseDir);
		await assertInstallBoundaryPaths({
			installBaseDir,
			candidatePaths: [params.targetDir]
		});
	} catch (err) {
		return {
			ok: false,
			error: `${params.copyErrorPrefix}: ${String(err)}`
		};
	}
	let installBaseRealPath;
	let canonicalTargetDir;
	try {
		({installBaseRealPath, canonicalTargetDir} = await resolveInstallPublishTarget({
			installBaseDir,
			targetDir: params.targetDir
		}));
		if (installBaseRealPath !== initialInstallBaseRealPath) throw new Error(INSTALL_BASE_CHANGED_ERROR_MESSAGE);
	} catch (err) {
		if (isInstallBaseChangedError(err)) params.logger?.warn?.(INSTALL_BASE_CHANGED_ABORT_WARNING);
		return {
			ok: false,
			error: `${params.copyErrorPrefix}: ${String(err)}`
		};
	}
	let stageDir = null;
	let backupDir = null;
	const fail = async (error, cause) => {
		if (isInstallBaseChangedError(cause)) params.logger?.warn?.(INSTALL_BASE_CHANGED_ABORT_WARNING);
		else {
			await restoreBackup();
			if (stageDir) {
				await cleanupInstallTempDir(stageDir);
				stageDir = null;
			}
		}
		return {
			ok: false,
			error
		};
	};
	const failWithCode = async (params, cause) => {
		const failed = await fail(params.error, cause);
		return params.code ? {
			...failed,
			code: params.code
		} : failed;
	};
	const restoreBackup = async () => {
		if (!backupDir) return;
		await movePathWithCopyFallback({
			from: backupDir,
			sourceHardlinks: "reject",
			to: canonicalTargetDir
		}).catch(() => void 0);
		backupDir = null;
	};
	try {
		await assertInstallBoundaryPaths({
			installBaseDir: installBaseRealPath,
			candidatePaths: [canonicalTargetDir]
		});
		stageDir = await fs.mkdtemp(path.join(installBaseRealPath, ".openclaw-install-stage-"));
		await fs.cp(params.sourceDir, stageDir, {
			recursive: true,
			verbatimSymlinks: true
		});
	} catch (err) {
		return await fail(`${params.copyErrorPrefix}: ${String(err)}`, err);
	}
	try {
		await params.afterCopy?.(stageDir);
	} catch (err) {
		return await fail(`post-copy validation failed: ${String(err)}`, err);
	}
	if (params.hasDeps) try {
		await sanitizeManifestForNpmInstall(stageDir);
		const hiddenProjectNpmConfig = await hideProjectNpmConfigForInstall(stageDir);
		params.logger?.info?.(params.depsLogMessage);
		const npmRes = await (async () => {
			try {
				return await runCommandWithTimeout(["npm", ...createSafeNpmInstallArgs({
					omitDev: true,
					loglevel: "error"
				})], {
					timeoutMs: Math.max(params.timeoutMs, 3e5),
					cwd: stageDir,
					env: createSafeNpmInstallEnv(process.env, { npmConfigCwd: stageDir })
				});
			} finally {
				await restoreProjectNpmConfigAfterInstall(hiddenProjectNpmConfig);
			}
		})();
		if (npmRes.code !== 0) return await fail(`npm install failed: ${npmRes.stderr.trim() || npmRes.stdout.trim()}`);
	} catch (error) {
		return await fail(`npm install failed: ${String(error)}`, error);
	}
	if (params.afterInstall) try {
		const postInstallResult = await params.afterInstall(stageDir);
		if (!postInstallResult.ok) return await failWithCode(postInstallResult);
	} catch (err) {
		return await fail(`post-install validation failed: ${String(err)}`, err);
	}
	if (params.mode === "update" && await pathExists(canonicalTargetDir)) {
		const backupRoot = path.join(installBaseRealPath, ".openclaw-install-backups");
		backupDir = path.join(backupRoot, `${path.basename(canonicalTargetDir)}-${Date.now()}`);
		try {
			await fs.mkdir(backupRoot, { recursive: true });
			await assertInstallBoundaryPaths({
				installBaseDir: installBaseRealPath,
				candidatePaths: [backupDir]
			});
			await assertInstallBaseStable({
				installBaseDir,
				expectedRealPath: installBaseRealPath
			});
			await movePathWithCopyFallback({
				from: canonicalTargetDir,
				sourceHardlinks: "reject",
				to: backupDir
			});
		} catch (err) {
			return await fail(`${params.copyErrorPrefix}: ${String(err)}`, err);
		}
	}
	try {
		await assertInstallBaseStable({
			installBaseDir,
			expectedRealPath: installBaseRealPath
		});
		await movePathWithCopyFallback({
			from: stageDir,
			sourceHardlinks: "reject",
			to: canonicalTargetDir
		});
		stageDir = null;
	} catch (err) {
		return await fail(`${params.copyErrorPrefix}: ${String(err)}`, err);
	}
	if (backupDir) try {
		await assertInstallBaseStable({
			installBaseDir,
			expectedRealPath: installBaseRealPath
		});
	} catch (err) {
		if (isInstallBaseChangedError(err)) params.logger?.warn?.(INSTALL_BASE_CHANGED_BACKUP_WARNING);
		backupDir = null;
	}
	if (backupDir) await fs.rm(backupDir, {
		recursive: true,
		force: true
	}).catch(() => void 0);
	if (stageDir) await cleanupInstallTempDir(stageDir);
	return { ok: true };
}
async function installPackageDirWithManifestDeps(params) {
	return installPackageDir({
		...params,
		hasDeps: Object.keys(params.manifestDependencies ?? {}).length > 0
	});
}
//#endregion
export { withExtractedArchiveRoot as i, installPackageDirWithManifestDeps as n, resolveExistingInstallPath as r, installPackageDir as t };
