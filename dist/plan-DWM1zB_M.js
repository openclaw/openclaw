import { o as createMigrationItem, v as summarizeMigrationItems } from "./migration-DGUrqTK8.js";
import { r as buildConfigItems } from "./config-Da3L9RL8.js";
import { t as buildMemoryItems } from "./memory-2xvD4AFM.js";
import { n as buildSkillItems } from "./skills-BrrciZEb.js";
import { n as hasClaudeSource, t as discoverClaudeSource } from "./source-CJzgKDf0.js";
import { t as resolveTargets } from "./targets-Bv2zD_3v.js";
//#region extensions/migrate-claude/plan.ts
function addArchiveItem(items, params) {
	if (!params.source) return;
	items.push(createMigrationItem({
		id: params.id,
		kind: "archive",
		action: "archive",
		source: params.source,
		message: params.message ?? "Archived in the migration report for manual review; not imported into live config.",
		details: { archiveRelativePath: params.relativePath }
	}));
}
async function buildClaudePlan(ctx) {
	const source = await discoverClaudeSource(ctx.source);
	if (!hasClaudeSource(source)) throw new Error(`Claude state was not found at ${source.root}. Pass --from <path> if it lives elsewhere.`);
	const targets = resolveTargets(ctx);
	const items = [];
	items.push(...await buildMemoryItems({
		source,
		targets,
		overwrite: ctx.overwrite
	}));
	items.push(...await buildConfigItems({
		ctx,
		source
	}));
	items.push(...await buildSkillItems({
		source,
		targets,
		overwrite: ctx.overwrite
	}));
	for (const archivePath of source.archivePaths) addArchiveItem(items, {
		id: archivePath.id,
		source: archivePath.path,
		relativePath: archivePath.relativePath
	});
	addArchiveItem(items, {
		id: "archive:CLAUDE.local.md",
		source: source.projectLocalMemoryPath,
		relativePath: "CLAUDE.local.md",
		message: "Claude local project memory is personal machine-local state. It is archived for manual review."
	});
	addArchiveItem(items, {
		id: "archive:.claude/rules",
		source: source.projectRulesDir,
		relativePath: ".claude/rules"
	});
	addArchiveItem(items, {
		id: "archive:user-agents",
		source: source.userAgentsDir,
		relativePath: "agents/user"
	});
	addArchiveItem(items, {
		id: "archive:project-agents",
		source: source.projectAgentsDir,
		relativePath: "agents/project"
	});
	const warnings = [
		...items.some((item) => item.status === "conflict") ? ["Conflicts were found. Re-run with --overwrite to replace conflicting targets after item-level backups."] : [],
		...items.some((item) => item.kind === "archive") ? ["Some Claude files are archive-only. They will be copied into the migration report for manual review, not loaded into OpenClaw."] : [],
		...items.some((item) => item.kind === "manual") ? ["Some Claude settings require manual review before they can be activated safely."] : []
	];
	return {
		providerId: "claude",
		source: source.root,
		target: targets.workspaceDir,
		summary: summarizeMigrationItems(items),
		items,
		warnings,
		nextSteps: ["Run openclaw doctor after applying the migration."],
		metadata: { agentDir: targets.agentDir }
	};
}
//#endregion
export { buildClaudePlan as t };
