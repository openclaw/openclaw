import { i as normalizeProviderIdForAuth } from "./provider-id-zTW9Rdln.js";
import { J as getShellEnvAppliedKeys } from "./io-DoswVvYe.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import { i as resolvePluginSetupProvider } from "./setup-registry-DHllMAAd.js";
import { b as resolveProviderEnvAuthEvidence, y as resolveProviderEnvApiKeyCandidates } from "./model-auth-markers-Cf78z2Zm.js";
import { t as normalizeOptionalSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import fs from "node:fs";
import os from "node:os";
//#region src/agents/model-auth-env.ts
function expandAuthEvidencePath(rawPath, env) {
	const trimmed = rawPath.trim();
	if (!trimmed) return;
	const homeDir = normalizeOptionalPathInput(env.HOME) ?? os.homedir();
	const appDataDir = normalizeOptionalPathInput(env.APPDATA);
	if (trimmed.includes("${APPDATA}") && !appDataDir) return;
	return trimmed.replaceAll("${HOME}", homeDir).replaceAll("${APPDATA}", appDataDir ?? "");
}
function normalizeOptionalPathInput(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function hasRequiredAuthEvidenceEnv(evidence, env) {
	const hasEnv = (key) => Boolean(normalizeOptionalSecretInput(env[key]));
	if (evidence.requiresAnyEnv?.length && !evidence.requiresAnyEnv.some(hasEnv)) return false;
	if (evidence.requiresAllEnv?.length && !evidence.requiresAllEnv.every(hasEnv)) return false;
	return true;
}
function hasLocalFileAuthEvidence(evidence, env) {
	if (evidence.fileEnvVar) {
		const explicitPath = normalizeOptionalPathInput(env[evidence.fileEnvVar]);
		if (explicitPath) return fs.existsSync(explicitPath);
	}
	for (const rawPath of evidence.fallbackPaths ?? []) {
		const expandedPath = expandAuthEvidencePath(rawPath, env);
		if (expandedPath && fs.existsSync(expandedPath)) return true;
	}
	return false;
}
function resolveAuthEvidence(evidence, env) {
	for (const entry of evidence ?? []) {
		if (entry.type !== "local-file-with-env") continue;
		if (!hasRequiredAuthEvidenceEnv(entry, env) || !hasLocalFileAuthEvidence(entry, env)) continue;
		return {
			apiKey: entry.credentialMarker,
			source: entry.source ?? "local auth evidence"
		};
	}
	return null;
}
function resolveEnvApiKey(provider, env = process.env, options = {}) {
	const normalizedProvider = normalizeProviderIdForAuth(provider);
	const lookupParams = {
		config: options.config,
		workspaceDir: options.workspaceDir,
		env
	};
	const normalized = options.aliasMap ? options.aliasMap[normalizedProvider] ?? normalizedProvider : resolveProviderIdForAuth(provider, lookupParams);
	const candidateMap = options.candidateMap ?? resolveProviderEnvApiKeyCandidates(lookupParams);
	const authEvidenceMap = options.authEvidenceMap ?? resolveProviderEnvAuthEvidence(lookupParams);
	const applied = new Set(getShellEnvAppliedKeys());
	const pick = (envVar) => {
		const value = normalizeOptionalSecretInput(env[envVar]);
		if (!value) return null;
		return {
			apiKey: value,
			source: applied.has(envVar) ? `shell env: ${envVar}` : `env: ${envVar}`
		};
	};
	const candidates = Object.hasOwn(candidateMap, normalized) ? candidateMap[normalized] : void 0;
	if (Array.isArray(candidates)) for (const envVar of candidates) {
		const resolved = pick(envVar);
		if (resolved) return resolved;
	}
	const authEvidence = resolveAuthEvidence(Object.hasOwn(authEvidenceMap, normalized) ? authEvidenceMap[normalized] : void 0, env);
	if (authEvidence) return authEvidence;
	if (Array.isArray(candidates)) return null;
	if (options.skipSetupProviderFallback === true) return null;
	const setupProvider = resolvePluginSetupProvider({
		provider: normalized,
		env
	});
	if (setupProvider?.resolveConfigApiKey) {
		const resolved = setupProvider.resolveConfigApiKey({
			provider: normalized,
			env
		});
		if (resolved?.trim()) return {
			apiKey: resolved,
			source: resolved === "gcp-vertex-credentials" ? "gcloud adc" : "env"
		};
	}
	return null;
}
//#endregion
export { resolveEnvApiKey as t };
