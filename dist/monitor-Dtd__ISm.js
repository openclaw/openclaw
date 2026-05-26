import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { c as defineStableChannelIngressIdentity, n as createChannelIngressResolver } from "./runtime-BUVuto5K.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./channel-ingress-runtime-C3bbz3sX.js";
import { i as getOrCreateClientManager, n as stripMarkdownForTwitch } from "./markdown-DzM1YirL.js";
import { t as getTwitchRuntime } from "./runtime-Cxblw3e5.js";
//#region extensions/twitch/src/access-control.ts
const twitchUserIdentity = defineStableChannelIngressIdentity({
	key: "sender-id",
	entryIdPrefix: "twitch-user-entry"
});
const twitchRoleIdentity = defineStableChannelIngressIdentity({
	key: "role-moderator",
	kind: "role",
	normalizeEntry: normalizeTwitchRole,
	normalizeSubject: normalizeTwitchRole,
	aliases: [
		"owner",
		"vip",
		"subscriber"
	].map((role) => ({
		key: `role-${role}`,
		kind: "role",
		normalizeEntry: () => null,
		normalizeSubject: normalizeTwitchRole
	})),
	isWildcardEntry: (entry) => normalizeTwitchRole(entry) === "all",
	resolveEntryId: ({ entryIndex }) => `twitch-role-entry-${entryIndex + 1}`
});
async function checkTwitchAccessControl(params) {
	const { message, account, botUsername } = params;
	const policyKind = resolveTwitchPolicyKind(account);
	const decision = (await createChannelIngressResolver({
		channelId: "twitch",
		accountId: "default",
		identity: policyKind === "role" ? twitchRoleIdentity : twitchUserIdentity
	}).message({
		subject: policyKind === "role" ? twitchRoleSubject(message) : { stableId: message.userId },
		conversation: {
			kind: "group",
			id: message.channel
		},
		event: { mayPair: false },
		mentionFacts: {
			canDetectMention: true,
			wasMentioned: mentionsBot(message.message, botUsername)
		},
		dmPolicy: "open",
		groupPolicy: policyKind === "open" ? "open" : "allowlist",
		policy: { activation: {
			requireMention: account.requireMention ?? true,
			allowTextCommands: false,
			order: "before-sender"
		} },
		groupAllowFrom: policyKind === "allowFrom" ? account.allowFrom : policyKind === "role" ? account.allowedRoles : void 0
	})).ingress;
	if (decision.decisiveGateId === "activation" && decision.admission !== "dispatch") return {
		allowed: false,
		reason: "message does not mention the bot (requireMention is enabled)"
	};
	if (decision.admission === "dispatch") {
		if (policyKind === "allowFrom") return {
			allowed: true,
			matchKey: params.message.userId,
			matchSource: "allowlist"
		};
		if (policyKind === "role") return {
			allowed: true,
			matchKey: params.account.allowedRoles?.join(","),
			matchSource: "role"
		};
		return { allowed: true };
	}
	if (policyKind === "allowFrom") {
		if (!params.message.userId) return {
			allowed: false,
			reason: "sender user ID not available for allowlist check"
		};
		return {
			allowed: false,
			reason: "sender is not in allowFrom allowlist"
		};
	}
	if (policyKind === "role") return {
		allowed: false,
		reason: `sender does not have any of the required roles: ${params.account.allowedRoles?.join(", ") ?? ""}`
	};
	return {
		allowed: false,
		reason: reasonForTwitchIngressDecision(decision)
	};
}
function resolveTwitchPolicyKind(account) {
	if (account.allowFrom !== void 0) return "allowFrom";
	if (account.allowedRoles && account.allowedRoles.length > 0) return "role";
	return "open";
}
function twitchRoleSubject(message) {
	return {
		stableId: message.isMod ? "moderator" : void 0,
		aliases: {
			"role-owner": message.isOwner ? "owner" : void 0,
			"role-vip": message.isVip ? "vip" : void 0,
			"role-subscriber": message.isSub ? "subscriber" : void 0
		}
	};
}
function normalizeTwitchRole(value) {
	const role = normalizeLowercaseStringOrEmpty(value);
	if (role === "*") return "all";
	return role === "moderator" || role === "owner" || role === "vip" || role === "subscriber" || role === "all" ? role : null;
}
function reasonForTwitchIngressDecision(decision) {
	switch (decision.reasonCode) {
		case "activation_skipped": return "message does not mention the bot (requireMention is enabled)";
		case "group_policy_empty_allowlist":
		case "group_policy_not_allowlisted": return "sender is not in allowFrom allowlist";
		default: return decision.reasonCode;
	}
}
function mentionsBot(message, botUsername) {
	const expected = normalizeLowercaseStringOrEmpty(botUsername);
	const mentionRegex = /@(\w+)/g;
	let match;
	while ((match = mentionRegex.exec(message)) !== null) if ((match[1] ? normalizeLowercaseStringOrEmpty(match[1]) : "") === expected) return true;
	return false;
}
//#endregion
//#region extensions/twitch/src/monitor.ts
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
						durable: () => ({ to: `twitch:channel:${message.channel}` }),
						deliver: async (payload) => {
							return await deliverTwitchReply({
								payload,
								channel: message.channel,
								account,
								accountId,
								config,
								tableMode,
								runtime
							});
						},
						onDelivered: (_payload, _info, result) => {
							if (result?.visibleReplySent !== false) statusSink?.({ lastOutboundAt: Date.now() });
						},
						onError: (err, info) => {
							runtime.error?.(`Twitch ${info.kind} reply failed: ${String(err)}`);
						}
					},
					replyPipeline: {},
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
	const { payload, channel, account, accountId, config, runtime } = params;
	try {
		const client = await getOrCreateClientManager(accountId, {
			info: (msg) => runtime.log?.(msg),
			warn: (msg) => runtime.log?.(msg),
			error: (msg) => runtime.error?.(msg),
			debug: (msg) => runtime.log?.(msg)
		}).getClient(account, config, accountId);
		if (!client) {
			runtime.error?.(`No client available for sending reply`);
			return { visibleReplySent: false };
		}
		if (!payload.text) {
			runtime.error?.(`No text to send in reply payload`);
			return { visibleReplySent: false };
		}
		const textToSend = stripMarkdownForTwitch(payload.text);
		await client.say(channel, textToSend);
		return { visibleReplySent: true };
	} catch (err) {
		runtime.error?.(`Failed to send reply: ${String(err)}`);
		return { visibleReplySent: false };
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
		(async () => {
			const botUsername = normalizeLowercaseStringOrEmpty(account.username);
			if (normalizeLowercaseStringOrEmpty(message.username) === botUsername) return;
			const access = await checkTwitchAccessControl({
				message,
				account,
				botUsername
			});
			if (stopped || !access.allowed) return;
			statusSink?.({ lastInboundAt: Date.now() });
			await processTwitchMessage({
				message,
				account,
				accountId,
				config,
				runtime,
				core,
				statusSink
			});
		})().catch((err) => {
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
