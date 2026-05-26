import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { d as resolveGatewayPort, s as resolveConfigPath, y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { a as trimToUndefined } from "./credential-planner-DPeD90hR.js";
import "./credentials-BJ7jvgw3.js";
import { f as isLoopbackIpAddress } from "./ip-WAe3-2zT.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { r as loadOrCreateDeviceIdentity } from "./device-identity-BuQ9YOu8.js";
import { t as loadGatewayTlsRuntime } from "./gateway-kClD4_Qv.js";
import { o as redactSensitiveUrlLikeString } from "./redact-sensitive-url-NNYIE41N.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import "./message-channel-CYCKkVrh.js";
import { n as resolveSafeTimeoutDelayMs } from "./timer-delay-awNPCchy.js";
import { t as startGatewayClientWhenEventLoopReady } from "./client-start-readiness-zY0I9Wur.js";
import { n as resolvePreauthHandshakeTimeoutMs } from "./handshake-timeouts-DRUWxVZ0.js";
import { a as isGatewayConnectAssemblyError, n as GatewayClient } from "./client-B1EH_7Mz.js";
import "./protocol-DiXjp30g.js";
import "./version-DDqbebEG.js";
import { t as buildGatewayConnectionDetailsWithResolvers } from "./connection-details-BUwiTtDD.js";
import { t as resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs-OTPqgPcC.js";
import { t as canSkipGatewayConfigLoad } from "./explicit-connection-policy-BAf1LVDv.js";
import { a as isGatewayMethodClassified, t as CLI_DEFAULT_OPERATOR_SCOPES, u as resolveLeastPrivilegeOperatorScopesForMethod } from "./method-scopes-D4RcH8qD.js";
import { randomUUID } from "node:crypto";
//#region src/gateway/call.ts
var GatewayTransportError = class extends Error {
	constructor(params) {
		super(params.message);
		this.name = "GatewayTransportError";
		this.kind = params.kind;
		this.connectionDetails = params.connectionDetails;
		if (params.code !== void 0) this.code = params.code;
		if (params.reason !== void 0) this.reason = params.reason;
		if (params.timeoutMs !== void 0) this.timeoutMs = params.timeoutMs;
	}
};
function firstGatewayErrorLine(message) {
	return message.split("\n", 1)[0]?.trim() || message;
}
function formatGatewayTransportErrorJson(value) {
	if (!isGatewayTransportError(value)) return null;
	return {
		ok: false,
		error: {
			type: "gateway_transport_error",
			kind: value.kind,
			message: firstGatewayErrorLine(value.message),
			...value.code !== void 0 ? { code: value.code } : {},
			...value.reason !== void 0 ? { reason: value.reason } : {},
			...value.timeoutMs !== void 0 ? { timeoutMs: value.timeoutMs } : {}
		},
		gateway: {
			url: redactSensitiveUrlLikeString(value.connectionDetails.url),
			urlSource: value.connectionDetails.urlSource,
			...value.connectionDetails.bindDetail ? { bindDetail: value.connectionDetails.bindDetail } : {},
			...value.connectionDetails.remoteFallbackNote ? { remoteFallbackNote: value.connectionDetails.remoteFallbackNote } : {}
		}
	};
}
function isGatewayTransportError(value) {
	if (value instanceof GatewayTransportError) return true;
	if (!(value instanceof Error) || value.name !== "GatewayTransportError") return false;
	const candidate = value;
	return (candidate.kind === "closed" || candidate.kind === "timeout") && typeof candidate.connectionDetails === "object" && candidate.connectionDetails !== null;
}
const defaultCreateGatewayClient = (opts) => new GatewayClient(opts);
const defaultGatewayCallDeps = {
	createGatewayClient: defaultCreateGatewayClient,
	getRuntimeConfig,
	loadOrCreateDeviceIdentity,
	resolveGatewayPort,
	resolveConfigPath,
	resolveStateDir,
	loadGatewayTlsRuntime
};
const gatewayCallDeps = { ...defaultGatewayCallDeps };
async function stopGatewayClient(client) {
	try {
		await client.stopAndWait({ timeoutMs: 1e3 });
	} catch {
		client.stop();
	}
}
function resolveGatewayClientDisplayName(opts) {
	if (opts.clientDisplayName) return opts.clientDisplayName;
	const clientName = opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI;
	if ((opts.mode ?? GATEWAY_CLIENT_MODES.CLI) !== GATEWAY_CLIENT_MODES.BACKEND && clientName !== GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT) return;
	const method = opts.method.trim();
	return method ? `gateway:${method}` : "gateway:request";
}
function loadGatewayConfig() {
	return (typeof gatewayCallDeps.getRuntimeConfig === "function" ? gatewayCallDeps.getRuntimeConfig : typeof defaultGatewayCallDeps.getRuntimeConfig === "function" ? defaultGatewayCallDeps.getRuntimeConfig : getRuntimeConfig)();
}
function resolveGatewayStateDir(env) {
	return (typeof gatewayCallDeps.resolveStateDir === "function" ? gatewayCallDeps.resolveStateDir : resolveStateDir)(env);
}
function resolveGatewayConfigPath(env) {
	return (typeof gatewayCallDeps.resolveConfigPath === "function" ? gatewayCallDeps.resolveConfigPath : resolveConfigPath)(env, resolveGatewayStateDir(env));
}
function resolveGatewayPortValue(config, env) {
	return (typeof gatewayCallDeps.resolveGatewayPort === "function" ? gatewayCallDeps.resolveGatewayPort : resolveGatewayPort)(config, env);
}
function buildGatewayConnectionDetails(options = {}) {
	return buildGatewayConnectionDetailsWithResolvers(options, {
		getRuntimeConfig: () => loadGatewayConfig(),
		resolveConfigPath: (env) => resolveGatewayConfigPath(env),
		resolveGatewayPort: (config, env) => resolveGatewayPortValue(config, env)
	});
}
const testing = {
	setDepsForTests(deps) {
		gatewayCallDeps.createGatewayClient = deps?.createGatewayClient ?? defaultGatewayCallDeps.createGatewayClient;
		gatewayCallDeps.getRuntimeConfig = deps?.getRuntimeConfig ?? defaultGatewayCallDeps.getRuntimeConfig;
		gatewayCallDeps.loadOrCreateDeviceIdentity = deps?.loadOrCreateDeviceIdentity ?? defaultGatewayCallDeps.loadOrCreateDeviceIdentity;
		gatewayCallDeps.resolveGatewayPort = deps?.resolveGatewayPort ?? defaultGatewayCallDeps.resolveGatewayPort;
		gatewayCallDeps.resolveConfigPath = deps?.resolveConfigPath ?? defaultGatewayCallDeps.resolveConfigPath;
		gatewayCallDeps.resolveStateDir = deps?.resolveStateDir ?? defaultGatewayCallDeps.resolveStateDir;
		gatewayCallDeps.loadGatewayTlsRuntime = deps?.loadGatewayTlsRuntime ?? defaultGatewayCallDeps.loadGatewayTlsRuntime;
	},
	setCreateGatewayClientForTests(createGatewayClient) {
		gatewayCallDeps.createGatewayClient = createGatewayClient ?? defaultGatewayCallDeps.createGatewayClient;
	},
	resetDepsForTests() {
		gatewayCallDeps.createGatewayClient = defaultGatewayCallDeps.createGatewayClient;
		gatewayCallDeps.getRuntimeConfig = defaultGatewayCallDeps.getRuntimeConfig;
		gatewayCallDeps.loadOrCreateDeviceIdentity = defaultGatewayCallDeps.loadOrCreateDeviceIdentity;
		gatewayCallDeps.resolveGatewayPort = defaultGatewayCallDeps.resolveGatewayPort;
		gatewayCallDeps.resolveConfigPath = defaultGatewayCallDeps.resolveConfigPath;
		gatewayCallDeps.resolveStateDir = defaultGatewayCallDeps.resolveStateDir;
		gatewayCallDeps.loadGatewayTlsRuntime = defaultGatewayCallDeps.loadGatewayTlsRuntime;
	}
};
function isLoopbackGatewayUrl(rawUrl) {
	try {
		const hostname = new URL(rawUrl).hostname.toLowerCase();
		const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
		return unbracketed === "localhost" || isLoopbackIpAddress(unbracketed);
	} catch {
		return false;
	}
}
function shouldOmitDeviceIdentityForGatewayCall(params) {
	const mode = params.opts.mode ?? GATEWAY_CLIENT_MODES.CLI;
	const clientName = params.opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI;
	const hasSharedAuth = Boolean(params.token || params.password);
	return mode === GATEWAY_CLIENT_MODES.BACKEND && clientName === GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT && hasSharedAuth && isLoopbackGatewayUrl(params.url);
}
function resolveDeviceIdentityForGatewayCall(params) {
	if (shouldOmitDeviceIdentityForGatewayCall(params)) return null;
	try {
		return gatewayCallDeps.loadOrCreateDeviceIdentity();
	} catch {
		return null;
	}
}
function resolveExplicitGatewayAuth(opts) {
	return {
		token: typeof opts?.token === "string" && opts.token.trim().length > 0 ? opts.token.trim() : void 0,
		password: typeof opts?.password === "string" && opts.password.trim().length > 0 ? opts.password.trim() : void 0
	};
}
function ensureExplicitGatewayAuth(params) {
	if (!params.urlOverride) return;
	const explicitToken = params.explicitAuth?.token;
	const explicitPassword = params.explicitAuth?.password;
	if (params.urlOverrideSource === "cli" && (explicitToken || explicitPassword)) return;
	const hasResolvedAuth = params.resolvedAuth?.token || params.resolvedAuth?.password || explicitToken || explicitPassword;
	if (params.urlOverrideSource === "env" && hasResolvedAuth) return;
	const message = [
		"gateway url override requires explicit credentials",
		params.errorHint,
		params.configPath ? `Config: ${params.configPath}` : void 0
	].filter(Boolean).join("\n");
	throw new Error(message);
}
function resolveGatewayCallTimeout(timeoutValue, configuredHandshakeTimeoutMs) {
	const hasConfiguredHandshakeTimeout = typeof configuredHandshakeTimeoutMs === "number" && Number.isFinite(configuredHandshakeTimeoutMs) && configuredHandshakeTimeoutMs > 0;
	const hasEnvHandshakeTimeout = Boolean(process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS) || Boolean(process.env.VITEST && process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS);
	const resolvedHandshakeTimeoutMs = hasConfiguredHandshakeTimeout || hasEnvHandshakeTimeout ? resolvePreauthHandshakeTimeoutMs({ configuredTimeoutMs: configuredHandshakeTimeoutMs }) : void 0;
	const timeoutMs = typeof timeoutValue === "number" && Number.isFinite(timeoutValue) ? timeoutValue : typeof resolvedHandshakeTimeoutMs === "number" && resolvedHandshakeTimeoutMs > 1e4 ? resolvedHandshakeTimeoutMs : 1e4;
	return {
		timeoutMs,
		safeTimerTimeoutMs: resolveSafeTimeoutDelayMs(timeoutMs)
	};
}
function resolveGatewayCallContext(opts) {
	const cliUrlOverride = trimToUndefined(opts.url);
	const explicitAuth = resolveExplicitGatewayAuth({
		token: opts.token,
		password: opts.password
	});
	const envUrlOverride = cliUrlOverride ? void 0 : trimToUndefined(process.env.OPENCLAW_GATEWAY_URL);
	const urlOverride = cliUrlOverride ?? envUrlOverride;
	const urlOverrideSource = cliUrlOverride ? "cli" : envUrlOverride ? "env" : void 0;
	const canSkipConfigLoad = canSkipGatewayConfigLoad({
		config: opts.config,
		urlOverride,
		explicitAuth
	});
	const config = opts.config ?? (canSkipConfigLoad ? {} : loadGatewayConfig());
	const configPath = opts.configPath ?? resolveGatewayConfigPath(process.env);
	const isRemoteMode = config.gateway?.mode === "remote";
	const remote = isRemoteMode ? config.gateway?.remote : void 0;
	return {
		config,
		configPath,
		isRemoteMode,
		remote,
		urlOverride,
		urlOverrideSource,
		remoteUrl: trimToUndefined(remote?.url),
		explicitAuth
	};
}
function ensureRemoteModeUrlConfigured(context) {
	if (!context.isRemoteMode || context.urlOverride || context.remoteUrl) return;
	throw new Error([
		"gateway remote mode misconfigured: gateway.remote.url missing",
		`Config: ${context.configPath}`,
		"Fix: set gateway.remote.url, or set gateway.mode=local."
	].join("\n"));
}
async function resolveGatewayCredentials(context) {
	return resolveGatewayCredentialsWithEnv(context, process.env);
}
async function resolveGatewayCredentialsWithEnv(context, env) {
	if (context.explicitAuth.token || context.explicitAuth.password) return {
		token: context.explicitAuth.token,
		password: context.explicitAuth.password
	};
	return resolveGatewayCredentialsWithSecretInputs({
		config: context.config,
		explicitAuth: context.explicitAuth,
		urlOverride: context.urlOverride,
		urlOverrideSource: context.urlOverrideSource,
		env,
		modeOverride: context.modeOverride,
		localTokenPrecedence: context.localTokenPrecedence,
		localPasswordPrecedence: context.localPasswordPrecedence,
		remoteTokenPrecedence: context.remoteTokenPrecedence,
		remotePasswordPrecedence: context.remotePasswordPrecedence,
		remoteTokenFallback: context.remoteTokenFallback,
		remotePasswordFallback: context.remotePasswordFallback
	});
}
async function resolveGatewayTlsFingerprint(params) {
	const { opts, context, url } = params;
	const tlsRuntime = context.config.gateway?.tls?.enabled === true && !context.urlOverrideSource && !context.remoteUrl && url.startsWith("wss://") ? await gatewayCallDeps.loadGatewayTlsRuntime(context.config.gateway?.tls) : void 0;
	const overrideTlsFingerprint = trimToUndefined(opts.tlsFingerprint);
	const remoteTlsFingerprint = context.isRemoteMode && context.urlOverrideSource !== "cli" ? trimToUndefined(context.remote?.tlsFingerprint) : void 0;
	return overrideTlsFingerprint || remoteTlsFingerprint || (tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : void 0);
}
function formatGatewayCloseError(code, reason, connectionDetails) {
	const reasonText = normalizeOptionalString(reason) || "no close reason";
	const hint = code === 1006 ? "abnormal closure (no close frame)" : code === 1e3 ? "normal closure" : "";
	let message = `gateway closed (${code}${hint ? ` ${hint}` : ""}): ${reasonText}\n${connectionDetails.message}`;
	if (code === 1006) message += "\n\nPossible causes:\n- Gateway not yet ready to accept connections (retry after a moment)\n- TLS mismatch (connecting with ws:// to a wss:// gateway, or vice versa)\n- Gateway crashed or was terminated unexpectedly\nRun `openclaw doctor` for diagnostics.";
	return message;
}
function formatGatewayTimeoutError(timeoutMs, connectionDetails) {
	return `gateway timeout after ${timeoutMs}ms\n${connectionDetails.message}`;
}
function createGatewayCloseTransportError(params) {
	const reasonText = normalizeOptionalString(params.reason) || "no close reason";
	return new GatewayTransportError({
		kind: "closed",
		code: params.code,
		reason: reasonText,
		connectionDetails: params.connectionDetails,
		message: formatGatewayCloseError(params.code, params.reason, params.connectionDetails)
	});
}
function createGatewayTimeoutTransportError(params) {
	return new GatewayTransportError({
		kind: "timeout",
		timeoutMs: params.timeoutMs,
		connectionDetails: params.connectionDetails,
		message: formatGatewayTimeoutError(params.timeoutMs, params.connectionDetails)
	});
}
function createGatewayRequestAbortError(method) {
	const err = /* @__PURE__ */ new Error(`gateway request aborted for ${method}`);
	err.name = "AbortError";
	return err;
}
function ensureGatewaySupportsRequiredMethods(params) {
	const requiredMethods = Array.isArray(params.requiredMethods) ? params.requiredMethods.map((entry) => entry.trim()).filter((entry) => entry.length > 0) : [];
	if (requiredMethods.length === 0) return;
	const supportedMethods = new Set((Array.isArray(params.methods) ? params.methods : []).map((entry) => entry.trim()).filter((entry) => entry.length > 0));
	for (const method of requiredMethods) {
		if (supportedMethods.has(method)) continue;
		throw new Error([`active gateway does not support required method "${method}" for "${params.attemptedMethod}".`, "Update the gateway or run without SecretRefs."].join(" "));
	}
}
async function executeGatewayRequestWithScopes(params) {
	const { opts, scopes, url, token, password, tlsFingerprint, preauthHandshakeTimeoutMs, timeoutMs, safeTimerTimeoutMs } = params;
	return await new Promise((resolve, reject) => {
		if (opts.signal?.aborted) {
			reject(createGatewayRequestAbortError(opts.method));
			return;
		}
		let settled = false;
		let ignoreClose = false;
		const startAbort = new AbortController();
		let abortHandler;
		let client;
		let timer;
		let primaryRequestStarted = false;
		const cleanup = () => {
			startAbort.abort();
			if (abortHandler) opts.signal?.removeEventListener("abort", abortHandler);
			if (timer) clearTimeout(timer);
		};
		const stopClientThenSettle = (activeClient, err, value) => {
			const complete = () => {
				if (err) reject(err);
				else resolve(value);
			};
			if (!activeClient) {
				complete();
				return;
			}
			stopGatewayClient(activeClient).finally(complete);
		};
		const stop = (err, value) => {
			if (settled) return;
			settled = true;
			cleanup();
			stopClientThenSettle(client, err, value);
		};
		abortHandler = () => {
			if (settled) return;
			ignoreClose = true;
			settled = true;
			cleanup();
			const err = createGatewayRequestAbortError(opts.method);
			const activeClient = client;
			const stopAfterAbortHook = () => stopClientThenSettle(activeClient, err);
			if (!activeClient || !opts.onSignalAbort || !primaryRequestStarted) {
				stopAfterAbortHook();
				return;
			}
			const request = activeClient.request.bind(activeClient);
			Promise.resolve().then(() => opts.onSignalAbort?.(request)).catch(() => {}).finally(stopAfterAbortHook);
		};
		opts.signal?.addEventListener("abort", abortHandler, { once: true });
		client = gatewayCallDeps.createGatewayClient({
			url,
			token,
			password,
			tlsFingerprint,
			preauthHandshakeTimeoutMs,
			instanceId: opts.instanceId ?? randomUUID(),
			clientName: opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
			clientDisplayName: resolveGatewayClientDisplayName(opts),
			clientVersion: opts.clientVersion ?? VERSION,
			platform: opts.platform,
			mode: opts.mode ?? GATEWAY_CLIENT_MODES.CLI,
			...opts.approvalRuntimeToken ? { approvalRuntimeToken: opts.approvalRuntimeToken } : {},
			role: "operator",
			scopes,
			deviceIdentity: opts.deviceIdentity === void 0 ? resolveDeviceIdentityForGatewayCall({
				opts,
				url,
				token,
				password
			}) : opts.deviceIdentity,
			minProtocol: opts.minProtocol ?? 4,
			maxProtocol: opts.maxProtocol ?? 4,
			onHelloOk: async (hello) => {
				try {
					ensureGatewaySupportsRequiredMethods({
						requiredMethods: opts.requiredMethods,
						methods: hello.features?.methods,
						attemptedMethod: opts.method
					});
					const activeClient = client;
					if (!activeClient) throw new Error("gateway client not initialized");
					primaryRequestStarted = true;
					const result = await activeClient.request(opts.method, opts.params, {
						expectFinal: opts.expectFinal,
						timeoutMs: opts.timeoutMs,
						signal: opts.signal,
						onAccepted: opts.onAccepted
					});
					ignoreClose = true;
					stop(void 0, result);
				} catch (err) {
					ignoreClose = true;
					stop(err);
				}
			},
			onClose: (code, reason) => {
				if (settled || ignoreClose) return;
				ignoreClose = true;
				stop(createGatewayCloseTransportError({
					code,
					reason,
					connectionDetails: params.connectionDetails
				}));
			},
			onConnectError: (err) => {
				if (settled || !isGatewayConnectAssemblyError(err)) return;
				ignoreClose = true;
				stop(err);
			}
		});
		timer = setTimeout(() => {
			ignoreClose = true;
			stop(createGatewayTimeoutTransportError({
				timeoutMs,
				connectionDetails: params.connectionDetails
			}));
		}, safeTimerTimeoutMs);
		startGatewayClientWhenEventLoopReady(client, {
			timeoutMs: safeTimerTimeoutMs,
			signal: startAbort.signal
		}).then((readiness) => {
			if (settled || readiness.ready || readiness.aborted) return;
			ignoreClose = true;
			stop(createGatewayTimeoutTransportError({
				timeoutMs,
				connectionDetails: params.connectionDetails
			}));
		}).catch((err) => {
			if (settled) return;
			ignoreClose = true;
			stop(err instanceof Error ? err : new Error(String(err)));
		});
	});
}
async function callGatewayWithScopes(opts, scopes) {
	const context = resolveGatewayCallContext(opts);
	const { timeoutMs, safeTimerTimeoutMs } = resolveGatewayCallTimeout(opts.timeoutMs, context.config.gateway?.handshakeTimeoutMs);
	const resolvedCredentials = await resolveGatewayCredentials(context);
	ensureExplicitGatewayAuth({
		urlOverride: context.urlOverride,
		urlOverrideSource: context.urlOverrideSource,
		explicitAuth: context.explicitAuth,
		resolvedAuth: resolvedCredentials,
		errorHint: "Fix: pass --token or --password (or gatewayToken in tools).",
		configPath: context.configPath
	});
	ensureRemoteModeUrlConfigured(context);
	const connectionDetails = buildGatewayConnectionDetails({
		config: context.config,
		url: context.urlOverride,
		urlSource: context.urlOverrideSource,
		...opts.configPath ? { configPath: opts.configPath } : {}
	});
	const url = connectionDetails.url;
	const tlsFingerprint = await resolveGatewayTlsFingerprint({
		opts,
		context,
		url
	});
	const { token, password } = resolvedCredentials;
	return await executeGatewayRequestWithScopes({
		opts,
		scopes,
		url,
		token,
		password,
		tlsFingerprint,
		preauthHandshakeTimeoutMs: context.config.gateway?.handshakeTimeoutMs,
		timeoutMs,
		safeTimerTimeoutMs,
		connectionDetails
	});
}
async function callGatewayScoped(opts) {
	return await callGatewayWithScopes(opts, opts.scopes);
}
async function callGatewayCli(opts) {
	return await callGatewayWithScopes(opts, Array.isArray(opts.scopes) ? opts.scopes : isGatewayMethodClassified(opts.method) ? resolveLeastPrivilegeOperatorScopesForMethod(opts.method, opts.params) : CLI_DEFAULT_OPERATOR_SCOPES);
}
async function callGatewayLeastPrivilege(opts) {
	return await callGatewayWithScopes(opts, resolveLeastPrivilegeOperatorScopesForMethod(opts.method, opts.params));
}
async function callGateway(opts) {
	const callerMode = opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND;
	const callerName = opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT;
	if (callerMode === GATEWAY_CLIENT_MODES.CLI || callerName === GATEWAY_CLIENT_NAMES.CLI) return await callGatewayCli(opts);
	if (Array.isArray(opts.scopes)) return await callGatewayWithScopes({
		...opts,
		mode: callerMode,
		clientName: callerName
	}, opts.scopes);
	return await callGatewayLeastPrivilege({
		...opts,
		mode: callerMode,
		clientName: callerName
	});
}
function randomIdempotencyKey() {
	return randomUUID();
}
//#endregion
export { callGatewayLeastPrivilege as a, formatGatewayTransportErrorJson as c, resolveExplicitGatewayAuth as d, testing as f, callGatewayCli as i, isGatewayTransportError as l, buildGatewayConnectionDetails as n, callGatewayScoped as o, callGateway as r, ensureExplicitGatewayAuth as s, GatewayTransportError as t, randomIdempotencyKey as u };
