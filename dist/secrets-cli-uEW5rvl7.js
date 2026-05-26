import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, d as normalizeStringifiedOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import { r as theme } from "./theme-CStEj1vt.js";
import { c as isRecord, d as resolveConfigDir, p as resolveUserPath } from "./utils-CKsuXgDI.js";
import { m as resolveSecretInputRef, o as coerceSecretRef } from "./types.secrets-BxqheYvy.js";
import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { c as normalizeAgentId } from "./session-key-DFEyR49L.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId, n as listAgentIds, r as resolveAgentConfig } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { a as parseEnvValue, i as parseDotPath, l as writeTextFileAtomic, n as isNonEmptyString, s as toDotPath } from "./shared-yONM2O7r.js";
import { n as getPath, r as setPathCreateStrict, t as deletePathStrict } from "./path-utils-Dw-vVQlL.js";
import { a as listAuthProfileSecretTargetEntries, c as resolvePlanTargetAgainstRegistry, n as discoverConfigSecretTargets, t as discoverAuthProfileSecretTargets } from "./target-registry-BBvvwcuS.js";
import { a as formatExecSecretRefIdValidationMessage, c as isValidSecretProviderAlias, l as resolveDefaultSecretProviderAlias, o as isValidExecSecretRefId, u as secretRefKey } from "./ref-contract-BLk8mcqQ.js";
import { t as runTasksWithConcurrency } from "./run-with-concurrency-u5TU0MMx.js";
import { a as resolveSecretRefValue, o as resolveSecretRefValues, r as isProviderScopedSecretResolutionError } from "./resolve-BHS7vHp1.js";
import { t as danger } from "./globals-CouSpJO4.js";
import { r as createConfigIO } from "./io-5xE1dPMK.js";
import { r as listKnownSecretEnvVarNames, t as getProviderEnvVars } from "./provider-env-vars-Bdegz5z9.js";
import { t as isSafeExecutableValue } from "./exec-safety-D79DFxXy.js";
import { w as SecretProviderSchema } from "./zod-schema.core-CrlgnnCI.js";
import { r as replaceConfigFile } from "./mutate-FhI2HIyp.js";
import "./config-CzeRK-GW.js";
import { t as formatGatewayCommandFailure } from "./error-format-ByBZDdph.js";
import { l as resolveAuthStorePath } from "./source-check-BnSDslnj.js";
import { c as loadAuthProfileStoreForSecretsRuntime, g as loadPersistedAuthProfileStore, h as coercePersistedAuthProfileStore } from "./store-a4exFSck.js";
import { f as isSecretRefHeaderValueMarker, u as isNonSecretApiKeyMarker } from "./model-auth-markers-UDEQVW7W.js";
import "./model-selection-VRXWv5rs.js";
import "./auth-profiles-vKILPyQ8.js";
import { a as prepareSecretsRuntimeSnapshot } from "./runtime-DvTwLiTi.js";
import { n as hasConfiguredPlaintextSecretValue, r as isExpectedResolvedSecretValue, t as assertExpectedResolvedSecretValue } from "./secret-value-ArhpyKkL.js";
import { n as callGatewayFromCli, t as addGatewayClientOptions } from "./gateway-rpc-Dfnu29I8.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isDeepStrictEqual } from "node:util";
import { confirm, select, text } from "@clack/prompts";
//#region src/secrets/auth-profiles-scan.ts
function getAuthProfileFieldName(pathPattern) {
	const segments = pathPattern.split(".").filter(Boolean);
	return segments[segments.length - 1] ?? "";
}
const AUTH_PROFILE_FIELD_SPEC_BY_TYPE = (() => {
	const defaults = {
		api_key: {
			valueField: "key",
			refField: "keyRef"
		},
		token: {
			valueField: "token",
			refField: "tokenRef"
		}
	};
	for (const target of listAuthProfileSecretTargetEntries()) {
		if (!target.authProfileType) continue;
		defaults[target.authProfileType] = {
			valueField: getAuthProfileFieldName(target.pathPattern),
			refField: target.refPathPattern !== void 0 ? getAuthProfileFieldName(target.refPathPattern) : defaults[target.authProfileType].refField
		};
	}
	return defaults;
})();
function getAuthProfileFieldSpec(type) {
	return AUTH_PROFILE_FIELD_SPEC_BY_TYPE[type];
}
function toSecretCredentialVisit(params) {
	const spec = getAuthProfileFieldSpec(params.kind);
	return {
		kind: params.kind,
		profileId: params.profileId,
		provider: params.provider,
		profile: params.profile,
		valueField: spec.valueField,
		refField: spec.refField,
		value: params.profile[spec.valueField],
		refValue: params.profile[spec.refField]
	};
}
function* iterateAuthProfileCredentials(profiles) {
	for (const [profileId, value] of Object.entries(profiles)) {
		if (!isRecord(value) || !isNonEmptyString(value.provider)) continue;
		const provider = value.provider;
		if (value.type === "api_key" || value.type === "token") {
			yield toSecretCredentialVisit({
				kind: value.type,
				profileId,
				provider,
				profile: value
			});
			continue;
		}
		if (value.type === "oauth") yield {
			kind: "oauth",
			profileId,
			provider,
			profile: value,
			hasAccess: isNonEmptyString(value.access),
			hasRefresh: isNonEmptyString(value.refresh)
		};
	}
}
//#endregion
//#region src/secrets/config-io.ts
const silentConfigIoLogger = {
	error: () => {},
	warn: () => {}
};
function createSecretsConfigIO(params) {
	return createConfigIO({
		env: params.env,
		logger: silentConfigIoLogger
	});
}
//#endregion
//#region src/secrets/exec-resolution-policy.ts
function selectRefsForExecPolicy(params) {
	const refsToResolve = [];
	const skippedExecRefs = [];
	for (const ref of params.refs) {
		if (ref.source === "exec" && !params.allowExec) {
			skippedExecRefs.push(ref);
			continue;
		}
		refsToResolve.push(ref);
	}
	return {
		refsToResolve,
		skippedExecRefs
	};
}
function getSkippedExecRefStaticError(params) {
	const id = params.ref.id.trim();
	const refLabel = `${params.ref.source}:${params.ref.provider}:${id}`;
	if (!id) return "Error: Secret reference id is empty.";
	if (!isValidExecSecretRefId(id)) return `Error: ${formatExecSecretRefIdValidationMessage()} (ref: ${refLabel}).`;
	const providerConfig = params.config.secrets?.providers?.[params.ref.provider];
	if (!providerConfig) return `Error: Secret provider "${params.ref.provider}" is not configured (ref: ${refLabel}).`;
	if (providerConfig.source !== params.ref.source) return `Error: Secret provider "${params.ref.provider}" has source "${providerConfig.source}" but ref requests "${params.ref.source}".`;
	return null;
}
//#endregion
//#region src/secrets/plan.ts
const FORBIDDEN_PATH_SEGMENTS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
function isObjectRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isSecretProviderConfigShape(value) {
	return SecretProviderSchema.safeParse(value).success;
}
function hasForbiddenPathSegment(segments) {
	return segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment));
}
function resolveValidatedPlanTarget(candidate) {
	if (typeof candidate.type !== "string" || !candidate.type.trim()) return null;
	const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
	if (!path) return null;
	const segments = Array.isArray(candidate.pathSegments) && candidate.pathSegments.length > 0 ? candidate.pathSegments.map((segment) => segment.trim()).filter(Boolean) : parseDotPath(path);
	if (segments.length === 0 || hasForbiddenPathSegment(segments) || path !== toDotPath(segments)) return null;
	return resolvePlanTargetAgainstRegistry({
		type: candidate.type,
		pathSegments: segments,
		providerId: candidate.providerId,
		accountId: candidate.accountId
	});
}
function isSecretsApplyPlan(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const typed = value;
	if (typed.version !== 1 || typed.protocolVersion !== 1 || !Array.isArray(typed.targets)) return false;
	for (const target of typed.targets) {
		if (!target || typeof target !== "object") return false;
		const candidate = target;
		const ref = candidate.ref;
		const resolved = resolveValidatedPlanTarget({
			type: candidate.type,
			path: candidate.path,
			pathSegments: candidate.pathSegments,
			agentId: candidate.agentId,
			providerId: candidate.providerId,
			accountId: candidate.accountId,
			authProfileProvider: candidate.authProfileProvider
		});
		if (typeof candidate.path !== "string" || !candidate.path.trim() || candidate.pathSegments !== void 0 && !Array.isArray(candidate.pathSegments) || !resolved || !ref || typeof ref !== "object" || ref.source !== "env" && ref.source !== "file" && ref.source !== "exec" || typeof ref.provider !== "string" || ref.provider.trim().length === 0 || typeof ref.id !== "string" || ref.id.trim().length === 0 || ref.source === "exec" && !isValidExecSecretRefId(ref.id)) return false;
		if (resolved.entry.configFile === "auth-profiles.json") {
			if (typeof candidate.agentId !== "string" || candidate.agentId.trim().length === 0) return false;
			if (candidate.authProfileProvider !== void 0 && (typeof candidate.authProfileProvider !== "string" || candidate.authProfileProvider.trim().length === 0)) return false;
		}
	}
	if (typed.providerUpserts !== void 0) {
		if (!isObjectRecord(typed.providerUpserts)) return false;
		for (const [providerAlias, providerValue] of Object.entries(typed.providerUpserts)) {
			if (!isValidSecretProviderAlias(providerAlias)) return false;
			if (!isSecretProviderConfigShape(providerValue)) return false;
		}
	}
	if (typed.providerDeletes !== void 0) {
		if (!Array.isArray(typed.providerDeletes) || typed.providerDeletes.some((providerAlias) => typeof providerAlias !== "string" || !isValidSecretProviderAlias(providerAlias))) return false;
	}
	return true;
}
function normalizeSecretsPlanOptions(options) {
	return {
		scrubEnv: options?.scrubEnv ?? true,
		scrubAuthProfilesForProviderTargets: options?.scrubAuthProfilesForProviderTargets ?? true,
		scrubLegacyAuthJson: options?.scrubLegacyAuthJson ?? true
	};
}
//#endregion
//#region src/secrets/auth-store-paths.ts
function listAuthProfileStorePaths$1(config, stateDir) {
	const paths = /* @__PURE__ */ new Set();
	paths.add(path.join(resolveUserPath(stateDir), "agents", "main", "agent", "auth-profiles.json"));
	const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
	if (fs.existsSync(agentsRoot)) for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		paths.add(path.join(agentsRoot, entry.name, "agent", "auth-profiles.json"));
	}
	for (const agentId of listAgentIds(config)) {
		if (agentId === "main") {
			paths.add(path.join(resolveUserPath(stateDir), "agents", "main", "agent", "auth-profiles.json"));
			continue;
		}
		const agentDir = resolveAgentDir(config, agentId);
		paths.add(resolveUserPath(resolveAuthStorePath(agentDir)));
	}
	return [...paths];
}
//#endregion
//#region src/secrets/storage-scan.ts
function isJsonObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseEnvAssignmentValue(raw) {
	return parseEnvValue(raw);
}
function listAuthProfileStorePaths(config, stateDir) {
	return listAuthProfileStorePaths$1(config, stateDir);
}
function listLegacyAuthJsonPaths(stateDir) {
	const out = [];
	const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
	if (!fs.existsSync(agentsRoot)) return out;
	for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const candidate = path.join(agentsRoot, entry.name, "agent", "auth.json");
		if (fs.existsSync(candidate)) out.push(candidate);
	}
	return out;
}
function resolveActiveAgentDir(stateDir, env = process.env) {
	const override = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
	if (override) return resolveUserPath(override);
	return path.join(resolveUserPath(stateDir), "agents", "main", "agent");
}
function listAgentModelsJsonPaths(config, stateDir, env = process.env) {
	const resolvedStateDir = resolveUserPath(stateDir);
	const paths = /* @__PURE__ */ new Set();
	paths.add(path.join(resolvedStateDir, "agents", "main", "agent", "models.json"));
	paths.add(path.join(resolveActiveAgentDir(stateDir, env), "models.json"));
	const agentsRoot = path.join(resolvedStateDir, "agents");
	if (fs.existsSync(agentsRoot)) for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		paths.add(path.join(agentsRoot, entry.name, "agent", "models.json"));
	}
	for (const agentId of listAgentIds(config)) {
		if (agentId === "main") {
			paths.add(path.join(resolvedStateDir, "agents", "main", "agent", "models.json"));
			continue;
		}
		const agentDir = resolveAgentDir(config, agentId);
		paths.add(path.join(resolveUserPath(agentDir), "models.json"));
	}
	return [...paths];
}
function readJsonObjectIfExists(filePath, options = {}) {
	if (!fs.existsSync(filePath)) return { value: null };
	try {
		const stats = fs.statSync(filePath);
		if (options.requireRegularFile && !stats.isFile()) return {
			value: null,
			error: `Refusing to read non-regular file: ${filePath}`
		};
		if (typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes) && options.maxBytes >= 0 && stats.size > options.maxBytes) return {
			value: null,
			error: `Refusing to read oversized JSON (${stats.size} bytes): ${filePath}`
		};
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (!isJsonObject(parsed)) return { value: null };
		return { value: parsed };
	} catch (err) {
		return {
			value: null,
			error: formatErrorMessage(err)
		};
	}
}
//#endregion
//#region src/secrets/apply.ts
function planContainsExecReferences(plan) {
	if (plan.targets.some((target) => target.ref.source === "exec")) return true;
	return Object.values(plan.providerUpserts ?? {}).some((provider) => provider.source === "exec");
}
function resolveTarget(target) {
	const resolved = resolveValidatedPlanTarget(target);
	if (!resolved) throw new Error(`Invalid plan target path for ${target.type}: ${target.path}`);
	return resolved;
}
function scrubEnvRaw(raw, migratedValues, allowedEnvKeys) {
	if (migratedValues.size === 0 || allowedEnvKeys.size === 0) return {
		nextRaw: raw,
		removed: 0
	};
	const lines = raw.split(/\r?\n/);
	const nextLines = [];
	let removed = 0;
	for (const line of lines) {
		const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!match) {
			nextLines.push(line);
			continue;
		}
		const envKey = match[1] ?? "";
		if (!allowedEnvKeys.has(envKey)) {
			nextLines.push(line);
			continue;
		}
		const parsedValue = parseEnvAssignmentValue(match[2] ?? "");
		if (migratedValues.has(parsedValue)) {
			removed += 1;
			continue;
		}
		nextLines.push(line);
	}
	const hadTrailingNewline = raw.endsWith("\n");
	const joined = nextLines.join("\n");
	return {
		nextRaw: hadTrailingNewline || joined.length === 0 ? `${joined}${joined.endsWith("\n") ? "" : "\n"}` : joined,
		removed
	};
}
function applyProviderPlanMutations(params) {
	const currentProviders = isRecord(params.config.secrets?.providers) ? structuredClone(params.config.secrets?.providers) : {};
	let changed = false;
	for (const providerAlias of params.deletes ?? []) {
		if (!Object.prototype.hasOwnProperty.call(currentProviders, providerAlias)) continue;
		delete currentProviders[providerAlias];
		changed = true;
	}
	for (const [providerAlias, providerConfig] of Object.entries(params.upserts ?? {})) {
		const previous = currentProviders[providerAlias];
		if (isDeepStrictEqual(previous, providerConfig)) continue;
		currentProviders[providerAlias] = structuredClone(providerConfig);
		changed = true;
	}
	if (!changed) return false;
	params.config.secrets ??= {};
	if (Object.keys(currentProviders).length === 0) {
		if ("providers" in params.config.secrets) delete params.config.secrets.providers;
		return true;
	}
	params.config.secrets.providers = currentProviders;
	return true;
}
async function projectPlanState(params) {
	const { snapshot, writeOptions } = await createSecretsConfigIO({ env: params.env }).readConfigFileSnapshotForWrite();
	if (!snapshot.valid) throw new Error("Cannot apply secrets plan: config is invalid.");
	const options = normalizeSecretsPlanOptions(params.plan.options);
	const nextConfig = structuredClone(snapshot.config);
	const stateDir = resolveStateDir(params.env, os.homedir);
	const changedFiles = /* @__PURE__ */ new Set();
	const warnings = [];
	const configPath = resolveUserPath(snapshot.path);
	if (applyProviderPlanMutations({
		config: nextConfig,
		upserts: params.plan.providerUpserts,
		deletes: params.plan.providerDeletes
	})) changedFiles.add(configPath);
	const targetMutations = applyConfigTargetMutations({
		planTargets: params.plan.targets,
		nextConfig,
		stateDir,
		authStoreByPath: /* @__PURE__ */ new Map(),
		changedFiles
	});
	if (targetMutations.configChanged) changedFiles.add(configPath);
	const authStoreByPath = scrubAuthStoresForProviderTargets({
		nextConfig,
		stateDir,
		providerTargets: targetMutations.providerTargets,
		scrubbedValues: targetMutations.scrubbedValues,
		authStoreByPath: targetMutations.authStoreByPath,
		changedFiles,
		warnings,
		enabled: options.scrubAuthProfilesForProviderTargets
	});
	const authJsonByPath = scrubLegacyAuthJsonStores({
		stateDir,
		changedFiles,
		enabled: options.scrubLegacyAuthJson
	});
	const envRawByPath = scrubEnvFiles({
		env: params.env,
		scrubbedValues: targetMutations.scrubbedValues,
		changedFiles,
		enabled: options.scrubEnv
	});
	const checkFullRuntime = params.write ? changedFiles.size > 0 : params.allowExecInDryRun;
	const validation = await validateProjectedSecretsState({
		env: params.env,
		nextConfig,
		resolvedTargets: targetMutations.resolvedTargets,
		authStoreByPath,
		write: params.write,
		allowExecInDryRun: params.allowExecInDryRun,
		checkFullRuntime
	});
	return {
		nextConfig,
		configSnapshot: snapshot,
		configPath,
		configWriteOptions: writeOptions,
		authStoreByPath,
		authJsonByPath,
		envRawByPath,
		changedFiles,
		warnings,
		refsChecked: validation.refsChecked,
		skippedExecRefs: validation.skippedExecRefs,
		resolvabilityComplete: validation.resolvabilityComplete
	};
}
function applyConfigTargetMutations(params) {
	const resolvedTargets = params.planTargets.map((target) => ({
		target,
		resolved: resolveTarget(target)
	}));
	const scrubbedValues = /* @__PURE__ */ new Set();
	const providerTargets = /* @__PURE__ */ new Set();
	let configChanged = false;
	for (const { target, resolved } of resolvedTargets) {
		if (resolved.entry.configFile === "auth-profiles.json") {
			if (applyAuthProfileTargetMutation({
				target,
				resolved,
				nextConfig: params.nextConfig,
				stateDir: params.stateDir,
				authStoreByPath: params.authStoreByPath,
				scrubbedValues
			})) {
				const agentId = (target.agentId ?? "").trim();
				if (!agentId) throw new Error(`Missing required agentId for auth-profiles target ${target.path}.`);
				params.changedFiles.add(resolveAuthStorePathForAgent({
					nextConfig: params.nextConfig,
					stateDir: params.stateDir,
					agentId
				}));
			}
			continue;
		}
		const targetPathSegments = resolved.pathSegments;
		if (resolved.entry.secretShape === "sibling_ref") {
			const previous = getPath(params.nextConfig, targetPathSegments);
			if (isNonEmptyString(previous)) scrubbedValues.add(previous.trim());
			const refPathSegments = resolved.refPathSegments;
			if (!refPathSegments) throw new Error(`Missing sibling ref path for target ${target.type}.`);
			const wroteRef = setPathCreateStrict(params.nextConfig, refPathSegments, target.ref);
			const deletedLegacy = deletePathStrict(params.nextConfig, targetPathSegments);
			if (wroteRef || deletedLegacy) configChanged = true;
			continue;
		}
		const previous = getPath(params.nextConfig, targetPathSegments);
		if (isNonEmptyString(previous)) scrubbedValues.add(previous.trim());
		if (setPathCreateStrict(params.nextConfig, targetPathSegments, target.ref)) configChanged = true;
		if (resolved.entry.trackProviderShadowing && resolved.providerId) providerTargets.add(normalizeProviderId(resolved.providerId));
	}
	return {
		resolvedTargets,
		scrubbedValues,
		providerTargets,
		configChanged,
		authStoreByPath: params.authStoreByPath
	};
}
function scrubAuthStoresForProviderTargets(params) {
	if (!params.enabled || params.providerTargets.size === 0) return params.authStoreByPath;
	for (const authStorePath of listAuthProfileStorePaths(params.nextConfig, params.stateDir)) {
		const parsed = params.authStoreByPath.get(authStorePath) ?? readJsonObjectIfExists(authStorePath).value;
		if (!parsed || !isRecord(parsed.profiles)) continue;
		const nextStore = structuredClone(parsed);
		const profiles = nextStore.profiles;
		if (!isRecord(profiles)) continue;
		let mutated = false;
		for (const profile of iterateAuthProfileCredentials(profiles)) {
			const provider = normalizeProviderId(profile.provider);
			if (!params.providerTargets.has(provider)) continue;
			if (profile.kind === "api_key" || profile.kind === "token") {
				if (isNonEmptyString(profile.value)) params.scrubbedValues.add(profile.value.trim());
				if (profile.valueField in profile.profile) {
					delete profile.profile[profile.valueField];
					mutated = true;
				}
				if (profile.refField in profile.profile && coerceSecretRef(profile.refValue, params.nextConfig.secrets?.defaults) === null) {
					delete profile.profile[profile.refField];
					mutated = true;
				}
				continue;
			}
			if (profile.kind === "oauth" && (profile.hasAccess || profile.hasRefresh)) params.warnings.push(`Provider "${provider}" has OAuth credentials in ${authStorePath}; those still take precedence and are out of scope for static SecretRef migration.`);
		}
		if (mutated) {
			params.authStoreByPath.set(authStorePath, nextStore);
			params.changedFiles.add(authStorePath);
		}
	}
	return params.authStoreByPath;
}
function ensureMutableAuthStore(store) {
	const next = store ? structuredClone(store) : {};
	const profiles = isRecord(next.profiles) ? next.profiles : {};
	if (typeof next.version !== "number" || !Number.isFinite(next.version)) next.version = 1;
	return {
		...next,
		profiles
	};
}
function resolveAuthStoreForTarget(params) {
	const agentId = (params.target.agentId ?? "").trim();
	if (!agentId) throw new Error(`Missing required agentId for auth-profiles target ${params.target.path}.`);
	const authStorePath = resolveAuthStorePathForAgent({
		nextConfig: params.nextConfig,
		stateDir: params.stateDir,
		agentId
	});
	const loaded = params.authStoreByPath.get(authStorePath) ?? readJsonObjectIfExists(authStorePath).value;
	const store = ensureMutableAuthStore(isRecord(loaded) ? loaded : void 0);
	params.authStoreByPath.set(authStorePath, store);
	return {
		path: authStorePath,
		store
	};
}
function resolveAuthStorePathForAgent(params) {
	const normalizedAgentId = normalizeAgentId(params.agentId);
	const configuredAgentDir = resolveAgentConfig(params.nextConfig, normalizedAgentId)?.agentDir?.trim();
	if (configuredAgentDir) return resolveUserPath(resolveAuthStorePath(configuredAgentDir));
	return path.join(resolveUserPath(params.stateDir), "agents", normalizedAgentId, "agent", "auth-profiles.json");
}
function ensureAuthProfileContainer(params) {
	let changed = false;
	const profilePathSegments = params.resolved.pathSegments.slice(0, 2);
	const profileId = profilePathSegments[1];
	if (!profileId) throw new Error(`Invalid auth profile target path: ${params.target.path}`);
	const current = getPath(params.store, profilePathSegments);
	const expectedType = params.resolved.entry.authProfileType;
	if (isRecord(current)) {
		if (expectedType && typeof current.type === "string" && current.type !== expectedType) throw new Error(`Auth profile "${profileId}" type mismatch for ${params.target.path}: expected "${expectedType}", got "${current.type}".`);
		if (!isNonEmptyString(current.provider) && isNonEmptyString(params.target.authProfileProvider)) {
			const wroteProvider = setPathCreateStrict(params.store, [...profilePathSegments, "provider"], params.target.authProfileProvider);
			changed = changed || wroteProvider;
		}
		return changed;
	}
	if (!expectedType) throw new Error(`Auth profile target ${params.target.path} is missing auth profile type metadata.`);
	const provider = (params.target.authProfileProvider ?? "").trim();
	if (!provider) throw new Error(`Cannot create auth profile "${profileId}" for ${params.target.path} without authProfileProvider.`);
	const wroteProfile = setPathCreateStrict(params.store, profilePathSegments, {
		type: expectedType,
		provider
	});
	changed = changed || wroteProfile;
	return changed;
}
function applyAuthProfileTargetMutation(params) {
	if (params.resolved.entry.configFile !== "auth-profiles.json") return false;
	const { store } = resolveAuthStoreForTarget({
		target: params.target,
		nextConfig: params.nextConfig,
		stateDir: params.stateDir,
		authStoreByPath: params.authStoreByPath
	});
	let changed = ensureAuthProfileContainer({
		target: params.target,
		resolved: params.resolved,
		store
	});
	const targetPathSegments = params.resolved.pathSegments;
	if (params.resolved.entry.secretShape === "sibling_ref") {
		const previous = getPath(store, targetPathSegments);
		if (isNonEmptyString(previous)) params.scrubbedValues.add(previous.trim());
		const refPathSegments = params.resolved.refPathSegments;
		if (!refPathSegments) throw new Error(`Missing sibling ref path for auth-profiles target ${params.target.path}.`);
		const wroteRef = setPathCreateStrict(store, refPathSegments, params.target.ref);
		const deletedPlaintext = deletePathStrict(store, targetPathSegments);
		changed = changed || wroteRef || deletedPlaintext;
		return changed;
	}
	const previous = getPath(store, targetPathSegments);
	if (isNonEmptyString(previous)) params.scrubbedValues.add(previous.trim());
	const wroteRef = setPathCreateStrict(store, targetPathSegments, params.target.ref);
	changed = changed || wroteRef;
	return changed;
}
function scrubLegacyAuthJsonStores(params) {
	const authJsonByPath = /* @__PURE__ */ new Map();
	if (!params.enabled) return authJsonByPath;
	for (const authJsonPath of listLegacyAuthJsonPaths(params.stateDir)) {
		const parsed = readJsonObjectIfExists(authJsonPath).value;
		if (!parsed) continue;
		let mutated = false;
		const nextParsed = structuredClone(parsed);
		for (const [providerId, value] of Object.entries(nextParsed)) {
			if (!isRecord(value)) continue;
			if (value.type === "api_key" && isNonEmptyString(value.key)) {
				delete nextParsed[providerId];
				mutated = true;
			}
		}
		if (mutated) {
			authJsonByPath.set(authJsonPath, nextParsed);
			params.changedFiles.add(authJsonPath);
		}
	}
	return authJsonByPath;
}
function scrubEnvFiles(params) {
	const envRawByPath = /* @__PURE__ */ new Map();
	if (!params.enabled || params.scrubbedValues.size === 0) return envRawByPath;
	const envPath = path.join(resolveConfigDir(params.env, os.homedir), ".env");
	if (!fs.existsSync(envPath)) return envRawByPath;
	const current = fs.readFileSync(envPath, "utf8");
	const scrubbed = scrubEnvRaw(current, params.scrubbedValues, new Set(listKnownSecretEnvVarNames()));
	if (scrubbed.removed > 0 && scrubbed.nextRaw !== current) {
		envRawByPath.set(envPath, scrubbed.nextRaw);
		params.changedFiles.add(envPath);
	}
	return envRawByPath;
}
async function validateProjectedSecretsState(params) {
	const cache = {};
	let refsChecked = 0;
	let skippedExecRefs = 0;
	for (const { target, resolved: resolvedTarget } of params.resolvedTargets) {
		if (!params.write && target.ref.source === "exec" && !params.allowExecInDryRun) {
			skippedExecRefs += 1;
			const staticError = getSkippedExecRefStaticError({
				ref: target.ref,
				config: params.nextConfig
			});
			if (staticError) throw new Error(staticError);
			continue;
		}
		const resolved = await resolveSecretRefValue(target.ref, {
			config: params.nextConfig,
			env: params.env,
			cache
		});
		refsChecked += 1;
		assertExpectedResolvedSecretValue({
			value: resolved,
			expected: resolvedTarget.entry.expectedResolvedValue,
			errorMessage: resolvedTarget.entry.expectedResolvedValue === "string" ? `Ref ${target.ref.source}:${target.ref.provider}:${target.ref.id} is not a non-empty string.` : `Ref ${target.ref.source}:${target.ref.provider}:${target.ref.id} is not string/object.`
		});
	}
	const authStoreLookup = /* @__PURE__ */ new Map();
	for (const [authStorePath, store] of params.authStoreByPath.entries()) authStoreLookup.set(resolveUserPath(authStorePath), store);
	if (params.checkFullRuntime) await prepareSecretsRuntimeSnapshot({
		config: params.nextConfig,
		env: params.env,
		includeAuthStoreRefs: params.write || params.authStoreByPath.size > 0,
		loadAuthStore: (agentDir) => {
			const storePath = resolveUserPath(resolveAuthStorePath(agentDir));
			const override = authStoreLookup.get(storePath);
			if (override) return coercePersistedAuthProfileStore(structuredClone(override)) ?? {
				version: 1,
				profiles: {}
			};
			return loadAuthProfileStoreForSecretsRuntime(agentDir);
		}
	});
	return {
		refsChecked,
		skippedExecRefs,
		resolvabilityComplete: params.write || params.allowExecInDryRun || skippedExecRefs === 0
	};
}
function captureFileSnapshot(pathname) {
	if (!fs.existsSync(pathname)) return {
		existed: false,
		content: "",
		mode: 384
	};
	const stat = fs.statSync(pathname);
	return {
		existed: true,
		content: fs.readFileSync(pathname, "utf8"),
		mode: stat.mode & 511
	};
}
function restoreFileSnapshot(pathname, snapshot) {
	if (!snapshot.existed) {
		if (fs.existsSync(pathname)) fs.rmSync(pathname, { force: true });
		return;
	}
	writeTextFileAtomic(pathname, snapshot.content, snapshot.mode || 384);
}
function toJsonWrite(pathname, value) {
	return {
		path: pathname,
		content: `${JSON.stringify(value, null, 2)}\n`,
		mode: 384
	};
}
async function runSecretsApply(params) {
	const env = params.env ?? process.env;
	const write = params.write === true;
	const allowExec = Boolean(params.allowExec);
	if (write && planContainsExecReferences(params.plan) && !allowExec) throw new Error("Plan contains exec SecretRefs/providers. Re-run with --allow-exec.");
	const allowExecInDryRun = write ? true : allowExec;
	const projected = await projectPlanState({
		plan: params.plan,
		env,
		write,
		allowExecInDryRun
	});
	const changedFiles = [...projected.changedFiles].toSorted();
	if (!write) return {
		mode: "dry-run",
		changed: changedFiles.length > 0,
		changedFiles,
		checks: {
			resolvability: true,
			resolvabilityComplete: projected.resolvabilityComplete
		},
		refsChecked: projected.refsChecked,
		skippedExecRefs: projected.skippedExecRefs,
		warningCount: projected.warnings.length,
		warnings: projected.warnings
	};
	if (changedFiles.length === 0) return {
		mode: "write",
		changed: false,
		changedFiles: [],
		checks: {
			resolvability: true,
			resolvabilityComplete: true
		},
		refsChecked: projected.refsChecked,
		skippedExecRefs: 0,
		warningCount: projected.warnings.length,
		warnings: projected.warnings
	};
	const io = createSecretsConfigIO({ env });
	const snapshots = /* @__PURE__ */ new Map();
	const capture = (pathname) => {
		if (!snapshots.has(pathname)) snapshots.set(pathname, captureFileSnapshot(pathname));
	};
	capture(projected.configPath);
	const writes = [];
	for (const [pathname, value] of projected.authStoreByPath.entries()) {
		capture(pathname);
		writes.push(toJsonWrite(pathname, value));
	}
	for (const [pathname, value] of projected.authJsonByPath.entries()) {
		capture(pathname);
		writes.push(toJsonWrite(pathname, value));
	}
	for (const [pathname, raw] of projected.envRawByPath.entries()) {
		capture(pathname);
		writes.push({
			path: pathname,
			content: raw,
			mode: 384
		});
	}
	try {
		await replaceConfigFile({
			nextConfig: projected.nextConfig,
			snapshot: projected.configSnapshot,
			writeOptions: projected.configWriteOptions,
			io,
			afterWrite: { mode: "auto" }
		});
		for (const write of writes) writeTextFileAtomic(write.path, write.content, write.mode);
	} catch (err) {
		for (const [pathname, snapshot] of snapshots.entries()) try {
			restoreFileSnapshot(pathname, snapshot);
		} catch {}
		throw new Error(`Secrets apply failed: ${String(err)}`, { cause: err });
	}
	return {
		mode: "write",
		changed: changedFiles.length > 0,
		changedFiles,
		checks: {
			resolvability: true,
			resolvabilityComplete: true
		},
		refsChecked: projected.refsChecked,
		skippedExecRefs: 0,
		warningCount: projected.warnings.length,
		warnings: projected.warnings
	};
}
//#endregion
//#region src/secrets/audit.ts
const REF_RESOLVE_FALLBACK_CONCURRENCY = 8;
const MAX_AUDIT_MODELS_JSON_BYTES = 5 * 1024 * 1024;
const ALWAYS_SENSITIVE_MODEL_PROVIDER_HEADER_NAMES = new Set([
	"authorization",
	"proxy-authorization",
	"x-api-key",
	"api-key",
	"apikey",
	"x-auth-token",
	"auth-token",
	"x-access-token",
	"access-token",
	"x-secret-key",
	"secret-key"
]);
const SENSITIVE_MODEL_PROVIDER_HEADER_NAME_FRAGMENTS = [
	"api-key",
	"apikey",
	"token",
	"secret",
	"password",
	"credential"
];
function isLikelySensitiveModelProviderHeaderName(value) {
	const normalized = normalizeLowercaseStringOrEmpty(value);
	if (!normalized) return false;
	if (ALWAYS_SENSITIVE_MODEL_PROVIDER_HEADER_NAMES.has(normalized)) return true;
	return SENSITIVE_MODEL_PROVIDER_HEADER_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}
