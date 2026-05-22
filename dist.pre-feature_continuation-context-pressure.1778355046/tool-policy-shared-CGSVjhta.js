import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/agents/tool-description-presets.ts
const EXEC_TOOL_DISPLAY_SUMMARY = "Run shell commands that start now.";
const PROCESS_TOOL_DISPLAY_SUMMARY = "Inspect and control running exec sessions.";
const CRON_TOOL_DISPLAY_SUMMARY = "Schedule cron jobs, reminders, and wake events.";
const SESSIONS_LIST_TOOL_DISPLAY_SUMMARY = "List visible sessions with mailbox filters and optional previews.";
const SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY = "Read sanitized message history for a visible session.";
const SESSIONS_SEND_TOOL_DISPLAY_SUMMARY = "Send a message to another visible session.";
const SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY = "Spawn sub-agent or ACP sessions.";
const SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY = "Spawn sub-agent sessions.";
const SESSION_STATUS_TOOL_DISPLAY_SUMMARY = "Show session status, usage, and model state.";
const UPDATE_PLAN_TOOL_DISPLAY_SUMMARY = "Track a short structured work plan.";
function describeSessionsListTool() {
	return ["List visible sessions with optional filters for kind, label, agentId, search, recent activity, derived titles, and last-message previews.", "Use this to discover a target session before calling sessions_history or sessions_send."].join(" ");
}
function describeSessionsHistoryTool() {
	return ["Fetch sanitized message history for a visible session.", "Supports limits and optional tool messages; use this to inspect another session before replying, debugging, or resuming work."].join(" ");
}
function describeSessionsSendTool() {
	return [
		"Send a message into another visible session by sessionKey or label.",
		"Thread-scoped chat sessions are rejected; target the parent channel session for inter-agent coordination.",
		"Use this to delegate follow-up work to an existing session; waits for the target run and returns the updated assistant reply when available."
	].join(" ");
}
function describeSessionsSpawnTool(options) {
	const baseDescription = [
		"Spawn a clean isolated session by default with `runtime=\"subagent\"` or `runtime=\"acp\"`.",
		options?.threadAvailable ? "`mode=\"run\"` is one-shot and `mode=\"session\"` is persistent and thread-bound." : "`mode=\"run\"` is one-shot background work.",
		"Subagents inherit the parent workspace directory automatically.",
		"For native subagents only, set `context=\"fork\"` when the child needs the current transcript context; otherwise omit it or use `context=\"isolated\"`.",
		"Use this when the work should happen in a fresh child session instead of the current one."
	];
	if (options?.acpAvailable === false) return baseDescription.map((line) => line.replace(" with `runtime=\"subagent\"` or `runtime=\"acp\"`", " with the native subagent runtime")).join(" ");
	return [
		...baseDescription.slice(0, 3),
		"`runtime=\"acp\"` is for external ACP harness ids such as codex, claude, gemini, or opencode, or agents configured with `agents.list[].runtime.type=\"acp\"`.",
		...baseDescription.slice(3)
	].join(" ");
}
function describeSessionStatusTool() {
	return [
		"Show a /status-equivalent session status card for the current or another visible session, including usage, time, cost when available, and linked background task context.",
		"Use `sessionKey=\"current\"` for the current session; do not use UI/client labels such as `openclaw-tui` as session keys.",
		"Optional `model` sets a per-session model override; `model=default` resets overrides.",
		"Use this for questions like what model is active or how a session is configured."
	].join(" ");
}
function describeUpdatePlanTool() {
	return [
		"Update the current structured work plan for this run.",
		"Use this for non-trivial multi-step work so the plan stays current while execution continues.",
		"Keep steps short, mark at most one step as `in_progress`, and skip this tool for simple one-step tasks."
	].join(" ");
}
//#endregion
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
		description: "Patch files",
		sectionId: "fs",
		profiles: ["coding"]
	},
	{
		id: "exec",
		label: "exec",
		description: EXEC_TOOL_DISPLAY_SUMMARY,
		sectionId: "runtime",
		profiles: ["coding"]
	},
	{
		id: "process",
		label: "process",
		description: PROCESS_TOOL_DISPLAY_SUMMARY,
		sectionId: "runtime",
		profiles: ["coding"]
	},
	{
		id: "code_execution",
		label: "code_execution",
		description: "Run sandboxed remote analysis",
		sectionId: "runtime",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "web_search",
		label: "web_search",
		description: "Search the web",
		sectionId: "web",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "web_fetch",
		label: "web_fetch",
		description: "Fetch web content",
		sectionId: "web",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "x_search",
		label: "x_search",
		description: "Search X posts",
		sectionId: "web",
		profiles: ["coding"],
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
		description: SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
		sectionId: "sessions",
		profiles: ["coding", "messaging"],
		includeInOpenClawGroup: true
	},
	{
		id: "sessions_history",
		label: "sessions_history",
		description: SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
		sectionId: "sessions",
		profiles: ["coding", "messaging"],
		includeInOpenClawGroup: true
	},
	{
		id: "sessions_send",
		label: "sessions_send",
		description: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
		sectionId: "sessions",
		profiles: ["coding", "messaging"],
		includeInOpenClawGroup: true
	},
	{
		id: "sessions_spawn",
		label: "sessions_spawn",
		description: SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
		sectionId: "sessions",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "sessions_yield",
		label: "sessions_yield",
		description: "End turn to receive sub-agent results",
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
		description: SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
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
		id: "heartbeat_respond",
		label: "heartbeat_respond",
		description: "Record heartbeat outcomes",
		sectionId: "automation",
		profiles: [],
		includeInOpenClawGroup: true
	},
	{
		id: "cron",
		label: "cron",
		description: CRON_TOOL_DISPLAY_SUMMARY,
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
		id: "update_plan",
		label: "update_plan",
		description: UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
		sectionId: "agents",
		profiles: ["coding"],
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
		id: "image_generate",
		label: "image_generate",
		description: "Image generation",
		sectionId: "media",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "music_generate",
		label: "music_generate",
		description: "Music generation",
		sectionId: "media",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "video_generate",
		label: "video_generate",
		description: "Video generation",
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
	coding: { allow: [...listCoreToolIdsForProfile("coding"), "bundle-mcp"] },
	messaging: { allow: [...listCoreToolIdsForProfile("messaging"), "bundle-mcp"] },
	full: { allow: ["*"] }
};
function buildCoreToolGroupMap() {
	const sectionToolMap = /* @__PURE__ */ new Map();
	for (const tool of CORE_TOOL_DEFINITIONS) {
		const groupId = `group:${tool.sectionId}`;
		const list = sectionToolMap.get(groupId) ?? [];
		list.push(tool.id);
		sectionToolMap.set(groupId, list);
	}
	return {
		"group:openclaw": CORE_TOOL_DEFINITIONS.filter((tool) => tool.includeInOpenClawGroup).map((tool) => tool.id),
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
//#region src/agents/tool-policy-shared.ts
const TOOL_NAME_ALIASES = {
	bash: "exec",
	"apply-patch": "apply_patch"
};
const TOOL_GROUPS = { ...CORE_TOOL_GROUPS };
function normalizeToolName(name) {
	const normalized = normalizeLowercaseStringOrEmpty(name);
	return TOOL_NAME_ALIASES[normalized] ?? normalized;
}
function normalizeToolList(list) {
	if (!list) return [];
	return list.map(normalizeToolName).filter(Boolean);
}
function expandToolGroups(list) {
	const normalized = normalizeToolList(list);
	const expanded = [];
	for (const value of normalized) {
		const group = TOOL_GROUPS[value];
		if (group) {
			expanded.push(...group);
			continue;
		}
		expanded.push(value);
	}
	return Array.from(new Set(expanded));
}
function resolveToolProfilePolicy(profile) {
	return resolveCoreToolProfilePolicy(profile);
}
//#endregion
export { describeSessionsSendTool as C, describeSessionsListTool as S, describeUpdatePlanTool as T, SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY as _, resolveToolProfilePolicy as a, describeSessionStatusTool as b, listCoreToolSections as c, EXEC_TOOL_DISPLAY_SUMMARY as d, PROCESS_TOOL_DISPLAY_SUMMARY as f, SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY as g, SESSIONS_SEND_TOOL_DISPLAY_SUMMARY as h, normalizeToolName as i, resolveCoreToolProfiles as l, SESSIONS_LIST_TOOL_DISPLAY_SUMMARY as m, expandToolGroups as n, PROFILE_OPTIONS as o, SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY as p, normalizeToolList as r, isKnownCoreToolId as s, TOOL_GROUPS as t, CRON_TOOL_DISPLAY_SUMMARY as u, SESSION_STATUS_TOOL_DISPLAY_SUMMARY as v, describeSessionsSpawnTool as w, describeSessionsHistoryTool as x, UPDATE_PLAN_TOOL_DISPLAY_SUMMARY as y };
