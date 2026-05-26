import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, l as normalizeOptionalStringifiedId } from "./string-coerce-DyL154ka.js";
import { p as resolvePayloadMediaUrls, w as createReplyToFanout, x as sendTextMediaPayload, y as sendPayloadMediaSequenceOrFallback } from "./reply-payload-DMPQsrQC.js";
import { n as retryAsync, t as resolveRetryConfig } from "./retry-CryZAmlE.js";
import { n as resolveOutboundSendDep } from "./send-deps-B-rmeTVl.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./outbound-runtime-CGgaScW3.js";
import { i as createAttachedChannelResultAdapter, t as attachChannelToResult } from "./channel-send-result-swFdRKhg.js";
import "./retry-runtime-BLxc3H40.js";
import { s as resolveDiscordAccount } from "./accounts-DIRzXd2H.js";
import { m as DiscordError } from "./discord-Cn5UmvYW.js";
import { t as chunkDiscordTextWithMode } from "./chunk-CixrDxH0.js";
import { i as normalizeDiscordOutboundTarget } from "./normalize-CECmG1sg.js";
import { t as createDiscordSendReceipt } from "./send.receipt-qNc0Gu3O.js";
import { s as readDiscordComponentSpec } from "./components-C72anMl6.js";
import { n as notifyDiscordInboundEventOutboundPayloadSuccess } from "./inbound-event-delivery-DTGIjZVJ.js";
//#region extensions/discord/src/delivery-retry.ts
const DISCORD_DELIVERY_RETRY_DEFAULTS = {
	attempts: 3,
	minDelayMs: 1e3,
	maxDelayMs: 3e4,
	jitter: 0
};
function isRetryableDiscordDeliveryError(err) {
	if (err instanceof DiscordError) return false;
	const status = err.status ?? err.statusCode;
	return status === 429 || status !== void 0 && status >= 500;
}
function getDiscordDeliveryRetryAfterMs(err) {
	if (!err || typeof err !== "object") return;
	if ("retryAfter" in err && typeof err.retryAfter === "number" && Number.isFinite(err.retryAfter)) return err.retryAfter * 1e3;
	const retryAfterRaw = err.headers?.["retry-after"];
	if (!retryAfterRaw) return;
	const retryAfterMs = Number(retryAfterRaw) * 1e3;
	return Number.isFinite(retryAfterMs) ? retryAfterMs : void 0;
}
async function withDiscordDeliveryRetry(params) {
	const retryConfig = resolveRetryConfig(DISCORD_DELIVERY_RETRY_DEFAULTS, resolveDiscordAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).config.retry);
	return await retryAsync(params.fn, {
		...retryConfig,
		shouldRetry: (err) => isRetryableDiscordDeliveryError(err),
		retryAfterMs: getDiscordDeliveryRetryAfterMs
	});
}
//#endregion
//#region extensions/discord/src/media-detection.ts
const DISCORD_VIDEO_MEDIA_EXTENSIONS = new Set([
	".avi",
	".m4v",
	".mkv",
	".mov",
	".mp4",
	".webm"
]);
function normalizeMediaPathForExtension(mediaUrl) {
	const trimmed = mediaUrl.trim();
	if (!trimmed) return "";
	try {
		return normalizeLowercaseStringOrEmpty(new URL(trimmed).pathname);
	} catch {
		const withoutHash = trimmed.split("#", 1)[0] ?? trimmed;
		return normalizeLowercaseStringOrEmpty(withoutHash.split("?", 1)[0] ?? withoutHash);
	}
}
function isLikelyDiscordVideoMedia(mediaUrl) {
	const normalized = normalizeMediaPathForExtension(mediaUrl);
	for (const ext of DISCORD_VIDEO_MEDIA_EXTENSIONS) if (normalized.endsWith(ext)) return true;
	return false;
}
//#endregion
//#region extensions/discord/src/outbound-approval.ts
function hasApprovalChannelData(payload) {
	const channelData = payload.channelData;
	if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) return false;
	return Boolean(channelData.execApproval);
}
function neutralizeDiscordApprovalMentions(value) {
	return value.replace(/@everyone/gi, "@​everyone").replace(/@here/gi, "@​here").replace(/<@/g, "<@​").replace(/<#/g, "<#​");
}
function normalizeDiscordApprovalPayload(payload) {
	return hasApprovalChannelData(payload) && payload.text ? {
		...payload,
		text: neutralizeDiscordApprovalMentions(payload.text)
	} : payload;
}
//#endregion
//#region extensions/discord/src/outbound-components.ts
let discordComponentSendPromise;
let discordSharedInteractivePromise;
async function sendDiscordComponentMessageLazy(...args) {
	discordComponentSendPromise ??= import("./send.components-DvrQA8Gk.js").then((module) => module.sendDiscordComponentMessage);
	return await (await discordComponentSendPromise)(...args);
}
function loadDiscordSharedInteractive() {
	discordSharedInteractivePromise ??= import("./shared-interactive-jag5Q_6I.js");
	return discordSharedInteractivePromise;
}
function addPayloadTextFallback(spec, payload) {
	return spec.text ? spec : {
		...spec,
		text: payload.text?.trim() ? payload.text : void 0
	};
}
async function buildDiscordPresentationPayload(params) {
	const componentSpec = (await loadDiscordSharedInteractive()).buildDiscordPresentationComponents(params.presentation);
	if (!componentSpec) return null;
	return {
		...params.payload,
		channelData: {
			...params.payload.channelData,
			discord: {
				...params.payload.channelData?.discord,
				presentationComponents: componentSpec
			}
		}
	};
}
async function resolveDiscordComponentSpec(payload) {
	const discordData = payload.channelData?.discord;
	const rawComponentSpec = discordData?.presentationComponents ?? (discordData?.components && typeof discordData.components === "object" && !Array.isArray(discordData.components) ? readDiscordComponentSpec(discordData.components) : null);
	if (rawComponentSpec) return addPayloadTextFallback(rawComponentSpec, payload);
	if (!payload.interactive) return;
	const interactiveSpec = (await loadDiscordSharedInteractive()).buildDiscordInteractiveComponents(payload.interactive);
	return interactiveSpec ? addPayloadTextFallback(interactiveSpec, payload) : void 0;
}
//#endregion
//#region extensions/discord/src/outbound-send-context.ts
let discordSendRuntimePromise;
async function loadDiscordSendRuntime() {
	discordSendRuntimePromise ??= import("./send-ug-iTBRu.js");
	return await discordSendRuntimePromise;
}
function resolveDiscordOutboundTarget(params) {
	if (params.threadId == null) return params.to;
	const threadId = normalizeOptionalStringifiedId(params.threadId) ?? "";
	if (!threadId) return params.to;
	return `channel:${threadId}`;
}
function resolveDiscordFormattingOptions(ctx) {
	const formatting = ctx.formatting;
	return {
		textLimit: formatting?.textLimit,
		maxLinesPerMessage: formatting?.maxLinesPerMessage,
		tableMode: formatting?.tableMode,
		chunkMode: formatting?.chunkMode
	};
}
async function createDiscordPayloadSendContext(ctx) {
	const runtime = await loadDiscordSendRuntime();
	return {
		target: resolveDiscordOutboundTarget({
			to: ctx.to,
			threadId: ctx.threadId
		}),
		formatting: resolveDiscordFormattingOptions(ctx),
		resolveReplyTo: createReplyToFanout({
			replyToId: ctx.replyToId,
			replyToIdSource: ctx.replyToIdSource,
			replyToMode: ctx.replyToMode
		}),
		send: resolveOutboundSendDep(ctx.deps, "discord") ?? runtime.sendMessageDiscord,
		sendVoice: resolveOutboundSendDep(ctx.deps, "discordVoice") ?? runtime.sendVoiceMessageDiscord,
		withRetry: async (fn) => await withDiscordDeliveryRetry({
			cfg: ctx.cfg,
			accountId: ctx.accountId,
			fn
		})
	};
}
//#endregion
//#region extensions/discord/src/outbound-payload.ts
async function sendDiscordOutboundPayload(params) {
	const ctx = params.ctx;
	const payload = normalizeDiscordApprovalPayload({
		...ctx.payload,
		text: ctx.payload.text ?? ""
	});
	const mediaUrls = resolvePayloadMediaUrls(payload);
	const sendContext = await createDiscordPayloadSendContext(ctx);
	if (payload.audioAsVoice && mediaUrls.length > 0) {
		let lastResult = await sendContext.withRetry(async () => await sendContext.sendVoice(sendContext.target, mediaUrls[0], {
			cfg: ctx.cfg,
			replyTo: sendContext.resolveReplyTo(),
			accountId: ctx.accountId ?? void 0,
			silent: ctx.silent ?? void 0
		}));
		if (payload.text?.trim()) lastResult = await sendContext.withRetry(async () => await sendContext.send(sendContext.target, payload.text, {
			verbose: false,
			replyTo: sendContext.resolveReplyTo(),
			accountId: ctx.accountId ?? void 0,
			silent: ctx.silent ?? void 0,
			cfg: ctx.cfg,
			...sendContext.formatting
		}));
		for (const mediaUrl of mediaUrls.slice(1)) lastResult = await sendContext.withRetry(async () => await sendContext.send(sendContext.target, "", {
			verbose: false,
			mediaUrl,
			mediaAccess: ctx.mediaAccess,
			mediaLocalRoots: ctx.mediaLocalRoots,
			mediaReadFile: ctx.mediaReadFile,
			replyTo: sendContext.resolveReplyTo(),
			accountId: ctx.accountId ?? void 0,
			silent: ctx.silent ?? void 0,
			cfg: ctx.cfg,
			...sendContext.formatting
		}));
		return attachChannelToResult("discord", lastResult);
	}
	const componentSpec = await resolveDiscordComponentSpec(payload);
	if (!componentSpec) {
		const discordData = payload.channelData?.discord && typeof payload.channelData.discord === "object" && !Array.isArray(payload.channelData.discord) ? payload.channelData.discord : {};
		const nativeComponents = Array.isArray(discordData.components) ? discordData.components : void 0;
		const embeds = Array.isArray(discordData.embeds) ? discordData.embeds : void 0;
		const filename = normalizeOptionalString(discordData.filename);
		if (nativeComponents || embeds?.length || filename) return attachChannelToResult("discord", await sendPayloadMediaSequenceOrFallback({
			text: payload.text ?? "",
			mediaUrls,
			fallbackResult: {
				messageId: "",
				channelId: sendContext.target,
				receipt: createDiscordSendReceipt({
					platformMessageIds: [],
					channelId: sendContext.target,
					kind: "unknown"
				})
			},
			sendNoMedia: async () => await sendContext.withRetry(async () => await sendContext.send(sendContext.target, payload.text ?? "", {
				verbose: false,
				components: nativeComponents,
				embeds,
				filename,
				replyTo: sendContext.resolveReplyTo(),
				accountId: ctx.accountId ?? void 0,
				silent: ctx.silent ?? void 0,
				cfg: ctx.cfg,
				...sendContext.formatting
			})),
			send: async ({ text, mediaUrl, isFirst }) => await sendContext.withRetry(async () => await sendContext.send(sendContext.target, text, {
				verbose: false,
				mediaUrl,
				mediaAccess: ctx.mediaAccess,
				mediaLocalRoots: ctx.mediaLocalRoots,
				mediaReadFile: ctx.mediaReadFile,
				components: isFirst ? nativeComponents : void 0,
				embeds: isFirst ? embeds : void 0,
				filename: isFirst ? filename : void 0,
				replyTo: sendContext.resolveReplyTo(),
				accountId: ctx.accountId ?? void 0,
				silent: ctx.silent ?? void 0,
				cfg: ctx.cfg,
				...sendContext.formatting
			}))
		}));
		return await sendTextMediaPayload({
			channel: "discord",
			ctx: {
				...ctx,
				payload
			},
			adapter: params.fallbackAdapter
		});
	}
	return attachChannelToResult("discord", await sendPayloadMediaSequenceOrFallback({
		text: payload.text ?? "",
		mediaUrls,
		fallbackResult: {
			messageId: "",
			channelId: sendContext.target,
			receipt: createDiscordSendReceipt({
				platformMessageIds: [],
				channelId: sendContext.target,
				kind: "unknown"
			})
		},
		sendNoMedia: async () => await sendContext.withRetry(async () => await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
			replyTo: sendContext.resolveReplyTo(),
			accountId: ctx.accountId ?? void 0,
			silent: ctx.silent ?? void 0,
			cfg: ctx.cfg,
			...sendContext.formatting
		})),
		send: async ({ text, mediaUrl, isFirst }) => {
			if (isFirst) return await sendContext.withRetry(async () => await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
				mediaUrl,
				mediaAccess: ctx.mediaAccess,
				mediaLocalRoots: ctx.mediaLocalRoots,
				mediaReadFile: ctx.mediaReadFile,
				replyTo: sendContext.resolveReplyTo(),
				accountId: ctx.accountId ?? void 0,
				silent: ctx.silent ?? void 0,
				cfg: ctx.cfg,
				...sendContext.formatting
			}));
			return await sendContext.withRetry(async () => await sendContext.send(sendContext.target, text, {
				verbose: false,
				mediaUrl,
				mediaAccess: ctx.mediaAccess,
				mediaLocalRoots: ctx.mediaLocalRoots,
				mediaReadFile: ctx.mediaReadFile,
				replyTo: sendContext.resolveReplyTo(),
				accountId: ctx.accountId ?? void 0,
				silent: ctx.silent ?? void 0,
				cfg: ctx.cfg,
				...sendContext.formatting
			}));
		}
	}));
}
//#endregion
//#region extensions/discord/src/outbound-adapter.ts
const DISCORD_TEXT_CHUNK_LIMIT = 2e3;
const DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_BLOCK_RE = /<\s*(system-reminder|previous_response)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_SELF_CLOSING_RE = /<\s*(?:system-reminder|previous_response)\b[^>]*\/\s*>/gi;
const DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_TAG_RE = /<\s*\/?\s*(?:system-reminder|previous_response)\b[^>]*>/gi;
function stripDiscordInternalRuntimeScaffolding(text) {
	return text.replace(DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_BLOCK_RE, "").replace(DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_SELF_CLOSING_RE, "").replace(DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_TAG_RE, "");
}
let discordThreadBindingsPromise;
function loadDiscordThreadBindings() {
	discordThreadBindingsPromise ??= import("./thread-bindings-bKCNliiW.js");
	return discordThreadBindingsPromise;
}
function resolveDiscordWebhookIdentity(params) {
	const usernameRaw = normalizeOptionalString(params.identity?.name);
	const fallbackUsername = normalizeOptionalString(params.binding.label) ?? params.binding.agentId;
	return {
		username: (usernameRaw || fallbackUsername || "").slice(0, 80) || void 0,
		avatarUrl: normalizeOptionalString(params.identity?.avatarUrl)
	};
}
async function maybeSendDiscordWebhookText(params) {
	if (params.threadId == null) return null;
	const threadId = normalizeOptionalStringifiedId(params.threadId) ?? "";
	if (!threadId) return null;
	const { getThreadBindingManager } = await loadDiscordThreadBindings();
	const manager = getThreadBindingManager(params.accountId ?? void 0);
	if (!manager) return null;
	const binding = manager.getByThreadId(threadId);
	if (!binding?.webhookId || !binding?.webhookToken) return null;
	const persona = resolveDiscordWebhookIdentity({
		identity: params.identity,
		binding
	});
	const { sendWebhookMessageDiscord } = await loadDiscordSendRuntime();
	return await sendWebhookMessageDiscord(params.text, {
		webhookId: binding.webhookId,
		webhookToken: binding.webhookToken,
		accountId: binding.accountId,
		threadId: binding.threadId,
		cfg: params.cfg,
		replyTo: params.replyToId ?? void 0,
		username: persona.username,
		avatarUrl: persona.avatarUrl
	});
}
const discordOutbound = {
	deliveryMode: "direct",
	chunker: (text, limit, ctx) => chunkDiscordTextWithMode(text, {
		maxChars: limit,
		maxLines: ctx?.formatting?.maxLinesPerMessage
	}),
	textChunkLimit: DISCORD_TEXT_CHUNK_LIMIT,
	sanitizeText: ({ text }) => stripDiscordInternalRuntimeScaffolding(text),
	pollMaxOptions: 10,
	normalizePayload: ({ payload }) => normalizeDiscordApprovalPayload(payload),
	presentationCapabilities: {
		supported: true,
		buttons: true,
		selects: true,
		context: true,
		divider: true,
		limits: {
			actions: {
				maxActions: 25,
				maxActionsPerRow: 5,
				maxRows: 5,
				maxLabelLength: 80,
				supportsDisabled: true
			},
			selects: {
				maxOptions: 25,
				maxLabelLength: 100,
				maxValueBytes: 100
			},
			text: {
				maxLength: DISCORD_TEXT_CHUNK_LIMIT,
				encoding: "characters",
				markdownDialect: "discord-markdown"
			}
		}
	},
	deliveryCapabilities: { durableFinal: {
		text: true,
		media: true,
		poll: true,
		payload: true,
		silent: true,
		replyTo: true,
		thread: true,
		messageSendingHooks: true
	} },
	renderPresentation: async ({ payload, presentation }) => {
		return await buildDiscordPresentationPayload({
			payload,
			presentation
		});
	},
	resolveTarget: ({ to, allowFrom }) => normalizeDiscordOutboundTarget(to, allowFrom),
	sendPayload: async (ctx) => await sendDiscordOutboundPayload({
		ctx,
		fallbackAdapter: discordOutbound
	}),
	...createAttachedChannelResultAdapter({
		channel: "discord",
		sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, identity, silent, formatting }) => {
			if (!silent) {
				const webhookResult = await maybeSendDiscordWebhookText({
					cfg,
					text,
					threadId,
					accountId,
					identity,
					replyToId
				}).catch(() => null);
				if (webhookResult) return webhookResult;
			}
			const send = resolveOutboundSendDep(deps, "discord") ?? (await loadDiscordSendRuntime()).sendMessageDiscord;
			return await withDiscordDeliveryRetry({
				cfg,
				accountId,
				fn: async () => await send(resolveDiscordOutboundTarget({
					to,
					threadId
				}), text, {
					verbose: false,
					replyTo: replyToId ?? void 0,
					accountId: accountId ?? void 0,
					silent: silent ?? void 0,
					cfg,
					...resolveDiscordFormattingOptions({ formatting })
				})
			});
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, audioAsVoice, mediaAccess, mediaLocalRoots, mediaReadFile, accountId, deps, replyToId, threadId, silent, formatting }) => {
			const send = resolveOutboundSendDep(deps, "discord") ?? (await loadDiscordSendRuntime()).sendMessageDiscord;
			const target = resolveDiscordOutboundTarget({
				to,
				threadId
			});
			const formattingOptions = resolveDiscordFormattingOptions({ formatting });
			if (audioAsVoice && mediaUrl) {
				const sendVoice = resolveOutboundSendDep(deps, "discordVoice") ?? (await loadDiscordSendRuntime()).sendVoiceMessageDiscord;
				return await withDiscordDeliveryRetry({
					cfg,
					accountId,
					fn: async () => await sendVoice(target, mediaUrl, {
						cfg,
						replyTo: replyToId ?? void 0,
						accountId: accountId ?? void 0,
						silent: silent ?? void 0
					})
				});
			}
			if (text.trim() && mediaUrl && isLikelyDiscordVideoMedia(mediaUrl)) {
				await withDiscordDeliveryRetry({
					cfg,
					accountId,
					fn: async () => await send(target, text, {
						verbose: false,
						replyTo: replyToId ?? void 0,
						accountId: accountId ?? void 0,
						silent: silent ?? void 0,
						cfg,
						...formattingOptions
					})
				});
				return await withDiscordDeliveryRetry({
					cfg,
					accountId,
					fn: async () => await send(target, "", {
						verbose: false,
						mediaUrl,
						mediaAccess,
						mediaLocalRoots,
						mediaReadFile,
						accountId: accountId ?? void 0,
						silent: silent ?? void 0,
						cfg,
						...formattingOptions
					})
				});
			}
			return await withDiscordDeliveryRetry({
				cfg,
				accountId,
				fn: async () => await send(target, text, {
					verbose: false,
					mediaUrl,
					mediaAccess,
					mediaLocalRoots,
					mediaReadFile,
					replyTo: replyToId ?? void 0,
					accountId: accountId ?? void 0,
					silent: silent ?? void 0,
					cfg,
					...formattingOptions
				})
			});
		},
		sendPoll: async ({ cfg, to, poll, accountId, threadId, silent }) => await withDiscordDeliveryRetry({
			cfg,
			accountId,
			fn: async () => await (await loadDiscordSendRuntime()).sendPollDiscord(resolveDiscordOutboundTarget({
				to,
				threadId
			}), poll, {
				accountId: accountId ?? void 0,
				silent: silent ?? void 0,
				cfg
			})
		})
	}),
	afterDeliverPayload: async ({ target, payload }) => {
		notifyDiscordInboundEventOutboundPayloadSuccess({
			payload,
			to: resolveDiscordOutboundTarget({
				to: target.to,
				threadId: target.threadId
			}),
			accountId: target.accountId
		});
		const threadId = normalizeOptionalStringifiedId(target.threadId);
		if (!threadId) return;
		const { getThreadBindingManager } = await loadDiscordThreadBindings();
		const manager = getThreadBindingManager(target.accountId ?? void 0);
		if (!manager?.getByThreadId(threadId)) return;
		manager.touchThread({ threadId });
	}
};
//#endregion
export { discordOutbound as n, DISCORD_TEXT_CHUNK_LIMIT as t };
