import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { p as resolveThreadSessionKeys$1 } from "./session-key-Bte0mmcq.js";
import { Nn as record, Rn as string, Tn as object, Xn as union, Zn as unknown } from "./schemas-Del5uzR8.js";
import { n as safeParseWithSchema, t as safeParseJsonWithSchema } from "./zod-parse-B4dzFRWI.js";
import { i as isLoopbackHost } from "./net-DCUMtgJy.js";
import { i as parseStrictPositiveInteger } from "./parse-finite-number-C3Woj8eC.js";
import { t as rawDataToString } from "./ws-C3qhmaFC.js";
import { a as getReplyPayloadTtsSupplement, n as buildTtsSupplementMediaPayload } from "./reply-payload-CiT5mlcY.js";
import { t as countOutboundMedia, u as isReasoningReplyPayload } from "./reply-payload-DMPQsrQC.js";
import { k as resolveChannelStreamingPreviewToolProgress, s as formatChannelProgressDraftLineForEntry } from "./channel-streaming-BKIuGSWW.js";
import { a as resolveInboundLastRouteSessionKey } from "./resolve-route-C8IahAyG.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "./runtime-group-policy-CmZDlIwd.js";
import { l as resolvePinnedMainDmOwnerFromAllowlist } from "./dm-policy-shared-CXEKnzKD.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { a as deliverWithFinalizableLivePreviewAdapter, r as defineFinalizableLivePreviewAdapter } from "./live-CF0ee90S.js";
import { n as createDebugProxyWebSocketAgent, r as resolveDebugProxySettings } from "./env-CDrl0Kuj.js";
import "./error-runtime-DGHc7DZw.js";
import { n as captureWsEvent } from "./runtime-Cqhsh14m.js";
import "./proxy-capture-v_LMACCK.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./routing-79DRZvfm.js";
import { i as formatInboundFromLabel$1 } from "./envelope-DUI2KFD9.js";
import "./history-BD_TtuvO.js";
import { t as createChannelReplyPipeline } from "./reply-pipeline-EtNTatED.js";
import { t as createChannelHistoryWindow } from "./history-window-Gy0CzEef.js";
import { t as buildAgentMediaPayload } from "./agent-media-payload-Coh_QzX4.js";
import { d as ssrfPolicyFromPrivateNetworkOptIn, o as isPrivateNetworkOptInEnabled } from "./ssrf-policy-CIwd6x-p.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { a as resolveChannelMediaMaxBytes } from "./media-runtime-BheBFFxc.js";
import { t as registerPluginHttpRoute } from "./http-registry-Dt8GAiji.js";
import "./security-runtime-CcSekjBd.js";
import "./gateway-runtime-HxuTzDuS.js";
import { t as listSkillCommandsForAgents } from "./skill-commands-dLqoqLxl.js";
import { t as buildModelsProviderData } from "./commands-models-C5hB5Z12.js";
import "./extension-shared-DSIp8QS_.js";
import { n as logInboundDrop, r as logTypingFailure } from "./logging-Dr3f0mtP.js";
import "./channel-inbound-C7GtKjtG.js";
import { r as createFinalizableDraftLifecycle } from "./channel-lifecycle-B7VOl7bW.js";
import "./channel-message-DMGbyII_.js";
import { n as createChannelPairingController } from "./channel-pairing-N4dBc-K-.js";
import { t as createClaimableDedupe } from "./persistent-dedupe-DaB2erKZ.js";
import "./webhook-ingress-R0qMwT4u.js";
import { a as resolveMattermostMonitorInboundAccess, r as normalizeMattermostAllowEntry, t as authorizeMattermostCommandInvocation } from "./monitor-auth-Ce-BTHuT.js";
import { _ as readMattermostError, a as MattermostPostSchema, c as createMattermostPost, f as fetchMattermostMe, g as normalizeMattermostBaseUrl, h as fetchMattermostUserTeams, i as resolveMattermostReplyToMode, l as deleteMattermostPost, o as createMattermostClient, p as fetchMattermostUser, r as resolveMattermostAccount, t as listMattermostAccountIds, u as fetchMattermostChannel, v as sendMattermostTyping, y as updateMattermostPost } from "./accounts-BSHeJeZB.js";
import { t as getMattermostRuntime } from "./runtime-CesoaWNy.js";
import { C as resolveCallbackUrl, S as registerSlashCommands, _ as renderMattermostProviderPickerView, a as sendMessageMattermost, b as cleanupSlashCommands, c as computeInteractionCallbackUrl, d as setInteractionCallbackUrl, f as setInteractionSecret, g as renderMattermostModelsPickerView, h as parseMattermostModelPickerContext, l as createMattermostInteractionHandler, m as buildMattermostAllowedModelRefs, n as deactivateSlashCommands, o as resolveMattermostOpaqueTarget, p as deliverMattermostReplyPayload, r as getSlashCommandState, s as buildButtonProps, t as activateSlashCommands, u as resolveInteractionCallbackPath, v as resolveMattermostModelPickerCurrentModel, w as resolveSlashCommandConfig, x as isSlashCommandsEnabled, y as DEFAULT_COMMAND_SPECS } from "./slash-state-CZTAy_CK.js";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
//#region extensions/mattermost/src/mattermost/directory.ts
function buildClient(params) {
	const account = resolveMattermostAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.enabled || !account.botToken || !account.baseUrl) return null;
	return createMattermostClient({
		baseUrl: account.baseUrl,
		botToken: account.botToken,
		allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config)
	});
}
/**
* Build clients from ALL enabled accounts (deduplicated by token).
*
* We always scan every account because:
* - Private channels are only visible to bots that are members
* - The requesting agent's account may have an expired/invalid token
*
* This means a single healthy bot token is enough for directory discovery.
*/
function buildClients(params) {
	const accountIds = listMattermostAccountIds(params.cfg);
	const seen = /* @__PURE__ */ new Set();
	const clients = [];
	for (const id of accountIds) {
		const client = buildClient({
			cfg: params.cfg,
			accountId: id
		});
		if (client && !seen.has(client.token)) {
			seen.add(client.token);
			clients.push(client);
		}
	}
	return clients;
}
/**
* List channels (public + private) visible to any configured bot account.
*
* NOTE: Uses per_page=200 which covers most instances. Mattermost does not
* return a "has more" indicator, so very large instances (200+ channels per bot)
* may see incomplete results. Pagination can be added if needed.
*/
async function listMattermostDirectoryGroups(params) {
	const clients = buildClients(params);
	if (!clients.length) return [];
	const q = normalizeLowercaseStringOrEmpty(params.query);
	const seenIds = /* @__PURE__ */ new Set();
	const entries = [];
	for (const client of clients) try {
		const me = await fetchMattermostMe(client);
		const channels = await client.request(`/users/${me.id}/channels?per_page=200`);
		for (const ch of channels) {
			if (ch.type !== "O" && ch.type !== "P") continue;
			if (seenIds.has(ch.id)) continue;
			if (q) {
				const name = normalizeLowercaseStringOrEmpty(ch.name);
				const display = normalizeLowercaseStringOrEmpty(ch.display_name);
				if (!name.includes(q) && !display.includes(q)) continue;
			}
			seenIds.add(ch.id);
			entries.push({
				kind: "group",
				id: `channel:${ch.id}`,
				name: ch.name ?? void 0,
				handle: ch.display_name ?? void 0
			});
		}
	} catch (err) {
		console.debug?.("[mattermost-directory] listGroups: skipping account:", err?.message);
		continue;
	}
	return params.limit && params.limit > 0 ? entries.slice(0, params.limit) : entries;
}
/**
* List team members as peer directory entries.
*
* Uses only the first available client since all bots in a team see the same
* user list (unlike channels where membership varies). Uses the first team
* returned — multi-team setups will only see members from that team.
*
* NOTE: per_page=200 for member listing; same pagination caveat as groups.
*/
async function listMattermostDirectoryPeers(params) {
	const clients = buildClients(params);
	if (!clients.length) return [];
	const client = clients[0];
	try {
		const me = await fetchMattermostMe(client);
		const teams = await client.request("/users/me/teams");
		if (!teams.length) return [];
		const teamId = teams[0].id;
		const q = normalizeLowercaseStringOrEmpty(params.query);
		let users;
		if (q) users = await client.request("/users/search", {
			method: "POST",
			body: JSON.stringify({
				term: q,
				team_id: teamId
			})
		});
		else {
			const userIds = (await client.request(`/teams/${teamId}/members?per_page=200`)).map((m) => m.user_id).filter((id) => id !== me.id);
			if (!userIds.length) return [];
			users = await client.request("/users/ids", {
				method: "POST",
				body: JSON.stringify(userIds)
			});
		}
		const entries = users.filter((u) => u.id !== me.id).map((u) => ({
			kind: "user",
			id: `user:${u.id}`,
			name: u.username ?? void 0,
			handle: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.nickname || void 0
		}));
		return params.limit && params.limit > 0 ? entries.slice(0, params.limit) : entries;
	} catch (err) {
		console.debug?.("[mattermost-directory] listPeers failed:", err?.message);
		return [];
	}
}
//#endregion
//#region extensions/mattermost/src/mattermost/draft-stream.ts
const MATTERMOST_STREAM_MAX_CHARS = 4e3;
const DEFAULT_THROTTLE_MS = 1e3;
function normalizeMattermostDraftText(text, maxChars) {
	const trimmed = text.trim();
	if (!trimmed) return "";
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
function buildMattermostToolStatusText(params) {
	return formatChannelProgressDraftLineForEntry(params.config, {
		event: "tool",
		name: params.name,
		phase: params.phase,
		args: params.args
	}, params.detailMode ? { detailMode: params.detailMode } : void 0) ?? "Running tool...";
}
function createMattermostDraftStream(params) {
	const maxChars = Math.min(params.maxChars ?? MATTERMOST_STREAM_MAX_CHARS, MATTERMOST_STREAM_MAX_CHARS);
	const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
	const streamState = {
		stopped: false,
		final: false
	};
	let streamPostId;
	let lastSentText = "";
	const sendOrEditStreamMessage = async (text) => {
		if (streamState.stopped && !streamState.final) return false;
		const normalized = normalizeMattermostDraftText(params.renderText?.(text) ?? text, maxChars);
		if (!normalized) return false;
		if (normalized === lastSentText) return true;
		try {
			if (streamPostId) await updateMattermostPost(params.client, streamPostId, { message: normalized });
			else {
				const postId = (await createMattermostPost(params.client, {
					channelId: params.channelId,
					message: normalized,
					rootId: params.rootId
				})).id?.trim();
				if (!postId) {
					streamState.stopped = true;
					params.warn?.("mattermost stream preview stopped (missing post id from create)");
					return false;
				}
				streamPostId = postId;
			}
			lastSentText = normalized;
			return true;
		} catch (err) {
			streamState.stopped = true;
			params.warn?.(`mattermost stream preview failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	};
	const { loop, update, stop, clear, discardPending, seal } = createFinalizableDraftLifecycle({
		throttleMs,
		state: streamState,
		sendOrEditStreamMessage,
		readMessageId: () => streamPostId,
		clearMessageId: () => {
			streamPostId = void 0;
		},
		isValidMessageId: (value) => typeof value === "string" && value.length > 0,
		deleteMessage: async (postId) => {
			await deleteMattermostPost(params.client, postId);
		},
		warn: params.warn,
		warnPrefix: "mattermost stream preview cleanup failed"
	});
	const forceNewMessage = () => {
		streamPostId = void 0;
		lastSentText = "";
		loop.resetPending();
		loop.resetThrottleWindow();
	};
	params.log?.(`mattermost stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);
	return {
		update,
		flush: loop.flush,
		postId: () => streamPostId,
		clear,
		discardPending,
		seal,
		stop,
		forceNewMessage
	};
}
//#endregion
//#region extensions/mattermost/src/mattermost/monitor-gating.ts
function mapMattermostChannelTypeToChatType(channelType) {
	const normalized = channelType?.trim().toUpperCase();
	if (!normalized) return "direct";
	if (normalized === "D") return "direct";
	if (normalized === "G" || normalized === "P") return "group";
	return "channel";
}
function resolveMattermostTrustedChatKind(params) {
	const channelType = params.channelType?.trim();
	if (channelType) return mapMattermostChannelTypeToChatType(channelType);
	return params.fallback ?? "direct";
}
function evaluateMattermostMentionGate(params) {
	const shouldRequireMention = params.kind !== "direct" && params.resolveRequireMention({
		cfg: params.cfg,
		channel: "mattermost",
		accountId: params.accountId,
		groupId: params.channelId,
		requireMentionOverride: params.requireMentionOverride
	});
	const shouldBypassMention = params.isControlCommand && shouldRequireMention && !params.wasMentioned && params.commandAuthorized;
	const effectiveWasMentioned = params.wasMentioned || shouldBypassMention || params.oncharTriggered;
	if (params.oncharEnabled && !params.oncharTriggered && !params.wasMentioned && !params.isControlCommand) return {
		shouldRequireMention,
		shouldBypassMention,
		effectiveWasMentioned,
		dropReason: "onchar-not-triggered"
	};
	if (params.kind !== "direct" && shouldRequireMention && params.canDetectMention && !effectiveWasMentioned) return {
		shouldRequireMention,
		shouldBypassMention,
		effectiveWasMentioned,
		dropReason: "missing-mention"
	};
	return {
		shouldRequireMention,
		shouldBypassMention,
		effectiveWasMentioned,
		dropReason: null
	};
}
//#endregion
//#region extensions/mattermost/src/mattermost/monitor-helpers.ts
const formatInboundFromLabel = formatInboundFromLabel$1;
function resolveThreadSessionKeys(params) {
	return resolveThreadSessionKeys$1({
		...params,
		normalizeThreadId: (threadId) => threadId
	});
}
/**
* Strip bot mention from message text while preserving newlines and
* block-level Markdown formatting (headings, lists, blockquotes).
*/
function normalizeMention(text, mention) {
	if (!mention) return text.trim();
	const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const hasMentionRe = new RegExp(`@${escaped}\\b`, "i");
	const leadingMentionRe = new RegExp(`^([\\t ]*)@${escaped}\\b[\\t ]*`, "i");
	const trailingMentionRe = new RegExp(`[\\t ]*@${escaped}\\b[\\t ]*$`, "i");
	const normalizedLines = text.split("\n").map((line) => {
		const hadMention = hasMentionRe.test(line);
		const normalizedLine = line.replace(leadingMentionRe, "$1").replace(trailingMentionRe, "").replace(new RegExp(`@${escaped}\\b`, "gi"), "").replace(/(\S)[ \t]{2,}/g, "$1 ");
		return {
			text: normalizedLine,
			mentionOnlyBlank: hadMention && normalizedLine.trim() === ""
		};
	});
	while (normalizedLines[0]?.mentionOnlyBlank) normalizedLines.shift();
	while (normalizedLines.at(-1)?.text.trim() === "") normalizedLines.pop();
	return normalizedLines.map((line) => line.text).join("\n");
}
//#endregion
//#region extensions/mattermost/src/mattermost/monitor-onchar.ts
const DEFAULT_ONCHAR_PREFIXES = [">", "!"];
function resolveOncharPrefixes(prefixes) {
	const cleaned = prefixes?.map((entry) => entry.trim()).filter(Boolean) ?? DEFAULT_ONCHAR_PREFIXES;
	return cleaned.length > 0 ? cleaned : DEFAULT_ONCHAR_PREFIXES;
}
function stripOncharPrefix(text, prefixes) {
	const trimmed = text.trimStart();
	for (const prefix of prefixes) {
		if (!prefix) continue;
		if (trimmed.startsWith(prefix)) return {
			triggered: true,
			stripped: trimmed.slice(prefix.length).trimStart()
		};
	}
	return {
		triggered: false,
		stripped: text
	};
}
//#endregion
//#region extensions/mattermost/src/mattermost/monitor-resources.ts
const CHANNEL_CACHE_TTL_MS = 5 * 6e4;
const USER_CACHE_TTL_MS = 10 * 6e4;
function createMattermostMonitorResources(params) {
	const { accountId, callbackUrl, client, logger, mediaMaxBytes, saveRemoteMedia, mediaKindFromMime } = params;
	const channelCache = /* @__PURE__ */ new Map();
	const userCache = /* @__PURE__ */ new Map();
	const resolveMattermostMedia = async (fileIds) => {
		const ids = (fileIds ?? []).map((id) => id?.trim()).filter(Boolean);
		if (ids.length === 0) return [];
		const out = [];
		for (const fileId of ids) try {
			const saved = await saveRemoteMedia({
				url: `${client.apiBaseUrl}/files/${fileId}`,
				requestInit: { headers: { Authorization: `Bearer ${client.token}` } },
				filePathHint: fileId,
				maxBytes: mediaMaxBytes,
				ssrfPolicy: { allowedHostnames: [new URL(client.baseUrl).hostname] }
			});
			const contentType = saved.contentType ?? void 0;
			out.push({
				path: saved.path,
				contentType,
				kind: mediaKindFromMime(contentType) ?? "unknown"
			});
		} catch (err) {
			logger.debug?.(`mattermost: failed to download file ${fileId}: ${String(err)}`);
		}
		return out;
	};
	const sendTypingIndicator = async (channelId, parentId) => {
		await sendMattermostTyping(client, {
			channelId,
			parentId
		});
	};
	const resolveChannelInfo = async (channelId) => {
		const cached = channelCache.get(channelId);
		if (cached && cached.expiresAt > Date.now()) return cached.value;
		try {
			const info = await fetchMattermostChannel(client, channelId);
			channelCache.set(channelId, {
				value: info,
				expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS
			});
			return info;
		} catch (err) {
			logger.debug?.(`mattermost: channel lookup failed: ${String(err)}`);
			channelCache.set(channelId, {
				value: null,
				expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS
			});
			return null;
		}
	};
	const resolveUserInfo = async (userId) => {
		const cached = userCache.get(userId);
		if (cached && cached.expiresAt > Date.now()) return cached.value;
		try {
			const info = await fetchMattermostUser(client, userId);
			userCache.set(userId, {
				value: info,
				expiresAt: Date.now() + USER_CACHE_TTL_MS
			});
			return info;
		} catch (err) {
			logger.debug?.(`mattermost: user lookup failed: ${String(err)}`);
			userCache.set(userId, {
				value: null,
				expiresAt: Date.now() + USER_CACHE_TTL_MS
			});
			return null;
		}
	};
	const buildModelPickerProps = (channelId, buttons) => buildButtonProps({
		callbackUrl,
		accountId,
		channelId,
		buttons
	});
	const updateModelPickerPost = async (params) => {
		const props = buildModelPickerProps(params.channelId, params.buttons ?? []) ?? { attachments: [] };
		await updateMattermostPost(client, params.postId, {
			message: params.message,
			props
		});
		return {};
	};
	return {
		resolveMattermostMedia,
		sendTypingIndicator,
		resolveChannelInfo,
		resolveUserInfo,
		updateModelPickerPost
	};
}
//#endregion
//#region extensions/mattermost/src/mattermost/monitor-slash.ts
function buildSlashCommands(params) {
	const commandsToRegister = [...DEFAULT_COMMAND_SPECS];
	if (!params.nativeSkills) return commandsToRegister;
	try {
		const skillCommands = listSkillCommandsForAgents({ cfg: params.cfg });
		for (const spec of skillCommands) {
			const name = typeof spec.name === "string" ? spec.name.trim() : "";
			if (!name) continue;
			const trigger = name.startsWith("oc_") ? name : `oc_${name}`;
			commandsToRegister.push({
				trigger,
				description: spec.description || `Run skill ${name}`,
				autoComplete: true,
				autoCompleteHint: "[args]",
				originalName: name
			});
		}
	} catch (err) {
		params.runtime.error?.(`mattermost: failed to list skill commands: ${String(err)}`);
	}
	return commandsToRegister;
}
function dedupeSlashCommands(commands) {
	const seen = /* @__PURE__ */ new Set();
	return commands.filter((cmd) => {
		const key = cmd.trigger.trim();
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
function buildTriggerMap(commands) {
	const triggerMap = /* @__PURE__ */ new Map();
	for (const cmd of commands) if (cmd.originalName) triggerMap.set(cmd.trigger, cmd.originalName);
	return triggerMap;
}
function warnOnSuspiciousCallbackUrl(params) {
	try {
		const mmHost = new URL(normalizeMattermostBaseUrl(params.baseUrl) ?? params.baseUrl).hostname;
		const callbackHost = new URL(params.callbackUrl).hostname;
		if (isLoopbackHost(callbackHost) && !isLoopbackHost(mmHost)) params.runtime.error?.(`mattermost: slash commands callbackUrl resolved to ${params.callbackUrl} (loopback) while baseUrl is ${params.baseUrl}. This MAY be unreachable depending on your deployment. If native slash commands don't work, set channels.mattermost.commands.callbackUrl to a URL reachable from the Mattermost server (e.g. your public reverse proxy URL).`);
	} catch {}
}
async function registerSlashCommandsAcrossTeams(params) {
	const registered = [];
	let teamRegistrationFailures = 0;
	for (const team of params.teams) try {
		const created = await registerSlashCommands({
			client: params.client,
			teamId: team.id,
			creatorUserId: params.botUserId,
			callbackUrl: params.callbackUrl,
			commands: params.commands,
			log: (msg) => params.runtime.log?.(msg)
		});
		registered.push(...created);
	} catch (err) {
		teamRegistrationFailures += 1;
		params.runtime.error?.(`mattermost: failed to register slash commands for team ${team.id}: ${String(err)}`);
	}
	return {
		registered,
		teamRegistrationFailures
	};
}
async function registerMattermostMonitorSlashCommands(params) {
	const commandsRaw = params.account.config.commands;
	const slashConfig = resolveSlashCommandConfig(commandsRaw);
	if (!isSlashCommandsEnabled(slashConfig)) return;
	try {
		const teams = await fetchMattermostUserTeams(params.client, params.botUserId);
		const slashCallbackUrl = resolveCallbackUrl({
			config: slashConfig,
			gatewayPort: parseStrictPositiveInteger(process.env.OPENCLAW_GATEWAY_PORT?.trim()) ?? params.cfg.gateway?.port ?? 18789,
			gatewayHost: params.cfg.gateway?.customBindHost ?? void 0
		});
		warnOnSuspiciousCallbackUrl({
			runtime: params.runtime,
			baseUrl: params.baseUrl,
			callbackUrl: slashCallbackUrl
		});
		const dedupedCommands = dedupeSlashCommands(buildSlashCommands({
			cfg: params.cfg,
			runtime: params.runtime,
			nativeSkills: slashConfig.nativeSkills === true
		}));
		const { registered, teamRegistrationFailures } = await registerSlashCommandsAcrossTeams({
			client: params.client,
			teams,
			botUserId: params.botUserId,
			callbackUrl: slashCallbackUrl,
			commands: dedupedCommands,
			runtime: params.runtime
		});
		if (registered.length === 0) {
			params.runtime.error?.("mattermost: native slash commands enabled but no commands could be registered; keeping slash callbacks inactive");
			return;
		}
		if (teamRegistrationFailures > 0) params.runtime.error?.(`mattermost: slash command registration completed with ${teamRegistrationFailures} team error(s)`);
		activateSlashCommands({
			account: params.account,
			commandTokens: registered.map((cmd) => cmd.token).filter(Boolean),
			registeredCommands: registered,
			triggerMap: buildTriggerMap(dedupedCommands),
			api: {
				cfg: params.cfg,
				runtime: params.runtime
			},
			log: (msg) => params.runtime.log?.(msg)
		});
		params.runtime.log?.(`mattermost: slash commands registered (${registered.length} commands across ${teams.length} teams, callback=${slashCallbackUrl})`);
	} catch (err) {
		params.runtime.error?.(`mattermost: failed to register slash commands: ${String(err)}`);
	}
}
//#endregion
//#region extensions/mattermost/src/mattermost/monitor-websocket.ts
const MattermostEventPayloadSchema = object({
	event: string().optional(),
	data: object({
		post: union([string(), MattermostPostSchema]).optional(),
		reaction: union([string(), record(string(), unknown())]).optional(),
		channel_id: string().optional(),
		channel_name: string().optional(),
		channel_display_name: string().optional(),
		channel_type: string().optional(),
		sender_name: string().optional(),
		team_id: string().optional()
	}).optional(),
	broadcast: object({
		channel_id: string().optional(),
		team_id: string().optional(),
		user_id: string().optional()
	}).optional()
});
function parseMattermostEventPayload(raw) {
	return safeParseJsonWithSchema(MattermostEventPayloadSchema, raw);
}
function parseMattermostPost(value) {
	if (typeof value === "string") return safeParseJsonWithSchema(MattermostPostSchema, value);
	return safeParseWithSchema(MattermostPostSchema, value);
}
var WebSocketClosedBeforeOpenError = class extends Error {
	constructor(code, reason) {
		super(`websocket closed before open (code ${code})`);
		this.code = code;
		this.reason = reason;
		this.name = "WebSocketClosedBeforeOpenError";
	}
};
const defaultMattermostWebSocketFactory = (url) => {
	const agent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
	return new WebSocket(url, agent ? { agent } : void 0);
};
function parsePostedPayload(payload) {
	if (payload.event !== "posted") return null;
	const postData = payload.data?.post;
	if (!postData) return null;
	const post = parseMattermostPost(postData);
	if (!post) return null;
	return {
		payload,
		post
	};
}
function createMattermostConnectOnce(opts) {
	const webSocketFactory = opts.webSocketFactory ?? defaultMattermostWebSocketFactory;
	const healthCheckIntervalMs = opts.healthCheckIntervalMs ?? 3e4;
	const pingIntervalMs = opts.pingIntervalMs ?? 3e4;
	const pongTimeoutMs = opts.pongTimeoutMs ?? 1e4;
	return async () => {
		const flowId = randomUUID();
		const ws = webSocketFactory(opts.wsUrl);
		const onAbort = () => ws.terminate();
		opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
		const getBotUpdateAt = opts.getBotUpdateAt;
		try {
			return await new Promise((resolve, reject) => {
				let opened = false;
				let settled = false;
				let healthCheckEnabled = getBotUpdateAt != null;
				let healthCheckInFlight = false;
				let healthCheckTimer;
				let protocolKeepaliveEnabled = true;
				let protocolPingTimer;
				let protocolPongTimer;
				let initialUpdateAt;
				const clearTimers = () => {
					if (healthCheckTimer !== void 0) {
						clearTimeout(healthCheckTimer);
						healthCheckTimer = void 0;
					}
					if (protocolPingTimer !== void 0) {
						clearTimeout(protocolPingTimer);
						protocolPingTimer = void 0;
					}
					if (protocolPongTimer !== void 0) {
						clearTimeout(protocolPongTimer);
						protocolPongTimer = void 0;
					}
				};
				const stopHealthChecks = () => {
					healthCheckEnabled = false;
					protocolKeepaliveEnabled = false;
					clearTimers();
				};
				const sendProtocolPing = () => {
					if (!protocolKeepaliveEnabled || settled) return;
					if (protocolPongTimer !== void 0) clearTimeout(protocolPongTimer);
					protocolPongTimer = setTimeout(() => {
						protocolPongTimer = void 0;
						if (!protocolKeepaliveEnabled || settled) return;
						opts.runtime.error?.("mattermost websocket pong timeout — reconnecting");
						stopHealthChecks();
						ws.terminate();
					}, pongTimeoutMs);
					try {
						ws.ping();
					} catch (err) {
						if (!protocolKeepaliveEnabled || settled) return;
						opts.runtime.error?.(`mattermost websocket ping failed: ${String(err)}`);
						stopHealthChecks();
						ws.terminate();
					}
				};
				const scheduleProtocolPing = () => {
					if (!protocolKeepaliveEnabled || settled || protocolPingTimer !== void 0) return;
					protocolPingTimer = setTimeout(() => {
						protocolPingTimer = void 0;
						sendProtocolPing();
					}, pingIntervalMs);
				};
				const scheduleHealthCheck = () => {
					if (!getBotUpdateAt || !healthCheckEnabled || settled || healthCheckInFlight) return;
					healthCheckTimer = setTimeout(() => {
						healthCheckTimer = void 0;
						runHealthCheck();
					}, healthCheckIntervalMs);
				};
				const runHealthCheck = async () => {
					if (!getBotUpdateAt || !healthCheckEnabled || settled || healthCheckInFlight) return;
					healthCheckInFlight = true;
					try {
						const current = await getBotUpdateAt();
						if (!healthCheckEnabled || settled) return;
						if (initialUpdateAt === void 0) {
							initialUpdateAt = current;
							return;
						}
						if (current !== initialUpdateAt) {
							opts.runtime.log?.(`mattermost: bot account updated (update_at changed: ${initialUpdateAt} → ${current}) — reconnecting`);
							stopHealthChecks();
							ws.terminate();
						}
					} catch (err) {
						if (!healthCheckEnabled || settled) return;
						const label = initialUpdateAt === void 0 ? "mattermost: failed to get initial update_at" : "mattermost: health check error";
						opts.runtime.error?.(`${label}: ${String(err)}`);
					} finally {
						healthCheckInFlight = false;
						scheduleHealthCheck();
					}
				};
				const resolveOnce = () => {
					if (settled) return;
					settled = true;
					stopHealthChecks();
					resolve();
				};
				const rejectOnce = (error) => {
					if (settled) return;
					settled = true;
					stopHealthChecks();
					reject(error);
				};
				ws.on("open", () => {
					opened = true;
					captureWsEvent({
						url: opts.wsUrl,
						direction: "local",
						kind: "ws-open",
						flowId,
						meta: { subsystem: "mattermost-websocket" }
					});
					opts.statusSink?.({
						connected: true,
						lastConnectedAt: Date.now(),
						lastError: null
					});
					const authPayload = JSON.stringify({
						seq: opts.nextSeq(),
						action: "authentication_challenge",
						data: { token: opts.botToken }
					});
					captureWsEvent({
						url: opts.wsUrl,
						direction: "outbound",
						kind: "ws-frame",
						flowId,
						payload: authPayload,
						meta: {
							subsystem: "mattermost-websocket",
							eventType: "authentication_challenge"
						}
					});
					ws.send(authPayload);
					scheduleProtocolPing();
					if (getBotUpdateAt) runHealthCheck();
				});
				ws.on("pong", () => {
					if (protocolPongTimer !== void 0) {
						clearTimeout(protocolPongTimer);
						protocolPongTimer = void 0;
					}
					scheduleProtocolPing();
				});
				ws.on("message", async (data) => {
					captureWsEvent({
						url: opts.wsUrl,
						direction: "inbound",
						kind: "ws-frame",
						flowId,
						payload: Buffer.from(rawDataToString(data)),
						meta: { subsystem: "mattermost-websocket" }
					});
					const payload = parseMattermostEventPayload(rawDataToString(data));
					if (!payload) return;
					if (payload.event === "reaction_added" || payload.event === "reaction_removed") {
						if (!opts.onReaction) return;
						try {
							await opts.onReaction(payload);
						} catch (err) {
							opts.runtime.error?.(`mattermost reaction handler failed: ${String(err)}`);
						}
						return;
					}
					if (payload.event !== "posted") return;
					const parsed = parsePostedPayload(payload);
					if (!parsed) return;
					try {
						await opts.onPosted(parsed.post, parsed.payload);
					} catch (err) {
						opts.runtime.error?.(`mattermost handler failed: ${String(err)}`);
					}
				});
				ws.on("close", (code, reason) => {
					captureWsEvent({
						url: opts.wsUrl,
						direction: "local",
						kind: "ws-close",
						flowId,
						closeCode: code,
						payload: reason,
						meta: { subsystem: "mattermost-websocket" }
					});
					stopHealthChecks();
					const message = reasonToString(reason);
					opts.statusSink?.({
						connected: false,
						lastDisconnect: {
							at: Date.now(),
							status: code,
							error: message || void 0
						}
					});
					if (opened) {
						resolveOnce();
						return;
					}
					rejectOnce(new WebSocketClosedBeforeOpenError(code, message || void 0));
				});
				ws.on("error", (err) => {
					captureWsEvent({
						url: opts.wsUrl,
						direction: "local",
						kind: "error",
						flowId,
						errorText: String(err),
						meta: { subsystem: "mattermost-websocket" }
					});
					opts.runtime.error?.(`mattermost websocket error: ${String(err)}`);
					opts.statusSink?.({ lastError: String(err) });
					try {
						ws.close();
					} catch {}
				});
			});
		} finally {
			opts.abortSignal?.removeEventListener("abort", onAbort);
		}
	};
}
function reasonToString(reason) {
	if (!reason) return "";
	if (typeof reason === "string") return reason;
	return reason.length > 0 ? reason.toString("utf8") : "";
}
//#endregion
//#region extensions/mattermost/src/mattermost/no-visible-reply-diagnostic.ts
/**
* Detects the #80501 symptom: `deliverMattermostReplyPayload` accepted a
* substantive (non-reasoning) payload, called the underlying
* `deliverTextOrMediaReply`, and the outcome was `"empty"` — meaning the
* payload had no text and no media to send, so no Mattermost API call
* happened. The agent's run completes successfully, but no visible
* channel/thread reply ever surfaces to the user.
*
* Returns a structured violation when the outcome is `"empty"` for a payload
* that nominally carried user-facing content (text or media bytes that ended
* up dropped by `resolveSendableOutboundReplyParts`/`sendMediaWithLeadingCaption`).
* Returns `null` for `"reasoning_skipped"` (intentional suppression),
* `"text"`, or `"media"` (successful visible sends).
*/
function evaluateMattermostNoVisibleReply(params) {
	if (params.outcome !== "empty") return null;
	const finalText = typeof params.payload.text === "string" ? params.payload.text.trim() : "";
	const mediaUrlCount = countOutboundMedia(params.payload);
	if (finalText.length === 0 && mediaUrlCount === 0) return null;
	return {
		reason: "no-visible-reply-after-final-delivery",
		outcome: params.outcome,
		finalTextLength: finalText.length,
		mediaUrlCount
	};
}
function formatMattermostNoVisibleReplyLog(params) {
	return `mattermost no-visible-reply: ${params.violation.reason} to=${params.to} accountId=${params.accountId} agentId=${params.agentId ?? "unknown"} outcome=${params.violation.outcome} finalTextLength=${params.violation.finalTextLength} mediaUrlCount=${params.violation.mediaUrlCount}`;
}
//#endregion
//#region extensions/mattermost/src/mattermost/reconnect.ts
/**
* Reconnection loop with exponential backoff.
*
* Calls `connectFn` in a while loop. On normal resolve (connection closed),
* the backoff resets. On thrown error (connection failed), the current delay is
* used, then doubled for the next retry.
* The loop exits when `abortSignal` fires.
*/
async function runWithReconnect(connectFn, opts = {}) {
	const { initialDelayMs = 2e3, maxDelayMs = 6e4 } = opts;
	const jitterRatio = Math.max(0, opts.jitterRatio ?? 0);
	const random = opts.random ?? Math.random;
	let retryDelay = initialDelayMs;
	let attempt = 0;
	while (!opts.abortSignal?.aborted) {
		let shouldIncreaseDelay = false;
		let outcome = "resolved";
		let error;
		try {
			await connectFn();
			retryDelay = initialDelayMs;
		} catch (err) {
			if (opts.abortSignal?.aborted) return;
			outcome = "rejected";
			error = err;
			opts.onError?.(err);
			shouldIncreaseDelay = true;
		}
		if (opts.abortSignal?.aborted) return;
		const delayMs = withJitter(retryDelay, jitterRatio, random);
		if (!(opts.shouldReconnect?.({
			attempt,
			delayMs,
			outcome,
			error
		}) ?? true)) return;
		opts.onReconnect?.(delayMs);
		await sleepAbortable(delayMs, opts.abortSignal);
		if (shouldIncreaseDelay) retryDelay = Math.min(retryDelay * 2, maxDelayMs);
		attempt++;
	}
}
function withJitter(baseMs, jitterRatio, random) {
	if (jitterRatio <= 0) return baseMs;
	const normalized = Math.max(0, Math.min(1, random()));
	const spread = baseMs * jitterRatio;
	return Math.max(1, Math.round(baseMs - spread + normalized * spread * 2));
}
function sleepAbortable(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
//#endregion
//#region extensions/mattermost/src/mattermost/monitor.ts
function shouldUpdateMattermostDraftToolProgress(account) {
	return account.streamingMode !== "off" && resolveChannelStreamingPreviewToolProgress(account.config);
}
function shouldSuppressMattermostDefaultToolProgressMessages(account) {
	return account.streamingMode !== "off";
}
const RECENT_MATTERMOST_MESSAGE_TTL_MS = 5 * 6e4;
const RECENT_MATTERMOST_MESSAGE_MAX = 2e3;
function normalizeInteractionSourceIps(values) {
	return (values ?? []).map((value) => normalizeOptionalString(value)).filter((value) => Boolean(value));
}
const recentInboundMessages = createClaimableDedupe({
	ttlMs: RECENT_MATTERMOST_MESSAGE_TTL_MS,
	memoryMaxSize: RECENT_MATTERMOST_MESSAGE_MAX
});
var MattermostRetryableInboundError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = "MattermostRetryableInboundError";
	}
};
function buildMattermostModelPickerSelectMessageSid(params) {
	const provider = normalizeLowercaseStringOrEmpty(params.provider);
	const model = normalizeLowercaseStringOrEmpty(params.model);
	return `interaction:${params.postId}:select:${provider}/${model}`;
}
function buildMattermostInboundReplayKeys(params) {
	return [...new Set(params.messageIds.map((id) => `${params.accountId}:${id.trim()}`))].filter((key) => !key.endsWith(":"));
}
async function processMattermostReplayGuardedPost(params) {
	const replayGuard = params.replayGuard ?? recentInboundMessages;
	const replayKeys = buildMattermostInboundReplayKeys({
		accountId: params.accountId,
		messageIds: params.messageIds
	});
	if (replayKeys.length === 0) {
		await params.handlePost();
		return "processed";
	}
	const claimedKeys = [];
	for (const replayKey of replayKeys) if ((await replayGuard.claim(replayKey)).kind === "claimed") claimedKeys.push(replayKey);
	if (claimedKeys.length === 0) return "duplicate";
	try {
		await params.handlePost();
		await Promise.all(claimedKeys.map((replayKey) => replayGuard.commit(replayKey)));
		return "processed";
	} catch (error) {
		if (error instanceof MattermostRetryableInboundError) claimedKeys.forEach((replayKey) => replayGuard.release(replayKey, { error }));
		else await Promise.all(claimedKeys.map((replayKey) => replayGuard.commit(replayKey)));
		throw error;
	}
}
function resolveRuntime(opts) {
	return opts.runtime ?? {
		log: console.log,
		error: console.error,
		exit: (code) => {
			throw new Error(`exit ${code}`);
		}
	};
}
function isSystemPost(post) {
	return normalizeOptionalString(post.type) !== void 0;
}
function channelChatType(kind) {
	if (kind === "direct") return "direct";
	if (kind === "group") return "group";
	return "channel";
}
function resolveMattermostReplyRootId(params) {
	if (params.kind === "direct") return;
	const threadRootId = normalizeOptionalString(params.threadRootId);
	if (threadRootId) return threadRootId;
	return normalizeOptionalString(params.replyToId);
}
function canFinalizeMattermostPreviewInPlace(params) {
	return resolveMattermostReplyRootId({
		kind: params.kind,
		threadRootId: params.threadRootId,
		replyToId: params.replyToId
	}) === params.previewRootId?.trim();
}
function createDisabledMattermostDraftStream() {
	const noopAsync = async () => {};
	return {
		update: () => {},
		flush: noopAsync,
		postId: () => void 0,
		clear: noopAsync,
		discardPending: noopAsync,
		seal: noopAsync,
		stop: noopAsync,
		forceNewMessage: () => {}
	};
}
async function deliverMattermostReplyWithDraftPreview(params) {
	if (isReasoningReplyPayload(params.payload)) return;
	await deliverWithFinalizableLivePreviewAdapter({
		kind: params.info.kind,
		payload: params.payload,
		adapter: defineFinalizableLivePreviewAdapter({
			draft: {
				flush: params.draftStream.flush,
				clear: params.draftStream.clear,
				discardPending: params.draftStream.discardPending,
				seal: params.draftStream.seal,
				id: params.draftStream.postId
			},
			buildFinalEdit: (payload) => {
				const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
				const ttsSupplement = getReplyPayloadTtsSupplement(payload);
				const previewFinalText = params.resolvePreviewFinalText(payload.text ?? ttsSupplement?.spokenText);
				if (hasMedia && !ttsSupplement || typeof previewFinalText !== "string" || payload.isError || !canFinalizeMattermostPreviewInPlace({
					kind: params.kind,
					previewRootId: params.effectiveReplyToId,
					threadRootId: params.effectiveReplyToId,
					replyToId: payload.replyToId
				})) return;
				return { message: previewFinalText };
			},
			editFinal: async (previewPostId, edit) => {
				await updateMattermostPost(params.client, previewPostId, edit);
			},
			onPreviewFinalized: () => {
				params.previewState.finalizedViaPreviewPost = true;
			},
			buildSupplementalPayload: (payload) => getReplyPayloadTtsSupplement(payload) ? buildTtsSupplementMediaPayload(payload) : void 0,
			deliverSupplemental: async (payload) => {
				await params.deliverPayload(payload);
			},
			logPreviewEditFailure: (err) => {
				params.logVerboseMessage(`mattermost preview final edit failed; falling back to normal send (${String(err)})`);
			}
		}),
		deliverNormally: async (payload) => {
			const supplement = getReplyPayloadTtsSupplement(payload);
			await params.deliverPayload(supplement && !payload.text?.trim() && supplement.visibleTextAlreadyDelivered !== true ? {
				...payload,
				text: supplement.spokenText
			} : payload);
		}
	});
}
function formatMattermostFinalDeliveryOutcomeLog(params) {
	const violation = evaluateMattermostNoVisibleReply({
		outcome: params.outcome,
		payload: params.payload
	});
	if (violation) return formatMattermostNoVisibleReplyLog({
		violation,
		to: params.to,
		accountId: params.accountId,
		agentId: params.agentId
	});
	if (params.outcome === "text" || params.outcome === "media") return `delivered reply to ${params.to}`;
}
function resolveMattermostEffectiveReplyToId(params) {
	if (params.kind === "direct") return;
	const threadRootId = normalizeOptionalString(params.threadRootId);
	if (threadRootId && params.replyToMode !== "off") return threadRootId;
	const postId = normalizeOptionalString(params.postId);
	if (!postId) return;
	return params.replyToMode === "all" || params.replyToMode === "first" || params.replyToMode === "batched" ? postId : void 0;
}
function resolveMattermostThreadSessionContext(params) {
	const effectiveReplyToId = resolveMattermostEffectiveReplyToId({
		kind: params.kind,
		postId: params.postId,
		replyToMode: params.replyToMode,
		threadRootId: params.threadRootId
	});
	const threadKeys = resolveThreadSessionKeys({
		baseSessionKey: params.baseSessionKey,
		threadId: effectiveReplyToId,
		parentSessionKey: effectiveReplyToId ? params.baseSessionKey : void 0
	});
	return {
		effectiveReplyToId,
		sessionKey: threadKeys.sessionKey,
		parentSessionKey: threadKeys.parentSessionKey
	};
}
function resolveMattermostReactionChannelId(payload) {
	return normalizeOptionalString(payload.broadcast?.channel_id) ?? normalizeOptionalString(payload.data?.channel_id);
}
function buildMattermostAttachmentPlaceholder(mediaList) {
	if (mediaList.length === 0) return "";
	if (mediaList.length === 1) return `<media:${mediaList[0].kind === "unknown" ? "document" : mediaList[0].kind}>`;
	const allImages = mediaList.every((media) => media.kind === "image");
	const label = allImages ? "image" : "file";
	const suffix = mediaList.length === 1 ? label : `${label}s`;
	return `${allImages ? "<media:image>" : "<media:document>"} (${mediaList.length} ${suffix})`;
}
function buildMattermostWsUrl(baseUrl) {
	const normalized = normalizeMattermostBaseUrl(baseUrl);
	if (!normalized) throw new Error("Mattermost baseUrl is required");
	return `${normalized.replace(/^http/i, "ws")}/api/v4/websocket`;
}
async function monitorMattermostProvider(opts = {}) {
	const core = getMattermostRuntime();
	const runtime = resolveRuntime(opts);
	const cfg = opts.config ?? core.config.current();
	const account = resolveMattermostAccount({
		cfg,
		accountId: opts.accountId
	});
	const pairing = createChannelPairingController({
		core,
		channel: "mattermost",
		accountId: account.accountId
	});
	const botToken = normalizeOptionalString(opts.botToken) ?? normalizeOptionalString(account.botToken);
	if (!botToken) throw new Error(`Mattermost bot token missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.botToken or MATTERMOST_BOT_TOKEN for default).`);
	const baseUrl = normalizeMattermostBaseUrl(opts.baseUrl ?? account.baseUrl);
	if (!baseUrl) throw new Error(`Mattermost baseUrl missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.baseUrl or MATTERMOST_URL for default).`);
	const client = createMattermostClient({
		baseUrl,
		botToken,
		allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config)
	});
	let botUser;
	await runWithReconnect(async () => {
		botUser = await fetchMattermostMe(client);
	}, {
		abortSignal: opts.abortSignal,
		jitterRatio: .2,
		shouldReconnect: ({ outcome }) => outcome === "rejected",
		onError: (err) => {
			runtime.error?.(`mattermost: API auth failed: ${String(err)}`);
			opts.statusSink?.({
				lastError: String(err),
				connected: false
			});
		},
		onReconnect: (delayMs) => {
			runtime.log?.(`mattermost: API not accessible, retrying in ${Math.round(delayMs / 1e3)}s`);
		}
	});
	if (opts.abortSignal?.aborted) return;
	const botUserId = botUser.id;
	const botUsername = normalizeOptionalString(botUser.username);
	runtime.log?.(`mattermost connected as ${botUsername ? `@${botUsername}` : botUserId}`);
	await registerMattermostMonitorSlashCommands({
		client,
		cfg,
		runtime,
		account,
		baseUrl,
		botUserId
	});
	const slashEnabled = getSlashCommandState(account.accountId) != null;
	setInteractionSecret(account.accountId, botToken);
	const interactionPath = resolveInteractionCallbackPath(account.accountId);
	const callbackUrl = computeInteractionCallbackUrl(account.accountId, {
		gateway: cfg.gateway,
		interactions: account.config.interactions
	});
	setInteractionCallbackUrl(account.accountId, callbackUrl);
	const allowedInteractionSourceIps = normalizeInteractionSourceIps(account.config.interactions?.allowedSourceIps);
	try {
		const mmHost = new URL(baseUrl).hostname;
		const callbackHost = new URL(callbackUrl).hostname;
		if (isLoopbackHost(callbackHost) && !isLoopbackHost(mmHost)) runtime.error?.(`mattermost: interactions callbackUrl resolved to ${callbackUrl} (loopback) while baseUrl is ${baseUrl}. This MAY be unreachable depending on your deployment. If button clicks don't work, set channels.mattermost.interactions.callbackBaseUrl to a URL reachable from the Mattermost server (e.g. your public reverse proxy URL).`);
		if (!isLoopbackHost(callbackHost) && allowedInteractionSourceIps.length === 0) runtime.error?.(`mattermost: interactions callbackUrl resolved to ${callbackUrl} without channels.mattermost.interactions.allowedSourceIps. For safety, non-loopback callback sources will be rejected until you allowlist the Mattermost server or trusted ingress IPs.`);
	} catch {}
	const effectiveInteractionSourceIps = allowedInteractionSourceIps.length > 0 ? allowedInteractionSourceIps : ["127.0.0.1", "::1"];
	const unregisterInteractions = registerPluginHttpRoute({
		path: interactionPath,
		fallbackPath: "/mattermost/interactions/default",
		auth: "plugin",
		handler: createMattermostInteractionHandler({
			client,
			botUserId,
			accountId: account.accountId,
			allowedSourceIps: effectiveInteractionSourceIps,
			trustedProxies: cfg.gateway?.trustedProxies,
			allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
			handleInteraction: handleModelPickerInteraction,
			authorizeButtonClick: async ({ payload, post }) => {
				const channelInfo = await resolveChannelInfo(payload.channel_id);
				const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
					cfg,
					surface: "mattermost"
				});
				const decision = await authorizeMattermostCommandInvocation({
					account,
					cfg,
					senderId: payload.user_id,
					senderName: payload.user_name ?? "",
					channelId: payload.channel_id,
					channelInfo,
					readStoreAllowFrom: pairing.readAllowFromStore,
					allowTextCommands,
					hasControlCommand: false
				});
				if (decision.ok) return { ok: true };
				return {
					ok: false,
					response: {
						update: {
							message: post.message ?? "",
							props: post.props ?? void 0
						},
						ephemeral_text: `OpenClaw ignored this action for ${decision.roomLabel}.`
					}
				};
			},
			resolveSessionKey: async ({ channelId, userId, post }) => {
				const channelInfo = await resolveChannelInfo(channelId);
				if (!channelInfo?.type) {
					logVerboseMessage(`mattermost: drop interaction session event (cannot resolve channel type for ${channelId})`);
					throw new Error("Mattermost channel type could not be resolved");
				}
				const kind = mapMattermostChannelTypeToChatType(channelInfo.type);
				const teamId = channelInfo?.team_id ?? void 0;
				const route = core.channel.routing.resolveAgentRoute({
					cfg,
					channel: "mattermost",
					accountId: account.accountId,
					teamId,
					peer: {
						kind,
						id: kind === "direct" ? userId : channelId
					}
				});
				const replyToMode = resolveMattermostReplyToMode(account, kind);
				return resolveMattermostThreadSessionContext({
					baseSessionKey: route.sessionKey,
					kind,
					postId: post.id || void 0,
					replyToMode,
					threadRootId: post.root_id
				}).sessionKey;
			},
			dispatchButtonClick: async (opts) => {
				const channelInfo = await resolveChannelInfo(opts.channelId);
				if (!channelInfo?.type) {
					logVerboseMessage(`mattermost: drop interaction dispatch (cannot resolve channel type for ${opts.channelId})`);
					return;
				}
				const kind = mapMattermostChannelTypeToChatType(channelInfo.type);
				const chatType = channelChatType(kind);
				const teamId = channelInfo?.team_id ?? void 0;
				const channelName = channelInfo?.name ?? void 0;
				const channelDisplay = channelInfo?.display_name ?? channelName ?? opts.channelId;
				const route = core.channel.routing.resolveAgentRoute({
					cfg,
					channel: "mattermost",
					accountId: account.accountId,
					teamId,
					peer: {
						kind,
						id: kind === "direct" ? opts.userId : opts.channelId
					}
				});
				const replyToMode = resolveMattermostReplyToMode(account, kind);
				const threadContext = resolveMattermostThreadSessionContext({
					baseSessionKey: route.sessionKey,
					kind,
					postId: opts.post.id || opts.postId,
					replyToMode,
					threadRootId: opts.post.root_id
				});
				const to = kind === "direct" ? `user:${opts.userId}` : `channel:${opts.channelId}`;
				const bodyText = `[Button click: user @${opts.userName} selected "${opts.actionName}"]`;
				const ctxPayload = core.channel.reply.finalizeInboundContext({
					Body: bodyText,
					BodyForAgent: bodyText,
					RawBody: bodyText,
					CommandBody: bodyText,
					From: kind === "direct" ? `mattermost:${opts.userId}` : kind === "group" ? `mattermost:group:${opts.channelId}` : `mattermost:channel:${opts.channelId}`,
					To: to,
					SessionKey: threadContext.sessionKey,
					ParentSessionKey: threadContext.parentSessionKey,
					AccountId: route.accountId,
					ChatType: chatType,
					ConversationLabel: `mattermost:${opts.userName}`,
					GroupSubject: kind !== "direct" ? channelDisplay : void 0,
					GroupChannel: channelName ? `#${channelName}` : void 0,
					GroupSpace: teamId,
					SenderName: opts.userName,
					SenderId: opts.userId,
					Provider: "mattermost",
					Surface: "mattermost",
					MessageSid: `interaction:${opts.postId}:${opts.actionId}`,
					ReplyToId: threadContext.effectiveReplyToId,
					MessageThreadId: threadContext.effectiveReplyToId,
					WasMentioned: true,
					CommandAuthorized: false,
					OriginatingChannel: "mattermost",
					OriginatingTo: to
				});
				const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "mattermost", account.accountId, { fallbackLimit: account.textChunkLimit ?? 4e3 });
				const tableMode = core.channel.text.resolveMarkdownTableMode({
					cfg,
					channel: "mattermost",
					accountId: account.accountId
				});
				const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
					cfg,
					agentId: route.agentId,
					channel: "mattermost",
					accountId: account.accountId,
					typing: {
						start: () => sendTypingIndicator(opts.channelId, threadContext.effectiveReplyToId),
						onStartError: (err) => {
							logTypingFailure({
								log: (message) => logger.debug?.(message),
								channel: "mattermost",
								target: opts.channelId,
								error: err
							});
						}
					}
				});
				const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
					...replyPipeline,
					humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
					deliver: async (payload) => {
						await deliverMattermostReplyPayload({
							core,
							cfg,
							payload,
							to,
							accountId: account.accountId,
							agentId: route.agentId,
							replyToId: resolveMattermostReplyRootId({
								kind,
								threadRootId: threadContext.effectiveReplyToId,
								replyToId: payload.replyToId
							}),
							textLimit,
							tableMode,
							sendMessage: sendMessageMattermost
						});
						runtime.log?.(`delivered button-click reply to ${to}`);
					},
					onError: (err, info) => {
						runtime.error?.(`mattermost button-click ${info.kind} reply failed: ${String(err)}`);
					},
					onReplyStart: typingCallbacks?.onReplyStart
				});
				await core.channel.reply.dispatchReplyFromConfig({
					ctx: ctxPayload,
					cfg,
					dispatcher,
					replyOptions: {
						...replyOptions,
						disableBlockStreaming: typeof account.blockStreaming === "boolean" ? !account.blockStreaming : void 0,
						onModelSelected
					}
				});
				markDispatchIdle();
			},
			log: (msg) => runtime.log?.(msg)
		}),
		pluginId: "mattermost",
		source: "mattermost-interactions",
		accountId: account.accountId,
		log: (msg) => runtime.log?.(msg)
	});
	const logger = core.logging.getChildLogger({ module: "mattermost" });
	const logVerboseMessage = (message) => {
		if (!core.logging.shouldLogVerbose()) return;
		logger.debug?.(message);
	};
	const mediaMaxBytes = resolveChannelMediaMaxBytes({
		cfg,
		resolveChannelLimitMb: () => void 0,
		accountId: account.accountId
	}) ?? 8 * 1024 * 1024;
	const historyLimit = Math.max(0, cfg.messages?.groupChat?.historyLimit ?? 50);
	const channelHistories = /* @__PURE__ */ new Map();
	const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
	const dmPolicy = account.config.dmPolicy ?? "pairing";
	const { groupPolicy, providerMissingFallbackApplied } = resolveAllowlistProviderRuntimeGroupPolicy({
		providerConfigPresent: cfg.channels?.mattermost !== void 0,
		groupPolicy: account.config.groupPolicy,
		defaultGroupPolicy
	});
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "mattermost",
		accountId: account.accountId,
		log: (message) => logVerboseMessage(message)
	});
	const { resolveMattermostMedia, sendTypingIndicator, resolveChannelInfo, resolveUserInfo, updateModelPickerPost } = createMattermostMonitorResources({
		accountId: account.accountId,
		callbackUrl,
		client,
		logger: { debug: (message) => logger.debug?.(String(message)) },
		mediaMaxBytes,
		saveRemoteMedia: (params) => core.channel.media.saveRemoteMedia(params),
		mediaKindFromMime: (contentType) => core.media.mediaKindFromMime(contentType)
	});
	const runModelPickerCommand = async (params) => {
		const to = params.kind === "direct" ? `user:${params.senderId}` : `channel:${params.channelId}`;
		const fromLabel = params.kind === "direct" ? `Mattermost DM from ${params.senderName}` : `Mattermost message in ${params.roomLabel} from ${params.senderName}`;
		const ctxPayload = core.channel.reply.finalizeInboundContext({
			Body: params.commandText,
			BodyForAgent: params.commandText,
			RawBody: params.commandText,
			CommandBody: params.commandText,
			From: params.kind === "direct" ? `mattermost:${params.senderId}` : params.kind === "group" ? `mattermost:group:${params.channelId}` : `mattermost:channel:${params.channelId}`,
			To: to,
			SessionKey: params.sessionKey,
			ParentSessionKey: params.parentSessionKey,
			AccountId: params.route.accountId,
			ChatType: params.chatType,
			ConversationLabel: fromLabel,
			GroupSubject: params.kind !== "direct" ? params.channelDisplay || params.roomLabel : void 0,
			GroupChannel: params.channelName ? `#${params.channelName}` : void 0,
			GroupSpace: params.teamId,
			SenderName: params.senderName,
			SenderId: params.senderId,
			Provider: "mattermost",
			Surface: "mattermost",
			MessageSid: params.messageSid ?? `interaction:${params.postId}:${Date.now()}`,
			ReplyToId: params.effectiveReplyToId,
			MessageThreadId: params.effectiveReplyToId,
			Timestamp: Date.now(),
			WasMentioned: true,
			CommandAuthorized: params.commandAuthorized,
			CommandSource: "native",
			OriginatingChannel: "mattermost",
			OriginatingTo: to
		});
		const tableMode = core.channel.text.resolveMarkdownTableMode({
			cfg,
			channel: "mattermost",
			accountId: account.accountId
		});
		const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "mattermost", account.accountId, { fallbackLimit: account.textChunkLimit ?? 4e3 });
		const shouldDeliverReplies = params.deliverReplies === true;
		const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
			cfg,
			agentId: params.route.agentId,
			channel: "mattermost",
			accountId: account.accountId,
			typing: shouldDeliverReplies ? {
				start: () => sendTypingIndicator(params.channelId, params.effectiveReplyToId),
				onStartError: (err) => {
					logTypingFailure({
						log: (message) => logger.debug?.(message),
						channel: "mattermost",
						target: params.channelId,
						error: err
					});
				}
			} : void 0
		});
		const capturedTexts = [];
		const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
			...replyPipeline,
			deliver: async (payload) => {
				const trimmedPayload = {
					...payload,
					text: core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode).trim()
				};
				if (!shouldDeliverReplies) {
					if (trimmedPayload.text) capturedTexts.push(trimmedPayload.text);
					return;
				}
				await deliverMattermostReplyPayload({
					core,
					cfg,
					payload: trimmedPayload,
					to,
					accountId: account.accountId,
					agentId: params.route.agentId,
					replyToId: resolveMattermostReplyRootId({
						kind: params.kind,
						threadRootId: params.effectiveReplyToId,
						replyToId: trimmedPayload.replyToId
					}),
					textLimit,
					tableMode: "off",
					sendMessage: sendMessageMattermost
				});
			},
			onError: (err, info) => {
				runtime.error?.(`mattermost model picker ${info.kind} reply failed: ${String(err)}`);
			},
			onReplyStart: typingCallbacks?.onReplyStart
		});
		await core.channel.reply.withReplyDispatcher({
			dispatcher,
			onSettled: () => {
				markDispatchIdle();
			},
			run: () => core.channel.reply.dispatchReplyFromConfig({
				ctx: ctxPayload,
				cfg,
				dispatcher,
				replyOptions: {
					...replyOptions,
					disableBlockStreaming: typeof account.blockStreaming === "boolean" ? !account.blockStreaming : void 0,
					onModelSelected
				}
			})
		});
		return capturedTexts.join("\n\n").trim();
	};
	async function handleModelPickerInteraction(params) {
		const pickerState = parseMattermostModelPickerContext(params.context);
		if (!pickerState) return null;
		if (pickerState.ownerUserId !== params.payload.user_id) return { ephemeral_text: "Only the person who opened this picker can use it." };
		const channelInfo = await resolveChannelInfo(params.payload.channel_id);
		const pickerCommandText = pickerState.action === "select" ? `/model ${pickerState.provider}/${pickerState.model}` : pickerState.action === "list" ? `/models ${pickerState.provider}` : "/models";
		const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
			cfg,
			surface: "mattermost"
		});
		const hasControlCommand = core.channel.text.hasControlCommand(pickerCommandText, cfg);
		const auth = await authorizeMattermostCommandInvocation({
			account,
			cfg,
			senderId: params.payload.user_id,
			senderName: params.userName,
			channelId: params.payload.channel_id,
			channelInfo,
			readStoreAllowFrom: pairing.readAllowFromStore,
			allowTextCommands,
			hasControlCommand
		});
		if (!auth.ok) {
			if (auth.denyReason === "dm-pairing") {
				const { code } = await pairing.upsertPairingRequest({
					id: params.payload.user_id,
					meta: { name: params.userName }
				});
				return { ephemeral_text: core.channel.pairing.buildPairingReply({
					channel: "mattermost",
					idLine: `Your Mattermost user id: ${params.payload.user_id}`,
					code
				}) };
			}
			return { ephemeral_text: auth.denyReason === "unknown-channel" ? "Temporary error: unable to determine channel type. Please try again." : auth.denyReason === "dm-disabled" ? "This bot is not accepting direct messages." : auth.denyReason === "channels-disabled" ? "Model picker actions are disabled in channels." : auth.denyReason === "channel-no-allowlist" ? "Model picker actions are not configured for this channel." : "Unauthorized." };
		}
		const kind = auth.kind;
		const chatType = auth.chatType;
		const teamId = auth.channelInfo.team_id ?? params.payload.team_id ?? void 0;
		const channelName = auth.channelName || void 0;
		const channelDisplay = auth.channelDisplay || auth.channelName || params.payload.channel_id;
		const roomLabel = auth.roomLabel;
		const route = core.channel.routing.resolveAgentRoute({
			cfg,
			channel: "mattermost",
			accountId: account.accountId,
			teamId,
			peer: {
				kind,
				id: kind === "direct" ? params.payload.user_id : params.payload.channel_id
			}
		});
		const replyToMode = resolveMattermostReplyToMode(account, kind);
		const threadContext = resolveMattermostThreadSessionContext({
			baseSessionKey: route.sessionKey,
			kind,
			postId: params.post.id || params.payload.post_id,
			replyToMode,
			threadRootId: params.post.root_id
		});
		const modelSessionRoute = {
			agentId: route.agentId,
			sessionKey: threadContext.sessionKey
		};
		const data = await buildModelsProviderData(cfg, route.agentId);
		if (data.providers.length === 0) return await updateModelPickerPost({
			channelId: params.payload.channel_id,
			postId: params.payload.post_id,
			message: "No models available."
		});
		if (pickerState.action === "providers" || pickerState.action === "back") {
			const currentModel = resolveMattermostModelPickerCurrentModel({
				cfg,
				route: modelSessionRoute,
				data
			});
			const view = renderMattermostProviderPickerView({
				ownerUserId: pickerState.ownerUserId,
				data,
				currentModel
			});
			return await updateModelPickerPost({
				channelId: params.payload.channel_id,
				postId: params.payload.post_id,
				message: view.text,
				buttons: view.buttons
			});
		}
		if (pickerState.action === "list") {
			const currentModel = resolveMattermostModelPickerCurrentModel({
				cfg,
				route: modelSessionRoute,
				data
			});
			const view = renderMattermostModelsPickerView({
				ownerUserId: pickerState.ownerUserId,
				data,
				provider: pickerState.provider,
				page: pickerState.page,
				currentModel
			});
			return await updateModelPickerPost({
				channelId: params.payload.channel_id,
				postId: params.payload.post_id,
				message: view.text,
				buttons: view.buttons
			});
		}
		const targetModelRef = `${pickerState.provider}/${pickerState.model}`;
		if (!buildMattermostAllowedModelRefs(data).has(targetModelRef)) return { ephemeral_text: `That model is no longer available: ${targetModelRef}` };
		(async () => {
			try {
				await runModelPickerCommand({
					commandText: `/model ${targetModelRef}`,
					commandAuthorized: auth.commandAuthorized,
					route,
					sessionKey: threadContext.sessionKey,
					parentSessionKey: threadContext.parentSessionKey,
					channelId: params.payload.channel_id,
					senderId: params.payload.user_id,
					senderName: params.userName,
					kind,
					chatType,
					channelName,
					channelDisplay,
					roomLabel,
					teamId,
					postId: params.payload.post_id,
					messageSid: buildMattermostModelPickerSelectMessageSid({
						postId: params.payload.post_id,
						provider: pickerState.provider,
						model: pickerState.model
					}),
					effectiveReplyToId: threadContext.effectiveReplyToId,
					deliverReplies: true
				});
				const updatedModel = resolveMattermostModelPickerCurrentModel({
					cfg,
					route: modelSessionRoute,
					data,
					skipCache: true
				});
				const view = renderMattermostModelsPickerView({
					ownerUserId: pickerState.ownerUserId,
					data,
					provider: pickerState.provider,
					page: pickerState.page,
					currentModel: updatedModel
				});
				await updateModelPickerPost({
					channelId: params.payload.channel_id,
					postId: params.payload.post_id,
					message: view.text,
					buttons: view.buttons
				});
			} catch (err) {
				runtime.error?.(`mattermost model picker select failed: ${String(err)}`);
			}
		})();
		return {};
	}
	const handlePost = async (post, payload, messageIds) => {
		const channelId = post.channel_id ?? payload.data?.channel_id ?? payload.broadcast?.channel_id;
		if (!channelId) {
			logVerboseMessage("mattermost: drop post (missing channel id)");
			return;
		}
		const allMessageIds = messageIds?.length ? messageIds : post.id ? [post.id] : [];
		if (allMessageIds.length === 0) {
			logVerboseMessage("mattermost: drop post (missing message id)");
			return;
		}
		if (await processMattermostReplayGuardedPost({
			accountId: account.accountId,
			messageIds: allMessageIds,
			handlePost: async () => {
				const senderId = post.user_id ?? payload.broadcast?.user_id;
				if (!senderId) {
					logVerboseMessage("mattermost: drop post (missing sender id)");
					return;
				}
				if (senderId === botUserId) {
					logVerboseMessage(`mattermost: drop post (self sender=${senderId})`);
					return;
				}
				if (isSystemPost(post)) {
					logVerboseMessage(`mattermost: drop post (system post type=${post.type ?? "unknown"})`);
					return;
				}
				const channelInfo = await resolveChannelInfo(channelId);
				const channelType = normalizeOptionalString(channelInfo?.type) ?? normalizeOptionalString(payload.data?.channel_type);
				if (!channelType) {
					logVerboseMessage(`mattermost: drop post (cannot resolve channel type for ${channelId})`);
					return;
				}
				const kind = resolveMattermostTrustedChatKind({ channelType });
				const chatType = channelChatType(kind);
				const senderName = normalizeOptionalString(payload.data?.sender_name) ?? normalizeOptionalString((await resolveUserInfo(senderId))?.username) ?? senderId;
				const rawText = normalizeOptionalString(post.message) ?? "";
				const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
					cfg,
					surface: "mattermost"
				});
				const isControlCommand = allowTextCommands && core.channel.commands.isControlCommandMessage(rawText, cfg);
				const accessDecision = await resolveMattermostMonitorInboundAccess({
					account,
					cfg,
					senderId,
					senderName,
					channelId,
					kind,
					groupPolicy,
					readStoreAllowFrom: pairing.readAllowFromStore,
					allowTextCommands,
					hasControlCommand: isControlCommand,
					eventKind: "message",
					mayPair: true
				});
				const commandAuthorized = accessDecision.commandAccess.authorized;
				if (accessDecision.ingress.decision !== "allow") {
					if (kind === "direct") {
						if (accessDecision.ingress.reasonCode === "dm_policy_disabled") {
							logVerboseMessage(`mattermost: drop dm (dmPolicy=disabled sender=${senderId})`);
							return;
						}
						if (accessDecision.ingress.decision === "pairing") {
							const { code, created } = await pairing.upsertPairingRequest({
								id: senderId,
								meta: { name: senderName }
							});
							logVerboseMessage(`mattermost: pairing request sender=${senderId} created=${created}`);
							if (created) try {
								await sendMessageMattermost(`user:${senderId}`, core.channel.pairing.buildPairingReply({
									channel: "mattermost",
									idLine: `Your Mattermost user id: ${senderId}`,
									code
								}), {
									cfg,
									accountId: account.accountId
								});
								opts.statusSink?.({ lastOutboundAt: Date.now() });
							} catch (err) {
								logVerboseMessage(`mattermost: pairing reply failed for ${senderId}: ${String(err)}`);
							}
							return;
						}
						logVerboseMessage(`mattermost: drop dm sender=${senderId} (dmPolicy=${dmPolicy})`);
						return;
					}
					if (accessDecision.ingress.reasonCode === "group_policy_disabled") {
						logVerboseMessage("mattermost: drop group message (groupPolicy=disabled)");
						return;
					}
					if (accessDecision.ingress.reasonCode === "group_policy_empty_allowlist") {
						logVerboseMessage("mattermost: drop group message (no group allowlist)");
						return;
					}
					if (accessDecision.ingress.reasonCode === "group_policy_not_allowlisted") {
						logVerboseMessage(`mattermost: drop group sender=${senderId} (not in groupAllowFrom)`);
						return;
					}
					logVerboseMessage(`mattermost: drop group message (groupPolicy=${groupPolicy} reason=${accessDecision.senderAccess.reasonCode})`);
					return;
				}
				if (kind !== "direct" && accessDecision.commandAccess.shouldBlockControlCommand) {
					logInboundDrop({
						log: logVerboseMessage,
						channel: "mattermost",
						reason: "control command (unauthorized)",
						target: senderId
					});
					return;
				}
				const teamId = payload.data?.team_id ?? channelInfo?.team_id ?? void 0;
				const channelName = payload.data?.channel_name ?? channelInfo?.name ?? "";
				const channelDisplay = payload.data?.channel_display_name ?? channelInfo?.display_name ?? channelName;
				const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${channelId}`;
				const route = core.channel.routing.resolveAgentRoute({
					cfg,
					channel: "mattermost",
					accountId: account.accountId,
					teamId,
					peer: {
						kind,
						id: kind === "direct" ? senderId : channelId
					}
				});
				const baseSessionKey = route.sessionKey;
				const threadRootId = normalizeOptionalString(post.root_id);
				const replyToMode = resolveMattermostReplyToMode(account, kind);
				const { effectiveReplyToId, sessionKey, parentSessionKey } = resolveMattermostThreadSessionContext({
					baseSessionKey,
					kind,
					postId: post.id,
					replyToMode,
					threadRootId
				});
				const historyKey = kind === "direct" ? null : sessionKey;
				const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
				const wasMentioned = kind !== "direct" && ((botUsername ? normalizeLowercaseStringOrEmpty(rawText).includes(`@${normalizeLowercaseStringOrEmpty(botUsername)}`) : false) || core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));
				const pendingBody = rawText || (post.file_ids?.length ? `[Mattermost ${post.file_ids.length === 1 ? "file" : "files"}]` : "");
				const pendingSender = senderName;
				const recordPendingHistory = () => {
					const trimmed = pendingBody.trim();
					createChannelHistoryWindow({ historyMap: channelHistories }).record({
						limit: historyLimit,
						historyKey: historyKey ?? "",
						entry: historyKey && trimmed ? {
							sender: pendingSender,
							body: trimmed,
							timestamp: typeof post.create_at === "number" ? post.create_at : void 0,
							messageId: post.id ?? void 0
						} : null
					});
				};
				const oncharEnabled = account.chatmode === "onchar" && kind !== "direct";
				const oncharPrefixes = oncharEnabled ? resolveOncharPrefixes(account.oncharPrefixes) : [];
				const oncharResult = oncharEnabled ? stripOncharPrefix(rawText, oncharPrefixes) : {
					triggered: false,
					stripped: rawText
				};
				const oncharTriggered = oncharResult.triggered;
				const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
				const mentionDecision = evaluateMattermostMentionGate({
					kind,
					cfg,
					accountId: account.accountId,
					channelId,
					threadRootId,
					requireMentionOverride: account.requireMention,
					resolveRequireMention: core.channel.groups.resolveRequireMention,
					wasMentioned,
					isControlCommand,
					commandAuthorized,
					oncharEnabled,
					oncharTriggered,
					canDetectMention
				});
				const { shouldRequireMention, shouldBypassMention } = mentionDecision;
				if (mentionDecision.dropReason === "onchar-not-triggered") {
					logVerboseMessage(`mattermost: drop group message (onchar not triggered channel=${channelId} sender=${senderId})`);
					recordPendingHistory();
					return;
				}
				if (mentionDecision.dropReason === "missing-mention") {
					logVerboseMessage(`mattermost: drop group message (missing mention channel=${channelId} sender=${senderId} requireMention=${shouldRequireMention} bypass=${shouldBypassMention} canDetectMention=${canDetectMention})`);
					recordPendingHistory();
					return;
				}
				const mediaList = await resolveMattermostMedia(post.file_ids);
				const mediaPlaceholder = buildMattermostAttachmentPlaceholder(mediaList);
				const bodyText = normalizeMention([oncharTriggered ? oncharResult.stripped : rawText, mediaPlaceholder].filter(Boolean).join("\n").trim(), botUsername);
				if (!bodyText) {
					logVerboseMessage(`mattermost: drop group message (empty body after normalization channel=${channelId} sender=${senderId})`);
					return;
				}
				core.channel.activity.record({
					channel: "mattermost",
					accountId: account.accountId,
					direction: "inbound"
				});
				const fromLabel = formatInboundFromLabel({
					isGroup: kind !== "direct",
					groupLabel: channelDisplay || roomLabel,
					groupId: channelId,
					groupFallback: roomLabel || "Channel",
					directLabel: senderName,
					directId: senderId
				});
				const textWithId = `${bodyText}\n[mattermost message id: ${post.id ?? "unknown"} channel: ${channelId}]`;
				let combinedBody = core.channel.reply.formatInboundEnvelope({
					channel: "Mattermost",
					from: fromLabel,
					timestamp: typeof post.create_at === "number" ? post.create_at : void 0,
					body: textWithId,
					chatType,
					sender: {
						name: senderName,
						id: senderId
					}
				});
				if (historyKey) combinedBody = createChannelHistoryWindow({ historyMap: channelHistories }).buildPendingContext({
					historyKey,
					limit: historyLimit,
					currentMessage: combinedBody,
					formatEntry: (entry) => core.channel.reply.formatInboundEnvelope({
						channel: "Mattermost",
						from: fromLabel,
						timestamp: entry.timestamp,
						body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId} channel:${channelId}]` : ""}`,
						chatType,
						senderLabel: entry.sender
					})
				});
				const to = kind === "direct" ? `user:${senderId}` : `channel:${channelId}`;
				const mediaPayload = buildAgentMediaPayload(mediaList);
				const commandBody = rawText.trim();
				const inboundHistory = historyKey && historyLimit > 0 ? createChannelHistoryWindow({ historyMap: channelHistories }).buildInboundHistory({
					historyKey,
					limit: historyLimit
				}) : void 0;
				const ctxPayload = core.channel.reply.finalizeInboundContext({
					Body: combinedBody,
					BodyForAgent: bodyText,
					InboundHistory: inboundHistory,
					RawBody: bodyText,
					CommandBody: commandBody,
					BodyForCommands: commandBody,
					From: kind === "direct" ? `mattermost:${senderId}` : kind === "group" ? `mattermost:group:${channelId}` : `mattermost:channel:${channelId}`,
					To: to,
					SessionKey: sessionKey,
					ParentSessionKey: parentSessionKey,
					AccountId: route.accountId,
					ChatType: chatType,
					ConversationLabel: fromLabel,
					GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : void 0,
					GroupChannel: channelName ? `#${channelName}` : void 0,
					GroupSpace: teamId,
					SenderName: senderName,
					SenderId: senderId,
					Provider: "mattermost",
					Surface: "mattermost",
					MessageSid: post.id ?? void 0,
					MessageSids: allMessageIds.length > 1 ? allMessageIds : void 0,
					MessageSidFirst: allMessageIds.length > 1 ? allMessageIds[0] : void 0,
					MessageSidLast: allMessageIds.length > 1 ? allMessageIds[allMessageIds.length - 1] : void 0,
					ReplyToId: effectiveReplyToId,
					MessageThreadId: effectiveReplyToId,
					Timestamp: typeof post.create_at === "number" ? post.create_at : void 0,
					WasMentioned: kind !== "direct" ? mentionDecision.effectiveWasMentioned : void 0,
					CommandAuthorized: commandAuthorized,
					OriginatingChannel: "mattermost",
					OriginatingTo: to,
					...mediaPayload
				});
				const pinnedMainDmOwner = kind === "direct" ? resolvePinnedMainDmOwnerFromAllowlist({
					dmScope: cfg.session?.dmScope,
					allowFrom: account.config.allowFrom,
					normalizeEntry: normalizeMattermostAllowEntry
				}) : null;
				const storePath = core.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
				const previewLine = bodyText.slice(0, 200).replace(/\n/g, "\\n");
				logVerboseMessage(`mattermost inbound: from=${ctxPayload.From} len=${bodyText.length} preview="${previewLine}"`);
				const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "mattermost", account.accountId, { fallbackLimit: account.textChunkLimit ?? 4e3 });
				const tableMode = core.channel.text.resolveMarkdownTableMode({
					cfg,
					channel: "mattermost",
					accountId: account.accountId
				});
				const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
					cfg,
					agentId: route.agentId,
					channel: "mattermost",
					accountId: account.accountId,
					typing: {
						start: () => sendTypingIndicator(channelId, effectiveReplyToId),
						onStartError: (err) => {
							logTypingFailure({
								log: (message) => logger.debug?.(message),
								channel: "mattermost",
								target: channelId,
								error: err
							});
						}
					}
				});
				const draftPreviewEnabled = account.streamingMode !== "off";
				const draftToolProgressEnabled = shouldUpdateMattermostDraftToolProgress(account);
				const suppressDefaultToolProgressMessages = shouldSuppressMattermostDefaultToolProgressMessages(account);
				const draftStream = draftPreviewEnabled ? createMattermostDraftStream({
					client,
					channelId,
					rootId: effectiveReplyToId,
					throttleMs: 1200,
					log: logVerboseMessage,
					warn: logVerboseMessage
				}) : createDisabledMattermostDraftStream();
				let lastPartialText = "";
				const previewState = { finalizedViaPreviewPost: false };
				const resolvePreviewFinalText = (text) => {
					if (typeof text !== "string") return;
					const formatted = core.channel.text.convertMarkdownTables(text, tableMode);
					const chunkMode = core.channel.text.resolveChunkMode(cfg, "mattermost", account.accountId);
					const chunks = core.channel.text.chunkMarkdownTextWithMode(formatted, textLimit, chunkMode);
					if (!chunks.length && formatted) chunks.push(formatted);
					if (chunks.length != 1) return;
					const trimmed = chunks[0]?.trim();
					if (!trimmed) return;
					if (lastPartialText && lastPartialText.startsWith(trimmed) && trimmed.length < lastPartialText.length) return;
					return trimmed;
				};
				const updateDraftFromPartial = (text) => {
					const cleaned = text?.trim();
					if (!cleaned) return;
					if (cleaned === lastPartialText) return;
					if (lastPartialText && lastPartialText.startsWith(cleaned) && cleaned.length < lastPartialText.length) return;
					lastPartialText = cleaned;
					draftStream.update(cleaned);
				};
				const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } = core.channel.reply.createReplyDispatcherWithTyping({
					...replyPipeline,
					humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
					typingCallbacks,
					deliver: async (payload, info) => {
						await deliverMattermostReplyWithDraftPreview({
							payload,
							info,
							kind,
							client,
							draftStream,
							effectiveReplyToId,
							resolvePreviewFinalText,
							previewState,
							logVerboseMessage,
							deliverPayload: async (payloadToDeliver) => {
								const deliveryLog = formatMattermostFinalDeliveryOutcomeLog({
									outcome: await deliverMattermostReplyPayload({
										core,
										cfg,
										payload: payloadToDeliver,
										to,
										accountId: account.accountId,
										agentId: route.agentId,
										replyToId: resolveMattermostReplyRootId({
											kind,
											threadRootId: effectiveReplyToId,
											replyToId: payloadToDeliver.replyToId
										}),
										textLimit,
										tableMode,
										sendMessage: sendMessageMattermost
									}),
									payload: payloadToDeliver,
									to,
									accountId: account.accountId,
									agentId: route.agentId
								});
								if (deliveryLog) runtime.log?.(deliveryLog);
							}
						});
					},
					onError: (err, info) => {
						runtime.error?.(`mattermost ${info.kind} reply failed: ${String(err)}`);
					}
				});
				const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
					route,
					sessionKey: route.sessionKey
				});
				let dispatchSettledBeforeStart = false;
				try {
					await core.channel.turn.run({
						channel: "mattermost",
						accountId: route.accountId,
						raw: post,
						adapter: {
							ingest: () => ({
								id: post.id ?? `${to}:${Date.now()}`,
								timestamp: post.create_at ?? void 0,
								rawText,
								textForAgent: ctxPayload.BodyForAgent,
								textForCommands: ctxPayload.CommandBody,
								raw: post
							}),
							resolveTurn: () => ({
								channel: "mattermost",
								accountId: route.accountId,
								routeSessionKey: route.sessionKey,
								storePath,
								ctxPayload,
								recordInboundSession: core.channel.session.recordInboundSession,
								record: {
									updateLastRoute: kind === "direct" ? {
										sessionKey: inboundLastRouteSessionKey,
										channel: "mattermost",
										to,
										accountId: route.accountId,
										mainDmOwnerPin: inboundLastRouteSessionKey === route.mainSessionKey && pinnedMainDmOwner ? {
											ownerRecipient: pinnedMainDmOwner,
											senderRecipient: normalizeMattermostAllowEntry(senderId),
											onSkip: ({ ownerRecipient, senderRecipient }) => {
												logVerboseMessage(`mattermost: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`);
											}
										} : void 0
									} : void 0,
									onRecordError: (err) => {
										logVerboseMessage(`mattermost: failed updating session meta id=${post.id ?? "unknown"}: ${String(err)}`);
									}
								},
								history: {
									isGroup: Boolean(historyKey),
									historyKey: historyKey ?? void 0,
									historyMap: channelHistories,
									limit: historyLimit
								},
								onPreDispatchFailure: async () => {
									dispatchSettledBeforeStart = true;
									await core.channel.reply.settleReplyDispatcher({
										dispatcher,
										onSettled: () => {
											markRunComplete();
											markDispatchIdle();
										}
									});
								},
								runDispatch: () => core.channel.reply.withReplyDispatcher({
									dispatcher,
									onSettled: () => {
										markDispatchIdle();
									},
									run: () => core.channel.reply.dispatchReplyFromConfig({
										ctx: ctxPayload,
										cfg,
										dispatcher,
										replyOptions: {
											...replyOptions,
											disableBlockStreaming: true,
											...suppressDefaultToolProgressMessages ? { suppressDefaultToolProgressMessages: true } : {},
											onModelSelected,
											onPartialReply: (payload) => {
												if (account.streamingMode !== "progress") updateDraftFromPartial(payload.text);
											},
											onAssistantMessageStart: () => {
												lastPartialText = "";
											},
											onReasoningEnd: () => {
												lastPartialText = "";
											},
											onReasoningStream: async () => {
												if (!lastPartialText) draftStream.update("Thinking…");
											},
											onToolStart: async (payload) => {
												if (!draftToolProgressEnabled) return;
												draftStream.update(buildMattermostToolStatusText({
													...payload,
													config: account.config
												}));
											},
											onItemEvent: async (payload) => {
												if (!draftToolProgressEnabled) return;
												const progressText = formatChannelProgressDraftLineForEntry(account.config, {
													event: "item",
													itemId: payload.itemId,
													itemKind: payload.kind,
													title: payload.title,
													name: payload.name,
													phase: payload.phase,
													status: payload.status,
													summary: payload.summary,
													progressText: payload.progressText,
													meta: payload.meta
												});
												if (progressText) draftStream.update(progressText);
											}
										}
									})
								})
							})
						}
					});
				} finally {
					try {
						await draftStream.stop();
					} catch (err) {
						logVerboseMessage(`mattermost draft preview cleanup failed: ${String(err)}`);
					}
					if (!dispatchSettledBeforeStart) markRunComplete();
				}
			}
		}) === "duplicate") {
			logVerboseMessage(`mattermost: drop post (dedupe account=${account.accountId} ids=${allMessageIds.length})`);
			return;
		}
	};
	const handleReactionEvent = async (payload) => {
		const reactionData = payload.data?.reaction;
		if (!reactionData) return;
		let reaction = null;
		if (typeof reactionData === "string") try {
			reaction = JSON.parse(reactionData);
		} catch {
			return;
		}
		else if (typeof reactionData === "object") reaction = reactionData;
		if (!reaction) return;
		const userId = reaction.user_id?.trim();
		const postId = reaction.post_id?.trim();
		const emojiName = reaction.emoji_name?.trim();
		if (!userId || !postId || !emojiName) return;
		if (userId === botUserId) return;
		const action = payload.event === "reaction_removed" ? "removed" : "added";
		const senderName = normalizeOptionalString((await resolveUserInfo(userId))?.username) ?? userId;
		const channelId = resolveMattermostReactionChannelId(payload);
		if (!channelId) {
			logVerboseMessage(`mattermost: drop reaction (no channel_id in broadcast, cannot enforce policy)`);
			return;
		}
		const channelInfo = await resolveChannelInfo(channelId);
		if (!channelInfo?.type) {
			logVerboseMessage(`mattermost: drop reaction (cannot resolve channel type for ${channelId})`);
			return;
		}
		const kind = mapMattermostChannelTypeToChatType(channelInfo.type);
		const reactionAccess = await resolveMattermostMonitorInboundAccess({
			account,
			cfg,
			senderId: userId,
			senderName,
			channelId,
			kind,
			groupPolicy,
			readStoreAllowFrom: pairing.readAllowFromStore,
			allowTextCommands: false,
			hasControlCommand: false,
			eventKind: "reaction",
			mayPair: false
		});
		if (reactionAccess.ingress.decision !== "allow") {
			if (kind === "direct") logVerboseMessage(`mattermost: drop reaction (dmPolicy=${dmPolicy} sender=${userId} reason=${reactionAccess.senderAccess.reasonCode})`);
			else logVerboseMessage(`mattermost: drop reaction (groupPolicy=${groupPolicy} sender=${userId} reason=${reactionAccess.senderAccess.reasonCode} channel=${channelId})`);
			return;
		}
		const teamId = channelInfo?.team_id ?? void 0;
		const sessionKey = core.channel.routing.resolveAgentRoute({
			cfg,
			channel: "mattermost",
			accountId: account.accountId,
			teamId,
			peer: {
				kind,
				id: kind === "direct" ? userId : channelId
			}
		}).sessionKey;
		const eventText = `Mattermost reaction ${action}: :${emojiName}: by @${senderName} on post ${postId} in channel ${channelId}`;
		core.system.enqueueSystemEvent(eventText, {
			sessionKey,
			contextKey: `mattermost:reaction:${postId}:${emojiName}:${userId}:${action}`
		});
		logVerboseMessage(`mattermost reaction: ${action} :${emojiName}: by ${senderName} on ${postId}`);
	};
	const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
		cfg,
		channel: "mattermost"
	});
	const debouncer = core.channel.debounce.createInboundDebouncer({
		debounceMs: inboundDebounceMs,
		buildKey: (entry) => {
			const channelId = entry.post.channel_id ?? entry.payload.data?.channel_id ?? entry.payload.broadcast?.channel_id;
			if (!channelId) return null;
			const threadId = normalizeOptionalString(entry.post.root_id);
			const threadKey = threadId ? `thread:${threadId}` : "channel";
			return `mattermost:${account.accountId}:${channelId}:${threadKey}`;
		},
		shouldDebounce: (entry) => {
			if (entry.post.file_ids && entry.post.file_ids.length > 0) return false;
			const text = normalizeOptionalString(entry.post.message) ?? "";
			if (!text) return false;
			return !core.channel.commands.isControlCommandMessage(text, cfg);
		},
		onFlush: async (entries) => {
			const last = entries.at(-1);
			if (!last) return;
			if (entries.length === 1) {
				await handlePost(last.post, last.payload);
				return;
			}
			const combinedText = entries.map((entry) => normalizeOptionalString(entry.post.message) ?? "").filter(Boolean).join("\n");
			const mergedPost = {
				...last.post,
				message: combinedText,
				file_ids: []
			};
			const ids = entries.map((entry) => entry.post.id).filter(Boolean);
			await handlePost(mergedPost, last.payload, ids.length > 0 ? ids : void 0);
		},
		onError: (err) => {
			runtime.error?.(`mattermost debounce flush failed: ${String(err)}`);
		}
	});
	const wsUrl = buildMattermostWsUrl(baseUrl);
	let seq = 1;
	const connectOnce = createMattermostConnectOnce({
		wsUrl,
		botToken,
		abortSignal: opts.abortSignal,
		statusSink: opts.statusSink,
		runtime,
		webSocketFactory: opts.webSocketFactory,
		nextSeq: () => seq++,
		getBotUpdateAt: async () => {
			return (await fetchMattermostMe(client)).update_at ?? 0;
		},
		onPosted: async (post, payload) => {
			await debouncer.enqueue({
				post,
				payload
			});
		},
		onReaction: async (payload) => {
			await handleReactionEvent(payload);
		}
	});
	let slashShutdownCleanup = null;
	if (slashEnabled) {
		const runAbortCleanup = () => {
			if (slashShutdownCleanup) return;
			const commands = getSlashCommandState(account.accountId)?.registeredCommands ?? [];
			deactivateSlashCommands(account.accountId);
			slashShutdownCleanup = cleanupSlashCommands({
				client,
				commands,
				log: (msg) => runtime.log?.(msg)
			}).catch((err) => {
				runtime.error?.(`mattermost: slash cleanup failed: ${String(err)}`);
			});
		};
		if (opts.abortSignal?.aborted) runAbortCleanup();
		else opts.abortSignal?.addEventListener("abort", runAbortCleanup, { once: true });
	}
	try {
		await runWithReconnect(connectOnce, {
			abortSignal: opts.abortSignal,
			jitterRatio: .2,
			onError: (err) => {
				runtime.error?.(`mattermost connection failed: ${String(err)}`);
				opts.statusSink?.({
					lastError: String(err),
					connected: false
				});
			},
			onReconnect: (delayMs) => {
				runtime.log?.(`mattermost reconnecting in ${Math.round(delayMs / 1e3)}s`);
			}
		});
	} finally {
		unregisterInteractions?.();
	}
	const slashShutdownCleanupPromise = slashShutdownCleanup;
	if (slashShutdownCleanupPromise) await Promise.resolve(slashShutdownCleanupPromise);
}
//#endregion
//#region extensions/mattermost/src/mattermost/probe.ts
async function probeMattermost(baseUrl, botToken, timeoutMs = 2500, allowPrivateNetwork = false) {
	const normalized = normalizeMattermostBaseUrl(baseUrl);
	if (!normalized) return {
		ok: false,
		error: "baseUrl missing"
	};
	const url = `${normalized}/api/v4/users/me`;
	const start = Date.now();
	const controller = timeoutMs > 0 ? new AbortController() : void 0;
	let timer = null;
	if (controller) timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const { response: res, release } = await fetchWithSsrFGuard({
			url,
			init: {
				headers: { Authorization: `Bearer ${botToken}` },
				signal: controller?.signal
			},
			auditContext: "mattermost-probe",
			policy: ssrfPolicyFromPrivateNetworkOptIn(allowPrivateNetwork)
		});
		try {
			const elapsedMs = Date.now() - start;
			if (!res.ok) {
				const detail = await readMattermostError(res);
				return {
					ok: false,
					status: res.status,
					error: detail || res.statusText,
					elapsedMs
				};
			}
			const bot = await res.json();
			return {
				ok: true,
				status: res.status,
				elapsedMs,
				bot
			};
		} finally {
			await release();
		}
	} catch (err) {
		return {
			ok: false,
			status: null,
			error: formatErrorMessage(err),
			elapsedMs: Date.now() - start
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}
//#endregion
//#region extensions/mattermost/src/mattermost/reactions.ts
const BOT_USER_CACHE_TTL_MS = 10 * 6e4;
const botUserIdCache = /* @__PURE__ */ new Map();
async function resolveBotUserId(client, cacheKey) {
	const cached = botUserIdCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) return cached.userId;
	const userId = (await fetchMattermostMe(client))?.id?.trim();
	if (!userId) return null;
	botUserIdCache.set(cacheKey, {
		userId,
		expiresAt: Date.now() + BOT_USER_CACHE_TTL_MS
	});
	return userId;
}
async function addMattermostReaction(params) {
	return runMattermostReaction(params, {
		action: "add",
		mutation: createReaction
	});
}
async function removeMattermostReaction(params) {
	return runMattermostReaction(params, {
		action: "remove",
		mutation: deleteReaction
	});
}
async function runMattermostReaction(params, options) {
	const resolved = resolveMattermostAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const baseUrl = resolved.baseUrl?.trim();
	const botToken = resolved.botToken?.trim();
	if (!baseUrl || !botToken) return {
		ok: false,
		error: "Mattermost botToken/baseUrl missing."
	};
	const client = createMattermostClient({
		baseUrl,
		botToken,
		fetchImpl: params.fetchImpl,
		allowPrivateNetwork: isPrivateNetworkOptInEnabled(resolved.config)
	});
	const userId = await resolveBotUserId(client, `${baseUrl}:${botToken}`);
	if (!userId) return {
		ok: false,
		error: "Mattermost reactions failed: could not resolve bot user id."
	};
	try {
		await options.mutation(client, {
			userId,
			postId: params.postId,
			emojiName: params.emojiName
		});
	} catch (err) {
		return {
			ok: false,
			error: `Mattermost ${options.action} reaction failed: ${String(err)}`
		};
	}
	return { ok: true };
}
async function createReaction(client, params) {
	await client.request("/reactions", {
		method: "POST",
		body: JSON.stringify({
			user_id: params.userId,
			post_id: params.postId,
			emoji_name: params.emojiName
		})
	});
}
async function deleteReaction(client, params) {
	const emoji = encodeURIComponent(params.emojiName);
	await client.request(`/users/${params.userId}/posts/${params.postId}/reactions/${emoji}`, { method: "DELETE" });
}
//#endregion
export { addMattermostReaction, listMattermostDirectoryGroups, listMattermostDirectoryPeers, monitorMattermostProvider, probeMattermost, removeMattermostReaction, resolveMattermostOpaqueTarget, sendMessageMattermost };
