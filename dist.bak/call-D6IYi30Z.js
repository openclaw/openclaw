import { $t as resolveStateDir, Ut as resolveConfigPath, W as CONFIG_DIR, X as ensureDir, lt as shortenHomeInString, qt as resolveGatewayPort, st as resolveUserPath } from "./entry.js";
import { j as loadConfig } from "./auth-profiles-D6H-HVV8.js";
import { h as GATEWAY_CLIENT_NAMES, m as GATEWAY_CLIENT_MODES } from "./message-channel-CJUwnCYd.js";
import { $t as loadOrCreateDeviceIdentity, At as PROTOCOL_VERSION, Zt as normalizeFingerprint, t as GatewayClient } from "./client-C2kv9X_7.js";
import { i as isSecureWebSocketUrl } from "./net-DBrsyv8q.js";
import { t as resolveGatewayCredentialsFromConfig } from "./credentials-DQGpxZLN.js";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import fs from "node:fs/promises";
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
	if (params.auth.token || params.auth.password) return;
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
	const urlOverride = typeof options.url === "string" && options.url.trim().length > 0 ? options.url.trim() : void 0;
	const remoteUrl = typeof remote?.url === "string" && remote.url.trim().length > 0 ? remote.url.trim() : void 0;
	const remoteMisconfigured = isRemoteMode && !urlOverride && !remoteUrl;
	const url = urlOverride || remoteUrl || localUrl;
	const urlSource = urlOverride ? "cli --url" : remoteUrl ? "config gateway.remote.url" : remoteMisconfigured ? "missing gateway.remote.url (fallback local)" : "local loopback";
	const remoteFallbackNote = remoteMisconfigured ? "Warn: gateway.mode=remote but gateway.remote.url is missing; set gateway.remote.url or switch gateway.mode=local." : void 0;
	const bindDetail = !urlOverride && !remoteUrl ? `Bind: ${bindMode}` : void 0;
	if (!isSecureWebSocketUrl(url)) throw new Error([
		`SECURITY ERROR: Gateway URL "${url}" uses plaintext ws:// to a non-loopback address.`,
		"Both credentials and chat data would be exposed to network interception.",
		`Source: ${urlSource}`,
		`Config: ${configPath}`,
		"Fix: Use wss:// for remote gateway URLs.",
		"Safe remote access defaults:",
		"- keep gateway.bind=loopback and use an SSH tunnel (ssh -N -L 18789:127.0.0.1:18789 user@gateway-host)",
		"- or use Tailscale Serve/Funnel for HTTPS remote access",
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
	return {
		config,
		configPath,
		isRemoteMode,
		remote,
		urlOverride: trimToUndefined(opts.url),
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
function resolveGatewayCredentials(context) {
	return resolveGatewayCredentialsFromConfig({
		cfg: context.config,
		env: process.env,
		explicitAuth: context.explicitAuth,
		urlOverride: context.urlOverride,
		remotePasswordPrecedence: "env-first"
	});
}
async function resolveGatewayTlsFingerprint(params) {
	const { opts, context, url } = params;
	const tlsRuntime = context.config.gateway?.tls?.enabled === true && !context.urlOverride && !context.remoteUrl && url.startsWith("wss://") ? await loadGatewayTlsRuntime(context.config.gateway?.tls) : void 0;
	const overrideTlsFingerprint = trimToUndefined(opts.tlsFingerprint);
	const remoteTlsFingerprint = context.isRemoteMode && !context.urlOverride && context.remoteUrl ? trimToUndefined(context.remote?.tlsFingerprint) : void 0;
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
			clientVersion: opts.clientVersion ?? "dev",
			platform: opts.platform,
			mode: opts.mode ?? GATEWAY_CLIENT_MODES.CLI,
			role: "operator",
			scopes,
			deviceIdentity: loadOrCreateDeviceIdentity(),
			minProtocol: opts.minProtocol ?? PROTOCOL_VERSION,
			maxProtocol: opts.maxProtocol ?? PROTOCOL_VERSION,
			onHelloOk: async () => {
				try {
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
	ensureExplicitGatewayAuth({
		urlOverride: context.urlOverride,
		auth: context.explicitAuth,
		errorHint: "Fix: pass --token or --password (or gatewayToken in tools).",
		configPath: context.configPath
	});
	ensureRemoteModeUrlConfigured(context);
	const connectionDetails = buildGatewayConnectionDetails({
		config: context.config,
		url: context.urlOverride,
		...opts.configPath ? { configPath: opts.configPath } : {}
	});
	const url = connectionDetails.url;
	const tlsFingerprint = await resolveGatewayTlsFingerprint({
		opts,
		context,
		url
	});
	const { token, password } = resolveGatewayCredentials(context);
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
export { randomIdempotencyKey as a, READ_SCOPE as c, resolveLeastPrivilegeOperatorScopesForMethod as d, loadGatewayTlsRuntime as f, ensureExplicitGatewayAuth as i, authorizeOperatorScopesForMethod as l, callGateway as n, resolveExplicitGatewayAuth as o, callGatewayLeastPrivilege as r, ADMIN_SCOPE as s, buildGatewayConnectionDetails as t, isNodeRoleMethod as u };