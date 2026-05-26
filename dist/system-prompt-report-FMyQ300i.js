import { r as buildBootstrapInjectionStats } from "./bootstrap-budget-CgtoXSfG.js";
//#region src/agents/system-prompt-report.ts
const toolReportEntryCache = /* @__PURE__ */ new WeakMap();
const toolSchemaStatsCache = /* @__PURE__ */ new WeakMap();
function extractBetween(input, startMarker, endMarker) {
	const start = input.indexOf(startMarker);
	if (start === -1) return "";
	const end = input.indexOf(endMarker, start + startMarker.length);
	return end === -1 ? input.slice(start) : input.slice(start, end);
}
function parseSkillBlocks(skillsPrompt) {
	const prompt = skillsPrompt.trim();
	if (!prompt) return [];
	return Array.from(prompt.matchAll(/<skill>[\s\S]*?<\/skill>/gi)).map((match) => match[0] ?? "").map((block) => {
		return {
			name: block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim() || "(unknown)",
			blockChars: block.length
		};
	}).filter((b) => b.blockChars > 0);
}
function buildToolSchemaStats(parameters) {
	if (!parameters || typeof parameters !== "object") return {
		schemaChars: 0,
		propertiesCount: null
	};
	const cached = toolSchemaStatsCache.get(parameters);
	if (cached) return cached;
	const stats = {
		schemaChars: (() => {
			try {
				return JSON.stringify(parameters).length;
			} catch {
				return 0;
			}
		})(),
		propertiesCount: (() => {
			const schema = parameters;
			const props = typeof schema.properties === "object" ? schema.properties : null;
			if (!props || typeof props !== "object") return null;
			return Object.keys(props).length;
		})()
	};
	toolSchemaStatsCache.set(parameters, stats);
	return stats;
}
function buildToolsEntries(tools) {
	return tools.map((tool) => {
		const cached = toolReportEntryCache.get(tool);
		if (cached) return cached;
		const entry = {
			name: tool.name,
			summaryChars: (tool.description?.trim() || tool.label?.trim() || "").length,
			...buildToolSchemaStats(tool.parameters)
		};
		toolReportEntryCache.set(tool, entry);
		return entry;
	});
}
function measureRenderedProjectContextChars(systemPrompt) {
	return extractBetween(systemPrompt, "\n# Project Context\n", "\n## Silent Replies\n").length;
}
function buildSystemPromptReport(params) {
	const systemPromptChars = params.systemPrompt.length;
	const projectContextChars = measureRenderedProjectContextChars(params.systemPrompt);
	const toolsEntries = buildToolsEntries(params.tools);
	const toolsSchemaChars = toolsEntries.reduce((sum, t) => sum + (t.schemaChars ?? 0), 0);
	const skillsEntries = parseSkillBlocks(params.skillsPrompt);
	return {
		source: params.source,
		generatedAt: params.generatedAt,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		provider: params.provider,
		model: params.model,
		workspaceDir: params.workspaceDir,
		bootstrapMaxChars: params.bootstrapMaxChars,
		bootstrapTotalMaxChars: params.bootstrapTotalMaxChars,
		...params.bootstrapTruncation ? { bootstrapTruncation: params.bootstrapTruncation } : {},
		sandbox: params.sandbox,
		systemPrompt: {
			chars: systemPromptChars,
			projectContextChars,
			nonProjectContextChars: Math.max(0, systemPromptChars - projectContextChars)
		},
		injectedWorkspaceFiles: buildBootstrapInjectionStats({
			bootstrapFiles: params.bootstrapFiles,
			injectedFiles: params.injectedFiles
		}),
		skills: {
			promptChars: params.skillsPrompt.length,
			entries: skillsEntries
		},
		tools: {
			listChars: 0,
			schemaChars: toolsSchemaChars,
			entries: toolsEntries
		}
	};
}
//#endregion
export { buildSystemPromptReport as t };
