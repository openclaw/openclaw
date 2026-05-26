import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { i as normalizeEnvVarKey, n as isDangerousHostEnvOverrideVarName, r as isDangerousHostEnvVarName } from "./host-env-security-66KkrZF_.js";
import { n as collectDurableServiceEnvVars, t as collectDurableServiceEnvVarSources } from "./state-dir-dotenv-Dzh60TUr.js";
import { m as resolveSecretInputRef, s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { u as resolveGatewayLaunchAgentLabel } from "./constants-CmvvKVqh.js";
import { t as resolveGatewayStateDir } from "./paths-Bq0Y-b28.js";
import { a as OPENCLAW_WRAPPER_ENV_KEY, c as resolveOpenClawWrapperPath, i as resolveDaemonServicePathDirs, n as resolveDaemonInstallRuntimeInputs, o as resolveGatewayProgramArguments, t as emitDaemonInstallRuntimeWarning } from "./daemon-install-plan.shared-6_gPBjOK.js";
import { S as writeManagedServiceEnvKeysToEnvironment, v as formatManagedServiceEnvKeys, x as readManagedServiceEnvKeysFromEnvironment } from "./systemd-DsQkjgIm.js";
import { d as buildServiceEnvironment, s as isNonMinimalServicePathEntry } from "./runtime-paths-DHAgI0A5.js";
import { n as discoverConfigSecretTargets } from "./target-registry-t5xykQQS.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/daemon/service-env-plan.ts
function createMutableServiceEnvPlan() {
	return {
		environment: {},
		environmentValueSources: {},
		entriesByNormalizedKey: /* @__PURE__ */ new Map()
	};
}
function normalizeServiceEnvPlanKey(rawKey) {
	return normalizeEnvVarKey(rawKey, { portable: true })?.toUpperCase();
}
function addServiceEnvPlanEntries(plan, entries, options) {
	for (const [rawKey, rawValue] of Object.entries(entries)) {
		if (typeof rawValue !== "string" || !rawValue.trim()) {
			if (options.includeRawKeys) {
				plan.environment[rawKey] = rawValue;
				plan.environmentValueSources[rawKey] = "inline";
			}
			continue;
		}
		const value = rawValue;
		const normalizedKey = normalizeServiceEnvPlanKey(rawKey);
		if (!normalizedKey) continue;
		plan.environment[rawKey] = value;
		const valueSource = typeof options.valueSource === "function" ? options.valueSource({
			rawKey,
			normalizedKey
		}) : options.valueSource;
		plan.environmentValueSources[rawKey] = valueSource ?? "inline";
		plan.entriesByNormalizedKey.set(normalizedKey, {
			rawKey,
			normalizedKey,
			value,
			source: options.source
		});
	}
}
function compactServiceEnvPlanValueSources(plan) {
	for (const key of Object.keys(plan.environmentValueSources)) if (!Object.hasOwn(plan.environment, key)) delete plan.environmentValueSources[key];
}
//#endregion
//#region src/daemon/service-env-render-policy.ts
function isLaunchAgentServiceEnvironment(params) {
	return params.platform === "darwin" && Boolean(params.serviceEnvironment.OPENCLAW_LAUNCHD_LABEL?.trim());
}
function applyManagedServiceEnvRenderPolicy(params) {
	writeManagedServiceEnvKeysToEnvironment(params.plan.environment, params.managedServiceEnvKeys);
	if (params.plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS) params.plan.environmentValueSources.OPENCLAW_SERVICE_MANAGED_ENV_KEYS = "inline";
	if (!isLaunchAgentServiceEnvironment(params)) return;
	const managedKeys = readManagedServiceEnvKeysFromEnvironment({ OPENCLAW_SERVICE_MANAGED_ENV_KEYS: params.managedServiceEnvKeys });
	if (managedKeys.size === 0) return;
	for (const entry of params.plan.entriesByNormalizedKey.values()) {
		if (entry.source !== "state-dotenv" || !managedKeys.has(entry.normalizedKey)) continue;
		params.plan.environment[entry.rawKey] = entry.value;
		params.plan.environmentValueSources[entry.rawKey] = "inline";
	}
}
//#endregion
//#region src/commands/daemon-install-helpers.ts
let daemonInstallAuthProfileSourceRuntimePromise;
let daemonInstallAuthProfileStoreRuntimePromise;
const NON_PERSISTED_CONFIG_SECRET_ENV_TARGET_IDS = new Set(["gateway.auth.password", "gateway.auth.token"]);
const EXEC_SECRET_REF_PASS_ENV_ALLOWED_OVERRIDE_ONLY_KEYS = new Set(["HOME"]);
function isBlockedExecSecretRefPassEnvKey(key) {
	if (isDangerousHostEnvVarName(key)) return true;
	if (!isDangerousHostEnvOverrideVarName(key)) return false;
	return !EXEC_SECRET_REF_PASS_ENV_ALLOWED_OVERRIDE_ONLY_KEYS.has(key.toUpperCase());
}
function loadDaemonInstallAuthProfileSourceRuntime() {
	daemonInstallAuthProfileSourceRuntimePromise ??= import("./daemon-install-auth-profiles-source.runtime.js");
	return daemonInstallAuthProfileSourceRuntimePromise;
}
function loadDaemonInstallAuthProfileStoreRuntime() {
	daemonInstallAuthProfileStoreRuntimePromise ??= import("./daemon-install-auth-profiles-store.runtime.js");
	return daemonInstallAuthProfileStoreRuntimePromise;
}
async function collectAuthProfileServiceEnvVars(params) {
	let authStore = params.authStore;
	if (!authStore) {
		const { hasAnyAuthProfileStoreSource } = await loadDaemonInstallAuthProfileSourceRuntime();
		if (!hasAnyAuthProfileStoreSource()) return {};
		const { loadAuthProfileStoreForSecretsRuntime } = await loadDaemonInstallAuthProfileStoreRuntime();
		authStore = loadAuthProfileStoreForSecretsRuntime();
	}
	if (!authStore) return {};
	const entries = {};
	for (const credential of Object.values(authStore.profiles)) {
		const ref = credential.type === "api_key" ? credential.keyRef : credential.type === "token" ? credential.tokenRef : void 0;
		if (!ref || ref.source !== "env") continue;
		const key = normalizeEnvVarKey(ref.id, { portable: true });
		if (!key) continue;
		if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) {
			params.warn?.(`Auth profile env ref "${key}" blocked by host-env security policy`, "Auth profile");
			continue;
		}
		const value = params.env[key]?.trim();
		if (!value) continue;
		entries[key] = value;
	}
	return entries;
}
function collectConfigSecretRefServiceEnvVars(params) {
	if (!params.config) return {};
	const entries = {};
	for (const target of discoverConfigSecretTargets(params.config)) {
		if (!target.entry.includeInPlan) continue;
		if (NON_PERSISTED_CONFIG_SECRET_ENV_TARGET_IDS.has(target.entry.id)) continue;
		const { ref } = resolveSecretInputRef({
			value: target.value,
			refValue: target.refValue,
			defaults: params.config.secrets?.defaults
		});
		if (!ref || ref.source !== "env") continue;
		const key = normalizeEnvVarKey(ref.id, { portable: true });
		if (!key) {
			params.warn?.(`Config SecretRef env id "${ref.id}" is not portable and was not added to the service environment`, "Config SecretRef");
			continue;
		}
		if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) {
			params.warn?.(`Config SecretRef env ref "${key}" blocked by host-env security policy`, "Config SecretRef");
			continue;
		}
		if (Object.hasOwn(params.durableEnvironment, key)) continue;
		const value = params.env[key]?.trim();
		if (!value) continue;
		entries[key] = value;
	}
	return entries;
}
function collectExecSecretRefPassEnvServiceEnvVars(params) {
	if (!params.config) return {};
	const entries = {};
	for (const target of discoverConfigSecretTargets(params.config)) {
		if (!target.entry.includeInPlan) continue;
		const { ref } = resolveSecretInputRef({
			value: target.value,
			refValue: target.refValue,
			defaults: params.config.secrets?.defaults
		});
		if (!ref || ref.source !== "exec") continue;
		const provider = params.config.secrets?.providers?.[ref.provider];
		if (!provider || provider.source !== "exec") continue;
		for (const rawKey of provider.passEnv ?? []) {
			const key = normalizeEnvVarKey(rawKey, { portable: true });
			if (!key) {
				params.warn?.(`Exec SecretRef passEnv id "${rawKey}" is not portable and was not added to the service environment`, "Config SecretRef");
				continue;
			}
			if (isBlockedExecSecretRefPassEnvKey(key)) {
				params.warn?.(`Exec SecretRef passEnv ref "${key}" blocked by host-env security policy`, "Config SecretRef");
				continue;
			}
			if (Object.hasOwn(params.durableEnvironment, key)) continue;
			const value = params.env[key]?.trim();
			if (!value) continue;
			entries[key] = value;
		}
	}
	return entries;
}
function mergeServicePath(nextPath, existingPath, tmpDir, platform) {
	const segments = [];
	const seen = /* @__PURE__ */ new Set();
	const normalizedTmpDirs = [tmpDir, os.tmpdir()].map((value) => value?.trim()).filter((value) => Boolean(value)).map((value) => path.resolve(value));
	const realTmpDirs = normalizedTmpDirs.map((tmpRoot) => {
		try {
			return path.normalize(fs.realpathSync.native(tmpRoot));
		} catch {
			return tmpRoot;
		}
	});
	const isSameOrChildPath = (candidate, parent) => candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
	const isUnsafeProcPath = (candidate) => candidate === `${path.sep}proc` || candidate.startsWith(`${path.sep}proc${path.sep}`);
	const realpathExistingPath = (candidate) => {
		const parts = [];
		let current = candidate;
		while (current && current !== path.dirname(current)) try {
			const realCurrent = path.normalize(fs.realpathSync.native(current));
			return path.normalize(path.join(realCurrent, ...parts.toReversed()));
		} catch {
			parts.push(path.basename(current));
			current = path.dirname(current);
		}
		try {
			return path.normalize(path.join(fs.realpathSync.native(current), ...parts.toReversed()));
		} catch {
			return;
		}
	};
	const normalizePreservedPathSegment = (segment) => {
		if (!path.isAbsolute(segment)) return;
		const normalized = path.normalize(segment);
		if (isUnsafeProcPath(normalized)) return;
		const cwd = path.resolve(process.cwd());
		if (isSameOrChildPath(normalized, cwd)) return;
		try {
			const realSegment = realpathExistingPath(normalized);
			const realCwd = path.normalize(fs.realpathSync.native(cwd));
			if (realSegment && isSameOrChildPath(realSegment, realCwd)) return;
		} catch {}
		return normalized;
	};
	const shouldPreserveNormalizedPathSegment = (segment) => {
		if (isNonMinimalServicePathEntry(segment, platform)) return false;
		const resolved = path.resolve(segment);
		const realResolved = realpathExistingPath(resolved) ?? resolved;
		return ![...normalizedTmpDirs, ...realTmpDirs].some((tmpRoot) => isSameOrChildPath(resolved, tmpRoot) || isSameOrChildPath(realResolved, tmpRoot));
	};
	const addPath = (value, options) => {
		if (typeof value !== "string" || value.trim().length === 0) return;
		for (const segment of value.split(path.delimiter)) {
			const trimmed = segment.trim();
			const candidate = options?.preserve ? normalizePreservedPathSegment(trimmed) : trimmed;
			if (options?.preserve && (!candidate || !shouldPreserveNormalizedPathSegment(candidate))) continue;
			if (!candidate || seen.has(candidate)) continue;
			seen.add(candidate);
			segments.push(candidate);
		}
	};
	addPath(nextPath);
	if (platform !== "darwin") addPath(existingPath, { preserve: true });
	return segments.length > 0 ? segments.join(path.delimiter) : void 0;
}
function collectPreservedExistingServiceEnvVars(existingEnvironment, managedServiceEnvKeys) {
	if (!existingEnvironment) return {};
	const preserved = {};
	for (const [rawKey, rawValue] of Object.entries(existingEnvironment)) {
		const key = normalizeEnvVarKey(rawKey, { portable: true });
		if (!key) continue;
		const upper = key.toUpperCase();
		if (upper === "HOME" || upper === "PATH" || upper === "TMPDIR" || upper.startsWith("OPENCLAW_")) continue;
		if (managedServiceEnvKeys.has(upper)) continue;
		if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) continue;
		const value = rawValue?.trim();
		if (!value) continue;
		preserved[key] = value;
	}
	return preserved;
}
function readExistingEnvironmentValueSource(params) {
	for (const [rawKey, source] of Object.entries(params.existingEnvironmentValueSources ?? {})) if (normalizeEnvVarKey(rawKey, { portable: true })?.toUpperCase() === params.normalizedKey) return source;
}
function resolveGatewayInstallWorkingDirectory(params) {
	if (params.workingDirectory) return params.workingDirectory;
	if (params.platform !== "darwin") return;
	return resolveGatewayStateDir(params.env);
}
async function buildGatewayInstallEnvironment(params) {
	const { stateDirDotEnvEnvironment, configEnvironment, durableEnvironment } = collectDurableServiceEnvVarSources({
		env: params.env,
		config: params.config
	});
	const configSecretRefEnvironment = collectConfigSecretRefServiceEnvVars({
		env: params.env,
		config: params.config,
		durableEnvironment,
		warn: params.warn
	});
	const execSecretRefPassEnvEnvironment = collectExecSecretRefPassEnvServiceEnvVars({
		env: params.env,
		config: params.config,
		durableEnvironment,
		warn: params.warn
	});
	const authProfileEnvironment = await collectAuthProfileServiceEnvVars({
		env: params.env,
		authStore: params.authStore,
		warn: params.warn
	});
	const preservedExistingEnvironment = collectPreservedExistingServiceEnvVars(params.existingEnvironment, readManagedServiceEnvKeysFromEnvironment(params.existingEnvironment));
	const plan = createMutableServiceEnvPlan();
	addServiceEnvPlanEntries(plan, preservedExistingEnvironment, {
		source: "existing-preserved",
		valueSource: ({ normalizedKey }) => readExistingEnvironmentValueSource({
			existingEnvironmentValueSources: params.existingEnvironmentValueSources,
			normalizedKey
		}) ?? "inline"
	});
	addServiceEnvPlanEntries(plan, stateDirDotEnvEnvironment, { source: "state-dotenv" });
	addServiceEnvPlanEntries(plan, configEnvironment, { source: "config-env" });
	addServiceEnvPlanEntries(plan, configSecretRefEnvironment, { source: "config-secretref-env" });
	addServiceEnvPlanEntries(plan, execSecretRefPassEnvEnvironment, { source: "exec-passenv" });
	addServiceEnvPlanEntries(plan, authProfileEnvironment, { source: "auth-profile-env" });
	applyManagedServiceEnvRenderPolicy({
		plan,
		managedServiceEnvKeys: formatManagedServiceEnvKeys(durableEnvironment, { omitKeys: Object.keys(params.serviceEnvironment) }),
		serviceEnvironment: params.serviceEnvironment,
		platform: params.platform
	});
	addServiceEnvPlanEntries(plan, params.serviceEnvironment, {
		source: "service-generated",
		includeRawKeys: true
	});
	const mergedPath = mergeServicePath(params.serviceEnvironment.PATH, params.existingEnvironment?.PATH, params.serviceEnvironment.TMPDIR, params.platform);
	if (mergedPath) {
		plan.environment.PATH = mergedPath;
		plan.environmentValueSources.PATH = "inline";
	}
	compactServiceEnvPlanValueSources(plan);
	return {
		environment: plan.environment,
		environmentValueSources: plan.environmentValueSources
	};
}
async function buildGatewayInstallPlan(params) {
	const platform = params.platform ?? process.platform;
	const { devMode, nodePath } = await resolveDaemonInstallRuntimeInputs({
		env: params.env,
		runtime: params.runtime,
		devMode: params.devMode,
		nodePath: params.nodePath
	});
	const wrapperPath = await resolveOpenClawWrapperPath(params.wrapperPath ?? params.env["OPENCLAW_WRAPPER"]);
	const serviceInputEnv = wrapperPath ? {
		...params.env,
		[OPENCLAW_WRAPPER_ENV_KEY]: wrapperPath
	} : params.env;
	const { programArguments, workingDirectory } = await resolveGatewayProgramArguments({
		port: params.port,
		dev: devMode,
		runtime: params.runtime,
		nodePath,
		wrapperPath
	});
	await emitDaemonInstallRuntimeWarning({
		env: params.env,
		runtime: params.runtime,
		programArguments,
		warn: params.warn,
		title: "Gateway runtime"
	});
	const serviceEnvironment = buildServiceEnvironment({
		env: serviceInputEnv,
		port: params.port,
		launchdLabel: platform === "darwin" ? resolveGatewayLaunchAgentLabel(serviceInputEnv.OPENCLAW_PROFILE) : void 0,
		platform,
		extraPathDirs: resolveDaemonServicePathDirs({
			nodePath,
			env: serviceInputEnv,
			platform
		})
	});
	const { environment, environmentValueSources } = await buildGatewayInstallEnvironment({
		env: serviceInputEnv,
		config: params.config,
		authStore: params.authStore,
		warn: params.warn,
		serviceEnvironment,
		existingEnvironment: params.existingEnvironment,
		existingEnvironmentValueSources: params.existingEnvironmentValueSources,
		platform
	});
	return {
		programArguments,
		workingDirectory: resolveGatewayInstallWorkingDirectory({
			env: serviceInputEnv,
			platform,
			workingDirectory
		}),
		environment,
		...Object.keys(environmentValueSources).length > 0 ? { environmentValueSources } : {}
	};
}
function gatewayInstallErrorHint(platform = process.platform) {
	return platform === "win32" ? "Tip: native Windows now falls back to a per-user Startup-folder login item when Scheduled Task creation is denied; if install still fails, rerun from an elevated PowerShell or skip service install." : `Tip: rerun \`${formatCliCommand("openclaw gateway install")}\` after fixing the error.`;
}
//#endregion
//#region src/gateway/auth-install-policy.ts
function hasExplicitGatewayInstallAuthMode(mode) {
	if (mode === "token") return true;
	if (mode === "password" || mode === "none" || mode === "trusted-proxy") return false;
}
function hasConfiguredGatewayPasswordForInstall(cfg) {
	return hasConfiguredSecretInput(cfg.gateway?.auth?.password, cfg.secrets?.defaults);
}
function hasDurableGatewayPasswordEnvForInstall(cfg, env) {
	const durableServiceEnv = collectDurableServiceEnvVars({
		env,
		config: cfg
	});
	return Boolean(normalizeOptionalString(durableServiceEnv.OPENCLAW_GATEWAY_PASSWORD) || normalizeOptionalString(durableServiceEnv.CLAWDBOT_GATEWAY_PASSWORD));
}
function shouldRequireGatewayTokenForInstall(cfg, env) {
	const explicitModeDecision = hasExplicitGatewayInstallAuthMode(cfg.gateway?.auth?.mode);
	if (explicitModeDecision !== void 0) return explicitModeDecision;
	if (hasConfiguredGatewayPasswordForInstall(cfg)) return false;
	if (hasDurableGatewayPasswordEnvForInstall(cfg, env)) return false;
	return true;
}
//#endregion
export { buildGatewayInstallPlan as n, gatewayInstallErrorHint as r, shouldRequireGatewayTokenForInstall as t };
