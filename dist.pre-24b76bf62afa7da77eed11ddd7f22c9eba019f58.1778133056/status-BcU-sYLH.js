import { i as normalizeToolName } from "./tool-policy-shared-C_ey7AIg.js";
import { t as describeToolForVerbose } from "./tool-description-summary-C4n0dSBO.js";
import "./command-status-builders-TTmVgkI3.js";
import "./status-message-CQdAagcK.js";
//#region src/auto-reply/status.ts
function sortToolsMessageItems(items) {
	return items.toSorted((a, b) => a.name.localeCompare(b.name));
}
function formatCompactToolEntry(tool) {
	if (tool.source === "plugin") return tool.pluginId ? `${tool.id} (${tool.pluginId})` : tool.id;
	if (tool.source === "channel") return tool.channelId ? `${tool.id} (${tool.channelId})` : tool.id;
	return tool.id;
}
function formatVerboseToolDescription(tool) {
	return describeToolForVerbose({
		rawDescription: tool.rawDescription,
		fallback: tool.description
	});
}
function buildToolsMessage(result, options) {
	const groups = result.groups.map((group) => ({
		label: group.label,
		tools: sortToolsMessageItems(group.tools.map((tool) => ({
			id: normalizeToolName(tool.id),
			name: tool.label,
			description: tool.description || "Tool",
			rawDescription: tool.rawDescription || tool.description || "Tool",
			source: tool.source,
			pluginId: tool.pluginId,
			channelId: tool.channelId
		})))
	})).filter((group) => group.tools.length > 0);
	if (groups.length === 0) return [
		"No tools are available for this agent right now.",
		"",
		`Profile: ${result.profile}`
	].join("\n");
	const verbose = options?.verbose === true;
	const lines = verbose ? [
		"Available tools",
		"",
		`Profile: ${result.profile}`,
		"What this agent can use right now:"
	] : [
		"Available tools",
		"",
		`Profile: ${result.profile}`
	];
	for (const group of groups) {
		lines.push("", group.label);
		if (verbose) {
			for (const tool of group.tools) lines.push(`  ${tool.name} - ${formatVerboseToolDescription(tool)}`);
			continue;
		}
		lines.push(`  ${group.tools.map((tool) => formatCompactToolEntry(tool)).join(", ")}`);
	}
	if (verbose) lines.push("", "Tool availability depends on this agent's configuration.");
	else lines.push("", "Use /tools verbose for descriptions.");
	if (result.notices?.length) {
		lines.push("", "Notes");
		for (const notice of result.notices) lines.push(`  ${notice.message}`);
	}
	return lines.join("\n");
}
//#endregion
export { buildToolsMessage as t };
