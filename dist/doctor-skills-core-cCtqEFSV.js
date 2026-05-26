//#region src/commands/doctor-skills-core.ts
function collectUnavailableAgentSkills(report) {
	return report.skills.filter((skill) => !skill.eligible && !skill.disabled && !skill.blockedByAllowlist && !skill.blockedByAgentFilter);
}
function disableUnavailableSkillsInConfig(config, skills) {
	if (skills.length === 0) return config;
	const entries = { ...config.skills?.entries };
	for (const skill of skills) entries[skill.skillKey] = {
		...entries[skill.skillKey],
		enabled: false
	};
	return {
		...config,
		skills: {
			...config.skills,
			entries
		}
	};
}
//#endregion
export { disableUnavailableSkillsInConfig as n, collectUnavailableAgentSkills as t };
