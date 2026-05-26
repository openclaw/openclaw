import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { d as normalizeSecretInputString, h as resolveSecretInputString, u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { At as boolean, Et as array, Nn as record, Rn as string, Tn as object, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { l as resolveDefaultSecretProviderAlias } from "./ref-contract-D_h_G00C.js";
import { t as getChatChannelMeta } from "./chat-meta-2H4wOcrq.js";
import { r as buildChannelConfigSchema } from "./config-schema-ChfiQrSg.js";
import { t as createMessageReceiptFromOutboundResults } from "./receipt-vrVTwZtS.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { c as resolveMergedAccountConfig, i as hasConfiguredAccountValue, t as createAccountListHelpers } from "./account-helpers-BEXOONiv.js";
import { i as createChatChannelPlugin, n as buildThreadAwareOutboundSessionRoute, t as buildChannelOutboundSessionRoute } from "./core-kXuNbs5U.js";
import "./channel-core-CV-k5W6W.js";
import "./provider-auth-BtRKd5us.js";
import { r as buildSecretInputSchema } from "./secret-input-CWnTb0tw.js";
import { t as createChannelReplyPipeline } from "./reply-pipeline-EtNTatED.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./channel-config-schema-BBVXL5oD.js";
import "./account-resolution-Dy8RKAMt.js";
import "./channel-plugin-common-fWZhnLoH.js";
import { d as createDefaultChannelRuntimeState, u as createComputedAccountStatusAdapter } from "./status-helpers-CnvYAK73.js";
import { r as defineChannelMessageAdapter } from "./channel-message-DMGbyII_.js";
import { WebSocket as WebSocket$1 } from "ws";
//#region extensions/clickclack/src/accounts.ts
const DEFAULT_RECONNECT_MS = 1500;
const { listAccountIds: listClickClackAccountIds, resolveDefaultAccountId: resolveDefaultClickClackAccountId } = createAccountListHelpers("clickclack", {
	normalizeAccountId,
	hasImplicitDefaultAccount: (cfg) => {
		const channel = cfg.channels?.clickclack;
		return Boolean(channel?.baseUrl?.trim() && hasConfiguredAccountValue(channel.token) && channel.workspace?.trim());
	}
});
function resolveMergedClickClackAccountConfig(cfg, accountId) {
	return resolveMergedAccountConfig({
		channelConfig: cfg.channels?.clickclack,
		accounts: cfg.channels?.clickclack?.accounts,
		accountId,
		omitKeys: ["defaultAccount"],
		normalizeAccountId
	});
}
function resolveClickClackToken(params) {
	const resolved = resolveSecretInputString({
		value: params.value,
		path: params.accountId === "default" ? "channels.clickclack.token" : `channels.clickclack.accounts.${params.accountId}.token`,
		defaults: params.cfg.secrets?.defaults,
		mode: "inspect"
	});
	if (resolved.status !== "available") {
		if (resolved.status === "configured_unavailable" && resolved.ref.source === "env") {
			const providerConfig = params.cfg.secrets?.providers?.[resolved.ref.provider];
			if (providerConfig) {
				if (providerConfig.source !== "env") throw new Error(`Secret provider "${resolved.ref.provider}" has source "${providerConfig.source}" but ref requests "env".`);
				if (providerConfig.allowlist && !providerConfig.allowlist.includes(resolved.ref.id)) throw new Error(`Environment variable "${resolved.ref.id}" is not allowlisted in secrets.providers.${resolved.ref.provider}.allowlist.`);
			} else if (resolved.ref.provider !== resolveDefaultSecretProviderAlias({ secrets: params.cfg.secrets }, "env")) throw new Error(`Secret provider "${resolved.ref.provider}" is not configured (ref: env:${resolved.ref.provider}:${resolved.ref.id}).`);
			return normalizeSecretInputString((params.env ?? process.env)[resolved.ref.id]) ?? "";
		}
		return "";
	}
	return normalizeResolvedSecretInputString({
		value: resolved.value,
		path: "channels.clickclack.token"
	}) ?? "";
}
function resolveClickClackAccount(params) {
	const accountId = normalizeAccountId(params.accountId);
	const merged = resolveMergedClickClackAccountConfig(params.cfg, accountId);
	const enabled = params.cfg.channels?.clickclack?.enabled !== false && merged.enabled !== false;
	const baseUrl = merged.baseUrl?.trim().replace(/\/$/, "") ?? "";
	const token = resolveClickClackToken({
		cfg: params.cfg,
		value: merged.token,
		accountId,
		env: params.env
	});
	const workspace = merged.workspace?.trim() ?? "";
	return {
		accountId,
		enabled,
		configured: Boolean(baseUrl && token && workspace),
		name: normalizeOptionalString(merged.name),
		baseUrl,
		token,
		workspace,
		botUserId: normalizeOptionalString(merged.botUserId),
		agentId: normalizeOptionalString(merged.agentId),
		replyMode: merged.replyMode === "model" ? "model" : "agent",
		model: normalizeOptionalString(merged.model),
		systemPrompt: normalizeOptionalString(merged.systemPrompt),
		timeoutSeconds: merged.timeoutSeconds,
		toolsAllow: merged.toolsAllow,
		defaultTo: merged.defaultTo?.trim() || "channel:general",
		allowFrom: merged.allowFrom ?? ["*"],
		reconnectMs: merged.reconnectMs ?? DEFAULT_RECONNECT_MS,
		config: {
			...merged,
			allowFrom: merged.allowFrom ?? ["*"]
		}
	};
}
function listEnabledClickClackAccounts(cfg) {
	return listClickClackAccountIds(cfg).map((accountId) => resolveClickClackAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled);
}
//#endregion
//#region extensions/clickclack/src/config-schema.ts
const ClickClackAccountConfigSchema = object({
	name: string().optional(),
	enabled: boolean().optional(),
	baseUrl: string().url().optional(),
	token: buildSecretInputSchema().optional(),
	workspace: string().optional(),
	botUserId: string().optional(),
	agentId: string().optional(),
	replyMode: _enum(["agent", "model"]).optional(),
	model: string().optional(),
	systemPrompt: string().optional(),
	timeoutSeconds: number().int().min(1).max(3600).optional(),
	toolsAllow: array(string()).optional(),
	defaultTo: string().optional(),
	allowFrom: array(string()).optional(),
	reconnectMs: number().int().min(100).max(6e4).optional()
}).strict();
const clickClackConfigSchema = buildChannelConfigSchema(ClickClackAccountConfigSchema.extend({
	accounts: record(string(), ClickClackAccountConfigSchema.partial()).optional(),
	defaultAccount: string().optional()
}).strict());
//#endregion
//#region extensions/clickclack/src/http-client.ts
function createClickClackClient(options) {
	const baseUrl = options.baseUrl.replace(/\/$/, "");
	const fetcher = options.fetch ?? fetch;
	const headers = {
		Authorization: `Bearer ${options.token}`,
		Accept: "application/json"
	};
	async function request(path, init = {}) {
		const requestHeaders = new Headers(init.headers);
		for (const [key, value] of Object.entries(headers)) requestHeaders.set(key, value);
		if (init.body && !(init.body instanceof FormData)) requestHeaders.set("Content-Type", "application/json");
		const response = await fetcher(`${baseUrl}${path}`, {
			...init,
			headers: requestHeaders
		});
		if (!response.ok) throw new Error(`ClickClack ${response.status}: ${await response.text()}`);
		return await response.json();
	}
	return {
		me: async () => {
			return (await request("/api/me")).user;
		},
		workspaces: async () => {
			return (await request("/api/workspaces")).workspaces;
		},
		channels: async (workspaceId) => {
			return (await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/channels`)).channels;
		},
		channelMessages: async (channelId, afterSeq, limit = 20) => {
			return (await request(`/api/channels/${encodeURIComponent(channelId)}/messages?after_seq=${afterSeq}&limit=${limit}`)).messages;
		},
		directMessages: async (conversationId, afterSeq, limit = 20) => {
			return (await request(`/api/dms/${encodeURIComponent(conversationId)}/messages?after_seq=${afterSeq}&limit=${limit}`)).messages;
		},
		thread: async (messageId) => await request(`/api/messages/${encodeURIComponent(messageId)}/thread`),
		createChannelMessage: async (channelId, body) => {
			return (await request(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
				method: "POST",
				body: JSON.stringify({ body })
			})).message;
		},
		createThreadReply: async (messageId, body) => {
			return (await request(`/api/messages/${encodeURIComponent(messageId)}/thread/replies`, {
				method: "POST",
				body: JSON.stringify({ body })
			})).message;
		},
		createDirectConversation: async (workspaceId, memberIds) => {
			return (await request("/api/dms", {
				method: "POST",
				body: JSON.stringify({
					workspace_id: workspaceId,
					member_ids: memberIds
				})
			})).conversation;
		},
		createDirectMessage: async (conversationId, body) => {
			return (await request(`/api/dms/${encodeURIComponent(conversationId)}/messages`, {
				method: "POST",
				body: JSON.stringify({ body })
			})).message;
		},
		events: async (workspaceId, afterCursor) => {
			const query = new URLSearchParams({ workspace_id: workspaceId });
			if (afterCursor) query.set("after_cursor", afterCursor);
			return (await request(`/api/realtime/events?${query.toString()}`)).events;
		},
		websocket: (workspaceId, afterCursor) => {
			const url = new URL(`${baseUrl}/api/realtime/ws`);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			url.searchParams.set("workspace_id", workspaceId);
			if (afterCursor) url.searchParams.set("after_cursor", afterCursor);
			return new WebSocket$1(url, { headers: { Authorization: `Bearer ${options.token}` } });
		}
	};
}
//#endregion
//#region extensions/clickclack/src/resolve.ts
async function resolveWorkspaceId(client, workspace) {
	if (workspace.startsWith("wsp_")) return workspace;
	const found = (await client.workspaces()).find((candidate) => candidate.id === workspace || candidate.slug === workspace || candidate.name === workspace);
	if (!found) throw new Error(`ClickClack workspace not found: ${workspace}`);
	return found.id;
}
async function resolveChannelId(client, workspaceId, channel) {
	if (channel.startsWith("chn_")) return channel;
	const found = (await client.channels(workspaceId)).find((candidate) => candidate.id === channel || candidate.name === channel);
	if (!found) throw new Error(`ClickClack channel not found: ${channel}`);
	return found.id;
}
//#endregion
//#region extensions/clickclack/src/target.ts
function parseClickClackTarget(raw) {
	const value = raw.trim();
	if (!value) throw new Error("ClickClack target is required");
	const [prefix, ...rest] = value.split(":");
	const body = rest.join(":").trim();
	if (prefix === "channel" && body) return {
		chatType: "group",
		kind: "channel",
		id: body
	};
	if (prefix === "thread" && body) return {
		chatType: "group",
		kind: "thread",
		id: body
	};
	if (prefix === "dm" && body) return {
		chatType: "direct",
		kind: "dm",
		id: body
	};
	if (!body) return {
		chatType: "group",
		kind: "channel",
		id: value
	};
	throw new Error(`Unsupported ClickClack target: ${raw}`);
}
function buildClickClackTarget(target) {
	return `${target.kind}:${target.id}`;
}
function normalizeClickClackTarget(raw) {
	return buildClickClackTarget(parseClickClackTarget(raw));
}
function looksLikeClickClackTarget(raw) {
	return /^(channel|thread|dm):/i.test(raw.trim()) || raw.trim().length > 0;
}
//#endregion
//#region extensions/clickclack/src/outbound.ts
async function sendClickClackText(params) {
	const account = resolveClickClackAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const client = createClickClackClient({
		baseUrl: account.baseUrl,
		token: account.token
	});
	const workspaceId = await resolveWorkspaceId(client, account.workspace);
	const parsed = parseClickClackTarget(params.to);
	const explicitThreadId = params.threadId == null ? "" : String(params.threadId);
	const replyToId = params.replyToId == null ? "" : String(params.replyToId);
	if (explicitThreadId || replyToId || parsed.kind === "thread") {
		const rootId = explicitThreadId || replyToId || parsed.id;
		const message = await client.createThreadReply(rootId, params.text);
		return {
			to: params.to,
			messageId: message.id
		};
	}
	if (parsed.kind === "dm") {
		const dm = await client.createDirectConversation(workspaceId, [parsed.id]);
		const message = await client.createDirectMessage(dm.id, params.text);
		return {
			to: params.to,
			messageId: message.id
		};
	}
	const channelId = await resolveChannelId(client, workspaceId, parsed.id);
	const message = await client.createChannelMessage(channelId, params.text);
	return {
		to: params.to,
		messageId: message.id
	};
}
//#endregion
//#region extensions/clickclack/src/runtime.ts
const { setRuntime: setClickClackRuntime, getRuntime: getClickClackRuntime } = createPluginRuntimeStore({
	pluginId: "clickclack",
	errorMessage: "ClickClack runtime not initialized"
});
//#endregion
//#region extensions/clickclack/src/inbound.ts
const CHANNEL_ID$1 = "clickclack";
function resolveAccountAgentRoute(params) {
	const runtime = getClickClackRuntime();
	const route = runtime.channel.routing.resolveAgentRoute({
		cfg: params.cfg,
		channel: CHANNEL_ID$1,
		accountId: params.account.accountId,
		peer: {
			kind: params.isDirect ? "direct" : "channel",
			id: params.target
		}
	});
	const agentId = params.account.agentId ?? route.agentId;
	if (agentId === route.agentId) return route;
	return {
		...route,
		agentId,
		sessionKey: runtime.channel.routing.buildAgentSessionKey({
			agentId,
			channel: CHANNEL_ID$1,
			accountId: params.account.accountId,
			peer: {
				kind: params.isDirect ? "direct" : "channel",
				id: params.target
			}
		})
	};
}
async function dispatchModelReply(params) {
	const text = (await getClickClackRuntime().llm.complete({
		agentId: params.route.agentId,
		model: params.account.model,
		maxTokens: 96,
		purpose: "clickclack bot reply",
		systemPrompt: params.account.systemPrompt,
		messages: [{
			role: "user",
			content: params.message.body
		}]
	})).text.trim();
	if (!text) return;
	await sendClickClackText({
		cfg: params.cfg,
		accountId: params.account.accountId,
		to: params.target,
		text,
		threadId: params.message.parent_message_id ? params.message.thread_root_id : void 0,
		replyToId: params.message.id
	});
}
async function handleClickClackInbound(params) {
	const runtime = getClickClackRuntime();
	const message = params.message;
	const isDirect = Boolean(message.direct_conversation_id);
	const target = buildClickClackTarget(isDirect ? {
		chatType: "direct",
		kind: "dm",
		id: message.author_id
	} : {
		chatType: "group",
		kind: "channel",
		id: message.channel_id ?? ""
	});
	const route = resolveAccountAgentRoute({
		cfg: params.config,
		account: params.account,
		target,
		isDirect
	});
	if (params.account.replyMode === "model") {
		await dispatchModelReply({
			account: params.account,
			cfg: params.config,
			message,
			route,
			target
		});
		return;
	}
	const senderName = message.author?.display_name || message.author_id;
	const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
		storePath: runtime.channel.session.resolveStorePath(params.config.session?.store, { agentId: route.agentId }),
		sessionKey: route.sessionKey
	});
	const body = runtime.channel.reply.formatAgentEnvelope({
		channel: "ClickClack",
		from: senderName,
		timestamp: new Date(message.created_at),
		previousTimestamp,
		envelope: runtime.channel.reply.resolveEnvelopeFormatOptions(params.config),
		body: message.body
	});
	const storePath = runtime.channel.session.resolveStorePath(params.config.session?.store, { agentId: route.agentId });
	const ctxPayload = runtime.channel.reply.finalizeInboundContext({
		Body: body,
		BodyForAgent: message.body,
		RawBody: message.body,
		CommandBody: message.body,
		From: target,
		To: target,
		SessionKey: route.sessionKey,
		AccountId: route.accountId ?? params.account.accountId,
		ChatType: isDirect ? "direct" : "group",
		WasMentioned: isDirect ? void 0 : true,
		ConversationLabel: isDirect ? senderName : message.channel_id,
		GroupChannel: message.channel_id,
		NativeChannelId: message.channel_id || message.direct_conversation_id,
		MessageThreadId: message.parent_message_id ? message.thread_root_id : void 0,
		ThreadParentId: message.parent_message_id ? message.thread_root_id : void 0,
		SenderName: senderName,
		SenderId: message.author_id,
		Provider: CHANNEL_ID$1,
		Surface: CHANNEL_ID$1,
		MessageSid: message.id,
		MessageSidFull: message.id,
		ReplyToId: message.id,
		Timestamp: message.created_at,
		OriginatingChannel: CHANNEL_ID$1,
		OriginatingTo: target,
		CommandAuthorized: true
	});
	const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
		cfg: params.config,
		agentId: route.agentId,
		channel: CHANNEL_ID$1,
		accountId: params.account.accountId
	});
	await runtime.channel.turn.runPrepared({
		channel: CHANNEL_ID$1,
		accountId: params.account.accountId,
		routeSessionKey: route.sessionKey,
		storePath,
		ctxPayload,
		recordInboundSession: runtime.channel.session.recordInboundSession,
		runDispatch: async () => await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
			ctx: ctxPayload,
			cfg: params.config,
			dispatcherOptions: {
				...replyPipeline,
				deliver: async (payload) => {
					const text = payload && typeof payload === "object" && "text" in payload ? payload.text ?? "" : "";
					if (!text.trim()) return;
					await sendClickClackText({
						cfg: params.config,
						accountId: params.account.accountId,
						to: target,
						text,
						threadId: message.parent_message_id ? message.thread_root_id : void 0,
						replyToId: message.id
					});
				},
				onError: (error) => {
					throw error instanceof Error ? error : /* @__PURE__ */ new Error(`clickclack dispatch failed: ${String(error)}`);
				}
			},
			replyOptions: { onModelSelected }
		}),
		record: { onRecordError: (error) => {
			throw error instanceof Error ? error : /* @__PURE__ */ new Error(`clickclack session record failed: ${String(error)}`);
		} }
	});
}
//#endregion
//#region extensions/clickclack/src/gateway.ts
function payloadString(event, key) {
	const value = event.payload?.[key];
	return typeof value === "string" ? value : "";
}
async function resolveEventMessage(params) {
	const messageId = payloadString(params.event, "message_id");
	if (!messageId) return null;
	const directConversationId = payloadString(params.event, "direct_conversation_id");
	if (directConversationId && typeof params.event.seq === "number") return (await params.client.directMessages(directConversationId, params.event.seq - 1, 10)).find((message) => message.id === messageId) ?? null;
	if (params.event.type === "thread.reply_created") {
		const rootId = payloadString(params.event, "root_message_id");
		if (!rootId) return null;
		return (await params.client.thread(rootId)).replies.find((message) => message.id === messageId) ?? null;
	}
	if (params.event.channel_id && typeof params.event.seq === "number") return (await params.client.channelMessages(params.event.channel_id, params.event.seq - 1, 10)).find((message) => message.id === messageId) ?? null;
	return null;
}
function decodeSocketMessage(data) {
	if (typeof data === "string") return data;
	if (Buffer.isBuffer(data)) return data.toString("utf8");
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	return Buffer.concat(data).toString("utf8");
}
function parseSocketEvent(data) {
	try {
		return JSON.parse(decodeSocketMessage(data));
	} catch {
		return null;
	}
}
async function processEvent(params) {
	if (params.event.type !== "message.created" && params.event.type !== "thread.reply_created") return;
	if (payloadString(params.event, "author_id") === params.botUserId) return;
	const message = await resolveEventMessage({
		client: params.client,
		event: params.event
	});
	if (!message || message.author_id === params.botUserId) return;
	if (message.author?.kind === "bot") return;
	await handleClickClackInbound({
		account: params.account,
		config: params.config,
		message
	});
}
async function startClickClackGatewayAccount(ctx) {
	const configuredAccount = resolveClickClackAccount({
		cfg: ctx.cfg,
		accountId: ctx.account.accountId
	});
	if (!configuredAccount.configured) throw new Error(`ClickClack is not configured for account "${configuredAccount.accountId}"`);
	const client = createClickClackClient({
		baseUrl: configuredAccount.baseUrl,
		token: configuredAccount.token
	});
	const workspaceId = await resolveWorkspaceId(client, configuredAccount.workspace);
	const me = await client.me();
	const account = {
		...configuredAccount,
		workspace: workspaceId,
		botUserId: configuredAccount.botUserId ?? me.id
	};
	ctx.setStatus({
		accountId: account.accountId,
		running: true,
		configured: true,
		enabled: account.enabled,
		baseUrl: account.baseUrl
	});
	let afterCursor = "";
	let initialized = false;
	while (!ctx.abortSignal.aborted) {
		const backlog = await client.events(workspaceId, afterCursor);
		if (!initialized) {
			for (const event of backlog) afterCursor = event.cursor || afterCursor;
			initialized = true;
		} else for (const event of backlog) {
			afterCursor = event.cursor || afterCursor;
			await processEvent({
				account,
				config: ctx.cfg,
				client,
				event,
				botUserId: account.botUserId
			});
		}
		const socket = client.websocket(workspaceId, afterCursor);
		await new Promise((resolve, reject) => {
			const abort = () => {
				socket.close();
				resolve();
			};
			ctx.abortSignal.addEventListener("abort", abort, { once: true });
			socket.on("message", (data) => {
				(async () => {
					const event = parseSocketEvent(data);
					if (!event) {
						ctx.log?.warn?.(`[${account.accountId}] skipped malformed ClickClack websocket event`);
						return;
					}
					afterCursor = event.cursor || afterCursor;
					await processEvent({
						account,
						config: ctx.cfg,
						client,
						event,
						botUserId: account.botUserId ?? ""
					});
				})().catch(reject);
			});
			socket.on("close", () => {
				ctx.abortSignal.removeEventListener("abort", abort);
				resolve();
			});
			socket.on("error", reject);
		});
		if (!ctx.abortSignal.aborted) await new Promise((resolve) => setTimeout(resolve, account.reconnectMs));
	}
	ctx.setStatus({
		accountId: account.accountId,
		running: false
	});
}
//#endregion
//#region extensions/clickclack/src/channel.ts
const CHANNEL_ID = "clickclack";
const meta = { ...getChatChannelMeta(CHANNEL_ID) };
const clickClackMessageAdapter = defineChannelMessageAdapter({
	id: CHANNEL_ID,
	durableFinal: { capabilities: {
		text: true,
		replyTo: true,
		thread: true,
		messageSendingHooks: true
	} },
	send: { text: async (ctx) => {
		const result = await sendClickClackText({
			cfg: ctx.cfg,
			accountId: ctx.accountId,
			to: ctx.to,
			text: ctx.text,
			threadId: ctx.threadId,
			replyToId: ctx.replyToId
		});
		const threadId = ctx.threadId == null ? void 0 : String(ctx.threadId);
		const replyToId = ctx.replyToId ?? void 0;
		return {
			messageId: result.messageId,
			receipt: createMessageReceiptFromOutboundResults({
				results: [{
					channel: CHANNEL_ID,
					messageId: result.messageId
				}],
				threadId,
				replyToId,
				kind: "text"
			})
		};
	} }
});
const clickClackPlugin = createChatChannelPlugin({
	base: {
		id: CHANNEL_ID,
		meta,
		capabilities: {
			chatTypes: ["direct", "group"],
			threads: true,
			blockStreaming: true
		},
		reload: { configPrefixes: ["channels.clickclack"] },
		configSchema: clickClackConfigSchema,
		config: {
			listAccountIds: (cfg) => listClickClackAccountIds(cfg),
			resolveAccount: (cfg, accountId) => resolveClickClackAccount({
				cfg,
				accountId
			}),
			defaultAccountId: (cfg) => resolveDefaultClickClackAccountId(cfg),
			isConfigured: (account) => account.configured,
			resolveAllowFrom: ({ cfg, accountId }) => resolveClickClackAccount({
				cfg,
				accountId
			}).allowFrom,
			resolveDefaultTo: ({ cfg, accountId }) => resolveClickClackAccount({
				cfg,
				accountId
			}).defaultTo
		},
		messaging: {
			targetPrefixes: ["clickclack", "cc"],
			normalizeTarget: normalizeClickClackTarget,
			parseExplicitTarget: ({ raw }) => {
				const parsed = parseClickClackTarget(raw);
				return {
					to: buildClickClackTarget(parsed),
					threadId: parsed.kind === "thread" ? parsed.id : void 0,
					chatType: parsed.chatType
				};
			},
			inferTargetChatType: ({ to }) => parseClickClackTarget(to).chatType,
			targetResolver: {
				looksLikeId: looksLikeClickClackTarget,
				hint: "<channel:name|dm:usr_id|thread:msg_id>"
			},
			resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target, replyToId, threadId, currentSessionKey }) => {
				const parsed = parseClickClackTarget(target);
				return buildThreadAwareOutboundSessionRoute({
					route: buildChannelOutboundSessionRoute({
						cfg,
						agentId,
						channel: CHANNEL_ID,
						accountId,
						peer: {
							kind: parsed.chatType === "direct" ? "direct" : "channel",
							id: buildClickClackTarget(parsed)
						},
						chatType: parsed.chatType,
						from: `clickclack:${accountId ?? "default"}`,
						to: buildClickClackTarget(parsed)
					}),
					replyToId,
					threadId: threadId ?? (parsed.kind === "thread" ? parsed.id : void 0),
					currentSessionKey,
					canRecoverCurrentThread: () => true
				});
			},
			resolveSessionConversation: ({ rawId }) => {
				const parsed = parseClickClackTarget(rawId);
				if (parsed.kind === "dm") return null;
				return {
					id: parsed.id,
					threadId: parsed.kind === "thread" ? parsed.id : void 0,
					baseConversationId: parsed.id,
					parentConversationCandidates: [parsed.id]
				};
			}
		},
		status: createComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
			buildChannelSummary: ({ snapshot }) => ({
				ok: snapshot.configured,
				label: snapshot.configured ? "configured" : "missing config",
				detail: snapshot.baseUrl ?? ""
			}),
			resolveAccountSnapshot: ({ account }) => ({
				accountId: account.accountId,
				name: account.name,
				enabled: account.enabled,
				configured: account.configured,
				baseUrl: account.baseUrl
			})
		}),
		gateway: { startAccount: startClickClackGatewayAccount },
		message: clickClackMessageAdapter
	},
	outbound: {
		base: { deliveryMode: "direct" },
		attachedResults: {
			channel: CHANNEL_ID,
			sendText: async ({ cfg, to, text, accountId, threadId, replyToId }) => await sendClickClackText({
				cfg,
				accountId,
				to,
				text,
				threadId,
				replyToId
			})
		}
	}
});
//#endregion
export { parseClickClackTarget as a, listClickClackAccountIds as c, resolveDefaultClickClackAccountId as d, buildClickClackTarget as i, listEnabledClickClackAccounts as l, getClickClackRuntime as n, createClickClackClient as o, setClickClackRuntime as r, clickClackConfigSchema as s, clickClackPlugin as t, resolveClickClackAccount as u };
