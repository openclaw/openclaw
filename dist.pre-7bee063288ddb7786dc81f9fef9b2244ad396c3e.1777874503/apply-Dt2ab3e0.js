import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { d as markMigrationItemSkipped, v as summarizeMigrationItems } from "./migration-qy8Kh27n.js";
import { t as backupCreateCommand } from "./backup-C9-OZ57a.js";
import { n as buildMigrationReportDir, t as buildMigrationContext } from "./context-CW1-o2V4.js";
import { i as writeApplyResult, n as assertConflictFreePlan, t as assertApplySucceeded } from "./output-gxlJkGd-.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/commands/migrate/selection.ts
const MIGRATION_SKILL_NOT_SELECTED_REASON = "not selected for migration";
function normalizeSelectionRef(value) {
	return value.trim().toLowerCase();
}
function readMigrationSkillName(item) {
	const value = item.details?.skillName;
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function readMigrationSkillSourceLabel(item) {
	const value = item.details?.sourceLabel;
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function migrationSkillRefs(item) {
	const skillName = readMigrationSkillName(item);
	const idSuffix = item.id.startsWith("skill:") ? item.id.slice(6) : void 0;
	const sourceBase = item.source ? path.basename(item.source) : void 0;
	const targetBase = item.target ? path.basename(item.target) : void 0;
	return [
		item.id,
		idSuffix,
		skillName,
		sourceBase,
		targetBase
	].filter((value) => typeof value === "string" && value.trim().length > 0);
}
function formatSelectionRefList(values) {
	if (values.length === 0) return "none";
	return values.map((value) => `"${value}"`).join(", ");
}
function buildSkillSelectionIndex(items) {
	const index = /* @__PURE__ */ new Map();
	for (const item of items) for (const ref of migrationSkillRefs(item)) {
		const normalized = normalizeSelectionRef(ref);
		if (!normalized) continue;
		const existing = index.get(normalized) ?? /* @__PURE__ */ new Set();
		existing.add(item.id);
		index.set(normalized, existing);
	}
	return index;
}
function resolveSelectedSkillItemIds(items, selectedRefs) {
	const index = buildSkillSelectionIndex(items);
	const selectedIds = /* @__PURE__ */ new Set();
	const unknownRefs = [];
	const ambiguousRefs = [];
	for (const ref of selectedRefs) {
		const normalized = normalizeSelectionRef(ref);
		if (!normalized) continue;
		const matches = index.get(normalized);
		if (!matches) {
			unknownRefs.push(ref);
			continue;
		}
		if (matches.size > 1) {
			ambiguousRefs.push(ref);
			continue;
		}
		const [id] = matches;
		if (id) selectedIds.add(id);
	}
	if (unknownRefs.length > 0 || ambiguousRefs.length > 0) {
		const available = items.map(formatMigrationSkillSelectionLabel).toSorted((a, b) => a.localeCompare(b));
		const parts = [];
		if (unknownRefs.length > 0) parts.push(`No migratable skill matched ${formatSelectionRefList(unknownRefs)}.`);
		if (ambiguousRefs.length > 0) parts.push(`Skill selection ${formatSelectionRefList(ambiguousRefs)} was ambiguous.`);
		parts.push(`Available skills: ${available.length > 0 ? available.join(", ") : "none"}.`);
		throw new Error(parts.join(" "));
	}
	return selectedIds;
}
function getSelectableMigrationSkillItems(plan) {
	return plan.items.filter((item) => item.kind === "skill" && item.action === "copy" && (item.status === "planned" || item.status === "conflict"));
}
function getMigrationSkillSelectionValue(item) {
	return item.id;
}
function formatMigrationSkillSelectionLabel(item) {
	return readMigrationSkillName(item) ?? item.id.replace(/^skill:/u, "");
}
function formatMigrationSkillSelectionHint(item) {
	const parts = [readMigrationSkillSourceLabel(item)];
	if (item.status === "conflict") parts.push(item.reason ? `conflict: ${item.reason}` : "conflict");
	return parts.filter((value) => typeof value === "string" && value.length > 0).join("; ") || void 0;
}
function applyMigrationSelectedSkillItemIds(plan, selectedItemIds) {
	const selectableIds = new Set(getSelectableMigrationSkillItems(plan).map((item) => item.id));
	const items = plan.items.map((item) => {
		if (!selectableIds.has(item.id) || selectedItemIds.has(item.id)) return item;
		return markMigrationItemSkipped(item, MIGRATION_SKILL_NOT_SELECTED_REASON);
	});
	return {
		...plan,
		items,
		summary: summarizeMigrationItems(items)
	};
}
function applyMigrationSkillSelection(plan, selectedSkillRefs) {
	if (selectedSkillRefs === void 0) return plan;
	return applyMigrationSelectedSkillItemIds(plan, resolveSelectedSkillItemIds(getSelectableMigrationSkillItems(plan), selectedSkillRefs));
}
//#endregion
//#region src/commands/migrate/apply.ts
function shouldTreatMissingBackupAsEmptyState(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("No local OpenClaw state was found to back up") || message.includes("No OpenClaw config file was found to back up");
}
async function createPreMigrationBackup(opts) {
	try {
		return (await backupCreateCommand({
			log() {},
			error() {},
			exit(code) {
				throw new Error(`backup exited with ${code}`);
			}
		}, {
			output: opts.output,
			verify: true
		})).archivePath;
	} catch (err) {
		if (shouldTreatMissingBackupAsEmptyState(err)) return;
		throw err;
	}
}
async function runMigrationApply(params) {
	const selectedPlan = applyMigrationSkillSelection(params.opts.preflightPlan ?? await params.provider.plan(buildMigrationContext({
		source: params.opts.source,
		includeSecrets: params.opts.includeSecrets,
		overwrite: params.opts.overwrite,
		runtime: params.runtime,
		json: params.opts.json
	})), params.opts.skills);
	assertConflictFreePlan(selectedPlan, params.providerId);
	const stateDir = resolveStateDir();
	const reportDir = buildMigrationReportDir(params.providerId, stateDir);
	const backupPath = params.opts.noBackup ? void 0 : await createPreMigrationBackup({ output: params.opts.backupOutput });
	await fs.mkdir(reportDir, { recursive: true });
	const ctx = buildMigrationContext({
		source: params.opts.source,
		includeSecrets: params.opts.includeSecrets,
		overwrite: params.opts.overwrite,
		runtime: params.runtime,
		backupPath,
		reportDir,
		json: params.opts.json
	});
	const result = await params.provider.apply(ctx, selectedPlan);
	const withBackup = {
		...result,
		backupPath: result.backupPath ?? backupPath,
		reportDir: result.reportDir ?? reportDir
	};
	writeApplyResult(params.runtime, params.opts, withBackup);
	assertApplySucceeded(withBackup);
	return withBackup;
}
//#endregion
export { formatMigrationSkillSelectionHint as a, getSelectableMigrationSkillItems as c, applyMigrationSkillSelection as i, runMigrationApply as n, formatMigrationSkillSelectionLabel as o, applyMigrationSelectedSkillItemIds as r, getMigrationSkillSelectionValue as s, createPreMigrationBackup as t };
