import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import path from "node:path";
import crypto from "node:crypto";
//#region extensions/matrix/src/storage-paths.ts
function sanitizeMatrixPathSegment(value) {
	return normalizeLowercaseStringOrEmpty(value).replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}
function resolveMatrixHomeserverKey(homeserver) {
	try {
		const url = new URL(homeserver);
		if (url.host) return sanitizeMatrixPathSegment(url.host);
	} catch {}
	return sanitizeMatrixPathSegment(homeserver);
}
function hashMatrixAccessToken(accessToken) {
	return crypto.createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}
function resolveMatrixCredentialsFilename(accountId) {
	const normalized = normalizeAccountId(accountId);
	return normalized === "default" ? "credentials.json" : `credentials-${normalized}.json`;
}
function resolveMatrixCredentialsDir(stateDir) {
	return path.join(stateDir, "credentials", "matrix");
}
function resolveMatrixCredentialsPath(params) {
	return path.join(resolveMatrixCredentialsDir(params.stateDir), resolveMatrixCredentialsFilename(params.accountId));
}
function resolveMatrixLegacyFlatStoreRoot(stateDir) {
	return path.join(stateDir, "matrix");
}
function resolveMatrixLegacyFlatStoragePaths(stateDir) {
	const rootDir = resolveMatrixLegacyFlatStoreRoot(stateDir);
	return {
		rootDir,
		storagePath: path.join(rootDir, "bot-storage.json"),
		cryptoPath: path.join(rootDir, "crypto")
	};
}
function resolveMatrixAccountStorageRoot(params) {
	const accountKey = sanitizeMatrixPathSegment(params.accountId ?? "default");
	const userKey = sanitizeMatrixPathSegment(params.userId);
	const serverKey = resolveMatrixHomeserverKey(params.homeserver);
	const tokenHash = hashMatrixAccessToken(params.accessToken);
	return {
		rootDir: path.join(params.stateDir, "matrix", "accounts", accountKey, `${serverKey}__${userKey}`, tokenHash),
		accountKey,
		tokenHash
	};
}
//#endregion
export { resolveMatrixCredentialsPath as a, resolveMatrixLegacyFlatStoreRoot as c, resolveMatrixCredentialsFilename as i, sanitizeMatrixPathSegment as l, resolveMatrixAccountStorageRoot as n, resolveMatrixHomeserverKey as o, resolveMatrixCredentialsDir as r, resolveMatrixLegacyFlatStoragePaths as s, hashMatrixAccessToken as t };
