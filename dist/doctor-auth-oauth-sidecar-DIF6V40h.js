import { _ as resolveOAuthDir, y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { a as resolveAgentDir, n as listAgentIds, s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import { n as saveJsonFile, t as loadJsonFile } from "./json-file-DpLhTVdZ.js";
import { r as resolveAuthStorePath } from "./path-resolve-C6Vj5eOM.js";
import "./constants-D_82oc2f.js";
import { _ as isLegacyOAuthRef, b as loadLegacyOAuthSidecarMaterial, t as clearRuntimeAuthProfileStoreSnapshots, v as isLegacyOAuthSidecarPayload, x as resolveLegacyOAuthSidecarPath, y as legacyOAuthSidecarTestUtils } from "./store-BMQkMM4l.js";
import "./paths-DuwII6c5.js";
import { t as note } from "./note-Dg2Luaaq.js";
import fs from "node:fs";
import path from "node:path";
//#region src/commands/doctor-auth-oauth-sidecar.ts
const LEGACY_OAUTH_SECRET_DIRNAME = "auth-profiles";
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function readNonEmptyString(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
function addCandidate(candidates, agentDir) {
	const authPath = resolveAuthStorePath(agentDir);
	candidates.set(path.resolve(authPath), {
		agentDir,
		authPath
	});
}
function listExistingAgentDirsFromState(env) {
	const root = path.join(resolveStateDir(env), "agents");
	let entries;
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => path.join(root, entry.name, "agent")).filter((agentDir) => {
		try {
			return fs.statSync(agentDir).isDirectory();
		} catch {
			return false;
		}
	});
}
function listAuthProfileRepairCandidates(cfg, env) {
	const candidates = /* @__PURE__ */ new Map();
	addCandidate(candidates, resolveDefaultAgentDir(cfg, env));
	const envAgentDir = readNonEmptyString(env.OPENCLAW_AGENT_DIR);
	if (envAgentDir) addCandidate(candidates, envAgentDir);
	for (const agentId of listAgentIds(cfg)) addCandidate(candidates, resolveAgentDir(cfg, agentId, env));
	for (const agentDir of listExistingAgentDirsFromState(env)) addCandidate(candidates, agentDir);
	return [...candidates.values()];
}
function resolveLegacyOAuthSidecarStore(candidate) {
	if (!fs.existsSync(candidate.authPath)) return null;
	const raw = loadJsonFile(candidate.authPath);
	if (!isRecord(raw) || !isRecord(raw.profiles)) return null;
	const profiles = [];
	for (const [profileId, value] of Object.entries(raw.profiles)) {
		if (!isRecord(value) || value.type !== "oauth") continue;
		const ref = isLegacyOAuthRef(value.oauthRef) ? value.oauthRef : void 0;
		if (!ref || readNonEmptyString(value.provider) !== ref.provider) continue;
		profiles.push({
			profileId,
			provider: ref.provider,
			ref
		});
	}
	return profiles.length > 0 ? {
		...candidate,
		raw,
		profiles
	} : null;
}
function listUnreferencedLegacyOAuthSidecars(referencedRefIds, env) {
	const sidecarDir = path.join(resolveOAuthDir(env), LEGACY_OAUTH_SECRET_DIRNAME);
	let entries;
	try {
		entries = fs.readdirSync(sidecarDir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.flatMap((entry) => {
		if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
		const refId = entry.name.slice(0, -5);
		if (!/^[a-f0-9]{32}$/.test(refId) || referencedRefIds.has(refId)) return [];
		const sidecarPath = path.join(sidecarDir, entry.name);
		return isLegacyOAuthSidecarPayload(loadJsonFile(sidecarPath)) ? [{ sidecarPath }] : [];
	});
}
function applyLegacyOAuthSidecarMaterial(params) {
	if (!isRecord(params.raw.profiles)) return false;
	const entry = params.raw.profiles[params.profile.profileId];
	if (!isRecord(entry)) return false;
	delete entry.oauthRef;
	if (params.material.access) entry.access = params.material.access;
	if (params.material.refresh) entry.refresh = params.material.refresh;
	if (params.material.idToken) entry.idToken = params.material.idToken;
	return true;
}
function backupLegacyOAuthSidecarStore(authPath, now) {
	const backupPath = `${authPath}.oauth-ref.${now()}.bak`;
	fs.copyFileSync(authPath, backupPath);
	return backupPath;
}
async function maybeRepairLegacyOAuthSidecarProfiles(params) {
	const now = params.now ?? Date.now;
	const emitNotes = params.emitNotes !== false;
	const env = params.env ?? process.env;
	const stores = listAuthProfileRepairCandidates(params.cfg, env).map(resolveLegacyOAuthSidecarStore).filter((entry) => entry !== null);
	const unreferencedSidecars = listUnreferencedLegacyOAuthSidecars(new Set(stores.flatMap((entry) => entry.profiles.map((p) => p.ref.id))), env);
	const result = {
		detected: [...stores.map((entry) => entry.authPath), ...unreferencedSidecars.map((entry) => entry.sidecarPath)],
		changes: [],
		warnings: []
	};
	if (stores.length === 0 && unreferencedSidecars.length === 0) return result;
	if (emitNotes) note([
		...stores.map((entry) => `- ${shortenHomePath(entry.authPath)} has legacy sidecar-backed Codex OAuth profiles.`),
		...unreferencedSidecars.length > 0 ? [`- Found ${unreferencedSidecars.length} unreferenced legacy Codex OAuth sidecar credential file${unreferencedSidecars.length === 1 ? "" : "s"}.`, `- Unreferenced sidecar files are left in place because external agent directories outside this scan may still reference them.`] : [],
		`- ${formatCliCommand("openclaw doctor --fix")} migrates active profiles back to inline OAuth credentials and removes only sidecar files it successfully migrated.`
	].join("\n"), "Auth profiles");
	if (!await params.prompter.confirmAutoFix({
		message: "Migrate legacy sidecar-backed Codex OAuth credentials now?",
		initialValue: true
	})) return result;
	const migratedSidecarsByRefId = /* @__PURE__ */ new Map();
	const unresolvedRefIds = /* @__PURE__ */ new Set();
	for (const store of stores) {
		let migratedCount = 0;
		const storeMigratedSidecarsByRefId = /* @__PURE__ */ new Map();
		for (const profile of store.profiles) {
			const material = loadLegacyOAuthSidecarMaterial({
				...profile,
				env
			});
			if (!material) {
				unresolvedRefIds.add(profile.ref.id);
				result.warnings.push(`Could not decrypt legacy OAuth sidecar for ${profile.profileId} in ${shortenHomePath(store.authPath)}; re-authenticate this profile.`);
				continue;
			}
			if (applyLegacyOAuthSidecarMaterial({
				raw: store.raw,
				profile,
				material
			})) {
				migratedCount += 1;
				storeMigratedSidecarsByRefId.set(profile.ref.id, resolveLegacyOAuthSidecarPath(profile.ref, env));
			} else unresolvedRefIds.add(profile.ref.id);
		}
		if (migratedCount === 0) continue;
		try {
			const backupPath = backupLegacyOAuthSidecarStore(store.authPath, now);
			if (!("version" in store.raw)) store.raw.version = 1;
			saveJsonFile(store.authPath, store.raw);
			for (const [refId, sidecarPath] of storeMigratedSidecarsByRefId) migratedSidecarsByRefId.set(refId, sidecarPath);
			result.changes.push(`Migrated ${migratedCount} sidecar-backed Codex OAuth profile${migratedCount === 1 ? "" : "s"} in ${shortenHomePath(store.authPath)} to inline credentials (backup: ${shortenHomePath(backupPath)}).`);
		} catch (err) {
			for (const refId of storeMigratedSidecarsByRefId.keys()) unresolvedRefIds.add(refId);
			result.warnings.push(`Failed to migrate legacy OAuth sidecars in ${shortenHomePath(store.authPath)}: ${String(err)}`);
		}
	}
	for (const [refId, sidecarPath] of migratedSidecarsByRefId) {
		if (unresolvedRefIds.has(refId)) continue;
		try {
			fs.rmSync(sidecarPath, { force: true });
		} catch (err) {
			result.warnings.push(`Failed to remove migrated legacy OAuth sidecar ${shortenHomePath(sidecarPath)}: ${String(err)}`);
		}
	}
	if (unreferencedSidecars.length > 0) result.warnings.push(`Found ${unreferencedSidecars.length} unreferenced legacy Codex OAuth sidecar credential file${unreferencedSidecars.length === 1 ? "" : "s"}; left in place because external agent directories outside this scan may still reference ${unreferencedSidecars.length === 1 ? "it" : "them"}.`);
	if (result.changes.length > 0) clearRuntimeAuthProfileStoreSnapshots();
	if (emitNotes && result.changes.length > 0) note(result.changes.map((change) => `- ${change}`).join("\n"), "Doctor changes");
	if (emitNotes && result.warnings.length > 0) note(result.warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
	return result;
}
legacyOAuthSidecarTestUtils.buildLegacyOAuthSecretAad, legacyOAuthSidecarTestUtils.buildLegacyOAuthSecretKey;
//#endregion
export { maybeRepairLegacyOAuthSidecarProfiles as t };
