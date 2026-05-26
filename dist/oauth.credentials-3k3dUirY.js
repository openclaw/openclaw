import { r as lowercasePreservingWhitespace } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { n as CLIENT_ID_KEYS, r as CLIENT_SECRET_KEYS } from "./oauth.shared-BD6M390i.js";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
//#region extensions/google/oauth.credentials.ts
const defaultFs = {
	existsSync,
	readFileSync,
	realpathSync,
	readdirSync
};
let credentialFs = defaultFs;
function resolveEnv(keys) {
	for (const key of keys) {
		const value = process.env[key]?.trim();
		if (value) return value;
	}
}
let cachedGeminiCliCredentials = null;
function clearCredentialsCache() {
	cachedGeminiCliCredentials = null;
}
function setOAuthCredentialsFsForTest(overrides) {
	credentialFs = overrides ? {
		...defaultFs,
		...overrides
	} : defaultFs;
}
function extractGeminiCliCredentials() {
	if (cachedGeminiCliCredentials) return cachedGeminiCliCredentials;
	try {
		const geminiPath = findInPath("gemini");
		if (!geminiPath) return null;
		const geminiCliDirs = resolveGeminiCliDirs(geminiPath, credentialFs.realpathSync(geminiPath));
		for (const geminiCliDir of geminiCliDirs) {
			const directCredentials = readGeminiCliCredentialsFromKnownPaths(geminiCliDir);
			if (directCredentials) {
				cachedGeminiCliCredentials = directCredentials;
				return directCredentials;
			}
			const bundledCredentials = readGeminiCliCredentialsFromBundle(geminiCliDir);
			if (bundledCredentials) {
				cachedGeminiCliCredentials = bundledCredentials;
				return bundledCredentials;
			}
			const discoveredCredentials = findGeminiCliCredentialsInTree(geminiCliDir, 10);
			if (discoveredCredentials) {
				cachedGeminiCliCredentials = discoveredCredentials;
				return discoveredCredentials;
			}
		}
	} catch {}
	return null;
}
function resolveGeminiCliDirs(geminiPath, resolvedPath) {
	const binDir = dirname(geminiPath);
	const candidates = [
		dirname(dirname(resolvedPath)),
		join(dirname(resolvedPath), "node_modules", "@google", "gemini-cli"),
		join(binDir, "node_modules", "@google", "gemini-cli"),
		join(dirname(binDir), "node_modules", "@google", "gemini-cli"),
		join(dirname(binDir), "lib", "node_modules", "@google", "gemini-cli")
	];
	const deduped = [];
	const seen = /* @__PURE__ */ new Set();
	for (const candidate of candidates) for (const searchDir of resolveGeminiCliSearchDirs(candidate)) {
		const key = process.platform === "win32" ? lowercasePreservingWhitespace(searchDir.replace(/\\/g, "/")) : searchDir;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(searchDir);
	}
	return deduped;
}
function resolveGeminiCliSearchDirs(candidate) {
	return [
		candidate,
		join(candidate, "node_modules", "@google", "gemini-cli"),
		join(candidate, "lib", "node_modules", "@google", "gemini-cli")
	].filter(looksLikeGeminiCliDir);
}
function looksLikeGeminiCliDir(candidate) {
	return credentialFs.existsSync(join(candidate, "package.json")) || credentialFs.existsSync(join(candidate, "node_modules", "@google", "gemini-cli-core"));
}
function findInPath(name) {
	const exts = process.platform === "win32" ? [
		".cmd",
		".bat",
		".exe",
		""
	] : [""];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) for (const ext of exts) {
		const path = join(dir, name + ext);
		if (credentialFs.existsSync(path)) return path;
	}
	return null;
}
function readGeminiCliCredentialsFile(path) {
	try {
		return parseGeminiCliCredentials(credentialFs.readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}
function parseGeminiCliCredentials(content) {
	const clientId = content.match(/OAUTH_CLIENT_ID\s*=\s*["']([^"']+)["']/)?.[1] ?? content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/)?.[1];
	const clientSecret = content.match(/OAUTH_CLIENT_SECRET\s*=\s*["']([^"']+)["']/)?.[1] ?? content.match(/(GOCSPX-[A-Za-z0-9_-]+)/)?.[1];
	if (!clientId || !clientSecret) return null;
	return {
		clientId,
		clientSecret
	};
}
function readGeminiCliCredentialsFromKnownPaths(geminiCliDir) {
	const searchPaths = [join(geminiCliDir, "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"), join(geminiCliDir, "node_modules", "@google", "gemini-cli-core", "dist", "code_assist", "oauth2.js")];
	for (const path of searchPaths) {
		if (!credentialFs.existsSync(path)) continue;
		const credentials = readGeminiCliCredentialsFile(path);
		if (credentials) return credentials;
	}
	return null;
}
function readGeminiCliCredentialsFromBundle(geminiCliDir) {
	const bundleDir = join(geminiCliDir, "bundle");
	if (!credentialFs.existsSync(bundleDir)) return null;
	try {
		for (const entry of credentialFs.readdirSync(bundleDir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
			const credentials = readGeminiCliCredentialsFile(join(bundleDir, entry.name));
			if (credentials) return credentials;
		}
	} catch {}
	return null;
}
function findGeminiCliCredentialsInTree(dir, depth) {
	if (depth <= 0) return null;
	try {
		for (const entry of credentialFs.readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isFile() && entry.name === "oauth2.js") {
				const credentials = readGeminiCliCredentialsFile(path);
				if (credentials) return credentials;
				continue;
			}
			if (entry.isDirectory() && !entry.name.startsWith(".")) {
				const found = findGeminiCliCredentialsInTree(path, depth - 1);
				if (found) return found;
			}
		}
	} catch {}
	return null;
}
function resolveOAuthClientConfig() {
	const envClientId = resolveEnv(CLIENT_ID_KEYS);
	const envClientSecret = resolveEnv(CLIENT_SECRET_KEYS);
	if (envClientId) return {
		clientId: envClientId,
		clientSecret: envClientSecret
	};
	const extracted = extractGeminiCliCredentials();
	if (extracted) return extracted;
	throw new Error("Gemini CLI not found. Install it first: brew install gemini-cli (or npm install -g @google/gemini-cli), or set GEMINI_CLI_OAUTH_CLIENT_ID.");
}
//#endregion
export { setOAuthCredentialsFsForTest as i, extractGeminiCliCredentials as n, resolveOAuthClientConfig as r, clearCredentialsCache as t };
