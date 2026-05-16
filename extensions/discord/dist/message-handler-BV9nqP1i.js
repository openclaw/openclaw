import { N as createDiscordRestClient } from "./send.shared-e9Pd_Em0.js";
import { a as resolveDiscordChannelParentSafe, n as resolveDiscordChannelInfoSafe, r as resolveDiscordChannelNameSafe, t as resolveDiscordChannelIdSafe } from "./channel-access-ewDxhd9q.js";
import { a as mergeAbortSignals } from "./timeouts-C7jeTtGs.js";
import { l as resolveDiscordMessageChannelId, r as resolveDiscordMessageText, s as hasDiscordMessageStickers } from "./message-utils-Dmgu-7fC.js";
import { t as sendTyping } from "./typing-BSi1dUHm.js";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { resolveBatchedReplyThreadingPolicy } from "openclaw/plugin-sdk/reply-reference";
import { createChannelInboundDebouncer, shouldDebounceTextInbound } from "openclaw/plugin-sdk/channel-inbound";
import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { createChannelRunQueue } from "openclaw/plugin-sdk/channel-lifecycle";
//#region extensions/discord/src/monitor/inbound-dedupe.ts
const RECENT_DISCORD_MESSAGE_TTL_MS = 5 * 6e4;
const RECENT_DISCORD_MESSAGE_MAX = 5e3;
function createDiscordInboundReplayGuard() {
	return createClaimableDedupe({
		ttlMs: RECENT_DISCORD_MESSAGE_TTL_MS,
		memoryMaxSize: RECENT_DISCORD_MESSAGE_MAX
	});
}
var DiscordRetryableInboundError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = "DiscordRetryableInboundError";
	}
};
function buildDiscordInboundReplayKey(params) {
	const messageId = params.data.message?.id?.trim();
	if (!messageId) return null;
	const channelId = resolveDiscordMessageChannelId({
		message: params.data.message,
		eventChannelId: params.data.channel_id
	});
	if (!channelId) return null;
	return `${params.accountId}:${channelId}:${messageId}`;
}
async function claimDiscordInboundReplay(params) {
	const replayKey = params.replayKey?.trim();
	if (!replayKey) return true;
	return (await params.replayGuard.claim(replayKey)).kind === "claimed";
}
async function commitDiscordInboundReplay(params) {
	const replayKeys = normalizeDiscordInboundReplayKeys(params.replayKeys);
	await Promise.all(replayKeys.map((replayKey) => params.replayGuard.commit(replayKey)));
}
function releaseDiscordInboundReplay(params) {
	normalizeDiscordInboundReplayKeys(params.replayKeys).forEach((replayKey) => params.replayGuard.release(replayKey, { error: params.error }));
}
function normalizeDiscordInboundReplayKeys(replayKeys) {
	return [...new Set((replayKeys ?? []).map((replayKey) => replayKey?.trim()).filter((replayKey) => Boolean(replayKey)))];
}
//#endregion
//#region extensions/discord/src/monitor/inbound-job.ts
function resolveDiscordInboundJobQueueKey(ctx) {
	const sessionKey = ctx.route.sessionKey?.trim();
	if (sessionKey) return sessionKey;
	const baseSessionKey = ctx.baseSessionKey?.trim();
	if (baseSessionKey) return baseSessionKey;
	return ctx.messageChannelId;
}
function buildDiscordInboundJob(ctx, options) {
	const { runtime, abortSignal, guildHistories, client, threadBindings, discordRestFetch, message, data, threadChannel, ...payload } = ctx;
	const sanitizedMessage = sanitizeDiscordInboundMessage(message);
	return {
		queueKey: resolveDiscordInboundJobQueueKey(ctx),
		payload: {
			...payload,
			message: sanitizedMessage,
			data: {
				...data,
				message: sanitizedMessage
			},
			threadChannel: normalizeDiscordThreadChannel(threadChannel)
		},
		runtime: {
			runtime,
			abortSignal,
			guildHistories,
			client,
			threadBindings,
			discordRestFetch
		},
		replayKeys: options?.replayKeys ? [...options.replayKeys] : void 0
	};
}
function materializeDiscordInboundJob(job, abortSignal) {
	return {
		...job.payload,
		...job.runtime,
		abortSignal: abortSignal ?? job.runtime.abortSignal
	};
}
function sanitizeDiscordInboundMessage(message) {
	const descriptors = Object.getOwnPropertyDescriptors(message);
	delete descriptors.channel;
	return Object.create(Object.getPrototypeOf(message), descriptors);
}
function normalizeDiscordThreadChannel(threadChannel) {
	if (!threadChannel) return null;
	const channelInfo = resolveDiscordChannelInfoSafe(threadChannel);
	const parent = resolveDiscordChannelParentSafe(threadChannel);
	return {
		id: threadChannel.id,
		name: channelInfo.name,
		parentId: channelInfo.parentId,
		parent: parent ? {
			id: resolveDiscordChannelIdSafe(parent),
			name: resolveDiscordChannelNameSafe(parent)
		} : void 0,
		ownerId: channelInfo.ownerId
	};
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.batch-gate.ts
function applyImplicitReplyBatchGate(ctx, replyToMode, isBatched) {
	const replyThreading = resolveBatchedReplyThreadingPolicy(replyToMode, isBatched);
	if (!replyThreading) return;
	ctx.ReplyThreading = replyThreading;
}
//#endregion
//#region extensions/discord/src/monitor/message-run-queue.ts
let messageProcessRuntimePromise;
async function loadMessageProcessRuntime() {
	messageProcessRuntimePromise ??= import("./message-handler.process-CXLov68f.js");
	return await messageProcessRuntimePromise;
}
async function processDiscordQueuedMessage(params) {
	const processDiscordMessageImpl = params.testing?.processDiscordMessage ?? (await loadMessageProcessRuntime()).processDiscordMessage;
	const abortSignal = mergeAbortSignals([params.job.runtime.abortSignal, params.lifecycleSignal]);
	try {
		await processDiscordMessageImpl(materializeDiscordInboundJob(params.job, abortSignal));
		await commitDiscordInboundReplay({
			replayKeys: params.job.replayKeys,
			replayGuard: params.replayGuard
		});
	} catch (error) {
		if (error instanceof DiscordRetryableInboundError) releaseDiscordInboundReplay({
			replayKeys: params.job.replayKeys,
			error,
			replayGuard: params.replayGuard
		});
		else await commitDiscordInboundReplay({
			replayKeys: params.job.replayKeys,
			replayGuard: params.replayGuard
		});
		throw error;
	}
}
function createDiscordMessageRunQueue(params) {
	const replayGuard = params.replayGuard ?? createDiscordInboundReplayGuard();
	const runQueue = createChannelRunQueue({
		setStatus: params.setStatus,
		abortSignal: params.abortSignal,
		onError: (error) => {
			params.runtime.error?.(danger(`discord message run failed: ${String(error)}`));
		}
	});
	return {
		enqueue(job) {
			runQueue.enqueue(job.queueKey, async ({ lifecycleSignal }) => {
				await processDiscordQueuedMessage({
					job,
					lifecycleSignal,
					replayGuard,
					testing: params.__testing
				});
			});
		},
		deactivate: runQueue.deactivate
	};
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.ts
let messagePreflightRuntimePromise;
async function loadMessagePreflightRuntime() {
	messagePreflightRuntimePromise ??= import("./message-handler.preflight-BsvNIDEw.js");
	return await messagePreflightRuntimePromise;
}
function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}
function shouldSendAcceptedDiscordTypingCue(ctx) {
	if (ctx.abortSignal?.aborted) return false;
	if (!ctx.isDirectMessage || ctx.isGuildMessage || ctx.isGroupDm) return false;
	if (!ctx.messageText.trim()) return false;
	const configuredTypingMode = ctx.cfg.session?.typingMode ?? ctx.cfg.agents?.defaults?.typingMode;
	return configuredTypingMode === void 0 || configuredTypingMode === "instant";
}
function queueAcceptedDiscordTypingCue(ctx) {
	if (!shouldSendAcceptedDiscordTypingCue(ctx)) return;
	const { rest } = createDiscordRestClient({
		cfg: ctx.cfg,
		token: ctx.token,
		accountId: ctx.accountId
	});
	sendTyping({
		rest,
		channelId: ctx.messageChannelId
	}).catch((err) => {
		logVerbose(`discord early typing cue failed for channel ${ctx.messageChannelId}: ${String(err)}`);
	});
}
function createDiscordMessageHandler(params) {
	const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: params.cfg.channels?.discord !== void 0,
		groupPolicy: params.discordConfig?.groupPolicy,
		defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy
	});
	const ackReactionScope = params.discordConfig?.ackReactionScope ?? params.cfg.messages?.ackReactionScope ?? "group-mentions";
	const preflightDiscordMessageImpl = params.__testing?.preflightDiscordMessage;
	const replayGuard = createDiscordInboundReplayGuard();
	const messageRunQueue = createDiscordMessageRunQueue({
		runtime: params.runtime,
		setStatus: params.setStatus,
		abortSignal: params.abortSignal,
		replayGuard,
		__testing: params.__testing
	});
	const { debouncer } = createChannelInboundDebouncer({
		cfg: params.cfg,
		channel: "discord",
		buildKey: (entry) => {
			const message = entry.data.message;
			const authorId = entry.data.author?.id;
			if (!message || !authorId) return null;
			const channelId = resolveDiscordMessageChannelId({
				message,
				eventChannelId: entry.data.channel_id
			});
			if (!channelId) return null;
			return `discord:${params.accountId}:${channelId}:${authorId}`;
		},
		shouldDebounce: (entry) => {
			const message = entry.data.message;
			if (!message) return false;
			return shouldDebounceTextInbound({
				text: resolveDiscordMessageText(message, { includeForwarded: false }),
				cfg: params.cfg,
				hasMedia: message.attachments && message.attachments.length > 0 || hasDiscordMessageStickers(message)
			});
		},
		onFlush: async (entries) => {
			const last = entries.at(-1);
			if (!last) return;
			const replayKeys = entries.map((entry) => entry.replayKey).filter(isNonEmptyString);
			const abortSignal = last.abortSignal;
			if (abortSignal?.aborted) {
				releaseDiscordInboundReplay({
					replayKeys,
					error: abortSignal.reason,
					replayGuard
				});
				return;
			}
			try {
				if (entries.length === 1) {
					const ctx = await (preflightDiscordMessageImpl ?? (await loadMessagePreflightRuntime()).preflightDiscordMessage)({
						...params,
						ackReactionScope,
						groupPolicy,
						abortSignal,
						data: last.data,
						client: last.client
					});
					if (!ctx) {
						await commitDiscordInboundReplay({
							replayKeys,
							replayGuard
						});
						return;
					}
					applyImplicitReplyBatchGate(ctx, params.replyToMode, false);
					queueAcceptedDiscordTypingCue(ctx);
					messageRunQueue.enqueue(buildDiscordInboundJob(ctx, { replayKeys }));
					return;
				}
				const combinedBaseText = entries.map((entry) => resolveDiscordMessageText(entry.data.message, { includeForwarded: false })).filter(Boolean).join("\n");
				const syntheticMessage = Object.create(Object.getPrototypeOf(last.data.message), {
					...Object.getOwnPropertyDescriptors(last.data.message),
					content: {
						value: combinedBaseText,
						enumerable: true,
						configurable: true
					},
					attachments: {
						value: [],
						enumerable: true,
						configurable: true
					},
					message_snapshots: {
						value: last.data.message.message_snapshots,
						enumerable: true,
						configurable: true
					},
					messageSnapshots: {
						value: last.data.message.messageSnapshots,
						enumerable: true,
						configurable: true
					},
					rawData: {
						value: { ...last.data.message.rawData },
						enumerable: true,
						configurable: true
					}
				});
				const syntheticData = {
					...last.data,
					message: syntheticMessage
				};
				const ctx = await (preflightDiscordMessageImpl ?? (await loadMessagePreflightRuntime()).preflightDiscordMessage)({
					...params,
					ackReactionScope,
					groupPolicy,
					abortSignal,
					data: syntheticData,
					client: last.client
				});
				if (!ctx) {
					await commitDiscordInboundReplay({
						replayKeys,
						replayGuard
					});
					return;
				}
				applyImplicitReplyBatchGate(ctx, params.replyToMode, true);
				if (entries.length > 1) {
					const ids = entries.map((entry) => entry.data.message?.id).filter(isNonEmptyString);
					if (ids.length > 0) {
						const ctxBatch = ctx;
						ctxBatch.MessageSids = ids;
						ctxBatch.MessageSidFirst = ids[0];
						ctxBatch.MessageSidLast = ids[ids.length - 1];
					}
				}
				queueAcceptedDiscordTypingCue(ctx);
				messageRunQueue.enqueue(buildDiscordInboundJob(ctx, { replayKeys }));
			} catch (error) {
				if (error instanceof DiscordRetryableInboundError) releaseDiscordInboundReplay({
					replayKeys,
					error,
					replayGuard
				});
				else await commitDiscordInboundReplay({
					replayKeys,
					replayGuard
				});
				throw error;
			}
		},
		onError: (err) => {
			params.runtime.error?.(danger(`discord debounce flush failed: ${String(err)}`));
		}
	});
	const handler = async (data, client, options) => {
		try {
			if (options?.abortSignal?.aborted) return;
			const msgAuthorId = data.message?.author?.id ?? data.author?.id;
			if (params.botUserId && msgAuthorId === params.botUserId) return;
			const replayKey = buildDiscordInboundReplayKey({
				accountId: params.accountId,
				data
			});
			if (!await claimDiscordInboundReplay({
				replayKey,
				replayGuard
			})) return;
			await debouncer.enqueue({
				data,
				client,
				abortSignal: options?.abortSignal,
				replayKey: replayKey ?? void 0
			});
		} catch (err) {
			params.runtime.error?.(danger(`handler failed: ${String(err)}`));
		}
	};
	handler.deactivate = messageRunQueue.deactivate;
	return handler;
}
//#endregion
export { createDiscordMessageHandler as t };
