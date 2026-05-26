import { i as writeJsonFileAtomically, n as readJsonFileWithFallback } from "./json-store-ChgPP2Sf.js";
import { t as getMatrixRuntime } from "./runtime-Bzh7h5rJ.js";
import { a as resolveMatrixStoragePaths } from "./storage-BVAqboeh.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
//#region extensions/matrix/src/matrix/monitor/legacy-crypto-restore.ts
function isMigrationState(value) {
	return Boolean(value) && typeof value === "object" && value.version === 1;
}
async function resolvePendingMigrationStatePath(params) {
	const { rootDir } = resolveMatrixStoragePaths({
		homeserver: params.auth.homeserver,
		userId: params.auth.userId,
		accessToken: params.auth.accessToken,
		accountId: params.auth.accountId,
		deviceId: params.auth.deviceId,
		stateDir: params.stateDir
	});
	const directStatePath = path.join(rootDir, "legacy-crypto-migration.json");
	const { value: directValue } = await readJsonFileWithFallback(directStatePath, null);
	if (isMigrationState(directValue) && directValue.restoreStatus === "pending") return {
		statePath: directStatePath,
		value: directValue
	};
	const accountStorageDir = path.dirname(rootDir);
	let siblingEntries = [];
	try {
		siblingEntries = (await fs.readdir(accountStorageDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).filter((entry) => path.join(accountStorageDir, entry) !== rootDir).toSorted((left, right) => left.localeCompare(right));
	} catch {
		return {
			statePath: directStatePath,
			value: directValue
		};
	}
	for (const sibling of siblingEntries) {
		const siblingStatePath = path.join(accountStorageDir, sibling, "legacy-crypto-migration.json");
		const { value } = await readJsonFileWithFallback(siblingStatePath, null);
		if (isMigrationState(value) && value.restoreStatus === "pending") return {
			statePath: siblingStatePath,
			value
		};
	}
	return {
		statePath: directStatePath,
		value: directValue
	};
}
async function maybeRestoreLegacyMatrixBackup(params) {
	const env = params.env ?? process.env;
	const { statePath, value } = await resolvePendingMigrationStatePath({
		stateDir: params.stateDir ?? getMatrixRuntime().state.resolveStateDir(env, os.homedir),
		auth: params.auth
	});
	if (!isMigrationState(value) || value.restoreStatus !== "pending") return { kind: "skipped" };
	const restore = await params.client.restoreRoomKeyBackup();
	const localOnlyKeys = value.roomKeyCounts && value.roomKeyCounts.total > value.roomKeyCounts.backedUp ? value.roomKeyCounts.total - value.roomKeyCounts.backedUp : 0;
	if (restore.success) {
		await writeJsonFileAtomically(statePath, {
			...value,
			restoreStatus: "completed",
			restoredAt: restore.restoredAt ?? (/* @__PURE__ */ new Date()).toISOString(),
			importedCount: restore.imported,
			totalCount: restore.total,
			lastError: null
		});
		return {
			kind: "restored",
			imported: restore.imported,
			total: restore.total,
			localOnlyKeys
		};
	}
	await writeJsonFileAtomically(statePath, {
		...value,
		lastError: restore.error ?? "unknown"
	});
	return {
		kind: "failed",
		error: restore.error ?? "unknown",
		localOnlyKeys
	};
}
//#endregion
export { maybeRestoreLegacyMatrixBackup };
