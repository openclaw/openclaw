import { a as normalizeLowercaseStringOrEmpty } from "../../string-coerce-Bje8XVt9.js";
import { i as formatErrorMessage } from "../../errors-QN8rySzW.js";
import "../../text-runtime-DCigKjjg.js";
import "../../error-runtime-BAONd32e.js";
import { t as createChannelReplyPipeline } from "../../channel-reply-pipeline-DR9vcaJj.js";
import { i as getOrCreateClientManager, n as stripMarkdownForTwitch } from "./markdown-B4HhXXvs.js";
import { t as getTwitchRuntime } from "./runtime-BvT71G4m.js";
//#region extensions/twitch/src/access-control.ts
/**
* Check if a Twitch message should be allowed based on account configuration
*
* This function implements the access control logic for incoming Twitch messages,
* checking allowlists, role-based restrictions, and mention requirements.
*
* Priority order:
* 1. If `requireMention` is true, message must mention the bot
* 2. If `allowFrom` is set, sender must be in the allowlist (by user ID)
* 3. If `allowedRoles` is set (and `allowFrom` is not), sender must have at least one role
*
* Note: `allowFrom` is a hard allowlist. When set, only those user IDs are allowed.
* Use `allowedRoles` as an alternative when you don't want to maintain an allowlist.
*
* Available roles:
* - "moderator": Moderators
* - "owner": Channel owner/broadcaster
* - "vip": VIPs
* - "subscriber": Subscribers
* - "all": Anyone in the chat
*/
function checkTwitchAccessControl(params) {
	const { message, account, botUsername } = params;
	if (account.requireMention ?? true) {
		if (!extractMentions(message.message).includes(normalizeLowercaseStringOrEmpty(botUsername))) return {
			allowed: false,
			reason: "message does not mention the bot (requireMention is enabled)"
		};
	}
	if (account.allowFrom !== void 0) {
		const allowFrom = account.allowFrom;
		if (allowFrom.length === 0) return {
			allowed: false,
			reason: "sender is not in allowFrom allowlist"
		};
		const senderId = message.userId;
		if (!senderId) return {
			allowed: false,
			reason: "sender user ID not available for allowlist check"
		};
		if (allowFrom.includes(senderId)) return {
			allowed: true,
			matchKey: senderId,
			matchSource: "allowlist"
		};
		return {
			allowed: false,
			reason: "sender is not in allowFrom allowlist"
		};
	}
	if (account.allowedRoles && account.allowedRoles.length > 0) {
		const allowedRoles = account.allowedRoles;
		if (allowedRoles.includes("all")) return {
			allowed: true,
			matchKey: "all",
			matchSource: "role"
		};
		if (!checkSenderRoles({
			message,
			allowedRoles
		})) return {
			allowed: false,
			reason: `sender does not have any of the required roles: ${allowedRoles.join(", ")}`
		};
		return {
			allowed: true,
			matchKey: allowedRoles.join(","),
			matchSource: "role"
		};
	}
	return { allowed: true };
}
/**
* Check if the sender has any of the allowed roles
*/
function checkSenderRoles(params) {
	const { message, allowedRoles } = params;
	const { isMod, isOwner, isVip, isSub } = message;
	for (const role of allowedRoles) switch (role) {
		case "moderator":
			if (isMod) return true;
			break;
		case "owner":
			if (isOwner) return true;
			break;
		case "vip":
			if (isVip) return true;
			break;
		case "subscriber":
			if (isSub) return true;
			break;
	}
	return false;
}
/**
* Extract @mentions from a Twitch chat message
*
* Returns a list of lowercase usernames that were mentioned in the message.
* Twitch mentions are in the format @username.
*/
function extractMentions(message) {
	const mentionRegex = /@(\w+)/g;
	const mentions = [];
	let match;
	while ((match = mentionRegex.exec(message)) !== null) {
		const username = match[1];
		if (username) mentions.push(normalizeLowercaseStringOrEmpty(username));
	}
	return mentions;
}
//#endregion
//#region extensions/twitch/src/monitor.ts
/**
* Twitch message monitor - processes incoming messages and routes to agents.
*
* This monitor connects to the Twitch client manager, processes incoming messages,
* resolves agent routes, and handles replies.
*/
/**
* Process an incoming Twitch message and dispatch to agent.
*/
async function processTwitchMessage(params) {
	const { message, account, accountId, config, runtime, core, statusSink } = params;
	const cfg = config;
	await core.channel.turn.run({
		channel: "twitch",
		accountId,
		raw: message,
		adapter: {
			ingest: (incoming) => ({
				id: incoming.id ?? `${incoming.channel}:${incoming.timestamp?.getTime() ?? Date.now()}`,
				timestamp: incoming.timestamp?.getTime(),
				rawText: incoming.message,
				textForAgent: incoming.message,
				textForCommands: incoming.message,
				raw: incoming
			}),
			resolveTurn: (input) => {
				const route = core.channel.routing.resolveAgentRoute({
					cfg,
					channel: "twitch",
					accountId,
					peer: {
						kind: "group",
						id: message.channel
					}
				});
				const senderId = message.userId ?? message.username;
				const fromLabel = message.displayName ?? message.username;
				const body = core.channel.reply.formatAgentEnvelope({
					channel: "Twitch",
					from: fromLabel,
					timestamp: input.timestamp,
					envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
					body: input.rawText
				});
				const ctxPayload = core.channel.turn.buildContext({
					channel: "twitch",
					accountId,
					messageId: input.id,
					timestamp: input.timestamp,
					from: `twitch:user:${senderId}`,
					sender: {
						id: senderId,
						name: fromLabel,
						username: message.username
					},
					conversation: {
						kind: "group",
						id: message.channel,
						label: message.channel,
						routePeer: {
							kind: "group",
							id: message.channel
						}
					},
					route: {
						agentId: route.agentId,
						accountId: route.accountId,
						routeSessionKey: route.sessionKey
					},
					reply: {
						to: `twitch:channel:${message.channel}`,
						originatingTo: `twitch:channel:${message.channel}`
					},
					message: {
						body,
						rawBody: input.rawText,
						bodyForAgent: input.textForAgent,
						commandBody: input.textForCommands,
						envelopeFrom: fromLabel
					}
				});
				const storePath = core.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
				const tableMode = core.channel.text.resolveMarkdownTableMode({
					cfg,
					channel: "twitch",
					accountId
				});
				const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
					cfg,
					agentId: route.agentId,
					channel: "twitch",
					accountId
				});
				return {
					cfg,
					channel: "twitch",
					accountId,
					agentId: route.agentId,
					routeSessionKey: route.sessionKey,
					storePath,
					ctxPayload,
					recordInboundSession: core.channel.session.recordInboundSession,
					dispatchReplyWithBufferedBlockDispatcher: core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
					delivery: {
						deliver: async (payload) => {
							await deliverTwitchReply({
								payload,
								channel: message.channel,
								account,
								accountId,
								config,
								tableMode,
								runtime,
								statusSink
							});
						},
						onError: (err, info) => {
							runtime.error?.(`Twitch ${info.kind} reply failed: ${String(err)}`);
						}
					},
					dispatcherOptions: replyPipeline,
					replyOptions: { onModelSelected },
					record: { onRecordError: (err) => {
						runtime.error?.(`Failed updating session meta: ${String(err)}`);
					} }
				};
			}
		}
	});
}
/**
* Deliver a reply to Twitch chat.
*/
async function deliverTwitchReply(params) {
	const { payload, channel, account, accountId, config, runtime, statusSink } = params;
	try {
		const client = await getOrCreateClientManager(accountId, {
			info: (msg) => runtime.log?.(msg),
			warn: (msg) => runtime.log?.(msg),
			error: (msg) => runtime.error?.(msg),
			debug: (msg) => runtime.log?.(msg)
		}).getClient(account, config, accountId);
		if (!client) {
			runtime.error?.(`No client available for sending reply`);
			return;
		}
		if (!payload.text) {
			runtime.error?.(`No text to send in reply payload`);
			return;
		}
		const textToSend = stripMarkdownForTwitch(payload.text);
		await client.say(channel, textToSend);
		statusSink?.({ lastOutboundAt: Date.now() });
	} catch (err) {
		runtime.error?.(`Failed to send reply: ${String(err)}`);
	}
}
/**
* Main monitor provider for Twitch.
*
* Sets up message handlers and processes incoming messages.
*/
async function monitorTwitchProvider(options) {
	const { account, accountId, config, runtime, abortSignal, statusSink } = options;
	const core = getTwitchRuntime();
	let stopped = false;
	const coreLogger = core.logging.getChildLogger({ module: "twitch" });
	const logVerboseMessage = (message) => {
		if (!core.logging.shouldLogVerbose()) return;
		coreLogger.debug?.(message);
	};
	const clientManager = getOrCreateClientManager(accountId, {
		info: (msg) => coreLogger.info(msg),
		warn: (msg) => coreLogger.warn(msg),
		error: (msg) => coreLogger.error(msg),
		debug: logVerboseMessage
	});
	try {
		await clientManager.getClient(account, config, accountId);
	} catch (error) {
		const errorMsg = formatErrorMessage(error);
		runtime.error?.(`Failed to connect: ${errorMsg}`);
		throw error;
	}
	const unregisterHandler = clientManager.onMessage(account, (message) => {
		if (stopped) return;
		const botUsername = normalizeLowercaseStringOrEmpty(account.username);
		if (normalizeLowercaseStringOrEmpty(message.username) === botUsername) return;
		if (!checkTwitchAccessControl({
			message,
			account,
			botUsername
		}).allowed) return;
		statusSink?.({ lastInboundAt: Date.now() });
		processTwitchMessage({
			message,
			account,
			accountId,
			config,
			runtime,
			core,
			statusSink
		}).catch((err) => {
			runtime.error?.(`Message processing failed: ${String(err)}`);
		});
	});
	const stop = () => {
		stopped = true;
		unregisterHandler();
	};
	abortSignal.addEventListener("abort", stop, { once: true });
	return { stop };
}
//#endregion
export { monitorTwitchProvider };
