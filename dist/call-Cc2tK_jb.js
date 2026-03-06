import { g as resolveStateDir, o as resolveConfigPath, u as resolveGatewayPort } from "./paths-BBP4yd-2.js";
import { c as ensureDir, t as CONFIG_DIR, x as shortenHomeInString, y as resolveUserPath } from "./utils-BgHhhQlR.js";
import { $t as loadConfig, Cn as secretRefKey, Ft as resolveSecretRefValues, Qr as VERSION } from "./model-selection-Dmiyt9yA.js";
import { L as resolveSecretInputRef, j as hasConfiguredSecretInput } from "./registry-DBb6KIXY.js";
import { h as GATEWAY_CLIENT_NAMES, m as GATEWAY_CLIENT_MODES } from "./message-channel-BTTrmWeS.js";
import { a as isSecureWebSocketUrl } from "./ws-OMv8Zfui.js";
import { n as resolveGatewayCredentialsFromConfig } from "./credentials-1kyjqvJ5.js";
import { Mt as PROTOCOL_VERSION, en as normalizeFingerprint, nn as loadOrCreateDeviceIdentity, t as GatewayClient } from "./client-0WVSaq6Z.js";
import path from "node:path";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { X509Certificate, randomUUID } from "node:crypto";

//#region src/infra/tls/gateway.ts
const execFileAsync = promisify(execFile);
async function fileExists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
async function generateSelfSignedCert(params) {
	const certDir = path.dirname(params.certPath);
	const keyDir = path.dirname(params.keyPath);
	await ensureDir(certDir);
	if (keyDir !== certDir) await ensureDir(keyDir);
	await execFileAsync("openssl", [
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-sha256",
		"-days",
		"3650",
		"-nodes",
		"-keyout",
		params.keyPath,
		"-out",
		params.certPath,
		"-subj",
		"/CN=openclaw-gateway"
	]);
	await fs.chmod(params.keyPath, 384).catch(() => {});
	await fs.chmod(params.certPath, 384).catch(() => {});
	params.log?.info?.(`gateway tls: generated self-signed cert at ${shortenHomeInString(params.certPath)}`);
}
async function loadGatewayTlsRuntime(cfg, log) {
	if (!cfg || cfg.enabled !== true) return {
		enabled: false,
		required: false
	};
	const autoGenerate = cfg.autoGenerate !== false;
	const baseDir = path.join(CONFIG_DIR, "gateway", "tls");
	const certPath = resolveUserPath(cfg.certPath ?? path.join(baseDir, "gateway-cert.pem"));
	const keyPath = resolveUserPath(cfg.keyPath ?? path.join(baseDir, "gateway-key.pem"));
	const caPath = cfg.caPath ? resolveUserPath(cfg.caPath) : void 0;
	const hasCert = await fileExists(certPath);
	const hasKey = await fileExists(keyPath);
	if (!hasCert && !hasKey && autoGenerate) try {
		await generateSelfSignedCert({
			certPath,
			keyPath,
			log
		});
	} catch (err) {
		return {
			enabled: false,
			required: true,
			certPath,
			keyPath,
			error: `gateway tls: failed to generate cert (${String(err)})`
		};
	}
	if (!await fileExists(certPath) || !await fileExists(keyPath)) return {
		enabled: false,
		required: true,
		certPath,
		keyPath,
		error: "gateway tls: cert/key missing"
	};
	try {
		const cert = await fs.readFile(certPath, "utf8");
		const key = await fs.readFile(keyPath, "utf8");
		const ca = caPath ? await fs.readFile(caPath, "utf8") : void 0;
		const fingerprintSha256 = normalizeFingerprint(new X509Certificate(cert).fingerprint256 ?? "");
		if (!fingerprintSha256) return {
			enabled: false,
			required: true,
			certPath,
			keyPath,
			caPath,
			error: "gateway tls: unable to compute certificate fingerprint"
		};
		return {
			enabled: true,
			required: true,
			certPath,
			keyPath,
			caPath,
			fingerprintSha256,
			tlsOptions: {
				cert,
				key,
				ca,
				minVersion: "TLSv1.3"
			}
		};
	} catch (err) {
		return {
			enabled: false,
			required: true,
			certPath,
			keyPath,
			caPath,
			error: `gateway tls: failed to load cert (${String(err)})`
		};
	}
}

