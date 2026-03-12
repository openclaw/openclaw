//#region src/agents/tool-catalog.ts
const CORE_TOOL_SECTION_ORDER = [
	{
		id: "fs",
		label: "Files"
	},
	{
		id: "runtime",
		label: "Runtime"
	},
	{
		id: "web",
		label: "Web"
	},
	{
		id: "memory",
		label: "Memory"
	},
	{
		id: "sessions",
		label: "Sessions"
	},
	{
		id: "ui",
		label: "UI"
	},
	{
		id: "messaging",
		label: "Messaging"
	},
	{
		id: "automation",
		label: "Automation"
	},
	{
		id: "nodes",
		label: "Nodes"
	},
	{
		id: "agents",
		label: "Agents"
	},
	{
		id: "media",
		label: "Media"
	}
];
const CORE_TOOL_DEFINITIONS = [
	{
		id: "read",
		label: "read",
		description: "Read file contents",
		sectionId: "fs",
		profiles: ["coding"]
	},
	{
		id: "write",
		label: "write",
		description: "Create or overwrite files",
		sectionId: "fs",
		profiles: ["coding"]
	},
	{
		id: "edit",
		label: "edit",
		description: "Make precise edits",
		sectionId: "fs",
		profiles: ["coding"]
	},
	{
		id: "apply_patch",
		label: "apply_patch",
		description: "Patch files (OpenAI)",
		sectionId: "fs",
		profiles: ["coding"]
	},
	{
		id: "exec",
		label: "exec",
		description: "Run shell commands",
		sectionId: "runtime",
		profiles: ["coding"]
	},
	{
		id: "process",
		label: "process",
		description: "Manage background processes",
		sectionId: "runtime",
		profiles: ["coding"]
	},
	{
		id: "web_search",
		label: "web_search",
		description: "Search the web",
		sectionId: "web",
		profiles: [],
		includeInOpenClawGroup: true
	},
	{
		id: "web_fetch",
		label: "web_fetch",
		description: "Fetch web content",
		sectionId: "web",
		profiles: [],
		includeInOpenClawGroup: true
	},
	{
		id: "memory_search",
		label: "memory_search",
		description: "Semantic search",
		sectionId: "memory",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "memory_get",
		label: "memory_get",
		description: "Read memory files",
		sectionId: "memory",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "sessions_list",
		label: "sessions_list",
		description: "List sessions",
		sectionId: "sessions",
		profiles: ["coding", "messaging"],
		includeInOpenClawGroup: true
	},
	{
		id: "sessions_history",
		label: "sessions_history",
		description: "Session history",
		sectionId: "sessions",
		profiles: ["coding", "messaging"],
		includeInOpenClawGroup: true
	},
	{
		id: "sessions_send",
		label: "sessions_send",
		description: "Send to session",
		sectionId: "sessions",
		profiles: ["coding", "messaging"],
		includeInOpenClawGroup: true
	},
	{
		id: "sessions_spawn",
		label: "sessions_spawn",
		description: "Spawn sub-agent",
		sectionId: "sessions",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "subagents",
		label: "subagents",
		description: "Manage sub-agents",
		sectionId: "sessions",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "session_status",
		label: "session_status",
		description: "Session status",
		sectionId: "sessions",
		profiles: [
			"minimal",
			"coding",
			"messaging"
		],
		includeInOpenClawGroup: true
	},
	{
		id: "browser",
		label: "browser",
		description: "Control web browser",
		sectionId: "ui",
		profiles: [],
		includeInOpenClawGroup: true
	},
	{
		id: "canvas",
		label: "canvas",
		description: "Control canvases",
		sectionId: "ui",
		profiles: [],
		includeInOpenClawGroup: true
	},
	{
		id: "message",
		label: "message",
		description: "Send messages",
		sectionId: "messaging",
		profiles: ["messaging"],
		includeInOpenClawGroup: true
	},
	{
		id: "cron",
		label: "cron",
		description: "Schedule tasks",
		sectionId: "automation",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "gateway",
		label: "gateway",
		description: "Gateway control",
		sectionId: "automation",
		profiles: [],
		includeInOpenClawGroup: true
	},
	{
		id: "nodes",
		label: "nodes",
		description: "Nodes + devices",
		sectionId: "nodes",
		profiles: [],
		includeInOpenClawGroup: true
	},
	{
		id: "agents_list",
		label: "agents_list",
		description: "List agents",
		sectionId: "agents",
		profiles: [],
		includeInOpenClawGroup: true
	},
	{
		id: "image",
		label: "image",
		description: "Image understanding",
		sectionId: "media",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "tts",
		label: "tts",
		description: "Text-to-speech conversion",
		sectionId: "media",
		profiles: [],
		includeInOpenClawGroup: true
	}
];
const CORE_TOOL_BY_ID = new Map(CORE_TOOL_DEFINITIONS.map((tool) => [tool.id, tool]));
function listCoreToolIdsForProfile(profile) {
	return CORE_TOOL_DEFINITIONS.filter((tool) => tool.profiles.includes(profile)).map((tool) => tool.id);
}
const CORE_TOOL_PROFILES = {
	minimal: { allow: listCoreToolIdsForProfile("minimal") },
	coding: { allow: listCoreToolIdsForProfile("coding") },
	messaging: { allow: listCoreToolIdsForProfile("messaging") },
	full: {}
};
function buildCoreToolGroupMap() {
	const sectionToolMap = /* @__PURE__ */ new Map();
	for (const tool of CORE_TOOL_DEFINITIONS) {
		const groupId = `group:${tool.sectionId}`;
		const list = sectionToolMap.get(groupId) ?? [];
		list.push(tool.id);
		sectionToolMap.set(groupId, list);
	}
	const openclawTools = CORE_TOOL_DEFINITIONS.filter((tool) => tool.includeInOpenClawGroup).map((tool) => tool.id);
	return {
		"group:openclaw": openclawTools,
		...Object.fromEntries(sectionToolMap.entries())
	};
}
const CORE_TOOL_GROUPS = buildCoreToolGroupMap();
const PROFILE_OPTIONS = [
	{
		id: "minimal",
		label: "Minimal"
	},
	{
		id: "coding",
		label: "Coding"
	},
	{
		id: "messaging",
		label: "Messaging"
	},
	{
		id: "full",
		label: "Full"
	}
];
function resolveCoreToolProfilePolicy(profile) {
	if (!profile) return;
	const resolved = CORE_TOOL_PROFILES[profile];
	if (!resolved) return;
	if (!resolved.allow && !resolved.deny) return;
	return {
		allow: resolved.allow ? [...resolved.allow] : void 0,
		deny: resolved.deny ? [...resolved.deny] : void 0
	};
}
function listCoreToolSections() {
	return CORE_TOOL_SECTION_ORDER.map((section) => ({
		id: section.id,
		label: section.label,
		tools: CORE_TOOL_DEFINITIONS.filter((tool) => tool.sectionId === section.id).map((tool) => ({
			id: tool.id,
			label: tool.label,
			description: tool.description
		}))
	})).filter((section) => section.tools.length > 0);
}
function resolveCoreToolProfiles(toolId) {
	const tool = CORE_TOOL_BY_ID.get(toolId);
	if (!tool) return [];
	return [...tool.profiles];
}
function isKnownCoreToolId(toolId) {
	return CORE_TOOL_BY_ID.has(toolId);
}

//#endregion
export { resolveCoreToolProfilePolicy as a, listCoreToolSections as i, PROFILE_OPTIONS as n, resolveCoreToolProfiles as o, isKnownCoreToolId as r, CORE_TOOL_GROUPS as t };