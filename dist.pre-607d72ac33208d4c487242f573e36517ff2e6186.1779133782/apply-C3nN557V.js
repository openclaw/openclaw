import { d as markMigrationItemSkipped, v as summarizeMigrationItems } from "./migration-BJpcIQ2K.js";
import { i as writeMigrationReport, n as copyMigrationFileItem, r as withCachedMigrationConfigRuntime, t as archiveMigrationItem } from "./migration-runtime-CxQRb-tZ.js";
import { t as appendItem } from "./helpers-BtBG5xua.js";
import { n as applyManualItem, t as applyConfigItem } from "./config-DryWhm-3.js";
import { t as applyModelItem } from "./model-DxO1ro6J.js";
import { t as applySecretItem } from "./secrets-CdXXL1Nk.js";
import { t as resolveTargets } from "./targets-D-3K_PF5.js";
import { t as buildHermesPlan } from "./plan-Dhawx9Jb.js";
import path from "node:path";
//#region extensions/migrate-hermes/apply.ts
const HERMES_REASON_BLOCKED_BY_APPLY_CONFLICT = "blocked by earlier apply conflict";
async function applyHermesPlan(params) {
	const plan = params.plan ?? await buildHermesPlan(params.ctx);
	const reportDir = params.ctx.reportDir ?? path.join(params.ctx.stateDir, "migration", "hermes");
	const targets = resolveTargets(params.ctx);
	const items = [];
	const runtime = withCachedMigrationConfigRuntime(params.ctx.runtime ?? params.runtime, params.ctx.config);
	const applyCtx = {
		...params.ctx,
		runtime
	};
	let blockedByApplyConflict = false;
	for (const item of plan.items) {
		if (item.status !== "planned") {
			items.push(item);
			continue;
		}
		if (blockedByApplyConflict) {
			items.push(markMigrationItemSkipped(item, HERMES_REASON_BLOCKED_BY_APPLY_CONFLICT));
			continue;
		}
		let appliedItem;
		if (item.id === "config:default-model") appliedItem = await applyModelItem(applyCtx, item);
		else if (item.kind === "config") appliedItem = await applyConfigItem(applyCtx, item);
		else if (item.kind === "manual") appliedItem = applyManualItem(item);
		else if (item.action === "archive") appliedItem = await archiveMigrationItem(item, reportDir);
		else if (item.kind === "secret") appliedItem = await applySecretItem(params.ctx, item, targets);
		else if (item.action === "append") appliedItem = await appendItem(item);
		else appliedItem = await copyMigrationFileItem(item, reportDir, { overwrite: params.ctx.overwrite });
		items.push(appliedItem);
		if (item.kind === "config" && (appliedItem.status === "conflict" || appliedItem.status === "error")) blockedByApplyConflict = true;
	}
	const result = {
		...plan,
		items,
		summary: summarizeMigrationItems(items),
		backupPath: params.ctx.backupPath,
		reportDir
	};
	await writeMigrationReport(result, { title: "Hermes Migration Report" });
	return result;
}
//#endregion
export { applyHermesPlan as t };
