import { t as createSubsystemLogger } from "./subsystem-EnljYYs1.js";
import { n as markOpenClawExecEnv } from "./openclaw-exec-env-YQjF2qEk.js";
import { c as normalizeResolvedSecretInputString } from "./types.secrets-CgNgVfYE.js";
import { r as normalizeStringEntries } from "./string-normalization-CJJOCyGw.js";
import { a as parseOpenClawManifestInstallBase, c as resolveOpenClawManifestOs, d as evaluateRuntimeEligibility, f as hasBinary, i as parseFrontmatterBool, l as resolveOpenClawManifestRequires, n as getFrontmatterString, o as resolveOpenClawManifestBlock, p as isConfigPathTruthyWithDefaults, r as normalizeStringList, s as resolveOpenClawManifestInstall, t as applyOpenClawManifestInstallCommonFields, u as parseFrontmatterBlock } from "./frontmatter-UI6LO8NQ.js";
import { n as validateEnvVarValue, t as sanitizeEnvVars } from "./sanitize-env-vars-BiLWBEoq.js";
//#region src/infra/host-env-security-policy.json
var host_env_security_policy_default = {
	blockedKeys: [
		"NODE_OPTIONS",
		"NODE_PATH",
		"PYTHONHOME",
		"PYTHONPATH",
		"PERL5LIB",
		"PERL5OPT",
		"RUBYLIB",
		"RUBYOPT",
		"BASH_ENV",
		"ENV",
		"GIT_EXTERNAL_DIFF",
		"GIT_EXEC_PATH",
		"SHELL",
		"SHELLOPTS",
		"PS4",
		"GCONV_PATH",
		"IFS",
		"SSLKEYLOGFILE"
	],
	blockedOverrideKeys: [
		"HOME",
		"ZDOTDIR",
		"GIT_SSH_COMMAND",
		"GIT_SSH",
		"GIT_PROXY_COMMAND",
		"GIT_ASKPASS",
		"SSH_ASKPASS",
		"LESSOPEN",
		"LESSCLOSE",
		"PAGER",
		"MANPAGER",
		"GIT_PAGER",
		"EDITOR",
		"VISUAL",
		"FCEDIT",
		"SUDO_EDITOR",
		"PROMPT_COMMAND",
		"HISTFILE",
		"PERL5DB",
		"PERL5DBCMD",
		"OPENSSL_CONF",
		"OPENSSL_ENGINES",
		"PYTHONSTARTUP",
		"WGETRC",
		"CURL_HOME"
	],
	blockedOverridePrefixes: ["GIT_CONFIG_", "NPM_CONFIG_"],
	blockedPrefixes: [
		"DYLD_",
		"LD_",
		"BASH_FUNC_"
	]
};
//#endregion
//#region src/infra/host-env-security.ts
const PORTABLE_ENV_VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST_ENV_SECURITY_POLICY = host_env_security_policy_default;
const HOST_DANGEROUS_ENV_KEY_VALUES = Object.freeze(HOST_ENV_SECURITY_POLICY.blockedKeys.map((key) => key.toUpperCase()));
const HOST_DANGEROUS_ENV_PREFIXES = Object.freeze(HOST_ENV_SECURITY_POLICY.blockedPrefixes.map((prefix) => prefix.toUpperCase()));
const HOST_DANGEROUS_OVERRIDE_ENV_KEY_VALUES = Object.freeze((HOST_ENV_SECURITY_POLICY.blockedOverrideKeys ?? []).map((key) => key.toUpperCase()));
const HOST_DANGEROUS_OVERRIDE_ENV_PREFIXES = Object.freeze((HOST_ENV_SECURITY_POLICY.blockedOverridePrefixes ?? []).map((prefix) => prefix.toUpperCase()));
const HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEY_VALUES = Object.freeze([
	"TERM",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR"
]);
const HOST_DANGEROUS_ENV_KEYS = new Set(HOST_DANGEROUS_ENV_KEY_VALUES);
const HOST_DANGEROUS_OVERRIDE_ENV_KEYS = new Set(HOST_DANGEROUS_OVERRIDE_ENV_KEY_VALUES);
const HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEYS = new Set(HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEY_VALUES);
function normalizeEnvVarKey(rawKey, options) {
	const key = rawKey.trim();
	if (!key) {return null;}
	if (options?.portable && !PORTABLE_ENV_VAR_KEY.test(key)) {return null;}
	return key;
}
function isDangerousHostEnvVarName(rawKey) {
	const key = normalizeEnvVarKey(rawKey);
	if (!key) {return false;}
	const upper = key.toUpperCase();
	if (HOST_DANGEROUS_ENV_KEYS.has(upper)) {return true;}
	return HOST_DANGEROUS_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}
