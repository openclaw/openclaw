import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { g as redactMigrationPlan, l as markMigrationItemConflict, n as MIGRATION_REASON_TARGET_EXISTS, t as MIGRATION_REASON_MISSING_SOURCE_OR_TARGET, u as markMigrationItemError } from "./migration-DGUrqTK8.js";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
//#region src/plugin-sdk/migration-runtime.ts
function withCachedMigrationConfigRuntime(runtime, fallbackConfig) {
	if (!runtime) return;
	const configApi = runtime.config;
	if (!configApi?.current || !configApi.mutateConfigFile) return runtime;
	let cachedConfig;
	const current = () => {
		cachedConfig ??= structuredClone(configApi.current() ?? fallbackConfig);
		return cachedConfig;
	};
	return {
		...runtime,
		config: {
			...runtime.config,
			current,
			mutateConfigFile: async (params) => {
				const result = await configApi.mutateConfigFile({
					...params,
					mutate: async (draft, context) => {
						const mutationResult = await params.mutate(draft, context);
						cachedConfig = structuredClone(draft);
						return mutationResult;
					}
				});
				cachedConfig = structuredClone(result.nextConfig);
				return result;
			},
			...configApi.replaceConfigFile ? { replaceConfigFile: async (params) => {
				const result = await configApi.replaceConfigFile(params);
				cachedConfig = structuredClone(result.nextConfig);
				return result;
			} } : {}
		}
	};
}
async function exists(filePath) {
	return await pathExists(filePath);
}
async function backupExistingMigrationTarget(target, reportDir) {
	if (!await exists(target)) return;
	const backupRoot = path.join(reportDir, "item-backups");
	await fs.mkdir(backupRoot, { recursive: true });
	const targetHash = crypto.createHash("sha256").update(path.resolve(target)).digest("hex").slice(0, 12);
	const backupDir = await fs.mkdtemp(path.join(backupRoot, `${Date.now()}-${targetHash}-${path.basename(target)}-`));
	const backupPath = path.join(backupDir, path.basename(target));
	await fs.cp(target, backupPath, {
		recursive: true,
		force: true
	});
	return backupPath;
}
function isFileAlreadyExistsError(err) {
	return Boolean(err && typeof err === "object" && "code" in err && (err.code === "ERR_FS_CP_EEXIST" || err.code === "EEXIST"));
}
function readArchiveRelativePath(item) {
	const detailPath = item.details?.archiveRelativePath;
	const raw = typeof detailPath === "string" && detailPath.trim() ? detailPath : void 0;
	const fallback = item.source ? path.basename(item.source) : item.id;
	return path.normalize(raw ?? fallback).split(path.sep).filter((part) => part && part !== "." && part !== "..").join(path.sep) || "item";
}
async function resolveUniqueArchivePath(archiveRoot, relativePath) {
	const parsed = path.parse(relativePath);
	let candidate = path.join(archiveRoot, relativePath);
	let index = 2;
	while (await exists(candidate)) {
		const filename = `${parsed.name}-${index}${parsed.ext}`;
		candidate = path.join(archiveRoot, parsed.dir, filename);
		index += 1;
	}
	return candidate;
}
async function archiveMigrationItem(item, reportDir) {
	if (!item.source) return markMigrationItemError(item, MIGRATION_REASON_MISSING_SOURCE_OR_TARGET);
	try {
		if ((await fs.lstat(item.source)).isSymbolicLink()) return markMigrationItemError(item, "archive source is a symlink");
		const archiveRoot = path.join(reportDir, "archive");
		const relativePath = readArchiveRelativePath(item);
		const archivePath = await resolveUniqueArchivePath(archiveRoot, relativePath);
		await fs.mkdir(path.dirname(archivePath), { recursive: true });
		await fs.cp(item.source, archivePath, {
			recursive: true,
			force: false,
			errorOnExist: true,
			verbatimSymlinks: true
		});
		return {
			...item,
			status: "migrated",
			target: archivePath,
			details: {
				...item.details,
				archivePath,
				archiveRelativePath: relativePath
			}
		};
	} catch (err) {
		if (isFileAlreadyExistsError(err)) return markMigrationItemConflict(item, MIGRATION_REASON_TARGET_EXISTS);
		return markMigrationItemError(item, err instanceof Error ? err.message : String(err));
	}
}
async function copyMigrationFileItem(item, reportDir, opts = {}) {
	if (!item.source || !item.target) return markMigrationItemError(item, MIGRATION_REASON_MISSING_SOURCE_OR_TARGET);
	try {
		if (await exists(item.target) && !opts.overwrite) return markMigrationItemConflict(item, MIGRATION_REASON_TARGET_EXISTS);
		const backupPath = opts.overwrite ? await backupExistingMigrationTarget(item.target, reportDir) : void 0;
		await fs.mkdir(path.dirname(item.target), { recursive: true });
		await fs.cp(item.source, item.target, {
			recursive: true,
			force: Boolean(opts.overwrite),
			errorOnExist: !opts.overwrite
		});
		return {
			...item,
			status: "migrated",
			details: {
				...item.details,
				...backupPath ? { backupPath } : {}
			}
		};
	} catch (err) {
		if (isFileAlreadyExistsError(err)) return markMigrationItemConflict(item, MIGRATION_REASON_TARGET_EXISTS);
		return markMigrationItemError(item, err instanceof Error ? err.message : String(err));
	}
}
async function writeMigrationReport(result, opts = {}) {
	if (!result.reportDir) return;
	await fs.mkdir(result.reportDir, { recursive: true });
	await fs.writeFile(path.join(result.reportDir, "report.json"), `${JSON.stringify(redactMigrationPlan(result), null, 2)}\n`, "utf8");
	const lines = [
		`# ${opts.title ?? "Migration Report"}`,
		"",
		`Source: ${result.source}`,
		result.target ? `Target: ${result.target}` : void 0,
		result.backupPath ? `Backup: ${result.backupPath}` : void 0,
		"",
		`Migrated: ${result.summary.migrated}`,
		`Skipped: ${result.summary.skipped}`,
		`Conflicts: ${result.summary.conflicts}`,
		`Errors: ${result.summary.errors}`,
		"",
		...result.items.map((item) => `- ${item.status}: ${item.id}${item.reason ? ` (${item.reason})` : ""}`)
	].filter((line) => typeof line === "string");
	await fs.writeFile(path.join(result.reportDir, "summary.md"), `${lines.join("\n")}\n`, "utf8");
}
//#endregion
export { writeMigrationReport as i, copyMigrationFileItem as n, withCachedMigrationConfigRuntime as r, archiveMigrationItem as t };