//#endregion
//#region src/gateway/method-scopes.ts
const ADMIN_SCOPE = "operator.admin";
const READ_SCOPE = "operator.read";
const WRITE_SCOPE = "operator.write";
const APPROVALS_SCOPE = "operator.approvals";
const PAIRING_SCOPE = "operator.pairing";
const CLI_DEFAULT_OPERATOR_SCOPES = [
	ADMIN_SCOPE,
	READ_SCOPE,
	WRITE_SCOPE,
	APPROVALS_SCOPE,
	PAIRING_SCOPE
];
const NODE_ROLE_METHODS = new Set([
	"node.invoke.result",
	"node.event",
	"node.canvas.capability.refresh",
	"skills.bins"
]);
const METHOD_SCOPE_GROUPS = {
	[APPROVALS_SCOPE]: [
		"exec.approval.request",
		"exec.approval.waitDecision",
		"exec.approval.resolve"
	],
	[PAIRING_SCOPE]: [
		"node.pair.request",
		"node.pair.list",
		"node.pair.approve",
		"node.pair.reject",
		"node.pair.verify",
		"device.pair.list",
		"device.pair.approve",
		"device.pair.reject",
		"device.pair.remove",
		"device.token.rotate",
		"device.token.revoke",
		"node.rename"
	],
	[READ_SCOPE]: [
		"health",
		"doctor.memory.status",
		"logs.tail",
		"channels.status",
		"status",
		"usage.status",
		"usage.cost",
		"tts.status",
		"tts.providers",
		"models.list",
		"tools.catalog",
		"agents.list",
		"agent.identity.get",
		"skills.status",
		"voicewake.get",
		"sessions.list",
		"sessions.preview",
		"sessions.resolve",
		"sessions.usage",
		"sessions.usage.timeseries",
		"sessions.usage.logs",
		"cron.list",
		"cron.status",
		"cron.runs",
		"system-presence",
		"last-heartbeat",
		"node.list",
		"node.describe",
		"chat.history",
		"config.get",
		"talk.config",
		"agents.files.list",
		"agents.files.get"
	],
	[WRITE_SCOPE]: [
		"send",
		"poll",
		"agent",
		"agent.wait",
		"wake",
		"talk.mode",
		"tts.enable",
		"tts.disable",
		"tts.convert",
		"tts.setProvider",
		"voicewake.set",
		"node.invoke",
		"chat.send",
		"chat.abort",
		"browser.request",
		"push.test"
	],
	[ADMIN_SCOPE]: [
		"channels.logout",
		"agents.create",
		"agents.update",
		"agents.delete",
		"skills.install",
		"skills.update",
		"secrets.reload",
		"secrets.resolve",
		"cron.add",
		"cron.update",
		"cron.remove",
		"cron.run",
		"sessions.patch",
		"sessions.reset",
		"sessions.delete",
		"sessions.compact",
		"connect",
		"chat.inject",
		"web.login.start",
		"web.login.wait",
		"set-heartbeats",
		"system-event",
		"agents.files.set"
	]
};
const ADMIN_METHOD_PREFIXES = [
	"exec.approvals.",
	"config.",
	"wizard.",
	"update."
];
const METHOD_SCOPE_BY_NAME = new Map(Object.entries(METHOD_SCOPE_GROUPS).flatMap(([scope, methods]) => methods.map((method) => [method, scope])));
function resolveScopedMethod(method) {
	const explicitScope = METHOD_SCOPE_BY_NAME.get(method);
	if (explicitScope) return explicitScope;
	if (ADMIN_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))) return ADMIN_SCOPE;
}
function isNodeRoleMethod(method) {
	return NODE_ROLE_METHODS.has(method);
}
function resolveRequiredOperatorScopeForMethod(method) {
	return resolveScopedMethod(method);
}
function resolveLeastPrivilegeOperatorScopesForMethod(method) {
	const requiredScope = resolveRequiredOperatorScopeForMethod(method);
	if (requiredScope) return [requiredScope];
	return [];
}
function authorizeOperatorScopesForMethod(method, scopes) {
	if (scopes.includes(ADMIN_SCOPE)) return { allowed: true };
	const requiredScope = resolveRequiredOperatorScopeForMethod(method) ?? ADMIN_SCOPE;
	if (requiredScope === READ_SCOPE) {
		if (scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE)) return { allowed: true };
		return {
			allowed: false,
			missingScope: READ_SCOPE
		};
	}
	if (scopes.includes(requiredScope)) return { allowed: true };
	return {
		allowed: false,
		missingScope: requiredScope
	};
}

