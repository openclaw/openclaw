import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { t as privateFileStore } from "./private-file-store-DMtyjgoc.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { i as deliverTextOrMediaReply, m as resolveSendableOutboundReplyParts } from "./reply-payload-DMPQsrQC.js";
import { o as resolveStableChannelMessageIngress } from "./runtime-BUVuto5K.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, r as resolveDefaultGroupPolicy } from "./runtime-group-policy-CmZDlIwd.js";
import "./temp-path-DllZid8c.js";
import { t as waitForAbortSignal } from "./abort-signal-B53kbSiw.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { r as resolveInboundRouteEnvelopeBuilderWithRuntime } from "./inbound-envelope-DF4N8x5q.js";
import { t as loadOutboundMediaFromUrl } from "./outbound-media-BwaTbAKd.js";
import { t as registerPluginHttpRoute } from "./http-registry-Dt8GAiji.js";
import "./security-runtime-CcSekjBd.js";
import { r as logTypingFailure } from "./logging-Dr3f0mtP.js";
import "./channel-feedback-Bn34MjYD.js";
import "./channel-ingress-runtime-C3bbz3sX.js";
import { n as createChannelPairingController } from "./channel-pairing-N4dBc-K-.js";
import "./webhook-ingress-R0qMwT4u.js";
import { n as resolveWebhookPath } from "./webhook-path-rjz7yuUD.js";
import { n as resolveZaloRuntimeGroupPolicy, t as normalizeZaloAllowEntry } from "./group-access-DMtIHfcM.js";
import { t as getZaloRuntime } from "./runtime-DEp4cBl2.js";
import { a as getUpdates, c as sendMessage, l as sendPhoto, n as ZaloApiError, o as getWebhookInfo, r as deleteWebhook, s as sendChatAction, t as resolveZaloProxyFetch, u as setWebhook } from "./proxy-BWFfui0N.js";
import "node:fs";
import { join } from "node:path";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
//#region extensions/zalo/src/monitor-durable.ts
function prepareZaloDurableReplyPayload(params) {
	if (!params.payload.text) return params.payload;
	return {
		...params.payload,
		text: params.convertMarkdownTables(params.payload.text, params.tableMode)
	};
}
function resolveZaloDurableReplyOptions(params) {
	if (params.infoKind !== "final") return false;
	const reply = resolveSendableOutboundReplyParts(params.payload);
	if (reply.hasMedia || !reply.hasText) return false;
	return { to: params.chatId };
}
//#endregion
//#region extensions/zalo/src/outbound-media.ts
const ZALO_OUTBOUND_MEDIA_TTL_MS = 2 * 6e4;
const ZALO_OUTBOUND_MEDIA_SEGMENT = "media";
const ZALO_OUTBOUND_MEDIA_PREFIX = `/${ZALO_OUTBOUND_MEDIA_SEGMENT}/`;
const ZALO_OUTBOUND_MEDIA_DIR = join(resolvePreferredOpenClawTmpDir(), "openclaw-zalo-outbound-media");
const ZALO_OUTBOUND_MEDIA_ID_RE = /^[a-f0-9]{24}$/;
function resolveHostedZaloMediaMetadataPath(id) {
	return join(ZALO_OUTBOUND_MEDIA_DIR, `${id}.json`);
}
function resolveHostedZaloMediaBufferPath(id) {
	return join(ZALO_OUTBOUND_MEDIA_DIR, `${id}.bin`);
}
function createHostedZaloMediaId() {
	return randomBytes(12).toString("hex");
}
function createHostedZaloMediaToken() {
	return randomBytes(24).toString("hex");
}
async function ensureHostedZaloMediaDir() {
	await privateFileStore(ZALO_OUTBOUND_MEDIA_DIR).writeText(".ready", "");
	await unlink(join(ZALO_OUTBOUND_MEDIA_DIR, ".ready")).catch(() => void 0);
}
async function deleteHostedZaloMediaEntry(id) {
	await Promise.all([unlink(resolveHostedZaloMediaMetadataPath(id)).catch(() => void 0), unlink(resolveHostedZaloMediaBufferPath(id)).catch(() => void 0)]);
}
async function cleanupExpiredHostedZaloMedia(nowMs = Date.now()) {
	let fileNames;
	try {
		fileNames = await readdir(ZALO_OUTBOUND_MEDIA_DIR);
	} catch {
		return;
	}
	await Promise.all(fileNames.filter((fileName) => fileName.endsWith(".json")).map(async (fileName) => {
		const id = fileName.slice(0, -5);
		try {
			const metadataRaw = await readFile(resolveHostedZaloMediaMetadataPath(id), "utf8");
			if (JSON.parse(metadataRaw).expiresAt <= nowMs) await deleteHostedZaloMediaEntry(id);
		} catch {
			await deleteHostedZaloMediaEntry(id);
		}
	}));
}
async function readHostedZaloMediaEntry(id) {
	try {
		const [metadataRaw, buffer] = await Promise.all([readFile(resolveHostedZaloMediaMetadataPath(id), "utf8"), readFile(resolveHostedZaloMediaBufferPath(id))]);
		return {
			metadata: JSON.parse(metadataRaw),
			buffer
		};
	} catch {
		return null;
	}
}
function resolveHostedZaloMediaRoutePrefix(params) {
	const webhookRoutePath = resolveWebhookPath({
		webhookPath: params.webhookPath,
		webhookUrl: params.webhookUrl,
		defaultPath: null
	});
	if (!webhookRoutePath) throw new Error("Zalo webhookPath could not be derived for outbound media hosting");
	return webhookRoutePath === "/" ? `/${ZALO_OUTBOUND_MEDIA_SEGMENT}` : `${webhookRoutePath}/${ZALO_OUTBOUND_MEDIA_SEGMENT}`;
}
function resolveHostedZaloMediaRoutePath(params) {
	return `${resolveHostedZaloMediaRoutePrefix(params)}/`;
}
async function prepareHostedZaloMediaUrl(params) {
	await ensureHostedZaloMediaDir();
	await cleanupExpiredHostedZaloMedia();
	const media = await loadOutboundMediaFromUrl(params.mediaUrl, {
		maxBytes: params.maxBytes,
		...params.proxyUrl ? { proxyUrl: params.proxyUrl } : {}
	});
	const routePath = resolveHostedZaloMediaRoutePath({
		webhookUrl: params.webhookUrl,
		webhookPath: params.webhookPath
	});
	const id = createHostedZaloMediaId();
	const token = createHostedZaloMediaToken();
	const publicBaseUrl = new URL(params.webhookUrl).origin;
	const store = privateFileStore(ZALO_OUTBOUND_MEDIA_DIR);
	await store.writeText(`${id}.bin`, media.buffer);
	try {
		await store.writeJson(`${id}.json`, {
			routePath,
			token,
			contentType: media.contentType,
			expiresAt: Date.now() + ZALO_OUTBOUND_MEDIA_TTL_MS
		});
	} catch (error) {
		await deleteHostedZaloMediaEntry(id);
		throw error;
	}
	return `${publicBaseUrl}${routePath}${id}?token=${token}`;
}
async function tryHandleHostedZaloMediaRequest(req, res) {
	await cleanupExpiredHostedZaloMedia();
	const method = req.method ?? "GET";
	if (method !== "GET" && method !== "HEAD") return false;
	let url;
	try {
		url = new URL(req.url ?? "/", "http://localhost");
	} catch {
		return false;
	}
	const mediaPath = url.pathname;
	const prefixIndex = mediaPath.lastIndexOf(ZALO_OUTBOUND_MEDIA_PREFIX);
	if (prefixIndex < 0) return false;
	const routePath = mediaPath.slice(0, prefixIndex + ZALO_OUTBOUND_MEDIA_PREFIX.length);
	const id = mediaPath.slice(prefixIndex + ZALO_OUTBOUND_MEDIA_PREFIX.length);
	if (!id || !ZALO_OUTBOUND_MEDIA_ID_RE.test(id)) {
		res.statusCode = 404;
		res.end("Not Found");
		return true;
	}
	const entry = await readHostedZaloMediaEntry(id);
	if (!entry || entry.metadata.routePath !== routePath) {
		res.statusCode = 404;
		res.end("Not Found");
		return true;
	}
	if (entry.metadata.expiresAt <= Date.now()) {
		await deleteHostedZaloMediaEntry(id);
		res.statusCode = 410;
		res.end("Expired");
		return true;
	}
	if (url.searchParams.get("token") !== entry.metadata.token) {
		res.statusCode = 401;
		res.end("Unauthorized");
		return true;
	}
	if (entry.metadata.contentType) res.setHeader("Content-Type", entry.metadata.contentType);
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("X-Content-Type-Options", "nosniff");
	const bufferStats = await stat(resolveHostedZaloMediaBufferPath(id)).catch(() => null);
	if (bufferStats) res.setHeader("Content-Length", String(bufferStats.size));
	if (method === "HEAD") {
		res.statusCode = 200;
		res.end();
		return true;
	}
	res.statusCode = 200;
	res.end(entry.buffer);
	await deleteHostedZaloMediaEntry(id);
	return true;
}
//#endregion
//#region extensions/zalo/src/monitor.ts
const ZALO_TEXT_LIMIT = 2e3;
const DEFAULT_MEDIA_MAX_MB = 5;
const WEBHOOK_CLEANUP_TIMEOUT_MS = 5e3;
const ZALO_TYPING_TIMEOUT_MS = 5e3;
let zaloWebhookModulePromise;
const hostedMediaRouteRefs = /* @__PURE__ */ new Map();
function loadZaloWebhookModule() {
	zaloWebhookModulePromise ??= import("./monitor.webhook-Dy5Oad1f.js");
	return zaloWebhookModulePromise;
}
function registerSharedHostedMediaRoute(params) {
	const unregister = registerPluginHttpRoute({
		auth: "plugin",
		match: "prefix",
		path: params.path,
		pluginId: "zalo",
		source: "zalo-hosted-media",
		accountId: params.accountId,
		log: params.log,
		handler: async (req, res) => {
			if (!await tryHandleHostedZaloMediaRequest(req, res) && !res.headersSent) {
				res.statusCode = 404;
				res.setHeader("Content-Type", "text/plain; charset=utf-8");
				res.end("Not Found");
			}
		}
	});
	const existing = hostedMediaRouteRefs.get(params.path);
	if (existing) {
		existing.count += 1;
		existing.unregisters.push(unregister);
		return () => {
			const current = hostedMediaRouteRefs.get(params.path);
			if (!current) return;
			if (current.count > 1) {
				current.count -= 1;
				return;
			}
			hostedMediaRouteRefs.delete(params.path);
			for (const unregisterHandle of current.unregisters) unregisterHandle();
		};
	}
	hostedMediaRouteRefs.set(params.path, {
		count: 1,
		unregisters: [unregister]
	});
	return () => {
		const current = hostedMediaRouteRefs.get(params.path);
		if (!current) return;
		if (current.count > 1) {
			current.count -= 1;
			return;
		}
		hostedMediaRouteRefs.delete(params.path);
		for (const unregisterHandle of current.unregisters) unregisterHandle();
	};
}
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
async function handleZaloWebhookRequest(req, res) {
	const { handleZaloWebhookRequest: handleZaloWebhookRequestInternal } = await loadZaloWebhookModule();
	return await handleZaloWebhookRequestInternal(req, res, async ({ update, target }) => {
		await processUpdate({
			update,
			token: target.token,
			account: target.account,
			config: target.config,
			runtime: target.runtime,
			core: target.core,
			mediaMaxMb: target.mediaMaxMb,
			canHostMedia: target.canHostMedia,
			webhookUrl: target.webhookUrl,
			webhookPath: target.webhookPath,
			statusSink: target.statusSink,
			fetcher: target.fetcher
		});
	});
}
function startPollingLoop(params) {
	const { token, account, config, runtime, core, mediaMaxMb, canHostMedia, webhookUrl, webhookPath, abortSignal, isStopped, statusSink, fetcher } = params;
	const pollTimeout = 30;
	const processingContext = {
		token,
		account,
		config,
		runtime,
		core,
		mediaMaxMb,
		canHostMedia,
		webhookUrl,
		webhookPath,
		statusSink,
		fetcher
	};
	runtime.log?.(`[${account.accountId}] Zalo polling loop started timeout=${String(pollTimeout)}s`);
	const poll = async () => {
		if (isStopped() || abortSignal.aborted) return;
		try {
			const response = await getUpdates(token, { timeout: pollTimeout }, fetcher);
			if (isStopped() || abortSignal.aborted) return;
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
		mediaMaxMb,
		canHostMedia: params.canHostMedia,
		webhookUrl: params.webhookUrl,
		webhookPath: params.webhookPath,
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
	const { photo_url, caption } = message;
	const authorization = await authorizeZaloMessage({
		...params,
		text: caption,
		mediaPath: photo_url ? "__pending_media__" : void 0,
		mediaType: void 0
	});
	if (!authorization) return;
	let mediaPath;
	let mediaType;
	if (photo_url) try {
		const maxBytes = mediaMaxMb * 1024 * 1024;
		const saved = await core.channel.media.saveRemoteMedia({
			url: photo_url,
			maxBytes
		});
		mediaPath = saved.path;
		mediaType = saved.contentType;
	} catch (err) {
		runtime.error?.(`[${account.accountId}] Failed to download Zalo image: ${String(err)}`);
	}
	await processMessageWithPipeline({
		...params,
		authorization,
		text: caption,
		mediaPath,
		mediaType
	});
}
async function authorizeZaloMessage(params) {
	const { message, account, config, runtime, core, text, mediaPath, token, statusSink, fetcher } = params;
	const pairing = createChannelPairingController({
		core,
		channel: "zalo",
		accountId: account.accountId
	});
	const { from, chat } = message;
	const isGroup = chat.chat_type === "GROUP";
	const chatId = chat.id;
	const senderId = from.id;
	const senderName = from.display_name ?? from.name;
	const dmPolicy = account.config.dmPolicy ?? "pairing";
	const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
	const rawBody = text?.trim() || (mediaPath ? "<media:image>" : "");
	const { groupPolicy, providerMissingFallbackApplied } = resolveZaloRuntimeGroupPolicy({
		providerConfigPresent: config.channels?.zalo !== void 0,
		groupPolicy: account.config.groupPolicy,
		defaultGroupPolicy
	});
	const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
	const access = await resolveStableChannelMessageIngress({
		channelId: "zalo",
		accountId: account.accountId,
		identity: {
			key: "zalo-user-id",
			normalize: normalizeZaloAllowEntry,
			sensitivity: "pii",
			entryIdPrefix: "zalo-entry"
		},
		cfg: config,
		readStoreAllowFrom: async () => await pairing.readAllowFromStore(),
		subject: { stableId: senderId },
		conversation: {
			kind: isGroup ? "group" : "direct",
			id: chatId
		},
		providerMissingFallbackApplied,
		dmPolicy,
		groupPolicy,
		policy: { groupAllowFromFallbackToAllowFrom: true },
		allowFrom: normalizeStringEntries(account.config.allowFrom),
		groupAllowFrom: normalizeStringEntries(account.config.groupAllowFrom),
		command: shouldComputeAuth ? {} : void 0
	});
	const senderAccess = access.senderAccess;
	if (isGroup) {
		warnMissingProviderGroupPolicyFallbackOnce({
			providerMissingFallbackApplied: senderAccess.providerMissingFallbackApplied,
			providerKey: "zalo",
			accountId: account.accountId,
			log: (message) => logVerbose(core, runtime, message)
		});
		if (!senderAccess.allowed) {
			if (senderAccess.reasonCode === "group_policy_disabled") logVerbose(core, runtime, `zalo: drop group ${chatId} (groupPolicy=disabled)`);
			else if (senderAccess.reasonCode === "group_policy_empty_allowlist") logVerbose(core, runtime, `zalo: drop group ${chatId} (groupPolicy=allowlist, no groupAllowFrom)`);
			else if (senderAccess.reasonCode === "group_policy_not_allowlisted") logVerbose(core, runtime, `zalo: drop group sender ${senderId} (groupPolicy=allowlist)`);
			return;
		}
	}
	if (!isGroup && senderAccess.decision === "block" && senderAccess.reasonCode === "dm_policy_disabled") {
		logVerbose(core, runtime, `Blocked zalo DM from ${senderId} (dmPolicy=disabled)`);
		return;
	}
	if (!isGroup && senderAccess.decision !== "allow") {
		if (dmPolicy === "pairing") await pairing.issueChallenge({
			senderId,
			senderIdLine: `Your Zalo user id: ${senderId}`,
			meta: { name: senderName ?? void 0 },
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
	return {
		chatId,
		commandAuthorized: access.commandAccess.requested ? access.commandAccess.authorized : void 0,
		isGroup,
		rawBody,
		senderId,
		senderName
	};
}
async function processMessageWithPipeline(params) {
	const { message, token, account, config, runtime, core, mediaPath, mediaType, statusSink, fetcher, authorization: authorizationOverride } = params;
	const { message_id, date } = message;
	const authorization = authorizationOverride ?? await authorizeZaloMessage({
		...params,
		mediaPath,
		mediaType
	});
	if (!authorization) return;
	const { isGroup, chatId, senderId, senderName, rawBody, commandAuthorized } = authorization;
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
	const ctxPayload = core.channel.turn.buildContext({
		channel: "zalo",
		accountId: route.accountId,
		messageId: message_id,
		timestamp: date ? date * 1e3 : void 0,
		from: isGroup ? `zalo:group:${chatId}` : `zalo:${senderId}`,
		sender: {
			id: senderId,
			name: senderName || void 0
		},
		conversation: {
			kind: isGroup ? "group" : "direct",
			id: chatId,
			label: fromLabel,
			routePeer: {
				kind: isGroup ? "group" : "direct",
				id: chatId
			}
		},
		route: {
			agentId: route.agentId,
			accountId: route.accountId,
			routeSessionKey: route.sessionKey
		},
		reply: {
			to: `zalo:${chatId}`,
			originatingTo: `zalo:${chatId}`
		},
		message: {
			body,
			bodyForAgent: rawBody,
			rawBody,
			commandBody: rawBody,
			envelopeFrom: fromLabel
		},
		media: mediaPath || mediaType ? [{
			path: mediaPath,
			url: mediaPath,
			contentType: mediaType
		}] : void 0,
		extra: {
			CommandAuthorized: commandAuthorized,
			GroupSubject: void 0
		}
	});
	const tableMode = core.channel.text.resolveMarkdownTableMode({
		cfg: config,
		channel: "zalo",
		accountId: account.accountId
	});
	await core.channel.turn.runAssembled({
		cfg: config,
		channel: "zalo",
		accountId: account.accountId,
		agentId: route.agentId,
		routeSessionKey: route.sessionKey,
		storePath,
		ctxPayload,
		recordInboundSession: core.channel.session.recordInboundSession,
		dispatchReplyWithBufferedBlockDispatcher: core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
		delivery: {
			preparePayload: (payload) => prepareZaloDurableReplyPayload({
				payload,
				tableMode,
				convertMarkdownTables: core.channel.text.convertMarkdownTables
			}),
			durable: (payload, info) => resolveZaloDurableReplyOptions({
				payload,
				infoKind: info.kind,
				chatId
			}),
			deliver: async (payload) => {
				await deliverZaloReply({
					payload,
					token,
					chatId,
					runtime,
					core,
					config,
					webhookUrl: params.webhookUrl,
					webhookPath: params.webhookPath,
					proxyUrl: account.config.proxy,
					mediaMaxBytes: params.mediaMaxMb * 1024 * 1024,
					canHostMedia: params.canHostMedia,
					accountId: account.accountId,
					statusSink,
					fetcher,
					tableMode: "off"
				});
			},
			onDelivered: () => {
				statusSink?.({ lastOutboundAt: Date.now() });
			},
			onError: (err, info) => {
				runtime.error?.(`[${account.accountId}] Zalo ${info.kind} reply failed: ${String(err)}`);
			}
		},
		replyPipeline: { typing: {
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
		} },
		record: { onRecordError: (err) => {
			runtime.error?.(`zalo: failed updating session meta: ${String(err)}`);
		} }
	});
}
async function deliverZaloReply(params) {
	const { payload, token, chatId, runtime, core, config, webhookUrl, webhookPath, proxyUrl, mediaMaxBytes, canHostMedia, accountId, statusSink, fetcher } = params;
	const tableMode = params.tableMode ?? "code";
	const reply = resolveSendableOutboundReplyParts(payload, { text: core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode) });
	const chunkMode = core.channel.text.resolveChunkMode(config, "zalo", accountId);
	await deliverTextOrMediaReply({
		payload,
		text: reply.text,
		chunkText: (value) => core.channel.text.chunkMarkdownTextWithMode(value, ZALO_TEXT_LIMIT, chunkMode),
		sendText: async (chunk) => {
			try {
				await sendMessage(token, {
					chat_id: chatId,
					text: chunk
				}, fetcher);
				statusSink?.({ lastOutboundAt: Date.now() });
			} catch (err) {
				runtime.error?.(`Zalo message send failed: ${String(err)}`);
			}
		},
		sendMedia: async ({ mediaUrl, caption }) => {
			await sendPhoto(token, {
				chat_id: chatId,
				photo: canHostMedia && webhookUrl && webhookPath ? await prepareHostedZaloMediaUrl({
					mediaUrl,
					webhookUrl,
					webhookPath,
					maxBytes: mediaMaxBytes,
					proxyUrl
				}) : mediaUrl,
				caption
			}, fetcher);
			statusSink?.({ lastOutboundAt: Date.now() });
		},
		onMediaError: (error) => {
			runtime.error?.(`Zalo photo send failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
		}
	});
}
async function monitorZaloProvider(options) {
	const { token, account, config, runtime, abortSignal, useWebhook, webhookUrl, webhookSecret, webhookPath, statusSink, fetcher: fetcherOverride } = options;
	const core = getZaloRuntime();
	const effectiveMediaMaxMb = account.config.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
	const fetcher = fetcherOverride ?? resolveZaloProxyFetch(account.config.proxy);
	const mode = useWebhook ? "webhook" : "polling";
	const effectiveWebhookUrl = normalizeWebhookUrl(webhookUrl ?? account.config.webhookUrl);
	const effectiveWebhookPath = effectiveWebhookUrl || webhookPath?.trim() || account.config.webhookPath?.trim() ? resolveWebhookPath({
		webhookPath: webhookPath ?? account.config.webhookPath,
		webhookUrl: effectiveWebhookUrl,
		defaultPath: null
	}) ?? void 0 : void 0;
	const canHostMedia = Boolean(effectiveWebhookUrl && effectiveWebhookPath);
	const hostedMediaRoutePath = canHostMedia && effectiveWebhookUrl ? resolveHostedZaloMediaRoutePrefix({
		webhookUrl: effectiveWebhookUrl,
		webhookPath: effectiveWebhookPath
	}) : void 0;
	let stopped = false;
	const stopHandlers = [];
	let cleanupWebhook;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		for (const handler of stopHandlers) handler();
	};
	const stopOnAbort = () => {
		if (!useWebhook) stop();
	};
	abortSignal.addEventListener("abort", stopOnAbort, { once: true });
	runtime.log?.(`[${account.accountId}] Zalo provider init mode=${mode} mediaMaxMb=${String(effectiveMediaMaxMb)}`);
	try {
		if (hostedMediaRoutePath) {
			const unregisterHostedMediaRoute = registerSharedHostedMediaRoute({
				path: hostedMediaRoutePath,
				accountId: account.accountId,
				log: runtime.log
			});
			stopHandlers.push(unregisterHostedMediaRoute);
		}
		if (useWebhook) {
			const { registerZaloWebhookTarget } = await loadZaloWebhookModule();
			if (!effectiveWebhookUrl || !webhookSecret) throw new Error("Zalo webhookUrl and webhookSecret are required for webhook mode");
			if (!effectiveWebhookUrl.startsWith("https://")) throw new Error("Zalo webhook URL must use HTTPS");
			if (webhookSecret.length < 8 || webhookSecret.length > 256) throw new Error("Zalo webhook secret must be 8-256 characters");
			const path = effectiveWebhookPath;
			if (!path) throw new Error("Zalo webhookPath could not be derived");
			runtime.log?.(`[${account.accountId}] Zalo configuring webhook path=${path} target=${describeWebhookTarget(effectiveWebhookUrl)}`);
			await setWebhook(token, {
				url: effectiveWebhookUrl,
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
				webhookUrl: effectiveWebhookUrl,
				webhookPath: path,
				secret: webhookSecret,
				statusSink: (patch) => statusSink?.(patch),
				mediaMaxMb: effectiveMediaMaxMb,
				canHostMedia,
				fetcher
			}, { route: {
				auth: "plugin",
				match: "exact",
				pluginId: "zalo",
				source: "zalo-webhook",
				accountId: account.accountId,
				log: runtime.log,
				handler: async (req, res) => {
					if (!await handleZaloWebhookRequest(req, res) && !res.headersSent) {
						res.statusCode = 404;
						res.setHeader("Content-Type", "text/plain; charset=utf-8");
						res.end("Not Found");
					}
				}
			} });
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
			canHostMedia,
			webhookUrl: effectiveWebhookUrl,
			webhookPath: effectiveWebhookPath,
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
		abortSignal.removeEventListener("abort", stopOnAbort);
		await cleanupWebhook?.();
		stop();
		runtime.log?.(`[${account.accountId}] Zalo provider stopped mode=${mode}`);
	}
}
//#endregion
export { monitorZaloProvider };
