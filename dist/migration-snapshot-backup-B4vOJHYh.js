import { o as resolveRequiredHomeDir } from "./home-dir-BOPFpGo8.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as writeJsonFileAtomically } from "./json-store-ChgPP2Sf.js";
import "./state-paths-iYyQ0JoC.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region extensions/matrix/src/migration-snapshot-backup.ts
const MATRIX_MIGRATION_SNAPSHOT_DIRNAME = "openclaw-migrations";
function loadSnapshotMarker(filePath) {
	try {
		if (!fs.existsSync(filePath)) return null;
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (parsed.version !== 1 || typeof parsed.createdAt !== "string" || typeof parsed.archivePath !== "string" || typeof parsed.trigger !== "string") return null;
		return {
			version: 1,
			createdAt: parsed.createdAt,
			archivePath: parsed.archivePath,
			trigger: parsed.trigger,
			includeWorkspace: parsed.includeWorkspace === true
		};
	} catch {
		return null;
	}
}
function resolveMatrixMigrationSnapshotMarkerPath(env = process.env) {
	const stateDir = resolveStateDir(env, os.homedir);
	return path.join(stateDir, "matrix", "migration-snapshot.json");
}
function resolveMatrixMigrationSnapshotOutputDir(env = process.env) {
	const homeDir = resolveRequiredHomeDir(env, os.homedir);
	return path.join(homeDir, "Backups", MATRIX_MIGRATION_SNAPSHOT_DIRNAME);
}
async function maybeCreateMatrixMigrationSnapshot(params) {
	const env = params.env ?? process.env;
	const createBackupArchive = params.createBackupArchive ?? (await import("./plugin-sdk/runtime.js")).createBackupArchive;
	const markerPath = resolveMatrixMigrationSnapshotMarkerPath(env);
	const existingMarker = loadSnapshotMarker(markerPath);
	if (existingMarker?.archivePath && fs.existsSync(existingMarker.archivePath)) {
		params.log?.info?.(`matrix: reusing existing pre-migration backup snapshot: ${existingMarker.archivePath}`);
		return {
			created: false,
			archivePath: existingMarker.archivePath,
			markerPath
		};
	}
	if (existingMarker?.archivePath && !fs.existsSync(existingMarker.archivePath)) params.log?.warn?.(`matrix: previous migration snapshot is missing (${existingMarker.archivePath}); creating a replacement backup before continuing`);
	const snapshot = await createBackupArchive({
		output: (() => {
			const outputDir = params.outputDir ?? resolveMatrixMigrationSnapshotOutputDir(env);
			fs.mkdirSync(outputDir, { recursive: true });
			return outputDir;
		})(),
		includeWorkspace: false
	});
	await writeJsonFileAtomically(markerPath, {
		version: 1,
		createdAt: snapshot.createdAt,
		archivePath: snapshot.archivePath,
		trigger: params.trigger,
		includeWorkspace: snapshot.includeWorkspace
	});
	params.log?.info?.(`matrix: created pre-migration backup snapshot: ${snapshot.archivePath}`);
	return {
		created: true,
		archivePath: snapshot.archivePath,
		markerPath
	};
}
//#endregion
export { maybeCreateMatrixMigrationSnapshot as t };
