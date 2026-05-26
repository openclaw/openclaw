import { n as MIGRATION_REASON_TARGET_EXISTS, o as createMigrationItem } from "./migration-DGUrqTK8.js";
import { r as exists } from "./helpers-DcrnbAnr.js";
import path from "node:path";
//#region extensions/migrate-claude/memory.ts
async function addMemoryItem(params) {
	if (!params.source) return;
	const targetExists = await exists(params.target);
	const action = params.copyWhenMissing && !targetExists ? "copy" : "append";
	params.items.push(createMigrationItem({
		id: params.id,
		kind: params.target.endsWith("AGENTS.md") ? "workspace" : "memory",
		action,
		source: params.source,
		target: params.target,
		status: action === "copy" && targetExists && !params.overwrite ? "conflict" : "planned",
		reason: action === "copy" && targetExists && !params.overwrite ? MIGRATION_REASON_TARGET_EXISTS : void 0,
		details: { sourceLabel: params.sourceLabel }
	}));
}
async function buildMemoryItems(params) {
	const items = [];
	await addMemoryItem({
		items,
		id: "workspace:CLAUDE.md",
		source: params.source.projectMemoryPath,
		target: path.join(params.targets.workspaceDir, "AGENTS.md"),
		sourceLabel: "project CLAUDE.md",
		copyWhenMissing: true,
		overwrite: params.overwrite
	});
	await addMemoryItem({
		items,
		id: "workspace:.claude/CLAUDE.md",
		source: params.source.projectDotClaudeMemoryPath,
		target: path.join(params.targets.workspaceDir, "AGENTS.md"),
		sourceLabel: "project .claude/CLAUDE.md",
		overwrite: params.overwrite
	});
	await addMemoryItem({
		items,
		id: "memory:user-CLAUDE.md",
		source: params.source.userMemoryPath,
		target: path.join(params.targets.workspaceDir, "USER.md"),
		sourceLabel: "user ~/.claude/CLAUDE.md",
		overwrite: params.overwrite
	});
	return items;
}
//#endregion
export { buildMemoryItems as t };
