import { o as __toESM } from "./chunk-DORXReHP.js";
import { g as normalizeAccountId, h as DEFAULT_ACCOUNT_ID } from "./session-key-BfFG0xOA.js";
import { $t as createAccountListHelpers, dr as applyAccountNameToChannelSection, pr as migrateBaseNameToDefaultAccount } from "./resolve-route-BZ4hHpx2.js";
import { c as normalizeSecretInputString, i as hasConfiguredSecretInput, s as normalizeResolvedSecretInputString } from "./types.secrets-apkw3WZr.js";
import { Cl as formatDocsLink, El as mergeAllowFromEntries, Ml as promptSingleChannelSecretInput, Tl as buildSingleChannelSecretPromptState, us as KeyedAsyncQueue, wl as addWildcardAllowFrom, zl as setTopLevelChannelGroupPolicy } from "./auth-profiles-CuJtivJK.js";
import { f as fetchWithSsrFGuard } from "./external-content-vZzOHxnd.js";
import { v as formatResolvedUnresolvedNote, y as mapAllowlistResolutionInputs } from "./compat-DDXNEdAm.js";
import { t as runPluginCommandWithTimeout } from "./run-command-Psw08BkS.js";
import { i as getMatrixRuntime, r as loadMatrixCredentials, t as credentialsMatchConfig } from "./credentials-_LkDOqEi.js";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import crypto from "node:crypto";
import MarkdownIt from "markdown-it";
//#region extensions/matrix/src/matrix/client/runtime.ts
function isBunRuntime() {
	return typeof process.versions.bun === "string";
}
//#endregion
//#region extensions/matrix/src/matrix/sdk-runtime.ts
let cachedMatrixSdkRuntime = null;
function loadMatrixSdk() {
	if (cachedMatrixSdkRuntime) {return cachedMatrixSdkRuntime;}
	cachedMatrixSdkRuntime = createRequire(import.meta.url)("@vector-im/matrix-bot-sdk");
	return cachedMatrixSdkRuntime;
}
function getMatrixLogService() {
	return loadMatrixSdk().LogService;
}
//#endregion
//#region extensions/matrix/src/matrix/client/logging.ts
let matrixSdkLoggingConfigured = false;
let matrixSdkBaseLogger;
function shouldSuppressMatrixHttpNotFound(module, messageOrObject) {
	if (module !== "MatrixHttpClient") {return false;}
	return messageOrObject.some((entry) => {
		if (!entry || typeof entry !== "object") {return false;}
		return entry.errcode === "M_NOT_FOUND";
	});
}
function ensureMatrixSdkLoggingConfigured() {
	if (matrixSdkLoggingConfigured) {return;}
	const { ConsoleLogger, LogService } = loadMatrixSdk();
	matrixSdkBaseLogger = new ConsoleLogger();
	matrixSdkLoggingConfigured = true;
	LogService.setLogger({
		trace: (module, ...messageOrObject) => matrixSdkBaseLogger?.trace(module, ...messageOrObject),
		debug: (module, ...messageOrObject) => matrixSdkBaseLogger?.debug(module, ...messageOrObject),
		info: (module, ...messageOrObject) => matrixSdkBaseLogger?.info(module, ...messageOrObject),
		warn: (module, ...messageOrObject) => matrixSdkBaseLogger?.warn(module, ...messageOrObject),
		error: (module, ...messageOrObject) => {
			if (shouldSuppressMatrixHttpNotFound(module, messageOrObject)) {return;}
			matrixSdkBaseLogger?.error(module, ...messageOrObject);
		}
	});
}
//#endregion
//#region extensions/matrix/src/matrix/client/config.ts
function clean(value, path) {
	return normalizeResolvedSecretInputString({
		value,
		path
	}) ?? "";
}
/** Shallow-merge known nested config sub-objects so partial overrides inherit base values. */
function deepMergeConfig(base, override) {
	const merged = {
		...base,
		...override
	};
	for (const key of ["dm", "actions"]) {
		const b = base[key];
		const o = override[key];
		if (typeof b === "object" && b !== null && typeof o === "object" && o !== null) {merged[key] = {
			...b,
			...o
		};}
	}
	return merged;
}
/**
* Resolve Matrix config for a specific account, with fallback to top-level config.
* This supports both multi-account (channels.matrix.accounts.*) and
* single-account (channels.matrix.*) configurations.
*/
function resolveMatrixConfigForAccount(cfg = getMatrixRuntime().config.loadConfig(), accountId, env = process.env) {
	const normalizedAccountId = normalizeAccountId(accountId);
	const matrixBase = cfg.channels?.matrix ?? {};
	const accounts = cfg.channels?.matrix?.accounts;
	let accountConfig = accounts?.[normalizedAccountId];
	if (!accountConfig && accounts) {
		for (const key of Object.keys(accounts)) {if (normalizeAccountId(key) === normalizedAccountId) {
			accountConfig = accounts[key];
			break;
		}}
	}
	const matrix = accountConfig ? deepMergeConfig(matrixBase, accountConfig) : matrixBase;
	return {
		homeserver: clean(matrix.homeserver, "channels.matrix.homeserver") || clean(env.MATRIX_HOMESERVER, "MATRIX_HOMESERVER"),
		userId: clean(matrix.userId, "channels.matrix.userId") || clean(env.MATRIX_USER_ID, "MATRIX_USER_ID"),
		accessToken: clean(matrix.accessToken, "channels.matrix.accessToken") || clean(env.MATRIX_ACCESS_TOKEN, "MATRIX_ACCESS_TOKEN") || void 0,
		password: clean(matrix.password, "channels.matrix.password") || clean(env.MATRIX_PASSWORD, "MATRIX_PASSWORD") || void 0,
		deviceName: clean(matrix.deviceName, "channels.matrix.deviceName") || clean(env.MATRIX_DEVICE_NAME, "MATRIX_DEVICE_NAME") || void 0,
		initialSyncLimit: typeof matrix.initialSyncLimit === "number" ? Math.max(0, Math.floor(matrix.initialSyncLimit)) : void 0,
		encryption: matrix.encryption ?? false
	};
}
async function resolveMatrixAuth(params) {
	const cfg = params?.cfg ?? getMatrixRuntime().config.loadConfig();
	const env = params?.env ?? process.env;
	const resolved = resolveMatrixConfigForAccount(cfg, params?.accountId, env);
	if (!resolved.homeserver) {throw new Error("Matrix homeserver is required (matrix.homeserver)");}
	const { loadMatrixCredentials, saveMatrixCredentials, credentialsMatchConfig, touchMatrixCredentials } = await import("./credentials-_LkDOqEi.js").then((n) => n.n);
	const accountId = params?.accountId;
	const cached = loadMatrixCredentials(env, accountId);
	const cachedCredentials = cached && credentialsMatchConfig(cached, {
		homeserver: resolved.homeserver,
		userId: resolved.userId || ""
	}) ? cached : null;
	if (resolved.accessToken) {
		let userId = resolved.userId;
		if (!userId) {
			ensureMatrixSdkLoggingConfigured();
			const { MatrixClient } = loadMatrixSdk();
			userId = await new MatrixClient(resolved.homeserver, resolved.accessToken).getUserId();
			saveMatrixCredentials({
				homeserver: resolved.homeserver,
				userId,
				accessToken: resolved.accessToken
			}, env, accountId);
		} else if (cachedCredentials && cachedCredentials.accessToken === resolved.accessToken) {touchMatrixCredentials(env, accountId);}
		return {
			homeserver: resolved.homeserver,
			userId,
			accessToken: resolved.accessToken,
			deviceName: resolved.deviceName,
			initialSyncLimit: resolved.initialSyncLimit,
			encryption: resolved.encryption
		};
	}
	if (cachedCredentials) {
		touchMatrixCredentials(env, accountId);
		return {
			homeserver: cachedCredentials.homeserver,
			userId: cachedCredentials.userId,
			accessToken: cachedCredentials.accessToken,
			deviceName: resolved.deviceName,
			initialSyncLimit: resolved.initialSyncLimit,
			encryption: resolved.encryption
		};
	}
	if (!resolved.userId) {throw new Error("Matrix userId is required when no access token is configured (matrix.userId)");}
	if (!resolved.password) {throw new Error("Matrix password is required when no access token is configured (matrix.password)");}
	const { response: loginResponse, release: releaseLoginResponse } = await fetchWithSsrFGuard({
		url: `${resolved.homeserver}/_matrix/client/v3/login`,
		init: {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "m.login.password",
				identifier: {
					type: "m.id.user",
					user: resolved.userId
				},
				password: resolved.password,
				initial_device_display_name: resolved.deviceName ?? "OpenClaw Gateway"
			})
		},
		auditContext: "matrix.login"
	});
	const login = await (async () => {
		try {
			if (!loginResponse.ok) {
				const errorText = await loginResponse.text();
				throw new Error(`Matrix login failed: ${errorText}`);
			}
			return await loginResponse.json();
		} finally {
			await releaseLoginResponse();
		}
	})();
	const accessToken = login.access_token?.trim();
	if (!accessToken) {throw new Error("Matrix login did not return an access token");}
	const auth = {
		homeserver: resolved.homeserver,
		userId: login.user_id ?? resolved.userId,
		accessToken,
		deviceName: resolved.deviceName,
		initialSyncLimit: resolved.initialSyncLimit,
		encryption: resolved.encryption
	};
	saveMatrixCredentials({
		homeserver: auth.homeserver,
		userId: auth.userId,
		accessToken: auth.accessToken,
		deviceId: login.device_id
	}, env, accountId);
	return auth;
}
//#endregion
//#region extensions/matrix/src/matrix/deps.ts
const MATRIX_SDK_PACKAGE = "@vector-im/matrix-bot-sdk";
const MATRIX_CRYPTO_DOWNLOAD_HELPER = "@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js";
function formatCommandError(result) {
	const stderr = result.stderr.trim();
	if (stderr) {return stderr;}
	const stdout = result.stdout.trim();
	if (stdout) {return stdout;}
	return "unknown error";
}
function isMissingMatrixCryptoRuntimeError(err) {
	const message = err instanceof Error ? err.message : String(err ?? "");
	return message.includes("Cannot find module") && message.includes("@matrix-org/matrix-sdk-crypto-nodejs-");
}
function isMatrixSdkAvailable() {
	try {
		createRequire(import.meta.url).resolve(MATRIX_SDK_PACKAGE);
		return true;
	} catch {
		return false;
	}
}
function resolvePluginRoot() {
	const currentDir = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(currentDir, "..", "..");
}
async function ensureMatrixCryptoRuntime(params = {}) {
	const req = createRequire(import.meta.url);
	const requireFn = params.requireFn ?? ((id) => req(id));
	const resolveFn = params.resolveFn ?? ((id) => req.resolve(id));
	const runCommand = params.runCommand ?? runPluginCommandWithTimeout;
	const nodeExecutable = params.nodeExecutable ?? process.execPath;
	try {
		requireFn(MATRIX_SDK_PACKAGE);
		return;
	} catch (err) {
		if (!isMissingMatrixCryptoRuntimeError(err)) {throw err;}
	}
	const scriptPath = resolveFn(MATRIX_CRYPTO_DOWNLOAD_HELPER);
	params.log?.("matrix: crypto runtime missing; downloading platform library…");
	const result = await runCommand({
		argv: [nodeExecutable, scriptPath],
		cwd: path.dirname(scriptPath),
		timeoutMs: 3e5,
		env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" }
	});
	if (result.code !== 0) {throw new Error(`Matrix crypto runtime bootstrap failed: ${formatCommandError(result)}`);}
	try {
		requireFn(MATRIX_SDK_PACKAGE);
	} catch (err) {
		throw new Error(`Matrix crypto runtime remains unavailable after bootstrap: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
	}
}
async function ensureMatrixSdkInstalled(params) {
	if (isMatrixSdkAvailable()) {return;}
	const confirm = params.confirm;
	if (confirm) {
		if (!await confirm("Matrix requires @vector-im/matrix-bot-sdk. Install now?")) {throw new Error("Matrix requires @vector-im/matrix-bot-sdk (install dependencies first).");}
	}
	const root = resolvePluginRoot();
	const command = fs.existsSync(path.join(root, "pnpm-lock.yaml")) ? ["pnpm", "install"] : [
		"npm",
		"install",
		"--omit=dev",
		"--silent"
	];
	params.runtime.log?.(`matrix: installing dependencies via ${command[0]} (${root})…`);
	const result = await runPluginCommandWithTimeout({
		argv: command,
		cwd: root,
		timeoutMs: 3e5,
		env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" }
	});
	if (result.code !== 0) {throw new Error(result.stderr.trim() || result.stdout.trim() || "Matrix dependency install failed.");}
	if (!isMatrixSdkAvailable()) {throw new Error("Matrix dependency install completed but @vector-im/matrix-bot-sdk is still missing.");}
}
const STORAGE_META_FILENAME = "storage-meta.json";
function sanitizePathSegment(value) {
	return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}
function resolveHomeserverKey(homeserver) {
	try {
		const url = new URL(homeserver);
		if (url.host) {return sanitizePathSegment(url.host);}
	} catch {}
	return sanitizePathSegment(homeserver);
}
function hashAccessToken(accessToken) {
	return crypto.createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}
function resolveLegacyStoragePaths(env = process.env) {
	const stateDir = getMatrixRuntime().state.resolveStateDir(env, os.homedir);
	return {
		storagePath: path.join(stateDir, "matrix", "bot-storage.json"),
		cryptoPath: path.join(stateDir, "matrix", "crypto")
	};
}
function resolveMatrixStoragePaths(params) {
	const env = params.env ?? process.env;
	const stateDir = getMatrixRuntime().state.resolveStateDir(env, os.homedir);
	const accountKey = sanitizePathSegment(params.accountId ?? "default");
	const userKey = sanitizePathSegment(params.userId);
	const serverKey = resolveHomeserverKey(params.homeserver);
	const tokenHash = hashAccessToken(params.accessToken);
	const rootDir = path.join(stateDir, "matrix", "accounts", accountKey, `${serverKey}__${userKey}`, tokenHash);
	return {
		rootDir,
		storagePath: path.join(rootDir, "bot-storage.json"),
		cryptoPath: path.join(rootDir, "crypto"),
		metaPath: path.join(rootDir, STORAGE_META_FILENAME),
		accountKey,
		tokenHash
	};
}
function maybeMigrateLegacyStorage(params) {
	const legacy = resolveLegacyStoragePaths(params.env);
	const hasLegacyStorage = fs.existsSync(legacy.storagePath);
	const hasLegacyCrypto = fs.existsSync(legacy.cryptoPath);
	const hasNewStorage = fs.existsSync(params.storagePaths.storagePath) || fs.existsSync(params.storagePaths.cryptoPath);
	if (!hasLegacyStorage && !hasLegacyCrypto) {return;}
	if (hasNewStorage) {return;}
	fs.mkdirSync(params.storagePaths.rootDir, { recursive: true });
	if (hasLegacyStorage) {try {
		fs.renameSync(legacy.storagePath, params.storagePaths.storagePath);
	} catch {}}
	if (hasLegacyCrypto) {try {
		fs.renameSync(legacy.cryptoPath, params.storagePaths.cryptoPath);
	} catch {}}
}
function writeStorageMeta(params) {
	try {
		const payload = {
			homeserver: params.homeserver,
			userId: params.userId,
			accountId: params.accountId ?? "default",
			accessTokenHash: params.storagePaths.tokenHash,
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		fs.mkdirSync(params.storagePaths.rootDir, { recursive: true });
		fs.writeFileSync(params.storagePaths.metaPath, JSON.stringify(payload, null, 2), "utf-8");
	} catch {}
}
//#endregion
//#region extensions/matrix/src/matrix/client/create-client.ts
function sanitizeUserIdList(input, label) {
	const LogService = loadMatrixSdk().LogService;
	if (input == null) {return [];}
	if (!Array.isArray(input)) {
		LogService.warn("MatrixClientLite", `Expected ${label} list to be an array, got ${typeof input}`);
		return [];
	}
	const filtered = input.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
	if (filtered.length !== input.length) {LogService.warn("MatrixClientLite", `Dropping ${input.length - filtered.length} invalid ${label} entries from sync payload`);}
	return filtered;
}
async function createMatrixClient(params) {
	await ensureMatrixCryptoRuntime();
	const { MatrixClient, SimpleFsStorageProvider, RustSdkCryptoStorageProvider, LogService } = loadMatrixSdk();
	ensureMatrixSdkLoggingConfigured();
	const env = process.env;
	const storagePaths = resolveMatrixStoragePaths({
		homeserver: params.homeserver,
		userId: params.userId,
		accessToken: params.accessToken,
		accountId: params.accountId,
		env
	});
	maybeMigrateLegacyStorage({
		storagePaths,
		env
	});
	fs.mkdirSync(storagePaths.rootDir, { recursive: true });
	const storage = new SimpleFsStorageProvider(storagePaths.storagePath);
	let cryptoStorage;
	if (params.encryption) {
		fs.mkdirSync(storagePaths.cryptoPath, { recursive: true });
		try {
			const { StoreType } = await import("./matrix-sdk-crypto-nodejs-CaYLOYdj.js").then((m) => /* @__PURE__ */ __toESM(m.default, 1));
			cryptoStorage = new RustSdkCryptoStorageProvider(storagePaths.cryptoPath, StoreType.Sqlite);
		} catch (err) {
			LogService.warn("MatrixClientLite", "Failed to initialize crypto storage, E2EE disabled:", err);
		}
	}
	writeStorageMeta({
		storagePaths,
		homeserver: params.homeserver,
		userId: params.userId,
		accountId: params.accountId
	});
	const client = new MatrixClient(params.homeserver, params.accessToken, storage, cryptoStorage);
	if (client.crypto) {
		const originalUpdateSyncData = client.crypto.updateSyncData.bind(client.crypto);
		client.crypto.updateSyncData = async (toDeviceMessages, otkCounts, unusedFallbackKeyAlgs, changedDeviceLists, leftDeviceLists) => {
			const safeChanged = sanitizeUserIdList(changedDeviceLists, "changed device list");
			const safeLeft = sanitizeUserIdList(leftDeviceLists, "left device list");
			try {
				return await originalUpdateSyncData(toDeviceMessages, otkCounts, unusedFallbackKeyAlgs, safeChanged, safeLeft);
			} catch (err) {
				const message = typeof err === "string" ? err : err instanceof Error ? err.message : "";
				if (message.includes("Expect value to be String")) {
					LogService.warn("MatrixClientLite", "Ignoring malformed device list entries during crypto sync", message);
					return;
				}
				throw err;
			}
		};
	}
	return client;
}
async function startMatrixClientWithGrace(params) {
	const graceMs = params.graceMs ?? 2e3;
	let startFailed = false;
	let startError = void 0;
	let startPromise;
	try {
		startPromise = params.client.start();
	} catch (err) {
		params.onError?.(err);
		throw err;
	}
	startPromise.catch((err) => {
		startFailed = true;
		startError = err;
		params.onError?.(err);
	});
	await new Promise((resolve) => setTimeout(resolve, graceMs));
	if (startFailed) {throw startError;}
}
//#endregion
//#region extensions/matrix/src/matrix/client/shared.ts
const sharedClientStates = /* @__PURE__ */ new Map();
const sharedClientPromises = /* @__PURE__ */ new Map();
const sharedClientStartPromises = /* @__PURE__ */ new Map();
function buildSharedClientKey(auth, accountId) {
	const normalizedAccountId = normalizeAccountId(accountId);
	return [
		auth.homeserver,
		auth.userId,
		auth.accessToken,
		auth.encryption ? "e2ee" : "plain",
		normalizedAccountId || "default"
	].join("|");
}
async function createSharedMatrixClient(params) {
	return {
		client: await createMatrixClient({
			homeserver: params.auth.homeserver,
			userId: params.auth.userId,
			accessToken: params.auth.accessToken,
			encryption: params.auth.encryption,
			localTimeoutMs: params.timeoutMs,
			accountId: params.accountId
		}),
		key: buildSharedClientKey(params.auth, params.accountId),
		started: false,
		cryptoReady: false
	};
}
async function ensureSharedClientStarted(params) {
	if (params.state.started) {return;}
	const key = params.state.key;
	const existingStartPromise = sharedClientStartPromises.get(key);
	if (existingStartPromise) {
		await existingStartPromise;
		return;
	}
	const startPromise = (async () => {
		const client = params.state.client;
		if (params.encryption && !params.state.cryptoReady) {try {
			const joinedRooms = await client.getJoinedRooms();
			if (client.crypto) {
				await client.crypto.prepare(joinedRooms);
				params.state.cryptoReady = true;
			}
		} catch (err) {
			getMatrixLogService().warn("MatrixClientLite", "Failed to prepare crypto:", err);
		}}
		await startMatrixClientWithGrace({
			client,
			onError: (err) => {
				params.state.started = false;
				getMatrixLogService().error("MatrixClientLite", "client.start() error:", err);
			}
		});
		params.state.started = true;
	})();
	sharedClientStartPromises.set(key, startPromise);
	try {
		await startPromise;
	} finally {
		sharedClientStartPromises.delete(key);
	}
}
async function resolveSharedMatrixClient(params = {}) {
	const accountId = normalizeAccountId(params.accountId);
	const auth = params.auth ?? await resolveMatrixAuth({
		cfg: params.cfg,
		env: params.env,
		accountId
	});
	const key = buildSharedClientKey(auth, accountId);
	const shouldStart = params.startClient !== false;
	const existingState = sharedClientStates.get(key);
	if (existingState) {
		if (shouldStart) {await ensureSharedClientStarted({
			state: existingState,
			timeoutMs: params.timeoutMs,
			initialSyncLimit: auth.initialSyncLimit,
			encryption: auth.encryption
		});}
		return existingState.client;
	}
	const existingPromise = sharedClientPromises.get(key);
	if (existingPromise) {
		const pending = await existingPromise;
		if (shouldStart) {await ensureSharedClientStarted({
			state: pending,
			timeoutMs: params.timeoutMs,
			initialSyncLimit: auth.initialSyncLimit,
			encryption: auth.encryption
		});}
		return pending.client;
	}
	const createPromise = createSharedMatrixClient({
		auth,
		timeoutMs: params.timeoutMs,
		accountId
	});
	sharedClientPromises.set(key, createPromise);
	try {
		const created = await createPromise;
		sharedClientStates.set(key, created);
		if (shouldStart) {await ensureSharedClientStarted({
			state: created,
			timeoutMs: params.timeoutMs,
			initialSyncLimit: auth.initialSyncLimit,
			encryption: auth.encryption
		});}
		return created.client;
	} finally {
		sharedClientPromises.delete(key);
	}
}
function stopSharedClient(key) {
	if (key) {
		const state = sharedClientStates.get(key);
		if (state) {
			state.client.stop();
			sharedClientStates.delete(key);
		}
	} else {
		for (const state of sharedClientStates.values()) {state.client.stop();}
		sharedClientStates.clear();
	}
}
/**
* Stop the shared client for a specific account.
* Use this instead of stopSharedClient() when shutting down a single account
* to avoid stopping all accounts.
*/
function stopSharedClientForAccount(auth, accountId) {
	stopSharedClient(buildSharedClientKey(auth, normalizeAccountId(accountId)));
}
//#endregion
//#region extensions/matrix/src/directory-live.ts
async function fetchMatrixJson(params) {
	const res = await fetch(`${params.homeserver}${params.path}`, {
		method: params.method ?? "GET",
		headers: {
			Authorization: `Bearer ${params.accessToken}`,
			"Content-Type": "application/json"
		},
		body: params.body ? JSON.stringify(params.body) : void 0
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Matrix API ${params.path} failed (${res.status}): ${text || "unknown error"}`);
	}
	return await res.json();
}
function normalizeQuery(value) {
	return value?.trim().toLowerCase() ?? "";
}
function resolveMatrixDirectoryLimit(limit) {
	return typeof limit === "number" && limit > 0 ? limit : 20;
}
async function resolveMatrixDirectoryContext(params) {
	const query = normalizeQuery(params.query);
	if (!query) {return null;}
	return {
		query,
		auth: await resolveMatrixAuth({
			cfg: params.cfg,
			accountId: params.accountId
		})
	};
}
function createGroupDirectoryEntry(params) {
	return {
		kind: "group",
		id: params.id,
		name: params.name,
		handle: params.handle
	};
}
async function listMatrixDirectoryPeersLive(params) {
	const context = await resolveMatrixDirectoryContext(params);
	if (!context) {return [];}
	const { query, auth } = context;
	return ((await fetchMatrixJson({
		homeserver: auth.homeserver,
		accessToken: auth.accessToken,
		path: "/_matrix/client/v3/user_directory/search",
		method: "POST",
		body: {
			search_term: query,
			limit: resolveMatrixDirectoryLimit(params.limit)
		}
	})).results ?? []).map((entry) => {
		const userId = entry.user_id?.trim();
		if (!userId) {return null;}
		return {
			kind: "user",
			id: userId,
			name: entry.display_name?.trim() || void 0,
			handle: entry.display_name ? `@${entry.display_name.trim()}` : void 0,
			raw: entry
		};
	}).filter(Boolean);
}
async function resolveMatrixRoomAlias(homeserver, accessToken, alias) {
	try {
		return (await fetchMatrixJson({
			homeserver,
			accessToken,
			path: `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`
		})).room_id?.trim() || null;
	} catch {
		return null;
	}
}
async function fetchMatrixRoomName(homeserver, accessToken, roomId) {
	try {
		return (await fetchMatrixJson({
			homeserver,
			accessToken,
			path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`
		})).name?.trim() || null;
	} catch {
		return null;
	}
}
async function listMatrixDirectoryGroupsLive(params) {
	const context = await resolveMatrixDirectoryContext(params);
	if (!context) {return [];}
	const { query, auth } = context;
	const limit = resolveMatrixDirectoryLimit(params.limit);
	if (query.startsWith("#")) {
		const roomId = await resolveMatrixRoomAlias(auth.homeserver, auth.accessToken, query);
		if (!roomId) {return [];}
		return [createGroupDirectoryEntry({
			id: roomId,
			name: query,
			handle: query
		})];
	}
	if (query.startsWith("!")) {
		const originalId = params.query?.trim() ?? query;
		return [createGroupDirectoryEntry({
			id: originalId,
			name: originalId
		})];
	}
	const rooms = (await fetchMatrixJson({
		homeserver: auth.homeserver,
		accessToken: auth.accessToken,
		path: "/_matrix/client/v3/joined_rooms"
	})).joined_rooms ?? [];
	const results = [];
	for (const roomId of rooms) {
		const name = await fetchMatrixRoomName(auth.homeserver, auth.accessToken, roomId);
		if (!name) {continue;}
		if (!name.toLowerCase().includes(query)) {continue;}
		results.push({
			kind: "group",
			id: roomId,
			name,
			handle: `#${name}`
		});
		if (results.length >= limit) {break;}
	}
	return results;
}
//#endregion
//#region extensions/matrix/src/matrix/accounts.ts
/** Merge account config with top-level defaults, preserving nested objects. */
function mergeAccountConfig(base, account) {
	const merged = {
		...base,
		...account
	};
	for (const key of ["dm", "actions"]) {
		const b = base[key];
		const o = account[key];
		if (typeof b === "object" && b != null && typeof o === "object" && o != null) {merged[key] = {
			...b,
			...o
		};}
	}
	delete merged.accounts;
	delete merged.defaultAccount;
	return merged;
}
const { listAccountIds: listMatrixAccountIds, resolveDefaultAccountId: resolveDefaultMatrixAccountId } = createAccountListHelpers("matrix", { normalizeAccountId });
function resolveAccountConfig(cfg, accountId) {
	const accounts = cfg.channels?.matrix?.accounts;
	if (!accounts || typeof accounts !== "object") {return;}
	if (accounts[accountId]) {return accounts[accountId];}
	const normalized = normalizeAccountId(accountId);
	for (const key of Object.keys(accounts)) {if (normalizeAccountId(key) === normalized) return accounts[key];}
}
function resolveMatrixAccount(params) {
	const accountId = normalizeAccountId(params.accountId);
	const matrixBase = params.cfg.channels?.matrix ?? {};
	const base = resolveMatrixAccountConfig({
		cfg: params.cfg,
		accountId
	});
	const enabled = base.enabled !== false && matrixBase.enabled !== false;
	const resolved = resolveMatrixConfigForAccount(params.cfg, accountId, process.env);
	const hasHomeserver = Boolean(resolved.homeserver);
	const hasUserId = Boolean(resolved.userId);
	const hasAccessToken = Boolean(resolved.accessToken);
	const hasPassword = Boolean(resolved.password);
	const hasPasswordAuth = hasUserId && (hasPassword || hasConfiguredSecretInput(base.password));
	const stored = loadMatrixCredentials(process.env, accountId);
	const hasStored = stored && resolved.homeserver ? credentialsMatchConfig(stored, {
		homeserver: resolved.homeserver,
		userId: resolved.userId || ""
	}) : false;
	const configured = hasHomeserver && (hasAccessToken || hasPasswordAuth || Boolean(hasStored));
	return {
		accountId,
		enabled,
		name: base.name?.trim() || void 0,
		configured,
		homeserver: resolved.homeserver || void 0,
		userId: resolved.userId || void 0,
		config: base
	};
}
function resolveMatrixAccountConfig(params) {
	const accountId = normalizeAccountId(params.accountId);
	const matrixBase = params.cfg.channels?.matrix ?? {};
	const accountConfig = resolveAccountConfig(params.cfg, accountId);
	if (!accountConfig) {return matrixBase;}
	return mergeAccountConfig(matrixBase, accountConfig);
}
//#endregion
//#region extensions/matrix/src/resolve-targets.ts
function findExactDirectoryMatches(matches, query) {
	const normalized = query.trim().toLowerCase();
	if (!normalized) {return [];}
	return matches.filter((match) => {
		const id = match.id.trim().toLowerCase();
		const name = match.name?.trim().toLowerCase();
		const handle = match.handle?.trim().toLowerCase();
		return normalized === id || normalized === name || normalized === handle;
	});
}
function pickBestGroupMatch(matches, query) {
	if (matches.length === 0) {return;}
	const [exact] = findExactDirectoryMatches(matches, query);
	return exact ?? matches[0];
}
function pickBestUserMatch(matches, query) {
	if (matches.length === 0) {return;}
	const exact = findExactDirectoryMatches(matches, query);
	if (exact.length === 1) {return exact[0];}
}
function describeUserMatchFailure(matches, query) {
	if (matches.length === 0) {return "no matches";}
	const normalized = query.trim().toLowerCase();
	if (!normalized) {return "empty input";}
	const exact = findExactDirectoryMatches(matches, normalized);
	if (exact.length === 0) {return "no exact match; use full Matrix ID";}
	if (exact.length > 1) {return "multiple exact matches; use full Matrix ID";}
	return "no exact match; use full Matrix ID";
}
async function resolveMatrixTargets(params) {
	return await mapAllowlistResolutionInputs({
		inputs: params.inputs,
		mapInput: async (input) => {
			const trimmed = input.trim();
			if (!trimmed) {return {
				input,
				resolved: false,
				note: "empty input"
			};}
			if (params.kind === "user") {
				if (trimmed.startsWith("@") && trimmed.includes(":")) {return {
					input,
					resolved: true,
					id: trimmed
				};}
				try {
					const matches = await listMatrixDirectoryPeersLive({
						cfg: params.cfg,
						query: trimmed,
						limit: 5
					});
					const best = pickBestUserMatch(matches, trimmed);
					return {
						input,
						resolved: Boolean(best?.id),
						id: best?.id,
						name: best?.name,
						note: best ? void 0 : describeUserMatchFailure(matches, trimmed)
					};
				} catch (err) {
					params.runtime?.error?.(`matrix resolve failed: ${String(err)}`);
					return {
						input,
						resolved: false,
						note: "lookup failed"
					};
				}
			}
			try {
				const matches = await listMatrixDirectoryGroupsLive({
					cfg: params.cfg,
					query: trimmed,
					limit: 5
				});
				const best = pickBestGroupMatch(matches, trimmed);
				return {
					input,
					resolved: Boolean(best?.id),
					id: best?.id,
					name: best?.name,
					note: matches.length > 1 ? "multiple matches; chose first" : void 0
				};
			} catch (err) {
				params.runtime?.error?.(`matrix resolve failed: ${String(err)}`);
				return {
					input,
					resolved: false,
					note: "lookup failed"
				};
			}
		}
	});
}
//#endregion
//#region extensions/matrix/src/setup-core.ts
const channel$1 = "matrix";
function buildMatrixConfigUpdate(cfg, input) {
	const existing = cfg.channels?.matrix ?? {};
	return {
		...cfg,
		channels: {
			...cfg.channels,
			matrix: {
				...existing,
				enabled: true,
				...input.homeserver ? { homeserver: input.homeserver } : {},
				...input.userId ? { userId: input.userId } : {},
				...input.accessToken ? { accessToken: input.accessToken } : {},
				...input.password ? { password: input.password } : {},
				...input.deviceName ? { deviceName: input.deviceName } : {},
				...typeof input.initialSyncLimit === "number" ? { initialSyncLimit: input.initialSyncLimit } : {}
			}
		}
	};
}
const matrixSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
		cfg,
		channelKey: channel$1,
		accountId,
		name
	}),
	validateInput: ({ input }) => {
		if (input.useEnv) {return null;}
		if (!input.homeserver?.trim()) {return "Matrix requires --homeserver";}
		const accessToken = input.accessToken?.trim();
		const password = normalizeSecretInputString(input.password);
		const userId = input.userId?.trim();
		if (!accessToken && !password) {return "Matrix requires --access-token or --password";}
		if (!accessToken) {
			if (!userId) {return "Matrix requires --user-id when using --password";}
			if (!password) {return "Matrix requires --password when using --user-id";}
		}
		return null;
	},
	applyAccountConfig: ({ cfg, accountId, input }) => {
		const namedConfig = applyAccountNameToChannelSection({
			cfg,
			channelKey: channel$1,
			accountId,
			name: input.name
		});
		const next = accountId !== "default" ? migrateBaseNameToDefaultAccount({
			cfg: namedConfig,
			channelKey: channel$1
		}) : namedConfig;
		if (input.useEnv) {return {
			...next,
			channels: {
				...next.channels,
				matrix: {
					...next.channels?.matrix,
					enabled: true
				}
			}
		};}
		return buildMatrixConfigUpdate(next, {
			homeserver: input.homeserver?.trim(),
			userId: input.userId?.trim(),
			accessToken: input.accessToken?.trim(),
			password: normalizeSecretInputString(input.password),
			deviceName: input.deviceName?.trim(),
			initialSyncLimit: input.initialSyncLimit
		});
	}
};
//#endregion
//#region extensions/matrix/src/setup-surface.ts
const channel = "matrix";
function setMatrixDmPolicy(cfg, policy) {
	const allowFrom = policy === "open" ? addWildcardAllowFrom(cfg.channels?.matrix?.dm?.allowFrom) : void 0;
	return {
		...cfg,
		channels: {
			...cfg.channels,
			matrix: {
				...cfg.channels?.matrix,
				dm: {
					...cfg.channels?.matrix?.dm,
					policy,
					...allowFrom ? { allowFrom } : {}
				}
			}
		}
	};
}
async function noteMatrixAuthHelp(prompter) {
	await prompter.note([
		"Matrix requires a homeserver URL.",
		"Use an access token (recommended) or a password (logs in and stores a token).",
		"With access token: user ID is fetched automatically.",
		"Env vars supported: MATRIX_HOMESERVER, MATRIX_USER_ID, MATRIX_ACCESS_TOKEN, MATRIX_PASSWORD.",
		`Docs: ${formatDocsLink("/channels/matrix", "channels/matrix")}`
	].join("\n"), "Matrix setup");
}
async function promptMatrixAllowFrom(params) {
	const { cfg, prompter } = params;
	const existingAllowFrom = cfg.channels?.matrix?.dm?.allowFrom ?? [];
	const account = resolveMatrixAccount({ cfg });
	const canResolve = Boolean(account.configured);
	const parseInput = (raw) => raw.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
	const isFullUserId = (value) => value.startsWith("@") && value.includes(":");
	while (true) {
		const entry = await prompter.text({
			message: "Matrix allowFrom (full @user:server; display name only if unique)",
			placeholder: "@user:server",
			initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : void 0,
			validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
		});
		const parts = parseInput(String(entry));
		const resolvedIds = [];
		const pending = [];
		const unresolved = [];
		const unresolvedNotes = [];
		for (const part of parts) {
			if (isFullUserId(part)) {
				resolvedIds.push(part);
				continue;
			}
			if (!canResolve) {
				unresolved.push(part);
				continue;
			}
			pending.push(part);
		}
		if (pending.length > 0) {
			const results = await resolveMatrixTargets({
				cfg,
				inputs: pending,
				kind: "user"
			}).catch(() => []);
			for (const result of results) {
				if (result?.resolved && result.id) {
					resolvedIds.push(result.id);
					continue;
				}
				if (result?.input) {
					unresolved.push(result.input);
					if (result.note) {unresolvedNotes.push(`${result.input}: ${result.note}`);}
				}
			}
		}
		if (unresolved.length > 0) {
			const details = unresolvedNotes.length > 0 ? unresolvedNotes : unresolved;
			await prompter.note(`Could not resolve:\n${details.join("\n")}\nUse full @user:server IDs.`, "Matrix allowlist");
			continue;
		}
		const unique = mergeAllowFromEntries(existingAllowFrom, resolvedIds);
		return {
			...cfg,
			channels: {
				...cfg.channels,
				matrix: {
					...cfg.channels?.matrix,
					enabled: true,
					dm: {
						...cfg.channels?.matrix?.dm,
						policy: "allowlist",
						allowFrom: unique
					}
				}
			}
		};
	}
}
function setMatrixGroupPolicy(cfg, groupPolicy) {
	return setTopLevelChannelGroupPolicy({
		cfg,
		channel: "matrix",
		groupPolicy,
		enabled: true
	});
}
function setMatrixGroupRooms(cfg, roomKeys) {
	const groups = Object.fromEntries(roomKeys.map((key) => [key, { allow: true }]));
	return {
		...cfg,
		channels: {
			...cfg.channels,
			matrix: {
				...cfg.channels?.matrix,
				enabled: true,
				groups
			}
		}
	};
}
async function resolveMatrixGroupRooms(params) {
	if (params.entries.length === 0) {return [];}
	try {
		const resolvedIds = [];
		const unresolved = [];
		for (const entry of params.entries) {
			const trimmed = entry.trim();
			if (!trimmed) {continue;}
			const cleaned = trimmed.replace(/^(room|channel):/i, "").trim();
			if (cleaned.startsWith("!") && cleaned.includes(":")) {
				resolvedIds.push(cleaned);
				continue;
			}
			const matches = await listMatrixDirectoryGroupsLive({
				cfg: params.cfg,
				query: trimmed,
				limit: 10
			});
			const best = matches.find((match) => (match.name ?? "").toLowerCase() === trimmed.toLowerCase()) ?? matches[0];
			if (best?.id) {resolvedIds.push(best.id);}
			else {unresolved.push(entry);}
		}
		const roomKeys = [...resolvedIds, ...unresolved.map((entry) => entry.trim()).filter(Boolean)];
		const resolution = formatResolvedUnresolvedNote({
			resolved: resolvedIds,
			unresolved
		});
		if (resolution) {await params.prompter.note(resolution, "Matrix rooms");}
		return roomKeys;
	} catch (err) {
		await params.prompter.note(`Room lookup failed; keeping entries as typed. ${String(err)}`, "Matrix rooms");
		return params.entries.map((entry) => entry.trim()).filter(Boolean);
	}
}
const matrixSetupWizard = {
	channel,
	resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID,
	resolveShouldPromptAccountIds: () => false,
	status: {
		configuredLabel: "configured",
		unconfiguredLabel: "needs homeserver + access token or password",
		configuredHint: "configured",
		unconfiguredHint: "needs auth",
		resolveConfigured: ({ cfg }) => resolveMatrixAccount({ cfg }).configured,
		resolveStatusLines: ({ cfg }) => {
			return [`Matrix: ${resolveMatrixAccount({ cfg }).configured ? "configured" : "needs homeserver + access token or password"}`];
		},
		resolveSelectionHint: ({ cfg, configured }) => {
			if (!isMatrixSdkAvailable()) {return "install @vector-im/matrix-bot-sdk";}
			return configured ? "configured" : "needs auth";
		}
	},
	credentials: [],
	finalize: async ({ cfg, runtime, prompter, forceAllowFrom }) => {
		let next = cfg;
		await ensureMatrixSdkInstalled({
			runtime,
			confirm: async (message) => await prompter.confirm({
				message,
				initialValue: true
			})
		});
		const existing = next.channels?.matrix ?? {};
		if (!resolveMatrixAccount({ cfg: next }).configured) {await noteMatrixAuthHelp(prompter);}
		const envHomeserver = process.env.MATRIX_HOMESERVER?.trim();
		const envUserId = process.env.MATRIX_USER_ID?.trim();
		const envAccessToken = process.env.MATRIX_ACCESS_TOKEN?.trim();
		const envPassword = process.env.MATRIX_PASSWORD?.trim();
		if (Boolean(envHomeserver && (envAccessToken || envUserId && envPassword)) && !existing.homeserver && !existing.userId && !existing.accessToken && !existing.password) {
			if (await prompter.confirm({
				message: "Matrix env vars detected. Use env values?",
				initialValue: true
			})) {
				next = matrixSetupAdapter.applyAccountConfig({
					cfg: next,
					accountId: DEFAULT_ACCOUNT_ID,
					input: { useEnv: true }
				});
				if (forceAllowFrom) {next = await promptMatrixAllowFrom({
					cfg: next,
					prompter
				});}
				return { cfg: next };
			}
		}
		const homeserver = String(await prompter.text({
			message: "Matrix homeserver URL",
			initialValue: existing.homeserver ?? envHomeserver,
			validate: (value) => {
				const raw = String(value ?? "").trim();
				if (!raw) {return "Required";}
				if (!/^https?:\/\//i.test(raw)) {return "Use a full URL (https://...)";}
			}
		})).trim();
		let accessToken = existing.accessToken ?? "";
		let password = existing.password;
		let userId = existing.userId ?? "";
		const existingPasswordConfigured = hasConfiguredSecretInput(existing.password);
		const passwordConfigured = () => hasConfiguredSecretInput(password);
		if (accessToken || passwordConfigured()) {
			if (!await prompter.confirm({
				message: "Matrix credentials already configured. Keep them?",
				initialValue: true
			})) {
				accessToken = "";
				password = void 0;
				userId = "";
			}
		}
		if (!accessToken && !passwordConfigured()) {if (await prompter.select({
			message: "Matrix auth method",
			options: [{
				value: "token",
				label: "Access token (user ID fetched automatically)"
			}, {
				value: "password",
				label: "Password (requires user ID)"
			}]
		}) === "token") {
			accessToken = String(await prompter.text({
				message: "Matrix access token",
				validate: (value) => value?.trim() ? void 0 : "Required"
			})).trim();
			userId = "";
		} else {
			userId = String(await prompter.text({
				message: "Matrix user ID",
				initialValue: existing.userId ?? envUserId,
				validate: (value) => {
					const raw = String(value ?? "").trim();
					if (!raw) return "Required";
					if (!raw.startsWith("@")) return "Matrix user IDs should start with @";
					if (!raw.includes(":")) return "Matrix user IDs should include a server (:server)";
				}
			})).trim();
			const passwordPromptState = buildSingleChannelSecretPromptState({
				accountConfigured: Boolean(existingPasswordConfigured),
				hasConfigToken: existingPasswordConfigured,
				allowEnv: true,
				envValue: envPassword
			});
			const passwordResult = await promptSingleChannelSecretInput({
				cfg: next,
				prompter,
				providerHint: channel,
				credentialLabel: "password",
				accountConfigured: passwordPromptState.accountConfigured,
				canUseEnv: passwordPromptState.canUseEnv,
				hasConfigToken: passwordPromptState.hasConfigToken,
				envPrompt: "MATRIX_PASSWORD detected. Use env var?",
				keepPrompt: "Matrix password already configured. Keep it?",
				inputPrompt: "Matrix password",
				preferredEnvVar: "MATRIX_PASSWORD"
			});
			if (passwordResult.action === "set") password = passwordResult.value;
			if (passwordResult.action === "use-env") password = void 0;
		}}
		const deviceName = String(await prompter.text({
			message: "Matrix device name (optional)",
			initialValue: existing.deviceName ?? "OpenClaw Gateway"
		})).trim();
		const enableEncryption = await prompter.confirm({
			message: "Enable end-to-end encryption (E2EE)?",
			initialValue: existing.encryption ?? false
		});
		next = {
			...next,
			channels: {
				...next.channels,
				matrix: {
					...next.channels?.matrix,
					enabled: true,
					homeserver,
					userId: userId || void 0,
					accessToken: accessToken || void 0,
					password,
					deviceName: deviceName || void 0,
					encryption: enableEncryption || void 0
				}
			}
		};
		if (forceAllowFrom) {next = await promptMatrixAllowFrom({
			cfg: next,
			prompter
		});}
		return { cfg: next };
	},
	dmPolicy: {
		label: "Matrix",
		channel,
		policyKey: "channels.matrix.dm.policy",
		allowFromKey: "channels.matrix.dm.allowFrom",
		getCurrent: (cfg) => cfg.channels?.matrix?.dm?.policy ?? "pairing",
		setPolicy: (cfg, policy) => setMatrixDmPolicy(cfg, policy),
		promptAllowFrom: promptMatrixAllowFrom
	},
	groupAccess: {
		label: "Matrix rooms",
		placeholder: "!roomId:server, #alias:server, Project Room",
		currentPolicy: ({ cfg }) => cfg.channels?.matrix?.groupPolicy ?? "allowlist",
		currentEntries: ({ cfg }) => Object.keys(cfg.channels?.matrix?.groups ?? cfg.channels?.matrix?.rooms ?? {}),
		updatePrompt: ({ cfg }) => Boolean(cfg.channels?.matrix?.groups ?? cfg.channels?.matrix?.rooms),
		setPolicy: ({ cfg, policy }) => setMatrixGroupPolicy(cfg, policy),
		resolveAllowlist: async ({ cfg, entries, prompter }) => await resolveMatrixGroupRooms({
			cfg,
			entries,
			prompter
		}),
		applyAllowlist: ({ cfg, resolved }) => setMatrixGroupRooms(cfg, resolved)
	},
	disable: (cfg) => ({
		...cfg,
		channels: {
			...cfg.channels,
			matrix: {
				...cfg.channels?.matrix,
				enabled: false
			}
		}
	})
};
//#endregion
//#region extensions/matrix/src/matrix/poll-types.ts
const M_POLL_START = "m.poll.start";
const POLL_START_TYPES = new Set([M_POLL_START, "org.matrix.msc3381.poll.start"]);
function isPollStartType(eventType) {
	return POLL_START_TYPES.has(eventType);
}
function getTextContent(text) {
	if (!text) {return "";}
	return text["m.text"] ?? text["org.matrix.msc1767.text"] ?? text.body ?? "";
}
function parsePollStartContent(content) {
	const poll = content["m.poll.start"] ?? content["org.matrix.msc3381.poll.start"] ?? content["m.poll"];
	if (!poll) {return null;}
	const question = getTextContent(poll.question);
	if (!question) {return null;}
	return {
		eventId: "",
		roomId: "",
		sender: "",
		senderName: "",
		question,
		answers: poll.answers.map((answer) => getTextContent(answer)).filter((a) => a.trim().length > 0),
		kind: poll.kind ?? "m.poll.disclosed",
		maxSelections: poll.max_selections ?? 1
	};
}
function formatPollAsText(summary) {
	return [
		"[Poll]",
		summary.question,
		"",
		...summary.answers.map((answer, idx) => `${idx + 1}. ${answer}`)
	].join("\n");
}
function buildTextContent$1(body) {
	return {
		"m.text": body,
		"org.matrix.msc1767.text": body
	};
}
function buildPollFallbackText(question, answers) {
	if (answers.length === 0) {return question;}
	return `${question}\n${answers.map((answer, idx) => `${idx + 1}. ${answer}`).join("\n")}`;
}
function buildPollStartContent(poll) {
	const question = poll.question.trim();
	const answers = poll.options.map((option) => option.trim()).filter((option) => option.length > 0).map((option, idx) => ({
		id: `answer${idx + 1}`,
		...buildTextContent$1(option)
	}));
	const isMultiple = (poll.maxSelections ?? 1) > 1;
	const maxSelections = isMultiple ? Math.max(1, answers.length) : 1;
	const fallbackText = buildPollFallbackText(question, answers.map((answer) => getTextContent(answer)));
	return {
		[M_POLL_START]: {
			question: buildTextContent$1(question),
			kind: isMultiple ? "m.poll.undisclosed" : "m.poll.disclosed",
			max_selections: maxSelections,
			answers
		},
		"m.text": fallbackText,
		"org.matrix.msc1767.text": fallbackText
	};
}
const roomQueues = new KeyedAsyncQueue();
function enqueueSend(roomId, fn, options) {
	const gapMs = options?.gapMs ?? 150;
	const delayFn = options?.delayFn ?? delay;
	return roomQueues.enqueue(roomId, async () => {
		await delayFn(gapMs);
		return await fn();
	});
}
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
//#endregion
//#region extensions/matrix/src/matrix/active-client.ts
const activeClients = /* @__PURE__ */ new Map();
function setActiveMatrixClient(client, accountId) {
	const key = normalizeAccountId(accountId);
	if (client) {activeClients.set(key, client);}
	else {activeClients.delete(key);}
}
function getActiveMatrixClient(accountId) {
	const key = normalizeAccountId(accountId);
	return activeClients.get(key) ?? null;
}
function getAnyActiveMatrixClient() {
	const first = activeClients.values().next();
	return first.done ? null : first.value;
}
//#endregion
//#region extensions/matrix/src/matrix/client-bootstrap.ts
async function createPreparedMatrixClient(opts) {
	const client = await createMatrixClient({
		homeserver: opts.auth.homeserver,
		userId: opts.auth.userId,
		accessToken: opts.auth.accessToken,
		encryption: opts.auth.encryption,
		localTimeoutMs: opts.timeoutMs,
		accountId: opts.accountId
	});
	if (opts.auth.encryption && client.crypto) {try {
		const joinedRooms = await client.getJoinedRooms();
		await client.crypto.prepare(joinedRooms);
	} catch {}}
	await startMatrixClientWithGrace({
		client,
		onError: (err) => {
			getMatrixLogService().error("MatrixClientBootstrap", "client.start() error:", err);
		}
	});
	return client;
}
//#endregion
//#region extensions/matrix/src/matrix/send/client.ts
const getCore$3 = () => getMatrixRuntime();
function ensureNodeRuntime() {
	if (isBunRuntime()) {throw new Error("Matrix support requires Node (bun runtime not supported)");}
}
/** Look up account config with case-insensitive key fallback. */
function findAccountConfig(accounts, accountId) {
	if (!accounts) {return void 0;}
	const normalized = normalizeAccountId(accountId);
	if (accounts[normalized]) {return accounts[normalized];}
	for (const key of Object.keys(accounts)) {if (normalizeAccountId(key) === normalized) return accounts[key];}
}
function resolveMediaMaxBytes(accountId, cfg) {
	const resolvedCfg = cfg ?? getCore$3().config.loadConfig();
	const accountConfig = findAccountConfig(resolvedCfg.channels?.matrix?.accounts, accountId ?? "");
	if (typeof accountConfig?.mediaMaxMb === "number") {return accountConfig.mediaMaxMb * 1024 * 1024;}
	if (typeof resolvedCfg.channels?.matrix?.mediaMaxMb === "number") {return resolvedCfg.channels.matrix.mediaMaxMb * 1024 * 1024;}
}
async function resolveMatrixClient(opts) {
	ensureNodeRuntime();
	if (opts.client) {return {
		client: opts.client,
		stopOnDone: false
	};}
	const accountId = typeof opts.accountId === "string" && opts.accountId.trim().length > 0 ? normalizeAccountId(opts.accountId) : void 0;
	const active = getActiveMatrixClient(accountId);
	if (active) {return {
		client: active,
		stopOnDone: false
	};}
	if (!accountId) {
		const defaultClient = getActiveMatrixClient(DEFAULT_ACCOUNT_ID);
		if (defaultClient) {return {
			client: defaultClient,
			stopOnDone: false
		};}
		const anyActive = getAnyActiveMatrixClient();
		if (anyActive) {return {
			client: anyActive,
			stopOnDone: false
		};}
	}
	if (process.env.OPENCLAW_GATEWAY_PORT) {return {
		client: await resolveSharedMatrixClient({
			timeoutMs: opts.timeoutMs,
			accountId,
			cfg: opts.cfg
		}),
		stopOnDone: false
	};}
	return {
		client: await createPreparedMatrixClient({
			auth: await resolveMatrixAuth({
				accountId,
				cfg: opts.cfg
			}),
			timeoutMs: opts.timeoutMs,
			accountId
		}),
		stopOnDone: true
	};
}
//#endregion
//#region extensions/matrix/src/matrix/format.ts
const md = new MarkdownIt({
	html: false,
	linkify: true,
	breaks: true,
	typographer: false
});
md.enable("strikethrough");
const { escapeHtml } = md.utils;
md.renderer.rules.image = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");
md.renderer.rules.html_block = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");
md.renderer.rules.html_inline = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");
function markdownToMatrixHtml(markdown) {
	return md.render(markdown ?? "").trimEnd();
}
//#endregion
//#region extensions/matrix/src/matrix/send/types.ts
const MsgType = {
	Text: "m.text",
	Image: "m.image",
	Audio: "m.audio",
	Video: "m.video",
	File: "m.file",
	Notice: "m.notice"
};
const RelationType = {
	Annotation: "m.annotation",
	Replace: "m.replace",
	Thread: "m.thread"
};
const EventType = {
	Direct: "m.direct",
	Reaction: "m.reaction",
	RoomMessage: "m.room.message"
};
//#endregion
//#region extensions/matrix/src/matrix/send/formatting.ts
const getCore$2 = () => getMatrixRuntime();
function buildTextContent(body, relation) {
	const content = relation ? {
		msgtype: MsgType.Text,
		body,
		"m.relates_to": relation
	} : {
		msgtype: MsgType.Text,
		body
	};
	applyMatrixFormatting(content, body);
	return content;
}
function applyMatrixFormatting(content, body) {
	const formatted = markdownToMatrixHtml(body ?? "");
	if (!formatted) {return;}
	content.format = "org.matrix.custom.html";
	content.formatted_body = formatted;
}
function buildReplyRelation(replyToId) {
	const trimmed = replyToId?.trim();
	if (!trimmed) {return;}
	return { "m.in_reply_to": { event_id: trimmed } };
}
function buildThreadRelation(threadId, replyToId) {
	const trimmed = threadId.trim();
	return {
		rel_type: RelationType.Thread,
		event_id: trimmed,
		is_falling_back: true,
		"m.in_reply_to": { event_id: replyToId?.trim() || trimmed }
	};
}
function resolveMatrixMsgType(contentType, _fileName) {
	switch (getCore$2().media.mediaKindFromMime(contentType ?? "")) {
		case "image": return MsgType.Image;
		case "audio": return MsgType.Audio;
		case "video": return MsgType.Video;
		default: return MsgType.File;
	}
}
function resolveMatrixVoiceDecision(opts) {
	if (!opts.wantsVoice) {return { useVoice: false };}
	if (isMatrixVoiceCompatibleAudio(opts)) {return { useVoice: true };}
	return { useVoice: false };
}
function isMatrixVoiceCompatibleAudio(opts) {
	return getCore$2().media.isVoiceCompatibleAudio({
		contentType: opts.contentType,
		fileName: opts.fileName
	});
}
//#endregion
//#region extensions/matrix/src/matrix/send/media.ts
const getCore$1 = () => getMatrixRuntime();
function buildMatrixMediaInfo(params) {
	const base = {};
	if (Number.isFinite(params.size)) {base.size = params.size;}
	if (params.mimetype) {base.mimetype = params.mimetype;}
	if (params.imageInfo) {
		const dimensional = {
			...base,
			...params.imageInfo
		};
		if (typeof params.durationMs === "number") {return {
			...dimensional,
			duration: params.durationMs
		};}
		return dimensional;
	}
	if (typeof params.durationMs === "number") {return {
		...base,
		duration: params.durationMs
	};}
	if (Object.keys(base).length === 0) {return;}
	return base;
}
function buildMediaContent(params) {
	const info = buildMatrixMediaInfo({
		size: params.size,
		mimetype: params.mimetype,
		durationMs: params.durationMs,
		imageInfo: params.imageInfo
	});
	const base = {
		msgtype: params.msgtype,
		body: params.body,
		filename: params.filename,
		info: info ?? void 0
	};
	if (!params.file && params.url) {base.url = params.url;}
	if (params.file) {base.file = params.file;}
	if (params.isVoice) {
		base["org.matrix.msc3245.voice"] = {};
		if (typeof params.durationMs === "number") {base["org.matrix.msc1767.audio"] = { duration: params.durationMs };}
	}
	if (params.relation) {base["m.relates_to"] = params.relation;}
	applyMatrixFormatting(base, params.body);
	return base;
}
const THUMBNAIL_MAX_SIDE = 800;
const THUMBNAIL_QUALITY = 80;
async function prepareImageInfo(params) {
	const meta = await getCore$1().media.getImageMetadata(params.buffer).catch(() => null);
	if (!meta) {return;}
	const imageInfo = {
		w: meta.width,
		h: meta.height
	};
	if (Math.max(meta.width, meta.height) > THUMBNAIL_MAX_SIDE) {try {
		const thumbBuffer = await getCore$1().media.resizeToJpeg({
			buffer: params.buffer,
			maxSide: THUMBNAIL_MAX_SIDE,
			quality: THUMBNAIL_QUALITY,
			withoutEnlargement: true
		});
		const thumbMeta = await getCore$1().media.getImageMetadata(thumbBuffer).catch(() => null);
		imageInfo.thumbnail_url = await params.client.uploadContent(thumbBuffer, "image/jpeg", "thumbnail.jpg");
		if (thumbMeta) imageInfo.thumbnail_info = {
			w: thumbMeta.width,
			h: thumbMeta.height,
			mimetype: "image/jpeg",
			size: thumbBuffer.byteLength
		};
	} catch {}}
	return imageInfo;
}
async function resolveMediaDurationMs(params) {
	if (params.kind !== "audio" && params.kind !== "video") {return;}
	try {
		const { parseBuffer } = await import("./lib-Ca0eatVv.js");
		const fileInfo = params.contentType || params.fileName ? {
			mimeType: params.contentType,
			size: params.buffer.byteLength,
			path: params.fileName
		} : void 0;
		const durationSeconds = (await parseBuffer(params.buffer, fileInfo, {
			duration: true,
			skipCovers: true
		})).format.duration;
		if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds)) {return Math.max(0, Math.round(durationSeconds * 1e3));}
	} catch {}
}
async function uploadFile(client, file, params) {
	return await client.uploadContent(file, params.contentType, params.filename);
}
/**
* Upload media with optional encryption for E2EE rooms.
*/
async function uploadMediaMaybeEncrypted(client, roomId, buffer, params) {
	if (client.crypto && await client.crypto.isRoomEncrypted(roomId) && client.crypto) {
		const encrypted = await client.crypto.encryptMedia(buffer);
		const mxc = await client.uploadContent(encrypted.buffer, params.contentType, params.filename);
		return {
			url: mxc,
			file: {
				url: mxc,
				...encrypted.file
			}
		};
	}
	return { url: await uploadFile(client, buffer, params) };
}
//#endregion
//#region extensions/matrix/src/matrix/send/targets.ts
function normalizeTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) {throw new Error("Matrix target is required (room:<id> or #alias)");}
	return trimmed;
}
function normalizeThreadId(raw) {
	if (raw === void 0 || raw === null) {return null;}
	const trimmed = String(raw).trim();
	return trimmed ? trimmed : null;
}
const MAX_DIRECT_ROOM_CACHE_SIZE = 1024;
const directRoomCache = /* @__PURE__ */ new Map();
function setDirectRoomCached(key, value) {
	directRoomCache.set(key, value);
	if (directRoomCache.size > MAX_DIRECT_ROOM_CACHE_SIZE) {
		const oldest = directRoomCache.keys().next().value;
		if (oldest !== void 0) {directRoomCache.delete(oldest);}
	}
}
async function persistDirectRoom(client, userId, roomId) {
	let directContent = null;
	try {
		directContent = await client.getAccountData(EventType.Direct);
	} catch {}
	const existing = directContent && !Array.isArray(directContent) ? directContent : {};
	const current = Array.isArray(existing[userId]) ? existing[userId] : [];
	if (current[0] === roomId) {return;}
	const next = [roomId, ...current.filter((id) => id !== roomId)];
	try {
		await client.setAccountData(EventType.Direct, {
			...existing,
			[userId]: next
		});
	} catch {}
}
async function resolveDirectRoomId(client, userId) {
	const trimmed = userId.trim();
	if (!trimmed.startsWith("@")) {throw new Error(`Matrix user IDs must be fully qualified (got "${trimmed}")`);}
	const cached = directRoomCache.get(trimmed);
	if (cached) {return cached;}
	try {
		const directContent = await client.getAccountData(EventType.Direct);
		const list = Array.isArray(directContent?.[trimmed]) ? directContent[trimmed] : [];
		if (list && list.length > 0) {
			setDirectRoomCached(trimmed, list[0]);
			return list[0];
		}
	} catch {}
	let fallbackRoom = null;
	try {
		const rooms = await client.getJoinedRooms();
		for (const roomId of rooms) {
			let members;
			try {
				members = await client.getJoinedRoomMembers(roomId);
			} catch {
				continue;
			}
			if (!members.includes(trimmed)) {continue;}
			if (members.length === 2) {
				setDirectRoomCached(trimmed, roomId);
				await persistDirectRoom(client, trimmed, roomId);
				return roomId;
			}
			if (!fallbackRoom) {fallbackRoom = roomId;}
		}
	} catch {}
	if (fallbackRoom) {
		setDirectRoomCached(trimmed, fallbackRoom);
		await persistDirectRoom(client, trimmed, fallbackRoom);
		return fallbackRoom;
	}
	throw new Error(`No direct room found for ${trimmed} (m.direct missing)`);
}
async function resolveMatrixRoomId(client, raw) {
	const target = normalizeTarget(raw);
	const lowered = target.toLowerCase();
	if (lowered.startsWith("matrix:")) {return await resolveMatrixRoomId(client, target.slice(7));}
	if (lowered.startsWith("room:")) {return await resolveMatrixRoomId(client, target.slice(5));}
	if (lowered.startsWith("channel:")) {return await resolveMatrixRoomId(client, target.slice(8));}
	if (lowered.startsWith("user:")) {return await resolveDirectRoomId(client, target.slice(5));}
	if (target.startsWith("@")) {return await resolveDirectRoomId(client, target);}
	if (target.startsWith("#")) {
		const resolved = await client.resolveRoom(target);
		if (!resolved) {throw new Error(`Matrix alias ${target} could not be resolved`);}
		return resolved;
	}
	return target;
}
//#endregion
//#region extensions/matrix/src/matrix/send.ts
const MATRIX_TEXT_LIMIT = 4e3;
const getCore = () => getMatrixRuntime();
async function sendMessageMatrix(to, message, opts = {}) {
	const trimmedMessage = message?.trim() ?? "";
	if (!trimmedMessage && !opts.mediaUrl) {throw new Error("Matrix send requires text or media");}
	const { client, stopOnDone } = await resolveMatrixClient({
		client: opts.client,
		timeoutMs: opts.timeoutMs,
		accountId: opts.accountId,
		cfg: opts.cfg
	});
	const cfg = opts.cfg ?? getCore().config.loadConfig();
	try {
		const roomId = await resolveMatrixRoomId(client, to);
		return await enqueueSend(roomId, async () => {
			const tableMode = getCore().channel.text.resolveMarkdownTableMode({
				cfg,
				channel: "matrix",
				accountId: opts.accountId
			});
			const convertedMessage = getCore().channel.text.convertMarkdownTables(trimmedMessage, tableMode);
			const textLimit = getCore().channel.text.resolveTextChunkLimit(cfg, "matrix");
			const chunkLimit = Math.min(textLimit, MATRIX_TEXT_LIMIT);
			const chunkMode = getCore().channel.text.resolveChunkMode(cfg, "matrix", opts.accountId);
			const chunks = getCore().channel.text.chunkMarkdownTextWithMode(convertedMessage, chunkLimit, chunkMode);
			const threadId = normalizeThreadId(opts.threadId);
			const relation = threadId ? buildThreadRelation(threadId, opts.replyToId) : buildReplyRelation(opts.replyToId);
			const sendContent = async (content) => {
				return await client.sendMessage(roomId, content);
			};
			let lastMessageId = "";
			if (opts.mediaUrl) {
				const maxBytes = resolveMediaMaxBytes(opts.accountId, cfg);
				const media = await getCore().media.loadWebMedia(opts.mediaUrl, maxBytes);
				const uploaded = await uploadMediaMaybeEncrypted(client, roomId, media.buffer, {
					contentType: media.contentType,
					filename: media.fileName
				});
				const durationMs = await resolveMediaDurationMs({
					buffer: media.buffer,
					contentType: media.contentType,
					fileName: media.fileName,
					kind: media.kind ?? "unknown"
				});
				const baseMsgType = resolveMatrixMsgType(media.contentType, media.fileName);
				const { useVoice } = resolveMatrixVoiceDecision({
					wantsVoice: opts.audioAsVoice === true,
					contentType: media.contentType,
					fileName: media.fileName
				});
				const msgtype = useVoice ? MsgType.Audio : baseMsgType;
				const imageInfo = msgtype === MsgType.Image ? await prepareImageInfo({
					buffer: media.buffer,
					client
				}) : void 0;
				const [firstChunk, ...rest] = chunks;
				lastMessageId = await sendContent(buildMediaContent({
					msgtype,
					body: useVoice ? "Voice message" : firstChunk ?? media.fileName ?? "(file)",
					url: uploaded.url,
					file: uploaded.file,
					filename: media.fileName,
					mimetype: media.contentType,
					size: media.buffer.byteLength,
					durationMs,
					relation,
					isVoice: useVoice,
					imageInfo
				})) ?? lastMessageId;
				const textChunks = useVoice ? chunks : rest;
				const followupRelation = threadId ? relation : void 0;
				for (const chunk of textChunks) {
					const text = chunk.trim();
					if (!text) {continue;}
					lastMessageId = await sendContent(buildTextContent(text, followupRelation)) ?? lastMessageId;
				}
			} else {for (const chunk of chunks.length ? chunks : [""]) {
				const text = chunk.trim();
				if (!text) continue;
				lastMessageId = await sendContent(buildTextContent(text, relation)) ?? lastMessageId;
			}}
			return {
				messageId: lastMessageId || "unknown",
				roomId
			};
		});
	} finally {
		if (stopOnDone) {client.stop();}
	}
}
async function sendPollMatrix(to, poll, opts = {}) {
	if (!poll.question?.trim()) {throw new Error("Matrix poll requires a question");}
	if (!poll.options?.length) {throw new Error("Matrix poll requires options");}
	const { client, stopOnDone } = await resolveMatrixClient({
		client: opts.client,
		timeoutMs: opts.timeoutMs,
		accountId: opts.accountId,
		cfg: opts.cfg
	});
	try {
		const roomId = await resolveMatrixRoomId(client, to);
		const pollContent = buildPollStartContent(poll);
		const threadId = normalizeThreadId(opts.threadId);
		const pollPayload = threadId ? {
			...pollContent,
			"m.relates_to": buildThreadRelation(threadId)
		} : pollContent;
		return {
			eventId: await client.sendEvent(roomId, "m.poll.start", pollPayload) ?? "unknown",
			roomId
		};
	} finally {
		if (stopOnDone) {client.stop();}
	}
}
async function sendTypingMatrix(roomId, typing, timeoutMs, client) {
	const { client: resolved, stopOnDone } = await resolveMatrixClient({
		client,
		timeoutMs
	});
	try {
		const resolvedTimeoutMs = typeof timeoutMs === "number" ? timeoutMs : 3e4;
		await resolved.setTyping(roomId, typing, resolvedTimeoutMs);
	} finally {
		if (stopOnDone) {resolved.stop();}
	}
}
async function sendReadReceiptMatrix(roomId, eventId, client) {
	if (!eventId?.trim()) {return;}
	const { client: resolved, stopOnDone } = await resolveMatrixClient({ client });
	try {
		const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
		await resolved.sendReadReceipt(resolvedRoom, eventId.trim());
	} finally {
		if (stopOnDone) {resolved.stop();}
	}
}
async function reactMatrixMessage(roomId, messageId, emoji, client) {
	if (!emoji.trim()) {throw new Error("Matrix reaction requires an emoji");}
	const { client: resolved, stopOnDone } = await resolveMatrixClient({ client });
	try {
		const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
		const reaction = { "m.relates_to": {
			rel_type: RelationType.Annotation,
			event_id: messageId,
			key: emoji
		} };
		await resolved.sendEvent(resolvedRoom, EventType.Reaction, reaction);
	} finally {
		if (stopOnDone) {resolved.stop();}
	}
}
//#endregion
export { stopSharedClientForAccount as C, isBunRuntime as D, loadMatrixSdk as E, resolveSharedMatrixClient as S, resolveMatrixAuth as T, resolveDefaultMatrixAccountId as _, sendTypingMatrix as a, listMatrixDirectoryGroupsLive as b, getActiveMatrixClient as c, isPollStartType as d, parsePollStartContent as f, listMatrixAccountIds as g, resolveMatrixTargets as h, sendReadReceiptMatrix as i, setActiveMatrixClient as l, matrixSetupAdapter as m, sendMessageMatrix as n, resolveMatrixRoomId as o, matrixSetupWizard as p, sendPollMatrix as r, createPreparedMatrixClient as s, reactMatrixMessage as t, formatPollAsText as u, resolveMatrixAccount as v, createMatrixClient as w, listMatrixDirectoryPeersLive as x, resolveMatrixAccountConfig as y };
