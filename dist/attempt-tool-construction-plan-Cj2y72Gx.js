import { f as expandToolGroups, m as normalizeToolName, r as buildPluginToolGroups, s as expandPolicyWithPluginGroups } from "./tool-policy-COX5DaEj.js";
import { n as isToolAllowedByPolicyName } from "./tool-policy-match-C9WqMgmG.js";
//#region src/agents/pi-embedded-runner/run/attempt-tool-construction-plan.ts
const BASE_CODING_TOOL_FACTORY_NAMES = new Set([
	"edit",
	"read",
	"write"
]);
const SHELL_CODING_TOOL_FACTORY_NAMES = new Set([
	"apply_patch",
	"exec",
	"process"
]);
const OPENCLAW_TOOL_FACTORY_NAMES = new Set([
	"agents_list",
	"canvas",
	"cron",
	"gateway",
	"heartbeat_respond",
	"heartbeat_response",
	"image",
	"image_generate",
	"message",
	"music_generate",
	"nodes",
	"pdf",
	"session_status",
	"sessions_history",
	"sessions_list",
	"sessions_send",
	"sessions_spawn",
	"sessions_yield",
	"subagents",
	"tts",
	"update_plan",
	"video_generate",
	"web_fetch",
	"web_search"
]);
const ALL_CODING_TOOL_CONSTRUCTION_PLAN = {
	includeBaseCodingTools: true,
	includeShellTools: true,
	includeChannelTools: true,
	includeOpenClawTools: true,
	includePluginTools: true
};
const NO_CODING_TOOL_CONSTRUCTION_PLAN = {
	includeBaseCodingTools: false,
	includeShellTools: false,
	includeChannelTools: false,
	includeOpenClawTools: false,
	includePluginTools: false
};
function cloneCodingToolConstructionPlan(plan) {
	return { ...plan };
}
function isBundleMcpAllowlistName(normalized) {
	return normalized === "bundle-mcp" || normalized.includes("__");
}
function isPluginGroupAllowlistName(normalized) {
	return normalized === "group:plugins";
}
function hasWildcardToolAllowlist(toolsAllow) {
	return toolsAllow.some((entry) => normalizeToolName(entry) === "*");
}
function isKnownLocalCodingToolName(normalized) {
	return BASE_CODING_TOOL_FACTORY_NAMES.has(normalized) || SHELL_CODING_TOOL_FACTORY_NAMES.has(normalized) || OPENCLAW_TOOL_FACTORY_NAMES.has(normalized);
}
function applyEmbeddedAttemptToolsAllow(tools, toolsAllow, options) {
	if (!toolsAllow) return tools;
	if (toolsAllow.length === 0) return [];
	if (hasWildcardToolAllowlist(toolsAllow)) return tools;
	const pluginGroups = options?.toolMeta ? buildPluginToolGroups({
		tools,
		toolMeta: options.toolMeta
	}) : void 0;
	const policy = pluginGroups ? expandPolicyWithPluginGroups({ allow: toolsAllow }, pluginGroups) : { allow: toolsAllow };
	return tools.filter((tool) => isToolAllowedByPolicyName(tool.name, policy));
}
function mergeForcedEmbeddedAttemptToolsAllow(toolsAllow, params) {
	if (!params.forceMessageTool || toolsAllow === void 0 || hasWildcardToolAllowlist(toolsAllow)) return toolsAllow;
	if (toolsAllow.length === 0) return ["message"];
	return new Set(toolsAllow.map((entry) => normalizeToolName(entry))).has("message") ? toolsAllow : [...toolsAllow, "message"];
}
function resolveCodingToolConstructionPlanForAllowlist(toolsAllow) {
	if (!toolsAllow) return cloneCodingToolConstructionPlan(ALL_CODING_TOOL_CONSTRUCTION_PLAN);
	if (toolsAllow.length === 0) return cloneCodingToolConstructionPlan(NO_CODING_TOOL_CONSTRUCTION_PLAN);
	if (hasWildcardToolAllowlist(toolsAllow)) return cloneCodingToolConstructionPlan(ALL_CODING_TOOL_CONSTRUCTION_PLAN);
	const normalized = expandToolGroups(toolsAllow).map((entry) => normalizeToolName(entry)).filter(Boolean);
	const includeBaseCodingTools = normalized.some((name) => BASE_CODING_TOOL_FACTORY_NAMES.has(name));
	const includeShellTools = normalized.some((name) => SHELL_CODING_TOOL_FACTORY_NAMES.has(name));
	const includeOpenClawTools = normalized.some((name) => OPENCLAW_TOOL_FACTORY_NAMES.has(name));
	const includePluginTools = normalized.some((name) => name === "group:plugins" || !isBundleMcpAllowlistName(name) && !isKnownLocalCodingToolName(name));
	return {
		includeBaseCodingTools,
		includeShellTools,
		includeChannelTools: includePluginTools,
		includeOpenClawTools,
		includePluginTools
	};
}
function resolveEmbeddedAttemptToolConstructionPlan(params) {
	if (params.disableTools === true || params.isRawModelRun === true) return {
		constructTools: false,
		includeCoreTools: false,
		codingToolConstructionPlan: cloneCodingToolConstructionPlan(NO_CODING_TOOL_CONSTRUCTION_PLAN)
	};
	const toolsAllow = mergeForcedEmbeddedAttemptToolsAllow(params.toolsAllow, { forceMessageTool: params.forceMessageTool });
	const codingToolConstructionPlan = resolveCodingToolConstructionPlanForAllowlist(toolsAllow);
	const includeCoreTools = codingToolConstructionPlan.includeBaseCodingTools || codingToolConstructionPlan.includeShellTools || codingToolConstructionPlan.includeOpenClawTools;
	return {
		constructTools: includeCoreTools || codingToolConstructionPlan.includeChannelTools || codingToolConstructionPlan.includePluginTools,
		includeCoreTools,
		...toolsAllow ? { runtimeToolAllowlist: toolsAllow } : {},
		codingToolConstructionPlan
	};
}
function shouldCreateBundleMcpRuntimeForAttempt(params) {
	if (!params.toolsEnabled || params.disableTools === true) return false;
	if (!params.toolsAllow) return true;
	if (params.toolsAllow.length === 0) return false;
	if (hasWildcardToolAllowlist(params.toolsAllow)) return true;
	return params.toolsAllow.some((toolName) => {
		const normalized = normalizeToolName(toolName);
		return isBundleMcpAllowlistName(normalized) || isPluginGroupAllowlistName(normalized);
	});
}
function shouldCreateBundleLspRuntimeForAttempt(params) {
	if (!params.toolsEnabled || params.disableTools === true) return false;
	if (!params.toolsAllow) return true;
	if (params.toolsAllow.length === 0) return false;
	if (hasWildcardToolAllowlist(params.toolsAllow)) return true;
	return params.toolsAllow.some((toolName) => {
		return normalizeToolName(toolName).startsWith("lsp_");
	});
}
//#endregion
export { shouldCreateBundleMcpRuntimeForAttempt as a, shouldCreateBundleLspRuntimeForAttempt as i, mergeForcedEmbeddedAttemptToolsAllow as n, resolveEmbeddedAttemptToolConstructionPlan as r, applyEmbeddedAttemptToolsAllow as t };
