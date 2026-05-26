import { n as isDangerousHostEnvOverrideVarName, r as isDangerousHostEnvVarName } from "./host-env-security-66KkrZF_.js";
import { o as coerceSecretRef, u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as getRuntimeConfigSnapshot } from "./runtime-snapshot-DgdkBEdP.js";
import { r as validateEnvVarValue, t as sanitizeEnvVars } from "./sanitize-env-vars-4wyDg6L9.js";
import { i as resolveSkillKey } from "./frontmatter-BTFF5uon.js";
import { i as resolveSkillConfig } from "./config-DU04JXyx.js";
//#region src/agents/skills/runtime-config.ts
function hasConfiguredSkillApiKeyRef(config) {
	const entries = config?.skills?.entries;
	if (!entries || typeof entries !== "object") return false;
	for (const skillConfig of Object.values(entries)) {
		if (!skillConfig || typeof skillConfig !== "object") continue;
		if (coerceSecretRef(skillConfig.apiKey) !== null) return true;
	}
	return false;
}
function resolveSkillRuntimeConfig(config) {
	const runtimeConfig = getRuntimeConfigSnapshot();
	if (!runtimeConfig) return config;
	if (!config) return runtimeConfig;
	const runtimeHasRawSkillSecretRefs = hasConfiguredSkillApiKeyRef(runtimeConfig);
	const configHasRawSkillSecretRefs = hasConfiguredSkillApiKeyRef(config);
	if (runtimeHasRawSkillSecretRefs && !configHasRawSkillSecretRefs) return config;
	return runtimeConfig;
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
		if (process.env[key] === void 0) process.env[key] = active.value;
		return true;
	}
	if (process.env[key] !== void 0) return false;
	activeSkillEnvEntries.set(key, {
		baseline: process.env[key],
		value,
		count: 1
	});
	return true;
}
function releaseActiveSkillEnvKey(key) {
	const active = activeSkillEnvEntries.get(key);
	if (!active) return;
	active.count -= 1;
	if (active.count > 0) {
		if (process.env[key] === void 0) process.env[key] = active.value;
		return;
	}
	activeSkillEnvEntries.delete(key);
	if (active.baseline === void 0) delete process.env[key];
	else process.env[key] = active.baseline;
}
const SKILL_ALWAYS_BLOCKED_ENV_PATTERNS = [/^OPENSSL_CONF$/i];
function matchesAnyPattern(value, patterns) {
	return patterns.some((pattern) => pattern.test(value));
}
function isAlwaysBlockedSkillEnvKey(key) {
	return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key) || matchesAnyPattern(key, SKILL_ALWAYS_BLOCKED_ENV_PATTERNS);
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
		const hasExternallyManagedValue = process.env[envKey] !== void 0 && !activeSkillEnvEntries.has(envKey);
		if (!envKey || !envValue || hasExternallyManagedValue) continue;
		pendingOverrides[envKey] = envValue;
	}
	if (normalizedPrimaryEnv && (process.env[normalizedPrimaryEnv] === void 0 || activeSkillEnvEntries.has(normalizedPrimaryEnv)) && !pendingOverrides[normalizedPrimaryEnv]) {
		const resolvedApiKey = normalizeResolvedSecretInputString({
			value: skillConfig.apiKey,
			path: `skills.entries.${skillKey}.apiKey`
		}) ?? "";
		if (resolvedApiKey) pendingOverrides[normalizedPrimaryEnv] = resolvedApiKey;
	}
	const sanitized = sanitizeSkillEnvOverrides({
		overrides: pendingOverrides,
		allowedSensitiveKeys
	});
	if (sanitized.blocked.length > 0) log.warn(`Blocked skill env overrides for ${skillKey}: ${sanitized.blocked.join(", ")}`);
	if (sanitized.warnings.length > 0) log.warn(`Suspicious skill env overrides for ${skillKey}: ${sanitized.warnings.join(", ")}`);
	for (const [envKey, envValue] of Object.entries(sanitized.allowed)) {
		if (!acquireActiveSkillEnvKey(envKey, envValue)) continue;
		updates.push({ key: envKey });
		process.env[envKey] = activeSkillEnvEntries.get(envKey)?.value ?? envValue;
	}
}
function createEnvReverter(updates) {
	return () => {
		for (const update of updates) releaseActiveSkillEnvKey(update.key);
	};
}
function applySkillEnvOverrides(params) {
	const { skills } = params;
	const config = resolveSkillRuntimeConfig(params.config);
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
	const { snapshot } = params;
	const config = resolveSkillRuntimeConfig(params.config);
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
export { resolveSkillRuntimeConfig as i, applySkillEnvOverridesFromSnapshot as n, getActiveSkillEnvKeys as r, applySkillEnvOverrides as t };
