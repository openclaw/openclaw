import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { i as resolveSafeInstallDir, r as assertCanonicalPathWithinBase } from "./install-safe-path-DEiFZ_bF.js";
import { a as isPrereleaseResolutionAllowed, n as formatPrereleaseResolutionError, s as parseRegistryNpmSpec } from "./npm-registry-spec-BwaWslDm.js";
import { r as packNpmSpecToArchive, s as withTempDir } from "./install-source-utils-BA9AHTyU.js";
import { t as resolveNpmIntegrityDriftWithDefaultMessage } from "./npm-integrity-DsZIWZKw.js";
import fs from "node:fs/promises";
//#region src/infra/npm-pack-install.ts
async function installFromNpmSpecArchiveWithInstaller(params) {
	return await installFromNpmSpecArchive({
		tempDirPrefix: params.tempDirPrefix,
		spec: params.spec,
		timeoutMs: params.timeoutMs,
		expectedIntegrity: params.expectedIntegrity,
		onIntegrityDrift: params.onIntegrityDrift,
		warn: params.warn,
		installFromArchive: async ({ archivePath }) => await params.installFromArchive({
			archivePath,
			...params.archiveInstallParams
		})
	});
}
function isSuccessfulInstallResult(result) {
	return result.ok;
}
function finalizeNpmSpecArchiveInstall(flowResult) {
	if (!flowResult.ok) return flowResult;
	const installResult = flowResult.installResult;
	if (!isSuccessfulInstallResult(installResult)) return installResult;
	return {
		...installResult,
		npmResolution: flowResult.npmResolution,
		...flowResult.integrityDrift ? { integrityDrift: flowResult.integrityDrift } : {}
	};
}
async function installFromNpmSpecArchive(params) {
	return await withTempDir(params.tempDirPrefix, async (tmpDir) => {
		const parsedSpec = parseRegistryNpmSpec(params.spec);
		if (!parsedSpec) return {
			ok: false,
			error: "unsupported npm spec"
		};
		const packedResult = await packNpmSpecToArchive({
			spec: params.spec,
			timeoutMs: params.timeoutMs,
			cwd: tmpDir
		});
		if (!packedResult.ok) return packedResult;
		const npmResolution = {
			...packedResult.metadata,
			resolvedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		if (npmResolution.version && !isPrereleaseResolutionAllowed({
			spec: parsedSpec,
			resolvedVersion: npmResolution.version
		})) return {
			ok: false,
			error: formatPrereleaseResolutionError({
				spec: parsedSpec,
				resolvedVersion: npmResolution.version
			})
		};
		const driftResult = await resolveNpmIntegrityDriftWithDefaultMessage({
			spec: params.spec,
			expectedIntegrity: params.expectedIntegrity,
			resolution: npmResolution,
			onIntegrityDrift: params.onIntegrityDrift,
			warn: params.warn
		});
		if (driftResult.error) return {
			ok: false,
			error: driftResult.error
		};
		return {
			ok: true,
			installResult: await params.installFromArchive({ archivePath: packedResult.archivePath }),
			npmResolution,
			integrityDrift: driftResult.integrityDrift
		};
	});
}
//#endregion
//#region src/infra/install-mode-options.ts
function resolveInstallModeOptions(params, defaultLogger) {
	return {
		logger: params.logger ?? defaultLogger,
		mode: params.mode ?? "install",
		dryRun: params.dryRun ?? false
	};
}
function resolveTimedInstallModeOptions(params, defaultLogger, defaultTimeoutMs = 12e4) {
	return {
		...resolveInstallModeOptions(params, defaultLogger),
		timeoutMs: params.timeoutMs ?? defaultTimeoutMs
	};
}
//#endregion
//#region src/infra/install-target.ts
async function resolveCanonicalInstallTarget(params) {
	await fs.mkdir(params.baseDir, { recursive: true });
	const targetDirResult = resolveSafeInstallDir({
		baseDir: params.baseDir,
		id: params.id,
		invalidNameMessage: params.invalidNameMessage,
		nameEncoder: params.nameEncoder
	});
	if (!targetDirResult.ok) return {
		ok: false,
		error: targetDirResult.error
	};
	try {
		await assertCanonicalPathWithinBase({
			baseDir: params.baseDir,
			candidatePath: targetDirResult.path,
			boundaryLabel: params.boundaryLabel
		});
	} catch (err) {
		return {
			ok: false,
			error: formatErrorMessage(err)
		};
	}
	return {
		ok: true,
		targetDir: targetDirResult.path
	};
}
async function ensureInstallTargetAvailable(params) {
	if (params.mode === "install" && await pathExists(params.targetDir)) return {
		ok: false,
		error: params.alreadyExistsError
	};
	return { ok: true };
}
//#endregion
export { finalizeNpmSpecArchiveInstall as a, resolveTimedInstallModeOptions as i, resolveCanonicalInstallTarget as n, installFromNpmSpecArchiveWithInstaller as o, resolveInstallModeOptions as r, ensureInstallTargetAvailable as t };
