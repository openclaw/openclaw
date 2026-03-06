import { y as resolveUserPath } from "./utils-BgHhhQlR.js";
import { t as runCommandWithTimeout } from "./exec-DOBmQ145.js";
import { c as fileExists, d as resolvePackedRootDir, n as resolveSafeInstallDir, s as extractArchive, t as assertCanonicalPathWithinBase, u as resolveArchiveKind } from "./install-safe-path-CY8HvIMX.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

//#region src/infra/install-source-utils.ts
function buildNpmResolutionFields(resolution) {
	return {
		resolvedName: resolution?.name,
		resolvedVersion: resolution?.version,
		resolvedSpec: resolution?.resolvedSpec,
		integrity: resolution?.integrity,
		shasum: resolution?.shasum,
		resolvedAt: resolution?.resolvedAt
	};
}
async function withTempDir(prefix, fn) {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		return await fn(tmpDir);
	} finally {
		await fs.rm(tmpDir, {
			recursive: true,
			force: true
		}).catch(() => void 0);
	}
}
async function resolveArchiveSourcePath(archivePath) {
	const resolved = resolveUserPath(archivePath);
	if (!await fileExists(resolved)) return {
		ok: false,
		error: `archive not found: ${resolved}`
	};
	if (!resolveArchiveKind(resolved)) return {
		ok: false,
		error: `unsupported archive: ${resolved}`
	};
	return {
		ok: true,
		path: resolved
	};
}
function toOptionalString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function parseResolvedSpecFromId(id) {
	const at = id.lastIndexOf("@");
	if (at <= 0 || at >= id.length - 1) return;
	const name = id.slice(0, at).trim();
	const version = id.slice(at + 1).trim();
	if (!name || !version) return;
	return `${name}@${version}`;
}
function normalizeNpmPackEntry(entry) {
	if (!entry || typeof entry !== "object") return null;
	const rec = entry;
	const name = toOptionalString(rec.name);
	const version = toOptionalString(rec.version);
	const id = toOptionalString(rec.id);
	const resolvedSpec = (name && version ? `${name}@${version}` : void 0) ?? (id ? parseResolvedSpecFromId(id) : void 0);
	return {
		filename: toOptionalString(rec.filename),
		metadata: {
			name,
			version,
			resolvedSpec,
			integrity: toOptionalString(rec.integrity),
			shasum: toOptionalString(rec.shasum)
		}
	};
}
function parseNpmPackJsonOutput(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const candidates = [trimmed];
	const arrayStart = trimmed.indexOf("[");
	if (arrayStart > 0) candidates.push(trimmed.slice(arrayStart));
	for (const candidate of candidates) {
		let parsed;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		const entries = Array.isArray(parsed) ? parsed : [parsed];
		let fallback = null;
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const normalized = normalizeNpmPackEntry(entries[i]);
			if (!normalized) continue;
			if (!fallback) fallback = normalized;
			if (normalized.filename) return normalized;
		}
		if (fallback) return fallback;
	}
	return null;
}
function parsePackedArchiveFromStdout(stdout) {
	const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const match = lines[index]?.match(/([^\s"']+\.tgz)/);
		if (match?.[1]) return match[1];
	}
}
async function findPackedArchiveInDir(cwd) {
	const archives = (await fs.readdir(cwd, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"));
	if (archives.length === 0) return;
	if (archives.length === 1) return archives[0]?.name;
	const sortedByMtime = await Promise.all(archives.map(async (entry) => ({
		name: entry.name,
		mtimeMs: (await fs.stat(path.join(cwd, entry.name))).mtimeMs
	})));
	sortedByMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return sortedByMtime[0]?.name;
}
async function packNpmSpecToArchive(params) {
	const res = await runCommandWithTimeout([
		"npm",
		"pack",
		params.spec,
		"--ignore-scripts",
		"--json"
	], {
		timeoutMs: Math.max(params.timeoutMs, 3e5),
		cwd: params.cwd,
		env: {
			COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
			NPM_CONFIG_IGNORE_SCRIPTS: "true"
		}
	});
	if (res.code !== 0) {
		const raw = res.stderr.trim() || res.stdout.trim();
		if (/E404|is not in this registry/i.test(raw)) return {
			ok: false,
			error: `Package not found on npm: ${params.spec}. See https://docs.openclaw.ai/tools/plugin for installable plugins.`
		};
		return {
			ok: false,
			error: `npm pack failed: ${raw}`
		};
	}
	const parsedJson = parseNpmPackJsonOutput(res.stdout || "");
	let packed = parsedJson?.filename ?? parsePackedArchiveFromStdout(res.stdout || "");
	if (!packed) packed = await findPackedArchiveInDir(params.cwd);
	if (!packed) return {
		ok: false,
		error: "npm pack produced no archive"
	};
	let archivePath = path.isAbsolute(packed) ? packed : path.join(params.cwd, packed);
	if (!await fileExists(archivePath)) {
		const fallbackPacked = await findPackedArchiveInDir(params.cwd);
		if (!fallbackPacked) return {
			ok: false,
			error: "npm pack produced no archive"
		};
		archivePath = path.join(params.cwd, fallbackPacked);
	}
	return {
		ok: true,
		archivePath,
		metadata: parsedJson?.metadata ?? {}
	};
}

//#endregion
//#region src/infra/install-flow.ts
async function resolveExistingInstallPath(inputPath) {
	const resolvedPath = resolveUserPath(inputPath);
	if (!await fileExists(resolvedPath)) return {
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
			rootDir = await resolvePackedRootDir(extractDir);
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
//#region src/infra/install-package-dir.ts
function isObjectRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
async function sanitizeManifestForNpmInstall(targetDir) {
	const manifestPath = path.join(targetDir, "package.json");
	let manifestRaw = "";
	try {
		manifestRaw = await fs.readFile(manifestPath, "utf-8");
	} catch {
		return;
	}
	let manifest;
	try {
		const parsed = JSON.parse(manifestRaw);
		if (!isObjectRecord(parsed)) return;
		manifest = parsed;
	} catch {
		return;
	}
	const devDependencies = manifest.devDependencies;
	if (!isObjectRecord(devDependencies)) return;
	const filteredEntries = Object.entries(devDependencies).filter(([, rawSpec]) => {
		return !(typeof rawSpec === "string" ? rawSpec.trim() : "").startsWith("workspace:");
	});
	if (filteredEntries.length === Object.keys(devDependencies).length) return;
	if (filteredEntries.length === 0) delete manifest.devDependencies;
	else manifest.devDependencies = Object.fromEntries(filteredEntries);
	await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}
async function assertInstallBoundaryPaths(params) {
	for (const candidatePath of params.candidatePaths) await assertCanonicalPathWithinBase({
		baseDir: params.installBaseDir,
		candidatePath,
		boundaryLabel: "install directory"
	});
}
async function installPackageDir(params) {
	params.logger?.info?.(`Installing to ${params.targetDir}…`);
	const installBaseDir = path.dirname(params.targetDir);
	await fs.mkdir(installBaseDir, { recursive: true });
	await assertInstallBoundaryPaths({
		installBaseDir,
		candidatePaths: [params.targetDir]
	});
	let backupDir = null;
	if (params.mode === "update" && await fileExists(params.targetDir)) {
		const backupRoot = path.join(path.dirname(params.targetDir), ".openclaw-install-backups");
		backupDir = path.join(backupRoot, `${path.basename(params.targetDir)}-${Date.now()}`);
		await fs.mkdir(backupRoot, { recursive: true });
		await assertInstallBoundaryPaths({
			installBaseDir,
			candidatePaths: [backupDir]
		});
		await fs.rename(params.targetDir, backupDir);
	}
	const rollback = async () => {
		if (!backupDir) return;
		await assertInstallBoundaryPaths({
			installBaseDir,
			candidatePaths: [params.targetDir, backupDir]
		});
		await fs.rm(params.targetDir, {
			recursive: true,
			force: true
		}).catch(() => void 0);
		await fs.rename(backupDir, params.targetDir).catch(() => void 0);
	};
	try {
		await assertInstallBoundaryPaths({
			installBaseDir,
			candidatePaths: [params.targetDir]
		});
		await fs.cp(params.sourceDir, params.targetDir, { recursive: true });
	} catch (err) {
		await rollback();
		return {
			ok: false,
			error: `${params.copyErrorPrefix}: ${String(err)}`
		};
	}
	try {
		await params.afterCopy?.();
	} catch (err) {
		await rollback();
		return {
			ok: false,
			error: `post-copy validation failed: ${String(err)}`
		};
	}
	if (params.hasDeps) {
		await sanitizeManifestForNpmInstall(params.targetDir);
		params.logger?.info?.(params.depsLogMessage);
		const npmRes = await runCommandWithTimeout([
			"npm",
			"install",
			"--omit=dev",
			"--omit=peer",
			"--silent",
			"--ignore-scripts"
		], {
			timeoutMs: Math.max(params.timeoutMs, 3e5),
			cwd: params.targetDir
		});
		if (npmRes.code !== 0) {
			await rollback();
			return {
				ok: false,
				error: `npm install failed: ${npmRes.stderr.trim() || npmRes.stdout.trim()}`
			};
		}
	}
	if (backupDir) await fs.rm(backupDir, {
		recursive: true,
		force: true
	}).catch(() => void 0);
	return { ok: true };
}
async function installPackageDirWithManifestDeps(params) {
	return installPackageDir({
		...params,
		hasDeps: Object.keys(params.manifestDependencies ?? {}).length > 0
	});
}

//#endregion
//#region src/infra/install-target.ts
async function resolveCanonicalInstallTarget(params) {
	await fs.mkdir(params.baseDir, { recursive: true });
	const targetDirResult = resolveSafeInstallDir({
		baseDir: params.baseDir,
		id: params.id,
		invalidNameMessage: params.invalidNameMessage
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
			error: err instanceof Error ? err.message : String(err)
		};
	}
	return {
		ok: true,
		targetDir: targetDirResult.path
	};
}
async function ensureInstallTargetAvailable(params) {
	if (params.mode === "install" && await fileExists(params.targetDir)) return {
		ok: false,
		error: params.alreadyExistsError
	};
	return { ok: true };
}

//#endregion
//#region src/infra/npm-integrity.ts
async function resolveNpmIntegrityDrift(params) {
	if (!params.expectedIntegrity || !params.resolution.integrity) return { proceed: true };
	if (params.expectedIntegrity === params.resolution.integrity) return { proceed: true };
	const integrityDrift = {
		expectedIntegrity: params.expectedIntegrity,
		actualIntegrity: params.resolution.integrity
	};
	const payload = params.createPayload({
		spec: params.spec,
		expectedIntegrity: integrityDrift.expectedIntegrity,
		actualIntegrity: integrityDrift.actualIntegrity,
		resolution: params.resolution
	});
	let proceed = true;
	if (params.onIntegrityDrift) proceed = await params.onIntegrityDrift(payload);
	else params.warn?.(payload);
	return {
		integrityDrift,
		proceed,
		payload
	};
}
async function resolveNpmIntegrityDriftWithDefaultMessage(params) {
	const driftResult = await resolveNpmIntegrityDrift({
		spec: params.spec,
		expectedIntegrity: params.expectedIntegrity,
		resolution: params.resolution,
		createPayload: (drift) => ({ ...drift }),
		onIntegrityDrift: params.onIntegrityDrift,
		warn: (driftPayload) => {
			params.warn?.(`Integrity drift detected for ${driftPayload.resolution.resolvedSpec ?? driftPayload.spec}: expected ${driftPayload.expectedIntegrity}, got ${driftPayload.actualIntegrity}`);
		}
	});
	if (!driftResult.proceed && driftResult.payload) return {
		integrityDrift: driftResult.integrityDrift,
		error: `aborted: npm package integrity drift detected for ${driftResult.payload.resolution.resolvedSpec ?? driftResult.payload.spec}`
	};
	return { integrityDrift: driftResult.integrityDrift };
}

//#endregion
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
export { installPackageDir as a, resolveTimedInstallModeOptions as c, buildNpmResolutionFields as d, resolveArchiveSourcePath as f, resolveCanonicalInstallTarget as i, resolveExistingInstallPath as l, installFromNpmSpecArchiveWithInstaller as n, installPackageDirWithManifestDeps as o, ensureInstallTargetAvailable as r, resolveInstallModeOptions as s, finalizeNpmSpecArchiveInstall as t, withExtractedArchiveRoot as u };