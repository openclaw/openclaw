import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { a as resolveMatrixDefaultOrOnlyAccountId, n as requiresExplicitMatrixDefaultAccount } from "./account-selection-CfoMW0gI.js";
import { t as getMatrixRuntime } from "./runtime-Bzh7h5rJ.js";
import { a as resolveMatrixCredentialsPath$1, r as resolveMatrixCredentialsDir$1 } from "./storage-paths--aIiLx_E.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region extensions/matrix/src/matrix/credentials-read.ts
function resolveStateDir(env) {
	try {
		return getMatrixRuntime().state.resolveStateDir(env, os.homedir);
	} catch {
		const override = env.OPENCLAW_STATE_DIR?.trim();
		if (override) return path.resolve(override);
		const homeDir = env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || os.homedir();
		return path.join(homeDir, ".openclaw");
	}
}
function resolveLegacyMatrixCredentialsPath(env) {
	return path.join(resolveMatrixCredentialsDir(env), "credentials.json");
}
function shouldReadLegacyCredentialsForAccount(accountId) {
	const normalizedAccountId = normalizeAccountId(accountId);
	const cfg = getMatrixRuntime().config.current();
	if (!cfg.channels?.matrix || typeof cfg.channels.matrix !== "object") return normalizedAccountId === DEFAULT_ACCOUNT_ID;
	if (requiresExplicitMatrixDefaultAccount(cfg)) return false;
	return normalizeAccountId(resolveMatrixDefaultOrOnlyAccountId(cfg)) === normalizedAccountId;
}
function resolveLegacyMigrationSourcePath(env, accountId) {
	if (!shouldReadLegacyCredentialsForAccount(accountId)) return null;
	const legacyPath = resolveLegacyMatrixCredentialsPath(env);
	return legacyPath === resolveMatrixCredentialsPath(env, accountId) ? null : legacyPath;
}
function parseMatrixCredentialsFile(filePath) {
	const raw = fs.readFileSync(filePath, "utf-8");
	const parsed = JSON.parse(raw);
	if (typeof parsed.homeserver !== "string" || typeof parsed.userId !== "string" || typeof parsed.accessToken !== "string") return null;
	return parsed;
}
function loadMatrixCredentialsFile(filePath, source) {
	try {
		return {
			kind: "loaded",
			source,
			credentials: parseMatrixCredentialsFile(filePath)
		};
	} catch (error) {
		if (error?.code === "ENOENT") return { kind: "missing" };
		throw error;
	}
}
function loadLegacyMatrixCredentialsWithCurrentFallback(params) {
	const legacy = loadMatrixCredentialsFile(params.legacyPath, "legacy");
	if (legacy.kind === "loaded") return legacy;
	return loadMatrixCredentialsFile(params.currentPath, "current");
}
function resolveMatrixCredentialsDir(env = process.env, stateDir) {
	return resolveMatrixCredentialsDir$1(stateDir ?? resolveStateDir(env));
}
function resolveMatrixCredentialsPath(env = process.env, accountId) {
	return resolveMatrixCredentialsPath$1({
		stateDir: resolveStateDir(env),
		accountId
	});
}
function loadMatrixCredentials(env = process.env, accountId) {
	const currentPath = resolveMatrixCredentialsPath(env, accountId);
	try {
		const current = loadMatrixCredentialsFile(currentPath, "current");
		if (current.kind === "loaded") return current.credentials;
		const legacyPath = resolveLegacyMigrationSourcePath(env, accountId);
		if (!legacyPath) return null;
		const loaded = loadLegacyMatrixCredentialsWithCurrentFallback({
			legacyPath,
			currentPath
		});
		if (loaded.kind !== "loaded" || !loaded.credentials) return null;
		if (loaded.source === "legacy") try {
			fs.mkdirSync(path.dirname(currentPath), { recursive: true });
			fs.renameSync(legacyPath, currentPath);
		} catch {}
		return loaded.credentials;
	} catch {
		return null;
	}
}
function clearMatrixCredentials(env = process.env, accountId) {
	const paths = [resolveMatrixCredentialsPath(env, accountId), resolveLegacyMigrationSourcePath(env, accountId)];
	for (const filePath of paths) {
		if (!filePath) continue;
		try {
			fs.unlinkSync(filePath);
		} catch {}
	}
}
function credentialsMatchConfig(stored, config) {
	if (!config.userId) {
		if (!config.accessToken) return false;
		return stored.homeserver === config.homeserver && stored.accessToken === config.accessToken;
	}
	return stored.homeserver === config.homeserver && stored.userId === config.userId;
}
//#endregion
export { resolveMatrixCredentialsPath as a, resolveMatrixCredentialsDir as i, credentialsMatchConfig as n, loadMatrixCredentials as r, clearMatrixCredentials as t };
