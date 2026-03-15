import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import { n as readJsonFile, r as writeJsonAtomic, t as createAsyncLock } from "../../json-files-Bf54H9wB.js";
import { n as resolveGatewayBindUrl, t as resolveTailnetHostWithRunner } from "../../tailscale-status-BDa0ufq3.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import { n as pruneExpiredPending, r as resolvePairingPaths, t as generatePairingToken } from "../../pairing-token-DKpN4qO0.js";
import { t as runPluginCommandWithTimeout } from "../../run-command-Psw08BkS.js";
import { n as listDevicePairing, t as approveDevicePairing } from "../../device-pairing-DYWF-CWB.js";
import { promises } from "node:fs";
import path from "node:path";
import os from "node:os";
import qrcode from "qrcode-terminal";
//#region src/infra/device-bootstrap.ts
const DEVICE_BOOTSTRAP_TOKEN_TTL_MS = 600 * 1e3;
const withLock = createAsyncLock();
function resolveBootstrapPath(baseDir) {
	return path.join(resolvePairingPaths(baseDir, "devices").dir, "bootstrap.json");
}
async function loadState(baseDir) {
	const rawState = await readJsonFile(resolveBootstrapPath(baseDir)) ?? {};
	const state = {};
	if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) return state;
	for (const [tokenKey, entry] of Object.entries(rawState)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry;
		const token = typeof record.token === "string" && record.token.trim().length > 0 ? record.token : tokenKey;
		const issuedAtMs = typeof record.issuedAtMs === "number" ? record.issuedAtMs : 0;
		state[tokenKey] = {
			...record,
			token,
			issuedAtMs,
			ts: typeof record.ts === "number" ? record.ts : issuedAtMs
		};
	}
	pruneExpiredPending(state, Date.now(), DEVICE_BOOTSTRAP_TOKEN_TTL_MS);
	return state;
}
async function persistState(state, baseDir) {
	await writeJsonAtomic(resolveBootstrapPath(baseDir), state);
}
async function issueDeviceBootstrapToken(params = {}) {
	return await withLock(async () => {
		const state = await loadState(params.baseDir);
		const token = generatePairingToken();
		const issuedAtMs = Date.now();
		state[token] = {
			token,
			ts: issuedAtMs,
			issuedAtMs
		};
		await persistState(state, params.baseDir);
		return {
			token,
			expiresAtMs: issuedAtMs + DEVICE_BOOTSTRAP_TOKEN_TTL_MS
		};
	});
}
//#endregion
//#region extensions/device-pair/notify.ts
const NOTIFY_STATE_FILE = "device-pair-notify.json";
const NOTIFY_POLL_INTERVAL_MS = 1e4;
const NOTIFY_MAX_SEEN_AGE_MS = 1440 * 60 * 1e3;
function formatPendingRequests(pending) {
	if (pending.length === 0) return "No pending device pairing requests.";
	const lines = ["Pending device pairing requests:"];
	for (const req of pending) {
		const label = req.displayName?.trim() || req.deviceId;
		const platform = req.platform?.trim();
		const ip = req.remoteIp?.trim();
		const parts = [
			`- ${req.requestId}`,
			label ? `name=${label}` : null,
			platform ? `platform=${platform}` : null,
			ip ? `ip=${ip}` : null
		].filter(Boolean);
		lines.push(parts.join(" · "));
	}
	return lines.join("\n");
}
function resolveNotifyStatePath(stateDir) {
	return path.join(stateDir, NOTIFY_STATE_FILE);
}
function normalizeNotifyState(raw) {
	const root = typeof raw === "object" && raw !== null ? raw : {};
	const subscribersRaw = Array.isArray(root.subscribers) ? root.subscribers : [];
	const notifiedRaw = typeof root.notifiedRequestIds === "object" && root.notifiedRequestIds !== null ? root.notifiedRequestIds : {};
	const subscribers = [];
	for (const item of subscribersRaw) {
		if (typeof item !== "object" || item === null) continue;
		const record = item;
		const to = typeof record.to === "string" ? record.to.trim() : "";
		if (!to) continue;
		const accountId = typeof record.accountId === "string" && record.accountId.trim() ? record.accountId.trim() : void 0;
		const messageThreadId = typeof record.messageThreadId === "number" && Number.isFinite(record.messageThreadId) ? Math.trunc(record.messageThreadId) : void 0;
		const mode = record.mode === "once" ? "once" : "persistent";
		const addedAtMs = typeof record.addedAtMs === "number" && Number.isFinite(record.addedAtMs) ? Math.trunc(record.addedAtMs) : Date.now();
		subscribers.push({
			to,
			accountId,
			messageThreadId,
			mode,
			addedAtMs
		});
	}
	const notifiedRequestIds = {};
	for (const [requestId, ts] of Object.entries(notifiedRaw)) {
		if (!requestId.trim()) continue;
		if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) continue;
		notifiedRequestIds[requestId] = Math.trunc(ts);
	}
	return {
		subscribers,
		notifiedRequestIds
	};
}
async function readNotifyState(filePath) {
	try {
		const content = await promises.readFile(filePath, "utf8");
		return normalizeNotifyState(JSON.parse(content));
	} catch {
		return {
			subscribers: [],
			notifiedRequestIds: {}
		};
	}
}
async function writeNotifyState(filePath, state) {
	await promises.mkdir(path.dirname(filePath), { recursive: true });
	const content = JSON.stringify(state, null, 2);
	await promises.writeFile(filePath, `${content}\n`, "utf8");
}
function notifySubscriberKey(subscriber) {
	return [
		subscriber.to,
		subscriber.accountId ?? "",
		subscriber.messageThreadId ?? ""
	].join("|");
}
function resolveNotifyTarget(ctx) {
	const to = ctx.senderId?.trim() || ctx.from?.trim() || ctx.to?.trim() || "";
	if (!to) return null;
	return {
		to,
		...ctx.accountId ? { accountId: ctx.accountId } : {},
		...ctx.messageThreadId != null ? { messageThreadId: ctx.messageThreadId } : {}
	};
}
function upsertNotifySubscriber(subscribers, target, mode) {
	const key = notifySubscriberKey(target);
	const index = subscribers.findIndex((entry) => notifySubscriberKey(entry) === key);
	const next = {
		...target,
		mode,
		addedAtMs: Date.now()
	};
	if (index === -1) {
		subscribers.push(next);
		return true;
	}
	if (subscribers[index]?.mode === mode) return false;
	subscribers[index] = next;
	return true;
}
function buildPairingRequestNotificationText(request) {
	const label = request.displayName?.trim() || request.deviceId;
	const platform = request.platform?.trim();
	const ip = request.remoteIp?.trim();
	return [
		"📲 New device pairing request",
		`ID: ${request.requestId}`,
		`Name: ${label}`,
		...platform ? [`Platform: ${platform}`] : [],
		...ip ? [`IP: ${ip}`] : [],
		"",
		`Approve: /pair approve ${request.requestId}`,
		"List pending: /pair pending"
	].join("\n");
}
function requestTimestampMs(request) {
	if (typeof request.ts !== "number" || !Number.isFinite(request.ts)) return null;
	const ts = Math.trunc(request.ts);
	return ts > 0 ? ts : null;
}
function shouldNotifySubscriberForRequest(subscriber, request) {
	if (subscriber.mode !== "once") return true;
	const ts = requestTimestampMs(request);
	if (ts == null) return false;
	return ts >= subscriber.addedAtMs;
}
async function notifySubscriber(params) {
	const send = params.api.runtime?.channel?.telegram?.sendMessageTelegram;
	if (!send) {
		params.api.logger.warn("device-pair: telegram runtime unavailable for pairing notifications");
		return false;
	}
	try {
		await send(params.subscriber.to, params.text, {
			...params.subscriber.accountId ? { accountId: params.subscriber.accountId } : {},
			...params.subscriber.messageThreadId != null ? { messageThreadId: params.subscriber.messageThreadId } : {}
		});
		return true;
	} catch (err) {
		params.api.logger.warn(`device-pair: failed to send pairing notification to ${params.subscriber.to}: ${String(err?.message ?? err)}`);
		return false;
	}
}
async function notifyPendingPairingRequests(params) {
	const state = await readNotifyState(params.statePath);
	const pending = (await listDevicePairing()).pending;
	const now = Date.now();
	const pendingIds = new Set(pending.map((entry) => entry.requestId));
	let changed = false;
	for (const [requestId, ts] of Object.entries(state.notifiedRequestIds)) if (!pendingIds.has(requestId) || now - ts > NOTIFY_MAX_SEEN_AGE_MS) {
		delete state.notifiedRequestIds[requestId];
		changed = true;
	}
	if (state.subscribers.length > 0) {
		const oneShotDelivered = /* @__PURE__ */ new Set();
		for (const request of pending) {
			if (state.notifiedRequestIds[request.requestId]) continue;
			const text = buildPairingRequestNotificationText(request);
			let delivered = false;
			for (const subscriber of state.subscribers) {
				if (!shouldNotifySubscriberForRequest(subscriber, request)) continue;
				const sent = await notifySubscriber({
					api: params.api,
					subscriber,
					text
				});
				delivered = delivered || sent;
				if (sent && subscriber.mode === "once") oneShotDelivered.add(notifySubscriberKey(subscriber));
			}
			if (delivered) {
				state.notifiedRequestIds[request.requestId] = now;
				changed = true;
			}
		}
		if (oneShotDelivered.size > 0) {
			const initialCount = state.subscribers.length;
			state.subscribers = state.subscribers.filter((subscriber) => !oneShotDelivered.has(notifySubscriberKey(subscriber)));
			if (state.subscribers.length !== initialCount) changed = true;
		}
	}
	if (changed) await writeNotifyState(params.statePath, state);
}
async function armPairNotifyOnce(params) {
	if (params.ctx.channel !== "telegram") return false;
	const target = resolveNotifyTarget(params.ctx);
	if (!target) return false;
	const statePath = resolveNotifyStatePath(params.api.runtime.state.resolveStateDir());
	const state = await readNotifyState(statePath);
	let changed = false;
	if (upsertNotifySubscriber(state.subscribers, target, "once")) changed = true;
	if (changed) await writeNotifyState(statePath, state);
	return true;
}
async function handleNotifyCommand(params) {
	if (params.ctx.channel !== "telegram") return { text: "Pairing notifications are currently supported only on Telegram." };
	const target = resolveNotifyTarget(params.ctx);
	if (!target) return { text: "Could not resolve Telegram target for this chat." };
	const statePath = resolveNotifyStatePath(params.api.runtime.state.resolveStateDir());
	const state = await readNotifyState(statePath);
	const targetKey = notifySubscriberKey(target);
	const current = state.subscribers.find((entry) => notifySubscriberKey(entry) === targetKey);
	if (params.action === "on" || params.action === "enable") {
		if (upsertNotifySubscriber(state.subscribers, target, "persistent")) await writeNotifyState(statePath, state);
		return { text: "✅ Pair request notifications enabled for this Telegram chat.\nI will ping here when a new device pairing request arrives." };
	}
	if (params.action === "off" || params.action === "disable") {
		const currentIndex = state.subscribers.findIndex((entry) => notifySubscriberKey(entry) === targetKey);
		if (currentIndex !== -1) {
			state.subscribers.splice(currentIndex, 1);
			await writeNotifyState(statePath, state);
		}
		return { text: "✅ Pair request notifications disabled for this Telegram chat." };
	}
	if (params.action === "once" || params.action === "arm") {
		await armPairNotifyOnce({
			api: params.api,
			ctx: params.ctx
		});
		return { text: "✅ One-shot pairing notification armed for this Telegram chat.\nI will notify on the next new pairing request, then auto-disable." };
	}
	if (params.action === "status" || params.action === "") {
		const pending = await listDevicePairing();
		const enabled = Boolean(current);
		const mode = current?.mode ?? "off";
		return { text: [
			`Pair request notifications: ${enabled ? "enabled" : "disabled"} for this chat.`,
			`Mode: ${mode}`,
			`Subscribers: ${state.subscribers.length}`,
			`Pending requests: ${pending.pending.length}`,
			"",
			"Use /pair notify on|off|once"
		].join("\n") };
	}
	return { text: "Usage: /pair notify on|off|once|status" };
}
function registerPairingNotifierService(api) {
	let notifyInterval = null;
	api.registerService({
		id: "device-pair-notifier",
		start: async (ctx) => {
			const statePath = resolveNotifyStatePath(ctx.stateDir);
			const tick = async () => {
				await notifyPendingPairingRequests({
					api,
					statePath
				});
			};
			await tick().catch((err) => {
				api.logger.warn(`device-pair: initial notify poll failed: ${String(err?.message ?? err)}`);
			});
			notifyInterval = setInterval(() => {
				tick().catch((err) => {
					api.logger.warn(`device-pair: notify poll failed: ${String(err?.message ?? err)}`);
				});
			}, NOTIFY_POLL_INTERVAL_MS);
			notifyInterval.unref?.();
		},
		stop: async () => {
			if (notifyInterval) {
				clearInterval(notifyInterval);
				notifyInterval = null;
			}
		}
	});
}
//#endregion
//#region extensions/device-pair/index.ts
function renderQrAscii(data) {
	return new Promise((resolve) => {
		qrcode.generate(data, { small: true }, (output) => {
			resolve(output);
		});
	});
}
const DEFAULT_GATEWAY_PORT = 18789;
function normalizeUrl(raw, schemeFallback) {
	const candidate = raw.trim();
	if (!candidate) return null;
	const parsedUrl = parseNormalizedGatewayUrl(candidate);
	if (parsedUrl) return parsedUrl;
	const hostPort = candidate.split("/", 1)[0]?.trim() ?? "";
	return hostPort ? `${schemeFallback}://${hostPort}` : null;
}
function parseNormalizedGatewayUrl(raw) {
	try {
		const parsed = new URL(raw);
		const scheme = parsed.protocol.slice(0, -1);
		const normalizedScheme = scheme === "http" ? "ws" : scheme === "https" ? "wss" : scheme;
		if (!(normalizedScheme === "ws" || normalizedScheme === "wss")) return null;
		if (!parsed.hostname) return null;
		return `${normalizedScheme}://${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
	} catch {
		return null;
	}
}
function parsePositiveInteger(raw) {
	if (!raw) return null;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function resolveGatewayPort(cfg) {
	const envPort = parsePositiveInteger(process.env.OPENCLAW_GATEWAY_PORT?.trim()) ?? parsePositiveInteger(process.env.CLAWDBOT_GATEWAY_PORT?.trim());
	if (envPort) return envPort;
	const configPort = cfg.gateway?.port;
	if (typeof configPort === "number" && Number.isFinite(configPort) && configPort > 0) return configPort;
	return DEFAULT_GATEWAY_PORT;
}
function resolveScheme(cfg, opts) {
	if (opts?.forceSecure) return "wss";
	return cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
}
function parseIPv4Octets(address) {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
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
function isTailnetIPv4(address) {
	const octets = parseIPv4Octets(address);
	if (!octets) return false;
	const [a, b] = octets;
	return a === 100 && b >= 64 && b <= 127;
}
function pickMatchingIPv4(predicate) {
	const nets = os.networkInterfaces();
	for (const entries of Object.values(nets)) {
		if (!entries) continue;
		for (const entry of entries) {
			const family = entry?.family;
			const isIpv4 = family === "IPv4" || String(family) === "4";
			if (!entry || entry.internal || !isIpv4) continue;
			const address = entry.address?.trim() ?? "";
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
	return await resolveTailnetHostWithRunner((argv, opts) => runPluginCommandWithTimeout({
		argv,
		timeoutMs: opts.timeoutMs
	}));
}
function resolveAuthLabel(cfg) {
	const mode = cfg.gateway?.auth?.mode;
	const token = pickFirstDefined([
		process.env.OPENCLAW_GATEWAY_TOKEN,
		process.env.CLAWDBOT_GATEWAY_TOKEN,
		cfg.gateway?.auth?.token
	]) ?? void 0;
	const password = pickFirstDefined([
		process.env.OPENCLAW_GATEWAY_PASSWORD,
		process.env.CLAWDBOT_GATEWAY_PASSWORD,
		cfg.gateway?.auth?.password
	]) ?? void 0;
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
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed) return trimmed;
	}
	return null;
}
function resolveRequiredAuthLabel(mode, values) {
	if (mode === "token") return values.token ? { label: "token" } : { error: "Gateway auth is set to token, but no token is configured." };
	return values.password ? { label: "password" } : { error: "Gateway auth is set to password, but no password is configured." };
}
async function resolveGatewayUrl(api) {
	const cfg = api.config;
	const pluginCfg = api.pluginConfig ?? {};
	const scheme = resolveScheme(cfg);
	const port = resolveGatewayPort(cfg);
	if (typeof pluginCfg.publicUrl === "string" && pluginCfg.publicUrl.trim()) {
		const url = normalizeUrl(pluginCfg.publicUrl, scheme);
		if (url) return {
			url,
			source: "plugins.entries.device-pair.config.publicUrl"
		};
		return { error: "Configured publicUrl is invalid." };
	}
	const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
	if (tailscaleMode === "serve" || tailscaleMode === "funnel") {
		const host = await resolveTailnetHost();
		if (!host) return { error: "Tailscale Serve is enabled, but MagicDNS could not be resolved." };
		return {
			url: `wss://${host}`,
			source: `gateway.tailscale.mode=${tailscaleMode}`
		};
	}
	const remoteUrl = cfg.gateway?.remote?.url;
	if (typeof remoteUrl === "string" && remoteUrl.trim()) {
		const url = normalizeUrl(remoteUrl, scheme);
		if (url) return {
			url,
			source: "gateway.remote.url"
		};
	}
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
function encodeSetupCode(payload) {
	const json = JSON.stringify(payload);
	return Buffer.from(json, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function formatSetupReply(payload, authLabel) {
	return [
		"Pairing setup code generated.",
		"",
		"1) Open the iOS app → Settings → Gateway",
		"2) Paste the setup code below and tap Connect",
		"3) Back here, run /pair approve",
		"",
		"Setup code:",
		encodeSetupCode(payload),
		"",
		`Gateway: ${payload.url}`,
		`Auth: ${authLabel}`
	].join("\n");
}
function formatSetupInstructions() {
	return [
		"Pairing setup code generated.",
		"",
		"1) Open the iOS app → Settings → Gateway",
		"2) Paste the setup code from my next message and tap Connect",
		"3) Back here, run /pair approve"
	].join("\n");
}
function register(api) {
	registerPairingNotifierService(api);
	api.registerCommand({
		name: "pair",
		description: "Generate setup codes and approve device pairing requests.",
		acceptsArgs: true,
		handler: async (ctx) => {
			const tokens = (ctx.args?.trim() ?? "").split(/\s+/).filter(Boolean);
			const action = tokens[0]?.toLowerCase() ?? "";
			api.logger.info?.(`device-pair: /pair invoked channel=${ctx.channel} sender=${ctx.senderId ?? "unknown"} action=${action || "new"}`);
			if (action === "status" || action === "pending") return { text: formatPendingRequests((await listDevicePairing()).pending) };
			if (action === "notify") return await handleNotifyCommand({
				api,
				ctx,
				action: tokens[1]?.trim().toLowerCase() ?? "status"
			});
			if (action === "approve") {
				const requested = tokens[1]?.trim();
				const list = await listDevicePairing();
				if (list.pending.length === 0) return { text: "No pending device pairing requests." };
				let pending;
				if (requested) if (requested.toLowerCase() === "latest") pending = [...list.pending].toSorted((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0];
				else pending = list.pending.find((entry) => entry.requestId === requested);
				else if (list.pending.length === 1) pending = list.pending[0];
				else return { text: `${formatPendingRequests(list.pending)}\n\nMultiple pending requests found. Approve one explicitly:
/pair approve <requestId>
Or approve the most recent:
/pair approve latest` };
				if (!pending) return { text: "Pairing request not found." };
				const approved = await approveDevicePairing(pending.requestId);
				if (!approved) return { text: "Pairing request not found." };
				const label = approved.device.displayName?.trim() || approved.device.deviceId;
				const platform = approved.device.platform?.trim();
				return { text: `✅ Paired ${label}${platform ? ` (${platform})` : ""}.` };
			}
			const authLabelResult = resolveAuthLabel(api.config);
			if (authLabelResult.error) return { text: `Error: ${authLabelResult.error}` };
			const urlResult = await resolveGatewayUrl(api);
			if (!urlResult.url) return { text: `Error: ${urlResult.error ?? "Gateway URL unavailable."}` };
			const payload = {
				url: urlResult.url,
				bootstrapToken: (await issueDeviceBootstrapToken()).token
			};
			if (action === "qr") {
				const qrAscii = await renderQrAscii(encodeSetupCode(payload));
				const authLabel = authLabelResult.label ?? "auth";
				const channel = ctx.channel;
				const target = ctx.senderId?.trim() || ctx.from?.trim() || ctx.to?.trim() || "";
				let autoNotifyArmed = false;
				if (channel === "telegram" && target) try {
					autoNotifyArmed = await armPairNotifyOnce({
						api,
						ctx
					});
				} catch (err) {
					api.logger.warn?.(`device-pair: failed to arm one-shot pairing notify (${String(err?.message ?? err)})`);
				}
				if (channel === "telegram" && target) try {
					const send = api.runtime?.channel?.telegram?.sendMessageTelegram;
					if (send) {
						await send(target, [
							"Scan this QR code with the OpenClaw iOS app:",
							"",
							"```",
							qrAscii,
							"```"
						].join("\n"), {
							...ctx.messageThreadId != null ? { messageThreadId: ctx.messageThreadId } : {},
							...ctx.accountId ? { accountId: ctx.accountId } : {}
						});
						return { text: [
							`Gateway: ${payload.url}`,
							`Auth: ${authLabel}`,
							"",
							autoNotifyArmed ? "After scanning, wait here for the pairing request ping." : "After scanning, come back here and run `/pair approve` to complete pairing.",
							...autoNotifyArmed ? ["I’ll auto-ping here when the pairing request arrives, then auto-disable.", "If the ping does not arrive, run `/pair approve latest` manually."] : []
						].join("\n") };
					}
				} catch (err) {
					api.logger.warn?.(`device-pair: telegram QR send failed, falling back (${String(err?.message ?? err)})`);
				}
				api.logger.info?.(`device-pair: QR fallback channel=${channel} target=${target}`);
				return { text: [
					"Scan this QR code with the OpenClaw iOS app:",
					"",
					"```",
					qrAscii,
					"```",
					"",
					...[
						`Gateway: ${payload.url}`,
						`Auth: ${authLabel}`,
						"",
						autoNotifyArmed ? "After scanning, wait here for the pairing request ping." : "After scanning, run `/pair approve` to complete pairing.",
						...autoNotifyArmed ? ["I’ll auto-ping here when the pairing request arrives, then auto-disable.", "If the ping does not arrive, run `/pair approve latest` manually."] : []
					]
				].join("\n") };
			}
			const channel = ctx.channel;
			const target = ctx.senderId?.trim() || ctx.from?.trim() || ctx.to?.trim() || "";
			const authLabel = authLabelResult.label ?? "auth";
			if (channel === "telegram" && target) try {
				const runtimeKeys = Object.keys(api.runtime ?? {});
				const channelKeys = Object.keys(api.runtime?.channel ?? {});
				api.logger.debug?.(`device-pair: runtime keys=${runtimeKeys.join(",") || "none"} channel keys=${channelKeys.join(",") || "none"}`);
				const send = api.runtime?.channel?.telegram?.sendMessageTelegram;
				if (!send) throw new Error(`telegram runtime unavailable (runtime keys: ${runtimeKeys.join(",")}; channel keys: ${channelKeys.join(",")})`);
				await send(target, formatSetupInstructions(), {
					...ctx.messageThreadId != null ? { messageThreadId: ctx.messageThreadId } : {},
					...ctx.accountId ? { accountId: ctx.accountId } : {}
				});
				api.logger.info?.(`device-pair: telegram split send ok target=${target} account=${ctx.accountId ?? "none"} thread=${ctx.messageThreadId ?? "none"}`);
				return { text: encodeSetupCode(payload) };
			} catch (err) {
				api.logger.warn?.(`device-pair: telegram split send failed, falling back to single message (${String(err?.message ?? err)})`);
			}
			return { text: formatSetupReply(payload, authLabel) };
		}
	});
}
//#endregion
export { register as default };
