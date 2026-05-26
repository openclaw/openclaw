import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "../../string-coerce-DyL154ka.js";
import "../../string-coerce-runtime-BAEEbdFW.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import path from "node:path";
import { rm } from "node:fs/promises";
import os from "node:os";
//#region extensions/device-pair/index.ts
let devicePairApiModulePromise;
let notifyModulePromise;
let pairCommandApproveModulePromise;
let pairCommandAuthModulePromise;
function loadDevicePairApiModule() {
	devicePairApiModulePromise ??= import("./api.js");
	return devicePairApiModulePromise;
}
function loadNotifyModule() {
	notifyModulePromise ??= import("./notify.js");
	return notifyModulePromise;
}
function loadPairCommandApproveModule() {
	pairCommandApproveModulePromise ??= import("./pair-command-approve.js");
	return pairCommandApproveModulePromise;
}
function loadPairCommandAuthModule() {
	pairCommandAuthModulePromise ??= import("./pair-command-auth.js");
	return pairCommandAuthModulePromise;
}
function formatDurationMinutes(expiresAtMs) {
	const msRemaining = Math.max(0, expiresAtMs - Date.now());
	const minutes = Math.max(1, Math.ceil(msRemaining / 6e4));
	return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
const QR_CHANNEL_SENDERS = {
	telegram: { createOpts: ({ ctx, qrFilePath, mediaLocalRoots, accountId }) => ({
		mediaUrl: qrFilePath,
		mediaLocalRoots,
		...ctx.messageThreadId != null ? { threadId: ctx.messageThreadId } : {},
		...accountId ? { accountId } : {}
	}) },
	discord: { createOpts: ({ qrFilePath, mediaLocalRoots, accountId }) => ({
		mediaUrl: qrFilePath,
		mediaLocalRoots,
		...accountId ? { accountId } : {}
	}) },
	slack: { createOpts: ({ ctx, qrFilePath, mediaLocalRoots, accountId }) => ({
		mediaUrl: qrFilePath,
		mediaLocalRoots,
		...ctx.messageThreadId != null ? { threadId: String(ctx.messageThreadId) } : {},
		...accountId ? { accountId } : {}
	}) },
	signal: { createOpts: ({ qrFilePath, mediaLocalRoots, accountId }) => ({
		mediaUrl: qrFilePath,
		mediaLocalRoots,
		...accountId ? { accountId } : {}
	}) },
	imessage: { createOpts: ({ qrFilePath, mediaLocalRoots, accountId }) => ({
		mediaUrl: qrFilePath,
		mediaLocalRoots,
		...accountId ? { accountId } : {}
	}) },
	whatsapp: { createOpts: ({ qrFilePath, mediaLocalRoots, accountId }) => ({
		verbose: false,
		mediaUrl: qrFilePath,
		mediaLocalRoots,
		...accountId ? { accountId } : {}
	}) }
};
const GATEWAY_SCHEME_WITHOUT_AUTHORITY_RE = /^(?:https?|wss?):(?!\/\/)/i;
const SCHEME_LIKE_PATH_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\//;
function normalizeUrl(raw, schemeFallback) {
	const candidate = normalizeOptionalString(raw);
	if (!candidate) return null;
	if (GATEWAY_SCHEME_WITHOUT_AUTHORITY_RE.test(candidate)) return null;
	const parsedUrl = parseNormalizedGatewayUrl(candidate);
	if (parsedUrl) return parsedUrl;
	if (candidate.includes("://") || SCHEME_LIKE_PATH_RE.test(candidate)) return null;
	const hostPort = normalizeOptionalString(candidate.split("/", 1)[0]) ?? "";
	return hostPort ? parseNormalizedGatewayUrl(`${schemeFallback}://${hostPort}`) : null;
}
function parseNormalizedGatewayUrl(raw) {
	try {
		const parsed = new URL(raw);
		if (parsed.username || parsed.password) return null;
		const scheme = parsed.protocol.slice(0, -1);
		const normalizedScheme = scheme === "http" ? "ws" : scheme === "https" ? "wss" : scheme;
		if (!(normalizedScheme === "ws" || normalizedScheme === "wss")) return null;
		if (!parsed.hostname) return null;
		return `${normalizedScheme}://${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
	} catch {
		return null;
	}
}
function describeSecureMobilePairingFix(source) {
	return "Tailscale and public mobile pairing require a secure gateway URL (wss://) or Tailscale Serve/Funnel." + (source ? ` Resolved source: ${source}.` : "") + " Fix: use a private LAN address, prefer gateway.tailscale.mode=serve, or set gateway.remote.url / plugins.entries.device-pair.config.publicUrl to a wss:// URL. ws:// setup codes are only valid for localhost/loopback, private LAN addresses, .local hosts, or the Android emulator.";
}
function normalizeHostForIpCheck(host) {
	let normalized = normalizeLowercaseStringOrEmpty(host);
	if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1);
	if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
	const zoneIndex = normalized.indexOf("%");
	if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);
	return normalized;
}
function isLoopbackHost(host) {
	const normalized = normalizeHostForIpCheck(host);
	if (!normalized) return false;
	if (normalized === "localhost" || normalized === "0.0.0.0" || normalized === "::") return true;
	const octets = parseIPv4Octets(normalized);
	if (octets) return octets[0] === 127;
	return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
}
function resolveScheme(cfg, opts) {
	if (opts?.forceSecure) return "wss";
	return cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
}
function parseIPv4Octets(address) {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	if (parts.some((part) => !/^\d+$/.test(part))) return null;
	const octets = parts.map((part) => Number.parseInt(part, 10));
	if (octets.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) return null;
	return octets;
}
function isPrivateIPv4(address) {
	const octets = parseIPv4Octets(address);
	if (!octets) return false;
	const [a, b] = octets;
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	return false;
}
function isPrivateLanCleartextHost(host) {
	const normalized = normalizeHostForIpCheck(host);
	if (normalized.endsWith(".local")) return true;
	if (isPrivateIPv4(normalized)) return true;
	const octets = parseIPv4Octets(normalized);
	if (!octets) return false;
	return octets[0] === 169 && octets[1] === 254;
}
function isTailnetIPv4(address) {
	const octets = parseIPv4Octets(address);
	if (!octets) return false;
	const [a, b] = octets;
	return a === 100 && b >= 64 && b <= 127;
}
function isMobilePairingCleartextAllowedHost(host) {
	const normalized = normalizeHostForIpCheck(host);
	return isLoopbackHost(normalized) || normalized === "10.0.2.2" || isPrivateLanCleartextHost(normalized);
}
function validateMobilePairingUrl(url, source) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return "Resolved mobile pairing URL is invalid.";
	}
	const protocol = parsed.protocol === "https:" ? "wss:" : parsed.protocol === "http:" ? "ws:" : parsed.protocol;
	if (protocol === "wss:") return null;
	if (protocol !== "ws:" || isMobilePairingCleartextAllowedHost(parsed.hostname)) return null;
	return describeSecureMobilePairingFix(source);
}
function pickMatchingIPv4(predicate) {
	const nets = os.networkInterfaces();
	for (const entries of Object.values(nets)) {
		if (!entries) continue;
		for (const entry of entries) {
			const family = entry?.family;
			const isIpv4 = family === "IPv4" || family === 4;
			if (!entry || entry.internal || !isIpv4) continue;
			const address = normalizeOptionalString(entry.address) ?? "";
			if (!address) continue;
			if (predicate(address)) return address;
		}
	}
	return null;
}
function pickLanIPv4() {
	return pickMatchingIPv4(isPrivateIPv4);
}
function pickTailnetIPv4() {
	return pickMatchingIPv4(isTailnetIPv4);
}
async function resolveTailnetHost() {
	const { resolveTailnetHostWithRunner, runPluginCommandWithTimeout } = await loadDevicePairApiModule();
	return await resolveTailnetHostWithRunner((argv, opts) => runPluginCommandWithTimeout({
		argv,
		timeoutMs: opts.timeoutMs
	}));
}
function resolveAuthLabel(cfg) {
	const mode = cfg.gateway?.auth?.mode;
	const token = pickFirstDefined([process.env.OPENCLAW_GATEWAY_TOKEN, cfg.gateway?.auth?.token]) ?? void 0;
	const password = pickFirstDefined([process.env.OPENCLAW_GATEWAY_PASSWORD, cfg.gateway?.auth?.password]) ?? void 0;
	if (mode === "token" || mode === "password") return resolveRequiredAuthLabel(mode, {
		token,
		password
	});
	if (token) return { label: "token" };
	if (password) return { label: "password" };
	return { error: "Gateway auth is not configured (no token or password)." };
}
function pickFirstDefined(candidates) {
	for (const value of candidates) {
		const trimmed = normalizeOptionalString(value);
		if (trimmed) return trimmed;
	}
	return null;
}
function resolveRequiredAuthLabel(mode, values) {
	if (mode === "token") return values.token ? { label: "token" } : { error: "Gateway auth is set to token, but no token is configured." };
	return values.password ? { label: "password" } : { error: "Gateway auth is set to password, but no password is configured." };
}
async function resolveGatewayUrl(api) {
	const { resolveGatewayBindUrl, resolveGatewayPort } = await loadDevicePairApiModule();
	const cfg = api.config;
	const pluginCfg = api.pluginConfig ?? {};
	const scheme = resolveScheme(cfg);
	const port = resolveGatewayPort(cfg);
	const configuredPublicUrl = normalizeOptionalString(pluginCfg.publicUrl);
	if (configuredPublicUrl) {
		const url = normalizeUrl(configuredPublicUrl, scheme);
		if (url) return {
			url,
			source: "plugins.entries.device-pair.config.publicUrl"
		};
		return { error: "Configured publicUrl is invalid." };
	}
	const configuredRemoteUrl = normalizeOptionalString(cfg.gateway?.remote?.url);
	const remoteUrl = configuredRemoteUrl ? normalizeUrl(configuredRemoteUrl, scheme) : null;
	if (configuredRemoteUrl && !remoteUrl) return { error: "Configured gateway.remote.url is invalid." };
	const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
	if (tailscaleMode === "serve" || tailscaleMode === "funnel") {
		const host = await resolveTailnetHost();
		if (!host) return { error: "Tailscale Serve is enabled, but MagicDNS could not be resolved." };
		return {
			url: `wss://${host}`,
			source: `gateway.tailscale.mode=${tailscaleMode}`
		};
	}
	if (remoteUrl) return {
		url: remoteUrl,
		source: "gateway.remote.url"
	};
	const bindResult = resolveGatewayBindUrl({
		bind: cfg.gateway?.bind,
		customBindHost: cfg.gateway?.customBindHost,
		scheme,
		port,
		pickTailnetHost: pickTailnetIPv4,
		pickLanHost: pickLanIPv4
	});
	if (bindResult) return bindResult;
	return { error: "Gateway is only bound to loopback. Set gateway.bind=lan, enable tailscale serve, or configure plugins.entries.device-pair.config.publicUrl." };
}
async function resolveMobilePairingGatewayUrl(api) {
	const result = await resolveGatewayUrl(api);
	if (!result.url) return result;
	const mobilePairingUrlError = validateMobilePairingUrl(result.url, result.source);
	if (mobilePairingUrlError) return { error: mobilePairingUrlError };
	return result;
}
function encodeSetupCode(payload) {
	const json = JSON.stringify(payload);
	return Buffer.from(json, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function buildPairingFlowLines(stepTwo) {
	return [
		"1) Open the iOS app → Settings → Gateway",
		`2) ${stepTwo}`,
		"3) Back here, run /pair approve",
		"4) If this code leaks or you are done, run /pair cleanup"
	];
}
function buildSecurityNoticeLines(params) {
	const cleanupCommand = params.markdown ? "`/pair cleanup`" : "/pair cleanup";
	const securityPrefix = params.markdown ? "- " : "";
	const importantLine = params.markdown ? `**Important:** Run ${cleanupCommand} after pairing finishes.` : `IMPORTANT: After pairing finishes, run ${cleanupCommand}.`;
	return [
		`${securityPrefix}Security: single-use bootstrap token`,
		`${securityPrefix}Expires: ${formatDurationMinutes(params.expiresAtMs)}`,
		"",
		importantLine,
		`If this ${params.kind} leaks, run ${cleanupCommand} immediately.`
	];
}
function buildQrFollowUpLines(autoNotifyArmed) {
	return autoNotifyArmed ? [
		"After scanning, wait here for the pairing request ping.",
		"I’ll auto-ping here when the pairing request arrives, then auto-disable.",
		"If the ping does not arrive, run `/pair approve latest` manually."
	] : ["After scanning, run `/pair approve` to complete pairing."];
}
function formatSetupReply(payload, authLabel) {
	const setupCode = encodeSetupCode(payload);
	return [
		"Pairing setup code generated.",
		"",
		...buildPairingFlowLines("Paste the setup code below and tap Connect"),
		"",
		"Setup code:",
		setupCode,
		"",
		`Gateway: ${payload.url}`,
		`Auth: ${authLabel}`,
		...buildSecurityNoticeLines({
			kind: "setup code",
			expiresAtMs: payload.expiresAtMs
		})
	].join("\n");
}
function formatSetupInstructions(expiresAtMs) {
	return [
		"Pairing setup code generated.",
		"",
		...buildPairingFlowLines("Paste the setup code from my next message and tap Connect"),
		"",
		...buildSecurityNoticeLines({
			kind: "setup code",
			expiresAtMs
		})
	].join("\n");
}
function buildQrInfoLines(params) {
	return [
		`Gateway: ${params.payload.url}`,
		`Auth: ${params.authLabel}`,
		...buildSecurityNoticeLines({
			kind: "QR code",
			expiresAtMs: params.expiresAtMs
		}),
		"",
		...buildQrFollowUpLines(params.autoNotifyArmed),
		"",
		"If your camera still won’t lock on, run `/pair` for a pasteable setup code."
	];
}
function formatQrInfoMarkdown(params) {
	return [
		`- Gateway: ${params.payload.url}`,
		`- Auth: ${params.authLabel}`,
		...buildSecurityNoticeLines({
			kind: "QR code",
			expiresAtMs: params.expiresAtMs,
			markdown: true
		}),
		"",
		...buildQrFollowUpLines(params.autoNotifyArmed),
		"",
		"If your camera still won’t lock on, run `/pair` for a pasteable setup code."
	].join("\n");
}
function canSendQrPngToChannel(channel) {
	return channel in QR_CHANNEL_SENDERS;
}
function resolveQrReplyTarget(ctx) {
	if (ctx.channel === "discord") {
		const senderId = normalizeOptionalString(ctx.senderId) ?? "";
		if (senderId) return senderId.startsWith("user:") || senderId.startsWith("channel:") ? senderId : `user:${senderId}`;
	}
	return normalizeOptionalString(ctx.senderId) || normalizeOptionalString(ctx.from) || normalizeOptionalString(ctx.to) || "";
}
async function issueSetupPayload(url) {
	const { issueDeviceBootstrapToken, PAIRING_SETUP_BOOTSTRAP_PROFILE } = await loadDevicePairApiModule();
	const issuedBootstrap = await issueDeviceBootstrapToken({ profile: PAIRING_SETUP_BOOTSTRAP_PROFILE });
	return {
		url,
		bootstrapToken: issuedBootstrap.token,
		expiresAtMs: issuedBootstrap.expiresAtMs
	};
}
async function sendQrPngToSupportedChannel(params) {
	const mediaLocalRoots = [path.dirname(params.qrFilePath)];
	const accountId = normalizeOptionalString(params.ctx.accountId) || void 0;
	const sender = QR_CHANNEL_SENDERS[params.ctx.channel];
	if (!sender) return false;
	const send = (await params.api.runtime.channel.outbound.loadAdapter(params.ctx.channel))?.sendMedia;
	if (!send) return false;
	await send({
		cfg: params.api.config,
		to: params.target,
		text: params.caption,
		...sender.createOpts({
			ctx: params.ctx,
			qrFilePath: params.qrFilePath,
			mediaLocalRoots,
			accountId
		})
	});
	return true;
}
var device_pair_default = definePluginEntry({
	id: "device-pair",
	name: "Device Pair",
	description: "QR/bootstrap pairing helpers for OpenClaw devices",
	register(api) {
		let notifierService;
		api.registerService({
			id: "device-pair-notifier",
			start: async (ctx) => {
				const { createPairingNotifierService } = await loadNotifyModule();
				notifierService = createPairingNotifierService(api);
				await notifierService.start(ctx);
			},
			stop: async (ctx) => {
				await notifierService?.stop?.(ctx);
				notifierService = void 0;
			}
		});
		api.registerCommand({
			name: "pair",
			description: "Generate setup codes and approve device pairing requests.",
			acceptsArgs: true,
			requiredScopes: ["operator.pairing"],
			handler: async (ctx) => {
				const tokens = (normalizeOptionalString(ctx.args) ?? "").split(/\s+/).filter(Boolean);
				const action = normalizeLowercaseStringOrEmpty(tokens[0]);
				const gatewayClientScopes = Array.isArray(ctx.gatewayClientScopes) ? ctx.gatewayClientScopes : void 0;
				const { buildMissingPairingScopeReply, resolvePairingCommandAuthState } = await loadPairCommandAuthModule();
				const authState = resolvePairingCommandAuthState({
					channel: ctx.channel,
					gatewayClientScopes,
					senderIsOwner: ctx.senderIsOwner
				});
				api.logger.info?.(`device-pair: /pair invoked channel=${ctx.channel} sender=${ctx.senderId ?? "unknown"} action=${action || "new"}`);
				if (authState.isMissingPairingPrivilege) return buildMissingPairingScopeReply();
				if (action === "status" || action === "pending") {
					const [{ listDevicePairing }, { formatPendingRequests }] = await Promise.all([loadDevicePairApiModule(), loadNotifyModule()]);
					return { text: formatPendingRequests((await listDevicePairing()).pending) };
				}
				if (action === "notify") {
					const notifyAction = normalizeLowercaseStringOrEmpty(tokens[1]) || "status";
					const { handleNotifyCommand } = await loadNotifyModule();
					return await handleNotifyCommand({
						api,
						ctx,
						action: notifyAction
					});
				}
				if (action === "approve") {
					const [{ listDevicePairing }, { approvePendingPairingRequest, selectPendingApprovalRequest }] = await Promise.all([loadDevicePairApiModule(), loadPairCommandApproveModule()]);
					const selected = selectPendingApprovalRequest({
						pending: (await listDevicePairing()).pending,
						requested: normalizeOptionalString(tokens[1])
					});
					if (selected.reply) return selected.reply;
					const pending = selected.pending;
					if (!pending) return { text: "Pairing request not found." };
					return await approvePendingPairingRequest({
						requestId: pending.requestId,
						callerScopes: authState.approvalCallerScopes
					});
				}
				if (action === "cleanup" || action === "clear" || action === "revoke") {
					const { clearDeviceBootstrapTokens } = await loadDevicePairApiModule();
					const cleared = await clearDeviceBootstrapTokens();
					return { text: cleared.removed > 0 ? `Invalidated ${cleared.removed} unused setup code${cleared.removed === 1 ? "" : "s"}.` : "No unused setup codes were active." };
				}
				const authLabelResult = resolveAuthLabel(api.config);
				if (authLabelResult.error) return { text: `Error: ${authLabelResult.error}` };
				const urlResult = await resolveMobilePairingGatewayUrl(api);
				if (!urlResult.url) return { text: `Error: ${urlResult.error ?? "Gateway URL unavailable."}` };
				const authLabel = authLabelResult.label ?? "auth";
				if (action === "qr") {
					const channel = ctx.channel;
					const target = resolveQrReplyTarget(ctx);
					let autoNotifyArmed = false;
					if (channel === "telegram" && target) try {
						const { armPairNotifyOnce } = await loadNotifyModule();
						autoNotifyArmed = await armPairNotifyOnce({
							api,
							ctx
						});
					} catch (err) {
						api.logger.warn?.(`device-pair: failed to arm one-shot pairing notify (${err?.message ?? err})`);
					}
					let payload = await issueSetupPayload(urlResult.url);
					let setupCode = encodeSetupCode(payload);
					const infoLines = buildQrInfoLines({
						payload,
						authLabel,
						autoNotifyArmed,
						expiresAtMs: payload.expiresAtMs
					});
					if (target && canSendQrPngToChannel(channel)) {
						let qrFilePath;
						try {
							const { resolvePreferredOpenClawTmpDir, writeQrPngTempFile } = await loadDevicePairApiModule();
							qrFilePath = (await writeQrPngTempFile(setupCode, {
								tmpRoot: resolvePreferredOpenClawTmpDir(),
								dirPrefix: "device-pair-qr-",
								fileName: "pair-qr.png"
							})).filePath;
							if (await sendQrPngToSupportedChannel({
								api,
								ctx,
								target,
								caption: [
									"Scan this QR code with the OpenClaw iOS app:",
									"",
									...infoLines
								].join("\n"),
								qrFilePath
							})) return { text: `QR code sent above.\nExpires: ${formatDurationMinutes(payload.expiresAtMs)}\nIMPORTANT: Run /pair cleanup after pairing finishes.` };
						} catch (err) {
							const { revokeDeviceBootstrapToken } = await loadDevicePairApiModule();
							api.logger.warn?.(`device-pair: QR image send failed channel=${channel}, falling back (${err?.message ?? err})`);
							await revokeDeviceBootstrapToken({ token: payload.bootstrapToken }).catch(() => {});
							payload = await issueSetupPayload(urlResult.url);
							setupCode = encodeSetupCode(payload);
						} finally {
							if (qrFilePath) await rm(path.dirname(qrFilePath), {
								recursive: true,
								force: true
							}).catch(() => {});
						}
					}
					api.logger.info?.(`device-pair: QR fallback channel=${channel} target=${target}`);
					if (channel === "webchat") {
						let qrDataUrl;
						try {
							const { renderQrPngDataUrl } = await loadDevicePairApiModule();
							qrDataUrl = await renderQrPngDataUrl(setupCode);
						} catch (err) {
							const { revokeDeviceBootstrapToken } = await loadDevicePairApiModule();
							api.logger.warn?.(`device-pair: webchat QR render failed, falling back (${err?.message ?? err})`);
							await revokeDeviceBootstrapToken({ token: payload.bootstrapToken }).catch(() => {});
							payload = await issueSetupPayload(urlResult.url);
							return { text: "QR image delivery is not available on this channel right now, so I generated a pasteable setup code instead.\n\n" + formatSetupReply(payload, authLabel) };
						}
						return {
							text: [
								"Scan this QR code with the OpenClaw iOS app:",
								"",
								formatQrInfoMarkdown({
									payload,
									authLabel,
									autoNotifyArmed,
									expiresAtMs: payload.expiresAtMs
								})
							].join("\n"),
							mediaUrl: qrDataUrl,
							sensitiveMedia: true
						};
					}
					return { text: "QR image delivery is not available on this channel, so I generated a pasteable setup code instead.\n\n" + formatSetupReply(payload, authLabel) };
				}
				const channel = ctx.channel;
				const target = normalizeOptionalString(ctx.senderId) || normalizeOptionalString(ctx.from) || normalizeOptionalString(ctx.to) || "";
				const payload = await issueSetupPayload(urlResult.url);
				if (channel === "telegram" && target) try {
					const runtimeKeys = Object.keys(api.runtime ?? {});
					const channelKeys = Object.keys(api.runtime?.channel ?? {});
					api.logger.debug?.(`device-pair: runtime keys=${runtimeKeys.join(",") || "none"} channel keys=${channelKeys.join(",") || "none"}`);
					const send = (await api.runtime.channel.outbound.loadAdapter("telegram"))?.sendText;
					if (!send) throw new Error(`telegram runtime unavailable (runtime keys: ${runtimeKeys.join(",")}; channel keys: ${channelKeys.join(",")})`);
					await send({
						cfg: api.config,
						to: target,
						text: formatSetupInstructions(payload.expiresAtMs),
						...ctx.messageThreadId != null ? { threadId: ctx.messageThreadId } : {},
						...ctx.accountId ? { accountId: ctx.accountId } : {}
					});
					api.logger.info?.(`device-pair: telegram split send ok target=${target} account=${ctx.accountId ?? "none"} thread=${ctx.messageThreadId ?? "none"}`);
					return { text: encodeSetupCode(payload) };
				} catch (err) {
					api.logger.warn?.(`device-pair: telegram split send failed, falling back to single message (${err?.message ?? err})`);
				}
				return { text: formatSetupReply(payload, authLabel) };
			}
		});
	}
});
//#endregion
export { device_pair_default as default };
