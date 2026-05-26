import { f as resolveHomeDir } from "./utils-CKsuXgDI.js";
import { _ as recoverConfigFromLastKnownGood, g as recoverConfigFromJsonRootSuffix, u as readConfigFileSnapshot } from "./io-5xE1dPMK.js";
import { n as formatConfigIssueLines } from "./issue-format-C1rff-gs.js";
import { t as note } from "./note-Bg5THHEx.js";
import { r as noteIncludeConfinementWarning } from "./doctor-config-analysis-KJ83eQGz.js";
import { t as findDoctorLegacyConfigIssues } from "./legacy-config-issues-D6eKfkcl.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/commands/doctor-config-preflight.ts
async function maybeMigrateLegacyConfig() {
	const changes = [];
	const home = resolveHomeDir();
	if (!home) return changes;
	const targetDir = path.join(home, ".openclaw");
	const targetPath = path.join(targetDir, "openclaw.json");
	try {
		await fs.access(targetPath);
		return changes;
	} catch {}
	const legacyCandidates = [path.join(home, ".clawdbot", "clawdbot.json")];
	let legacyPath = null;
	for (const candidate of legacyCandidates) try {
		await fs.access(candidate);
		legacyPath = candidate;
		break;
	} catch {}
	if (!legacyPath) return changes;
	await fs.mkdir(targetDir, { recursive: true });
	try {
		await fs.copyFile(legacyPath, targetPath, fs.constants.COPYFILE_EXCL);
		changes.push(`Migrated legacy config: ${legacyPath} -> ${targetPath}`);
	} catch {}
	return changes;
}
function collectDoctorLegacyIssues(snapshot) {
	if (!snapshot.exists) return [];
	const resolvedRaw = snapshot.sourceConfig ?? snapshot.config ?? {};
	return findDoctorLegacyConfigIssues(resolvedRaw, snapshot.parsed ?? resolvedRaw);
}
function addDoctorLegacyIssues(snapshot) {
	const legacyIssues = collectDoctorLegacyIssues(snapshot);
	if (legacyIssues.length === 0) return snapshot;
	return {
		...snapshot,
		legacyIssues
	};
}
async function runDoctorConfigPreflight(options = {}) {
	if (options.migrateState !== false) {
		const { autoMigrateLegacyStateDir } = await import("./doctor-state-migrations-B9TF7Ybk.js");
		const stateDirResult = await autoMigrateLegacyStateDir({ env: process.env });
		if (stateDirResult.changes.length > 0) note(stateDirResult.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
		if (stateDirResult.warnings.length > 0) note(stateDirResult.warnings.map((entry) => `- ${entry}`).join("\n"), "Doctor warnings");
	}
	if (options.migrateLegacyConfig !== false) {
		const legacyConfigChanges = await maybeMigrateLegacyConfig();
		if (legacyConfigChanges.length > 0) note(legacyConfigChanges.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
	}
	let snapshot = addDoctorLegacyIssues(await readConfigFileSnapshot());
	if (options.repairPrefixedConfig === true && snapshot.exists && !snapshot.valid) {
		if (await recoverConfigFromJsonRootSuffix(snapshot)) {
			note("Removed non-JSON prefix from openclaw.json; original saved as .clobbered.*.", "Config");
			snapshot = addDoctorLegacyIssues(await readConfigFileSnapshot());
		} else if (await recoverConfigFromLastKnownGood({
			snapshot,
			reason: "doctor-invalid-config"
		})) {
			note("Restored openclaw.json from last-known-good; original saved as .clobbered.*.", "Config");
			snapshot = addDoctorLegacyIssues(await readConfigFileSnapshot());
		}
	}
	const invalidConfigNote = options.invalidConfigNote ?? "Config invalid; doctor will run with best-effort config.";
	if (invalidConfigNote && snapshot.exists && !snapshot.valid && snapshot.legacyIssues.length === 0) {
		note(invalidConfigNote, "Config");
		noteIncludeConfinementWarning(snapshot);
	}
	const warnings = snapshot.warnings ?? [];
	if (warnings.length > 0) note(formatConfigIssueLines(warnings, "-").join("\n"), "Config warnings");
	return {
		snapshot,
		baseConfig: snapshot.sourceConfig ?? snapshot.config ?? {}
	};
}
//#endregion
export { runDoctorConfigPreflight as t };
