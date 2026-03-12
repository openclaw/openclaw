import { Lt as resolvePreferredOpenClawTmpDir, W as CONFIG_DIR, s as createSubsystemLogger, st as resolveUserPath } from "./entry.js";
import { f as isPathInside, h as normalizeSkillFilter, n as resolveOpenClawPackageRootSync } from "./openclaw-root-C9tYgTzw.js";
import { n as isDangerousHostEnvVarName } from "./host-env-security-BM8ktVlo.js";
import { d as resolveEffectiveEnableState, f as resolveMemorySlotDecision, n as loadPluginManifestRegistry, u as normalizePluginsConfig } from "./manifest-registry-HLdbjiS7.js";
import { a as resolveOpenClawManifestBlock, c as resolveOpenClawManifestRequires, d as hasBinary, f as isConfigPathTruthyWithDefaults, i as parseOpenClawManifestInstallBase, l as parseFrontmatterBlock, n as normalizeStringList, o as resolveOpenClawManifestInstall, r as parseFrontmatterBool, s as resolveOpenClawManifestOs, t as getFrontmatterString, u as evaluateRuntimeEligibility } from "./frontmatter-DzgKaILZ.js";
import { n as assertNoPathAliasEscape } from "./path-alias-guards-BpvAiXds.js";
import { URL, fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { formatSkillsForPrompt, loadSkillsFromDir } from "@mariozechner/pi-coding-agent";

//#region src/agents/skills/frontmatter.ts
function parseFrontmatter(content) {
	return parseFrontmatterBlock(content);
}
function parseInstallSpec(input) {
	const parsed = parseOpenClawManifestInstallBase(input, [
		"brew",
		"node",
		"go",
		"uv",
		"download"
	]);
	if (!parsed) return;
	const { raw } = parsed;
	const spec = { kind: parsed.kind };
	if (parsed.id) spec.id = parsed.id;
	if (parsed.label) spec.label = parsed.label;
	if (parsed.bins) spec.bins = parsed.bins;
	const osList = normalizeStringList(raw.os);
	if (osList.length > 0) spec.os = osList;
	const formula = typeof raw.formula === "string" ? raw.formula.trim() : "";
	if (formula) spec.formula = formula;
	const cask = typeof raw.cask === "string" ? raw.cask.trim() : "";
	if (!spec.formula && cask) spec.formula = cask;
	if (typeof raw.package === "string") spec.package = raw.package;
	if (typeof raw.module === "string") spec.module = raw.module;
	if (typeof raw.url === "string") spec.url = raw.url;
	if (typeof raw.archive === "string") spec.archive = raw.archive;
	if (typeof raw.extract === "boolean") spec.extract = raw.extract;
	if (typeof raw.stripComponents === "number") spec.stripComponents = raw.stripComponents;
	if (typeof raw.targetDir === "string") spec.targetDir = raw.targetDir;
	return spec;
}
function resolveOpenClawMetadata(frontmatter) {
	const metadataObj = resolveOpenClawManifestBlock({ frontmatter });
	if (!metadataObj) return;
	const requires = resolveOpenClawManifestRequires(metadataObj);
	const install = resolveOpenClawManifestInstall(metadataObj, parseInstallSpec);
	const osRaw = resolveOpenClawManifestOs(metadataObj);
	return {
		always: typeof metadataObj.always === "boolean" ? metadataObj.always : void 0,
		emoji: typeof metadataObj.emoji === "string" ? metadataObj.emoji : void 0,
		homepage: typeof metadataObj.homepage === "string" ? metadataObj.homepage : void 0,
		skillKey: typeof metadataObj.skillKey === "string" ? metadataObj.skillKey : void 0,
		primaryEnv: typeof metadataObj.primaryEnv === "string" ? metadataObj.primaryEnv : void 0,
		os: osRaw.length > 0 ? osRaw : void 0,
		requires,
		install: install.length > 0 ? install : void 0
	};
}
function resolveSkillInvocationPolicy(frontmatter) {
	return {
		userInvocable: parseFrontmatterBool(getFrontmatterString(frontmatter, "user-invocable"), true),
		disableModelInvocation: parseFrontmatterBool(getFrontmatterString(frontmatter, "disable-model-invocation"), false)
	};
}
function resolveSkillKey(skill, entry) {
	return entry?.metadata?.skillKey ?? skill.name;
}

//#endregion
//#region src/agents/skills/config.ts
const DEFAULT_CONFIG_VALUES = {
	"browser.enabled": true,
	"browser.evaluateEnabled": true
};
function isConfigPathTruthy(config, pathStr) {
	return isConfigPathTruthyWithDefaults(config, pathStr, DEFAULT_CONFIG_VALUES);
}
function resolveSkillConfig(config, skillKey) {
	const skills = config?.skills?.entries;
	if (!skills || typeof skills !== "object") return;
	const entry = skills[skillKey];
	if (!entry || typeof entry !== "object") return;
	return entry;
}
function normalizeAllowlist(input) {
	if (!input) return;
	if (!Array.isArray(input)) return;
	const normalized = input.map((entry) => String(entry).trim()).filter(Boolean);
	return normalized.length > 0 ? normalized : void 0;
}
const BUNDLED_SOURCES = new Set(["openclaw-bundled"]);
function isBundledSkill(entry) {
	return BUNDLED_SOURCES.has(entry.skill.source);
}
function resolveBundledAllowlist(config) {
	return normalizeAllowlist(config?.skills?.allowBundled);
}
function isBundledSkillAllowed(entry, allowlist) {
	if (!allowlist || allowlist.length === 0) return true;
	if (!isBundledSkill(entry)) return true;
	const key = resolveSkillKey(entry.skill, entry);
	return allowlist.includes(key) || allowlist.includes(entry.skill.name);
}
function shouldIncludeSkill(params) {
	const { entry, config, eligibility } = params;
	const skillConfig = resolveSkillConfig(config, resolveSkillKey(entry.skill, entry));
	const allowBundled = normalizeAllowlist(config?.skills?.allowBundled);
	if (skillConfig?.enabled === false) return false;
	if (!isBundledSkillAllowed(entry, allowBundled)) return false;
	return evaluateRuntimeEligibility({
		os: entry.metadata?.os,
		remotePlatforms: eligibility?.remote?.platforms,
		always: entry.metadata?.always,
		requires: entry.metadata?.requires,
		hasBin: hasBinary,
		hasRemoteBin: eligibility?.remote?.hasBin,
		hasAnyRemoteBin: eligibility?.remote?.hasAnyBin,
		hasEnv: (envName) => Boolean(process.env[envName] || skillConfig?.env?.[envName] || skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
		isConfigPathTruthy: (configPath) => isConfigPathTruthy(config, configPath)
	});
}

//#endregion
//#region src/agents/sandbox/sanitize-env-vars.ts
const BLOCKED_ENV_VAR_PATTERNS = [
	/^ANTHROPIC_API_KEY$/i,
	/^OPENAI_API_KEY$/i,
	/^GEMINI_API_KEY$/i,
	/^OPENROUTER_API_KEY$/i,
	/^MINIMAX_API_KEY$/i,
	/^ELEVENLABS_API_KEY$/i,
	/^SYNTHETIC_API_KEY$/i,
	/^TELEGRAM_BOT_TOKEN$/i,
	/^DISCORD_BOT_TOKEN$/i,
	/^SLACK_(BOT|APP)_TOKEN$/i,
	/^LINE_CHANNEL_SECRET$/i,
	/^LINE_CHANNEL_ACCESS_TOKEN$/i,
	/^OPENCLAW_GATEWAY_(TOKEN|PASSWORD)$/i,
	/^AWS_(SECRET_ACCESS_KEY|SECRET_KEY|SESSION_TOKEN)$/i,
	/^(GH|GITHUB)_TOKEN$/i,
	/^(AZURE|AZURE_OPENAI|COHERE|AI_GATEWAY|OPENROUTER)_API_KEY$/i,
	/_?(API_KEY|TOKEN|PASSWORD|PRIVATE_KEY|SECRET)$/i
];
const ALLOWED_ENV_VAR_PATTERNS = [
	/^LANG$/,
	/^LC_.*$/i,
	/^PATH$/i,
	/^HOME$/i,
	/^USER$/i,
	/^SHELL$/i,
	/^TERM$/i,
	/^TZ$/i,
	/^NODE_ENV$/i
];
function validateEnvVarValue(value) {
	if (value.includes("\0")) return "Contains null bytes";
	if (value.length > 32768) return "Value exceeds maximum length";
	if (/^[A-Za-z0-9+/=]{80,}$/.test(value)) return "Value looks like base64-encoded credential data";
}
function matchesAnyPattern$1(value, patterns) {
	return patterns.some((pattern) => pattern.test(value));
}
function sanitizeEnvVars(envVars, options = {}) {
	const allowed = {};
	const blocked = [];
	const warnings = [];
	const blockedPatterns = [...BLOCKED_ENV_VAR_PATTERNS, ...options.customBlockedPatterns ?? []];
	const allowedPatterns = [...ALLOWED_ENV_VAR_PATTERNS, ...options.customAllowedPatterns ?? []];
	for (const [rawKey, value] of Object.entries(envVars)) {
		const key = rawKey.trim();
		if (!key) continue;
		if (matchesAnyPattern$1(key, blockedPatterns)) {
			blocked.push(key);
			continue;
		}
		if (options.strictMode && !matchesAnyPattern$1(key, allowedPatterns)) {
			blocked.push(key);
			continue;
		}
		const warning = validateEnvVarValue(value);
		if (warning) {
			if (warning === "Contains null bytes") {
				blocked.push(key);
				continue;
			}
			warnings.push(`${key}: ${warning}`);
		}
		allowed[key] = value;
	}
	return {
		allowed,
		blocked,
		warnings
	};
}

//#endregion
//#region src/agents/skills/env-overrides.ts
const log$1 = createSubsystemLogger("env-overrides");
const SKILL_ALWAYS_BLOCKED_ENV_PATTERNS = [/^OPENSSL_CONF$/i];
function matchesAnyPattern(value, patterns) {
	return patterns.some((pattern) => pattern.test(value));
}
function isAlwaysBlockedSkillEnvKey(key) {
	return isDangerousHostEnvVarName(key) || matchesAnyPattern(key, SKILL_ALWAYS_BLOCKED_ENV_PATTERNS);
}
function sanitizeSkillEnvOverrides(params) {
	if (Object.keys(params.overrides).length === 0) return {
		allowed: {},
		blocked: [],
		warnings: []
	};
	const result = sanitizeEnvVars(params.overrides);
	const allowed = {};
	const blocked = /* @__PURE__ */ new Set();
	const warnings = [...result.warnings];
	for (const [key, value] of Object.entries(result.allowed)) {
		if (isAlwaysBlockedSkillEnvKey(key)) {
			blocked.add(key);
			continue;
		}
		allowed[key] = value;
	}
	for (const key of result.blocked) {
		if (isAlwaysBlockedSkillEnvKey(key) || !params.allowedSensitiveKeys.has(key)) {
			blocked.add(key);
			continue;
		}
		const value = params.overrides[key];
		if (!value) continue;
		const warning = validateEnvVarValue(value);
		if (warning) {
			if (warning === "Contains null bytes") {
				blocked.add(key);
				continue;
			}
			warnings.push(`${key}: ${warning}`);
		}
		allowed[key] = value;
	}
	return {
		allowed,
		blocked: [...blocked],
		warnings
	};
}
function applySkillConfigEnvOverrides(params) {
	const { updates, skillConfig, primaryEnv, requiredEnv, skillKey } = params;
	const allowedSensitiveKeys = /* @__PURE__ */ new Set();
	const normalizedPrimaryEnv = primaryEnv?.trim();
	if (normalizedPrimaryEnv) allowedSensitiveKeys.add(normalizedPrimaryEnv);
	for (const envName of requiredEnv ?? []) {
		const trimmedEnv = envName.trim();
		if (trimmedEnv) allowedSensitiveKeys.add(trimmedEnv);
	}
	const pendingOverrides = {};
	if (skillConfig.env) for (const [rawKey, envValue] of Object.entries(skillConfig.env)) {
		const envKey = rawKey.trim();
		if (!envKey || !envValue || process.env[envKey]) continue;
		pendingOverrides[envKey] = envValue;
	}
	const resolvedApiKey = typeof skillConfig.apiKey === "string" ? skillConfig.apiKey.trim() : "";
	if (normalizedPrimaryEnv && resolvedApiKey && !process.env[normalizedPrimaryEnv]) {
		if (!pendingOverrides[normalizedPrimaryEnv]) pendingOverrides[normalizedPrimaryEnv] = resolvedApiKey;
	}
	const sanitized = sanitizeSkillEnvOverrides({
		overrides: pendingOverrides,
		allowedSensitiveKeys
	});
	if (sanitized.blocked.length > 0) log$1.warn(`Blocked skill env overrides for ${skillKey}: ${sanitized.blocked.join(", ")}`);
	if (sanitized.warnings.length > 0) log$1.warn(`Suspicious skill env overrides for ${skillKey}: ${sanitized.warnings.join(", ")}`);
	for (const [envKey, envValue] of Object.entries(sanitized.allowed)) {
		if (process.env[envKey]) continue;
		updates.push({
			key: envKey,
			prev: process.env[envKey]
		});
		process.env[envKey] = envValue;
	}
}
function createEnvReverter(updates) {
	return () => {
		for (const update of updates) if (update.prev === void 0) delete process.env[update.key];
		else process.env[update.key] = update.prev;
	};
}
function applySkillEnvOverrides(params) {
	const { skills, config } = params;
	const updates = [];
	for (const entry of skills) {
		const skillKey = resolveSkillKey(entry.skill, entry);
		const skillConfig = resolveSkillConfig(config, skillKey);
		if (!skillConfig) continue;
		applySkillConfigEnvOverrides({
			updates,
			skillConfig,
			primaryEnv: entry.metadata?.primaryEnv,
			requiredEnv: entry.metadata?.requires?.env,
			skillKey
		});
	}
	return createEnvReverter(updates);
}
function applySkillEnvOverridesFromSnapshot(params) {
	const { snapshot, config } = params;
	if (!snapshot) return () => {};
	const updates = [];
	for (const skill of snapshot.skills) {
		const skillConfig = resolveSkillConfig(config, skill.name);
		if (!skillConfig) continue;
		applySkillConfigEnvOverrides({
			updates,
			skillConfig,
			primaryEnv: skill.primaryEnv,
			requiredEnv: skill.requiredEnv,
			skillKey: skill.name
		});
	}
	return createEnvReverter(updates);
}

//#endregion
//#region src/agents/sandbox-paths.ts
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const HTTP_URL_RE = /^https?:\/\//i;
const DATA_URL_RE = /^data:/i;
const SANDBOX_CONTAINER_WORKDIR = "/workspace";
function normalizeUnicodeSpaces(str) {
	return str.replace(UNICODE_SPACES, " ");
}
function normalizeAtPrefix(filePath) {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}
function expandPath(filePath) {
	const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
	if (normalized === "~") return os.homedir();
	if (normalized.startsWith("~/")) return os.homedir() + normalized.slice(1);
	return normalized;
}
function resolveToCwd(filePath, cwd) {
	const expanded = expandPath(filePath);
	if (path.isAbsolute(expanded)) return expanded;
	return path.resolve(cwd, expanded);
}
function resolveSandboxInputPath(filePath, cwd) {
	return resolveToCwd(filePath, cwd);
}
function resolveSandboxPath(params) {
	const resolved = resolveSandboxInputPath(params.filePath, params.cwd);
	const rootResolved = path.resolve(params.root);
	const relative = path.relative(rootResolved, resolved);
	if (!relative || relative === "") return {
		resolved,
		relative: ""
	};
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes sandbox root (${shortPath(rootResolved)}): ${params.filePath}`);
	return {
		resolved,
		relative
	};
}
async function assertSandboxPath(params) {
	const resolved = resolveSandboxPath(params);
	const policy = {
		allowFinalSymlinkForUnlink: params.allowFinalSymlinkForUnlink,
		allowFinalHardlinkForUnlink: params.allowFinalHardlinkForUnlink
	};
	await assertNoPathAliasEscape({
		absolutePath: resolved.resolved,
		rootPath: params.root,
		boundaryLabel: "sandbox root",
		policy
	});
	return resolved;
}
function assertMediaNotDataUrl(media) {
	const raw = media.trim();
	if (DATA_URL_RE.test(raw)) throw new Error("data: URLs are not supported for media. Use buffer instead.");
}
async function resolveSandboxedMediaSource(params) {
	const raw = params.media.trim();
	if (!raw) return raw;
	if (HTTP_URL_RE.test(raw)) return raw;
	let candidate = raw;
	if (/^file:\/\//i.test(candidate)) {
		const workspaceMappedFromUrl = mapContainerWorkspaceFileUrl({
			fileUrl: candidate,
			sandboxRoot: params.sandboxRoot
		});
		if (workspaceMappedFromUrl) candidate = workspaceMappedFromUrl;
		else try {
			candidate = fileURLToPath(candidate);
		} catch {
			throw new Error(`Invalid file:// URL for sandboxed media: ${raw}`);
		}
	}
	const containerWorkspaceMapped = mapContainerWorkspacePath({
		candidate,
		sandboxRoot: params.sandboxRoot
	});
	if (containerWorkspaceMapped) candidate = containerWorkspaceMapped;
	const tmpMediaPath = await resolveAllowedTmpMediaPath({
		candidate,
		sandboxRoot: params.sandboxRoot
	});
	if (tmpMediaPath) return tmpMediaPath;
	return (await assertSandboxPath({
		filePath: candidate,
		cwd: params.sandboxRoot,
		root: params.sandboxRoot
	})).resolved;
}
function mapContainerWorkspaceFileUrl(params) {
	let parsed;
	try {
		parsed = new URL(params.fileUrl);
	} catch {
		return;
	}
	if (parsed.protocol !== "file:") return;
	const normalizedPathname = decodeURIComponent(parsed.pathname).replace(/\\/g, "/");
	if (normalizedPathname !== SANDBOX_CONTAINER_WORKDIR && !normalizedPathname.startsWith(`${SANDBOX_CONTAINER_WORKDIR}/`)) return;
	return mapContainerWorkspacePath({
		candidate: normalizedPathname,
		sandboxRoot: params.sandboxRoot
	});
}
function mapContainerWorkspacePath(params) {
	const normalized = params.candidate.replace(/\\/g, "/");
	if (normalized === SANDBOX_CONTAINER_WORKDIR) return path.resolve(params.sandboxRoot);
	const prefix = `${SANDBOX_CONTAINER_WORKDIR}/`;
	if (!normalized.startsWith(prefix)) return;
	const rel = normalized.slice(prefix.length);
	if (!rel) return path.resolve(params.sandboxRoot);
	return path.resolve(params.sandboxRoot, ...rel.split("/").filter(Boolean));
}
async function resolveAllowedTmpMediaPath(params) {
	if (!path.isAbsolute(expandPath(params.candidate))) return;
	const resolved = path.resolve(resolveSandboxInputPath(params.candidate, params.sandboxRoot));
	const openClawTmpDir = path.resolve(resolvePreferredOpenClawTmpDir());
	if (!isPathInside(openClawTmpDir, resolved)) return;
	await assertNoTmpAliasEscape({
		filePath: resolved,
		tmpRoot: openClawTmpDir
	});
	return resolved;
}
async function assertNoTmpAliasEscape(params) {
	await assertNoPathAliasEscape({
		absolutePath: params.filePath,
		rootPath: params.tmpRoot,
		boundaryLabel: "tmp root"
	});
}
function shortPath(value) {
	if (value.startsWith(os.homedir())) return `~${value.slice(os.homedir().length)}`;
	return value;
}

