import { n as isRich, r as theme, t as colorize } from "./theme-D58JpUfy.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { t as resolveSystemBin } from "./resolve-system-bin-pDkUnF3W.js";
import { i as loadManagedProxyTlsOptions, o as resolveManagedProxyCaFileForUrl } from "./managed-proxy-undici-CxE3Ud0o.js";
import { r as createHttp1ProxyAgent } from "./undici-runtime-DWGlO0I7.js";
import { t as fetchWithRuntimeDispatcher } from "./runtime-fetch-BCUOAbGl.js";
import { r as resolveDebugProxySettings, t as applyDebugProxyEnv } from "./env-CDrl0Kuj.js";
import { c as closeDebugProxyCaptureStore, i as initializeDebugProxyCapture, l as getDebugProxyCaptureStore, r as finalizeDebugProxyCapture } from "./runtime-Cqhsh14m.js";
import { r as probeApnsHttp2ReachabilityViaProxy } from "./push-apns-http2-BZfw4u2z.js";
import { t as buildDebugProxyCoverageReport } from "./coverage-D7_VF0hH.js";
import process$1 from "node:process";
import { URL as URL$1 } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createServer as createServer$1, request } from "node:http";
import { request as request$1 } from "node:https";
//#region src/infra/net/proxy/proxy-validation.ts
const DEFAULT_PROXY_VALIDATION_ALLOWED_URLS = ["https://example.com/"];
const DEFAULT_PROXY_VALIDATION_TIMEOUT_MS = 5e3;
const DENIED_CANARY_HEADER = "x-openclaw-proxy-validation-canary";
const APNS_REACHABILITY_REASON = "InvalidProviderToken";
function normalizeProxyUrl(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function isHttpOrHttpsProxyUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}
function validateProxyUrl(value) {
	if (!value) return ["proxy validation requires proxy.proxyUrl, --proxy-url, or OPENCLAW_PROXY_URL"];
	if (!isHttpOrHttpsProxyUrl(value)) return ["proxyUrl must use http:// or https://"];
	return [];
}
function validateProxyEnabled(source, enabled) {
	if (enabled || source === "override" || source === "missing" || source === "disabled") return [];
	if (source === "env") return ["proxy validation requires proxy.enabled to be true for OPENCLAW_PROXY_URL"];
	return ["proxy validation requires proxy.enabled to be true for configured proxy URLs"];
}
function validateResolvedProxy(source, enabled, value) {
	return [...validateProxyUrl(value), ...validateProxyEnabled(source, enabled)];
}
function resolveProxyValidationConfig(options) {
	const overrideUrl = normalizeProxyUrl(options.proxyUrlOverride);
	if (overrideUrl) {
		const proxyCaFile = resolveManagedProxyCaFileForUrl({
			proxyUrl: overrideUrl,
			caFileOverride: options.proxyCaFileOverride
		});
		return {
			enabled: true,
			proxyUrl: overrideUrl,
			...proxyCaFile ? { proxyCaFile } : {},
			source: "override",
			errors: validateResolvedProxy("override", true, overrideUrl)
		};
	}
	const configUrl = normalizeProxyUrl(options.config?.proxyUrl);
	if (configUrl) {
		const proxyCaFile = resolveManagedProxyCaFileForUrl({
			proxyUrl: configUrl,
			config: options.config,
			caFileOverride: options.proxyCaFileOverride
		});
		return {
			enabled: options.config?.enabled === true,
			proxyUrl: configUrl,
			...proxyCaFile ? { proxyCaFile } : {},
			source: "config",
			errors: validateResolvedProxy("config", options.config?.enabled === true, configUrl)
		};
	}
	const envUrl = normalizeProxyUrl(options.env?.OPENCLAW_PROXY_URL);
	if (envUrl) {
		const proxyCaFile = resolveManagedProxyCaFileForUrl({
			proxyUrl: envUrl,
			config: options.config,
			caFileOverride: options.proxyCaFileOverride
		});
		return {
			enabled: options.config?.enabled === true,
			proxyUrl: envUrl,
			...proxyCaFile ? { proxyCaFile } : {},
			source: "env",
			errors: validateResolvedProxy("env", options.config?.enabled === true, envUrl)
		};
	}
	if (options.config?.enabled === true) return {
		enabled: true,
		source: "missing",
		errors: validateProxyUrl(void 0)
	};
	return {
		enabled: false,
		source: "disabled",
		errors: ["proxy validation requires proxy.enabled=true with proxy.proxyUrl or OPENCLAW_PROXY_URL, or --proxy-url"]
	};
}
async function defaultProxyValidationFetchCheck({ proxyUrl, proxyTls, targetUrl, timeoutMs }) {
	const dispatcher = createHttp1ProxyAgent({
		uri: proxyUrl,
		...proxyTls ? { proxyTls } : {}
	}, timeoutMs);
	try {
		const response = await fetchWithRuntimeDispatcher(targetUrl, {
			dispatcher,
			redirect: "manual"
		});
		response.body?.cancel();
		return {
			ok: response.ok,
			status: response.status,
			deniedCanaryToken: response.headers.get(DENIED_CANARY_HEADER) ?? void 0
		};
	} finally {
		await dispatcher.close();
	}
}
async function defaultProxyValidationApnsCheck({ proxyUrl, proxyTls, authority, timeoutMs }) {
	const result = await probeApnsHttp2ReachabilityViaProxy({
		proxyUrl,
		...proxyTls ? { proxyTls } : {},
		authority,
		timeoutMs
	});
	return {
		status: result.status,
		apnsId: result.responseHeaders?.["apns-id"],
		apnsReason: parseApnsErrorReason(result.body)
	};
}
function parseApnsErrorReason(body) {
	try {
		const parsed = JSON.parse(body);
		if (!parsed || typeof parsed !== "object") return;
		const reason = parsed.reason;
		return typeof reason === "string" && reason.trim() ? reason : void 0;
	} catch {
		return;
	}
}
function hasApnsReachabilityProof(result) {
	if (result.apnsId) return true;
	return result.status === 403 && result.apnsReason === APNS_REACHABILITY_REASON;
}
function normalizeTimeoutMs(value) {
	if (value === void 0 || !Number.isFinite(value) || value <= 0) return DEFAULT_PROXY_VALIDATION_TIMEOUT_MS;
	return Math.floor(value);
}
function isValidHttpTargetUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}
function closeServer(server) {
	return new Promise((resolve, reject) => {
		server.close((err) => {
			if (err) {
				reject(err);
				return;
			}
			resolve();
		});
	});
}
async function createLoopbackDeniedCanary() {
	const token = randomUUID();
	const server = createServer$1((_request, response) => {
		response.writeHead(204, {
			[DENIED_CANARY_HEADER]: token,
			"cache-control": "no-store"
		});
		response.end();
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (typeof address === "string" || address === null) {
		await closeServer(server);
		throw new Error("Unable to start loopback proxy validation canary");
	}
	return {
		target: {
			url: `http://127.0.0.1:${address.port}/`,
			expectedCanaryToken: token,
			transportErrorMeansBlocked: true
		},
		close: () => closeServer(server)
	};
}
async function resolveDeniedTargets(deniedUrls) {
	if (deniedUrls !== void 0) return {
		targets: deniedUrls.map((url) => ({
			url,
			transportErrorMeansBlocked: false
		})),
		close: async () => void 0
	};
	const canary = await createLoopbackDeniedCanary();
	return {
		targets: [canary.target],
		close: canary.close
	};
}
async function runAllowedCheck(params) {
	if (!isValidHttpTargetUrl(params.url)) return {
		kind: "allowed",
		url: params.url,
		ok: false,
		error: "Invalid allowed destination URL"
	};
	try {
		const result = await params.fetchCheck({
			proxyUrl: params.proxyUrl,
			...params.proxyTls ? { proxyTls: params.proxyTls } : {},
			targetUrl: params.url,
			timeoutMs: params.timeoutMs
		});
		if (!result.ok) return {
			kind: "allowed",
			url: params.url,
			ok: false,
			status: result.status,
			error: `Allowed destination returned HTTP ${result.status}`
		};
		return {
			kind: "allowed",
			url: params.url,
			ok: true,
			status: result.status
		};
	} catch (err) {
		return {
			kind: "allowed",
			url: params.url,
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
async function runDeniedCheck(params) {
	if (!isValidHttpTargetUrl(params.target.url)) return {
		kind: "denied",
		url: params.target.url,
		ok: false,
		error: "Invalid denied destination URL"
	};
	try {
		const result = await params.fetchCheck({
			proxyUrl: params.proxyUrl,
			...params.proxyTls ? { proxyTls: params.proxyTls } : {},
			targetUrl: params.target.url,
			timeoutMs: params.timeoutMs
		});
		if (params.target.expectedCanaryToken !== void 0 && result.deniedCanaryToken !== params.target.expectedCanaryToken) {
			if (result.ok) return {
				kind: "denied",
				url: params.target.url,
				ok: false,
				status: result.status,
				error: `Denied loopback canary returned HTTP ${result.status} without the validation token`
			};
			return {
				kind: "denied",
				url: params.target.url,
				ok: true,
				status: result.status
			};
		}
		return {
			kind: "denied",
			url: params.target.url,
			ok: false,
			status: result.status,
			error: params.target.expectedCanaryToken === void 0 ? `Denied destination returned HTTP ${result.status}; expected the proxy to block the connection` : `Denied loopback canary was reachable through the proxy with HTTP ${result.status}`
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (params.target.transportErrorMeansBlocked) return {
			kind: "denied",
			url: params.target.url,
			ok: true,
			error: message
		};
		return {
			kind: "denied",
			url: params.target.url,
			ok: false,
			error: `Denied destination failed without a verifiable proxy-deny signal: ${message}`
		};
	}
}
async function runApnsReachabilityCheck(params) {
	try {
		const result = await params.apnsCheck({
			proxyUrl: params.proxyUrl,
			...params.proxyTls ? { proxyTls: params.proxyTls } : {},
			authority: params.authority,
			timeoutMs: params.timeoutMs
		});
		if (!hasApnsReachabilityProof(result)) return {
			kind: "apns",
			url: params.authority,
			ok: false,
			error: "APNs reachability check failed: response did not include an apns-id header or APNs InvalidProviderToken body. The proxy may be intercepting the connection instead of tunneling it."
		};
		return {
			kind: "apns",
			url: params.authority,
			ok: true,
			status: result.status
		};
	} catch (err) {
		return {
			kind: "apns",
			url: params.authority,
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
async function runProxyValidation(options) {
	const config = resolveProxyValidationConfig(options);
	if (config.errors.length > 0) return {
		ok: false,
		config,
		checks: []
	};
	if (!config.proxyUrl) {
		if (!config.enabled && config.source === "disabled") return {
			ok: false,
			config: {
				...config,
				errors: ["Proxy validation is disabled. Set proxy.enabled=true or pass --proxy-url to run validation."]
			},
			checks: []
		};
		return {
			ok: false,
			config,
			checks: []
		};
	}
	const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
	let proxyTls;
	try {
		proxyTls = await loadManagedProxyTlsOptions(config.proxyCaFile);
	} catch (err) {
		return {
			ok: false,
			config: {
				...config,
				errors: [...config.errors, err instanceof Error ? err.message : String(err)]
			},
			checks: []
		};
	}
	const fetchCheck = options.fetchCheck ?? defaultProxyValidationFetchCheck;
	const apnsCheck = options.apnsCheck ?? defaultProxyValidationApnsCheck;
	const apnsAuthority = options.apnsAuthority ?? "https://api.sandbox.push.apple.com";
	const allowedUrls = options.allowedUrls ?? DEFAULT_PROXY_VALIDATION_ALLOWED_URLS;
	const deniedTargets = await resolveDeniedTargets(options.deniedUrls);
	const checks = [];
	try {
		for (const url of allowedUrls) checks.push(await runAllowedCheck({
			url,
			proxyUrl: config.proxyUrl,
			proxyTls,
			timeoutMs,
			fetchCheck
		}));
		for (const target of deniedTargets.targets) checks.push(await runDeniedCheck({
			target,
			proxyUrl: config.proxyUrl,
			proxyTls,
			timeoutMs,
			fetchCheck
		}));
		if (options.apnsReachability === true) checks.push(await runApnsReachabilityCheck({
			authority: apnsAuthority,
			proxyUrl: config.proxyUrl,
			proxyTls,
			timeoutMs,
			apnsCheck
		}));
	} finally {
		await deniedTargets.close();
	}
	return {
		ok: checks.every((check) => check.ok),
		config,
		checks
	};
}
//#endregion
//#region src/proxy-capture/ca.ts
const execFileAsync = promisify(execFile);
async function ensureDebugProxyCa(certDir) {
	fs.mkdirSync(certDir, { recursive: true });
	const certPath = path.join(certDir, "root-ca.pem");
	const keyPath = path.join(certDir, "root-ca-key.pem");
	if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return {
		certPath,
		keyPath
	};
	const openssl = resolveSystemBin("openssl");
	if (!openssl) throw new Error("openssl is required to generate debug proxy certificates");
	await execFileAsync(openssl, [
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-sha256",
		"-days",
		"7",
		"-nodes",
		"-keyout",
		keyPath,
		"-out",
		certPath,
		"-subj",
		"/CN=OpenClaw Debug Proxy"
	]);
	return {
		certPath,
		keyPath
	};
}
//#endregion
//#region src/proxy-capture/proxy-server.ts
const TRUTHY_ENV = new Set([
	"1",
	"true",
	"yes",
	"on"
]);
const DEBUG_PROXY_DIRECT_CONNECT_OVERRIDE = "OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY";
function isTruthyEnvValue(value) {
	return TRUTHY_ENV.has((value ?? "").trim().toLowerCase());
}
function isManagedProxyActive(env = process.env) {
	return isTruthyEnvValue(env["OPENCLAW_PROXY_ACTIVE"]);
}
function allowsDirectConnectWithManagedProxy(env = process.env) {
	return isTruthyEnvValue(env[DEBUG_PROXY_DIRECT_CONNECT_OVERRIDE]);
}
function assertDebugProxyDirectUpstreamAllowed(env = process.env) {
	if (!isManagedProxyActive(env) || allowsDirectConnectWithManagedProxy(env)) return;
	throw new Error(`Debug proxy direct upstream forwarding is disabled while managed proxy mode is active. Set ${DEBUG_PROXY_DIRECT_CONNECT_OVERRIDE}=1 only for approved local diagnostics.`);
}
function parseConnectTarget(rawTarget) {
	const trimmed = rawTarget?.trim() ?? "";
	if (!trimmed) return {
		hostname: "127.0.0.1",
		port: 443
	};
	const bracketedMatch = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);
	if (bracketedMatch) {
		const hostname = bracketedMatch[1]?.trim() || "127.0.0.1";
		const port = Number(bracketedMatch[2] || 443);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CONNECT target port");
		return {
			hostname,
			port
		};
	}
	const lastColon = trimmed.lastIndexOf(":");
	if (lastColon <= 0 || lastColon === trimmed.length - 1) return {
		hostname: trimmed,
		port: 443
	};
	const hostname = trimmed.slice(0, lastColon).trim() || "127.0.0.1";
	const portText = trimmed.slice(lastColon + 1).trim();
	const port = Number(portText);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CONNECT target port");
	return {
		hostname,
		port
	};
}
function normalizeTargetUrl(req) {
	if (req.url?.startsWith("http://") || req.url?.startsWith("https://")) return new URL$1(req.url);
	return new URL$1(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`);
}
async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks);
}
async function startDebugProxyServer(params) {
	await ensureDebugProxyCa(params.settings.certDir);
	const store = getDebugProxyCaptureStore(params.settings.dbPath, params.settings.blobDir);
	const host = params.host?.trim() || "127.0.0.1";
	const server = createServer$1(async (req, res) => {
		const flowId = randomUUID();
		let target;
		try {
			target = normalizeTargetUrl(req);
		} catch (error) {
			const message = "Invalid proxy target URL";
			store.recordEvent({
				sessionId: params.settings.sessionId,
				ts: Date.now(),
				sourceScope: "openclaw",
				sourceProcess: params.settings.sourceProcess,
				protocol: "http",
				direction: "local",
				kind: "error",
				flowId,
				method: req.method,
				host: req.headers.host,
				path: req.url ?? "",
				errorText: error instanceof Error ? error.message : String(error)
			});
			const responseBody = `${message}\n`;
			res.writeHead(400, {
				Connection: "close",
				"Content-Type": "text/plain; charset=utf-8",
				"Content-Length": Buffer.byteLength(responseBody)
			});
			res.end(responseBody);
			return;
		}
		try {
			assertDebugProxyDirectUpstreamAllowed();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			store.recordEvent({
				sessionId: params.settings.sessionId,
				ts: Date.now(),
				sourceScope: "openclaw",
				sourceProcess: params.settings.sourceProcess,
				protocol: target.protocol === "https:" ? "https" : "http",
				direction: "local",
				kind: "error",
				flowId,
				method: req.method,
				host: target.host,
				path: `${target.pathname}${target.search}`,
				errorText: message
			});
			const responseBody = `${message}\n`;
			res.writeHead(403, {
				Connection: "close",
				"Content-Type": "text/plain; charset=utf-8",
				"Content-Length": Buffer.byteLength(responseBody)
			});
			res.end(responseBody);
			return;
		}
		const body = await readBody(req);
		store.recordEvent({
			sessionId: params.settings.sessionId,
			ts: Date.now(),
			sourceScope: "openclaw",
			sourceProcess: params.settings.sourceProcess,
			protocol: target.protocol === "https:" ? "https" : "http",
			direction: "outbound",
			kind: "request",
			flowId,
			method: req.method,
			host: target.host,
			path: `${target.pathname}${target.search}`,
			headersJson: JSON.stringify(req.headers),
			dataText: body.subarray(0, 8192).toString("utf8")
		});
		const upstream = (target.protocol === "https:" ? request$1 : request)(target, {
			method: req.method,
			headers: req.headers
		}, (upstreamRes) => {
			const chunks = [];
			upstreamRes.on("data", (chunk) => {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				chunks.push(buffer);
				res.write(buffer);
			});
			upstreamRes.on("end", () => {
				const responseBody = Buffer.concat(chunks);
				store.recordEvent({
					sessionId: params.settings.sessionId,
					ts: Date.now(),
					sourceScope: "openclaw",
					sourceProcess: params.settings.sourceProcess,
					protocol: target.protocol === "https:" ? "https" : "http",
					direction: "inbound",
					kind: "response",
					flowId,
					method: req.method,
					host: target.host,
					path: `${target.pathname}${target.search}`,
					status: upstreamRes.statusCode ?? void 0,
					headersJson: JSON.stringify(upstreamRes.headers),
					dataText: responseBody.subarray(0, 8192).toString("utf8")
				});
				res.end();
			});
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
		});
		upstream.on("error", (error) => {
			store.recordEvent({
				sessionId: params.settings.sessionId,
				ts: Date.now(),
				sourceScope: "openclaw",
				sourceProcess: params.settings.sourceProcess,
				protocol: target.protocol === "https:" ? "https" : "http",
				direction: "local",
				kind: "error",
				flowId,
				method: req.method,
				host: target.host,
				path: `${target.pathname}${target.search}`,
				errorText: error.message
			});
			res.statusCode = 502;
			res.end(error.message);
		});
		if (body.byteLength > 0) upstream.write(body);
		upstream.end();
	});
	server.on("connect", (req, clientSocket, head) => {
		const flowId = randomUUID();
		let hostname = "127.0.0.1";
		let port = 443;
		try {
			const parsed = parseConnectTarget(req.url);
			hostname = parsed.hostname;
			port = parsed.port;
		} catch (error) {
			store.recordEvent({
				sessionId: params.settings.sessionId,
				ts: Date.now(),
				sourceScope: "openclaw",
				sourceProcess: params.settings.sourceProcess,
				protocol: "connect",
				direction: "local",
				kind: "error",
				flowId,
				host: hostname,
				path: req.url ?? "",
				errorText: error instanceof Error ? error.message : String(error)
			});
			clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		store.recordEvent({
			sessionId: params.settings.sessionId,
			ts: Date.now(),
			sourceScope: "openclaw",
			sourceProcess: params.settings.sourceProcess,
			protocol: "connect",
			direction: "local",
			kind: "connect",
			flowId,
			host: hostname,
			path: req.url ?? "",
			headersJson: JSON.stringify(req.headers)
		});
		try {
			assertDebugProxyDirectUpstreamAllowed();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			store.recordEvent({
				sessionId: params.settings.sessionId,
				ts: Date.now(),
				sourceScope: "openclaw",
				sourceProcess: params.settings.sourceProcess,
				protocol: "connect",
				direction: "local",
				kind: "error",
				flowId,
				host: hostname,
				path: req.url ?? "",
				errorText: message
			});
			const responseBody = `${message}\n`;
			clientSocket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(responseBody)}\r\n\r\n${responseBody}`);
			return;
		}
		const upstreamSocket = net.connect(port, hostname, () => {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) upstreamSocket.write(head);
			clientSocket.pipe(upstreamSocket);
			upstreamSocket.pipe(clientSocket);
		});
		clientSocket.on("error", (error) => {
			store.recordEvent({
				sessionId: params.settings.sessionId,
				ts: Date.now(),
				sourceScope: "openclaw",
				sourceProcess: params.settings.sourceProcess,
				protocol: "connect",
				direction: "local",
				kind: "error",
				flowId,
				host: hostname,
				path: req.url ?? "",
				errorText: error.message
			});
			upstreamSocket.destroy();
		});
		upstreamSocket.on("error", (error) => {
			store.recordEvent({
				sessionId: params.settings.sessionId,
				ts: Date.now(),
				sourceScope: "openclaw",
				sourceProcess: params.settings.sourceProcess,
				protocol: "connect",
				direction: "local",
				kind: "error",
				flowId,
				host: hostname,
				path: req.url ?? "",
				errorText: error.message
			});
			clientSocket.destroy();
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(params.port ?? 0, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Failed to resolve debug proxy server address");
	return {
		proxyUrl: `http://${host}:${address.port}`,
		stop: async () => await new Promise((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		})
	};
}
//#endregion
//#region src/cli/proxy-cli.runtime.ts
async function runDebugProxyStartCommand(opts) {
	const settings = resolveDebugProxySettings();
	const store = getDebugProxyCaptureStore(settings.dbPath, settings.blobDir);
	store.upsertSession({
		id: settings.sessionId,
		startedAt: Date.now(),
		mode: "proxy-start",
		sourceScope: "openclaw",
		sourceProcess: "openclaw",
		proxyUrl: settings.proxyUrl,
		dbPath: settings.dbPath,
		blobDir: settings.blobDir
	});
	initializeDebugProxyCapture("proxy-start", settings);
	const ca = await ensureDebugProxyCa(settings.certDir);
	const server = await startDebugProxyServer({
		host: opts.host,
		port: opts.port,
		settings
	});
	process$1.stdout.write(`Debug proxy: ${server.proxyUrl}\n`);
	process$1.stdout.write(`CA cert: ${ca.certPath}\n`);
	process$1.stdout.write(`Capture DB: ${settings.dbPath}\n`);
	process$1.stdout.write("Press Ctrl+C to stop.\n");
	const shutdown = async () => {
		process$1.off("SIGINT", onSignal);
		process$1.off("SIGTERM", onSignal);
		await server.stop();
		if (settings.enabled) finalizeDebugProxyCapture(settings);
		else {
			store.endSession(settings.sessionId);
			closeDebugProxyCaptureStore();
		}
		process$1.exit(0);
	};
	const onSignal = () => {
		shutdown();
	};
	process$1.on("SIGINT", onSignal);
	process$1.on("SIGTERM", onSignal);
	await new Promise(() => void 0);
}
async function runDebugProxyRunCommand(opts) {
	if (opts.commandArgs.length === 0) throw new Error("proxy run requires a command after --");
	const sessionId = randomUUID();
	const settings = {
		...resolveDebugProxySettings(),
		sessionId
	};
	getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).upsertSession({
		id: sessionId,
		startedAt: Date.now(),
		mode: "proxy-run",
		sourceScope: "openclaw",
		sourceProcess: "openclaw",
		proxyUrl: void 0,
		dbPath: settings.dbPath,
		blobDir: settings.blobDir
	});
	const server = await startDebugProxyServer({
		host: opts.host,
		port: opts.port,
		settings
	});
	const [command, ...args] = opts.commandArgs;
	const childEnv = applyDebugProxyEnv(process$1.env, {
		proxyUrl: server.proxyUrl,
		sessionId,
		dbPath: settings.dbPath,
		blobDir: settings.blobDir,
		certDir: settings.certDir
	});
	try {
		await new Promise((resolve, reject) => {
			const child = spawn(command, args, {
				stdio: "inherit",
				env: childEnv,
				cwd: process$1.cwd()
			});
			child.once("error", reject);
			child.once("exit", (code, signal) => {
				process$1.exitCode = signal ? 1 : code ?? 1;
				resolve();
			});
		});
	} finally {
		await server.stop();
		getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).endSession(sessionId);
	}
}
function redactProxyUrl(value) {
	if (!value) return;
	try {
		const url = new URL(value);
		if (url.username || url.password) {
			url.username = "redacted";
			url.password = "redacted";
		}
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return "<invalid proxy URL>";
	}
}
function redactProxyValidationResult(result) {
	return {
		...result,
		config: {
			...result.config,
			proxyUrl: redactProxyUrl(result.config.proxyUrl)
		}
	};
}
function getProxyValidationTextColors() {
	const rich = isRich();
	const apply = (color) => (value) => colorize(rich, color, value);
	return {
		heading: apply(theme.heading),
		success: apply(theme.success),
		error: apply(theme.error),
		muted: apply(theme.muted),
		warn: apply(theme.warn)
	};
}
function formatProxyCheckLine(check, colors) {
	const icon = check.ok ? colors.success("✓") : colors.error("✗");
	const paddedKind = colors.muted(check.kind.padEnd(7, " "));
	const status = check.status === void 0 ? "" : ` ${check.ok ? colors.success(`HTTP ${check.status}`) : colors.error(`HTTP ${check.status}`)}`;
	const detail = check.error ? ` — ${check.ok ? colors.muted(check.error) : colors.error(check.error)}` : "";
	return `  ${icon} ${paddedKind} ${check.url}${status}${detail}`;
}
function formatProxyValidationNextSteps(result) {
	if (result.ok) return [];
	if (result.config.errors.some((error) => error.includes("proxy.enabled"))) return ["Enable proxy.enabled with proxy.proxyUrl or OPENCLAW_PROXY_URL, or pass --proxy-url for an explicit one-off validation."];
	if (result.config.errors.some((error) => error.includes("proxy CA file could not be read"))) return ["Confirm proxy.tls.caFile or --proxy-ca-file points to a readable PEM CA file for the HTTPS proxy endpoint."];
	if (result.config.errors.length > 0) return ["Fix proxy.proxyUrl, OPENCLAW_PROXY_URL, or --proxy-url so it uses a reachable http:// or https:// proxy."];
	if (result.checks.some((check) => !check.ok && check.kind === "allowed")) return ["Confirm the proxy is reachable from this deployment context and permits the allowed destinations."];
	if (result.checks.some((check) => !check.ok && check.kind === "denied")) return ["Update the proxy ACL so denied destinations are blocked, or pass the expected --denied-url values."];
	return ["Review the failed checks above and update proxy configuration or validation destinations."];
}
function formatProxyValidationText(result) {
	const colors = getProxyValidationTextColors();
	const redactedProxyUrl = redactProxyUrl(result.config.proxyUrl);
	const lines = [
		result.ok ? colors.success("Proxy validation passed") : colors.error("Proxy validation failed"),
		"",
		colors.heading("Proxy"),
		`  Source: ${colors.muted(result.config.source)}`,
		`  URL:    ${redactedProxyUrl ?? colors.muted("not configured")}`
	];
	if (result.config.errors.length > 0) {
		lines.push("", colors.heading("Problems"));
		for (const error of result.config.errors) lines.push(`  - ${colors.error(error)}`);
	}
	if (result.checks.length > 0) {
		lines.push("", colors.heading("Checks"));
		for (const check of result.checks) lines.push(formatProxyCheckLine(check, colors));
	}
	const nextSteps = formatProxyValidationNextSteps(result);
	if (nextSteps.length > 0) {
		lines.push("", colors.heading("Next steps"));
		for (const nextStep of nextSteps) lines.push(`  ${colors.warn(nextStep)}`);
	}
	return `${lines.join("\n")}\n`;
}
async function runProxyValidateCommand(opts) {
	const result = await runProxyValidation({
		config: getRuntimeConfig()?.proxy,
		env: process$1.env,
		proxyUrlOverride: opts.proxyUrl,
		proxyCaFileOverride: opts.proxyCaFile,
		allowedUrls: opts.allowedUrls,
		deniedUrls: opts.deniedUrls,
		apnsReachability: opts.apnsReachability,
		apnsAuthority: opts.apnsAuthority,
		timeoutMs: opts.timeoutMs
	});
	const outputResult = redactProxyValidationResult(result);
	process$1.stdout.write(opts.json === true ? `${JSON.stringify(outputResult, null, 2)}\n` : formatProxyValidationText(outputResult));
	if (!result.ok) process$1.exitCode = 1;
}
async function runDebugProxySessionsCommand(opts) {
	const settings = resolveDebugProxySettings();
	const sessions = getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).listSessions(opts.limit ?? 20);
	process$1.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
	closeDebugProxyCaptureStore();
}
async function runDebugProxyQueryCommand(opts) {
	const settings = resolveDebugProxySettings();
	const rows = getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).queryPreset(opts.preset, opts.sessionId);
	process$1.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
	closeDebugProxyCaptureStore();
}
async function runDebugProxyCoverageCommand() {
	process$1.stdout.write(`${JSON.stringify(buildDebugProxyCoverageReport(), null, 2)}\n`);
	closeDebugProxyCaptureStore();
}
async function runDebugProxyPurgeCommand() {
	const settings = resolveDebugProxySettings();
	const result = getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).purgeAll();
	process$1.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	closeDebugProxyCaptureStore();
}
async function readDebugProxyBlobCommand(opts) {
	const settings = resolveDebugProxySettings();
	const content = getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).readBlob(opts.blobId);
	if (content == null) {
		closeDebugProxyCaptureStore();
		throw new Error(`Unknown blob: ${opts.blobId}`);
	}
	process$1.stdout.write(content);
	closeDebugProxyCaptureStore();
}
//#endregion
export { readDebugProxyBlobCommand, runDebugProxyCoverageCommand, runDebugProxyPurgeCommand, runDebugProxyQueryCommand, runDebugProxyRunCommand, runDebugProxySessionsCommand, runDebugProxyStartCommand, runProxyValidateCommand };