//#endregion
//#region src/gateway/call.ts
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
function buildGatewayConnectionDetails(options = {}) {
	const config = options.config ?? loadConfig();
	const configPath = options.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env));
	const isRemoteMode = config.gateway?.mode === "remote";
	const remote = isRemoteMode ? config.gateway?.remote : void 0;
	const tlsEnabled = config.gateway?.tls?.enabled === true;
	const localPort = resolveGatewayPort(config);
	const bindMode = config.gateway?.bind ?? "loopback";
	const localUrl = `${tlsEnabled ? "wss" : "ws"}://127.0.0.1:${localPort}`;
	const cliUrlOverride = typeof options.url === "string" && options.url.trim().length > 0 ? options.url.trim() : void 0;
	const envUrlOverride = cliUrlOverride ? void 0 : trimToUndefined(process.env.OPENCLAW_GATEWAY_URL) ?? trimToUndefined(process.env.CLAWDBOT_GATEWAY_URL);
	const urlOverride = cliUrlOverride ?? envUrlOverride;
	const remoteUrl = typeof remote?.url === "string" && remote.url.trim().length > 0 ? remote.url.trim() : void 0;
	const remoteMisconfigured = isRemoteMode && !urlOverride && !remoteUrl;
	const urlSourceHint = options.urlSource ?? (cliUrlOverride ? "cli" : envUrlOverride ? "env" : void 0);
	const url = urlOverride || remoteUrl || localUrl;
	const urlSource = urlOverride ? urlSourceHint === "env" ? "env OPENCLAW_GATEWAY_URL" : "cli --url" : remoteUrl ? "config gateway.remote.url" : remoteMisconfigured ? "missing gateway.remote.url (fallback local)" : "local loopback";
	const bindDetail = !urlOverride && !remoteUrl ? `Bind: ${bindMode}` : void 0;
	const remoteFallbackNote = remoteMisconfigured ? "Warn: gateway.mode=remote but gateway.remote.url is missing; set gateway.remote.url or switch gateway.mode=local." : void 0;
	const allowPrivateWs = process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1";
	if (!isSecureWebSocketUrl(url, { allowPrivateWs })) throw new Error([
		`SECURITY ERROR: Gateway URL "${url}" uses plaintext ws:// to a non-loopback address.`,
		"Both credentials and chat data would be exposed to network interception.",
		`Source: ${urlSource}`,
		`Config: ${configPath}`,
		"Fix: Use wss:// for remote gateway URLs.",
		"Safe remote access defaults:",
		"- keep gateway.bind=loopback and use an SSH tunnel (ssh -N -L 18789:127.0.0.1:18789 user@gateway-host)",
		"- or use Tailscale Serve/Funnel for HTTPS remote access",
		allowPrivateWs ? void 0 : "Break-glass (trusted private networks only): set OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1",
		"Doctor: openclaw doctor --fix",
		"Docs: https://docs.openclaw.ai/gateway/remote"
	].join("\n"));
	return {
		url,
		urlSource,
		bindDetail,
		remoteFallbackNote,
		message: [
			`Gateway target: ${url}`,
			`Source: ${urlSource}`,
			`Config: ${configPath}`,
			bindDetail,
			remoteFallbackNote
		].filter(Boolean).join("\n")
	};
}
function trimToUndefined(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function readGatewayTokenEnv(env) {
	return trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN) ?? trimToUndefined(env.CLAWDBOT_GATEWAY_TOKEN);
}
function readGatewayPasswordEnv(env) {
	return trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD) ?? trimToUndefined(env.CLAWDBOT_GATEWAY_PASSWORD);
}
function resolveGatewayCallTimeout(timeoutValue) {
	const timeoutMs = typeof timeoutValue === "number" && Number.isFinite(timeoutValue) ? timeoutValue : 1e4;
	return {
		timeoutMs,
		safeTimerTimeoutMs: Math.max(1, Math.min(Math.floor(timeoutMs), 2147483647))
	};
}
function resolveGatewayCallContext(opts) {
	const config = opts.config ?? loadConfig();
	const configPath = opts.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env));
	const isRemoteMode = config.gateway?.mode === "remote";
	const remote = isRemoteMode ? config.gateway?.remote : void 0;
	const cliUrlOverride = trimToUndefined(opts.url);
	const envUrlOverride = cliUrlOverride ? void 0 : trimToUndefined(process.env.OPENCLAW_GATEWAY_URL) ?? trimToUndefined(process.env.CLAWDBOT_GATEWAY_URL);
	return {
		config,
		configPath,
		isRemoteMode,
		remote,
		urlOverride: cliUrlOverride ?? envUrlOverride,
		urlOverrideSource: cliUrlOverride ? "cli" : envUrlOverride ? "env" : void 0,
		remoteUrl: trimToUndefined(remote?.url),
		explicitAuth: resolveExplicitGatewayAuth({
			token: opts.token,
			password: opts.password
		})
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
async function resolveGatewaySecretInputString(params) {
	const defaults = params.config.secrets?.defaults;
	const { ref } = resolveSecretInputRef({
		value: params.value,
		defaults
	});
	if (!ref) return trimToUndefined(params.value);
	const resolvedValue = trimToUndefined((await resolveSecretRefValues([ref], {
		config: params.config,
		env: params.env
	})).get(secretRefKey(ref)));
	if (!resolvedValue) throw new Error(`${params.path} resolved to an empty or non-string value.`);
	return resolvedValue;
}
async function resolveGatewayCredentials(context) {
	return resolveGatewayCredentialsWithEnv(context, process.env);
}
async function resolveGatewayCredentialsWithEnv(context, env) {
	if (context.explicitAuth.token || context.explicitAuth.password) return {
		token: context.explicitAuth.token,
		password: context.explicitAuth.password
	};
	if (context.urlOverride) return resolveGatewayCredentialsFromConfig({
		cfg: context.config,
		env,
		explicitAuth: context.explicitAuth,
		urlOverride: context.urlOverride,
		urlOverrideSource: context.urlOverrideSource,
		remotePasswordPrecedence: "env-first"
	});
	let resolvedConfig = context.config;
	const envToken = readGatewayTokenEnv(env);
	const envPassword = readGatewayPasswordEnv(env);
	const defaults = context.config.secrets?.defaults;
	const auth = context.config.gateway?.auth;
	const remoteConfig = context.config.gateway?.remote;
	const authMode = auth?.mode;
	const localToken = trimToUndefined(auth?.token);
	const remoteToken = trimToUndefined(remoteConfig?.token);
	const remoteTokenConfigured = hasConfiguredSecretInput(remoteConfig?.token, defaults);
	const tokenCanWin = Boolean(envToken || localToken || remoteToken || remoteTokenConfigured);
	const remotePasswordConfigured = context.isRemoteMode && hasConfiguredSecretInput(remoteConfig?.password, defaults);
	const localPasswordRef = resolveSecretInputRef({
		value: auth?.password,
		defaults
	}).ref;
	const localPasswordCanWinInLocalMode = authMode === "password" || authMode !== "token" && authMode !== "none" && authMode !== "trusted-proxy" && !tokenCanWin;
	const localTokenCanWinInLocalMode = authMode !== "password" && authMode !== "none" && authMode !== "trusted-proxy";
	const localPasswordCanWinInRemoteMode = !remotePasswordConfigured && !tokenCanWin;
	if (Boolean(auth) && !envPassword && Boolean(localPasswordRef) && (context.isRemoteMode ? localPasswordCanWinInRemoteMode : localPasswordCanWinInLocalMode)) {
		resolvedConfig = structuredClone(context.config);
		const resolvedPassword = await resolveGatewaySecretInputString({
			config: resolvedConfig,
			value: resolvedConfig.gateway?.auth?.password,
			path: "gateway.auth.password",
			env
		});
		if (resolvedConfig.gateway?.auth) resolvedConfig.gateway.auth.password = resolvedPassword;
	}
	const remote = context.isRemoteMode ? resolvedConfig.gateway?.remote : void 0;
	const resolvedDefaults = resolvedConfig.secrets?.defaults;
	if (remote) {
		const localToken = trimToUndefined(resolvedConfig.gateway?.auth?.token);
		const localPassword = trimToUndefined(resolvedConfig.gateway?.auth?.password);
		const passwordCanWinBeforeRemoteTokenResolution = Boolean(envPassword || localPassword || trimToUndefined(remote.password));
		const remoteTokenRef = resolveSecretInputRef({
			value: remote.token,
			defaults: resolvedDefaults
		}).ref;
		if (!passwordCanWinBeforeRemoteTokenResolution && !envToken && !localToken && remoteTokenRef) remote.token = await resolveGatewaySecretInputString({
			config: resolvedConfig,
			value: remote.token,
			path: "gateway.remote.token",
			env
		});
		const tokenCanWin = Boolean(envToken || localToken || trimToUndefined(remote.token));
		const remotePasswordRef = resolveSecretInputRef({
			value: remote.password,
			defaults: resolvedDefaults
		}).ref;
		if (!tokenCanWin && !envPassword && !localPassword && remotePasswordRef) remote.password = await resolveGatewaySecretInputString({
			config: resolvedConfig,
			value: remote.password,
			path: "gateway.remote.password",
			env
		});
	}
	const localModeRemote = !context.isRemoteMode ? resolvedConfig.gateway?.remote : void 0;
	if (localModeRemote) {
		const localToken = trimToUndefined(resolvedConfig.gateway?.auth?.token);
		const localPassword = trimToUndefined(resolvedConfig.gateway?.auth?.password);
		const localModePasswordSourceConfigured = Boolean(envPassword || localPassword || trimToUndefined(localModeRemote.password));
		const passwordCanWinBeforeRemoteTokenResolution = localPasswordCanWinInLocalMode && localModePasswordSourceConfigured;
		const remoteTokenRef = resolveSecretInputRef({
			value: localModeRemote.token,
			defaults: resolvedDefaults
		}).ref;
		if (localTokenCanWinInLocalMode && !passwordCanWinBeforeRemoteTokenResolution && !envToken && !localToken && remoteTokenRef) localModeRemote.token = await resolveGatewaySecretInputString({
			config: resolvedConfig,
			value: localModeRemote.token,
			path: "gateway.remote.token",
			env
		});
		const tokenCanWin = Boolean(envToken || localToken || trimToUndefined(localModeRemote.token));
		const remotePasswordRef = resolveSecretInputRef({
			value: localModeRemote.password,
			defaults: resolvedDefaults
		}).ref;
		if (!tokenCanWin && !envPassword && !localPassword && remotePasswordRef && localPasswordCanWinInLocalMode) localModeRemote.password = await resolveGatewaySecretInputString({
			config: resolvedConfig,
			value: localModeRemote.password,
			path: "gateway.remote.password",
			env
		});
	}
	return resolveGatewayCredentialsFromConfig({
		cfg: resolvedConfig,
		env,
		explicitAuth: context.explicitAuth,
		urlOverride: context.urlOverride,
		urlOverrideSource: context.urlOverrideSource,
		remotePasswordPrecedence: "env-first"
	});
}
async function resolveGatewayCredentialsWithSecretInputs(params) {
	return resolveGatewayCredentialsWithEnv({
		config: params.config,
		configPath: resolveConfigPath(process.env, resolveStateDir(process.env)),
		isRemoteMode: params.config.gateway?.mode === "remote",
		remote: params.config.gateway?.mode === "remote" ? params.config.gateway?.remote : void 0,
		urlOverride: trimToUndefined(params.urlOverride),
		remoteUrl: params.config.gateway?.mode === "remote" ? trimToUndefined((params.config.gateway?.remote)?.url) : void 0,
		explicitAuth: resolveExplicitGatewayAuth(params.explicitAuth)
	}, params.env ?? process.env);
}
async function resolveGatewayTlsFingerprint(params) {
	const { opts, context, url } = params;
	const tlsRuntime = context.config.gateway?.tls?.enabled === true && !context.urlOverrideSource && !context.remoteUrl && url.startsWith("wss://") ? await loadGatewayTlsRuntime(context.config.gateway?.tls) : void 0;
	const overrideTlsFingerprint = trimToUndefined(opts.tlsFingerprint);
	const remoteTlsFingerprint = context.isRemoteMode && context.urlOverrideSource !== "cli" ? trimToUndefined(context.remote?.tlsFingerprint) : void 0;
	return overrideTlsFingerprint || remoteTlsFingerprint || (tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : void 0);
}
function formatGatewayCloseError(code, reason, connectionDetails) {
	const reasonText = reason?.trim() || "no close reason";
	const hint = code === 1006 ? "abnormal closure (no close frame)" : code === 1e3 ? "normal closure" : "";
	return `gateway closed (${code}${hint ? ` ${hint}` : ""}): ${reasonText}\n${connectionDetails.message}`;
}
function formatGatewayTimeoutError(timeoutMs, connectionDetails) {
	return `gateway timeout after ${timeoutMs}ms\n${connectionDetails.message}`;
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
	const { opts, scopes, url, token, password, tlsFingerprint, timeoutMs, safeTimerTimeoutMs } = params;
	return await new Promise((resolve, reject) => {
		let settled = false;
		let ignoreClose = false;
		const stop = (err, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (err) reject(err);
			else resolve(value);
		};
		const client = new GatewayClient({
			url,
			token,
			password,
			tlsFingerprint,
			instanceId: opts.instanceId ?? randomUUID(),
			clientName: opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
			clientDisplayName: opts.clientDisplayName,
			clientVersion: opts.clientVersion ?? VERSION,
			platform: opts.platform,
			mode: opts.mode ?? GATEWAY_CLIENT_MODES.CLI,
			role: "operator",
			scopes,
			deviceIdentity: loadOrCreateDeviceIdentity(),
			minProtocol: opts.minProtocol ?? PROTOCOL_VERSION,
			maxProtocol: opts.maxProtocol ?? PROTOCOL_VERSION,
			onHelloOk: async (hello) => {
				try {
					ensureGatewaySupportsRequiredMethods({
						requiredMethods: opts.requiredMethods,
						methods: hello.features?.methods,
						attemptedMethod: opts.method
					});
					const result = await client.request(opts.method, opts.params, { expectFinal: opts.expectFinal });
					ignoreClose = true;
					stop(void 0, result);
					client.stop();
				} catch (err) {
					ignoreClose = true;
					client.stop();
					stop(err);
				}
			},
			onClose: (code, reason) => {
				if (settled || ignoreClose) return;
				ignoreClose = true;
				client.stop();
				stop(new Error(formatGatewayCloseError(code, reason, params.connectionDetails)));
			}
		});
		const timer = setTimeout(() => {
			ignoreClose = true;
			client.stop();
			stop(new Error(formatGatewayTimeoutError(timeoutMs, params.connectionDetails)));
		}, safeTimerTimeoutMs);
		client.start();
	});
}
async function callGatewayWithScopes(opts, scopes) {
	const { timeoutMs, safeTimerTimeoutMs } = resolveGatewayCallTimeout(opts.timeoutMs);
	const context = resolveGatewayCallContext(opts);
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
		timeoutMs,
		safeTimerTimeoutMs,
		connectionDetails
	});
}
async function callGatewayCli(opts) {
	return await callGatewayWithScopes(opts, Array.isArray(opts.scopes) ? opts.scopes : CLI_DEFAULT_OPERATOR_SCOPES);
}
async function callGatewayLeastPrivilege(opts) {
	return await callGatewayWithScopes(opts, resolveLeastPrivilegeOperatorScopesForMethod(opts.method));
}
async function callGateway(opts) {
	if (Array.isArray(opts.scopes)) return await callGatewayWithScopes(opts, opts.scopes);
	const callerMode = opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND;
	const callerName = opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT;
	if (callerMode === GATEWAY_CLIENT_MODES.CLI || callerName === GATEWAY_CLIENT_NAMES.CLI) return await callGatewayCli(opts);
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
export { randomIdempotencyKey as a, ADMIN_SCOPE as c, isNodeRoleMethod as d, resolveLeastPrivilegeOperatorScopesForMethod as f, ensureExplicitGatewayAuth as i, READ_SCOPE as l, callGateway as n, resolveExplicitGatewayAuth as o, loadGatewayTlsRuntime as p, callGatewayLeastPrivilege as r, resolveGatewayCredentialsWithSecretInputs as s, buildGatewayConnectionDetails as t, authorizeOperatorScopesForMethod as u };