//#endregion
//#region src/agents/skills/bundled-dir.ts
function looksLikeSkillsDir(dir) {
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const fullPath = path.join(dir, entry.name);
			if (entry.isFile() && entry.name.endsWith(".md")) return true;
			if (entry.isDirectory()) {
				if (fs.existsSync(path.join(fullPath, "SKILL.md"))) return true;
			}
		}
	} catch {
		return false;
	}
	return false;
}
function resolveBundledSkillsDir(opts = {}) {
	const override = process.env.OPENCLAW_BUNDLED_SKILLS_DIR?.trim();
	if (override) return override;
	try {
		const execPath = opts.execPath ?? process.execPath;
		const execDir = path.dirname(execPath);
		const sibling = path.join(execDir, "skills");
		if (fs.existsSync(sibling)) return sibling;
	} catch {}
	try {
		const moduleUrl = opts.moduleUrl ?? import.meta.url;
		const moduleDir = path.dirname(fileURLToPath(moduleUrl));
		const packageRoot = resolveOpenClawPackageRootSync({
			argv1: opts.argv1 ?? process.argv[1],
			moduleUrl,
			cwd: opts.cwd ?? process.cwd()
		});
		if (packageRoot) {
			const candidate = path.join(packageRoot, "skills");
			if (looksLikeSkillsDir(candidate)) return candidate;
		}
		let current = moduleDir;
		for (let depth = 0; depth < 6; depth += 1) {
			const candidate = path.join(current, "skills");
			if (looksLikeSkillsDir(candidate)) return candidate;
			const next = path.dirname(current);
			if (next === current) break;
			current = next;
		}
	} catch {}
}

