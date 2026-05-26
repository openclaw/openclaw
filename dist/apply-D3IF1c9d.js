import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { c as isRecord, d as resolveConfigDir, p as resolveUserPath } from "./utils-sBTEdeml.js";
import { o as coerceSecretRef } from "./types.secrets-DwPik3M8.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import "./agent-scope-CtLXGcWm.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { l as writeTextFileAtomic, n as isNonEmptyString } from "./shared-Cv5g0_Ch.js";
import { n as getPath, r as setPathCreateStrict, t as deletePathStrict } from "./path-utils-BCEW_1WB.js";
import { a as resolveSecretRefValue } from "./resolve-D1Ko6pWx.js";
import { r as listKnownSecretEnvVarNames } from "./provider-env-vars-HpAfBQBJ.js";
import { i as replaceConfigFile } from "./mutate-DLC8bveh.js";
import "./config-B6Oplu5W.js";
import { r as resolveAuthStorePath } from "./path-resolve-C6Vj5eOM.js";
import "./constants-D_82oc2f.js";
import { c as loadAuthProfileStoreForSecretsRuntime, h as coercePersistedAuthProfileStore } from "./store-BMQkMM4l.js";
import "./paths-DuwII6c5.js";
import "./model-selection-P-81eBKx.js";
import "./auth-profiles-D6NMnufG.js";
import { t as assertExpectedResolvedSecretValue } from "./secret-value-BZ8grP0G.js";
import { o as prepareSecretsRuntimeSnapshot } from "./runtime-nQoXP16c.js";
import { a as readJsonObjectIfExists, c as createSecretsConfigIO, i as parseEnvAssignmentValue, l as iterateAuthProfileCredentials, n as listAuthProfileStorePaths, o as getSkippedExecRefStaticError, r as listLegacyAuthJsonPaths } from "./storage-scan-B8FlWLBo.js";
import { n as normalizeSecretsPlanOptions, r as resolveValidatedPlanTarget } from "./plan-CxNgsCY6.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isDeepStrictEqual } from "node:util";
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
const testing = { async projectConfigForTest(params) {
	return (await projectPlanState({
		plan: params.plan,
		env: params.env ?? process.env,
		write: false,
		allowExecInDryRun: false
	})).nextConfig;
} };
//#endregion
export { testing as n, runSecretsApply as t };
