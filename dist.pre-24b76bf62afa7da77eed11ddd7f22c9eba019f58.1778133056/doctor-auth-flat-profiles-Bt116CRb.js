import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { t as formatCliCommand } from "./command-format-DXo6xcsW.js";
import { g as shortenHomePath } from "./utils-CCskKJVV.js";
import { _ as listAgentIds, b as resolveAgentDir } from "./agent-scope-eOlEQiLx.js";
import { t as loadJsonFile } from "./json-file-rNa4iFuY.js";
import { l as resolveAuthStorePath } from "./source-check-BkK5JqJj.js";
import { f as saveAuthProfileStore, t as clearRuntimeAuthProfileStoreSnapshots } from "./store-H1X3llav.js";
import { t as resolveOpenClawAgentDir } from "./agent-paths-CoNW3JiD.js";
import { t as note } from "./note-nUYTZrYm.js";
import fs from "node:fs";
import path from "node:path";
//#region src/commands/doctor-auth-flat-profiles.ts
const UNSAFE_LEGACY_AUTH_PROFILE_KEYS = new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function readNonEmptyString(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
function isSafeLegacyProviderKey(key) {
	return key.trim().length > 0 && !UNSAFE_LEGACY_AUTH_PROFILE_KEYS.has(key);
}
function inferLegacyCredentialType(record) {
	const explicit = readNonEmptyString(record.type) ?? readNonEmptyString(record.mode);
	if (explicit === "api_key" || explicit === "token" || explicit === "oauth") return explicit;
	if (readNonEmptyString(record.key) ?? readNonEmptyString(record.apiKey)) return "api_key";
	if (readNonEmptyString(record.token)) return "token";
	if (readNonEmptyString(record.access) && readNonEmptyString(record.refresh) && typeof record.expires === "number") return "oauth";
}
function coerceLegacyFlatCredential(providerId, raw) {
	if (!isRecord(raw)) return null;
	const provider = readNonEmptyString(raw.provider) ?? providerId;
	const type = inferLegacyCredentialType(raw);
	const email = readNonEmptyString(raw.email);
	if (type === "api_key") {
		const key = readNonEmptyString(raw.key) ?? readNonEmptyString(raw.apiKey);
		return key ? {
			type,
			provider,
			key,
			...email ? { email } : {}
		} : null;
	}
	if (type === "token") {
		const token = readNonEmptyString(raw.token);
		return token ? {
			type,
			provider,
			token,
			...typeof raw.expires === "number" ? { expires: raw.expires } : {},
			...email ? { email } : {}
		} : null;
	}
	if (type === "oauth") {
		const access = readNonEmptyString(raw.access);
		const refresh = readNonEmptyString(raw.refresh);
		if (!access || !refresh || typeof raw.expires !== "number") return null;
		return {
			type,
			provider,
			access,
			refresh,
			expires: raw.expires,
			...readNonEmptyString(raw.enterpriseUrl) ? { enterpriseUrl: readNonEmptyString(raw.enterpriseUrl) } : {},
			...readNonEmptyString(raw.projectId) ? { projectId: readNonEmptyString(raw.projectId) } : {},
			...readNonEmptyString(raw.accountId) ? { accountId: readNonEmptyString(raw.accountId) } : {},
			...email ? { email } : {}
		};
	}
	return null;
}
function coerceLegacyFlatAuthProfileStore(raw) {
	if (!isRecord(raw) || "profiles" in raw) return null;
	const store = {
		version: 1,
		profiles: {}
	};
	for (const [key, value] of Object.entries(raw)) {
		const providerId = key.trim();
		if (!isSafeLegacyProviderKey(providerId)) continue;
		const credential = coerceLegacyFlatCredential(providerId, value);
		if (!credential) continue;
		store.profiles[`${providerId}:default`] = credential;
	}
	return Object.keys(store.profiles).length > 0 ? store : null;
}
function addCandidate(candidates, agentDir) {
	const authPath = resolveAuthStorePath(agentDir);
	candidates.set(path.resolve(authPath), {
		agentDir,
		authPath
	});
}
function listExistingAgentDirsFromState() {
	const root = path.join(resolveStateDir(), "agents");
	let entries;
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name, "agent")).filter((agentDir) => {
		try {
			return fs.statSync(agentDir).isDirectory();
		} catch {
			return false;
		}
	});
}
function listAuthProfileRepairCandidates(cfg) {
	const candidates = /* @__PURE__ */ new Map();
	addCandidate(candidates, resolveOpenClawAgentDir());
	for (const agentId of listAgentIds(cfg)) addCandidate(candidates, resolveAgentDir(cfg, agentId));
	for (const agentDir of listExistingAgentDirsFromState()) addCandidate(candidates, agentDir);
	return [...candidates.values()];
}
function resolveLegacyFlatStore(candidate) {
	if (!fs.existsSync(candidate.authPath)) return null;
	const raw = loadJsonFile(candidate.authPath);
	if (!raw || typeof raw !== "object" || "profiles" in raw) return null;
	const store = coerceLegacyFlatAuthProfileStore(raw);
	if (!store || Object.keys(store.profiles).length === 0) return null;
	return {
		...candidate,
		store
	};
}
function backupAuthProfileStore(authPath, now) {
	const backupPath = `${authPath}.legacy-flat.${now()}.bak`;
	fs.copyFileSync(authPath, backupPath);
	return backupPath;
}
async function maybeRepairLegacyFlatAuthProfileStores(params) {
	const now = params.now ?? Date.now;
	const legacyStores = listAuthProfileRepairCandidates(params.cfg).map(resolveLegacyFlatStore).filter((entry) => entry !== null);
	const result = {
		detected: legacyStores.map((entry) => entry.authPath),
		changes: [],
		warnings: []
	};
	if (legacyStores.length === 0) return result;
	note([...legacyStores.map((entry) => `- ${shortenHomePath(entry.authPath)} uses the legacy flat auth profile format.`), `- The gateway expects the canonical version/profiles store; ${formatCliCommand("openclaw doctor --fix")} rewrites this legacy shape with a backup.`].join("\n"), "Auth profiles");
	if (!await params.prompter.confirmAutoFix({
		message: "Rewrite legacy flat auth-profiles.json files now?",
		initialValue: true
	})) return result;
	for (const entry of legacyStores) try {
		const backupPath = backupAuthProfileStore(entry.authPath, now);
		saveAuthProfileStore(entry.store, entry.agentDir, { syncExternalCli: false });
		result.changes.push(`Rewrote ${shortenHomePath(entry.authPath)} to the canonical auth profile format (backup: ${shortenHomePath(backupPath)}).`);
	} catch (err) {
		result.warnings.push(`Failed to rewrite ${shortenHomePath(entry.authPath)}: ${String(err)}`);
	}
	clearRuntimeAuthProfileStoreSnapshots();
	if (result.changes.length > 0) note(result.changes.map((change) => `- ${change}`).join("\n"), "Doctor changes");
	if (result.warnings.length > 0) note(result.warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
	return result;
}
//#endregion
export { maybeRepairLegacyFlatAuthProfileStores };
