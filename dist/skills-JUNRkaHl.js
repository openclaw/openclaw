import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { a as isPathInsideWithRealpath } from "./path-BlG8lhgR.js";
import { t as resolveEffectiveAgentSkillFilter } from "./agent-filter-CZoQBzQY.js";
import { o as mergeBundlePathLists, s as normalizeBundlePathList, t as CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH } from "./bundle-manifest-s4nKSc4m.js";
import { u as readRootJsonObjectSync } from "./json-files-C2hqjU--.js";
import { l as resolveEffectivePluginActivationState, r as hasExplicitPluginConfig, s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { n as loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry-CgH_ZSlH.js";
import "./scan-paths-BJFKmVji.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { u as parseFrontmatterBlock } from "./frontmatter-DIUKpD-a.js";
import "./config-DU04JXyx.js";
import "./env-overrides-DIYux-i5.js";
import { a as loadVisibleWorkspaceSkillEntries, i as filterWorkspaceSkillEntriesWithOptions } from "./workspace-BoRIIBbL.js";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/bundle-commands.ts
function parseFrontmatterBool(value, fallback) {
	const normalized = normalizeOptionalLowercaseString(value);
	if (!normalized) return fallback;
	if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
	if (normalized === "false" || normalized === "no" || normalized === "0") return false;
	return fallback;
}
function stripFrontmatter(content) {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return normalized.trim();
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return normalized.trim();
	return normalized.slice(endIndex + 4).trim();
}
function readClaudeBundleManifest(rootDir) {
	const result = readRootJsonObjectSync({
		rootDir,
		relativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
		boundaryLabel: "plugin root",
		rejectHardlinks: true
	});
	return result.ok ? result.value : {};
}
function resolveClaudeCommandRootDirs(rootDir) {
	const declared = normalizeBundlePathList(readClaudeBundleManifest(rootDir).commands);
	return mergeBundlePathLists(fs.existsSync(path.join(rootDir, "commands")) ? ["commands"] : [], declared);
}
function listMarkdownFilesRecursive(rootDir) {
	const pending = [rootDir];
	const files = [];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) continue;
		let entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				pending.push(fullPath);
				continue;
			}
			if (entry.isFile() && normalizeOptionalLowercaseString(entry.name)?.endsWith(".md")) files.push(fullPath);
		}
	}
	return files.toSorted((a, b) => a.localeCompare(b));
}
function toDefaultCommandName(rootDir, filePath) {
	return path.relative(rootDir, filePath).replace(/\.[^.]+$/u, "").split(path.sep).join(":");
}
function toDefaultDescription(rawName, promptTemplate) {
	return promptTemplate.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || rawName;
}
function loadBundleCommandsFromRoot(params) {
	const entries = [];
	for (const filePath of listMarkdownFilesRecursive(params.commandRoot)) {
		let raw;
		try {
			raw = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const frontmatter = parseFrontmatterBlock(raw);
		if (parseFrontmatterBool(frontmatter["disable-model-invocation"], false)) continue;
		const promptTemplate = stripFrontmatter(raw);
		if (!promptTemplate) continue;
		const rawName = normalizeOptionalString(frontmatter.name) || toDefaultCommandName(params.commandRoot, filePath);
		if (!rawName) continue;
		const description = normalizeOptionalString(frontmatter.description) || toDefaultDescription(rawName, promptTemplate);
		entries.push({
			pluginId: params.pluginId,
			rawName,
			description,
			promptTemplate,
			sourceFilePath: filePath
		});
	}
	return entries;
}
function loadEnabledClaudeBundleCommands(params) {
	if (!hasExplicitPluginConfig(params.cfg?.plugins)) return [];
	const registry = loadPluginManifestRegistryForPluginRegistry({
		workspaceDir: params.workspaceDir,
		config: params.cfg,
		includeDisabled: true
	});
	const normalizedPlugins = normalizePluginsConfig(params.cfg?.plugins);
	const commands = [];
	for (const record of registry.plugins) {
		if (record.format !== "bundle" || record.bundleFormat !== "claude" || !(record.bundleCapabilities ?? []).includes("commands")) continue;
		if (!resolveEffectivePluginActivationState({
			id: record.id,
			origin: record.origin,
			config: normalizedPlugins,
			rootConfig: params.cfg
		}).activated) continue;
		for (const relativeRoot of resolveClaudeCommandRootDirs(record.rootDir)) {
			const commandRoot = path.resolve(record.rootDir, relativeRoot);
			if (!fs.existsSync(commandRoot)) continue;
			if (!isPathInsideWithRealpath(record.rootDir, commandRoot, { requireRealpath: true })) continue;
			commands.push(...loadBundleCommandsFromRoot({
				pluginId: record.id,
				commandRoot
			}));
		}
	}
	return commands;
}
//#endregion
//#region src/agents/skills/command-specs.ts
const skillsLogger = createSubsystemLogger("skills");
const skillCommandDebugOnce = /* @__PURE__ */ new Set();
const SKILL_COMMAND_MAX_LENGTH = 32;
const SKILL_COMMAND_FALLBACK = "skill";
const SKILL_COMMAND_DESCRIPTION_MAX_LENGTH = 100;
function debugSkillCommandOnce(messageKey, message, meta) {
	if (skillCommandDebugOnce.has(messageKey)) return;
	skillCommandDebugOnce.add(messageKey);
	skillsLogger.debug(message, meta);
}
function sanitizeSkillCommandName(raw) {
	return normalizeLowercaseStringOrEmpty(raw).replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, SKILL_COMMAND_MAX_LENGTH) || SKILL_COMMAND_FALLBACK;
}
function resolveUniqueSkillCommandName(base, used) {
	const normalizedBase = normalizeLowercaseStringOrEmpty(base);
	if (!used.has(normalizedBase)) return base;
	for (let index = 2; index < 1e3; index += 1) {
		const suffix = `_${index}`;
		const maxBaseLength = Math.max(1, SKILL_COMMAND_MAX_LENGTH - suffix.length);
		const candidate = `${base.slice(0, maxBaseLength)}${suffix}`;
		const candidateKey = normalizeLowercaseStringOrEmpty(candidate);
		if (!used.has(candidateKey)) return candidate;
	}
	return `${base.slice(0, Math.max(1, SKILL_COMMAND_MAX_LENGTH - 2))}_x`;
}
function buildWorkspaceSkillCommandSpecs(workspaceDir, opts) {
	const effectiveSkillFilter = opts?.skillFilter ?? resolveEffectiveAgentSkillFilter(opts?.config, opts?.agentId);
	const userInvocable = (opts?.entries ? filterWorkspaceSkillEntriesWithOptions(opts.entries, {
		config: opts?.config,
		skillFilter: effectiveSkillFilter,
		eligibility: opts?.eligibility
	}) : loadVisibleWorkspaceSkillEntries(workspaceDir, {
		config: opts?.config,
		managedSkillsDir: opts?.managedSkillsDir,
		bundledSkillsDir: opts?.bundledSkillsDir,
		skillFilter: effectiveSkillFilter,
		eligibility: opts?.eligibility
	})).filter((entry) => entry.invocation?.userInvocable !== false);
	const used = /* @__PURE__ */ new Set();
	for (const reserved of opts?.reservedNames ?? []) used.add(normalizeLowercaseStringOrEmpty(reserved));
	const specs = [];
	for (const entry of userInvocable) {
		const rawName = entry.skill.name;
		const base = sanitizeSkillCommandName(rawName);
		if (base !== rawName) debugSkillCommandOnce(`sanitize:${rawName}:${base}`, `Sanitized skill command name "${rawName}" to "/${base}".`, {
			rawName,
			sanitized: `/${base}`
		});
		const unique = resolveUniqueSkillCommandName(base, used);
		if (unique !== base) debugSkillCommandOnce(`dedupe:${rawName}:${unique}`, `De-duplicated skill command name for "${rawName}" to "/${unique}".`, {
			rawName,
			deduped: `/${unique}`
		});
		used.add(normalizeLowercaseStringOrEmpty(unique));
		const rawDescription = entry.skill.description?.trim() || rawName;
		const description = rawDescription.length > SKILL_COMMAND_DESCRIPTION_MAX_LENGTH ? rawDescription.slice(0, SKILL_COMMAND_DESCRIPTION_MAX_LENGTH - 1) + "…" : rawDescription;
		const dispatch = (() => {
			const kindRaw = normalizeLowercaseStringOrEmpty(entry.frontmatter?.["command-dispatch"] ?? entry.frontmatter?.["command_dispatch"] ?? "");
			if (!kindRaw || kindRaw !== "tool") return;
			const toolName = (entry.frontmatter?.["command-tool"] ?? entry.frontmatter?.["command_tool"] ?? "").trim();
			if (!toolName) {
				debugSkillCommandOnce(`dispatch:missingTool:${rawName}`, `Skill command "/${unique}" requested tool dispatch but did not provide command-tool. Ignoring dispatch.`, {
					skillName: rawName,
					command: unique
				});
				return;
			}
			const argModeRaw = normalizeOptionalLowercaseString(entry.frontmatter?.["command-arg-mode"] ?? entry.frontmatter?.["command_arg_mode"] ?? "");
			if (!(!argModeRaw || argModeRaw === "raw" ? "raw" : null)) debugSkillCommandOnce(`dispatch:badArgMode:${rawName}:${argModeRaw}`, `Skill command "/${unique}" requested tool dispatch but has unknown command-arg-mode. Falling back to raw.`, {
				skillName: rawName,
				command: unique,
				argMode: argModeRaw
			});
			return {
				kind: "tool",
				toolName,
				argMode: "raw"
			};
		})();
		specs.push({
			name: unique,
			skillName: rawName,
			description,
			...dispatch ? { dispatch } : {}
		});
	}
	const bundleCommands = loadEnabledClaudeBundleCommands({
		workspaceDir,
		cfg: opts?.config
	});
	for (const entry of bundleCommands) {
		const base = sanitizeSkillCommandName(entry.rawName);
		if (base !== entry.rawName) debugSkillCommandOnce(`bundle-sanitize:${entry.rawName}:${base}`, `Sanitized bundle command name "${entry.rawName}" to "/${base}".`, {
			rawName: entry.rawName,
			sanitized: `/${base}`
		});
		const unique = resolveUniqueSkillCommandName(base, used);
		if (unique !== base) debugSkillCommandOnce(`bundle-dedupe:${entry.rawName}:${unique}`, `De-duplicated bundle command name for "${entry.rawName}" to "/${unique}".`, {
			rawName: entry.rawName,
			deduped: `/${unique}`
		});
		used.add(normalizeLowercaseStringOrEmpty(unique));
		const description = entry.description.length > SKILL_COMMAND_DESCRIPTION_MAX_LENGTH ? entry.description.slice(0, SKILL_COMMAND_DESCRIPTION_MAX_LENGTH - 1) + "…" : entry.description;
		specs.push({
			name: unique,
			skillName: entry.rawName,
			description,
			promptTemplate: entry.promptTemplate,
			sourceFilePath: entry.sourceFilePath
		});
	}
	return specs;
}
//#endregion
//#region src/agents/skills.ts
function resolveSkillsInstallPreferences(config) {
	const raw = config?.skills?.install;
	const preferBrew = raw?.preferBrew ?? true;
	const manager = normalizeLowercaseStringOrEmpty(normalizeOptionalString(raw?.nodeManager));
	return {
		preferBrew,
		nodeManager: manager === "pnpm" || manager === "yarn" || manager === "bun" || manager === "npm" ? manager : "npm"
	};
}
//#endregion
export { buildWorkspaceSkillCommandSpecs as n, resolveSkillsInstallPreferences as t };
