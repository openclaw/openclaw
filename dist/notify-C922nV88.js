import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as replaceFileAtomic } from "./replace-file-C7_Inj8B.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./security-runtime-CcSekjBd.js";
import { l as listDevicePairing } from "./device-pairing-C3feAqgm.js";
import "./device-bootstrap-hK3imi9M.js";
import { promises } from "node:fs";
import path from "node:path";
//#region extensions/device-pair/notify.ts
const NOTIFY_STATE_FILE = "device-pair-notify.json";
const NOTIFY_POLL_INTERVAL_MS = 1e4;
const NOTIFY_MAX_SEEN_AGE_MS = 1440 * 60 * 1e3;
function formatStringList(values) {
	if (!Array.isArray(values) || values.length === 0) return "none";
	const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
	return normalized.length > 0 ? normalized.join(", ") : "none";
}
function formatRoleList(request) {
	const role = normalizeOptionalString(request.role);
	if (role) return role;
	return formatStringList(request.roles);
}
function formatScopeList(request) {
	return formatStringList(request.scopes);
}
function formatPendingRequests(pending) {
	if (pending.length === 0) return "No pending device pairing requests.";
	const lines = ["Pending device pairing requests:"];
	for (const req of pending) {
		const label = normalizeOptionalString(req.displayName) || req.deviceId;
		const platform = normalizeOptionalString(req.platform);
		const ip = normalizeOptionalString(req.remoteIp);
		const parts = [
			`- ${req.requestId}`,
			label ? `name=${label}` : null,
			platform ? `platform=${platform}` : null,
			`role=${formatRoleList(req)}`,
			`scopes=${formatScopeList(req)}`,
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
		const to = normalizeOptionalString(record.to) ?? "";
		if (!to) continue;
		const accountId = normalizeOptionalString(record.accountId) ?? void 0;
		const messageThreadId = typeof record.messageThreadId === "string" ? normalizeOptionalString(record.messageThreadId) || void 0 : typeof record.messageThreadId === "number" && Number.isFinite(record.messageThreadId) ? Math.trunc(record.messageThreadId) : void 0;
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
		const normalizedRequestId = normalizeOptionalString(requestId);
		if (!normalizedRequestId) continue;
		if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) continue;
		notifiedRequestIds[normalizedRequestId] = Math.trunc(ts);
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
	await replaceFileAtomic({
		filePath,
		content: `${JSON.stringify(state, null, 2)}\n`,
		tempPrefix: ".device-pair-notify"
	});
}
function notifySubscriberKey(subscriber) {
	return JSON.stringify([
		subscriber.to,
		subscriber.accountId ?? "",
		normalizeNotifyThreadKey(subscriber.messageThreadId)
	]);
}
function normalizeNotifyThreadKey(messageThreadId) {
	if (typeof messageThreadId === "number" && Number.isFinite(messageThreadId)) return String(Math.trunc(messageThreadId));
	if (typeof messageThreadId !== "string") return "";
	const normalized = normalizeOptionalString(messageThreadId);
	if (!normalized) return "";
	if (!/^-?\d+$/u.test(normalized)) return normalized;
	try {
		return BigInt(normalized).toString();
	} catch {
		return normalized;
	}
}
function resolveNotifyTarget(ctx) {
	const to = normalizeOptionalString(ctx.senderId) || normalizeOptionalString(ctx.from) || normalizeOptionalString(ctx.to) || "";
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
	const label = normalizeOptionalString(request.displayName) || request.deviceId;
	const platform = normalizeOptionalString(request.platform);
	const ip = normalizeOptionalString(request.remoteIp);
	const role = formatRoleList(request);
	const scopes = formatScopeList(request);
	return [
		"📲 New device pairing request",
		`ID: ${request.requestId}`,
		`Name: ${label}`,
		...platform ? [`Platform: ${platform}`] : [],
		`Role: ${role}`,
		`Scopes: ${scopes}`,
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
	const send = (await params.api.runtime.channel.outbound.loadAdapter("telegram"))?.sendText;
	if (!send) {
		params.api.logger.warn("device-pair: telegram outbound adapter unavailable for pairing notifications");
		return false;
	}
	try {
		await send({
			cfg: params.api.config,
			to: params.subscriber.to,
			text: params.text,
			...params.subscriber.accountId ? { accountId: params.subscriber.accountId } : {},
			...params.subscriber.messageThreadId != null ? { threadId: params.subscriber.messageThreadId } : {}
		});
		return true;
	} catch (err) {
		params.api.logger.warn(`device-pair: failed to send pairing notification to ${params.subscriber.to}: ${formatErrorMessage(err)}`);
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
function createPairingNotifierService(api) {
	let notifyInterval = null;
	return {
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
				api.logger.warn(`device-pair: initial notify poll failed: ${formatErrorMessage(err)}`);
			});
			notifyInterval = setInterval(() => {
				tick().catch((err) => {
					api.logger.warn(`device-pair: notify poll failed: ${formatErrorMessage(err)}`);
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
	};
}
function registerPairingNotifierService(api) {
	api.registerService(createPairingNotifierService(api));
}
//#endregion
export { registerPairingNotifierService as a, handleNotifyCommand as i, createPairingNotifierService as n, formatPendingRequests as r, armPairNotifyOnce as t };
