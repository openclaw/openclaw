import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { t as safeEqualSecret } from "./secret-equal-DzYE9Rgi.js";
import { g as resolveRequestClientIp } from "./net-xqHkLqZe.js";
import "./error-runtime-B9i9dR6-.js";
import { a as createFixedWindowRateLimiter, r as WEBHOOK_RATE_LIMIT_DEFAULTS } from "./webhook-ingress-ClPA1a_D.js";
import { a as createWebhookInFlightLimiter, c as readWebhookBodyOrReject } from "./webhook-request-guards-CfdZlct7.js";
import { t as normalizeWebhookPath } from "./webhook-path-Dzr2IdLy.js";
import { l as withResolvedWebhookRequestPipeline, n as registerWebhookTargetWithPluginRoute, s as resolveWebhookTargetWithAuthOrRejectSync } from "./webhook-targets-ByhBLZIm.js";
import "./security-runtime-UeJYXWvz.js";
import "./string-coerce-runtime-DLMQKy7t.js";
import { F as resolveBlueBubblesEffectiveAllowPrivateNetwork, _ as normalizeWebhookReaction, g as normalizeWebhookMessage, o as probeBlueBubbles, t as fetchBlueBubblesServerInfo, u as asRecord } from "./probe-C1O9FePH.js";
import { t as getBlueBubblesRuntime } from "./runtime-B5pBKPDD.js";
import { n as resolveWebhookPathFromConfig } from "./webhook-shared-DGCTJyOi.js";
import { a as resolveBlueBubblesMessageId, b as sendMessageBlueBubbles } from "./reactions-vM5hyhlE.js";
import { i as sendBlueBubblesMedia, n as processMessage, r as processReaction, t as logVerbose } from "./monitor-processing-CMEU-kEY.js";
//#region extensions/bluebubbles/src/monitor-debounce.ts
function normalizeDebounceMessageText(text) {
	return typeof text === "string" ? text : "";
}
function sanitizeDebounceEntry(entry) {
	if (typeof entry.message.text === "string") return entry;
	return {
		...entry,
		message: {
			...entry.message,
			text: ""
		}
	};
}
/**
* Default debounce window for inbound message coalescing (ms).
* This helps combine URL text + link preview balloon messages that BlueBubbles
* sends as separate webhook events when no explicit inbound debounce config exists.
*/
const DEFAULT_INBOUND_DEBOUNCE_MS = 500;
/**
* Default debounce window when `coalesceSameSenderDms` is enabled.
*
* The legacy 500 ms default is tuned for BlueBubbles's own text+balloon
* pairing, which is typically linked by `associatedMessageGuid` and arrives
* within ~100-300 ms. The new split-send case this flag targets has a wider
* cadence — live traces show Apple delivers `Dump` and its pasted-URL
* balloon ~0.8-2.0 s apart — so 500 ms would flush the text alone before the
* balloon webhook ever reaches the debouncer. 2500 ms comfortably covers the
* observed range while keeping agent-reply latency acceptable for DMs. Users
* who want tighter turnaround can still set `messages.inbound.byChannel.bluebubbles`
* explicitly.
*/
const DEFAULT_COALESCE_INBOUND_DEBOUNCE_MS = 2500;
/**
* Bounds on the combined output when multiple inbound events are merged into
* one agent turn. Guards against amplification from a sender who rapid-fires
* many small DMs inside the debounce window (concern raised on #69258): the
* merged text, attachment list, and source-message count are each capped so
* a flood cannot balloon a single agent prompt beyond a safe ceiling.
* Callers still see every messageId via inbound-dedupe.
*/
const MAX_COALESCED_TEXT_CHARS = 4e3;
const MAX_COALESCED_ATTACHMENTS = 20;
const MAX_COALESCED_ENTRIES = 10;
/**
* Combines multiple debounced messages into a single message for processing.
* Used when multiple webhook events arrive within the debounce window.
*/
function combineDebounceEntries(entries) {
	if (entries.length === 0) throw new Error("Cannot combine empty entries");
	if (entries.length === 1) return entries[0].message;
	const first = entries[0].message;
	const boundedEntries = entries.length > MAX_COALESCED_ENTRIES ? [...entries.slice(0, MAX_COALESCED_ENTRIES - 1), entries[entries.length - 1]] : entries;
	const seenTexts = /* @__PURE__ */ new Set();
	const textParts = [];
	for (const entry of boundedEntries) {
		const text = normalizeDebounceMessageText(entry.message.text).trim();
		if (!text) continue;
		const normalizedText = normalizeLowercaseStringOrEmpty(text);
		if (seenTexts.has(normalizedText)) continue;
		seenTexts.add(normalizedText);
		textParts.push(text);
	}
	let combinedText = textParts.join(" ");
	if (combinedText.length > MAX_COALESCED_TEXT_CHARS) combinedText = `${combinedText.slice(0, MAX_COALESCED_TEXT_CHARS)}…[truncated]`;
	const allAttachments = boundedEntries.flatMap((e) => e.message.attachments ?? []).slice(0, MAX_COALESCED_ATTACHMENTS);
	const timestamps = entries.map((e) => e.message.timestamp).filter((t) => typeof t === "number");
	const latestTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : first.timestamp;
	const messageId = entries.map((e) => e.message.messageId).find((id) => Boolean(id));
	const seenIds = /* @__PURE__ */ new Set();
	const coalescedMessageIds = [];
	for (const entry of entries) {
		const id = entry.message.messageId?.trim();
		if (!id || seenIds.has(id)) continue;
		seenIds.add(id);
		coalescedMessageIds.push(id);
	}
	const entryWithReply = entries.find((e) => e.message.replyToId);
	return {
		...first,
		text: combinedText,
		attachments: allAttachments.length > 0 ? allAttachments : first.attachments,
		timestamp: latestTimestamp,
		messageId: messageId ?? first.messageId,
		coalescedMessageIds: coalescedMessageIds.length > 0 ? coalescedMessageIds : void 0,
		replyToId: entryWithReply?.message.replyToId ?? first.replyToId,
		replyToBody: entryWithReply?.message.replyToBody ?? first.replyToBody,
		replyToSender: entryWithReply?.message.replyToSender ?? first.replyToSender,
		balloonBundleId: void 0
	};
}
function resolveBlueBubblesDebounceMs(config, core, accountConfig) {
	const inbound = config.messages?.inbound;
	if (!(typeof inbound?.debounceMs === "number" || typeof inbound?.byChannel?.bluebubbles === "number")) return accountConfig.coalesceSameSenderDms ? DEFAULT_COALESCE_INBOUND_DEBOUNCE_MS : DEFAULT_INBOUND_DEBOUNCE_MS;
	return core.channel.debounce.resolveInboundDebounceMs({
		cfg: config,
		channel: "bluebubbles"
	});
}
function createBlueBubblesDebounceRegistry(params) {
	const targetDebouncers = /* @__PURE__ */ new Map();
	return {
		getOrCreateDebouncer: (target) => {
			const existing = targetDebouncers.get(target);
			if (existing) return existing;
			const { account, config, runtime, core } = target;
			const baseDebouncer = core.channel.debounce.createInboundDebouncer({
				debounceMs: resolveBlueBubblesDebounceMs(config, core, account.config),
				buildKey: (entry) => {
					const msg = entry.message;
					const balloonBundleId = msg.balloonBundleId?.trim();
					const associatedMessageGuid = msg.associatedMessageGuid?.trim();
					if (balloonBundleId && associatedMessageGuid) return `bluebubbles:${account.accountId}:msg:${associatedMessageGuid}`;
					const chatKey = msg.chatGuid?.trim() ?? msg.chatIdentifier?.trim() ?? (msg.chatId ? String(msg.chatId) : "dm");
					if (account.config.coalesceSameSenderDms && !msg.isGroup && !associatedMessageGuid) return `bluebubbles:${account.accountId}:dm:${chatKey}:${msg.senderId}`;
					const messageId = msg.messageId?.trim();
					if (messageId) return `bluebubbles:${account.accountId}:msg:${messageId}`;
					return `bluebubbles:${account.accountId}:${chatKey}:${msg.senderId}`;
				},
				shouldDebounce: (entry) => {
					const msg = entry.message;
					if (msg.fromMe) return false;
					if (core.channel.text.hasControlCommand(msg.text, config)) {
						const associatedMessageGuid = msg.associatedMessageGuid?.trim();
						if (account.config.coalesceSameSenderDms && !msg.isGroup && !associatedMessageGuid) return true;
						return false;
					}
					return true;
				},
				onFlush: async (entries) => {
					if (entries.length === 0) return;
					const flushTarget = entries[0].target;
					if (entries.length === 1) {
						await params.processMessage(entries[0].message, flushTarget);
						return;
					}
					const combined = combineDebounceEntries(entries);
					if (core.logging.shouldLogVerbose()) {
						const count = entries.length;
						const preview = combined.text.slice(0, 50);
						runtime.log?.(`[bluebubbles] coalesced ${count} messages: "${preview}${combined.text.length > 50 ? "..." : ""}"`);
					}
					await params.processMessage(combined, flushTarget);
				},
				onError: (err) => {
					runtime.error?.(`[${account.accountId}] [bluebubbles] debounce flush failed: ${String(err)}`);
				}
			});
			const debouncer = {
				enqueue: async (item) => {
					await baseDebouncer.enqueue(sanitizeDebounceEntry(item));
				},
				flushKey: (key) => baseDebouncer.flushKey(key)
			};
			targetDebouncers.set(target, debouncer);
			return debouncer;
		},
		removeDebouncer: (target) => {
			targetDebouncers.delete(target);
		}
	};
}
//#endregion
//#region extensions/bluebubbles/src/monitor.ts
const webhookTargets = /* @__PURE__ */ new Map();
const webhookRateLimiter = createFixedWindowRateLimiter({
	windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
	maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
	maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys
});
const webhookInFlightLimiter = createWebhookInFlightLimiter();
const debounceRegistry = createBlueBubblesDebounceRegistry({ processMessage });
function registerBlueBubblesWebhookTarget(target) {
	const registered = registerWebhookTargetWithPluginRoute({
		targetsByPath: webhookTargets,
		target,
		route: {
			auth: "plugin",
			match: "exact",
			pluginId: "bluebubbles",
			source: "bluebubbles-webhook",
			accountId: target.account.accountId,
			log: target.runtime.log,
			handler: async (req, res) => {
				if (!await handleBlueBubblesWebhookRequest(req, res) && !res.headersSent) {
					res.statusCode = 404;
					res.setHeader("Content-Type", "text/plain; charset=utf-8");
					res.end("Not Found");
				}
			}
		}
	});
	return () => {
		registered.unregister();
		debounceRegistry.removeDebouncer(registered.target);
	};
}
function parseBlueBubblesWebhookPayload(rawBody) {
	const trimmed = rawBody.trim();
	if (!trimmed) return {
		ok: false,
		error: "empty payload"
	};
	try {
		return {
			ok: true,
			value: JSON.parse(trimmed)
		};
	} catch {
		const params = new URLSearchParams(rawBody);
		const payload = params.get("payload") ?? params.get("data") ?? params.get("message");
		if (!payload) return {
			ok: false,
			error: "invalid json"
		};
		try {
			return {
				ok: true,
				value: JSON.parse(payload)
			};
		} catch (error) {
			return {
				ok: false,
				error: formatErrorMessage(error)
			};
		}
	}
}
function maskSecret(value) {
	if (value.length <= 6) return "***";
	return `${value.slice(0, 2)}***${value.slice(-2)}`;
}
function normalizeAuthToken(raw) {
	const value = raw.trim();
	if (!value) return "";
	if (normalizeLowercaseStringOrEmpty(value).startsWith("bearer ")) return value.slice(7).trim();
	return value;
}
function safeEqualAuthToken(aRaw, bRaw) {
	const a = normalizeAuthToken(aRaw);
	const b = normalizeAuthToken(bRaw);
	if (!a || !b) return false;
	return safeEqualSecret(a, b);
}
function collectTrustedProxies(targets) {
	const proxies = /* @__PURE__ */ new Set();
	for (const target of targets) for (const proxy of target.config.gateway?.trustedProxies ?? []) {
		const normalized = proxy.trim();
		if (normalized) proxies.add(normalized);
	}
	return [...proxies];
}
function resolveWebhookAllowRealIpFallback(targets) {
	return targets.some((target) => target.config.gateway?.allowRealIpFallback === true);
}
function resolveWebhookClientIp(req, trustedProxies, allowRealIpFallback) {
	if (!req.headers["x-forwarded-for"] && !(allowRealIpFallback && req.headers["x-real-ip"])) return req.socket.remoteAddress ?? "unknown";
	return resolveRequestClientIp(req, [...trustedProxies], allowRealIpFallback) ?? req.socket.remoteAddress ?? "unknown";
}
async function handleBlueBubblesWebhookRequest(req, res) {
	const requestUrl = new URL(req.url ?? "/", "http://localhost");
	const normalizedPath = normalizeWebhookPath(requestUrl.pathname);
	const pathTargets = webhookTargets.get(normalizedPath) ?? [];
	const clientIp = resolveWebhookClientIp(req, collectTrustedProxies(pathTargets), resolveWebhookAllowRealIpFallback(pathTargets));
	return await withResolvedWebhookRequestPipeline({
		req,
		res,
		targetsByPath: webhookTargets,
		allowMethods: ["POST"],
		rateLimiter: webhookRateLimiter,
		rateLimitKey: `${normalizedPath}:${clientIp}`,
		inFlightLimiter: webhookInFlightLimiter,
		inFlightKey: `${normalizedPath}:${clientIp}`,
		handle: async ({ path, targets }) => {
			const url = requestUrl;
			const guidParam = url.searchParams.get("guid") ?? url.searchParams.get("password");
			const headerToken = req.headers["x-guid"] ?? req.headers["x-password"] ?? req.headers["x-bluebubbles-guid"] ?? req.headers["authorization"];
			const guid = (Array.isArray(headerToken) ? headerToken[0] : headerToken) ?? guidParam ?? "";
			const target = resolveWebhookTargetWithAuthOrRejectSync({
				targets,
				res,
				isMatch: (target) => {
					return safeEqualAuthToken(guid, target.account.config.password?.trim() ?? "");
				}
			});
			if (!target) {
				console.warn(`[bluebubbles] webhook rejected: status=${res.statusCode} path=${path} guid=${maskSecret(url.searchParams.get("guid") ?? url.searchParams.get("password") ?? "")}`);
				return true;
			}
			const body = await readWebhookBodyOrReject({
				req,
				res,
				profile: "post-auth",
				invalidBodyMessage: "invalid payload"
			});
			if (!body.ok) {
				console.warn(`[bluebubbles] webhook rejected: status=${res.statusCode}`);
				return true;
			}
			const parsed = parseBlueBubblesWebhookPayload(body.value);
			if (!parsed.ok) {
				res.statusCode = 400;
				res.end(parsed.error);
				console.warn(`[bluebubbles] webhook rejected: ${parsed.error}`);
				return true;
			}
			const payload = asRecord(parsed.value) ?? {};
			const firstTarget = targets[0];
			if (firstTarget) logVerbose(firstTarget.core, firstTarget.runtime, `webhook received path=${path} keys=${Object.keys(payload).join(",") || "none"}`);
			const eventTypeRaw = payload.type;
			const eventType = typeof eventTypeRaw === "string" ? eventTypeRaw.trim() : "";
			if (eventType && !new Set([
				"new-message",
				"updated-message",
				"message-reaction",
				"reaction"
			]).has(eventType)) {
				res.statusCode = 200;
				res.end("ok");
				if (firstTarget) logVerbose(firstTarget.core, firstTarget.runtime, `webhook ignored type=${eventType}`);
				return true;
			}
			const reaction = normalizeWebhookReaction(payload);
			const message = reaction ? null : normalizeWebhookMessage(payload, { eventType });
			const isAttachmentUpdate = eventType === "updated-message" && (message?.attachments?.length ?? 0) > 0;
			if ((eventType === "updated-message" || eventType === "message-reaction" || eventType === "reaction") && !reaction && !isAttachmentUpdate) {
				res.statusCode = 200;
				res.end("ok");
				if (firstTarget) logVerbose(firstTarget.core, firstTarget.runtime, `webhook ignored ${eventType || "event"} (no reaction or attachment update)`);
				return true;
			}
			if (!message && !reaction) {
				res.statusCode = 400;
				res.end("invalid payload");
				console.warn("[bluebubbles] webhook rejected: unable to parse message payload");
				return true;
			}
			target.statusSink?.({ lastInboundAt: Date.now() });
			if (reaction) processReaction(reaction, target).catch((err) => {
				target.runtime.error?.(`[${target.account.accountId}] BlueBubbles reaction failed: ${String(err)}`);
			});
			else if (message) debounceRegistry.getOrCreateDebouncer(target).enqueue({
				message,
				target
			}).catch((err) => {
				target.runtime.error?.(`[${target.account.accountId}] BlueBubbles webhook failed: ${String(err)}`);
			});
			res.statusCode = 200;
			res.end("ok");
			if (reaction) {
				if (firstTarget) logVerbose(firstTarget.core, firstTarget.runtime, `webhook accepted reaction sender=${reaction.senderId} msg=${reaction.messageId} action=${reaction.action}`);
			} else if (message) {
				if (firstTarget) logVerbose(firstTarget.core, firstTarget.runtime, `webhook accepted sender=${message.senderId} group=${message.isGroup} chatGuid=${message.chatGuid ?? ""} chatId=${message.chatId ?? ""}`);
			}
			return true;
		}
	});
}
async function monitorBlueBubblesProvider(options) {
	const { account, config, runtime, abortSignal, statusSink } = options;
	const core = getBlueBubblesRuntime();
	const path = options.webhookPath?.trim() || "/bluebubbles-webhook";
	const allowPrivateNetwork = resolveBlueBubblesEffectiveAllowPrivateNetwork({
		baseUrl: account.baseUrl,
		config: account.config
	});
	const serverInfo = await fetchBlueBubblesServerInfo({
		baseUrl: account.baseUrl,
		password: account.config.password,
		accountId: account.accountId,
		timeoutMs: 5e3,
		allowPrivateNetwork
	}).catch(() => null);
	if (serverInfo?.os_version) runtime.log?.(`[${account.accountId}] BlueBubbles server macOS ${serverInfo.os_version}`);
	if (typeof serverInfo?.private_api === "boolean") runtime.log?.(`[${account.accountId}] BlueBubbles Private API ${serverInfo.private_api ? "enabled" : "disabled"}`);
	const target = {
		account,
		config,
		runtime,
		core,
		path,
		statusSink
	};
	const unregister = registerBlueBubblesWebhookTarget(target);
	return await new Promise((resolve) => {
		const stop = () => {
			unregister();
			resolve();
		};
		if (abortSignal?.aborted) {
			stop();
			return;
		}
		abortSignal?.addEventListener("abort", stop, { once: true });
		runtime.log?.(`[${account.accountId}] BlueBubbles webhook listening on ${normalizeWebhookPath(path)}`);
		import("./catchup-Bgakkjhq.js").then(({ runBlueBubblesCatchup }) => runBlueBubblesCatchup(target)).catch((err) => {
			runtime.error?.(`[${account.accountId}] BlueBubbles catchup: unexpected failure: ${String(err)}`);
		});
	});
}
//#endregion
//#region extensions/bluebubbles/src/channel.runtime.ts
const blueBubblesChannelRuntime = {
	sendBlueBubblesMedia,
	resolveBlueBubblesMessageId,
	monitorBlueBubblesProvider,
	resolveWebhookPathFromConfig,
	probeBlueBubbles,
	sendMessageBlueBubbles
};
//#endregion
export { blueBubblesChannelRuntime };