//#endregion
//#region src/agents/skills/plugin-skills.ts
const log = createSubsystemLogger("skills");
function resolvePluginSkillDirs(params) {
	const workspaceDir = (params.workspaceDir ?? "").trim();
	if (!workspaceDir) return [];
	const registry = loadPluginManifestRegistry({
		workspaceDir,
		config: params.config
	});
	if (registry.plugins.length === 0) return [];
	const normalizedPlugins = normalizePluginsConfig(params.config?.plugins);
	const acpEnabled = params.config?.acp?.enabled !== false;
	const memorySlot = normalizedPlugins.slots.memory;
	let selectedMemoryPluginId = null;
	const seen = /* @__PURE__ */ new Set();
	const resolved = [];
	for (const record of registry.plugins) {
		if (!record.skills || record.skills.length === 0) continue;
		if (!resolveEffectiveEnableState({
			id: record.id,
			origin: record.origin,
			config: normalizedPlugins,
			rootConfig: params.config
		}).enabled) continue;
		if (!acpEnabled && record.id === "acpx") continue;
		const memoryDecision = resolveMemorySlotDecision({
			id: record.id,
			kind: record.kind,
			slot: memorySlot,
			selectedId: selectedMemoryPluginId
		});
		if (!memoryDecision.enabled) continue;
		if (memoryDecision.selected && record.kind === "memory") selectedMemoryPluginId = record.id;
		for (const raw of record.skills) {
			const trimmed = raw.trim();
			if (!trimmed) continue;
			const candidate = path.resolve(record.rootDir, trimmed);
			if (!fs.existsSync(candidate)) {
				log.warn(`plugin skill path not found (${record.id}): ${candidate}`);
				continue;
			}
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			resolved.push(candidate);
		}
	}
	return resolved;
}

