import { c as isRecord } from "./utils-sBTEdeml.js";
import { n as formatPluginInstallPathIssue, t as detectPluginInstallPathIssue } from "./plugin-install-path-warnings-CcS7vrVn.js";
import { s as removePluginFromConfig } from "./uninstall-Cvtk5oOG.js";
import "./runtime-doctor-p5TvjiM-.js";
import "./record-shared-DQ4sTnau.js";
import "./doctor-contract-DGpYqQ1j.js";
import { i as autoPrepareLegacyMatrixCrypto, o as autoMigrateLegacyMatrixState, r as resolveMatrixMigrationStatus } from "./matrix-migration.runtime.js";
import { t as maybeCreateMatrixMigrationSnapshot } from "./migration-snapshot-backup-B4vOJHYh.js";
//#region extensions/matrix/src/doctor.ts
function hasConfiguredMatrixChannel(cfg) {
	const channels = cfg.channels;
	return isRecord(channels?.matrix);
}
function hasConfiguredMatrixPluginSurface(cfg) {
	return Boolean(cfg.plugins?.installs?.matrix || cfg.plugins?.entries?.matrix || cfg.plugins?.allow?.includes("matrix") || cfg.plugins?.deny?.includes("matrix"));
}
function hasConfiguredMatrixEnv(env) {
	return Object.entries(env).some(([key, value]) => key.startsWith("MATRIX_") && typeof value === "string" && value.trim());
}
function configMayNeedMatrixDoctorSequence(cfg, env) {
	return hasConfiguredMatrixChannel(cfg) || hasConfiguredMatrixPluginSurface(cfg) || hasConfiguredMatrixEnv(env);
}
function formatMatrixLegacyStatePreview(detection) {
	return [
		"- Matrix plugin upgraded in place.",
		`- Legacy sync store: ${detection.legacyStoragePath} -> ${detection.targetStoragePath}`,
		`- Legacy crypto store: ${detection.legacyCryptoPath} -> ${detection.targetCryptoPath}`,
		...detection.selectionNote ? [`- ${detection.selectionNote}`] : [],
		"- Run \"openclaw doctor --fix\" to migrate this Matrix state now."
	].join("\n");
}
function formatMatrixLegacyCryptoPreview(detection) {
	const notes = [];
	for (const warning of detection.warnings) notes.push(`- ${warning}`);
	for (const plan of detection.plans) notes.push([
		`- Matrix encrypted-state migration is pending for account "${plan.accountId}".`,
		`- Legacy crypto store: ${plan.legacyCryptoPath}`,
		`- New recovery key file: ${plan.recoveryKeyPath}`,
		`- Migration state file: ${plan.statePath}`,
		"- Run \"openclaw doctor --fix\" to extract any saved backup key now. Backed-up room keys will restore automatically on next gateway start."
	].join("\n"));
	return notes;
}
async function collectMatrixInstallPathWarnings(cfg) {
	const issue = await detectPluginInstallPathIssue({
		pluginId: "matrix",
		install: cfg.plugins?.installs?.matrix
	});
	if (!issue) return [];
	return formatPluginInstallPathIssue({
		issue,
		pluginLabel: "Matrix",
		defaultInstallCommand: "openclaw plugins install @openclaw/matrix"
	}).map((entry) => `- ${entry}`);
}
async function cleanStaleMatrixPluginConfig(cfg) {
	const issue = await detectPluginInstallPathIssue({
		pluginId: "matrix",
		install: cfg.plugins?.installs?.matrix
	});
	if (!issue || issue.kind !== "missing-path") return {
		config: cfg,
		changes: []
	};
	const { config, actions } = removePluginFromConfig(cfg, "matrix");
	const removed = [];
	if (actions.install) removed.push("install record");
	if (actions.loadPath) removed.push("load path");
	if (actions.entry) removed.push("plugin entry");
	if (actions.allowlist) removed.push("allowlist entry");
	if (removed.length === 0) return {
		config: cfg,
		changes: []
	};
	return {
		config,
		changes: [`Removed stale Matrix plugin references (${removed.join(", ")}). The previous install path no longer exists: ${issue.path}`]
	};
}
async function applyMatrixDoctorRepair(params) {
	const changes = [];
	const warnings = [];
	const migrationStatus = resolveMatrixMigrationStatus({
		cfg: params.cfg,
		env: params.env
	});
	let matrixSnapshotReady = true;
	if (migrationStatus.actionable) try {
		const snapshot = await maybeCreateMatrixMigrationSnapshot({
			trigger: "doctor-fix",
			env: params.env
		});
		changes.push(`Matrix migration snapshot ${snapshot.created ? "created" : "reused"} before applying Matrix upgrades.\n- ${snapshot.archivePath}`);
	} catch (error) {
		matrixSnapshotReady = false;
		warnings.push(`- Failed creating a Matrix migration snapshot before repair: ${String(error)}`);
		warnings.push("- Skipping Matrix migration changes for now. Resolve the snapshot failure, then rerun \"openclaw doctor --fix\".");
	}
	else if (migrationStatus.pending) warnings.push("- Matrix migration warnings are present, but no on-disk Matrix mutation is actionable yet. No pre-migration snapshot was needed.");
	if (!matrixSnapshotReady) return {
		changes,
		warnings
	};
	const matrixStateRepair = await autoMigrateLegacyMatrixState({
		cfg: params.cfg,
		env: params.env
	});
	if (matrixStateRepair.changes.length > 0) changes.push([
		"Matrix plugin upgraded in place.",
		...matrixStateRepair.changes.map((entry) => `- ${entry}`),
		"- No user action required."
	].join("\n"));
	if (matrixStateRepair.warnings.length > 0) warnings.push(matrixStateRepair.warnings.map((entry) => `- ${entry}`).join("\n"));
	const matrixCryptoRepair = await autoPrepareLegacyMatrixCrypto({
		cfg: params.cfg,
		env: params.env
	});
	if (matrixCryptoRepair.changes.length > 0) changes.push(["Matrix encrypted-state migration prepared.", ...matrixCryptoRepair.changes.map((entry) => `- ${entry}`)].join("\n"));
	if (matrixCryptoRepair.warnings.length > 0) warnings.push(matrixCryptoRepair.warnings.map((entry) => `- ${entry}`).join("\n"));
	return {
		changes,
		warnings
	};
}
async function runMatrixDoctorSequence(params) {
	const warningNotes = [];
	const changeNotes = [];
	const installWarnings = await collectMatrixInstallPathWarnings(params.cfg);
	if (installWarnings.length > 0) warningNotes.push(installWarnings.join("\n"));
	if (!configMayNeedMatrixDoctorSequence(params.cfg, params.env)) return {
		changeNotes,
		warningNotes
	};
	if (params.shouldRepair) {
		const repair = await applyMatrixDoctorRepair({
			cfg: params.cfg,
			env: params.env
		});
		changeNotes.push(...repair.changes);
		warningNotes.push(...repair.warnings);
	} else {
		const migrationStatus = resolveMatrixMigrationStatus({
			cfg: params.cfg,
			env: params.env
		});
		if (migrationStatus.legacyState) if ("warning" in migrationStatus.legacyState) warningNotes.push(`- ${migrationStatus.legacyState.warning}`);
		else warningNotes.push(formatMatrixLegacyStatePreview(migrationStatus.legacyState));
		if (migrationStatus.legacyCrypto.warnings.length > 0 || migrationStatus.legacyCrypto.plans.length > 0) warningNotes.push(...formatMatrixLegacyCryptoPreview(migrationStatus.legacyCrypto));
	}
	return {
		changeNotes,
		warningNotes
	};
}
//#endregion
export { cleanStaleMatrixPluginConfig, runMatrixDoctorSequence };
