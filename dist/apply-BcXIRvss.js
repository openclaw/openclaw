import { v as summarizeMigrationItems } from "./migration-DGUrqTK8.js";
import { i as writeMigrationReport, n as copyMigrationFileItem, r as withCachedMigrationConfigRuntime, t as archiveMigrationItem } from "./migration-runtime-B3XPHvRB.js";
import { t as appendItem } from "./helpers-DcrnbAnr.js";
import { n as applyManualItem, t as applyConfigItem } from "./config-Da3L9RL8.js";
import { t as applyGeneratedSkillItem } from "./skills-BrrciZEb.js";
import { t as buildClaudePlan } from "./plan-DWM1zB_M.js";
import path from "node:path";
//#region extensions/migrate-claude/apply.ts
async function applyClaudePlan(params) {
	const plan = params.plan ?? await buildClaudePlan(params.ctx);
	const reportDir = params.ctx.reportDir ?? path.join(params.ctx.stateDir, "migration", "claude");
	const runtime = withCachedMigrationConfigRuntime(params.ctx.runtime ?? params.runtime, params.ctx.config);
	const applyCtx = {
		...params.ctx,
		runtime
	};
	const items = [];
	for (const item of plan.items) {
		if (item.status !== "planned") {
			items.push(item);
			continue;
		}
		if (item.kind === "config") items.push(await applyConfigItem(applyCtx, item));
		else if (item.kind === "manual") items.push(applyManualItem(item));
		else if (item.action === "archive") items.push(await archiveMigrationItem(item, reportDir));
		else if (item.action === "append") items.push(await appendItem(item));
		else if (item.action === "create" && item.kind === "skill") items.push(await applyGeneratedSkillItem(item, { overwrite: params.ctx.overwrite }));
		else items.push(await copyMigrationFileItem(item, reportDir, { overwrite: params.ctx.overwrite }));
	}
	const result = {
		...plan,
		items,
		summary: summarizeMigrationItems(items),
		backupPath: params.ctx.backupPath,
		reportDir
	};
	await writeMigrationReport(result, { title: "Claude Migration Report" });
	return result;
}
//#endregion
export { applyClaudePlan as t };
