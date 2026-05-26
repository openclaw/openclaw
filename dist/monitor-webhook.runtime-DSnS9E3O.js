import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { o as isDiagnosticsEnabled } from "./diagnostic-events-BLgzARSp.js";
import { t as safeEqualSecret } from "./secret-equal-DDhtiQsP.js";
import { b as startDiagnosticHeartbeat, h as logWebhookReceived, m as logWebhookProcessed, p as logWebhookError, x as stopDiagnosticHeartbeat } from "./diagnostic-DEgTYLXt.js";
import { n as sleepWithAbort, t as computeBackoff } from "./backoff-BQ4uO4hX.js";
import { r as formatDurationPrecise } from "./format-duration-BrZ-AaEJ.js";
import { t as resolveTelegramAllowedUpdates } from "./allowed-updates-C8V4-A3j.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { a as isRecoverableTelegramNetworkError, d as isTelegramServerError, u as isTelegramRateLimitError } from "./request-timeouts-CnvnuqEE.js";
import { o as readJsonBodyWithLimit } from "./http-body-BfDL157U.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./security-runtime-CcSekjBd.js";
import { t as createConnectedChannelStatusPatch } from "./gateway-runtime-HxuTzDuS.js";
import "./logging-core-DwEC9Ajh.js";
import { a as createFixedWindowRateLimiter, r as WEBHOOK_RATE_LIMIT_DEFAULTS } from "./webhook-ingress-R0qMwT4u.js";
import { r as applyBasicWebhookRequestGuards } from "./webhook-request-guards-iMi786D5.js";
import { O as withTelegramApiErrorLogging } from "./send-HzJbRmiM.js";
import { t as createTelegramBot } from "./bot-D0mzNk0g.js";
import net from "node:net";
import { createServer as createServer$1 } from "node:http";
import { InputFile } from "grammy";
//#region extensions/telegram/src/webhook-status.ts
function createTelegramWebhookStatusPublisher(setStatus) {
	return {
		noteWebhookStart() {
			setStatus?.({
				mode: "webhook",
				connected: false,
				lastConnectedAt: null,
				lastEventAt: null,
				lastTransportActivityAt: null
			});
		},
		noteWebhookAdvertised(at = Date.now()) {
			setStatus?.({
				...createConnectedChannelStatusPatch(at),
				mode: "webhook",
				lastError: null
			});
		},
		noteWebhookUpdateReceived(at = Date.now()) {
			setStatus?.({
				...createConnectedChannelStatusPatch(at),
				mode: "webhook",
				lastError: null
			});
		},
		noteWebhookRegistrationFailure(error) {
			setStatus?.({
				mode: "webhook",
				connected: false,
				lastError: error
			});
		},
		noteWebhookStop() {
			setStatus?.({
				mode: "webhook",
				connected: false
			});
		}
	};
}
//#endregion
//#region extensions/telegram/src/webhook.ts
const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS = 3e4;
const TELEGRAM_WEBHOOK_REGISTRATION_RETRY_POLICY = {
	initialMs: 5e3,
	maxMs: 6e4,
	factor: 2,
	jitter: .2
};
async function listenHttpServer(params) {
	await new Promise((resolve, reject) => {
		const onError = (err) => {
			params.server.off("error", onError);
			reject(err);
		};
		params.server.once("error", onError);
		params.server.listen(params.port, params.host, () => {
			params.server.off("error", onError);
			resolve();
		});
	});
}
function resolveWebhookPublicUrl(params) {
	if (params.configuredPublicUrl) return params.configuredPublicUrl;
	const address = params.server.address();
	if (address && typeof address !== "string") return `http://${params.host === "0.0.0.0" || address.address === "0.0.0.0" || address.address === "::" ? "localhost" : address.address}:${address.port}${params.path}`;
	return `http://${params.host === "0.0.0.0" ? "localhost" : params.host}:${params.port}${params.path}`;
}
async function initializeTelegramWebhookBot(params) {
	const initSignal = params.abortSignal;
	await withTelegramApiErrorLogging({
		operation: "getMe",
		runtime: params.runtime,
		fn: () => params.bot.init(initSignal)
	});
}
function resolveSingleHeaderValue(header) {
	if (typeof header === "string") return header;
	if (Array.isArray(header) && header.length === 1) return header[0];
}
function hasValidTelegramWebhookSecret(secretHeader, expectedSecret) {
	return safeEqualSecret(secretHeader, expectedSecret);
}
function parseIpLiteral(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	if (trimmed.startsWith("[")) {
		const end = trimmed.indexOf("]");
		if (end !== -1) {
			const candidate = trimmed.slice(1, end);
			return net.isIP(candidate) === 0 ? void 0 : candidate;
		}
	}
	if (net.isIP(trimmed) !== 0) return trimmed;
	const lastColon = trimmed.lastIndexOf(":");
	if (lastColon > -1 && trimmed.includes(".") && trimmed.indexOf(":") === lastColon) {
		const candidate = trimmed.slice(0, lastColon);
		return net.isIP(candidate) === 4 ? candidate : void 0;
	}
}
function isTrustedProxyAddress(ip, trustedProxies) {
	const candidate = parseIpLiteral(ip);
	if (!candidate || !trustedProxies?.length) return false;
	const blockList = new net.BlockList();
	for (const proxy of trustedProxies) {
		const trimmed = normalizeOptionalString(proxy) ?? "";
		if (!trimmed) continue;
		if (trimmed.includes("/")) {
			const [address, prefix] = trimmed.split("/", 2);
			const parsedPrefix = Number.parseInt(prefix ?? "", 10);
			const family = net.isIP(address);
			if (family === 4 && Number.isInteger(parsedPrefix) && parsedPrefix >= 0 && parsedPrefix <= 32) blockList.addSubnet(address, parsedPrefix, "ipv4");
			if (family === 6 && Number.isInteger(parsedPrefix) && parsedPrefix >= 0 && parsedPrefix <= 128) blockList.addSubnet(address, parsedPrefix, "ipv6");
			continue;
		}
		if (net.isIP(trimmed) === 4) {
			blockList.addAddress(trimmed, "ipv4");
			continue;
		}
		if (net.isIP(trimmed) === 6) blockList.addAddress(trimmed, "ipv6");
	}
	return blockList.check(candidate, net.isIP(candidate) === 6 ? "ipv6" : "ipv4");
}
function resolveForwardedClientIp(forwardedFor, trustedProxies) {
	if (!trustedProxies?.length) return;
	const forwardedChain = forwardedFor?.split(",").map((entry) => parseIpLiteral(entry)).filter((entry) => Boolean(entry));
	if (!forwardedChain?.length) return;
	for (let index = forwardedChain.length - 1; index >= 0; index -= 1) {
		const hop = forwardedChain[index];
		if (!isTrustedProxyAddress(hop, trustedProxies)) return hop;
	}
}
function resolveTelegramWebhookClientIp(req, config) {
	const remoteAddress = parseIpLiteral(req.socket.remoteAddress);
	const trustedProxies = config?.gateway?.trustedProxies;
	if (!remoteAddress) return "unknown";
	if (!isTrustedProxyAddress(remoteAddress, trustedProxies)) return remoteAddress;
	const forwardedClientIp = resolveForwardedClientIp(Array.isArray(req.headers["x-forwarded-for"]) ? req.headers["x-forwarded-for"][0] : req.headers["x-forwarded-for"], trustedProxies);
	if (forwardedClientIp) return forwardedClientIp;
	if (config?.gateway?.allowRealIpFallback === true) return parseIpLiteral(Array.isArray(req.headers["x-real-ip"]) ? req.headers["x-real-ip"][0] : req.headers["x-real-ip"]) ?? "unknown";
	return "unknown";
}
function resolveTelegramWebhookRateLimitKey(req, path, config) {
	return `${path}:${resolveTelegramWebhookClientIp(req, config)}`;
}
async function startTelegramWebhook(opts) {
	const path = opts.path ?? "/telegram-webhook";
	const healthPath = opts.healthPath ?? "/healthz";
	const port = opts.port ?? 8787;
	const host = opts.host ?? "127.0.0.1";
	const secret = normalizeOptionalString(opts.secret) ?? "";
	if (!secret) throw new Error("Telegram webhook mode requires a non-empty secret token. Set channels.telegram.webhookSecret in your config.");
	const runtime = opts.runtime ?? defaultRuntime;
	const status = createTelegramWebhookStatusPublisher(opts.setStatus);
	status.noteWebhookStart();
	const webhookRegistrationRetryPolicy = opts.webhookRegistrationRetryPolicy ?? TELEGRAM_WEBHOOK_REGISTRATION_RETRY_POLICY;
	const diagnosticsEnabled = isDiagnosticsEnabled(opts.config);
	const bot = createTelegramBot({
		token: opts.token,
		runtime,
		proxyFetch: opts.fetch,
		config: opts.config,
		accountId: opts.accountId
	});
	await initializeTelegramWebhookBot({
		bot,
		runtime,
		abortSignal: opts.abortSignal
	});
	const telegramWebhookRateLimiter = createFixedWindowRateLimiter({
		windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
		maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
		maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys
	});
	if (diagnosticsEnabled) startDiagnosticHeartbeat(opts.config);
	const server = createServer$1((req, res) => {
		const respondText = (statusCode, text = "") => {
			if (res.headersSent || res.writableEnded) return;
			res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
			res.end(text);
		};
		if (req.url === healthPath) {
			res.writeHead(200);
			res.end("ok");
			return;
		}
		if (req.url !== path || req.method !== "POST") {
			res.writeHead(404);
			res.end();
			return;
		}
		if (!applyBasicWebhookRequestGuards({
			req,
			res,
			rateLimiter: telegramWebhookRateLimiter,
			rateLimitKey: resolveTelegramWebhookRateLimitKey(req, path, opts.config)
		})) return;
		const startTime = Date.now();
		if (diagnosticsEnabled) logWebhookReceived({
			channel: "telegram",
			updateType: "telegram-post"
		});
		if (!hasValidTelegramWebhookSecret(resolveSingleHeaderValue(req.headers["x-telegram-bot-api-secret-token"]), secret)) {
			res.shouldKeepAlive = false;
			res.setHeader("Connection", "close");
			respondText(401, "unauthorized");
			return;
		}
		(async () => {
			const body = await readJsonBodyWithLimit(req, {
				maxBytes: TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
				timeoutMs: TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS,
				emptyObjectOnEmpty: false
			});
			if (!body.ok) {
				if (body.code === "PAYLOAD_TOO_LARGE") {
					respondText(413, body.error);
					return;
				}
				if (body.code === "REQUEST_BODY_TIMEOUT") {
					respondText(408, body.error);
					return;
				}
				if (body.code === "CONNECTION_CLOSED") {
					respondText(400, body.error);
					return;
				}
				respondText(400, body.error);
				return;
			}
			respondText(200);
			status.noteWebhookUpdateReceived();
			(async () => {
				await bot.handleUpdate(body.value);
				if (diagnosticsEnabled) logWebhookProcessed({
					channel: "telegram",
					updateType: "telegram-post",
					durationMs: Date.now() - startTime
				});
			})().catch((err) => {
				const errMsg = formatErrorMessage(err);
				if (diagnosticsEnabled) logWebhookError({
					channel: "telegram",
					updateType: "telegram-post",
					error: errMsg
				});
				runtime.log?.(`webhook update processing failed after ack: ${errMsg}`);
			});
		})().catch((err) => {
			const errMsg = formatErrorMessage(err);
			if (diagnosticsEnabled) logWebhookError({
				channel: "telegram",
				updateType: "telegram-post",
				error: errMsg
			});
			runtime.log?.(`webhook request failed: ${errMsg}`);
			respondText(500);
		});
	});
	await listenHttpServer({
		server,
		port,
		host
	});
	const boundAddress = server.address();
	const boundPort = boundAddress && typeof boundAddress !== "string" ? boundAddress.port : port;
	const publicUrl = resolveWebhookPublicUrl({
		configuredPublicUrl: opts.publicUrl,
		server,
		path,
		host,
		port
	});
	let shutDown = false;
	let webhookAdvertised = false;
	const shutdown = () => {
		if (shutDown) return;
		shutDown = true;
		withTelegramApiErrorLogging({
			operation: "deleteWebhook",
			runtime,
			fn: () => bot.api.deleteWebhook({ drop_pending_updates: false })
		}).catch(() => {});
		server.close();
		bot.stop();
		status.noteWebhookStop();
		if (diagnosticsEnabled) stopDiagnosticHeartbeat();
	};
	if (opts.abortSignal?.aborted) shutdown();
	else if (opts.abortSignal) opts.abortSignal.addEventListener("abort", shutdown, { once: true });
	const advertiseWebhook = async () => {
		if (shutDown || opts.abortSignal?.aborted) return;
		try {
			await withTelegramApiErrorLogging({
				operation: "setWebhook",
				runtime,
				fn: () => bot.api.setWebhook(publicUrl, {
					secret_token: secret,
					allowed_updates: resolveTelegramAllowedUpdates(),
					certificate: opts.webhookCertPath ? new InputFile(opts.webhookCertPath) : void 0
				})
			});
		} catch (err) {
			status.noteWebhookRegistrationFailure(formatErrorMessage(err));
			throw err;
		}
		if (shutDown) return;
		webhookAdvertised = true;
		status.noteWebhookAdvertised();
		runtime.log?.(`webhook advertised to telegram on ${publicUrl}`);
	};
	const shouldRetryWebhookRegistration = (err) => isRecoverableTelegramNetworkError(err, { context: "webhook" }) || isTelegramServerError(err) || isTelegramRateLimitError(err);
	const retryWebhookRegistration = async (firstAttempt) => {
		let attempt = firstAttempt;
		while (true) {
			if (shutDown || opts.abortSignal?.aborted || webhookAdvertised) return;
			const delayMs = computeBackoff(webhookRegistrationRetryPolicy, attempt);
			runtime.log?.(`telegram setWebhook retry ${attempt} scheduled in ${formatDurationPrecise(delayMs)}`);
			try {
				await sleepWithAbort(delayMs, opts.abortSignal);
			} catch {
				return;
			}
			if (shutDown || opts.abortSignal?.aborted || webhookAdvertised) return;
			try {
				await advertiseWebhook();
				return;
			} catch (err) {
				if (!shouldRetryWebhookRegistration(err)) {
					runtime.error?.(`telegram setWebhook retry stopped after non-recoverable error: ${formatErrorMessage(err)}`);
					return;
				}
			}
			attempt += 1;
		}
	};
	const closeAfterStartupFailure = () => {
		shutDown = true;
		server.close();
		bot.stop();
		status.noteWebhookStop();
		if (diagnosticsEnabled) stopDiagnosticHeartbeat();
	};
	runtime.log?.(`webhook local listener on http://${host}:${boundPort}${path}`);
	if (!shutDown) try {
		await advertiseWebhook();
	} catch (err) {
		if (!shouldRetryWebhookRegistration(err)) {
			closeAfterStartupFailure();
			throw err;
		}
		retryWebhookRegistration(1);
	}
	return {
		server,
		bot,
		stop: shutdown
	};
}
//#endregion
export { startTelegramWebhook };
