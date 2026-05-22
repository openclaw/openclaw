import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { t as formatCliCommand } from "./command-format-DXo6xcsW.js";
import { i as normalizeEnvVarKey, n as isDangerousHostEnvOverrideVarName, r as isDangerousHostEnvVarName } from "./host-env-security-DKoIiz1v.js";
import { t as collectDurableServiceEnvVars } from "./state-dir-dotenv-Bj2f-okz.js";
import { o as hasConfiguredSecretInput, p as resolveSecretInputRef } from "./types.secrets-CyuYZNvB.js";
import { d as resolveGatewayLaunchAgentLabel, t as resolveGatewayStateDir } from "./paths-W_9piPld.js";
import { a as resolveGatewayProgramArguments, i as OPENCLAW_WRAPPER_ENV_KEY, n as resolveDaemonInstallRuntimeInputs, r as resolveDaemonNodeBinDir, s as resolveOpenClawWrapperPath, t as emitDaemonInstallRuntimeWarning } from "./daemon-install-plan.shared-DZsnpy4W.js";
import { _ as buildServiceEnvironment, m as writeManagedServiceEnvKeysToEnvironment, p as readManagedServiceEnvKeysFromEnvironment, s as isNonMinimalServicePathEntry, u as formatManagedServiceEnvKeys } from "./runtime-paths-ykBd9_J0.js";
import { n as discoverConfigSecretTargets } from "./target-registry-DYig1YDH.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/commands/daemon-install-helpers.ts
let daemonInstallAuthProfileSourceRuntimePromise;
let daemonInstallAuthProfileStoreRuntimePromise;
const NON_PERSISTED_CONFIG_SECRET_ENV_TARGET_IDS = new Set(["gateway.auth.password", "gateway.auth.token"]);
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
function resolveGatewayInstallWorkingDirectory(params) {
	if (params.workingDirectory) return params.workingDirectory;
	if (params.platform !== "darwin") return;
	return resolveGatewayStateDir(params.env);
}
async function buildGatewayInstallEnvironment(params) {
	const durableEnvironment = collectDurableServiceEnvVars({
		env: params.env,
		config: params.config
	});
	const configSecretRefEnvironment = collectConfigSecretRefServiceEnvVars({
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
	const environment = {
		...collectPreservedExistingServiceEnvVars(params.existingEnvironment, readManagedServiceEnvKeysFromEnvironment(params.existingEnvironment)),
		...durableEnvironment,
		...configSecretRefEnvironment,
		...authProfileEnvironment
	};
	writeManagedServiceEnvKeysToEnvironment(environment, formatManagedServiceEnvKeys(durableEnvironment, { omitKeys: Object.keys(params.serviceEnvironment) }));
	Object.assign(environment, params.serviceEnvironment);
	const mergedPath = mergeServicePath(params.serviceEnvironment.PATH, params.existingEnvironment?.PATH, params.serviceEnvironment.TMPDIR, params.platform);
	if (mergedPath) environment.PATH = mergedPath;
	return environment;
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
		extraPathDirs: resolveDaemonNodeBinDir(nodePath)
	});
	return {
		programArguments,
		workingDirectory: resolveGatewayInstallWorkingDirectory({
			env: serviceInputEnv,
			platform,
			workingDirectory
		}),
		environment: await buildGatewayInstallEnvironment({
			env: serviceInputEnv,
			config: params.config,
			authStore: params.authStore,
			warn: params.warn,
			serviceEnvironment,
			existingEnvironment: params.existingEnvironment,
			platform
		})
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
