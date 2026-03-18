import "./redact-qojvLPM7.js";
import "./errors-nCFRNLA6.js";
import "./unhandled-rejections-DGuis5pC.js";
import "./globals-B6h30oSy.js";
import "./paths-DqbqmTPe.js";
import "./theme-CL08MjAq.js";
import "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-BiUV1eIQ.js";
import "./links-DPi3kBux.js";
import { $d as WEBHOOK_ANOMALY_COUNTER_DEFAULTS, Bf as logTypingFailure, Jd as applyBasicWebhookRequestGuards, Nf as createReplyPrefixOptions, On as isNormalizedSenderAllowed, Zd as readJsonWebhookBodyOrReject, cf as createScopedPairingAccess, ef as WEBHOOK_RATE_LIMIT_DEFAULTS, er as waitForAbortSignal, jf as createTypingCallbacks, nf as createWebhookAnomalyTracker, of as issuePairingChallenge, tf as createFixedWindowRateLimiter, tt as createPluginRuntimeStore } from "./auth-profiles-DAOR1fRn.js";
import "./plugins-allowlist-E4LSkJ7R.js";
import { D as createDedupeCache, Gt as evaluateSenderGroupAccess, Qt as resolveDefaultGroupPolicy, en as warnMissingProviderGroupPolicyFallbackOnce } from "./registry-ep1yQ6WN.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-DZywV-kg.js";
import "./method-scopes-CLHNYIU6.js";
import "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import "./agent-scope-C0PckUtv.js";
import "./logger-DLmJXd-S.js";
import "./exec-BmPfiSbq.js";
import "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import "./version-Dubp0iGu.js";
import "./config-DZ3oWznn.js";
import "./workspace-dirs-Ejflbukt.js";
import "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import { d as resolveClientIp } from "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-V82ct97U.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-DUmWDILI.js";
import "./commands-BfMCtxuV.js";
import "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import "./paths-55bRPK_d.js";
import "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import "./cli-utils-DRykF2zj.js";
import { _ as sendMediaWithLeadingCaption, g as resolveOutboundMediaUrls, x as resolveSenderCommandAuthorizationWithRuntime, y as resolveDirectDmAuthorizationOutcome } from "./compat-aC6dpiEb.js";
import { a as registerWebhookTarget, c as resolveWebhookTargetWithAuthOrRejectSync, d as resolveWebhookPath, l as withResolvedWebhookRequestPipeline, o as registerWebhookTargetWithPluginRoute, t as resolveInboundRouteEnvelopeBuilderWithRuntime } from "./inbound-envelope-aY_xfQcC.js";
import "./device-pairing-D3SsXoQX.js";
import "./resolve-utils-P7inlndK.js";
import { a as getUpdates, c as sendMessage, l as sendPhoto, n as ZaloApiError, o as getWebhookInfo, r as deleteWebhook, s as sendChatAction, t as resolveZaloProxyFetch, u as setWebhook } from "./proxy-XWtf_VTn.js";
import { timingSafeEqual } from "node:crypto";
//#region extensions/zalo/src/group-access.ts
const ZALO_ALLOW_FROM_PREFIX_RE = /^(zalo|zl):/i;
function isZaloSenderAllowed(senderId, allowFrom) {
	return isNormalizedSenderAllowed({
		senderId,
		allowFrom,
		stripPrefixRe: ZALO_ALLOW_FROM_PREFIX_RE
	});
}
function evaluateZaloGroupAccess(params) {
	return evaluateSenderGroupAccess({
		providerConfigPresent: params.providerConfigPresent,
		configuredGroupPolicy: params.configuredGroupPolicy,
		defaultGroupPolicy: params.defaultGroupPolicy,
		groupAllowFrom: params.groupAllowFrom,
		senderId: params.senderId,
		isSenderAllowed: isZaloSenderAllowed
	});
}
//#endregion
//#region extensions/zalo/src/monitor.webhook.ts
const ZALO_WEBHOOK_REPLAY_WINDOW_MS = 5 * 6e4;
const webhookTargets = /* @__PURE__ */ new Map();
const webhookRateLimiter = createFixedWindowRateLimiter({
	windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
	maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
	maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys
});
const recentWebhookEvents = createDedupeCache({
	ttlMs: ZALO_WEBHOOK_REPLAY_WINDOW_MS,
	maxSize: 5e3
});
const webhookAnomalyTracker = createWebhookAnomalyTracker({
	maxTrackedKeys: WEBHOOK_ANOMALY_COUNTER_DEFAULTS.maxTrackedKeys,
	ttlMs: WEBHOOK_ANOMALY_COUNTER_DEFAULTS.ttlMs,
	logEvery: WEBHOOK_ANOMALY_COUNTER_DEFAULTS.logEvery
});
function timingSafeEquals(left, right) {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	if (leftBuffer.length !== rightBuffer.length) {
		const length = Math.max(1, leftBuffer.length, rightBuffer.length);
		const paddedLeft = Buffer.alloc(length);
		const paddedRight = Buffer.alloc(length);
		leftBuffer.copy(paddedLeft);
		rightBuffer.copy(paddedRight);
		timingSafeEqual(paddedLeft, paddedRight);
		return false;
	}
	return timingSafeEqual(leftBuffer, rightBuffer);
}
function isReplayEvent(update, nowMs) {
	const messageId = update.message?.message_id;
	if (!messageId) return false;
	const key = `${update.event_name}:${messageId}`;
	return recentWebhookEvents.check(key, nowMs);
}
function recordWebhookStatus(runtime, path, statusCode) {
	webhookAnomalyTracker.record({
		key: `${path}:${statusCode}`,
		statusCode,
		log: runtime?.log,
		message: (count) => `[zalo] webhook anomaly path=${path} status=${statusCode} count=${String(count)}`
	});
}
function headerValue(value) {
	return Array.isArray(value) ? value[0] : value;
}
function registerZaloWebhookTarget$1(target, opts) {
	if (opts?.route) return registerWebhookTargetWithPluginRoute({
		targetsByPath: webhookTargets,
		target,
		route: opts.route,
		onLastPathTargetRemoved: opts.onLastPathTargetRemoved
	}).unregister;
	return registerWebhookTarget(webhookTargets, target, opts).unregister;
}
async function handleZaloWebhookRequest$1(req, res, processUpdate) {
	return await withResolvedWebhookRequestPipeline({
		req,
		res,
		targetsByPath: webhookTargets,
		allowMethods: ["POST"],
		handle: async ({ targets, path }) => {
			const trustedProxies = targets[0]?.config.gateway?.trustedProxies;
			const allowRealIpFallback = targets[0]?.config.gateway?.allowRealIpFallback === true;
			const rateLimitKey = `${path}:${resolveClientIp({
				remoteAddr: req.socket.remoteAddress,
				forwardedFor: headerValue(req.headers["x-forwarded-for"]),
				realIp: headerValue(req.headers["x-real-ip"]),
				trustedProxies,
				allowRealIpFallback
			}) ?? req.socket.remoteAddress ?? "unknown"}`;
			const nowMs = Date.now();
			if (!applyBasicWebhookRequestGuards({
				req,
				res,
				rateLimiter: webhookRateLimiter,
				rateLimitKey,
				nowMs
			})) {
				recordWebhookStatus(targets[0]?.runtime, path, res.statusCode);
				return true;
			}
			const headerToken = String(req.headers["x-bot-api-secret-token"] ?? "");
			const target = resolveWebhookTargetWithAuthOrRejectSync({
				targets,
				res,
				isMatch: (entry) => timingSafeEquals(entry.secret, headerToken)
			});
			if (!target) {
				recordWebhookStatus(targets[0]?.runtime, path, res.statusCode);
				return true;
			}
			if (!applyBasicWebhookRequestGuards({
				req,
				res,
				requireJsonContentType: true
			})) {
				recordWebhookStatus(target.runtime, path, res.statusCode);
				return true;
			}
			const body = await readJsonWebhookBodyOrReject({
				req,
				res,
				maxBytes: 1024 * 1024,
				timeoutMs: 3e4,
				emptyObjectOnEmpty: false,
				invalidJsonMessage: "Bad Request"
			});
			if (!body.ok) {
				recordWebhookStatus(target.runtime, path, res.statusCode);
				return true;
			}
			const raw = body.value;
			const record = raw && typeof raw === "object" ? raw : null;
			const update = record && record.ok === true && record.result ? record.result : record ?? void 0;
			if (!update?.event_name) {
				res.statusCode = 400;
				res.end("Bad Request");
				recordWebhookStatus(target.runtime, path, res.statusCode);
				return true;
			}
			if (isReplayEvent(update, nowMs)) {
				res.statusCode = 200;
				res.end("ok");
				return true;
			}
			target.statusSink?.({ lastInboundAt: Date.now() });
			processUpdate({
				update,
				target
			}).catch((err) => {
				target.runtime.error?.(`[${target.account.accountId}] Zalo webhook failed: ${String(err)}`);
			});
			res.statusCode = 200;
			res.end("ok");
			return true;
		}
	});
}
//#endregion
//#region extensions/zalo/src/runtime.ts
const { setRuntime: setZaloRuntime, getRuntime: getZaloRuntime } = createPluginRuntimeStore("Zalo runtime not initialized");
//#endregion
//#region extensions/zalo/src/monitor.ts
const ZALO_TEXT_LIMIT = 2e3;
const DEFAULT_MEDIA_MAX_MB = 5;
const WEBHOOK_CLEANUP_TIMEOUT_MS = 5e3;
const ZALO_TYPING_TIMEOUT_MS = 5e3;
function formatZaloError(error) {
	if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
	return String(error);
}
function describeWebhookTarget(rawUrl) {
	try {
		const parsed = new URL(rawUrl);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return rawUrl;
	}
}
function normalizeWebhookUrl(url) {
	const trimmed = url?.trim();
	return trimmed ? trimmed : void 0;
}
function logVerbose(core, runtime, message) {
	if (core.logging.shouldLogVerbose()) runtime.log?.(`[zalo] ${message}`);
}
function registerZaloWebhookTarget(target) {
	return registerZaloWebhookTarget$1(target, { route: {
		auth: "plugin",
		match: "exact",
		pluginId: "zalo",
		source: "zalo-webhook",
		accountId: target.account.accountId,
		log: target.runtime.log,
		handler: async (req, res) => {
			if (!await handleZaloWebhookRequest(req, res) && !res.headersSent) {
				res.statusCode = 404;
				res.setHeader("Content-Type", "text/plain; charset=utf-8");
				res.end("Not Found");
			}
		}
	} });
}
async function handleZaloWebhookRequest(req, res) {
	return handleZaloWebhookRequest$1(req, res, async ({ update, target }) => {
		await processUpdate({
			update,
			token: target.token,
			account: target.account,
			config: target.config,
			runtime: target.runtime,
			core: target.core,
			mediaMaxMb: target.mediaMaxMb,
			statusSink: target.statusSink,
			fetcher: target.fetcher
		});
	});
}
function startPollingLoop(params) {
	const { token, account, config, runtime, core, abortSignal, isStopped, mediaMaxMb, statusSink, fetcher } = params;
	const pollTimeout = 30;
	const processingContext = {
		token,
		account,
		config,
		runtime,
		core,
		mediaMaxMb,
		statusSink,
		fetcher
	};
	runtime.log?.(`[${account.accountId}] Zalo polling loop started timeout=${String(pollTimeout)}s`);
	const poll = async () => {
		if (isStopped() || abortSignal.aborted) return;
		try {
			const response = await getUpdates(token, { timeout: pollTimeout }, fetcher);
			if (response.ok && response.result) {
				statusSink?.({ lastInboundAt: Date.now() });
				await processUpdate({
					update: response.result,
					...processingContext
				});
			}
		} catch (err) {
			if (err instanceof ZaloApiError && err.isPollingTimeout) {} else if (!isStopped() && !abortSignal.aborted) {
				runtime.error?.(`[${account.accountId}] Zalo polling error: ${formatZaloError(err)}`);
				await new Promise((resolve) => setTimeout(resolve, 5e3));
			}
		}
		if (!isStopped() && !abortSignal.aborted) setImmediate(poll);
	};
	poll();
}
async function processUpdate(params) {
	const { update, token, account, config, runtime, core, mediaMaxMb, statusSink, fetcher } = params;
	const { event_name, message } = update;
	const sharedContext = {
		token,
		account,
		config,
		runtime,
		core,
		statusSink,
		fetcher
	};
	if (!message) return;
	switch (event_name) {
		case "message.text.received":
			await handleTextMessage({
				message,
				...sharedContext
			});
			break;
		case "message.image.received":
			await handleImageMessage({
				message,
				...sharedContext,
				mediaMaxMb
			});
			break;
		case "message.sticker.received":
			logVerbose(core, runtime, `[${account.accountId}] Received sticker from ${message.from.id}`);
			break;
		case "message.unsupported.received":
			logVerbose(core, runtime, `[${account.accountId}] Received unsupported message type from ${message.from.id}`);
			break;
	}
}
async function handleTextMessage(params) {
	const { message } = params;
	const { text } = message;
	if (!text?.trim()) return;
	await processMessageWithPipeline({
		...params,
		text,
		mediaPath: void 0,
		mediaType: void 0
	});
}
async function handleImageMessage(params) {
	const { message, mediaMaxMb, account, core, runtime } = params;
	const { photo, caption } = message;
	let mediaPath;
	let mediaType;
	if (photo) try {
		const maxBytes = mediaMaxMb * 1024 * 1024;
		const fetched = await core.channel.media.fetchRemoteMedia({
			url: photo,
			maxBytes
		});
		const saved = await core.channel.media.saveMediaBuffer(fetched.buffer, fetched.contentType, "inbound", maxBytes);
		mediaPath = saved.path;
		mediaType = saved.contentType;
	} catch (err) {
		runtime.error?.(`[${account.accountId}] Failed to download Zalo image: ${String(err)}`);
	}
	await processMessageWithPipeline({
		...params,
		text: caption,
		mediaPath,
		mediaType
	});
}
async function processMessageWithPipeline(params) {
	const { message, token, account, config, runtime, core, text, mediaPath, mediaType, statusSink, fetcher } = params;
	const pairing = createScopedPairingAccess({
		core,
		channel: "zalo",
		accountId: account.accountId
	});
	const { from, chat, message_id, date } = message;
	const isGroup = chat.chat_type === "GROUP";
	const chatId = chat.id;
	const senderId = from.id;
	const senderName = from.name;
	const dmPolicy = account.config.dmPolicy ?? "pairing";
	const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
	const configuredGroupAllowFrom = (account.config.groupAllowFrom ?? []).map((v) => String(v));
	const groupAllowFrom = configuredGroupAllowFrom.length > 0 ? configuredGroupAllowFrom : configAllowFrom;
	const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
	const groupAccess = isGroup ? evaluateZaloGroupAccess({
		providerConfigPresent: config.channels?.zalo !== void 0,
		configuredGroupPolicy: account.config.groupPolicy,
		defaultGroupPolicy,
		groupAllowFrom,
		senderId
	}) : void 0;
	if (groupAccess) {
		warnMissingProviderGroupPolicyFallbackOnce({
			providerMissingFallbackApplied: groupAccess.providerMissingFallbackApplied,
			providerKey: "zalo",
			accountId: account.accountId,
			log: (message) => logVerbose(core, runtime, message)
		});
		if (!groupAccess.allowed) {
			if (groupAccess.reason === "disabled") logVerbose(core, runtime, `zalo: drop group ${chatId} (groupPolicy=disabled)`);
			else if (groupAccess.reason === "empty_allowlist") logVerbose(core, runtime, `zalo: drop group ${chatId} (groupPolicy=allowlist, no groupAllowFrom)`);
			else if (groupAccess.reason === "sender_not_allowlisted") logVerbose(core, runtime, `zalo: drop group sender ${senderId} (groupPolicy=allowlist)`);
			return;
		}
	}
	const rawBody = text?.trim() || (mediaPath ? "<media:image>" : "");
	const { senderAllowedForCommands, commandAuthorized } = await resolveSenderCommandAuthorizationWithRuntime({
		cfg: config,
		rawBody,
		isGroup,
		dmPolicy,
		configuredAllowFrom: configAllowFrom,
		configuredGroupAllowFrom: groupAllowFrom,
		senderId,
		isSenderAllowed: isZaloSenderAllowed,
		readAllowFromStore: pairing.readAllowFromStore,
		runtime: core.channel.commands
	});
	const directDmOutcome = resolveDirectDmAuthorizationOutcome({
		isGroup,
		dmPolicy,
		senderAllowedForCommands
	});
	if (directDmOutcome === "disabled") {
		logVerbose(core, runtime, `Blocked zalo DM from ${senderId} (dmPolicy=disabled)`);
		return;
	}
	if (directDmOutcome === "unauthorized") {
		if (dmPolicy === "pairing") await issuePairingChallenge({
			channel: "zalo",
			senderId,
			senderIdLine: `Your Zalo user id: ${senderId}`,
			meta: { name: senderName ?? void 0 },
			upsertPairingRequest: pairing.upsertPairingRequest,
			onCreated: () => {
				logVerbose(core, runtime, `zalo pairing request sender=${senderId}`);
			},
			sendPairingReply: async (text) => {
				await sendMessage(token, {
					chat_id: chatId,
					text
				}, fetcher);
				statusSink?.({ lastOutboundAt: Date.now() });
			},
			onReplyError: (err) => {
				logVerbose(core, runtime, `zalo pairing reply failed for ${senderId}: ${String(err)}`);
			}
		});
		else logVerbose(core, runtime, `Blocked unauthorized zalo sender ${senderId} (dmPolicy=${dmPolicy})`);
		return;
	}
	const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
		cfg: config,
		channel: "zalo",
		accountId: account.accountId,
		peer: {
			kind: isGroup ? "group" : "direct",
			id: chatId
		},
		runtime: core.channel,
		sessionStore: config.session?.store
	});
	if (isGroup && core.channel.commands.isControlCommandMessage(rawBody, config) && commandAuthorized !== true) {
		logVerbose(core, runtime, `zalo: drop control command from unauthorized sender ${senderId}`);
		return;
	}
	const fromLabel = isGroup ? `group:${chatId}` : senderName || `user:${senderId}`;
	const { storePath, body } = buildEnvelope({
		channel: "Zalo",
		from: fromLabel,
		timestamp: date ? date * 1e3 : void 0,
		body: rawBody
	});
	const ctxPayload = core.channel.reply.finalizeInboundContext({
		Body: body,
		BodyForAgent: rawBody,
		RawBody: rawBody,
		CommandBody: rawBody,
		From: isGroup ? `zalo:group:${chatId}` : `zalo:${senderId}`,
		To: `zalo:${chatId}`,
		SessionKey: route.sessionKey,
		AccountId: route.accountId,
		ChatType: isGroup ? "group" : "direct",
		ConversationLabel: fromLabel,
		SenderName: senderName || void 0,
		SenderId: senderId,
		CommandAuthorized: commandAuthorized,
		Provider: "zalo",
		Surface: "zalo",
		MessageSid: message_id,
		MediaPath: mediaPath,
		MediaType: mediaType,
		MediaUrl: mediaPath,
		OriginatingChannel: "zalo",
		OriginatingTo: `zalo:${chatId}`
	});
	await core.channel.session.recordInboundSession({
		storePath,
		sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
		ctx: ctxPayload,
		onRecordError: (err) => {
			runtime.error?.(`zalo: failed updating session meta: ${String(err)}`);
		}
	});
	const tableMode = core.channel.text.resolveMarkdownTableMode({
		cfg: config,
		channel: "zalo",
		accountId: account.accountId
	});
	const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
		cfg: config,
		agentId: route.agentId,
		channel: "zalo",
		accountId: account.accountId
	});
	const typingCallbacks = createTypingCallbacks({
		start: async () => {
			await sendChatAction(token, {
				chat_id: chatId,
				action: "typing"
			}, fetcher, ZALO_TYPING_TIMEOUT_MS);
		},
		onStartError: (err) => {
			logTypingFailure({
				log: (message) => logVerbose(core, runtime, message),
				channel: "zalo",
				action: "start",
				target: chatId,
				error: err
			});
		}
	});
	await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
		ctx: ctxPayload,
		cfg: config,
		dispatcherOptions: {
			...prefixOptions,
			typingCallbacks,
			deliver: async (payload) => {
				await deliverZaloReply({
					payload,
					token,
					chatId,
					runtime,
					core,
					config,
					accountId: account.accountId,
					statusSink,
					fetcher,
					tableMode
				});
			},
			onError: (err, info) => {
				runtime.error?.(`[${account.accountId}] Zalo ${info.kind} reply failed: ${String(err)}`);
			}
		},
		replyOptions: { onModelSelected }
	});
}
async function deliverZaloReply(params) {
	const { payload, token, chatId, runtime, core, config, accountId, statusSink, fetcher } = params;
	const tableMode = params.tableMode ?? "code";
	const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
	if (await sendMediaWithLeadingCaption({
		mediaUrls: resolveOutboundMediaUrls(payload),
		caption: text,
		send: async ({ mediaUrl, caption }) => {
			await sendPhoto(token, {
				chat_id: chatId,
				photo: mediaUrl,
				caption
			}, fetcher);
			statusSink?.({ lastOutboundAt: Date.now() });
		},
		onError: (error) => {
			runtime.error?.(`Zalo photo send failed: ${String(error)}`);
		}
	})) return;
	if (text) {
		const chunkMode = core.channel.text.resolveChunkMode(config, "zalo", accountId);
		const chunks = core.channel.text.chunkMarkdownTextWithMode(text, ZALO_TEXT_LIMIT, chunkMode);
		for (const chunk of chunks) try {
			await sendMessage(token, {
				chat_id: chatId,
				text: chunk
			}, fetcher);
			statusSink?.({ lastOutboundAt: Date.now() });
		} catch (err) {
			runtime.error?.(`Zalo message send failed: ${String(err)}`);
		}
	}
}
async function monitorZaloProvider(options) {
	const { token, account, config, runtime, abortSignal, useWebhook, webhookUrl, webhookSecret, webhookPath, statusSink, fetcher: fetcherOverride } = options;
	const core = getZaloRuntime();
	const effectiveMediaMaxMb = account.config.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
	const fetcher = fetcherOverride ?? resolveZaloProxyFetch(account.config.proxy);
	const mode = useWebhook ? "webhook" : "polling";
	let stopped = false;
	const stopHandlers = [];
	let cleanupWebhook;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		for (const handler of stopHandlers) handler();
	};
	runtime.log?.(`[${account.accountId}] Zalo provider init mode=${mode} mediaMaxMb=${String(effectiveMediaMaxMb)}`);
	try {
		if (useWebhook) {
			if (!webhookUrl || !webhookSecret) throw new Error("Zalo webhookUrl and webhookSecret are required for webhook mode");
			if (!webhookUrl.startsWith("https://")) throw new Error("Zalo webhook URL must use HTTPS");
			if (webhookSecret.length < 8 || webhookSecret.length > 256) throw new Error("Zalo webhook secret must be 8-256 characters");
			const path = resolveWebhookPath({
				webhookPath,
				webhookUrl,
				defaultPath: null
			});
			if (!path) throw new Error("Zalo webhookPath could not be derived");
			runtime.log?.(`[${account.accountId}] Zalo configuring webhook path=${path} target=${describeWebhookTarget(webhookUrl)}`);
			await setWebhook(token, {
				url: webhookUrl,
				secret_token: webhookSecret
			}, fetcher);
			let webhookCleanupPromise;
			cleanupWebhook = async () => {
				if (!webhookCleanupPromise) webhookCleanupPromise = (async () => {
					runtime.log?.(`[${account.accountId}] Zalo stopping; deleting webhook`);
					try {
						await deleteWebhook(token, fetcher, WEBHOOK_CLEANUP_TIMEOUT_MS);
						runtime.log?.(`[${account.accountId}] Zalo webhook deleted`);
					} catch (err) {
						const detail = err instanceof Error && err.name === "AbortError" ? `timed out after ${String(WEBHOOK_CLEANUP_TIMEOUT_MS)}ms` : formatZaloError(err);
						runtime.error?.(`[${account.accountId}] Zalo webhook delete failed: ${detail}`);
					}
				})();
				await webhookCleanupPromise;
			};
			runtime.log?.(`[${account.accountId}] Zalo webhook registered path=${path}`);
			const unregister = registerZaloWebhookTarget({
				token,
				account,
				config,
				runtime,
				core,
				path,
				secret: webhookSecret,
				statusSink: (patch) => statusSink?.(patch),
				mediaMaxMb: effectiveMediaMaxMb,
				fetcher
			});
			stopHandlers.push(unregister);
			await waitForAbortSignal(abortSignal);
			return;
		}
		runtime.log?.(`[${account.accountId}] Zalo polling mode: clearing webhook before startup`);
		try {
			try {
				const currentWebhookUrl = normalizeWebhookUrl((await getWebhookInfo(token, fetcher)).result?.url);
				if (!currentWebhookUrl) runtime.log?.(`[${account.accountId}] Zalo polling mode ready (no webhook configured)`);
				else {
					runtime.log?.(`[${account.accountId}] Zalo polling mode disabling existing webhook ${describeWebhookTarget(currentWebhookUrl)}`);
					await deleteWebhook(token, fetcher);
					runtime.log?.(`[${account.accountId}] Zalo polling mode ready (webhook disabled)`);
				}
			} catch (err) {
				if (err instanceof ZaloApiError && err.errorCode === 404) runtime.log?.(`[${account.accountId}] Zalo polling mode webhook inspection unavailable; continuing without webhook cleanup`);
				else throw err;
			}
		} catch (err) {
			runtime.error?.(`[${account.accountId}] Zalo polling startup could not clear webhook: ${formatZaloError(err)}`);
		}
		startPollingLoop({
			token,
			account,
			config,
			runtime,
			core,
			abortSignal,
			isStopped: () => stopped,
			mediaMaxMb: effectiveMediaMaxMb,
			statusSink,
			fetcher
		});
		await waitForAbortSignal(abortSignal);
	} catch (err) {
		runtime.error?.(`[${account.accountId}] Zalo provider startup failed mode=${mode}: ${formatZaloError(err)}`);
		throw err;
	} finally {
		await cleanupWebhook?.();
		stop();
		runtime.log?.(`[${account.accountId}] Zalo provider stopped mode=${mode}`);
	}
}
//#endregion
export { monitorZaloProvider };
