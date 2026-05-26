import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { o as coerceSecretRef, u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId, r as normalizeOptionalAccountId } from "./account-id-B32J-iNN.js";
import { n as retryAsync } from "./retry-CryZAmlE.js";
import "./error-runtime-DGHc7DZw.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-DWa7yCpn.js";
import { o as isPrivateNetworkOptInEnabled, u as ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "./ssrf-policy-CIwd6x-p.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./retry-runtime-BLxc3H40.js";
import "./secret-input-runtime-BxNajKSO.js";
import { a as resolveMatrixDefaultOrOnlyAccountId, n as requiresExplicitMatrixDefaultAccount, o as resolveMatrixAccountStringValues } from "./account-selection-CfoMW0gI.js";
import { t as getMatrixScopedEnvVarNames } from "./env-vars-J2eHsfqp.js";
import { o as resolveMatrixBaseConfig, r as listNormalizedMatrixAccountIds, t as findMatrixAccountConfig } from "./account-config-C6EZ3oG4.js";
import { i as resolveScopedMatrixEnvConfig, n as resolveGlobalMatrixEnvConfig } from "./env-auth-RoZX59IM.js";
import { t as resolveMatrixConfigFieldPath } from "./config-paths-DExRbAi8.js";
import { t as resolveValidatedMatrixHomeserverUrl } from "./url-validation-CnTuySPp.js";
import { r as repairCurrentTokenStorageMetaDeviceId } from "./storage-BVAqboeh.js";
//#region extensions/matrix/src/matrix/client/config.ts
let matrixAuthClientDepsPromise;
let matrixCredentialsReadDepsPromise;
let matrixCredentialsWriteRuntimePromise;
let matrixSecretInputDepsPromise;
const MATRIX_AUTH_REQUEST_RETRY_RE = /\b(fetch failed|econnreset|econnrefused|enotfound|etimedout|ehostunreach|enetunreach|eai_again|und_err_|socket hang up|network|headers timeout|body timeout|connect timeout)\b/i;
async function loadMatrixAuthClientDeps() {
	matrixAuthClientDepsPromise ??= Promise.all([import("./sdk-Dxd-qmfQ.js"), import("./logging-CO1uJYr1.js")]).then(([sdkModule, loggingModule]) => ({
		MatrixClient: sdkModule.MatrixClient,
		ensureMatrixSdkLoggingConfigured: loggingModule.ensureMatrixSdkLoggingConfigured
	}));
	return await matrixAuthClientDepsPromise;
}
async function loadMatrixCredentialsReadDeps() {
	matrixCredentialsReadDepsPromise ??= import("./credentials-read-D-kTAu2h.js").then((credentialsReadModule) => ({
		loadMatrixCredentials: credentialsReadModule.loadMatrixCredentials,
		credentialsMatchConfig: credentialsReadModule.credentialsMatchConfig
	}));
	return await matrixCredentialsReadDepsPromise;
}
async function loadMatrixCredentialsWriteRuntime() {
	matrixCredentialsWriteRuntimePromise ??= import("./credentials-write.runtime.js");
	return await matrixCredentialsWriteRuntimePromise;
}
async function loadMatrixSecretInputDeps() {
	matrixSecretInputDepsPromise ??= import("./config-secret-input.runtime.js").then((runtime) => ({ resolveConfiguredSecretInputString: runtime.resolveConfiguredSecretInputString }));
	return await matrixSecretInputDepsPromise;
}
function shouldRetryMatrixAuthRequest(err) {
	return MATRIX_AUTH_REQUEST_RETRY_RE.test(formatErrorMessage(err));
}
function isAbortSignalTriggered(signal) {
	return signal?.aborted === true;
}
function credentialsMatchBackfillAuthLineage(params) {
	if (!params.stored) return true;
	return params.stored.homeserver === params.auth.homeserver && params.stored.userId === params.auth.userId && params.stored.accessToken === params.auth.accessToken;
}
async function retryMatrixAuthRequest(label, run) {
	return await retryAsync(run, {
		attempts: 3,
		minDelayMs: 250,
		maxDelayMs: 1500,
		jitter: .1,
		label,
		shouldRetry: (err) => shouldRetryMatrixAuthRequest(err)
	});
}
async function fetchMatrixWhoamiIdentity(params) {
	const { MatrixClient, ensureMatrixSdkLoggingConfigured } = await loadMatrixAuthClientDeps();
	ensureMatrixSdkLoggingConfigured();
	const tempClient = new MatrixClient(params.homeserver, params.accessToken, {
		userId: params.userId,
		ssrfPolicy: params.ssrfPolicy,
		dispatcherPolicy: params.dispatcherPolicy
	});
	return await retryMatrixAuthRequest("matrix auth whoami", async () => {
		return await tempClient.doRequest("GET", "/_matrix/client/v3/account/whoami");
	});
}
function readEnvSecretRefFallback(params) {
	const ref = coerceSecretRef(params.value, params.config?.secrets?.defaults);
	if (!ref || ref.source !== "env" || !params.env) return;
	const providerConfig = params.config?.secrets?.providers?.[ref.provider];
	if (providerConfig) {
		if (providerConfig.source !== "env") throw new Error(`Secret provider "${ref.provider}" has source "${providerConfig.source}" but ref requests "env".`);
		if (providerConfig.allowlist && !providerConfig.allowlist.includes(ref.id)) throw new Error(`Environment variable "${ref.id}" is not allowlisted in secrets.providers.${ref.provider}.allowlist.`);
	} else if (ref.provider !== (params.config?.secrets?.defaults?.env?.trim() || "default")) throw new Error(`Secret provider "${ref.provider}" is not configured (ref: ${ref.source}:${ref.provider}:${ref.id}).`);
	const resolved = params.env[ref.id];
	if (typeof resolved !== "string") return;
	const trimmed = resolved.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function clean(value, path, opts) {
	const ref = coerceSecretRef(value, opts?.config?.secrets?.defaults);
	if (opts?.suppressSecretRef && ref) return "";
	return normalizeResolvedSecretInputString({
		value: opts?.allowEnvSecretRefFallback ? ref?.source === "env" ? readEnvSecretRefFallback({
			value,
			env: opts.env,
			config: opts.config
		}) ?? value : ref ? "" : value : value,
		path,
		defaults: opts?.config?.secrets?.defaults
	}) ?? "";
}
function resolveMatrixBaseConfigFieldPath(field) {
	return `channels.matrix.${field}`;
}
function shouldAllowEnvSecretRefFallback(field) {
	return field === "accessToken" || field === "password";
}
function hasConfiguredSecretInputValue(value, cfg) {
	return typeof value === "string" && value.trim().length > 0 || Boolean(coerceSecretRef(value, cfg.secrets?.defaults));
}
function hasConfiguredMatrixAccessTokenSource(params) {
	const normalizedAccountId = normalizeAccountId(params.accountId);
	const account = findMatrixAccountConfig(params.cfg, normalizedAccountId) ?? {};
	const scopedAccessTokenVar = getMatrixScopedEnvVarNames(normalizedAccountId).accessToken;
	if (hasConfiguredSecretInputValue(account.accessToken, params.cfg) || clean(params.env[scopedAccessTokenVar], scopedAccessTokenVar).length > 0) return true;
	if (normalizedAccountId !== "default") return false;
	return hasConfiguredSecretInputValue(resolveMatrixBaseConfig(params.cfg).accessToken, params.cfg) || clean(params.env.MATRIX_ACCESS_TOKEN, "MATRIX_ACCESS_TOKEN").length > 0;
}
function resolveConfiguredMatrixAuthInput(params) {
	const normalizedAccountId = normalizeAccountId(params.accountId);
	const accountValue = (findMatrixAccountConfig(params.cfg, normalizedAccountId) ?? {})[params.field];
	if (accountValue !== void 0) return {
		value: accountValue,
		path: resolveMatrixConfigFieldPath(params.cfg, normalizedAccountId, params.field)
	};
	const scopedKeys = getMatrixScopedEnvVarNames(normalizedAccountId);
	const scopedValue = resolveScopedMatrixEnvConfig(normalizedAccountId, params.env)[params.field];
	if (scopedValue !== void 0) return {
		value: scopedValue,
		path: params.field === "accessToken" ? scopedKeys.accessToken : scopedKeys.password
	};
	if (normalizedAccountId !== "default") return;
	const baseValue = resolveMatrixBaseConfig(params.cfg)[params.field];
	if (baseValue !== void 0) return {
		value: baseValue,
		path: resolveMatrixBaseConfigFieldPath(params.field)
	};
	const globalValue = params.field === "accessToken" ? params.env.MATRIX_ACCESS_TOKEN : params.env.MATRIX_PASSWORD;
	if (globalValue !== void 0) return {
		value: globalValue,
		path: params.field === "accessToken" ? "MATRIX_ACCESS_TOKEN" : "MATRIX_PASSWORD"
	};
}
async function resolveConfiguredMatrixAuthSecretInput(params) {
	const configured = resolveConfiguredMatrixAuthInput(params);
	if (!configured) return;
	if (!coerceSecretRef(configured.value, params.cfg.secrets?.defaults)) return normalizeResolvedSecretInputString({
		value: configured.value,
		path: configured.path,
		defaults: params.cfg.secrets?.defaults
	});
	const { resolveConfiguredSecretInputString } = await loadMatrixSecretInputDeps();
	const resolved = await resolveConfiguredSecretInputString({
		config: params.cfg,
		env: params.env,
		value: configured.value,
		path: configured.path,
		unresolvedReasonStyle: "detailed"
	});
	if (resolved.value !== void 0) return resolved.value;
	throw new Error(resolved.unresolvedRefReason ?? `${configured.path} SecretRef could not be resolved.`);
}
function readMatrixBaseConfigField(matrix, field, opts) {
	return clean(matrix[field], resolveMatrixBaseConfigFieldPath(field), {
		env: opts?.env,
		config: opts?.config,
		allowEnvSecretRefFallback: shouldAllowEnvSecretRefFallback(field),
		suppressSecretRef: opts?.suppressSecretRef
	});
}
function readMatrixAccountConfigField(cfg, accountId, account, field, opts) {
	return clean(account[field], resolveMatrixConfigFieldPath(cfg, accountId, field), {
		env: opts?.env,
		config: opts?.config,
		allowEnvSecretRefFallback: shouldAllowEnvSecretRefFallback(field),
		suppressSecretRef: opts?.suppressSecretRef
	});
}
function clampMatrixInitialSyncLimit(value) {
	return typeof value === "number" ? Math.max(0, Math.floor(value)) : void 0;
}
function buildMatrixNetworkFields(params) {
	const dispatcherPolicy = params.dispatcherPolicy ?? (params.proxy ? {
		mode: "explicit-proxy",
		proxyUrl: params.proxy
	} : void 0);
	if (!params.allowPrivateNetwork && !dispatcherPolicy) return {};
	return {
		...params.allowPrivateNetwork ? {
			allowPrivateNetwork: true,
			ssrfPolicy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(true)
		} : {},
		...dispatcherPolicy ? { dispatcherPolicy } : {}
	};
}
function hasScopedMatrixEnvConfig(accountId, env) {
	const scoped = resolveScopedMatrixEnvConfig(accountId, env);
	return Boolean(scoped.homeserver || scoped.userId || scoped.accessToken || scoped.password || scoped.deviceId || scoped.deviceName);
}
function resolveMatrixConfigForAccount(cfg, accountId, env = process.env) {
	const matrix = resolveMatrixBaseConfig(cfg);
	const account = findMatrixAccountConfig(cfg, accountId) ?? {};
	const normalizedAccountId = normalizeAccountId(accountId);
	const suppressInactivePasswordSecretRef = hasConfiguredMatrixAccessTokenSource({
		cfg,
		env,
		accountId: normalizedAccountId
	});
	const fieldReadOptions = {
		env,
		config: cfg
	};
	const scopedEnv = resolveScopedMatrixEnvConfig(normalizedAccountId, env);
	const globalEnv = resolveGlobalMatrixEnvConfig(env);
	const accountField = (field) => readMatrixAccountConfigField(cfg, normalizedAccountId, account, field, {
		...fieldReadOptions,
		suppressSecretRef: field === "password" ? suppressInactivePasswordSecretRef : void 0
	});
	const resolvedStrings = resolveMatrixAccountStringValues({
		accountId: normalizedAccountId,
		account: {
			homeserver: accountField("homeserver"),
			userId: accountField("userId"),
			accessToken: accountField("accessToken"),
			password: accountField("password"),
			deviceId: accountField("deviceId"),
			deviceName: accountField("deviceName")
		},
		scopedEnv,
		channel: {
			homeserver: readMatrixBaseConfigField(matrix, "homeserver", fieldReadOptions),
			userId: readMatrixBaseConfigField(matrix, "userId", fieldReadOptions),
			accessToken: readMatrixBaseConfigField(matrix, "accessToken", fieldReadOptions),
			password: readMatrixBaseConfigField(matrix, "password", {
				...fieldReadOptions,
				suppressSecretRef: suppressInactivePasswordSecretRef
			}),
			deviceId: readMatrixBaseConfigField(matrix, "deviceId", fieldReadOptions),
			deviceName: readMatrixBaseConfigField(matrix, "deviceName", fieldReadOptions)
		},
		globalEnv
	});
	const initialSyncLimit = clampMatrixInitialSyncLimit(account.initialSyncLimit) ?? clampMatrixInitialSyncLimit(matrix.initialSyncLimit);
	const encryption = typeof account.encryption === "boolean" ? account.encryption : matrix.encryption ?? false;
	const allowPrivateNetwork = isPrivateNetworkOptInEnabled(account) || isPrivateNetworkOptInEnabled(matrix) ? true : void 0;
	return {
		homeserver: resolvedStrings.homeserver,
		userId: resolvedStrings.userId,
		accessToken: resolvedStrings.accessToken || void 0,
		password: resolvedStrings.password || void 0,
		deviceId: resolvedStrings.deviceId || void 0,
		deviceName: resolvedStrings.deviceName || void 0,
		initialSyncLimit,
		encryption,
		...buildMatrixNetworkFields({
			allowPrivateNetwork,
			proxy: account.proxy ?? matrix.proxy
		})
	};
}
function resolveImplicitMatrixAccountId(cfg, env = process.env) {
	if (requiresExplicitMatrixDefaultAccount(cfg, env)) return null;
	return normalizeAccountId(resolveMatrixDefaultOrOnlyAccountId(cfg, env));
}
function resolveMatrixAuthContext(params) {
	const cfg = requireRuntimeConfig(params.cfg, "Matrix auth context");
	const env = params?.env ?? process.env;
	const explicitAccountId = normalizeOptionalAccountId(params?.accountId);
	const effectiveAccountId = explicitAccountId ?? resolveImplicitMatrixAccountId(cfg, env);
	if (!effectiveAccountId) throw new Error("Multiple Matrix accounts are configured and channels.matrix.defaultAccount is not set. Set \"channels.matrix.defaultAccount\" to the intended account or pass --account <id>.");
	if (explicitAccountId && explicitAccountId !== "default" && !listNormalizedMatrixAccountIds(cfg).includes(explicitAccountId) && !hasScopedMatrixEnvConfig(explicitAccountId, env)) throw new Error(`Matrix account "${explicitAccountId}" is not configured. Add channels.matrix.accounts.${explicitAccountId} or define scoped ${getMatrixScopedEnvVarNames(explicitAccountId).accessToken.replace(/_ACCESS_TOKEN$/, "")}_* variables.`);
	return {
		cfg,
		env,
		accountId: effectiveAccountId,
		resolved: resolveMatrixConfigForAccount(cfg, effectiveAccountId, env)
	};
}
async function resolveMatrixAuth(params) {
	if (!params?.cfg) throw new Error("Matrix auth requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.");
	const { cfg, env, accountId, resolved } = resolveMatrixAuthContext({
		cfg: params.cfg,
		env: params.env,
		accountId: params.accountId
	});
	const accessToken = await resolveConfiguredMatrixAuthSecretInput({
		cfg,
		env,
		accountId,
		field: "accessToken"
	}) ?? resolved.accessToken;
	const tokenAuthPassword = resolved.password;
	const homeserver = await resolveValidatedMatrixHomeserverUrl(resolved.homeserver, { dangerouslyAllowPrivateNetwork: resolved.allowPrivateNetwork });
	const { loadMatrixCredentials, credentialsMatchConfig } = await loadMatrixCredentialsReadDeps();
	const cached = loadMatrixCredentials(env, accountId);
	const cachedCredentials = cached && credentialsMatchConfig(cached, {
		homeserver,
		userId: resolved.userId || "",
		accessToken
	}) ? cached : null;
	if (accessToken) {
		let userId = resolved.userId;
		const hasMatchingCachedToken = cachedCredentials?.accessToken === accessToken;
		let knownDeviceId = hasMatchingCachedToken ? cachedCredentials?.deviceId || resolved.deviceId : resolved.deviceId;
		if (!userId) {
			const whoami = await fetchMatrixWhoamiIdentity({
				homeserver,
				accessToken,
				userId,
				ssrfPolicy: resolved.ssrfPolicy,
				dispatcherPolicy: resolved.dispatcherPolicy
			});
			const fetchedUserId = whoami.user_id?.trim();
			if (!fetchedUserId) throw new Error("Matrix whoami did not return user_id");
			userId = fetchedUserId;
			knownDeviceId = knownDeviceId || whoami.device_id?.trim() || resolved.deviceId;
		}
		if (!cachedCredentials || !hasMatchingCachedToken || cachedCredentials.userId !== userId || (cachedCredentials.deviceId || void 0) !== knownDeviceId) {
			const { saveMatrixCredentials } = await loadMatrixCredentialsWriteRuntime();
			await saveMatrixCredentials({
				homeserver,
				userId,
				accessToken,
				deviceId: knownDeviceId
			}, env, accountId);
		} else if (hasMatchingCachedToken) {
			const { touchMatrixCredentials } = await loadMatrixCredentialsWriteRuntime();
			await touchMatrixCredentials(env, accountId);
		}
		return {
			accountId,
			homeserver,
			userId,
			accessToken,
			password: tokenAuthPassword,
			deviceId: knownDeviceId,
			deviceName: resolved.deviceName,
			initialSyncLimit: resolved.initialSyncLimit,
			encryption: resolved.encryption,
			...buildMatrixNetworkFields({
				allowPrivateNetwork: resolved.allowPrivateNetwork,
				dispatcherPolicy: resolved.dispatcherPolicy
			})
		};
	}
	if (cachedCredentials) {
		const { touchMatrixCredentials } = await loadMatrixCredentialsWriteRuntime();
		await touchMatrixCredentials(env, accountId);
		return {
			accountId,
			homeserver: cachedCredentials.homeserver,
			userId: cachedCredentials.userId,
			accessToken: cachedCredentials.accessToken,
			password: tokenAuthPassword,
			deviceId: cachedCredentials.deviceId || resolved.deviceId,
			deviceName: resolved.deviceName,
			initialSyncLimit: resolved.initialSyncLimit,
			encryption: resolved.encryption,
			...buildMatrixNetworkFields({
				allowPrivateNetwork: resolved.allowPrivateNetwork,
				dispatcherPolicy: resolved.dispatcherPolicy
			})
		};
	}
	if (!resolved.userId) throw new Error("Matrix userId is required when no access token is configured (matrix.userId)");
	const password = await resolveConfiguredMatrixAuthSecretInput({
		cfg,
		env,
		accountId,
		field: "password"
	}) ?? resolved.password;
	if (!password) throw new Error("Matrix password is required when no access token is configured (matrix.password)");
	const { MatrixClient, ensureMatrixSdkLoggingConfigured } = await loadMatrixAuthClientDeps();
	ensureMatrixSdkLoggingConfigured();
	const loginClient = new MatrixClient(homeserver, "", {
		ssrfPolicy: resolved.ssrfPolicy,
		dispatcherPolicy: resolved.dispatcherPolicy
	});
	const login = await retryMatrixAuthRequest("matrix auth login", async () => {
		return await loginClient.doRequest("POST", "/_matrix/client/v3/login", void 0, {
			type: "m.login.password",
			identifier: {
				type: "m.id.user",
				user: resolved.userId
			},
			password,
			device_id: resolved.deviceId,
			initial_device_display_name: resolved.deviceName ?? "OpenClaw Gateway"
		});
	});
	const loginAccessToken = login.access_token?.trim();
	if (!loginAccessToken) throw new Error("Matrix login did not return an access token");
	const auth = {
		accountId,
		homeserver,
		userId: login.user_id ?? resolved.userId,
		accessToken: loginAccessToken,
		password,
		deviceId: login.device_id ?? resolved.deviceId,
		deviceName: resolved.deviceName,
		initialSyncLimit: resolved.initialSyncLimit,
		encryption: resolved.encryption,
		...buildMatrixNetworkFields({
			allowPrivateNetwork: resolved.allowPrivateNetwork,
			dispatcherPolicy: resolved.dispatcherPolicy
		})
	};
	const { saveMatrixCredentials } = await loadMatrixCredentialsWriteRuntime();
	await saveMatrixCredentials({
		homeserver: auth.homeserver,
		userId: auth.userId,
		accessToken: auth.accessToken,
		deviceId: auth.deviceId
	}, env, accountId);
	return auth;
}
async function backfillMatrixAuthDeviceIdAfterStartup(params) {
	const knownDeviceId = params.auth.deviceId?.trim();
	if (knownDeviceId) return knownDeviceId;
	if (isAbortSignalTriggered(params.abortSignal)) return;
	const deviceId = (await fetchMatrixWhoamiIdentity({
		homeserver: params.auth.homeserver,
		accessToken: params.auth.accessToken,
		userId: params.auth.userId,
		ssrfPolicy: params.auth.ssrfPolicy,
		dispatcherPolicy: params.auth.dispatcherPolicy
	})).device_id?.trim();
	if (!deviceId) return;
	if (isAbortSignalTriggered(params.abortSignal)) return;
	const env = params.env ?? process.env;
	const { loadMatrixCredentials } = await loadMatrixCredentialsReadDeps();
	if (!credentialsMatchBackfillAuthLineage({
		stored: loadMatrixCredentials(env, params.auth.accountId),
		auth: params.auth
	})) return;
	if (!repairCurrentTokenStorageMetaDeviceId({
		homeserver: params.auth.homeserver,
		userId: params.auth.userId,
		accessToken: params.auth.accessToken,
		accountId: params.auth.accountId,
		deviceId,
		env: params.env
	})) throw new Error("Matrix deviceId backfill failed to repair current-token storage metadata");
	if (isAbortSignalTriggered(params.abortSignal)) return;
	return await (await loadMatrixCredentialsWriteRuntime()).saveBackfilledMatrixDeviceId({
		homeserver: params.auth.homeserver,
		userId: params.auth.userId,
		accessToken: params.auth.accessToken,
		deviceId
	}, env, params.auth.accountId) === "saved" ? deviceId : void 0;
}
//#endregion
export { resolveMatrixConfigForAccount as i, resolveMatrixAuth as n, resolveMatrixAuthContext as r, backfillMatrixAuthDeviceIdAfterStartup as t };
