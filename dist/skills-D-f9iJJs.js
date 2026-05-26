import { n as MIGRATION_REASON_TARGET_EXISTS, o as createMigrationItem } from "./migration-DGUrqTK8.js";
import { f as sanitizeName, r as exists } from "./helpers-B_eVYvP7.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region extensions/migrate-hermes/skills.ts
async function buildSkillItems(params) {
	if (!params.source.skillsDir) return [];
	const entries = await fs.readdir(params.source.skillsDir, { withFileTypes: true }).catch(() => []);
	const plannedSkills = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const name = sanitizeName(entry.name);
		if (!name) continue;
		const source = path.join(params.source.skillsDir, entry.name);
		if (!await exists(path.join(source, "SKILL.md"))) continue;
		plannedSkills.push({
			name,
			source,
			target: path.join(params.targets.workspaceDir, "skills", name)
		});
	}
	const counts = /* @__PURE__ */ new Map();
	for (const skill of plannedSkills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
	const items = [];
	for (const skill of plannedSkills) {
		const collides = (counts.get(skill.name) ?? 0) > 1;
		const targetExists = await exists(skill.target);
		items.push(createMigrationItem({
			id: `skill:${skill.name}`,
			kind: "skill",
			action: "copy",
			source: skill.source,
			target: skill.target,
			status: collides ? "conflict" : targetExists && !params.overwrite ? "conflict" : "planned",
			reason: collides ? `multiple Hermes skill directories normalize to "${skill.name}"` : targetExists && !params.overwrite ? MIGRATION_REASON_TARGET_EXISTS : void 0
		}));
	}
	return items;
}
//#endregion
export { buildSkillItems as t };