function addFinding(collector, finding) {
	collector.findings.push(finding);
}
function collectProviderRefPath(collector, providerId, configPath) {
	const key = normalizeProviderId(providerId);
	const existing = collector.configProviderRefPaths.get(key);
	if (existing) {
		existing.push(configPath);
		return;
	}
	collector.configProviderRefPaths.set(key, [configPath]);
}
function trackAuthProviderState(collector, provider, mode) {
	const key = normalizeProviderId(provider);
	const existing = collector.authProviderState.get(key);
	if (existing) {
		existing.hasUsableStaticOrOAuth = true;
		existing.modes.add(mode);
		return;
	}
	collector.authProviderState.set(key, {
		hasUsableStaticOrOAuth: true,
		modes: new Set([mode])
	});
}
function collectEnvPlaintext(params) {
	if (!fs.existsSync(params.envPath)) return;
	params.collector.filesScanned.add(params.envPath);
	const knownKeys = new Set(listKnownSecretEnvVarNames());
	const lines = fs.readFileSync(params.envPath, "utf8").split(/\r?\n/);
	for (const line of lines) {
		const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!match) continue;
		const key = match[1] ?? "";
		if (!knownKeys.has(key)) continue;
		if (!parseEnvAssignmentValue(match[2] ?? "")) continue;
		addFinding(params.collector, {
			code: "PLAINTEXT_FOUND",
			severity: "warn",
			file: params.envPath,
			jsonPath: `$env.${key}`,
			message: `Potential secret found in .env (${key}).`
		});
	}
}
function collectConfigSecrets(params) {
	const defaults = params.config.secrets?.defaults;
	for (const target of discoverConfigSecretTargets(params.config)) {
		if (!target.entry.includeInAudit) continue;
		const { ref } = resolveSecretInputRef({
			value: target.value,
			refValue: target.refValue,
			defaults
		});
		if (ref) {
			params.collector.refAssignments.push({
				file: params.configPath,
				path: target.path,
				ref,
				expected: target.entry.expectedResolvedValue,
				provider: target.providerId
			});
			if (target.entry.trackProviderShadowing && target.providerId) collectProviderRefPath(params.collector, target.providerId, target.path);
			continue;
		}
		const hasPlaintext = hasConfiguredPlaintextSecretValue(target.value, target.entry.expectedResolvedValue);
		if (target.entry.id === "models.providers.*.headers.*" && !isLikelySensitiveModelProviderHeaderName(target.pathSegments.at(-1) ?? "")) continue;
		if (!hasPlaintext) continue;
		addFinding(params.collector, {
			code: "PLAINTEXT_FOUND",
			severity: "warn",
			file: params.configPath,
			jsonPath: target.path,
			message: `${target.path} is stored as plaintext.`,
			provider: target.providerId
		});
	}
}
function collectAuthStoreSecrets(params) {
	if (!fs.existsSync(params.authStorePath)) return;
	params.collector.filesScanned.add(params.authStorePath);
	const parsedResult = readJsonObjectIfExists(params.authStorePath);
	if (parsedResult.error) {
		addFinding(params.collector, {
			code: "REF_UNRESOLVED",
			severity: "error",
			file: params.authStorePath,
			jsonPath: "<root>",
			message: `Invalid JSON in auth-profiles store: ${parsedResult.error}`
		});
		return;
	}
	const parsed = parsedResult.value;
	if (!parsed || !isRecord(parsed.profiles)) return;
	for (const entry of iterateAuthProfileCredentials(parsed.profiles)) {
		if (entry.kind === "api_key" || entry.kind === "token") {
			const { ref } = resolveSecretInputRef({
				value: entry.value,
				refValue: entry.refValue,
				defaults: params.defaults
			});
			if (ref) {
				params.collector.refAssignments.push({
					file: params.authStorePath,
					path: `profiles.${entry.profileId}.${entry.valueField}`,
					ref,
					expected: "string",
					provider: entry.provider
				});
				trackAuthProviderState(params.collector, entry.provider, entry.kind);
			}
			if (isNonEmptyString(entry.value)) {
				addFinding(params.collector, {
					code: "PLAINTEXT_FOUND",
					severity: "warn",
					file: params.authStorePath,
					jsonPath: `profiles.${entry.profileId}.${entry.valueField}`,
					message: entry.kind === "api_key" ? "Auth profile API key is stored as plaintext." : "Auth profile token is stored as plaintext.",
					provider: entry.provider,
					profileId: entry.profileId
				});
				trackAuthProviderState(params.collector, entry.provider, entry.kind);
			}
			continue;
		}
		if (entry.hasAccess || entry.hasRefresh) {
			addFinding(params.collector, {
				code: "LEGACY_RESIDUE",
				severity: "info",
				file: params.authStorePath,
				jsonPath: `profiles.${entry.profileId}`,
				message: "OAuth credentials are present (out of scope for static SecretRef migration).",
				provider: entry.provider,
				profileId: entry.profileId
			});
			trackAuthProviderState(params.collector, entry.provider, "oauth");
		}
	}
}
function collectAuthJsonResidue(params) {
	for (const authJsonPath of listLegacyAuthJsonPaths(params.stateDir)) {
		params.collector.filesScanned.add(authJsonPath);
		const parsedResult = readJsonObjectIfExists(authJsonPath);
		if (parsedResult.error) {
			addFinding(params.collector, {
				code: "REF_UNRESOLVED",
				severity: "error",
				file: authJsonPath,
				jsonPath: "<root>",
				message: `Invalid JSON in legacy auth.json: ${parsedResult.error}`
			});
			continue;
		}
		const parsed = parsedResult.value;
		if (!parsed) continue;
		for (const [providerId, value] of Object.entries(parsed)) {
			if (!isRecord(value)) continue;
			if (value.type === "api_key" && isNonEmptyString(value.key)) addFinding(params.collector, {
				code: "LEGACY_RESIDUE",
				severity: "warn",
				file: authJsonPath,
				jsonPath: providerId,
				message: "Legacy auth.json contains static api_key credentials.",
				provider: providerId
			});
		}
	}
}
function collectModelsJsonSecrets(params) {
	if (!fs.existsSync(params.modelsJsonPath)) return;
	params.collector.filesScanned.add(params.modelsJsonPath);
	const parsedResult = readJsonObjectIfExists(params.modelsJsonPath, {
		requireRegularFile: true,
		maxBytes: MAX_AUDIT_MODELS_JSON_BYTES
	});
	if (parsedResult.error) {
		addFinding(params.collector, {
			code: "REF_UNRESOLVED",
			severity: "error",
			file: params.modelsJsonPath,
			jsonPath: "<root>",
			message: `Invalid JSON in models.json: ${parsedResult.error}`
		});
		return;
	}
	const parsed = parsedResult.value;
	if (!parsed || !isRecord(parsed.providers)) return;
	for (const [providerId, providerValue] of Object.entries(parsed.providers)) {
		if (!isRecord(providerValue)) continue;
		const apiKey = providerValue.apiKey;
		if (coerceSecretRef(apiKey)) addFinding(params.collector, {
			code: "REF_UNRESOLVED",
			severity: "error",
			file: params.modelsJsonPath,
			jsonPath: `providers.${providerId}.apiKey`,
			message: "models.json contains an unresolved SecretRef object; regenerate models.json.",
			provider: providerId
		});
		else if (isNonEmptyString(apiKey) && !isNonSecretApiKeyMarker(apiKey)) addFinding(params.collector, {
			code: "PLAINTEXT_FOUND",
			severity: "warn",
			file: params.modelsJsonPath,
			jsonPath: `providers.${providerId}.apiKey`,
			message: "models.json provider apiKey is stored as plaintext.",
			provider: providerId
		});
		const headers = isRecord(providerValue.headers) ? providerValue.headers : void 0;
		if (!headers) continue;
		for (const [headerKey, headerValue] of Object.entries(headers)) {
			const headerPath = `providers.${providerId}.headers.${headerKey}`;
			if (coerceSecretRef(headerValue)) {
				addFinding(params.collector, {
					code: "REF_UNRESOLVED",
					severity: "error",
					file: params.modelsJsonPath,
					jsonPath: headerPath,
					message: "models.json contains an unresolved SecretRef object for provider headers; regenerate models.json.",
					provider: providerId
				});
				continue;
			}
			if (!isNonEmptyString(headerValue)) continue;
			if (isSecretRefHeaderValueMarker(headerValue)) continue;
			if (!isLikelySensitiveModelProviderHeaderName(headerKey)) continue;
			addFinding(params.collector, {
				code: "PLAINTEXT_FOUND",
				severity: "warn",
				file: params.modelsJsonPath,
				jsonPath: headerPath,
				message: "models.json provider header value is stored as plaintext.",
				provider: providerId
			});
		}
	}
}
async function collectUnresolvedRefFindings(params) {
	const cache = {};
	const refsByProvider = /* @__PURE__ */ new Map();
	const skippedRefKeys = /* @__PURE__ */ new Set();
	let refsChecked = 0;
	let skippedExecRefs = 0;
	for (const assignment of params.collector.refAssignments) {
		const providerKey = `${assignment.ref.source}:${assignment.ref.provider}`;
		let refsForProvider = refsByProvider.get(providerKey);
		if (!refsForProvider) {
			refsForProvider = /* @__PURE__ */ new Map();
			refsByProvider.set(providerKey, refsForProvider);
		}
		refsForProvider.set(secretRefKey(assignment.ref), assignment.ref);
	}
	const resolvedByRefKey = /* @__PURE__ */ new Map();
	const errorsByRefKey = /* @__PURE__ */ new Map();
	for (const refsForProvider of refsByProvider.values()) {
		const refs = [...refsForProvider.values()];
		const selectedRefs = selectRefsForExecPolicy({
			refs,
			allowExec: params.allowExec
		});
		if (selectedRefs.skippedExecRefs.length > 0) {
			skippedExecRefs += selectedRefs.skippedExecRefs.length;
			for (const ref of selectedRefs.skippedExecRefs) {
				skippedRefKeys.add(secretRefKey(ref));
				const staticError = getSkippedExecRefStaticError({
					ref,
					config: params.config
				});
				if (staticError) errorsByRefKey.set(secretRefKey(ref), new Error(staticError));
			}
		}
		if (selectedRefs.refsToResolve.length === 0) continue;
		refsChecked += selectedRefs.refsToResolve.length;
		const provider = refs[0]?.provider;
		try {
			const resolved = await resolveSecretRefValues(selectedRefs.refsToResolve, {
				config: params.config,
				env: params.env,
				cache
			});
			for (const [key, value] of resolved.entries()) resolvedByRefKey.set(key, value);
			continue;
		} catch (err) {
			if (provider && isProviderScopedSecretResolutionError(err)) {
				for (const ref of selectedRefs.refsToResolve) errorsByRefKey.set(secretRefKey(ref), err);
				continue;
			}
		}
		const fallback = await runTasksWithConcurrency({
			tasks: selectedRefs.refsToResolve.map((ref) => async () => ({
				key: secretRefKey(ref),
				resolved: await resolveSecretRefValue(ref, {
					config: params.config,
					env: params.env,
					cache
				})
			})),
			limit: Math.min(REF_RESOLVE_FALLBACK_CONCURRENCY, selectedRefs.refsToResolve.length),
			errorMode: "continue",
			onTaskError: (error, index) => {
				const ref = selectedRefs.refsToResolve[index];
				if (!ref) return;
				errorsByRefKey.set(secretRefKey(ref), error);
			}
		});
		for (const result of fallback.results) {
			if (!result) continue;
			resolvedByRefKey.set(result.key, result.resolved);
		}
	}
	for (const assignment of params.collector.refAssignments) {
		const key = secretRefKey(assignment.ref);
		if (skippedRefKeys.has(key) && !errorsByRefKey.has(key)) continue;
		const resolveErr = errorsByRefKey.get(key);
		if (resolveErr) {
			addFinding(params.collector, {
				code: "REF_UNRESOLVED",
				severity: "error",
				file: assignment.file,
				jsonPath: assignment.path,
				message: `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (${formatErrorMessage(resolveErr)}).`,
				provider: assignment.provider
			});
			continue;
		}
		if (!resolvedByRefKey.has(key)) {
			addFinding(params.collector, {
				code: "REF_UNRESOLVED",
				severity: "error",
				file: assignment.file,
				jsonPath: assignment.path,
				message: `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (resolved value is missing).`,
				provider: assignment.provider
			});
			continue;
		}
		if (!isExpectedResolvedSecretValue(resolvedByRefKey.get(key), assignment.expected)) addFinding(params.collector, {
			code: "REF_UNRESOLVED",
			severity: "error",
			file: assignment.file,
			jsonPath: assignment.path,
			message: assignment.expected === "string" ? `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (resolved value is not a non-empty string).` : `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (resolved value is not a string/object).`,
			provider: assignment.provider
		});
	}
	return {
		refsChecked,
		skippedExecRefs
	};
}
function collectShadowingFindings(collector) {
	for (const [provider, paths] of collector.configProviderRefPaths.entries()) {
		const authState = collector.authProviderState.get(provider);
		if (!authState?.hasUsableStaticOrOAuth) continue;
		const modeText = [...authState.modes].join("/");
		for (const configPath of paths) addFinding(collector, {
			code: "REF_SHADOWED",
			severity: "warn",
			file: "openclaw.json",
			jsonPath: configPath,
			message: `Auth profile credentials (${modeText}) take precedence for provider "${provider}", so this config ref may never be used.`,
			provider
		});
	}
}
function summarizeFindings(findings) {
	return {
		plaintextCount: findings.filter((entry) => entry.code === "PLAINTEXT_FOUND").length,
		unresolvedRefCount: findings.filter((entry) => entry.code === "REF_UNRESOLVED").length,
		shadowedRefCount: findings.filter((entry) => entry.code === "REF_SHADOWED").length,
		legacyResidueCount: findings.filter((entry) => entry.code === "LEGACY_RESIDUE").length
	};
}
async function runSecretsAudit(params = {}) {
	const env = params.env ?? process.env;
	const allowExec = Boolean(params.allowExec);
	const snapshot = await createSecretsConfigIO({ env }).readConfigFileSnapshot();
	const configPath = resolveUserPath(snapshot.path);
	const defaults = snapshot.valid ? snapshot.config.secrets?.defaults : void 0;
	const collector = {
		findings: [],
		refAssignments: [],
		configProviderRefPaths: /* @__PURE__ */ new Map(),
		authProviderState: /* @__PURE__ */ new Map(),
		filesScanned: new Set([configPath])
	};
	const stateDir = resolveStateDir(env, os.homedir);
	const envPath = path.join(resolveConfigDir(env, os.homedir), ".env");
	const config = snapshot.valid ? snapshot.config : {};
	let resolution = {
		refsChecked: 0,
		skippedExecRefs: 0,
		resolvabilityComplete: true
	};
	if (snapshot.valid) {
		collectConfigSecrets({
			config,
			configPath,
			collector
		});
		for (const authStorePath of listAuthProfileStorePaths(config, stateDir)) collectAuthStoreSecrets({
			authStorePath,
			collector,
			defaults
		});
		for (const modelsJsonPath of listAgentModelsJsonPaths(config, stateDir, env)) collectModelsJsonSecrets({
			modelsJsonPath,
			collector
		});
		const unresolvedRefResult = await collectUnresolvedRefFindings({
			collector,
			config,
			env,
			allowExec
		});
		resolution = {
			refsChecked: unresolvedRefResult.refsChecked,
			skippedExecRefs: unresolvedRefResult.skippedExecRefs,
			resolvabilityComplete: unresolvedRefResult.skippedExecRefs === 0
		};
		collectShadowingFindings(collector);
	} else addFinding(collector, {
		code: "REF_UNRESOLVED",
		severity: "error",
		file: configPath,
		jsonPath: "<root>",
		message: "Config is invalid; cannot validate secret references reliably."
	});
	collectEnvPlaintext({
		envPath,
		collector
	});
	collectAuthJsonResidue({
		stateDir,
		collector
	});
	const summary = summarizeFindings(collector.findings);
	return {
		version: 1,
		status: summary.unresolvedRefCount > 0 ? "unresolved" : collector.findings.length > 0 ? "findings" : "clean",
		resolution,
		filesScanned: [...collector.filesScanned].toSorted(),
		summary,
		findings: collector.findings
	};
}
function resolveSecretsAuditExitCode(report, check) {
	if (report.summary.unresolvedRefCount > 0) return 2;
	if (check && report.findings.length > 0) return 1;
	return 0;
}
//#endregion
//#region src/secrets/configure-plan.ts
function getSecretProviders$1(config) {
	if (!isRecord(config.secrets?.providers)) return {};
	return config.secrets.providers;
}
function configureCandidateSortKey(candidate) {
	if (candidate.configFile === "auth-profiles.json") return `auth-profiles:${candidate.agentId ?? ""}:${candidate.path}`;
	return `openclaw:${candidate.path}`;
}
function resolveAuthProfileProvider(store, pathSegments) {
	const profileId = pathSegments[1];
	if (!profileId) return;
	const profile = store.profiles?.[profileId];
	if (!isRecord(profile) || typeof profile.provider !== "string") return;
	const provider = profile.provider.trim();
	return provider.length > 0 ? provider : void 0;
}
function buildConfigureCandidatesForScope(params) {
	const authoredConfig = params.authoredOpenClawConfig ?? params.config;
	const hasPathInAuthoredConfig = (pathSegments) => hasPath(authoredConfig, pathSegments);
	const openclawCandidates = discoverConfigSecretTargets(params.config).filter((entry) => entry.entry.includeInConfigure).map((entry) => {
		const resolved = resolveSecretInputRef({
			value: entry.value,
			refValue: entry.refValue,
			defaults: params.config.secrets?.defaults
		});
		const pathExists = hasPathInAuthoredConfig(entry.pathSegments);
		const refPathExists = entry.refPathSegments ? hasPathInAuthoredConfig(entry.refPathSegments) : false;
		return Object.assign({
			type: entry.entry.targetType,
			path: entry.path,
			pathSegments: [...entry.pathSegments],
			label: entry.path,
			configFile: `openclaw.json`,
			expectedResolvedValue: entry.entry.expectedResolvedValue
		}, resolved.ref ? { existingRef: resolved.ref } : {}, pathExists || refPathExists ? {} : { isDerived: true }, entry.providerId ? { providerId: entry.providerId } : {}, entry.accountId ? { accountId: entry.accountId } : {});
	});
	const authCandidates = params.authProfiles === void 0 ? [] : discoverAuthProfileSecretTargets(params.authProfiles.store).filter((entry) => entry.entry.includeInConfigure).map((entry) => {
		const authProfiles = params.authProfiles;
		if (!authProfiles) throw new Error("Missing auth profile scope for configure candidate discovery.");
		const authProfileProvider = resolveAuthProfileProvider(authProfiles.store, entry.pathSegments);
		const resolved = resolveSecretInputRef({
			value: entry.value,
			refValue: entry.refValue,
			defaults: params.config.secrets?.defaults
		});
		return Object.assign({
			type: entry.entry.targetType,
			path: entry.path,
			pathSegments: [...entry.pathSegments],
			label: `${entry.path} (auth profile, agent ${authProfiles.agentId})`,
			configFile: `auth-profiles.json`,
			expectedResolvedValue: entry.entry.expectedResolvedValue
		}, resolved.ref ? { existingRef: resolved.ref } : {}, { agentId: authProfiles.agentId }, authProfileProvider ? { authProfileProvider } : {});
	});
	return [...openclawCandidates, ...authCandidates].toSorted((a, b) => configureCandidateSortKey(a).localeCompare(configureCandidateSortKey(b)));
}
function hasPath(root, segments) {
	if (segments.length === 0) return false;
	let cursor = root;
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index] ?? "";
		if (Array.isArray(cursor)) {
			if (!/^\d+$/.test(segment)) return false;
			const parsedIndex = Number.parseInt(segment, 10);
			if (!Number.isFinite(parsedIndex) || parsedIndex < 0 || parsedIndex >= cursor.length) return false;
			if (index === segments.length - 1) return true;
			cursor = cursor[parsedIndex];
			continue;
		}
		if (!isRecord(cursor)) return false;
		if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return false;
		if (index === segments.length - 1) return true;
		cursor = cursor[segment];
	}
	return false;
}
function collectConfigureProviderChanges(params) {
	const originalProviders = getSecretProviders$1(params.original);
	const nextProviders = getSecretProviders$1(params.next);
	const upserts = {};
	const deletes = [];
	for (const [providerAlias, nextProviderConfig] of Object.entries(nextProviders)) {
		const current = originalProviders[providerAlias];
		if (isDeepStrictEqual(current, nextProviderConfig)) continue;
		upserts[providerAlias] = structuredClone(nextProviderConfig);
	}
	for (const providerAlias of Object.keys(originalProviders)) if (!Object.prototype.hasOwnProperty.call(nextProviders, providerAlias)) deletes.push(providerAlias);
	return {
		upserts,
		deletes: deletes.toSorted()
	};
}
function hasConfigurePlanChanges(params) {
	return params.selectedTargets.size > 0 || Object.keys(params.providerChanges.upserts).length > 0 || params.providerChanges.deletes.length > 0;
}
function buildSecretsConfigurePlan(params) {
	return {
		version: 1,
		protocolVersion: 1,
		generatedAt: params.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
		generatedBy: "openclaw secrets configure",
		targets: [...params.selectedTargets.values()].map((entry) => Object.assign({
			type: entry.type,
			path: entry.path,
			pathSegments: [...entry.pathSegments],
			ref: entry.ref
		}, entry.agentId ? { agentId: entry.agentId } : {}, entry.providerId ? { providerId: entry.providerId } : {}, entry.accountId ? { accountId: entry.accountId } : {}, entry.authProfileProvider ? { authProfileProvider: entry.authProfileProvider } : {})),
		...Object.keys(params.providerChanges.upserts).length > 0 ? { providerUpserts: params.providerChanges.upserts } : {},
		...params.providerChanges.deletes.length > 0 ? { providerDeletes: params.providerChanges.deletes } : {},
		options: {
			scrubEnv: true,
			scrubAuthProfilesForProviderTargets: true,
			scrubLegacyAuthJson: true
		}
	};
}
//#endregion
//#region src/secrets/configure.ts
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;
function isAbsolutePathValue(value) {
	return path.isAbsolute(value) || WINDOWS_ABS_PATH_PATTERN.test(value) || WINDOWS_UNC_PATH_PATTERN.test(value);
}
function parseCsv(value) {
	return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
function parseOptionalPositiveInt(value, max) {
	const trimmed = value.trim();
	if (!trimmed) return;
	if (!/^\d+$/.test(trimmed)) return;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) return;
	return parsed;
}
function getSecretProviders(config) {
	if (!isRecord(config.secrets?.providers)) return {};
	return config.secrets.providers;
}
function setSecretProvider(config, providerAlias, providerConfig) {
	config.secrets ??= {};
	if (!isRecord(config.secrets.providers)) config.secrets.providers = {};
	config.secrets.providers[providerAlias] = providerConfig;
}
function removeSecretProvider(config, providerAlias) {
	if (!isRecord(config.secrets?.providers)) return false;
	const providers = config.secrets.providers;
	if (!Object.prototype.hasOwnProperty.call(providers, providerAlias)) return false;
	delete providers[providerAlias];
	if (Object.keys(providers).length === 0) delete config.secrets?.providers;
	if (isRecord(config.secrets?.defaults)) {
		const defaults = config.secrets.defaults;
		if (defaults?.env === providerAlias) delete defaults.env;
		if (defaults?.file === providerAlias) delete defaults.file;
		if (defaults?.exec === providerAlias) delete defaults.exec;
		if (defaults && defaults.env === void 0 && defaults.file === void 0 && defaults.exec === void 0) delete config.secrets?.defaults;
	}
	return true;
}
function providerHint(provider) {
	if (provider.source === "env") return provider.allowlist?.length ? `env (${provider.allowlist.length} allowlisted)` : "env";
	if (provider.source === "file") return `file (${provider.mode ?? "json"})`;
	return `exec (${provider.jsonOnly === false ? "json+text" : "json"})`;
}
function toSourceChoices(config) {
	const hasSource = (source) => Object.values(config.secrets?.providers ?? {}).some((provider) => provider?.source === source);
	const choices = [{
		value: "env",
		label: "env"
	}];
	if (hasSource("file")) choices.push({
		value: "file",
		label: "file"
	});
	if (hasSource("exec")) choices.push({
		value: "exec",
		label: "exec"
	});
	return choices;
}
function assertNoCancel(value, message) {
	if (typeof value === "symbol") throw new Error(message);
	return value;
}
const AUTH_PROFILE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
function validateEnvNameCsv(value) {
	const entries = parseCsv(value);
	for (const entry of entries) if (!ENV_NAME_PATTERN.test(entry)) return `Invalid env name: ${entry}`;
}
async function promptEnvNameCsv(params) {
	return parseCsv(assertNoCancel(await text({
		message: params.message,
		initialValue: params.initialValue,
		validate: (value) => validateEnvNameCsv(value ?? "")
	}), "Secrets configure cancelled.") ?? "");
}
async function promptOptionalPositiveInt(params) {
	return parseOptionalPositiveInt(normalizeStringifiedOptionalString(assertNoCancel(await text({
		message: params.message,
		initialValue: params.initialValue === void 0 ? "" : String(params.initialValue),
		validate: (value) => {
			const trimmed = normalizeStringifiedOptionalString(value) ?? "";
			if (!trimmed) return;
			if (parseOptionalPositiveInt(trimmed, params.max) === void 0) return `Must be an integer between 1 and ${params.max}`;
		}
	}), "Secrets configure cancelled.")) ?? "", params.max);
}
function configureCandidateKey(candidate) {
	if (candidate.configFile === "auth-profiles.json") return `auth-profiles:${normalizeOptionalString(candidate.agentId) ?? ""}:${candidate.path}`;
	return `openclaw:${candidate.path}`;
}
function hasSourceChoice(sourceChoices, source) {
	return sourceChoices.some((entry) => entry.value === source);
}
function resolveCandidateProviderHint(candidate) {
	return normalizeOptionalLowercaseString(candidate.authProfileProvider) ?? normalizeOptionalLowercaseString(candidate.providerId);
}
function resolveSuggestedEnvSecretId(candidate) {
	const hintedProvider = resolveCandidateProviderHint(candidate);
	if (!hintedProvider) return;
	const envCandidates = getProviderEnvVars(hintedProvider);
	if (!Array.isArray(envCandidates) || envCandidates.length === 0) return;
	return envCandidates[0];
}
function resolveConfigureAgentId(config, explicitAgentId) {
	const knownAgentIds = new Set(listAgentIds(config));
	if (!explicitAgentId) return resolveDefaultAgentId(config);
	const normalized = normalizeAgentId(explicitAgentId);
	if (knownAgentIds.has(normalized)) return normalized;
	const known = [...knownAgentIds].toSorted().join(", ");
	throw new Error(`Unknown agent id "${explicitAgentId}". Known agents: ${known || "none configured"}.`);
}
function loadAuthProfileStoreForConfigure(params) {
	return loadPersistedAuthProfileStore(resolveAgentDir(params.config, params.agentId)) ?? {
		version: 1,
		profiles: {}
	};
}
async function promptNewAuthProfileCandidate(agentId) {
	const profileId = assertNoCancel(await text({
		message: "Auth profile id",
		validate: (value) => {
			const trimmed = normalizeStringifiedOptionalString(value) ?? "";
			if (!trimmed) return "Required";
			if (!AUTH_PROFILE_ID_PATTERN.test(trimmed)) return "Use letters/numbers/\":\"/\"_\"/\"-\" only.";
		}
	}), "Secrets configure cancelled.");
	const credentialType = assertNoCancel(await select({
		message: "Auth profile credential type",
		options: [{
			value: "api_key",
			label: "api_key (key/keyRef)"
		}, {
			value: "token",
			label: "token (token/tokenRef)"
		}]
	}), "Secrets configure cancelled.");
	const provider = assertNoCancel(await text({
		message: "Provider id",
		validate: (value) => normalizeStringifiedOptionalString(value) ? void 0 : "Required"
	}), "Secrets configure cancelled.");
	const profileIdTrimmed = normalizeStringifiedOptionalString(profileId) ?? "";
	const providerTrimmed = normalizeStringifiedOptionalString(provider) ?? "";
	if (credentialType === "token") return {
		type: "auth-profiles.token.token",
		path: `profiles.${profileIdTrimmed}.token`,
		pathSegments: [
			"profiles",
			profileIdTrimmed,
			"token"
		],
		label: `profiles.${profileIdTrimmed}.token (auth profile, agent ${agentId})`,
		configFile: "auth-profiles.json",
		agentId,
		authProfileProvider: providerTrimmed,
		expectedResolvedValue: "string"
	};
	return {
		type: "auth-profiles.api_key.key",
		path: `profiles.${profileIdTrimmed}.key`,
		pathSegments: [
			"profiles",
			profileIdTrimmed,
			"key"
		],
		label: `profiles.${profileIdTrimmed}.key (auth profile, agent ${agentId})`,
		configFile: "auth-profiles.json",
		agentId,
		authProfileProvider: providerTrimmed,
		expectedResolvedValue: "string"
	};
}
async function promptProviderAlias(params) {
	return normalizeStringifiedOptionalString(assertNoCancel(await text({
		message: "Provider alias",
		initialValue: "default",
		validate: (value) => {
			const trimmed = normalizeStringifiedOptionalString(value) ?? "";
			if (!trimmed) return "Required";
			if (!isValidSecretProviderAlias(trimmed)) return "Must match /^[a-z][a-z0-9_-]{0,63}$/";
			if (params.existingAliases.has(trimmed)) return "Alias already exists";
		}
	}), "Secrets configure cancelled.")) ?? "";
}
async function promptProviderSource(initial) {
	return assertNoCancel(await select({
		message: "Provider source",
		options: [
			{
				value: "env",
				label: "env"
			},
			{
				value: "file",
				label: "file"
			},
			{
				value: "exec",
				label: "exec"
			}
		],
		initialValue: initial
	}), "Secrets configure cancelled.");
}
async function promptEnvProvider(base) {
	const allowlist = await promptEnvNameCsv({
		message: "Env allowlist (comma-separated, blank for unrestricted)",
		initialValue: base?.allowlist?.join(",") ?? ""
	});
	return {
		source: "env",
		...allowlist.length > 0 ? { allowlist } : {}
	};
}
async function promptFileProvider(base) {
	const filePath = assertNoCancel(await text({
		message: "File path (absolute)",
		initialValue: base?.path ?? "",
		validate: (value) => {
			const trimmed = normalizeStringifiedOptionalString(value) ?? "";
			if (!trimmed) return "Required";
			if (!isAbsolutePathValue(trimmed)) return "Must be an absolute path";
		}
	}), "Secrets configure cancelled.");
	const mode = assertNoCancel(await select({
		message: "File mode",
		options: [{
			value: "json",
			label: "json"
		}, {
			value: "singleValue",
			label: "singleValue"
		}],
		initialValue: base?.mode ?? "json"
	}), "Secrets configure cancelled.");
	const timeoutMs = await promptOptionalPositiveInt({
		message: "Timeout ms (blank for default)",
		initialValue: base?.timeoutMs,
		max: 12e4
	});
	const maxBytes = await promptOptionalPositiveInt({
		message: "Max bytes (blank for default)",
		initialValue: base?.maxBytes,
		max: 20 * 1024 * 1024
	});
	const allowInsecurePath = assertNoCancel(await confirm({
		message: "Allow insecure file path checks?",
		initialValue: base?.allowInsecurePath ?? false
	}), "Secrets configure cancelled.");
	return {
		source: "file",
		path: normalizeStringifiedOptionalString(filePath) ?? "",
		mode,
		...timeoutMs ? { timeoutMs } : {},
		...maxBytes ? { maxBytes } : {},
		...allowInsecurePath ? { allowInsecurePath: true } : {}
	};
}
async function parseArgsInput(rawValue) {
	const trimmed = rawValue.trim();
	if (!trimmed) return;
	const parsed = JSON.parse(trimmed);
	if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) throw new Error("args must be a JSON array of strings");
	return parsed;
}
async function promptExecProvider(base) {
	const command = assertNoCancel(await text({
		message: "Command path (absolute)",
		initialValue: base?.command ?? "",
		validate: (value) => {
			const trimmed = normalizeStringifiedOptionalString(value) ?? "";
			if (!trimmed) return "Required";
			if (!isAbsolutePathValue(trimmed)) return "Must be an absolute path";
			if (!isSafeExecutableValue(trimmed)) return "Command value is not allowed";
		}
	}), "Secrets configure cancelled.");
	const argsRaw = assertNoCancel(await text({
		message: "Args JSON array (blank for none)",
		initialValue: JSON.stringify(base?.args ?? []),
		validate: (value) => {
			const trimmed = normalizeStringifiedOptionalString(value) ?? "";
			if (!trimmed) return;
			try {
				const parsed = JSON.parse(trimmed);
				if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) return "Must be a JSON array of strings";
				return;
			} catch {
				return "Must be valid JSON";
			}
		}
	}), "Secrets configure cancelled.");
	const timeoutMs = await promptOptionalPositiveInt({
		message: "Timeout ms (blank for default)",
		initialValue: base?.timeoutMs,
		max: 12e4
	});
	const noOutputTimeoutMs = await promptOptionalPositiveInt({
		message: "No-output timeout ms (blank for default)",
		initialValue: base?.noOutputTimeoutMs,
		max: 12e4
	});
	const maxOutputBytes = await promptOptionalPositiveInt({
		message: "Max output bytes (blank for default)",
		initialValue: base?.maxOutputBytes,
		max: 20 * 1024 * 1024
	});
	const jsonOnly = assertNoCancel(await confirm({
		message: "Require JSON-only response?",
		initialValue: base?.jsonOnly ?? true
	}), "Secrets configure cancelled.");
	const passEnv = await promptEnvNameCsv({
		message: "Pass-through env vars (comma-separated, blank for none)",
		initialValue: base?.passEnv?.join(",") ?? ""
	});
	const trustedDirsRaw = assertNoCancel(await text({
		message: "Trusted dirs (comma-separated absolute paths, blank for none)",
		initialValue: base?.trustedDirs?.join(",") ?? "",
		validate: (value) => {
			const entries = parseCsv(value ?? "");
			for (const entry of entries) if (!isAbsolutePathValue(entry)) return `Trusted dir must be absolute: ${entry}`;
		}
	}), "Secrets configure cancelled.");
	const allowInsecurePath = assertNoCancel(await confirm({
		message: "Allow insecure command path checks?",
		initialValue: base?.allowInsecurePath ?? false
	}), "Secrets configure cancelled.");
	const allowSymlinkCommand = assertNoCancel(await confirm({
		message: "Allow symlink command path?",
		initialValue: base?.allowSymlinkCommand ?? false
	}), "Secrets configure cancelled.");
	const args = await parseArgsInput(normalizeStringifiedOptionalString(argsRaw) ?? "");
	const trustedDirs = parseCsv(trustedDirsRaw ?? "");
	return {
		source: "exec",
		command: normalizeStringifiedOptionalString(command) ?? "",
		...args && args.length > 0 ? { args } : {},
		...timeoutMs ? { timeoutMs } : {},
		...noOutputTimeoutMs ? { noOutputTimeoutMs } : {},
		...maxOutputBytes ? { maxOutputBytes } : {},
		...jsonOnly ? { jsonOnly } : { jsonOnly: false },
		...passEnv.length > 0 ? { passEnv } : {},
		...trustedDirs.length > 0 ? { trustedDirs } : {},
		...allowInsecurePath ? { allowInsecurePath: true } : {},
		...allowSymlinkCommand ? { allowSymlinkCommand: true } : {},
		...isRecord(base?.env) ? { env: base.env } : {}
	};
}
async function promptProviderConfig(source, current) {
	if (source === "env") return await promptEnvProvider(current?.source === "env" ? current : void 0);
	if (source === "file") return await promptFileProvider(current?.source === "file" ? current : void 0);
	return await promptExecProvider(current?.source === "exec" ? current : void 0);
}
async function configureProvidersInteractive(config) {
	while (true) {
		const providers = getSecretProviders(config);
		const providerEntries = Object.entries(providers).toSorted(([left], [right]) => left.localeCompare(right));
		const actionOptions = [{
			value: "add",
			label: "Add provider",
			hint: "Define a new env/file/exec provider"
		}];
		if (providerEntries.length > 0) {
			actionOptions.push({
				value: "edit",
				label: "Edit provider",
				hint: "Update an existing provider"
			});
			actionOptions.push({
				value: "remove",
				label: "Remove provider",
				hint: "Delete a provider alias"
			});
		}
		actionOptions.push({
			value: "continue",
			label: "Continue",
			hint: "Move to credential mapping"
		});
		const action = assertNoCancel(await select({
			message: providerEntries.length > 0 ? "Configure secret providers" : "Configure secret providers (only env refs are available until file/exec providers are added)",
			options: actionOptions
		}), "Secrets configure cancelled.");
		if (action === "continue") return;
		if (action === "add") {
			const source = await promptProviderSource();
			setSecretProvider(config, await promptProviderAlias({ existingAliases: new Set(providerEntries.map(([providerAlias]) => providerAlias)) }), await promptProviderConfig(source));
			continue;
		}
		if (action === "edit") {
			const alias = assertNoCancel(await select({
				message: "Select provider to edit",
				options: providerEntries.map(([providerAlias, providerConfig]) => ({
					value: providerAlias,
					label: providerAlias,
					hint: providerHint(providerConfig)
				}))
			}), "Secrets configure cancelled.");
			const current = providers[alias];
			if (!current) continue;
			const nextProviderConfig = await promptProviderConfig(await promptProviderSource(current.source), current);
			if (!isDeepStrictEqual(current, nextProviderConfig)) setSecretProvider(config, alias, nextProviderConfig);
			continue;
		}
		if (action === "remove") {
			const alias = assertNoCancel(await select({
				message: "Select provider to remove",
				options: providerEntries.map(([providerAlias, providerConfig]) => ({
					value: providerAlias,
					label: providerAlias,
					hint: providerHint(providerConfig)
				}))
			}), "Secrets configure cancelled.");
			if (assertNoCancel(await confirm({
				message: `Remove provider "${alias}"?`,
				initialValue: false
			}), "Secrets configure cancelled.")) removeSecretProvider(config, alias);
		}
	}
}
async function runSecretsConfigureInteractive(params = {}) {
	if (!process.stdin.isTTY) throw new Error("secrets configure requires an interactive TTY.");
	if (params.providersOnly && params.skipProviderSetup) throw new Error("Cannot combine --providers-only with --skip-provider-setup.");
	const env = params.env ?? process.env;
	const allowExecInPreflight = Boolean(params.allowExecInPreflight);
	const { snapshot } = await createSecretsConfigIO({ env }).readConfigFileSnapshotForWrite();
	if (!snapshot.valid) throw new Error("Cannot run interactive secrets configure because config is invalid.");
	const stagedConfig = structuredClone(snapshot.config);
	if (!params.skipProviderSetup) await configureProvidersInteractive(stagedConfig);
	const providerChanges = collectConfigureProviderChanges({
		original: snapshot.config,
		next: stagedConfig
	});
	const selectedByPath = /* @__PURE__ */ new Map();
	if (!params.providersOnly) {
		const configureAgentId = resolveConfigureAgentId(snapshot.config, params.agentId);
		const authStore = loadAuthProfileStoreForConfigure({
			config: snapshot.config,
			agentId: configureAgentId
		});
		const candidates = buildConfigureCandidatesForScope({
			config: stagedConfig,
			authoredOpenClawConfig: snapshot.resolved,
			authProfiles: {
				agentId: configureAgentId,
				store: authStore
			}
		});
		if (candidates.length === 0) throw new Error("No configurable secret-bearing fields found for this agent scope.");
		const sourceChoices = toSourceChoices(stagedConfig);
		const hasDerivedCandidates = candidates.some((candidate) => candidate.isDerived === true);
		let showDerivedCandidates = false;
		while (true) {
			const visibleCandidates = showDerivedCandidates ? candidates : candidates.filter((candidate) => candidate.isDerived !== true);
			const options = visibleCandidates.map((candidate) => ({
				value: configureCandidateKey(candidate),
				label: candidate.label,
				hint: [candidate.configFile === "auth-profiles.json" ? "auth-profiles.json" : "openclaw.json", candidate.isDerived === true ? "derived" : void 0].filter(Boolean).join(" | ")
			}));
			options.push({
				value: "__create_auth_profile__",
				label: "Create auth profile mapping",
				hint: `Add a new auth-profiles target for agent ${configureAgentId}`
			});
			if (hasDerivedCandidates) options.push({
				value: "__toggle_derived__",
				label: showDerivedCandidates ? "Hide derived targets" : "Show derived targets",
				hint: showDerivedCandidates ? "Show only fields authored directly in config" : "Include normalized/derived aliases"
			});
			if (selectedByPath.size > 0) options.unshift({
				value: "__done__",
				label: "Done",
				hint: "Finish and run preflight"
			});
			const selectedPath = assertNoCancel(await select({
				message: "Select credential field",
				options
			}), "Secrets configure cancelled.");
			if (selectedPath === "__done__") break;
			if (selectedPath === "__create_auth_profile__") {
				const createdCandidate = await promptNewAuthProfileCandidate(configureAgentId);
				const key = configureCandidateKey(createdCandidate);
				const existingIndex = candidates.findIndex((entry) => configureCandidateKey(entry) === key);
				if (existingIndex >= 0) candidates[existingIndex] = createdCandidate;
				else candidates.push(createdCandidate);
				continue;
			}
			if (selectedPath === "__toggle_derived__") {
				showDerivedCandidates = !showDerivedCandidates;
				continue;
			}
			const candidate = visibleCandidates.find((entry) => configureCandidateKey(entry) === selectedPath);
			if (!candidate) throw new Error(`Unknown configure target: ${selectedPath}`);
			const candidateKey = configureCandidateKey(candidate);
			const existingRef = selectedByPath.get(candidateKey)?.ref ?? candidate.existingRef;
			const source = assertNoCancel(await select({
				message: "Secret source",
				options: sourceChoices,
				initialValue: existingRef && hasSourceChoice(sourceChoices, existingRef.source) ? existingRef.source : void 0
			}), "Secrets configure cancelled.");
			const defaultAlias = resolveDefaultSecretProviderAlias(stagedConfig, source, { preferFirstProviderForSource: true });
			const providerAlias = normalizeStringifiedOptionalString(assertNoCancel(await text({
				message: "Provider alias",
				initialValue: existingRef?.source === source ? existingRef.provider : defaultAlias,
				validate: (value) => {
					const trimmed = normalizeStringifiedOptionalString(value) ?? "";
					if (!trimmed) return "Required";
					if (!isValidSecretProviderAlias(trimmed)) return "Must match /^[a-z][a-z0-9_-]{0,63}$/";
				}
			}), "Secrets configure cancelled.")) ?? "";
			let suggestedId = existingRef?.source === source ? existingRef.id : void 0;
			if (!suggestedId && source === "env") suggestedId = resolveSuggestedEnvSecretId(candidate);
			if (!suggestedId && source === "file") {
				const configuredProvider = stagedConfig.secrets?.providers?.[providerAlias];
				if (configuredProvider?.source === "file" && configuredProvider.mode === "singleValue") suggestedId = "value";
			}
			const ref = {
				source,
				provider: providerAlias,
				id: normalizeStringifiedOptionalString(assertNoCancel(await text({
					message: "Secret id",
					initialValue: suggestedId,
					validate: (value) => {
						const trimmed = normalizeStringifiedOptionalString(value) ?? "";
						if (!trimmed) return "Required";
						if (source === "exec" && !isValidExecSecretRefId(trimmed)) return formatExecSecretRefIdValidationMessage();
					}
				}), "Secrets configure cancelled.")) ?? ""
			};
			if (ref.source === "exec" && !allowExecInPreflight) {
				const staticError = getSkippedExecRefStaticError({
					ref,
					config: stagedConfig
				});
				if (staticError) throw new Error(staticError);
			} else assertExpectedResolvedSecretValue({
				value: await resolveSecretRefValue(ref, {
					config: stagedConfig,
					env
				}),
				expected: candidate.expectedResolvedValue,
				errorMessage: candidate.expectedResolvedValue === "string" ? `Ref ${ref.source}:${ref.provider}:${ref.id} did not resolve to a non-empty string.` : `Ref ${ref.source}:${ref.provider}:${ref.id} did not resolve to a supported value type.`
			});
			const next = {
				...candidate,
				ref
			};
			selectedByPath.set(candidateKey, next);
			if (!assertNoCancel(await confirm({
				message: "Configure another credential?",
				initialValue: true
			}), "Secrets configure cancelled.")) break;
		}
	}
	if (!hasConfigurePlanChanges({
		selectedTargets: selectedByPath,
		providerChanges
	})) throw new Error("No secrets changes were selected.");
	const plan = buildSecretsConfigurePlan({
		selectedTargets: selectedByPath,
		providerChanges
	});
	return {
		plan,
		preflight: await runSecretsApply({
			plan,
			env,
			write: false,
			allowExec: allowExecInPreflight
		})
	};
}
//#endregion
//#region src/cli/secrets-cli.ts
function readPlanFile(pathname) {
	const raw = fs.readFileSync(pathname, "utf8");
	const parsed = JSON.parse(raw);
	if (!isSecretsApplyPlan(parsed)) throw new Error(`Invalid secrets plan file: ${pathname}. Generate a fresh plan with ${formatCliCommand("openclaw secrets configure --plan-out <path>")}.`);
	return parsed;
}
function registerSecretsCli(program) {
	const secrets = program.command("secrets").description("Secrets runtime controls").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/gateway/security", "docs.openclaw.ai/gateway/security")}\n`);
	addGatewayClientOptions(secrets.command("reload").description("Re-resolve secret references and atomically swap runtime snapshot").option("--json", "Output JSON", false)).action(async (opts) => {
		try {
			const result = await callGatewayFromCli("secrets.reload", opts, void 0, { expectFinal: false });
			if (opts.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			const warningCount = Number(result?.warningCount ?? 0);
			if (Number.isFinite(warningCount) && warningCount > 0) {
				defaultRuntime.log(`Secrets reloaded with ${warningCount} warning(s).`);
				return;
			}
			defaultRuntime.log("Secrets reloaded.");
		} catch (err) {
			defaultRuntime.error(danger(formatGatewayCommandFailure({
				action: "reload secrets",
				error: err,
				inspectCommand: "openclaw gateway status --deep"
			})));
			defaultRuntime.exit(1);
		}
	});
	secrets.command("audit").description("Audit plaintext secrets, unresolved refs, and precedence drift").option("--check", "Exit non-zero when findings are present", false).option("--allow-exec", "Allow exec SecretRef resolution during audit (may execute provider commands)", false).option("--json", "Output JSON", false).action(async (opts) => {
		try {
			const report = await runSecretsAudit({ allowExec: Boolean(opts.allowExec) });
			if (opts.json) defaultRuntime.writeJson(report);
			else {
				defaultRuntime.log(`Secrets audit: ${report.status}. plaintext=${report.summary.plaintextCount}, unresolved=${report.summary.unresolvedRefCount}, shadowed=${report.summary.shadowedRefCount}, legacy=${report.summary.legacyResidueCount}.`);
				if (report.findings.length > 0) {
					for (const finding of report.findings.slice(0, 20)) defaultRuntime.log(`- [${finding.code}] ${finding.file}:${finding.jsonPath} ${finding.message}`);
					if (report.findings.length > 20) defaultRuntime.log(`... ${report.findings.length - 20} more finding(s).`);
				}
				if (report.resolution.skippedExecRefs > 0) defaultRuntime.log(`Audit note: skipped ${report.resolution.skippedExecRefs} exec SecretRef resolvability check(s). Re-run with --allow-exec to execute exec providers during audit.`);
			}
			const exitCode = resolveSecretsAuditExitCode(report, Boolean(opts.check));
			if (exitCode !== 0) defaultRuntime.exit(exitCode);
		} catch (err) {
			defaultRuntime.error(danger(`Secrets audit failed: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw doctor")} to inspect config and credential state.`));
			defaultRuntime.exit(2);
		}
	});
	secrets.command("configure").description("Interactive secrets helper (provider setup + SecretRef mapping + preflight)").option("--apply", "Apply changes immediately after preflight", false).option("--yes", "Skip apply confirmation prompt", false).option("--providers-only", "Configure secrets.providers only, skip credential mapping", false).option("--skip-provider-setup", "Skip provider setup and only map credential fields to existing providers", false).option("--agent <id>", "Agent id for auth-profiles targets (default: configured default agent)").option("--allow-exec", "Allow exec SecretRef preflight checks (may execute provider commands)", false).option("--plan-out <path>", "Write generated plan JSON to a file").option("--json", "Output JSON", false).action(async (opts) => {
		try {
			const configured = await runSecretsConfigureInteractive({
				providersOnly: Boolean(opts.providersOnly),
				skipProviderSetup: Boolean(opts.skipProviderSetup),
				agentId: typeof opts.agent === "string" ? opts.agent : void 0,
				allowExecInPreflight: Boolean(opts.allowExec)
			});
			if (opts.planOut) fs.writeFileSync(opts.planOut, `${JSON.stringify(configured.plan, null, 2)}\n`, "utf8");
			if (opts.json) defaultRuntime.writeJson({
				plan: configured.plan,
				preflight: configured.preflight
			});
			else {
				defaultRuntime.log(`Preflight: changed=${configured.preflight.changed}, files=${configured.preflight.changedFiles.length}, warnings=${configured.preflight.warningCount}.`);
				if (configured.preflight.warningCount > 0) for (const warning of configured.preflight.warnings) defaultRuntime.log(`- warning: ${warning}`);
				if (!configured.preflight.checks.resolvabilityComplete && configured.preflight.skippedExecRefs > 0) defaultRuntime.log(`Preflight note: skipped ${configured.preflight.skippedExecRefs} exec SecretRef resolvability check(s). Re-run with --allow-exec to execute exec providers during preflight.`);
				const providerUpserts = Object.keys(configured.plan.providerUpserts ?? {}).length;
				const providerDeletes = configured.plan.providerDeletes?.length ?? 0;
				defaultRuntime.log(`Plan: targets=${configured.plan.targets.length}, providerUpserts=${providerUpserts}, providerDeletes=${providerDeletes}.`);
				if (opts.planOut) defaultRuntime.log(`Plan written to ${opts.planOut}`);
			}
			let shouldApply = Boolean(opts.apply);
			if (!shouldApply && !opts.json) {
				const approved = await confirm({
					message: "Apply this plan now?",
					initialValue: true
				});
				if (typeof approved === "boolean") shouldApply = approved;
			}
			if (shouldApply) {
				if (Boolean(opts.apply) && !opts.yes && !opts.json) {
					if (await confirm({
						message: "This migration is one-way for migrated plaintext values. Continue with apply?",
						initialValue: true
					}) !== true) {
						defaultRuntime.log("Apply cancelled.");
						return;
					}
				}
				const result = await runSecretsApply({
					plan: configured.plan,
					write: true,
					allowExec: Boolean(opts.allowExec)
				});
				if (opts.json) {
					defaultRuntime.writeJson(result);
					return;
				}
				defaultRuntime.log(result.changed ? `Secrets applied. Updated ${result.changedFiles.length} file(s).` : "Secrets apply: no changes.");
			}
		} catch (err) {
			defaultRuntime.error(danger(`Secrets configure failed: ${formatErrorMessage(err)}. Re-run ${formatCliCommand("openclaw secrets audit")} before applying changes.`));
			defaultRuntime.exit(1);
		}
	});
	secrets.command("apply").description("Apply a previously generated secrets plan").requiredOption("--from <path>", "Path to plan JSON").option("--dry-run", "Validate/preflight only", false).option("--allow-exec", "Allow exec SecretRef checks (may execute provider commands)", false).option("--json", "Output JSON", false).action(async (opts) => {
		try {
			const result = await runSecretsApply({
				plan: readPlanFile(opts.from),
				write: !opts.dryRun,
				allowExec: Boolean(opts.allowExec)
			});
			if (opts.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			if (opts.dryRun) {
				defaultRuntime.log(result.changed ? `Secrets apply dry run: ${result.changedFiles.length} file(s) would change.` : "Secrets apply dry run: no changes.");
				if (!result.checks.resolvabilityComplete && result.skippedExecRefs > 0) defaultRuntime.log(`Secrets apply dry-run note: skipped ${result.skippedExecRefs} exec SecretRef resolvability check(s). Re-run with --allow-exec to execute exec providers during dry-run.`);
				return;
			}
			defaultRuntime.log(result.changed ? `Secrets applied. Updated ${result.changedFiles.length} file(s).` : "Secrets apply: no changes.");
		} catch (err) {
			defaultRuntime.error(danger(`Secrets apply failed: ${formatErrorMessage(err)}. Re-run ${formatCliCommand("openclaw secrets apply --from <path> --dry-run")} to inspect the plan without writing.`));
			defaultRuntime.exit(1);
		}
	});
}
//#endregion
export { registerSecretsCli };
