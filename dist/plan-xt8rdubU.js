import { n as MIGRATION_REASON_TARGET_EXISTS, o as createMigrationItem, v as summarizeMigrationItems } from "./migration-DGUrqTK8.js";
import { r as exists, s as parseHermesConfig, u as readText } from "./helpers-B_eVYvP7.js";
import { r as buildConfigItems } from "./config-CiYLrdrz.js";
import { l as createHermesModelItem } from "./items-CPsScumM.js";
import { n as resolveCurrentModelRef, r as resolveHermesModelRef } from "./model-B3tqrlBc.js";
import { n as buildSecretItems } from "./secrets-f9lq-r9u.js";
import { t as buildSkillItems } from "./skills-D-f9iJJs.js";
import { n as hasHermesSource, t as discoverHermesSource } from "./source-DBE89LOz.js";
import { t as resolveTargets } from "./targets-CZQ88tgV.js";
import path from "node:path";
//#region extensions/migrate-hermes/plan.ts
async function addFileItem(params) {
	if (!params.source) return;
	const targetExists = await exists(params.target);
	params.items.push(createMigrationItem({
		id: params.id,
		kind: params.kind ?? "file",
		action: params.action ?? "copy",
		source: params.source,
		target: params.target,
		status: targetExists && !params.overwrite ? "conflict" : "planned",
		reason: targetExists && !params.overwrite ? MIGRATION_REASON_TARGET_EXISTS : void 0
	}));
}
async function buildHermesPlan(ctx) {
	const source = await discoverHermesSource(ctx.source);
	if (!hasHermesSource(source)) throw new Error(`Hermes state was not found at ${source.root}. Pass --from <path> if it lives elsewhere.`);
	const targets = resolveTargets(ctx);
	const config = parseHermesConfig(await readText(source.configPath));
	const modelRef = resolveHermesModelRef(config);
	const items = [];
	if (modelRef) {
		const currentModel = resolveCurrentModelRef(ctx);
		items.push(createHermesModelItem({
			model: modelRef,
			currentModel,
			overwrite: ctx.overwrite
		}));
	}
	items.push(...buildConfigItems({
		ctx,
		config,
		modelRef,
		hasMemoryFiles: Boolean(source.memoryPath || source.userPath)
	}));
	await addFileItem({
		items,
		id: "workspace:SOUL.md",
		kind: "workspace",
		source: source.soulPath,
		target: path.join(targets.workspaceDir, "SOUL.md"),
		overwrite: ctx.overwrite
	});
	await addFileItem({
		items,
		id: "workspace:AGENTS.md",
		kind: "workspace",
		source: source.agentsPath,
		target: path.join(targets.workspaceDir, "AGENTS.md"),
		overwrite: ctx.overwrite
	});
	if (source.memoryPath) items.push(createMigrationItem({
		id: "memory:MEMORY.md",
		kind: "memory",
		action: "append",
		source: source.memoryPath,
		target: path.join(targets.workspaceDir, "MEMORY.md")
	}));
	if (source.userPath) items.push(createMigrationItem({
		id: "memory:USER.md",
		kind: "memory",
		action: "append",
		source: source.userPath,
		target: path.join(targets.workspaceDir, "USER.md")
	}));
	items.push(...await buildSkillItems({
		source,
		targets,
		overwrite: ctx.overwrite
	}));
	items.push(...await buildSecretItems({
		ctx,
		source,
		targets
	}));
	for (const archivePath of source.archivePaths) items.push(createMigrationItem({
		id: archivePath.id,
		kind: "archive",
		action: "archive",
		source: archivePath.path,
		message: "Archived in the migration report for manual review; not imported into live config.",
		details: { archiveRelativePath: archivePath.relativePath }
	}));
	const warnings = [
		...!ctx.includeSecrets && items.some((item) => item.kind === "secret") ? ["Secrets were detected but skipped. Re-run with --include-secrets to import supported API keys."] : [],
		...items.some((item) => item.status === "conflict") ? ["Conflicts were found. Re-run with --overwrite to replace conflicting targets after item-level backups."] : [],
		...source.archivePaths.length > 0 ? ["Some Hermes files are archive-only. They will be copied into the migration report for manual review, not loaded into OpenClaw."] : [],
		...items.some((item) => item.kind === "manual") ? ["Some Hermes settings require manual review before they can be activated safely."] : []
	];
	return {
		providerId: "hermes",
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
export { buildHermesPlan as t };
