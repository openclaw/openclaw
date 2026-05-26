import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { a as resolveAgentDir, s as resolveDefaultAgentDir, t as listAgentEntries } from "./agent-scope-config-CMp71_27.js";
import { o as withFileLock } from "./file-lock-D5OTq3qW.js";
import "./file-lock-BSRN56ID.js";
import { r as resolveAuthStorePath } from "./path-resolve-C6Vj5eOM.js";
import { t as AUTH_STORE_LOCK_OPTIONS } from "./constants-D_82oc2f.js";
import { E as hasUsableOAuthCredential, O as isSafeToAdoptMainStoreOAuthIdentity, f as saveAuthProfileStore, g as loadPersistedAuthProfileStore, w as areOAuthCredentialsEquivalent } from "./store-BMQkMM4l.js";
import "./paths-DuwII6c5.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/commands/doctor/shared/stale-oauth-profile-shadows.ts
const LEGACY_OAUTH_REF_SOURCE = "openclaw-credentials";
const LEGACY_OAUTH_REF_PROVIDER = "openai-codex";
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isLegacyOAuthRef(value) {
	return isRecord(value) && value.source === LEGACY_OAUTH_REF_SOURCE && value.provider === LEGACY_OAUTH_REF_PROVIDER && typeof value.id === "string" && /^[a-f0-9]{32}$/.test(value.id);
}
async function loadRawAuthProfileStore(authPath) {
	try {
		const raw = JSON.parse(await fs.readFile(authPath, "utf8"));
		return isRecord(raw) ? raw : null;
	} catch {
		return null;
	}
}
function hasLegacyOAuthSidecarRef(raw, profileId) {
	if (!raw || !isRecord(raw.profiles)) return false;
	const profile = raw.profiles[profileId];
	if (!isRecord(profile)) return false;
	return profile.type === "oauth" && profile.provider === LEGACY_OAUTH_REF_PROVIDER && isLegacyOAuthRef(profile.oauthRef);
}
async function pathExists(targetPath) {
	try {
		await fs.lstat(targetPath);
		return true;
	} catch {
		return false;
	}
}
async function collectStateAgentDirs(env) {
	const agentsRoot = path.join(resolveStateDir(env), "agents");
	return (await fs.readdir(agentsRoot, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => path.join(agentsRoot, entry.name, "agent"));
}
async function collectCandidateAgentDirs(cfg, env) {
	const dirs = /* @__PURE__ */ new Set();
	for (const entry of listAgentEntries(cfg)) {
		const id = entry.id?.trim();
		if (id) dirs.add(path.resolve(resolveAgentDir(cfg, id, env)));
	}
	for (const agentDir of await collectStateAgentDirs(env)) dirs.add(path.resolve(agentDir));
	return [...dirs].toSorted((left, right) => left.localeCompare(right));
}
function shouldRemoveLocalOAuthShadow(params) {
	const { local, main, now } = params;
	if (!main || main.type !== "oauth" || local.provider !== main.provider) return false;
	if (!isSafeToAdoptMainStoreOAuthIdentity(local, main)) return false;
	if (areOAuthCredentialsEquivalent(local, main)) return true;
	if (!hasUsableOAuthCredential(main, now)) return false;
	if (!hasUsableOAuthCredential(local, now)) return true;
	const localExpires = Number.isFinite(local.expires) ? local.expires : 0;
	return (Number.isFinite(main.expires) ? main.expires : 0) >= localExpires;
}
async function scanStaleOAuthProfileShadows(params) {
	const env = params.env ?? process.env;
	const now = params.now ?? Date.now();
	const mainAgentDir = resolveDefaultAgentDir({}, env);
	const mainAuthPath = path.resolve(resolveAuthStorePath(mainAgentDir));
	const mainStore = loadPersistedAuthProfileStore(mainAgentDir);
	if (!mainStore) return [];
	const hits = [];
	for (const agentDir of await collectCandidateAgentDirs(params.cfg, env)) {
		const authPath = path.resolve(resolveAuthStorePath(agentDir));
		if (authPath === mainAuthPath || !await pathExists(authPath)) continue;
		const rawLocalStore = await loadRawAuthProfileStore(authPath);
		const localStore = loadPersistedAuthProfileStore(agentDir);
		if (!localStore) continue;
		for (const [profileId, local] of Object.entries(localStore.profiles)) {
			if (local.type !== "oauth") continue;
			if (hasLegacyOAuthSidecarRef(rawLocalStore, profileId)) continue;
			const main = mainStore.profiles[profileId];
			if (shouldRemoveLocalOAuthShadow({
				local,
				main: main?.type === "oauth" ? main : void 0,
				now
			})) hits.push({
				agentDir,
				authPath,
				profileId
			});
		}
	}
	return hits;
}
function removeStaleProfilesFromStore(params) {
	const removedProfileIds = [];
	const profiles = { ...params.store.profiles };
	const usageStats = params.store.usageStats ? { ...params.store.usageStats } : void 0;
	for (const profileId of params.profileIds) {
		const local = profiles[profileId];
		const main = params.mainStore.profiles[profileId];
		if (local?.type !== "oauth" || !shouldRemoveLocalOAuthShadow({
			local,
			main: main?.type === "oauth" ? main : void 0,
			now: params.now
		})) continue;
		delete profiles[profileId];
		if (usageStats) delete usageStats[profileId];
		removedProfileIds.push(profileId);
	}
	return {
		store: {
			...params.store,
			profiles,
			...usageStats && Object.keys(usageStats).length > 0 ? { usageStats } : { usageStats: void 0 }
		},
		removedProfileIds
	};
}
function formatProfileList(profileIds) {
	return profileIds.length === 1 ? profileIds[0] : `${profileIds.length} profiles`;
}
async function repairStaleOAuthProfilesForAgent(params) {
	return await withFileLock(resolveAuthStorePath(params.agentDir), AUTH_STORE_LOCK_OPTIONS, async () => {
		const store = loadPersistedAuthProfileStore(params.agentDir);
		if (!store) return { status: "missing" };
		const rawStore = await loadRawAuthProfileStore(resolveAuthStorePath(params.agentDir));
		const profileIds = new Set([...params.profileIds].filter((profileId) => !hasLegacyOAuthSidecarRef(rawStore, profileId)));
		if (profileIds.size === 0) return { status: "unchanged" };
		const result = removeStaleProfilesFromStore({
			store,
			mainStore: params.mainStore,
			profileIds,
			now: params.now
		});
		if (result.removedProfileIds.length === 0) return { status: "unchanged" };
		saveAuthProfileStore(result.store, params.agentDir);
		return {
			status: "changed",
			removedProfileIds: result.removedProfileIds
		};
	});
}
function collectStaleOAuthProfileShadowWarnings(params) {
	return params.hits.map((hit) => `- ${shortenHomePath(hit.authPath)} has stale OAuth auth profile ${hit.profileId}; it shadows the fresher main-agent credential. Run "${params.doctorFixCommand}" to remove the local shadow and inherit main auth.`);
}
async function repairStaleOAuthProfileShadows(params) {
	const env = params.env ?? process.env;
	const now = params.now ?? Date.now();
	const hits = await scanStaleOAuthProfileShadows({
		...params,
		env,
		now
	});
	const changes = [];
	const warnings = [];
	const byAgentDir = /* @__PURE__ */ new Map();
	for (const hit of hits) {
		const existing = byAgentDir.get(hit.agentDir) ?? [];
		existing.push(hit);
		byAgentDir.set(hit.agentDir, existing);
	}
	for (const [agentDir, agentHits] of byAgentDir) {
		const mainStore = loadPersistedAuthProfileStore(resolveDefaultAgentDir({}, env));
		if (!mainStore) continue;
		const profileIds = new Set(agentHits.map((hit) => hit.profileId));
		try {
			const repair = await repairStaleOAuthProfilesForAgent({
				agentDir,
				mainStore,
				profileIds,
				now
			});
			if (repair.status === "changed") changes.push(`Removed stale OAuth auth profile shadow ${formatProfileList(repair.removedProfileIds.toSorted())} from ${shortenHomePath(resolveAuthStorePath(agentDir))}; this agent now inherits main auth.`);
		} catch (error) {
			warnings.push(`Failed to remove stale OAuth auth profile shadow from ${shortenHomePath(resolveAuthStorePath(agentDir))}: ${String(error)}`);
		}
	}
	return {
		changes,
		warnings
	};
}
//#endregion
export { repairStaleOAuthProfileShadows as n, scanStaleOAuthProfileShadows as r, collectStaleOAuthProfileShadowWarnings as t };