function isDangerousHostEnvOverrideVarName(rawKey) {
	const key = normalizeEnvVarKey(rawKey);
	if (!key) {return false;}
	const upper = key.toUpperCase();
	if (HOST_DANGEROUS_OVERRIDE_ENV_KEYS.has(upper)) {return true;}
	return HOST_DANGEROUS_OVERRIDE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}
function listNormalizedPortableEnvEntries(source) {
	const entries = [];
	for (const [rawKey, value] of Object.entries(source)) {
		if (typeof value !== "string") {continue;}
		const key = normalizeEnvVarKey(rawKey, { portable: true });
		if (!key) {continue;}
		entries.push([key, value]);
	}
	return entries;
}
function sanitizeHostExecEnv(params) {
	const baseEnv = params?.baseEnv ?? process.env;
	const overrides = params?.overrides ?? void 0;
	const blockPathOverrides = params?.blockPathOverrides ?? true;
	const merged = {};
	for (const [key, value] of listNormalizedPortableEnvEntries(baseEnv)) {
		if (isDangerousHostEnvVarName(key)) {continue;}
		merged[key] = value;
	}
	if (!overrides) {return markOpenClawExecEnv(merged);}
	for (const [key, value] of listNormalizedPortableEnvEntries(overrides)) {
		const upper = key.toUpperCase();
		if (blockPathOverrides && upper === "PATH") {continue;}
		if (isDangerousHostEnvVarName(upper) || isDangerousHostEnvOverrideVarName(upper)) {continue;}
		merged[key] = value;
	}
	return markOpenClawExecEnv(merged);
}
function sanitizeSystemRunEnvOverrides(params) {
	const overrides = params?.overrides ?? void 0;
	if (!overrides) {return;}
	if (!params?.shellWrapper) {return overrides;}
	const filtered = {};
	for (const [key, value] of listNormalizedPortableEnvEntries(overrides)) {
		if (!HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEYS.has(key.toUpperCase())) {continue;}
		filtered[key] = value;
	}
	return Object.keys(filtered).length > 0 ? filtered : void 0;
}
//#endregion
//#region src/infra/npm-registry-spec.ts
const EXACT_SEMVER_VERSION_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const DIST_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function parseRegistryNpmSpecInternal(rawSpec) {
	const spec = rawSpec.trim();
	if (!spec) {return {
		ok: false,
		error: "missing npm spec"
	};}
	if (/\s/.test(spec)) {return {
		ok: false,
		error: "unsupported npm spec: whitespace is not allowed"
	};}
	if (spec.includes("://")) {return {
		ok: false,
		error: "unsupported npm spec: URLs are not allowed"
	};}
	if (spec.includes("#")) {return {
		ok: false,
		error: "unsupported npm spec: git refs are not allowed"
	};}
	if (spec.includes(":")) {return {
		ok: false,
		error: "unsupported npm spec: protocol specs are not allowed"
	};}
	const at = spec.lastIndexOf("@");
	const hasSelector = at > 0;
	const name = hasSelector ? spec.slice(0, at) : spec;
	const selector = hasSelector ? spec.slice(at + 1) : "";
	if (!(name.startsWith("@") ? /^@[a-z0-9][a-z0-9-._~]*\/[a-z0-9][a-z0-9-._~]*$/.test(name) : /^[a-z0-9][a-z0-9-._~]*$/.test(name))) {return {
		ok: false,
		error: "unsupported npm spec: expected <name> or <name>@<version> from the npm registry"
	};}
	if (!hasSelector) {return {
		ok: true,
		parsed: {
			name,
			raw: spec,
			selectorKind: "none",
			selectorIsPrerelease: false
		}
	};}
	if (!selector) {return {
		ok: false,
		error: "unsupported npm spec: missing version/tag after @"
	};}
	if (/[\\/]/.test(selector)) {return {
		ok: false,
		error: "unsupported npm spec: invalid version/tag"
	};}
	const exactVersionMatch = EXACT_SEMVER_VERSION_RE.exec(selector);
	if (exactVersionMatch) {return {
		ok: true,
		parsed: {
			name,
			raw: spec,
			selector,
			selectorKind: "exact-version",
			selectorIsPrerelease: Boolean(exactVersionMatch[4])
		}
	};}
	if (!DIST_TAG_RE.test(selector)) {return {
		ok: false,
		error: "unsupported npm spec: use an exact version or dist-tag (ranges are not allowed)"
	};}
	return {
		ok: true,
		parsed: {
			name,
			raw: spec,
			selector,
			selectorKind: "tag",
			selectorIsPrerelease: false
		}
	};
}
function parseRegistryNpmSpec(rawSpec) {
	const parsed = parseRegistryNpmSpecInternal(rawSpec);
	return parsed.ok ? parsed.parsed : null;
}
function validateRegistryNpmSpec(rawSpec) {
	const parsed = parseRegistryNpmSpecInternal(rawSpec);
	return parsed.ok ? null : parsed.error;
}
function isPrereleaseSemverVersion(value) {
	const match = EXACT_SEMVER_VERSION_RE.exec(value.trim());
	return Boolean(match?.[4]);
}
function isPrereleaseResolutionAllowed(params) {
	if (!params.resolvedVersion || !isPrereleaseSemverVersion(params.resolvedVersion)) {return true;}
	if (params.spec.selectorKind === "none") {return false;}
	if (params.spec.selectorKind === "exact-version") {return params.spec.selectorIsPrerelease;}
	return params.spec.selector?.toLowerCase() !== "latest";
}
function formatPrereleaseResolutionError(params) {
	const selectorHint = params.spec.selectorKind === "none" || params.spec.selector?.toLowerCase() === "latest" ? `Use "${params.spec.name}@beta" (or another prerelease tag) or an exact prerelease version to opt in explicitly.` : `Use an explicit prerelease tag or exact prerelease version if you want prerelease installs.`;
	return `Resolved ${params.spec.raw} to prerelease version ${params.resolvedVersion}, but prereleases are only installed when explicitly requested. ${selectorHint}`;
}
//#endregion
//#region src/agents/skills/frontmatter.ts
function parseFrontmatter(content) {
	return parseFrontmatterBlock(content);
}
const BREW_FORMULA_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@+._/-]*$/;
const GO_MODULE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~+\-/]*(?:@[A-Za-z0-9][A-Za-z0-9._~+\-/]*)?$/;
const UV_PACKAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-[\]=<>!~+,]*$/;
function normalizeSafeBrewFormula(raw) {
	if (typeof raw !== "string") {return;}
	const formula = raw.trim();
	if (!formula || formula.startsWith("-") || formula.includes("\\") || formula.includes("..")) {return;}
	if (!BREW_FORMULA_PATTERN.test(formula)) {return;}
	return formula;
}
function normalizeSafeNpmSpec(raw) {
	if (typeof raw !== "string") {return;}
	const spec = raw.trim();
	if (!spec || spec.startsWith("-")) {return;}
	if (validateRegistryNpmSpec(spec) !== null) {return;}
	return spec;
}
function normalizeSafeGoModule(raw) {
	if (typeof raw !== "string") {return;}
	const moduleSpec = raw.trim();
	if (!moduleSpec || moduleSpec.startsWith("-") || moduleSpec.includes("\\") || moduleSpec.includes("://")) {return;}
	if (!GO_MODULE_PATTERN.test(moduleSpec)) {return;}
	return moduleSpec;
}
function normalizeSafeUvPackage(raw) {
	if (typeof raw !== "string") {return;}
	const pkg = raw.trim();
	if (!pkg || pkg.startsWith("-") || pkg.includes("\\") || pkg.includes("://")) {return;}
	if (!UV_PACKAGE_PATTERN.test(pkg)) {return;}
	return pkg;
}
function normalizeSafeDownloadUrl(raw) {
	if (typeof raw !== "string") {return;}
	const value = raw.trim();
	if (!value || /\s/.test(value)) {return;}
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {return;}
		return parsed.toString();
	} catch {
		return;
	}
}
function parseInstallSpec(input) {
	const parsed = parseOpenClawManifestInstallBase(input, [
		"brew",
		"node",
		"go",
		"uv",
		"download"
	]);
	if (!parsed) {return;}
	const { raw } = parsed;
	const spec = applyOpenClawManifestInstallCommonFields({ kind: parsed.kind }, parsed);
	const osList = normalizeStringList(raw.os);
	if (osList.length > 0) {spec.os = osList;}
	const formula = normalizeSafeBrewFormula(raw.formula);
	if (formula) {spec.formula = formula;}
	const cask = normalizeSafeBrewFormula(raw.cask);
	if (!spec.formula && cask) {spec.formula = cask;}
	if (spec.kind === "node") {
		const pkg = normalizeSafeNpmSpec(raw.package);
		if (pkg) {spec.package = pkg;}
	} else if (spec.kind === "uv") {
		const pkg = normalizeSafeUvPackage(raw.package);
		if (pkg) {spec.package = pkg;}
	}
	const moduleSpec = normalizeSafeGoModule(raw.module);
	if (moduleSpec) {spec.module = moduleSpec;}
	const downloadUrl = normalizeSafeDownloadUrl(raw.url);
	if (downloadUrl) {spec.url = downloadUrl;}
	if (typeof raw.archive === "string") {spec.archive = raw.archive;}
	if (typeof raw.extract === "boolean") {spec.extract = raw.extract;}
	if (typeof raw.stripComponents === "number") {spec.stripComponents = raw.stripComponents;}
	if (typeof raw.targetDir === "string") {spec.targetDir = raw.targetDir;}
	if (spec.kind === "brew" && !spec.formula) {return;}
	if (spec.kind === "node" && !spec.package) {return;}
	if (spec.kind === "go" && !spec.module) {return;}
	if (spec.kind === "uv" && !spec.package) {return;}
	if (spec.kind === "download" && !spec.url) {return;}
	return spec;
}
function resolveOpenClawMetadata(frontmatter) {
	const metadataObj = resolveOpenClawManifestBlock({ frontmatter });
	if (!metadataObj) {return;}
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
	if (!skills || typeof skills !== "object") {return;}
	const entry = skills[skillKey];
	if (!entry || typeof entry !== "object") {return;}
	return entry;
}
function normalizeAllowlist(input) {
	if (!input) {return;}
	if (!Array.isArray(input)) {return;}
	const normalized = normalizeStringEntries(input);
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
	if (!allowlist || allowlist.length === 0) {return true;}
	if (!isBundledSkill(entry)) {return true;}
	const key = resolveSkillKey(entry.skill, entry);
	return allowlist.includes(key) || allowlist.includes(entry.skill.name);
}
function shouldIncludeSkill(params) {
	const { entry, config, eligibility } = params;
	const skillConfig = resolveSkillConfig(config, resolveSkillKey(entry.skill, entry));
	const allowBundled = normalizeAllowlist(config?.skills?.allowBundled);
	if (skillConfig?.enabled === false) {return false;}
	if (!isBundledSkillAllowed(entry, allowBundled)) {return false;}
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
//#region src/agents/skills/env-overrides.ts
const log = createSubsystemLogger("env-overrides");
/**
* Tracks env var keys that are currently injected by skill overrides.
* Used by ACP harness spawn to strip skill-injected keys so they don't
* leak to child processes (e.g., OPENAI_API_KEY leaking to Codex CLI).
* @see https://github.com/openclaw/openclaw/issues/36280
*/
const activeSkillEnvEntries = /* @__PURE__ */ new Map();
/** Returns a snapshot of env var keys currently injected by skill overrides. */
function getActiveSkillEnvKeys() {
	return new Set(activeSkillEnvEntries.keys());
}
function acquireActiveSkillEnvKey(key, value) {
	const active = activeSkillEnvEntries.get(key);
	if (active) {
		active.count += 1;
		if (process.env[key] === void 0) {process.env[key] = active.value;}
		return true;
	}
	if (process.env[key] !== void 0) {return false;}
	activeSkillEnvEntries.set(key, {
		baseline: process.env[key],
		value,
		count: 1
	});
	return true;
}
function releaseActiveSkillEnvKey(key) {
	const active = activeSkillEnvEntries.get(key);
	if (!active) {return;}
	active.count -= 1;
	if (active.count > 0) {
		if (process.env[key] === void 0) {process.env[key] = active.value;}
		return;
	}
	activeSkillEnvEntries.delete(key);
	if (active.baseline === void 0) {delete process.env[key];}
	else {process.env[key] = active.baseline;}
}
const SKILL_ALWAYS_BLOCKED_ENV_PATTERNS = [/^OPENSSL_CONF$/i];
function matchesAnyPattern(value, patterns) {
	return patterns.some((pattern) => pattern.test(value));
}
function isAlwaysBlockedSkillEnvKey(key) {
	return isDangerousHostEnvVarName(key) || matchesAnyPattern(key, SKILL_ALWAYS_BLOCKED_ENV_PATTERNS);
}
function sanitizeSkillEnvOverrides(params) {
	if (Object.keys(params.overrides).length === 0) {return {
		allowed: {},
		blocked: [],
		warnings: []
	};}
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
		if (!value) {continue;}
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
	if (normalizedPrimaryEnv) {allowedSensitiveKeys.add(normalizedPrimaryEnv);}
	for (const envName of requiredEnv ?? []) {
		const trimmedEnv = envName.trim();
		if (trimmedEnv) {allowedSensitiveKeys.add(trimmedEnv);}
	}
	const pendingOverrides = {};
	if (skillConfig.env) {for (const [rawKey, envValue] of Object.entries(skillConfig.env)) {
		const envKey = rawKey.trim();
		const hasExternallyManagedValue = process.env[envKey] !== void 0 && !activeSkillEnvEntries.has(envKey);
		if (!envKey || !envValue || hasExternallyManagedValue) continue;
		pendingOverrides[envKey] = envValue;
	}}
	const resolvedApiKey = normalizeResolvedSecretInputString({
		value: skillConfig.apiKey,
		path: `skills.entries.${skillKey}.apiKey`
	}) ?? "";
	if (normalizedPrimaryEnv && (process.env[normalizedPrimaryEnv] === void 0 || activeSkillEnvEntries.has(normalizedPrimaryEnv)) && resolvedApiKey) {
		if (!pendingOverrides[normalizedPrimaryEnv]) {pendingOverrides[normalizedPrimaryEnv] = resolvedApiKey;}
	}
	const sanitized = sanitizeSkillEnvOverrides({
		overrides: pendingOverrides,
		allowedSensitiveKeys
	});
	if (sanitized.blocked.length > 0) {log.warn(`Blocked skill env overrides for ${skillKey}: ${sanitized.blocked.join(", ")}`);}
	if (sanitized.warnings.length > 0) {log.warn(`Suspicious skill env overrides for ${skillKey}: ${sanitized.warnings.join(", ")}`);}
	for (const [envKey, envValue] of Object.entries(sanitized.allowed)) {
		if (!acquireActiveSkillEnvKey(envKey, envValue)) {continue;}
		updates.push({ key: envKey });
		process.env[envKey] = activeSkillEnvEntries.get(envKey)?.value ?? envValue;
	}
}
function createEnvReverter(updates) {
	return () => {
		for (const update of updates) {releaseActiveSkillEnvKey(update.key);}
	};
}
function applySkillEnvOverrides(params) {
	const { skills, config } = params;
	const updates = [];
	for (const entry of skills) {
		const skillKey = resolveSkillKey(entry.skill, entry);
		const skillConfig = resolveSkillConfig(config, skillKey);
		if (!skillConfig) {continue;}
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
	if (!snapshot) {return () => {};}
	const updates = [];
	for (const skill of snapshot.skills) {
		const skillConfig = resolveSkillConfig(config, skill.name);
		if (!skillConfig) {continue;}
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
export { isDangerousHostEnvOverrideVarName as _, isConfigPathTruthy as a, sanitizeHostExecEnv as b, shouldIncludeSkill as c, resolveSkillInvocationPolicy as d, resolveSkillKey as f, validateRegistryNpmSpec as g, parseRegistryNpmSpec as h, isBundledSkillAllowed as i, parseFrontmatter as l, isPrereleaseResolutionAllowed as m, applySkillEnvOverridesFromSnapshot as n, resolveBundledAllowlist as o, formatPrereleaseResolutionError as p, getActiveSkillEnvKeys as r, resolveSkillConfig as s, applySkillEnvOverrides as t, resolveOpenClawMetadata as u, isDangerousHostEnvVarName as v, sanitizeSystemRunEnvOverrides as x, normalizeEnvVarKey as y };
