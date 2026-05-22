import { f as readStringValue } from "./string-coerce-Bje8XVt9.js";
import { c as isRecord, p as resolveUserPath } from "./utils-D5swhEXt.js";
import { r as writeRuntimeJson } from "./runtime-bzt9CHmD.js";
import path from "node:path";
import * as tar from "tar";
//#region src/commands/backup-verify.ts
const WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
function stripTrailingSlashes(value) {
	return value.replace(/\/+$/u, "");
}
function normalizeArchivePath(entryPath, label) {
	const trimmed = stripTrailingSlashes(entryPath.trim());
	if (!trimmed) throw new Error(`${label} is empty.`);
	if (trimmed.startsWith("/") || WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE.test(trimmed)) throw new Error(`${label} must be relative: ${entryPath}`);
	if (trimmed.includes("\\")) throw new Error(`${label} must use forward slashes: ${entryPath}`);
	if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) throw new Error(`${label} contains path traversal segments: ${entryPath}`);
	const normalized = stripTrailingSlashes(path.posix.normalize(trimmed));
	if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new Error(`${label} resolves outside the archive root: ${entryPath}`);
	return normalized;
}
function normalizeArchiveRoot(rootName) {
	const normalized = normalizeArchivePath(rootName, "Backup manifest archiveRoot");
	if (normalized.includes("/")) throw new Error(`Backup manifest archiveRoot must be a single path segment: ${rootName}`);
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
	if (!isRecord(parsed)) throw new Error("Backup manifest must be an object.");
	if (parsed.schemaVersion !== 1) throw new Error(`Unsupported backup manifest schemaVersion: ${String(parsed.schemaVersion)}`);
	if (typeof parsed.archiveRoot !== "string" || !parsed.archiveRoot.trim()) throw new Error("Backup manifest is missing archiveRoot.");
	if (typeof parsed.createdAt !== "string" || !parsed.createdAt.trim()) throw new Error("Backup manifest is missing createdAt.");
	if (!Array.isArray(parsed.assets)) throw new Error("Backup manifest is missing assets.");
	const assets = [];
	for (const asset of parsed.assets) {
		if (!isRecord(asset)) throw new Error("Backup manifest contains a non-object asset.");
		if (typeof asset.kind !== "string" || !asset.kind.trim()) throw new Error("Backup manifest asset is missing kind.");
		if (typeof asset.sourcePath !== "string" || !asset.sourcePath.trim()) throw new Error("Backup manifest asset is missing sourcePath.");
		if (typeof asset.archivePath !== "string" || !asset.archivePath.trim()) throw new Error("Backup manifest asset is missing archivePath.");
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
			stateDir: readStringValue(parsed.paths.stateDir),
			configPath: readStringValue(parsed.paths.configPath),
			oauthDir: readStringValue(parsed.paths.oauthDir),
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
	if (!manifestContentPromise) throw new Error(`Archive is missing manifest entry: ${params.manifestEntryPath}`);
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
	if (!normalizedEntrySet.has(manifestEntryPath)) throw new Error(`Archive is missing manifest entry: ${manifestEntryPath}`);
	for (const entry of normalizedEntries) if (!isArchivePathWithin(entry, archiveRoot)) throw new Error(`Archive entry is outside the declared archive root: ${entry}`);
	const payloadRoot = path.posix.join(archiveRoot, "payload");
	for (const asset of manifest.assets) {
		const assetArchivePath = normalizeArchivePath(asset.archivePath, "Backup manifest asset path");
		if (!isArchivePathWithin(assetArchivePath, payloadRoot)) throw new Error(`Manifest asset path is outside payload root: ${asset.archivePath}`);
		const exact = normalizedEntrySet.has(assetArchivePath);
		const nested = normalizedEntries.some((entry) => entry !== assetArchivePath && isArchivePathWithin(entry, assetArchivePath));
		if (!exact && !nested) throw new Error(`Archive is missing payload for manifest asset: ${assetArchivePath}`);
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
		if (seen.has(entry.normalized)) return entry.normalized;
		seen.add(entry.normalized);
	}
}
async function backupVerifyCommand(runtime, opts) {
	const archivePath = resolveUserPath(opts.archive);
	const rawEntries = await listArchiveEntries(archivePath);
	if (rawEntries.length === 0) throw new Error("Backup archive is empty.");
	const entries = rawEntries.map((entry) => ({
		raw: entry,
		normalized: normalizeArchivePath(entry, "Archive entry")
	}));
	const normalizedEntrySet = new Set(entries.map((entry) => entry.normalized));
	const manifestMatches = entries.filter((entry) => isRootManifestEntry(entry.normalized));
	if (manifestMatches.length !== 1) throw new Error(`Expected exactly one backup manifest entry, found ${manifestMatches.length}.`);
	const duplicateEntryPath = findDuplicateNormalizedEntryPath(entries);
	if (duplicateEntryPath) throw new Error(`Archive contains duplicate entry path: ${duplicateEntryPath}`);
	const manifestEntryPath = manifestMatches[0]?.raw;
	if (!manifestEntryPath) throw new Error("Backup archive manifest entry could not be resolved.");
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
	if (opts.json) writeRuntimeJson(runtime, result);
	else runtime.log(formatResult(result));
	return result;
}
//#endregion
export { backupVerifyCommand as t };
