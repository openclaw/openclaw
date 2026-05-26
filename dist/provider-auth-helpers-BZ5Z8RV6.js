import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { o as coerceSecretRef, t as DEFAULT_SECRET_PROVIDER_ALIAS } from "./types.secrets-DwPik3M8.js";
import { s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import { t as getProviderEnvVars } from "./provider-env-vars-HpAfBQBJ.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { t as buildAuthProfileId } from "./identity-B9_6eGVi.js";
import { o as upsertAuthProfile, s as upsertAuthProfileWithLock } from "./profiles-9GB1thhi.js";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/provider-auth-helpers.ts
const ENV_REF_PATTERN = /^\$\{([A-Z][A-Z0-9_]*)\}$/;
const resolveAuthAgentDir = (agentDir, config) => agentDir ?? resolveDefaultAgentDir(config ?? {});
function buildEnvSecretRef(id) {
	return {
		source: "env",
		provider: DEFAULT_SECRET_PROVIDER_ALIAS,
		id
	};
}
function parseEnvSecretRef(value) {
	const match = ENV_REF_PATTERN.exec(value);
	if (!match) return null;
	return buildEnvSecretRef(match[1]);
}
function resolveProviderDefaultEnvSecretRef(provider, config) {
	const envVar = getProviderEnvVars(provider, {
		...config ? { config } : {},
		includeUntrustedWorkspacePlugins: false
	})?.find((candidate) => candidate.trim().length > 0);
	if (!envVar) throw new Error(`Provider "${provider}" does not have a default env var mapping for secret-input-mode=ref.`);
	return buildEnvSecretRef(envVar);
}
function resolveApiKeySecretInput(provider, input, options) {
	if (options?.secretInputMode === "plaintext") return normalizeSecretInput(input);
	const coercedRef = coerceSecretRef(input);
	if (coercedRef) return coercedRef;
	const normalized = normalizeSecretInput(input);
	const inlineEnvRef = parseEnvSecretRef(normalized);
	if (inlineEnvRef) return inlineEnvRef;
	if (options?.secretInputMode === "ref") return resolveProviderDefaultEnvSecretRef(provider, options.config);
	return normalized;
}
function buildApiKeyCredential(provider, input, metadata, options) {
	const secretInput = resolveApiKeySecretInput(provider, input, options);
	if (typeof secretInput === "string") return {
		type: "api_key",
		provider,
		key: secretInput,
		...metadata ? { metadata } : {}
	};
	return {
		type: "api_key",
		provider,
		keyRef: secretInput,
		...metadata ? { metadata } : {}
	};
}
function upsertApiKeyProfile(params) {
	const profileId = params.profileId ?? buildAuthProfileId({ providerId: params.provider });
	upsertAuthProfile({
		profileId,
		credential: buildApiKeyCredential(params.provider, params.input, params.metadata, params.options),
		agentDir: resolveAuthAgentDir(params.agentDir, params.options?.config)
	});
	return profileId;
}
async function upsertAuthProfileWithLockOrThrow(params) {
	if (!await upsertAuthProfileWithLock(params)) throw new Error("Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.");
}
function applyAuthProfileConfig(cfg, params) {
	const normalizedProvider = resolveProviderIdForAuth(params.provider, { config: cfg });
	const profiles = {
		...cfg.auth?.profiles,
		[params.profileId]: {
			provider: params.provider,
			mode: params.mode,
			...params.email ? { email: params.email } : {},
			...params.displayName ? { displayName: params.displayName } : {}
		}
	};
	const configuredProviderProfiles = Object.entries(cfg.auth?.profiles ?? {}).filter(([, profile]) => resolveProviderIdForAuth(profile.provider, { config: cfg }) === normalizedProvider).map(([profileId, profile]) => ({
		profileId,
		mode: profile.mode
	}));
	const matchingProviderOrderEntries = Object.entries(cfg.auth?.order ?? {}).filter(([providerId]) => resolveProviderIdForAuth(providerId, { config: cfg }) === normalizedProvider);
	const existingProviderOrder = matchingProviderOrderEntries.length > 0 ? [...new Set(matchingProviderOrderEntries.flatMap(([, order]) => order))] : void 0;
	const preferProfileFirst = params.preferProfileFirst ?? true;
	const reorderedProviderOrder = existingProviderOrder && preferProfileFirst ? [params.profileId, ...existingProviderOrder.filter((profileId) => profileId !== params.profileId)] : existingProviderOrder;
	const hasMixedConfiguredModes = configuredProviderProfiles.some(({ profileId, mode }) => profileId !== params.profileId && mode !== params.mode);
	const derivedProviderOrder = existingProviderOrder === void 0 && preferProfileFirst && hasMixedConfiguredModes ? [params.profileId, ...configuredProviderProfiles.map(({ profileId }) => profileId).filter((profileId) => profileId !== params.profileId)] : void 0;
	const baseOrder = matchingProviderOrderEntries.length > 0 ? Object.fromEntries(Object.entries(cfg.auth?.order ?? {}).filter(([providerId]) => resolveProviderIdForAuth(providerId, { config: cfg }) !== normalizedProvider)) : cfg.auth?.order;
	const order = existingProviderOrder !== void 0 ? {
		...baseOrder,
		[normalizedProvider]: reorderedProviderOrder?.includes(params.profileId) ? reorderedProviderOrder : [...reorderedProviderOrder ?? [], params.profileId]
	} : derivedProviderOrder ? {
		...baseOrder,
		[normalizedProvider]: derivedProviderOrder
	} : baseOrder;
	return {
		...cfg,
		auth: {
			...cfg.auth,
			profiles,
			...order ? { order } : {}
		}
	};
}
/** Resolve real path, returning null if the target doesn't exist. */
function safeRealpathSync(dir) {
	try {
		return fs.realpathSync(path.resolve(dir));
	} catch {
		return null;
	}
}
function resolveSiblingAgentDirs(primaryAgentDir) {
	const normalized = path.resolve(primaryAgentDir);
	const parentOfAgent = path.dirname(normalized);
	const candidateAgentsRoot = path.dirname(parentOfAgent);
	const agentsRoot = path.basename(normalized) === "agent" && path.basename(candidateAgentsRoot) === "agents" ? candidateAgentsRoot : path.join(resolveStateDir(), "agents");
	const discovered = (() => {
		try {
			return fs.readdirSync(agentsRoot, { withFileTypes: true });
		} catch {
			return [];
		}
	})().filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => path.join(agentsRoot, entry.name, "agent"));
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const dir of [normalized, ...discovered]) {
		const real = safeRealpathSync(dir);
		if (real && !seen.has(real)) {
			seen.add(real);
			result.push(real);
		}
	}
	return result;
}
async function writeOAuthCredentials(provider, creds, agentDir, options) {
	const email = typeof creds.email === "string" && creds.email.trim() ? creds.email.trim() : "default";
	const profileId = buildAuthProfileId({
		providerId: provider,
		profileName: options?.profileName ?? email
	});
	const resolvedAgentDir = path.resolve(resolveAuthAgentDir(agentDir));
	const targetAgentDirs = options?.syncSiblingAgents ? resolveSiblingAgentDirs(resolvedAgentDir) : [resolvedAgentDir];
	const credential = {
		type: "oauth",
		provider,
		...creds,
		...options?.displayName ? { displayName: options.displayName } : {}
	};
	await upsertAuthProfileWithLockOrThrow({
		profileId,
		credential,
		agentDir: resolvedAgentDir
	});
	if (options?.syncSiblingAgents) {
		const primaryReal = safeRealpathSync(resolvedAgentDir);
		for (const targetAgentDir of targetAgentDirs) {
			const targetReal = safeRealpathSync(targetAgentDir);
			if (targetReal && primaryReal && targetReal === primaryReal) continue;
			try {
				await upsertAuthProfileWithLock({
					profileId,
					credential,
					agentDir: targetAgentDir
				});
			} catch {}
		}
	}
	return profileId;
}
//#endregion
export { writeOAuthCredentials as i, buildApiKeyCredential as n, upsertApiKeyProfile as r, applyAuthProfileConfig as t };
