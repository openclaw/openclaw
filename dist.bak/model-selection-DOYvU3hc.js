import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { a as resolveAgentEffectiveModelPrimary, c as resolveDefaultAgentId, g as toAgentModelListLike, h as resolveAgentModelPrimaryValue, r as resolveAgentConfig, s as resolveAgentWorkspaceDir } from "./agent-scope-ET3-KDD1.js";
import { c as expandHomePrefix, n as resolveConfigPath, o as resolveOAuthPath, r as resolveDefaultConfigCandidates, s as resolveStateDir, u as resolveRequiredHomeDir } from "./paths-MYHBPf85.js";
import { L as resolveConfigDir, M as isRecord$3, p as normalizeChatChannelId, q as isPlainObject$2, s as CHANNEL_IDS, t as createSubsystemLogger, z as resolveUserPath } from "./subsystem-CYLd4dcj.js";
import { h as isBlockedObjectKey, s as normalizeAgentId, t as DEFAULT_AGENT_ID } from "./session-key-CPPWn8gW.js";
import { C as canUseBoundaryFileOpen, T as openBoundaryFileSync, _ as runExec, j as isPathInside$2 } from "./workspace-PvhqUv3h.js";
import { a as saveJsonFile, i as loadJsonFile, r as resolveCopilotApiToken, t as DEFAULT_COPILOT_API_BASE_URL } from "./github-copilot-token-DyM1y5Pr.js";
import { n as formatCliCommand, t as isTruthyEnvValue } from "./env-DioSf1y0.js";
import { n as MANIFEST_KEY } from "./legacy-names-CuzMKZMW.js";
import { t as runTasksWithConcurrency } from "./run-with-concurrency-C0tgsauE.js";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import syncFs from "node:fs";
import JSON5 from "json5";
import { isDeepStrictEqual } from "node:util";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto, { createHash, randomBytes, randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, getEnvApiKey, getOAuthApiKey, getOAuthProviders } from "@mariozechner/pi-ai";
import dotenv from "dotenv";
import AjvPkg from "ajv";
import { z } from "zod";
import { BedrockClient, ListFoundationModelsCommand } from "@aws-sdk/client-bedrock";

//#region src/agents/defaults.ts
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-opus-4-6";
const DEFAULT_CONTEXT_TOKENS = 2e5;

//#endregion
//#region src/agents/model-ref-profile.ts
function splitTrailingAuthProfile(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return { model: "" };
	const profileDelimiter = trimmed.lastIndexOf("@");
	const lastSlash = trimmed.lastIndexOf("/");
	if (profileDelimiter <= 0 || profileDelimiter <= lastSlash) return { model: trimmed };
	const model = trimmed.slice(0, profileDelimiter).trim();
	const profile = trimmed.slice(profileDelimiter + 1).trim();
	if (!model || !profile) return { model: trimmed };
	return {
		model,
		profile
	};
}

//#endregion
//#region src/config/types.secrets.ts
const DEFAULT_SECRET_PROVIDER_ALIAS = "default";
const ENV_SECRET_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSecretRef(value) {
	if (!isRecord$2(value)) return false;
	if (Object.keys(value).length !== 3) return false;
	return (value.source === "env" || value.source === "file" || value.source === "exec") && typeof value.provider === "string" && value.provider.trim().length > 0 && typeof value.id === "string" && value.id.trim().length > 0;
}
function isLegacySecretRefWithoutProvider(value) {
	if (!isRecord$2(value)) return false;
	return (value.source === "env" || value.source === "file" || value.source === "exec") && typeof value.id === "string" && value.id.trim().length > 0 && value.provider === void 0;
}
function parseEnvTemplateSecretRef(value, provider = DEFAULT_SECRET_PROVIDER_ALIAS) {
	if (typeof value !== "string") return null;
	const match = ENV_SECRET_TEMPLATE_RE.exec(value.trim());
	if (!match) return null;
	return {
		source: "env",
		provider: provider.trim() || DEFAULT_SECRET_PROVIDER_ALIAS,
		id: match[1]
	};
}
function coerceSecretRef(value, defaults) {
	if (isSecretRef(value)) return value;
	if (isLegacySecretRefWithoutProvider(value)) {
		const provider = value.source === "env" ? defaults?.env ?? DEFAULT_SECRET_PROVIDER_ALIAS : value.source === "file" ? defaults?.file ?? DEFAULT_SECRET_PROVIDER_ALIAS : defaults?.exec ?? DEFAULT_SECRET_PROVIDER_ALIAS;
		return {
			source: value.source,
			provider,
			id: value.id
		};
	}
	const envTemplate = parseEnvTemplateSecretRef(value, defaults?.env);
	if (envTemplate) return envTemplate;
	return null;
}

//#endregion
//#region src/providers/kilocode-shared.ts
const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";
const KILOCODE_DEFAULT_MODEL_ID = "anthropic/claude-opus-4.6";
const KILOCODE_DEFAULT_MODEL_REF = `kilocode/${KILOCODE_DEFAULT_MODEL_ID}`;
const KILOCODE_DEFAULT_MODEL_NAME = "Claude Opus 4.6";
const KILOCODE_MODEL_CATALOG = [
	{
		id: KILOCODE_DEFAULT_MODEL_ID,
		name: KILOCODE_DEFAULT_MODEL_NAME,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1e6,
		maxTokens: 128e3
	},
	{
		id: "z-ai/glm-5:free",
		name: "GLM-5 (Free)",
		reasoning: true,
		input: ["text"],
		contextWindow: 202800,
		maxTokens: 131072
	},
	{
		id: "minimax/minimax-m2.5:free",
		name: "MiniMax M2.5 (Free)",
		reasoning: true,
		input: ["text"],
		contextWindow: 204800,
		maxTokens: 131072
	},
	{
		id: "anthropic/claude-sonnet-4.5",
		name: "Claude Sonnet 4.5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1e6,
		maxTokens: 64e3
	},
	{
		id: "openai/gpt-5.2",
		name: "GPT-5.2",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 4e5,
		maxTokens: 128e3
	},
	{
		id: "google/gemini-3-pro-preview",
		name: "Gemini 3 Pro Preview",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536
	},
	{
		id: "google/gemini-3-flash-preview",
		name: "Gemini 3 Flash Preview",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65535
	},
	{
		id: "x-ai/grok-code-fast-1",
		name: "Grok Code Fast 1",
		reasoning: true,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 1e4
	},
	{
		id: "moonshotai/kimi-k2.5",
		name: "Kimi K2.5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 65535
	}
];
const KILOCODE_DEFAULT_CONTEXT_WINDOW = 1e6;
const KILOCODE_DEFAULT_MAX_TOKENS = 128e3;
const KILOCODE_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};

//#endregion
//#region src/utils/normalize-secret-input.ts
/**
* Secret normalization for copy/pasted credentials.
*
* Common footgun: line breaks (especially `\r`) embedded in API keys/tokens.
* We strip line breaks anywhere, then trim whitespace at the ends.
*
* Intentionally does NOT remove ordinary spaces inside the string to avoid
* silently altering "Bearer <token>" style values.
*/
function normalizeSecretInput(value) {
	if (typeof value !== "string") return "";
	return value.replace(/[\r\n\u2028\u2029]+/g, "").trim();
}
function normalizeOptionalSecretInput(value) {
	const normalized = normalizeSecretInput(value);
	return normalized ? normalized : void 0;
}

//#endregion
//#region src/agents/auth-profiles/constants.ts
const AUTH_STORE_VERSION = 1;
const AUTH_PROFILE_FILENAME = "auth-profiles.json";
const LEGACY_AUTH_FILENAME = "auth.json";
const QWEN_CLI_PROFILE_ID = "qwen-portal:qwen-cli";
const MINIMAX_CLI_PROFILE_ID = "minimax-portal:minimax-cli";
const AUTH_STORE_LOCK_OPTIONS = {
	retries: {
		retries: 10,
		factor: 2,
		minTimeout: 100,
		maxTimeout: 1e4,
		randomize: true
	},
	stale: 3e4
};
const EXTERNAL_CLI_SYNC_TTL_MS = 900 * 1e3;
const EXTERNAL_CLI_NEAR_EXPIRY_MS = 600 * 1e3;
const log$7 = createSubsystemLogger("agents/auth-profiles");

//#endregion
//#region src/agents/auth-profiles/display.ts
function resolveAuthProfileDisplayLabel(params) {
	const { cfg, store, profileId } = params;
	const profile = store.profiles[profileId];
	const email = cfg?.auth?.profiles?.[profileId]?.email?.trim() || (profile && "email" in profile ? profile.email?.trim() : void 0);
	if (email) return `${profileId} (${email})`;
	return profileId;
}

//#endregion
//#region src/shared/pid-alive.ts
/**
* Check if a process is a zombie on Linux by reading /proc/<pid>/status.
* Returns false on non-Linux platforms or if the proc file can't be read.
*/
function isZombieProcess(pid) {
	if (process.platform !== "linux") return false;
	try {
		return syncFs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^State:\s+(\S)/m)?.[1] === "Z";
	} catch {
		return false;
	}
}
function isPidAlive(pid) {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	if (isZombieProcess(pid)) return false;
	return true;
}

//#endregion
//#region src/shared/process-scoped-map.ts
function resolveProcessScopedMap(key) {
	const proc = process;
	const existing = proc[key];
	if (existing) return existing;
	const created = /* @__PURE__ */ new Map();
	proc[key] = created;
	return created;
}

//#endregion
//#region src/plugin-sdk/file-lock.ts
const HELD_LOCKS = resolveProcessScopedMap(Symbol.for("openclaw.fileLockHeldLocks"));
function computeDelayMs(retries, attempt) {
	const base = Math.min(retries.maxTimeout, Math.max(retries.minTimeout, retries.minTimeout * retries.factor ** attempt));
	const jitter = retries.randomize ? 1 + Math.random() : 1;
	return Math.min(retries.maxTimeout, Math.round(base * jitter));
}
async function readLockPayload(lockPath) {
	try {
		const raw = await fs.readFile(lockPath, "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "string") return null;
		return {
			pid: parsed.pid,
			createdAt: parsed.createdAt
		};
	} catch {
		return null;
	}
}
async function resolveNormalizedFilePath(filePath) {
	const resolved = path.resolve(filePath);
	const dir = path.dirname(resolved);
	await fs.mkdir(dir, { recursive: true });
	try {
		const realDir = await fs.realpath(dir);
		return path.join(realDir, path.basename(resolved));
	} catch {
		return resolved;
	}
}
async function isStaleLock(lockPath, staleMs) {
	const payload = await readLockPayload(lockPath);
	if (payload?.pid && !isPidAlive(payload.pid)) return true;
	if (payload?.createdAt) {
		const createdAt = Date.parse(payload.createdAt);
		if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleMs) return true;
	}
	try {
		const stat = await fs.stat(lockPath);
		return Date.now() - stat.mtimeMs > staleMs;
	} catch {
		return true;
	}
}
async function releaseHeldLock(normalizedFile) {
	const current = HELD_LOCKS.get(normalizedFile);
	if (!current) return;
	current.count -= 1;
	if (current.count > 0) return;
	HELD_LOCKS.delete(normalizedFile);
	await current.handle.close().catch(() => void 0);
	await fs.rm(current.lockPath, { force: true }).catch(() => void 0);
}
async function acquireFileLock(filePath, options) {
	const normalizedFile = await resolveNormalizedFilePath(filePath);
	const lockPath = `${normalizedFile}.lock`;
	const held = HELD_LOCKS.get(normalizedFile);
	if (held) {
		held.count += 1;
		return {
			lockPath,
			release: () => releaseHeldLock(normalizedFile)
		};
	}
	const attempts = Math.max(1, options.retries.retries + 1);
	for (let attempt = 0; attempt < attempts; attempt += 1) try {
		const handle = await fs.open(lockPath, "wx");
		await handle.writeFile(JSON.stringify({
			pid: process.pid,
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		}, null, 2), "utf8");
		HELD_LOCKS.set(normalizedFile, {
			count: 1,
			handle,
			lockPath
		});
		return {
			lockPath,
			release: () => releaseHeldLock(normalizedFile)
		};
	} catch (err) {
		if (err.code !== "EEXIST") throw err;
		if (await isStaleLock(lockPath, options.stale)) {
			await fs.rm(lockPath, { force: true }).catch(() => void 0);
			continue;
		}
		if (attempt >= attempts - 1) break;
		await new Promise((resolve) => setTimeout(resolve, computeDelayMs(options.retries, attempt)));
	}
	throw new Error(`file lock timeout for ${normalizedFile}`);
}
async function withFileLock(filePath, options, fn) {
	const lock = await acquireFileLock(filePath, options);
	try {
		return await fn();
	} finally {
		await lock.release();
	}
}

//#endregion
//#region src/agents/cli-credentials.ts
const log$6 = createSubsystemLogger("agents/auth-profiles");
const QWEN_CLI_CREDENTIALS_RELATIVE_PATH = ".qwen/oauth_creds.json";
const MINIMAX_CLI_CREDENTIALS_RELATIVE_PATH = ".minimax/oauth_creds.json";
let qwenCliCache = null;
let minimaxCliCache = null;
function resolveQwenCliCredentialsPath(homeDir) {
	const baseDir = homeDir ?? resolveUserPath("~");
	return path.join(baseDir, QWEN_CLI_CREDENTIALS_RELATIVE_PATH);
}
function resolveMiniMaxCliCredentialsPath(homeDir) {
	const baseDir = homeDir ?? resolveUserPath("~");
	return path.join(baseDir, MINIMAX_CLI_CREDENTIALS_RELATIVE_PATH);
}
function readQwenCliCredentials(options) {
	return readPortalCliOauthCredentials(resolveQwenCliCredentialsPath(options?.homeDir), "qwen-portal");
}
function readPortalCliOauthCredentials(credPath, provider) {
	const raw = loadJsonFile(credPath);
	if (!raw || typeof raw !== "object") return null;
	const data = raw;
	const accessToken = data.access_token;
	const refreshToken = data.refresh_token;
	const expiresAt = data.expiry_date;
	if (typeof accessToken !== "string" || !accessToken) return null;
	if (typeof refreshToken !== "string" || !refreshToken) return null;
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
	return {
		type: "oauth",
		provider,
		access: accessToken,
		refresh: refreshToken,
		expires: expiresAt
	};
}
function readMiniMaxCliCredentials(options) {
	return readPortalCliOauthCredentials(resolveMiniMaxCliCredentialsPath(options?.homeDir), "minimax-portal");
}
function readQwenCliCredentialsCached(options) {
	const ttlMs = options?.ttlMs ?? 0;
	const now = Date.now();
	const cacheKey = resolveQwenCliCredentialsPath(options?.homeDir);
	if (ttlMs > 0 && qwenCliCache && qwenCliCache.cacheKey === cacheKey && now - qwenCliCache.readAt < ttlMs) return qwenCliCache.value;
	const value = readQwenCliCredentials({ homeDir: options?.homeDir });
	if (ttlMs > 0) qwenCliCache = {
		value,
		readAt: now,
		cacheKey
	};
	return value;
}
function readMiniMaxCliCredentialsCached(options) {
	const ttlMs = options?.ttlMs ?? 0;
	const now = Date.now();
	const cacheKey = resolveMiniMaxCliCredentialsPath(options?.homeDir);
	if (ttlMs > 0 && minimaxCliCache && minimaxCliCache.cacheKey === cacheKey && now - minimaxCliCache.readAt < ttlMs) return minimaxCliCache.value;
	const value = readMiniMaxCliCredentials({ homeDir: options?.homeDir });
	if (ttlMs > 0) minimaxCliCache = {
		value,
		readAt: now,
		cacheKey
	};
	return value;
}

//#endregion
//#region src/agents/auth-profiles/external-cli-sync.ts
function shallowEqualOAuthCredentials(a, b) {
	if (!a) return false;
	if (a.type !== "oauth") return false;
	return a.provider === b.provider && a.access === b.access && a.refresh === b.refresh && a.expires === b.expires && a.email === b.email && a.enterpriseUrl === b.enterpriseUrl && a.projectId === b.projectId && a.accountId === b.accountId;
}
function isExternalProfileFresh(cred, now) {
	if (!cred) return false;
	if (cred.type !== "oauth" && cred.type !== "token") return false;
	if (cred.provider !== "qwen-portal" && cred.provider !== "minimax-portal") return false;
	if (typeof cred.expires !== "number") return true;
	return cred.expires > now + EXTERNAL_CLI_NEAR_EXPIRY_MS;
}
/** Sync external CLI credentials into the store for a given provider. */
function syncExternalCliCredentialsForProvider(store, profileId, provider, readCredentials, now) {
	const existing = store.profiles[profileId];
	const creds = !existing || existing.provider !== provider || !isExternalProfileFresh(existing, now) ? readCredentials() : null;
	if (!creds) return false;
	const existingOAuth = existing?.type === "oauth" ? existing : void 0;
	if ((!existingOAuth || existingOAuth.provider !== provider || existingOAuth.expires <= now || creds.expires > existingOAuth.expires) && !shallowEqualOAuthCredentials(existingOAuth, creds)) {
		store.profiles[profileId] = creds;
		log$7.info(`synced ${provider} credentials from external cli`, {
			profileId,
			expires: new Date(creds.expires).toISOString()
		});
		return true;
	}
	return false;
}
/**
* Sync OAuth credentials from external CLI tools (Qwen Code CLI, MiniMax CLI) into the store.
*
* Returns true if any credentials were updated.
*/
function syncExternalCliCredentials(store) {
	let mutated = false;
	const now = Date.now();
	const existingQwen = store.profiles[QWEN_CLI_PROFILE_ID];
	const qwenCreds = !existingQwen || existingQwen.provider !== "qwen-portal" || !isExternalProfileFresh(existingQwen, now) ? readQwenCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }) : null;
	if (qwenCreds) {
		const existing = store.profiles[QWEN_CLI_PROFILE_ID];
		const existingOAuth = existing?.type === "oauth" ? existing : void 0;
		if ((!existingOAuth || existingOAuth.provider !== "qwen-portal" || existingOAuth.expires <= now || qwenCreds.expires > existingOAuth.expires) && !shallowEqualOAuthCredentials(existingOAuth, qwenCreds)) {
			store.profiles[QWEN_CLI_PROFILE_ID] = qwenCreds;
			mutated = true;
			log$7.info("synced qwen credentials from qwen cli", {
				profileId: QWEN_CLI_PROFILE_ID,
				expires: new Date(qwenCreds.expires).toISOString()
			});
		}
	}
	if (syncExternalCliCredentialsForProvider(store, MINIMAX_CLI_PROFILE_ID, "minimax-portal", () => readMiniMaxCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }), now)) mutated = true;
	return mutated;
}

//#endregion
//#region src/agents/agent-paths.ts
function resolveOpenClawAgentDir() {
	const override = process.env.OPENCLAW_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
	if (override) return resolveUserPath(override);
	return resolveUserPath(path.join(resolveStateDir(), "agents", DEFAULT_AGENT_ID, "agent"));
}

//#endregion
//#region src/agents/auth-profiles/paths.ts
function resolveAuthStorePath(agentDir) {
	const resolved = resolveUserPath(agentDir ?? resolveOpenClawAgentDir());
	return path.join(resolved, AUTH_PROFILE_FILENAME);
}
function resolveLegacyAuthStorePath(agentDir) {
	const resolved = resolveUserPath(agentDir ?? resolveOpenClawAgentDir());
	return path.join(resolved, LEGACY_AUTH_FILENAME);
}
function resolveAuthStorePathForDisplay(agentDir) {
	const pathname = resolveAuthStorePath(agentDir);
	return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}
function ensureAuthStoreFile(pathname) {
	if (syncFs.existsSync(pathname)) return;
	saveJsonFile(pathname, {
		version: AUTH_STORE_VERSION,
		profiles: {}
	});
}

//#endregion
//#region src/agents/auth-profiles/store.ts
const AUTH_PROFILE_TYPES = new Set([
	"api_key",
	"oauth",
	"token"
]);
const runtimeAuthStoreSnapshots = /* @__PURE__ */ new Map();
function resolveRuntimeStoreKey(agentDir) {
	return resolveAuthStorePath(agentDir);
}
function cloneAuthProfileStore(store) {
	return structuredClone(store);
}
function resolveRuntimeAuthProfileStore(agentDir) {
	if (runtimeAuthStoreSnapshots.size === 0) return null;
	const mainKey = resolveRuntimeStoreKey(void 0);
	const requestedKey = resolveRuntimeStoreKey(agentDir);
	const mainStore = runtimeAuthStoreSnapshots.get(mainKey);
	const requestedStore = runtimeAuthStoreSnapshots.get(requestedKey);
	if (!agentDir || requestedKey === mainKey) {
		if (!mainStore) return null;
		return cloneAuthProfileStore(mainStore);
	}
	if (mainStore && requestedStore) return mergeAuthProfileStores(cloneAuthProfileStore(mainStore), cloneAuthProfileStore(requestedStore));
	if (requestedStore) return cloneAuthProfileStore(requestedStore);
	if (mainStore) return cloneAuthProfileStore(mainStore);
	return null;
}
async function updateAuthProfileStoreWithLock(params) {
	const authPath = resolveAuthStorePath(params.agentDir);
	ensureAuthStoreFile(authPath);
	try {
		return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
			const store = ensureAuthProfileStore(params.agentDir);
			if (params.updater(store)) saveAuthProfileStore(store, params.agentDir);
			return store;
		});
	} catch {
		return null;
	}
}
/**
* Normalise a raw auth-profiles.json credential entry.
*
* The official format uses `type` and (for api_key credentials) `key`.
* A common mistake — caused by the similarity with the `openclaw.json`
* `auth.profiles` section which uses `mode` — is to write `mode` instead of
* `type` and `apiKey` instead of `key`.  Accept both spellings so users don't
* silently lose their credentials.
*/
function normalizeRawCredentialEntry(raw) {
	const entry = { ...raw };
	if (!("type" in entry) && typeof entry["mode"] === "string") entry["type"] = entry["mode"];
	if (!("key" in entry) && typeof entry["apiKey"] === "string") entry["key"] = entry["apiKey"];
	return entry;
}
function parseCredentialEntry(raw, fallbackProvider) {
	if (!raw || typeof raw !== "object") return {
		ok: false,
		reason: "non_object"
	};
	const typed = normalizeRawCredentialEntry(raw);
	if (!AUTH_PROFILE_TYPES.has(typed.type)) return {
		ok: false,
		reason: "invalid_type"
	};
	const provider = typed.provider ?? fallbackProvider;
	if (typeof provider !== "string" || provider.trim().length === 0) return {
		ok: false,
		reason: "missing_provider"
	};
	return {
		ok: true,
		credential: {
			...typed,
			provider
		}
	};
}
function warnRejectedCredentialEntries(source, rejected) {
	if (rejected.length === 0) return;
	const reasons = rejected.reduce((acc, current) => {
		acc[current.reason] = (acc[current.reason] ?? 0) + 1;
		return acc;
	}, {});
	log$7.warn("ignored invalid auth profile entries during store load", {
		source,
		dropped: rejected.length,
		reasons,
		keys: rejected.slice(0, 10).map((entry) => entry.key)
	});
}
function coerceLegacyStore(raw) {
	if (!raw || typeof raw !== "object") return null;
	const record = raw;
	if ("profiles" in record) return null;
	const entries = {};
	const rejected = [];
	for (const [key, value] of Object.entries(record)) {
		const parsed = parseCredentialEntry(value, key);
		if (!parsed.ok) {
			rejected.push({
				key,
				reason: parsed.reason
			});
			continue;
		}
		entries[key] = parsed.credential;
	}
	warnRejectedCredentialEntries("auth.json", rejected);
	return Object.keys(entries).length > 0 ? entries : null;
}
function coerceAuthStore(raw) {
	if (!raw || typeof raw !== "object") return null;
	const record = raw;
	if (!record.profiles || typeof record.profiles !== "object") return null;
	const profiles = record.profiles;
	const normalized = {};
	const rejected = [];
	for (const [key, value] of Object.entries(profiles)) {
		const parsed = parseCredentialEntry(value);
		if (!parsed.ok) {
			rejected.push({
				key,
				reason: parsed.reason
			});
			continue;
		}
		normalized[key] = parsed.credential;
	}
	warnRejectedCredentialEntries("auth-profiles.json", rejected);
	const order = record.order && typeof record.order === "object" ? Object.entries(record.order).reduce((acc, [provider, value]) => {
		if (!Array.isArray(value)) return acc;
		const list = value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
		if (list.length === 0) return acc;
		acc[provider] = list;
		return acc;
	}, {}) : void 0;
	return {
		version: Number(record.version ?? AUTH_STORE_VERSION),
		profiles: normalized,
		order,
		lastGood: record.lastGood && typeof record.lastGood === "object" ? record.lastGood : void 0,
		usageStats: record.usageStats && typeof record.usageStats === "object" ? record.usageStats : void 0
	};
}
function mergeRecord(base, override) {
	if (!base && !override) return;
	if (!base) return { ...override };
	if (!override) return { ...base };
	return {
		...base,
		...override
	};
}
function mergeAuthProfileStores(base, override) {
	if (Object.keys(override.profiles).length === 0 && !override.order && !override.lastGood && !override.usageStats) return base;
	return {
		version: Math.max(base.version, override.version ?? base.version),
		profiles: {
			...base.profiles,
			...override.profiles
		},
		order: mergeRecord(base.order, override.order),
		lastGood: mergeRecord(base.lastGood, override.lastGood),
		usageStats: mergeRecord(base.usageStats, override.usageStats)
	};
}
function mergeOAuthFileIntoStore(store) {
	const oauthRaw = loadJsonFile(resolveOAuthPath());
	if (!oauthRaw || typeof oauthRaw !== "object") return false;
	const oauthEntries = oauthRaw;
	let mutated = false;
	for (const [provider, creds] of Object.entries(oauthEntries)) {
		if (!creds || typeof creds !== "object") continue;
		const profileId = `${provider}:default`;
		if (store.profiles[profileId]) continue;
		store.profiles[profileId] = {
			type: "oauth",
			provider,
			...creds
		};
		mutated = true;
	}
	return mutated;
}
function applyLegacyStore(store, legacy) {
	for (const [provider, cred] of Object.entries(legacy)) {
		const profileId = `${provider}:default`;
		if (cred.type === "api_key") {
			store.profiles[profileId] = {
				type: "api_key",
				provider: String(cred.provider ?? provider),
				key: cred.key,
				...cred.email ? { email: cred.email } : {}
			};
			continue;
		}
		if (cred.type === "token") {
			store.profiles[profileId] = {
				type: "token",
				provider: String(cred.provider ?? provider),
				token: cred.token,
				...typeof cred.expires === "number" ? { expires: cred.expires } : {},
				...cred.email ? { email: cred.email } : {}
			};
			continue;
		}
		store.profiles[profileId] = {
			type: "oauth",
			provider: String(cred.provider ?? provider),
			access: cred.access,
			refresh: cred.refresh,
			expires: cred.expires,
			...cred.enterpriseUrl ? { enterpriseUrl: cred.enterpriseUrl } : {},
			...cred.projectId ? { projectId: cred.projectId } : {},
			...cred.accountId ? { accountId: cred.accountId } : {},
			...cred.email ? { email: cred.email } : {}
		};
	}
}
function loadCoercedStore(authPath) {
	return coerceAuthStore(loadJsonFile(authPath));
}
function loadAuthProfileStoreForAgent(agentDir, options) {
	const readOnly = options?.readOnly === true;
	const authPath = resolveAuthStorePath(agentDir);
	const asStore = loadCoercedStore(authPath);
	if (asStore) {
		if (syncExternalCliCredentials(asStore) && !readOnly) saveJsonFile(authPath, asStore);
		return asStore;
	}
	if (agentDir && !readOnly) {
		const mainStore = coerceAuthStore(loadJsonFile(resolveAuthStorePath()));
		if (mainStore && Object.keys(mainStore.profiles).length > 0) {
			saveJsonFile(authPath, mainStore);
			log$7.info("inherited auth-profiles from main agent", { agentDir });
			return mainStore;
		}
	}
	const legacy = coerceLegacyStore(loadJsonFile(resolveLegacyAuthStorePath(agentDir)));
	const store = {
		version: AUTH_STORE_VERSION,
		profiles: {}
	};
	if (legacy) applyLegacyStore(store, legacy);
	const mergedOAuth = mergeOAuthFileIntoStore(store);
	const syncedCli = syncExternalCliCredentials(store);
	const forceReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY === "1";
	const shouldWrite = !readOnly && !forceReadOnly && (legacy !== null || mergedOAuth || syncedCli);
	if (shouldWrite) saveJsonFile(authPath, store);
	if (shouldWrite && legacy !== null) {
		const legacyPath = resolveLegacyAuthStorePath(agentDir);
		try {
			syncFs.unlinkSync(legacyPath);
		} catch (err) {
			if (err?.code !== "ENOENT") log$7.warn("failed to delete legacy auth.json after migration", {
				err,
				legacyPath
			});
		}
	}
	return store;
}
function ensureAuthProfileStore(agentDir, options) {
	const runtimeStore = resolveRuntimeAuthProfileStore(agentDir);
	if (runtimeStore) return runtimeStore;
	const store = loadAuthProfileStoreForAgent(agentDir, options);
	const authPath = resolveAuthStorePath(agentDir);
	const mainAuthPath = resolveAuthStorePath();
	if (!agentDir || authPath === mainAuthPath) return store;
	return mergeAuthProfileStores(loadAuthProfileStoreForAgent(void 0, options), store);
}
function saveAuthProfileStore(store, agentDir) {
	saveJsonFile(resolveAuthStorePath(agentDir), {
		version: AUTH_STORE_VERSION,
		profiles: Object.fromEntries(Object.entries(store.profiles).map(([profileId, credential]) => {
			if (credential.type === "api_key" && credential.keyRef && credential.key !== void 0) {
				const sanitized = { ...credential };
				delete sanitized.key;
				return [profileId, sanitized];
			}
			if (credential.type === "token" && credential.tokenRef && credential.token !== void 0) {
				const sanitized = { ...credential };
				delete sanitized.token;
				return [profileId, sanitized];
			}
			return [profileId, credential];
		})),
		order: store.order ?? void 0,
		lastGood: store.lastGood ?? void 0,
		usageStats: store.usageStats ?? void 0
	});
}

//#endregion
//#region src/agents/auth-profiles/profiles.ts
function dedupeProfileIds(profileIds) {
	return [...new Set(profileIds)];
}
function listProfilesForProvider(store, provider) {
	const providerKey = normalizeProviderId(provider);
	return Object.entries(store.profiles).filter(([, cred]) => normalizeProviderId(cred.provider) === providerKey).map(([id]) => id);
}
async function markAuthProfileGood(params) {
	const { store, provider, profileId, agentDir } = params;
	const updated = await updateAuthProfileStoreWithLock({
		agentDir,
		updater: (freshStore) => {
			const profile = freshStore.profiles[profileId];
			if (!profile || profile.provider !== provider) return false;
			freshStore.lastGood = {
				...freshStore.lastGood,
				[provider]: profileId
			};
			return true;
		}
	});
	if (updated) {
		store.lastGood = updated.lastGood;
		return;
	}
	const profile = store.profiles[profileId];
	if (!profile || profile.provider !== provider) return;
	store.lastGood = {
		...store.lastGood,
		[provider]: profileId
	};
	saveAuthProfileStore(store, agentDir);
}

//#endregion
//#region src/agents/auth-profiles/repair.ts
function getProfileSuffix(profileId) {
	const idx = profileId.indexOf(":");
	if (idx < 0) return "";
	return profileId.slice(idx + 1);
}
function isEmailLike(value) {
	const trimmed = value.trim();
	if (!trimmed) return false;
	return trimmed.includes("@") && trimmed.includes(".");
}
function suggestOAuthProfileIdForLegacyDefault(params) {
	const providerKey = normalizeProviderId(params.provider);
	if (getProfileSuffix(params.legacyProfileId) !== "default") return null;
	const legacyCfg = params.cfg?.auth?.profiles?.[params.legacyProfileId];
	if (legacyCfg && normalizeProviderId(legacyCfg.provider) === providerKey && legacyCfg.mode !== "oauth") return null;
	const oauthProfiles = listProfilesForProvider(params.store, providerKey).filter((id) => params.store.profiles[id]?.type === "oauth");
	if (oauthProfiles.length === 0) return null;
	const configuredEmail = legacyCfg?.email?.trim();
	if (configuredEmail) {
		const byEmail = oauthProfiles.find((id) => {
			const cred = params.store.profiles[id];
			if (!cred || cred.type !== "oauth") return false;
			return cred.email?.trim() === configuredEmail || id === `${providerKey}:${configuredEmail}`;
		});
		if (byEmail) return byEmail;
	}
	const lastGood = params.store.lastGood?.[providerKey] ?? params.store.lastGood?.[params.provider];
	if (lastGood && oauthProfiles.includes(lastGood)) return lastGood;
	const nonLegacy = oauthProfiles.filter((id) => id !== params.legacyProfileId);
	if (nonLegacy.length === 1) return nonLegacy[0] ?? null;
	const emailLike = nonLegacy.filter((id) => isEmailLike(getProfileSuffix(id)));
	if (emailLike.length === 1) return emailLike[0] ?? null;
	return null;
}

//#endregion
//#region src/agents/auth-profiles/doctor.ts
function formatAuthDoctorHint(params) {
	const providerKey = normalizeProviderId(params.provider);
	if (providerKey !== "anthropic") return "";
	const legacyProfileId = params.profileId ?? "anthropic:default";
	const suggested = suggestOAuthProfileIdForLegacyDefault({
		cfg: params.cfg,
		store: params.store,
		provider: providerKey,
		legacyProfileId
	});
	if (!suggested || suggested === legacyProfileId) return "";
	const storeOauthProfiles = listProfilesForProvider(params.store, providerKey).filter((id) => params.store.profiles[id]?.type === "oauth").join(", ");
	const cfgMode = params.cfg?.auth?.profiles?.[legacyProfileId]?.mode;
	const cfgProvider = params.cfg?.auth?.profiles?.[legacyProfileId]?.provider;
	return [
		"Doctor hint (for GitHub issue):",
		`- provider: ${providerKey}`,
		`- config: ${legacyProfileId}${cfgProvider || cfgMode ? ` (provider=${cfgProvider ?? "?"}, mode=${cfgMode ?? "?"})` : ""}`,
		`- auth store oauth profiles: ${storeOauthProfiles || "(none)"}`,
		`- suggested profile: ${suggested}`,
		`Fix: run "${formatCliCommand("openclaw doctor --yes")}"`
	].join("\n");
}

//#endregion
//#region src/agents/owner-display.ts
function trimToUndefined(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
/**
* Resolve owner display settings for prompt rendering.
* Keep auth secrets decoupled from owner hash secrets.
*/
function resolveOwnerDisplaySetting(config) {
	const ownerDisplay = config?.commands?.ownerDisplay;
	if (ownerDisplay !== "hash") return {
		ownerDisplay,
		ownerDisplaySecret: void 0
	};
	return {
		ownerDisplay: "hash",
		ownerDisplaySecret: trimToUndefined(config?.commands?.ownerDisplaySecret)
	};
}
/**
* Ensure hash mode has a dedicated secret.
* Returns updated config and generated secret when autofill was needed.
*/
function ensureOwnerDisplaySecret(config, generateSecret = () => crypto.randomBytes(32).toString("hex")) {
	const settings = resolveOwnerDisplaySetting(config);
	if (settings.ownerDisplay !== "hash" || settings.ownerDisplaySecret) return { config };
	const generatedSecret = generateSecret();
	return {
		config: {
			...config,
			commands: {
				...config.commands,
				ownerDisplay: "hash",
				ownerDisplaySecret: generatedSecret
			}
		},
		generatedSecret
	};
}

//#endregion
//#region src/infra/dotenv.ts
function loadDotEnv(opts) {
	const quiet = opts?.quiet ?? true;
	dotenv.config({ quiet });
	const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
	if (!syncFs.existsSync(globalEnvPath)) return;
	dotenv.config({
		quiet,
		path: globalEnvPath,
		override: false
	});
}

//#endregion
//#region src/infra/host-env-security-policy.json
var host_env_security_policy_default = {
	blockedKeys: [
		"NODE_OPTIONS",
		"NODE_PATH",
		"PYTHONHOME",
		"PYTHONPATH",
		"PERL5LIB",
		"PERL5OPT",
		"RUBYLIB",
		"RUBYOPT",
		"BASH_ENV",
		"ENV",
		"GIT_EXTERNAL_DIFF",
		"SHELL",
		"SHELLOPTS",
		"PS4",
		"GCONV_PATH",
		"IFS",
		"SSLKEYLOGFILE"
	],
	blockedOverrideKeys: ["HOME", "ZDOTDIR"],
	blockedPrefixes: [
		"DYLD_",
		"LD_",
		"BASH_FUNC_"
	]
};

//#endregion
//#region src/infra/host-env-security.ts
const PORTABLE_ENV_VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST_ENV_SECURITY_POLICY = host_env_security_policy_default;
const HOST_DANGEROUS_ENV_KEY_VALUES = Object.freeze(HOST_ENV_SECURITY_POLICY.blockedKeys.map((key) => key.toUpperCase()));
const HOST_DANGEROUS_ENV_PREFIXES = Object.freeze(HOST_ENV_SECURITY_POLICY.blockedPrefixes.map((prefix) => prefix.toUpperCase()));
const HOST_DANGEROUS_OVERRIDE_ENV_KEY_VALUES = Object.freeze((HOST_ENV_SECURITY_POLICY.blockedOverrideKeys ?? []).map((key) => key.toUpperCase()));
const HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEY_VALUES = Object.freeze([
	"TERM",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR"
]);
const HOST_DANGEROUS_ENV_KEYS = new Set(HOST_DANGEROUS_ENV_KEY_VALUES);
const HOST_DANGEROUS_OVERRIDE_ENV_KEYS = new Set(HOST_DANGEROUS_OVERRIDE_ENV_KEY_VALUES);
const HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEYS = new Set(HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEY_VALUES);
function normalizeEnvVarKey(rawKey, options) {
	const key = rawKey.trim();
	if (!key) return null;
	if (options?.portable && !PORTABLE_ENV_VAR_KEY.test(key)) return null;
	return key;
}
function isDangerousHostEnvVarName(rawKey) {
	const key = normalizeEnvVarKey(rawKey);
	if (!key) return false;
	const upper = key.toUpperCase();
	if (HOST_DANGEROUS_ENV_KEYS.has(upper)) return true;
	return HOST_DANGEROUS_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}
function isDangerousHostEnvOverrideVarName(rawKey) {
	const key = normalizeEnvVarKey(rawKey);
	if (!key) return false;
	return HOST_DANGEROUS_OVERRIDE_ENV_KEYS.has(key.toUpperCase());
}
function sanitizeHostExecEnv(params) {
	const baseEnv = params?.baseEnv ?? process.env;
	const overrides = params?.overrides ?? void 0;
	const blockPathOverrides = params?.blockPathOverrides ?? true;
	const merged = {};
	for (const [rawKey, value] of Object.entries(baseEnv)) {
		if (typeof value !== "string") continue;
		const key = normalizeEnvVarKey(rawKey, { portable: true });
		if (!key || isDangerousHostEnvVarName(key)) continue;
		merged[key] = value;
	}
	if (!overrides) return merged;
	for (const [rawKey, value] of Object.entries(overrides)) {
		if (typeof value !== "string") continue;
		const key = normalizeEnvVarKey(rawKey, { portable: true });
		if (!key) continue;
		const upper = key.toUpperCase();
		if (blockPathOverrides && upper === "PATH") continue;
		if (isDangerousHostEnvVarName(upper) || isDangerousHostEnvOverrideVarName(upper)) continue;
		merged[key] = value;
	}
	return merged;
}

//#endregion
//#region src/infra/shell-env.ts
const DEFAULT_TIMEOUT_MS = 15e3;
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const DEFAULT_SHELL = "/bin/sh";
let lastAppliedKeys = [];
let cachedShellPath;
let cachedEtcShells;
function resolveShellExecEnv(env) {
	const execEnv = sanitizeHostExecEnv({ baseEnv: env });
	const home = os.homedir().trim();
	if (home) execEnv.HOME = home;
	else delete execEnv.HOME;
	delete execEnv.ZDOTDIR;
	return execEnv;
}
function resolveTimeoutMs(timeoutMs) {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
	return Math.max(0, timeoutMs);
}
function readEtcShells() {
	if (cachedEtcShells !== void 0) return cachedEtcShells;
	try {
		const entries = syncFs.readFileSync("/etc/shells", "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#") && path.isAbsolute(line));
		cachedEtcShells = new Set(entries);
	} catch {
		cachedEtcShells = null;
	}
	return cachedEtcShells;
}
function isTrustedShellPath(shell) {
	if (!path.isAbsolute(shell)) return false;
	if (path.normalize(shell) !== shell) return false;
	return readEtcShells()?.has(shell) === true;
}
function resolveShell(env) {
	const shell = env.SHELL?.trim();
	if (shell && isTrustedShellPath(shell)) return shell;
	return DEFAULT_SHELL;
}
function execLoginShellEnvZero(params) {
	return params.exec(params.shell, [
		"-l",
		"-c",
		"env -0"
	], {
		encoding: "buffer",
		timeout: params.timeoutMs,
		maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
		env: params.env,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
}
function parseShellEnv(stdout) {
	const shellEnv = /* @__PURE__ */ new Map();
	const parts = stdout.toString("utf8").split("\0");
	for (const part of parts) {
		if (!part) continue;
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		const key = part.slice(0, eq);
		const value = part.slice(eq + 1);
		if (!key) continue;
		shellEnv.set(key, value);
	}
	return shellEnv;
}
function probeLoginShellEnv(params) {
	const exec = params.exec ?? execFileSync;
	const timeoutMs = resolveTimeoutMs(params.timeoutMs);
	const shell = resolveShell(params.env);
	const execEnv = resolveShellExecEnv(params.env);
	try {
		return {
			ok: true,
			shellEnv: parseShellEnv(execLoginShellEnvZero({
				shell,
				env: execEnv,
				exec,
				timeoutMs
			}))
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
function loadShellEnvFallback(opts) {
	const logger = opts.logger ?? console;
	if (!opts.enabled) {
		lastAppliedKeys = [];
		return {
			ok: true,
			applied: [],
			skippedReason: "disabled"
		};
	}
	if (opts.expectedKeys.some((key) => Boolean(opts.env[key]?.trim()))) {
		lastAppliedKeys = [];
		return {
			ok: true,
			applied: [],
			skippedReason: "already-has-keys"
		};
	}
	const probe = probeLoginShellEnv({
		env: opts.env,
		timeoutMs: opts.timeoutMs,
		exec: opts.exec
	});
	if (!probe.ok) {
		logger.warn(`[openclaw] shell env fallback failed: ${probe.error}`);
		lastAppliedKeys = [];
		return {
			ok: false,
			error: probe.error,
			applied: []
		};
	}
	const applied = [];
	for (const key of opts.expectedKeys) {
		if (opts.env[key]?.trim()) continue;
		const value = probe.shellEnv.get(key);
		if (!value?.trim()) continue;
		opts.env[key] = value;
		applied.push(key);
	}
	lastAppliedKeys = applied;
	return {
		ok: true,
		applied
	};
}
function shouldEnableShellEnvFallback(env) {
	return isTruthyEnvValue(env.OPENCLAW_LOAD_SHELL_ENV);
}
function shouldDeferShellEnvFallback(env) {
	return isTruthyEnvValue(env.OPENCLAW_DEFER_SHELL_ENV_FALLBACK);
}
function resolveShellEnvFallbackTimeoutMs(env) {
	const raw = env.OPENCLAW_SHELL_ENV_TIMEOUT_MS?.trim();
	if (!raw) return DEFAULT_TIMEOUT_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
	return Math.max(0, parsed);
}
function getShellPathFromLoginShell(opts) {
	if (cachedShellPath !== void 0) return cachedShellPath;
	if ((opts.platform ?? process.platform) === "win32") {
		cachedShellPath = null;
		return cachedShellPath;
	}
	const probe = probeLoginShellEnv({
		env: opts.env,
		timeoutMs: opts.timeoutMs,
		exec: opts.exec
	});
	if (!probe.ok) {
		cachedShellPath = null;
		return cachedShellPath;
	}
	const shellPath = probe.shellEnv.get("PATH")?.trim();
	cachedShellPath = shellPath && shellPath.length > 0 ? shellPath : null;
	return cachedShellPath;
}
function getShellEnvAppliedKeys() {
	return [...lastAppliedKeys];
}

//#endregion
//#region src/version.ts
const CORE_PACKAGE_NAME = "openclaw";
const PACKAGE_JSON_CANDIDATES = [
	"../package.json",
	"../../package.json",
	"../../../package.json",
	"./package.json"
];
const BUILD_INFO_CANDIDATES = [
	"../build-info.json",
	"../../build-info.json",
	"./build-info.json"
];
function readVersionFromJsonCandidates(moduleUrl, candidates, opts = {}) {
	try {
		const require = createRequire(moduleUrl);
		for (const candidate of candidates) try {
			const parsed = require(candidate);
			const version = parsed.version?.trim();
			if (!version) continue;
			if (opts.requirePackageName && parsed.name !== CORE_PACKAGE_NAME) continue;
			return version;
		} catch {}
		return null;
	} catch {
		return null;
	}
}
function readVersionFromPackageJsonForModuleUrl(moduleUrl) {
	return readVersionFromJsonCandidates(moduleUrl, PACKAGE_JSON_CANDIDATES, { requirePackageName: true });
}
function readVersionFromBuildInfoForModuleUrl(moduleUrl) {
	return readVersionFromJsonCandidates(moduleUrl, BUILD_INFO_CANDIDATES);
}
function resolveVersionFromModuleUrl(moduleUrl) {
	return readVersionFromPackageJsonForModuleUrl(moduleUrl) || readVersionFromBuildInfoForModuleUrl(moduleUrl);
}
const VERSION = typeof __OPENCLAW_VERSION__ === "string" && __OPENCLAW_VERSION__ || process.env.OPENCLAW_BUNDLED_VERSION || resolveVersionFromModuleUrl(import.meta.url) || "0.0.0";

//#endregion
//#region src/config/agent-dirs.ts
var DuplicateAgentDirError = class extends Error {
	constructor(duplicates) {
		super(formatDuplicateAgentDirError(duplicates));
		this.name = "DuplicateAgentDirError";
		this.duplicates = duplicates;
	}
};
function canonicalizeAgentDir(agentDir) {
	const resolved = path.resolve(agentDir);
	if (process.platform === "darwin" || process.platform === "win32") return resolved.toLowerCase();
	return resolved;
}
function collectReferencedAgentIds(cfg) {
	const ids = /* @__PURE__ */ new Set();
	const agents = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
	const defaultAgentId = agents.find((agent) => agent?.default)?.id ?? agents[0]?.id ?? DEFAULT_AGENT_ID;
	ids.add(normalizeAgentId(defaultAgentId));
	for (const entry of agents) if (entry?.id) ids.add(normalizeAgentId(entry.id));
	const bindings = cfg.bindings;
	if (Array.isArray(bindings)) for (const binding of bindings) {
		const id = binding?.agentId;
		if (typeof id === "string" && id.trim()) ids.add(normalizeAgentId(id));
	}
	return [...ids];
}
function resolveEffectiveAgentDir(cfg, agentId, deps) {
	const id = normalizeAgentId(agentId);
	const trimmed = (Array.isArray(cfg.agents?.list) ? cfg.agents?.list.find((agent) => normalizeAgentId(agent.id) === id)?.agentDir : void 0)?.trim();
	if (trimmed) return resolveUserPath(trimmed);
	const env = deps?.env ?? process.env;
	const root = resolveStateDir(env, deps?.homedir ?? (() => resolveRequiredHomeDir(env, os.homedir)));
	return path.join(root, "agents", id, "agent");
}
function findDuplicateAgentDirs(cfg, deps) {
	const byDir = /* @__PURE__ */ new Map();
	for (const agentId of collectReferencedAgentIds(cfg)) {
		const agentDir = resolveEffectiveAgentDir(cfg, agentId, deps);
		const key = canonicalizeAgentDir(agentDir);
		const entry = byDir.get(key);
		if (entry) entry.agentIds.push(agentId);
		else byDir.set(key, {
			agentDir,
			agentIds: [agentId]
		});
	}
	return [...byDir.values()].filter((v) => v.agentIds.length > 1);
}
function formatDuplicateAgentDirError(dups) {
	return [
		"Duplicate agentDir detected (multi-agent config).",
		"Each agent must have a unique agentDir; sharing it causes auth/session state collisions and token invalidation.",
		"",
		"Conflicts:",
		...dups.map((d) => `- ${d.agentDir}: ${d.agentIds.map((id) => `"${id}"`).join(", ")}`),
		"",
		"Fix: remove the shared agents.list[].agentDir override (or give each agent its own directory).",
		"If you want to share credentials, copy auth-profiles.json instead of sharing the entire agentDir."
	].join("\n");
}

//#endregion
//#region src/config/backup-rotation.ts
const CONFIG_BACKUP_COUNT = 5;
async function rotateConfigBackups(configPath, ioFs) {
	if (CONFIG_BACKUP_COUNT <= 1) return;
	const backupBase = `${configPath}.bak`;
	const maxIndex = CONFIG_BACKUP_COUNT - 1;
	await ioFs.unlink(`${backupBase}.${maxIndex}`).catch(() => {});
	for (let index = maxIndex - 1; index >= 1; index -= 1) await ioFs.rename(`${backupBase}.${index}`, `${backupBase}.${index + 1}`).catch(() => {});
	await ioFs.rename(backupBase, `${backupBase}.1`).catch(() => {});
}

//#endregion
//#region src/config/agent-limits.ts
const DEFAULT_AGENT_MAX_CONCURRENT = 4;
const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1;
function resolveAgentMaxConcurrent(cfg) {
	const raw = cfg?.agents?.defaults?.maxConcurrent;
	if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(1, Math.floor(raw));
	return DEFAULT_AGENT_MAX_CONCURRENT;
}

//#endregion
//#region src/config/talk.ts
const DEFAULT_TALK_PROVIDER = "elevenlabs";
function isPlainObject$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeVoiceAliases(value) {
	if (!isPlainObject$1(value)) return;
	const aliases = {};
	for (const [alias, rawId] of Object.entries(value)) {
		if (typeof rawId !== "string") continue;
		aliases[alias] = rawId;
	}
	return Object.keys(aliases).length > 0 ? aliases : void 0;
}
function normalizeTalkProviderConfig(value) {
	if (!isPlainObject$1(value)) return;
	const provider = {};
	for (const [key, raw] of Object.entries(value)) {
		if (raw === void 0) continue;
		if (key === "voiceAliases") {
			const aliases = normalizeVoiceAliases(raw);
			if (aliases) provider.voiceAliases = aliases;
			continue;
		}
		if (key === "voiceId" || key === "modelId" || key === "outputFormat" || key === "apiKey") {
			const normalized = normalizeString(raw);
			if (normalized) provider[key] = normalized;
			continue;
		}
		provider[key] = raw;
	}
	return Object.keys(provider).length > 0 ? provider : void 0;
}
function normalizeTalkProviders(value) {
	if (!isPlainObject$1(value)) return;
	const providers = {};
	for (const [rawProviderId, providerConfig] of Object.entries(value)) {
		const providerId = normalizeString(rawProviderId);
		if (!providerId) continue;
		const normalizedProvider = normalizeTalkProviderConfig(providerConfig);
		if (!normalizedProvider) continue;
		providers[providerId] = normalizedProvider;
	}
	return Object.keys(providers).length > 0 ? providers : void 0;
}
function normalizedLegacyTalkFields(source) {
	const legacy = {};
	const voiceId = normalizeString(source.voiceId);
	if (voiceId) legacy.voiceId = voiceId;
	const voiceAliases = normalizeVoiceAliases(source.voiceAliases);
	if (voiceAliases) legacy.voiceAliases = voiceAliases;
	const modelId = normalizeString(source.modelId);
	if (modelId) legacy.modelId = modelId;
	const outputFormat = normalizeString(source.outputFormat);
	if (outputFormat) legacy.outputFormat = outputFormat;
	const apiKey = normalizeString(source.apiKey);
	if (apiKey) legacy.apiKey = apiKey;
	return legacy;
}
function legacyProviderConfigFromTalk(source) {
	return normalizeTalkProviderConfig({
		voiceId: source.voiceId,
		voiceAliases: source.voiceAliases,
		modelId: source.modelId,
		outputFormat: source.outputFormat,
		apiKey: source.apiKey
	});
}
function activeProviderFromTalk(talk) {
	const provider = normalizeString(talk.provider);
	if (provider) return provider;
	const providerIds = talk.providers ? Object.keys(talk.providers) : [];
	return providerIds.length === 1 ? providerIds[0] : void 0;
}
function normalizeTalkSection(value) {
	if (!isPlainObject$1(value)) return;
	const source = value;
	const hasNormalizedShape = typeof source.provider === "string" || isPlainObject$1(source.providers);
	const normalized = {};
	const legacy = normalizedLegacyTalkFields(source);
	if (Object.keys(legacy).length > 0) Object.assign(normalized, legacy);
	if (typeof source.interruptOnSpeech === "boolean") normalized.interruptOnSpeech = source.interruptOnSpeech;
	if (hasNormalizedShape) {
		const providers = normalizeTalkProviders(source.providers);
		const provider = normalizeString(source.provider);
		if (providers) normalized.providers = providers;
		if (provider) normalized.provider = provider;
		else if (providers) {
			const ids = Object.keys(providers);
			if (ids.length === 1) normalized.provider = ids[0];
		}
		return Object.keys(normalized).length > 0 ? normalized : void 0;
	}
	const legacyProviderConfig = legacyProviderConfigFromTalk(source);
	if (legacyProviderConfig) {
		normalized.provider = DEFAULT_TALK_PROVIDER;
		normalized.providers = { [DEFAULT_TALK_PROVIDER]: legacyProviderConfig };
	}
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function normalizeTalkConfig(config) {
	if (!config.talk) return config;
	const normalizedTalk = normalizeTalkSection(config.talk);
	if (!normalizedTalk) return config;
	return {
		...config,
		talk: normalizedTalk
	};
}
function resolveActiveTalkProviderConfig(talk) {
	const normalizedTalk = normalizeTalkSection(talk);
	if (!normalizedTalk) return {};
	const provider = activeProviderFromTalk(normalizedTalk);
	if (!provider) return {};
	return {
		provider,
		config: normalizedTalk.providers?.[provider]
	};
}
function readTalkApiKeyFromProfile(deps = {}) {
	const fsImpl = deps.fs ?? syncFs;
	const osImpl = deps.os ?? os;
	const pathImpl = deps.path ?? path;
	const home = osImpl.homedir();
	const candidates = [
		".profile",
		".zprofile",
		".zshrc",
		".bashrc"
	].map((name) => pathImpl.join(home, name));
	for (const candidate of candidates) {
		if (!fsImpl.existsSync(candidate)) continue;
		try {
			const value = fsImpl.readFileSync(candidate, "utf-8").match(/(?:^|\n)\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*["']?([^\n"']+)["']?/)?.[1]?.trim();
			if (value) return value;
		} catch {}
	}
	return null;
}
function resolveTalkApiKey(env = process.env, deps = {}) {
	const envValue = (env.ELEVENLABS_API_KEY ?? "").trim();
	if (envValue) return envValue;
	return readTalkApiKeyFromProfile(deps);
}

//#endregion
//#region src/config/defaults.ts
let defaultWarnState = { warned: false };
const DEFAULT_MODEL_ALIASES = {
	opus: "anthropic/claude-opus-4-6",
	sonnet: "anthropic/claude-sonnet-4-6",
	gpt: "openai/gpt-5.2",
	"gpt-mini": "openai/gpt-5-mini",
	gemini: "google/gemini-3-pro-preview",
	"gemini-flash": "google/gemini-3-flash-preview"
};
const DEFAULT_MODEL_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const DEFAULT_MODEL_INPUT = ["text"];
const DEFAULT_MODEL_MAX_TOKENS = 8192;
function resolveDefaultProviderApi(providerId, providerApi) {
	if (providerApi) return providerApi;
	return normalizeProviderId(providerId) === "anthropic" ? "anthropic-messages" : void 0;
}
function isPositiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function resolveModelCost(raw) {
	return {
		input: typeof raw?.input === "number" ? raw.input : DEFAULT_MODEL_COST.input,
		output: typeof raw?.output === "number" ? raw.output : DEFAULT_MODEL_COST.output,
		cacheRead: typeof raw?.cacheRead === "number" ? raw.cacheRead : DEFAULT_MODEL_COST.cacheRead,
		cacheWrite: typeof raw?.cacheWrite === "number" ? raw.cacheWrite : DEFAULT_MODEL_COST.cacheWrite
	};
}
function resolveAnthropicDefaultAuthMode(cfg) {
	const profiles = cfg.auth?.profiles ?? {};
	const anthropicProfiles = Object.entries(profiles).filter(([, profile]) => profile?.provider === "anthropic");
	const order = cfg.auth?.order?.anthropic ?? [];
	for (const profileId of order) {
		const entry = profiles[profileId];
		if (!entry || entry.provider !== "anthropic") continue;
		if (entry.mode === "api_key") return "api_key";
		if (entry.mode === "oauth" || entry.mode === "token") return "oauth";
	}
	const hasApiKey = anthropicProfiles.some(([, profile]) => profile?.mode === "api_key");
	const hasOauth = anthropicProfiles.some(([, profile]) => profile?.mode === "oauth" || profile?.mode === "token");
	if (hasApiKey && !hasOauth) return "api_key";
	if (hasOauth && !hasApiKey) return "oauth";
	if (process.env.ANTHROPIC_OAUTH_TOKEN?.trim()) return "oauth";
	if (process.env.ANTHROPIC_API_KEY?.trim()) return "api_key";
	return null;
}
function resolvePrimaryModelRef(raw) {
	if (!raw || typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	return DEFAULT_MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}
function applyMessageDefaults(cfg) {
	const messages = cfg.messages;
	if (messages?.ackReactionScope !== void 0) return cfg;
	const nextMessages = messages ? { ...messages } : {};
	nextMessages.ackReactionScope = "group-mentions";
	return {
		...cfg,
		messages: nextMessages
	};
}
function applySessionDefaults(cfg, options = {}) {
	const session = cfg.session;
	if (!session || session.mainKey === void 0) return cfg;
	const trimmed = session.mainKey.trim();
	const warn = options.warn ?? console.warn;
	const warnState = options.warnState ?? defaultWarnState;
	const next = {
		...cfg,
		session: {
			...session,
			mainKey: "main"
		}
	};
	if (trimmed && trimmed !== "main" && !warnState.warned) {
		warnState.warned = true;
		warn("session.mainKey is ignored; main session is always \"main\".");
	}
	return next;
}
function applyTalkApiKey(config) {
	const normalized = normalizeTalkConfig(config);
	const resolved = resolveTalkApiKey();
	if (!resolved) return normalized;
	const talk = normalized.talk;
	const active = resolveActiveTalkProviderConfig(talk);
	if (active.provider && active.provider !== DEFAULT_TALK_PROVIDER) return normalized;
	const existingProviderApiKey = typeof active.config?.apiKey === "string" ? active.config.apiKey.trim() : "";
	const existingLegacyApiKey = typeof talk?.apiKey === "string" ? talk.apiKey.trim() : "";
	if (existingProviderApiKey || existingLegacyApiKey) return normalized;
	const providerId = active.provider ?? DEFAULT_TALK_PROVIDER;
	const providers = { ...talk?.providers };
	providers[providerId] = {
		...providers[providerId],
		apiKey: resolved
	};
	const nextTalk = {
		...talk,
		provider: talk?.provider ?? providerId,
		providers,
		apiKey: resolved
	};
	return {
		...normalized,
		talk: nextTalk
	};
}
function applyTalkConfigNormalization(config) {
	return normalizeTalkConfig(config);
}
function applyModelDefaults(cfg) {
	let mutated = false;
	let nextCfg = cfg;
	const providerConfig = nextCfg.models?.providers;
	if (providerConfig) {
		const nextProviders = { ...providerConfig };
		for (const [providerId, provider] of Object.entries(providerConfig)) {
			const models = provider.models;
			if (!Array.isArray(models) || models.length === 0) continue;
			const providerApi = resolveDefaultProviderApi(providerId, provider.api);
			let nextProvider = provider;
			if (providerApi && provider.api !== providerApi) {
				mutated = true;
				nextProvider = {
					...nextProvider,
					api: providerApi
				};
			}
			let providerMutated = false;
			const nextModels = models.map((model) => {
				const raw = model;
				let modelMutated = false;
				const reasoning = typeof raw.reasoning === "boolean" ? raw.reasoning : false;
				if (raw.reasoning !== reasoning) modelMutated = true;
				const input = raw.input ?? [...DEFAULT_MODEL_INPUT];
				if (raw.input === void 0) modelMutated = true;
				const cost = resolveModelCost(raw.cost);
				if (!raw.cost || raw.cost.input !== cost.input || raw.cost.output !== cost.output || raw.cost.cacheRead !== cost.cacheRead || raw.cost.cacheWrite !== cost.cacheWrite) modelMutated = true;
				const contextWindow = isPositiveNumber(raw.contextWindow) ? raw.contextWindow : DEFAULT_CONTEXT_TOKENS;
				if (raw.contextWindow !== contextWindow) modelMutated = true;
				const defaultMaxTokens = Math.min(DEFAULT_MODEL_MAX_TOKENS, contextWindow);
				const rawMaxTokens = isPositiveNumber(raw.maxTokens) ? raw.maxTokens : defaultMaxTokens;
				const maxTokens = Math.min(rawMaxTokens, contextWindow);
				if (raw.maxTokens !== maxTokens) modelMutated = true;
				const api = raw.api ?? providerApi;
				if (raw.api !== api) modelMutated = true;
				if (!modelMutated) return model;
				providerMutated = true;
				return {
					...raw,
					reasoning,
					input,
					cost,
					contextWindow,
					maxTokens,
					api
				};
			});
			if (!providerMutated) {
				if (nextProvider !== provider) nextProviders[providerId] = nextProvider;
				continue;
			}
			nextProviders[providerId] = {
				...nextProvider,
				models: nextModels
			};
			mutated = true;
		}
		if (mutated) nextCfg = {
			...nextCfg,
			models: {
				...nextCfg.models,
				providers: nextProviders
			}
		};
	}
	const existingAgent = nextCfg.agents?.defaults;
	if (!existingAgent) return mutated ? nextCfg : cfg;
	const existingModels = existingAgent.models ?? {};
	if (Object.keys(existingModels).length === 0) return mutated ? nextCfg : cfg;
	const nextModels = { ...existingModels };
	for (const [alias, target] of Object.entries(DEFAULT_MODEL_ALIASES)) {
		const entry = nextModels[target];
		if (!entry) continue;
		if (entry.alias !== void 0) continue;
		nextModels[target] = {
			...entry,
			alias
		};
		mutated = true;
	}
	if (!mutated) return cfg;
	return {
		...nextCfg,
		agents: {
			...nextCfg.agents,
			defaults: {
				...existingAgent,
				models: nextModels
			}
		}
	};
}
function applyAgentDefaults(cfg) {
	const agents = cfg.agents;
	const defaults = agents?.defaults;
	const hasMax = typeof defaults?.maxConcurrent === "number" && Number.isFinite(defaults.maxConcurrent);
	const hasSubMax = typeof defaults?.subagents?.maxConcurrent === "number" && Number.isFinite(defaults.subagents.maxConcurrent);
	if (hasMax && hasSubMax) return cfg;
	let mutated = false;
	const nextDefaults = defaults ? { ...defaults } : {};
	if (!hasMax) {
		nextDefaults.maxConcurrent = DEFAULT_AGENT_MAX_CONCURRENT;
		mutated = true;
	}
	const nextSubagents = defaults?.subagents ? { ...defaults.subagents } : {};
	if (!hasSubMax) {
		nextSubagents.maxConcurrent = DEFAULT_SUBAGENT_MAX_CONCURRENT;
		mutated = true;
	}
	if (!mutated) return cfg;
	return {
		...cfg,
		agents: {
			...agents,
			defaults: {
				...nextDefaults,
				subagents: nextSubagents
			}
		}
	};
}
function applyLoggingDefaults(cfg) {
	const logging = cfg.logging;
	if (!logging) return cfg;
	if (logging.redactSensitive) return cfg;
	return {
		...cfg,
		logging: {
			...logging,
			redactSensitive: "tools"
		}
	};
}
function applyContextPruningDefaults(cfg) {
	const defaults = cfg.agents?.defaults;
	if (!defaults) return cfg;
	const authMode = resolveAnthropicDefaultAuthMode(cfg);
	if (!authMode) return cfg;
	let mutated = false;
	const nextDefaults = { ...defaults };
	const contextPruning = defaults.contextPruning ?? {};
	const heartbeat = defaults.heartbeat ?? {};
	if (defaults.contextPruning?.mode === void 0) {
		nextDefaults.contextPruning = {
			...contextPruning,
			mode: "cache-ttl",
			ttl: defaults.contextPruning?.ttl ?? "1h"
		};
		mutated = true;
	}
	if (defaults.heartbeat?.every === void 0) {
		nextDefaults.heartbeat = {
			...heartbeat,
			every: authMode === "oauth" ? "1h" : "30m"
		};
		mutated = true;
	}
	if (authMode === "api_key") {
		const nextModels = defaults.models ? { ...defaults.models } : {};
		let modelsMutated = false;
		const isAnthropicCacheRetentionTarget = (parsed) => Boolean(parsed && (parsed.provider === "anthropic" || parsed.provider === "amazon-bedrock" && parsed.model.toLowerCase().includes("anthropic.claude")));
		for (const [key, entry] of Object.entries(nextModels)) {
			if (!isAnthropicCacheRetentionTarget(parseModelRef(key, "anthropic"))) continue;
			const current = entry ?? {};
			const params = current.params ?? {};
			if (typeof params.cacheRetention === "string") continue;
			nextModels[key] = {
				...current,
				params: {
					...params,
					cacheRetention: "short"
				}
			};
			modelsMutated = true;
		}
		const primary = resolvePrimaryModelRef(resolveAgentModelPrimaryValue(defaults.model) ?? void 0);
		if (primary) {
			const parsedPrimary = parseModelRef(primary, "anthropic");
			if (isAnthropicCacheRetentionTarget(parsedPrimary)) {
				const key = `${parsedPrimary.provider}/${parsedPrimary.model}`;
				const current = nextModels[key] ?? {};
				const params = current.params ?? {};
				if (typeof params.cacheRetention !== "string") {
					nextModels[key] = {
						...current,
						params: {
							...params,
							cacheRetention: "short"
						}
					};
					modelsMutated = true;
				}
			}
		}
		if (modelsMutated) {
			nextDefaults.models = nextModels;
			mutated = true;
		}
	}
	if (!mutated) return cfg;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: nextDefaults
		}
	};
}
function applyCompactionDefaults(cfg) {
	const defaults = cfg.agents?.defaults;
	if (!defaults) return cfg;
	const compaction = defaults?.compaction;
	if (compaction?.mode) return cfg;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...defaults,
				compaction: {
					...compaction,
					mode: "safeguard"
				}
			}
		}
	};
}

//#endregion
//#region src/config/env-preserve.ts
/**
* Preserves `${VAR}` environment variable references during config write-back.
*
* When config is read, `${VAR}` references are resolved to their values.
* When writing back, callers pass the resolved config. This module detects
* values that match what a `${VAR}` reference would resolve to and restores
* the original reference, so env var references survive config round-trips.
*
* A value is restored only if:
* 1. The pre-substitution value contained a `${VAR}` pattern
* 2. Resolving that pattern with current env vars produces the incoming value
*
* If a caller intentionally set a new value (different from what the env var
* resolves to), the new value is kept as-is.
*/
const ENV_VAR_PATTERN = /\$\{[A-Z_][A-Z0-9_]*\}/;
/**
* Check if a string contains any `${VAR}` env var references.
*/
function hasEnvVarRef(value) {
	return ENV_VAR_PATTERN.test(value);
}
/**
* Resolve `${VAR}` references in a single string using the given env.
* Returns null if any referenced var is missing (instead of throwing).
*
* Mirrors the substitution semantics of `substituteString` in env-substitution.ts:
* - `${VAR}` → env value (returns null if missing)
* - `$${VAR}` → literal `${VAR}` (escape sequence)
*/
function tryResolveString(template, env) {
	const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/;
	const chunks = [];
	for (let i = 0; i < template.length; i++) {
		if (template[i] === "$") {
			if (template[i + 1] === "$" && template[i + 2] === "{") {
				const start = i + 3;
				const end = template.indexOf("}", start);
				if (end !== -1) {
					const name = template.slice(start, end);
					if (ENV_VAR_NAME.test(name)) {
						chunks.push(`\${${name}}`);
						i = end;
						continue;
					}
				}
			}
			if (template[i + 1] === "{") {
				const start = i + 2;
				const end = template.indexOf("}", start);
				if (end !== -1) {
					const name = template.slice(start, end);
					if (ENV_VAR_NAME.test(name)) {
						const val = env[name];
						if (val === void 0 || val === "") return null;
						chunks.push(val);
						i = end;
						continue;
					}
				}
			}
		}
		chunks.push(template[i]);
	}
	return chunks.join("");
}
/**
* Deep-walk the incoming config and restore `${VAR}` references from the
* pre-substitution parsed config wherever the resolved value matches.
*
* @param incoming - The resolved config about to be written
* @param parsed - The pre-substitution parsed config (from the current file on disk)
* @param env - Environment variables for verification
* @returns A new config object with env var references restored where appropriate
*/
function restoreEnvVarRefs(incoming, parsed, env = process.env) {
	if (parsed === null || parsed === void 0) return incoming;
	if (typeof incoming === "string" && typeof parsed === "string") {
		if (hasEnvVarRef(parsed)) {
			if (tryResolveString(parsed, env) === incoming) return parsed;
		}
		return incoming;
	}
	if (Array.isArray(incoming) && Array.isArray(parsed)) return incoming.map((item, i) => i < parsed.length ? restoreEnvVarRefs(item, parsed[i], env) : item);
	if (isPlainObject$2(incoming) && isPlainObject$2(parsed)) {
		const result = {};
		for (const [key, value] of Object.entries(incoming)) if (key in parsed) result[key] = restoreEnvVarRefs(value, parsed[key], env);
		else result[key] = value;
		return result;
	}
	return incoming;
}

//#endregion
//#region src/config/env-substitution.ts
/**
* Environment variable substitution for config values.
*
* Supports `${VAR_NAME}` syntax in string values, substituted at config load time.
* - Only uppercase env vars are matched: `[A-Z_][A-Z0-9_]*`
* - Escape with `$${}` to output literal `${}`
* - Missing env vars throw `MissingEnvVarError` with context
*
* @example
* ```json5
* {
*   models: {
*     providers: {
*       "vercel-gateway": {
*         apiKey: "${VERCEL_GATEWAY_API_KEY}"
*       }
*     }
*   }
* }
* ```
*/
const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
var MissingEnvVarError = class extends Error {
	constructor(varName, configPath) {
		super(`Missing env var "${varName}" referenced at config path: ${configPath}`);
		this.varName = varName;
		this.configPath = configPath;
		this.name = "MissingEnvVarError";
	}
};
function parseEnvTokenAt(value, index) {
	if (value[index] !== "$") return null;
	const next = value[index + 1];
	const afterNext = value[index + 2];
	if (next === "$" && afterNext === "{") {
		const start = index + 3;
		const end = value.indexOf("}", start);
		if (end !== -1) {
			const name = value.slice(start, end);
			if (ENV_VAR_NAME_PATTERN.test(name)) return {
				kind: "escaped",
				name,
				end
			};
		}
	}
	if (next === "{") {
		const start = index + 2;
		const end = value.indexOf("}", start);
		if (end !== -1) {
			const name = value.slice(start, end);
			if (ENV_VAR_NAME_PATTERN.test(name)) return {
				kind: "substitution",
				name,
				end
			};
		}
	}
	return null;
}
function substituteString(value, env, configPath) {
	if (!value.includes("$")) return value;
	const chunks = [];
	for (let i = 0; i < value.length; i += 1) {
		const char = value[i];
		if (char !== "$") {
			chunks.push(char);
			continue;
		}
		const token = parseEnvTokenAt(value, i);
		if (token?.kind === "escaped") {
			chunks.push(`\${${token.name}}`);
			i = token.end;
			continue;
		}
		if (token?.kind === "substitution") {
			const envValue = env[token.name];
			if (envValue === void 0 || envValue === "") throw new MissingEnvVarError(token.name, configPath);
			chunks.push(envValue);
			i = token.end;
			continue;
		}
		chunks.push(char);
	}
	return chunks.join("");
}
function containsEnvVarReference(value) {
	if (!value.includes("$")) return false;
	for (let i = 0; i < value.length; i += 1) {
		if (value[i] !== "$") continue;
		const token = parseEnvTokenAt(value, i);
		if (token?.kind === "escaped") {
			i = token.end;
			continue;
		}
		if (token?.kind === "substitution") return true;
	}
	return false;
}
function substituteAny(value, env, path) {
	if (typeof value === "string") return substituteString(value, env, path);
	if (Array.isArray(value)) return value.map((item, index) => substituteAny(item, env, `${path}[${index}]`));
	if (isPlainObject$2(value)) {
		const result = {};
		for (const [key, val] of Object.entries(value)) result[key] = substituteAny(val, env, path ? `${path}.${key}` : key);
		return result;
	}
	return value;
}
/**
* Resolves `${VAR_NAME}` environment variable references in config values.
*
* @param obj - The parsed config object (after JSON5 parse and $include resolution)
* @param env - Environment variables to use for substitution (defaults to process.env)
* @returns The config object with env vars substituted
* @throws {MissingEnvVarError} If a referenced env var is not set or empty
*/
function resolveConfigEnvVars(obj, env = process.env) {
	return substituteAny(obj, env, "");
}

//#endregion
//#region src/config/env-vars.ts
function isBlockedConfigEnvVar(key) {
	return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key);
}
function collectConfigEnvVarsByTarget(cfg) {
	const envConfig = cfg?.env;
	if (!envConfig) return {};
	const entries = {};
	if (envConfig.vars) for (const [rawKey, value] of Object.entries(envConfig.vars)) {
		if (!value) continue;
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
function applyConfigEnvVars(cfg, env = process.env) {
	const entries = collectConfigRuntimeEnvVars(cfg);
	for (const [key, value] of Object.entries(entries)) {
		if (env[key]?.trim()) continue;
		env[key] = value;
	}
}

//#endregion
//#region src/security/scan-paths.ts
function isPathInside$1(basePath, candidatePath) {
	const base = path.resolve(basePath);
	const candidate = path.resolve(candidatePath);
	const rel = path.relative(base, candidate);
	return rel === "" || !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
}

//#endregion
//#region src/config/includes.ts
/**
* Config includes: $include directive for modular configs
*
* @example
* ```json5
* {
*   "$include": "./base.json5",           // single file
*   "$include": ["./a.json5", "./b.json5"] // merge multiple
* }
* ```
*/
const INCLUDE_KEY = "$include";
const MAX_INCLUDE_DEPTH = 10;
const MAX_INCLUDE_FILE_BYTES = 2 * 1024 * 1024;
var ConfigIncludeError = class extends Error {
	constructor(message, includePath, cause) {
		super(message);
		this.includePath = includePath;
		this.cause = cause;
		this.name = "ConfigIncludeError";
	}
};
var CircularIncludeError = class extends ConfigIncludeError {
	constructor(chain) {
		super(`Circular include detected: ${chain.join(" -> ")}`, chain[chain.length - 1]);
		this.chain = chain;
		this.name = "CircularIncludeError";
	}
};
/** Deep merge: arrays concatenate, objects merge recursively, primitives: source wins */
function deepMerge(target, source) {
	if (Array.isArray(target) && Array.isArray(source)) return [...target, ...source];
	if (isPlainObject$2(target) && isPlainObject$2(source)) {
		const result = { ...target };
		for (const key of Object.keys(source)) {
			if (isBlockedObjectKey(key)) continue;
			result[key] = key in result ? deepMerge(result[key], source[key]) : source[key];
		}
		return result;
	}
	return source;
}
var IncludeProcessor = class IncludeProcessor {
	constructor(basePath, resolver, rootDir) {
		this.basePath = basePath;
		this.resolver = resolver;
		this.visited = /* @__PURE__ */ new Set();
		this.depth = 0;
		this.visited.add(path.normalize(basePath));
		this.rootDir = path.normalize(rootDir ?? path.dirname(basePath));
		this.rootRealDir = path.normalize(safeRealpath(this.rootDir));
	}
	process(obj) {
		if (Array.isArray(obj)) return obj.map((item) => this.process(item));
		if (!isPlainObject$2(obj)) return obj;
		if (!(INCLUDE_KEY in obj)) return this.processObject(obj);
		return this.processInclude(obj);
	}
	processObject(obj) {
		const result = {};
		for (const [key, value] of Object.entries(obj)) result[key] = this.process(value);
		return result;
	}
	processInclude(obj) {
		const includeValue = obj[INCLUDE_KEY];
		const otherKeys = Object.keys(obj).filter((k) => k !== INCLUDE_KEY);
		const included = this.resolveInclude(includeValue);
		if (otherKeys.length === 0) return included;
		if (!isPlainObject$2(included)) throw new ConfigIncludeError("Sibling keys require included content to be an object", typeof includeValue === "string" ? includeValue : INCLUDE_KEY);
		const rest = {};
		for (const key of otherKeys) rest[key] = this.process(obj[key]);
		return deepMerge(included, rest);
	}
	resolveInclude(value) {
		if (typeof value === "string") return this.loadFile(value);
		if (Array.isArray(value)) return value.reduce((merged, item) => {
			if (typeof item !== "string") throw new ConfigIncludeError(`Invalid $include array item: expected string, got ${typeof item}`, String(item));
			return deepMerge(merged, this.loadFile(item));
		}, {});
		throw new ConfigIncludeError(`Invalid $include value: expected string or array of strings, got ${typeof value}`, String(value));
	}
	loadFile(includePath) {
		const resolvedPath = this.resolvePath(includePath);
		this.checkCircular(resolvedPath);
		this.checkDepth(includePath);
		const raw = this.readFile(includePath, resolvedPath);
		const parsed = this.parseFile(includePath, resolvedPath, raw);
		return this.processNested(resolvedPath, parsed);
	}
	resolvePath(includePath) {
		const configDir = path.dirname(this.basePath);
		const resolved = path.isAbsolute(includePath) ? includePath : path.resolve(configDir, includePath);
		const normalized = path.normalize(resolved);
		if (!isPathInside$1(this.rootDir, normalized)) throw new ConfigIncludeError(`Include path escapes config directory: ${includePath} (root: ${this.rootDir})`, includePath);
		try {
			const real = syncFs.realpathSync(normalized);
			if (!isPathInside$1(this.rootRealDir, real)) throw new ConfigIncludeError(`Include path resolves outside config directory (symlink): ${includePath} (root: ${this.rootDir})`, includePath);
		} catch (err) {
			if (err instanceof ConfigIncludeError) throw err;
		}
		return normalized;
	}
	checkCircular(resolvedPath) {
		if (this.visited.has(resolvedPath)) throw new CircularIncludeError([...this.visited, resolvedPath]);
	}
	checkDepth(includePath) {
		if (this.depth >= MAX_INCLUDE_DEPTH) throw new ConfigIncludeError(`Maximum include depth (${MAX_INCLUDE_DEPTH}) exceeded at: ${includePath}`, includePath);
	}
	readFile(includePath, resolvedPath) {
		try {
			if (this.resolver.readFileWithGuards) return this.resolver.readFileWithGuards({
				includePath,
				resolvedPath,
				rootRealDir: this.rootRealDir
			});
			return this.resolver.readFile(resolvedPath);
		} catch (err) {
			if (err instanceof ConfigIncludeError) throw err;
			throw new ConfigIncludeError(`Failed to read include file: ${includePath} (resolved: ${resolvedPath})`, includePath, err instanceof Error ? err : void 0);
		}
	}
	parseFile(includePath, resolvedPath, raw) {
		try {
			return this.resolver.parseJson(raw);
		} catch (err) {
			throw new ConfigIncludeError(`Failed to parse include file: ${includePath} (resolved: ${resolvedPath})`, includePath, err instanceof Error ? err : void 0);
		}
	}
	processNested(resolvedPath, parsed) {
		const nested = new IncludeProcessor(resolvedPath, this.resolver, this.rootDir);
		nested.visited = new Set([...this.visited, resolvedPath]);
		nested.depth = this.depth + 1;
		return nested.process(parsed);
	}
};
function safeRealpath(target) {
	try {
		return syncFs.realpathSync(target);
	} catch {
		return target;
	}
}
function readConfigIncludeFileWithGuards(params) {
	const ioFs = params.ioFs ?? syncFs;
	const maxBytes = params.maxBytes ?? MAX_INCLUDE_FILE_BYTES;
	if (!canUseBoundaryFileOpen(ioFs)) return ioFs.readFileSync(params.resolvedPath, "utf-8");
	const opened = openBoundaryFileSync({
		absolutePath: params.resolvedPath,
		rootPath: params.rootRealDir,
		rootRealPath: params.rootRealDir,
		boundaryLabel: "config directory",
		skipLexicalRootCheck: true,
		maxBytes,
		ioFs
	});
	if (!opened.ok) {
		if (opened.reason === "validation") throw new ConfigIncludeError(`Include file failed security checks (regular file, max ${maxBytes} bytes, no hardlinks): ${params.includePath}`, params.includePath);
		throw new ConfigIncludeError(`Failed to read include file: ${params.includePath} (resolved: ${params.resolvedPath})`, params.includePath, opened.error instanceof Error ? opened.error : void 0);
	}
	try {
		return ioFs.readFileSync(opened.fd, "utf-8");
	} finally {
		ioFs.closeSync(opened.fd);
	}
}
const defaultResolver = {
	readFile: (p) => syncFs.readFileSync(p, "utf-8"),
	readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) => readConfigIncludeFileWithGuards({
		includePath,
		resolvedPath,
		rootRealDir
	}),
	parseJson: (raw) => JSON5.parse(raw)
};
/**
* Resolves all $include directives in a parsed config object.
*/
function resolveConfigIncludes(obj, configPath, resolver = defaultResolver) {
	return new IncludeProcessor(configPath, resolver).process(obj);
}

//#endregion
//#region src/config/discord-preview-streaming.ts
function normalizeStreamingMode(value) {
	if (typeof value !== "string") return null;
	return value.trim().toLowerCase() || null;
}
function parseStreamingMode(value) {
	const normalized = normalizeStreamingMode(value);
	if (normalized === "off" || normalized === "partial" || normalized === "block" || normalized === "progress") return normalized;
	return null;
}
function parseDiscordPreviewStreamMode(value) {
	const parsed = parseStreamingMode(value);
	if (!parsed) return null;
	return parsed === "progress" ? "partial" : parsed;
}
function parseSlackLegacyDraftStreamMode(value) {
	const normalized = normalizeStreamingMode(value);
	if (normalized === "replace" || normalized === "status_final" || normalized === "append") return normalized;
	return null;
}
function mapSlackLegacyDraftStreamModeToStreaming(mode) {
	if (mode === "append") return "block";
	if (mode === "status_final") return "progress";
	return "partial";
}
function mapStreamingModeToSlackLegacyDraftStreamMode(mode) {
	if (mode === "block") return "append";
	if (mode === "progress") return "status_final";
	return "replace";
}
function resolveTelegramPreviewStreamMode(params = {}) {
	const parsedStreaming = parseStreamingMode(params.streaming);
	if (parsedStreaming) {
		if (parsedStreaming === "progress") return "partial";
		return parsedStreaming;
	}
	const legacy = parseDiscordPreviewStreamMode(params.streamMode);
	if (legacy) return legacy;
	if (typeof params.streaming === "boolean") return params.streaming ? "partial" : "off";
	return "off";
}
function resolveDiscordPreviewStreamMode(params = {}) {
	const parsedStreaming = parseDiscordPreviewStreamMode(params.streaming);
	if (parsedStreaming) return parsedStreaming;
	const legacy = parseDiscordPreviewStreamMode(params.streamMode);
	if (legacy) return legacy;
	if (typeof params.streaming === "boolean") return params.streaming ? "partial" : "off";
	return "off";
}
function resolveSlackStreamingMode(params = {}) {
	const parsedStreaming = parseStreamingMode(params.streaming);
	if (parsedStreaming) return parsedStreaming;
	const legacyStreamMode = parseSlackLegacyDraftStreamMode(params.streamMode);
	if (legacyStreamMode) return mapSlackLegacyDraftStreamModeToStreaming(legacyStreamMode);
	if (typeof params.streaming === "boolean") return "partial";
	return "partial";
}
function resolveSlackNativeStreaming(params = {}) {
	if (typeof params.nativeStreaming === "boolean") return params.nativeStreaming;
	if (typeof params.streaming === "boolean") return params.streaming;
	return true;
}

//#endregion
//#region src/infra/exec-safety.ts
const SHELL_METACHARS = /[;&|`$<>]/;
const CONTROL_CHARS = /[\r\n]/;
const QUOTE_CHARS = /["']/;
const BARE_NAME_PATTERN = /^[A-Za-z0-9._+-]+$/;
function isLikelyPath(value) {
	if (value.startsWith(".") || value.startsWith("~")) return true;
	if (value.includes("/") || value.includes("\\")) return true;
	return /^[A-Za-z]:[\\/]/.test(value);
}
function isSafeExecutableValue(value) {
	if (!value) return false;
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (trimmed.includes("\0")) return false;
	if (CONTROL_CHARS.test(trimmed)) return false;
	if (SHELL_METACHARS.test(trimmed)) return false;
	if (QUOTE_CHARS.test(trimmed)) return false;
	if (isLikelyPath(trimmed)) return true;
	if (trimmed.startsWith("-")) return false;
	return BARE_NAME_PATTERN.test(trimmed);
}

//#endregion
//#region src/config/legacy.shared.ts
const getRecord = (value) => isRecord$3(value) ? value : null;
const ensureRecord = (root, key) => {
	const existing = root[key];
	if (isRecord$3(existing)) return existing;
	const next = {};
	root[key] = next;
	return next;
};
const mergeMissing = (target, source) => {
	for (const [key, value] of Object.entries(source)) {
		if (value === void 0 || isBlockedObjectKey(key)) continue;
		const existing = target[key];
		if (existing === void 0) {
			target[key] = value;
			continue;
		}
		if (isRecord$3(existing) && isRecord$3(value)) mergeMissing(existing, value);
	}
};
const mapLegacyAudioTranscription = (value) => {
	const transcriber = getRecord(value);
	const command = Array.isArray(transcriber?.command) ? transcriber?.command : null;
	if (!command || command.length === 0) return null;
	if (typeof command[0] !== "string") return null;
	if (!command.every((part) => typeof part === "string")) return null;
	const rawExecutable = command[0].trim();
	if (!rawExecutable) return null;
	if (!isSafeExecutableValue(rawExecutable)) return null;
	const args = command.slice(1);
	const timeoutSeconds = typeof transcriber?.timeoutSeconds === "number" ? transcriber?.timeoutSeconds : void 0;
	const result = {
		command: rawExecutable,
		type: "cli"
	};
	if (args.length > 0) result.args = args;
	if (timeoutSeconds !== void 0) result.timeoutSeconds = timeoutSeconds;
	return result;
};
const getAgentsList = (agents) => {
	const list = agents?.list;
	return Array.isArray(list) ? list : [];
};
const resolveDefaultAgentIdFromRaw = (raw) => {
	const list = getAgentsList(getRecord(raw.agents));
	const defaultEntry = list.find((entry) => isRecord$3(entry) && entry.default === true && typeof entry.id === "string" && entry.id.trim() !== "");
	if (defaultEntry) return defaultEntry.id.trim();
	const routing = getRecord(raw.routing);
	const routingDefault = typeof routing?.defaultAgentId === "string" ? routing.defaultAgentId.trim() : "";
	if (routingDefault) return routingDefault;
	const firstEntry = list.find((entry) => isRecord$3(entry) && typeof entry.id === "string" && entry.id.trim() !== "");
	if (firstEntry) return firstEntry.id.trim();
	return "main";
};
const ensureAgentEntry = (list, id) => {
	const normalized = id.trim();
	const existing = list.find((entry) => isRecord$3(entry) && typeof entry.id === "string" && entry.id.trim() === normalized);
	if (existing) return existing;
	const created = { id: normalized };
	list.push(created);
	return created;
};

//#endregion
//#region src/config/legacy.migrations.part-1.ts
function migrateBindings(raw, changes, changeNote, mutator) {
	const bindings = Array.isArray(raw.bindings) ? raw.bindings : null;
	if (!bindings) return;
	let touched = false;
	for (const entry of bindings) {
		if (!isRecord$3(entry)) continue;
		const match = getRecord(entry.match);
		if (!match) continue;
		if (!mutator(match)) continue;
		entry.match = match;
		touched = true;
	}
	if (touched) {
		raw.bindings = bindings;
		changes.push(changeNote);
	}
}
function ensureDefaultGroupEntry(section) {
	const groups = isRecord$3(section.groups) ? section.groups : {};
	const defaultKey = "*";
	return {
		groups,
		entry: isRecord$3(groups[defaultKey]) ? groups[defaultKey] : {}
	};
}
function hasOwnKey(target, key) {
	return Object.prototype.hasOwnProperty.call(target, key);
}
function migrateThreadBindingsTtlHoursForPath(params) {
	const threadBindings = getRecord(params.owner.threadBindings);
	if (!threadBindings || !hasOwnKey(threadBindings, "ttlHours")) return false;
	const hadIdleHours = threadBindings.idleHours !== void 0;
	if (!hadIdleHours) threadBindings.idleHours = threadBindings.ttlHours;
	delete threadBindings.ttlHours;
	params.owner.threadBindings = threadBindings;
	if (hadIdleHours) params.changes.push(`Removed ${params.pathPrefix}.threadBindings.ttlHours (${params.pathPrefix}.threadBindings.idleHours already set).`);
	else params.changes.push(`Moved ${params.pathPrefix}.threadBindings.ttlHours → ${params.pathPrefix}.threadBindings.idleHours.`);
	return true;
}
const LEGACY_CONFIG_MIGRATIONS_PART_1 = [
	{
		id: "bindings.match.provider->bindings.match.channel",
		describe: "Move bindings[].match.provider to bindings[].match.channel",
		apply: (raw, changes) => {
			migrateBindings(raw, changes, "Moved bindings[].match.provider → bindings[].match.channel.", (match) => {
				if (typeof match.channel === "string" && match.channel.trim()) return false;
				const provider = typeof match.provider === "string" ? match.provider.trim() : "";
				if (!provider) return false;
				match.channel = provider;
				delete match.provider;
				return true;
			});
		}
	},
	{
		id: "bindings.match.accountID->bindings.match.accountId",
		describe: "Move bindings[].match.accountID to bindings[].match.accountId",
		apply: (raw, changes) => {
			migrateBindings(raw, changes, "Moved bindings[].match.accountID → bindings[].match.accountId.", (match) => {
				if (match.accountId !== void 0) return false;
				const accountID = typeof match.accountID === "string" ? match.accountID.trim() : match.accountID;
				if (!accountID) return false;
				match.accountId = accountID;
				delete match.accountID;
				return true;
			});
		}
	},
	{
		id: "session.sendPolicy.rules.match.provider->match.channel",
		describe: "Move session.sendPolicy.rules[].match.provider to match.channel",
		apply: (raw, changes) => {
			const session = getRecord(raw.session);
			if (!session) return;
			const sendPolicy = getRecord(session.sendPolicy);
			if (!sendPolicy) return;
			const rules = Array.isArray(sendPolicy.rules) ? sendPolicy.rules : null;
			if (!rules) return;
			let touched = false;
			for (const rule of rules) {
				if (!isRecord$3(rule)) continue;
				const match = getRecord(rule.match);
				if (!match) continue;
				if (typeof match.channel === "string" && match.channel.trim()) continue;
				const provider = typeof match.provider === "string" ? match.provider.trim() : "";
				if (!provider) continue;
				match.channel = provider;
				delete match.provider;
				rule.match = match;
				touched = true;
			}
			if (touched) {
				sendPolicy.rules = rules;
				session.sendPolicy = sendPolicy;
				raw.session = session;
				changes.push("Moved session.sendPolicy.rules[].match.provider → match.channel.");
			}
		}
	},
	{
		id: "messages.queue.byProvider->byChannel",
		describe: "Move messages.queue.byProvider to messages.queue.byChannel",
		apply: (raw, changes) => {
			const messages = getRecord(raw.messages);
			if (!messages) return;
			const queue = getRecord(messages.queue);
			if (!queue) return;
			if (queue.byProvider === void 0) return;
			if (queue.byChannel === void 0) {
				queue.byChannel = queue.byProvider;
				changes.push("Moved messages.queue.byProvider → messages.queue.byChannel.");
			} else changes.push("Removed messages.queue.byProvider (messages.queue.byChannel already set).");
			delete queue.byProvider;
			messages.queue = queue;
			raw.messages = messages;
		}
	},
	{
		id: "providers->channels",
		describe: "Move provider config sections to channels.*",
		apply: (raw, changes) => {
			const legacyEntries = [
				"whatsapp",
				"telegram",
				"discord",
				"slack",
				"signal",
				"imessage",
				"msteams"
			].filter((key) => isRecord$3(raw[key]));
			if (legacyEntries.length === 0) return;
			const channels = ensureRecord(raw, "channels");
			for (const key of legacyEntries) {
				const legacy = getRecord(raw[key]);
				if (!legacy) continue;
				const channelEntry = ensureRecord(channels, key);
				const hadEntries = Object.keys(channelEntry).length > 0;
				mergeMissing(channelEntry, legacy);
				channels[key] = channelEntry;
				delete raw[key];
				changes.push(hadEntries ? `Merged ${key} → channels.${key}.` : `Moved ${key} → channels.${key}.`);
			}
			raw.channels = channels;
		}
	},
	{
		id: "thread-bindings.ttlHours->idleHours",
		describe: "Move legacy threadBindings.ttlHours keys to threadBindings.idleHours (session + channels.discord)",
		apply: (raw, changes) => {
			const session = getRecord(raw.session);
			if (session) {
				migrateThreadBindingsTtlHoursForPath({
					owner: session,
					pathPrefix: "session",
					changes
				});
				raw.session = session;
			}
			const channels = getRecord(raw.channels);
			const discord = getRecord(channels?.discord);
			if (!channels || !discord) return;
			migrateThreadBindingsTtlHoursForPath({
				owner: discord,
				pathPrefix: "channels.discord",
				changes
			});
			const accounts = getRecord(discord.accounts);
			if (accounts) {
				for (const [accountId, accountRaw] of Object.entries(accounts)) {
					const account = getRecord(accountRaw);
					if (!account) continue;
					migrateThreadBindingsTtlHoursForPath({
						owner: account,
						pathPrefix: `channels.discord.accounts.${accountId}`,
						changes
					});
					accounts[accountId] = account;
				}
				discord.accounts = accounts;
			}
			channels.discord = discord;
			raw.channels = channels;
		}
	},
	{
		id: "channels.streaming-keys->channels.streaming",
		describe: "Normalize legacy streaming keys to channels.<provider>.streaming (Telegram/Discord/Slack)",
		apply: (raw, changes) => {
			const channels = getRecord(raw.channels);
			if (!channels) return;
			const migrateProviderEntry = (params) => {
				const migrateCommonStreamingMode = (resolveMode) => {
					const hasLegacyStreamMode = params.entry.streamMode !== void 0;
					const legacyStreaming = params.entry.streaming;
					if (!hasLegacyStreamMode && typeof legacyStreaming !== "boolean") return false;
					const resolved = resolveMode(params.entry);
					params.entry.streaming = resolved;
					if (hasLegacyStreamMode) {
						delete params.entry.streamMode;
						changes.push(`Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming (${resolved}).`);
					}
					if (typeof legacyStreaming === "boolean") changes.push(`Normalized ${params.pathPrefix}.streaming boolean → enum (${resolved}).`);
					return true;
				};
				const hasLegacyStreamMode = params.entry.streamMode !== void 0;
				const legacyStreaming = params.entry.streaming;
				const legacyNativeStreaming = params.entry.nativeStreaming;
				if (params.provider === "telegram") {
					migrateCommonStreamingMode(resolveTelegramPreviewStreamMode);
					return;
				}
				if (params.provider === "discord") {
					migrateCommonStreamingMode(resolveDiscordPreviewStreamMode);
					return;
				}
				if (!hasLegacyStreamMode && typeof legacyStreaming !== "boolean") return;
				const resolvedStreaming = resolveSlackStreamingMode(params.entry);
				const resolvedNativeStreaming = resolveSlackNativeStreaming(params.entry);
				params.entry.streaming = resolvedStreaming;
				params.entry.nativeStreaming = resolvedNativeStreaming;
				if (hasLegacyStreamMode) {
					delete params.entry.streamMode;
					changes.push(`Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming (${resolvedStreaming}).`);
				}
				if (typeof legacyStreaming === "boolean") changes.push(`Moved ${params.pathPrefix}.streaming (boolean) → ${params.pathPrefix}.nativeStreaming (${resolvedNativeStreaming}).`);
				else if (typeof legacyNativeStreaming !== "boolean" && hasLegacyStreamMode) changes.push(`Set ${params.pathPrefix}.nativeStreaming → ${resolvedNativeStreaming}.`);
			};
			const migrateProvider = (provider) => {
				const providerEntry = getRecord(channels[provider]);
				if (!providerEntry) return;
				migrateProviderEntry({
					provider,
					entry: providerEntry,
					pathPrefix: `channels.${provider}`
				});
				const accounts = getRecord(providerEntry.accounts);
				if (!accounts) return;
				for (const [accountId, accountValue] of Object.entries(accounts)) {
					const account = getRecord(accountValue);
					if (!account) continue;
					migrateProviderEntry({
						provider,
						entry: account,
						pathPrefix: `channels.${provider}.accounts.${accountId}`
					});
				}
			};
			migrateProvider("telegram");
			migrateProvider("discord");
			migrateProvider("slack");
		}
	},
	{
		id: "routing.allowFrom->channels.whatsapp.allowFrom",
		describe: "Move routing.allowFrom to channels.whatsapp.allowFrom",
		apply: (raw, changes) => {
			const routing = raw.routing;
			if (!routing || typeof routing !== "object") return;
			const allowFrom = routing.allowFrom;
			if (allowFrom === void 0) return;
			const channels = getRecord(raw.channels);
			const whatsapp = channels ? getRecord(channels.whatsapp) : null;
			if (!whatsapp) {
				delete routing.allowFrom;
				if (Object.keys(routing).length === 0) delete raw.routing;
				changes.push("Removed routing.allowFrom (channels.whatsapp not configured).");
				return;
			}
			if (whatsapp.allowFrom === void 0) {
				whatsapp.allowFrom = allowFrom;
				changes.push("Moved routing.allowFrom → channels.whatsapp.allowFrom.");
			} else changes.push("Removed routing.allowFrom (channels.whatsapp.allowFrom already set).");
			delete routing.allowFrom;
			if (Object.keys(routing).length === 0) delete raw.routing;
			channels.whatsapp = whatsapp;
			raw.channels = channels;
		}
	},
	{
		id: "routing.groupChat.requireMention->groups.*.requireMention",
		describe: "Move routing.groupChat.requireMention to channels.whatsapp/telegram/imessage groups",
		apply: (raw, changes) => {
			const routing = raw.routing;
			if (!routing || typeof routing !== "object") return;
			const groupChat = routing.groupChat && typeof routing.groupChat === "object" ? routing.groupChat : null;
			if (!groupChat) return;
			const requireMention = groupChat.requireMention;
			if (requireMention === void 0) return;
			const channels = ensureRecord(raw, "channels");
			const applyTo = (key, options) => {
				if (options?.requireExisting && !isRecord$3(channels[key])) return;
				const section = channels[key] && typeof channels[key] === "object" ? channels[key] : {};
				const { groups, entry } = ensureDefaultGroupEntry(section);
				const defaultKey = "*";
				if (entry.requireMention === void 0) {
					entry.requireMention = requireMention;
					groups[defaultKey] = entry;
					section.groups = groups;
					channels[key] = section;
					changes.push(`Moved routing.groupChat.requireMention → channels.${key}.groups."*".requireMention.`);
				} else changes.push(`Removed routing.groupChat.requireMention (channels.${key}.groups."*" already set).`);
			};
			applyTo("whatsapp", { requireExisting: true });
			applyTo("telegram");
			applyTo("imessage");
			delete groupChat.requireMention;
			if (Object.keys(groupChat).length === 0) delete routing.groupChat;
			if (Object.keys(routing).length === 0) delete raw.routing;
			raw.channels = channels;
		}
	},
	{
		id: "gateway.token->gateway.auth.token",
		describe: "Move gateway.token to gateway.auth.token",
		apply: (raw, changes) => {
			const gateway = raw.gateway;
			if (!gateway || typeof gateway !== "object") return;
			const token = gateway.token;
			if (token === void 0) return;
			const gatewayObj = gateway;
			const auth = gatewayObj.auth && typeof gatewayObj.auth === "object" ? gatewayObj.auth : {};
			if (auth.token === void 0) {
				auth.token = token;
				if (!auth.mode) auth.mode = "token";
				changes.push("Moved gateway.token → gateway.auth.token.");
			} else changes.push("Removed gateway.token (gateway.auth.token already set).");
			delete gatewayObj.token;
			if (Object.keys(auth).length > 0) gatewayObj.auth = auth;
			raw.gateway = gatewayObj;
		}
	},
	{
		id: "telegram.requireMention->channels.telegram.groups.*.requireMention",
		describe: "Move telegram.requireMention to channels.telegram.groups.*.requireMention",
		apply: (raw, changes) => {
			const channels = ensureRecord(raw, "channels");
			const telegram = channels.telegram;
			if (!telegram || typeof telegram !== "object") return;
			const requireMention = telegram.requireMention;
			if (requireMention === void 0) return;
			const { groups, entry } = ensureDefaultGroupEntry(telegram);
			const defaultKey = "*";
			if (entry.requireMention === void 0) {
				entry.requireMention = requireMention;
				groups[defaultKey] = entry;
				telegram.groups = groups;
				changes.push("Moved telegram.requireMention → channels.telegram.groups.\"*\".requireMention.");
			} else changes.push("Removed telegram.requireMention (channels.telegram.groups.\"*\" already set).");
			delete telegram.requireMention;
			channels.telegram = telegram;
			raw.channels = channels;
		}
	}
];

//#endregion
//#region src/config/legacy.migrations.part-2.ts
function applyLegacyAudioTranscriptionModel(params) {
	const mapped = mapLegacyAudioTranscription(params.source);
	if (!mapped) {
		params.changes.push(params.invalidMessage);
		return;
	}
	const mediaAudio = ensureRecord(ensureRecord(ensureRecord(params.raw, "tools"), "media"), "audio");
	if ((Array.isArray(mediaAudio.models) ? mediaAudio.models : []).length === 0) {
		mediaAudio.enabled = true;
		mediaAudio.models = [mapped];
		params.changes.push(params.movedMessage);
		return;
	}
	params.changes.push(params.alreadySetMessage);
}
const LEGACY_CONFIG_MIGRATIONS_PART_2 = [
	{
		id: "agent.model-config-v2",
		describe: "Migrate legacy agent.model/allowedModels/modelAliases/modelFallbacks/imageModelFallbacks to agent.models + model lists",
		apply: (raw, changes) => {
			const agentRoot = getRecord(raw.agent);
			const defaults = getRecord(getRecord(raw.agents)?.defaults);
			const agent = agentRoot ?? defaults;
			if (!agent) return;
			const label = agentRoot ? "agent" : "agents.defaults";
			const legacyModel = typeof agent.model === "string" ? String(agent.model) : void 0;
			const legacyImageModel = typeof agent.imageModel === "string" ? String(agent.imageModel) : void 0;
			const legacyAllowed = Array.isArray(agent.allowedModels) ? agent.allowedModels.map(String) : [];
			const legacyModelFallbacks = Array.isArray(agent.modelFallbacks) ? agent.modelFallbacks.map(String) : [];
			const legacyImageModelFallbacks = Array.isArray(agent.imageModelFallbacks) ? agent.imageModelFallbacks.map(String) : [];
			const legacyAliases = agent.modelAliases && typeof agent.modelAliases === "object" ? agent.modelAliases : {};
			if (!(legacyModel || legacyImageModel || legacyAllowed.length > 0 || legacyModelFallbacks.length > 0 || legacyImageModelFallbacks.length > 0 || Object.keys(legacyAliases).length > 0)) return;
			const models = agent.models && typeof agent.models === "object" ? agent.models : {};
			const ensureModel = (rawKey) => {
				if (typeof rawKey !== "string") return;
				const key = rawKey.trim();
				if (!key) return;
				if (!models[key]) models[key] = {};
			};
			ensureModel(legacyModel);
			ensureModel(legacyImageModel);
			for (const key of legacyAllowed) ensureModel(key);
			for (const key of legacyModelFallbacks) ensureModel(key);
			for (const key of legacyImageModelFallbacks) ensureModel(key);
			for (const target of Object.values(legacyAliases)) {
				if (typeof target !== "string") continue;
				ensureModel(target);
			}
			for (const [alias, targetRaw] of Object.entries(legacyAliases)) {
				if (typeof targetRaw !== "string") continue;
				const target = targetRaw.trim();
				if (!target) continue;
				const entry = models[target] && typeof models[target] === "object" ? models[target] : {};
				if (!("alias" in entry)) {
					entry.alias = alias;
					models[target] = entry;
				}
			}
			const currentModel = agent.model && typeof agent.model === "object" ? agent.model : null;
			if (currentModel) {
				if (!currentModel.primary && legacyModel) currentModel.primary = legacyModel;
				if (legacyModelFallbacks.length > 0 && (!Array.isArray(currentModel.fallbacks) || currentModel.fallbacks.length === 0)) currentModel.fallbacks = legacyModelFallbacks;
				agent.model = currentModel;
			} else if (legacyModel || legacyModelFallbacks.length > 0) agent.model = {
				primary: legacyModel,
				fallbacks: legacyModelFallbacks.length ? legacyModelFallbacks : []
			};
			const currentImageModel = agent.imageModel && typeof agent.imageModel === "object" ? agent.imageModel : null;
			if (currentImageModel) {
				if (!currentImageModel.primary && legacyImageModel) currentImageModel.primary = legacyImageModel;
				if (legacyImageModelFallbacks.length > 0 && (!Array.isArray(currentImageModel.fallbacks) || currentImageModel.fallbacks.length === 0)) currentImageModel.fallbacks = legacyImageModelFallbacks;
				agent.imageModel = currentImageModel;
			} else if (legacyImageModel || legacyImageModelFallbacks.length > 0) agent.imageModel = {
				primary: legacyImageModel,
				fallbacks: legacyImageModelFallbacks.length ? legacyImageModelFallbacks : []
			};
			agent.models = models;
			if (legacyModel !== void 0) changes.push(`Migrated ${label}.model string → ${label}.model.primary.`);
			if (legacyModelFallbacks.length > 0) changes.push(`Migrated ${label}.modelFallbacks → ${label}.model.fallbacks.`);
			if (legacyImageModel !== void 0) changes.push(`Migrated ${label}.imageModel string → ${label}.imageModel.primary.`);
			if (legacyImageModelFallbacks.length > 0) changes.push(`Migrated ${label}.imageModelFallbacks → ${label}.imageModel.fallbacks.`);
			if (legacyAllowed.length > 0) changes.push(`Migrated ${label}.allowedModels → ${label}.models.`);
			if (Object.keys(legacyAliases).length > 0) changes.push(`Migrated ${label}.modelAliases → ${label}.models.*.alias.`);
			delete agent.allowedModels;
			delete agent.modelAliases;
			delete agent.modelFallbacks;
			delete agent.imageModelFallbacks;
		}
	},
	{
		id: "routing.agents-v2",
		describe: "Move routing.agents/defaultAgentId to agents.list",
		apply: (raw, changes) => {
			const routing = getRecord(raw.routing);
			if (!routing) return;
			const routingAgents = getRecord(routing.agents);
			const agents = ensureRecord(raw, "agents");
			const list = getAgentsList(agents);
			if (routingAgents) {
				for (const [rawId, entryRaw] of Object.entries(routingAgents)) {
					const agentId = String(rawId ?? "").trim();
					const entry = getRecord(entryRaw);
					if (!agentId || !entry) continue;
					const target = ensureAgentEntry(list, agentId);
					const entryCopy = { ...entry };
					if ("mentionPatterns" in entryCopy) {
						const mentionPatterns = entryCopy.mentionPatterns;
						const groupChat = ensureRecord(target, "groupChat");
						if (groupChat.mentionPatterns === void 0) {
							groupChat.mentionPatterns = mentionPatterns;
							changes.push(`Moved routing.agents.${agentId}.mentionPatterns → agents.list (id "${agentId}").groupChat.mentionPatterns.`);
						} else changes.push(`Removed routing.agents.${agentId}.mentionPatterns (agents.list groupChat mentionPatterns already set).`);
						delete entryCopy.mentionPatterns;
					}
					const legacyGroupChat = getRecord(entryCopy.groupChat);
					if (legacyGroupChat) {
						mergeMissing(ensureRecord(target, "groupChat"), legacyGroupChat);
						delete entryCopy.groupChat;
					}
					const legacySandbox = getRecord(entryCopy.sandbox);
					if (legacySandbox) {
						const sandboxTools = getRecord(legacySandbox.tools);
						if (sandboxTools) {
							mergeMissing(ensureRecord(ensureRecord(ensureRecord(target, "tools"), "sandbox"), "tools"), sandboxTools);
							delete legacySandbox.tools;
							changes.push(`Moved routing.agents.${agentId}.sandbox.tools → agents.list (id "${agentId}").tools.sandbox.tools.`);
						}
						entryCopy.sandbox = legacySandbox;
					}
					mergeMissing(target, entryCopy);
				}
				delete routing.agents;
				changes.push("Moved routing.agents → agents.list.");
			}
			const defaultAgentId = typeof routing.defaultAgentId === "string" ? routing.defaultAgentId.trim() : "";
			if (defaultAgentId) {
				if (!list.some((entry) => isRecord$3(entry) && entry.default === true)) {
					const entry = ensureAgentEntry(list, defaultAgentId);
					entry.default = true;
					changes.push(`Moved routing.defaultAgentId → agents.list (id "${defaultAgentId}").default.`);
				} else changes.push("Removed routing.defaultAgentId (agents.list default already set).");
				delete routing.defaultAgentId;
			}
			if (list.length > 0) agents.list = list;
			if (Object.keys(routing).length === 0) delete raw.routing;
		}
	},
	{
		id: "routing.config-v2",
		describe: "Move routing bindings/groupChat/queue/agentToAgent/transcribeAudio",
		apply: (raw, changes) => {
			const routing = getRecord(raw.routing);
			if (!routing) return;
			if (routing.bindings !== void 0) {
				if (raw.bindings === void 0) {
					raw.bindings = routing.bindings;
					changes.push("Moved routing.bindings → bindings.");
				} else changes.push("Removed routing.bindings (bindings already set).");
				delete routing.bindings;
			}
			if (routing.agentToAgent !== void 0) {
				const tools = ensureRecord(raw, "tools");
				if (tools.agentToAgent === void 0) {
					tools.agentToAgent = routing.agentToAgent;
					changes.push("Moved routing.agentToAgent → tools.agentToAgent.");
				} else changes.push("Removed routing.agentToAgent (tools.agentToAgent already set).");
				delete routing.agentToAgent;
			}
			if (routing.queue !== void 0) {
				const messages = ensureRecord(raw, "messages");
				if (messages.queue === void 0) {
					messages.queue = routing.queue;
					changes.push("Moved routing.queue → messages.queue.");
				} else changes.push("Removed routing.queue (messages.queue already set).");
				delete routing.queue;
			}
			const groupChat = getRecord(routing.groupChat);
			if (groupChat) {
				const historyLimit = groupChat.historyLimit;
				if (historyLimit !== void 0) {
					const messagesGroup = ensureRecord(ensureRecord(raw, "messages"), "groupChat");
					if (messagesGroup.historyLimit === void 0) {
						messagesGroup.historyLimit = historyLimit;
						changes.push("Moved routing.groupChat.historyLimit → messages.groupChat.historyLimit.");
					} else changes.push("Removed routing.groupChat.historyLimit (messages.groupChat.historyLimit already set).");
					delete groupChat.historyLimit;
				}
				const mentionPatterns = groupChat.mentionPatterns;
				if (mentionPatterns !== void 0) {
					const messagesGroup = ensureRecord(ensureRecord(raw, "messages"), "groupChat");
					if (messagesGroup.mentionPatterns === void 0) {
						messagesGroup.mentionPatterns = mentionPatterns;
						changes.push("Moved routing.groupChat.mentionPatterns → messages.groupChat.mentionPatterns.");
					} else changes.push("Removed routing.groupChat.mentionPatterns (messages.groupChat.mentionPatterns already set).");
					delete groupChat.mentionPatterns;
				}
				if (Object.keys(groupChat).length === 0) delete routing.groupChat;
				else routing.groupChat = groupChat;
			}
			if (routing.transcribeAudio !== void 0) {
				applyLegacyAudioTranscriptionModel({
					raw,
					source: routing.transcribeAudio,
					changes,
					movedMessage: "Moved routing.transcribeAudio → tools.media.audio.models.",
					alreadySetMessage: "Removed routing.transcribeAudio (tools.media.audio.models already set).",
					invalidMessage: "Removed routing.transcribeAudio (invalid or empty command)."
				});
				delete routing.transcribeAudio;
			}
			if (Object.keys(routing).length === 0) delete raw.routing;
		}
	},
	{
		id: "audio.transcription-v2",
		describe: "Move audio.transcription to tools.media.audio.models",
		apply: (raw, changes) => {
			const audio = getRecord(raw.audio);
			if (audio?.transcription === void 0) return;
			applyLegacyAudioTranscriptionModel({
				raw,
				source: audio.transcription,
				changes,
				movedMessage: "Moved audio.transcription → tools.media.audio.models.",
				alreadySetMessage: "Removed audio.transcription (tools.media.audio.models already set).",
				invalidMessage: "Removed audio.transcription (invalid or empty command)."
			});
			delete audio.transcription;
			if (Object.keys(audio).length === 0) delete raw.audio;
			else raw.audio = audio;
		}
	}
];

//#endregion
//#region src/config/legacy.migrations.part-3.ts
const LEGACY_CONFIG_MIGRATIONS_PART_3 = [
	{
		id: "memorySearch->agents.defaults.memorySearch",
		describe: "Move top-level memorySearch to agents.defaults.memorySearch",
		apply: (raw, changes) => {
			const legacyMemorySearch = getRecord(raw.memorySearch);
			if (!legacyMemorySearch) return;
			const agents = ensureRecord(raw, "agents");
			const defaults = ensureRecord(agents, "defaults");
			const existing = getRecord(defaults.memorySearch);
			if (!existing) {
				defaults.memorySearch = legacyMemorySearch;
				changes.push("Moved memorySearch → agents.defaults.memorySearch.");
			} else {
				const merged = structuredClone(existing);
				mergeMissing(merged, legacyMemorySearch);
				defaults.memorySearch = merged;
				changes.push("Merged memorySearch → agents.defaults.memorySearch (filled missing fields from legacy; kept explicit agents.defaults values).");
			}
			agents.defaults = defaults;
			raw.agents = agents;
			delete raw.memorySearch;
		}
	},
	{
		id: "auth.anthropic-claude-cli-mode-oauth",
		describe: "Switch anthropic:claude-cli auth profile mode to oauth",
		apply: (raw, changes) => {
			const profiles = getRecord(getRecord(raw.auth)?.profiles);
			if (!profiles) return;
			const claudeCli = getRecord(profiles["anthropic:claude-cli"]);
			if (!claudeCli) return;
			if (claudeCli.mode !== "token") return;
			claudeCli.mode = "oauth";
			changes.push("Updated auth.profiles[\"anthropic:claude-cli\"].mode → \"oauth\".");
		}
	},
	{
		id: "tools.bash->tools.exec",
		describe: "Move tools.bash to tools.exec",
		apply: (raw, changes) => {
			const tools = ensureRecord(raw, "tools");
			const bash = getRecord(tools.bash);
			if (!bash) return;
			if (tools.exec === void 0) {
				tools.exec = bash;
				changes.push("Moved tools.bash → tools.exec.");
			} else changes.push("Removed tools.bash (tools.exec already set).");
			delete tools.bash;
		}
	},
	{
		id: "messages.tts.enabled->auto",
		describe: "Move messages.tts.enabled to messages.tts.auto",
		apply: (raw, changes) => {
			const tts = getRecord(getRecord(raw.messages)?.tts);
			if (!tts) return;
			if (tts.auto !== void 0) {
				if ("enabled" in tts) {
					delete tts.enabled;
					changes.push("Removed messages.tts.enabled (messages.tts.auto already set).");
				}
				return;
			}
			if (typeof tts.enabled !== "boolean") return;
			tts.auto = tts.enabled ? "always" : "off";
			delete tts.enabled;
			changes.push(`Moved messages.tts.enabled → messages.tts.auto (${String(tts.auto)}).`);
		}
	},
	{
		id: "agent.defaults-v2",
		describe: "Move agent config to agents.defaults and tools",
		apply: (raw, changes) => {
			const agent = getRecord(raw.agent);
			if (!agent) return;
			const agents = ensureRecord(raw, "agents");
			const defaults = getRecord(agents.defaults) ?? {};
			const tools = ensureRecord(raw, "tools");
			const agentTools = getRecord(agent.tools);
			if (agentTools) {
				if (tools.allow === void 0 && agentTools.allow !== void 0) {
					tools.allow = agentTools.allow;
					changes.push("Moved agent.tools.allow → tools.allow.");
				}
				if (tools.deny === void 0 && agentTools.deny !== void 0) {
					tools.deny = agentTools.deny;
					changes.push("Moved agent.tools.deny → tools.deny.");
				}
			}
			const elevated = getRecord(agent.elevated);
			if (elevated) if (tools.elevated === void 0) {
				tools.elevated = elevated;
				changes.push("Moved agent.elevated → tools.elevated.");
			} else changes.push("Removed agent.elevated (tools.elevated already set).");
			const bash = getRecord(agent.bash);
			if (bash) if (tools.exec === void 0) {
				tools.exec = bash;
				changes.push("Moved agent.bash → tools.exec.");
			} else changes.push("Removed agent.bash (tools.exec already set).");
			const sandbox = getRecord(agent.sandbox);
			if (sandbox) {
				const sandboxTools = getRecord(sandbox.tools);
				if (sandboxTools) {
					mergeMissing(ensureRecord(ensureRecord(tools, "sandbox"), "tools"), sandboxTools);
					delete sandbox.tools;
					changes.push("Moved agent.sandbox.tools → tools.sandbox.tools.");
				}
			}
			const subagents = getRecord(agent.subagents);
			if (subagents) {
				const subagentTools = getRecord(subagents.tools);
				if (subagentTools) {
					mergeMissing(ensureRecord(ensureRecord(tools, "subagents"), "tools"), subagentTools);
					delete subagents.tools;
					changes.push("Moved agent.subagents.tools → tools.subagents.tools.");
				}
			}
			const agentCopy = structuredClone(agent);
			delete agentCopy.tools;
			delete agentCopy.elevated;
			delete agentCopy.bash;
			if (isRecord$3(agentCopy.sandbox)) delete agentCopy.sandbox.tools;
			if (isRecord$3(agentCopy.subagents)) delete agentCopy.subagents.tools;
			mergeMissing(defaults, agentCopy);
			agents.defaults = defaults;
			raw.agents = agents;
			delete raw.agent;
			changes.push("Moved agent → agents.defaults.");
		}
	},
	{
		id: "identity->agents.list",
		describe: "Move identity to agents.list[].identity",
		apply: (raw, changes) => {
			const identity = getRecord(raw.identity);
			if (!identity) return;
			const agents = ensureRecord(raw, "agents");
			const list = getAgentsList(agents);
			const defaultId = resolveDefaultAgentIdFromRaw(raw);
			const entry = ensureAgentEntry(list, defaultId);
			if (entry.identity === void 0) {
				entry.identity = identity;
				changes.push(`Moved identity → agents.list (id "${defaultId}").identity.`);
			} else changes.push("Removed identity (agents.list identity already set).");
			agents.list = list;
			raw.agents = agents;
			delete raw.identity;
		}
	}
];

//#endregion
//#region src/config/legacy.migrations.ts
const LEGACY_CONFIG_MIGRATIONS = [
	...LEGACY_CONFIG_MIGRATIONS_PART_1,
	...LEGACY_CONFIG_MIGRATIONS_PART_2,
	...LEGACY_CONFIG_MIGRATIONS_PART_3
];

//#endregion
//#region src/config/legacy.rules.ts
function isRecord$1(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasLegacyThreadBindingTtl(value) {
	return isRecord$1(value) && Object.prototype.hasOwnProperty.call(value, "ttlHours");
}
function hasLegacyThreadBindingTtlInAccounts(value) {
	if (!isRecord$1(value)) return false;
	return Object.values(value).some((entry) => hasLegacyThreadBindingTtl(isRecord$1(entry) ? entry.threadBindings : void 0));
}
const LEGACY_CONFIG_RULES = [
	{
		path: ["whatsapp"],
		message: "whatsapp config moved to channels.whatsapp (auto-migrated on load)."
	},
	{
		path: ["telegram"],
		message: "telegram config moved to channels.telegram (auto-migrated on load)."
	},
	{
		path: ["discord"],
		message: "discord config moved to channels.discord (auto-migrated on load)."
	},
	{
		path: ["slack"],
		message: "slack config moved to channels.slack (auto-migrated on load)."
	},
	{
		path: ["signal"],
		message: "signal config moved to channels.signal (auto-migrated on load)."
	},
	{
		path: ["imessage"],
		message: "imessage config moved to channels.imessage (auto-migrated on load)."
	},
	{
		path: ["msteams"],
		message: "msteams config moved to channels.msteams (auto-migrated on load)."
	},
	{
		path: ["session", "threadBindings"],
		message: "session.threadBindings.ttlHours was renamed to session.threadBindings.idleHours (auto-migrated on load).",
		match: (value) => hasLegacyThreadBindingTtl(value)
	},
	{
		path: [
			"channels",
			"discord",
			"threadBindings"
		],
		message: "channels.discord.threadBindings.ttlHours was renamed to channels.discord.threadBindings.idleHours (auto-migrated on load).",
		match: (value) => hasLegacyThreadBindingTtl(value)
	},
	{
		path: [
			"channels",
			"discord",
			"accounts"
		],
		message: "channels.discord.accounts.<id>.threadBindings.ttlHours was renamed to channels.discord.accounts.<id>.threadBindings.idleHours (auto-migrated on load).",
		match: (value) => hasLegacyThreadBindingTtlInAccounts(value)
	},
	{
		path: ["routing", "allowFrom"],
		message: "routing.allowFrom was removed; use channels.whatsapp.allowFrom instead (auto-migrated on load)."
	},
	{
		path: ["routing", "bindings"],
		message: "routing.bindings was moved; use top-level bindings instead (auto-migrated on load)."
	},
	{
		path: ["routing", "agents"],
		message: "routing.agents was moved; use agents.list instead (auto-migrated on load)."
	},
	{
		path: ["routing", "defaultAgentId"],
		message: "routing.defaultAgentId was moved; use agents.list[].default instead (auto-migrated on load)."
	},
	{
		path: ["routing", "agentToAgent"],
		message: "routing.agentToAgent was moved; use tools.agentToAgent instead (auto-migrated on load)."
	},
	{
		path: [
			"routing",
			"groupChat",
			"requireMention"
		],
		message: "routing.groupChat.requireMention was removed; use channels.whatsapp/telegram/imessage groups defaults (e.g. channels.whatsapp.groups.\"*\".requireMention) instead (auto-migrated on load)."
	},
	{
		path: [
			"routing",
			"groupChat",
			"mentionPatterns"
		],
		message: "routing.groupChat.mentionPatterns was moved; use agents.list[].groupChat.mentionPatterns or messages.groupChat.mentionPatterns instead (auto-migrated on load)."
	},
	{
		path: ["routing", "queue"],
		message: "routing.queue was moved; use messages.queue instead (auto-migrated on load)."
	},
	{
		path: ["routing", "transcribeAudio"],
		message: "routing.transcribeAudio was moved; use tools.media.audio.models instead (auto-migrated on load)."
	},
	{
		path: ["telegram", "requireMention"],
		message: "telegram.requireMention was removed; use channels.telegram.groups.\"*\".requireMention instead (auto-migrated on load)."
	},
	{
		path: ["identity"],
		message: "identity was moved; use agents.list[].identity instead (auto-migrated on load)."
	},
	{
		path: ["agent"],
		message: "agent.* was moved; use agents.defaults (and tools.* for tool/elevated/exec settings) instead (auto-migrated on load)."
	},
	{
		path: ["memorySearch"],
		message: "top-level memorySearch was moved; use agents.defaults.memorySearch instead (auto-migrated on load)."
	},
	{
		path: ["tools", "bash"],
		message: "tools.bash was removed; use tools.exec instead (auto-migrated on load)."
	},
	{
		path: ["agent", "model"],
		message: "agent.model string was replaced by agents.defaults.model.primary/fallbacks and agents.defaults.models (auto-migrated on load).",
		match: (value) => typeof value === "string"
	},
	{
		path: ["agent", "imageModel"],
		message: "agent.imageModel string was replaced by agents.defaults.imageModel.primary/fallbacks (auto-migrated on load).",
		match: (value) => typeof value === "string"
	},
	{
		path: ["agent", "allowedModels"],
		message: "agent.allowedModels was replaced by agents.defaults.models (auto-migrated on load)."
	},
	{
		path: ["agent", "modelAliases"],
		message: "agent.modelAliases was replaced by agents.defaults.models.*.alias (auto-migrated on load)."
	},
	{
		path: ["agent", "modelFallbacks"],
		message: "agent.modelFallbacks was replaced by agents.defaults.model.fallbacks (auto-migrated on load)."
	},
	{
		path: ["agent", "imageModelFallbacks"],
		message: "agent.imageModelFallbacks was replaced by agents.defaults.imageModel.fallbacks (auto-migrated on load)."
	},
	{
		path: [
			"messages",
			"tts",
			"enabled"
		],
		message: "messages.tts.enabled was replaced by messages.tts.auto (auto-migrated on load)."
	},
	{
		path: ["gateway", "token"],
		message: "gateway.token is ignored; use gateway.auth.token instead (auto-migrated on load)."
	}
];

//#endregion
//#region src/config/legacy.ts
function findLegacyConfigIssues(raw) {
	if (!raw || typeof raw !== "object") return [];
	const root = raw;
	const issues = [];
	for (const rule of LEGACY_CONFIG_RULES) {
		let cursor = root;
		for (const key of rule.path) {
			if (!cursor || typeof cursor !== "object") {
				cursor = void 0;
				break;
			}
			cursor = cursor[key];
		}
		if (cursor !== void 0 && (!rule.match || rule.match(cursor, root))) issues.push({
			path: rule.path.join("."),
			message: rule.message
		});
	}
	return issues;
}

//#endregion
//#region src/config/merge-patch.ts
function isObjectWithStringId(value) {
	if (!isPlainObject$2(value)) return false;
	return typeof value.id === "string" && value.id.length > 0;
}
/**
* Merge arrays of object-like entries keyed by `id`.
*
* Contract:
* - Base array must be fully id-keyed; otherwise return undefined (caller should replace).
* - Patch entries with valid id merge by id (or append when the id is new).
* - Patch entries without valid id append as-is, avoiding destructive full-array replacement.
*/
function mergeObjectArraysById(base, patch, options) {
	if (!base.every(isObjectWithStringId)) return;
	const merged = [...base];
	const indexById = /* @__PURE__ */ new Map();
	for (const [index, entry] of merged.entries()) {
		if (!isObjectWithStringId(entry)) return;
		indexById.set(entry.id, index);
	}
	for (const patchEntry of patch) {
		if (!isObjectWithStringId(patchEntry)) {
			merged.push(structuredClone(patchEntry));
			continue;
		}
		const existingIndex = indexById.get(patchEntry.id);
		if (existingIndex === void 0) {
			merged.push(structuredClone(patchEntry));
			indexById.set(patchEntry.id, merged.length - 1);
			continue;
		}
		merged[existingIndex] = applyMergePatch(merged[existingIndex], patchEntry, options);
	}
	return merged;
}
function applyMergePatch(base, patch, options = {}) {
	if (!isPlainObject$2(patch)) return patch;
	const result = isPlainObject$2(base) ? { ...base } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (isBlockedObjectKey(key)) continue;
		if (value === null) {
			delete result[key];
			continue;
		}
		if (options.mergeObjectArraysById && Array.isArray(result[key]) && Array.isArray(value)) {
			const mergedArray = mergeObjectArraysById(result[key], value, options);
			if (mergedArray) {
				result[key] = mergedArray;
				continue;
			}
		}
		if (isPlainObject$2(value)) {
			const baseValue = result[key];
			result[key] = applyMergePatch(isPlainObject$2(baseValue) ? baseValue : {}, value, options);
			continue;
		}
		result[key] = value;
	}
	return result;
}

//#endregion
//#region src/infra/exec-safe-bin-policy-profiles.ts
const NO_FLAGS$1 = /* @__PURE__ */ new Set();
const toFlagSet = (flags) => {
	if (!flags || flags.length === 0) return NO_FLAGS$1;
	return new Set(flags);
};
function collectKnownLongFlags(allowedValueFlags, deniedFlags) {
	const known = /* @__PURE__ */ new Set();
	for (const flag of allowedValueFlags) if (flag.startsWith("--")) known.add(flag);
	for (const flag of deniedFlags) if (flag.startsWith("--")) known.add(flag);
	return Array.from(known);
}
function buildLongFlagPrefixMap(knownLongFlags) {
	const prefixMap = /* @__PURE__ */ new Map();
	for (const flag of knownLongFlags) {
		if (!flag.startsWith("--") || flag.length <= 2) continue;
		for (let length = 3; length <= flag.length; length += 1) {
			const prefix = flag.slice(0, length);
			const existing = prefixMap.get(prefix);
			if (existing === void 0) {
				prefixMap.set(prefix, flag);
				continue;
			}
			if (existing !== flag) prefixMap.set(prefix, null);
		}
	}
	return prefixMap;
}
function compileSafeBinProfile(fixture) {
	const allowedValueFlags = toFlagSet(fixture.allowedValueFlags);
	const deniedFlags = toFlagSet(fixture.deniedFlags);
	const knownLongFlags = collectKnownLongFlags(allowedValueFlags, deniedFlags);
	return {
		minPositional: fixture.minPositional,
		maxPositional: fixture.maxPositional,
		allowedValueFlags,
		deniedFlags,
		knownLongFlags,
		knownLongFlagsSet: new Set(knownLongFlags),
		longFlagPrefixMap: buildLongFlagPrefixMap(knownLongFlags)
	};
}
function compileSafeBinProfiles(fixtures) {
	return Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, compileSafeBinProfile(fixture)]));
}
const SAFE_BIN_PROFILE_FIXTURES = {
	jq: {
		maxPositional: 1,
		allowedValueFlags: [
			"--arg",
			"--argjson",
			"--argstr"
		],
		deniedFlags: [
			"--argfile",
			"--rawfile",
			"--slurpfile",
			"--from-file",
			"--library-path",
			"-L",
			"-f"
		]
	},
	grep: {
		maxPositional: 0,
		allowedValueFlags: [
			"--regexp",
			"--max-count",
			"--after-context",
			"--before-context",
			"--context",
			"--devices",
			"--binary-files",
			"--exclude",
			"--include",
			"--label",
			"-e",
			"-m",
			"-A",
			"-B",
			"-C",
			"-D"
		],
		deniedFlags: [
			"--file",
			"--exclude-from",
			"--dereference-recursive",
			"--directories",
			"--recursive",
			"-f",
			"-d",
			"-r",
			"-R"
		]
	},
	cut: {
		maxPositional: 0,
		allowedValueFlags: [
			"--bytes",
			"--characters",
			"--fields",
			"--delimiter",
			"--output-delimiter",
			"-b",
			"-c",
			"-f",
			"-d"
		]
	},
	sort: {
		maxPositional: 0,
		allowedValueFlags: [
			"--key",
			"--field-separator",
			"--buffer-size",
			"--parallel",
			"--batch-size",
			"-k",
			"-t",
			"-S"
		],
		deniedFlags: [
			"--compress-program",
			"--files0-from",
			"--output",
			"--random-source",
			"--temporary-directory",
			"-T",
			"-o"
		]
	},
	uniq: {
		maxPositional: 0,
		allowedValueFlags: [
			"--skip-fields",
			"--skip-chars",
			"--check-chars",
			"--group",
			"-f",
			"-s",
			"-w"
		]
	},
	head: {
		maxPositional: 0,
		allowedValueFlags: [
			"--lines",
			"--bytes",
			"-n",
			"-c"
		]
	},
	tail: {
		maxPositional: 0,
		allowedValueFlags: [
			"--lines",
			"--bytes",
			"--sleep-interval",
			"--max-unchanged-stats",
			"--pid",
			"-n",
			"-c"
		]
	},
	tr: {
		minPositional: 1,
		maxPositional: 2
	},
	wc: {
		maxPositional: 0,
		deniedFlags: ["--files0-from"]
	}
};
const SAFE_BIN_PROFILES = compileSafeBinProfiles(SAFE_BIN_PROFILE_FIXTURES);
function normalizeSafeBinProfileName(raw) {
	const name = raw.trim().toLowerCase();
	return name.length > 0 ? name : null;
}
function normalizeFixtureLimit(raw) {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return;
	const next = Math.trunc(raw);
	return next >= 0 ? next : void 0;
}
function normalizeFixtureFlags(flags) {
	if (!Array.isArray(flags) || flags.length === 0) return;
	const normalized = Array.from(new Set(flags.map((flag) => flag.trim()).filter((flag) => flag.length > 0))).toSorted((a, b) => a.localeCompare(b));
	return normalized.length > 0 ? normalized : void 0;
}
function normalizeSafeBinProfileFixture(fixture) {
	const minPositional = normalizeFixtureLimit(fixture.minPositional);
	const maxPositionalRaw = normalizeFixtureLimit(fixture.maxPositional);
	return {
		minPositional,
		maxPositional: minPositional !== void 0 && maxPositionalRaw !== void 0 && maxPositionalRaw < minPositional ? minPositional : maxPositionalRaw,
		allowedValueFlags: normalizeFixtureFlags(fixture.allowedValueFlags),
		deniedFlags: normalizeFixtureFlags(fixture.deniedFlags)
	};
}
function normalizeSafeBinProfileFixtures(fixtures) {
	const normalized = {};
	if (!fixtures) return normalized;
	for (const [rawName, fixture] of Object.entries(fixtures)) {
		const name = normalizeSafeBinProfileName(rawName);
		if (!name) continue;
		normalized[name] = normalizeSafeBinProfileFixture(fixture);
	}
	return normalized;
}
function resolveSafeBinProfiles(fixtures) {
	const normalizedFixtures = normalizeSafeBinProfileFixtures(fixtures);
	if (Object.keys(normalizedFixtures).length === 0) return SAFE_BIN_PROFILES;
	return {
		...SAFE_BIN_PROFILES,
		...compileSafeBinProfiles(normalizedFixtures)
	};
}

//#endregion
//#region src/utils/shell-argv.ts
const DOUBLE_QUOTE_ESCAPES$1 = new Set([
	"\\",
	"\"",
	"$",
	"`",
	"\n",
	"\r"
]);
function isDoubleQuoteEscape$1(next) {
	return Boolean(next && DOUBLE_QUOTE_ESCAPES$1.has(next));
}
function splitShellArgs(raw) {
	const tokens = [];
	let buf = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	const pushToken = () => {
		if (buf.length > 0) {
			tokens.push(buf);
			buf = "";
		}
	};
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (escaped) {
			buf += ch;
			escaped = false;
			continue;
		}
		if (!inSingle && !inDouble && ch === "\\") {
			escaped = true;
			continue;
		}
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else buf += ch;
			continue;
		}
		if (inDouble) {
			const next = raw[i + 1];
			if (ch === "\\" && isDoubleQuoteEscape$1(next)) {
				buf += next;
				i += 1;
				continue;
			}
			if (ch === "\"") inDouble = false;
			else buf += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === "\"") {
			inDouble = true;
			continue;
		}
		if (/\s/.test(ch)) {
			pushToken();
			continue;
		}
		buf += ch;
	}
	if (escaped || inSingle || inDouble) return null;
	pushToken();
	return tokens;
}

//#endregion
//#region src/infra/exec-wrapper-resolution.ts
const MAX_DISPATCH_WRAPPER_DEPTH = 4;
const WINDOWS_EXE_SUFFIX = ".exe";
const POSIX_SHELL_WRAPPER_NAMES = [
	"ash",
	"bash",
	"dash",
	"fish",
	"ksh",
	"sh",
	"zsh"
];
const WINDOWS_CMD_WRAPPER_NAMES = ["cmd"];
const POWERSHELL_WRAPPER_NAMES = ["powershell", "pwsh"];
const SHELL_MULTIPLEXER_WRAPPER_NAMES = ["busybox", "toybox"];
const DISPATCH_WRAPPER_NAMES = [
	"chrt",
	"doas",
	"env",
	"ionice",
	"nice",
	"nohup",
	"setsid",
	"stdbuf",
	"sudo",
	"taskset",
	"timeout"
];
function withWindowsExeAliases(names) {
	const expanded = /* @__PURE__ */ new Set();
	for (const name of names) {
		expanded.add(name);
		expanded.add(`${name}${WINDOWS_EXE_SUFFIX}`);
	}
	return Array.from(expanded);
}
function stripWindowsExeSuffix(value) {
	return value.endsWith(WINDOWS_EXE_SUFFIX) ? value.slice(0, -4) : value;
}
const POSIX_SHELL_WRAPPERS = new Set(POSIX_SHELL_WRAPPER_NAMES);
const WINDOWS_CMD_WRAPPERS = new Set(withWindowsExeAliases(WINDOWS_CMD_WRAPPER_NAMES));
const POWERSHELL_WRAPPERS = new Set(withWindowsExeAliases(POWERSHELL_WRAPPER_NAMES));
const DISPATCH_WRAPPER_EXECUTABLES = new Set(withWindowsExeAliases(DISPATCH_WRAPPER_NAMES));
const POSIX_SHELL_WRAPPER_CANONICAL = new Set(POSIX_SHELL_WRAPPER_NAMES);
const WINDOWS_CMD_WRAPPER_CANONICAL = new Set(WINDOWS_CMD_WRAPPER_NAMES);
const POWERSHELL_WRAPPER_CANONICAL = new Set(POWERSHELL_WRAPPER_NAMES);
const SHELL_MULTIPLEXER_WRAPPER_CANONICAL = new Set(SHELL_MULTIPLEXER_WRAPPER_NAMES);
const DISPATCH_WRAPPER_CANONICAL = new Set(DISPATCH_WRAPPER_NAMES);
const SHELL_WRAPPER_CANONICAL = new Set([
	...POSIX_SHELL_WRAPPER_NAMES,
	...WINDOWS_CMD_WRAPPER_NAMES,
	...POWERSHELL_WRAPPER_NAMES
]);
const POSIX_INLINE_COMMAND_FLAGS = new Set([
	"-lc",
	"-c",
	"--command"
]);
const POWERSHELL_INLINE_COMMAND_FLAGS = new Set([
	"-c",
	"-command",
	"--command"
]);
const ENV_OPTIONS_WITH_VALUE = new Set([
	"-u",
	"--unset",
	"-c",
	"--chdir",
	"-s",
	"--split-string",
	"--default-signal",
	"--ignore-signal",
	"--block-signal"
]);
const ENV_INLINE_VALUE_PREFIXES = [
	"-u",
	"-c",
	"-s",
	"--unset=",
	"--chdir=",
	"--split-string=",
	"--default-signal=",
	"--ignore-signal=",
	"--block-signal="
];
const ENV_FLAG_OPTIONS = new Set([
	"-i",
	"--ignore-environment",
	"-0",
	"--null"
]);
const NICE_OPTIONS_WITH_VALUE = new Set([
	"-n",
	"--adjustment",
	"--priority"
]);
const STDBUF_OPTIONS_WITH_VALUE = new Set([
	"-i",
	"--input",
	"-o",
	"--output",
	"-e",
	"--error"
]);
const TIMEOUT_FLAG_OPTIONS = new Set([
	"--foreground",
	"--preserve-status",
	"-v",
	"--verbose"
]);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set([
	"-k",
	"--kill-after",
	"-s",
	"--signal"
]);
const TRANSPARENT_DISPATCH_WRAPPERS = new Set([
	"nice",
	"nohup",
	"stdbuf",
	"timeout"
]);
const SHELL_WRAPPER_SPECS = [
	{
		kind: "posix",
		names: POSIX_SHELL_WRAPPER_CANONICAL
	},
	{
		kind: "cmd",
		names: WINDOWS_CMD_WRAPPER_CANONICAL
	},
	{
		kind: "powershell",
		names: POWERSHELL_WRAPPER_CANONICAL
	}
];
function basenameLower(token) {
	const win = path.win32.basename(token);
	const posix = path.posix.basename(token);
	return (win.length < posix.length ? win : posix).trim().toLowerCase();
}
function normalizeExecutableToken(token) {
	return stripWindowsExeSuffix(basenameLower(token));
}
function isDispatchWrapperExecutable(token) {
	return DISPATCH_WRAPPER_CANONICAL.has(normalizeExecutableToken(token));
}
function isShellWrapperExecutable(token) {
	return SHELL_WRAPPER_CANONICAL.has(normalizeExecutableToken(token));
}
function findShellWrapperSpec(baseExecutable) {
	const canonicalBase = stripWindowsExeSuffix(baseExecutable);
	for (const spec of SHELL_WRAPPER_SPECS) if (spec.names.has(canonicalBase)) return spec;
	return null;
}
function unwrapKnownShellMultiplexerInvocation(argv) {
	const token0 = argv[0]?.trim();
	if (!token0) return { kind: "not-wrapper" };
	const wrapper = normalizeExecutableToken(token0);
	if (!SHELL_MULTIPLEXER_WRAPPER_CANONICAL.has(wrapper)) return { kind: "not-wrapper" };
	let appletIndex = 1;
	if (argv[appletIndex]?.trim() === "--") appletIndex += 1;
	const applet = argv[appletIndex]?.trim();
	if (!applet || !isShellWrapperExecutable(applet)) return {
		kind: "blocked",
		wrapper
	};
	const unwrapped = argv.slice(appletIndex);
	if (unwrapped.length === 0) return {
		kind: "blocked",
		wrapper
	};
	return {
		kind: "unwrapped",
		wrapper,
		argv: unwrapped
	};
}
function isEnvAssignment(token) {
	return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}
function hasEnvInlineValuePrefix(lower) {
	for (const prefix of ENV_INLINE_VALUE_PREFIXES) if (lower.startsWith(prefix)) return true;
	return false;
}
function scanWrapperInvocation(argv, params) {
	let idx = 1;
	let expectsOptionValue = false;
	while (idx < argv.length) {
		const token = argv[idx]?.trim() ?? "";
		if (!token) {
			idx += 1;
			continue;
		}
		if (expectsOptionValue) {
			expectsOptionValue = false;
			idx += 1;
			continue;
		}
		if (params.separators?.has(token)) {
			idx += 1;
			break;
		}
		const directive = params.onToken(token, token.toLowerCase());
		if (directive === "stop") break;
		if (directive === "invalid") return null;
		if (directive === "consume-next") expectsOptionValue = true;
		idx += 1;
	}
	if (expectsOptionValue) return null;
	const commandIndex = params.adjustCommandIndex ? params.adjustCommandIndex(idx, argv) : idx;
	if (commandIndex === null || commandIndex >= argv.length) return null;
	return argv.slice(commandIndex);
}
function unwrapEnvInvocation(argv) {
	return scanWrapperInvocation(argv, {
		separators: new Set(["--", "-"]),
		onToken: (token, lower) => {
			if (isEnvAssignment(token)) return "continue";
			if (!token.startsWith("-") || token === "-") return "stop";
			const [flag] = lower.split("=", 2);
			if (ENV_FLAG_OPTIONS.has(flag)) return "continue";
			if (ENV_OPTIONS_WITH_VALUE.has(flag)) return lower.includes("=") ? "continue" : "consume-next";
			if (hasEnvInlineValuePrefix(lower)) return "continue";
			return "invalid";
		}
	});
}
function envInvocationUsesModifiers(argv) {
	let idx = 1;
	let expectsOptionValue = false;
	while (idx < argv.length) {
		const token = argv[idx]?.trim() ?? "";
		if (!token) {
			idx += 1;
			continue;
		}
		if (expectsOptionValue) return true;
		if (token === "--" || token === "-") {
			idx += 1;
			break;
		}
		if (isEnvAssignment(token)) return true;
		if (!token.startsWith("-") || token === "-") break;
		const lower = token.toLowerCase();
		const [flag] = lower.split("=", 2);
		if (ENV_FLAG_OPTIONS.has(flag)) return true;
		if (ENV_OPTIONS_WITH_VALUE.has(flag)) {
			if (lower.includes("=")) return true;
			expectsOptionValue = true;
			idx += 1;
			continue;
		}
		if (hasEnvInlineValuePrefix(lower)) return true;
		return true;
	}
	return false;
}
function unwrapNiceInvocation(argv) {
	return unwrapDashOptionInvocation(argv, { onFlag: (flag, lower) => {
		if (/^-\d+$/.test(lower)) return "continue";
		if (NICE_OPTIONS_WITH_VALUE.has(flag)) return lower.includes("=") || lower !== flag ? "continue" : "consume-next";
		if (lower.startsWith("-n") && lower.length > 2) return "continue";
		return "invalid";
	} });
}
function unwrapNohupInvocation(argv) {
	return scanWrapperInvocation(argv, {
		separators: new Set(["--"]),
		onToken: (token, lower) => {
			if (!token.startsWith("-") || token === "-") return "stop";
			return lower === "--help" || lower === "--version" ? "continue" : "invalid";
		}
	});
}
function unwrapDashOptionInvocation(argv, params) {
	return scanWrapperInvocation(argv, {
		separators: new Set(["--"]),
		onToken: (token, lower) => {
			if (!token.startsWith("-") || token === "-") return "stop";
			const [flag] = lower.split("=", 2);
			return params.onFlag(flag, lower);
		},
		adjustCommandIndex: params.adjustCommandIndex
	});
}
function unwrapStdbufInvocation(argv) {
	return unwrapDashOptionInvocation(argv, { onFlag: (flag, lower) => {
		if (!STDBUF_OPTIONS_WITH_VALUE.has(flag)) return "invalid";
		return lower.includes("=") ? "continue" : "consume-next";
	} });
}
function unwrapTimeoutInvocation(argv) {
	return unwrapDashOptionInvocation(argv, {
		onFlag: (flag, lower) => {
			if (TIMEOUT_FLAG_OPTIONS.has(flag)) return "continue";
			if (TIMEOUT_OPTIONS_WITH_VALUE.has(flag)) return lower.includes("=") ? "continue" : "consume-next";
			return "invalid";
		},
		adjustCommandIndex: (commandIndex, currentArgv) => {
			const wrappedCommandIndex = commandIndex + 1;
			return wrappedCommandIndex < currentArgv.length ? wrappedCommandIndex : null;
		}
	});
}
function blockDispatchWrapper(wrapper) {
	return {
		kind: "blocked",
		wrapper
	};
}
function unwrapDispatchWrapper(wrapper, unwrapped) {
	return unwrapped ? {
		kind: "unwrapped",
		wrapper,
		argv: unwrapped
	} : blockDispatchWrapper(wrapper);
}
function unwrapKnownDispatchWrapperInvocation(argv) {
	const token0 = argv[0]?.trim();
	if (!token0) return { kind: "not-wrapper" };
	const wrapper = normalizeExecutableToken(token0);
	switch (wrapper) {
		case "env": return unwrapDispatchWrapper(wrapper, unwrapEnvInvocation(argv));
		case "nice": return unwrapDispatchWrapper(wrapper, unwrapNiceInvocation(argv));
		case "nohup": return unwrapDispatchWrapper(wrapper, unwrapNohupInvocation(argv));
		case "stdbuf": return unwrapDispatchWrapper(wrapper, unwrapStdbufInvocation(argv));
		case "timeout": return unwrapDispatchWrapper(wrapper, unwrapTimeoutInvocation(argv));
		case "chrt":
		case "doas":
		case "ionice":
		case "setsid":
		case "sudo":
		case "taskset": return blockDispatchWrapper(wrapper);
		default: return { kind: "not-wrapper" };
	}
}
function isSemanticDispatchWrapperUsage(wrapper, argv) {
	if (wrapper === "env") return envInvocationUsesModifiers(argv);
	return !TRANSPARENT_DISPATCH_WRAPPERS.has(wrapper);
}
function blockedDispatchWrapperPlan(params) {
	return {
		argv: params.argv,
		wrappers: params.wrappers,
		policyBlocked: true,
		blockedWrapper: params.blockedWrapper
	};
}
function resolveDispatchWrapperExecutionPlan(argv, maxDepth = MAX_DISPATCH_WRAPPER_DEPTH) {
	let current = argv;
	const wrappers = [];
	for (let depth = 0; depth < maxDepth; depth += 1) {
		const unwrap = unwrapKnownDispatchWrapperInvocation(current);
		if (unwrap.kind === "blocked") return blockedDispatchWrapperPlan({
			argv: current,
			wrappers,
			blockedWrapper: unwrap.wrapper
		});
		if (unwrap.kind !== "unwrapped" || unwrap.argv.length === 0) break;
		wrappers.push(unwrap.wrapper);
		if (isSemanticDispatchWrapperUsage(unwrap.wrapper, current)) return blockedDispatchWrapperPlan({
			argv: current,
			wrappers,
			blockedWrapper: unwrap.wrapper
		});
		current = unwrap.argv;
	}
	if (wrappers.length >= maxDepth) {
		const overflow = unwrapKnownDispatchWrapperInvocation(current);
		if (overflow.kind === "blocked" || overflow.kind === "unwrapped") return blockedDispatchWrapperPlan({
			argv: current,
			wrappers,
			blockedWrapper: overflow.wrapper
		});
	}
	return {
		argv: current,
		wrappers,
		policyBlocked: false
	};
}
function extractPosixShellInlineCommand(argv) {
	return extractInlineCommandByFlags(argv, POSIX_INLINE_COMMAND_FLAGS, { allowCombinedC: true });
}
function extractCmdInlineCommand(argv) {
	const idx = argv.findIndex((item) => {
		const token = item.trim().toLowerCase();
		return token === "/c" || token === "/k";
	});
	if (idx === -1) return null;
	const tail = argv.slice(idx + 1);
	if (tail.length === 0) return null;
	const cmd = tail.join(" ").trim();
	return cmd.length > 0 ? cmd : null;
}
function extractPowerShellInlineCommand(argv) {
	return extractInlineCommandByFlags(argv, POWERSHELL_INLINE_COMMAND_FLAGS);
}
function extractInlineCommandByFlags(argv, flags, options = {}) {
	for (let i = 1; i < argv.length; i += 1) {
		const token = argv[i]?.trim();
		if (!token) continue;
		const lower = token.toLowerCase();
		if (lower === "--") break;
		if (flags.has(lower)) {
			const cmd = argv[i + 1]?.trim();
			return cmd ? cmd : null;
		}
		if (options.allowCombinedC && /^-[^-]*c[^-]*$/i.test(token)) {
			const commandIndex = lower.indexOf("c");
			const inline = token.slice(commandIndex + 1).trim();
			if (inline) return inline;
			const cmd = argv[i + 1]?.trim();
			return cmd ? cmd : null;
		}
	}
	return null;
}
function extractShellWrapperPayload(argv, spec) {
	switch (spec.kind) {
		case "posix": return extractPosixShellInlineCommand(argv);
		case "cmd": return extractCmdInlineCommand(argv);
		case "powershell": return extractPowerShellInlineCommand(argv);
	}
}
function extractShellWrapperCommandInternal(argv, rawCommand, depth) {
	if (depth >= MAX_DISPATCH_WRAPPER_DEPTH) return {
		isWrapper: false,
		command: null
	};
	const token0 = argv[0]?.trim();
	if (!token0) return {
		isWrapper: false,
		command: null
	};
	const dispatchUnwrap = unwrapKnownDispatchWrapperInvocation(argv);
	if (dispatchUnwrap.kind === "blocked") return {
		isWrapper: false,
		command: null
	};
	if (dispatchUnwrap.kind === "unwrapped") return extractShellWrapperCommandInternal(dispatchUnwrap.argv, rawCommand, depth + 1);
	const shellMultiplexerUnwrap = unwrapKnownShellMultiplexerInvocation(argv);
	if (shellMultiplexerUnwrap.kind === "blocked") return {
		isWrapper: false,
		command: null
	};
	if (shellMultiplexerUnwrap.kind === "unwrapped") return extractShellWrapperCommandInternal(shellMultiplexerUnwrap.argv, rawCommand, depth + 1);
	const wrapper = findShellWrapperSpec(normalizeExecutableToken(token0));
	if (!wrapper) return {
		isWrapper: false,
		command: null
	};
	const payload = extractShellWrapperPayload(argv, wrapper);
	if (!payload) return {
		isWrapper: false,
		command: null
	};
	return {
		isWrapper: true,
		command: rawCommand ?? payload
	};
}
function extractShellWrapperInlineCommand(argv) {
	const extracted = extractShellWrapperCommandInternal(argv, null, 0);
	return extracted.isWrapper ? extracted.command : null;
}

//#endregion
//#region src/infra/exec-command-resolution.ts
const DEFAULT_SAFE_BINS = [
	"jq",
	"cut",
	"uniq",
	"head",
	"tail",
	"tr",
	"wc"
];
function isExecutableFile(filePath) {
	try {
		if (!syncFs.statSync(filePath).isFile()) return false;
		if (process.platform !== "win32") syncFs.accessSync(filePath, syncFs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
function resolveExecutablePath(rawExecutable, cwd, env) {
	const expanded = rawExecutable.startsWith("~") ? expandHomePrefix(rawExecutable) : rawExecutable;
	if (expanded.includes("/") || expanded.includes("\\")) {
		if (path.isAbsolute(expanded)) return isExecutableFile(expanded) ? expanded : void 0;
		const base = cwd && cwd.trim() ? cwd.trim() : process.cwd();
		const candidate = path.resolve(base, expanded);
		return isExecutableFile(candidate) ? candidate : void 0;
	}
	const entries = (env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
	const hasExtension = process.platform === "win32" && path.extname(expanded).length > 0;
	const extensions = process.platform === "win32" ? hasExtension ? [""] : (env?.PATHEXT ?? env?.Pathext ?? process.env.PATHEXT ?? process.env.Pathext ?? ".EXE;.CMD;.BAT;.COM").split(";").map((ext) => ext.toLowerCase()) : [""];
	for (const entry of entries) for (const ext of extensions) {
		const candidate = path.join(entry, expanded + ext);
		if (isExecutableFile(candidate)) return candidate;
	}
}
function resolveCommandResolutionFromArgv(argv, cwd, env) {
	const plan = resolveDispatchWrapperExecutionPlan(argv);
	const effectiveArgv = plan.argv;
	const rawExecutable = effectiveArgv[0]?.trim();
	if (!rawExecutable) return null;
	const resolvedPath = resolveExecutablePath(rawExecutable, cwd, env);
	return {
		rawExecutable,
		resolvedPath,
		executableName: resolvedPath ? path.basename(resolvedPath) : rawExecutable,
		effectiveArgv,
		wrapperChain: plan.wrappers,
		policyBlocked: plan.policyBlocked,
		blockedWrapper: plan.blockedWrapper
	};
}
function normalizeMatchTarget(value) {
	if (process.platform === "win32") return value.replace(/^\\\\[?.]\\/, "").replace(/\\/g, "/").toLowerCase();
	return value.replace(/\\\\/g, "/").toLowerCase();
}
function tryRealpath(value) {
	try {
		return syncFs.realpathSync(value);
	} catch {
		return null;
	}
}
function globToRegExp(pattern) {
	let regex = "^";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				regex += ".*";
				i += 2;
				continue;
			}
			regex += "[^/]*";
			i += 1;
			continue;
		}
		if (ch === "?") {
			regex += ".";
			i += 1;
			continue;
		}
		regex += ch.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&");
		i += 1;
	}
	regex += "$";
	return new RegExp(regex, "i");
}
function matchesPattern(pattern, target) {
	const trimmed = pattern.trim();
	if (!trimmed) return false;
	const expanded = trimmed.startsWith("~") ? expandHomePrefix(trimmed) : trimmed;
	const hasWildcard = /[*?]/.test(expanded);
	let normalizedPattern = expanded;
	let normalizedTarget = target;
	if (process.platform === "win32" && !hasWildcard) {
		normalizedPattern = tryRealpath(expanded) ?? expanded;
		normalizedTarget = tryRealpath(target) ?? target;
	}
	normalizedPattern = normalizeMatchTarget(normalizedPattern);
	normalizedTarget = normalizeMatchTarget(normalizedTarget);
	return globToRegExp(normalizedPattern).test(normalizedTarget);
}
function resolveAllowlistCandidatePath(resolution, cwd) {
	if (!resolution) return;
	if (resolution.resolvedPath) return resolution.resolvedPath;
	const raw = resolution.rawExecutable?.trim();
	if (!raw) return;
	const expanded = raw.startsWith("~") ? expandHomePrefix(raw) : raw;
	if (!expanded.includes("/") && !expanded.includes("\\")) return;
	if (path.isAbsolute(expanded)) return expanded;
	const base = cwd && cwd.trim() ? cwd.trim() : process.cwd();
	return path.resolve(base, expanded);
}
function matchAllowlist(entries, resolution) {
	if (!entries.length) return null;
	const bareWild = entries.find((e) => e.pattern?.trim() === "*");
	if (bareWild && resolution) return bareWild;
	if (!resolution?.resolvedPath) return null;
	const resolvedPath = resolution.resolvedPath;
	for (const entry of entries) {
		const pattern = entry.pattern?.trim();
		if (!pattern) continue;
		if (!(pattern.includes("/") || pattern.includes("\\") || pattern.includes("~"))) continue;
		if (matchesPattern(pattern, resolvedPath)) return entry;
	}
	return null;
}
/**
* Tokenizes a single argv entry into a normalized option/positional model.
* Consumers can share this model to keep argv parsing behavior consistent.
*/
function parseExecArgvToken(raw) {
	if (!raw) return {
		kind: "empty",
		raw
	};
	if (raw === "--") return {
		kind: "terminator",
		raw
	};
	if (raw === "-") return {
		kind: "stdin",
		raw
	};
	if (!raw.startsWith("-")) return {
		kind: "positional",
		raw
	};
	if (raw.startsWith("--")) {
		const eqIndex = raw.indexOf("=");
		if (eqIndex > 0) return {
			kind: "option",
			raw,
			style: "long",
			flag: raw.slice(0, eqIndex),
			inlineValue: raw.slice(eqIndex + 1)
		};
		return {
			kind: "option",
			raw,
			style: "long",
			flag: raw
		};
	}
	const cluster = raw.slice(1);
	return {
		kind: "option",
		raw,
		style: "short-cluster",
		cluster,
		flags: cluster.split("").map((entry) => `-${entry}`)
	};
}

//#endregion
//#region src/infra/exec-approvals-analysis.ts
const DISALLOWED_PIPELINE_TOKENS = new Set([
	">",
	"<",
	"`",
	"\n",
	"\r",
	"(",
	")"
]);
const DOUBLE_QUOTE_ESCAPES = new Set([
	"\\",
	"\"",
	"$",
	"`"
]);
const WINDOWS_UNSUPPORTED_TOKENS = new Set([
	"&",
	"|",
	"<",
	">",
	"^",
	"(",
	")",
	"%",
	"!",
	"\n",
	"\r"
]);
function isDoubleQuoteEscape(next) {
	return Boolean(next && DOUBLE_QUOTE_ESCAPES.has(next));
}
function isEscapedLineContinuation(next) {
	return next === "\n" || next === "\r";
}
function splitShellPipeline(command) {
	const parseHeredocDelimiter = (source, start) => {
		let i = start;
		while (i < source.length && (source[i] === " " || source[i] === "	")) i += 1;
		if (i >= source.length) return null;
		const first = source[i];
		if (first === "'" || first === "\"") {
			const quote = first;
			i += 1;
			let delimiter = "";
			while (i < source.length) {
				const ch = source[i];
				if (ch === "\n" || ch === "\r") return null;
				if (quote === "\"" && ch === "\\" && i + 1 < source.length) {
					delimiter += source[i + 1];
					i += 2;
					continue;
				}
				if (ch === quote) return {
					delimiter,
					end: i + 1,
					quoted: true
				};
				delimiter += ch;
				i += 1;
			}
			return null;
		}
		let delimiter = "";
		while (i < source.length) {
			const ch = source[i];
			if (/\s/.test(ch) || ch === "|" || ch === "&" || ch === ";" || ch === "<" || ch === ">") break;
			delimiter += ch;
			i += 1;
		}
		if (!delimiter) return null;
		return {
			delimiter,
			end: i,
			quoted: false
		};
	};
	const segments = [];
	let buf = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	let emptySegment = false;
	const pendingHeredocs = [];
	let inHeredocBody = false;
	let heredocLine = "";
	const pushPart = () => {
		const trimmed = buf.trim();
		if (trimmed) segments.push(trimmed);
		buf = "";
	};
	const isEscapedInHeredocLine = (line, index) => {
		let slashes = 0;
		for (let i = index - 1; i >= 0 && line[i] === "\\"; i -= 1) slashes += 1;
		return slashes % 2 === 1;
	};
	const hasUnquotedHeredocExpansionToken = (line) => {
		for (let i = 0; i < line.length; i += 1) {
			const ch = line[i];
			if (ch === "`" && !isEscapedInHeredocLine(line, i)) return true;
			if (ch === "$" && !isEscapedInHeredocLine(line, i)) {
				const next = line[i + 1];
				if (next === "(" || next === "{") return true;
			}
		}
		return false;
	};
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		const next = command[i + 1];
		if (inHeredocBody) {
			if (ch === "\n" || ch === "\r") {
				const current = pendingHeredocs[0];
				if (current) {
					if ((current.stripTabs ? heredocLine.replace(/^\t+/, "") : heredocLine) === current.delimiter) pendingHeredocs.shift();
					else if (!current.quoted && hasUnquotedHeredocExpansionToken(heredocLine)) return {
						ok: false,
						reason: "command substitution in unquoted heredoc",
						segments: []
					};
				}
				heredocLine = "";
				if (pendingHeredocs.length === 0) inHeredocBody = false;
				if (ch === "\r" && next === "\n") i += 1;
			} else heredocLine += ch;
			continue;
		}
		if (escaped) {
			buf += ch;
			escaped = false;
			emptySegment = false;
			continue;
		}
		if (!inSingle && !inDouble && ch === "\\") {
			escaped = true;
			buf += ch;
			emptySegment = false;
			continue;
		}
		if (inSingle) {
			if (ch === "'") inSingle = false;
			buf += ch;
			emptySegment = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && isEscapedLineContinuation(next)) return {
				ok: false,
				reason: "unsupported shell token: newline",
				segments: []
			};
			if (ch === "\\" && isDoubleQuoteEscape(next)) {
				buf += ch;
				buf += next;
				i += 1;
				emptySegment = false;
				continue;
			}
			if (ch === "$" && next === "(") return {
				ok: false,
				reason: "unsupported shell token: $()",
				segments: []
			};
			if (ch === "`") return {
				ok: false,
				reason: "unsupported shell token: `",
				segments: []
			};
			if (ch === "\n" || ch === "\r") return {
				ok: false,
				reason: "unsupported shell token: newline",
				segments: []
			};
			if (ch === "\"") inDouble = false;
			buf += ch;
			emptySegment = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			buf += ch;
			emptySegment = false;
			continue;
		}
		if (ch === "\"") {
			inDouble = true;
			buf += ch;
			emptySegment = false;
			continue;
		}
		if ((ch === "\n" || ch === "\r") && pendingHeredocs.length > 0) {
			inHeredocBody = true;
			heredocLine = "";
			if (ch === "\r" && next === "\n") i += 1;
			continue;
		}
		if (ch === "|" && next === "|") return {
			ok: false,
			reason: "unsupported shell token: ||",
			segments: []
		};
		if (ch === "|" && next === "&") return {
			ok: false,
			reason: "unsupported shell token: |&",
			segments: []
		};
		if (ch === "|") {
			emptySegment = true;
			pushPart();
			continue;
		}
		if (ch === "&" || ch === ";") return {
			ok: false,
			reason: `unsupported shell token: ${ch}`,
			segments: []
		};
		if (ch === "<" && next === "<") {
			buf += "<<";
			emptySegment = false;
			i += 1;
			let scanIndex = i + 1;
			let stripTabs = false;
			if (command[scanIndex] === "-") {
				stripTabs = true;
				buf += "-";
				scanIndex += 1;
			}
			const parsed = parseHeredocDelimiter(command, scanIndex);
			if (parsed) {
				pendingHeredocs.push({
					delimiter: parsed.delimiter,
					stripTabs,
					quoted: parsed.quoted
				});
				buf += command.slice(scanIndex, parsed.end);
				i = parsed.end - 1;
			}
			continue;
		}
		if (DISALLOWED_PIPELINE_TOKENS.has(ch)) return {
			ok: false,
			reason: `unsupported shell token: ${ch}`,
			segments: []
		};
		if (ch === "$" && next === "(") return {
			ok: false,
			reason: "unsupported shell token: $()",
			segments: []
		};
		buf += ch;
		emptySegment = false;
	}
	if (inHeredocBody && pendingHeredocs.length > 0) {
		const current = pendingHeredocs[0];
		if ((current.stripTabs ? heredocLine.replace(/^\t+/, "") : heredocLine) === current.delimiter) {
			pendingHeredocs.shift();
			if (pendingHeredocs.length === 0) inHeredocBody = false;
		}
	}
	if (pendingHeredocs.length > 0 || inHeredocBody) return {
		ok: false,
		reason: "unterminated heredoc",
		segments: []
	};
	if (escaped || inSingle || inDouble) return {
		ok: false,
		reason: "unterminated shell quote/escape",
		segments: []
	};
	pushPart();
	if (emptySegment || segments.length === 0) return {
		ok: false,
		reason: segments.length === 0 ? "empty command" : "empty pipeline segment",
		segments: []
	};
	return {
		ok: true,
		segments
	};
}
function findWindowsUnsupportedToken(command) {
	for (const ch of command) if (WINDOWS_UNSUPPORTED_TOKENS.has(ch)) {
		if (ch === "\n" || ch === "\r") return "newline";
		return ch;
	}
	return null;
}
function tokenizeWindowsSegment(segment) {
	const tokens = [];
	let buf = "";
	let inDouble = false;
	const pushToken = () => {
		if (buf.length > 0) {
			tokens.push(buf);
			buf = "";
		}
	};
	for (let i = 0; i < segment.length; i += 1) {
		const ch = segment[i];
		if (ch === "\"") {
			inDouble = !inDouble;
			continue;
		}
		if (!inDouble && /\s/.test(ch)) {
			pushToken();
			continue;
		}
		buf += ch;
	}
	if (inDouble) return null;
	pushToken();
	return tokens.length > 0 ? tokens : null;
}
function analyzeWindowsShellCommand(params) {
	const unsupported = findWindowsUnsupportedToken(params.command);
	if (unsupported) return {
		ok: false,
		reason: `unsupported windows shell token: ${unsupported}`,
		segments: []
	};
	const argv = tokenizeWindowsSegment(params.command);
	if (!argv || argv.length === 0) return {
		ok: false,
		reason: "unable to parse windows command",
		segments: []
	};
	return {
		ok: true,
		segments: [{
			raw: params.command,
			argv,
			resolution: resolveCommandResolutionFromArgv(argv, params.cwd, params.env)
		}]
	};
}
function isWindowsPlatform(platform) {
	return String(platform ?? "").trim().toLowerCase().startsWith("win");
}
function parseSegmentsFromParts(parts, cwd, env) {
	const segments = [];
	for (const raw of parts) {
		const argv = splitShellArgs(raw);
		if (!argv || argv.length === 0) return null;
		segments.push({
			raw,
			argv,
			resolution: resolveCommandResolutionFromArgv(argv, cwd, env)
		});
	}
	return segments;
}
/**
* Splits a command string by chain operators (&&, ||, ;) while preserving the operators.
* Returns null when no chain is present or when the chain is malformed.
*/
function splitCommandChainWithOperators(command) {
	const parts = [];
	let buf = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	let foundChain = false;
	let invalidChain = false;
	const pushPart = (opToNext) => {
		const trimmed = buf.trim();
		buf = "";
		if (!trimmed) return false;
		parts.push({
			part: trimmed,
			opToNext
		});
		return true;
	};
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		const next = command[i + 1];
		if (escaped) {
			buf += ch;
			escaped = false;
			continue;
		}
		if (!inSingle && !inDouble && ch === "\\") {
			escaped = true;
			buf += ch;
			continue;
		}
		if (inSingle) {
			if (ch === "'") inSingle = false;
			buf += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && isEscapedLineContinuation(next)) {
				invalidChain = true;
				break;
			}
			if (ch === "\\" && isDoubleQuoteEscape(next)) {
				buf += ch;
				buf += next;
				i += 1;
				continue;
			}
			if (ch === "\"") inDouble = false;
			buf += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			buf += ch;
			continue;
		}
		if (ch === "\"") {
			inDouble = true;
			buf += ch;
			continue;
		}
		if (ch === "&" && next === "&") {
			if (!pushPart("&&")) invalidChain = true;
			i += 1;
			foundChain = true;
			continue;
		}
		if (ch === "|" && next === "|") {
			if (!pushPart("||")) invalidChain = true;
			i += 1;
			foundChain = true;
			continue;
		}
		if (ch === ";") {
			if (!pushPart(";")) invalidChain = true;
			foundChain = true;
			continue;
		}
		buf += ch;
	}
	if (!foundChain) return null;
	const trimmed = buf.trim();
	if (!trimmed) return null;
	parts.push({
		part: trimmed,
		opToNext: null
	});
	if (invalidChain || parts.length === 0) return null;
	return parts;
}
function shellEscapeSingleArg(value) {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function rebuildShellCommandFromSource(params) {
	if (isWindowsPlatform(params.platform ?? null)) return {
		ok: false,
		reason: "unsupported platform"
	};
	const source = params.command.trim();
	if (!source) return {
		ok: false,
		reason: "empty command"
	};
	const chainParts = splitCommandChainWithOperators(source) ?? [{
		part: source,
		opToNext: null
	}];
	let segmentCount = 0;
	let out = "";
	for (const part of chainParts) {
		const pipelineSplit = splitShellPipeline(part.part);
		if (!pipelineSplit.ok) return {
			ok: false,
			reason: pipelineSplit.reason ?? "unable to parse pipeline"
		};
		const renderedSegments = [];
		for (const segmentRaw of pipelineSplit.segments) {
			const rendered = params.renderSegment(segmentRaw, segmentCount);
			if (!rendered.ok) return {
				ok: false,
				reason: rendered.reason
			};
			renderedSegments.push(rendered.rendered);
			segmentCount += 1;
		}
		out += renderedSegments.join(" | ");
		if (part.opToNext) out += ` ${part.opToNext} `;
	}
	return {
		ok: true,
		command: out,
		segmentCount
	};
}
function renderQuotedArgv(argv) {
	return argv.map((token) => shellEscapeSingleArg(token)).join(" ");
}
function resolvePlannedSegmentArgv(segment) {
	if (segment.resolution?.policyBlocked === true) return null;
	const baseArgv = segment.resolution?.effectiveArgv && segment.resolution.effectiveArgv.length > 0 ? segment.resolution.effectiveArgv : segment.argv;
	if (baseArgv.length === 0) return null;
	const argv = [...baseArgv];
	const resolvedExecutable = segment.resolution?.resolvedPath?.trim() ?? "";
	if (resolvedExecutable) argv[0] = resolvedExecutable;
	return argv;
}
function buildEnforcedShellCommand(params) {
	const rebuilt = rebuildShellCommandFromSource({
		command: params.command,
		platform: params.platform,
		renderSegment: (_raw, segmentIndex) => {
			const seg = params.segments[segmentIndex];
			if (!seg) return {
				ok: false,
				reason: "segment mapping failed"
			};
			const argv = resolvePlannedSegmentArgv(seg);
			if (!argv) return {
				ok: false,
				reason: "segment execution plan unavailable"
			};
			return {
				ok: true,
				rendered: renderQuotedArgv(argv)
			};
		}
	});
	if (!rebuilt.ok) return {
		ok: false,
		reason: rebuilt.reason
	};
	if (rebuilt.segmentCount !== params.segments.length) return {
		ok: false,
		reason: "segment count mismatch"
	};
	return {
		ok: true,
		command: rebuilt.command
	};
}
/**
* Splits a command string by chain operators (&&, ||, ;) while respecting quotes.
* Returns null when no chain is present or when the chain is malformed.
*/
function splitCommandChain(command) {
	const parts = splitCommandChainWithOperators(command);
	if (!parts) return null;
	return parts.map((p) => p.part);
}
function analyzeShellCommand(params) {
	if (isWindowsPlatform(params.platform)) return analyzeWindowsShellCommand(params);
	const chainParts = splitCommandChain(params.command);
	if (chainParts) {
		const chains = [];
		const allSegments = [];
		for (const part of chainParts) {
			const pipelineSplit = splitShellPipeline(part);
			if (!pipelineSplit.ok) return {
				ok: false,
				reason: pipelineSplit.reason,
				segments: []
			};
			const segments = parseSegmentsFromParts(pipelineSplit.segments, params.cwd, params.env);
			if (!segments) return {
				ok: false,
				reason: "unable to parse shell segment",
				segments: []
			};
			chains.push(segments);
			allSegments.push(...segments);
		}
		return {
			ok: true,
			segments: allSegments,
			chains
		};
	}
	const split = splitShellPipeline(params.command);
	if (!split.ok) return {
		ok: false,
		reason: split.reason,
		segments: []
	};
	const segments = parseSegmentsFromParts(split.segments, params.cwd, params.env);
	if (!segments) return {
		ok: false,
		reason: "unable to parse shell segment",
		segments: []
	};
	return {
		ok: true,
		segments
	};
}

//#endregion
//#region src/infra/exec-safe-bin-policy-validator.ts
function isPathLikeToken(value) {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (trimmed === "-") return false;
	if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~")) return true;
	if (trimmed.startsWith("/")) return true;
	return /^[A-Za-z]:[\\/]/.test(trimmed);
}
function hasGlobToken(value) {
	return /[*?[\]]/.test(value);
}
const NO_FLAGS = /* @__PURE__ */ new Set();
function isSafeLiteralToken(value) {
	if (!value || value === "-") return true;
	return !hasGlobToken(value) && !isPathLikeToken(value);
}
function isInvalidValueToken(value) {
	return !value || !isSafeLiteralToken(value);
}
function resolveCanonicalLongFlag(params) {
	if (!params.flag.startsWith("--") || params.flag.length <= 2) return null;
	if (params.knownLongFlagsSet.has(params.flag)) return params.flag;
	return params.longFlagPrefixMap.get(params.flag) ?? null;
}
function consumeLongOptionToken(params) {
	const canonicalFlag = resolveCanonicalLongFlag({
		flag: params.flag,
		knownLongFlagsSet: params.knownLongFlagsSet,
		longFlagPrefixMap: params.longFlagPrefixMap
	});
	if (!canonicalFlag) return -1;
	if (params.deniedFlags.has(canonicalFlag)) return -1;
	const expectsValue = params.allowedValueFlags.has(canonicalFlag);
	if (params.inlineValue !== void 0) {
		if (!expectsValue) return -1;
		return isSafeLiteralToken(params.inlineValue) ? params.index + 1 : -1;
	}
	if (!expectsValue) return params.index + 1;
	return isInvalidValueToken(params.args[params.index + 1]) ? -1 : params.index + 2;
}
function consumeShortOptionClusterToken(params) {
	for (let j = 0; j < params.flags.length; j += 1) {
		const flag = params.flags[j];
		if (params.deniedFlags.has(flag)) return -1;
		if (!params.allowedValueFlags.has(flag)) continue;
		const inlineValue = params.cluster.slice(j + 1);
		if (inlineValue) return isSafeLiteralToken(inlineValue) ? params.index + 1 : -1;
		return isInvalidValueToken(params.args[params.index + 1]) ? -1 : params.index + 2;
	}
	return -1;
}
function consumePositionalToken(token, positional) {
	if (!isSafeLiteralToken(token)) return false;
	positional.push(token);
	return true;
}
function validatePositionalCount(positional, profile) {
	const minPositional = profile.minPositional ?? 0;
	if (positional.length < minPositional) return false;
	return typeof profile.maxPositional !== "number" || positional.length <= profile.maxPositional;
}
function validateSafeBinArgv(args, profile) {
	const allowedValueFlags = profile.allowedValueFlags ?? NO_FLAGS;
	const deniedFlags = profile.deniedFlags ?? NO_FLAGS;
	const knownLongFlags = profile.knownLongFlags ?? collectKnownLongFlags(allowedValueFlags, deniedFlags);
	const knownLongFlagsSet = profile.knownLongFlagsSet ?? new Set(knownLongFlags);
	const longFlagPrefixMap = profile.longFlagPrefixMap ?? buildLongFlagPrefixMap(knownLongFlags);
	const positional = [];
	let i = 0;
	while (i < args.length) {
		const token = parseExecArgvToken(args[i] ?? "");
		if (token.kind === "empty" || token.kind === "stdin") {
			i += 1;
			continue;
		}
		if (token.kind === "terminator") {
			for (let j = i + 1; j < args.length; j += 1) {
				const rest = args[j];
				if (!rest || rest === "-") continue;
				if (!consumePositionalToken(rest, positional)) return false;
			}
			break;
		}
		if (token.kind === "positional") {
			if (!consumePositionalToken(token.raw, positional)) return false;
			i += 1;
			continue;
		}
		if (token.style === "long") {
			const nextIndex = consumeLongOptionToken({
				args,
				index: i,
				flag: token.flag,
				inlineValue: token.inlineValue,
				allowedValueFlags,
				deniedFlags,
				knownLongFlagsSet,
				longFlagPrefixMap
			});
			if (nextIndex < 0) return false;
			i = nextIndex;
			continue;
		}
		const nextIndex = consumeShortOptionClusterToken({
			args,
			index: i,
			cluster: token.cluster,
			flags: token.flags,
			allowedValueFlags,
			deniedFlags
		});
		if (nextIndex < 0) return false;
		i = nextIndex;
	}
	return validatePositionalCount(positional, profile);
}

//#endregion
//#region src/infra/exec-safe-bin-trust.ts
const DEFAULT_SAFE_BIN_TRUSTED_DIRS = ["/bin", "/usr/bin"];
let trustedSafeBinCache = null;
function normalizeTrustedDir(value) {
	const trimmed = value.trim();
	if (!trimmed) return null;
	return path.resolve(trimmed);
}
function normalizeTrustedSafeBinDirs(entries) {
	if (!Array.isArray(entries)) return [];
	const normalized = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	return Array.from(new Set(normalized));
}
function resolveTrustedSafeBinDirs(entries) {
	const resolved = entries.map((entry) => normalizeTrustedDir(entry)).filter((entry) => Boolean(entry));
	return Array.from(new Set(resolved)).toSorted();
}
function buildTrustedSafeBinCacheKey(entries) {
	return resolveTrustedSafeBinDirs(normalizeTrustedSafeBinDirs(entries)).join("");
}
function buildTrustedSafeBinDirs(params = {}) {
	const baseDirs = params.baseDirs ?? DEFAULT_SAFE_BIN_TRUSTED_DIRS;
	const extraDirs = params.extraDirs ?? [];
	return new Set(resolveTrustedSafeBinDirs([...normalizeTrustedSafeBinDirs(baseDirs), ...normalizeTrustedSafeBinDirs(extraDirs)]));
}
function getTrustedSafeBinDirs(params = {}) {
	const baseDirs = params.baseDirs ?? DEFAULT_SAFE_BIN_TRUSTED_DIRS;
	const extraDirs = params.extraDirs ?? [];
	const key = buildTrustedSafeBinCacheKey([...baseDirs, ...extraDirs]);
	if (!params.refresh && trustedSafeBinCache?.key === key) return trustedSafeBinCache.dirs;
	const dirs = buildTrustedSafeBinDirs({
		baseDirs,
		extraDirs
	});
	trustedSafeBinCache = {
		key,
		dirs
	};
	return dirs;
}
function isTrustedSafeBinPath(params) {
	const trustedDirs = params.trustedDirs ?? getTrustedSafeBinDirs();
	const resolvedDir = path.dirname(path.resolve(params.resolvedPath));
	return trustedDirs.has(resolvedDir);
}
function listWritableExplicitTrustedSafeBinDirs(entries) {
	if (process.platform === "win32") return [];
	const resolved = resolveTrustedSafeBinDirs(normalizeTrustedSafeBinDirs(entries));
	const hits = [];
	for (const dir of resolved) {
		let stat;
		try {
			stat = syncFs.statSync(dir);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;
		const mode = stat.mode & 511;
		const groupWritable = (mode & 16) !== 0;
		const worldWritable = (mode & 2) !== 0;
		if (!groupWritable && !worldWritable) continue;
		hits.push({
			dir,
			groupWritable,
			worldWritable
		});
	}
	return hits;
}

//#endregion
//#region src/config/normalize-exec-safe-bin.ts
function normalizeExecSafeBinProfilesInConfig(cfg) {
	const normalizeExec = (exec) => {
		if (!exec || typeof exec !== "object" || Array.isArray(exec)) return;
		const typedExec = exec;
		const normalizedProfiles = normalizeSafeBinProfileFixtures(typedExec.safeBinProfiles);
		typedExec.safeBinProfiles = Object.keys(normalizedProfiles).length > 0 ? normalizedProfiles : void 0;
		const normalizedTrustedDirs = normalizeTrustedSafeBinDirs(typedExec.safeBinTrustedDirs);
		typedExec.safeBinTrustedDirs = normalizedTrustedDirs.length > 0 ? normalizedTrustedDirs : void 0;
	};
	normalizeExec(cfg.tools?.exec);
	const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
	for (const agent of agents) normalizeExec(agent?.tools?.exec);
}

//#endregion
//#region src/config/normalize-paths.ts
const PATH_VALUE_RE = /^~(?=$|[\\/])/;
const PATH_KEY_RE = /(dir|path|paths|file|root|workspace)$/i;
const PATH_LIST_KEYS = new Set(["paths", "pathPrepend"]);
function normalizeStringValue(key, value) {
	if (!PATH_VALUE_RE.test(value.trim())) return value;
	if (!key) return value;
	if (PATH_KEY_RE.test(key) || PATH_LIST_KEYS.has(key)) return resolveUserPath(value);
	return value;
}
function normalizeAny(key, value) {
	if (typeof value === "string") return normalizeStringValue(key, value);
	if (Array.isArray(value)) {
		const normalizeChildren = Boolean(key && PATH_LIST_KEYS.has(key));
		return value.map((entry) => {
			if (typeof entry === "string") return normalizeChildren ? normalizeStringValue(key, entry) : entry;
			if (Array.isArray(entry)) return normalizeAny(void 0, entry);
			if (isPlainObject$2(entry)) return normalizeAny(void 0, entry);
			return entry;
		});
	}
	if (!isPlainObject$2(value)) return value;
	for (const [childKey, childValue] of Object.entries(value)) {
		const next = normalizeAny(childKey, childValue);
		if (next !== childValue) value[childKey] = next;
	}
	return value;
}
/**
* Normalize "~" paths in path-ish config fields.
*
* Goal: accept `~/...` consistently across config file + env overrides, while
* keeping the surface area small and predictable.
*/
function normalizeConfigPaths(cfg) {
	if (!cfg || typeof cfg !== "object") return cfg;
	normalizeAny(void 0, cfg);
	return cfg;
}

//#endregion
//#region src/config/config-paths.ts
function parseConfigPath(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return {
		ok: false,
		error: "Invalid path. Use dot notation (e.g. foo.bar)."
	};
	const parts = trimmed.split(".").map((part) => part.trim());
	if (parts.some((part) => !part)) return {
		ok: false,
		error: "Invalid path. Use dot notation (e.g. foo.bar)."
	};
	if (parts.some((part) => isBlockedObjectKey(part))) return {
		ok: false,
		error: "Invalid path segment."
	};
	return {
		ok: true,
		path: parts
	};
}
function setConfigValueAtPath(root, path, value) {
	let cursor = root;
	for (let idx = 0; idx < path.length - 1; idx += 1) {
		const key = path[idx];
		const next = cursor[key];
		if (!isPlainObject$2(next)) cursor[key] = {};
		cursor = cursor[key];
	}
	cursor[path[path.length - 1]] = value;
}
function unsetConfigValueAtPath(root, path) {
	const stack = [];
	let cursor = root;
	for (let idx = 0; idx < path.length - 1; idx += 1) {
		const key = path[idx];
		const next = cursor[key];
		if (!isPlainObject$2(next)) return false;
		stack.push({
			node: cursor,
			key
		});
		cursor = next;
	}
	const leafKey = path[path.length - 1];
	if (!(leafKey in cursor)) return false;
	delete cursor[leafKey];
	for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
		const { node, key } = stack[idx];
		const child = node[key];
		if (isPlainObject$2(child) && Object.keys(child).length === 0) delete node[key];
		else break;
	}
	return true;
}
function getConfigValueAtPath(root, path) {
	let cursor = root;
	for (const key of path) {
		if (!isPlainObject$2(cursor)) return;
		cursor = cursor[key];
	}
	return cursor;
}

//#endregion
//#region src/config/runtime-overrides.ts
let overrides = {};
function sanitizeOverrideValue(value, seen = /* @__PURE__ */ new WeakSet()) {
	if (Array.isArray(value)) return value.map((entry) => sanitizeOverrideValue(entry, seen));
	if (!isPlainObject$2(value)) return value;
	if (seen.has(value)) return {};
	seen.add(value);
	const sanitized = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry === void 0 || isBlockedObjectKey(key)) continue;
		sanitized[key] = sanitizeOverrideValue(entry, seen);
	}
	seen.delete(value);
	return sanitized;
}
function mergeOverrides(base, override) {
	if (!isPlainObject$2(base) || !isPlainObject$2(override)) return override;
	const next = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value === void 0 || isBlockedObjectKey(key)) continue;
		next[key] = mergeOverrides(base[key], value);
	}
	return next;
}
function getConfigOverrides() {
	return overrides;
}
function resetConfigOverrides() {
	overrides = {};
}
function setConfigOverride(pathRaw, value) {
	const parsed = parseConfigPath(pathRaw);
	if (!parsed.ok || !parsed.path) return {
		ok: false,
		error: parsed.error ?? "Invalid path."
	};
	setConfigValueAtPath(overrides, parsed.path, sanitizeOverrideValue(value));
	return { ok: true };
}
function unsetConfigOverride(pathRaw) {
	const parsed = parseConfigPath(pathRaw);
	if (!parsed.ok || !parsed.path) return {
		ok: false,
		removed: false,
		error: parsed.error ?? "Invalid path."
	};
	return {
		ok: true,
		removed: unsetConfigValueAtPath(overrides, parsed.path)
	};
}
function applyConfigOverrides(cfg) {
	if (!overrides || Object.keys(overrides).length === 0) return cfg;
	return mergeOverrides(cfg, overrides);
}

//#endregion
//#region src/plugins/slots.ts
const DEFAULT_SLOT_BY_KEY = { memory: "memory-core" };
function defaultSlotIdForKey(slotKey) {
	return DEFAULT_SLOT_BY_KEY[slotKey];
}

//#endregion
//#region src/plugins/config-state.ts
const BUNDLED_ENABLED_BY_DEFAULT = new Set([
	"device-pair",
	"phone-control",
	"talk-voice"
]);
const normalizeList = (value) => {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
};
const normalizeSlotValue = (value) => {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (!trimmed) return;
	if (trimmed.toLowerCase() === "none") return null;
	return trimmed;
};
const normalizePluginEntries = (entries) => {
	if (!entries || typeof entries !== "object" || Array.isArray(entries)) return {};
	const normalized = {};
	for (const [key, value] of Object.entries(entries)) {
		if (!key.trim()) continue;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			normalized[key] = {};
			continue;
		}
		const entry = value;
		normalized[key] = {
			enabled: typeof entry.enabled === "boolean" ? entry.enabled : void 0,
			config: "config" in entry ? entry.config : void 0
		};
	}
	return normalized;
};
const normalizePluginsConfig = (config) => {
	const memorySlot = normalizeSlotValue(config?.slots?.memory);
	return {
		enabled: config?.enabled !== false,
		allow: normalizeList(config?.allow),
		deny: normalizeList(config?.deny),
		loadPaths: normalizeList(config?.load?.paths),
		slots: { memory: memorySlot === void 0 ? defaultSlotIdForKey("memory") : memorySlot },
		entries: normalizePluginEntries(config?.entries)
	};
};
const hasExplicitMemorySlot = (plugins) => Boolean(plugins?.slots && Object.prototype.hasOwnProperty.call(plugins.slots, "memory"));
const hasExplicitMemoryEntry = (plugins) => Boolean(plugins?.entries && Object.prototype.hasOwnProperty.call(plugins.entries, "memory-core"));
const hasExplicitPluginConfig = (plugins) => {
	if (!plugins) return false;
	if (typeof plugins.enabled === "boolean") return true;
	if (Array.isArray(plugins.allow) && plugins.allow.length > 0) return true;
	if (Array.isArray(plugins.deny) && plugins.deny.length > 0) return true;
	if (plugins.load?.paths && Array.isArray(plugins.load.paths) && plugins.load.paths.length > 0) return true;
	if (plugins.slots && Object.keys(plugins.slots).length > 0) return true;
	if (plugins.entries && Object.keys(plugins.entries).length > 0) return true;
	return false;
};
function applyTestPluginDefaults(cfg, env = process.env) {
	if (!env.VITEST) return cfg;
	const plugins = cfg.plugins;
	if (hasExplicitPluginConfig(plugins)) {
		if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) return cfg;
		return {
			...cfg,
			plugins: {
				...plugins,
				slots: {
					...plugins?.slots,
					memory: "none"
				}
			}
		};
	}
	return {
		...cfg,
		plugins: {
			...plugins,
			enabled: false,
			slots: {
				...plugins?.slots,
				memory: "none"
			}
		}
	};
}
function resolveEnableState(id, origin, config) {
	if (!config.enabled) return {
		enabled: false,
		reason: "plugins disabled"
	};
	if (config.deny.includes(id)) return {
		enabled: false,
		reason: "blocked by denylist"
	};
	if (config.allow.length > 0 && !config.allow.includes(id)) return {
		enabled: false,
		reason: "not in allowlist"
	};
	if (config.slots.memory === id) return { enabled: true };
	const entry = config.entries[id];
	if (entry?.enabled === true) return { enabled: true };
	if (entry?.enabled === false) return {
		enabled: false,
		reason: "disabled in config"
	};
	if (origin === "bundled" && BUNDLED_ENABLED_BY_DEFAULT.has(id)) return { enabled: true };
	if (origin === "bundled") return {
		enabled: false,
		reason: "bundled (disabled by default)"
	};
	return { enabled: true };
}
function isBundledChannelEnabledByChannelConfig(cfg, pluginId) {
	if (!cfg) return false;
	const channelId = normalizeChatChannelId(pluginId);
	if (!channelId) return false;
	const entry = cfg.channels?.[channelId];
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
	return entry.enabled === true;
}
function resolveEffectiveEnableState(params) {
	const base = resolveEnableState(params.id, params.origin, params.config);
	if (!base.enabled && base.reason === "bundled (disabled by default)" && isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)) return { enabled: true };
	return base;
}
function resolveMemorySlotDecision(params) {
	if (params.kind !== "memory") return { enabled: true };
	if (params.slot === null) return {
		enabled: false,
		reason: "memory slot disabled"
	};
	if (typeof params.slot === "string") {
		if (params.slot === params.id) return {
			enabled: true,
			selected: true
		};
		return {
			enabled: false,
			reason: `memory slot set to "${params.slot}"`
		};
	}
	if (params.selectedId && params.selectedId !== params.id) return {
		enabled: false,
		reason: `memory slot already filled by "${params.selectedId}"`
	};
	return {
		enabled: true,
		selected: true
	};
}

//#endregion
//#region src/plugins/bundled-dir.ts
function resolveBundledPluginsDir() {
	const override = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
	if (override) return override;
	try {
		const execDir = path.dirname(process.execPath);
		const sibling = path.join(execDir, "extensions");
		if (syncFs.existsSync(sibling)) return sibling;
	} catch {}
	try {
		let cursor = path.dirname(fileURLToPath(import.meta.url));
		for (let i = 0; i < 6; i += 1) {
			const candidate = path.join(cursor, "extensions");
			if (syncFs.existsSync(candidate)) return candidate;
			const parent = path.dirname(cursor);
			if (parent === cursor) break;
			cursor = parent;
		}
	} catch {}
}

//#endregion
//#region src/plugins/manifest.ts
const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
const PLUGIN_MANIFEST_FILENAMES = [PLUGIN_MANIFEST_FILENAME];
function normalizeStringList(value) {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
}
function resolvePluginManifestPath(rootDir) {
	for (const filename of PLUGIN_MANIFEST_FILENAMES) {
		const candidate = path.join(rootDir, filename);
		if (syncFs.existsSync(candidate)) return candidate;
	}
	return path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
}
function loadPluginManifest(rootDir) {
	const manifestPath = resolvePluginManifestPath(rootDir);
	const opened = openBoundaryFileSync({
		absolutePath: manifestPath,
		rootPath: rootDir,
		boundaryLabel: "plugin root"
	});
	if (!opened.ok) {
		if (opened.reason === "path") return {
			ok: false,
			error: `plugin manifest not found: ${manifestPath}`,
			manifestPath
		};
		return {
			ok: false,
			error: `unsafe plugin manifest path: ${manifestPath} (${opened.reason})`,
			manifestPath
		};
	}
	let raw;
	try {
		raw = JSON.parse(syncFs.readFileSync(opened.fd, "utf-8"));
	} catch (err) {
		return {
			ok: false,
			error: `failed to parse plugin manifest: ${String(err)}`,
			manifestPath
		};
	} finally {
		syncFs.closeSync(opened.fd);
	}
	if (!isRecord$3(raw)) return {
		ok: false,
		error: "plugin manifest must be an object",
		manifestPath
	};
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!id) return {
		ok: false,
		error: "plugin manifest requires id",
		manifestPath
	};
	const configSchema = isRecord$3(raw.configSchema) ? raw.configSchema : null;
	if (!configSchema) return {
		ok: false,
		error: "plugin manifest requires configSchema",
		manifestPath
	};
	const kind = typeof raw.kind === "string" ? raw.kind : void 0;
	const name = typeof raw.name === "string" ? raw.name.trim() : void 0;
	const description = typeof raw.description === "string" ? raw.description.trim() : void 0;
	const version = typeof raw.version === "string" ? raw.version.trim() : void 0;
	const channels = normalizeStringList(raw.channels);
	const providers = normalizeStringList(raw.providers);
	const skills = normalizeStringList(raw.skills);
	let uiHints;
	if (isRecord$3(raw.uiHints)) uiHints = raw.uiHints;
	return {
		ok: true,
		manifest: {
			id,
			configSchema,
			kind,
			channels,
			providers,
			skills,
			name,
			description,
			version,
			uiHints
		},
		manifestPath
	};
}
function getPackageManifestMetadata(manifest) {
	if (!manifest) return;
	return manifest[MANIFEST_KEY];
}

//#endregion
//#region src/plugins/path-safety.ts
function isPathInside(baseDir, targetPath) {
	return isPathInside$2(baseDir, targetPath);
}
function safeRealpathSync(targetPath, cache) {
	const cached = cache?.get(targetPath);
	if (cached) return cached;
	try {
		const resolved = syncFs.realpathSync(targetPath);
		cache?.set(targetPath, resolved);
		return resolved;
	} catch {
		return null;
	}
}
function safeStatSync(targetPath) {
	try {
		return syncFs.statSync(targetPath);
	} catch {
		return null;
	}
}
function formatPosixMode(mode) {
	return (mode & 511).toString(8).padStart(3, "0");
}

//#endregion
//#region src/plugins/discovery.ts
const EXTENSION_EXTS = new Set([
	".ts",
	".js",
	".mts",
	".cts",
	".mjs",
	".cjs"
]);
function currentUid(overrideUid) {
	if (overrideUid !== void 0) return overrideUid;
	if (process.platform === "win32") return null;
	if (typeof process.getuid !== "function") return null;
	return process.getuid();
}
function checkSourceEscapesRoot(params) {
	const sourceRealPath = safeRealpathSync(params.source);
	const rootRealPath = safeRealpathSync(params.rootDir);
	if (!sourceRealPath || !rootRealPath) return null;
	if (isPathInside(rootRealPath, sourceRealPath)) return null;
	return {
		reason: "source_escapes_root",
		sourcePath: params.source,
		rootPath: params.rootDir,
		targetPath: params.source,
		sourceRealPath,
		rootRealPath
	};
}
function checkPathStatAndPermissions(params) {
	if (process.platform === "win32") return null;
	const pathsToCheck = [params.rootDir, params.source];
	const seen = /* @__PURE__ */ new Set();
	for (const targetPath of pathsToCheck) {
		const normalized = path.resolve(targetPath);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		const stat = safeStatSync(targetPath);
		if (!stat) return {
			reason: "path_stat_failed",
			sourcePath: params.source,
			rootPath: params.rootDir,
			targetPath
		};
		const modeBits = stat.mode & 511;
		if ((modeBits & 2) !== 0) return {
			reason: "path_world_writable",
			sourcePath: params.source,
			rootPath: params.rootDir,
			targetPath,
			modeBits
		};
		if (params.origin !== "bundled" && params.uid !== null && typeof stat.uid === "number" && stat.uid !== params.uid && stat.uid !== 0) return {
			reason: "path_suspicious_ownership",
			sourcePath: params.source,
			rootPath: params.rootDir,
			targetPath,
			foundUid: stat.uid,
			expectedUid: params.uid
		};
	}
	return null;
}
function findCandidateBlockIssue(params) {
	const escaped = checkSourceEscapesRoot({
		source: params.source,
		rootDir: params.rootDir
	});
	if (escaped) return escaped;
	return checkPathStatAndPermissions({
		source: params.source,
		rootDir: params.rootDir,
		origin: params.origin,
		uid: currentUid(params.ownershipUid)
	});
}
function formatCandidateBlockMessage(issue) {
	if (issue.reason === "source_escapes_root") return `blocked plugin candidate: source escapes plugin root (${issue.sourcePath} -> ${issue.sourceRealPath}; root=${issue.rootRealPath})`;
	if (issue.reason === "path_stat_failed") return `blocked plugin candidate: cannot stat path (${issue.targetPath})`;
	if (issue.reason === "path_world_writable") return `blocked plugin candidate: world-writable path (${issue.targetPath}, mode=${formatPosixMode(issue.modeBits ?? 0)})`;
	return `blocked plugin candidate: suspicious ownership (${issue.targetPath}, uid=${issue.foundUid}, expected uid=${issue.expectedUid} or root)`;
}
function isUnsafePluginCandidate(params) {
	const issue = findCandidateBlockIssue({
		source: params.source,
		rootDir: params.rootDir,
		origin: params.origin,
		ownershipUid: params.ownershipUid
	});
	if (!issue) return false;
	params.diagnostics.push({
		level: "warn",
		source: issue.targetPath,
		message: formatCandidateBlockMessage(issue)
	});
	return true;
}
function isExtensionFile(filePath) {
	const ext = path.extname(filePath);
	if (!EXTENSION_EXTS.has(ext)) return false;
	return !filePath.endsWith(".d.ts");
}
function shouldIgnoreScannedDirectory(dirName) {
	const normalized = dirName.trim().toLowerCase();
	if (!normalized) return true;
	if (normalized.endsWith(".bak")) return true;
	if (normalized.includes(".backup-")) return true;
	if (normalized.includes(".disabled")) return true;
	return false;
}
function readPackageManifest(dir) {
	const opened = openBoundaryFileSync({
		absolutePath: path.join(dir, "package.json"),
		rootPath: dir,
		boundaryLabel: "plugin package directory"
	});
	if (!opened.ok) return null;
	try {
		const raw = syncFs.readFileSync(opened.fd, "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	} finally {
		syncFs.closeSync(opened.fd);
	}
}
function resolvePackageExtensions(manifest) {
	const raw = getPackageManifestMetadata(manifest)?.extensions;
	if (!Array.isArray(raw)) return [];
	return raw.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
}
function deriveIdHint(params) {
	const base = path.basename(params.filePath, path.extname(params.filePath));
	const rawPackageName = params.packageName?.trim();
	if (!rawPackageName) return base;
	const unscoped = rawPackageName.includes("/") ? rawPackageName.split("/").pop() ?? rawPackageName : rawPackageName;
	if (!params.hasMultipleExtensions) return unscoped;
	return `${unscoped}/${base}`;
}
function addCandidate(params) {
	const resolved = path.resolve(params.source);
	if (params.seen.has(resolved)) return;
	const resolvedRoot = safeRealpathSync(params.rootDir) ?? path.resolve(params.rootDir);
	if (isUnsafePluginCandidate({
		source: resolved,
		rootDir: resolvedRoot,
		origin: params.origin,
		diagnostics: params.diagnostics,
		ownershipUid: params.ownershipUid
	})) return;
	params.seen.add(resolved);
	const manifest = params.manifest ?? null;
	params.candidates.push({
		idHint: params.idHint,
		source: resolved,
		rootDir: resolvedRoot,
		origin: params.origin,
		workspaceDir: params.workspaceDir,
		packageName: manifest?.name?.trim() || void 0,
		packageVersion: manifest?.version?.trim() || void 0,
		packageDescription: manifest?.description?.trim() || void 0,
		packageDir: params.packageDir,
		packageManifest: getPackageManifestMetadata(manifest ?? void 0)
	});
}
function resolvePackageEntrySource(params) {
	const opened = openBoundaryFileSync({
		absolutePath: path.resolve(params.packageDir, params.entryPath),
		rootPath: params.packageDir,
		boundaryLabel: "plugin package directory"
	});
	if (!opened.ok) {
		params.diagnostics.push({
			level: "error",
			message: `extension entry escapes package directory: ${params.entryPath}`,
			source: params.sourceLabel
		});
		return null;
	}
	const safeSource = opened.path;
	syncFs.closeSync(opened.fd);
	return safeSource;
}
function discoverInDirectory(params) {
	if (!syncFs.existsSync(params.dir)) return;
	let entries = [];
	try {
		entries = syncFs.readdirSync(params.dir, { withFileTypes: true });
	} catch (err) {
		params.diagnostics.push({
			level: "warn",
			message: `failed to read extensions dir: ${params.dir} (${String(err)})`,
			source: params.dir
		});
		return;
	}
	for (const entry of entries) {
		const fullPath = path.join(params.dir, entry.name);
		if (entry.isFile()) {
			if (!isExtensionFile(fullPath)) continue;
			addCandidate({
				candidates: params.candidates,
				diagnostics: params.diagnostics,
				seen: params.seen,
				idHint: path.basename(entry.name, path.extname(entry.name)),
				source: fullPath,
				rootDir: path.dirname(fullPath),
				origin: params.origin,
				ownershipUid: params.ownershipUid,
				workspaceDir: params.workspaceDir
			});
		}
		if (!entry.isDirectory()) continue;
		if (shouldIgnoreScannedDirectory(entry.name)) continue;
		const manifest = readPackageManifest(fullPath);
		const extensions = manifest ? resolvePackageExtensions(manifest) : [];
		if (extensions.length > 0) {
			for (const extPath of extensions) {
				const resolved = resolvePackageEntrySource({
					packageDir: fullPath,
					entryPath: extPath,
					sourceLabel: fullPath,
					diagnostics: params.diagnostics
				});
				if (!resolved) continue;
				addCandidate({
					candidates: params.candidates,
					diagnostics: params.diagnostics,
					seen: params.seen,
					idHint: deriveIdHint({
						filePath: resolved,
						packageName: manifest?.name,
						hasMultipleExtensions: extensions.length > 1
					}),
					source: resolved,
					rootDir: fullPath,
					origin: params.origin,
					ownershipUid: params.ownershipUid,
					workspaceDir: params.workspaceDir,
					manifest,
					packageDir: fullPath
				});
			}
			continue;
		}
		const indexFile = [
			"index.ts",
			"index.js",
			"index.mjs",
			"index.cjs"
		].map((candidate) => path.join(fullPath, candidate)).find((candidate) => syncFs.existsSync(candidate));
		if (indexFile && isExtensionFile(indexFile)) addCandidate({
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen,
			idHint: entry.name,
			source: indexFile,
			rootDir: fullPath,
			origin: params.origin,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir,
			manifest,
			packageDir: fullPath
		});
	}
}
function discoverFromPath(params) {
	const resolved = resolveUserPath(params.rawPath);
	if (!syncFs.existsSync(resolved)) {
		params.diagnostics.push({
			level: "error",
			message: `plugin path not found: ${resolved}`,
			source: resolved
		});
		return;
	}
	const stat = syncFs.statSync(resolved);
	if (stat.isFile()) {
		if (!isExtensionFile(resolved)) {
			params.diagnostics.push({
				level: "error",
				message: `plugin path is not a supported file: ${resolved}`,
				source: resolved
			});
			return;
		}
		addCandidate({
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen,
			idHint: path.basename(resolved, path.extname(resolved)),
			source: resolved,
			rootDir: path.dirname(resolved),
			origin: params.origin,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir
		});
		return;
	}
	if (stat.isDirectory()) {
		const manifest = readPackageManifest(resolved);
		const extensions = manifest ? resolvePackageExtensions(manifest) : [];
		if (extensions.length > 0) {
			for (const extPath of extensions) {
				const source = resolvePackageEntrySource({
					packageDir: resolved,
					entryPath: extPath,
					sourceLabel: resolved,
					diagnostics: params.diagnostics
				});
				if (!source) continue;
				addCandidate({
					candidates: params.candidates,
					diagnostics: params.diagnostics,
					seen: params.seen,
					idHint: deriveIdHint({
						filePath: source,
						packageName: manifest?.name,
						hasMultipleExtensions: extensions.length > 1
					}),
					source,
					rootDir: resolved,
					origin: params.origin,
					ownershipUid: params.ownershipUid,
					workspaceDir: params.workspaceDir,
					manifest,
					packageDir: resolved
				});
			}
			return;
		}
		const indexFile = [
			"index.ts",
			"index.js",
			"index.mjs",
			"index.cjs"
		].map((candidate) => path.join(resolved, candidate)).find((candidate) => syncFs.existsSync(candidate));
		if (indexFile && isExtensionFile(indexFile)) {
			addCandidate({
				candidates: params.candidates,
				diagnostics: params.diagnostics,
				seen: params.seen,
				idHint: path.basename(resolved),
				source: indexFile,
				rootDir: resolved,
				origin: params.origin,
				ownershipUid: params.ownershipUid,
				workspaceDir: params.workspaceDir,
				manifest,
				packageDir: resolved
			});
			return;
		}
		discoverInDirectory({
			dir: resolved,
			origin: params.origin,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir,
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen
		});
		return;
	}
}
function discoverOpenClawPlugins(params) {
	const candidates = [];
	const diagnostics = [];
	const seen = /* @__PURE__ */ new Set();
	const workspaceDir = params.workspaceDir?.trim();
	const extra = params.extraPaths ?? [];
	for (const extraPath of extra) {
		if (typeof extraPath !== "string") continue;
		const trimmed = extraPath.trim();
		if (!trimmed) continue;
		discoverFromPath({
			rawPath: trimmed,
			origin: "config",
			ownershipUid: params.ownershipUid,
			workspaceDir: workspaceDir?.trim() || void 0,
			candidates,
			diagnostics,
			seen
		});
	}
	if (workspaceDir) {
		const workspaceRoot = resolveUserPath(workspaceDir);
		const workspaceExtDirs = [path.join(workspaceRoot, ".openclaw", "extensions")];
		for (const dir of workspaceExtDirs) discoverInDirectory({
			dir,
			origin: "workspace",
			ownershipUid: params.ownershipUid,
			workspaceDir: workspaceRoot,
			candidates,
			diagnostics,
			seen
		});
	}
	discoverInDirectory({
		dir: path.join(resolveConfigDir(), "extensions"),
		origin: "global",
		ownershipUid: params.ownershipUid,
		candidates,
		diagnostics,
		seen
	});
	const bundledDir = resolveBundledPluginsDir();
	if (bundledDir) discoverInDirectory({
		dir: bundledDir,
		origin: "bundled",
		ownershipUid: params.ownershipUid,
		candidates,
		diagnostics,
		seen
	});
	return {
		candidates,
		diagnostics
	};
}

//#endregion
//#region src/plugins/manifest-registry.ts
const PLUGIN_ORIGIN_RANK = {
	config: 0,
	workspace: 1,
	global: 2,
	bundled: 3
};
const registryCache = /* @__PURE__ */ new Map();
const DEFAULT_MANIFEST_CACHE_MS = 200;
function resolveManifestCacheMs(env) {
	const raw = env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS?.trim();
	if (raw === "" || raw === "0") return 0;
	if (!raw) return DEFAULT_MANIFEST_CACHE_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return DEFAULT_MANIFEST_CACHE_MS;
	return Math.max(0, parsed);
}
function shouldUseManifestCache(env) {
	if (env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE?.trim()) return false;
	return resolveManifestCacheMs(env) > 0;
}
function buildCacheKey$1(params) {
	const workspaceKey = params.workspaceDir ? resolveUserPath(params.workspaceDir) : "";
	const loadPaths = params.plugins.loadPaths.map((p) => resolveUserPath(p)).map((p) => p.trim()).filter(Boolean).toSorted();
	return `${workspaceKey}::${JSON.stringify(loadPaths)}`;
}
function safeStatMtimeMs(filePath) {
	try {
		return syncFs.statSync(filePath).mtimeMs;
	} catch {
		return null;
	}
}
function normalizeManifestLabel(raw) {
	const trimmed = raw?.trim();
	return trimmed ? trimmed : void 0;
}
function buildRecord(params) {
	return {
		id: params.manifest.id,
		name: normalizeManifestLabel(params.manifest.name) ?? params.candidate.packageName,
		description: normalizeManifestLabel(params.manifest.description) ?? params.candidate.packageDescription,
		version: normalizeManifestLabel(params.manifest.version) ?? params.candidate.packageVersion,
		kind: params.manifest.kind,
		channels: params.manifest.channels ?? [],
		providers: params.manifest.providers ?? [],
		skills: params.manifest.skills ?? [],
		origin: params.candidate.origin,
		workspaceDir: params.candidate.workspaceDir,
		rootDir: params.candidate.rootDir,
		source: params.candidate.source,
		manifestPath: params.manifestPath,
		schemaCacheKey: params.schemaCacheKey,
		configSchema: params.configSchema,
		configUiHints: params.manifest.uiHints
	};
}
function loadPluginManifestRegistry(params) {
	const normalized = normalizePluginsConfig((params.config ?? {}).plugins);
	const cacheKey = buildCacheKey$1({
		workspaceDir: params.workspaceDir,
		plugins: normalized
	});
	const env = params.env ?? process.env;
	const cacheEnabled = params.cache !== false && shouldUseManifestCache(env);
	if (cacheEnabled) {
		const cached = registryCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) return cached.registry;
	}
	const discovery = params.candidates ? {
		candidates: params.candidates,
		diagnostics: params.diagnostics ?? []
	} : discoverOpenClawPlugins({
		workspaceDir: params.workspaceDir,
		extraPaths: normalized.loadPaths
	});
	const diagnostics = [...discovery.diagnostics];
	const candidates = discovery.candidates;
	const records = [];
	const seenIds = /* @__PURE__ */ new Map();
	const realpathCache = /* @__PURE__ */ new Map();
	for (const candidate of candidates) {
		const manifestRes = loadPluginManifest(candidate.rootDir);
		if (!manifestRes.ok) {
			diagnostics.push({
				level: "error",
				message: manifestRes.error,
				source: manifestRes.manifestPath
			});
			continue;
		}
		const manifest = manifestRes.manifest;
		if (candidate.idHint && candidate.idHint !== manifest.id) diagnostics.push({
			level: "warn",
			pluginId: manifest.id,
			source: candidate.source,
			message: `plugin id mismatch (manifest uses "${manifest.id}", entry hints "${candidate.idHint}")`
		});
		const configSchema = manifest.configSchema;
		const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
		const schemaCacheKey = manifestMtime ? `${manifestRes.manifestPath}:${manifestMtime}` : manifestRes.manifestPath;
		const existing = seenIds.get(manifest.id);
		if (existing) {
			const existingReal = safeRealpathSync(existing.candidate.rootDir, realpathCache);
			const candidateReal = safeRealpathSync(candidate.rootDir, realpathCache);
			if (Boolean(existingReal && candidateReal && existingReal === candidateReal)) {
				if (PLUGIN_ORIGIN_RANK[candidate.origin] < PLUGIN_ORIGIN_RANK[existing.candidate.origin]) {
					records[existing.recordIndex] = buildRecord({
						manifest,
						candidate,
						manifestPath: manifestRes.manifestPath,
						schemaCacheKey,
						configSchema
					});
					seenIds.set(manifest.id, {
						candidate,
						recordIndex: existing.recordIndex
					});
				}
				continue;
			}
			diagnostics.push({
				level: "warn",
				pluginId: manifest.id,
				source: candidate.source,
				message: `duplicate plugin id detected; later plugin may be overridden (${candidate.source})`
			});
		} else seenIds.set(manifest.id, {
			candidate,
			recordIndex: records.length
		});
		records.push(buildRecord({
			manifest,
			candidate,
			manifestPath: manifestRes.manifestPath,
			schemaCacheKey,
			configSchema
		}));
	}
	const registry = {
		plugins: records,
		diagnostics
	};
	if (cacheEnabled) {
		const ttl = resolveManifestCacheMs(env);
		if (ttl > 0) registryCache.set(cacheKey, {
			expiresAt: Date.now() + ttl,
			registry
		});
	}
	return registry;
}

//#endregion
//#region src/plugins/schema-validator.ts
const ajv = new AjvPkg({
	allErrors: true,
	strict: false,
	removeAdditional: false
});
const schemaCache = /* @__PURE__ */ new Map();
function formatAjvErrors(errors) {
	if (!errors || errors.length === 0) return ["invalid config"];
	return errors.map((error) => {
		return `${error.instancePath?.replace(/^\//, "").replace(/\//g, ".") || "<root>"}: ${error.message ?? "invalid"}`;
	});
}
function validateJsonSchemaValue(params) {
	let cached = schemaCache.get(params.cacheKey);
	if (!cached || cached.schema !== params.schema) {
		cached = {
			validate: ajv.compile(params.schema),
			schema: params.schema
		};
		schemaCache.set(params.cacheKey, cached);
	}
	if (cached.validate(params.value)) return { ok: true };
	return {
		ok: false,
		errors: formatAjvErrors(cached.validate.errors)
	};
}

//#endregion
//#region src/shared/avatar-policy.ts
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const LOCAL_AVATAR_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg"
]);
const AVATAR_DATA_RE = /^data:/i;
const AVATAR_HTTP_RE = /^https?:\/\//i;
const AVATAR_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABS_RE = /^[a-zA-Z]:[\\/]/;
function isAvatarDataUrl(value) {
	return AVATAR_DATA_RE.test(value);
}
function isAvatarHttpUrl(value) {
	return AVATAR_HTTP_RE.test(value);
}
function hasAvatarUriScheme(value) {
	return AVATAR_SCHEME_RE.test(value);
}
function isWindowsAbsolutePath(value) {
	return WINDOWS_ABS_RE.test(value);
}
function isPathWithinRoot(rootDir, targetPath) {
	const relative = path.relative(rootDir, targetPath);
	if (relative === "") return true;
	return !relative.startsWith("..") && !path.isAbsolute(relative);
}
function isSupportedLocalAvatarExtension(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	return LOCAL_AVATAR_EXTENSIONS.has(ext);
}

//#endregion
//#region src/cli/parse-bytes.ts
const UNIT_MULTIPLIERS = {
	b: 1,
	kb: 1024,
	k: 1024,
	mb: 1024 ** 2,
	m: 1024 ** 2,
	gb: 1024 ** 3,
	g: 1024 ** 3,
	tb: 1024 ** 4,
	t: 1024 ** 4
};
function parseByteSize(raw, opts) {
	const trimmed = String(raw ?? "").trim().toLowerCase();
	if (!trimmed) throw new Error("invalid byte size (empty)");
	const m = /^(\d+(?:\.\d+)?)([a-z]+)?$/.exec(trimmed);
	if (!m) throw new Error(`invalid byte size: ${raw}`);
	const value = Number(m[1]);
	if (!Number.isFinite(value) || value < 0) throw new Error(`invalid byte size: ${raw}`);
	const multiplier = UNIT_MULTIPLIERS[(m[2] ?? opts?.defaultUnit ?? "b").toLowerCase()];
	if (!multiplier) throw new Error(`invalid byte size unit: ${raw}`);
	const bytes = Math.round(value * multiplier);
	if (!Number.isFinite(bytes)) throw new Error(`invalid byte size: ${raw}`);
	return bytes;
}

//#endregion
//#region src/cli/parse-duration.ts
const DURATION_MULTIPLIERS = {
	ms: 1,
	s: 1e3,
	m: 6e4,
	h: 36e5,
	d: 864e5
};
function parseDurationMs(raw, opts) {
	const trimmed = String(raw ?? "").trim().toLowerCase();
	if (!trimmed) throw new Error("invalid duration (empty)");
	const single = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(trimmed);
	if (single) {
		const value = Number(single[1]);
		if (!Number.isFinite(value) || value < 0) throw new Error(`invalid duration: ${raw}`);
		const unit = single[2] ?? opts?.defaultUnit ?? "ms";
		const ms = Math.round(value * DURATION_MULTIPLIERS[unit]);
		if (!Number.isFinite(ms)) throw new Error(`invalid duration: ${raw}`);
		return ms;
	}
	let totalMs = 0;
	let consumed = 0;
	for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
		const [full, valueRaw, unitRaw] = match;
		const index = match.index ?? -1;
		if (!full || !valueRaw || !unitRaw || index < 0) throw new Error(`invalid duration: ${raw}`);
		if (index !== consumed) throw new Error(`invalid duration: ${raw}`);
		const value = Number(valueRaw);
		if (!Number.isFinite(value) || value < 0) throw new Error(`invalid duration: ${raw}`);
		const multiplier = DURATION_MULTIPLIERS[unitRaw];
		if (!multiplier) throw new Error(`invalid duration: ${raw}`);
		totalMs += value * multiplier;
		consumed += full.length;
	}
	if (consumed !== trimmed.length || consumed === 0) throw new Error(`invalid duration: ${raw}`);
	const ms = Math.round(totalMs);
	if (!Number.isFinite(ms)) throw new Error(`invalid duration: ${raw}`);
	return ms;
}

//#endregion
//#region src/agents/sandbox/network-mode.ts
function normalizeNetworkMode(network) {
	return network?.trim().toLowerCase() || void 0;
}
function getBlockedNetworkModeReason(params) {
	const normalized = normalizeNetworkMode(params.network);
	if (!normalized) return null;
	if (normalized === "host") return "host";
	if (normalized.startsWith("container:") && params.allowContainerNamespaceJoin !== true) return "container_namespace_join";
	return null;
}

//#endregion
//#region src/config/zod-schema.agent-model.ts
const AgentModelSchema = z.union([z.string(), z.object({
	primary: z.string().optional(),
	fallbacks: z.array(z.string()).optional()
}).strict()]);

//#endregion
//#region src/secrets/ref-contract.ts
const FILE_SECRET_REF_SEGMENT_PATTERN = /^(?:[^~]|~0|~1)*$/;
const SINGLE_VALUE_FILE_REF_ID = "value";
function secretRefKey(ref) {
	return `${ref.source}:${ref.provider}:${ref.id}`;
}
function resolveDefaultSecretProviderAlias(config, source, options) {
	const configured = source === "env" ? config.secrets?.defaults?.env : source === "file" ? config.secrets?.defaults?.file : config.secrets?.defaults?.exec;
	if (configured?.trim()) return configured.trim();
	if (options?.preferFirstProviderForSource) {
		const providers = config.secrets?.providers;
		if (providers) {
			for (const [providerName, provider] of Object.entries(providers)) if (provider?.source === source) return providerName;
		}
	}
	return DEFAULT_SECRET_PROVIDER_ALIAS;
}
function isValidFileSecretRefId(value) {
	if (value === SINGLE_VALUE_FILE_REF_ID) return true;
	if (!value.startsWith("/")) return false;
	return value.slice(1).split("/").every((segment) => FILE_SECRET_REF_SEGMENT_PATTERN.test(segment));
}

//#endregion
//#region src/config/types.models.ts
const MODEL_APIS = [
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"google-generative-ai",
	"github-copilot",
	"bedrock-converse-stream",
	"ollama"
];

//#endregion
//#region src/config/zod-schema.allowdeny.ts
const AllowDenyActionSchema = z.union([z.literal("allow"), z.literal("deny")]);
const AllowDenyChatTypeSchema = z.union([
	z.literal("direct"),
	z.literal("group"),
	z.literal("channel"),
	z.literal("dm")
]).optional();
function createAllowDenyChannelRulesSchema() {
	return z.object({
		default: AllowDenyActionSchema.optional(),
		rules: z.array(z.object({
			action: AllowDenyActionSchema,
			match: z.object({
				channel: z.string().optional(),
				chatType: AllowDenyChatTypeSchema,
				keyPrefix: z.string().optional(),
				rawKeyPrefix: z.string().optional()
			}).strict().optional()
		}).strict()).optional()
	}).strict().optional();
}

//#endregion
//#region src/config/zod-schema.sensitive.ts
const sensitive = z.registry();

//#endregion
//#region src/config/zod-schema.core.ts
const ENV_SECRET_REF_ID_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const EXEC_SECRET_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const WINDOWS_ABS_PATH_PATTERN$1 = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN$1 = /^\\\\[^\\]+\\[^\\]+/;
function isAbsolutePath(value) {
	return path.isAbsolute(value) || WINDOWS_ABS_PATH_PATTERN$1.test(value) || WINDOWS_UNC_PATH_PATTERN$1.test(value);
}
const EnvSecretRefSchema = z.object({
	source: z.literal("env"),
	provider: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN, "Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: \"default\")."),
	id: z.string().regex(ENV_SECRET_REF_ID_PATTERN, "Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: \"OPENAI_API_KEY\").")
}).strict();
const FileSecretRefSchema = z.object({
	source: z.literal("file"),
	provider: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN, "Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: \"default\")."),
	id: z.string().refine(isValidFileSecretRefId, "File secret reference id must be an absolute JSON pointer (example: \"/providers/openai/apiKey\"), or \"value\" for singleValue mode.")
}).strict();
const ExecSecretRefSchema = z.object({
	source: z.literal("exec"),
	provider: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN, "Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: \"default\")."),
	id: z.string().regex(EXEC_SECRET_REF_ID_PATTERN, "Exec secret reference id must match /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/ (example: \"vault/openai/api-key\").")
}).strict();
const SecretRefSchema = z.discriminatedUnion("source", [
	EnvSecretRefSchema,
	FileSecretRefSchema,
	ExecSecretRefSchema
]);
const SecretInputSchema = z.union([z.string(), SecretRefSchema]);
const SecretsEnvProviderSchema = z.object({
	source: z.literal("env"),
	allowlist: z.array(z.string().regex(ENV_SECRET_REF_ID_PATTERN)).max(256).optional()
}).strict();
const SecretsFileProviderSchema = z.object({
	source: z.literal("file"),
	path: z.string().min(1),
	mode: z.union([z.literal("singleValue"), z.literal("json")]).optional(),
	timeoutMs: z.number().int().positive().max(12e4).optional(),
	maxBytes: z.number().int().positive().max(20 * 1024 * 1024).optional()
}).strict();
const SecretsExecProviderSchema = z.object({
	source: z.literal("exec"),
	command: z.string().min(1).refine((value) => isSafeExecutableValue(value), "secrets.providers.*.command is unsafe.").refine((value) => isAbsolutePath(value), "secrets.providers.*.command must be an absolute path."),
	args: z.array(z.string().max(1024)).max(128).optional(),
	timeoutMs: z.number().int().positive().max(12e4).optional(),
	noOutputTimeoutMs: z.number().int().positive().max(12e4).optional(),
	maxOutputBytes: z.number().int().positive().max(20 * 1024 * 1024).optional(),
	jsonOnly: z.boolean().optional(),
	env: z.record(z.string(), z.string()).optional(),
	passEnv: z.array(z.string().regex(ENV_SECRET_REF_ID_PATTERN)).max(128).optional(),
	trustedDirs: z.array(z.string().min(1).refine((value) => isAbsolutePath(value), "trustedDirs entries must be absolute paths.")).max(64).optional(),
	allowInsecurePath: z.boolean().optional(),
	allowSymlinkCommand: z.boolean().optional()
}).strict();
const SecretProviderSchema = z.discriminatedUnion("source", [
	SecretsEnvProviderSchema,
	SecretsFileProviderSchema,
	SecretsExecProviderSchema
]);
const SecretsConfigSchema = z.object({
	providers: z.object({}).catchall(SecretProviderSchema).optional(),
	defaults: z.object({
		env: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
		file: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
		exec: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional()
	}).strict().optional(),
	resolution: z.object({
		maxProviderConcurrency: z.number().int().positive().max(16).optional(),
		maxRefsPerProvider: z.number().int().positive().max(4096).optional(),
		maxBatchBytes: z.number().int().positive().max(5 * 1024 * 1024).optional()
	}).strict().optional()
}).strict().optional();
const ModelApiSchema = z.enum(MODEL_APIS);
const ModelCompatSchema = z.object({
	supportsStore: z.boolean().optional(),
	supportsDeveloperRole: z.boolean().optional(),
	supportsReasoningEffort: z.boolean().optional(),
	supportsUsageInStreaming: z.boolean().optional(),
	supportsStrictMode: z.boolean().optional(),
	maxTokensField: z.union([z.literal("max_completion_tokens"), z.literal("max_tokens")]).optional(),
	thinkingFormat: z.union([
		z.literal("openai"),
		z.literal("zai"),
		z.literal("qwen")
	]).optional(),
	requiresToolResultName: z.boolean().optional(),
	requiresAssistantAfterToolResult: z.boolean().optional(),
	requiresThinkingAsText: z.boolean().optional(),
	requiresMistralToolIds: z.boolean().optional()
}).strict().optional();
const ModelDefinitionSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	api: ModelApiSchema.optional(),
	reasoning: z.boolean().optional(),
	input: z.array(z.union([z.literal("text"), z.literal("image")])).optional(),
	cost: z.object({
		input: z.number().optional(),
		output: z.number().optional(),
		cacheRead: z.number().optional(),
		cacheWrite: z.number().optional()
	}).strict().optional(),
	contextWindow: z.number().positive().optional(),
	maxTokens: z.number().positive().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	compat: ModelCompatSchema
}).strict();
const ModelProviderSchema = z.object({
	baseUrl: z.string().min(1),
	apiKey: SecretInputSchema.optional().register(sensitive),
	auth: z.union([
		z.literal("api-key"),
		z.literal("aws-sdk"),
		z.literal("oauth"),
		z.literal("token")
	]).optional(),
	api: ModelApiSchema.optional(),
	injectNumCtxForOpenAICompat: z.boolean().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	authHeader: z.boolean().optional(),
	models: z.array(ModelDefinitionSchema)
}).strict();
const BedrockDiscoverySchema = z.object({
	enabled: z.boolean().optional(),
	region: z.string().optional(),
	providerFilter: z.array(z.string()).optional(),
	refreshInterval: z.number().int().nonnegative().optional(),
	defaultContextWindow: z.number().int().positive().optional(),
	defaultMaxTokens: z.number().int().positive().optional()
}).strict().optional();
const ModelsConfigSchema = z.object({
	mode: z.union([z.literal("merge"), z.literal("replace")]).optional(),
	providers: z.record(z.string(), ModelProviderSchema).optional(),
	bedrockDiscovery: BedrockDiscoverySchema
}).strict().optional();
const GroupChatSchema = z.object({
	mentionPatterns: z.array(z.string()).optional(),
	historyLimit: z.number().int().positive().optional()
}).strict().optional();
const DmConfigSchema = z.object({ historyLimit: z.number().int().min(0).optional() }).strict();
const IdentitySchema = z.object({
	name: z.string().optional(),
	theme: z.string().optional(),
	emoji: z.string().optional(),
	avatar: z.string().optional()
}).strict().optional();
const QueueModeSchema = z.union([
	z.literal("steer"),
	z.literal("followup"),
	z.literal("collect"),
	z.literal("steer-backlog"),
	z.literal("steer+backlog"),
	z.literal("queue"),
	z.literal("interrupt")
]);
const QueueDropSchema = z.union([
	z.literal("old"),
	z.literal("new"),
	z.literal("summarize")
]);
const ReplyToModeSchema = z.union([
	z.literal("off"),
	z.literal("first"),
	z.literal("all")
]);
const TypingModeSchema = z.union([
	z.literal("never"),
	z.literal("instant"),
	z.literal("thinking"),
	z.literal("message")
]);
const GroupPolicySchema = z.enum([
	"open",
	"disabled",
	"allowlist"
]);
const DmPolicySchema = z.enum([
	"pairing",
	"allowlist",
	"open",
	"disabled"
]);
const BlockStreamingCoalesceSchema = z.object({
	minChars: z.number().int().positive().optional(),
	maxChars: z.number().int().positive().optional(),
	idleMs: z.number().int().nonnegative().optional()
}).strict();
const ReplyRuntimeConfigSchemaShape = {
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	responsePrefix: z.string().optional(),
	mediaMaxMb: z.number().positive().optional()
};
const BlockStreamingChunkSchema = z.object({
	minChars: z.number().int().positive().optional(),
	maxChars: z.number().int().positive().optional(),
	breakPreference: z.union([
		z.literal("paragraph"),
		z.literal("newline"),
		z.literal("sentence")
	]).optional()
}).strict();
const MarkdownTableModeSchema = z.enum([
	"off",
	"bullets",
	"code"
]);
const MarkdownConfigSchema = z.object({ tables: MarkdownTableModeSchema.optional() }).strict().optional();
const TtsProviderSchema = z.enum([
	"elevenlabs",
	"openai",
	"edge"
]);
const TtsModeSchema = z.enum(["final", "all"]);
const TtsAutoSchema = z.enum([
	"off",
	"always",
	"inbound",
	"tagged"
]);
const TtsConfigSchema = z.object({
	auto: TtsAutoSchema.optional(),
	enabled: z.boolean().optional(),
	mode: TtsModeSchema.optional(),
	provider: TtsProviderSchema.optional(),
	summaryModel: z.string().optional(),
	modelOverrides: z.object({
		enabled: z.boolean().optional(),
		allowText: z.boolean().optional(),
		allowProvider: z.boolean().optional(),
		allowVoice: z.boolean().optional(),
		allowModelId: z.boolean().optional(),
		allowVoiceSettings: z.boolean().optional(),
		allowNormalization: z.boolean().optional(),
		allowSeed: z.boolean().optional()
	}).strict().optional(),
	elevenlabs: z.object({
		apiKey: z.string().optional().register(sensitive),
		baseUrl: z.string().optional(),
		voiceId: z.string().optional(),
		modelId: z.string().optional(),
		seed: z.number().int().min(0).max(4294967295).optional(),
		applyTextNormalization: z.enum([
			"auto",
			"on",
			"off"
		]).optional(),
		languageCode: z.string().optional(),
		voiceSettings: z.object({
			stability: z.number().min(0).max(1).optional(),
			similarityBoost: z.number().min(0).max(1).optional(),
			style: z.number().min(0).max(1).optional(),
			useSpeakerBoost: z.boolean().optional(),
			speed: z.number().min(.5).max(2).optional()
		}).strict().optional()
	}).strict().optional(),
	openai: z.object({
		apiKey: z.string().optional().register(sensitive),
		model: z.string().optional(),
		voice: z.string().optional()
	}).strict().optional(),
	edge: z.object({
		enabled: z.boolean().optional(),
		voice: z.string().optional(),
		lang: z.string().optional(),
		outputFormat: z.string().optional(),
		pitch: z.string().optional(),
		rate: z.string().optional(),
		volume: z.string().optional(),
		saveSubtitles: z.boolean().optional(),
		proxy: z.string().optional(),
		timeoutMs: z.number().int().min(1e3).max(12e4).optional()
	}).strict().optional(),
	prefsPath: z.string().optional(),
	maxTextLength: z.number().int().min(1).optional(),
	timeoutMs: z.number().int().min(1e3).max(12e4).optional()
}).strict().optional();
const HumanDelaySchema = z.object({
	mode: z.union([
		z.literal("off"),
		z.literal("natural"),
		z.literal("custom")
	]).optional(),
	minMs: z.number().int().nonnegative().optional(),
	maxMs: z.number().int().nonnegative().optional()
}).strict();
const CliBackendWatchdogModeSchema = z.object({
	noOutputTimeoutMs: z.number().int().min(1e3).optional(),
	noOutputTimeoutRatio: z.number().min(.05).max(.95).optional(),
	minMs: z.number().int().min(1e3).optional(),
	maxMs: z.number().int().min(1e3).optional()
}).strict().optional();
const CliBackendSchema = z.object({
	command: z.string(),
	args: z.array(z.string()).optional(),
	output: z.union([
		z.literal("json"),
		z.literal("text"),
		z.literal("jsonl")
	]).optional(),
	resumeOutput: z.union([
		z.literal("json"),
		z.literal("text"),
		z.literal("jsonl")
	]).optional(),
	input: z.union([z.literal("arg"), z.literal("stdin")]).optional(),
	maxPromptArgChars: z.number().int().positive().optional(),
	env: z.record(z.string(), z.string()).optional(),
	clearEnv: z.array(z.string()).optional(),
	modelArg: z.string().optional(),
	modelAliases: z.record(z.string(), z.string()).optional(),
	sessionArg: z.string().optional(),
	sessionArgs: z.array(z.string()).optional(),
	resumeArgs: z.array(z.string()).optional(),
	sessionMode: z.union([
		z.literal("always"),
		z.literal("existing"),
		z.literal("none")
	]).optional(),
	sessionIdFields: z.array(z.string()).optional(),
	systemPromptArg: z.string().optional(),
	systemPromptMode: z.union([z.literal("append"), z.literal("replace")]).optional(),
	systemPromptWhen: z.union([
		z.literal("first"),
		z.literal("always"),
		z.literal("never")
	]).optional(),
	imageArg: z.string().optional(),
	imageMode: z.union([z.literal("repeat"), z.literal("list")]).optional(),
	serialize: z.boolean().optional(),
	reliability: z.object({ watchdog: z.object({
		fresh: CliBackendWatchdogModeSchema,
		resume: CliBackendWatchdogModeSchema
	}).strict().optional() }).strict().optional()
}).strict();
const normalizeAllowFrom = (values) => (values ?? []).map((v) => String(v).trim()).filter(Boolean);
const requireOpenAllowFrom = (params) => {
	if (params.policy !== "open") return;
	if (normalizeAllowFrom(params.allowFrom).includes("*")) return;
	params.ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: params.path,
		message: params.message
	});
};
/**
* Validate that dmPolicy="allowlist" has a non-empty allowFrom array.
* Without this, all DMs are silently dropped because the allowlist is empty
* and no senders can match.
*/
const requireAllowlistAllowFrom = (params) => {
	if (params.policy !== "allowlist") return;
	if (normalizeAllowFrom(params.allowFrom).length > 0) return;
	params.ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: params.path,
		message: params.message
	});
};
const MSTeamsReplyStyleSchema = z.enum(["thread", "top-level"]);
const RetryConfigSchema = z.object({
	attempts: z.number().int().min(1).optional(),
	minDelayMs: z.number().int().min(0).optional(),
	maxDelayMs: z.number().int().min(0).optional(),
	jitter: z.number().min(0).max(1).optional()
}).strict().optional();
const QueueModeBySurfaceSchema = z.object({
	whatsapp: QueueModeSchema.optional(),
	telegram: QueueModeSchema.optional(),
	discord: QueueModeSchema.optional(),
	irc: QueueModeSchema.optional(),
	slack: QueueModeSchema.optional(),
	mattermost: QueueModeSchema.optional(),
	signal: QueueModeSchema.optional(),
	imessage: QueueModeSchema.optional(),
	msteams: QueueModeSchema.optional(),
	webchat: QueueModeSchema.optional()
}).strict().optional();
const DebounceMsBySurfaceSchema = z.record(z.string(), z.number().int().nonnegative()).optional();
const QueueSchema = z.object({
	mode: QueueModeSchema.optional(),
	byChannel: QueueModeBySurfaceSchema,
	debounceMs: z.number().int().nonnegative().optional(),
	debounceMsByChannel: DebounceMsBySurfaceSchema,
	cap: z.number().int().positive().optional(),
	drop: QueueDropSchema.optional()
}).strict().optional();
const InboundDebounceSchema = z.object({
	debounceMs: z.number().int().nonnegative().optional(),
	byChannel: DebounceMsBySurfaceSchema
}).strict().optional();
const TranscribeAudioSchema = z.object({
	command: z.array(z.string()).superRefine((value, ctx) => {
		const executable = value[0];
		if (!isSafeExecutableValue(executable)) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: [0],
			message: "expected safe executable name or path"
		});
	}),
	timeoutSeconds: z.number().int().positive().optional()
}).strict().optional();
const HexColorSchema = z.string().regex(/^#?[0-9a-fA-F]{6}$/, "expected hex color (RRGGBB)");
const ExecutableTokenSchema = z.string().refine(isSafeExecutableValue, "expected safe executable name or path");
const MediaUnderstandingScopeSchema = createAllowDenyChannelRulesSchema();
const MediaUnderstandingCapabilitiesSchema = z.array(z.union([
	z.literal("image"),
	z.literal("audio"),
	z.literal("video")
])).optional();
const MediaUnderstandingAttachmentsSchema = z.object({
	mode: z.union([z.literal("first"), z.literal("all")]).optional(),
	maxAttachments: z.number().int().positive().optional(),
	prefer: z.union([
		z.literal("first"),
		z.literal("last"),
		z.literal("path"),
		z.literal("url")
	]).optional()
}).strict().optional();
const DeepgramAudioSchema = z.object({
	detectLanguage: z.boolean().optional(),
	punctuate: z.boolean().optional(),
	smartFormat: z.boolean().optional()
}).strict().optional();
const ProviderOptionValueSchema = z.union([
	z.string(),
	z.number(),
	z.boolean()
]);
const ProviderOptionsSchema = z.record(z.string(), z.record(z.string(), ProviderOptionValueSchema)).optional();
const MediaUnderstandingRuntimeFields = {
	prompt: z.string().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	language: z.string().optional(),
	providerOptions: ProviderOptionsSchema,
	deepgram: DeepgramAudioSchema,
	baseUrl: z.string().optional(),
	headers: z.record(z.string(), z.string()).optional()
};
const MediaUnderstandingModelSchema = z.object({
	provider: z.string().optional(),
	model: z.string().optional(),
	capabilities: MediaUnderstandingCapabilitiesSchema,
	type: z.union([z.literal("provider"), z.literal("cli")]).optional(),
	command: z.string().optional(),
	args: z.array(z.string()).optional(),
	maxChars: z.number().int().positive().optional(),
	maxBytes: z.number().int().positive().optional(),
	...MediaUnderstandingRuntimeFields,
	profile: z.string().optional(),
	preferredProfile: z.string().optional()
}).strict().optional();
const ToolsMediaUnderstandingSchema = z.object({
	enabled: z.boolean().optional(),
	scope: MediaUnderstandingScopeSchema,
	maxBytes: z.number().int().positive().optional(),
	maxChars: z.number().int().positive().optional(),
	...MediaUnderstandingRuntimeFields,
	attachments: MediaUnderstandingAttachmentsSchema,
	models: z.array(MediaUnderstandingModelSchema).optional()
}).strict().optional();
const ToolsMediaSchema = z.object({
	models: z.array(MediaUnderstandingModelSchema).optional(),
	concurrency: z.number().int().positive().optional(),
	image: ToolsMediaUnderstandingSchema.optional(),
	audio: ToolsMediaUnderstandingSchema.optional(),
	video: ToolsMediaUnderstandingSchema.optional()
}).strict().optional();
const LinkModelSchema = z.object({
	type: z.literal("cli").optional(),
	command: z.string().min(1),
	args: z.array(z.string()).optional(),
	timeoutSeconds: z.number().int().positive().optional()
}).strict();
const ToolsLinksSchema = z.object({
	enabled: z.boolean().optional(),
	scope: MediaUnderstandingScopeSchema,
	maxLinks: z.number().int().positive().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	models: z.array(LinkModelSchema).optional()
}).strict().optional();
const NativeCommandsSettingSchema = z.union([z.boolean(), z.literal("auto")]);
const ProviderCommandsSchema = z.object({
	native: NativeCommandsSettingSchema.optional(),
	nativeSkills: NativeCommandsSettingSchema.optional()
}).strict().optional();

//#endregion
//#region src/config/zod-schema.agent-runtime.ts
const HeartbeatSchema = z.object({
	every: z.string().optional(),
	activeHours: z.object({
		start: z.string().optional(),
		end: z.string().optional(),
		timezone: z.string().optional()
	}).strict().optional(),
	model: z.string().optional(),
	session: z.string().optional(),
	includeReasoning: z.boolean().optional(),
	target: z.string().optional(),
	directPolicy: z.union([z.literal("allow"), z.literal("block")]).optional(),
	to: z.string().optional(),
	accountId: z.string().optional(),
	prompt: z.string().optional(),
	ackMaxChars: z.number().int().nonnegative().optional(),
	suppressToolErrorWarnings: z.boolean().optional()
}).strict().superRefine((val, ctx) => {
	if (!val.every) return;
	try {
		parseDurationMs(val.every, { defaultUnit: "m" });
	} catch {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["every"],
			message: "invalid duration (use ms, s, m, h)"
		});
	}
	const active = val.activeHours;
	if (!active) return;
	const timePattern = /^([01]\d|2[0-3]|24):([0-5]\d)$/;
	const validateTime = (raw, opts, path) => {
		if (!raw) return;
		if (!timePattern.test(raw)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["activeHours", path],
				message: "invalid time (use \"HH:MM\" 24h format)"
			});
			return;
		}
		const [hourStr, minuteStr] = raw.split(":");
		const hour = Number(hourStr);
		if (hour === 24 && Number(minuteStr) !== 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["activeHours", path],
				message: "invalid time (24:00 is the only allowed 24:xx value)"
			});
			return;
		}
		if (hour === 24 && !opts.allow24) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["activeHours", path],
			message: "invalid time (start cannot be 24:00)"
		});
	};
	validateTime(active.start, { allow24: false }, "start");
	validateTime(active.end, { allow24: true }, "end");
}).optional();
const SandboxDockerSchema = z.object({
	image: z.string().optional(),
	containerPrefix: z.string().optional(),
	workdir: z.string().optional(),
	readOnlyRoot: z.boolean().optional(),
	tmpfs: z.array(z.string()).optional(),
	network: z.string().optional(),
	user: z.string().optional(),
	capDrop: z.array(z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
	setupCommand: z.string().optional(),
	pidsLimit: z.number().int().positive().optional(),
	memory: z.union([z.string(), z.number()]).optional(),
	memorySwap: z.union([z.string(), z.number()]).optional(),
	cpus: z.number().positive().optional(),
	ulimits: z.record(z.string(), z.union([
		z.string(),
		z.number(),
		z.object({
			soft: z.number().int().nonnegative().optional(),
			hard: z.number().int().nonnegative().optional()
		}).strict()
	])).optional(),
	seccompProfile: z.string().optional(),
	apparmorProfile: z.string().optional(),
	dns: z.array(z.string()).optional(),
	extraHosts: z.array(z.string()).optional(),
	binds: z.array(z.string()).optional(),
	dangerouslyAllowReservedContainerTargets: z.boolean().optional(),
	dangerouslyAllowExternalBindSources: z.boolean().optional(),
	dangerouslyAllowContainerNamespaceJoin: z.boolean().optional()
}).strict().superRefine((data, ctx) => {
	if (data.binds) for (let i = 0; i < data.binds.length; i += 1) {
		const bind = data.binds[i]?.trim() ?? "";
		if (!bind) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["binds", i],
				message: "Sandbox security: bind mount entry must be a non-empty string."
			});
			continue;
		}
		const firstColon = bind.indexOf(":");
		const source = (firstColon <= 0 ? bind : bind.slice(0, firstColon)).trim();
		if (!source.startsWith("/")) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["binds", i],
			message: `Sandbox security: bind mount "${bind}" uses a non-absolute source path "${source}". Only absolute POSIX paths are supported for sandbox binds.`
		});
	}
	const blockedNetworkReason = getBlockedNetworkModeReason({
		network: data.network,
		allowContainerNamespaceJoin: data.dangerouslyAllowContainerNamespaceJoin === true
	});
	if (blockedNetworkReason === "host") ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["network"],
		message: "Sandbox security: network mode \"host\" is blocked. Use \"bridge\" or \"none\" instead."
	});
	if (blockedNetworkReason === "container_namespace_join") ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["network"],
		message: "Sandbox security: network mode \"container:*\" is blocked by default. Use a custom bridge network, or set dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime."
	});
	if (data.seccompProfile?.trim().toLowerCase() === "unconfined") ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["seccompProfile"],
		message: "Sandbox security: seccomp profile \"unconfined\" is blocked. Use a custom seccomp profile file or omit this setting."
	});
	if (data.apparmorProfile?.trim().toLowerCase() === "unconfined") ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["apparmorProfile"],
		message: "Sandbox security: apparmor profile \"unconfined\" is blocked. Use a named AppArmor profile or omit this setting."
	});
}).optional();
const SandboxBrowserSchema = z.object({
	enabled: z.boolean().optional(),
	image: z.string().optional(),
	containerPrefix: z.string().optional(),
	network: z.string().optional(),
	cdpPort: z.number().int().positive().optional(),
	cdpSourceRange: z.string().optional(),
	vncPort: z.number().int().positive().optional(),
	noVncPort: z.number().int().positive().optional(),
	headless: z.boolean().optional(),
	enableNoVnc: z.boolean().optional(),
	allowHostControl: z.boolean().optional(),
	autoStart: z.boolean().optional(),
	autoStartTimeoutMs: z.number().int().positive().optional(),
	binds: z.array(z.string()).optional()
}).superRefine((data, ctx) => {
	if (data.network?.trim().toLowerCase() === "host") ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["network"],
		message: "Sandbox security: browser network mode \"host\" is blocked. Use \"bridge\" or a custom bridge network instead."
	});
}).strict().optional();
const SandboxPruneSchema = z.object({
	idleHours: z.number().int().nonnegative().optional(),
	maxAgeDays: z.number().int().nonnegative().optional()
}).strict().optional();
const ToolPolicyBaseSchema = z.object({
	allow: z.array(z.string()).optional(),
	alsoAllow: z.array(z.string()).optional(),
	deny: z.array(z.string()).optional()
}).strict();
const ToolPolicySchema = ToolPolicyBaseSchema.superRefine((value, ctx) => {
	if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "tools policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)"
	});
}).optional();
const ToolsWebSearchSchema = z.object({
	enabled: z.boolean().optional(),
	provider: z.union([
		z.literal("brave"),
		z.literal("perplexity"),
		z.literal("grok"),
		z.literal("gemini"),
		z.literal("kimi")
	]).optional(),
	apiKey: z.string().optional().register(sensitive),
	maxResults: z.number().int().positive().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	cacheTtlMinutes: z.number().nonnegative().optional(),
	perplexity: z.object({
		apiKey: z.string().optional().register(sensitive),
		baseUrl: z.string().optional(),
		model: z.string().optional()
	}).strict().optional(),
	grok: z.object({
		apiKey: z.string().optional().register(sensitive),
		model: z.string().optional(),
		inlineCitations: z.boolean().optional()
	}).strict().optional(),
	gemini: z.object({
		apiKey: z.string().optional().register(sensitive),
		model: z.string().optional()
	}).strict().optional(),
	kimi: z.object({
		apiKey: z.string().optional().register(sensitive),
		baseUrl: z.string().optional(),
		model: z.string().optional()
	}).strict().optional()
}).strict().optional();
const ToolsWebFetchSchema = z.object({
	enabled: z.boolean().optional(),
	maxChars: z.number().int().positive().optional(),
	maxCharsCap: z.number().int().positive().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	cacheTtlMinutes: z.number().nonnegative().optional(),
	maxRedirects: z.number().int().nonnegative().optional(),
	userAgent: z.string().optional()
}).strict().optional();
const ToolsWebSchema = z.object({
	search: ToolsWebSearchSchema,
	fetch: ToolsWebFetchSchema
}).strict().optional();
const ToolProfileSchema = z.union([
	z.literal("minimal"),
	z.literal("coding"),
	z.literal("messaging"),
	z.literal("full")
]).optional();
function addAllowAlsoAllowConflictIssue(value, ctx, message) {
	if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message
	});
}
const ToolPolicyWithProfileSchema = z.object({
	allow: z.array(z.string()).optional(),
	alsoAllow: z.array(z.string()).optional(),
	deny: z.array(z.string()).optional(),
	profile: ToolProfileSchema
}).strict().superRefine((value, ctx) => {
	addAllowAlsoAllowConflictIssue(value, ctx, "tools.byProvider policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)");
});
const ElevatedAllowFromSchema = z.record(z.string(), z.array(z.union([z.string(), z.number()]))).optional();
const ToolExecApplyPatchSchema = z.object({
	enabled: z.boolean().optional(),
	workspaceOnly: z.boolean().optional(),
	allowModels: z.array(z.string()).optional()
}).strict().optional();
const ToolExecSafeBinProfileSchema = z.object({
	minPositional: z.number().int().nonnegative().optional(),
	maxPositional: z.number().int().nonnegative().optional(),
	allowedValueFlags: z.array(z.string()).optional(),
	deniedFlags: z.array(z.string()).optional()
}).strict();
const ToolExecBaseShape = {
	host: z.enum([
		"sandbox",
		"gateway",
		"node"
	]).optional(),
	security: z.enum([
		"deny",
		"allowlist",
		"full"
	]).optional(),
	ask: z.enum([
		"off",
		"on-miss",
		"always"
	]).optional(),
	node: z.string().optional(),
	pathPrepend: z.array(z.string()).optional(),
	safeBins: z.array(z.string()).optional(),
	safeBinTrustedDirs: z.array(z.string()).optional(),
	safeBinProfiles: z.record(z.string(), ToolExecSafeBinProfileSchema).optional(),
	backgroundMs: z.number().int().positive().optional(),
	timeoutSec: z.number().int().positive().optional(),
	cleanupMs: z.number().int().positive().optional(),
	notifyOnExit: z.boolean().optional(),
	notifyOnExitEmptySuccess: z.boolean().optional(),
	applyPatch: ToolExecApplyPatchSchema
};
const AgentToolExecSchema = z.object({
	...ToolExecBaseShape,
	approvalRunningNoticeMs: z.number().int().nonnegative().optional()
}).strict().optional();
const ToolExecSchema = z.object(ToolExecBaseShape).strict().optional();
const ToolFsSchema = z.object({ workspaceOnly: z.boolean().optional() }).strict().optional();
const ToolLoopDetectionDetectorSchema = z.object({
	genericRepeat: z.boolean().optional(),
	knownPollNoProgress: z.boolean().optional(),
	pingPong: z.boolean().optional()
}).strict().optional();
const ToolLoopDetectionSchema = z.object({
	enabled: z.boolean().optional(),
	historySize: z.number().int().positive().optional(),
	warningThreshold: z.number().int().positive().optional(),
	criticalThreshold: z.number().int().positive().optional(),
	globalCircuitBreakerThreshold: z.number().int().positive().optional(),
	detectors: ToolLoopDetectionDetectorSchema
}).strict().superRefine((value, ctx) => {
	if (value.warningThreshold !== void 0 && value.criticalThreshold !== void 0 && value.warningThreshold >= value.criticalThreshold) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["criticalThreshold"],
		message: "tools.loopDetection.warningThreshold must be lower than criticalThreshold."
	});
	if (value.criticalThreshold !== void 0 && value.globalCircuitBreakerThreshold !== void 0 && value.criticalThreshold >= value.globalCircuitBreakerThreshold) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["globalCircuitBreakerThreshold"],
		message: "tools.loopDetection.criticalThreshold must be lower than globalCircuitBreakerThreshold."
	});
}).optional();
const AgentSandboxSchema = z.object({
	mode: z.union([
		z.literal("off"),
		z.literal("non-main"),
		z.literal("all")
	]).optional(),
	workspaceAccess: z.union([
		z.literal("none"),
		z.literal("ro"),
		z.literal("rw")
	]).optional(),
	sessionToolsVisibility: z.union([z.literal("spawned"), z.literal("all")]).optional(),
	scope: z.union([
		z.literal("session"),
		z.literal("agent"),
		z.literal("shared")
	]).optional(),
	perSession: z.boolean().optional(),
	workspaceRoot: z.string().optional(),
	docker: SandboxDockerSchema,
	browser: SandboxBrowserSchema,
	prune: SandboxPruneSchema
}).strict().superRefine((data, ctx) => {
	if (getBlockedNetworkModeReason({
		network: data.browser?.network,
		allowContainerNamespaceJoin: data.docker?.dangerouslyAllowContainerNamespaceJoin === true
	}) === "container_namespace_join") ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["browser", "network"],
		message: "Sandbox security: browser network mode \"container:*\" is blocked by default. Set sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime."
	});
}).optional();
const CommonToolPolicyFields = {
	profile: ToolProfileSchema,
	allow: z.array(z.string()).optional(),
	alsoAllow: z.array(z.string()).optional(),
	deny: z.array(z.string()).optional(),
	byProvider: z.record(z.string(), ToolPolicyWithProfileSchema).optional()
};
const AgentToolsSchema = z.object({
	...CommonToolPolicyFields,
	elevated: z.object({
		enabled: z.boolean().optional(),
		allowFrom: ElevatedAllowFromSchema
	}).strict().optional(),
	exec: AgentToolExecSchema,
	fs: ToolFsSchema,
	loopDetection: ToolLoopDetectionSchema,
	sandbox: z.object({ tools: ToolPolicySchema }).strict().optional()
}).strict().superRefine((value, ctx) => {
	addAllowAlsoAllowConflictIssue(value, ctx, "agent tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)");
}).optional();
const MemorySearchSchema = z.object({
	enabled: z.boolean().optional(),
	sources: z.array(z.union([z.literal("memory"), z.literal("sessions")])).optional(),
	extraPaths: z.array(z.string()).optional(),
	experimental: z.object({ sessionMemory: z.boolean().optional() }).strict().optional(),
	provider: z.union([
		z.literal("openai"),
		z.literal("local"),
		z.literal("gemini"),
		z.literal("voyage"),
		z.literal("mistral")
	]).optional(),
	remote: z.object({
		baseUrl: z.string().optional(),
		apiKey: z.string().optional().register(sensitive),
		headers: z.record(z.string(), z.string()).optional(),
		batch: z.object({
			enabled: z.boolean().optional(),
			wait: z.boolean().optional(),
			concurrency: z.number().int().positive().optional(),
			pollIntervalMs: z.number().int().nonnegative().optional(),
			timeoutMinutes: z.number().int().positive().optional()
		}).strict().optional()
	}).strict().optional(),
	fallback: z.union([
		z.literal("openai"),
		z.literal("gemini"),
		z.literal("local"),
		z.literal("voyage"),
		z.literal("mistral"),
		z.literal("none")
	]).optional(),
	model: z.string().optional(),
	local: z.object({
		modelPath: z.string().optional(),
		modelCacheDir: z.string().optional()
	}).strict().optional(),
	store: z.object({
		driver: z.literal("sqlite").optional(),
		path: z.string().optional(),
		vector: z.object({
			enabled: z.boolean().optional(),
			extensionPath: z.string().optional()
		}).strict().optional()
	}).strict().optional(),
	chunking: z.object({
		tokens: z.number().int().positive().optional(),
		overlap: z.number().int().nonnegative().optional()
	}).strict().optional(),
	sync: z.object({
		onSessionStart: z.boolean().optional(),
		onSearch: z.boolean().optional(),
		watch: z.boolean().optional(),
		watchDebounceMs: z.number().int().nonnegative().optional(),
		intervalMinutes: z.number().int().nonnegative().optional(),
		sessions: z.object({
			deltaBytes: z.number().int().nonnegative().optional(),
			deltaMessages: z.number().int().nonnegative().optional()
		}).strict().optional()
	}).strict().optional(),
	query: z.object({
		maxResults: z.number().int().positive().optional(),
		minScore: z.number().min(0).max(1).optional(),
		hybrid: z.object({
			enabled: z.boolean().optional(),
			vectorWeight: z.number().min(0).max(1).optional(),
			textWeight: z.number().min(0).max(1).optional(),
			candidateMultiplier: z.number().int().positive().optional(),
			mmr: z.object({
				enabled: z.boolean().optional(),
				lambda: z.number().min(0).max(1).optional()
			}).strict().optional(),
			temporalDecay: z.object({
				enabled: z.boolean().optional(),
				halfLifeDays: z.number().int().positive().optional()
			}).strict().optional()
		}).strict().optional()
	}).strict().optional(),
	cache: z.object({
		enabled: z.boolean().optional(),
		maxEntries: z.number().int().positive().optional()
	}).strict().optional()
}).strict().optional();
const AgentEntrySchema = z.object({
	id: z.string(),
	default: z.boolean().optional(),
	name: z.string().optional(),
	workspace: z.string().optional(),
	agentDir: z.string().optional(),
	model: AgentModelSchema.optional(),
	skills: z.array(z.string()).optional(),
	memorySearch: MemorySearchSchema,
	humanDelay: HumanDelaySchema.optional(),
	heartbeat: HeartbeatSchema,
	identity: IdentitySchema,
	groupChat: GroupChatSchema,
	subagents: z.object({
		allowAgents: z.array(z.string()).optional(),
		model: z.union([z.string(), z.object({
			primary: z.string().optional(),
			fallbacks: z.array(z.string()).optional()
		}).strict()]).optional(),
		thinking: z.string().optional()
	}).strict().optional(),
	sandbox: AgentSandboxSchema,
	tools: AgentToolsSchema
}).strict();
const ToolsSchema = z.object({
	...CommonToolPolicyFields,
	web: ToolsWebSchema,
	media: ToolsMediaSchema,
	links: ToolsLinksSchema,
	sessions: z.object({ visibility: z.enum([
		"self",
		"tree",
		"agent",
		"all"
	]).optional() }).strict().optional(),
	loopDetection: ToolLoopDetectionSchema,
	message: z.object({
		allowCrossContextSend: z.boolean().optional(),
		crossContext: z.object({
			allowWithinProvider: z.boolean().optional(),
			allowAcrossProviders: z.boolean().optional(),
			marker: z.object({
				enabled: z.boolean().optional(),
				prefix: z.string().optional(),
				suffix: z.string().optional()
			}).strict().optional()
		}).strict().optional(),
		broadcast: z.object({ enabled: z.boolean().optional() }).strict().optional()
	}).strict().optional(),
	agentToAgent: z.object({
		enabled: z.boolean().optional(),
		allow: z.array(z.string()).optional()
	}).strict().optional(),
	elevated: z.object({
		enabled: z.boolean().optional(),
		allowFrom: ElevatedAllowFromSchema
	}).strict().optional(),
	exec: ToolExecSchema,
	fs: ToolFsSchema,
	subagents: z.object({ tools: ToolPolicySchema }).strict().optional(),
	sandbox: z.object({ tools: ToolPolicySchema }).strict().optional()
}).strict().superRefine((value, ctx) => {
	addAllowAlsoAllowConflictIssue(value, ctx, "tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)");
}).optional();

//#endregion
//#region src/config/zod-schema.agent-defaults.ts
const AgentDefaultsSchema = z.object({
	model: AgentModelSchema.optional(),
	imageModel: AgentModelSchema.optional(),
	models: z.record(z.string(), z.object({
		alias: z.string().optional(),
		params: z.record(z.string(), z.unknown()).optional(),
		streaming: z.boolean().optional()
	}).strict()).optional(),
	workspace: z.string().optional(),
	repoRoot: z.string().optional(),
	skipBootstrap: z.boolean().optional(),
	bootstrapMaxChars: z.number().int().positive().optional(),
	bootstrapTotalMaxChars: z.number().int().positive().optional(),
	userTimezone: z.string().optional(),
	timeFormat: z.union([
		z.literal("auto"),
		z.literal("12"),
		z.literal("24")
	]).optional(),
	envelopeTimezone: z.string().optional(),
	envelopeTimestamp: z.union([z.literal("on"), z.literal("off")]).optional(),
	envelopeElapsed: z.union([z.literal("on"), z.literal("off")]).optional(),
	contextTokens: z.number().int().positive().optional(),
	cliBackends: z.record(z.string(), CliBackendSchema).optional(),
	memorySearch: MemorySearchSchema,
	contextPruning: z.object({
		mode: z.union([z.literal("off"), z.literal("cache-ttl")]).optional(),
		ttl: z.string().optional(),
		keepLastAssistants: z.number().int().nonnegative().optional(),
		softTrimRatio: z.number().min(0).max(1).optional(),
		hardClearRatio: z.number().min(0).max(1).optional(),
		minPrunableToolChars: z.number().int().nonnegative().optional(),
		tools: z.object({
			allow: z.array(z.string()).optional(),
			deny: z.array(z.string()).optional()
		}).strict().optional(),
		softTrim: z.object({
			maxChars: z.number().int().nonnegative().optional(),
			headChars: z.number().int().nonnegative().optional(),
			tailChars: z.number().int().nonnegative().optional()
		}).strict().optional(),
		hardClear: z.object({
			enabled: z.boolean().optional(),
			placeholder: z.string().optional()
		}).strict().optional()
	}).strict().optional(),
	compaction: z.object({
		mode: z.union([z.literal("default"), z.literal("safeguard")]).optional(),
		reserveTokens: z.number().int().nonnegative().optional(),
		keepRecentTokens: z.number().int().positive().optional(),
		reserveTokensFloor: z.number().int().nonnegative().optional(),
		maxHistoryShare: z.number().min(.1).max(.9).optional(),
		identifierPolicy: z.union([
			z.literal("strict"),
			z.literal("off"),
			z.literal("custom")
		]).optional(),
		identifierInstructions: z.string().optional(),
		memoryFlush: z.object({
			enabled: z.boolean().optional(),
			softThresholdTokens: z.number().int().nonnegative().optional(),
			prompt: z.string().optional(),
			systemPrompt: z.string().optional()
		}).strict().optional()
	}).strict().optional(),
	embeddedPi: z.object({ projectSettingsPolicy: z.union([
		z.literal("trusted"),
		z.literal("sanitize"),
		z.literal("ignore")
	]).optional() }).strict().optional(),
	thinkingDefault: z.union([
		z.literal("off"),
		z.literal("minimal"),
		z.literal("low"),
		z.literal("medium"),
		z.literal("high"),
		z.literal("xhigh")
	]).optional(),
	verboseDefault: z.union([
		z.literal("off"),
		z.literal("on"),
		z.literal("full")
	]).optional(),
	elevatedDefault: z.union([
		z.literal("off"),
		z.literal("on"),
		z.literal("ask"),
		z.literal("full")
	]).optional(),
	blockStreamingDefault: z.union([z.literal("off"), z.literal("on")]).optional(),
	blockStreamingBreak: z.union([z.literal("text_end"), z.literal("message_end")]).optional(),
	blockStreamingChunk: BlockStreamingChunkSchema.optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	humanDelay: HumanDelaySchema.optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	mediaMaxMb: z.number().positive().optional(),
	imageMaxDimensionPx: z.number().int().positive().optional(),
	typingIntervalSeconds: z.number().int().positive().optional(),
	typingMode: TypingModeSchema.optional(),
	heartbeat: HeartbeatSchema,
	maxConcurrent: z.number().int().positive().optional(),
	subagents: z.object({
		maxConcurrent: z.number().int().positive().optional(),
		maxSpawnDepth: z.number().int().min(1).max(5).optional().describe("Maximum nesting depth for sub-agent spawning. 1 = no nesting (default), 2 = sub-agents can spawn sub-sub-agents."),
		maxChildrenPerAgent: z.number().int().min(1).max(20).optional().describe("Maximum number of active children a single agent session can spawn (default: 5)."),
		archiveAfterMinutes: z.number().int().positive().optional(),
		model: AgentModelSchema.optional(),
		thinking: z.string().optional(),
		runTimeoutSeconds: z.number().int().min(0).optional(),
		announceTimeoutMs: z.number().int().positive().optional()
	}).strict().optional(),
	sandbox: AgentSandboxSchema
}).strict().optional();

//#endregion
//#region src/config/zod-schema.agents.ts
const AgentsSchema = z.object({
	defaults: z.lazy(() => AgentDefaultsSchema).optional(),
	list: z.array(AgentEntrySchema).optional()
}).strict().optional();
const BindingsSchema = z.array(z.object({
	agentId: z.string(),
	comment: z.string().optional(),
	match: z.object({
		channel: z.string(),
		accountId: z.string().optional(),
		peer: z.object({
			kind: z.union([
				z.literal("direct"),
				z.literal("group"),
				z.literal("channel"),
				z.literal("dm")
			]),
			id: z.string()
		}).strict().optional(),
		guildId: z.string().optional(),
		teamId: z.string().optional(),
		roles: z.array(z.string()).optional()
	}).strict()
}).strict()).optional();
const BroadcastStrategySchema = z.enum(["parallel", "sequential"]);
const BroadcastSchema = z.object({ strategy: BroadcastStrategySchema.optional() }).catchall(z.array(z.string())).optional();
const AudioSchema = z.object({ transcription: TranscribeAudioSchema }).strict().optional();

//#endregion
//#region src/config/zod-schema.approvals.ts
const ExecApprovalForwardTargetSchema = z.object({
	channel: z.string().min(1),
	to: z.string().min(1),
	accountId: z.string().optional(),
	threadId: z.union([z.string(), z.number()]).optional()
}).strict();
const ExecApprovalForwardingSchema = z.object({
	enabled: z.boolean().optional(),
	mode: z.union([
		z.literal("session"),
		z.literal("targets"),
		z.literal("both")
	]).optional(),
	agentFilter: z.array(z.string()).optional(),
	sessionFilter: z.array(z.string()).optional(),
	targets: z.array(ExecApprovalForwardTargetSchema).optional()
}).strict().optional();
const ApprovalsSchema = z.object({ exec: ExecApprovalForwardingSchema }).strict().optional();

//#endregion
//#region src/config/zod-schema.installs.ts
const InstallSourceSchema = z.union([
	z.literal("npm"),
	z.literal("archive"),
	z.literal("path")
]);
const InstallRecordShape = {
	source: InstallSourceSchema,
	spec: z.string().optional(),
	sourcePath: z.string().optional(),
	installPath: z.string().optional(),
	version: z.string().optional(),
	resolvedName: z.string().optional(),
	resolvedVersion: z.string().optional(),
	resolvedSpec: z.string().optional(),
	integrity: z.string().optional(),
	shasum: z.string().optional(),
	resolvedAt: z.string().optional(),
	installedAt: z.string().optional()
};

//#endregion
//#region src/config/zod-schema.hooks.ts
function isSafeRelativeModulePath(raw) {
	const value = raw.trim();
	if (!value) return false;
	if (path.isAbsolute(value)) return false;
	if (value.startsWith("~")) return false;
	if (value.includes(":")) return false;
	if (value.split(/[\\/]+/g).some((part) => part === "..")) return false;
	return true;
}
const SafeRelativeModulePathSchema = z.string().refine(isSafeRelativeModulePath, "module must be a safe relative path (no absolute paths)");
const HookMappingSchema = z.object({
	id: z.string().optional(),
	match: z.object({
		path: z.string().optional(),
		source: z.string().optional()
	}).optional(),
	action: z.union([z.literal("wake"), z.literal("agent")]).optional(),
	wakeMode: z.union([z.literal("now"), z.literal("next-heartbeat")]).optional(),
	name: z.string().optional(),
	agentId: z.string().optional(),
	sessionKey: z.string().optional().register(sensitive),
	messageTemplate: z.string().optional(),
	textTemplate: z.string().optional(),
	deliver: z.boolean().optional(),
	allowUnsafeExternalContent: z.boolean().optional(),
	channel: z.union([
		z.literal("last"),
		z.literal("whatsapp"),
		z.literal("telegram"),
		z.literal("discord"),
		z.literal("irc"),
		z.literal("slack"),
		z.literal("signal"),
		z.literal("imessage"),
		z.literal("msteams")
	]).optional(),
	to: z.string().optional(),
	model: z.string().optional(),
	thinking: z.string().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	transform: z.object({
		module: SafeRelativeModulePathSchema,
		export: z.string().optional()
	}).strict().optional()
}).strict().optional();
const InternalHookHandlerSchema = z.object({
	event: z.string(),
	module: SafeRelativeModulePathSchema,
	export: z.string().optional()
}).strict();
const HookConfigSchema = z.object({
	enabled: z.boolean().optional(),
	env: z.record(z.string(), z.string()).optional()
}).passthrough();
const HookInstallRecordSchema = z.object({
	...InstallRecordShape,
	hooks: z.array(z.string()).optional()
}).strict();
const InternalHooksSchema = z.object({
	enabled: z.boolean().optional(),
	handlers: z.array(InternalHookHandlerSchema).optional(),
	entries: z.record(z.string(), HookConfigSchema).optional(),
	load: z.object({ extraDirs: z.array(z.string()).optional() }).strict().optional(),
	installs: z.record(z.string(), HookInstallRecordSchema).optional()
}).strict().optional();
const HooksGmailSchema = z.object({
	account: z.string().optional(),
	label: z.string().optional(),
	topic: z.string().optional(),
	subscription: z.string().optional(),
	pushToken: z.string().optional().register(sensitive),
	hookUrl: z.string().optional(),
	includeBody: z.boolean().optional(),
	maxBytes: z.number().int().positive().optional(),
	renewEveryMinutes: z.number().int().positive().optional(),
	allowUnsafeExternalContent: z.boolean().optional(),
	serve: z.object({
		bind: z.string().optional(),
		port: z.number().int().positive().optional(),
		path: z.string().optional()
	}).strict().optional(),
	tailscale: z.object({
		mode: z.union([
			z.literal("off"),
			z.literal("serve"),
			z.literal("funnel")
		]).optional(),
		path: z.string().optional(),
		target: z.string().optional()
	}).strict().optional(),
	model: z.string().optional(),
	thinking: z.union([
		z.literal("off"),
		z.literal("minimal"),
		z.literal("low"),
		z.literal("medium"),
		z.literal("high")
	]).optional()
}).strict().optional();

//#endregion
//#region src/config/zod-schema.channels.ts
const ChannelHeartbeatVisibilitySchema = z.object({
	showOk: z.boolean().optional(),
	showAlerts: z.boolean().optional(),
	useIndicator: z.boolean().optional()
}).strict().optional();

//#endregion
//#region src/infra/scp-host.ts
const SSH_TOKEN = /^[A-Za-z0-9._-]+$/;
const BRACKETED_IPV6 = /^\[[0-9A-Fa-f:.%]+\]$/;
const WHITESPACE = /\s/;
function hasControlOrWhitespace(value) {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code <= 31 || code === 127 || WHITESPACE.test(char)) return true;
	}
	return false;
}
function normalizeScpRemoteHost(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (!trimmed) return;
	if (hasControlOrWhitespace(trimmed)) return;
	if (trimmed.startsWith("-") || trimmed.includes("/") || trimmed.includes("\\")) return;
	const firstAt = trimmed.indexOf("@");
	const lastAt = trimmed.lastIndexOf("@");
	let user;
	let host = trimmed;
	if (firstAt !== -1) {
		if (firstAt !== lastAt || firstAt === 0 || firstAt === trimmed.length - 1) return;
		user = trimmed.slice(0, firstAt);
		host = trimmed.slice(firstAt + 1);
		if (!SSH_TOKEN.test(user)) return;
	}
	if (!host || host.startsWith("-") || host.includes("@")) return;
	if (host.includes(":") && !BRACKETED_IPV6.test(host)) return;
	if (!SSH_TOKEN.test(host) && !BRACKETED_IPV6.test(host)) return;
	return user ? `${user}@${host}` : host;
}
function isSafeScpRemoteHost(value) {
	return normalizeScpRemoteHost(value) !== void 0;
}

//#endregion
//#region src/media/inbound-path-policy.ts
const WILDCARD_SEGMENT = "*";
const WINDOWS_DRIVE_ABS_RE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:$/;
const DEFAULT_IMESSAGE_ATTACHMENT_ROOTS = ["/Users/*/Library/Messages/Attachments"];
function normalizePosixAbsolutePath(value) {
	const trimmed = value.trim();
	if (!trimmed || trimmed.includes("\0")) return;
	const normalized = path.posix.normalize(trimmed.replaceAll("\\", "/"));
	if (!(normalized.startsWith("/") || WINDOWS_DRIVE_ABS_RE.test(normalized)) || normalized === "/") return;
	const withoutTrailingSlash = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	if (WINDOWS_DRIVE_ROOT_RE.test(withoutTrailingSlash)) return;
	return withoutTrailingSlash;
}
function splitPathSegments(value) {
	return value.split("/").filter(Boolean);
}
function matchesRootPattern(params) {
	const candidateSegments = splitPathSegments(params.candidatePath);
	const rootSegments = splitPathSegments(params.rootPattern);
	if (candidateSegments.length < rootSegments.length) return false;
	for (let idx = 0; idx < rootSegments.length; idx += 1) {
		const expected = rootSegments[idx];
		const actual = candidateSegments[idx];
		if (expected === WILDCARD_SEGMENT) continue;
		if (expected !== actual) return false;
	}
	return true;
}
function isValidInboundPathRootPattern(value) {
	const normalized = normalizePosixAbsolutePath(value);
	if (!normalized) return false;
	const segments = splitPathSegments(normalized);
	if (segments.length === 0) return false;
	return segments.every((segment) => segment === WILDCARD_SEGMENT || !segment.includes("*"));
}
function normalizeInboundPathRoots(roots) {
	const normalized = [];
	const seen = /* @__PURE__ */ new Set();
	for (const root of roots ?? []) {
		if (typeof root !== "string") continue;
		if (!isValidInboundPathRootPattern(root)) continue;
		const candidate = normalizePosixAbsolutePath(root);
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		normalized.push(candidate);
	}
	return normalized;
}
function mergeInboundPathRoots(...rootsLists) {
	const merged = [];
	const seen = /* @__PURE__ */ new Set();
	for (const roots of rootsLists) {
		const normalized = normalizeInboundPathRoots(roots);
		for (const root of normalized) {
			if (seen.has(root)) continue;
			seen.add(root);
			merged.push(root);
		}
	}
	return merged;
}
function isInboundPathAllowed(params) {
	const candidatePath = normalizePosixAbsolutePath(params.filePath);
	if (!candidatePath) return false;
	const roots = normalizeInboundPathRoots(params.roots);
	const effectiveRoots = roots.length > 0 ? roots : normalizeInboundPathRoots(params.fallbackRoots ?? void 0);
	if (effectiveRoots.length === 0) return false;
	return effectiveRoots.some((rootPattern) => matchesRootPattern({
		candidatePath,
		rootPattern
	}));
}
function resolveIMessageAccountConfig(params) {
	const accountId = params.accountId?.trim();
	if (!accountId) return;
	return params.cfg.channels?.imessage?.accounts?.[accountId];
}
function resolveIMessageAttachmentRoots(params) {
	return mergeInboundPathRoots(resolveIMessageAccountConfig(params)?.attachmentRoots, params.cfg.channels?.imessage?.attachmentRoots, DEFAULT_IMESSAGE_ATTACHMENT_ROOTS);
}
function resolveIMessageRemoteAttachmentRoots(params) {
	const accountConfig = resolveIMessageAccountConfig(params);
	return mergeInboundPathRoots(accountConfig?.remoteAttachmentRoots, params.cfg.channels?.imessage?.remoteAttachmentRoots, accountConfig?.attachmentRoots, params.cfg.channels?.imessage?.attachmentRoots, DEFAULT_IMESSAGE_ATTACHMENT_ROOTS);
}

//#endregion
//#region src/config/telegram-custom-commands.ts
const TELEGRAM_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
function normalizeTelegramCommandName(value) {
	const trimmed = value.trim();
	if (!trimmed) return "";
	return (trimmed.startsWith("/") ? trimmed.slice(1) : trimmed).trim().toLowerCase().replace(/-/g, "_");
}
function normalizeTelegramCommandDescription(value) {
	return value.trim();
}
function resolveTelegramCustomCommands(params) {
	const entries = Array.isArray(params.commands) ? params.commands : [];
	const reserved = params.reservedCommands ?? /* @__PURE__ */ new Set();
	const checkReserved = params.checkReserved !== false;
	const checkDuplicates = params.checkDuplicates !== false;
	const seen = /* @__PURE__ */ new Set();
	const resolved = [];
	const issues = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const normalized = normalizeTelegramCommandName(String(entry?.command ?? ""));
		if (!normalized) {
			issues.push({
				index,
				field: "command",
				message: "Telegram custom command is missing a command name."
			});
			continue;
		}
		if (!TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
			issues.push({
				index,
				field: "command",
				message: `Telegram custom command "/${normalized}" is invalid (use a-z, 0-9, underscore; max 32 chars).`
			});
			continue;
		}
		if (checkReserved && reserved.has(normalized)) {
			issues.push({
				index,
				field: "command",
				message: `Telegram custom command "/${normalized}" conflicts with a native command.`
			});
			continue;
		}
		if (checkDuplicates && seen.has(normalized)) {
			issues.push({
				index,
				field: "command",
				message: `Telegram custom command "/${normalized}" is duplicated.`
			});
			continue;
		}
		const description = normalizeTelegramCommandDescription(String(entry?.description ?? ""));
		if (!description) {
			issues.push({
				index,
				field: "description",
				message: `Telegram custom command "/${normalized}" is missing a description.`
			});
			continue;
		}
		if (checkDuplicates) seen.add(normalized);
		resolved.push({
			command: normalized,
			description
		});
	}
	return {
		commands: resolved,
		issues
	};
}

//#endregion
//#region src/config/zod-schema.providers-core.ts
const ToolPolicyBySenderSchema$1 = z.record(z.string(), ToolPolicySchema).optional();
const DiscordIdSchema = z.union([z.string(), z.number()]).refine((value) => typeof value === "string", { message: "Discord IDs must be strings (wrap numeric IDs in quotes)." });
const DiscordIdListSchema = z.array(DiscordIdSchema);
const TelegramInlineButtonsScopeSchema = z.enum([
	"off",
	"dm",
	"group",
	"all",
	"allowlist"
]);
const TelegramCapabilitiesSchema = z.union([z.array(z.string()), z.object({ inlineButtons: TelegramInlineButtonsScopeSchema.optional() }).strict()]);
const TelegramTopicSchema = z.object({
	requireMention: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional(),
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional()
}).strict();
const TelegramGroupSchema = z.object({
	requireMention: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional(),
	topics: z.record(z.string(), TelegramTopicSchema.optional()).optional()
}).strict();
const TelegramCustomCommandSchema = z.object({
	command: z.string().transform(normalizeTelegramCommandName),
	description: z.string().transform(normalizeTelegramCommandDescription)
}).strict();
const validateTelegramCustomCommands = (value, ctx) => {
	if (!value.customCommands || value.customCommands.length === 0) return;
	const { issues } = resolveTelegramCustomCommands({
		commands: value.customCommands,
		checkReserved: false,
		checkDuplicates: false
	});
	for (const issue of issues) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: [
			"customCommands",
			issue.index,
			issue.field
		],
		message: issue.message
	});
};
function normalizeTelegramStreamingConfig(value) {
	value.streaming = resolveTelegramPreviewStreamMode(value);
	delete value.streamMode;
}
function normalizeDiscordStreamingConfig(value) {
	value.streaming = resolveDiscordPreviewStreamMode(value);
	delete value.streamMode;
}
function normalizeSlackStreamingConfig(value) {
	value.nativeStreaming = resolveSlackNativeStreaming(value);
	value.streaming = resolveSlackStreamingMode(value);
	delete value.streamMode;
}
const TelegramAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: TelegramCapabilitiesSchema.optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	commands: ProviderCommandsSchema,
	customCommands: z.array(TelegramCustomCommandSchema).optional(),
	configWrites: z.boolean().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	botToken: z.string().optional().register(sensitive),
	tokenFile: z.string().optional(),
	replyToMode: ReplyToModeSchema.optional(),
	groups: z.record(z.string(), TelegramGroupSchema.optional()).optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	defaultTo: z.union([z.string(), z.number()]).optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	streaming: z.union([z.boolean(), z.enum([
		"off",
		"partial",
		"block",
		"progress"
	])]).optional(),
	blockStreaming: z.boolean().optional(),
	draftChunk: BlockStreamingChunkSchema.optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	streamMode: z.enum([
		"off",
		"partial",
		"block"
	]).optional(),
	mediaMaxMb: z.number().positive().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	retry: RetryConfigSchema,
	network: z.object({
		autoSelectFamily: z.boolean().optional(),
		dnsResultOrder: z.enum(["ipv4first", "verbatim"]).optional()
	}).strict().optional(),
	proxy: z.string().optional(),
	webhookUrl: z.string().optional().describe("Public HTTPS webhook URL registered with Telegram for inbound updates. This must be internet-reachable and requires channels.telegram.webhookSecret."),
	webhookSecret: z.string().optional().describe("Secret token sent to Telegram during webhook registration and verified on inbound webhook requests. Telegram returns this value for verification; this is not the gateway auth token and not the bot token.").register(sensitive),
	webhookPath: z.string().optional().describe("Local webhook route path served by the gateway listener. Defaults to /telegram-webhook."),
	webhookHost: z.string().optional().describe("Local bind host for the webhook listener. Defaults to 127.0.0.1; keep loopback unless you intentionally expose direct ingress."),
	webhookPort: z.number().int().nonnegative().optional().describe("Local bind port for the webhook listener. Defaults to 8787; set to 0 to let the OS assign an ephemeral port."),
	actions: z.object({
		reactions: z.boolean().optional(),
		sendMessage: z.boolean().optional(),
		deleteMessage: z.boolean().optional(),
		sticker: z.boolean().optional()
	}).strict().optional(),
	reactionNotifications: z.enum([
		"off",
		"own",
		"all"
	]).optional(),
	reactionLevel: z.enum([
		"off",
		"ack",
		"minimal",
		"extensive"
	]).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	linkPreview: z.boolean().optional(),
	responsePrefix: z.string().optional(),
	ackReaction: z.string().optional()
}).strict();
const TelegramAccountSchema = TelegramAccountSchemaBase.superRefine((value, ctx) => {
	normalizeTelegramStreamingConfig(value);
	validateTelegramCustomCommands(value, ctx);
});
const TelegramConfigSchema = TelegramAccountSchemaBase.extend({ accounts: z.record(z.string(), TelegramAccountSchema.optional()).optional() }).superRefine((value, ctx) => {
	normalizeTelegramStreamingConfig(value);
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.telegram.dmPolicy=\"open\" requires channels.telegram.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.telegram.dmPolicy=\"allowlist\" requires channels.telegram.allowFrom to contain at least one sender ID"
	});
	validateTelegramCustomCommands(value, ctx);
	if (value.accounts) for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.telegram.accounts.*.dmPolicy=\"open\" requires channels.telegram.accounts.*.allowFrom (or channels.telegram.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.telegram.accounts.*.dmPolicy=\"allowlist\" requires channels.telegram.accounts.*.allowFrom (or channels.telegram.allowFrom) to contain at least one sender ID"
		});
	}
	const baseWebhookUrl = typeof value.webhookUrl === "string" ? value.webhookUrl.trim() : "";
	const baseWebhookSecret = typeof value.webhookSecret === "string" ? value.webhookSecret.trim() : "";
	if (baseWebhookUrl && !baseWebhookSecret) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.telegram.webhookUrl requires channels.telegram.webhookSecret",
		path: ["webhookSecret"]
	});
	if (!value.accounts) return;
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		if (account.enabled === false) continue;
		const effectiveDmPolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = Array.isArray(account.allowFrom) ? account.allowFrom : value.allowFrom;
		requireOpenAllowFrom({
			policy: effectiveDmPolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.telegram.accounts.*.dmPolicy=\"open\" requires channels.telegram.allowFrom or channels.telegram.accounts.*.allowFrom to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectiveDmPolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.telegram.accounts.*.dmPolicy=\"allowlist\" requires channels.telegram.allowFrom or channels.telegram.accounts.*.allowFrom to contain at least one sender ID"
		});
		if (!(typeof account.webhookUrl === "string" ? account.webhookUrl.trim() : "")) continue;
		if (!(typeof account.webhookSecret === "string" ? account.webhookSecret.trim() : "") && !baseWebhookSecret) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "channels.telegram.accounts.*.webhookUrl requires channels.telegram.webhookSecret or channels.telegram.accounts.*.webhookSecret",
			path: [
				"accounts",
				accountId,
				"webhookSecret"
			]
		});
	}
});
const DiscordDmSchema = z.object({
	enabled: z.boolean().optional(),
	policy: DmPolicySchema.optional(),
	allowFrom: DiscordIdListSchema.optional(),
	groupEnabled: z.boolean().optional(),
	groupChannels: DiscordIdListSchema.optional()
}).strict();
const DiscordGuildChannelSchema = z.object({
	allow: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	users: DiscordIdListSchema.optional(),
	roles: DiscordIdListSchema.optional(),
	systemPrompt: z.string().optional(),
	includeThreadStarter: z.boolean().optional(),
	autoThread: z.boolean().optional()
}).strict();
const DiscordGuildSchema = z.object({
	slug: z.string().optional(),
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	reactionNotifications: z.enum([
		"off",
		"own",
		"all",
		"allowlist"
	]).optional(),
	users: DiscordIdListSchema.optional(),
	roles: DiscordIdListSchema.optional(),
	channels: z.record(z.string(), DiscordGuildChannelSchema.optional()).optional()
}).strict();
const DiscordUiSchema = z.object({ components: z.object({ accentColor: HexColorSchema.optional() }).strict().optional() }).strict().optional();
const DiscordVoiceAutoJoinSchema = z.object({
	guildId: z.string().min(1),
	channelId: z.string().min(1)
}).strict();
const DiscordVoiceSchema = z.object({
	enabled: z.boolean().optional(),
	autoJoin: z.array(DiscordVoiceAutoJoinSchema).optional(),
	daveEncryption: z.boolean().optional(),
	decryptionFailureTolerance: z.number().int().min(0).optional(),
	tts: TtsConfigSchema.optional()
}).strict().optional();
const DiscordAccountSchema = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	commands: ProviderCommandsSchema,
	configWrites: z.boolean().optional(),
	token: z.string().optional().register(sensitive),
	proxy: z.string().optional(),
	allowBots: z.boolean().optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	streaming: z.union([z.boolean(), z.enum([
		"off",
		"partial",
		"block",
		"progress"
	])]).optional(),
	streamMode: z.enum([
		"partial",
		"block",
		"off"
	]).optional(),
	draftChunk: BlockStreamingChunkSchema.optional(),
	maxLinesPerMessage: z.number().int().positive().optional(),
	mediaMaxMb: z.number().positive().optional(),
	retry: RetryConfigSchema,
	actions: z.object({
		reactions: z.boolean().optional(),
		stickers: z.boolean().optional(),
		emojiUploads: z.boolean().optional(),
		stickerUploads: z.boolean().optional(),
		polls: z.boolean().optional(),
		permissions: z.boolean().optional(),
		messages: z.boolean().optional(),
		threads: z.boolean().optional(),
		pins: z.boolean().optional(),
		search: z.boolean().optional(),
		memberInfo: z.boolean().optional(),
		roleInfo: z.boolean().optional(),
		roles: z.boolean().optional(),
		channelInfo: z.boolean().optional(),
		voiceStatus: z.boolean().optional(),
		events: z.boolean().optional(),
		moderation: z.boolean().optional(),
		channels: z.boolean().optional(),
		presence: z.boolean().optional()
	}).strict().optional(),
	replyToMode: ReplyToModeSchema.optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: DiscordIdListSchema.optional(),
	defaultTo: z.string().optional(),
	dm: DiscordDmSchema.optional(),
	guilds: z.record(z.string(), DiscordGuildSchema.optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	execApprovals: z.object({
		enabled: z.boolean().optional(),
		approvers: DiscordIdListSchema.optional(),
		agentFilter: z.array(z.string()).optional(),
		sessionFilter: z.array(z.string()).optional(),
		cleanupAfterResolve: z.boolean().optional(),
		target: z.enum([
			"dm",
			"channel",
			"both"
		]).optional()
	}).strict().optional(),
	ui: DiscordUiSchema,
	slashCommand: z.object({ ephemeral: z.boolean().optional() }).strict().optional(),
	threadBindings: z.object({
		enabled: z.boolean().optional(),
		idleHours: z.number().nonnegative().optional(),
		maxAgeHours: z.number().nonnegative().optional(),
		spawnSubagentSessions: z.boolean().optional(),
		spawnAcpSessions: z.boolean().optional()
	}).strict().optional(),
	intents: z.object({
		presence: z.boolean().optional(),
		guildMembers: z.boolean().optional()
	}).strict().optional(),
	voice: DiscordVoiceSchema,
	pluralkit: z.object({
		enabled: z.boolean().optional(),
		token: z.string().optional().register(sensitive)
	}).strict().optional(),
	responsePrefix: z.string().optional(),
	ackReaction: z.string().optional(),
	activity: z.string().optional(),
	status: z.enum([
		"online",
		"dnd",
		"idle",
		"invisible"
	]).optional(),
	activityType: z.union([
		z.literal(0),
		z.literal(1),
		z.literal(2),
		z.literal(3),
		z.literal(4),
		z.literal(5)
	]).optional(),
	activityUrl: z.string().url().optional()
}).strict().superRefine((value, ctx) => {
	normalizeDiscordStreamingConfig(value);
	const activityText = typeof value.activity === "string" ? value.activity.trim() : "";
	const hasActivity = Boolean(activityText);
	const hasActivityType = value.activityType !== void 0;
	const activityUrl = typeof value.activityUrl === "string" ? value.activityUrl.trim() : "";
	const hasActivityUrl = Boolean(activityUrl);
	if ((hasActivityType || hasActivityUrl) && !hasActivity) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.discord.activity is required when activityType or activityUrl is set",
		path: ["activity"]
	});
	if (value.activityType === 1 && !hasActivityUrl) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.discord.activityUrl is required when activityType is 1 (Streaming)",
		path: ["activityUrl"]
	});
	if (hasActivityUrl && value.activityType !== 1) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.discord.activityType must be 1 (Streaming) when activityUrl is set",
		path: ["activityType"]
	});
});
const DiscordConfigSchema = DiscordAccountSchema.extend({ accounts: z.record(z.string(), DiscordAccountSchema.optional()).optional() }).superRefine((value, ctx) => {
	const dmPolicy = value.dmPolicy ?? value.dm?.policy ?? "pairing";
	const allowFrom = value.allowFrom ?? value.dm?.allowFrom;
	const allowFromPath = value.allowFrom !== void 0 ? ["allowFrom"] : ["dm", "allowFrom"];
	requireOpenAllowFrom({
		policy: dmPolicy,
		allowFrom,
		ctx,
		path: [...allowFromPath],
		message: "channels.discord.dmPolicy=\"open\" requires channels.discord.allowFrom (or channels.discord.dm.allowFrom) to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: dmPolicy,
		allowFrom,
		ctx,
		path: [...allowFromPath],
		message: "channels.discord.dmPolicy=\"allowlist\" requires channels.discord.allowFrom (or channels.discord.dm.allowFrom) to contain at least one sender ID"
	});
	if (!value.accounts) return;
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		const effectivePolicy = account.dmPolicy ?? account.dm?.policy ?? value.dmPolicy ?? value.dm?.policy ?? "pairing";
		const effectiveAllowFrom = account.allowFrom ?? account.dm?.allowFrom ?? value.allowFrom ?? value.dm?.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.discord.accounts.*.dmPolicy=\"open\" requires channels.discord.accounts.*.allowFrom (or channels.discord.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.discord.accounts.*.dmPolicy=\"allowlist\" requires channels.discord.accounts.*.allowFrom (or channels.discord.allowFrom) to contain at least one sender ID"
		});
	}
});
const GoogleChatDmSchema = z.object({
	enabled: z.boolean().optional(),
	policy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional()
}).strict().superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.policy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.googlechat.dm.policy=\"open\" requires channels.googlechat.dm.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.policy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.googlechat.dm.policy=\"allowlist\" requires channels.googlechat.dm.allowFrom to contain at least one sender ID"
	});
});
const GoogleChatGroupSchema = z.object({
	enabled: z.boolean().optional(),
	allow: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	users: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional()
}).strict();
const GoogleChatAccountSchema = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	allowBots: z.boolean().optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groups: z.record(z.string(), GoogleChatGroupSchema.optional()).optional(),
	defaultTo: z.string().optional(),
	serviceAccount: z.union([
		z.string(),
		z.record(z.string(), z.unknown()),
		SecretRefSchema
	]).optional().register(sensitive),
	serviceAccountRef: SecretRefSchema.optional().register(sensitive),
	serviceAccountFile: z.string().optional(),
	audienceType: z.enum(["app-url", "project-number"]).optional(),
	audience: z.string().optional(),
	webhookPath: z.string().optional(),
	webhookUrl: z.string().optional(),
	botUser: z.string().optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	streamMode: z.enum([
		"replace",
		"status_final",
		"append"
	]).optional().default("replace"),
	mediaMaxMb: z.number().positive().optional(),
	replyToMode: ReplyToModeSchema.optional(),
	actions: z.object({ reactions: z.boolean().optional() }).strict().optional(),
	dm: GoogleChatDmSchema.optional(),
	typingIndicator: z.enum([
		"none",
		"message",
		"reaction"
	]).optional(),
	responsePrefix: z.string().optional()
}).strict();
const GoogleChatConfigSchema = GoogleChatAccountSchema.extend({
	accounts: z.record(z.string(), GoogleChatAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
});
const SlackDmSchema = z.object({
	enabled: z.boolean().optional(),
	policy: DmPolicySchema.optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupEnabled: z.boolean().optional(),
	groupChannels: z.array(z.union([z.string(), z.number()])).optional(),
	replyToMode: ReplyToModeSchema.optional()
}).strict();
const SlackChannelSchema = z.object({
	enabled: z.boolean().optional(),
	allow: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	allowBots: z.boolean().optional(),
	users: z.array(z.union([z.string(), z.number()])).optional(),
	skills: z.array(z.string()).optional(),
	systemPrompt: z.string().optional()
}).strict();
const SlackThreadSchema = z.object({
	historyScope: z.enum(["thread", "channel"]).optional(),
	inheritParent: z.boolean().optional(),
	initialHistoryLimit: z.number().int().min(0).optional()
}).strict();
const SlackReplyToModeByChatTypeSchema = z.object({
	direct: ReplyToModeSchema.optional(),
	group: ReplyToModeSchema.optional(),
	channel: ReplyToModeSchema.optional()
}).strict();
const SlackAccountSchema = z.object({
	name: z.string().optional(),
	mode: z.enum(["socket", "http"]).optional(),
	signingSecret: z.string().optional().register(sensitive),
	webhookPath: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	commands: ProviderCommandsSchema,
	configWrites: z.boolean().optional(),
	botToken: z.string().optional().register(sensitive),
	appToken: z.string().optional().register(sensitive),
	userToken: z.string().optional().register(sensitive),
	userTokenReadOnly: z.boolean().optional().default(true),
	allowBots: z.boolean().optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	streaming: z.union([z.boolean(), z.enum([
		"off",
		"partial",
		"block",
		"progress"
	])]).optional(),
	nativeStreaming: z.boolean().optional(),
	streamMode: z.enum([
		"replace",
		"status_final",
		"append"
	]).optional(),
	mediaMaxMb: z.number().positive().optional(),
	reactionNotifications: z.enum([
		"off",
		"own",
		"all",
		"allowlist"
	]).optional(),
	reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
	replyToMode: ReplyToModeSchema.optional(),
	replyToModeByChatType: SlackReplyToModeByChatTypeSchema.optional(),
	thread: SlackThreadSchema.optional(),
	actions: z.object({
		reactions: z.boolean().optional(),
		messages: z.boolean().optional(),
		pins: z.boolean().optional(),
		search: z.boolean().optional(),
		permissions: z.boolean().optional(),
		memberInfo: z.boolean().optional(),
		channelInfo: z.boolean().optional(),
		emojiList: z.boolean().optional()
	}).strict().optional(),
	slashCommand: z.object({
		enabled: z.boolean().optional(),
		name: z.string().optional(),
		sessionPrefix: z.string().optional(),
		ephemeral: z.boolean().optional()
	}).strict().optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	defaultTo: z.string().optional(),
	dm: SlackDmSchema.optional(),
	channels: z.record(z.string(), SlackChannelSchema.optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	responsePrefix: z.string().optional(),
	ackReaction: z.string().optional()
}).strict().superRefine((value) => {
	normalizeSlackStreamingConfig(value);
});
const SlackConfigSchema = SlackAccountSchema.safeExtend({
	mode: z.enum(["socket", "http"]).optional().default("socket"),
	signingSecret: z.string().optional().register(sensitive),
	webhookPath: z.string().optional().default("/slack/events"),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	accounts: z.record(z.string(), SlackAccountSchema.optional()).optional()
}).superRefine((value, ctx) => {
	const dmPolicy = value.dmPolicy ?? value.dm?.policy ?? "pairing";
	const allowFrom = value.allowFrom ?? value.dm?.allowFrom;
	const allowFromPath = value.allowFrom !== void 0 ? ["allowFrom"] : ["dm", "allowFrom"];
	requireOpenAllowFrom({
		policy: dmPolicy,
		allowFrom,
		ctx,
		path: [...allowFromPath],
		message: "channels.slack.dmPolicy=\"open\" requires channels.slack.allowFrom (or channels.slack.dm.allowFrom) to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: dmPolicy,
		allowFrom,
		ctx,
		path: [...allowFromPath],
		message: "channels.slack.dmPolicy=\"allowlist\" requires channels.slack.allowFrom (or channels.slack.dm.allowFrom) to contain at least one sender ID"
	});
	const baseMode = value.mode ?? "socket";
	if (baseMode === "http" && !value.signingSecret) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.slack.mode=\"http\" requires channels.slack.signingSecret",
		path: ["signingSecret"]
	});
	if (!value.accounts) return;
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		if (account.enabled === false) continue;
		const accountMode = account.mode ?? baseMode;
		const effectivePolicy = account.dmPolicy ?? account.dm?.policy ?? value.dmPolicy ?? value.dm?.policy ?? "pairing";
		const effectiveAllowFrom = account.allowFrom ?? account.dm?.allowFrom ?? value.allowFrom ?? value.dm?.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.slack.accounts.*.dmPolicy=\"open\" requires channels.slack.accounts.*.allowFrom (or channels.slack.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.slack.accounts.*.dmPolicy=\"allowlist\" requires channels.slack.accounts.*.allowFrom (or channels.slack.allowFrom) to contain at least one sender ID"
		});
		if (accountMode !== "http") continue;
		if (!(account.signingSecret ?? value.signingSecret)) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "channels.slack.accounts.*.mode=\"http\" requires channels.slack.signingSecret or channels.slack.accounts.*.signingSecret",
			path: [
				"accounts",
				accountId,
				"signingSecret"
			]
		});
	}
});
const SignalAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	account: z.string().optional(),
	httpUrl: z.string().optional(),
	httpHost: z.string().optional(),
	httpPort: z.number().int().positive().optional(),
	cliPath: ExecutableTokenSchema.optional(),
	autoStart: z.boolean().optional(),
	startupTimeoutMs: z.number().int().min(1e3).max(12e4).optional(),
	receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
	ignoreAttachments: z.boolean().optional(),
	ignoreStories: z.boolean().optional(),
	sendReadReceipts: z.boolean().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	defaultTo: z.string().optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaMaxMb: z.number().int().positive().optional(),
	reactionNotifications: z.enum([
		"off",
		"own",
		"all",
		"allowlist"
	]).optional(),
	reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
	actions: z.object({ reactions: z.boolean().optional() }).strict().optional(),
	reactionLevel: z.enum([
		"off",
		"ack",
		"minimal",
		"extensive"
	]).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	responsePrefix: z.string().optional()
}).strict();
const SignalAccountSchema = SignalAccountSchemaBase;
const SignalConfigSchema = SignalAccountSchemaBase.extend({ accounts: z.record(z.string(), SignalAccountSchema.optional()).optional() }).superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.signal.dmPolicy=\"open\" requires channels.signal.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.signal.dmPolicy=\"allowlist\" requires channels.signal.allowFrom to contain at least one sender ID"
	});
	if (!value.accounts) return;
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.signal.accounts.*.dmPolicy=\"open\" requires channels.signal.accounts.*.allowFrom (or channels.signal.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.signal.accounts.*.dmPolicy=\"allowlist\" requires channels.signal.accounts.*.allowFrom (or channels.signal.allowFrom) to contain at least one sender ID"
		});
	}
});
const IrcGroupSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional()
}).strict();
const IrcNickServSchema = z.object({
	enabled: z.boolean().optional(),
	service: z.string().optional(),
	password: z.string().optional().register(sensitive),
	passwordFile: z.string().optional(),
	register: z.boolean().optional(),
	registerEmail: z.string().optional()
}).strict();
const IrcAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	host: z.string().optional(),
	port: z.number().int().min(1).max(65535).optional(),
	tls: z.boolean().optional(),
	nick: z.string().optional(),
	username: z.string().optional(),
	realname: z.string().optional(),
	password: z.string().optional().register(sensitive),
	passwordFile: z.string().optional(),
	nickserv: IrcNickServSchema.optional(),
	channels: z.array(z.string()).optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	defaultTo: z.string().optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	groups: z.record(z.string(), IrcGroupSchema.optional()).optional(),
	mentionPatterns: z.array(z.string()).optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaMaxMb: z.number().positive().optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	responsePrefix: z.string().optional()
}).strict();
function refineIrcAllowFromAndNickserv(value, ctx) {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.irc.dmPolicy=\"open\" requires channels.irc.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.irc.dmPolicy=\"allowlist\" requires channels.irc.allowFrom to contain at least one sender ID"
	});
	if (value.nickserv?.register && !value.nickserv.registerEmail?.trim()) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["nickserv", "registerEmail"],
		message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail"
	});
}
const IrcAccountSchema = IrcAccountSchemaBase.superRefine((value, ctx) => {
	if (value.nickserv?.register && !value.nickserv.registerEmail?.trim()) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["nickserv", "registerEmail"],
		message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail"
	});
});
const IrcConfigSchema = IrcAccountSchemaBase.extend({ accounts: z.record(z.string(), IrcAccountSchema.optional()).optional() }).superRefine((value, ctx) => {
	refineIrcAllowFromAndNickserv(value, ctx);
	if (!value.accounts) return;
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.irc.accounts.*.dmPolicy=\"open\" requires channels.irc.accounts.*.allowFrom (or channels.irc.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.irc.accounts.*.dmPolicy=\"allowlist\" requires channels.irc.accounts.*.allowFrom (or channels.irc.allowFrom) to contain at least one sender ID"
		});
	}
});
const IMessageAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	cliPath: ExecutableTokenSchema.optional(),
	dbPath: z.string().optional(),
	remoteHost: z.string().refine(isSafeScpRemoteHost, "expected SSH host or user@host (no spaces/options)").optional(),
	service: z.union([
		z.literal("imessage"),
		z.literal("sms"),
		z.literal("auto")
	]).optional(),
	region: z.string().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	defaultTo: z.string().optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	includeAttachments: z.boolean().optional(),
	attachmentRoots: z.array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root")).optional(),
	remoteAttachmentRoots: z.array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root")).optional(),
	mediaMaxMb: z.number().int().positive().optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	groups: z.record(z.string(), z.object({
		requireMention: z.boolean().optional(),
		tools: ToolPolicySchema,
		toolsBySender: ToolPolicyBySenderSchema$1
	}).strict().optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	responsePrefix: z.string().optional()
}).strict();
const IMessageAccountSchema = IMessageAccountSchemaBase;
const IMessageConfigSchema = IMessageAccountSchemaBase.extend({ accounts: z.record(z.string(), IMessageAccountSchema.optional()).optional() }).superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.imessage.dmPolicy=\"open\" requires channels.imessage.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.imessage.dmPolicy=\"allowlist\" requires channels.imessage.allowFrom to contain at least one sender ID"
	});
	if (!value.accounts) return;
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.imessage.accounts.*.dmPolicy=\"open\" requires channels.imessage.accounts.*.allowFrom (or channels.imessage.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.imessage.accounts.*.dmPolicy=\"allowlist\" requires channels.imessage.accounts.*.allowFrom (or channels.imessage.allowFrom) to contain at least one sender ID"
		});
	}
});
const BlueBubblesAllowFromEntry = z.union([z.string(), z.number()]);
const BlueBubblesActionSchema = z.object({
	reactions: z.boolean().optional(),
	edit: z.boolean().optional(),
	unsend: z.boolean().optional(),
	reply: z.boolean().optional(),
	sendWithEffect: z.boolean().optional(),
	renameGroup: z.boolean().optional(),
	setGroupIcon: z.boolean().optional(),
	addParticipant: z.boolean().optional(),
	removeParticipant: z.boolean().optional(),
	leaveGroup: z.boolean().optional(),
	sendAttachment: z.boolean().optional()
}).strict().optional();
const BlueBubblesGroupConfigSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1
}).strict();
const BlueBubblesAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	configWrites: z.boolean().optional(),
	enabled: z.boolean().optional(),
	serverUrl: z.string().optional(),
	password: z.string().optional().register(sensitive),
	webhookPath: z.string().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(BlueBubblesAllowFromEntry).optional(),
	groupAllowFrom: z.array(BlueBubblesAllowFromEntry).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	mediaMaxMb: z.number().int().positive().optional(),
	mediaLocalRoots: z.array(z.string()).optional(),
	sendReadReceipts: z.boolean().optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	groups: z.record(z.string(), BlueBubblesGroupConfigSchema.optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	responsePrefix: z.string().optional()
}).strict();
const BlueBubblesAccountSchema = BlueBubblesAccountSchemaBase;
const BlueBubblesConfigSchema = BlueBubblesAccountSchemaBase.extend({
	accounts: z.record(z.string(), BlueBubblesAccountSchema.optional()).optional(),
	actions: BlueBubblesActionSchema
}).superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.bluebubbles.dmPolicy=\"open\" requires channels.bluebubbles.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.bluebubbles.dmPolicy=\"allowlist\" requires channels.bluebubbles.allowFrom to contain at least one sender ID"
	});
	if (!value.accounts) return;
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.bluebubbles.accounts.*.dmPolicy=\"open\" requires channels.bluebubbles.accounts.*.allowFrom (or channels.bluebubbles.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.bluebubbles.accounts.*.dmPolicy=\"allowlist\" requires channels.bluebubbles.accounts.*.allowFrom (or channels.bluebubbles.allowFrom) to contain at least one sender ID"
		});
	}
});
const MSTeamsChannelSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	replyStyle: MSTeamsReplyStyleSchema.optional()
}).strict();
const MSTeamsTeamSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	replyStyle: MSTeamsReplyStyleSchema.optional(),
	channels: z.record(z.string(), MSTeamsChannelSchema.optional()).optional()
}).strict();
const MSTeamsConfigSchema = z.object({
	enabled: z.boolean().optional(),
	capabilities: z.array(z.string()).optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	markdown: MarkdownConfigSchema,
	configWrites: z.boolean().optional(),
	appId: z.string().optional(),
	appPassword: z.string().optional().register(sensitive),
	tenantId: z.string().optional(),
	webhook: z.object({
		port: z.number().int().positive().optional(),
		path: z.string().optional()
	}).strict().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.string()).optional(),
	defaultTo: z.string().optional(),
	groupAllowFrom: z.array(z.string()).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaAllowHosts: z.array(z.string()).optional(),
	mediaAuthAllowHosts: z.array(z.string()).optional(),
	requireMention: z.boolean().optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	replyStyle: MSTeamsReplyStyleSchema.optional(),
	teams: z.record(z.string(), MSTeamsTeamSchema.optional()).optional(),
	mediaMaxMb: z.number().positive().optional(),
	sharePointSiteId: z.string().optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	responsePrefix: z.string().optional()
}).strict().superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.msteams.dmPolicy=\"open\" requires channels.msteams.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.msteams.dmPolicy=\"allowlist\" requires channels.msteams.allowFrom to contain at least one sender ID"
	});
});

//#endregion
//#region src/config/zod-schema.providers-whatsapp.ts
const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();
const WhatsAppGroupEntrySchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema
}).strict().optional();
const WhatsAppGroupsSchema = z.record(z.string(), WhatsAppGroupEntrySchema).optional();
const WhatsAppAckReactionSchema = z.object({
	emoji: z.string().optional(),
	direct: z.boolean().optional().default(true),
	group: z.enum([
		"always",
		"mentions",
		"never"
	]).optional().default("mentions")
}).strict().optional();
const WhatsAppSharedSchema = z.object({
	enabled: z.boolean().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	configWrites: z.boolean().optional(),
	sendReadReceipts: z.boolean().optional(),
	messagePrefix: z.string().optional(),
	responsePrefix: z.string().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	selfChatMode: z.boolean().optional(),
	allowFrom: z.array(z.string()).optional(),
	defaultTo: z.string().optional(),
	groupAllowFrom: z.array(z.string()).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	groups: WhatsAppGroupsSchema,
	ackReaction: WhatsAppAckReactionSchema,
	debounceMs: z.number().int().nonnegative().optional().default(0),
	heartbeat: ChannelHeartbeatVisibilitySchema
});
function enforceOpenDmPolicyAllowFromStar(params) {
	if (params.dmPolicy !== "open") return;
	if ((Array.isArray(params.allowFrom) ? params.allowFrom : []).map((v) => String(v).trim()).filter(Boolean).includes("*")) return;
	params.ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: params.path ?? ["allowFrom"],
		message: params.message
	});
}
function enforceAllowlistDmPolicyAllowFrom(params) {
	if (params.dmPolicy !== "allowlist") return;
	if ((Array.isArray(params.allowFrom) ? params.allowFrom : []).map((v) => String(v).trim()).filter(Boolean).length > 0) return;
	params.ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: params.path ?? ["allowFrom"],
		message: params.message
	});
}
const WhatsAppAccountSchema = WhatsAppSharedSchema.extend({
	name: z.string().optional(),
	enabled: z.boolean().optional(),
	authDir: z.string().optional(),
	mediaMaxMb: z.number().int().positive().optional()
}).strict();
const WhatsAppConfigSchema = WhatsAppSharedSchema.extend({
	accounts: z.record(z.string(), WhatsAppAccountSchema.optional()).optional(),
	mediaMaxMb: z.number().int().positive().optional().default(50),
	actions: z.object({
		reactions: z.boolean().optional(),
		sendMessage: z.boolean().optional(),
		polls: z.boolean().optional()
	}).strict().optional()
}).strict().superRefine((value, ctx) => {
	enforceOpenDmPolicyAllowFromStar({
		dmPolicy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		message: "channels.whatsapp.dmPolicy=\"open\" requires channels.whatsapp.allowFrom to include \"*\""
	});
	enforceAllowlistDmPolicyAllowFrom({
		dmPolicy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		message: "channels.whatsapp.dmPolicy=\"allowlist\" requires channels.whatsapp.allowFrom to contain at least one sender ID"
	});
	if (!value.accounts) return;
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
		enforceOpenDmPolicyAllowFromStar({
			dmPolicy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.whatsapp.accounts.*.dmPolicy=\"open\" requires channels.whatsapp.accounts.*.allowFrom (or channels.whatsapp.allowFrom) to include \"*\""
		});
		enforceAllowlistDmPolicyAllowFrom({
			dmPolicy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.whatsapp.accounts.*.dmPolicy=\"allowlist\" requires channels.whatsapp.accounts.*.allowFrom (or channels.whatsapp.allowFrom) to contain at least one sender ID"
		});
	}
});

//#endregion
//#region src/config/zod-schema.providers.ts
const ChannelModelByChannelSchema = z.record(z.string(), z.record(z.string(), z.string())).optional();
const ChannelsSchema = z.object({
	defaults: z.object({
		groupPolicy: GroupPolicySchema.optional(),
		heartbeat: ChannelHeartbeatVisibilitySchema
	}).strict().optional(),
	modelByChannel: ChannelModelByChannelSchema,
	whatsapp: WhatsAppConfigSchema.optional(),
	telegram: TelegramConfigSchema.optional(),
	discord: DiscordConfigSchema.optional(),
	irc: IrcConfigSchema.optional(),
	googlechat: GoogleChatConfigSchema.optional(),
	slack: SlackConfigSchema.optional(),
	signal: SignalConfigSchema.optional(),
	imessage: IMessageConfigSchema.optional(),
	bluebubbles: BlueBubblesConfigSchema.optional(),
	msteams: MSTeamsConfigSchema.optional()
}).passthrough().optional();

//#endregion
//#region src/config/zod-schema.session.ts
const SessionResetConfigSchema = z.object({
	mode: z.union([z.literal("daily"), z.literal("idle")]).optional(),
	atHour: z.number().int().min(0).max(23).optional(),
	idleMinutes: z.number().int().positive().optional()
}).strict();
const SessionSendPolicySchema = createAllowDenyChannelRulesSchema();
const SessionSchema = z.object({
	scope: z.union([z.literal("per-sender"), z.literal("global")]).optional(),
	dmScope: z.union([
		z.literal("main"),
		z.literal("per-peer"),
		z.literal("per-channel-peer"),
		z.literal("per-account-channel-peer")
	]).optional(),
	identityLinks: z.record(z.string(), z.array(z.string())).optional(),
	resetTriggers: z.array(z.string()).optional(),
	idleMinutes: z.number().int().positive().optional(),
	reset: SessionResetConfigSchema.optional(),
	resetByType: z.object({
		direct: SessionResetConfigSchema.optional(),
		dm: SessionResetConfigSchema.optional(),
		group: SessionResetConfigSchema.optional(),
		thread: SessionResetConfigSchema.optional()
	}).strict().optional(),
	resetByChannel: z.record(z.string(), SessionResetConfigSchema).optional(),
	store: z.string().optional(),
	typingIntervalSeconds: z.number().int().positive().optional(),
	typingMode: TypingModeSchema.optional(),
	parentForkMaxTokens: z.number().int().nonnegative().optional(),
	mainKey: z.string().optional(),
	sendPolicy: SessionSendPolicySchema.optional(),
	agentToAgent: z.object({ maxPingPongTurns: z.number().int().min(0).max(5).optional() }).strict().optional(),
	threadBindings: z.object({
		enabled: z.boolean().optional(),
		idleHours: z.number().nonnegative().optional(),
		maxAgeHours: z.number().nonnegative().optional()
	}).strict().optional(),
	maintenance: z.object({
		mode: z.enum(["enforce", "warn"]).optional(),
		pruneAfter: z.union([z.string(), z.number()]).optional(),
		pruneDays: z.number().int().positive().optional(),
		maxEntries: z.number().int().positive().optional(),
		rotateBytes: z.union([z.string(), z.number()]).optional(),
		resetArchiveRetention: z.union([
			z.string(),
			z.number(),
			z.literal(false)
		]).optional(),
		maxDiskBytes: z.union([z.string(), z.number()]).optional(),
		highWaterBytes: z.union([z.string(), z.number()]).optional()
	}).strict().superRefine((val, ctx) => {
		if (val.pruneAfter !== void 0) try {
			parseDurationMs(String(val.pruneAfter).trim(), { defaultUnit: "d" });
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["pruneAfter"],
				message: "invalid duration (use ms, s, m, h, d)"
			});
		}
		if (val.rotateBytes !== void 0) try {
			parseByteSize(String(val.rotateBytes).trim(), { defaultUnit: "b" });
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["rotateBytes"],
				message: "invalid size (use b, kb, mb, gb, tb)"
			});
		}
		if (val.resetArchiveRetention !== void 0 && val.resetArchiveRetention !== false) try {
			parseDurationMs(String(val.resetArchiveRetention).trim(), { defaultUnit: "d" });
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["resetArchiveRetention"],
				message: "invalid duration (use ms, s, m, h, d)"
			});
		}
		if (val.maxDiskBytes !== void 0) try {
			parseByteSize(String(val.maxDiskBytes).trim(), { defaultUnit: "b" });
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["maxDiskBytes"],
				message: "invalid size (use b, kb, mb, gb, tb)"
			});
		}
		if (val.highWaterBytes !== void 0) try {
			parseByteSize(String(val.highWaterBytes).trim(), { defaultUnit: "b" });
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["highWaterBytes"],
				message: "invalid size (use b, kb, mb, gb, tb)"
			});
		}
	}).optional()
}).strict().optional();
const MessagesSchema = z.object({
	messagePrefix: z.string().optional(),
	responsePrefix: z.string().optional(),
	groupChat: GroupChatSchema,
	queue: QueueSchema,
	inbound: InboundDebounceSchema,
	ackReaction: z.string().optional(),
	ackReactionScope: z.enum([
		"group-mentions",
		"group-all",
		"direct",
		"all"
	]).optional(),
	removeAckAfterReply: z.boolean().optional(),
	statusReactions: z.object({
		enabled: z.boolean().optional(),
		emojis: z.object({
			thinking: z.string().optional(),
			tool: z.string().optional(),
			coding: z.string().optional(),
			web: z.string().optional(),
			done: z.string().optional(),
			error: z.string().optional(),
			stallSoft: z.string().optional(),
			stallHard: z.string().optional()
		}).strict().optional(),
		timing: z.object({
			debounceMs: z.number().int().min(0).optional(),
			stallSoftMs: z.number().int().min(0).optional(),
			stallHardMs: z.number().int().min(0).optional(),
			doneHoldMs: z.number().int().min(0).optional(),
			errorHoldMs: z.number().int().min(0).optional()
		}).strict().optional()
	}).strict().optional(),
	suppressToolErrors: z.boolean().optional(),
	tts: TtsConfigSchema
}).strict().optional();
const CommandsSchema = z.object({
	native: NativeCommandsSettingSchema.optional().default("auto"),
	nativeSkills: NativeCommandsSettingSchema.optional().default("auto"),
	text: z.boolean().optional(),
	bash: z.boolean().optional(),
	bashForegroundMs: z.number().int().min(0).max(3e4).optional(),
	config: z.boolean().optional(),
	debug: z.boolean().optional(),
	restart: z.boolean().optional().default(true),
	useAccessGroups: z.boolean().optional(),
	ownerAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	ownerDisplay: z.enum(["raw", "hash"]).optional().default("raw"),
	ownerDisplaySecret: z.string().optional().register(sensitive),
	allowFrom: ElevatedAllowFromSchema.optional()
}).strict().optional().default(() => ({
	native: "auto",
	nativeSkills: "auto",
	restart: true,
	ownerDisplay: "raw"
}));

//#endregion
//#region src/config/zod-schema.ts
const BrowserSnapshotDefaultsSchema = z.object({ mode: z.literal("efficient").optional() }).strict().optional();
const NodeHostSchema = z.object({ browserProxy: z.object({
	enabled: z.boolean().optional(),
	allowProfiles: z.array(z.string()).optional()
}).strict().optional() }).strict().optional();
const MemoryQmdPathSchema = z.object({
	path: z.string(),
	name: z.string().optional(),
	pattern: z.string().optional()
}).strict();
const MemoryQmdSessionSchema = z.object({
	enabled: z.boolean().optional(),
	exportDir: z.string().optional(),
	retentionDays: z.number().int().nonnegative().optional()
}).strict();
const MemoryQmdUpdateSchema = z.object({
	interval: z.string().optional(),
	debounceMs: z.number().int().nonnegative().optional(),
	onBoot: z.boolean().optional(),
	waitForBootSync: z.boolean().optional(),
	embedInterval: z.string().optional(),
	commandTimeoutMs: z.number().int().nonnegative().optional(),
	updateTimeoutMs: z.number().int().nonnegative().optional(),
	embedTimeoutMs: z.number().int().nonnegative().optional()
}).strict();
const MemoryQmdLimitsSchema = z.object({
	maxResults: z.number().int().positive().optional(),
	maxSnippetChars: z.number().int().positive().optional(),
	maxInjectedChars: z.number().int().positive().optional(),
	timeoutMs: z.number().int().nonnegative().optional()
}).strict();
const MemoryQmdMcporterSchema = z.object({
	enabled: z.boolean().optional(),
	serverName: z.string().optional(),
	startDaemon: z.boolean().optional()
}).strict();
const LoggingLevelSchema = z.union([
	z.literal("silent"),
	z.literal("fatal"),
	z.literal("error"),
	z.literal("warn"),
	z.literal("info"),
	z.literal("debug"),
	z.literal("trace")
]);
const MemoryQmdSchema = z.object({
	command: z.string().optional(),
	mcporter: MemoryQmdMcporterSchema.optional(),
	searchMode: z.union([
		z.literal("query"),
		z.literal("search"),
		z.literal("vsearch")
	]).optional(),
	includeDefaultMemory: z.boolean().optional(),
	paths: z.array(MemoryQmdPathSchema).optional(),
	sessions: MemoryQmdSessionSchema.optional(),
	update: MemoryQmdUpdateSchema.optional(),
	limits: MemoryQmdLimitsSchema.optional(),
	scope: SessionSendPolicySchema.optional()
}).strict();
const MemorySchema = z.object({
	backend: z.union([z.literal("builtin"), z.literal("qmd")]).optional(),
	citations: z.union([
		z.literal("auto"),
		z.literal("on"),
		z.literal("off")
	]).optional(),
	qmd: MemoryQmdSchema.optional()
}).strict().optional();
const HttpUrlSchema = z.string().url().refine((value) => {
	const protocol = new URL(value).protocol;
	return protocol === "http:" || protocol === "https:";
}, "Expected http:// or https:// URL");
const OpenClawSchema = z.object({
	$schema: z.string().optional(),
	meta: z.object({
		lastTouchedVersion: z.string().optional(),
		lastTouchedAt: z.union([z.string(), z.number().transform((n, ctx) => {
			const d = new Date(n);
			if (Number.isNaN(d.getTime())) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Invalid timestamp"
				});
				return z.NEVER;
			}
			return d.toISOString();
		})]).optional()
	}).strict().optional(),
	env: z.object({
		shellEnv: z.object({
			enabled: z.boolean().optional(),
			timeoutMs: z.number().int().nonnegative().optional()
		}).strict().optional(),
		vars: z.record(z.string(), z.string()).optional()
	}).catchall(z.string()).optional(),
	wizard: z.object({
		lastRunAt: z.string().optional(),
		lastRunVersion: z.string().optional(),
		lastRunCommit: z.string().optional(),
		lastRunCommand: z.string().optional(),
		lastRunMode: z.union([z.literal("local"), z.literal("remote")]).optional()
	}).strict().optional(),
	diagnostics: z.object({
		enabled: z.boolean().optional(),
		flags: z.array(z.string()).optional(),
		otel: z.object({
			enabled: z.boolean().optional(),
			endpoint: z.string().optional(),
			protocol: z.union([z.literal("http/protobuf"), z.literal("grpc")]).optional(),
			headers: z.record(z.string(), z.string()).optional(),
			serviceName: z.string().optional(),
			traces: z.boolean().optional(),
			metrics: z.boolean().optional(),
			logs: z.boolean().optional(),
			sampleRate: z.number().min(0).max(1).optional(),
			flushIntervalMs: z.number().int().nonnegative().optional()
		}).strict().optional(),
		cacheTrace: z.object({
			enabled: z.boolean().optional(),
			filePath: z.string().optional(),
			includeMessages: z.boolean().optional(),
			includePrompt: z.boolean().optional(),
			includeSystem: z.boolean().optional()
		}).strict().optional()
	}).strict().optional(),
	logging: z.object({
		level: LoggingLevelSchema.optional(),
		file: z.string().optional(),
		maxFileBytes: z.number().int().positive().optional(),
		consoleLevel: LoggingLevelSchema.optional(),
		consoleStyle: z.union([
			z.literal("pretty"),
			z.literal("compact"),
			z.literal("json")
		]).optional(),
		redactSensitive: z.union([z.literal("off"), z.literal("tools")]).optional(),
		redactPatterns: z.array(z.string()).optional()
	}).strict().optional(),
	update: z.object({
		channel: z.union([
			z.literal("stable"),
			z.literal("beta"),
			z.literal("dev")
		]).optional(),
		checkOnStart: z.boolean().optional(),
		auto: z.object({
			enabled: z.boolean().optional(),
			stableDelayHours: z.number().nonnegative().max(168).optional(),
			stableJitterHours: z.number().nonnegative().max(168).optional(),
			betaCheckIntervalHours: z.number().positive().max(24).optional()
		}).strict().optional()
	}).strict().optional(),
	browser: z.object({
		enabled: z.boolean().optional(),
		evaluateEnabled: z.boolean().optional(),
		cdpUrl: z.string().optional(),
		remoteCdpTimeoutMs: z.number().int().nonnegative().optional(),
		remoteCdpHandshakeTimeoutMs: z.number().int().nonnegative().optional(),
		color: z.string().optional(),
		executablePath: z.string().optional(),
		headless: z.boolean().optional(),
		noSandbox: z.boolean().optional(),
		attachOnly: z.boolean().optional(),
		defaultProfile: z.string().optional(),
		snapshotDefaults: BrowserSnapshotDefaultsSchema,
		ssrfPolicy: z.object({
			allowPrivateNetwork: z.boolean().optional(),
			dangerouslyAllowPrivateNetwork: z.boolean().optional(),
			allowedHostnames: z.array(z.string()).optional(),
			hostnameAllowlist: z.array(z.string()).optional()
		}).strict().optional(),
		profiles: z.record(z.string().regex(/^[a-z0-9-]+$/, "Profile names must be alphanumeric with hyphens only"), z.object({
			cdpPort: z.number().int().min(1).max(65535).optional(),
			cdpUrl: z.string().optional(),
			driver: z.union([z.literal("clawd"), z.literal("extension")]).optional(),
			color: HexColorSchema
		}).strict().refine((value) => value.cdpPort || value.cdpUrl, { message: "Profile must set cdpPort or cdpUrl" })).optional()
	}).strict().optional(),
	ui: z.object({
		seamColor: HexColorSchema.optional(),
		assistant: z.object({
			name: z.string().max(50).optional(),
			avatar: z.string().max(200).optional()
		}).strict().optional()
	}).strict().optional(),
	secrets: SecretsConfigSchema,
	auth: z.object({
		profiles: z.record(z.string(), z.object({
			provider: z.string(),
			mode: z.union([
				z.literal("api_key"),
				z.literal("oauth"),
				z.literal("token")
			]),
			email: z.string().optional()
		}).strict()).optional(),
		order: z.record(z.string(), z.array(z.string())).optional(),
		cooldowns: z.object({
			billingBackoffHours: z.number().positive().optional(),
			billingBackoffHoursByProvider: z.record(z.string(), z.number().positive()).optional(),
			billingMaxHours: z.number().positive().optional(),
			failureWindowHours: z.number().positive().optional()
		}).strict().optional()
	}).strict().optional(),
	acp: z.object({
		enabled: z.boolean().optional(),
		dispatch: z.object({ enabled: z.boolean().optional() }).strict().optional(),
		backend: z.string().optional(),
		defaultAgent: z.string().optional(),
		allowedAgents: z.array(z.string()).optional(),
		maxConcurrentSessions: z.number().int().positive().optional(),
		stream: z.object({
			coalesceIdleMs: z.number().int().nonnegative().optional(),
			maxChunkChars: z.number().int().positive().optional()
		}).strict().optional(),
		runtime: z.object({
			ttlMinutes: z.number().int().positive().optional(),
			installCommand: z.string().optional()
		}).strict().optional()
	}).strict().optional(),
	models: ModelsConfigSchema,
	nodeHost: NodeHostSchema,
	agents: AgentsSchema,
	tools: ToolsSchema,
	bindings: BindingsSchema,
	broadcast: BroadcastSchema,
	audio: AudioSchema,
	media: z.object({ preserveFilenames: z.boolean().optional() }).strict().optional(),
	messages: MessagesSchema,
	commands: CommandsSchema,
	approvals: ApprovalsSchema,
	session: SessionSchema,
	cron: z.object({
		enabled: z.boolean().optional(),
		store: z.string().optional(),
		maxConcurrentRuns: z.number().int().positive().optional(),
		retry: z.object({
			maxAttempts: z.number().int().min(0).max(10).optional(),
			backoffMs: z.array(z.number().int().nonnegative()).min(1).max(10).optional(),
			retryOn: z.array(z.enum([
				"rate_limit",
				"network",
				"timeout",
				"server_error"
			])).min(1).optional()
		}).strict().optional(),
		webhook: HttpUrlSchema.optional(),
		webhookToken: z.string().optional().register(sensitive),
		sessionRetention: z.union([z.string(), z.literal(false)]).optional(),
		runLog: z.object({
			maxBytes: z.union([z.string(), z.number()]).optional(),
			keepLines: z.number().int().positive().optional()
		}).strict().optional()
	}).strict().superRefine((val, ctx) => {
		if (val.sessionRetention !== void 0 && val.sessionRetention !== false) try {
			parseDurationMs(String(val.sessionRetention).trim(), { defaultUnit: "h" });
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["sessionRetention"],
				message: "invalid duration (use ms, s, m, h, d)"
			});
		}
		if (val.runLog?.maxBytes !== void 0) try {
			parseByteSize(String(val.runLog.maxBytes).trim(), { defaultUnit: "b" });
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["runLog", "maxBytes"],
				message: "invalid size (use b, kb, mb, gb, tb)"
			});
		}
	}).optional(),
	hooks: z.object({
		enabled: z.boolean().optional(),
		path: z.string().optional(),
		token: z.string().optional().register(sensitive),
		defaultSessionKey: z.string().optional(),
		allowRequestSessionKey: z.boolean().optional(),
		allowedSessionKeyPrefixes: z.array(z.string()).optional(),
		allowedAgentIds: z.array(z.string()).optional(),
		maxBodyBytes: z.number().int().positive().optional(),
		presets: z.array(z.string()).optional(),
		transformsDir: z.string().optional(),
		mappings: z.array(HookMappingSchema).optional(),
		gmail: HooksGmailSchema,
		internal: InternalHooksSchema
	}).strict().optional(),
	web: z.object({
		enabled: z.boolean().optional(),
		heartbeatSeconds: z.number().int().positive().optional(),
		reconnect: z.object({
			initialMs: z.number().positive().optional(),
			maxMs: z.number().positive().optional(),
			factor: z.number().positive().optional(),
			jitter: z.number().min(0).max(1).optional(),
			maxAttempts: z.number().int().min(0).optional()
		}).strict().optional()
	}).strict().optional(),
	channels: ChannelsSchema,
	discovery: z.object({
		wideArea: z.object({ enabled: z.boolean().optional() }).strict().optional(),
		mdns: z.object({ mode: z.enum([
			"off",
			"minimal",
			"full"
		]).optional() }).strict().optional()
	}).strict().optional(),
	canvasHost: z.object({
		enabled: z.boolean().optional(),
		root: z.string().optional(),
		port: z.number().int().positive().optional(),
		liveReload: z.boolean().optional()
	}).strict().optional(),
	talk: z.object({
		provider: z.string().optional(),
		providers: z.record(z.string(), z.object({
			voiceId: z.string().optional(),
			voiceAliases: z.record(z.string(), z.string()).optional(),
			modelId: z.string().optional(),
			outputFormat: z.string().optional(),
			apiKey: z.string().optional().register(sensitive)
		}).catchall(z.unknown())).optional(),
		voiceId: z.string().optional(),
		voiceAliases: z.record(z.string(), z.string()).optional(),
		modelId: z.string().optional(),
		outputFormat: z.string().optional(),
		apiKey: z.string().optional().register(sensitive),
		interruptOnSpeech: z.boolean().optional()
	}).strict().optional(),
	gateway: z.object({
		port: z.number().int().positive().optional(),
		mode: z.union([z.literal("local"), z.literal("remote")]).optional(),
		bind: z.union([
			z.literal("auto"),
			z.literal("lan"),
			z.literal("loopback"),
			z.literal("custom"),
			z.literal("tailnet")
		]).optional(),
		customBindHost: z.string().optional(),
		controlUi: z.object({
			enabled: z.boolean().optional(),
			basePath: z.string().optional(),
			root: z.string().optional(),
			allowedOrigins: z.array(z.string()).optional(),
			dangerouslyAllowHostHeaderOriginFallback: z.boolean().optional(),
			allowInsecureAuth: z.boolean().optional(),
			dangerouslyDisableDeviceAuth: z.boolean().optional()
		}).strict().optional(),
		auth: z.object({
			mode: z.union([
				z.literal("none"),
				z.literal("token"),
				z.literal("password"),
				z.literal("trusted-proxy")
			]).optional(),
			token: z.string().optional().register(sensitive),
			password: z.string().optional().register(sensitive),
			allowTailscale: z.boolean().optional(),
			rateLimit: z.object({
				maxAttempts: z.number().optional(),
				windowMs: z.number().optional(),
				lockoutMs: z.number().optional(),
				exemptLoopback: z.boolean().optional()
			}).strict().optional(),
			trustedProxy: z.object({
				userHeader: z.string().min(1, "userHeader is required for trusted-proxy mode"),
				requiredHeaders: z.array(z.string()).optional(),
				allowUsers: z.array(z.string()).optional()
			}).strict().optional()
		}).strict().optional(),
		trustedProxies: z.array(z.string()).optional(),
		allowRealIpFallback: z.boolean().optional(),
		tools: z.object({
			deny: z.array(z.string()).optional(),
			allow: z.array(z.string()).optional()
		}).strict().optional(),
		channelHealthCheckMinutes: z.number().int().min(0).optional(),
		tailscale: z.object({
			mode: z.union([
				z.literal("off"),
				z.literal("serve"),
				z.literal("funnel")
			]).optional(),
			resetOnExit: z.boolean().optional()
		}).strict().optional(),
		remote: z.object({
			url: z.string().optional(),
			transport: z.union([z.literal("ssh"), z.literal("direct")]).optional(),
			token: z.string().optional().register(sensitive),
			password: z.string().optional().register(sensitive),
			tlsFingerprint: z.string().optional(),
			sshTarget: z.string().optional(),
			sshIdentity: z.string().optional()
		}).strict().optional(),
		reload: z.object({
			mode: z.union([
				z.literal("off"),
				z.literal("restart"),
				z.literal("hot"),
				z.literal("hybrid")
			]).optional(),
			debounceMs: z.number().int().min(0).optional()
		}).strict().optional(),
		tls: z.object({
			enabled: z.boolean().optional(),
			autoGenerate: z.boolean().optional(),
			certPath: z.string().optional(),
			keyPath: z.string().optional(),
			caPath: z.string().optional()
		}).optional(),
		http: z.object({
			endpoints: z.object({
				chatCompletions: z.object({ enabled: z.boolean().optional() }).strict().optional(),
				responses: z.object({
					enabled: z.boolean().optional(),
					maxBodyBytes: z.number().int().positive().optional(),
					maxUrlParts: z.number().int().nonnegative().optional(),
					files: z.object({
						allowUrl: z.boolean().optional(),
						urlAllowlist: z.array(z.string()).optional(),
						allowedMimes: z.array(z.string()).optional(),
						maxBytes: z.number().int().positive().optional(),
						maxChars: z.number().int().positive().optional(),
						maxRedirects: z.number().int().nonnegative().optional(),
						timeoutMs: z.number().int().positive().optional(),
						pdf: z.object({
							maxPages: z.number().int().positive().optional(),
							maxPixels: z.number().int().positive().optional(),
							minTextChars: z.number().int().nonnegative().optional()
						}).strict().optional()
					}).strict().optional(),
					images: z.object({
						allowUrl: z.boolean().optional(),
						urlAllowlist: z.array(z.string()).optional(),
						allowedMimes: z.array(z.string()).optional(),
						maxBytes: z.number().int().positive().optional(),
						maxRedirects: z.number().int().nonnegative().optional(),
						timeoutMs: z.number().int().positive().optional()
					}).strict().optional()
				}).strict().optional()
			}).strict().optional(),
			securityHeaders: z.object({ strictTransportSecurity: z.union([z.string(), z.literal(false)]).optional() }).strict().optional()
		}).strict().optional(),
		nodes: z.object({
			browser: z.object({
				mode: z.union([
					z.literal("auto"),
					z.literal("manual"),
					z.literal("off")
				]).optional(),
				node: z.string().optional()
			}).strict().optional(),
			allowCommands: z.array(z.string()).optional(),
			denyCommands: z.array(z.string()).optional()
		}).strict().optional()
	}).strict().optional(),
	memory: MemorySchema,
	skills: z.object({
		allowBundled: z.array(z.string()).optional(),
		load: z.object({
			extraDirs: z.array(z.string()).optional(),
			watch: z.boolean().optional(),
			watchDebounceMs: z.number().int().min(0).optional()
		}).strict().optional(),
		install: z.object({
			preferBrew: z.boolean().optional(),
			nodeManager: z.union([
				z.literal("npm"),
				z.literal("pnpm"),
				z.literal("yarn"),
				z.literal("bun")
			]).optional()
		}).strict().optional(),
		limits: z.object({
			maxCandidatesPerRoot: z.number().int().min(1).optional(),
			maxSkillsLoadedPerSource: z.number().int().min(1).optional(),
			maxSkillsInPrompt: z.number().int().min(0).optional(),
			maxSkillsPromptChars: z.number().int().min(0).optional(),
			maxSkillFileBytes: z.number().int().min(0).optional()
		}).strict().optional(),
		entries: z.record(z.string(), z.object({
			enabled: z.boolean().optional(),
			apiKey: SecretInputSchema.optional().register(sensitive),
			env: z.record(z.string(), z.string()).optional(),
			config: z.record(z.string(), z.unknown()).optional()
		}).strict()).optional()
	}).strict().optional(),
	plugins: z.object({
		enabled: z.boolean().optional(),
		allow: z.array(z.string()).optional(),
		deny: z.array(z.string()).optional(),
		load: z.object({ paths: z.array(z.string()).optional() }).strict().optional(),
		slots: z.object({ memory: z.string().optional() }).strict().optional(),
		entries: z.record(z.string(), z.object({
			enabled: z.boolean().optional(),
			config: z.record(z.string(), z.unknown()).optional()
		}).strict()).optional(),
		installs: z.record(z.string(), z.object({ ...InstallRecordShape }).strict()).optional()
	}).strict().optional()
}).strict().superRefine((cfg, ctx) => {
	const agents = cfg.agents?.list ?? [];
	if (agents.length === 0) return;
	const agentIds = new Set(agents.map((agent) => agent.id));
	const broadcast = cfg.broadcast;
	if (!broadcast) return;
	for (const [peerId, ids] of Object.entries(broadcast)) {
		if (peerId === "strategy") continue;
		if (!Array.isArray(ids)) continue;
		for (let idx = 0; idx < ids.length; idx += 1) {
			const agentId = ids[idx];
			if (!agentIds.has(agentId)) ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: [
					"broadcast",
					peerId,
					idx
				],
				message: `Unknown agent id "${agentId}" (not in agents.list).`
			});
		}
	}
});

//#endregion
//#region src/config/validation.ts
const LEGACY_REMOVED_PLUGIN_IDS = new Set(["google-antigravity-auth"]);
function isWorkspaceAvatarPath(value, workspaceDir) {
	const workspaceRoot = path.resolve(workspaceDir);
	return isPathWithinRoot(workspaceRoot, path.resolve(workspaceRoot, value));
}
function validateIdentityAvatar(config) {
	const agents = config.agents?.list;
	if (!Array.isArray(agents) || agents.length === 0) return [];
	const issues = [];
	for (const [index, entry] of agents.entries()) {
		if (!entry || typeof entry !== "object") continue;
		const avatarRaw = entry.identity?.avatar;
		if (typeof avatarRaw !== "string") continue;
		const avatar = avatarRaw.trim();
		if (!avatar) continue;
		if (isAvatarDataUrl(avatar) || isAvatarHttpUrl(avatar)) continue;
		if (avatar.startsWith("~")) {
			issues.push({
				path: `agents.list.${index}.identity.avatar`,
				message: "identity.avatar must be a workspace-relative path, http(s) URL, or data URI."
			});
			continue;
		}
		if (hasAvatarUriScheme(avatar) && !isWindowsAbsolutePath(avatar)) {
			issues.push({
				path: `agents.list.${index}.identity.avatar`,
				message: "identity.avatar must be a workspace-relative path, http(s) URL, or data URI."
			});
			continue;
		}
		if (!isWorkspaceAvatarPath(avatar, resolveAgentWorkspaceDir(config, entry.id ?? resolveDefaultAgentId(config)))) issues.push({
			path: `agents.list.${index}.identity.avatar`,
			message: "identity.avatar must stay within the agent workspace."
		});
	}
	return issues;
}
/**
* Validates config without applying runtime defaults.
* Use this when you need the raw validated config (e.g., for writing back to file).
*/
function validateConfigObjectRaw(raw) {
	const legacyIssues = findLegacyConfigIssues(raw);
	if (legacyIssues.length > 0) return {
		ok: false,
		issues: legacyIssues.map((iss) => ({
			path: iss.path,
			message: iss.message
		}))
	};
	const validated = OpenClawSchema.safeParse(raw);
	if (!validated.success) return {
		ok: false,
		issues: validated.error.issues.map((iss) => ({
			path: iss.path.join("."),
			message: iss.message
		}))
	};
	const duplicates = findDuplicateAgentDirs(validated.data);
	if (duplicates.length > 0) return {
		ok: false,
		issues: [{
			path: "agents.list",
			message: formatDuplicateAgentDirError(duplicates)
		}]
	};
	const avatarIssues = validateIdentityAvatar(validated.data);
	if (avatarIssues.length > 0) return {
		ok: false,
		issues: avatarIssues
	};
	return {
		ok: true,
		config: validated.data
	};
}
function validateConfigObject(raw) {
	const result = validateConfigObjectRaw(raw);
	if (!result.ok) return result;
	return {
		ok: true,
		config: applyModelDefaults(applyAgentDefaults(applySessionDefaults(result.config)))
	};
}
function validateConfigObjectWithPlugins(raw) {
	return validateConfigObjectWithPluginsBase(raw, { applyDefaults: true });
}
function validateConfigObjectRawWithPlugins(raw) {
	return validateConfigObjectWithPluginsBase(raw, { applyDefaults: false });
}
function validateConfigObjectWithPluginsBase(raw, opts) {
	const base = opts.applyDefaults ? validateConfigObject(raw) : validateConfigObjectRaw(raw);
	if (!base.ok) return {
		ok: false,
		issues: base.issues,
		warnings: []
	};
	const config = base.config;
	const issues = [];
	const warnings = [];
	const hasExplicitPluginsConfig = isRecord$3(raw) && Object.prototype.hasOwnProperty.call(raw, "plugins");
	let registryInfo = null;
	const ensureRegistry = () => {
		if (registryInfo) return registryInfo;
		const registry = loadPluginManifestRegistry({
			config,
			workspaceDir: resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)) ?? void 0
		});
		const knownIds = new Set(registry.plugins.map((record) => record.id));
		const normalizedPlugins = normalizePluginsConfig(config.plugins);
		for (const diag of registry.diagnostics) {
			let path = diag.pluginId ? `plugins.entries.${diag.pluginId}` : "plugins";
			if (!diag.pluginId && diag.message.includes("plugin path not found")) path = "plugins.load.paths";
			const message = `${diag.pluginId ? `plugin ${diag.pluginId}` : "plugin"}: ${diag.message}`;
			if (diag.level === "error") issues.push({
				path,
				message
			});
			else warnings.push({
				path,
				message
			});
		}
		registryInfo = {
			registry,
			knownIds,
			normalizedPlugins
		};
		return registryInfo;
	};
	const allowedChannels = new Set([
		"defaults",
		"modelByChannel",
		...CHANNEL_IDS
	]);
	if (config.channels && isRecord$3(config.channels)) for (const key of Object.keys(config.channels)) {
		const trimmed = key.trim();
		if (!trimmed) continue;
		if (!allowedChannels.has(trimmed)) {
			const { registry } = ensureRegistry();
			for (const record of registry.plugins) for (const channelId of record.channels) allowedChannels.add(channelId);
		}
		if (!allowedChannels.has(trimmed)) issues.push({
			path: `channels.${trimmed}`,
			message: `unknown channel id: ${trimmed}`
		});
	}
	const heartbeatChannelIds = /* @__PURE__ */ new Set();
	for (const channelId of CHANNEL_IDS) heartbeatChannelIds.add(channelId.toLowerCase());
	const validateHeartbeatTarget = (target, path) => {
		if (typeof target !== "string") return;
		const trimmed = target.trim();
		if (!trimmed) {
			issues.push({
				path,
				message: "heartbeat target must not be empty"
			});
			return;
		}
		const normalized = trimmed.toLowerCase();
		if (normalized === "last" || normalized === "none") return;
		if (normalizeChatChannelId(trimmed)) return;
		if (!heartbeatChannelIds.has(normalized)) {
			const { registry } = ensureRegistry();
			for (const record of registry.plugins) for (const channelId of record.channels) {
				const pluginChannel = channelId.trim();
				if (pluginChannel) heartbeatChannelIds.add(pluginChannel.toLowerCase());
			}
		}
		if (heartbeatChannelIds.has(normalized)) return;
		issues.push({
			path,
			message: `unknown heartbeat target: ${target}`
		});
	};
	validateHeartbeatTarget(config.agents?.defaults?.heartbeat?.target, "agents.defaults.heartbeat.target");
	if (Array.isArray(config.agents?.list)) for (const [index, entry] of config.agents.list.entries()) validateHeartbeatTarget(entry?.heartbeat?.target, `agents.list.${index}.heartbeat.target`);
	if (!hasExplicitPluginsConfig) {
		if (issues.length > 0) return {
			ok: false,
			issues,
			warnings
		};
		return {
			ok: true,
			config,
			warnings
		};
	}
	const { registry, knownIds, normalizedPlugins } = ensureRegistry();
	const pushMissingPluginIssue = (path, pluginId, opts) => {
		if (LEGACY_REMOVED_PLUGIN_IDS.has(pluginId)) {
			warnings.push({
				path,
				message: `plugin removed: ${pluginId} (stale config entry ignored; remove it from plugins config)`
			});
			return;
		}
		if (opts?.warnOnly) {
			warnings.push({
				path,
				message: `plugin not found: ${pluginId} (stale config entry ignored; remove it from plugins config)`
			});
			return;
		}
		issues.push({
			path,
			message: `plugin not found: ${pluginId}`
		});
	};
	const pluginsConfig = config.plugins;
	const entries = pluginsConfig?.entries;
	if (entries && isRecord$3(entries)) {
		for (const pluginId of Object.keys(entries)) if (!knownIds.has(pluginId)) pushMissingPluginIssue(`plugins.entries.${pluginId}`, pluginId, { warnOnly: true });
	}
	const allow = pluginsConfig?.allow ?? [];
	for (const pluginId of allow) {
		if (typeof pluginId !== "string" || !pluginId.trim()) continue;
		if (!knownIds.has(pluginId)) pushMissingPluginIssue("plugins.allow", pluginId);
	}
	const deny = pluginsConfig?.deny ?? [];
	for (const pluginId of deny) {
		if (typeof pluginId !== "string" || !pluginId.trim()) continue;
		if (!knownIds.has(pluginId)) pushMissingPluginIssue("plugins.deny", pluginId);
	}
	const memorySlot = normalizedPlugins.slots.memory;
	if (typeof memorySlot === "string" && memorySlot.trim() && !knownIds.has(memorySlot)) pushMissingPluginIssue("plugins.slots.memory", memorySlot);
	let selectedMemoryPluginId = null;
	const seenPlugins = /* @__PURE__ */ new Set();
	for (const record of registry.plugins) {
		const pluginId = record.id;
		if (seenPlugins.has(pluginId)) continue;
		seenPlugins.add(pluginId);
		const entry = normalizedPlugins.entries[pluginId];
		const entryHasConfig = Boolean(entry?.config);
		const enableState = resolveEffectiveEnableState({
			id: pluginId,
			origin: record.origin,
			config: normalizedPlugins,
			rootConfig: config
		});
		let enabled = enableState.enabled;
		let reason = enableState.reason;
		if (enabled) {
			const memoryDecision = resolveMemorySlotDecision({
				id: pluginId,
				kind: record.kind,
				slot: memorySlot,
				selectedId: selectedMemoryPluginId
			});
			if (!memoryDecision.enabled) {
				enabled = false;
				reason = memoryDecision.reason;
			}
			if (memoryDecision.selected && record.kind === "memory") selectedMemoryPluginId = pluginId;
		}
		if (enabled || entryHasConfig) if (record.configSchema) {
			const res = validateJsonSchemaValue({
				schema: record.configSchema,
				cacheKey: record.schemaCacheKey ?? record.manifestPath ?? pluginId,
				value: entry?.config ?? {}
			});
			if (!res.ok) for (const error of res.errors) issues.push({
				path: `plugins.entries.${pluginId}.config`,
				message: `invalid config: ${error}`
			});
		} else issues.push({
			path: `plugins.entries.${pluginId}`,
			message: `plugin schema missing for ${pluginId}`
		});
		if (!enabled && entryHasConfig) warnings.push({
			path: `plugins.entries.${pluginId}`,
			message: `plugin disabled (${reason ?? "disabled"}) but config is present`
		});
	}
	if (issues.length > 0) return {
		ok: false,
		issues,
		warnings
	};
	return {
		ok: true,
		config,
		warnings
	};
}

//#endregion
//#region src/config/version.ts
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-(\d+))?/;
function parseOpenClawVersion(raw) {
	if (!raw) return null;
	const match = raw.trim().match(VERSION_RE);
	if (!match) return null;
	const [, major, minor, patch, revision] = match;
	return {
		major: Number.parseInt(major, 10),
		minor: Number.parseInt(minor, 10),
		patch: Number.parseInt(patch, 10),
		revision: revision ? Number.parseInt(revision, 10) : 0
	};
}
function compareOpenClawVersions(a, b) {
	const parsedA = parseOpenClawVersion(a);
	const parsedB = parseOpenClawVersion(b);
	if (!parsedA || !parsedB) return null;
	if (parsedA.major !== parsedB.major) return parsedA.major < parsedB.major ? -1 : 1;
	if (parsedA.minor !== parsedB.minor) return parsedA.minor < parsedB.minor ? -1 : 1;
	if (parsedA.patch !== parsedB.patch) return parsedA.patch < parsedB.patch ? -1 : 1;
	if (parsedA.revision !== parsedB.revision) return parsedA.revision < parsedB.revision ? -1 : 1;
	return 0;
}

//#endregion
//#region src/config/io.ts
const SHELL_ENV_EXPECTED_KEYS = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"GEMINI_API_KEY",
	"ZAI_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"MINIMAX_API_KEY",
	"SYNTHETIC_API_KEY",
	"KILOCODE_API_KEY",
	"ELEVENLABS_API_KEY",
	"TELEGRAM_BOT_TOKEN",
	"DISCORD_BOT_TOKEN",
	"SLACK_BOT_TOKEN",
	"SLACK_APP_TOKEN",
	"OPENCLAW_GATEWAY_TOKEN",
	"OPENCLAW_GATEWAY_PASSWORD"
];
const OPEN_DM_POLICY_ALLOW_FROM_RE = /^(?<policyPath>[a-z0-9_.-]+)\s*=\s*"open"\s+requires\s+(?<allowPath>[a-z0-9_.-]+)(?:\s+\(or\s+[a-z0-9_.-]+\))?\s+to include "\*"$/i;
const CONFIG_AUDIT_LOG_FILENAME = "config-audit.jsonl";
const loggedInvalidConfigs = /* @__PURE__ */ new Set();
function hashConfigRaw(raw) {
	return crypto.createHash("sha256").update(raw ?? "").digest("hex");
}
function formatConfigValidationFailure(pathLabel, issueMessage) {
	const match = issueMessage.match(OPEN_DM_POLICY_ALLOW_FROM_RE);
	const policyPath = match?.groups?.policyPath?.trim();
	const allowPath = match?.groups?.allowPath?.trim();
	if (!policyPath || !allowPath) return `Config validation failed: ${pathLabel}: ${issueMessage}`;
	return [
		`Config validation failed: ${pathLabel}`,
		"",
		`Configuration mismatch: ${policyPath} is "open", but ${allowPath} does not include "*".`,
		"",
		"Fix with:",
		`  openclaw config set ${allowPath} '["*"]'`,
		"",
		"Or switch policy:",
		`  openclaw config set ${policyPath} "pairing"`
	].join("\n");
}
function isNumericPathSegment(raw) {
	return /^[0-9]+$/.test(raw);
}
function isWritePlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasOwnObjectKey(value, key) {
	return Object.prototype.hasOwnProperty.call(value, key);
}
const WRITE_PRUNED_OBJECT = Symbol("write-pruned-object");
function unsetPathForWriteAt(value, pathSegments, depth) {
	if (depth >= pathSegments.length) return {
		changed: false,
		value
	};
	const segment = pathSegments[depth];
	const isLeaf = depth === pathSegments.length - 1;
	if (Array.isArray(value)) {
		if (!isNumericPathSegment(segment)) return {
			changed: false,
			value
		};
		const index = Number.parseInt(segment, 10);
		if (!Number.isFinite(index) || index < 0 || index >= value.length) return {
			changed: false,
			value
		};
		if (isLeaf) {
			const next = value.slice();
			next.splice(index, 1);
			return {
				changed: true,
				value: next
			};
		}
		const child = unsetPathForWriteAt(value[index], pathSegments, depth + 1);
		if (!child.changed) return {
			changed: false,
			value
		};
		const next = value.slice();
		if (child.value === WRITE_PRUNED_OBJECT) next.splice(index, 1);
		else next[index] = child.value;
		return {
			changed: true,
			value: next
		};
	}
	if (isBlockedObjectKey(segment) || !isWritePlainObject(value) || !hasOwnObjectKey(value, segment)) return {
		changed: false,
		value
	};
	if (isLeaf) {
		const next = { ...value };
		delete next[segment];
		return {
			changed: true,
			value: Object.keys(next).length === 0 ? WRITE_PRUNED_OBJECT : next
		};
	}
	const child = unsetPathForWriteAt(value[segment], pathSegments, depth + 1);
	if (!child.changed) return {
		changed: false,
		value
	};
	const next = { ...value };
	if (child.value === WRITE_PRUNED_OBJECT) delete next[segment];
	else next[segment] = child.value;
	return {
		changed: true,
		value: Object.keys(next).length === 0 ? WRITE_PRUNED_OBJECT : next
	};
}
function unsetPathForWrite(root, pathSegments) {
	if (pathSegments.length === 0) return {
		changed: false,
		next: root
	};
	const result = unsetPathForWriteAt(root, pathSegments, 0);
	if (!result.changed) return {
		changed: false,
		next: root
	};
	if (result.value === WRITE_PRUNED_OBJECT) return {
		changed: true,
		next: {}
	};
	if (isWritePlainObject(result.value)) return {
		changed: true,
		next: coerceConfig(result.value)
	};
	return {
		changed: false,
		next: root
	};
}
function resolveConfigSnapshotHash(snapshot) {
	if (typeof snapshot.hash === "string") {
		const trimmed = snapshot.hash.trim();
		if (trimmed) return trimmed;
	}
	if (typeof snapshot.raw !== "string") return null;
	return hashConfigRaw(snapshot.raw);
}
function coerceConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value;
}
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasConfigMeta(value) {
	if (!isPlainObject(value)) return false;
	const meta = value.meta;
	return isPlainObject(meta);
}
function resolveGatewayMode(value) {
	if (!isPlainObject(value)) return null;
	const gateway = value.gateway;
	if (!isPlainObject(gateway) || typeof gateway.mode !== "string") return null;
	const trimmed = gateway.mode.trim();
	return trimmed.length > 0 ? trimmed : null;
}
function cloneUnknown(value) {
	return structuredClone(value);
}
function createMergePatch(base, target) {
	if (!isPlainObject(base) || !isPlainObject(target)) return cloneUnknown(target);
	const patch = {};
	const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
	for (const key of keys) {
		const hasBase = key in base;
		if (!(key in target)) {
			patch[key] = null;
			continue;
		}
		const targetValue = target[key];
		if (!hasBase) {
			patch[key] = cloneUnknown(targetValue);
			continue;
		}
		const baseValue = base[key];
		if (isPlainObject(baseValue) && isPlainObject(targetValue)) {
			const childPatch = createMergePatch(baseValue, targetValue);
			if (isPlainObject(childPatch) && Object.keys(childPatch).length === 0) continue;
			patch[key] = childPatch;
			continue;
		}
		if (!isDeepStrictEqual(baseValue, targetValue)) patch[key] = cloneUnknown(targetValue);
	}
	return patch;
}
function collectEnvRefPaths(value, path, output) {
	if (typeof value === "string") {
		if (containsEnvVarReference(value)) output.set(path, value);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			collectEnvRefPaths(item, `${path}[${index}]`, output);
		});
		return;
	}
	if (isPlainObject(value)) for (const [key, child] of Object.entries(value)) collectEnvRefPaths(child, path ? `${path}.${key}` : key, output);
}
function collectChangedPaths(base, target, path, output) {
	if (Array.isArray(base) && Array.isArray(target)) {
		const max = Math.max(base.length, target.length);
		for (let index = 0; index < max; index += 1) {
			const childPath = path ? `${path}[${index}]` : `[${index}]`;
			if (index >= base.length || index >= target.length) {
				output.add(childPath);
				continue;
			}
			collectChangedPaths(base[index], target[index], childPath, output);
		}
		return;
	}
	if (isPlainObject(base) && isPlainObject(target)) {
		const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
		for (const key of keys) {
			const childPath = path ? `${path}.${key}` : key;
			const hasBase = key in base;
			if (!(key in target) || !hasBase) {
				output.add(childPath);
				continue;
			}
			collectChangedPaths(base[key], target[key], childPath, output);
		}
		return;
	}
	if (!isDeepStrictEqual(base, target)) output.add(path);
}
function parentPath(value) {
	if (!value) return "";
	if (value.endsWith("]")) {
		const index = value.lastIndexOf("[");
		return index > 0 ? value.slice(0, index) : "";
	}
	const index = value.lastIndexOf(".");
	return index >= 0 ? value.slice(0, index) : "";
}
function isPathChanged(path, changedPaths) {
	if (changedPaths.has(path)) return true;
	let current = parentPath(path);
	while (current) {
		if (changedPaths.has(current)) return true;
		current = parentPath(current);
	}
	return changedPaths.has("");
}
function restoreEnvRefsFromMap(value, path, envRefMap, changedPaths) {
	if (typeof value === "string") {
		if (!isPathChanged(path, changedPaths)) {
			const original = envRefMap.get(path);
			if (original !== void 0) return original;
		}
		return value;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item, index) => {
			const updated = restoreEnvRefsFromMap(item, `${path}[${index}]`, envRefMap, changedPaths);
			if (updated !== item) changed = true;
			return updated;
		});
		return changed ? next : value;
	}
	if (isPlainObject(value)) {
		let changed = false;
		const next = {};
		for (const [key, child] of Object.entries(value)) {
			const updated = restoreEnvRefsFromMap(child, path ? `${path}.${key}` : key, envRefMap, changedPaths);
			if (updated !== child) changed = true;
			next[key] = updated;
		}
		return changed ? next : value;
	}
	return value;
}
function resolveConfigAuditLogPath(env, homedir) {
	return path.join(resolveStateDir(env, homedir), "logs", CONFIG_AUDIT_LOG_FILENAME);
}
function resolveConfigWriteSuspiciousReasons(params) {
	const reasons = [];
	if (!params.existsBefore) return reasons;
	if (typeof params.previousBytes === "number" && typeof params.nextBytes === "number" && params.previousBytes >= 512 && params.nextBytes < Math.floor(params.previousBytes * .5)) reasons.push(`size-drop:${params.previousBytes}->${params.nextBytes}`);
	if (!params.hasMetaBefore) reasons.push("missing-meta-before-write");
	if (params.gatewayModeBefore && !params.gatewayModeAfter) reasons.push("gateway-mode-removed");
	return reasons;
}
async function appendConfigWriteAuditRecord(deps, record) {
	try {
		const auditPath = resolveConfigAuditLogPath(deps.env, deps.homedir);
		await deps.fs.promises.mkdir(path.dirname(auditPath), {
			recursive: true,
			mode: 448
		});
		await deps.fs.promises.appendFile(auditPath, `${JSON.stringify(record)}\n`, {
			encoding: "utf-8",
			mode: 384
		});
	} catch {}
}
function warnOnConfigMiskeys(raw, logger) {
	if (!raw || typeof raw !== "object") return;
	const gateway = raw.gateway;
	if (!gateway || typeof gateway !== "object") return;
	if ("token" in gateway) logger.warn("Config uses \"gateway.token\". This key is ignored; use \"gateway.auth.token\" instead.");
}
function stampConfigVersion(cfg) {
	const now = (/* @__PURE__ */ new Date()).toISOString();
	return {
		...cfg,
		meta: {
			...cfg.meta,
			lastTouchedVersion: VERSION,
			lastTouchedAt: now
		}
	};
}
function warnIfConfigFromFuture(cfg, logger) {
	const touched = cfg.meta?.lastTouchedVersion;
	if (!touched) return;
	const cmp = compareOpenClawVersions(VERSION, touched);
	if (cmp === null) return;
	if (cmp < 0) logger.warn(`Config was last written by a newer OpenClaw (${touched}); current version is ${VERSION}.`);
}
function resolveConfigPathForDeps(deps) {
	if (deps.configPath) return deps.configPath;
	return resolveConfigPath(deps.env, resolveStateDir(deps.env, deps.homedir));
}
function normalizeDeps(overrides = {}) {
	return {
		fs: overrides.fs ?? syncFs,
		json5: overrides.json5 ?? JSON5,
		env: overrides.env ?? process.env,
		homedir: overrides.homedir ?? (() => resolveRequiredHomeDir(overrides.env ?? process.env, os.homedir)),
		configPath: overrides.configPath ?? "",
		logger: overrides.logger ?? console
	};
}
function maybeLoadDotEnvForConfig(env) {
	if (env !== process.env) return;
	loadDotEnv({ quiet: true });
}
function parseConfigJson5(raw, json5 = JSON5) {
	try {
		return {
			ok: true,
			parsed: json5.parse(raw)
		};
	} catch (err) {
		return {
			ok: false,
			error: String(err)
		};
	}
}
function resolveConfigIncludesForRead(parsed, configPath, deps) {
	return resolveConfigIncludes(parsed, configPath, {
		readFile: (candidate) => deps.fs.readFileSync(candidate, "utf-8"),
		readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) => readConfigIncludeFileWithGuards({
			includePath,
			resolvedPath,
			rootRealDir,
			ioFs: deps.fs
		}),
		parseJson: (raw) => deps.json5.parse(raw)
	});
}
function resolveConfigForRead(resolvedIncludes, env) {
	if (resolvedIncludes && typeof resolvedIncludes === "object" && "env" in resolvedIncludes) applyConfigEnvVars(resolvedIncludes, env);
	return {
		resolvedConfigRaw: resolveConfigEnvVars(resolvedIncludes, env),
		envSnapshotForRestore: { ...env }
	};
}
function createConfigIO(overrides = {}) {
	const deps = normalizeDeps(overrides);
	const requestedConfigPath = resolveConfigPathForDeps(deps);
	const configPath = (deps.configPath ? [requestedConfigPath] : resolveDefaultConfigCandidates(deps.env, deps.homedir)).find((candidate) => deps.fs.existsSync(candidate)) ?? requestedConfigPath;
	function loadConfig() {
		try {
			maybeLoadDotEnvForConfig(deps.env);
			if (!deps.fs.existsSync(configPath)) {
				if (shouldEnableShellEnvFallback(deps.env) && !shouldDeferShellEnvFallback(deps.env)) loadShellEnvFallback({
					enabled: true,
					env: deps.env,
					expectedKeys: SHELL_ENV_EXPECTED_KEYS,
					logger: deps.logger,
					timeoutMs: resolveShellEnvFallbackTimeoutMs(deps.env)
				});
				return {};
			}
			const raw = deps.fs.readFileSync(configPath, "utf-8");
			const { resolvedConfigRaw: resolvedConfig } = resolveConfigForRead(resolveConfigIncludesForRead(deps.json5.parse(raw), configPath, deps), deps.env);
			warnOnConfigMiskeys(resolvedConfig, deps.logger);
			if (typeof resolvedConfig !== "object" || resolvedConfig === null) return {};
			const preValidationDuplicates = findDuplicateAgentDirs(resolvedConfig, {
				env: deps.env,
				homedir: deps.homedir
			});
			if (preValidationDuplicates.length > 0) throw new DuplicateAgentDirError(preValidationDuplicates);
			const validated = validateConfigObjectWithPlugins(resolvedConfig);
			if (!validated.ok) {
				const details = validated.issues.map((iss) => `- ${iss.path || "<root>"}: ${iss.message}`).join("\n");
				if (!loggedInvalidConfigs.has(configPath)) {
					loggedInvalidConfigs.add(configPath);
					deps.logger.error(`Invalid config at ${configPath}:\\n${details}`);
				}
				const error = /* @__PURE__ */ new Error("Invalid config");
				error.code = "INVALID_CONFIG";
				error.details = details;
				throw error;
			}
			if (validated.warnings.length > 0) {
				const details = validated.warnings.map((iss) => `- ${iss.path || "<root>"}: ${iss.message}`).join("\n");
				deps.logger.warn(`Config warnings:\\n${details}`);
			}
			warnIfConfigFromFuture(validated.config, deps.logger);
			const cfg = applyTalkConfigNormalization(applyModelDefaults(applyCompactionDefaults(applyContextPruningDefaults(applyAgentDefaults(applySessionDefaults(applyLoggingDefaults(applyMessageDefaults(validated.config))))))));
			normalizeConfigPaths(cfg);
			normalizeExecSafeBinProfilesInConfig(cfg);
			const duplicates = findDuplicateAgentDirs(cfg, {
				env: deps.env,
				homedir: deps.homedir
			});
			if (duplicates.length > 0) throw new DuplicateAgentDirError(duplicates);
			applyConfigEnvVars(cfg, deps.env);
			if ((shouldEnableShellEnvFallback(deps.env) || cfg.env?.shellEnv?.enabled === true) && !shouldDeferShellEnvFallback(deps.env)) loadShellEnvFallback({
				enabled: true,
				env: deps.env,
				expectedKeys: SHELL_ENV_EXPECTED_KEYS,
				logger: deps.logger,
				timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(deps.env)
			});
			const pendingSecret = AUTO_OWNER_DISPLAY_SECRET_BY_PATH.get(configPath);
			const ownerDisplaySecretResolution = ensureOwnerDisplaySecret(cfg, () => pendingSecret ?? crypto.randomBytes(32).toString("hex"));
			const cfgWithOwnerDisplaySecret = ownerDisplaySecretResolution.config;
			if (ownerDisplaySecretResolution.generatedSecret) {
				AUTO_OWNER_DISPLAY_SECRET_BY_PATH.set(configPath, ownerDisplaySecretResolution.generatedSecret);
				if (!AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT.has(configPath)) {
					AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT.add(configPath);
					writeConfigFile(cfgWithOwnerDisplaySecret, { expectedConfigPath: configPath }).then(() => {
						AUTO_OWNER_DISPLAY_SECRET_BY_PATH.delete(configPath);
						AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.delete(configPath);
					}).catch((err) => {
						if (!AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.has(configPath)) {
							AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.add(configPath);
							deps.logger.warn(`Failed to persist auto-generated commands.ownerDisplaySecret at ${configPath}: ${String(err)}`);
						}
					}).finally(() => {
						AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT.delete(configPath);
					});
				}
			} else {
				AUTO_OWNER_DISPLAY_SECRET_BY_PATH.delete(configPath);
				AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.delete(configPath);
			}
			return applyConfigOverrides(cfgWithOwnerDisplaySecret);
		} catch (err) {
			if (err instanceof DuplicateAgentDirError) {
				deps.logger.error(err.message);
				throw err;
			}
			if (err?.code === "INVALID_CONFIG") return {};
			deps.logger.error(`Failed to read config at ${configPath}`, err);
			return {};
		}
	}
	async function readConfigFileSnapshotInternal() {
		maybeLoadDotEnvForConfig(deps.env);
		if (!deps.fs.existsSync(configPath)) {
			const hash = hashConfigRaw(null);
			return { snapshot: {
				path: configPath,
				exists: false,
				raw: null,
				parsed: {},
				resolved: {},
				valid: true,
				config: applyTalkApiKey(applyTalkConfigNormalization(applyModelDefaults(applyCompactionDefaults(applyContextPruningDefaults(applyAgentDefaults(applySessionDefaults(applyMessageDefaults({})))))))),
				hash,
				issues: [],
				warnings: [],
				legacyIssues: []
			} };
		}
		try {
			const raw = deps.fs.readFileSync(configPath, "utf-8");
			const hash = hashConfigRaw(raw);
			const parsedRes = parseConfigJson5(raw, deps.json5);
			if (!parsedRes.ok) return { snapshot: {
				path: configPath,
				exists: true,
				raw,
				parsed: {},
				resolved: {},
				valid: false,
				config: {},
				hash,
				issues: [{
					path: "",
					message: `JSON5 parse failed: ${parsedRes.error}`
				}],
				warnings: [],
				legacyIssues: []
			} };
			let resolved;
			try {
				resolved = resolveConfigIncludesForRead(parsedRes.parsed, configPath, deps);
			} catch (err) {
				const message = err instanceof ConfigIncludeError ? err.message : `Include resolution failed: ${String(err)}`;
				return { snapshot: {
					path: configPath,
					exists: true,
					raw,
					parsed: parsedRes.parsed,
					resolved: coerceConfig(parsedRes.parsed),
					valid: false,
					config: coerceConfig(parsedRes.parsed),
					hash,
					issues: [{
						path: "",
						message
					}],
					warnings: [],
					legacyIssues: []
				} };
			}
			let readResolution;
			try {
				readResolution = resolveConfigForRead(resolved, deps.env);
			} catch (err) {
				const message = err instanceof MissingEnvVarError ? err.message : `Env var substitution failed: ${String(err)}`;
				return { snapshot: {
					path: configPath,
					exists: true,
					raw,
					parsed: parsedRes.parsed,
					resolved: coerceConfig(resolved),
					valid: false,
					config: coerceConfig(resolved),
					hash,
					issues: [{
						path: "",
						message
					}],
					warnings: [],
					legacyIssues: []
				} };
			}
			const resolvedConfigRaw = readResolution.resolvedConfigRaw;
			const legacyIssues = findLegacyConfigIssues(resolvedConfigRaw);
			const validated = validateConfigObjectWithPlugins(resolvedConfigRaw);
			if (!validated.ok) return { snapshot: {
				path: configPath,
				exists: true,
				raw,
				parsed: parsedRes.parsed,
				resolved: coerceConfig(resolvedConfigRaw),
				valid: false,
				config: coerceConfig(resolvedConfigRaw),
				hash,
				issues: validated.issues,
				warnings: validated.warnings,
				legacyIssues
			} };
			warnIfConfigFromFuture(validated.config, deps.logger);
			const snapshotConfig = normalizeConfigPaths(applyTalkApiKey(applyTalkConfigNormalization(applyModelDefaults(applyAgentDefaults(applySessionDefaults(applyLoggingDefaults(applyMessageDefaults(validated.config))))))));
			normalizeExecSafeBinProfilesInConfig(snapshotConfig);
			return {
				snapshot: {
					path: configPath,
					exists: true,
					raw,
					parsed: parsedRes.parsed,
					resolved: coerceConfig(resolvedConfigRaw),
					valid: true,
					config: snapshotConfig,
					hash,
					issues: [],
					warnings: validated.warnings,
					legacyIssues
				},
				envSnapshotForRestore: readResolution.envSnapshotForRestore
			};
		} catch (err) {
			const nodeErr = err;
			let message;
			if (nodeErr?.code === "EACCES") {
				const uid = process.getuid?.();
				const uidHint = typeof uid === "number" ? String(uid) : "$(id -u)";
				message = [
					`read failed: ${String(err)}`,
					``,
					`Config file is not readable by the current process. If running in a container`,
					`or 1-click deployment, fix ownership with:`,
					`  chown ${uidHint} "${configPath}"`,
					`Then restart the gateway.`
				].join("\n");
				deps.logger.error(message);
			} else message = `read failed: ${String(err)}`;
			return { snapshot: {
				path: configPath,
				exists: true,
				raw: null,
				parsed: {},
				resolved: {},
				valid: false,
				config: {},
				hash: hashConfigRaw(null),
				issues: [{
					path: "",
					message
				}],
				warnings: [],
				legacyIssues: []
			} };
		}
	}
	async function readConfigFileSnapshot() {
		return (await readConfigFileSnapshotInternal()).snapshot;
	}
	async function readConfigFileSnapshotForWrite() {
		const result = await readConfigFileSnapshotInternal();
		return {
			snapshot: result.snapshot,
			writeOptions: {
				envSnapshotForRestore: result.envSnapshotForRestore,
				expectedConfigPath: configPath
			}
		};
	}
	async function writeConfigFile(cfg, options = {}) {
		clearConfigCache();
		let persistCandidate = cfg;
		const { snapshot } = await readConfigFileSnapshotInternal();
		let envRefMap = null;
		let changedPaths = null;
		if (snapshot.valid && snapshot.exists) {
			const patch = createMergePatch(snapshot.config, cfg);
			persistCandidate = applyMergePatch(snapshot.resolved, patch);
			try {
				const resolvedIncludes = resolveConfigIncludes(snapshot.parsed, configPath, {
					readFile: (candidate) => deps.fs.readFileSync(candidate, "utf-8"),
					readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) => readConfigIncludeFileWithGuards({
						includePath,
						resolvedPath,
						rootRealDir,
						ioFs: deps.fs
					}),
					parseJson: (raw) => deps.json5.parse(raw)
				});
				const collected = /* @__PURE__ */ new Map();
				collectEnvRefPaths(resolvedIncludes, "", collected);
				if (collected.size > 0) {
					envRefMap = collected;
					changedPaths = /* @__PURE__ */ new Set();
					collectChangedPaths(snapshot.config, cfg, "", changedPaths);
				}
			} catch {
				envRefMap = null;
			}
		}
		const validated = validateConfigObjectRawWithPlugins(persistCandidate);
		if (!validated.ok) {
			const issue = validated.issues[0];
			const pathLabel = issue?.path ? issue.path : "<root>";
			const issueMessage = issue?.message ?? "invalid";
			throw new Error(formatConfigValidationFailure(pathLabel, issueMessage));
		}
		if (validated.warnings.length > 0) {
			const details = validated.warnings.map((warning) => `- ${warning.path}: ${warning.message}`).join("\n");
			deps.logger.warn(`Config warnings:\n${details}`);
		}
		let cfgToWrite = validated.config;
		try {
			if (deps.fs.existsSync(configPath)) {
				const parsedRes = parseConfigJson5(await deps.fs.promises.readFile(configPath, "utf-8"), deps.json5);
				if (parsedRes.ok) {
					const envForRestore = options.envSnapshotForRestore ?? deps.env;
					cfgToWrite = restoreEnvVarRefs(cfgToWrite, parsedRes.parsed, envForRestore);
				}
			}
		} catch {}
		const dir = path.dirname(configPath);
		await deps.fs.promises.mkdir(dir, {
			recursive: true,
			mode: 448
		});
		let outputConfig = envRefMap && changedPaths ? restoreEnvRefsFromMap(cfgToWrite, "", envRefMap, changedPaths) : cfgToWrite;
		if (options.unsetPaths?.length) for (const unsetPath of options.unsetPaths) {
			if (!Array.isArray(unsetPath) || unsetPath.length === 0) continue;
			const unsetResult = unsetPathForWrite(outputConfig, unsetPath);
			if (unsetResult.changed) outputConfig = unsetResult.next;
		}
		const stampedOutputConfig = stampConfigVersion(outputConfig);
		const json = JSON.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\n");
		const nextHash = hashConfigRaw(json);
		const previousHash = resolveConfigSnapshotHash(snapshot);
		const changedPathCount = changedPaths?.size;
		const previousBytes = typeof snapshot.raw === "string" ? Buffer.byteLength(snapshot.raw, "utf-8") : null;
		const nextBytes = Buffer.byteLength(json, "utf-8");
		const hasMetaBefore = hasConfigMeta(snapshot.parsed);
		const hasMetaAfter = hasConfigMeta(stampedOutputConfig);
		const gatewayModeBefore = resolveGatewayMode(snapshot.resolved);
		const gatewayModeAfter = resolveGatewayMode(stampedOutputConfig);
		const suspiciousReasons = resolveConfigWriteSuspiciousReasons({
			existsBefore: snapshot.exists,
			previousBytes,
			nextBytes,
			hasMetaBefore,
			gatewayModeBefore,
			gatewayModeAfter
		});
		const logConfigOverwrite = () => {
			if (!snapshot.exists) return;
			const isVitest = deps.env.VITEST === "true";
			const shouldLogInVitest = deps.env.OPENCLAW_TEST_CONFIG_OVERWRITE_LOG === "1";
			if (isVitest && !shouldLogInVitest) return;
			const changeSummary = typeof changedPathCount === "number" ? `, changedPaths=${changedPathCount}` : "";
			deps.logger.warn(`Config overwrite: ${configPath} (sha256 ${previousHash ?? "unknown"} -> ${nextHash}, backup=${configPath}.bak${changeSummary})`);
		};
		const logConfigWriteAnomalies = () => {
			if (suspiciousReasons.length === 0) return;
			const isVitest = deps.env.VITEST === "true";
			const shouldLogInVitest = deps.env.OPENCLAW_TEST_CONFIG_WRITE_ANOMALY_LOG === "1";
			if (isVitest && !shouldLogInVitest) return;
			deps.logger.warn(`Config write anomaly: ${configPath} (${suspiciousReasons.join(", ")})`);
		};
		const auditRecordBase = {
			ts: (/* @__PURE__ */ new Date()).toISOString(),
			source: "config-io",
			event: "config.write",
			configPath,
			pid: process.pid,
			ppid: process.ppid,
			cwd: process.cwd(),
			argv: process.argv.slice(0, 8),
			execArgv: process.execArgv.slice(0, 8),
			watchMode: deps.env.OPENCLAW_WATCH_MODE === "1",
			watchSession: typeof deps.env.OPENCLAW_WATCH_SESSION === "string" && deps.env.OPENCLAW_WATCH_SESSION.trim().length > 0 ? deps.env.OPENCLAW_WATCH_SESSION.trim() : null,
			watchCommand: typeof deps.env.OPENCLAW_WATCH_COMMAND === "string" && deps.env.OPENCLAW_WATCH_COMMAND.trim().length > 0 ? deps.env.OPENCLAW_WATCH_COMMAND.trim() : null,
			existsBefore: snapshot.exists,
			previousHash: previousHash ?? null,
			nextHash,
			previousBytes,
			nextBytes,
			changedPathCount: typeof changedPathCount === "number" ? changedPathCount : null,
			hasMetaBefore,
			hasMetaAfter,
			gatewayModeBefore,
			gatewayModeAfter,
			suspicious: suspiciousReasons
		};
		const appendWriteAudit = async (result, err) => {
			const errorCode = err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : void 0;
			const errorMessage = err && typeof err === "object" && "message" in err && typeof err.message === "string" ? err.message : void 0;
			await appendConfigWriteAuditRecord(deps, {
				...auditRecordBase,
				result,
				nextHash: result === "failed" ? null : auditRecordBase.nextHash,
				nextBytes: result === "failed" ? null : auditRecordBase.nextBytes,
				errorCode,
				errorMessage
			});
		};
		const tmp = path.join(dir, `${path.basename(configPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
		try {
			await deps.fs.promises.writeFile(tmp, json, {
				encoding: "utf-8",
				mode: 384
			});
			if (deps.fs.existsSync(configPath)) {
				await rotateConfigBackups(configPath, deps.fs.promises);
				await deps.fs.promises.copyFile(configPath, `${configPath}.bak`).catch(() => {});
			}
			try {
				await deps.fs.promises.rename(tmp, configPath);
			} catch (err) {
				const code = err.code;
				if (code === "EPERM" || code === "EEXIST") {
					await deps.fs.promises.copyFile(tmp, configPath);
					await deps.fs.promises.chmod(configPath, 384).catch(() => {});
					await deps.fs.promises.unlink(tmp).catch(() => {});
					logConfigOverwrite();
					logConfigWriteAnomalies();
					await appendWriteAudit("copy-fallback");
					return;
				}
				await deps.fs.promises.unlink(tmp).catch(() => {});
				throw err;
			}
			logConfigOverwrite();
			logConfigWriteAnomalies();
			await appendWriteAudit("rename");
		} catch (err) {
			await appendWriteAudit("failed", err);
			throw err;
		}
	}
	return {
		configPath,
		loadConfig,
		readConfigFileSnapshot,
		readConfigFileSnapshotForWrite,
		writeConfigFile
	};
}
const DEFAULT_CONFIG_CACHE_MS = 200;
const AUTO_OWNER_DISPLAY_SECRET_BY_PATH = /* @__PURE__ */ new Map();
const AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT = /* @__PURE__ */ new Set();
const AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED = /* @__PURE__ */ new Set();
let configCache = null;
let runtimeConfigSnapshot = null;
let runtimeConfigSourceSnapshot = null;
function resolveConfigCacheMs(env) {
	const raw = env.OPENCLAW_CONFIG_CACHE_MS?.trim();
	if (raw === "" || raw === "0") return 0;
	if (!raw) return DEFAULT_CONFIG_CACHE_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return DEFAULT_CONFIG_CACHE_MS;
	return Math.max(0, parsed);
}
function shouldUseConfigCache(env) {
	if (env.OPENCLAW_DISABLE_CONFIG_CACHE?.trim()) return false;
	return resolveConfigCacheMs(env) > 0;
}
function clearConfigCache() {
	configCache = null;
}
function loadConfig() {
	if (runtimeConfigSnapshot) return runtimeConfigSnapshot;
	const io = createConfigIO();
	const configPath = io.configPath;
	const now = Date.now();
	if (shouldUseConfigCache(process.env)) {
		const cached = configCache;
		if (cached && cached.configPath === configPath && cached.expiresAt > now) return cached.config;
	}
	const config = io.loadConfig();
	if (shouldUseConfigCache(process.env)) {
		const cacheMs = resolveConfigCacheMs(process.env);
		if (cacheMs > 0) configCache = {
			configPath,
			expiresAt: now + cacheMs,
			config
		};
	}
	return config;
}
async function readConfigFileSnapshot() {
	return await createConfigIO().readConfigFileSnapshot();
}
async function readConfigFileSnapshotForWrite() {
	return await createConfigIO().readConfigFileSnapshotForWrite();
}
async function writeConfigFile(cfg, options = {}) {
	const io = createConfigIO();
	let nextCfg = cfg;
	if (runtimeConfigSnapshot && runtimeConfigSourceSnapshot) {
		const runtimePatch = createMergePatch(runtimeConfigSnapshot, cfg);
		nextCfg = coerceConfig(applyMergePatch(runtimeConfigSourceSnapshot, runtimePatch));
	}
	const sameConfigPath = options.expectedConfigPath === void 0 || options.expectedConfigPath === io.configPath;
	await io.writeConfigFile(nextCfg, {
		envSnapshotForRestore: sameConfigPath ? options.envSnapshotForRestore : void 0,
		unsetPaths: options.unsetPaths
	});
}

//#endregion
//#region src/providers/qwen-portal-oauth.ts
const QWEN_OAUTH_TOKEN_ENDPOINT = `https://chat.qwen.ai/api/v1/oauth2/token`;
const QWEN_OAUTH_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
async function refreshQwenPortalCredentials(credentials) {
	const refreshToken = credentials.refresh?.trim();
	if (!refreshToken) throw new Error("Qwen OAuth refresh token missing; re-authenticate.");
	const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json"
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: QWEN_OAUTH_CLIENT_ID
		})
	});
	if (!response.ok) {
		const text = await response.text();
		if (response.status === 400) throw new Error(`Qwen OAuth refresh token expired or invalid. Re-authenticate with \`${formatCliCommand("openclaw models auth login --provider qwen-portal")}\`.`);
		throw new Error(`Qwen OAuth refresh failed: ${text || response.statusText}`);
	}
	const payload = await response.json();
	const accessToken = payload.access_token?.trim();
	const newRefreshToken = payload.refresh_token?.trim();
	const expiresIn = payload.expires_in;
	if (!accessToken) throw new Error("Qwen OAuth refresh response missing access token.");
	if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error("Qwen OAuth refresh response missing or invalid expires_in.");
	return {
		...credentials,
		access: accessToken,
		refresh: newRefreshToken || refreshToken,
		expires: Date.now() + expiresIn * 1e3
	};
}

//#endregion
//#region src/security/windows-acl.ts
const INHERIT_FLAGS = new Set([
	"I",
	"OI",
	"CI",
	"IO",
	"NP"
]);
const WORLD_PRINCIPALS = new Set([
	"everyone",
	"users",
	"builtin\\users",
	"authenticated users",
	"nt authority\\authenticated users"
]);
const TRUSTED_BASE = new Set([
	"nt authority\\system",
	"system",
	"builtin\\administrators",
	"creator owner"
]);
const WORLD_SUFFIXES = ["\\users", "\\authenticated users"];
const TRUSTED_SUFFIXES = ["\\administrators", "\\system"];
const SID_RE = /^s-\d+-\d+(-\d+)+$/i;
const TRUSTED_SIDS = new Set([
	"s-1-5-18",
	"s-1-5-32-544",
	"s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
]);
const STATUS_PREFIXES = [
	"successfully processed",
	"processed",
	"failed processing",
	"no mapping between account names"
];
const normalize = (value) => value.trim().toLowerCase();
function resolveWindowsUserPrincipal(env) {
	const username = env?.USERNAME?.trim() || os.userInfo().username?.trim();
	if (!username) return null;
	const domain = env?.USERDOMAIN?.trim();
	return domain ? `${domain}\\${username}` : username;
}
function buildTrustedPrincipals(env) {
	const trusted = new Set(TRUSTED_BASE);
	const principal = resolveWindowsUserPrincipal(env);
	if (principal) {
		trusted.add(normalize(principal));
		const userOnly = principal.split("\\").at(-1);
		if (userOnly) trusted.add(normalize(userOnly));
	}
	const userSid = normalize(env?.USERSID ?? "");
	if (userSid && SID_RE.test(userSid)) trusted.add(userSid);
	return trusted;
}
function classifyPrincipal(principal, trustedPrincipals) {
	const normalized = normalize(principal);
	if (SID_RE.test(normalized)) return TRUSTED_SIDS.has(normalized) || trustedPrincipals.has(normalized) ? "trusted" : "group";
	if (trustedPrincipals.has(normalized) || TRUSTED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return "trusted";
	if (WORLD_PRINCIPALS.has(normalized) || WORLD_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return "world";
	return "group";
}
function rightsFromTokens(tokens) {
	const upper = tokens.join("").toUpperCase();
	const canWrite = upper.includes("F") || upper.includes("M") || upper.includes("W") || upper.includes("D");
	return {
		canRead: upper.includes("F") || upper.includes("M") || upper.includes("R"),
		canWrite
	};
}
function isStatusLine(lowerLine) {
	return STATUS_PREFIXES.some((prefix) => lowerLine.startsWith(prefix));
}
function stripTargetPrefix(params) {
	if (params.lowerLine.startsWith(params.lowerTarget)) return params.trimmedLine.slice(params.normalizedTarget.length).trim();
	if (params.lowerLine.startsWith(params.quotedLower)) return params.trimmedLine.slice(params.quotedTarget.length).trim();
	return params.trimmedLine;
}
function parseAceEntry(entry) {
	if (!entry || !entry.includes("(")) return null;
	const idx = entry.indexOf(":");
	if (idx === -1) return null;
	const principal = entry.slice(0, idx).trim();
	const rawRights = entry.slice(idx + 1).trim();
	const tokens = rawRights.match(/\(([^)]+)\)/g)?.map((token) => token.slice(1, -1).trim()).filter(Boolean) ?? [];
	if (tokens.some((token) => token.toUpperCase() === "DENY")) return null;
	const rights = tokens.filter((token) => !INHERIT_FLAGS.has(token.toUpperCase()));
	if (rights.length === 0) return null;
	const { canRead, canWrite } = rightsFromTokens(rights);
	return {
		principal,
		rights,
		rawRights,
		canRead,
		canWrite
	};
}
function parseIcaclsOutput(output, targetPath) {
	const entries = [];
	const normalizedTarget = targetPath.trim();
	const lowerTarget = normalizedTarget.toLowerCase();
	const quotedTarget = `"${normalizedTarget}"`;
	const quotedLower = quotedTarget.toLowerCase();
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line.trim()) continue;
		const trimmed = line.trim();
		const lower = trimmed.toLowerCase();
		if (isStatusLine(lower)) continue;
		const parsed = parseAceEntry(stripTargetPrefix({
			trimmedLine: trimmed,
			lowerLine: lower,
			normalizedTarget,
			lowerTarget,
			quotedTarget,
			quotedLower
		}));
		if (!parsed) continue;
		entries.push(parsed);
	}
	return entries;
}
function summarizeWindowsAcl(entries, env) {
	const trustedPrincipals = buildTrustedPrincipals(env);
	const trusted = [];
	const untrustedWorld = [];
	const untrustedGroup = [];
	for (const entry of entries) {
		const classification = classifyPrincipal(entry.principal, trustedPrincipals);
		if (classification === "trusted") trusted.push(entry);
		else if (classification === "world") untrustedWorld.push(entry);
		else untrustedGroup.push(entry);
	}
	return {
		trusted,
		untrustedWorld,
		untrustedGroup
	};
}
async function inspectWindowsAcl(targetPath, opts) {
	const exec = opts?.exec ?? runExec;
	try {
		const { stdout, stderr } = await exec("icacls", [targetPath]);
		const entries = parseIcaclsOutput(`${stdout}\n${stderr}`.trim(), targetPath);
		const { trusted, untrustedWorld, untrustedGroup } = summarizeWindowsAcl(entries, opts?.env);
		return {
			ok: true,
			entries,
			trusted,
			untrustedWorld,
			untrustedGroup
		};
	} catch (err) {
		return {
			ok: false,
			entries: [],
			trusted: [],
			untrustedWorld: [],
			untrustedGroup: [],
			error: String(err)
		};
	}
}
function formatWindowsAclSummary(summary) {
	if (!summary.ok) return "unknown";
	const untrusted = [...summary.untrustedWorld, ...summary.untrustedGroup];
	if (untrusted.length === 0) return "trusted-only";
	return untrusted.map((entry) => `${entry.principal}:${entry.rawRights}`).join(", ");
}

//#endregion
//#region src/security/audit-fs.ts
async function safeStat(targetPath) {
	try {
		const lst = await fs.lstat(targetPath);
		return {
			ok: true,
			isSymlink: lst.isSymbolicLink(),
			isDir: lst.isDirectory(),
			mode: typeof lst.mode === "number" ? lst.mode : null,
			uid: typeof lst.uid === "number" ? lst.uid : null,
			gid: typeof lst.gid === "number" ? lst.gid : null
		};
	} catch (err) {
		return {
			ok: false,
			isSymlink: false,
			isDir: false,
			mode: null,
			uid: null,
			gid: null,
			error: String(err)
		};
	}
}
async function inspectPathPermissions(targetPath, opts) {
	const st = await safeStat(targetPath);
	if (!st.ok) return {
		ok: false,
		isSymlink: false,
		isDir: false,
		mode: null,
		bits: null,
		source: "unknown",
		worldWritable: false,
		groupWritable: false,
		worldReadable: false,
		groupReadable: false,
		error: st.error
	};
	let effectiveMode = st.mode;
	let effectiveIsDir = st.isDir;
	if (st.isSymlink) try {
		const target = await fs.stat(targetPath);
		effectiveMode = typeof target.mode === "number" ? target.mode : st.mode;
		effectiveIsDir = target.isDirectory();
	} catch {}
	const bits = modeBits(effectiveMode);
	if ((opts?.platform ?? process.platform) === "win32") {
		const acl = await inspectWindowsAcl(targetPath, {
			env: opts?.env,
			exec: opts?.exec
		});
		if (!acl.ok) return {
			ok: true,
			isSymlink: st.isSymlink,
			isDir: effectiveIsDir,
			mode: effectiveMode,
			bits,
			source: "unknown",
			worldWritable: false,
			groupWritable: false,
			worldReadable: false,
			groupReadable: false,
			error: acl.error
		};
		return {
			ok: true,
			isSymlink: st.isSymlink,
			isDir: effectiveIsDir,
			mode: effectiveMode,
			bits,
			source: "windows-acl",
			worldWritable: acl.untrustedWorld.some((entry) => entry.canWrite),
			groupWritable: acl.untrustedGroup.some((entry) => entry.canWrite),
			worldReadable: acl.untrustedWorld.some((entry) => entry.canRead),
			groupReadable: acl.untrustedGroup.some((entry) => entry.canRead),
			aclSummary: formatWindowsAclSummary(acl)
		};
	}
	return {
		ok: true,
		isSymlink: st.isSymlink,
		isDir: effectiveIsDir,
		mode: effectiveMode,
		bits,
		source: "posix",
		worldWritable: isWorldWritable(bits),
		groupWritable: isGroupWritable(bits),
		worldReadable: isWorldReadable(bits),
		groupReadable: isGroupReadable(bits)
	};
}
function modeBits(mode) {
	if (mode == null) return null;
	return mode & 511;
}
function isWorldWritable(bits) {
	if (bits == null) return false;
	return (bits & 2) !== 0;
}
function isGroupWritable(bits) {
	if (bits == null) return false;
	return (bits & 16) !== 0;
}
function isWorldReadable(bits) {
	if (bits == null) return false;
	return (bits & 4) !== 0;
}
function isGroupReadable(bits) {
	if (bits == null) return false;
	return (bits & 32) !== 0;
}

//#endregion
//#region src/secrets/json-pointer.ts
function failOrUndefined(params) {
	if (params.onMissing === "throw") throw new Error(params.message);
}
function decodeJsonPointerToken(token) {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
}
function readJsonPointer(root, pointer, options = {}) {
	const onMissing = options.onMissing ?? "throw";
	if (!pointer.startsWith("/")) return failOrUndefined({
		onMissing,
		message: "File-backed secret ids must be absolute JSON pointers (for example: \"/providers/openai/apiKey\")."
	});
	const tokens = pointer.slice(1).split("/").map((token) => decodeJsonPointerToken(token));
	let current = root;
	for (const token of tokens) {
		if (Array.isArray(current)) {
			const index = Number.parseInt(token, 10);
			if (!Number.isFinite(index) || index < 0 || index >= current.length) return failOrUndefined({
				onMissing,
				message: `JSON pointer segment "${token}" is out of bounds.`
			});
			current = current[index];
			continue;
		}
		if (typeof current !== "object" || current === null || Array.isArray(current)) return failOrUndefined({
			onMissing,
			message: `JSON pointer segment "${token}" does not exist.`
		});
		const record = current;
		if (!Object.hasOwn(record, token)) return failOrUndefined({
			onMissing,
			message: `JSON pointer segment "${token}" does not exist.`
		});
		current = record[token];
	}
	return current;
}

//#endregion
//#region src/secrets/shared.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function normalizePositiveInt(value, fallback) {
	if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.floor(value));
	return Math.max(1, Math.floor(fallback));
}

//#endregion
//#region src/secrets/resolve.ts
const DEFAULT_PROVIDER_CONCURRENCY = 4;
const DEFAULT_MAX_REFS_PER_PROVIDER = 512;
const DEFAULT_MAX_BATCH_BYTES = 256 * 1024;
const DEFAULT_FILE_MAX_BYTES = 1024 * 1024;
const DEFAULT_FILE_TIMEOUT_MS = 5e3;
const DEFAULT_EXEC_TIMEOUT_MS = 5e3;
const DEFAULT_EXEC_NO_OUTPUT_TIMEOUT_MS = 2e3;
const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 1024 * 1024;
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;
function isAbsolutePathname(value) {
	return path.isAbsolute(value) || WINDOWS_ABS_PATH_PATTERN.test(value) || WINDOWS_UNC_PATH_PATTERN.test(value);
}
function resolveResolutionLimits(config) {
	const resolution = config.secrets?.resolution;
	return {
		maxProviderConcurrency: normalizePositiveInt(resolution?.maxProviderConcurrency, DEFAULT_PROVIDER_CONCURRENCY),
		maxRefsPerProvider: normalizePositiveInt(resolution?.maxRefsPerProvider, DEFAULT_MAX_REFS_PER_PROVIDER),
		maxBatchBytes: normalizePositiveInt(resolution?.maxBatchBytes, DEFAULT_MAX_BATCH_BYTES)
	};
}
function toProviderKey(source, provider) {
	return `${source}:${provider}`;
}
function resolveConfiguredProvider(ref, config) {
	const providerConfig = config.secrets?.providers?.[ref.provider];
	if (!providerConfig) {
		if (ref.source === "env" && ref.provider === resolveDefaultSecretProviderAlias(config, "env")) return { source: "env" };
		throw new Error(`Secret provider "${ref.provider}" is not configured (ref: ${ref.source}:${ref.provider}:${ref.id}).`);
	}
	if (providerConfig.source !== ref.source) throw new Error(`Secret provider "${ref.provider}" has source "${providerConfig.source}" but ref requests "${ref.source}".`);
	return providerConfig;
}
async function assertSecurePath(params) {
	if (!isAbsolutePathname(params.targetPath)) throw new Error(`${params.label} must be an absolute path.`);
	let effectivePath = params.targetPath;
	let stat = await safeStat(effectivePath);
	if (!stat.ok) throw new Error(`${params.label} is not readable: ${effectivePath}`);
	if (stat.isDir) throw new Error(`${params.label} must be a file: ${effectivePath}`);
	if (stat.isSymlink) {
		if (!params.allowSymlinkPath) throw new Error(`${params.label} must not be a symlink: ${effectivePath}`);
		try {
			effectivePath = await fs.realpath(effectivePath);
		} catch {
			throw new Error(`${params.label} symlink target is not readable: ${params.targetPath}`);
		}
		if (!isAbsolutePathname(effectivePath)) throw new Error(`${params.label} resolved symlink target must be an absolute path.`);
		stat = await safeStat(effectivePath);
		if (!stat.ok) throw new Error(`${params.label} is not readable: ${effectivePath}`);
		if (stat.isDir) throw new Error(`${params.label} must be a file: ${effectivePath}`);
		if (stat.isSymlink) throw new Error(`${params.label} symlink target must not be a symlink: ${effectivePath}`);
	}
	if (params.trustedDirs && params.trustedDirs.length > 0) {
		if (!params.trustedDirs.map((entry) => resolveUserPath(entry)).some((dir) => isPathInside$1(dir, effectivePath))) throw new Error(`${params.label} is outside trustedDirs: ${effectivePath}`);
	}
	if (params.allowInsecurePath) return effectivePath;
	const perms = await inspectPathPermissions(effectivePath);
	if (!perms.ok) throw new Error(`${params.label} permissions could not be verified: ${effectivePath}`);
	const writableByOthers = perms.worldWritable || perms.groupWritable;
	const readableByOthers = perms.worldReadable || perms.groupReadable;
	if (writableByOthers || !params.allowReadableByOthers && readableByOthers) throw new Error(`${params.label} permissions are too open: ${effectivePath}`);
	if (process.platform === "win32" && perms.source === "unknown") throw new Error(`${params.label} ACL verification unavailable on Windows for ${effectivePath}.`);
	if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid != null) {
		const uid = process.getuid();
		if (stat.uid !== uid) throw new Error(`${params.label} must be owned by the current user (uid=${uid}): ${effectivePath}`);
	}
	return effectivePath;
}
async function readFileProviderPayload(params) {
	const cacheKey = params.providerName;
	const cache = params.cache;
	if (cache?.filePayloadByProvider?.has(cacheKey)) return await cache.filePayloadByProvider.get(cacheKey);
	const filePath = resolveUserPath(params.providerConfig.path);
	const readPromise = (async () => {
		const secureFilePath = await assertSecurePath({
			targetPath: filePath,
			label: `secrets.providers.${params.providerName}.path`
		});
		const timeoutMs = normalizePositiveInt(params.providerConfig.timeoutMs, DEFAULT_FILE_TIMEOUT_MS);
		const maxBytes = normalizePositiveInt(params.providerConfig.maxBytes, DEFAULT_FILE_MAX_BYTES);
		const abortController = new AbortController();
		const timeoutErrorMessage = `File provider "${params.providerName}" timed out after ${timeoutMs}ms.`;
		let timeoutHandle = null;
		const timeoutPromise = new Promise((_resolve, reject) => {
			timeoutHandle = setTimeout(() => {
				abortController.abort();
				reject(new Error(timeoutErrorMessage));
			}, timeoutMs);
		});
		try {
			const payload = await Promise.race([fs.readFile(secureFilePath, { signal: abortController.signal }), timeoutPromise]);
			if (payload.byteLength > maxBytes) throw new Error(`File provider "${params.providerName}" exceeded maxBytes (${maxBytes}).`);
			const text = payload.toString("utf8");
			if (params.providerConfig.mode === "singleValue") return text.replace(/\r?\n$/, "");
			const parsed = JSON.parse(text);
			if (!isRecord(parsed)) throw new Error(`File provider "${params.providerName}" payload is not a JSON object.`);
			return parsed;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw new Error(timeoutErrorMessage, { cause: error });
			throw error;
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
		}
	})();
	if (cache) {
		cache.filePayloadByProvider ??= /* @__PURE__ */ new Map();
		cache.filePayloadByProvider.set(cacheKey, readPromise);
	}
	return await readPromise;
}
async function resolveEnvRefs(params) {
	const resolved = /* @__PURE__ */ new Map();
	const allowlist = params.providerConfig.allowlist ? new Set(params.providerConfig.allowlist) : null;
	for (const ref of params.refs) {
		if (allowlist && !allowlist.has(ref.id)) throw new Error(`Environment variable "${ref.id}" is not allowlisted in secrets.providers.${params.providerName}.allowlist.`);
		const envValue = params.env[ref.id] ?? process.env[ref.id];
		if (!isNonEmptyString(envValue)) throw new Error(`Environment variable "${ref.id}" is missing or empty.`);
		resolved.set(ref.id, envValue);
	}
	return resolved;
}
async function resolveFileRefs(params) {
	const payload = await readFileProviderPayload({
		providerName: params.providerName,
		providerConfig: params.providerConfig,
		cache: params.cache
	});
	const mode = params.providerConfig.mode ?? "json";
	const resolved = /* @__PURE__ */ new Map();
	if (mode === "singleValue") {
		for (const ref of params.refs) {
			if (ref.id !== SINGLE_VALUE_FILE_REF_ID) throw new Error(`singleValue file provider "${params.providerName}" expects ref id "${SINGLE_VALUE_FILE_REF_ID}".`);
			resolved.set(ref.id, payload);
		}
		return resolved;
	}
	for (const ref of params.refs) resolved.set(ref.id, readJsonPointer(payload, ref.id, { onMissing: "throw" }));
	return resolved;
}
async function runExecResolver(params) {
	return await new Promise((resolve, reject) => {
		const child = spawn(params.command, params.args, {
			cwd: params.cwd,
			env: params.env,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			shell: false,
			windowsHide: true
		});
		let settled = false;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let noOutputTimedOut = false;
		let outputBytes = 0;
		let noOutputTimer = null;
		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, params.timeoutMs);
		const clearTimers = () => {
			clearTimeout(timeoutTimer);
			if (noOutputTimer) {
				clearTimeout(noOutputTimer);
				noOutputTimer = null;
			}
		};
		const armNoOutputTimer = () => {
			if (noOutputTimer) clearTimeout(noOutputTimer);
			noOutputTimer = setTimeout(() => {
				noOutputTimedOut = true;
				child.kill("SIGKILL");
			}, params.noOutputTimeoutMs);
		};
		const append = (chunk, target) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			outputBytes += Buffer.byteLength(text, "utf8");
			if (outputBytes > params.maxOutputBytes) {
				child.kill("SIGKILL");
				if (!settled) {
					settled = true;
					clearTimers();
					reject(/* @__PURE__ */ new Error(`Exec provider output exceeded maxOutputBytes (${params.maxOutputBytes}).`));
				}
				return;
			}
			if (target === "stdout") stdout += text;
			else stderr += text;
			armNoOutputTimer();
		};
		armNoOutputTimer();
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimers();
			reject(error);
		});
		child.stdout?.on("data", (chunk) => append(chunk, "stdout"));
		child.stderr?.on("data", (chunk) => append(chunk, "stderr"));
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimers();
			resolve({
				stdout,
				stderr,
				code,
				signal,
				termination: noOutputTimedOut ? "no-output-timeout" : timedOut ? "timeout" : "exit"
			});
		});
		child.stdin?.end(params.input);
	});
}
function parseExecValues(params) {
	const trimmed = params.stdout.trim();
	if (!trimmed) throw new Error(`Exec provider "${params.providerName}" returned empty stdout.`);
	let parsed;
	if (!params.jsonOnly && params.ids.length === 1) try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { [params.ids[0]]: trimmed };
	}
	else try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new Error(`Exec provider "${params.providerName}" returned invalid JSON.`);
	}
	if (!isRecord(parsed)) {
		if (!params.jsonOnly && params.ids.length === 1 && typeof parsed === "string") return { [params.ids[0]]: parsed };
		throw new Error(`Exec provider "${params.providerName}" response must be an object.`);
	}
	if (parsed.protocolVersion !== 1) throw new Error(`Exec provider "${params.providerName}" protocolVersion must be 1.`);
	const responseValues = parsed.values;
	if (!isRecord(responseValues)) throw new Error(`Exec provider "${params.providerName}" response missing "values".`);
	const responseErrors = isRecord(parsed.errors) ? parsed.errors : null;
	const out = {};
	for (const id of params.ids) {
		if (responseErrors && id in responseErrors) {
			const entry = responseErrors[id];
			if (isRecord(entry) && typeof entry.message === "string" && entry.message.trim()) throw new Error(`Exec provider "${params.providerName}" failed for id "${id}" (${entry.message.trim()}).`);
			throw new Error(`Exec provider "${params.providerName}" failed for id "${id}".`);
		}
		if (!(id in responseValues)) throw new Error(`Exec provider "${params.providerName}" response missing id "${id}".`);
		out[id] = responseValues[id];
	}
	return out;
}
async function resolveExecRefs(params) {
	const ids = [...new Set(params.refs.map((ref) => ref.id))];
	if (ids.length > params.limits.maxRefsPerProvider) throw new Error(`Exec provider "${params.providerName}" exceeded maxRefsPerProvider (${params.limits.maxRefsPerProvider}).`);
	const secureCommandPath = await assertSecurePath({
		targetPath: resolveUserPath(params.providerConfig.command),
		label: `secrets.providers.${params.providerName}.command`,
		trustedDirs: params.providerConfig.trustedDirs,
		allowInsecurePath: params.providerConfig.allowInsecurePath,
		allowReadableByOthers: true,
		allowSymlinkPath: params.providerConfig.allowSymlinkCommand
	});
	const requestPayload = {
		protocolVersion: 1,
		provider: params.providerName,
		ids
	};
	const input = JSON.stringify(requestPayload);
	if (Buffer.byteLength(input, "utf8") > params.limits.maxBatchBytes) throw new Error(`Exec provider "${params.providerName}" request exceeded maxBatchBytes (${params.limits.maxBatchBytes}).`);
	const childEnv = {};
	for (const key of params.providerConfig.passEnv ?? []) {
		const value = params.env[key] ?? process.env[key];
		if (value !== void 0) childEnv[key] = value;
	}
	for (const [key, value] of Object.entries(params.providerConfig.env ?? {})) childEnv[key] = value;
	const timeoutMs = normalizePositiveInt(params.providerConfig.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS);
	const noOutputTimeoutMs = normalizePositiveInt(params.providerConfig.noOutputTimeoutMs, DEFAULT_EXEC_NO_OUTPUT_TIMEOUT_MS);
	const maxOutputBytes = normalizePositiveInt(params.providerConfig.maxOutputBytes, DEFAULT_EXEC_MAX_OUTPUT_BYTES);
	const jsonOnly = params.providerConfig.jsonOnly ?? true;
	const result = await runExecResolver({
		command: secureCommandPath,
		args: params.providerConfig.args ?? [],
		cwd: path.dirname(secureCommandPath),
		env: childEnv,
		input,
		timeoutMs,
		noOutputTimeoutMs,
		maxOutputBytes
	});
	if (result.termination === "timeout") throw new Error(`Exec provider "${params.providerName}" timed out after ${timeoutMs}ms.`);
	if (result.termination === "no-output-timeout") throw new Error(`Exec provider "${params.providerName}" produced no output for ${noOutputTimeoutMs}ms.`);
	if (result.code !== 0) throw new Error(`Exec provider "${params.providerName}" exited with code ${String(result.code)}.`);
	const values = parseExecValues({
		providerName: params.providerName,
		ids,
		stdout: result.stdout,
		jsonOnly
	});
	const resolved = /* @__PURE__ */ new Map();
	for (const id of ids) resolved.set(id, values[id]);
	return resolved;
}
async function resolveProviderRefs(params) {
	if (params.providerConfig.source === "env") return await resolveEnvRefs({
		refs: params.refs,
		providerName: params.providerName,
		providerConfig: params.providerConfig,
		env: params.options.env ?? process.env
	});
	if (params.providerConfig.source === "file") return await resolveFileRefs({
		refs: params.refs,
		providerName: params.providerName,
		providerConfig: params.providerConfig,
		cache: params.options.cache
	});
	if (params.providerConfig.source === "exec") return await resolveExecRefs({
		refs: params.refs,
		providerName: params.providerName,
		providerConfig: params.providerConfig,
		env: params.options.env ?? process.env,
		limits: params.limits
	});
	throw new Error(`Unsupported secret provider source "${String(params.providerConfig.source)}".`);
}
async function resolveSecretRefValues(refs, options) {
	if (refs.length === 0) return /* @__PURE__ */ new Map();
	const limits = resolveResolutionLimits(options.config);
	const uniqueRefs = /* @__PURE__ */ new Map();
	for (const ref of refs) {
		const id = ref.id.trim();
		if (!id) throw new Error("Secret reference id is empty.");
		uniqueRefs.set(secretRefKey(ref), {
			...ref,
			id
		});
	}
	const grouped = /* @__PURE__ */ new Map();
	for (const ref of uniqueRefs.values()) {
		const key = toProviderKey(ref.source, ref.provider);
		const existing = grouped.get(key);
		if (existing) {
			existing.refs.push(ref);
			continue;
		}
		grouped.set(key, {
			source: ref.source,
			providerName: ref.provider,
			refs: [ref]
		});
	}
	const taskResults = await runTasksWithConcurrency({
		tasks: [...grouped.values()].map((group) => async () => {
			if (group.refs.length > limits.maxRefsPerProvider) throw new Error(`Secret provider "${group.providerName}" exceeded maxRefsPerProvider (${limits.maxRefsPerProvider}).`);
			const providerConfig = resolveConfiguredProvider(group.refs[0], options.config);
			return {
				group,
				values: await resolveProviderRefs({
					refs: group.refs,
					source: group.source,
					providerName: group.providerName,
					providerConfig,
					options,
					limits
				})
			};
		}),
		limit: limits.maxProviderConcurrency,
		errorMode: "stop"
	});
	if (taskResults.hasError) throw taskResults.firstError;
	const resolved = /* @__PURE__ */ new Map();
	for (const result of taskResults.results) for (const ref of result.group.refs) {
		if (!result.values.has(ref.id)) throw new Error(`Secret provider "${result.group.providerName}" did not return id "${ref.id}".`);
		resolved.set(secretRefKey(ref), result.values.get(ref.id));
	}
	return resolved;
}
async function resolveSecretRefValue(ref, options) {
	const cache = options.cache;
	const key = secretRefKey(ref);
	if (cache?.resolvedByRefKey?.has(key)) return await cache.resolvedByRefKey.get(key);
	const promise = (async () => {
		const resolved = await resolveSecretRefValues([ref], options);
		if (!resolved.has(key)) throw new Error(`Secret reference "${key}" resolved to no value.`);
		return resolved.get(key);
	})();
	if (cache) {
		cache.resolvedByRefKey ??= /* @__PURE__ */ new Map();
		cache.resolvedByRefKey.set(key, promise);
	}
	return await promise;
}
async function resolveSecretRefString(ref, options) {
	const resolved = await resolveSecretRefValue(ref, options);
	if (!isNonEmptyString(resolved)) throw new Error(`Secret reference "${ref.source}:${ref.provider}:${ref.id}" resolved to a non-string or empty value.`);
	return resolved;
}

//#endregion
//#region src/agents/chutes-oauth.ts
const CHUTES_OAUTH_ISSUER = "https://api.chutes.ai";
const CHUTES_AUTHORIZE_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/authorize`;
const CHUTES_TOKEN_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/token`;
const CHUTES_USERINFO_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/userinfo`;
const DEFAULT_EXPIRES_BUFFER_MS = 300 * 1e3;
function coerceExpiresAt(expiresInSeconds, now) {
	const value = now + Math.max(0, Math.floor(expiresInSeconds)) * 1e3 - DEFAULT_EXPIRES_BUFFER_MS;
	return Math.max(value, now + 3e4);
}
async function refreshChutesTokens(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const now = params.now ?? Date.now();
	const refreshToken = params.credential.refresh?.trim();
	if (!refreshToken) throw new Error("Chutes OAuth credential is missing refresh token");
	const clientId = params.credential.clientId?.trim() ?? process.env.CHUTES_CLIENT_ID?.trim();
	if (!clientId) throw new Error("Missing CHUTES_CLIENT_ID for Chutes OAuth refresh (set env var or re-auth).");
	const clientSecret = process.env.CHUTES_CLIENT_SECRET?.trim() || void 0;
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: clientId,
		refresh_token: refreshToken
	});
	if (clientSecret) body.set("client_secret", clientSecret);
	const response = await fetchFn(CHUTES_TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Chutes token refresh failed: ${text}`);
	}
	const data = await response.json();
	const access = data.access_token?.trim();
	const newRefresh = data.refresh_token?.trim();
	const expiresIn = data.expires_in ?? 0;
	if (!access) throw new Error("Chutes token refresh returned no access_token");
	return {
		...params.credential,
		access,
		refresh: newRefresh || refreshToken,
		expires: coerceExpiresAt(expiresIn, now),
		clientId
	};
}

//#endregion
//#region src/agents/auth-profiles/oauth.ts
const OAUTH_PROVIDER_IDS = new Set(getOAuthProviders().map((provider) => provider.id));
const isOAuthProvider = (provider) => OAUTH_PROVIDER_IDS.has(provider);
const resolveOAuthProvider = (provider) => isOAuthProvider(provider) ? provider : null;
/** Bearer-token auth modes that are interchangeable (oauth tokens and raw tokens). */
const BEARER_AUTH_MODES = new Set(["oauth", "token"]);
const isCompatibleModeType = (mode, type) => {
	if (!mode || !type) return false;
	if (mode === type) return true;
	return BEARER_AUTH_MODES.has(mode) && BEARER_AUTH_MODES.has(type);
};
function isProfileConfigCompatible(params) {
	const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
	if (profileConfig && profileConfig.provider !== params.provider) return false;
	if (profileConfig && !isCompatibleModeType(profileConfig.mode, params.mode)) return false;
	return true;
}
function buildOAuthApiKey(provider, credentials) {
	return provider === "google-gemini-cli" ? JSON.stringify({
		token: credentials.access,
		projectId: credentials.projectId
	}) : credentials.access;
}
function buildApiKeyProfileResult(params) {
	return {
		apiKey: params.apiKey,
		provider: params.provider,
		email: params.email
	};
}
function buildOAuthProfileResult(params) {
	return buildApiKeyProfileResult({
		apiKey: buildOAuthApiKey(params.provider, params.credentials),
		provider: params.provider,
		email: params.email
	});
}
function isExpiredCredential(expires) {
	return typeof expires === "number" && Number.isFinite(expires) && expires > 0 && Date.now() >= expires;
}
function adoptNewerMainOAuthCredential(params) {
	if (!params.agentDir) return null;
	try {
		const mainCred = ensureAuthProfileStore(void 0).profiles[params.profileId];
		if (mainCred?.type === "oauth" && mainCred.provider === params.cred.provider && Number.isFinite(mainCred.expires) && (!Number.isFinite(params.cred.expires) || mainCred.expires > params.cred.expires)) {
			params.store.profiles[params.profileId] = { ...mainCred };
			saveAuthProfileStore(params.store, params.agentDir);
			log$7.info("adopted newer OAuth credentials from main agent", {
				profileId: params.profileId,
				agentDir: params.agentDir,
				expires: new Date(mainCred.expires).toISOString()
			});
			return mainCred;
		}
	} catch (err) {
		log$7.debug("adoptNewerMainOAuthCredential failed", {
			profileId: params.profileId,
			error: err instanceof Error ? err.message : String(err)
		});
	}
	return null;
}
async function refreshOAuthTokenWithLock(params) {
	const authPath = resolveAuthStorePath(params.agentDir);
	ensureAuthStoreFile(authPath);
	return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
		const store = ensureAuthProfileStore(params.agentDir);
		const cred = store.profiles[params.profileId];
		if (!cred || cred.type !== "oauth") return null;
		if (Date.now() < cred.expires) return {
			apiKey: buildOAuthApiKey(cred.provider, cred),
			newCredentials: cred
		};
		const oauthCreds = { [cred.provider]: cred };
		const result = String(cred.provider) === "chutes" ? await (async () => {
			const newCredentials = await refreshChutesTokens({ credential: cred });
			return {
				apiKey: newCredentials.access,
				newCredentials
			};
		})() : String(cred.provider) === "qwen-portal" ? await (async () => {
			const newCredentials = await refreshQwenPortalCredentials(cred);
			return {
				apiKey: newCredentials.access,
				newCredentials
			};
		})() : await (async () => {
			const oauthProvider = resolveOAuthProvider(cred.provider);
			if (!oauthProvider) return null;
			return await getOAuthApiKey(oauthProvider, oauthCreds);
		})();
		if (!result) return null;
		store.profiles[params.profileId] = {
			...cred,
			...result.newCredentials,
			type: "oauth"
		};
		saveAuthProfileStore(store, params.agentDir);
		return result;
	});
}
async function tryResolveOAuthProfile(params) {
	const { cfg, store, profileId } = params;
	const cred = store.profiles[profileId];
	if (!cred || cred.type !== "oauth") return null;
	if (!isProfileConfigCompatible({
		cfg,
		profileId,
		provider: cred.provider,
		mode: cred.type
	})) return null;
	if (Date.now() < cred.expires) return buildOAuthProfileResult({
		provider: cred.provider,
		credentials: cred,
		email: cred.email
	});
	const refreshed = await refreshOAuthTokenWithLock({
		profileId,
		agentDir: params.agentDir
	});
	if (!refreshed) return null;
	return buildApiKeyProfileResult({
		apiKey: refreshed.apiKey,
		provider: cred.provider,
		email: cred.email
	});
}
async function resolveProfileSecretString(params) {
	let resolvedValue = params.value?.trim();
	if (resolvedValue) {
		const inlineRef = coerceSecretRef(resolvedValue, params.refDefaults);
		if (inlineRef) try {
			resolvedValue = await resolveSecretRefString(inlineRef, {
				config: params.configForRefResolution,
				env: process.env,
				cache: params.cache
			});
		} catch (err) {
			log$7.debug(params.inlineFailureMessage, {
				profileId: params.profileId,
				provider: params.provider,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}
	const explicitRef = coerceSecretRef(params.valueRef, params.refDefaults);
	if (!resolvedValue && explicitRef) try {
		resolvedValue = await resolveSecretRefString(explicitRef, {
			config: params.configForRefResolution,
			env: process.env,
			cache: params.cache
		});
	} catch (err) {
		log$7.debug(params.refFailureMessage, {
			profileId: params.profileId,
			provider: params.provider,
			error: err instanceof Error ? err.message : String(err)
		});
	}
	return resolvedValue;
}
async function resolveApiKeyForProfile(params) {
	const { cfg, store, profileId } = params;
	const cred = store.profiles[profileId];
	if (!cred) return null;
	if (!isProfileConfigCompatible({
		cfg,
		profileId,
		provider: cred.provider,
		mode: cred.type,
		allowOAuthTokenCompatibility: true
	})) return null;
	const refResolveCache = {};
	const configForRefResolution = cfg ?? loadConfig();
	const refDefaults = configForRefResolution.secrets?.defaults;
	if (cred.type === "api_key") {
		const key = await resolveProfileSecretString({
			profileId,
			provider: cred.provider,
			value: cred.key,
			valueRef: cred.keyRef,
			refDefaults,
			configForRefResolution,
			cache: refResolveCache,
			inlineFailureMessage: "failed to resolve inline auth profile api_key ref",
			refFailureMessage: "failed to resolve auth profile api_key ref"
		});
		if (!key) return null;
		return buildApiKeyProfileResult({
			apiKey: key,
			provider: cred.provider,
			email: cred.email
		});
	}
	if (cred.type === "token") {
		const token = await resolveProfileSecretString({
			profileId,
			provider: cred.provider,
			value: cred.token,
			valueRef: cred.tokenRef,
			refDefaults,
			configForRefResolution,
			cache: refResolveCache,
			inlineFailureMessage: "failed to resolve inline auth profile token ref",
			refFailureMessage: "failed to resolve auth profile token ref"
		});
		if (!token) return null;
		if (isExpiredCredential(cred.expires)) return null;
		return buildApiKeyProfileResult({
			apiKey: token,
			provider: cred.provider,
			email: cred.email
		});
	}
	const oauthCred = adoptNewerMainOAuthCredential({
		store,
		profileId,
		agentDir: params.agentDir,
		cred
	}) ?? cred;
	if (Date.now() < oauthCred.expires) return buildOAuthProfileResult({
		provider: oauthCred.provider,
		credentials: oauthCred,
		email: oauthCred.email
	});
	try {
		const result = await refreshOAuthTokenWithLock({
			profileId,
			agentDir: params.agentDir
		});
		if (!result) return null;
		return buildApiKeyProfileResult({
			apiKey: result.apiKey,
			provider: cred.provider,
			email: cred.email
		});
	} catch (error) {
		const refreshedStore = ensureAuthProfileStore(params.agentDir);
		const refreshed = refreshedStore.profiles[profileId];
		if (refreshed?.type === "oauth" && Date.now() < refreshed.expires) return buildOAuthProfileResult({
			provider: refreshed.provider,
			credentials: refreshed,
			email: refreshed.email ?? cred.email
		});
		const fallbackProfileId = suggestOAuthProfileIdForLegacyDefault({
			cfg,
			store: refreshedStore,
			provider: cred.provider,
			legacyProfileId: profileId
		});
		if (fallbackProfileId && fallbackProfileId !== profileId) try {
			const fallbackResolved = await tryResolveOAuthProfile({
				cfg,
				store: refreshedStore,
				profileId: fallbackProfileId,
				agentDir: params.agentDir
			});
			if (fallbackResolved) return fallbackResolved;
		} catch {}
		if (params.agentDir) try {
			const mainCred = ensureAuthProfileStore(void 0).profiles[profileId];
			if (mainCred?.type === "oauth" && Date.now() < mainCred.expires) {
				refreshedStore.profiles[profileId] = { ...mainCred };
				saveAuthProfileStore(refreshedStore, params.agentDir);
				log$7.info("inherited fresh OAuth credentials from main agent", {
					profileId,
					agentDir: params.agentDir,
					expires: new Date(mainCred.expires).toISOString()
				});
				return buildOAuthProfileResult({
					provider: mainCred.provider,
					credentials: mainCred,
					email: mainCred.email
				});
			}
		} catch {}
		const message = error instanceof Error ? error.message : String(error);
		const hint = formatAuthDoctorHint({
			cfg,
			store: refreshedStore,
			provider: cred.provider,
			profileId
		});
		throw new Error(`OAuth token refresh failed for ${cred.provider}: ${message}. Please try again or re-authenticate.` + (hint ? `\n\n${hint}` : ""), { cause: error });
	}
}

//#endregion
//#region src/agents/auth-profiles/usage.ts
const FAILURE_REASON_PRIORITY = [
	"auth_permanent",
	"auth",
	"billing",
	"format",
	"model_not_found",
	"timeout",
	"rate_limit",
	"unknown"
];
const FAILURE_REASON_SET = new Set(FAILURE_REASON_PRIORITY);
const FAILURE_REASON_ORDER = new Map(FAILURE_REASON_PRIORITY.map((reason, index) => [reason, index]));
function isAuthCooldownBypassedForProvider(provider) {
	return normalizeProviderId(provider ?? "") === "openrouter";
}
function resolveProfileUnusableUntil(stats) {
	const values = [stats.cooldownUntil, stats.disabledUntil].filter((value) => typeof value === "number").filter((value) => Number.isFinite(value) && value > 0);
	if (values.length === 0) return null;
	return Math.max(...values);
}
/**
* Check if a profile is currently in cooldown (due to rate limiting or errors).
*/
function isProfileInCooldown(store, profileId) {
	if (isAuthCooldownBypassedForProvider(store.profiles[profileId]?.provider)) return false;
	const stats = store.usageStats?.[profileId];
	if (!stats) return false;
	const unusableUntil = resolveProfileUnusableUntil(stats);
	return unusableUntil ? Date.now() < unusableUntil : false;
}
function isActiveUnusableWindow(until, now) {
	return typeof until === "number" && Number.isFinite(until) && until > 0 && now < until;
}
/**
* Infer the most likely reason all candidate profiles are currently unavailable.
*
* We prefer explicit active `disabledReason` values (for example billing/auth)
* over generic cooldown buckets, then fall back to failure-count signals.
*/
function resolveProfilesUnavailableReason(params) {
	const now = params.now ?? Date.now();
	const scores = /* @__PURE__ */ new Map();
	const addScore = (reason, value) => {
		if (!FAILURE_REASON_SET.has(reason) || value <= 0 || !Number.isFinite(value)) return;
		scores.set(reason, (scores.get(reason) ?? 0) + value);
	};
	for (const profileId of params.profileIds) {
		const stats = params.store.usageStats?.[profileId];
		if (!stats) continue;
		if (isActiveUnusableWindow(stats.disabledUntil, now) && stats.disabledReason && FAILURE_REASON_SET.has(stats.disabledReason)) {
			addScore(stats.disabledReason, 1e3);
			continue;
		}
		if (!isActiveUnusableWindow(stats.cooldownUntil, now)) continue;
		let recordedReason = false;
		for (const [rawReason, rawCount] of Object.entries(stats.failureCounts ?? {})) {
			const reason = rawReason;
			const count = typeof rawCount === "number" ? rawCount : 0;
			if (!FAILURE_REASON_SET.has(reason) || count <= 0) continue;
			addScore(reason, count);
			recordedReason = true;
		}
		if (!recordedReason) addScore("rate_limit", 1);
	}
	if (scores.size === 0) return null;
	let best = null;
	let bestScore = -1;
	let bestPriority = Number.MAX_SAFE_INTEGER;
	for (const reason of FAILURE_REASON_PRIORITY) {
		const score = scores.get(reason);
		if (typeof score !== "number") continue;
		const priority = FAILURE_REASON_ORDER.get(reason) ?? Number.MAX_SAFE_INTEGER;
		if (score > bestScore || score === bestScore && priority < bestPriority) {
			best = reason;
			bestScore = score;
			bestPriority = priority;
		}
	}
	return best;
}
/**
* Return the soonest `unusableUntil` timestamp (ms epoch) among the given
* profiles, or `null` when no profile has a recorded cooldown. Note: the
* returned timestamp may be in the past if the cooldown has already expired.
*/
function getSoonestCooldownExpiry(store, profileIds) {
	let soonest = null;
	for (const id of profileIds) {
		const stats = store.usageStats?.[id];
		if (!stats) continue;
		const until = resolveProfileUnusableUntil(stats);
		if (typeof until !== "number" || !Number.isFinite(until) || until <= 0) continue;
		if (soonest === null || until < soonest) soonest = until;
	}
	return soonest;
}
/**
* Clear expired cooldowns from all profiles in the store.
*
* When `cooldownUntil` or `disabledUntil` has passed, the corresponding fields
* are removed and error counters are reset so the profile gets a fresh start
* (circuit-breaker half-open → closed). Without this, a stale `errorCount`
* causes the *next* transient failure to immediately escalate to a much longer
* cooldown — the root cause of profiles appearing "stuck" after rate limits.
*
* `cooldownUntil` and `disabledUntil` are handled independently: if a profile
* has both and only one has expired, only that field is cleared.
*
* Mutates the in-memory store; disk persistence happens lazily on the next
* store write (e.g. `markAuthProfileUsed` / `markAuthProfileFailure`), which
* matches the existing save pattern throughout the auth-profiles module.
*
* @returns `true` if any profile was modified.
*/
function clearExpiredCooldowns(store, now) {
	const usageStats = store.usageStats;
	if (!usageStats) return false;
	const ts = now ?? Date.now();
	let mutated = false;
	for (const [profileId, stats] of Object.entries(usageStats)) {
		if (!stats) continue;
		let profileMutated = false;
		const cooldownExpired = typeof stats.cooldownUntil === "number" && Number.isFinite(stats.cooldownUntil) && stats.cooldownUntil > 0 && ts >= stats.cooldownUntil;
		const disabledExpired = typeof stats.disabledUntil === "number" && Number.isFinite(stats.disabledUntil) && stats.disabledUntil > 0 && ts >= stats.disabledUntil;
		if (cooldownExpired) {
			stats.cooldownUntil = void 0;
			profileMutated = true;
		}
		if (disabledExpired) {
			stats.disabledUntil = void 0;
			stats.disabledReason = void 0;
			profileMutated = true;
		}
		if (profileMutated && !resolveProfileUnusableUntil(stats)) {
			stats.errorCount = 0;
			stats.failureCounts = void 0;
		}
		if (profileMutated) {
			usageStats[profileId] = stats;
			mutated = true;
		}
	}
	return mutated;
}
/**
* Mark a profile as successfully used. Resets error count and updates lastUsed.
* Uses store lock to avoid overwriting concurrent usage updates.
*/
async function markAuthProfileUsed(params) {
	const { store, profileId, agentDir } = params;
	const updated = await updateAuthProfileStoreWithLock({
		agentDir,
		updater: (freshStore) => {
			if (!freshStore.profiles[profileId]) return false;
			freshStore.usageStats = freshStore.usageStats ?? {};
			freshStore.usageStats[profileId] = {
				...freshStore.usageStats[profileId],
				lastUsed: Date.now(),
				errorCount: 0,
				cooldownUntil: void 0,
				disabledUntil: void 0,
				disabledReason: void 0,
				failureCounts: void 0
			};
			return true;
		}
	});
	if (updated) {
		store.usageStats = updated.usageStats;
		return;
	}
	if (!store.profiles[profileId]) return;
	store.usageStats = store.usageStats ?? {};
	store.usageStats[profileId] = {
		...store.usageStats[profileId],
		lastUsed: Date.now(),
		errorCount: 0,
		cooldownUntil: void 0,
		disabledUntil: void 0,
		disabledReason: void 0,
		failureCounts: void 0
	};
	saveAuthProfileStore(store, agentDir);
}
function calculateAuthProfileCooldownMs(errorCount) {
	const normalized = Math.max(1, errorCount);
	return Math.min(3600 * 1e3, 60 * 1e3 * 5 ** Math.min(normalized - 1, 3));
}
function resolveAuthCooldownConfig(params) {
	const defaults = {
		billingBackoffHours: 5,
		billingMaxHours: 24,
		failureWindowHours: 24
	};
	const resolveHours = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
	const cooldowns = params.cfg?.auth?.cooldowns;
	const billingBackoffHours = resolveHours((() => {
		const map = cooldowns?.billingBackoffHoursByProvider;
		if (!map) return;
		for (const [key, value] of Object.entries(map)) if (normalizeProviderId(key) === params.providerId) return value;
	})() ?? cooldowns?.billingBackoffHours, defaults.billingBackoffHours);
	const billingMaxHours = resolveHours(cooldowns?.billingMaxHours, defaults.billingMaxHours);
	const failureWindowHours = resolveHours(cooldowns?.failureWindowHours, defaults.failureWindowHours);
	return {
		billingBackoffMs: billingBackoffHours * 60 * 60 * 1e3,
		billingMaxMs: billingMaxHours * 60 * 60 * 1e3,
		failureWindowMs: failureWindowHours * 60 * 60 * 1e3
	};
}
function calculateAuthProfileBillingDisableMsWithConfig(params) {
	const normalized = Math.max(1, params.errorCount);
	const baseMs = Math.max(6e4, params.baseMs);
	const maxMs = Math.max(baseMs, params.maxMs);
	const raw = baseMs * 2 ** Math.min(normalized - 1, 10);
	return Math.min(maxMs, raw);
}
function keepActiveWindowOrRecompute(params) {
	const { existingUntil, now, recomputedUntil } = params;
	return typeof existingUntil === "number" && Number.isFinite(existingUntil) && existingUntil > now ? existingUntil : recomputedUntil;
}
function computeNextProfileUsageStats(params) {
	const windowMs = params.cfgResolved.failureWindowMs;
	const windowExpired = typeof params.existing.lastFailureAt === "number" && params.existing.lastFailureAt > 0 && params.now - params.existing.lastFailureAt > windowMs;
	const nextErrorCount = (windowExpired ? 0 : params.existing.errorCount ?? 0) + 1;
	const failureCounts = windowExpired ? {} : { ...params.existing.failureCounts };
	failureCounts[params.reason] = (failureCounts[params.reason] ?? 0) + 1;
	const updatedStats = {
		...params.existing,
		errorCount: nextErrorCount,
		failureCounts,
		lastFailureAt: params.now
	};
	if (params.reason === "billing" || params.reason === "auth_permanent") {
		const backoffMs = calculateAuthProfileBillingDisableMsWithConfig({
			errorCount: failureCounts[params.reason] ?? 1,
			baseMs: params.cfgResolved.billingBackoffMs,
			maxMs: params.cfgResolved.billingMaxMs
		});
		updatedStats.disabledUntil = keepActiveWindowOrRecompute({
			existingUntil: params.existing.disabledUntil,
			now: params.now,
			recomputedUntil: params.now + backoffMs
		});
		updatedStats.disabledReason = params.reason;
	} else {
		const backoffMs = calculateAuthProfileCooldownMs(nextErrorCount);
		updatedStats.cooldownUntil = keepActiveWindowOrRecompute({
			existingUntil: params.existing.cooldownUntil,
			now: params.now,
			recomputedUntil: params.now + backoffMs
		});
	}
	return updatedStats;
}
/**
* Mark a profile as failed for a specific reason. Billing and permanent-auth
* failures are treated as "disabled" (longer backoff) vs the regular cooldown
* window.
*/
async function markAuthProfileFailure(params) {
	const { store, profileId, reason, agentDir, cfg } = params;
	const profile = store.profiles[profileId];
	if (!profile || isAuthCooldownBypassedForProvider(profile.provider)) return;
	const updated = await updateAuthProfileStoreWithLock({
		agentDir,
		updater: (freshStore) => {
			const profile = freshStore.profiles[profileId];
			if (!profile || isAuthCooldownBypassedForProvider(profile.provider)) return false;
			freshStore.usageStats = freshStore.usageStats ?? {};
			const existing = freshStore.usageStats[profileId] ?? {};
			const now = Date.now();
			const cfgResolved = resolveAuthCooldownConfig({
				cfg,
				providerId: normalizeProviderId(profile.provider)
			});
			freshStore.usageStats[profileId] = computeNextProfileUsageStats({
				existing,
				now,
				reason,
				cfgResolved
			});
			return true;
		}
	});
	if (updated) {
		store.usageStats = updated.usageStats;
		return;
	}
	if (!store.profiles[profileId]) return;
	store.usageStats = store.usageStats ?? {};
	const existing = store.usageStats[profileId] ?? {};
	const now = Date.now();
	const cfgResolved = resolveAuthCooldownConfig({
		cfg,
		providerId: normalizeProviderId(store.profiles[profileId]?.provider ?? "")
	});
	store.usageStats[profileId] = computeNextProfileUsageStats({
		existing,
		now,
		reason,
		cfgResolved
	});
	saveAuthProfileStore(store, agentDir);
}

//#endregion
//#region src/agents/auth-profiles/order.ts
function resolveAuthProfileOrder(params) {
	const { cfg, store, provider, preferredProfile } = params;
	const providerKey = normalizeProviderId(provider);
	const now = Date.now();
	clearExpiredCooldowns(store, now);
	const storedOrder = findNormalizedProviderValue(store.order, providerKey);
	const configuredOrder = findNormalizedProviderValue(cfg?.auth?.order, providerKey);
	const explicitOrder = storedOrder ?? configuredOrder;
	const explicitProfiles = cfg?.auth?.profiles ? Object.entries(cfg.auth.profiles).filter(([, profile]) => normalizeProviderId(profile.provider) === providerKey).map(([profileId]) => profileId) : [];
	const baseOrder = explicitOrder ?? (explicitProfiles.length > 0 ? explicitProfiles : listProfilesForProvider(store, providerKey));
	if (baseOrder.length === 0) return [];
	const isValidProfile = (profileId) => {
		const cred = store.profiles[profileId];
		if (!cred) return false;
		if (normalizeProviderId(cred.provider) !== providerKey) return false;
		const profileConfig = cfg?.auth?.profiles?.[profileId];
		if (profileConfig) {
			if (normalizeProviderId(profileConfig.provider) !== providerKey) return false;
			if (profileConfig.mode !== cred.type) {
				if (!(profileConfig.mode === "oauth" && cred.type === "token")) return false;
			}
		}
		if (cred.type === "api_key") return Boolean(cred.key?.trim());
		if (cred.type === "token") {
			if (!cred.token?.trim()) return false;
			if (typeof cred.expires === "number" && Number.isFinite(cred.expires) && cred.expires > 0 && now >= cred.expires) return false;
			return true;
		}
		if (cred.type === "oauth") return Boolean(cred.access?.trim() || cred.refresh?.trim());
		return false;
	};
	let filtered = baseOrder.filter(isValidProfile);
	const allBaseProfilesMissing = baseOrder.every((profileId) => !store.profiles[profileId]);
	if (filtered.length === 0 && explicitProfiles.length > 0 && allBaseProfilesMissing) filtered = listProfilesForProvider(store, providerKey).filter(isValidProfile);
	const deduped = dedupeProfileIds(filtered);
	if (explicitOrder && explicitOrder.length > 0) {
		const available = [];
		const inCooldown = [];
		for (const profileId of deduped) if (isProfileInCooldown(store, profileId)) {
			const cooldownUntil = resolveProfileUnusableUntil(store.usageStats?.[profileId] ?? {}) ?? now;
			inCooldown.push({
				profileId,
				cooldownUntil
			});
		} else available.push(profileId);
		const cooldownSorted = inCooldown.toSorted((a, b) => a.cooldownUntil - b.cooldownUntil).map((entry) => entry.profileId);
		const ordered = [...available, ...cooldownSorted];
		if (preferredProfile && ordered.includes(preferredProfile)) return [preferredProfile, ...ordered.filter((e) => e !== preferredProfile)];
		return ordered;
	}
	const sorted = orderProfilesByMode(deduped, store);
	if (preferredProfile && sorted.includes(preferredProfile)) return [preferredProfile, ...sorted.filter((e) => e !== preferredProfile)];
	return sorted;
}
function orderProfilesByMode(order, store) {
	const now = Date.now();
	const available = [];
	const inCooldown = [];
	for (const profileId of order) if (isProfileInCooldown(store, profileId)) inCooldown.push(profileId);
	else available.push(profileId);
	const sorted = available.map((profileId) => {
		const type = store.profiles[profileId]?.type;
		return {
			profileId,
			typeScore: type === "oauth" ? 0 : type === "token" ? 1 : type === "api_key" ? 2 : 3,
			lastUsed: store.usageStats?.[profileId]?.lastUsed ?? 0
		};
	}).toSorted((a, b) => {
		if (a.typeScore !== b.typeScore) return a.typeScore - b.typeScore;
		return a.lastUsed - b.lastUsed;
	}).map((entry) => entry.profileId);
	const cooldownSorted = inCooldown.map((profileId) => ({
		profileId,
		cooldownUntil: resolveProfileUnusableUntil(store.usageStats?.[profileId] ?? {}) ?? now
	})).toSorted((a, b) => a.cooldownUntil - b.cooldownUntil).map((entry) => entry.profileId);
	return [...sorted, ...cooldownSorted];
}

//#endregion
//#region src/agents/auth-profiles.ts
var auth_profiles_exports = /* @__PURE__ */ __exportAll({ ensureAuthProfileStore: () => ensureAuthProfileStore });

//#endregion
//#region src/agents/bedrock-discovery.ts
const log$5 = createSubsystemLogger("bedrock-discovery");
const DEFAULT_REFRESH_INTERVAL_SECONDS = 3600;
const DEFAULT_CONTEXT_WINDOW = 32e3;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const discoveryCache = /* @__PURE__ */ new Map();
let hasLoggedBedrockError = false;
function normalizeProviderFilter(filter) {
	if (!filter || filter.length === 0) return [];
	const normalized = new Set(filter.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0));
	return Array.from(normalized).toSorted();
}
function buildCacheKey(params) {
	return JSON.stringify(params);
}
function includesTextModalities(modalities) {
	return (modalities ?? []).some((entry) => entry.toLowerCase() === "text");
}
function isActive(summary) {
	const status = summary.modelLifecycle?.status;
	return typeof status === "string" ? status.toUpperCase() === "ACTIVE" : false;
}
function mapInputModalities(summary) {
	const inputs = summary.inputModalities ?? [];
	const mapped = /* @__PURE__ */ new Set();
	for (const modality of inputs) {
		const lower = modality.toLowerCase();
		if (lower === "text") mapped.add("text");
		if (lower === "image") mapped.add("image");
	}
	if (mapped.size === 0) mapped.add("text");
	return Array.from(mapped);
}
function inferReasoningSupport(summary) {
	const haystack = `${summary.modelId ?? ""} ${summary.modelName ?? ""}`.toLowerCase();
	return haystack.includes("reasoning") || haystack.includes("thinking");
}
function resolveDefaultContextWindow(config) {
	const value = Math.floor(config?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW);
	return value > 0 ? value : DEFAULT_CONTEXT_WINDOW;
}
function resolveDefaultMaxTokens(config) {
	const value = Math.floor(config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS);
	return value > 0 ? value : DEFAULT_MAX_TOKENS;
}
function matchesProviderFilter(summary, filter) {
	if (filter.length === 0) return true;
	const normalized = (summary.providerName ?? (typeof summary.modelId === "string" ? summary.modelId.split(".")[0] : void 0))?.trim().toLowerCase();
	if (!normalized) return false;
	return filter.includes(normalized);
}
function shouldIncludeSummary(summary, filter) {
	if (!summary.modelId?.trim()) return false;
	if (!matchesProviderFilter(summary, filter)) return false;
	if (summary.responseStreamingSupported !== true) return false;
	if (!includesTextModalities(summary.outputModalities)) return false;
	if (!isActive(summary)) return false;
	return true;
}
function toModelDefinition(summary, defaults) {
	const id = summary.modelId?.trim() ?? "";
	return {
		id,
		name: summary.modelName?.trim() || id,
		reasoning: inferReasoningSupport(summary),
		input: mapInputModalities(summary),
		cost: DEFAULT_COST,
		contextWindow: defaults.contextWindow,
		maxTokens: defaults.maxTokens
	};
}
async function discoverBedrockModels(params) {
	const refreshIntervalSeconds = Math.max(0, Math.floor(params.config?.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_SECONDS));
	const providerFilter = normalizeProviderFilter(params.config?.providerFilter);
	const defaultContextWindow = resolveDefaultContextWindow(params.config);
	const defaultMaxTokens = resolveDefaultMaxTokens(params.config);
	const cacheKey = buildCacheKey({
		region: params.region,
		providerFilter,
		refreshIntervalSeconds,
		defaultContextWindow,
		defaultMaxTokens
	});
	const now = params.now?.() ?? Date.now();
	if (refreshIntervalSeconds > 0) {
		const cached = discoveryCache.get(cacheKey);
		if (cached?.value && cached.expiresAt > now) return cached.value;
		if (cached?.inFlight) return cached.inFlight;
	}
	const client = (params.clientFactory ?? ((region) => new BedrockClient({ region })))(params.region);
	const discoveryPromise = (async () => {
		const response = await client.send(new ListFoundationModelsCommand({}));
		const discovered = [];
		for (const summary of response.modelSummaries ?? []) {
			if (!shouldIncludeSummary(summary, providerFilter)) continue;
			discovered.push(toModelDefinition(summary, {
				contextWindow: defaultContextWindow,
				maxTokens: defaultMaxTokens
			}));
		}
		return discovered.toSorted((a, b) => a.name.localeCompare(b.name));
	})();
	if (refreshIntervalSeconds > 0) discoveryCache.set(cacheKey, {
		expiresAt: now + refreshIntervalSeconds * 1e3,
		inFlight: discoveryPromise
	});
	try {
		const value = await discoveryPromise;
		if (refreshIntervalSeconds > 0) discoveryCache.set(cacheKey, {
			expiresAt: now + refreshIntervalSeconds * 1e3,
			value
		});
		return value;
	} catch (error) {
		if (refreshIntervalSeconds > 0) discoveryCache.delete(cacheKey);
		if (!hasLoggedBedrockError) {
			hasLoggedBedrockError = true;
			log$5.warn(`Failed to list models: ${String(error)}`);
		}
		return [];
	}
}

//#endregion
//#region src/agents/volc-models.shared.ts
const VOLC_MODEL_KIMI_K2_5 = {
	id: "kimi-k2-5-260127",
	name: "Kimi K2.5",
	reasoning: false,
	input: ["text", "image"],
	contextWindow: 256e3,
	maxTokens: 4096
};
const VOLC_MODEL_GLM_4_7 = {
	id: "glm-4-7-251222",
	name: "GLM 4.7",
	reasoning: false,
	input: ["text", "image"],
	contextWindow: 2e5,
	maxTokens: 4096
};
const VOLC_SHARED_CODING_MODEL_CATALOG = [
	{
		id: "ark-code-latest",
		name: "Ark Coding Plan",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 4096
	},
	{
		id: "doubao-seed-code",
		name: "Doubao Seed Code",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 4096
	},
	{
		id: "glm-4.7",
		name: "GLM 4.7 Coding",
		reasoning: false,
		input: ["text"],
		contextWindow: 2e5,
		maxTokens: 4096
	},
	{
		id: "kimi-k2-thinking",
		name: "Kimi K2 Thinking",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 4096
	},
	{
		id: "kimi-k2.5",
		name: "Kimi K2.5 Coding",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 4096
	}
];
function buildVolcModelDefinition(entry, cost) {
	return {
		id: entry.id,
		name: entry.name,
		reasoning: entry.reasoning,
		input: [...entry.input],
		cost,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens
	};
}

//#endregion
//#region src/agents/byteplus-models.ts
const BYTEPLUS_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";
const BYTEPLUS_CODING_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/coding/v3";
const BYTEPLUS_DEFAULT_MODEL_ID = "seed-1-8-251228";
const BYTEPLUS_DEFAULT_MODEL_REF = `byteplus/${BYTEPLUS_DEFAULT_MODEL_ID}`;
const BYTEPLUS_DEFAULT_COST = {
	input: 1e-4,
	output: 2e-4,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* Complete catalog of BytePlus ARK models.
*
* BytePlus ARK provides access to various models
* through the ARK API. Authentication requires a BYTEPLUS_API_KEY.
*/
const BYTEPLUS_MODEL_CATALOG = [
	{
		id: "seed-1-8-251228",
		name: "Seed 1.8",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 256e3,
		maxTokens: 4096
	},
	VOLC_MODEL_KIMI_K2_5,
	VOLC_MODEL_GLM_4_7
];
function buildBytePlusModelDefinition(entry) {
	return buildVolcModelDefinition(entry, BYTEPLUS_DEFAULT_COST);
}
const BYTEPLUS_CODING_MODEL_CATALOG = VOLC_SHARED_CODING_MODEL_CATALOG;

//#endregion
//#region src/agents/cloudflare-ai-gateway.ts
const CLOUDFLARE_AI_GATEWAY_PROVIDER_ID = "cloudflare-ai-gateway";
const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID = "claude-sonnet-4-5";
const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF = `${CLOUDFLARE_AI_GATEWAY_PROVIDER_ID}/${CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID}`;
const CLOUDFLARE_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW = 2e5;
const CLOUDFLARE_AI_GATEWAY_DEFAULT_MAX_TOKENS = 64e3;
const CLOUDFLARE_AI_GATEWAY_DEFAULT_COST = {
	input: 3,
	output: 15,
	cacheRead: .3,
	cacheWrite: 3.75
};
function buildCloudflareAiGatewayModelDefinition(params) {
	return {
		id: params?.id?.trim() || CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID,
		name: params?.name ?? "Claude Sonnet 4.5",
		reasoning: params?.reasoning ?? true,
		input: params?.input ?? ["text", "image"],
		cost: CLOUDFLARE_AI_GATEWAY_DEFAULT_COST,
		contextWindow: CLOUDFLARE_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW,
		maxTokens: CLOUDFLARE_AI_GATEWAY_DEFAULT_MAX_TOKENS
	};
}
function resolveCloudflareAiGatewayBaseUrl(params) {
	const accountId = params.accountId.trim();
	const gatewayId = params.gatewayId.trim();
	if (!accountId || !gatewayId) return "";
	return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`;
}

//#endregion
//#region src/agents/doubao-models.ts
const DOUBAO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DOUBAO_CODING_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
const DOUBAO_DEFAULT_MODEL_ID = "doubao-seed-1-8-251228";
const DOUBAO_DEFAULT_MODEL_REF = `volcengine/${DOUBAO_DEFAULT_MODEL_ID}`;
const DOUBAO_DEFAULT_COST = {
	input: 1e-4,
	output: 2e-4,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* Complete catalog of Volcano Engine models.
*
* Volcano Engine provides access to models
* through the API. Authentication requires a Volcano Engine API Key.
*/
const DOUBAO_MODEL_CATALOG = [
	{
		id: "doubao-seed-code-preview-251028",
		name: "doubao-seed-code-preview-251028",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 256e3,
		maxTokens: 4096
	},
	{
		id: "doubao-seed-1-8-251228",
		name: "Doubao Seed 1.8",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 256e3,
		maxTokens: 4096
	},
	VOLC_MODEL_KIMI_K2_5,
	VOLC_MODEL_GLM_4_7,
	{
		id: "deepseek-v3-2-251201",
		name: "DeepSeek V3.2",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 128e3,
		maxTokens: 4096
	}
];
function buildDoubaoModelDefinition(entry) {
	return buildVolcModelDefinition(entry, DOUBAO_DEFAULT_COST);
}
const DOUBAO_CODING_MODEL_CATALOG = [...VOLC_SHARED_CODING_MODEL_CATALOG, {
	id: "doubao-seed-code-preview-251028",
	name: "Doubao Seed Code Preview",
	reasoning: false,
	input: ["text"],
	contextWindow: 256e3,
	maxTokens: 4096
}];

//#endregion
//#region src/agents/huggingface-models.ts
const log$4 = createSubsystemLogger("huggingface-models");
/** Hugging Face Inference Providers (router) — OpenAI-compatible chat completions. */
const HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";
/** Default cost when not in static catalog (HF pricing varies by provider). */
const HUGGINGFACE_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/** Defaults for models discovered from GET /v1/models. */
const HUGGINGFACE_DEFAULT_CONTEXT_WINDOW = 131072;
const HUGGINGFACE_DEFAULT_MAX_TOKENS = 8192;
const HUGGINGFACE_MODEL_CATALOG = [
	{
		id: "deepseek-ai/DeepSeek-R1",
		name: "DeepSeek R1",
		reasoning: true,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		cost: {
			input: 3,
			output: 7,
			cacheRead: 3,
			cacheWrite: 3
		}
	},
	{
		id: "deepseek-ai/DeepSeek-V3.1",
		name: "DeepSeek V3.1",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		cost: {
			input: .6,
			output: 1.25,
			cacheRead: .6,
			cacheWrite: .6
		}
	},
	{
		id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
		name: "Llama 3.3 70B Instruct Turbo",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		cost: {
			input: .88,
			output: .88,
			cacheRead: .88,
			cacheWrite: .88
		}
	},
	{
		id: "openai/gpt-oss-120b",
		name: "GPT-OSS 120B",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		}
	}
];
function buildHuggingfaceModelDefinition(model) {
	return {
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens
	};
}
/**
* Infer reasoning and display name from Hub-style model id (e.g. "deepseek-ai/DeepSeek-R1").
*/
function inferredMetaFromModelId(id) {
	const base = id.split("/").pop() ?? id;
	const reasoning = /r1|reasoning|thinking|reason/i.test(id) || /-\d+[tb]?-thinking/i.test(base);
	return {
		name: base.replace(/-/g, " ").replace(/\b(\w)/g, (c) => c.toUpperCase()),
		reasoning
	};
}
/** Prefer API-supplied display name, then owned_by/id, then inferred from id. */
function displayNameFromApiEntry(entry, inferredName) {
	const fromApi = typeof entry.name === "string" && entry.name.trim() || typeof entry.title === "string" && entry.title.trim() || typeof entry.display_name === "string" && entry.display_name.trim();
	if (fromApi) return fromApi;
	if (typeof entry.owned_by === "string" && entry.owned_by.trim()) {
		const base = entry.id.split("/").pop() ?? entry.id;
		return `${entry.owned_by.trim()}/${base}`;
	}
	return inferredName;
}
/**
* Discover chat-completion models from Hugging Face Inference Providers (GET /v1/models).
* Requires a valid HF token. Falls back to static catalog on failure or in test env.
*/
async function discoverHuggingfaceModels(apiKey) {
	if (process.env.VITEST === "true" || false) return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
	const trimmedKey = apiKey?.trim();
	if (!trimmedKey) return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
	try {
		const response = await fetch(`${HUGGINGFACE_BASE_URL}/models`, {
			signal: AbortSignal.timeout(1e4),
			headers: {
				Authorization: `Bearer ${trimmedKey}`,
				"Content-Type": "application/json"
			}
		});
		if (!response.ok) {
			log$4.warn(`GET /v1/models failed: HTTP ${response.status}, using static catalog`);
			return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
		}
		const data = (await response.json())?.data;
		if (!Array.isArray(data) || data.length === 0) {
			log$4.warn("No models in response, using static catalog");
			return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
		}
		const catalogById = new Map(HUGGINGFACE_MODEL_CATALOG.map((m) => [m.id, m]));
		const seen = /* @__PURE__ */ new Set();
		const models = [];
		for (const entry of data) {
			const id = typeof entry?.id === "string" ? entry.id.trim() : "";
			if (!id || seen.has(id)) continue;
			seen.add(id);
			const catalogEntry = catalogById.get(id);
			if (catalogEntry) models.push(buildHuggingfaceModelDefinition(catalogEntry));
			else {
				const inferred = inferredMetaFromModelId(id);
				const name = displayNameFromApiEntry(entry, inferred.name);
				const modalities = entry.architecture?.input_modalities;
				const input = Array.isArray(modalities) && modalities.includes("image") ? ["text", "image"] : ["text"];
				const contextLength = (Array.isArray(entry.providers) ? entry.providers : []).find((p) => typeof p?.context_length === "number" && p.context_length > 0)?.context_length ?? HUGGINGFACE_DEFAULT_CONTEXT_WINDOW;
				models.push({
					id,
					name,
					reasoning: inferred.reasoning,
					input,
					cost: HUGGINGFACE_DEFAULT_COST,
					contextWindow: contextLength,
					maxTokens: HUGGINGFACE_DEFAULT_MAX_TOKENS
				});
			}
		}
		return models.length > 0 ? models : HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
	} catch (error) {
		log$4.warn(`Discovery failed: ${String(error)}, using static catalog`);
		return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
	}
}

//#endregion
//#region src/agents/model-auth.ts
const AWS_BEARER_ENV = "AWS_BEARER_TOKEN_BEDROCK";
const AWS_ACCESS_KEY_ENV = "AWS_ACCESS_KEY_ID";
const AWS_SECRET_KEY_ENV = "AWS_SECRET_ACCESS_KEY";
const AWS_PROFILE_ENV = "AWS_PROFILE";
function resolveProviderConfig(cfg, provider) {
	const providers = cfg?.models?.providers ?? {};
	const direct = providers[provider];
	if (direct) return direct;
	const normalized = normalizeProviderId(provider);
	if (normalized === provider) return Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized)?.[1];
	return providers[normalized] ?? Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized)?.[1];
}
function getCustomProviderApiKey(cfg, provider) {
	return normalizeOptionalSecretInput(resolveProviderConfig(cfg, provider)?.apiKey);
}
function resolveProviderAuthOverride(cfg, provider) {
	const auth = resolveProviderConfig(cfg, provider)?.auth;
	if (auth === "api-key" || auth === "aws-sdk" || auth === "oauth" || auth === "token") return auth;
}
function resolveEnvSourceLabel(params) {
	return `${params.envVars.some((envVar) => params.applied.has(envVar)) ? "shell env: " : "env: "}${params.label}`;
}
function resolveAwsSdkEnvVarName(env = process.env) {
	if (env[AWS_BEARER_ENV]?.trim()) return AWS_BEARER_ENV;
	if (env[AWS_ACCESS_KEY_ENV]?.trim() && env[AWS_SECRET_KEY_ENV]?.trim()) return AWS_ACCESS_KEY_ENV;
	if (env[AWS_PROFILE_ENV]?.trim()) return AWS_PROFILE_ENV;
}
function resolveAwsSdkAuthInfo() {
	const applied = new Set(getShellEnvAppliedKeys());
	if (process.env[AWS_BEARER_ENV]?.trim()) return {
		mode: "aws-sdk",
		source: resolveEnvSourceLabel({
			applied,
			envVars: [AWS_BEARER_ENV],
			label: AWS_BEARER_ENV
		})
	};
	if (process.env[AWS_ACCESS_KEY_ENV]?.trim() && process.env[AWS_SECRET_KEY_ENV]?.trim()) return {
		mode: "aws-sdk",
		source: resolveEnvSourceLabel({
			applied,
			envVars: [AWS_ACCESS_KEY_ENV, AWS_SECRET_KEY_ENV],
			label: `${AWS_ACCESS_KEY_ENV} + ${AWS_SECRET_KEY_ENV}`
		})
	};
	if (process.env[AWS_PROFILE_ENV]?.trim()) return {
		mode: "aws-sdk",
		source: resolveEnvSourceLabel({
			applied,
			envVars: [AWS_PROFILE_ENV],
			label: AWS_PROFILE_ENV
		})
	};
	return {
		mode: "aws-sdk",
		source: "aws-sdk default chain"
	};
}
async function resolveApiKeyForProvider(params) {
	const { provider, cfg, profileId, preferredProfile } = params;
	const store = params.store ?? ensureAuthProfileStore(params.agentDir);
	if (profileId) {
		const resolved = await resolveApiKeyForProfile({
			cfg,
			store,
			profileId,
			agentDir: params.agentDir
		});
		if (!resolved) throw new Error(`No credentials found for profile "${profileId}".`);
		const mode = store.profiles[profileId]?.type;
		return {
			apiKey: resolved.apiKey,
			profileId,
			source: `profile:${profileId}`,
			mode: mode === "oauth" ? "oauth" : mode === "token" ? "token" : "api-key"
		};
	}
	const authOverride = resolveProviderAuthOverride(cfg, provider);
	if (authOverride === "aws-sdk") return resolveAwsSdkAuthInfo();
	const order = resolveAuthProfileOrder({
		cfg,
		store,
		provider,
		preferredProfile
	});
	for (const candidate of order) try {
		const resolved = await resolveApiKeyForProfile({
			cfg,
			store,
			profileId: candidate,
			agentDir: params.agentDir
		});
		if (resolved) {
			const mode = store.profiles[candidate]?.type;
			return {
				apiKey: resolved.apiKey,
				profileId: candidate,
				source: `profile:${candidate}`,
				mode: mode === "oauth" ? "oauth" : mode === "token" ? "token" : "api-key"
			};
		}
	} catch {}
	const envResolved = resolveEnvApiKey(provider);
	if (envResolved) return {
		apiKey: envResolved.apiKey,
		source: envResolved.source,
		mode: envResolved.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key"
	};
	const customKey = getCustomProviderApiKey(cfg, provider);
	if (customKey) return {
		apiKey: customKey,
		source: "models.json",
		mode: "api-key"
	};
	const normalized = normalizeProviderId(provider);
	if (authOverride === void 0 && normalized === "amazon-bedrock") return resolveAwsSdkAuthInfo();
	if (provider === "openai") {
		if (listProfilesForProvider(store, "openai-codex").length > 0) throw new Error("No API key found for provider \"openai\". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.3-codex (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.1-codex.");
	}
	const authStorePath = resolveAuthStorePathForDisplay(params.agentDir);
	const resolvedAgentDir = path.dirname(authStorePath);
	throw new Error([
		`No API key found for provider "${provider}".`,
		`Auth store: ${authStorePath} (agentDir: ${resolvedAgentDir}).`,
		`Configure auth for this agent (${formatCliCommand("openclaw agents add <id>")}) or copy auth-profiles.json from the main agentDir.`
	].join(" "));
}
function resolveEnvApiKey(provider) {
	const normalized = normalizeProviderId(provider);
	const applied = new Set(getShellEnvAppliedKeys());
	const pick = (envVar) => {
		const value = normalizeOptionalSecretInput(process.env[envVar]);
		if (!value) return null;
		return {
			apiKey: value,
			source: applied.has(envVar) ? `shell env: ${envVar}` : `env: ${envVar}`
		};
	};
	if (normalized === "github-copilot") return pick("COPILOT_GITHUB_TOKEN") ?? pick("GH_TOKEN") ?? pick("GITHUB_TOKEN");
	if (normalized === "anthropic") return pick("ANTHROPIC_OAUTH_TOKEN") ?? pick("ANTHROPIC_API_KEY");
	if (normalized === "chutes") return pick("CHUTES_OAUTH_TOKEN") ?? pick("CHUTES_API_KEY");
	if (normalized === "zai") return pick("ZAI_API_KEY") ?? pick("Z_AI_API_KEY");
	if (normalized === "google-vertex") {
		const envKey = getEnvApiKey(normalized);
		if (!envKey) return null;
		return {
			apiKey: envKey,
			source: "gcloud adc"
		};
	}
	if (normalized === "opencode") return pick("OPENCODE_API_KEY") ?? pick("OPENCODE_ZEN_API_KEY");
	if (normalized === "qwen-portal") return pick("QWEN_OAUTH_TOKEN") ?? pick("QWEN_PORTAL_API_KEY");
	if (normalized === "volcengine" || normalized === "volcengine-plan") return pick("VOLCANO_ENGINE_API_KEY");
	if (normalized === "byteplus" || normalized === "byteplus-plan") return pick("BYTEPLUS_API_KEY");
	if (normalized === "minimax-portal") return pick("MINIMAX_OAUTH_TOKEN") ?? pick("MINIMAX_API_KEY");
	if (normalized === "kimi-coding") return pick("KIMI_API_KEY") ?? pick("KIMICODE_API_KEY");
	if (normalized === "huggingface") return pick("HUGGINGFACE_HUB_TOKEN") ?? pick("HF_TOKEN");
	const envVar = {
		openai: "OPENAI_API_KEY",
		google: "GEMINI_API_KEY",
		voyage: "VOYAGE_API_KEY",
		groq: "GROQ_API_KEY",
		deepgram: "DEEPGRAM_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
		xai: "XAI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
		litellm: "LITELLM_API_KEY",
		"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
		"cloudflare-ai-gateway": "CLOUDFLARE_AI_GATEWAY_API_KEY",
		moonshot: "MOONSHOT_API_KEY",
		minimax: "MINIMAX_API_KEY",
		nvidia: "NVIDIA_API_KEY",
		xiaomi: "XIAOMI_API_KEY",
		synthetic: "SYNTHETIC_API_KEY",
		venice: "VENICE_API_KEY",
		mistral: "MISTRAL_API_KEY",
		opencode: "OPENCODE_API_KEY",
		together: "TOGETHER_API_KEY",
		qianfan: "QIANFAN_API_KEY",
		ollama: "OLLAMA_API_KEY",
		vllm: "VLLM_API_KEY",
		kilocode: "KILOCODE_API_KEY"
	}[normalized];
	if (!envVar) return null;
	return pick(envVar);
}
function resolveModelAuthMode(provider, cfg, store) {
	const resolved = provider?.trim();
	if (!resolved) return;
	const authOverride = resolveProviderAuthOverride(cfg, resolved);
	if (authOverride === "aws-sdk") return "aws-sdk";
	const authStore = store ?? ensureAuthProfileStore();
	const profiles = listProfilesForProvider(authStore, resolved);
	if (profiles.length > 0) {
		const modes = new Set(profiles.map((id) => authStore.profiles[id]?.type).filter((mode) => Boolean(mode)));
		if ([
			"oauth",
			"token",
			"api_key"
		].filter((k) => modes.has(k)).length >= 2) return "mixed";
		if (modes.has("oauth")) return "oauth";
		if (modes.has("token")) return "token";
		if (modes.has("api_key")) return "api-key";
	}
	if (authOverride === void 0 && normalizeProviderId(resolved) === "amazon-bedrock") return "aws-sdk";
	const envKey = resolveEnvApiKey(resolved);
	if (envKey?.apiKey) return envKey.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key";
	if (getCustomProviderApiKey(cfg, resolved)) return "api-key";
	return "unknown";
}
async function getApiKeyForModel(params) {
	return resolveApiKeyForProvider({
		provider: params.model.provider,
		cfg: params.cfg,
		profileId: params.profileId,
		preferredProfile: params.preferredProfile,
		store: params.store,
		agentDir: params.agentDir
	});
}
function requireApiKey(auth, provider) {
	const key = normalizeSecretInput(auth.apiKey);
	if (key) return key;
	throw new Error(`No API key resolved for provider "${provider}" (auth mode: ${auth.mode}).`);
}

//#endregion
//#region src/agents/ollama-stream.ts
const log$3 = createSubsystemLogger("ollama-stream");
const OLLAMA_NATIVE_BASE_URL = "http://127.0.0.1:11434";
const MAX_SAFE_INTEGER_ABS_STR = String(Number.MAX_SAFE_INTEGER);
function isAsciiDigit(ch) {
	return ch !== void 0 && ch >= "0" && ch <= "9";
}
function parseJsonNumberToken(input, start) {
	let idx = start;
	if (input[idx] === "-") idx += 1;
	if (idx >= input.length) return null;
	if (input[idx] === "0") idx += 1;
	else if (isAsciiDigit(input[idx]) && input[idx] !== "0") while (isAsciiDigit(input[idx])) idx += 1;
	else return null;
	let isInteger = true;
	if (input[idx] === ".") {
		isInteger = false;
		idx += 1;
		if (!isAsciiDigit(input[idx])) return null;
		while (isAsciiDigit(input[idx])) idx += 1;
	}
	if (input[idx] === "e" || input[idx] === "E") {
		isInteger = false;
		idx += 1;
		if (input[idx] === "+" || input[idx] === "-") idx += 1;
		if (!isAsciiDigit(input[idx])) return null;
		while (isAsciiDigit(input[idx])) idx += 1;
	}
	return {
		token: input.slice(start, idx),
		end: idx,
		isInteger
	};
}
function isUnsafeIntegerLiteral(token) {
	const digits = token[0] === "-" ? token.slice(1) : token;
	if (digits.length < MAX_SAFE_INTEGER_ABS_STR.length) return false;
	if (digits.length > MAX_SAFE_INTEGER_ABS_STR.length) return true;
	return digits > MAX_SAFE_INTEGER_ABS_STR;
}
function quoteUnsafeIntegerLiterals(input) {
	let out = "";
	let inString = false;
	let escaped = false;
	let idx = 0;
	while (idx < input.length) {
		const ch = input[idx] ?? "";
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === "\"") inString = false;
			idx += 1;
			continue;
		}
		if (ch === "\"") {
			inString = true;
			out += ch;
			idx += 1;
			continue;
		}
		if (ch === "-" || isAsciiDigit(ch)) {
			const parsed = parseJsonNumberToken(input, idx);
			if (parsed) {
				if (parsed.isInteger && isUnsafeIntegerLiteral(parsed.token)) out += `"${parsed.token}"`;
				else out += parsed.token;
				idx = parsed.end;
				continue;
			}
		}
		out += ch;
		idx += 1;
	}
	return out;
}
function parseJsonPreservingUnsafeIntegers(input) {
	return JSON.parse(quoteUnsafeIntegerLiterals(input));
}
function extractTextContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part.type === "text").map((part) => part.text).join("");
}
function extractOllamaImages(content) {
	if (!Array.isArray(content)) return [];
	return content.filter((part) => part.type === "image").map((part) => part.data);
}
function extractToolCalls(content) {
	if (!Array.isArray(content)) return [];
	const parts = content;
	const result = [];
	for (const part of parts) if (part.type === "toolCall") result.push({ function: {
		name: part.name,
		arguments: part.arguments
	} });
	else if (part.type === "tool_use") result.push({ function: {
		name: part.name,
		arguments: part.input
	} });
	return result;
}
function convertToOllamaMessages(messages, system) {
	const result = [];
	if (system) result.push({
		role: "system",
		content: system
	});
	for (const msg of messages) {
		const { role } = msg;
		if (role === "user") {
			const text = extractTextContent(msg.content);
			const images = extractOllamaImages(msg.content);
			result.push({
				role: "user",
				content: text,
				...images.length > 0 ? { images } : {}
			});
		} else if (role === "assistant") {
			const text = extractTextContent(msg.content);
			const toolCalls = extractToolCalls(msg.content);
			result.push({
				role: "assistant",
				content: text,
				...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
			});
		} else if (role === "tool" || role === "toolResult") {
			const text = extractTextContent(msg.content);
			const toolName = typeof msg.toolName === "string" ? msg.toolName : void 0;
			result.push({
				role: "tool",
				content: text,
				...toolName ? { tool_name: toolName } : {}
			});
		}
	}
	return result;
}
function extractOllamaTools(tools) {
	if (!tools || !Array.isArray(tools)) return [];
	const result = [];
	for (const tool of tools) {
		if (typeof tool.name !== "string" || !tool.name) continue;
		result.push({
			type: "function",
			function: {
				name: tool.name,
				description: typeof tool.description === "string" ? tool.description : "",
				parameters: tool.parameters ?? {}
			}
		});
	}
	return result;
}
function buildAssistantMessage(response, modelInfo) {
	const content = [];
	const text = response.message.content || response.message.reasoning || "";
	if (text) content.push({
		type: "text",
		text
	});
	const toolCalls = response.message.tool_calls;
	if (toolCalls && toolCalls.length > 0) for (const tc of toolCalls) content.push({
		type: "toolCall",
		id: `ollama_call_${randomUUID()}`,
		name: tc.function.name,
		arguments: tc.function.arguments
	});
	const stopReason = toolCalls && toolCalls.length > 0 ? "toolUse" : "stop";
	const usage = {
		input: response.prompt_eval_count ?? 0,
		output: response.eval_count ?? 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
	return {
		role: "assistant",
		content,
		stopReason,
		api: modelInfo.api,
		provider: modelInfo.provider,
		model: modelInfo.id,
		usage,
		timestamp: Date.now()
	};
}
async function* parseNdjsonStream(reader) {
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				yield parseJsonPreservingUnsafeIntegers(trimmed);
			} catch {
				log$3.warn(`Skipping malformed NDJSON line: ${trimmed.slice(0, 120)}`);
			}
		}
	}
	if (buffer.trim()) try {
		yield parseJsonPreservingUnsafeIntegers(buffer.trim());
	} catch {
		log$3.warn(`Skipping malformed trailing data: ${buffer.trim().slice(0, 120)}`);
	}
}
function resolveOllamaChatUrl(baseUrl) {
	return `${baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "") || OLLAMA_NATIVE_BASE_URL}/api/chat`;
}
function createOllamaStreamFn(baseUrl) {
	const chatUrl = resolveOllamaChatUrl(baseUrl);
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const run = async () => {
			try {
				const ollamaMessages = convertToOllamaMessages(context.messages ?? [], context.systemPrompt);
				const ollamaTools = extractOllamaTools(context.tools);
				const ollamaOptions = { num_ctx: model.contextWindow ?? 65536 };
				if (typeof options?.temperature === "number") ollamaOptions.temperature = options.temperature;
				if (typeof options?.maxTokens === "number") ollamaOptions.num_predict = options.maxTokens;
				const body = {
					model: model.id,
					messages: ollamaMessages,
					stream: true,
					...ollamaTools.length > 0 ? { tools: ollamaTools } : {},
					options: ollamaOptions
				};
				const headers = {
					"Content-Type": "application/json",
					...options?.headers
				};
				if (options?.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
				const response = await fetch(chatUrl, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: options?.signal
				});
				if (!response.ok) {
					const errorText = await response.text().catch(() => "unknown error");
					throw new Error(`Ollama API error ${response.status}: ${errorText}`);
				}
				if (!response.body) throw new Error("Ollama API returned empty response body");
				const reader = response.body.getReader();
				let accumulatedContent = "";
				const accumulatedToolCalls = [];
				let finalResponse;
				for await (const chunk of parseNdjsonStream(reader)) {
					if (chunk.message?.content) accumulatedContent += chunk.message.content;
					else if (chunk.message?.reasoning) accumulatedContent += chunk.message.reasoning;
					if (chunk.message?.tool_calls) accumulatedToolCalls.push(...chunk.message.tool_calls);
					if (chunk.done) {
						finalResponse = chunk;
						break;
					}
				}
				if (!finalResponse) throw new Error("Ollama API stream ended without a final response");
				finalResponse.message.content = accumulatedContent;
				if (accumulatedToolCalls.length > 0) finalResponse.message.tool_calls = accumulatedToolCalls;
				const assistantMessage = buildAssistantMessage(finalResponse, {
					api: model.api,
					provider: model.provider,
					id: model.id
				});
				const reason = assistantMessage.stopReason === "toolUse" ? "toolUse" : "stop";
				stream.push({
					type: "done",
					reason,
					message: assistantMessage
				});
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				stream.push({
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage,
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0
							}
						},
						timestamp: Date.now()
					}
				});
			} finally {
				stream.end();
			}
		};
		queueMicrotask(() => void run());
		return stream;
	};
}

//#endregion
//#region src/agents/synthetic-models.ts
const SYNTHETIC_BASE_URL = "https://api.synthetic.new/anthropic";
const SYNTHETIC_DEFAULT_MODEL_ID = "hf:MiniMaxAI/MiniMax-M2.1";
const SYNTHETIC_DEFAULT_MODEL_REF = `synthetic/${SYNTHETIC_DEFAULT_MODEL_ID}`;
const SYNTHETIC_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const SYNTHETIC_MODEL_CATALOG = [
	{
		id: SYNTHETIC_DEFAULT_MODEL_ID,
		name: "MiniMax M2.1",
		reasoning: false,
		input: ["text"],
		contextWindow: 192e3,
		maxTokens: 65536
	},
	{
		id: "hf:moonshotai/Kimi-K2-Thinking",
		name: "Kimi K2 Thinking",
		reasoning: true,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 8192
	},
	{
		id: "hf:zai-org/GLM-4.7",
		name: "GLM-4.7",
		reasoning: false,
		input: ["text"],
		contextWindow: 198e3,
		maxTokens: 128e3
	},
	{
		id: "hf:deepseek-ai/DeepSeek-R1-0528",
		name: "DeepSeek R1 0528",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 8192
	},
	{
		id: "hf:deepseek-ai/DeepSeek-V3-0324",
		name: "DeepSeek V3 0324",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 8192
	},
	{
		id: "hf:deepseek-ai/DeepSeek-V3.1",
		name: "DeepSeek V3.1",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 8192
	},
	{
		id: "hf:deepseek-ai/DeepSeek-V3.1-Terminus",
		name: "DeepSeek V3.1 Terminus",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 8192
	},
	{
		id: "hf:deepseek-ai/DeepSeek-V3.2",
		name: "DeepSeek V3.2",
		reasoning: false,
		input: ["text"],
		contextWindow: 159e3,
		maxTokens: 8192
	},
	{
		id: "hf:meta-llama/Llama-3.3-70B-Instruct",
		name: "Llama 3.3 70B Instruct",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 8192
	},
	{
		id: "hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
		name: "Llama 4 Maverick 17B 128E Instruct FP8",
		reasoning: false,
		input: ["text"],
		contextWindow: 524e3,
		maxTokens: 8192
	},
	{
		id: "hf:moonshotai/Kimi-K2-Instruct-0905",
		name: "Kimi K2 Instruct 0905",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 8192
	},
	{
		id: "hf:moonshotai/Kimi-K2.5",
		name: "Kimi K2.5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256e3,
		maxTokens: 8192
	},
	{
		id: "hf:openai/gpt-oss-120b",
		name: "GPT OSS 120B",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 8192
	},
	{
		id: "hf:Qwen/Qwen3-235B-A22B-Instruct-2507",
		name: "Qwen3 235B A22B Instruct 2507",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 8192
	},
	{
		id: "hf:Qwen/Qwen3-Coder-480B-A35B-Instruct",
		name: "Qwen3 Coder 480B A35B Instruct",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 8192
	},
	{
		id: "hf:Qwen/Qwen3-VL-235B-A22B-Instruct",
		name: "Qwen3 VL 235B A22B Instruct",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 25e4,
		maxTokens: 8192
	},
	{
		id: "hf:zai-org/GLM-4.5",
		name: "GLM-4.5",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 128e3
	},
	{
		id: "hf:zai-org/GLM-4.6",
		name: "GLM-4.6",
		reasoning: false,
		input: ["text"],
		contextWindow: 198e3,
		maxTokens: 128e3
	},
	{
		id: "hf:zai-org/GLM-5",
		name: "GLM-5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256e3,
		maxTokens: 128e3
	},
	{
		id: "hf:deepseek-ai/DeepSeek-V3",
		name: "DeepSeek V3",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 8192
	},
	{
		id: "hf:Qwen/Qwen3-235B-A22B-Thinking-2507",
		name: "Qwen3 235B A22B Thinking 2507",
		reasoning: true,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 8192
	}
];
function buildSyntheticModelDefinition(entry) {
	return {
		id: entry.id,
		name: entry.name,
		reasoning: entry.reasoning,
		input: [...entry.input],
		cost: SYNTHETIC_DEFAULT_COST,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens
	};
}

//#endregion
//#region src/agents/together-models.ts
const TOGETHER_BASE_URL = "https://api.together.xyz/v1";
const TOGETHER_MODEL_CATALOG = [
	{
		id: "zai-org/GLM-4.7",
		name: "GLM 4.7 Fp8",
		reasoning: false,
		input: ["text"],
		contextWindow: 202752,
		maxTokens: 8192,
		cost: {
			input: .45,
			output: 2,
			cacheRead: .45,
			cacheWrite: 2
		}
	},
	{
		id: "moonshotai/Kimi-K2.5",
		name: "Kimi K2.5",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: .5,
			output: 2.8,
			cacheRead: .5,
			cacheWrite: 2.8
		},
		contextWindow: 262144,
		maxTokens: 32768
	},
	{
		id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
		name: "Llama 3.3 70B Instruct Turbo",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		cost: {
			input: .88,
			output: .88,
			cacheRead: .88,
			cacheWrite: .88
		}
	},
	{
		id: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
		name: "Llama 4 Scout 17B 16E Instruct",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 1e7,
		maxTokens: 32768,
		cost: {
			input: .18,
			output: .59,
			cacheRead: .18,
			cacheWrite: .18
		}
	},
	{
		id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
		name: "Llama 4 Maverick 17B 128E Instruct FP8",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 2e7,
		maxTokens: 32768,
		cost: {
			input: .27,
			output: .85,
			cacheRead: .27,
			cacheWrite: .27
		}
	},
	{
		id: "deepseek-ai/DeepSeek-V3.1",
		name: "DeepSeek V3.1",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		cost: {
			input: .6,
			output: 1.25,
			cacheRead: .6,
			cacheWrite: .6
		}
	},
	{
		id: "deepseek-ai/DeepSeek-R1",
		name: "DeepSeek R1",
		reasoning: true,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		cost: {
			input: 3,
			output: 7,
			cacheRead: 3,
			cacheWrite: 3
		}
	},
	{
		id: "moonshotai/Kimi-K2-Instruct-0905",
		name: "Kimi K2-Instruct 0905",
		reasoning: false,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 8192,
		cost: {
			input: 1,
			output: 3,
			cacheRead: 1,
			cacheWrite: 3
		}
	}
];
function buildTogetherModelDefinition(model) {
	return {
		id: model.id,
		name: model.name,
		api: "openai-completions",
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens
	};
}

//#endregion
//#region src/agents/venice-models.ts
const log$2 = createSubsystemLogger("venice-models");
const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
const VENICE_DEFAULT_MODEL_ID = "llama-3.3-70b";
const VENICE_DEFAULT_MODEL_REF = `venice/${VENICE_DEFAULT_MODEL_ID}`;
const VENICE_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* Complete catalog of Venice AI models.
*
* Venice provides two privacy modes:
* - "private": Fully private inference, no logging, ephemeral
* - "anonymized": Proxied through Venice with metadata stripped (for proprietary models)
*
* Note: The `privacy` field is included for documentation purposes but is not
* propagated to ModelDefinitionConfig as it's not part of the core model schema.
* Privacy mode is determined by the model itself, not configurable at runtime.
*
* This catalog serves as a fallback when the Venice API is unreachable.
*/
const VENICE_MODEL_CATALOG = [
	{
		id: "llama-3.3-70b",
		name: "Llama 3.3 70B",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		privacy: "private"
	},
	{
		id: "llama-3.2-3b",
		name: "Llama 3.2 3B",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		privacy: "private"
	},
	{
		id: "hermes-3-llama-3.1-405b",
		name: "Hermes 3 Llama 3.1 405B",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		privacy: "private"
	},
	{
		id: "qwen3-235b-a22b-thinking-2507",
		name: "Qwen3 235B Thinking",
		reasoning: true,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		privacy: "private"
	},
	{
		id: "qwen3-235b-a22b-instruct-2507",
		name: "Qwen3 235B Instruct",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		privacy: "private"
	},
	{
		id: "qwen3-coder-480b-a35b-instruct",
		name: "Qwen3 Coder 480B",
		reasoning: false,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 8192,
		privacy: "private"
	},
	{
		id: "qwen3-next-80b",
		name: "Qwen3 Next 80B",
		reasoning: false,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 8192,
		privacy: "private"
	},
	{
		id: "qwen3-vl-235b-a22b",
		name: "Qwen3 VL 235B (Vision)",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 8192,
		privacy: "private"
	},
	{
		id: "qwen3-4b",
		name: "Venice Small (Qwen3 4B)",
		reasoning: true,
		input: ["text"],
		contextWindow: 32768,
		maxTokens: 8192,
		privacy: "private"
	},
	{
		id: "deepseek-v3.2",
		name: "DeepSeek V3.2",
		reasoning: true,
		input: ["text"],
		contextWindow: 163840,
		maxTokens: 8192,
		privacy: "private"
	},
	{
		id: "venice-uncensored",
		name: "Venice Uncensored (Dolphin-Mistral)",
		reasoning: false,
		input: ["text"],
		contextWindow: 32768,
		maxTokens: 8192,
		privacy: "private"
	},
	{
		id: "mistral-31-24b",
		name: "Venice Medium (Mistral)",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 131072,
		maxTokens: 8192,
		privacy: "private"
	},
	{
		id: "google-gemma-3-27b-it",
		name: "Google Gemma 3 27B Instruct",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 202752,
		maxTokens: 8192,
		privacy: "private"
	},
	{
		id: "openai-gpt-oss-120b",
		name: "OpenAI GPT OSS 120B",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		privacy: "private"
	},
	{
		id: "zai-org-glm-4.7",
		name: "GLM 4.7",
		reasoning: true,
		input: ["text"],
		contextWindow: 202752,
		maxTokens: 8192,
		privacy: "private"
	},
	{
		id: "claude-opus-45",
		name: "Claude Opus 4.5 (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 202752,
		maxTokens: 8192,
		privacy: "anonymized"
	},
	{
		id: "claude-sonnet-45",
		name: "Claude Sonnet 4.5 (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 202752,
		maxTokens: 8192,
		privacy: "anonymized"
	},
	{
		id: "openai-gpt-52",
		name: "GPT-5.2 (via Venice)",
		reasoning: true,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 8192,
		privacy: "anonymized"
	},
	{
		id: "openai-gpt-52-codex",
		name: "GPT-5.2 Codex (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 8192,
		privacy: "anonymized"
	},
	{
		id: "gemini-3-pro-preview",
		name: "Gemini 3 Pro (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 202752,
		maxTokens: 8192,
		privacy: "anonymized"
	},
	{
		id: "gemini-3-flash-preview",
		name: "Gemini 3 Flash (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 8192,
		privacy: "anonymized"
	},
	{
		id: "grok-41-fast",
		name: "Grok 4.1 Fast (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 8192,
		privacy: "anonymized"
	},
	{
		id: "grok-code-fast-1",
		name: "Grok Code Fast 1 (via Venice)",
		reasoning: true,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 8192,
		privacy: "anonymized"
	},
	{
		id: "kimi-k2-thinking",
		name: "Kimi K2 Thinking (via Venice)",
		reasoning: true,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 8192,
		privacy: "anonymized"
	},
	{
		id: "minimax-m21",
		name: "MiniMax M2.1 (via Venice)",
		reasoning: true,
		input: ["text"],
		contextWindow: 202752,
		maxTokens: 8192,
		privacy: "anonymized"
	}
];
/**
* Build a ModelDefinitionConfig from a Venice catalog entry.
*
* Note: The `privacy` field from the catalog is not included in the output
* as ModelDefinitionConfig doesn't support custom metadata fields. Privacy
* mode is inherent to each model and documented in the catalog/docs.
*/
function buildVeniceModelDefinition(entry) {
	return {
		id: entry.id,
		name: entry.name,
		reasoning: entry.reasoning,
		input: [...entry.input],
		cost: VENICE_DEFAULT_COST,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		compat: { supportsUsageInStreaming: false }
	};
}
/**
* Discover models from Venice API with fallback to static catalog.
* The /models endpoint is public and doesn't require authentication.
*/
async function discoverVeniceModels() {
	if (process.env.VITEST) return VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
	try {
		const response = await fetch(`${VENICE_BASE_URL}/models`, { signal: AbortSignal.timeout(5e3) });
		if (!response.ok) {
			log$2.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
			return VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
		}
		const data = await response.json();
		if (!Array.isArray(data.data) || data.data.length === 0) {
			log$2.warn("No models found from API, using static catalog");
			return VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
		}
		const catalogById = new Map(VENICE_MODEL_CATALOG.map((m) => [m.id, m]));
		const models = [];
		for (const apiModel of data.data) {
			const catalogEntry = catalogById.get(apiModel.id);
			if (catalogEntry) models.push(buildVeniceModelDefinition(catalogEntry));
			else {
				const isReasoning = apiModel.model_spec.capabilities.supportsReasoning || apiModel.id.toLowerCase().includes("thinking") || apiModel.id.toLowerCase().includes("reason") || apiModel.id.toLowerCase().includes("r1");
				const hasVision = apiModel.model_spec.capabilities.supportsVision;
				models.push({
					id: apiModel.id,
					name: apiModel.model_spec.name || apiModel.id,
					reasoning: isReasoning,
					input: hasVision ? ["text", "image"] : ["text"],
					cost: VENICE_DEFAULT_COST,
					contextWindow: apiModel.model_spec.availableContextTokens || 128e3,
					maxTokens: 8192,
					compat: { supportsUsageInStreaming: false }
				});
			}
		}
		return models.length > 0 ? models : VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
	} catch (error) {
		log$2.warn(`Discovery failed: ${String(error)}, using static catalog`);
		return VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
	}
}

//#endregion
//#region src/agents/models-config.providers.ts
const MINIMAX_PORTAL_BASE_URL = "https://api.minimax.io/anthropic";
const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M2.1";
const MINIMAX_DEFAULT_VISION_MODEL_ID = "MiniMax-VL-01";
const MINIMAX_DEFAULT_CONTEXT_WINDOW = 2e5;
const MINIMAX_DEFAULT_MAX_TOKENS = 8192;
const MINIMAX_OAUTH_PLACEHOLDER = "minimax-oauth";
const MINIMAX_API_COST = {
	input: .3,
	output: 1.2,
	cacheRead: .03,
	cacheWrite: .12
};
function buildMinimaxModel(params) {
	return {
		id: params.id,
		name: params.name,
		reasoning: params.reasoning,
		input: params.input,
		cost: MINIMAX_API_COST,
		contextWindow: MINIMAX_DEFAULT_CONTEXT_WINDOW,
		maxTokens: MINIMAX_DEFAULT_MAX_TOKENS
	};
}
function buildMinimaxTextModel(params) {
	return buildMinimaxModel({
		...params,
		input: ["text"]
	});
}
const XIAOMI_BASE_URL = "https://api.xiaomimimo.com/anthropic";
const XIAOMI_DEFAULT_MODEL_ID = "mimo-v2-flash";
const XIAOMI_DEFAULT_CONTEXT_WINDOW = 262144;
const XIAOMI_DEFAULT_MAX_TOKENS = 8192;
const XIAOMI_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2.5";
const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 256e3;
const MOONSHOT_DEFAULT_MAX_TOKENS = 8192;
const MOONSHOT_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/";
const KIMI_CODING_DEFAULT_MODEL_ID = "k2p5";
const KIMI_CODING_DEFAULT_CONTEXT_WINDOW = 262144;
const KIMI_CODING_DEFAULT_MAX_TOKENS = 32768;
const KIMI_CODING_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const QWEN_PORTAL_BASE_URL = "https://portal.qwen.ai/v1";
const QWEN_PORTAL_OAUTH_PLACEHOLDER = "qwen-oauth";
const QWEN_PORTAL_DEFAULT_CONTEXT_WINDOW = 128e3;
const QWEN_PORTAL_DEFAULT_MAX_TOKENS = 8192;
const QWEN_PORTAL_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const OLLAMA_API_BASE_URL = OLLAMA_NATIVE_BASE_URL;
const OLLAMA_SHOW_CONCURRENCY = 8;
const OLLAMA_SHOW_MAX_MODELS = 200;
const OLLAMA_DEFAULT_CONTEXT_WINDOW = 128e3;
const OLLAMA_DEFAULT_MAX_TOKENS = 8192;
const OLLAMA_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MODEL_ID = "auto";
const OPENROUTER_DEFAULT_CONTEXT_WINDOW = 2e5;
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const VLLM_BASE_URL = "http://127.0.0.1:8000/v1";
const VLLM_DEFAULT_CONTEXT_WINDOW = 128e3;
const VLLM_DEFAULT_MAX_TOKENS = 8192;
const VLLM_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const QIANFAN_BASE_URL = "https://qianfan.baidubce.com/v2";
const QIANFAN_DEFAULT_MODEL_ID = "deepseek-v3.2";
const QIANFAN_DEFAULT_CONTEXT_WINDOW = 98304;
const QIANFAN_DEFAULT_MAX_TOKENS = 32768;
const QIANFAN_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_DEFAULT_MODEL_ID = "nvidia/llama-3.1-nemotron-70b-instruct";
const NVIDIA_DEFAULT_CONTEXT_WINDOW = 131072;
const NVIDIA_DEFAULT_MAX_TOKENS = 4096;
const NVIDIA_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const log$1 = createSubsystemLogger("agents/model-providers");
/**
* Derive the Ollama native API base URL from a configured base URL.
*
* Users typically configure `baseUrl` with a `/v1` suffix (e.g.
* `http://192.168.20.14:11434/v1`) for the OpenAI-compatible endpoint.
* The native Ollama API lives at the root (e.g. `/api/tags`), so we
* strip the `/v1` suffix when present.
*/
function resolveOllamaApiBase(configuredBaseUrl) {
	if (!configuredBaseUrl) return OLLAMA_API_BASE_URL;
	return configuredBaseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}
async function queryOllamaContextWindow(apiBase, modelName) {
	try {
		const response = await fetch(`${apiBase}/api/show`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: modelName }),
			signal: AbortSignal.timeout(3e3)
		});
		if (!response.ok) return;
		const data = await response.json();
		if (!data.model_info) return;
		for (const [key, value] of Object.entries(data.model_info)) if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value)) {
			const contextWindow = Math.floor(value);
			if (contextWindow > 0) return contextWindow;
		}
		return;
	} catch {
		return;
	}
}
async function discoverOllamaModels(baseUrl, opts) {
	if (process.env.VITEST || false) return [];
	try {
		const apiBase = resolveOllamaApiBase(baseUrl);
		const response = await fetch(`${apiBase}/api/tags`, { signal: AbortSignal.timeout(5e3) });
		if (!response.ok) {
			if (!opts?.quiet) log$1.warn(`Failed to discover Ollama models: ${response.status}`);
			return [];
		}
		const data = await response.json();
		if (!data.models || data.models.length === 0) {
			log$1.debug("No Ollama models found on local instance");
			return [];
		}
		const modelsToInspect = data.models.slice(0, OLLAMA_SHOW_MAX_MODELS);
		if (modelsToInspect.length < data.models.length && !opts?.quiet) log$1.warn(`Capping Ollama /api/show inspection to ${OLLAMA_SHOW_MAX_MODELS} models (received ${data.models.length})`);
		const discovered = [];
		for (let index = 0; index < modelsToInspect.length; index += OLLAMA_SHOW_CONCURRENCY) {
			const batch = modelsToInspect.slice(index, index + OLLAMA_SHOW_CONCURRENCY);
			const batchDiscovered = await Promise.all(batch.map(async (model) => {
				const modelId = model.name;
				const contextWindow = await queryOllamaContextWindow(apiBase, modelId);
				return {
					id: modelId,
					name: modelId,
					reasoning: modelId.toLowerCase().includes("r1") || modelId.toLowerCase().includes("reasoning"),
					input: ["text"],
					cost: OLLAMA_DEFAULT_COST,
					contextWindow: contextWindow ?? OLLAMA_DEFAULT_CONTEXT_WINDOW,
					maxTokens: OLLAMA_DEFAULT_MAX_TOKENS
				};
			}));
			discovered.push(...batchDiscovered);
		}
		return discovered;
	} catch (error) {
		if (!opts?.quiet) log$1.warn(`Failed to discover Ollama models: ${String(error)}`);
		return [];
	}
}
async function discoverVllmModels(baseUrl, apiKey) {
	if (process.env.VITEST || false) return [];
	const url = `${baseUrl.trim().replace(/\/+$/, "")}/models`;
	try {
		const trimmedApiKey = apiKey?.trim();
		const response = await fetch(url, {
			headers: trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : void 0,
			signal: AbortSignal.timeout(5e3)
		});
		if (!response.ok) {
			log$1.warn(`Failed to discover vLLM models: ${response.status}`);
			return [];
		}
		const models = (await response.json()).data ?? [];
		if (models.length === 0) {
			log$1.warn("No vLLM models found on local instance");
			return [];
		}
		return models.map((m) => ({ id: typeof m.id === "string" ? m.id.trim() : "" })).filter((m) => Boolean(m.id)).map((m) => {
			const modelId = m.id;
			const lower = modelId.toLowerCase();
			return {
				id: modelId,
				name: modelId,
				reasoning: lower.includes("r1") || lower.includes("reasoning") || lower.includes("think"),
				input: ["text"],
				cost: VLLM_DEFAULT_COST,
				contextWindow: VLLM_DEFAULT_CONTEXT_WINDOW,
				maxTokens: VLLM_DEFAULT_MAX_TOKENS
			};
		});
	} catch (error) {
		log$1.warn(`Failed to discover vLLM models: ${String(error)}`);
		return [];
	}
}
function normalizeApiKeyConfig(value) {
	const trimmed = value.trim();
	return /^\$\{([A-Z0-9_]+)\}$/.exec(trimmed)?.[1] ?? trimmed;
}
function resolveEnvApiKeyVarName(provider) {
	const resolved = resolveEnvApiKey(provider);
	if (!resolved) return;
	const match = /^(?:env: |shell env: )([A-Z0-9_]+)$/.exec(resolved.source);
	return match ? match[1] : void 0;
}
function resolveAwsSdkApiKeyVarName() {
	return resolveAwsSdkEnvVarName() ?? "AWS_PROFILE";
}
function resolveApiKeyFromProfiles(params) {
	const ids = listProfilesForProvider(params.store, params.provider);
	for (const id of ids) {
		const cred = params.store.profiles[id];
		if (!cred) continue;
		if (cred.type === "api_key") {
			if (cred.key?.trim()) return cred.key;
			const keyRef = coerceSecretRef(cred.keyRef);
			if (keyRef?.source === "env" && keyRef.id.trim()) return keyRef.id.trim();
			continue;
		}
		if (cred.type === "token") {
			if (cred.token?.trim()) return cred.token;
			const tokenRef = coerceSecretRef(cred.tokenRef);
			if (tokenRef?.source === "env" && tokenRef.id.trim()) return tokenRef.id.trim();
			continue;
		}
	}
}
function normalizeGoogleModelId(id) {
	if (id === "gemini-3-pro") return "gemini-3-pro-preview";
	if (id === "gemini-3-flash") return "gemini-3-flash-preview";
	return id;
}
const ANTIGRAVITY_BARE_PRO_IDS = new Set([
	"gemini-3-pro",
	"gemini-3.1-pro",
	"gemini-3-1-pro"
]);
function normalizeAntigravityModelId(id) {
	if (ANTIGRAVITY_BARE_PRO_IDS.has(id)) return `${id}-low`;
	return id;
}
function normalizeProviderModels(provider, normalizeId) {
	let mutated = false;
	const models = provider.models.map((model) => {
		const nextId = normalizeId(model.id);
		if (nextId === model.id) return model;
		mutated = true;
		return {
			...model,
			id: nextId
		};
	});
	return mutated ? {
		...provider,
		models
	} : provider;
}
function normalizeGoogleProvider(provider) {
	return normalizeProviderModels(provider, normalizeGoogleModelId);
}
function normalizeAntigravityProvider(provider) {
	return normalizeProviderModels(provider, normalizeAntigravityModelId);
}
function normalizeProviders(params) {
	const { providers } = params;
	if (!providers) return providers;
	const authStore = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
	let mutated = false;
	const next = {};
	for (const [key, provider] of Object.entries(providers)) {
		const normalizedKey = key.trim();
		let normalizedProvider = provider;
		const configuredApiKey = normalizedProvider.apiKey;
		if (typeof configuredApiKey === "string" && normalizeApiKeyConfig(configuredApiKey) !== configuredApiKey) {
			mutated = true;
			normalizedProvider = {
				...normalizedProvider,
				apiKey: normalizeApiKeyConfig(configuredApiKey)
			};
		}
		const hasModels = Array.isArray(normalizedProvider.models) && normalizedProvider.models.length > 0;
		const normalizedApiKey = normalizeOptionalSecretInput(normalizedProvider.apiKey);
		const hasConfiguredApiKey = Boolean(normalizedApiKey || normalizedProvider.apiKey);
		if (hasModels && !hasConfiguredApiKey) if ((normalizedProvider.auth ?? (normalizedKey === "amazon-bedrock" ? "aws-sdk" : void 0)) === "aws-sdk") {
			const apiKey = resolveAwsSdkApiKeyVarName();
			mutated = true;
			normalizedProvider = {
				...normalizedProvider,
				apiKey
			};
		} else {
			const fromEnv = resolveEnvApiKeyVarName(normalizedKey);
			const fromProfiles = resolveApiKeyFromProfiles({
				provider: normalizedKey,
				store: authStore
			});
			const apiKey = fromEnv ?? fromProfiles;
			if (apiKey?.trim()) {
				mutated = true;
				normalizedProvider = {
					...normalizedProvider,
					apiKey
				};
			}
		}
		if (normalizedKey === "google") {
			const googleNormalized = normalizeGoogleProvider(normalizedProvider);
			if (googleNormalized !== normalizedProvider) mutated = true;
			normalizedProvider = googleNormalized;
		}
		if (normalizedKey === "google-antigravity") {
			const antigravityNormalized = normalizeAntigravityProvider(normalizedProvider);
			if (antigravityNormalized !== normalizedProvider) mutated = true;
			normalizedProvider = antigravityNormalized;
		}
		next[key] = normalizedProvider;
	}
	return mutated ? next : providers;
}
function buildMinimaxProvider() {
	return {
		baseUrl: MINIMAX_PORTAL_BASE_URL,
		api: "anthropic-messages",
		authHeader: true,
		models: [
			buildMinimaxTextModel({
				id: MINIMAX_DEFAULT_MODEL_ID,
				name: "MiniMax M2.1",
				reasoning: false
			}),
			buildMinimaxTextModel({
				id: "MiniMax-M2.1-lightning",
				name: "MiniMax M2.1 Lightning",
				reasoning: false
			}),
			buildMinimaxModel({
				id: MINIMAX_DEFAULT_VISION_MODEL_ID,
				name: "MiniMax VL 01",
				reasoning: false,
				input: ["text", "image"]
			}),
			buildMinimaxTextModel({
				id: "MiniMax-M2.5",
				name: "MiniMax M2.5",
				reasoning: true
			}),
			buildMinimaxTextModel({
				id: "MiniMax-M2.5-Lightning",
				name: "MiniMax M2.5 Lightning",
				reasoning: true
			})
		]
	};
}
function buildMinimaxPortalProvider() {
	return {
		baseUrl: MINIMAX_PORTAL_BASE_URL,
		api: "anthropic-messages",
		authHeader: true,
		models: [buildMinimaxTextModel({
			id: MINIMAX_DEFAULT_MODEL_ID,
			name: "MiniMax M2.1",
			reasoning: false
		}), buildMinimaxTextModel({
			id: "MiniMax-M2.5",
			name: "MiniMax M2.5",
			reasoning: true
		})]
	};
}
function buildMoonshotProvider() {
	return {
		baseUrl: MOONSHOT_BASE_URL,
		api: "openai-completions",
		models: [{
			id: MOONSHOT_DEFAULT_MODEL_ID,
			name: "Kimi K2.5",
			reasoning: false,
			input: ["text", "image"],
			cost: MOONSHOT_DEFAULT_COST,
			contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
			maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS
		}]
	};
}
function buildKimiCodingProvider() {
	return {
		baseUrl: KIMI_CODING_BASE_URL,
		api: "anthropic-messages",
		models: [{
			id: KIMI_CODING_DEFAULT_MODEL_ID,
			name: "Kimi for Coding",
			reasoning: true,
			input: ["text", "image"],
			cost: KIMI_CODING_DEFAULT_COST,
			contextWindow: KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
			maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS
		}]
	};
}
function buildQwenPortalProvider() {
	return {
		baseUrl: QWEN_PORTAL_BASE_URL,
		api: "openai-completions",
		models: [{
			id: "coder-model",
			name: "Qwen Coder",
			reasoning: false,
			input: ["text"],
			cost: QWEN_PORTAL_DEFAULT_COST,
			contextWindow: QWEN_PORTAL_DEFAULT_CONTEXT_WINDOW,
			maxTokens: QWEN_PORTAL_DEFAULT_MAX_TOKENS
		}, {
			id: "vision-model",
			name: "Qwen Vision",
			reasoning: false,
			input: ["text", "image"],
			cost: QWEN_PORTAL_DEFAULT_COST,
			contextWindow: QWEN_PORTAL_DEFAULT_CONTEXT_WINDOW,
			maxTokens: QWEN_PORTAL_DEFAULT_MAX_TOKENS
		}]
	};
}
function buildSyntheticProvider() {
	return {
		baseUrl: SYNTHETIC_BASE_URL,
		api: "anthropic-messages",
		models: SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition)
	};
}
function buildDoubaoProvider() {
	return {
		baseUrl: DOUBAO_BASE_URL,
		api: "openai-completions",
		models: DOUBAO_MODEL_CATALOG.map(buildDoubaoModelDefinition)
	};
}
function buildDoubaoCodingProvider() {
	return {
		baseUrl: DOUBAO_CODING_BASE_URL,
		api: "openai-completions",
		models: DOUBAO_CODING_MODEL_CATALOG.map(buildDoubaoModelDefinition)
	};
}
function buildBytePlusProvider() {
	return {
		baseUrl: BYTEPLUS_BASE_URL,
		api: "openai-completions",
		models: BYTEPLUS_MODEL_CATALOG.map(buildBytePlusModelDefinition)
	};
}
function buildBytePlusCodingProvider() {
	return {
		baseUrl: BYTEPLUS_CODING_BASE_URL,
		api: "openai-completions",
		models: BYTEPLUS_CODING_MODEL_CATALOG.map(buildBytePlusModelDefinition)
	};
}
function buildXiaomiProvider() {
	return {
		baseUrl: XIAOMI_BASE_URL,
		api: "anthropic-messages",
		models: [{
			id: XIAOMI_DEFAULT_MODEL_ID,
			name: "Xiaomi MiMo V2 Flash",
			reasoning: false,
			input: ["text"],
			cost: XIAOMI_DEFAULT_COST,
			contextWindow: XIAOMI_DEFAULT_CONTEXT_WINDOW,
			maxTokens: XIAOMI_DEFAULT_MAX_TOKENS
		}]
	};
}
async function buildVeniceProvider() {
	return {
		baseUrl: VENICE_BASE_URL,
		api: "openai-completions",
		models: await discoverVeniceModels()
	};
}
async function buildOllamaProvider(configuredBaseUrl, opts) {
	const models = await discoverOllamaModels(configuredBaseUrl, opts);
	return {
		baseUrl: resolveOllamaApiBase(configuredBaseUrl),
		api: "ollama",
		models
	};
}
async function buildHuggingfaceProvider(apiKey) {
	const resolvedSecret = apiKey?.trim() !== "" ? /^[A-Z][A-Z0-9_]*$/.test(apiKey.trim()) ? (process.env[apiKey.trim()] ?? "").trim() : apiKey.trim() : "";
	return {
		baseUrl: HUGGINGFACE_BASE_URL,
		api: "openai-completions",
		models: resolvedSecret !== "" ? await discoverHuggingfaceModels(resolvedSecret) : HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition)
	};
}
function buildTogetherProvider() {
	return {
		baseUrl: TOGETHER_BASE_URL,
		api: "openai-completions",
		models: TOGETHER_MODEL_CATALOG.map(buildTogetherModelDefinition)
	};
}
function buildOpenrouterProvider() {
	return {
		baseUrl: OPENROUTER_BASE_URL,
		api: "openai-completions",
		models: [{
			id: OPENROUTER_DEFAULT_MODEL_ID,
			name: "OpenRouter Auto",
			reasoning: false,
			input: ["text", "image"],
			cost: OPENROUTER_DEFAULT_COST,
			contextWindow: OPENROUTER_DEFAULT_CONTEXT_WINDOW,
			maxTokens: OPENROUTER_DEFAULT_MAX_TOKENS
		}]
	};
}
async function buildVllmProvider(params) {
	const baseUrl = (params?.baseUrl?.trim() || VLLM_BASE_URL).replace(/\/+$/, "");
	return {
		baseUrl,
		api: "openai-completions",
		models: await discoverVllmModels(baseUrl, params?.apiKey)
	};
}
function buildQianfanProvider() {
	return {
		baseUrl: QIANFAN_BASE_URL,
		api: "openai-completions",
		models: [{
			id: QIANFAN_DEFAULT_MODEL_ID,
			name: "DEEPSEEK V3.2",
			reasoning: true,
			input: ["text"],
			cost: QIANFAN_DEFAULT_COST,
			contextWindow: QIANFAN_DEFAULT_CONTEXT_WINDOW,
			maxTokens: QIANFAN_DEFAULT_MAX_TOKENS
		}, {
			id: "ernie-5.0-thinking-preview",
			name: "ERNIE-5.0-Thinking-Preview",
			reasoning: true,
			input: ["text", "image"],
			cost: QIANFAN_DEFAULT_COST,
			contextWindow: 119e3,
			maxTokens: 64e3
		}]
	};
}
function buildNvidiaProvider() {
	return {
		baseUrl: NVIDIA_BASE_URL,
		api: "openai-completions",
		models: [
			{
				id: NVIDIA_DEFAULT_MODEL_ID,
				name: "NVIDIA Llama 3.1 Nemotron 70B Instruct",
				reasoning: false,
				input: ["text"],
				cost: NVIDIA_DEFAULT_COST,
				contextWindow: NVIDIA_DEFAULT_CONTEXT_WINDOW,
				maxTokens: NVIDIA_DEFAULT_MAX_TOKENS
			},
			{
				id: "meta/llama-3.3-70b-instruct",
				name: "Meta Llama 3.3 70B Instruct",
				reasoning: false,
				input: ["text"],
				cost: NVIDIA_DEFAULT_COST,
				contextWindow: 131072,
				maxTokens: 4096
			},
			{
				id: "nvidia/mistral-nemo-minitron-8b-8k-instruct",
				name: "NVIDIA Mistral NeMo Minitron 8B Instruct",
				reasoning: false,
				input: ["text"],
				cost: NVIDIA_DEFAULT_COST,
				contextWindow: 8192,
				maxTokens: 2048
			}
		]
	};
}
function buildKilocodeProvider() {
	return {
		baseUrl: KILOCODE_BASE_URL,
		api: "openai-completions",
		models: KILOCODE_MODEL_CATALOG.map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: model.input,
			cost: KILOCODE_DEFAULT_COST,
			contextWindow: model.contextWindow ?? KILOCODE_DEFAULT_CONTEXT_WINDOW,
			maxTokens: model.maxTokens ?? KILOCODE_DEFAULT_MAX_TOKENS
		}))
	};
}
async function resolveImplicitProviders(params) {
	const providers = {};
	const authStore = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
	const minimaxKey = resolveEnvApiKeyVarName("minimax") ?? resolveApiKeyFromProfiles({
		provider: "minimax",
		store: authStore
	});
	if (minimaxKey) providers.minimax = {
		...buildMinimaxProvider(),
		apiKey: minimaxKey
	};
	if (listProfilesForProvider(authStore, "minimax-portal").length > 0) providers["minimax-portal"] = {
		...buildMinimaxPortalProvider(),
		apiKey: MINIMAX_OAUTH_PLACEHOLDER
	};
	const moonshotKey = resolveEnvApiKeyVarName("moonshot") ?? resolveApiKeyFromProfiles({
		provider: "moonshot",
		store: authStore
	});
	if (moonshotKey) providers.moonshot = {
		...buildMoonshotProvider(),
		apiKey: moonshotKey
	};
	const kimiCodingKey = resolveEnvApiKeyVarName("kimi-coding") ?? resolveApiKeyFromProfiles({
		provider: "kimi-coding",
		store: authStore
	});
	if (kimiCodingKey) providers["kimi-coding"] = {
		...buildKimiCodingProvider(),
		apiKey: kimiCodingKey
	};
	const syntheticKey = resolveEnvApiKeyVarName("synthetic") ?? resolveApiKeyFromProfiles({
		provider: "synthetic",
		store: authStore
	});
	if (syntheticKey) providers.synthetic = {
		...buildSyntheticProvider(),
		apiKey: syntheticKey
	};
	const veniceKey = resolveEnvApiKeyVarName("venice") ?? resolveApiKeyFromProfiles({
		provider: "venice",
		store: authStore
	});
	if (veniceKey) providers.venice = {
		...await buildVeniceProvider(),
		apiKey: veniceKey
	};
	if (listProfilesForProvider(authStore, "qwen-portal").length > 0) providers["qwen-portal"] = {
		...buildQwenPortalProvider(),
		apiKey: QWEN_PORTAL_OAUTH_PLACEHOLDER
	};
	const volcengineKey = resolveEnvApiKeyVarName("volcengine") ?? resolveApiKeyFromProfiles({
		provider: "volcengine",
		store: authStore
	});
	if (volcengineKey) {
		providers.volcengine = {
			...buildDoubaoProvider(),
			apiKey: volcengineKey
		};
		providers["volcengine-plan"] = {
			...buildDoubaoCodingProvider(),
			apiKey: volcengineKey
		};
	}
	const byteplusKey = resolveEnvApiKeyVarName("byteplus") ?? resolveApiKeyFromProfiles({
		provider: "byteplus",
		store: authStore
	});
	if (byteplusKey) {
		providers.byteplus = {
			...buildBytePlusProvider(),
			apiKey: byteplusKey
		};
		providers["byteplus-plan"] = {
			...buildBytePlusCodingProvider(),
			apiKey: byteplusKey
		};
	}
	const xiaomiKey = resolveEnvApiKeyVarName("xiaomi") ?? resolveApiKeyFromProfiles({
		provider: "xiaomi",
		store: authStore
	});
	if (xiaomiKey) providers.xiaomi = {
		...buildXiaomiProvider(),
		apiKey: xiaomiKey
	};
	const cloudflareProfiles = listProfilesForProvider(authStore, "cloudflare-ai-gateway");
	for (const profileId of cloudflareProfiles) {
		const cred = authStore.profiles[profileId];
		if (cred?.type !== "api_key") continue;
		const accountId = cred.metadata?.accountId?.trim();
		const gatewayId = cred.metadata?.gatewayId?.trim();
		if (!accountId || !gatewayId) continue;
		const baseUrl = resolveCloudflareAiGatewayBaseUrl({
			accountId,
			gatewayId
		});
		if (!baseUrl) continue;
		const apiKey = resolveEnvApiKeyVarName("cloudflare-ai-gateway") ?? cred.key?.trim() ?? "";
		if (!apiKey) continue;
		providers["cloudflare-ai-gateway"] = {
			baseUrl,
			api: "anthropic-messages",
			apiKey,
			models: [buildCloudflareAiGatewayModelDefinition()]
		};
		break;
	}
	const ollamaKey = resolveEnvApiKeyVarName("ollama") ?? resolveApiKeyFromProfiles({
		provider: "ollama",
		store: authStore
	});
	const explicitOllama = params.explicitProviders?.ollama;
	if (Array.isArray(explicitOllama?.models) && explicitOllama.models.length > 0 && explicitOllama) providers.ollama = {
		...explicitOllama,
		baseUrl: resolveOllamaApiBase(explicitOllama.baseUrl),
		api: explicitOllama.api ?? "ollama",
		apiKey: ollamaKey ?? explicitOllama.apiKey ?? "ollama-local"
	};
	else {
		const ollamaBaseUrl = explicitOllama?.baseUrl;
		const ollamaProvider = await buildOllamaProvider(ollamaBaseUrl, { quiet: !ollamaKey && !Boolean(explicitOllama) });
		if (ollamaProvider.models.length > 0 || ollamaKey || explicitOllama?.apiKey) providers.ollama = {
			...ollamaProvider,
			apiKey: ollamaKey ?? explicitOllama?.apiKey ?? "ollama-local"
		};
	}
	if (!params.explicitProviders?.vllm) {
		const vllmEnvVar = resolveEnvApiKeyVarName("vllm");
		const vllmProfileKey = resolveApiKeyFromProfiles({
			provider: "vllm",
			store: authStore
		});
		const vllmKey = vllmEnvVar ?? vllmProfileKey;
		if (vllmKey) providers.vllm = {
			...await buildVllmProvider({ apiKey: (vllmEnvVar ? process.env[vllmEnvVar]?.trim() ?? "" : vllmProfileKey ?? "") || void 0 }),
			apiKey: vllmKey
		};
	}
	const togetherKey = resolveEnvApiKeyVarName("together") ?? resolveApiKeyFromProfiles({
		provider: "together",
		store: authStore
	});
	if (togetherKey) providers.together = {
		...buildTogetherProvider(),
		apiKey: togetherKey
	};
	const huggingfaceKey = resolveEnvApiKeyVarName("huggingface") ?? resolveApiKeyFromProfiles({
		provider: "huggingface",
		store: authStore
	});
	if (huggingfaceKey) providers.huggingface = {
		...await buildHuggingfaceProvider(huggingfaceKey),
		apiKey: huggingfaceKey
	};
	const qianfanKey = resolveEnvApiKeyVarName("qianfan") ?? resolveApiKeyFromProfiles({
		provider: "qianfan",
		store: authStore
	});
	if (qianfanKey) providers.qianfan = {
		...buildQianfanProvider(),
		apiKey: qianfanKey
	};
	const openrouterKey = resolveEnvApiKeyVarName("openrouter") ?? resolveApiKeyFromProfiles({
		provider: "openrouter",
		store: authStore
	});
	if (openrouterKey) providers.openrouter = {
		...buildOpenrouterProvider(),
		apiKey: openrouterKey
	};
	const nvidiaKey = resolveEnvApiKeyVarName("nvidia") ?? resolveApiKeyFromProfiles({
		provider: "nvidia",
		store: authStore
	});
	if (nvidiaKey) providers.nvidia = {
		...buildNvidiaProvider(),
		apiKey: nvidiaKey
	};
	const kilocodeKey = resolveEnvApiKeyVarName("kilocode") ?? resolveApiKeyFromProfiles({
		provider: "kilocode",
		store: authStore
	});
	if (kilocodeKey) providers.kilocode = {
		...buildKilocodeProvider(),
		apiKey: kilocodeKey
	};
	return providers;
}
async function resolveImplicitCopilotProvider(params) {
	const env = params.env ?? process.env;
	const authStore = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
	const hasProfile = listProfilesForProvider(authStore, "github-copilot").length > 0;
	const githubToken = (env.COPILOT_GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "").trim();
	if (!hasProfile && !githubToken) return null;
	let selectedGithubToken = githubToken;
	if (!selectedGithubToken && hasProfile) {
		const profileId = listProfilesForProvider(authStore, "github-copilot")[0];
		const profile = profileId ? authStore.profiles[profileId] : void 0;
		if (profile && profile.type === "token") {
			selectedGithubToken = profile.token?.trim() ?? "";
			if (!selectedGithubToken) {
				const tokenRef = coerceSecretRef(profile.tokenRef);
				if (tokenRef?.source === "env" && tokenRef.id.trim()) selectedGithubToken = (env[tokenRef.id] ?? process.env[tokenRef.id] ?? "").trim();
			}
		}
	}
	let baseUrl = DEFAULT_COPILOT_API_BASE_URL;
	if (selectedGithubToken) try {
		baseUrl = (await resolveCopilotApiToken({
			githubToken: selectedGithubToken,
			env
		})).baseUrl;
	} catch {
		baseUrl = DEFAULT_COPILOT_API_BASE_URL;
	}
	return {
		baseUrl,
		models: []
	};
}
async function resolveImplicitBedrockProvider(params) {
	const env = params.env ?? process.env;
	const discoveryConfig = params.config?.models?.bedrockDiscovery;
	const enabled = discoveryConfig?.enabled;
	const hasAwsCreds = resolveAwsSdkEnvVarName(env) !== void 0;
	if (enabled === false) return null;
	if (enabled !== true && !hasAwsCreds) return null;
	const region = discoveryConfig?.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";
	const models = await discoverBedrockModels({
		region,
		config: discoveryConfig
	});
	if (models.length === 0) return null;
	return {
		baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
		api: "bedrock-converse-stream",
		auth: "aws-sdk",
		models
	};
}

//#endregion
//#region src/agents/model-selection.ts
const log = createSubsystemLogger("model-selection");
const ANTHROPIC_MODEL_ALIASES = {
	"opus-4.6": "claude-opus-4-6",
	"opus-4.5": "claude-opus-4-5",
	"sonnet-4.6": "claude-sonnet-4-6",
	"sonnet-4.5": "claude-sonnet-4-5"
};
const OPENAI_CODEX_OAUTH_MODEL_PREFIXES = ["gpt-5.3-codex"];
function normalizeAliasKey(value) {
	return value.trim().toLowerCase();
}
function modelKey(provider, model) {
	return `${provider}/${model}`;
}
function normalizeProviderId(provider) {
	const normalized = provider.trim().toLowerCase();
	if (normalized === "z.ai" || normalized === "z-ai") return "zai";
	if (normalized === "opencode-zen") return "opencode";
	if (normalized === "qwen") return "qwen-portal";
	if (normalized === "kimi-code") return "kimi-coding";
	if (normalized === "bedrock" || normalized === "aws-bedrock") return "amazon-bedrock";
	if (normalized === "bytedance" || normalized === "doubao") return "volcengine";
	return normalized;
}
function findNormalizedProviderValue(entries, provider) {
	if (!entries) return;
	const providerKey = normalizeProviderId(provider);
	for (const [key, value] of Object.entries(entries)) if (normalizeProviderId(key) === providerKey) return value;
}
function isCliProvider(provider, cfg) {
	const normalized = normalizeProviderId(provider);
	if (normalized === "claude-cli") return true;
	if (normalized === "codex-cli") return true;
	const backends = cfg?.agents?.defaults?.cliBackends ?? {};
	return Object.keys(backends).some((key) => normalizeProviderId(key) === normalized);
}
function normalizeAnthropicModelId(model) {
	const trimmed = model.trim();
	if (!trimmed) return trimmed;
	return ANTHROPIC_MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}
function normalizeProviderModelId(provider, model) {
	if (provider === "anthropic") return normalizeAnthropicModelId(model);
	if (provider === "vercel-ai-gateway" && !model.includes("/")) {
		const normalizedAnthropicModel = normalizeAnthropicModelId(model);
		if (normalizedAnthropicModel.startsWith("claude-")) return `anthropic/${normalizedAnthropicModel}`;
	}
	if (provider === "google") return normalizeGoogleModelId(model);
	if (provider === "openrouter" && !model.includes("/")) return `openrouter/${model}`;
	return model;
}
function shouldUseOpenAICodexProvider(provider, model) {
	if (provider !== "openai") return false;
	const normalized = model.trim().toLowerCase();
	if (!normalized) return false;
	return OPENAI_CODEX_OAUTH_MODEL_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`));
}
function normalizeModelRef(provider, model) {
	const normalizedProvider = normalizeProviderId(provider);
	const normalizedModel = normalizeProviderModelId(normalizedProvider, model.trim());
	if (shouldUseOpenAICodexProvider(normalizedProvider, normalizedModel)) return {
		provider: "openai-codex",
		model: normalizedModel
	};
	return {
		provider: normalizedProvider,
		model: normalizedModel
	};
}
function parseModelRef(raw, defaultProvider) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const slash = trimmed.indexOf("/");
	if (slash === -1) return normalizeModelRef(defaultProvider, trimmed);
	const providerRaw = trimmed.slice(0, slash).trim();
	const model = trimmed.slice(slash + 1).trim();
	if (!providerRaw || !model) return null;
	return normalizeModelRef(providerRaw, model);
}
function resolveAllowlistModelKey(raw, defaultProvider) {
	const parsed = parseModelRef(raw, defaultProvider);
	if (!parsed) return null;
	return modelKey(parsed.provider, parsed.model);
}
function buildConfiguredAllowlistKeys(params) {
	const rawAllowlist = Object.keys(params.cfg?.agents?.defaults?.models ?? {});
	if (rawAllowlist.length === 0) return null;
	const keys = /* @__PURE__ */ new Set();
	for (const raw of rawAllowlist) {
		const key = resolveAllowlistModelKey(String(raw ?? ""), params.defaultProvider);
		if (key) keys.add(key);
	}
	return keys.size > 0 ? keys : null;
}
function buildModelAliasIndex(params) {
	const byAlias = /* @__PURE__ */ new Map();
	const byKey = /* @__PURE__ */ new Map();
	const rawModels = params.cfg.agents?.defaults?.models ?? {};
	for (const [keyRaw, entryRaw] of Object.entries(rawModels)) {
		const parsed = parseModelRef(String(keyRaw ?? ""), params.defaultProvider);
		if (!parsed) continue;
		const alias = String(entryRaw?.alias ?? "").trim();
		if (!alias) continue;
		const aliasKey = normalizeAliasKey(alias);
		byAlias.set(aliasKey, {
			alias,
			ref: parsed
		});
		const key = modelKey(parsed.provider, parsed.model);
		const existing = byKey.get(key) ?? [];
		existing.push(alias);
		byKey.set(key, existing);
	}
	return {
		byAlias,
		byKey
	};
}
function resolveModelRefFromString(params) {
	const { model } = splitTrailingAuthProfile(params.raw);
	if (!model) return null;
	if (!model.includes("/")) {
		const aliasKey = normalizeAliasKey(model);
		const aliasMatch = params.aliasIndex?.byAlias.get(aliasKey);
		if (aliasMatch) return {
			ref: aliasMatch.ref,
			alias: aliasMatch.alias
		};
	}
	const parsed = parseModelRef(model, params.defaultProvider);
	if (!parsed) return null;
	return { ref: parsed };
}
function resolveConfiguredModelRef(params) {
	const rawModel = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model) ?? "";
	if (rawModel) {
		const trimmed = rawModel.trim();
		const aliasIndex = buildModelAliasIndex({
			cfg: params.cfg,
			defaultProvider: params.defaultProvider
		});
		if (!trimmed.includes("/")) {
			const aliasKey = normalizeAliasKey(trimmed);
			const aliasMatch = aliasIndex.byAlias.get(aliasKey);
			if (aliasMatch) return aliasMatch.ref;
			log.warn(`Model "${trimmed}" specified without provider. Falling back to "anthropic/${trimmed}". Please use "anthropic/${trimmed}" in your config.`);
			return {
				provider: "anthropic",
				model: trimmed
			};
		}
		const resolved = resolveModelRefFromString({
			raw: trimmed,
			defaultProvider: params.defaultProvider,
			aliasIndex
		});
		if (resolved) return resolved.ref;
	}
	return {
		provider: params.defaultProvider,
		model: params.defaultModel
	};
}
function resolveDefaultModelForAgent(params) {
	const agentModelOverride = params.agentId ? resolveAgentEffectiveModelPrimary(params.cfg, params.agentId) : void 0;
	return resolveConfiguredModelRef({
		cfg: agentModelOverride && agentModelOverride.length > 0 ? {
			...params.cfg,
			agents: {
				...params.cfg.agents,
				defaults: {
					...params.cfg.agents?.defaults,
					model: {
						...toAgentModelListLike(params.cfg.agents?.defaults?.model),
						primary: agentModelOverride
					}
				}
			}
		} : params.cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
}
function resolveSubagentConfiguredModelSelection(params) {
	const agentConfig = resolveAgentConfig(params.cfg, params.agentId);
	return normalizeModelSelection(agentConfig?.subagents?.model) ?? normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model) ?? normalizeModelSelection(agentConfig?.model);
}
function resolveSubagentSpawnModelSelection(params) {
	const runtimeDefault = resolveDefaultModelForAgent({
		cfg: params.cfg,
		agentId: params.agentId
	});
	return normalizeModelSelection(params.modelOverride) ?? resolveSubagentConfiguredModelSelection({
		cfg: params.cfg,
		agentId: params.agentId
	}) ?? normalizeModelSelection(resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model)) ?? `${runtimeDefault.provider}/${runtimeDefault.model}`;
}
function buildAllowedModelSet(params) {
	const rawAllowlist = (() => {
		const modelMap = params.cfg.agents?.defaults?.models ?? {};
		return Object.keys(modelMap);
	})();
	const allowAny = rawAllowlist.length === 0;
	const defaultModel = params.defaultModel?.trim();
	const defaultRef = defaultModel && params.defaultProvider ? parseModelRef(defaultModel, params.defaultProvider) : null;
	const defaultKey = defaultRef ? modelKey(defaultRef.provider, defaultRef.model) : void 0;
	const catalogKeys = new Set(params.catalog.map((entry) => modelKey(entry.provider, entry.id)));
	if (allowAny) {
		if (defaultKey) catalogKeys.add(defaultKey);
		return {
			allowAny: true,
			allowedCatalog: params.catalog,
			allowedKeys: catalogKeys
		};
	}
	const allowedKeys = /* @__PURE__ */ new Set();
	const syntheticCatalogEntries = /* @__PURE__ */ new Map();
	for (const raw of rawAllowlist) {
		const parsed = parseModelRef(String(raw), params.defaultProvider);
		if (!parsed) continue;
		const key = modelKey(parsed.provider, parsed.model);
		allowedKeys.add(key);
		if (!catalogKeys.has(key) && !syntheticCatalogEntries.has(key)) syntheticCatalogEntries.set(key, {
			id: parsed.model,
			name: parsed.model,
			provider: parsed.provider
		});
	}
	if (defaultKey) allowedKeys.add(defaultKey);
	const allowedCatalog = [...params.catalog.filter((entry) => allowedKeys.has(modelKey(entry.provider, entry.id))), ...syntheticCatalogEntries.values()];
	if (allowedCatalog.length === 0 && allowedKeys.size === 0) {
		if (defaultKey) catalogKeys.add(defaultKey);
		return {
			allowAny: true,
			allowedCatalog: params.catalog,
			allowedKeys: catalogKeys
		};
	}
	return {
		allowAny: false,
		allowedCatalog,
		allowedKeys
	};
}
function resolveThinkingDefault(params) {
	const configured = params.cfg.agents?.defaults?.thinkingDefault;
	if (configured) return configured;
	if ((params.catalog?.find((entry) => entry.provider === params.provider && entry.id === params.model))?.reasoning) return "low";
	return "off";
}
/** Default reasoning level when session/directive do not set it: "on" if model supports reasoning, else "off". */
function resolveReasoningDefault(params) {
	const key = modelKey(params.provider, params.model);
	return (params.catalog?.find((entry) => entry.provider === params.provider && entry.id === params.model || entry.provider === key && entry.id === params.model))?.reasoning === true ? "on" : "off";
}
/**
* Normalize a model selection value (string or `{primary?: string}`) to a
* plain trimmed string.  Returns `undefined` when the input is empty/missing.
* Shared by sessions-spawn and cron isolated-agent model resolution.
*/
function normalizeModelSelection(value) {
	if (typeof value === "string") return value.trim() || void 0;
	if (!value || typeof value !== "object") return;
	const primary = value.primary;
	if (typeof primary === "string" && primary.trim()) return primary.trim();
}

//#endregion
export { getBlockedNetworkModeReason as $, DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH as $t, resolveAuthProfileOrder as A, buildEnforcedShellCommand as At, readConfigFileSnapshotForWrite as B, unwrapKnownDispatchWrapperInvocation as Bt, getApiKeyForModel as C, unsetConfigValueAtPath as Ct, resolveEnvApiKey as D, normalizeTrustedSafeBinDirs as Dt, resolveApiKeyForProvider as E, listWritableExplicitTrustedSafeBinDirs as Et, resolveProfilesUnavailableReason as F, resolveAllowlistCandidatePath as Ft, normalizeTelegramCommandName as G, resolveSafeBinProfiles as Gt, writeConfigFile as H, splitShellArgs as Ht, resolveApiKeyForProfile as I, resolveCommandResolutionFromArgv as It, isInboundPathAllowed as J, mapStreamingModeToSlackLegacyDraftStreamMode as Jt, resolveTelegramCustomCommands as K, applyMergePatch as Kt, createConfigIO as L, extractShellWrapperInlineCommand as Lt, isProfileInCooldown as M, splitCommandChain as Mt, markAuthProfileFailure as N, DEFAULT_SAFE_BINS as Nt, resolveModelAuthMode as O, validateSafeBinArgv as Ot, markAuthProfileUsed as P, matchAllowlist as Pt, normalizeScpRemoteHost as Q, resolveTelegramPreviewStreamMode as Qt, loadConfig as R, isDispatchWrapperExecutable as Rt, createOllamaStreamFn as S, setConfigValueAtPath as St, requireApiKey as T, isTrustedSafeBinPath as Tt, validateConfigObjectWithPlugins as U, SAFE_BIN_PROFILES as Ut, resolveConfigSnapshotHash as V, unwrapKnownShellMultiplexerInvocation as Vt, TELEGRAM_COMMAND_NAME_PATTERN as W, normalizeSafeBinProfileFixtures as Wt, resolveIMessageAttachmentRoots as X, resolveSlackNativeStreaming as Xt, mergeInboundPathRoots as Y, resolveDiscordPreviewStreamMode as Yt, resolveIMessageRemoteAttachmentRoots as Z, resolveSlackStreamingMode as Zt, normalizeProviders as _, splitTrailingAuthProfile as _n, resetConfigOverrides as _t, isCliProvider as a, resolveOwnerDisplaySetting as an, isPathWithinRoot as at, resolveImplicitProviders as b, DEFAULT_PROVIDER as bn, getConfigValueAtPath as bt, normalizeProviderId as c, markAuthProfileGood as cn, loadPluginManifestRegistry as ct, resolveDefaultModelForAgent as d, resolveOpenClawAgentDir as dn, safeStatSync as dt, resolveAgentMaxConcurrent as en, parseDurationMs as et, resolveModelRefFromString as f, withFileLock as fn, applyTestPluginDefaults as ft, normalizeGoogleModelId as g, normalizeSecretInput as gn, getConfigOverrides as gt, resolveThinkingDefault as h, resolveAuthProfileDisplayLabel as hn, resolveMemorySlotDecision as ht, findNormalizedProviderValue as i, isDangerousHostEnvVarName as in, isAvatarHttpUrl as it, getSoonestCooldownExpiry as j, isWindowsPlatform as jt, auth_profiles_exports as k, analyzeShellCommand as kt, parseModelRef as l, ensureAuthProfileStore as ln, discoverOpenClawPlugins as lt, resolveSubagentSpawnModelSelection as m, isPidAlive as mn, resolveEffectiveEnableState as mt, buildConfiguredAllowlistKeys as n, getShellPathFromLoginShell as nn, AVATAR_MAX_BYTES as nt, modelKey as o, dedupeProfileIds as on, isSupportedLocalAvatarExtension as ot, resolveReasoningDefault as p, resolveProcessScopedMap as pn, normalizePluginsConfig as pt, DEFAULT_IMESSAGE_ATTACHMENT_ROOTS as q, isSafeExecutableValue as qt, buildModelAliasIndex as r, resolveShellEnvFallbackTimeoutMs as rn, isAvatarDataUrl as rt, normalizeModelRef as s, listProfilesForProvider as sn, validateJsonSchemaValue as st, buildAllowedModelSet as t, VERSION as tn, parseByteSize as tt, resolveConfiguredModelRef as u, resolveAuthStorePathForDisplay as un, isPathInside as ut, resolveImplicitBedrockProvider as v, DEFAULT_CONTEXT_TOKENS as vn, setConfigOverride as vt, getCustomProviderApiKey as w, getTrustedSafeBinDirs as wt, OLLAMA_NATIVE_BASE_URL as x, parseConfigPath as xt, resolveImplicitCopilotProvider as y, DEFAULT_MODEL as yn, unsetConfigOverride as yt, readConfigFileSnapshot as z, isShellWrapperExecutable as zt };