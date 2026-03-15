import { g as normalizeAccountId, h as DEFAULT_ACCOUNT_ID } from "./session-key-CbP51u9x.js";
import { Ct as warnMissingProviderGroupPolicyFallbackOnce, Dt as resolveChannelEntryMatch, Gt as hasConfiguredSecretInput, Jt as normalizeResolvedSecretInputString, Tt as buildChannelKeyCandidates, Yt as normalizeSecretInputString, _t as GROUP_POLICY_BLOCKED_LABEL, bt as resolveDefaultGroupPolicy, fn as createAccountListHelpers, ft as evaluateGroupRouteAccessForPolicy, gt as resolveSenderScopedGroupPolicy, yt as resolveAllowlistProviderRuntimeGroupPolicy } from "./runtime-DRRlb-lt.js";
import { $a as buildSecretInputSchema, Gt as resolveDmGroupAccessWithLists, Jt as resolveInboundSessionEnvelopeContext, Ka as createScopedPairingAccess, Vt as readStoreAllowFromForDmPolicy, Wa as issuePairingChallenge, _l as jsonResult, bl as readStringParam, c as promptSingleChannelSecretInput, eo as createTypingCallbacks, h as setTopLevelChannelGroupPolicy, ha as toLocationContext, hl as createActionGate, in as resolveControlCommandGate, ma as formatLocationText, n as buildSingleChannelSecretPromptState, no as logInboundDrop, r as mergeAllowFromEntries, ro as logTypingFailure, t as addWildcardAllowFrom, vl as readNumberParam, yl as readReactionParams } from "./setup-wizard-helpers-Bds9SZeS.js";
import "./provider-env-vars-CWXfFyDU.js";
import "./logger-DEV1v8zB.js";
import "./tmp-openclaw-dir-DGafsubg.js";
import "./subsystem-BunQspj4.js";
import "./utils-C9epF7GR.js";
import "./fetch-s6LpGbVn.js";
import "./retry-Bdb5CNwD.js";
import { t as emptyPluginConfigSchema } from "./config-schema-X8cahxVt.js";
import "./paths-BoU0P6Xb.js";
import { o as formatResolvedUnresolvedNote, u as mapAllowlistResolutionInputs } from "./plugin-sdk-VLbTPvOr.js";
import "./webhook-targets-DPRi3syU.js";
import { A as ToolPolicySchema, G as buildProbeChannelStatusSummary, J as collectStatusIssuesFromLastError } from "./signal-Bycwzc0M.js";
import { T as MarkdownConfigSchema, a as formatPairingApproveHint, n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection, u as buildChannelConfigSchema } from "./config-helpers-C9J9Kf27.js";
import "./fetch-CokEYQHV.js";
import "./exec-LHBFP7K9.js";
import { j as normalizeStringEntries } from "./agent-scope-BAdJcjtf.js";
import { r as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "./setup-helpers-kuIKtuQw.js";
import { n as createReplyPrefixOptions, u as formatDocsLink } from "./reply-prefix-B-13vT7e.js";
import "./logger-kC9I1OJ3.js";
import { t as fetchWithSsrFGuard } from "./fetch-guard-COmtEumo.js";
import "./resolve-route-5UJLanKQ.js";
import "./pairing-token-BUkoGEse.js";
import "./query-expansion-DrHj090u.js";
import "./redact-DDISwu8-.js";
import { i as resolveAllowlistMatchByCandidates, n as formatAllowlistMatchMeta, o as resolveCompiledAllowlistMatch, r as resolveAllowlistCandidates, t as compileAllowlist } from "./allowlist-match-CTtlT8WI.js";
import { t as PAIRING_APPROVED_MESSAGE } from "./channel-plugin-common-cMzLzrLW.js";
import "./secret-file-B_1xic5c.js";
import "./line-DxANBoSD.js";
import "./text-chunking-Km2nBx_6.js";
import { r as dispatchReplyFromConfigWithSettledDispatcher } from "./inbound-reply-dispatch-SyBMbS2x.js";
import "./outbound-media-nwsOJ3Sf.js";
import { n as resolveRuntimeEnv, t as createLoggerBackedRuntime } from "./runtime-C8QhqR-z.js";
import { t as runPluginCommandWithTimeout } from "./run-command-Z5uOHylE.js";
import "./device-pairing-cTvIZwx2.js";
import { i as mergeAllowlist, o as summarizeMapping } from "./resolve-utils-D-PSzOHf.js";
import "./bluebubbles-BUOnMB_W.js";
import "./upsert-with-lock-A5dg0Uin.js";
import "./self-hosted-provider-setup-DGcVewib.js";
import "./ollama-setup-CObwBzad.js";
import "./vllm-setup-Pbn0jwU6.js";
import "./compat.js";
import { i as getMatrixRuntime, r as loadMatrixCredentials, t as credentialsMatchConfig } from "./credentials-vfD2uryt.js";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import "node:os";
import "node:crypto";
import { fileURLToPath } from "node:url";
//#region extensions/matrix/src/matrix/sdk-runtime.ts
let cachedMatrixSdkRuntime = null;
function loadMatrixSdk() {
	if (cachedMatrixSdkRuntime) {return cachedMatrixSdkRuntime;}
	cachedMatrixSdkRuntime = createRequire(import.meta.url)("@vector-im/matrix-bot-sdk");
	return cachedMatrixSdkRuntime;
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
	const { loadMatrixCredentials, saveMatrixCredentials, credentialsMatchConfig, touchMatrixCredentials } = await import("./credentials-vfD2uryt.js").then((n) => n.n);
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
export { DEFAULT_ACCOUNT_ID, GROUP_POLICY_BLOCKED_LABEL, MarkdownConfigSchema, PAIRING_APPROVED_MESSAGE, ToolPolicySchema, addWildcardAllowFrom, applyAccountNameToChannelSection, buildChannelConfigSchema, buildChannelKeyCandidates, buildProbeChannelStatusSummary, buildSecretInputSchema, buildSingleChannelSecretPromptState, collectStatusIssuesFromLastError, compileAllowlist, createAccountListHelpers, createActionGate, createLoggerBackedRuntime, createReplyPrefixOptions, createScopedPairingAccess, createTypingCallbacks, deleteAccountFromConfigSection, dispatchReplyFromConfigWithSettledDispatcher, emptyPluginConfigSchema, evaluateGroupRouteAccessForPolicy, fetchWithSsrFGuard, formatAllowlistMatchMeta, formatDocsLink, formatLocationText, formatPairingApproveHint, formatResolvedUnresolvedNote, hasConfiguredSecretInput, issuePairingChallenge, jsonResult, logInboundDrop, logTypingFailure, matrixSetupAdapter, matrixSetupWizard, mergeAllowFromEntries, mergeAllowlist, normalizeAccountId, normalizeResolvedSecretInputString, normalizeSecretInputString, normalizeStringEntries, promptSingleChannelSecretInput, readNumberParam, readReactionParams, readStoreAllowFromForDmPolicy, readStringParam, resolveAllowlistCandidates, resolveAllowlistMatchByCandidates, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelEntryMatch, resolveCompiledAllowlistMatch, resolveControlCommandGate, resolveDefaultGroupPolicy, resolveDmGroupAccessWithLists, resolveInboundSessionEnvelopeContext, resolveRuntimeEnv, resolveSenderScopedGroupPolicy, runPluginCommandWithTimeout, setAccountEnabledInConfigSection, setTopLevelChannelGroupPolicy, summarizeMapping, toLocationContext, warnMissingProviderGroupPolicyFallbackOnce };
