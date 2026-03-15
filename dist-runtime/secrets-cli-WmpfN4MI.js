import "./redact-CPjO5IzK.js";
import "./errors-CHvVoeNX.js";
import "./unhandled-rejections-BUxLQs1F.js";
import { t as danger } from "./globals-I5DlBD2D.js";
import { _ as resolveStateDir } from "./paths-1qR_mW4i.js";
import { r as theme } from "./theme-UkqnBJaj.js";
import { l as defaultRuntime } from "./subsystem-EnljYYs1.js";
import "./ansi-YpD2Ho3J.js";
import "./boolean-B938tROv.js";
import "./env-Bdj-riuG.js";
import "./warning-filter-xAwZkSAQ.js";
import { g as resolveConfigDir, y as resolveUserPath } from "./utils-Do8MzKyM.js";
import { t as formatDocsLink } from "./links-Cx-Xmp-Y.js";
import { Cb as isSecretRefHeaderValueMarker, Eb as listKnownSecretEnvVarNames, Jo as hasConfiguredPlaintextSecretValue, LS as SecretProviderSchema, Lb as createConfigIO, Sb as isNonSecretApiKeyMarker, Uo as prepareSecretsRuntimeSnapshot, VS as isSafeExecutableValue, Yo as isExpectedResolvedSecretValue, eC as normalizeProviderId, eb as isProviderScopedSecretResolutionError, g as loadAuthProfileStoreForSecretsRuntime, nb as resolveSecretRefValue, qo as assertExpectedResolvedSecretValue, rb as resolveSecretRefValues, v as resolveAuthStorePath, wb as PROVIDER_ENV_VARS } from "./auth-profiles-DqxBs6Au.js";
import "./plugins-allowlist-CTOQWcBK.js";
import "./registry-DrRO3PZ7.js";
import { c as normalizeAgentId } from "./session-key-D2lHwVVl.js";
import { d as resolveSecretInputRef, i as coerceSecretRef } from "./types.secrets-CgNgVfYE.js";
import "./fetch-DM2X1MUS.js";
import "./config-state-Dtu4rsXl.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-CA0yK887.js";
import { Fn as resolveDefaultSecretProviderAlias, In as secretRefKey, Mn as isValidExecSecretRefId, Pn as isValidSecretProviderAlias, jn as formatExecSecretRefIdValidationMessage } from "./method-scopes-DDb5C1xl.js";
import "./plugins-CygWjihb.js";
import "./brew-BBTHZkpM.js";
import { a as resolveAgentDir, f as resolveDefaultAgentId, i as resolveAgentConfig, r as listAgentIds } from "./agent-scope-tkfLX5MZ.js";
import "./logger-BwHrL168.js";
import "./exec-Fh3CK0qE.js";
import "./env-overrides-ArVaLl04.js";
import "./safe-text-ByhWP-8W.js";
import "./version-Dubp0iGu.js";
import "./config-VO8zzMSR.js";
import "./workspace-dirs-D1oDbsnN.js";
import "./search-manager-DIDe1qlM.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import { F as runTasksWithConcurrency } from "./query-expansion-CcKf_qr0.js";
import { C as parseDotPath, E as writeTextFileAtomic, T as toDotPath, _ as setPathCreateStrict, b as isNonEmptyString, c as discoverAuthProfileSecretTargets, f as isKnownSecretTargetType, g as getPath, h as deletePathStrict, l as discoverConfigSecretTargets, m as resolvePlanTargetAgainstRegistry, p as listAuthProfileSecretTargetEntries, w as parseEnvValue, x as isRecord, y as describeUnknownError } from "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-eb8njEg8.js";
import "./commands-BRfqrztE.js";
import "./ports-DeHp-MTZ.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-Cu8erp19.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-CfAp_q6e.js";
import "./paths-YN5WLIkL.js";
import "./session-cost-usage-DeAwWk6A.js";
import "./fetch-CzYOE42F.js";
import "./identity-file-Dh-pAEVE.js";
import "./dm-policy-shared-qfNerugD.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-BI0f8wZY.js";
import "./prompt-style-DqOsOwLH.js";
import "./secret-file-Bd-d3WTG.js";
import "./token-C5m9DX_R.js";
import "./restart-stale-pids-DzpGvXwg.js";
import "./accounts-B1y-wv7m.js";
import "./audit-CmcUcZU1.js";
import "./cli-utils-DRykF2zj.js";
import { n as callGatewayFromCli, t as addGatewayClientOptions } from "./gateway-rpc-B_RKVlkq.js";
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
		if (!target.authProfileType) {continue;}
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
		if (!isRecord(value) || !isNonEmptyString(value.provider)) {continue;}
		const provider = String(value.provider);
		if (value.type === "api_key" || value.type === "token") {
			yield toSecretCredentialVisit({
				kind: value.type,
				profileId,
				provider,
				profile: value
			});
			continue;
		}
		if (value.type === "oauth") {yield {
			kind: "oauth",
			profileId,
			provider,
			profile: value,
			hasAccess: isNonEmptyString(value.access),
			hasRefresh: isNonEmptyString(value.refresh)
		};}
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
	if (!isKnownSecretTargetType(candidate.type)) {return null;}
	const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
	if (!path) {return null;}
	const segments = Array.isArray(candidate.pathSegments) && candidate.pathSegments.length > 0 ? candidate.pathSegments.map((segment) => String(segment).trim()).filter(Boolean) : parseDotPath(path);
	if (segments.length === 0 || hasForbiddenPathSegment(segments) || path !== toDotPath(segments)) {return null;}
	return resolvePlanTargetAgainstRegistry({
		type: candidate.type,
		pathSegments: segments,
		providerId: candidate.providerId,
		accountId: candidate.accountId
	});
}
function isSecretsApplyPlan(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {return false;}
	const typed = value;
	if (typed.version !== 1 || typed.protocolVersion !== 1 || !Array.isArray(typed.targets)) {return false;}
	for (const target of typed.targets) {
		if (!target || typeof target !== "object") {return false;}
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
		if (!isKnownSecretTargetType(candidate.type) || typeof candidate.path !== "string" || !candidate.path.trim() || candidate.pathSegments !== void 0 && !Array.isArray(candidate.pathSegments) || !resolved || !ref || typeof ref !== "object" || ref.source !== "env" && ref.source !== "file" && ref.source !== "exec" || typeof ref.provider !== "string" || ref.provider.trim().length === 0 || typeof ref.id !== "string" || ref.id.trim().length === 0 || ref.source === "exec" && !isValidExecSecretRefId(ref.id)) {return false;}
		if (resolved.entry.configFile === "auth-profiles.json") {
			if (typeof candidate.agentId !== "string" || candidate.agentId.trim().length === 0) {return false;}
			if (candidate.authProfileProvider !== void 0 && (typeof candidate.authProfileProvider !== "string" || candidate.authProfileProvider.trim().length === 0)) {return false;}
		}
	}
	if (typed.providerUpserts !== void 0) {
		if (!isObjectRecord(typed.providerUpserts)) {return false;}
		for (const [providerAlias, providerValue] of Object.entries(typed.providerUpserts)) {
			if (!isValidSecretProviderAlias(providerAlias)) {return false;}
			if (!isSecretProviderConfigShape(providerValue)) {return false;}
		}
	}
	if (typed.providerDeletes !== void 0) {
		if (!Array.isArray(typed.providerDeletes) || typed.providerDeletes.some((providerAlias) => typeof providerAlias !== "string" || !isValidSecretProviderAlias(providerAlias))) {return false;}
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
	if (fs.existsSync(agentsRoot)) {for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		paths.add(path.join(agentsRoot, entry.name, "agent", "auth-profiles.json"));
	}}
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
function parseEnvAssignmentValue(raw) {
	return parseEnvValue(raw);
}
function listAuthProfileStorePaths(config, stateDir) {
	return listAuthProfileStorePaths$1(config, stateDir);
}
function listLegacyAuthJsonPaths(stateDir) {
	const out = [];
	const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
	if (!fs.existsSync(agentsRoot)) {return out;}
	for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) {continue;}
		const candidate = path.join(agentsRoot, entry.name, "agent", "auth.json");
		if (fs.existsSync(candidate)) {out.push(candidate);}
	}
	return out;
}
function resolveActiveAgentDir(stateDir, env = process.env) {
	const override = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
	if (override) {return resolveUserPath(override);}
	return path.join(resolveUserPath(stateDir), "agents", "main", "agent");
}
function listAgentModelsJsonPaths(config, stateDir, env = process.env) {
	const resolvedStateDir = resolveUserPath(stateDir);
	const paths = /* @__PURE__ */ new Set();
	paths.add(path.join(resolvedStateDir, "agents", "main", "agent", "models.json"));
	paths.add(path.join(resolveActiveAgentDir(stateDir, env), "models.json"));
	const agentsRoot = path.join(resolvedStateDir, "agents");
	if (fs.existsSync(agentsRoot)) {for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		paths.add(path.join(agentsRoot, entry.name, "agent", "models.json"));
	}}
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
	if (!fs.existsSync(filePath)) {return { value: null };}
	try {
		const stats = fs.statSync(filePath);
		if (options.requireRegularFile && !stats.isFile()) {return {
			value: null,
			error: `Refusing to read non-regular file: ${filePath}`
		};}
		if (typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes) && options.maxBytes >= 0 && stats.size > options.maxBytes) {return {
			value: null,
			error: `Refusing to read oversized JSON (${stats.size} bytes): ${filePath}`
		};}
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {return { value: null };}
		return { value: parsed };
	} catch (err) {
		return {
			value: null,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
//#endregion
//#region src/secrets/apply.ts
function resolveTarget(target) {
	const resolved = resolveValidatedPlanTarget(target);
	if (!resolved) {throw new Error(`Invalid plan target path for ${target.type}: ${target.path}`);}
	return resolved;
}
function scrubEnvRaw(raw, migratedValues, allowedEnvKeys) {
	if (migratedValues.size === 0 || allowedEnvKeys.size === 0) {return {
		nextRaw: raw,
		removed: 0
	};}
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
		if (!Object.prototype.hasOwnProperty.call(currentProviders, providerAlias)) {continue;}
		delete currentProviders[providerAlias];
		changed = true;
	}
	for (const [providerAlias, providerConfig] of Object.entries(params.upserts ?? {})) {
		const previous = currentProviders[providerAlias];
		if (isDeepStrictEqual(previous, providerConfig)) {continue;}
		currentProviders[providerAlias] = structuredClone(providerConfig);
		changed = true;
	}
	if (!changed) {return false;}
	params.config.secrets ??= {};
	if (Object.keys(currentProviders).length === 0) {
		if ("providers" in params.config.secrets) {delete params.config.secrets.providers;}
		return true;
	}
	params.config.secrets.providers = currentProviders;
	return true;
}
async function projectPlanState(params) {
	const { snapshot, writeOptions } = await createSecretsConfigIO({ env: params.env }).readConfigFileSnapshotForWrite();
	if (!snapshot.valid) {throw new Error("Cannot apply secrets plan: config is invalid.");}
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
	})) {changedFiles.add(configPath);}
	const targetMutations = applyConfigTargetMutations({
		planTargets: params.plan.targets,
		nextConfig,
		stateDir,
		authStoreByPath: /* @__PURE__ */ new Map(),
		changedFiles
	});
	if (targetMutations.configChanged) {changedFiles.add(configPath);}
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
	await validateProjectedSecretsState({
		env: params.env,
		nextConfig,
		resolvedTargets: targetMutations.resolvedTargets,
		authStoreByPath
	});
	return {
		nextConfig,
		configPath,
		configWriteOptions: writeOptions,
		authStoreByPath,
		authJsonByPath,
		envRawByPath,
		changedFiles,
		warnings
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
				const agentId = String(target.agentId ?? "").trim();
				if (!agentId) {throw new Error(`Missing required agentId for auth-profiles target ${target.path}.`);}
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
			if (isNonEmptyString(previous)) {scrubbedValues.add(previous.trim());}
			const refPathSegments = resolved.refPathSegments;
			if (!refPathSegments) {throw new Error(`Missing sibling ref path for target ${target.type}.`);}
			const wroteRef = setPathCreateStrict(params.nextConfig, refPathSegments, target.ref);
			const deletedLegacy = deletePathStrict(params.nextConfig, targetPathSegments);
			if (wroteRef || deletedLegacy) {configChanged = true;}
			continue;
		}
		const previous = getPath(params.nextConfig, targetPathSegments);
		if (isNonEmptyString(previous)) {scrubbedValues.add(previous.trim());}
		if (setPathCreateStrict(params.nextConfig, targetPathSegments, target.ref)) {configChanged = true;}
		if (resolved.entry.trackProviderShadowing && resolved.providerId) {providerTargets.add(normalizeProviderId(resolved.providerId));}
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
	if (!params.enabled || params.providerTargets.size === 0) {return params.authStoreByPath;}
	for (const authStorePath of listAuthProfileStorePaths(params.nextConfig, params.stateDir)) {
		const parsed = params.authStoreByPath.get(authStorePath) ?? readJsonObjectIfExists(authStorePath).value;
		if (!parsed || !isRecord(parsed.profiles)) {continue;}
		const nextStore = structuredClone(parsed);
		let mutated = false;
		for (const profile of iterateAuthProfileCredentials(nextStore.profiles)) {
			const provider = normalizeProviderId(profile.provider);
			if (!params.providerTargets.has(provider)) {continue;}
			if (profile.kind === "api_key" || profile.kind === "token") {
				if (isNonEmptyString(profile.value)) {params.scrubbedValues.add(profile.value.trim());}
				if (profile.valueField in profile.profile) {
					delete profile.profile[profile.valueField];
					mutated = true;
				}
				if (profile.refField in profile.profile) {
					delete profile.profile[profile.refField];
					mutated = true;
				}
				continue;
			}
			if (profile.kind === "oauth" && (profile.hasAccess || profile.hasRefresh)) {params.warnings.push(`Provider "${provider}" has OAuth credentials in ${authStorePath}; those still take precedence and are out of scope for static SecretRef migration.`);}
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
	if (!isRecord(next.profiles)) {next.profiles = {};}
	if (typeof next.version !== "number" || !Number.isFinite(next.version)) {next.version = 1;}
	return next;
}
function resolveAuthStoreForTarget(params) {
	const agentId = String(params.target.agentId ?? "").trim();
	if (!agentId) {throw new Error(`Missing required agentId for auth-profiles target ${params.target.path}.`);}
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
function asConfigPathRoot(store) {
	return store;
}
function resolveAuthStorePathForAgent(params) {
	const normalizedAgentId = normalizeAgentId(params.agentId);
	const configuredAgentDir = resolveAgentConfig(params.nextConfig, normalizedAgentId)?.agentDir?.trim();
	if (configuredAgentDir) {return resolveUserPath(resolveAuthStorePath(configuredAgentDir));}
	return path.join(resolveUserPath(params.stateDir), "agents", normalizedAgentId, "agent", "auth-profiles.json");
}
function ensureAuthProfileContainer(params) {
	let changed = false;
	const profilePathSegments = params.resolved.pathSegments.slice(0, 2);
	const profileId = profilePathSegments[1];
	if (!profileId) {throw new Error(`Invalid auth profile target path: ${params.target.path}`);}
	const current = getPath(params.store, profilePathSegments);
	const expectedType = params.resolved.entry.authProfileType;
	if (isRecord(current)) {
		if (expectedType && typeof current.type === "string" && current.type !== expectedType) {throw new Error(`Auth profile "${profileId}" type mismatch for ${params.target.path}: expected "${expectedType}", got "${current.type}".`);}
		if (!isNonEmptyString(current.provider) && isNonEmptyString(params.target.authProfileProvider)) {
			const wroteProvider = setPathCreateStrict(asConfigPathRoot(params.store), [...profilePathSegments, "provider"], params.target.authProfileProvider);
			changed = changed || wroteProvider;
		}
		return changed;
	}
	if (!expectedType) {throw new Error(`Auth profile target ${params.target.path} is missing auth profile type metadata.`);}
	const provider = String(params.target.authProfileProvider ?? "").trim();
	if (!provider) {throw new Error(`Cannot create auth profile "${profileId}" for ${params.target.path} without authProfileProvider.`);}
	const wroteProfile = setPathCreateStrict(asConfigPathRoot(params.store), profilePathSegments, {
		type: expectedType,
		provider
	});
	changed = changed || wroteProfile;
	return changed;
}
function applyAuthProfileTargetMutation(params) {
	if (params.resolved.entry.configFile !== "auth-profiles.json") {return false;}
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
		if (isNonEmptyString(previous)) {params.scrubbedValues.add(previous.trim());}
		const refPathSegments = params.resolved.refPathSegments;
		if (!refPathSegments) {throw new Error(`Missing sibling ref path for auth-profiles target ${params.target.path}.`);}
		const wroteRef = setPathCreateStrict(asConfigPathRoot(store), refPathSegments, params.target.ref);
		const deletedPlaintext = deletePathStrict(asConfigPathRoot(store), targetPathSegments);
		changed = changed || wroteRef || deletedPlaintext;
		return changed;
	}
	const previous = getPath(store, targetPathSegments);
	if (isNonEmptyString(previous)) {params.scrubbedValues.add(previous.trim());}
	const wroteRef = setPathCreateStrict(asConfigPathRoot(store), targetPathSegments, params.target.ref);
	changed = changed || wroteRef;
	return changed;
}
function scrubLegacyAuthJsonStores(params) {
	const authJsonByPath = /* @__PURE__ */ new Map();
	if (!params.enabled) {return authJsonByPath;}
	for (const authJsonPath of listLegacyAuthJsonPaths(params.stateDir)) {
		const parsed = readJsonObjectIfExists(authJsonPath).value;
		if (!parsed) {continue;}
		let mutated = false;
		const nextParsed = structuredClone(parsed);
		for (const [providerId, value] of Object.entries(nextParsed)) {
			if (!isRecord(value)) {continue;}
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
	if (!params.enabled || params.scrubbedValues.size === 0) {return envRawByPath;}
	const envPath = path.join(resolveConfigDir(params.env, os.homedir), ".env");
	if (!fs.existsSync(envPath)) {return envRawByPath;}
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
	for (const { target, resolved: resolvedTarget } of params.resolvedTargets) {assertExpectedResolvedSecretValue({
		value: await resolveSecretRefValue(target.ref, {
			config: params.nextConfig,
			env: params.env,
			cache
		}),
		expected: resolvedTarget.entry.expectedResolvedValue,
		errorMessage: resolvedTarget.entry.expectedResolvedValue === "string" ? `Ref ${target.ref.source}:${target.ref.provider}:${target.ref.id} is not a non-empty string.` : `Ref ${target.ref.source}:${target.ref.provider}:${target.ref.id} is not string/object.`
	});}
	const authStoreLookup = /* @__PURE__ */ new Map();
	for (const [authStorePath, store] of params.authStoreByPath.entries()) {authStoreLookup.set(resolveUserPath(authStorePath), store);}
	await prepareSecretsRuntimeSnapshot({
		config: params.nextConfig,
		env: params.env,
		loadAuthStore: (agentDir) => {
			const storePath = resolveUserPath(resolveAuthStorePath(agentDir));
			const override = authStoreLookup.get(storePath);
			if (override) {return structuredClone(override);}
			return loadAuthProfileStoreForSecretsRuntime(agentDir);
		}
	});
}
function captureFileSnapshot(pathname) {
	if (!fs.existsSync(pathname)) {return {
		existed: false,
		content: "",
		mode: 384
	};}
	const stat = fs.statSync(pathname);
	return {
		existed: true,
		content: fs.readFileSync(pathname, "utf8"),
		mode: stat.mode & 511
	};
}
function restoreFileSnapshot(pathname, snapshot) {
	if (!snapshot.existed) {
		if (fs.existsSync(pathname)) {fs.rmSync(pathname, { force: true });}
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
	const projected = await projectPlanState({
		plan: params.plan,
		env
	});
	const changedFiles = [...projected.changedFiles].toSorted();
	if (!params.write) {return {
		mode: "dry-run",
		changed: changedFiles.length > 0,
		changedFiles,
		warningCount: projected.warnings.length,
		warnings: projected.warnings
	};}
	if (changedFiles.length === 0) {return {
		mode: "write",
		changed: false,
		changedFiles: [],
		warningCount: projected.warnings.length,
		warnings: projected.warnings
	};}
	const io = createSecretsConfigIO({ env });
	const snapshots = /* @__PURE__ */ new Map();
	const capture = (pathname) => {
		if (!snapshots.has(pathname)) {snapshots.set(pathname, captureFileSnapshot(pathname));}
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
		await io.writeConfigFile(projected.nextConfig, projected.configWriteOptions);
		for (const write of writes) {writeTextFileAtomic(write.path, write.content, write.mode);}
	} catch (err) {
		for (const [pathname, snapshot] of snapshots.entries()) {try {
			restoreFileSnapshot(pathname, snapshot);
		} catch {}}
		throw new Error(`Secrets apply failed: ${String(err)}`, { cause: err });
	}
	return {
		mode: "write",
		changed: changedFiles.length > 0,
		changedFiles,
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
	const normalized = value.trim().toLowerCase();
	if (!normalized) {return false;}
	if (ALWAYS_SENSITIVE_MODEL_PROVIDER_HEADER_NAMES.has(normalized)) {return true;}
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
	if (!fs.existsSync(params.envPath)) {return;}
	params.collector.filesScanned.add(params.envPath);
	const knownKeys = new Set(listKnownSecretEnvVarNames());
	const lines = fs.readFileSync(params.envPath, "utf8").split(/\r?\n/);
	for (const line of lines) {
		const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!match) {continue;}
		const key = match[1] ?? "";
		if (!knownKeys.has(key)) {continue;}
		if (!parseEnvAssignmentValue(match[2] ?? "")) {continue;}
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
		if (!target.entry.includeInAudit) {continue;}
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
			if (target.entry.trackProviderShadowing && target.providerId) {collectProviderRefPath(params.collector, target.providerId, target.path);}
			continue;
		}
		const hasPlaintext = hasConfiguredPlaintextSecretValue(target.value, target.entry.expectedResolvedValue);
		if (target.entry.id === "models.providers.*.headers.*" && !isLikelySensitiveModelProviderHeaderName(target.pathSegments.at(-1) ?? "")) {continue;}
		if (!hasPlaintext) {continue;}
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
	if (!fs.existsSync(params.authStorePath)) {return;}
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
	if (!parsed || !isRecord(parsed.profiles)) {return;}
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
		if (!parsed) {continue;}
		for (const [providerId, value] of Object.entries(parsed)) {
			if (!isRecord(value)) {continue;}
			if (value.type === "api_key" && isNonEmptyString(value.key)) {addFinding(params.collector, {
				code: "LEGACY_RESIDUE",
				severity: "warn",
				file: authJsonPath,
				jsonPath: providerId,
				message: "Legacy auth.json contains static api_key credentials.",
				provider: providerId
			});}
		}
	}
}
function collectModelsJsonSecrets(params) {
	if (!fs.existsSync(params.modelsJsonPath)) {return;}
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
	if (!parsed || !isRecord(parsed.providers)) {return;}
	for (const [providerId, providerValue] of Object.entries(parsed.providers)) {
		if (!isRecord(providerValue)) {continue;}
		const apiKey = providerValue.apiKey;
		if (coerceSecretRef(apiKey)) {addFinding(params.collector, {
			code: "REF_UNRESOLVED",
			severity: "error",
			file: params.modelsJsonPath,
			jsonPath: `providers.${providerId}.apiKey`,
			message: "models.json contains an unresolved SecretRef object; regenerate models.json.",
			provider: providerId
		});}
		else if (isNonEmptyString(apiKey) && !isNonSecretApiKeyMarker(apiKey)) {addFinding(params.collector, {
			code: "PLAINTEXT_FOUND",
			severity: "warn",
			file: params.modelsJsonPath,
			jsonPath: `providers.${providerId}.apiKey`,
			message: "models.json provider apiKey is stored as plaintext.",
			provider: providerId
		});}
		const headers = isRecord(providerValue.headers) ? providerValue.headers : void 0;
		if (!headers) {continue;}
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
			if (!isNonEmptyString(headerValue)) {continue;}
			if (isSecretRefHeaderValueMarker(headerValue)) {continue;}
			if (!isLikelySensitiveModelProviderHeaderName(headerKey)) {continue;}
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
		const provider = refs[0]?.provider;
		try {
			const resolved = await resolveSecretRefValues(refs, {
				config: params.config,
				env: params.env,
				cache
			});
			for (const [key, value] of resolved.entries()) {resolvedByRefKey.set(key, value);}
			continue;
		} catch (err) {
			if (provider && isProviderScopedSecretResolutionError(err)) {
				for (const ref of refs) {errorsByRefKey.set(secretRefKey(ref), err);}
				continue;
			}
		}
		const fallback = await runTasksWithConcurrency({
			tasks: refs.map((ref) => async () => ({
				key: secretRefKey(ref),
				resolved: await resolveSecretRefValue(ref, {
					config: params.config,
					env: params.env,
					cache
				})
			})),
			limit: Math.min(REF_RESOLVE_FALLBACK_CONCURRENCY, refs.length),
			errorMode: "continue",
			onTaskError: (error, index) => {
				const ref = refs[index];
				if (!ref) {return;}
				errorsByRefKey.set(secretRefKey(ref), error);
			}
		});
		for (const result of fallback.results) {
			if (!result) {continue;}
			resolvedByRefKey.set(result.key, result.resolved);
		}
	}
	for (const assignment of params.collector.refAssignments) {
		const key = secretRefKey(assignment.ref);
		const resolveErr = errorsByRefKey.get(key);
		if (resolveErr) {
			addFinding(params.collector, {
				code: "REF_UNRESOLVED",
				severity: "error",
				file: assignment.file,
				jsonPath: assignment.path,
				message: `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (${describeUnknownError(resolveErr)}).`,
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
		if (!isExpectedResolvedSecretValue(resolvedByRefKey.get(key), assignment.expected)) {addFinding(params.collector, {
			code: "REF_UNRESOLVED",
			severity: "error",
			file: assignment.file,
			jsonPath: assignment.path,
			message: assignment.expected === "string" ? `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (resolved value is not a non-empty string).` : `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (resolved value is not a string/object).`,
			provider: assignment.provider
		});}
	}
}
function collectShadowingFindings(collector) {
	for (const [provider, paths] of collector.configProviderRefPaths.entries()) {
		const authState = collector.authProviderState.get(provider);
		if (!authState?.hasUsableStaticOrOAuth) {continue;}
		const modeText = [...authState.modes].join("/");
		for (const configPath of paths) {addFinding(collector, {
			code: "REF_SHADOWED",
			severity: "warn",
			file: "openclaw.json",
			jsonPath: configPath,
			message: `Auth profile credentials (${modeText}) take precedence for provider "${provider}", so this config ref may never be used.`,
			provider
		});}
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
	if (snapshot.valid) {
		collectConfigSecrets({
			config,
			configPath,
			collector
		});
		for (const authStorePath of listAuthProfileStorePaths(config, stateDir)) {collectAuthStoreSecrets({
			authStorePath,
			collector,
			defaults
		});}
		for (const modelsJsonPath of listAgentModelsJsonPaths(config, stateDir, env)) {collectModelsJsonSecrets({
			modelsJsonPath,
			collector
		});}
		await collectUnresolvedRefFindings({
			collector,
			config,
			env
		});
		collectShadowingFindings(collector);
	} else {addFinding(collector, {
		code: "REF_UNRESOLVED",
		severity: "error",
		file: configPath,
		jsonPath: "<root>",
		message: "Config is invalid; cannot validate secret references reliably."
	});}
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
		filesScanned: [...collector.filesScanned].toSorted(),
		summary,
		findings: collector.findings
	};
}
function resolveSecretsAuditExitCode(report, check) {
	if (report.summary.unresolvedRefCount > 0) {return 2;}
	if (check && report.findings.length > 0) {return 1;}
	return 0;
}
//#endregion
//#region src/secrets/configure-plan.ts
function getSecretProviders$1(config) {
	if (!isRecord(config.secrets?.providers)) {return {};}
	return config.secrets.providers;
}
function configureCandidateSortKey(candidate) {
	if (candidate.configFile === "auth-profiles.json") {return `auth-profiles:${candidate.agentId ?? ""}:${candidate.path}`;}
	return `openclaw:${candidate.path}`;
}
function resolveAuthProfileProvider(store, pathSegments) {
	const profileId = pathSegments[1];
	if (!profileId) {return;}
	const profile = store.profiles?.[profileId];
	if (!isRecord(profile) || typeof profile.provider !== "string") {return;}
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
		return {
			type: entry.entry.targetType,
			path: entry.path,
			pathSegments: [...entry.pathSegments],
			label: entry.path,
			configFile: "openclaw.json",
			expectedResolvedValue: entry.entry.expectedResolvedValue,
			...resolved.ref ? { existingRef: resolved.ref } : {},
			...pathExists || refPathExists ? {} : { isDerived: true },
			...entry.providerId ? { providerId: entry.providerId } : {},
			...entry.accountId ? { accountId: entry.accountId } : {}
		};
	});
	const authCandidates = params.authProfiles === void 0 ? [] : discoverAuthProfileSecretTargets(params.authProfiles.store).filter((entry) => entry.entry.includeInConfigure).map((entry) => {
		const authProfiles = params.authProfiles;
		if (!authProfiles) {throw new Error("Missing auth profile scope for configure candidate discovery.");}
		const authProfileProvider = resolveAuthProfileProvider(authProfiles.store, entry.pathSegments);
		const resolved = resolveSecretInputRef({
			value: entry.value,
			refValue: entry.refValue,
			defaults: params.config.secrets?.defaults
		});
		return {
			type: entry.entry.targetType,
			path: entry.path,
			pathSegments: [...entry.pathSegments],
			label: `${entry.path} (auth profile, agent ${authProfiles.agentId})`,
			configFile: "auth-profiles.json",
			expectedResolvedValue: entry.entry.expectedResolvedValue,
			...resolved.ref ? { existingRef: resolved.ref } : {},
			agentId: authProfiles.agentId,
			...authProfileProvider ? { authProfileProvider } : {}
		};
	});
	return [...openclawCandidates, ...authCandidates].toSorted((a, b) => configureCandidateSortKey(a).localeCompare(configureCandidateSortKey(b)));
}
function hasPath(root, segments) {
	if (segments.length === 0) {return false;}
	let cursor = root;
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index] ?? "";
		if (Array.isArray(cursor)) {
			if (!/^\d+$/.test(segment)) {return false;}
			const parsedIndex = Number.parseInt(segment, 10);
			if (!Number.isFinite(parsedIndex) || parsedIndex < 0 || parsedIndex >= cursor.length) {return false;}
			if (index === segments.length - 1) {return true;}
			cursor = cursor[parsedIndex];
			continue;
		}
		if (!isRecord(cursor)) {return false;}
		if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {return false;}
		if (index === segments.length - 1) {return true;}
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
		if (isDeepStrictEqual(current, nextProviderConfig)) {continue;}
		upserts[providerAlias] = structuredClone(nextProviderConfig);
	}
	for (const providerAlias of Object.keys(originalProviders)) {if (!Object.prototype.hasOwnProperty.call(nextProviders, providerAlias)) deletes.push(providerAlias);}
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
		targets: [...params.selectedTargets.values()].map((entry) => ({
			type: entry.type,
			path: entry.path,
			pathSegments: [...entry.pathSegments],
			ref: entry.ref,
			...entry.agentId ? { agentId: entry.agentId } : {},
			...entry.providerId ? { providerId: entry.providerId } : {},
			...entry.accountId ? { accountId: entry.accountId } : {},
			...entry.authProfileProvider ? { authProfileProvider: entry.authProfileProvider } : {}
		})),
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
	if (!trimmed) {return;}
	if (!/^\d+$/.test(trimmed)) {return;}
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) {return;}
	return parsed;
}
function getSecretProviders(config) {
	if (!isRecord(config.secrets?.providers)) {return {};}
	return config.secrets.providers;
}
function setSecretProvider(config, providerAlias, providerConfig) {
	config.secrets ??= {};
	if (!isRecord(config.secrets.providers)) {config.secrets.providers = {};}
	config.secrets.providers[providerAlias] = providerConfig;
}
function removeSecretProvider(config, providerAlias) {
	if (!isRecord(config.secrets?.providers)) {return false;}
	const providers = config.secrets.providers;
	if (!Object.prototype.hasOwnProperty.call(providers, providerAlias)) {return false;}
	delete providers[providerAlias];
	if (Object.keys(providers).length === 0) {delete config.secrets?.providers;}
	if (isRecord(config.secrets?.defaults)) {
		const defaults = config.secrets.defaults;
		if (defaults?.env === providerAlias) {delete defaults.env;}
		if (defaults?.file === providerAlias) {delete defaults.file;}
		if (defaults?.exec === providerAlias) {delete defaults.exec;}
		if (defaults && defaults.env === void 0 && defaults.file === void 0 && defaults.exec === void 0) {delete config.secrets?.defaults;}
	}
	return true;
}
function providerHint(provider) {
	if (provider.source === "env") {return provider.allowlist?.length ? `env (${provider.allowlist.length} allowlisted)` : "env";}
	if (provider.source === "file") {return `file (${provider.mode ?? "json"})`;}
	return `exec (${provider.jsonOnly === false ? "json+text" : "json"})`;
}
function toSourceChoices(config) {
	const hasSource = (source) => Object.values(config.secrets?.providers ?? {}).some((provider) => provider?.source === source);
	const choices = [{
		value: "env",
		label: "env"
	}];
	if (hasSource("file")) {choices.push({
		value: "file",
		label: "file"
	});}
	if (hasSource("exec")) {choices.push({
		value: "exec",
		label: "exec"
	});}
	return choices;
}
function assertNoCancel(value, message) {
	if (typeof value === "symbol") {throw new Error(message);}
	return value;
}
const AUTH_PROFILE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
function validateEnvNameCsv(value) {
	const entries = parseCsv(value);
	for (const entry of entries) {if (!ENV_NAME_PATTERN.test(entry)) return `Invalid env name: ${entry}`;}
}
async function promptEnvNameCsv(params) {
	const raw = assertNoCancel(await text({
		message: params.message,
		initialValue: params.initialValue,
		validate: (value) => validateEnvNameCsv(String(value ?? ""))
	}), "Secrets configure cancelled.");
	return parseCsv(String(raw ?? ""));
}
async function promptOptionalPositiveInt(params) {
	const raw = assertNoCancel(await text({
		message: params.message,
		initialValue: params.initialValue === void 0 ? "" : String(params.initialValue),
		validate: (value) => {
			const trimmed = String(value ?? "").trim();
			if (!trimmed) {return;}
			if (parseOptionalPositiveInt(trimmed, params.max) === void 0) {return `Must be an integer between 1 and ${params.max}`;}
		}
	}), "Secrets configure cancelled.");
	return parseOptionalPositiveInt(String(raw ?? ""), params.max);
}
function configureCandidateKey(candidate) {
	if (candidate.configFile === "auth-profiles.json") {return `auth-profiles:${String(candidate.agentId ?? "").trim()}:${candidate.path}`;}
	return `openclaw:${candidate.path}`;
}
function hasSourceChoice(sourceChoices, source) {
	return sourceChoices.some((entry) => entry.value === source);
}
function resolveCandidateProviderHint(candidate) {
	if (typeof candidate.authProfileProvider === "string" && candidate.authProfileProvider.trim()) {return candidate.authProfileProvider.trim().toLowerCase();}
	if (typeof candidate.providerId === "string" && candidate.providerId.trim()) {return candidate.providerId.trim().toLowerCase();}
}
function resolveSuggestedEnvSecretId(candidate) {
	const hintedProvider = resolveCandidateProviderHint(candidate);
	if (!hintedProvider) {return;}
	const envCandidates = PROVIDER_ENV_VARS[hintedProvider];
	if (!Array.isArray(envCandidates) || envCandidates.length === 0) {return;}
	return envCandidates[0];
}
function resolveConfigureAgentId(config, explicitAgentId) {
	const knownAgentIds = new Set(listAgentIds(config));
	if (!explicitAgentId) {return resolveDefaultAgentId(config);}
	const normalized = normalizeAgentId(explicitAgentId);
	if (knownAgentIds.has(normalized)) {return normalized;}
	const known = [...knownAgentIds].toSorted().join(", ");
	throw new Error(`Unknown agent id "${explicitAgentId}". Known agents: ${known || "none configured"}.`);
}
function normalizeAuthStoreForConfigure(raw, storePath) {
	if (!raw) {return {
		version: 1,
		profiles: {}
	};}
	if (!isRecord(raw.profiles)) {throw new Error(`Cannot run interactive secrets configure because ${storePath} is invalid (missing "profiles" object).`);}
	return {
		version: typeof raw.version === "number" && Number.isFinite(raw.version) ? raw.version : 1,
		profiles: raw.profiles,
		...isRecord(raw.order) ? { order: raw.order } : {},
		...isRecord(raw.lastGood) ? { lastGood: raw.lastGood } : {},
		...isRecord(raw.usageStats) ? { usageStats: raw.usageStats } : {}
	};
}
function loadAuthProfileStoreForConfigure(params) {
	const storePath = resolveAuthStorePath(resolveAgentDir(params.config, params.agentId));
	const parsed = readJsonObjectIfExists(storePath);
	if (parsed.error) {throw new Error(`Cannot run interactive secrets configure because ${storePath} could not be read: ${parsed.error}`);}
	return normalizeAuthStoreForConfigure(parsed.value, storePath);
}
async function promptNewAuthProfileCandidate(agentId) {
	const profileId = assertNoCancel(await text({
		message: "Auth profile id",
		validate: (value) => {
			const trimmed = String(value ?? "").trim();
			if (!trimmed) {return "Required";}
			if (!AUTH_PROFILE_ID_PATTERN.test(trimmed)) {return "Use letters/numbers/\":\"/\"_\"/\"-\" only.";}
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
		validate: (value) => String(value ?? "").trim().length > 0 ? void 0 : "Required"
	}), "Secrets configure cancelled.");
	const profileIdTrimmed = String(profileId).trim();
	const providerTrimmed = String(provider).trim();
	if (credentialType === "token") {return {
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
	};}
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
	const alias = assertNoCancel(await text({
		message: "Provider alias",
		initialValue: "default",
		validate: (value) => {
			const trimmed = String(value ?? "").trim();
			if (!trimmed) {return "Required";}
			if (!isValidSecretProviderAlias(trimmed)) {return "Must match /^[a-z][a-z0-9_-]{0,63}$/";}
			if (params.existingAliases.has(trimmed)) {return "Alias already exists";}
		}
	}), "Secrets configure cancelled.");
	return String(alias).trim();
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
			const trimmed = String(value ?? "").trim();
			if (!trimmed) {return "Required";}
			if (!isAbsolutePathValue(trimmed)) {return "Must be an absolute path";}
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
	return {
		source: "file",
		path: String(filePath).trim(),
		mode,
		...timeoutMs ? { timeoutMs } : {},
		...maxBytes ? { maxBytes } : {}
	};
}
async function parseArgsInput(rawValue) {
	const trimmed = rawValue.trim();
	if (!trimmed) {return;}
	const parsed = JSON.parse(trimmed);
	if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {throw new Error("args must be a JSON array of strings");}
	return parsed;
}
async function promptExecProvider(base) {
	const command = assertNoCancel(await text({
		message: "Command path (absolute)",
		initialValue: base?.command ?? "",
		validate: (value) => {
			const trimmed = String(value ?? "").trim();
			if (!trimmed) {return "Required";}
			if (!isAbsolutePathValue(trimmed)) {return "Must be an absolute path";}
			if (!isSafeExecutableValue(trimmed)) {return "Command value is not allowed";}
		}
	}), "Secrets configure cancelled.");
	const argsRaw = assertNoCancel(await text({
		message: "Args JSON array (blank for none)",
		initialValue: JSON.stringify(base?.args ?? []),
		validate: (value) => {
			const trimmed = String(value ?? "").trim();
			if (!trimmed) {return;}
			try {
				const parsed = JSON.parse(trimmed);
				if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {return "Must be a JSON array of strings";}
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
			const entries = parseCsv(String(value ?? ""));
			for (const entry of entries) {if (!isAbsolutePathValue(entry)) return `Trusted dir must be absolute: ${entry}`;}
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
	const args = await parseArgsInput(String(argsRaw ?? ""));
	const trustedDirs = parseCsv(String(trustedDirsRaw ?? ""));
	return {
		source: "exec",
		command: String(command).trim(),
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
	if (source === "env") {return await promptEnvProvider(current?.source === "env" ? current : void 0);}
	if (source === "file") {return await promptFileProvider(current?.source === "file" ? current : void 0);}
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
		if (action === "continue") {return;}
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
			if (!current) {continue;}
			const nextProviderConfig = await promptProviderConfig(await promptProviderSource(current.source), current);
			if (!isDeepStrictEqual(current, nextProviderConfig)) {setSecretProvider(config, alias, nextProviderConfig);}
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
			}), "Secrets configure cancelled.")) {removeSecretProvider(config, alias);}
		}
	}
}
async function runSecretsConfigureInteractive(params = {}) {
	if (!process.stdin.isTTY) {throw new Error("secrets configure requires an interactive TTY.");}
	if (params.providersOnly && params.skipProviderSetup) {throw new Error("Cannot combine --providers-only with --skip-provider-setup.");}
	const env = params.env ?? process.env;
	const { snapshot } = await createSecretsConfigIO({ env }).readConfigFileSnapshotForWrite();
	if (!snapshot.valid) {throw new Error("Cannot run interactive secrets configure because config is invalid.");}
	const stagedConfig = structuredClone(snapshot.config);
	if (!params.skipProviderSetup) {await configureProvidersInteractive(stagedConfig);}
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
		if (candidates.length === 0) {throw new Error("No configurable secret-bearing fields found for this agent scope.");}
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
			if (hasDerivedCandidates) {options.push({
				value: "__toggle_derived__",
				label: showDerivedCandidates ? "Hide derived targets" : "Show derived targets",
				hint: showDerivedCandidates ? "Show only fields authored directly in config" : "Include normalized/derived aliases"
			});}
			if (selectedByPath.size > 0) {options.unshift({
				value: "__done__",
				label: "Done",
				hint: "Finish and run preflight"
			});}
			const selectedPath = assertNoCancel(await select({
				message: "Select credential field",
				options
			}), "Secrets configure cancelled.");
			if (selectedPath === "__done__") {break;}
			if (selectedPath === "__create_auth_profile__") {
				const createdCandidate = await promptNewAuthProfileCandidate(configureAgentId);
				const key = configureCandidateKey(createdCandidate);
				const existingIndex = candidates.findIndex((entry) => configureCandidateKey(entry) === key);
				if (existingIndex >= 0) {candidates[existingIndex] = createdCandidate;}
				else {candidates.push(createdCandidate);}
				continue;
			}
			if (selectedPath === "__toggle_derived__") {
				showDerivedCandidates = !showDerivedCandidates;
				continue;
			}
			const candidate = visibleCandidates.find((entry) => configureCandidateKey(entry) === selectedPath);
			if (!candidate) {throw new Error(`Unknown configure target: ${selectedPath}`);}
			const candidateKey = configureCandidateKey(candidate);
			const existingRef = selectedByPath.get(candidateKey)?.ref ?? candidate.existingRef;
			const source = assertNoCancel(await select({
				message: "Secret source",
				options: sourceChoices,
				initialValue: existingRef && hasSourceChoice(sourceChoices, existingRef.source) ? existingRef.source : void 0
			}), "Secrets configure cancelled.");
			const defaultAlias = resolveDefaultSecretProviderAlias(stagedConfig, source, { preferFirstProviderForSource: true });
			const provider = assertNoCancel(await text({
				message: "Provider alias",
				initialValue: existingRef?.source === source ? existingRef.provider : defaultAlias,
				validate: (value) => {
					const trimmed = String(value ?? "").trim();
					if (!trimmed) {return "Required";}
					if (!isValidSecretProviderAlias(trimmed)) {return "Must match /^[a-z][a-z0-9_-]{0,63}$/";}
				}
			}), "Secrets configure cancelled.");
			const providerAlias = String(provider).trim();
			let suggestedId = existingRef?.source === source ? existingRef.id : void 0;
			if (!suggestedId && source === "env") {suggestedId = resolveSuggestedEnvSecretId(candidate);}
			if (!suggestedId && source === "file") {
				const configuredProvider = stagedConfig.secrets?.providers?.[providerAlias];
				if (configuredProvider?.source === "file" && configuredProvider.mode === "singleValue") {suggestedId = "value";}
			}
			const id = assertNoCancel(await text({
				message: "Secret id",
				initialValue: suggestedId,
				validate: (value) => {
					const trimmed = String(value ?? "").trim();
					if (!trimmed) {return "Required";}
					if (source === "exec" && !isValidExecSecretRefId(trimmed)) {return formatExecSecretRefIdValidationMessage();}
				}
			}), "Secrets configure cancelled.");
			const ref = {
				source,
				provider: providerAlias,
				id: String(id).trim()
			};
			assertExpectedResolvedSecretValue({
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
			}), "Secrets configure cancelled.")) {break;}
		}
	}
	if (!hasConfigurePlanChanges({
		selectedTargets: selectedByPath,
		providerChanges
	})) {throw new Error("No secrets changes were selected.");}
	const plan = buildSecretsConfigurePlan({
		selectedTargets: selectedByPath,
		providerChanges
	});
	return {
		plan,
		preflight: await runSecretsApply({
			plan,
			env,
			write: false
		})
	};
}
//#endregion
//#region src/cli/secrets-cli.ts
function readPlanFile(pathname) {
	const raw = fs.readFileSync(pathname, "utf8");
	const parsed = JSON.parse(raw);
	if (!isSecretsApplyPlan(parsed)) {throw new Error(`Invalid secrets plan file: ${pathname}`);}
	return parsed;
}
function registerSecretsCli(program) {
	const secrets = program.command("secrets").description("Secrets runtime controls").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/gateway/security", "docs.openclaw.ai/gateway/security")}\n`);
	addGatewayClientOptions(secrets.command("reload").description("Re-resolve secret references and atomically swap runtime snapshot").option("--json", "Output JSON", false)).action(async (opts) => {
		try {
			const result = await callGatewayFromCli("secrets.reload", opts, void 0, { expectFinal: false });
			if (opts.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			const warningCount = Number(result?.warningCount ?? 0);
			if (Number.isFinite(warningCount) && warningCount > 0) {
				defaultRuntime.log(`Secrets reloaded with ${warningCount} warning(s).`);
				return;
			}
			defaultRuntime.log("Secrets reloaded.");
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	secrets.command("audit").description("Audit plaintext secrets, unresolved refs, and precedence drift").option("--check", "Exit non-zero when findings are present", false).option("--json", "Output JSON", false).action(async (opts) => {
		try {
			const report = await runSecretsAudit();
			if (opts.json) {defaultRuntime.log(JSON.stringify(report, null, 2));}
			else {
				defaultRuntime.log(`Secrets audit: ${report.status}. plaintext=${report.summary.plaintextCount}, unresolved=${report.summary.unresolvedRefCount}, shadowed=${report.summary.shadowedRefCount}, legacy=${report.summary.legacyResidueCount}.`);
				if (report.findings.length > 0) {
					for (const finding of report.findings.slice(0, 20)) {defaultRuntime.log(`- [${finding.code}] ${finding.file}:${finding.jsonPath} ${finding.message}`);}
					if (report.findings.length > 20) {defaultRuntime.log(`... ${report.findings.length - 20} more finding(s).`);}
				}
			}
			const exitCode = resolveSecretsAuditExitCode(report, Boolean(opts.check));
			if (exitCode !== 0) {defaultRuntime.exit(exitCode);}
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(2);
		}
	});
	secrets.command("configure").description("Interactive secrets helper (provider setup + SecretRef mapping + preflight)").option("--apply", "Apply changes immediately after preflight", false).option("--yes", "Skip apply confirmation prompt", false).option("--providers-only", "Configure secrets.providers only, skip credential mapping", false).option("--skip-provider-setup", "Skip provider setup and only map credential fields to existing providers", false).option("--agent <id>", "Agent id for auth-profiles targets (default: configured default agent)").option("--plan-out <path>", "Write generated plan JSON to a file").option("--json", "Output JSON", false).action(async (opts) => {
		try {
			const configured = await runSecretsConfigureInteractive({
				providersOnly: Boolean(opts.providersOnly),
				skipProviderSetup: Boolean(opts.skipProviderSetup),
				agentId: typeof opts.agent === "string" ? opts.agent : void 0
			});
			if (opts.planOut) {fs.writeFileSync(opts.planOut, `${JSON.stringify(configured.plan, null, 2)}\n`, "utf8");}
			if (opts.json) {defaultRuntime.log(JSON.stringify({
				plan: configured.plan,
				preflight: configured.preflight
			}, null, 2));}
			else {
				defaultRuntime.log(`Preflight: changed=${configured.preflight.changed}, files=${configured.preflight.changedFiles.length}, warnings=${configured.preflight.warningCount}.`);
				if (configured.preflight.warningCount > 0) {for (const warning of configured.preflight.warnings) defaultRuntime.log(`- warning: ${warning}`);}
				const providerUpserts = Object.keys(configured.plan.providerUpserts ?? {}).length;
				const providerDeletes = configured.plan.providerDeletes?.length ?? 0;
				defaultRuntime.log(`Plan: targets=${configured.plan.targets.length}, providerUpserts=${providerUpserts}, providerDeletes=${providerDeletes}.`);
				if (opts.planOut) {defaultRuntime.log(`Plan written to ${opts.planOut}`);}
			}
			let shouldApply = Boolean(opts.apply);
			if (!shouldApply && !opts.json) {
				const approved = await confirm({
					message: "Apply this plan now?",
					initialValue: true
				});
				if (typeof approved === "boolean") {shouldApply = approved;}
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
					write: true
				});
				if (opts.json) {
					defaultRuntime.log(JSON.stringify(result, null, 2));
					return;
				}
				defaultRuntime.log(result.changed ? `Secrets applied. Updated ${result.changedFiles.length} file(s).` : "Secrets apply: no changes.");
			}
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	secrets.command("apply").description("Apply a previously generated secrets plan").requiredOption("--from <path>", "Path to plan JSON").option("--dry-run", "Validate/preflight only", false).option("--json", "Output JSON", false).action(async (opts) => {
		try {
			const result = await runSecretsApply({
				plan: readPlanFile(opts.from),
				write: !opts.dryRun
			});
			if (opts.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			if (opts.dryRun) {
				defaultRuntime.log(result.changed ? `Secrets apply dry run: ${result.changedFiles.length} file(s) would change.` : "Secrets apply dry run: no changes.");
				return;
			}
			defaultRuntime.log(result.changed ? `Secrets applied. Updated ${result.changedFiles.length} file(s).` : "Secrets apply: no changes.");
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
}
//#endregion
export { registerSecretsCli };
