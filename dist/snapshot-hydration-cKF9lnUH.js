//#region src/agents/skills/snapshot-hydration.ts
function hydrateResolvedSkills(snapshot, rebuild) {
	if (snapshot.resolvedSkills !== void 0) return snapshot;
	return {
		...snapshot,
		resolvedSkills: rebuild().resolvedSkills
	};
}
async function hydrateResolvedSkillsAsync(snapshot, rebuild) {
	if (snapshot.resolvedSkills !== void 0) return snapshot;
	return {
		...snapshot,
		resolvedSkills: (await rebuild()).resolvedSkills
	};
}
//#endregion
export { hydrateResolvedSkillsAsync as n, hydrateResolvedSkills as t };
