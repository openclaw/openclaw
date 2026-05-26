import { a as createMigrationConfigPatchItem, c as hasMigrationConfigPatchConflict, i as applyMigrationManualItem, n as MIGRATION_REASON_TARGET_EXISTS, r as applyMigrationConfigPatchItem, s as createMigrationManualItem } from "./migration-DGUrqTK8.js";
import { a as isRecord, l as sanitizeName, n as childRecord, o as readJsonObject } from "./helpers-DcrnbAnr.js";
//#region extensions/migrate-claude/config.ts
function mapMcpServers(raw) {
	if (!isRecord(raw)) return;
	const mapped = {};
	for (const [name, value] of Object.entries(raw)) {
		if (!name.trim() || !isRecord(value)) continue;
		const next = {};
		for (const key of [
			"command",
			"args",
			"env",
			"cwd",
			"workingDirectory",
			"url",
			"type",
			"transport",
			"headers",
			"connectionTimeoutMs"
		]) if (value[key] !== void 0) next[key] = value[key];
		if (Object.keys(next).length > 0) mapped[name] = next;
	}
	return Object.keys(mapped).length > 0 ? mapped : void 0;
}
async function collectMcpSources(source) {
	const sources = [];
	const projectMcp = await readJsonObject(source.projectMcpPath);
	const projectServers = mapMcpServers(projectMcp.mcpServers ?? projectMcp);
	if (projectServers && source.projectMcpPath) sources.push({
		sourceId: "project-mcp",
		sourceLabel: "project .mcp.json",
		sourcePath: source.projectMcpPath,
		servers: projectServers
	});
	const claudeJson = await readJsonObject(source.userClaudeJsonPath);
	const userServers = mapMcpServers(claudeJson.mcpServers);
	if (userServers && source.userClaudeJsonPath) sources.push({
		sourceId: "user-claude-json",
		sourceLabel: "user ~/.claude.json",
		sourcePath: source.userClaudeJsonPath,
		servers: userServers
	});
	if (source.projectDir) {
		const projectScopedServers = mapMcpServers(childRecord(childRecord(claudeJson, "projects"), source.projectDir).mcpServers);
		if (projectScopedServers && source.userClaudeJsonPath) sources.push({
			sourceId: "user-claude-json-project",
			sourceLabel: "project entry in ~/.claude.json",
			sourcePath: source.userClaudeJsonPath,
			servers: projectScopedServers
		});
	}
	const desktopServers = mapMcpServers((await readJsonObject(source.desktopConfigPath)).mcpServers);
	if (desktopServers && source.desktopConfigPath) sources.push({
		sourceId: "desktop",
		sourceLabel: "Claude Desktop config",
		sourcePath: source.desktopConfigPath,
		servers: desktopServers
	});
	return sources;
}
async function buildConfigItems(params) {
	const items = [];
	const mcpSources = await collectMcpSources(params.source);
	const counts = /* @__PURE__ */ new Map();
	for (const mcpSource of mcpSources) for (const name of Object.keys(mcpSource.servers)) counts.set(name, (counts.get(name) ?? 0) + 1);
	for (const mcpSource of mcpSources) for (const [name, value] of Object.entries(mcpSource.servers)) {
		const patch = { [name]: value };
		const duplicate = (counts.get(name) ?? 0) > 1;
		const conflict = duplicate || !params.ctx.overwrite && hasMigrationConfigPatchConflict(params.ctx.config, ["mcp", "servers"], patch);
		items.push(createMigrationConfigPatchItem({
			id: `config:mcp-server:${sanitizeName(mcpSource.sourceId)}:${sanitizeName(name)}`,
			source: mcpSource.sourcePath,
			target: `mcp.servers.${name}`,
			path: ["mcp", "servers"],
			value: patch,
			message: `Import Claude MCP server "${name}" from ${mcpSource.sourceLabel}.`,
			conflict,
			reason: duplicate ? `multiple Claude MCP sources define "${name}"` : MIGRATION_REASON_TARGET_EXISTS,
			details: { sourceLabel: mcpSource.sourceLabel }
		}));
	}
	for (const settingsPath of [
		params.source.userSettingsPath,
		params.source.userLocalSettingsPath,
		params.source.projectSettingsPath,
		params.source.projectLocalSettingsPath
	]) {
		const settings = await readJsonObject(settingsPath);
		if (settingsPath && settings.hooks !== void 0) items.push(createMigrationManualItem({
			id: `manual:hooks:${sanitizeName(settingsPath)}`,
			source: settingsPath,
			message: "Claude hooks were found but are not enabled automatically.",
			recommendation: "Review hook commands before recreating equivalent OpenClaw automation."
		}));
		if (settingsPath && settings.permissions !== void 0) items.push(createMigrationManualItem({
			id: `manual:permissions:${sanitizeName(settingsPath)}`,
			source: settingsPath,
			message: "Claude permission settings were found but are not translated automatically.",
			recommendation: "Review deny and allow rules manually. Do not import broad allow rules without a policy review."
		}));
		if (settingsPath && settings.env !== void 0) items.push(createMigrationManualItem({
			id: `manual:env:${sanitizeName(settingsPath)}`,
			source: settingsPath,
			message: "Claude environment defaults were found but are not copied automatically.",
			recommendation: "Move non-secret values manually and store credentials through OpenClaw credential flows."
		}));
	}
	return items;
}
async function applyConfigItem(ctx, item) {
	return applyMigrationConfigPatchItem(ctx, item);
}
function applyManualItem(item) {
	return applyMigrationManualItem(item);
}
//#endregion
export { applyManualItem as n, buildConfigItems as r, applyConfigItem as t };
