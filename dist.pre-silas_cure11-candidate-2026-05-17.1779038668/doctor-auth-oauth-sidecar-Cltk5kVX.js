import { g as resolveOAuthDir, v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { g as shortenHomePath } from "./utils-CpmNtyoq.js";
import "./agent-scope-C5uhMtO-.js";
import { a as resolveAgentDir, n as listAgentIds, s as resolveDefaultAgentDir } from "./agent-scope-config-BWnA6LIS.js";
import { n as saveJsonFile, t as loadJsonFile } from "./json-file-CuVcyv5a.js";
import { u as resolveAuthStorePath } from "./source-check-CVEfE2Xf.js";
import { t as clearRuntimeAuthProfileStoreSnapshots } from "./store-B65Fparu.js";
import { t as note } from "./note-B7V1z9JE.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as childProcess from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
//#region src/commands/doctor-auth-oauth-sidecar.ts
const LEGACY_OAUTH_REF_SOURCE = "openclaw-credentials";
const LEGACY_OAUTH_REF_PROVIDER = "openai-codex";
const LEGACY_OAUTH_SECRET_DIRNAME = "auth-profiles";
const LEGACY_OAUTH_SECRET_VERSION = 1;
const LEGACY_OAUTH_SECRET_ALGORITHM = "aes-256-gcm";
const LEGACY_OAUTH_SECRET_KEY_ENV = "OPENCLAW_AUTH_PROFILE_SECRET_KEY";
const LEGACY_OAUTH_SECRET_KEYCHAIN_SERVICE = "OpenClaw Auth Profile Secrets";
const LEGACY_OAUTH_SECRET_KEYCHAIN_ACCOUNT = "oauth-profile-master-key";
const LEGACY_OAUTH_SECRET_KEY_FILE_NAME = "auth-profile-secret-key";
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function readNonEmptyString(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
function isLegacyOAuthRef(value) {
	if (!isRecord(value)) return false;
	return value.source === LEGACY_OAUTH_REF_SOURCE && value.provider === LEGACY_OAUTH_REF_PROVIDER && typeof value.id === "string" && /^[a-f0-9]{32}$/.test(value.id);
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
		const provider = readNonEmptyString(value.provider);
		if (!ref || provider !== LEGACY_OAUTH_REF_PROVIDER) continue;
		profiles.push({
			profileId,
			provider,
			ref
		});
	}
	return profiles.length > 0 ? {
		...candidate,
		raw,
		profiles
	} : null;
}
function resolveLegacyOAuthSidecarPath(ref, env = process.env) {
	return path.join(resolveOAuthDir(env), LEGACY_OAUTH_SECRET_DIRNAME, `${ref.id}.json`);
}
function normalizeLegacyOAuthSecretMaterial(raw) {
	if (!isRecord(raw)) return null;
	const material = {
		...readNonEmptyString(raw.access) ? { access: readNonEmptyString(raw.access) } : {},
		...readNonEmptyString(raw.refresh) ? { refresh: readNonEmptyString(raw.refresh) } : {},
		...readNonEmptyString(raw.idToken) ? { idToken: readNonEmptyString(raw.idToken) } : {}
	};
	return Object.keys(material).length > 0 ? material : null;
}
function coerceLegacyOAuthEncryptedPayload(raw) {
	if (!isRecord(raw)) return null;
	return raw.algorithm === LEGACY_OAUTH_SECRET_ALGORITHM && typeof raw.iv === "string" && typeof raw.tag === "string" && typeof raw.ciphertext === "string" ? {
		algorithm: raw.algorithm,
		iv: raw.iv,
		tag: raw.tag,
		ciphertext: raw.ciphertext
	} : null;
}
function isLegacyOAuthSidecarPayload(raw) {
	if (!isRecord(raw)) return false;
	if (raw.version !== LEGACY_OAUTH_SECRET_VERSION || readNonEmptyString(raw.profileId) === void 0 || raw.provider !== LEGACY_OAUTH_REF_PROVIDER) return false;
	return coerceLegacyOAuthEncryptedPayload(raw.encrypted) !== null || normalizeLegacyOAuthSecretMaterial(raw) !== null;
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
function buildLegacyOAuthSecretAad(params) {
	return Buffer.from(`${params.ref.id}\0${params.profileId}\0${params.provider}`, "utf8");
}
function buildLegacyOAuthSecretKey(seed) {
	return createHash("sha256").update(`openclaw:auth-profile-oauth:${seed}`).digest();
}
function isPathInsideOrEqual(parentDir, candidatePath) {
	const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
	return relative === "" || !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function uniquePaths(paths) {
	return Array.from(new Set(paths.filter((entry) => Boolean(entry))));
}
function resolveLegacyOAuthSecretKeyFileCandidates(env) {
	if (process.platform === "win32") {
		const home = env.USERPROFILE?.trim() || os.homedir();
		const root = env.APPDATA?.trim() || (home ? path.join(home, "AppData", "Roaming") : void 0);
		return uniquePaths([root ? path.join(root, "OpenClaw", LEGACY_OAUTH_SECRET_KEY_FILE_NAME) : void 0, home ? path.join(home, ".openclaw-auth-profile-secrets", LEGACY_OAUTH_SECRET_KEY_FILE_NAME) : void 0]);
	}
	if (process.platform === "darwin") {
		const home = env.HOME?.trim() || os.homedir();
		return uniquePaths([home ? path.join(home, "Library", "Application Support", "OpenClaw", LEGACY_OAUTH_SECRET_KEY_FILE_NAME) : void 0, home ? path.join(home, ".openclaw-auth-profile-secrets", LEGACY_OAUTH_SECRET_KEY_FILE_NAME) : void 0]);
	}
	const home = env.HOME?.trim() || os.homedir();
	const root = env.XDG_CONFIG_HOME?.trim() || (home ? path.join(home, ".config") : void 0);
	return uniquePaths([root ? path.join(root, "openclaw", LEGACY_OAUTH_SECRET_KEY_FILE_NAME) : void 0, home ? path.join(home, ".openclaw-auth-profile-secrets", LEGACY_OAUTH_SECRET_KEY_FILE_NAME) : void 0]);
}
function resolveLegacyOAuthSecretKeyFilePath(env) {
	const stateDir = resolveStateDir(env);
	return resolveLegacyOAuthSecretKeyFileCandidates(env).find((candidate) => !isPathInsideOrEqual(stateDir, candidate));
}
function readLegacyOAuthSecretKeyFile(env) {
	const keyPath = resolveLegacyOAuthSecretKeyFilePath(env);
	if (!keyPath) return;
	try {
		return fs.readFileSync(keyPath, "utf8").trim() || void 0;
	} catch {
		return;
	}
}
function readLegacyMacOAuthSecretKeychainKey() {
	if (process.platform !== "darwin" || process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== void 0) return;
	try {
		return childProcess.execFileSync("security", [
			"find-generic-password",
			"-s",
			LEGACY_OAUTH_SECRET_KEYCHAIN_SERVICE,
			"-a",
			LEGACY_OAUTH_SECRET_KEYCHAIN_ACCOUNT,
			"-w"
		], {
			encoding: "utf8",
			timeout: 5e3,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		}).trim();
	} catch {
		return;
	}
}
function resolveLegacyOAuthSecretKeySeeds(env) {
	const seeds = [];
	const addSeed = (value) => {
		const trimmed = value?.trim();
		if (trimmed && !seeds.includes(trimmed)) seeds.push(trimmed);
	};
	addSeed(env[LEGACY_OAUTH_SECRET_KEY_ENV]);
	if (env.NODE_ENV === "test" && env.VITEST === "true") addSeed("openclaw-test-oauth-profile-secret-key");
	addSeed(readLegacyOAuthSecretKeyFile(env));
	return seeds;
}
function decryptLegacyOAuthSecretMaterialWithSeed(params, seed) {
	try {
		const decipher = createDecipheriv(LEGACY_OAUTH_SECRET_ALGORITHM, buildLegacyOAuthSecretKey(seed), Buffer.from(params.encrypted.iv, "base64url"));
		decipher.setAAD(buildLegacyOAuthSecretAad({
			ref: params.ref,
			profileId: params.profileId,
			provider: params.provider
		}));
		decipher.setAuthTag(Buffer.from(params.encrypted.tag, "base64url"));
		const plaintext = Buffer.concat([decipher.update(Buffer.from(params.encrypted.ciphertext, "base64url")), decipher.final()]).toString("utf8");
		return normalizeLegacyOAuthSecretMaterial(JSON.parse(plaintext));
	} catch {
		return null;
	}
}
function decryptLegacyOAuthSecretMaterial(params) {
	const seeds = resolveLegacyOAuthSecretKeySeeds(params.env);
	for (const seed of seeds) {
		const material = decryptLegacyOAuthSecretMaterialWithSeed(params, seed);
		if (material) return material;
	}
	const keychainSeed = readLegacyMacOAuthSecretKeychainKey();
	if (keychainSeed && !seeds.includes(keychainSeed)) return decryptLegacyOAuthSecretMaterialWithSeed(params, keychainSeed);
	return null;
}
function loadLegacyOAuthSidecarMaterial(profile, env) {
	const raw = loadJsonFile(resolveLegacyOAuthSidecarPath(profile.ref, env));
	if (!isRecord(raw)) return null;
	if (raw.version !== LEGACY_OAUTH_SECRET_VERSION || raw.profileId !== profile.profileId || raw.provider !== profile.provider) return null;
	const encrypted = coerceLegacyOAuthEncryptedPayload(raw.encrypted);
	if (encrypted) return decryptLegacyOAuthSecretMaterial({
		ref: profile.ref,
		profileId: profile.profileId,
		provider: profile.provider,
		encrypted,
		env
	});
	return normalizeLegacyOAuthSecretMaterial(raw);
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
			const material = loadLegacyOAuthSidecarMaterial(profile, env);
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
//#endregion
export { maybeRepairLegacyOAuthSidecarProfiles as t };
