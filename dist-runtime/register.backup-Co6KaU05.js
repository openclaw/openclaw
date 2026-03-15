import "./redact-CPjO5IzK.js";
import "./errors-CHvVoeNX.js";
import "./unhandled-rejections-BUxLQs1F.js";
import "./globals-I5DlBD2D.js";
import { _ as resolveStateDir, h as resolveOAuthDir, o as resolveConfigPath } from "./paths-1qR_mW4i.js";
import { r as theme } from "./theme-UkqnBJaj.js";
import { l as defaultRuntime } from "./subsystem-EnljYYs1.js";
import "./ansi-YpD2Ho3J.js";
import "./boolean-B938tROv.js";
import "./env-Bdj-riuG.js";
import "./warning-filter-xAwZkSAQ.js";
import { S as shortenHomePath, _ as resolveHomeDir, h as pathExists, y as resolveUserPath } from "./utils-Do8MzKyM.js";
import { t as formatDocsLink } from "./links-Cx-Xmp-Y.js";
import { Wb as readConfigFileSnapshot, ey as formatSessionArchiveTimestamp, in as formatHelpExamples } from "./auth-profiles-DqxBs6Au.js";
import "./plugins-allowlist-CTOQWcBK.js";
import "./registry-DrRO3PZ7.js";
import "./fetch-DM2X1MUS.js";
import "./config-state-Dtu4rsXl.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-CA0yK887.js";
import "./method-scopes-DDb5C1xl.js";
import "./plugins-CygWjihb.js";
import "./brew-BBTHZkpM.js";
import "./agent-scope-tkfLX5MZ.js";
import "./logger-BwHrL168.js";
import "./exec-Fh3CK0qE.js";
import "./env-overrides-ArVaLl04.js";
import "./safe-text-ByhWP-8W.js";
import { o as resolveRuntimeServiceVersion } from "./version-Dubp0iGu.js";
import "./config-VO8zzMSR.js";
import "./workspace-dirs-D1oDbsnN.js";
import "./search-manager-DIDe1qlM.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-CcKf_qr0.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-eb8njEg8.js";
import "./commands-BRfqrztE.js";
import "./ports-DeHp-MTZ.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-Cu8erp19.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-CfAp_q6e.js";
import "./paths-YN5WLIkL.js";
import "./session-cost-usage-DeAwWk6A.js";
import "./fetch-CzYOE42F.js";
import "./identity-file-Dh-pAEVE.js";
import "./dm-policy-shared-qfNerugD.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-BI0f8wZY.js";
import "./prompt-style-DqOsOwLH.js";
import "./secret-file-Bd-d3WTG.js";
import "./token-C5m9DX_R.js";
import "./restart-stale-pids-DzpGvXwg.js";
import "./accounts-B1y-wv7m.js";
import "./audit-CmcUcZU1.js";
import { n as runCommandWithRuntime } from "./cli-utils-DRykF2zj.js";
import { n as isPathWithin, t as buildCleanupPlan } from "./cleanup-utils-g6CZWoyN.js";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import fs$1 from "node:fs/promises";
import * as tar from "tar";
//#region src/commands/backup-verify.ts
const WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stripTrailingSlashes(value) {
	return value.replace(/\/+$/u, "");
}
function normalizeArchivePath(entryPath, label) {
	const trimmed = stripTrailingSlashes(entryPath.trim());
	if (!trimmed) {throw new Error(`${label} is empty.`);}
	if (trimmed.startsWith("/") || WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE.test(trimmed)) {throw new Error(`${label} must be relative: ${entryPath}`);}
	if (trimmed.includes("\\")) {throw new Error(`${label} must use forward slashes: ${entryPath}`);}
	if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) {throw new Error(`${label} contains path traversal segments: ${entryPath}`);}
	const normalized = stripTrailingSlashes(path.posix.normalize(trimmed));
	if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {throw new Error(`${label} resolves outside the archive root: ${entryPath}`);}
	return normalized;
}
function normalizeArchiveRoot(rootName) {
	const normalized = normalizeArchivePath(rootName, "Backup manifest archiveRoot");
	if (normalized.includes("/")) {throw new Error(`Backup manifest archiveRoot must be a single path segment: ${rootName}`);}
	return normalized;
}
function isArchivePathWithin(child, parent) {
	const relative = path.posix.relative(parent, child);
	return relative === "" || !relative.startsWith("../") && relative !== "..";
}
function parseManifest(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Backup manifest is not valid JSON: ${String(err)}`, { cause: err });
	}
	if (!isRecord(parsed)) {throw new Error("Backup manifest must be an object.");}
	if (parsed.schemaVersion !== 1) {throw new Error(`Unsupported backup manifest schemaVersion: ${String(parsed.schemaVersion)}`);}
	if (typeof parsed.archiveRoot !== "string" || !parsed.archiveRoot.trim()) {throw new Error("Backup manifest is missing archiveRoot.");}
	if (typeof parsed.createdAt !== "string" || !parsed.createdAt.trim()) {throw new Error("Backup manifest is missing createdAt.");}
	if (!Array.isArray(parsed.assets)) {throw new Error("Backup manifest is missing assets.");}
	const assets = [];
	for (const asset of parsed.assets) {
		if (!isRecord(asset)) {throw new Error("Backup manifest contains a non-object asset.");}
		if (typeof asset.kind !== "string" || !asset.kind.trim()) {throw new Error("Backup manifest asset is missing kind.");}
		if (typeof asset.sourcePath !== "string" || !asset.sourcePath.trim()) {throw new Error("Backup manifest asset is missing sourcePath.");}
		if (typeof asset.archivePath !== "string" || !asset.archivePath.trim()) {throw new Error("Backup manifest asset is missing archivePath.");}
		assets.push({
			kind: asset.kind,
			sourcePath: asset.sourcePath,
			archivePath: asset.archivePath
		});
	}
	return {
		schemaVersion: 1,
		archiveRoot: parsed.archiveRoot,
		createdAt: parsed.createdAt,
		runtimeVersion: typeof parsed.runtimeVersion === "string" && parsed.runtimeVersion.trim() ? parsed.runtimeVersion : "unknown",
		platform: typeof parsed.platform === "string" ? parsed.platform : "unknown",
		nodeVersion: typeof parsed.nodeVersion === "string" ? parsed.nodeVersion : "unknown",
		options: isRecord(parsed.options) ? { includeWorkspace: parsed.options.includeWorkspace } : void 0,
		paths: isRecord(parsed.paths) ? {
			stateDir: typeof parsed.paths.stateDir === "string" ? parsed.paths.stateDir : void 0,
			configPath: typeof parsed.paths.configPath === "string" ? parsed.paths.configPath : void 0,
			oauthDir: typeof parsed.paths.oauthDir === "string" ? parsed.paths.oauthDir : void 0,
			workspaceDirs: Array.isArray(parsed.paths.workspaceDirs) ? parsed.paths.workspaceDirs.filter((entry) => typeof entry === "string") : void 0
		} : void 0,
		assets,
		skipped: Array.isArray(parsed.skipped) ? parsed.skipped : void 0
	};
}
async function listArchiveEntries(archivePath) {
	const entries = [];
	await tar.t({
		file: archivePath,
		gzip: true,
		onentry: (entry) => {
			entries.push(entry.path);
		}
	});
	return entries;
}
async function extractManifest(params) {
	let manifestContentPromise;
	await tar.t({
		file: params.archivePath,
		gzip: true,
		onentry: (entry) => {
			if (entry.path !== params.manifestEntryPath) {
				entry.resume();
				return;
			}
			manifestContentPromise = new Promise((resolve, reject) => {
				const chunks = [];
				entry.on("data", (chunk) => {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				entry.on("error", reject);
				entry.on("end", () => {
					resolve(Buffer.concat(chunks).toString("utf8"));
				});
			});
		}
	});
	if (!manifestContentPromise) {throw new Error(`Archive is missing manifest entry: ${params.manifestEntryPath}`);}
	return await manifestContentPromise;
}
function isRootManifestEntry(entryPath) {
	const parts = entryPath.split("/");
	return parts.length === 2 && parts[0] !== "" && parts[1] === "manifest.json";
}
function verifyManifestAgainstEntries(manifest, entries) {
	const archiveRoot = normalizeArchiveRoot(manifest.archiveRoot);
	const manifestEntryPath = path.posix.join(archiveRoot, "manifest.json");
	const normalizedEntries = [...entries];
	const normalizedEntrySet = new Set(normalizedEntries);
	if (!normalizedEntrySet.has(manifestEntryPath)) {throw new Error(`Archive is missing manifest entry: ${manifestEntryPath}`);}
	for (const entry of normalizedEntries) {if (!isArchivePathWithin(entry, archiveRoot)) throw new Error(`Archive entry is outside the declared archive root: ${entry}`);}
	const payloadRoot = path.posix.join(archiveRoot, "payload");
	for (const asset of manifest.assets) {
		const assetArchivePath = normalizeArchivePath(asset.archivePath, "Backup manifest asset path");
		if (!isArchivePathWithin(assetArchivePath, payloadRoot)) {throw new Error(`Manifest asset path is outside payload root: ${asset.archivePath}`);}
		const exact = normalizedEntrySet.has(assetArchivePath);
		const nested = normalizedEntries.some((entry) => entry !== assetArchivePath && isArchivePathWithin(entry, assetArchivePath));
		if (!exact && !nested) {throw new Error(`Archive is missing payload for manifest asset: ${assetArchivePath}`);}
	}
}
function formatResult(result) {
	return [
		`Backup archive OK: ${result.archivePath}`,
		`Archive root: ${result.archiveRoot}`,
		`Created at: ${result.createdAt}`,
		`Runtime version: ${result.runtimeVersion}`,
		`Assets verified: ${result.assetCount}`,
		`Archive entries scanned: ${result.entryCount}`
	].join("\n");
}
function findDuplicateNormalizedEntryPath(entries) {
	const seen = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		if (seen.has(entry.normalized)) {return entry.normalized;}
		seen.add(entry.normalized);
	}
}
async function backupVerifyCommand(runtime, opts) {
	const archivePath = resolveUserPath(opts.archive);
	const rawEntries = await listArchiveEntries(archivePath);
	if (rawEntries.length === 0) {throw new Error("Backup archive is empty.");}
	const entries = rawEntries.map((entry) => ({
		raw: entry,
		normalized: normalizeArchivePath(entry, "Archive entry")
	}));
	const normalizedEntrySet = new Set(entries.map((entry) => entry.normalized));
	const manifestMatches = entries.filter((entry) => isRootManifestEntry(entry.normalized));
	if (manifestMatches.length !== 1) {throw new Error(`Expected exactly one backup manifest entry, found ${manifestMatches.length}.`);}
	const duplicateEntryPath = findDuplicateNormalizedEntryPath(entries);
	if (duplicateEntryPath) {throw new Error(`Archive contains duplicate entry path: ${duplicateEntryPath}`);}
	const manifestEntryPath = manifestMatches[0]?.raw;
	if (!manifestEntryPath) {throw new Error("Backup archive manifest entry could not be resolved.");}
	const manifest = parseManifest(await extractManifest({
		archivePath,
		manifestEntryPath
	}));
	verifyManifestAgainstEntries(manifest, normalizedEntrySet);
	const result = {
		ok: true,
		archivePath,
		archiveRoot: manifest.archiveRoot,
		createdAt: manifest.createdAt,
		runtimeVersion: manifest.runtimeVersion,
		assetCount: manifest.assets.length,
		entryCount: rawEntries.length
	};
	runtime.log(opts.json ? JSON.stringify(result, null, 2) : formatResult(result));
	return result;
}
//#endregion
//#region src/commands/backup-shared.ts
function backupAssetPriority(kind) {
	switch (kind) {
		case "state": return 0;
		case "config": return 1;
		case "credentials": return 2;
		case "workspace": return 3;
	}
}
function buildBackupArchiveRoot(nowMs = Date.now()) {
	return `${formatSessionArchiveTimestamp(nowMs)}-openclaw-backup`;
}
function buildBackupArchiveBasename(nowMs = Date.now()) {
	return `${buildBackupArchiveRoot(nowMs)}.tar.gz`;
}
function encodeAbsolutePathForBackupArchive(sourcePath) {
	const normalized = sourcePath.replaceAll("\\", "/");
	const windowsMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
	if (windowsMatch) {
		const drive = windowsMatch[1]?.toUpperCase() ?? "UNKNOWN";
		const rest = windowsMatch[2] ?? "";
		return path.posix.join("windows", drive, rest);
	}
	if (normalized.startsWith("/")) {return path.posix.join("posix", normalized.slice(1));}
	return path.posix.join("relative", normalized);
}
function buildBackupArchivePath(archiveRoot, sourcePath) {
	return path.posix.join(archiveRoot, "payload", encodeAbsolutePathForBackupArchive(sourcePath));
}
function compareCandidates(left, right) {
	const depthDelta = left.canonicalPath.length - right.canonicalPath.length;
	if (depthDelta !== 0) {return depthDelta;}
	const priorityDelta = backupAssetPriority(left.kind) - backupAssetPriority(right.kind);
	if (priorityDelta !== 0) {return priorityDelta;}
	return left.canonicalPath.localeCompare(right.canonicalPath);
}
async function canonicalizeExistingPath(targetPath) {
	try {
		return await fs$1.realpath(targetPath);
	} catch {
		return path.resolve(targetPath);
	}
}
async function resolveBackupPlanFromDisk(params = {}) {
	const includeWorkspace = params.includeWorkspace ?? true;
	const onlyConfig = params.onlyConfig ?? false;
	const stateDir = resolveStateDir();
	const configPath = resolveConfigPath();
	const oauthDir = resolveOAuthDir();
	const archiveRoot = buildBackupArchiveRoot(params.nowMs);
	if (onlyConfig) {
		const resolvedConfigPath = path.resolve(configPath);
		if (!await pathExists(resolvedConfigPath)) {return {
			stateDir,
			configPath,
			oauthDir,
			workspaceDirs: [],
			included: [],
			skipped: [{
				kind: "config",
				sourcePath: resolvedConfigPath,
				displayPath: shortenHomePath(resolvedConfigPath),
				reason: "missing"
			}]
		};}
		const canonicalConfigPath = await canonicalizeExistingPath(resolvedConfigPath);
		return {
			stateDir,
			configPath,
			oauthDir,
			workspaceDirs: [],
			included: [{
				kind: "config",
				sourcePath: canonicalConfigPath,
				displayPath: shortenHomePath(canonicalConfigPath),
				archivePath: buildBackupArchivePath(archiveRoot, canonicalConfigPath)
			}],
			skipped: []
		};
	}
	const configSnapshot = await readConfigFileSnapshot();
	if (includeWorkspace && configSnapshot.exists && !configSnapshot.valid) {throw new Error(`Config invalid at ${shortenHomePath(configSnapshot.path)}. OpenClaw cannot reliably discover custom workspaces for backup. Fix the config or rerun with --no-include-workspace for a partial backup.`);}
	const cleanupPlan = buildCleanupPlan({
		cfg: configSnapshot.config,
		stateDir,
		configPath,
		oauthDir
	});
	const workspaceDirs = includeWorkspace ? cleanupPlan.workspaceDirs : [];
	const rawCandidates = [
		{
			kind: "state",
			sourcePath: path.resolve(stateDir)
		},
		...cleanupPlan.configInsideState ? [] : [{
			kind: "config",
			sourcePath: path.resolve(configPath)
		}],
		...cleanupPlan.oauthInsideState ? [] : [{
			kind: "credentials",
			sourcePath: path.resolve(oauthDir)
		}],
		...includeWorkspace ? workspaceDirs.map((workspaceDir) => ({
			kind: "workspace",
			sourcePath: path.resolve(workspaceDir)
		})) : []
	];
	const candidates = await Promise.all(rawCandidates.map(async (candidate) => {
		const exists = await pathExists(candidate.sourcePath);
		return {
			...candidate,
			exists,
			canonicalPath: exists ? await canonicalizeExistingPath(candidate.sourcePath) : path.resolve(candidate.sourcePath)
		};
	}));
	const uniqueCandidates = [];
	const seenCanonicalPaths = /* @__PURE__ */ new Set();
	for (const candidate of [...candidates].toSorted(compareCandidates)) {
		if (seenCanonicalPaths.has(candidate.canonicalPath)) {continue;}
		seenCanonicalPaths.add(candidate.canonicalPath);
		uniqueCandidates.push(candidate);
	}
	const included = [];
	const skipped = [];
	for (const candidate of uniqueCandidates) {
		if (!candidate.exists) {
			skipped.push({
				kind: candidate.kind,
				sourcePath: candidate.sourcePath,
				displayPath: shortenHomePath(candidate.sourcePath),
				reason: "missing"
			});
			continue;
		}
		const coveredBy = included.find((asset) => isPathWithin(candidate.canonicalPath, asset.sourcePath));
		if (coveredBy) {
			skipped.push({
				kind: candidate.kind,
				sourcePath: candidate.canonicalPath,
				displayPath: shortenHomePath(candidate.canonicalPath),
				reason: "covered",
				coveredBy: coveredBy.displayPath
			});
			continue;
		}
		included.push({
			kind: candidate.kind,
			sourcePath: candidate.canonicalPath,
			displayPath: shortenHomePath(candidate.canonicalPath),
			archivePath: buildBackupArchivePath(archiveRoot, candidate.canonicalPath)
		});
	}
	return {
		stateDir,
		configPath,
		oauthDir,
		workspaceDirs: workspaceDirs.map((entry) => path.resolve(entry)),
		included,
		skipped
	};
}
//#endregion
//#region src/infra/backup-create.ts
async function resolveOutputPath(params) {
	const basename = buildBackupArchiveBasename(params.nowMs);
	const rawOutput = params.output?.trim();
	if (!rawOutput) {
		const cwd = path.resolve(process.cwd());
		const canonicalCwd = await fs$1.realpath(cwd).catch(() => cwd);
		const defaultDir = params.includedAssets.some((asset) => isPathWithin(canonicalCwd, asset.sourcePath)) ? resolveHomeDir() ?? path.dirname(params.stateDir) : cwd;
		return path.resolve(defaultDir, basename);
	}
	const resolved = resolveUserPath(rawOutput);
	if (rawOutput.endsWith("/") || rawOutput.endsWith("\\")) {return path.join(resolved, basename);}
	try {
		if ((await fs$1.stat(resolved)).isDirectory()) {return path.join(resolved, basename);}
	} catch {}
	return resolved;
}
async function assertOutputPathReady(outputPath) {
	try {
		await fs$1.access(outputPath);
		throw new Error(`Refusing to overwrite existing backup archive: ${outputPath}`);
	} catch (err) {
		if (err?.code === "ENOENT") {return;}
		throw err;
	}
}
function buildTempArchivePath(outputPath) {
	return `${outputPath}.${randomUUID()}.tmp`;
}
function isLinkUnsupportedError(code) {
	return code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EPERM";
}
async function publishTempArchive(params) {
	try {
		await fs$1.link(params.tempArchivePath, params.outputPath);
	} catch (err) {
		const code = err?.code;
		if (code === "EEXIST") {throw new Error(`Refusing to overwrite existing backup archive: ${params.outputPath}`, { cause: err });}
		if (!isLinkUnsupportedError(code)) {throw err;}
		try {
			await fs$1.copyFile(params.tempArchivePath, params.outputPath, constants.COPYFILE_EXCL);
		} catch (copyErr) {
			const copyCode = copyErr?.code;
			if (copyCode !== "EEXIST") {await fs$1.rm(params.outputPath, { force: true }).catch(() => void 0);}
			if (copyCode === "EEXIST") {throw new Error(`Refusing to overwrite existing backup archive: ${params.outputPath}`, { cause: copyErr });}
			throw copyErr;
		}
	}
	await fs$1.rm(params.tempArchivePath, { force: true });
}
async function canonicalizePathForContainment(targetPath) {
	const resolved = path.resolve(targetPath);
	const suffix = [];
	let probe = resolved;
	while (true) {try {
		const realProbe = await fs$1.realpath(probe);
		return suffix.length === 0 ? realProbe : path.join(realProbe, ...suffix.toReversed());
	} catch {
		const parent = path.dirname(probe);
		if (parent === probe) return resolved;
		suffix.push(path.basename(probe));
		probe = parent;
	}}
}
function buildManifest(params) {
	return {
		schemaVersion: 1,
		createdAt: params.createdAt,
		archiveRoot: params.archiveRoot,
		runtimeVersion: resolveRuntimeServiceVersion(),
		platform: process.platform,
		nodeVersion: process.version,
		options: {
			includeWorkspace: params.includeWorkspace,
			onlyConfig: params.onlyConfig
		},
		paths: {
			stateDir: params.stateDir,
			configPath: params.configPath,
			oauthDir: params.oauthDir,
			workspaceDirs: params.workspaceDirs
		},
		assets: params.assets.map((asset) => ({
			kind: asset.kind,
			sourcePath: asset.sourcePath,
			archivePath: asset.archivePath
		})),
		skipped: params.skipped.map((entry) => ({
			kind: entry.kind,
			sourcePath: entry.sourcePath,
			reason: entry.reason,
			coveredBy: entry.coveredBy
		}))
	};
}
function formatBackupCreateSummary(result) {
	const lines = [`Backup archive: ${result.archivePath}`];
	lines.push(`Included ${result.assets.length} path${result.assets.length === 1 ? "" : "s"}:`);
	for (const asset of result.assets) {lines.push(`- ${asset.kind}: ${asset.displayPath}`);}
	if (result.skipped.length > 0) {
		lines.push(`Skipped ${result.skipped.length} path${result.skipped.length === 1 ? "" : "s"}:`);
		for (const entry of result.skipped) {if (entry.reason === "covered" && entry.coveredBy) lines.push(`- ${entry.kind}: ${entry.displayPath} (${entry.reason} by ${entry.coveredBy})`);
		else lines.push(`- ${entry.kind}: ${entry.displayPath} (${entry.reason})`);}
	}
	if (result.dryRun) {lines.push("Dry run only; archive was not written.");}
	else {
		lines.push(`Created ${result.archivePath}`);
		if (result.verified) {lines.push("Archive verification: passed");}
	}
	return lines;
}
function remapArchiveEntryPath(params) {
	const normalizedEntry = path.resolve(params.entryPath);
	if (normalizedEntry === params.manifestPath) {return path.posix.join(params.archiveRoot, "manifest.json");}
	return buildBackupArchivePath(params.archiveRoot, normalizedEntry);
}
async function createBackupArchive(opts = {}) {
	const nowMs = opts.nowMs ?? Date.now();
	const archiveRoot = buildBackupArchiveRoot(nowMs);
	const onlyConfig = Boolean(opts.onlyConfig);
	const includeWorkspace = onlyConfig ? false : opts.includeWorkspace ?? true;
	const plan = await resolveBackupPlanFromDisk({
		includeWorkspace,
		onlyConfig,
		nowMs
	});
	const outputPath = await resolveOutputPath({
		output: opts.output,
		nowMs,
		includedAssets: plan.included,
		stateDir: plan.stateDir
	});
	if (plan.included.length === 0) {throw new Error(onlyConfig ? "No OpenClaw config file was found to back up." : "No local OpenClaw state was found to back up.");}
	const canonicalOutputPath = await canonicalizePathForContainment(outputPath);
	const overlappingAsset = plan.included.find((asset) => isPathWithin(canonicalOutputPath, asset.sourcePath));
	if (overlappingAsset) {throw new Error(`Backup output must not be written inside a source path: ${outputPath} is inside ${overlappingAsset.sourcePath}`);}
	if (!opts.dryRun) {await assertOutputPathReady(outputPath);}
	const createdAt = new Date(nowMs).toISOString();
	const result = {
		createdAt,
		archiveRoot,
		archivePath: outputPath,
		dryRun: Boolean(opts.dryRun),
		includeWorkspace,
		onlyConfig,
		verified: false,
		assets: plan.included,
		skipped: plan.skipped
	};
	if (opts.dryRun) {return result;}
	await fs$1.mkdir(path.dirname(outputPath), { recursive: true });
	const tempDir = await fs$1.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-"));
	const manifestPath = path.join(tempDir, "manifest.json");
	const tempArchivePath = buildTempArchivePath(outputPath);
	try {
		const manifest = buildManifest({
			createdAt,
			archiveRoot,
			includeWorkspace,
			onlyConfig,
			assets: result.assets,
			skipped: result.skipped,
			stateDir: plan.stateDir,
			configPath: plan.configPath,
			oauthDir: plan.oauthDir,
			workspaceDirs: plan.workspaceDirs
		});
		await fs$1.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		await tar.c({
			file: tempArchivePath,
			gzip: true,
			portable: true,
			preservePaths: true,
			onWriteEntry: (entry) => {
				entry.path = remapArchiveEntryPath({
					entryPath: entry.path,
					manifestPath,
					archiveRoot
				});
			}
		}, [manifestPath, ...result.assets.map((asset) => asset.sourcePath)]);
		await publishTempArchive({
			tempArchivePath,
			outputPath
		});
	} finally {
		await fs$1.rm(tempArchivePath, { force: true }).catch(() => void 0);
		await fs$1.rm(tempDir, {
			recursive: true,
			force: true
		}).catch(() => void 0);
	}
	return result;
}
//#endregion
//#region src/commands/backup.ts
async function backupCreateCommand(runtime, opts = {}) {
	const result = await createBackupArchive(opts);
	if (opts.verify && !opts.dryRun) {
		await backupVerifyCommand({
			...runtime,
			log: () => {}
		}, {
			archive: result.archivePath,
			json: false
		});
		result.verified = true;
	}
	const output = opts.json ? JSON.stringify(result, null, 2) : formatBackupCreateSummary(result).join("\n");
	runtime.log(output);
	return result;
}
//#endregion
//#region src/cli/program/register.backup.ts
function registerBackupCommand(program) {
	const backup = program.command("backup").description("Create and verify local backup archives for OpenClaw state").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/backup", "docs.openclaw.ai/cli/backup")}\n`);
	backup.command("create").description("Write a backup archive for config, credentials, sessions, and workspaces").option("--output <path>", "Archive path or destination directory").option("--json", "Output JSON", false).option("--dry-run", "Print the backup plan without writing the archive", false).option("--verify", "Verify the archive after writing it", false).option("--only-config", "Back up only the active JSON config file", false).option("--no-include-workspace", "Exclude workspace directories from the backup").addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw backup create", "Create a timestamped backup in the current directory."],
		["openclaw backup create --output ~/Backups", "Write the archive into an existing backup directory."],
		["openclaw backup create --dry-run --json", "Preview the archive plan without writing any files."],
		["openclaw backup create --verify", "Create the archive and immediately validate its manifest and payload layout."],
		["openclaw backup create --no-include-workspace", "Back up state/config without agent workspace files."],
		["openclaw backup create --only-config", "Back up only the active JSON config file."]
	])}`).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await backupCreateCommand(defaultRuntime, {
				output: opts.output,
				json: Boolean(opts.json),
				dryRun: Boolean(opts.dryRun),
				verify: Boolean(opts.verify),
				onlyConfig: Boolean(opts.onlyConfig),
				includeWorkspace: opts.includeWorkspace
			});
		});
	});
	backup.command("verify <archive>").description("Validate a backup archive and its embedded manifest").option("--json", "Output JSON", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([["openclaw backup verify ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz", "Check that the archive structure and manifest are intact."], ["openclaw backup verify ~/Backups/latest.tar.gz --json", "Emit machine-readable verification output."]])}`).action(async (archive, opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await backupVerifyCommand(defaultRuntime, {
				archive,
				json: Boolean(opts.json)
			});
		});
	});
}
//#endregion
export { registerBackupCommand };