//#endregion
//#region src/agents/skills/serialize.ts
const SKILLS_SYNC_QUEUE = /* @__PURE__ */ new Map();
async function serializeByKey(key, task) {
	const next = (SKILLS_SYNC_QUEUE.get(key) ?? Promise.resolve()).then(task, task);
	SKILLS_SYNC_QUEUE.set(key, next);
	try {
		return await next;
	} finally {
		if (SKILLS_SYNC_QUEUE.get(key) === next) SKILLS_SYNC_QUEUE.delete(key);
	}
}

//#endregion
//#region src/agents/skills/workspace.ts
const fsp = fs.promises;
const skillsLogger = createSubsystemLogger("skills");
const skillCommandDebugOnce = /* @__PURE__ */ new Set();
/**
* Replace the user's home directory prefix with `~` in skill file paths
* to reduce system prompt token usage. Models understand `~` expansion,
* and the read tool resolves `~` to the home directory.
*
* Example: `/Users/alice/.bun/.../skills/github/SKILL.md`
*       → `~/.bun/.../skills/github/SKILL.md`
*
* Saves ~5–6 tokens per skill path × N skills ≈ 400–600 tokens total.
*/
function compactSkillPaths(skills) {
	const home = os.homedir();
	if (!home) return skills;
	const prefix = home.endsWith(path.sep) ? home : home + path.sep;
	return skills.map((s) => ({
		...s,
		filePath: s.filePath.startsWith(prefix) ? "~/" + s.filePath.slice(prefix.length) : s.filePath
	}));
}
function debugSkillCommandOnce(messageKey, message, meta) {
	if (skillCommandDebugOnce.has(messageKey)) return;
	skillCommandDebugOnce.add(messageKey);
	skillsLogger.debug(message, meta);
}
function filterSkillEntries(entries, config, skillFilter, eligibility) {
	let filtered = entries.filter((entry) => shouldIncludeSkill({
		entry,
		config,
		eligibility
	}));
	if (skillFilter !== void 0) {
		const normalized = normalizeSkillFilter(skillFilter) ?? [];
		const label = normalized.length > 0 ? normalized.join(", ") : "(none)";
		skillsLogger.debug(`Applying skill filter: ${label}`);
		filtered = normalized.length > 0 ? filtered.filter((entry) => normalized.includes(entry.skill.name)) : [];
		skillsLogger.debug(`After skill filter: ${filtered.map((entry) => entry.skill.name).join(", ") || "(none)"}`);
	}
	return filtered;
}
const SKILL_COMMAND_MAX_LENGTH = 32;
const SKILL_COMMAND_FALLBACK = "skill";
const SKILL_COMMAND_DESCRIPTION_MAX_LENGTH = 100;
const DEFAULT_MAX_CANDIDATES_PER_ROOT = 300;
const DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE = 200;
const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 3e4;
const DEFAULT_MAX_SKILL_FILE_BYTES = 256e3;
function sanitizeSkillCommandName(raw) {
	return raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, SKILL_COMMAND_MAX_LENGTH) || SKILL_COMMAND_FALLBACK;
}
function resolveUniqueSkillCommandName(base, used) {
	const normalizedBase = base.toLowerCase();
	if (!used.has(normalizedBase)) return base;
	for (let index = 2; index < 1e3; index += 1) {
		const suffix = `_${index}`;
		const maxBaseLength = Math.max(1, SKILL_COMMAND_MAX_LENGTH - suffix.length);
		const candidate = `${base.slice(0, maxBaseLength)}${suffix}`;
		const candidateKey = candidate.toLowerCase();
		if (!used.has(candidateKey)) return candidate;
	}
	return `${base.slice(0, Math.max(1, SKILL_COMMAND_MAX_LENGTH - 2))}_x`;
}
function resolveSkillsLimits(config) {
	const limits = config?.skills?.limits;
	return {
		maxCandidatesPerRoot: limits?.maxCandidatesPerRoot ?? DEFAULT_MAX_CANDIDATES_PER_ROOT,
		maxSkillsLoadedPerSource: limits?.maxSkillsLoadedPerSource ?? DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE,
		maxSkillsInPrompt: limits?.maxSkillsInPrompt ?? DEFAULT_MAX_SKILLS_IN_PROMPT,
		maxSkillsPromptChars: limits?.maxSkillsPromptChars ?? DEFAULT_MAX_SKILLS_PROMPT_CHARS,
		maxSkillFileBytes: limits?.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES
	};
}
function listChildDirectories(dir) {
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const dirs = [];
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				dirs.push(entry.name);
				continue;
			}
			if (entry.isSymbolicLink()) try {
				if (fs.statSync(fullPath).isDirectory()) dirs.push(entry.name);
			} catch {}
		}
		return dirs;
	} catch {
		return [];
	}
}
function resolveNestedSkillsRoot(dir, opts) {
	const nested = path.join(dir, "skills");
	try {
		if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) return { baseDir: dir };
	} catch {
		return { baseDir: dir };
	}
	const nestedDirs = listChildDirectories(nested);
	const scanLimit = Math.max(0, opts?.maxEntriesToScan ?? 100);
	const toScan = scanLimit === 0 ? [] : nestedDirs.slice(0, Math.min(nestedDirs.length, scanLimit));
	for (const name of toScan) {
		const skillMd = path.join(nested, name, "SKILL.md");
		if (fs.existsSync(skillMd)) return {
			baseDir: nested,
			note: `Detected nested skills root at ${nested}`
		};
	}
	return { baseDir: dir };
}
function unwrapLoadedSkills(loaded) {
	if (Array.isArray(loaded)) return loaded;
	if (loaded && typeof loaded === "object" && "skills" in loaded) {
		const skills = loaded.skills;
		if (Array.isArray(skills)) return skills;
	}
	return [];
}
function loadSkillEntries(workspaceDir, opts) {
	const limits = resolveSkillsLimits(opts?.config);
	const loadSkills = (params) => {
		const baseDir = resolveNestedSkillsRoot(params.dir, { maxEntriesToScan: limits.maxCandidatesPerRoot }).baseDir;
		const rootSkillMd = path.join(baseDir, "SKILL.md");
		if (fs.existsSync(rootSkillMd)) {
			try {
				const size = fs.statSync(rootSkillMd).size;
				if (size > limits.maxSkillFileBytes) {
					skillsLogger.warn("Skipping skills root due to oversized SKILL.md.", {
						dir: baseDir,
						filePath: rootSkillMd,
						size,
						maxSkillFileBytes: limits.maxSkillFileBytes
					});
					return [];
				}
			} catch {
				return [];
			}
			return unwrapLoadedSkills(loadSkillsFromDir({
				dir: baseDir,
				source: params.source
			}));
		}
		const childDirs = listChildDirectories(baseDir);
		const suspicious = childDirs.length > limits.maxCandidatesPerRoot;
		const maxCandidates = Math.max(0, limits.maxSkillsLoadedPerSource);
		const limitedChildren = childDirs.slice().sort().slice(0, maxCandidates);
		if (suspicious) skillsLogger.warn("Skills root looks suspiciously large, truncating discovery.", {
			dir: params.dir,
			baseDir,
			childDirCount: childDirs.length,
			maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
			maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource
		});
		else if (childDirs.length > maxCandidates) skillsLogger.warn("Skills root has many entries, truncating discovery.", {
			dir: params.dir,
			baseDir,
			childDirCount: childDirs.length,
			maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource
		});
		const loadedSkills = [];
		for (const name of limitedChildren) {
			const skillDir = path.join(baseDir, name);
			const skillMd = path.join(skillDir, "SKILL.md");
			if (!fs.existsSync(skillMd)) continue;
			try {
				const size = fs.statSync(skillMd).size;
				if (size > limits.maxSkillFileBytes) {
					skillsLogger.warn("Skipping skill due to oversized SKILL.md.", {
						skill: name,
						filePath: skillMd,
						size,
						maxSkillFileBytes: limits.maxSkillFileBytes
					});
					continue;
				}
			} catch {
				continue;
			}
			const loaded = loadSkillsFromDir({
				dir: skillDir,
				source: params.source
			});
			loadedSkills.push(...unwrapLoadedSkills(loaded));
			if (loadedSkills.length >= limits.maxSkillsLoadedPerSource) break;
		}
		if (loadedSkills.length > limits.maxSkillsLoadedPerSource) return loadedSkills.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, limits.maxSkillsLoadedPerSource);
		return loadedSkills;
	};
	const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
	const workspaceSkillsDir = path.resolve(workspaceDir, "skills");
	const bundledSkillsDir = opts?.bundledSkillsDir ?? resolveBundledSkillsDir();
	const extraDirs = (opts?.config?.skills?.load?.extraDirs ?? []).map((d) => typeof d === "string" ? d.trim() : "").filter(Boolean);
	const pluginSkillDirs = resolvePluginSkillDirs({
		workspaceDir,
		config: opts?.config
	});
	const mergedExtraDirs = [...extraDirs, ...pluginSkillDirs];
	const bundledSkills = bundledSkillsDir ? loadSkills({
		dir: bundledSkillsDir,
		source: "openclaw-bundled"
	}) : [];
	const extraSkills = mergedExtraDirs.flatMap((dir) => {
		return loadSkills({
			dir: resolveUserPath(dir),
			source: "openclaw-extra"
		});
	});
	const managedSkills = loadSkills({
		dir: managedSkillsDir,
		source: "openclaw-managed"
	});
	const personalAgentsSkills = loadSkills({
		dir: path.resolve(os.homedir(), ".agents", "skills"),
		source: "agents-skills-personal"
	});
	const projectAgentsSkills = loadSkills({
		dir: path.resolve(workspaceDir, ".agents", "skills"),
		source: "agents-skills-project"
	});
	const workspaceSkills = loadSkills({
		dir: workspaceSkillsDir,
		source: "openclaw-workspace"
	});
	const merged = /* @__PURE__ */ new Map();
	for (const skill of extraSkills) merged.set(skill.name, skill);
	for (const skill of bundledSkills) merged.set(skill.name, skill);
	for (const skill of managedSkills) merged.set(skill.name, skill);
	for (const skill of personalAgentsSkills) merged.set(skill.name, skill);
	for (const skill of projectAgentsSkills) merged.set(skill.name, skill);
	for (const skill of workspaceSkills) merged.set(skill.name, skill);
	return Array.from(merged.values()).map((skill) => {
		let frontmatter = {};
		try {
			frontmatter = parseFrontmatter(fs.readFileSync(skill.filePath, "utf-8"));
		} catch {}
		return {
			skill,
			frontmatter,
			metadata: resolveOpenClawMetadata(frontmatter),
			invocation: resolveSkillInvocationPolicy(frontmatter)
		};
	});
}
function applySkillsPromptLimits(params) {
	const limits = resolveSkillsLimits(params.config);
	const total = params.skills.length;
	const byCount = params.skills.slice(0, Math.max(0, limits.maxSkillsInPrompt));
	let skillsForPrompt = byCount;
	let truncated = total > byCount.length;
	let truncatedReason = truncated ? "count" : null;
	const fits = (skills) => {
		return formatSkillsForPrompt(skills).length <= limits.maxSkillsPromptChars;
	};
	if (!fits(skillsForPrompt)) {
		let lo = 0;
		let hi = skillsForPrompt.length;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (fits(skillsForPrompt.slice(0, mid))) lo = mid;
			else hi = mid - 1;
		}
		skillsForPrompt = skillsForPrompt.slice(0, lo);
		truncated = true;
		truncatedReason = "chars";
	}
	return {
		skillsForPrompt,
		truncated,
		truncatedReason
	};
}
function buildWorkspaceSkillSnapshot(workspaceDir, opts) {
	const { eligible, prompt, resolvedSkills } = resolveWorkspaceSkillPromptState(workspaceDir, opts);
	const skillFilter = normalizeSkillFilter(opts?.skillFilter);
	return {
		prompt,
		skills: eligible.map((entry) => ({
			name: entry.skill.name,
			primaryEnv: entry.metadata?.primaryEnv,
			requiredEnv: entry.metadata?.requires?.env?.slice()
		})),
		...skillFilter === void 0 ? {} : { skillFilter },
		resolvedSkills,
		version: opts?.snapshotVersion
	};
}
function buildWorkspaceSkillsPrompt(workspaceDir, opts) {
	return resolveWorkspaceSkillPromptState(workspaceDir, opts).prompt;
}
function resolveWorkspaceSkillPromptState(workspaceDir, opts) {
	const eligible = filterSkillEntries(opts?.entries ?? loadSkillEntries(workspaceDir, opts), opts?.config, opts?.skillFilter, opts?.eligibility);
	const promptEntries = eligible.filter((entry) => entry.invocation?.disableModelInvocation !== true);
	const remoteNote = opts?.eligibility?.remote?.note?.trim();
	const resolvedSkills = promptEntries.map((entry) => entry.skill);
	const { skillsForPrompt, truncated } = applySkillsPromptLimits({
		skills: resolvedSkills,
		config: opts?.config
	});
	return {
		eligible,
		prompt: [
			remoteNote,
			truncated ? `⚠️ Skills truncated: included ${skillsForPrompt.length} of ${resolvedSkills.length}. Run \`openclaw skills check\` to audit.` : "",
			formatSkillsForPrompt(compactSkillPaths(skillsForPrompt))
		].filter(Boolean).join("\n"),
		resolvedSkills
	};
}
function resolveSkillsPromptForRun(params) {
	const snapshotPrompt = params.skillsSnapshot?.prompt?.trim();
	if (snapshotPrompt) return snapshotPrompt;
	if (params.entries && params.entries.length > 0) {
		const prompt = buildWorkspaceSkillsPrompt(params.workspaceDir, {
			entries: params.entries,
			config: params.config
		});
		return prompt.trim() ? prompt : "";
	}
	return "";
}
function loadWorkspaceSkillEntries(workspaceDir, opts) {
	return loadSkillEntries(workspaceDir, opts);
}
function resolveUniqueSyncedSkillDirName(base, used) {
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	for (let index = 2; index < 1e4; index += 1) {
		const candidate = `${base}-${index}`;
		if (!used.has(candidate)) {
			used.add(candidate);
			return candidate;
		}
	}
	let fallbackIndex = 1e4;
	let fallback = `${base}-${fallbackIndex}`;
	while (used.has(fallback)) {
		fallbackIndex += 1;
		fallback = `${base}-${fallbackIndex}`;
	}
	used.add(fallback);
	return fallback;
}
function resolveSyncedSkillDestinationPath(params) {
	const sourceDirName = path.basename(params.entry.skill.baseDir).trim();
	if (!sourceDirName || sourceDirName === "." || sourceDirName === "..") return null;
	return resolveSandboxPath({
		filePath: resolveUniqueSyncedSkillDirName(sourceDirName, params.usedDirNames),
		cwd: params.targetSkillsDir,
		root: params.targetSkillsDir
	}).resolved;
}
async function syncSkillsToWorkspace(params) {
	const sourceDir = resolveUserPath(params.sourceWorkspaceDir);
	const targetDir = resolveUserPath(params.targetWorkspaceDir);
	if (sourceDir === targetDir) return;
	await serializeByKey(`syncSkills:${targetDir}`, async () => {
		const targetSkillsDir = path.join(targetDir, "skills");
		const entries = loadSkillEntries(sourceDir, {
			config: params.config,
			managedSkillsDir: params.managedSkillsDir,
			bundledSkillsDir: params.bundledSkillsDir
		});
		await fsp.rm(targetSkillsDir, {
			recursive: true,
			force: true
		});
		await fsp.mkdir(targetSkillsDir, { recursive: true });
		const usedDirNames = /* @__PURE__ */ new Set();
		for (const entry of entries) {
			let dest = null;
			try {
				dest = resolveSyncedSkillDestinationPath({
					targetSkillsDir,
					entry,
					usedDirNames
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : JSON.stringify(error);
				skillsLogger.warn(`Failed to resolve safe destination for ${entry.skill.name}: ${message}`);
				continue;
			}
			if (!dest) {
				skillsLogger.warn(`Failed to resolve safe destination for ${entry.skill.name}: invalid source directory name`);
				continue;
			}
			try {
				await fsp.cp(entry.skill.baseDir, dest, {
					recursive: true,
					force: true
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : JSON.stringify(error);
				skillsLogger.warn(`Failed to copy ${entry.skill.name} to sandbox: ${message}`);
			}
		}
	});
}
function buildWorkspaceSkillCommandSpecs(workspaceDir, opts) {
	const userInvocable = filterSkillEntries(opts?.entries ?? loadSkillEntries(workspaceDir, opts), opts?.config, opts?.skillFilter, opts?.eligibility).filter((entry) => entry.invocation?.userInvocable !== false);
	const used = /* @__PURE__ */ new Set();
	for (const reserved of opts?.reservedNames ?? []) used.add(reserved.toLowerCase());
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
		used.add(unique.toLowerCase());
		const rawDescription = entry.skill.description?.trim() || rawName;
		const description = rawDescription.length > SKILL_COMMAND_DESCRIPTION_MAX_LENGTH ? rawDescription.slice(0, SKILL_COMMAND_DESCRIPTION_MAX_LENGTH - 1) + "…" : rawDescription;
		const dispatch = (() => {
			const kindRaw = (entry.frontmatter?.["command-dispatch"] ?? entry.frontmatter?.["command_dispatch"] ?? "").trim().toLowerCase();
			if (!kindRaw) return;
			if (kindRaw !== "tool") return;
			const toolName = (entry.frontmatter?.["command-tool"] ?? entry.frontmatter?.["command_tool"] ?? "").trim();
			if (!toolName) {
				debugSkillCommandOnce(`dispatch:missingTool:${rawName}`, `Skill command "/${unique}" requested tool dispatch but did not provide command-tool. Ignoring dispatch.`, {
					skillName: rawName,
					command: unique
				});
				return;
			}
			const argModeRaw = (entry.frontmatter?.["command-arg-mode"] ?? entry.frontmatter?.["command_arg_mode"] ?? "").trim().toLowerCase();
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
	return specs;
}

//#endregion
//#region src/agents/skills.ts
function resolveSkillsInstallPreferences(config) {
	const raw = config?.skills?.install;
	const preferBrew = raw?.preferBrew ?? true;
	const manager = (typeof raw?.nodeManager === "string" ? raw.nodeManager.trim() : "").toLowerCase();
	return {
		preferBrew,
		nodeManager: manager === "pnpm" || manager === "yarn" || manager === "bun" || manager === "npm" ? manager : "npm"
	};
}

//#endregion
export { isBundledSkillAllowed as _, resolveSkillsPromptForRun as a, resolveSkillConfig as b, resolveBundledSkillsDir as c, resolveSandboxInputPath as d, resolveSandboxPath as f, sanitizeEnvVars as g, applySkillEnvOverridesFromSnapshot as h, loadWorkspaceSkillEntries as i, assertMediaNotDataUrl as l, applySkillEnvOverrides as m, buildWorkspaceSkillCommandSpecs as n, syncSkillsToWorkspace as o, resolveSandboxedMediaSource as p, buildWorkspaceSkillSnapshot as r, resolvePluginSkillDirs as s, resolveSkillsInstallPreferences as t, assertSandboxPath as u, isConfigPathTruthy as v, resolveSkillKey as x, resolveBundledAllowlist as y };