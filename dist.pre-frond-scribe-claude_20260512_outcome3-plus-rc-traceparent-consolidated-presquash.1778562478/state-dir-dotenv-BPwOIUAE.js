import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { i as normalizeEnvVarKey, n as isDangerousHostEnvOverrideVarName, r as isDangerousHostEnvVarName } from "./host-env-security-CXDv4ev5.js";
import { n as containsEnvVarReference } from "./env-substitution-DsepEDPS.js";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
//#region src/config/config-env-vars.ts
function isBlockedConfigEnvVar(key) {
	return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key);
}
function collectConfigEnvVarsByTarget(cfg) {
	const envConfig = cfg?.env;
	if (!envConfig) return {};
	const entries = {};
	if (envConfig.vars) for (const [rawKey, value] of Object.entries(envConfig.vars)) {
		if (typeof value !== "string" || !value.trim()) continue;
		const key = normalizeEnvVarKey(rawKey, { portable: true });
		if (!key) continue;
		if (isBlockedConfigEnvVar(key)) continue;
		entries[key] = value;
	}
	for (const [rawKey, value] of Object.entries(envConfig)) {
		if (rawKey === "shellEnv" || rawKey === "vars") continue;
		if (typeof value !== "string" || !value.trim()) continue;
		const key = normalizeEnvVarKey(rawKey, { portable: true });
		if (!key) continue;
		if (isBlockedConfigEnvVar(key)) continue;
		entries[key] = value;
	}
	return entries;
}
function collectConfigRuntimeEnvVars(cfg) {
	return collectConfigEnvVarsByTarget(cfg);
}
function collectConfigServiceEnvVars(cfg) {
	return collectConfigEnvVarsByTarget(cfg);
}
function createConfigRuntimeEnv(cfg, baseEnv = process.env) {
	const env = { ...baseEnv };
	applyConfigEnvVars(cfg, env);
	return env;
}
function applyConfigEnvVars(cfg, env = process.env) {
	const entries = collectConfigRuntimeEnvVars(cfg);
	for (const [key, value] of Object.entries(entries)) {
		if (env[key]?.trim()) continue;
		if (containsEnvVarReference(value)) continue;
		env[key] = value;
	}
}
//#endregion
//#region src/config/state-dir-dotenv.ts
function isBlockedServiceEnvVar(key) {
	return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key);
}
function parseStateDirDotEnvContent(content) {
	const parsed = dotenv.parse(content);
	const entries = {};
	for (const [rawKey, value] of Object.entries(parsed)) {
		if (!value?.trim()) continue;
		const key = normalizeEnvVarKey(rawKey, { portable: true });
		if (!key) continue;
		if (isBlockedServiceEnvVar(key)) continue;
		entries[key] = value;
	}
	return entries;
}
function readStateDirDotEnvVarsFromStateDir(stateDir) {
	const dotEnvPath = path.join(stateDir, ".env");
	try {
		return parseStateDirDotEnvContent(fs.readFileSync(dotEnvPath, "utf8"));
	} catch {
		return {};
	}
}
/**
* Read and parse `~/.openclaw/.env` (or `$OPENCLAW_STATE_DIR/.env`), returning
* a filtered record of key-value pairs suitable for a managed service
* environment source.
*/
function readStateDirDotEnvVars(env) {
	return readStateDirDotEnvVarsFromStateDir(resolveStateDir(env));
}
function collectDurableServiceEnvVarSources(params) {
	const stateDirDotEnvEnvironment = readStateDirDotEnvVars(params.env);
	const configEnvironment = collectConfigServiceEnvVars(params.config);
	return {
		stateDirDotEnvEnvironment,
		configEnvironment,
		durableEnvironment: {
			...stateDirDotEnvEnvironment,
			...configEnvironment
		}
	};
}
/**
* Durable service env sources survive beyond the invoking shell and are safe to
* persist into owner-only gateway service environment sources.
*
* Precedence:
* 1. state-dir `.env` file vars
* 2. config service env vars
*/
function collectDurableServiceEnvVars(params) {
	return collectDurableServiceEnvVarSources(params).durableEnvironment;
}
//#endregion
export { createConfigRuntimeEnv as a, applyConfigEnvVars as i, collectDurableServiceEnvVars as n, readStateDirDotEnvVarsFromStateDir as r, collectDurableServiceEnvVarSources as t };
