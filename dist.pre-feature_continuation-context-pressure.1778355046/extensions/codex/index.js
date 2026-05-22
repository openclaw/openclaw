import { S as resolveDefaultAgentId, v as resolveAgentConfig, x as resolveAgentWorkspaceDir } from "../../agent-scope-CcybJBoN.js";
import { t as definePluginEntry } from "../../plugin-entry-6pkoHhQg.js";
import { n as resolveLivePluginConfigObject } from "../../plugin-config-runtime-BANFJK51.js";
import "../../agent-runtime-DAulW69A.js";
import { n as MIGRATION_REASON_TARGET_EXISTS, o as createMigrationItem, s as createMigrationManualItem, v as summarizeMigrationItems } from "../../migration-7BZlk8zG.js";
import { i as writeMigrationReport, n as copyMigrationFileItem, t as archiveMigrationItem } from "../../migration-runtime-B6NMgj72.js";
import { t as createCodexAppServerAgentHarness } from "./harness-DEK9NU9G.js";
import { t as buildCodexMediaUnderstandingProvider } from "./media-understanding-provider-B9dv4atP.js";
import { t as buildCodexProvider } from "./provider-DL2UQx5g.js";
import { f as describeControlFailure, r as formatCodexDisplayText } from "./command-formatters-DbrDOfwg.js";
import { n as handleCodexConversationInboundClaim, t as handleCodexConversationBindingResolved } from "./conversation-binding-DNxsaMjU.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
//#region extensions/codex/src/commands.ts
function createCodexCommand(options) {
	return {
		name: "codex",
		description: "Inspect and control the Codex app-server harness",
		ownership: "reserved",
		agentPromptGuidance: ["Native Codex app-server plugin is available (`/codex ...`). For Codex bind/control/thread/resume/steer/stop requests, prefer `/codex bind`, `/codex threads`, `/codex resume`, `/codex steer`, and `/codex stop` over ACP.", "Use ACP for Codex only when the user explicitly asks for ACP/acpx or wants to test the ACP path."],
		acceptsArgs: true,
		requireAuth: true,
		handler: (ctx) => handleCodexCommand(ctx, options)
	};
}
async function handleCodexCommand(ctx, options = {}) {
	const { handleCodexSubcommand } = await import("./command-handlers-BGuTZ2rh.js");
	try {
		return await handleCodexSubcommand(ctx, options);
	} catch (error) {
		return { text: `Codex command failed: ${formatCodexDisplayText(describeControlFailure(error))}` };
	}
}
//#endregion
//#region extensions/codex/src/migration/helpers.ts
async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
async function isDirectory(filePath) {
	if (!filePath) return false;
	try {
		return (await fs.stat(filePath)).isDirectory();
	} catch {
		return false;
	}
}
function resolveUserHomeDir() {
	return process.env.HOME?.trim() || os.homedir();
}
function resolveHomePath(value) {
	if (value === "~") return resolveUserHomeDir();
	if (value.startsWith("~/")) return path.join(resolveUserHomeDir(), value.slice(2));
	return path.resolve(value);
}
function sanitizeName(value) {
	return value.trim().toLowerCase().replaceAll(/[^a-z0-9._-]+/gu, "-").replaceAll(/^-+|-+$/gu, "").slice(0, 64);
}
async function readJsonObject(filePath) {
	if (!filePath) return {};
	try {
		const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
//#endregion
//#region extensions/codex/src/migration/source.ts
const SKILL_FILENAME = "SKILL.md";
const MAX_SCAN_DEPTH = 6;
const MAX_DISCOVERED_DIRS = 2e3;
function defaultCodexHome() {
	return resolveHomePath(process.env.CODEX_HOME?.trim() || "~/.codex");
}
function personalAgentsSkillsDir() {
	return path.join(resolveUserHomeDir(), ".agents", "skills");
}
async function safeReadDir(dir) {
	return await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
}
async function discoverSkillDirs(params) {
	if (!params.root || !await isDirectory(params.root)) return [];
	const discovered = [];
	async function visit(dir, depth) {
		if (discovered.length >= MAX_DISCOVERED_DIRS || depth > MAX_SCAN_DEPTH) return;
		const name = path.basename(dir);
		if (params.excludeSystem && depth === 1 && name === ".system") return;
		if (await exists(path.join(dir, SKILL_FILENAME))) {
			discovered.push({
				name,
				source: dir,
				sourceLabel: params.sourceLabel
			});
			return;
		}
		for (const entry of await safeReadDir(dir)) {
			if (!entry.isDirectory()) continue;
			await visit(path.join(dir, entry.name), depth + 1);
		}
	}
	await visit(params.root, 0);
	return discovered;
}
async function discoverPluginDirs(codexHome) {
	const root = path.join(codexHome, "plugins", "cache");
	if (!await isDirectory(root)) return [];
	const discovered = /* @__PURE__ */ new Map();
	async function visit(dir, depth) {
		if (discovered.size >= MAX_DISCOVERED_DIRS || depth > MAX_SCAN_DEPTH) return;
		const manifestPath = path.join(dir, ".codex-plugin", "plugin.json");
		if (await exists(manifestPath)) {
			const manifest = await readJsonObject(manifestPath);
			const name = (typeof manifest.name === "string" ? manifest.name.trim() : "") || path.basename(dir);
			discovered.set(dir, {
				name,
				source: dir,
				manifestPath
			});
			return;
		}
		for (const entry of await safeReadDir(dir)) {
			if (!entry.isDirectory()) continue;
			await visit(path.join(dir, entry.name), depth + 1);
		}
	}
	await visit(root, 0);
	return [...discovered.values()].toSorted((a, b) => a.source.localeCompare(b.source));
}
async function discoverCodexSource(input) {
	const codexHome = resolveHomePath(input?.trim() || defaultCodexHome());
	const codexSkillsDir = path.join(codexHome, "skills");
	const agentsSkillsDir = personalAgentsSkillsDir();
	const configPath = path.join(codexHome, "config.toml");
	const hooksPath = path.join(codexHome, "hooks", "hooks.json");
	const codexSkills = await discoverSkillDirs({
		root: codexSkillsDir,
		sourceLabel: "Codex CLI skill",
		excludeSystem: true
	});
	const personalAgentSkills = await discoverSkillDirs({
		root: agentsSkillsDir,
		sourceLabel: "personal AgentSkill"
	});
	const plugins = await discoverPluginDirs(codexHome);
	const archivePaths = [];
	if (await exists(configPath)) archivePaths.push({
		id: "archive:config.toml",
		path: configPath,
		relativePath: "config.toml",
		message: "Codex config is archived for manual review; it is not activated automatically."
	});
	if (await exists(hooksPath)) archivePaths.push({
		id: "archive:hooks/hooks.json",
		path: hooksPath,
		relativePath: "hooks/hooks.json",
		message: "Codex native hooks are archived for manual review because they can execute commands."
	});
	const skills = [...codexSkills, ...personalAgentSkills].toSorted((a, b) => a.source.localeCompare(b.source));
	const high = Boolean(codexSkills.length || plugins.length || archivePaths.length);
	const medium = personalAgentSkills.length > 0;
	return {
		root: codexHome,
		confidence: high ? "high" : medium ? "medium" : "low",
		codexHome,
		...await isDirectory(codexSkillsDir) ? { codexSkillsDir } : {},
		...await isDirectory(agentsSkillsDir) ? { personalAgentsSkillsDir: agentsSkillsDir } : {},
		...await exists(configPath) ? { configPath } : {},
		...await exists(hooksPath) ? { hooksPath } : {},
		skills,
		plugins,
		archivePaths
	};
}
function hasCodexSource(source) {
	return source.confidence !== "low";
}
//#endregion
//#region extensions/codex/src/migration/targets.ts
function resolveCodexMigrationTargets(ctx) {
	const cfg = ctx.config;
	const agentId = resolveDefaultAgentId(cfg);
	const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
	const configuredAgentDir = resolveAgentConfig(cfg, agentId)?.agentDir?.trim();
	return {
		workspaceDir,
		agentDir: ctx.runtime?.agent?.resolveAgentDir(cfg, agentId) ?? (configuredAgentDir ? resolveHomePath(configuredAgentDir) : void 0) ?? path.join(ctx.stateDir, "agents", agentId, "agent")
	};
}
//#endregion
//#region extensions/codex/src/migration/plan.ts
function uniqueSkillName(skill, counts) {
	const base = sanitizeName(skill.name) || "codex-skill";
	if ((counts.get(base) ?? 0) <= 1) return base;
	return sanitizeName([
		"codex",
		sanitizeName(path.basename(path.dirname(skill.source))),
		base
	].filter(Boolean).join("-")) || base;
}
async function buildSkillItems(params) {
	const baseCounts = /* @__PURE__ */ new Map();
	for (const skill of params.skills) {
		const base = sanitizeName(skill.name) || "codex-skill";
		baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
	}
	const resolvedCounts = /* @__PURE__ */ new Map();
	const planned = params.skills.map((skill) => {
		const name = uniqueSkillName(skill, baseCounts);
		resolvedCounts.set(name, (resolvedCounts.get(name) ?? 0) + 1);
		return {
			skill,
			name,
			target: path.join(params.workspaceDir, "skills", name)
		};
	});
	const items = [];
	for (const item of planned) {
		const collides = (resolvedCounts.get(item.name) ?? 0) > 1;
		const targetExists = await exists(item.target);
		items.push(createMigrationItem({
			id: `skill:${item.name}`,
			kind: "skill",
			action: "copy",
			source: item.skill.source,
			target: item.target,
			status: collides ? "conflict" : targetExists && !params.overwrite ? "conflict" : "planned",
			reason: collides ? `multiple Codex skills normalize to "${item.name}"` : targetExists && !params.overwrite ? MIGRATION_REASON_TARGET_EXISTS : void 0,
			message: `Copy ${item.skill.sourceLabel} into this OpenClaw agent workspace.`,
			details: {
				skillName: item.name,
				sourceLabel: item.skill.sourceLabel
			}
		}));
	}
	return items;
}
async function buildCodexMigrationPlan(ctx) {
	const source = await discoverCodexSource(ctx.source);
	if (!hasCodexSource(source)) throw new Error(`Codex state was not found at ${source.root}. Pass --from <path> if it lives elsewhere.`);
	const targets = resolveCodexMigrationTargets(ctx);
	const items = [];
	items.push(...await buildSkillItems({
		skills: source.skills,
		workspaceDir: targets.workspaceDir,
		overwrite: ctx.overwrite
	}));
	for (const [index, plugin] of source.plugins.entries()) items.push(createMigrationManualItem({
		id: `plugin:${sanitizeName(plugin.name) || sanitizeName(path.basename(plugin.source))}:${index + 1}`,
		source: plugin.source,
		message: `Codex native plugin "${plugin.name}" was found but not activated automatically.`,
		recommendation: "Review the plugin bundle first, then install trusted compatible plugins with openclaw plugins install <path>."
	}));
	for (const archivePath of source.archivePaths) items.push(createMigrationItem({
		id: archivePath.id,
		kind: "archive",
		action: "archive",
		source: archivePath.path,
		message: archivePath.message ?? "Archived in the migration report for manual review; not imported into live config.",
		details: { archiveRelativePath: archivePath.relativePath }
	}));
	const warnings = [
		...items.some((item) => item.status === "conflict") ? ["Conflicts were found. Re-run with --overwrite to replace conflicting skill targets after item-level backups."] : [],
		...source.plugins.length > 0 ? ["Codex native plugins are reported for manual review only. OpenClaw does not auto-activate plugin bundles, hooks, MCP servers, or apps from another Codex home."] : [],
		...source.archivePaths.length > 0 ? ["Codex config and hook files are archive-only. They are preserved in the migration report, not loaded into OpenClaw automatically."] : []
	];
	return {
		providerId: "codex",
		source: source.root,
		target: targets.workspaceDir,
		summary: summarizeMigrationItems(items),
		items,
		warnings,
		nextSteps: ["Run openclaw doctor after applying the migration.", "Review skipped Codex plugin/config/hook items before installing or recreating them in OpenClaw."],
		metadata: {
			agentDir: targets.agentDir,
			codexHome: source.codexHome,
			codexSkillsDir: source.codexSkillsDir,
			personalAgentsSkillsDir: source.personalAgentsSkillsDir
		}
	};
}
//#endregion
//#region extensions/codex/src/migration/apply.ts
async function applyCodexMigrationPlan(params) {
	const plan = params.plan ?? await buildCodexMigrationPlan(params.ctx);
	const reportDir = params.ctx.reportDir ?? path.join(params.ctx.stateDir, "migration", "codex");
	const items = [];
	for (const item of plan.items) {
		if (item.status !== "planned") {
			items.push(item);
			continue;
		}
		if (item.action === "archive") items.push(await archiveMigrationItem(item, reportDir));
		else items.push(await copyMigrationFileItem(item, reportDir, { overwrite: params.ctx.overwrite }));
	}
	const result = {
		...plan,
		items,
		summary: summarizeMigrationItems(items),
		backupPath: params.ctx.backupPath,
		reportDir
	};
	await writeMigrationReport(result, { title: "Codex Migration Report" });
	return result;
}
//#endregion
//#region extensions/codex/src/migration/provider.ts
function buildCodexMigrationProvider() {
	return {
		id: "codex",
		label: "Codex",
		description: "Inventory and promote Codex CLI skills while keeping Codex native plugins and hooks explicit.",
		async detect(ctx) {
			const source = await discoverCodexSource(ctx.source);
			const found = hasCodexSource(source);
			return {
				found,
				source: source.root,
				label: "Codex",
				confidence: found ? source.confidence : "low",
				message: found ? "Codex state found." : "Codex state not found."
			};
		},
		plan: buildCodexMigrationPlan,
		async apply(ctx, plan) {
			return await applyCodexMigrationPlan({
				ctx,
				plan
			});
		}
	};
}
//#endregion
//#region extensions/codex/index.ts
var codex_default = definePluginEntry({
	id: "codex",
	name: "Codex",
	description: "Codex app-server harness and Codex-managed GPT model catalog.",
	register(api) {
		const resolveCurrentPluginConfig = () => resolveLivePluginConfigObject(api.runtime.config?.current ? () => api.runtime.config.current() : void 0, "codex", api.pluginConfig) ?? api.pluginConfig;
		api.registerAgentHarness(createCodexAppServerAgentHarness({ pluginConfig: api.pluginConfig }));
		api.registerProvider(buildCodexProvider({ pluginConfig: api.pluginConfig }));
		api.registerMediaUnderstandingProvider(buildCodexMediaUnderstandingProvider({ pluginConfig: api.pluginConfig }));
		api.registerMigrationProvider(buildCodexMigrationProvider());
		api.registerCommand(createCodexCommand({ pluginConfig: api.pluginConfig }));
		api.on("inbound_claim", (event, ctx) => handleCodexConversationInboundClaim(event, ctx, { pluginConfig: resolveCurrentPluginConfig() }));
		api.onConversationBindingResolved?.(handleCodexConversationBindingResolved);
	}
});
//#endregion
export { codex_default as default };
