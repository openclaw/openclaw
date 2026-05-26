import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { t as safeEqualSecret } from "./secret-equal-DDhtiQsP.js";
import { c as isTrustedProxyAddress, f as resolveClientIp } from "./net-DCUMtgJy.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { i as deliverTextOrMediaReply, m as resolveSendableOutboundReplyParts, u as isReasoningReplyPayload } from "./reply-payload-DMPQsrQC.js";
import { r as getAgentScopedMediaLocalRoots } from "./local-roots-Pi6a9oaK.js";
import { t as createMessageReceiptFromOutboundResults } from "./receipt-vrVTwZtS.js";
import { n as resolveStoredModelOverride } from "./stored-model-override-DwKmC9nn.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./provider-model-shared-DtsPmvDx.js";
import { t as createChannelReplyPipeline } from "./reply-pipeline-EtNTatED.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DCRkoyVz.js";
import { t as convertMarkdownTables } from "./tables-D3y68tNR.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-DWa7yCpn.js";
import { t as loadOutboundMediaFromUrl } from "./outbound-media-BwaTbAKd.js";
import { a as isRequestBodyLimitError, s as readRequestBodyWithLimit } from "./http-body-BfDL157U.js";
import { o as isPrivateNetworkOptInEnabled } from "./ssrf-policy-CIwd6x-p.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./media-runtime-BheBFFxc.js";
import "./text-chunking-C154U6-i.js";
import "./security-runtime-CcSekjBd.js";
import "./markdown-table-runtime-BRMInqmJ.js";
import { t as buildModelsProviderData } from "./commands-models-C5hB5Z12.js";
import "./command-auth-native-BhcKSceK.js";
import { r as logTypingFailure } from "./logging-Dr3f0mtP.js";
import "./channel-message-DMGbyII_.js";
import { t as loadSessionStore } from "./session-store-runtime-DCQkOAps.js";
import { i as normalizeMattermostAllowList, t as authorizeMattermostCommandInvocation } from "./monitor-auth-Ce-BTHuT.js";
import { b as uploadMattermostFile, c as createMattermostPost, d as fetchMattermostChannelByName, f as fetchMattermostMe, g as normalizeMattermostBaseUrl, h as fetchMattermostUserTeams, m as fetchMattermostUserByUsername, o as createMattermostClient, p as fetchMattermostUser, r as resolveMattermostAccount, s as createMattermostDirectChannelWithRetry, u as fetchMattermostChannel, v as sendMattermostTyping, y as updateMattermostPost } from "./accounts-BSHeJeZB.js";
import { t as getMattermostRuntime } from "./runtime-CesoaWNy.js";
import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
/**
* Built-in OpenClaw commands to register as native slash commands.
* These mirror the text-based commands already handled by the gateway.
*/
const DEFAULT_COMMAND_SPECS = [
	{
		trigger: "oc_status",
		originalName: "status",
		description: "Show session status (model, usage, uptime)",
		autoComplete: true
	},
	{
		trigger: "oc_model",
		originalName: "model",
		description: "View or change the current model",
		autoComplete: true,
		autoCompleteHint: "[model-name] [--runtime runtime]"
	},
	{
		trigger: "oc_models",
		originalName: "models",
		description: "Browse available models",
		autoComplete: true,
		autoCompleteHint: "[provider]"
	},
	{
		trigger: "oc_new",
		originalName: "new",
		description: "Start a new conversation session",
		autoComplete: true
	},
	{
		trigger: "oc_help",
		originalName: "help",
		description: "Show available commands",
		autoComplete: true
	},
	{
		trigger: "oc_think",
		originalName: "think",
		description: "Set thinking/reasoning level",
		autoComplete: true,
		autoCompleteHint: "[off|low|medium|high]"
	},
	{
		trigger: "oc_reasoning",
		originalName: "reasoning",
		description: "Toggle reasoning mode",
		autoComplete: true,
		autoCompleteHint: "[on|off]"
	},
	{
		trigger: "oc_verbose",
		originalName: "verbose",
		description: "Toggle verbose mode",
		autoComplete: true,
		autoCompleteHint: "[on|off]"
	}
];
/**
* List existing custom slash commands for a team.
*/
async function listMattermostCommands(client, teamId, init) {
	return await client.request(`/commands?team_id=${encodeURIComponent(teamId)}&custom_only=true`, init);
}
/**
* Get a custom slash command by id.
*/
async function getMattermostCommand(client, commandId, init) {
	return await client.request(`/commands/${encodeURIComponent(commandId)}`, init);
}
/**
* Create a custom slash command on a Mattermost team.
*/
async function createMattermostCommand(client, params) {
	return await client.request("/commands", {
		method: "POST",
		body: JSON.stringify(params)
	});
}
/**
* Delete a custom slash command.
*/
async function deleteMattermostCommand(client, commandId) {
	await client.request(`/commands/${encodeURIComponent(commandId)}`, { method: "DELETE" });
}
/**
* Update an existing custom slash command.
*/
async function updateMattermostCommand(client, params) {
	return await client.request(`/commands/${encodeURIComponent(params.id)}`, {
		method: "PUT",
		body: JSON.stringify(params)
	});
}
/**
* Register all OpenClaw slash commands for a given team.
* Skips commands that are already registered with the same trigger + callback URL.
* Returns the list of newly created command IDs.
*/
async function registerSlashCommands(params) {
	const { client, teamId, creatorUserId, callbackUrl, commands, log } = params;
	const normalizedCreatorUserId = creatorUserId.trim();
	if (!normalizedCreatorUserId) throw new Error("creatorUserId is required for slash command reconciliation");
	let existing = [];
	try {
		existing = await listMattermostCommands(client, teamId);
	} catch (err) {
		log?.(`mattermost: failed to list existing commands: ${String(err)}`);
		throw err;
	}
	const existingByTrigger = /* @__PURE__ */ new Map();
	for (const cmd of existing) {
		const list = existingByTrigger.get(cmd.trigger) ?? [];
		list.push(cmd);
		existingByTrigger.set(cmd.trigger, list);
	}
	const registered = [];
	for (const spec of commands) {
		const existingForTrigger = existingByTrigger.get(spec.trigger) ?? [];
		const ownedCommands = existingForTrigger.filter((cmd) => cmd.creator_id?.trim() === normalizedCreatorUserId);
		const foreignCommands = existingForTrigger.filter((cmd) => cmd.creator_id?.trim() !== normalizedCreatorUserId);
		if (ownedCommands.length === 0 && foreignCommands.length > 0) {
			log?.(`mattermost: trigger /${spec.trigger} already used by non-OpenClaw command(s); skipping to avoid mutating external integrations`);
			continue;
		}
		if (ownedCommands.length > 1) log?.(`mattermost: multiple owned commands found for /${spec.trigger}; using the first and leaving extras untouched`);
		const existingCmd = ownedCommands[0];
		const existingNeedsUpdate = existingCmd ? existingCmd.url !== callbackUrl || existingCmd.method !== "P" : false;
		if (existingCmd && !existingNeedsUpdate) {
			log?.(`mattermost: command /${spec.trigger} already registered (id=${existingCmd.id})`);
			registered.push({
				id: existingCmd.id,
				trigger: spec.trigger,
				teamId,
				token: existingCmd.token,
				url: callbackUrl,
				managed: false
			});
			continue;
		}
		if (existingCmd && existingNeedsUpdate) {
			log?.(`mattermost: command /${spec.trigger} exists with different callback settings; updating (id=${existingCmd.id})`);
			try {
				const updated = await updateMattermostCommand(client, {
					id: existingCmd.id,
					team_id: teamId,
					trigger: spec.trigger,
					method: "P",
					url: callbackUrl,
					description: spec.description,
					auto_complete: spec.autoComplete,
					auto_complete_desc: spec.description,
					auto_complete_hint: spec.autoCompleteHint
				});
				registered.push({
					id: updated.id,
					trigger: spec.trigger,
					teamId,
					token: updated.token,
					url: callbackUrl,
					managed: false
				});
				continue;
			} catch (err) {
				log?.(`mattermost: failed to update command /${spec.trigger} (id=${existingCmd.id}): ${String(err)}`);
				try {
					await deleteMattermostCommand(client, existingCmd.id);
					log?.(`mattermost: deleted stale command /${spec.trigger} (id=${existingCmd.id})`);
				} catch (deleteErr) {
					log?.(`mattermost: failed to delete stale command /${spec.trigger} (id=${existingCmd.id}): ${String(deleteErr)}`);
					continue;
				}
			}
		}
		try {
			const created = await createMattermostCommand(client, {
				team_id: teamId,
				trigger: spec.trigger,
				method: "P",
				url: callbackUrl,
				description: spec.description,
				auto_complete: spec.autoComplete,
				auto_complete_desc: spec.description,
				auto_complete_hint: spec.autoCompleteHint
			});
			log?.(`mattermost: registered command /${spec.trigger} (id=${created.id})`);
			registered.push({
				id: created.id,
				trigger: spec.trigger,
				teamId,
				token: created.token,
				url: callbackUrl,
				managed: true
			});
		} catch (err) {
			log?.(`mattermost: failed to register command /${spec.trigger}: ${String(err)}`);
		}
	}
	return registered;
}
/**
* Clean up all registered slash commands.
*/
async function cleanupSlashCommands(params) {
	const { client, commands, log } = params;
	for (const cmd of commands) {
		if (!cmd.managed) continue;
		try {
			await deleteMattermostCommand(client, cmd.id);
			log?.(`mattermost: deleted command /${cmd.trigger} (id=${cmd.id})`);
		} catch (err) {
			log?.(`mattermost: failed to delete command /${cmd.trigger}: ${String(err)}`);
		}
	}
}
/**
* Parse a Mattermost slash command callback payload from a URL-encoded or JSON body.
*/
function parseSlashCommandPayload(body, contentType) {
	if (!body) return null;
	try {
		if (contentType?.includes("application/json")) {
			const parsed = JSON.parse(body);
			const token = typeof parsed.token === "string" ? parsed.token : "";
			const teamId = typeof parsed.team_id === "string" ? parsed.team_id : "";
			const channelId = typeof parsed.channel_id === "string" ? parsed.channel_id : "";
			const userId = typeof parsed.user_id === "string" ? parsed.user_id : "";
			const command = typeof parsed.command === "string" ? parsed.command : "";
			if (!token || !teamId || !channelId || !userId || !command) return null;
			return {
				token,
				team_id: teamId,
				team_domain: typeof parsed.team_domain === "string" ? parsed.team_domain : void 0,
				channel_id: channelId,
				channel_name: typeof parsed.channel_name === "string" ? parsed.channel_name : void 0,
				user_id: userId,
				user_name: typeof parsed.user_name === "string" ? parsed.user_name : void 0,
				command,
				text: typeof parsed.text === "string" ? parsed.text : "",
				trigger_id: typeof parsed.trigger_id === "string" ? parsed.trigger_id : void 0,
				response_url: typeof parsed.response_url === "string" ? parsed.response_url : void 0
			};
		}
		const params = new URLSearchParams(body);
		const token = params.get("token");
		const teamId = params.get("team_id");
		const channelId = params.get("channel_id");
		const userId = params.get("user_id");
		const command = params.get("command");
		if (!token || !teamId || !channelId || !userId || !command) return null;
		return {
			token,
			team_id: teamId,
			team_domain: params.get("team_domain") ?? void 0,
			channel_id: channelId,
			channel_name: params.get("channel_name") ?? void 0,
			user_id: userId,
			user_name: params.get("user_name") ?? void 0,
			command,
			text: params.get("text") ?? "",
			trigger_id: params.get("trigger_id") ?? void 0,
			response_url: params.get("response_url") ?? void 0
		};
	} catch {
		return null;
	}
}
/**
* Map the trigger word back to the original OpenClaw command name.
* e.g. "oc_status" -> "/status", "oc_model" -> "/model"
*/
function resolveCommandText(trigger, text, triggerMap) {
	const commandName = triggerMap?.get(trigger) ?? (trigger.startsWith("oc_") ? trigger.slice(3) : trigger);
	const args = text.trim();
	return args ? `/${commandName} ${args}` : `/${commandName}`;
}
function normalizeSlashCommandTrigger(command) {
	return command.replace(/^\//, "").trim();
}
const DEFAULT_CALLBACK_PATH = "/api/channels/mattermost/command";
/**
* Ensure the callback path starts with a leading `/` to prevent
* malformed URLs like `http://host:portapi/...`.
*/
function normalizeCallbackPath(path) {
	const trimmed = path.trim();
	if (!trimmed) return DEFAULT_CALLBACK_PATH;
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
function resolveSlashCommandConfig(raw) {
	return {
		native: raw?.native ?? "auto",
		nativeSkills: raw?.nativeSkills ?? "auto",
		callbackPath: normalizeCallbackPath(raw?.callbackPath ?? DEFAULT_CALLBACK_PATH),
		callbackUrl: normalizeOptionalString(raw?.callbackUrl)
	};
}
function isSlashCommandsEnabled(config) {
	if (config.native === true) return true;
	if (config.native === false) return false;
	return false;
}
/**
* Build the callback URL that Mattermost will POST to when a command is invoked.
*/
function resolveCallbackUrl(params) {
	if (params.config.callbackUrl) return params.config.callbackUrl;
	const isWildcardBindHost = (rawHost) => {
		const trimmed = rawHost.trim();
		if (!trimmed) return false;
		const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
		return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0" || host === "::0";
	};
	let host = params.gatewayHost && !isWildcardBindHost(params.gatewayHost) ? params.gatewayHost : "localhost";
	const path = normalizeCallbackPath(params.config.callbackPath);
	if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) host = `[${host}]`;
	return `http://${host}:${params.gatewayPort}${path}`;
}
//#endregion
//#region extensions/mattermost/src/mattermost/model-picker.ts
const MATTERMOST_MODEL_PICKER_CONTEXT_KEY = "oc_model_picker";
const MODELS_PAGE_SIZE = 8;
const ACTION_IDS = {
	providers: "mdlprov",
	list: "mdllist",
	select: "mdlsel",
	back: "mdlback"
};
function splitModelRef(modelRef) {
	const match = normalizeOptionalString(modelRef)?.match(/^([^/]+)\/(.+)$/u);
	if (!match) return null;
	const provider = normalizeProviderId(match[1]);
	const model = normalizeOptionalString(match[2]);
	if (!provider || !model) return null;
	return {
		provider,
		model
	};
}
function readContextString(context, key, fallback = "") {
	const value = context[key];
	return typeof value === "string" ? value : fallback;
}
function readContextNumber(context, key) {
	const value = context[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed)) return parsed;
	}
}
function normalizePage(value) {
	if (!Number.isFinite(value)) return 1;
	return Math.max(1, Math.floor(value));
}
function paginateItems(items, page, pageSize = MODELS_PAGE_SIZE) {
	const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
	const safePage = Math.max(1, Math.min(normalizePage(page), totalPages));
	const start = (safePage - 1) * pageSize;
	return {
		items: items.slice(start, start + pageSize),
		page: safePage,
		totalPages,
		hasPrev: safePage > 1,
		hasNext: safePage < totalPages,
		totalItems: items.length
	};
}
function buildContext(state) {
	return {
		[MATTERMOST_MODEL_PICKER_CONTEXT_KEY]: true,
		...state
	};
}
function buildButtonId(state) {
	const digest = createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 12);
	return `${ACTION_IDS[state.action]}${digest}`;
}
function buildButton(params) {
	const baseState = params.action === "providers" || params.action === "back" ? {
		action: params.action,
		ownerUserId: params.ownerUserId
	} : params.action === "list" ? {
		action: "list",
		ownerUserId: params.ownerUserId,
		provider: normalizeProviderId(params.provider ?? ""),
		page: normalizePage(params.page)
	} : {
		action: "select",
		ownerUserId: params.ownerUserId,
		provider: normalizeProviderId(params.provider ?? ""),
		page: normalizePage(params.page),
		model: normalizeStringifiedOptionalString(params.model) ?? ""
	};
	return {
		id: buildButtonId(baseState),
		text: params.text,
		...params.style ? { style: params.style } : {},
		context: buildContext(baseState)
	};
}
function getProviderModels(data, provider) {
	return [...data.byProvider.get(normalizeProviderId(provider)) ?? /* @__PURE__ */ new Set()].toSorted();
}
function formatCurrentModelLine(currentModel) {
	const parsed = splitModelRef(currentModel);
	if (!parsed) return "Current: default";
	return `Current: ${parsed.provider}/${parsed.model}`;
}
function resolveMattermostModelPickerEntry(commandText) {
	const normalized = commandText.trim().replace(/\s+/g, " ");
	if (/^\/model$/i.test(normalized)) return { kind: "summary" };
	if (/^\/models$/i.test(normalized)) return { kind: "providers" };
	const providerMatch = normalized.match(/^\/models\s+(\S+)$/i);
	if (!providerMatch?.[1]) return null;
	return {
		kind: "models",
		provider: normalizeProviderId(providerMatch[1])
	};
}
function parseMattermostModelPickerContext(context) {
	if (!context || context[MATTERMOST_MODEL_PICKER_CONTEXT_KEY] !== true) return null;
	const ownerUserId = normalizeOptionalString(readContextString(context, "ownerUserId")) ?? "";
	const action = normalizeOptionalString(readContextString(context, "action")) ?? "";
	if (!ownerUserId) return null;
	if (action === "providers" || action === "back") return {
		action,
		ownerUserId
	};
	const provider = normalizeProviderId(readContextString(context, "provider"));
	const page = readContextNumber(context, "page");
	if (!provider) return null;
	if (action === "list") return {
		action,
		ownerUserId,
		provider,
		page: normalizePage(page)
	};
	if (action === "select") {
		const model = normalizeOptionalString(readContextString(context, "model")) ?? "";
		if (!model) return null;
		return {
			action,
			ownerUserId,
			provider,
			page: normalizePage(page),
			model
		};
	}
	return null;
}
function buildMattermostAllowedModelRefs(data) {
	const refs = /* @__PURE__ */ new Set();
	for (const provider of data.providers) for (const model of data.byProvider.get(provider) ?? []) refs.add(`${provider}/${model}`);
	return refs;
}
function resolveMattermostModelPickerCurrentModel(params) {
	const fallback = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
	try {
		const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.route.agentId });
		const sessionStore = params.skipCache ? loadSessionStore(storePath, { skipCache: true }) : loadSessionStore(storePath);
		const sessionEntry = sessionStore[params.route.sessionKey];
		const override = resolveStoredModelOverride({
			sessionEntry,
			sessionStore,
			sessionKey: params.route.sessionKey,
			defaultProvider: params.data.resolvedDefault.provider
		});
		if (!override?.model) return fallback;
		const provider = (override.provider || params.data.resolvedDefault.provider).trim();
		return provider ? `${provider}/${override.model}` : fallback;
	} catch {
		return fallback;
	}
}
function renderMattermostModelSummaryView(params) {
	return {
		text: [
			formatCurrentModelLine(params.currentModel),
			"",
			"Tap below to browse models, or use:",
			"/oc_model <provider/model> to switch",
			"Browse keeps the current runtime; use /oc_model <provider/model> --runtime <runtime> to switch runtime too",
			"/oc_model status for details"
		].join("\n"),
		buttons: [[buildButton({
			action: "providers",
			ownerUserId: params.ownerUserId,
			text: "Browse providers",
			style: "primary"
		})]]
	};
}
function renderMattermostProviderPickerView(params) {
	const currentProvider = splitModelRef(params.currentModel)?.provider;
	const rows = params.data.providers.map((provider) => [buildButton({
		action: "list",
		ownerUserId: params.ownerUserId,
		text: `${provider} (${params.data.byProvider.get(provider)?.size ?? 0})`,
		provider,
		page: 1,
		style: provider === currentProvider ? "primary" : "default"
	})]);
	return {
		text: [
			formatCurrentModelLine(params.currentModel),
			"",
			"Select a provider:"
		].join("\n"),
		buttons: rows
	};
}
function renderMattermostModelsPickerView(params) {
	const provider = normalizeProviderId(params.provider);
	const models = getProviderModels(params.data, provider);
	const current = splitModelRef(params.currentModel);
	if (models.length === 0) return {
		text: [
			formatCurrentModelLine(params.currentModel),
			"",
			`Unknown provider: ${provider}`
		].join("\n"),
		buttons: [[buildButton({
			action: "back",
			ownerUserId: params.ownerUserId,
			text: "Back to providers"
		})]]
	};
	const page = paginateItems(models, params.page);
	const rows = page.items.map((model) => {
		const isCurrent = current?.provider === provider && current.model === model;
		return [buildButton({
			action: "select",
			ownerUserId: params.ownerUserId,
			text: isCurrent ? `${model} [current]` : model,
			provider,
			model,
			page: page.page,
			style: isCurrent ? "primary" : "default"
		})];
	});
	const navRow = [];
	if (page.hasPrev) navRow.push(buildButton({
		action: "list",
		ownerUserId: params.ownerUserId,
		text: "Prev",
		provider,
		page: page.page - 1
	}));
	if (page.hasNext) navRow.push(buildButton({
		action: "list",
		ownerUserId: params.ownerUserId,
		text: "Next",
		provider,
		page: page.page + 1
	}));
	if (navRow.length > 0) rows.push(navRow);
	rows.push([buildButton({
		action: "back",
		ownerUserId: params.ownerUserId,
		text: "Back to providers"
	})]);
	return {
		text: [
			`Models (${provider}) - ${page.totalItems} available`,
			formatCurrentModelLine(params.currentModel),
			`Page ${page.page}/${page.totalPages}`,
			"Select a model to switch immediately."
		].join("\n"),
		buttons: rows
	};
}
//#endregion
//#region extensions/mattermost/src/mattermost/reply-delivery.ts
async function deliverMattermostReplyPayload(params) {
	if (isReasoningReplyPayload(params.payload)) return "reasoning_skipped";
	const reply = resolveSendableOutboundReplyParts(params.payload, { text: params.core.channel.text.convertMarkdownTables(params.payload.text ?? "", params.tableMode) });
	const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.agentId);
	const chunkMode = params.core.channel.text.resolveChunkMode(params.cfg, "mattermost", params.accountId);
	return await deliverTextOrMediaReply({
		payload: params.payload,
		text: reply.text,
		chunkText: (value) => params.core.channel.text.chunkMarkdownTextWithMode(value, params.textLimit, chunkMode),
		sendText: async (chunk) => {
			await params.sendMessage(params.to, chunk, {
				cfg: params.cfg,
				accountId: params.accountId,
				replyToId: params.replyToId
			});
		},
		sendMedia: async ({ mediaUrl, caption }) => {
			await params.sendMessage(params.to, caption ?? "", {
				cfg: params.cfg,
				accountId: params.accountId,
				mediaUrl,
				mediaLocalRoots,
				replyToId: params.replyToId
			});
		}
	});
}
//#endregion
//#region extensions/mattermost/src/mattermost/interactions.ts
const INTERACTION_MAX_BODY_BYTES = 64 * 1024;
const INTERACTION_BODY_TIMEOUT_MS = 1e4;
const SIGNED_CHANNEL_ID_CONTEXT_KEY = "__openclaw_channel_id";
const callbackUrls = /* @__PURE__ */ new Map();
function setInteractionCallbackUrl(accountId, url) {
	callbackUrls.set(accountId, url);
}
function resolveInteractionCallbackPath(accountId) {
	return `/mattermost/interactions/${accountId}`;
}
function isWildcardBindHost(rawHost) {
	const trimmed = rawHost.trim();
	if (!trimmed) return false;
	const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
	return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0" || host === "::0";
}
function normalizeCallbackBaseUrl(baseUrl) {
	return baseUrl.trim().replace(/\/+$/, "");
}
function headerValue(value) {
	if (Array.isArray(value)) return normalizeOptionalString(value[0]);
	return normalizeOptionalString(value);
}
function isAllowedInteractionSource(params) {
	const { allowedSourceIps } = params;
	if (!allowedSourceIps?.length) return true;
	return isTrustedProxyAddress(resolveClientIp({
		remoteAddr: params.req.socket?.remoteAddress,
		forwardedFor: headerValue(params.req.headers["x-forwarded-for"]),
		realIp: headerValue(params.req.headers["x-real-ip"]),
		trustedProxies: params.trustedProxies,
		allowRealIpFallback: params.allowRealIpFallback
	}), allowedSourceIps);
}
/**
* Resolve the interaction callback URL for an account.
* Falls back to computing it from interactions.callbackBaseUrl or gateway host config.
*/
function computeInteractionCallbackUrl(accountId, cfg) {
	const path = resolveInteractionCallbackPath(accountId);
	const callbackBaseUrl = normalizeOptionalString(cfg?.interactions?.callbackBaseUrl) ?? normalizeOptionalString(cfg?.channels?.mattermost?.interactions?.callbackBaseUrl);
	if (callbackBaseUrl) return `${normalizeCallbackBaseUrl(callbackBaseUrl)}${path}`;
	const port = typeof cfg?.gateway?.port === "number" ? cfg.gateway.port : 18789;
	let host = cfg?.gateway?.customBindHost && !isWildcardBindHost(cfg.gateway.customBindHost) ? cfg.gateway.customBindHost.trim() : "localhost";
	if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) host = `[${host}]`;
	return `http://${host}:${port}${path}`;
}
/**
* Resolve the interaction callback URL for an account.
* Prefers the in-memory registered URL (set by the gateway monitor) so callers outside the
* monitor lifecycle can reuse the runtime-validated callback destination.
*/
function resolveInteractionCallbackUrl(accountId, cfg) {
	const cached = callbackUrls.get(accountId);
	if (cached) return cached;
	return computeInteractionCallbackUrl(accountId, cfg);
}
const interactionSecrets = /* @__PURE__ */ new Map();
let defaultInteractionSecret;
function deriveInteractionSecret(botToken) {
	return createHmac("sha256", "openclaw-mattermost-interactions").update(botToken).digest("hex");
}
function setInteractionSecret(accountIdOrBotToken, botToken) {
	if (typeof botToken === "string") {
		interactionSecrets.set(accountIdOrBotToken, deriveInteractionSecret(botToken));
		return;
	}
	defaultInteractionSecret = deriveInteractionSecret(accountIdOrBotToken);
}
function getInteractionSecret(accountId) {
	const scoped = accountId ? interactionSecrets.get(accountId) : void 0;
	if (scoped) return scoped;
	if (defaultInteractionSecret) return defaultInteractionSecret;
	if (interactionSecrets.size === 1) {
		const first = interactionSecrets.values().next().value;
		if (typeof first === "string") return first;
	}
	throw new Error("Interaction secret not initialized — call setInteractionSecret(accountId, botToken) first");
}
function canonicalizeInteractionContext(value) {
	if (Array.isArray(value)) return value.map((item) => canonicalizeInteractionContext(item));
	if (value && typeof value === "object") {
		const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== void 0).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, entryValue]) => [key, canonicalizeInteractionContext(entryValue)]);
		return Object.fromEntries(entries);
	}
	return value;
}
function generateInteractionToken(context, accountId) {
	const secret = getInteractionSecret(accountId);
	const payload = JSON.stringify(canonicalizeInteractionContext(context));
	return createHmac("sha256", secret).update(payload).digest("hex");
}
function verifyInteractionToken(context, token, accountId) {
	return safeEqualSecret(generateInteractionToken(context, accountId), token);
}
/**
* Build Mattermost `props.attachments` with interactive buttons.
*
* Each button includes an HMAC token in its integration context so the
* callback handler can verify the request originated from a legitimate
* button click (Mattermost's recommended security pattern).
*/
/**
* Sanitize a button ID so Mattermost's action router can match it.
* Mattermost uses the action ID in the URL path `/api/v4/posts/{id}/actions/{actionId}`
* and IDs containing hyphens or underscores break the server-side routing.
* See: https://github.com/mattermost/mattermost/issues/25747
*/
function sanitizeActionId(id) {
	return id.replace(/[-_]/g, "");
}
function buildButtonAttachments(params) {
	const actions = params.buttons.map((btn) => {
		const safeId = sanitizeActionId(btn.id);
		const context = {
			action_id: safeId,
			...btn.context
		};
		const token = generateInteractionToken(context, params.accountId);
		return {
			id: safeId,
			type: "button",
			name: btn.name,
			style: btn.style,
			integration: {
				url: params.callbackUrl,
				context: {
					...context,
					_token: token
				}
			}
		};
	});
	return [{
		text: params.text ?? "",
		actions
	}];
}
function buildButtonProps(params) {
	const buttons = params.buttons.flatMap((item) => Array.isArray(item) ? item : [item]).map((btn) => ({
		id: normalizeStringifiedOptionalString(btn.id ?? btn.callback_data) ?? "",
		name: normalizeStringifiedOptionalString(btn.text ?? btn.name ?? btn.label) ?? "",
		style: btn.style ?? "default",
		context: typeof btn.context === "object" && btn.context !== null ? {
			...btn.context,
			[SIGNED_CHANNEL_ID_CONTEXT_KEY]: params.channelId
		} : { [SIGNED_CHANNEL_ID_CONTEXT_KEY]: params.channelId }
	})).filter((btn) => btn.id && btn.name);
	if (buttons.length === 0) return;
	return { attachments: buildButtonAttachments({
		callbackUrl: params.callbackUrl,
		accountId: params.accountId,
		buttons,
		text: params.text
	}) };
}
function readInteractionBody(req) {
	return readRequestBodyWithLimit(req, {
		maxBytes: INTERACTION_MAX_BODY_BYTES,
		timeoutMs: INTERACTION_BODY_TIMEOUT_MS
	});
}
function createMattermostInteractionHandler(params) {
	const { client, accountId, log } = params;
	const core = getMattermostRuntime();
	function parseInteractionPayload(raw) {
		try {
			return JSON.parse(raw);
		} catch {
			throw new Error("Mattermost interaction body was malformed JSON");
		}
	}
	return async (req, res) => {
		if (req.method !== "POST") {
			res.statusCode = 405;
			res.setHeader("Allow", "POST");
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Method Not Allowed" }));
			return;
		}
		if (!isAllowedInteractionSource({
			req,
			allowedSourceIps: params.allowedSourceIps,
			trustedProxies: params.trustedProxies,
			allowRealIpFallback: params.allowRealIpFallback
		})) {
			log?.(`mattermost interaction: rejected callback source remote=${req.socket?.remoteAddress ?? "?"}`);
			res.statusCode = 403;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Forbidden origin" }));
			return;
		}
		let payload;
		try {
			payload = parseInteractionPayload(await readInteractionBody(req));
		} catch (err) {
			log?.(`mattermost interaction: failed to parse body: ${String(err)}`);
			res.statusCode = 400;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Invalid request body" }));
			return;
		}
		const context = payload.context;
		if (!context) {
			res.statusCode = 400;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Missing context" }));
			return;
		}
		const token = context["_token"];
		if (typeof token !== "string") {
			log?.("mattermost interaction: missing _token in context");
			res.statusCode = 403;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Missing token" }));
			return;
		}
		const { _token, ...contextWithoutToken } = context;
		if (!verifyInteractionToken(contextWithoutToken, token, accountId)) {
			log?.("mattermost interaction: invalid _token");
			res.statusCode = 403;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Invalid token" }));
			return;
		}
		const actionId = context.action_id;
		if (typeof actionId !== "string") {
			res.statusCode = 400;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Missing action_id in context" }));
			return;
		}
		const signedChannelId = typeof contextWithoutToken[SIGNED_CHANNEL_ID_CONTEXT_KEY] === "string" ? contextWithoutToken[SIGNED_CHANNEL_ID_CONTEXT_KEY].trim() : "";
		if (signedChannelId && signedChannelId !== payload.channel_id) {
			log?.(`mattermost interaction: signed channel mismatch payload=${payload.channel_id} signed=${signedChannelId}`);
			res.statusCode = 403;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Channel mismatch" }));
			return;
		}
		const userName = payload.user_name ?? payload.user_id;
		let originalMessage = "";
		let originalPost = null;
		let clickedButtonName = null;
		try {
			originalPost = await client.request(`/posts/${payload.post_id}`);
			const postChannelId = originalPost.channel_id?.trim();
			if (!postChannelId || postChannelId !== payload.channel_id) {
				log?.(`mattermost interaction: post channel mismatch payload=${payload.channel_id} post=${postChannelId ?? "<missing>"}`);
				res.statusCode = 403;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "Post/channel mismatch" }));
				return;
			}
			originalMessage = originalPost.message ?? "";
			const postAttachments = Array.isArray(originalPost?.props?.attachments) ? originalPost.props.attachments : [];
			for (const att of postAttachments) {
				const match = att.actions?.find((a) => a.id === actionId);
				if (match?.name) {
					clickedButtonName = match.name;
					break;
				}
			}
			if (clickedButtonName === null) {
				log?.(`mattermost interaction: action ${actionId} not found in post ${payload.post_id}`);
				res.statusCode = 403;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "Unknown action" }));
				return;
			}
		} catch (err) {
			log?.(`mattermost interaction: failed to validate post ${payload.post_id}: ${String(err)}`);
			res.statusCode = 500;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Failed to validate interaction" }));
			return;
		}
		if (!originalPost) {
			log?.(`mattermost interaction: missing fetched post ${payload.post_id}`);
			res.statusCode = 500;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Failed to load interaction post" }));
			return;
		}
		log?.(`mattermost interaction: action=${actionId} user=${payload.user_name ?? payload.user_id} post=${payload.post_id} channel=${payload.channel_id}`);
		if (params.authorizeButtonClick) try {
			const authorization = await params.authorizeButtonClick({
				payload,
				post: originalPost
			});
			if (!authorization.ok) {
				res.statusCode = authorization.statusCode ?? 200;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify(authorization.response ?? { ephemeral_text: "You are not allowed to use this action here." }));
				return;
			}
		} catch (err) {
			log?.(`mattermost interaction: authorization failed: ${String(err)}`);
			res.statusCode = 500;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Interaction authorization failed" }));
			return;
		}
		if (params.handleInteraction) try {
			const response = await params.handleInteraction({
				payload,
				userName,
				actionId,
				actionName: clickedButtonName,
				originalMessage,
				context: contextWithoutToken,
				post: originalPost
			});
			if (response !== null) {
				res.statusCode = 200;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify(response));
				return;
			}
		} catch (err) {
			log?.(`mattermost interaction: custom handler failed: ${String(err)}`);
			res.statusCode = 500;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Interaction handler failed" }));
			return;
		}
		try {
			const eventLabel = `Mattermost button click: action="${actionId}" by ${payload.user_name ?? payload.user_id} in channel ${payload.channel_id}`;
			const sessionKey = params.resolveSessionKey ? await params.resolveSessionKey({
				channelId: payload.channel_id,
				userId: payload.user_id,
				post: originalPost
			}) : `agent:main:mattermost:${accountId}:${payload.channel_id}`;
			core.system.enqueueSystemEvent(eventLabel, {
				sessionKey,
				contextKey: `mattermost:interaction:${payload.post_id}:${actionId}`
			});
		} catch (err) {
			log?.(`mattermost interaction: system event dispatch failed: ${String(err)}`);
		}
		try {
			await updateMattermostPost(client, payload.post_id, {
				message: originalMessage,
				props: { attachments: [{ text: `✓ **${clickedButtonName}** selected by @${userName}` }] }
			});
		} catch (err) {
			log?.(`mattermost interaction: failed to update post ${payload.post_id}: ${String(err)}`);
		}
		res.statusCode = 200;
		res.setHeader("Content-Type", "application/json");
		res.end("{}");
		if (params.dispatchButtonClick) try {
			await params.dispatchButtonClick({
				channelId: payload.channel_id,
				userId: payload.user_id,
				userName,
				actionId,
				actionName: clickedButtonName,
				postId: payload.post_id,
				post: originalPost
			});
		} catch (err) {
			log?.(`mattermost interaction: dispatchButtonClick failed: ${String(err)}`);
		}
	};
}
//#endregion
//#region extensions/mattermost/src/mattermost/target-resolution.ts
const mattermostOpaqueTargetCache = /* @__PURE__ */ new Map();
function cacheKey$1(baseUrl, token, id) {
	return `${baseUrl}::${token}::${id}`;
}
/** Mattermost IDs are 26-character lowercase alphanumeric strings. */
function isMattermostId(value) {
	return /^[a-z0-9]{26}$/.test(value);
}
function isExplicitMattermostTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	return /^(channel|user|mattermost):/i.test(trimmed) || trimmed.startsWith("@") || trimmed.startsWith("#");
}
function parseMattermostApiStatus(err) {
	if (!err || typeof err !== "object") return;
	const msg = "message" in err && typeof err.message === "string" ? err.message : "";
	const match = /Mattermost API (\d{3})\b/.exec(msg);
	if (!match) return;
	const code = Number(match[1]);
	return Number.isFinite(code) ? code : void 0;
}
async function resolveMattermostOpaqueTarget(params) {
	const input = params.input.trim();
	if (!input || isExplicitMattermostTarget(input) || !isMattermostId(input)) return null;
	const account = params.cfg && (!params.token || !params.baseUrl) ? resolveMattermostAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}) : null;
	const token = normalizeOptionalString(params.token) ?? normalizeOptionalString(account?.botToken);
	const baseUrl = normalizeMattermostBaseUrl(params.baseUrl ?? account?.baseUrl);
	if (!token || !baseUrl) return null;
	const key = cacheKey$1(baseUrl, token, input);
	const cached = mattermostOpaqueTargetCache.get(key);
	if (cached === true) return {
		kind: "user",
		id: input,
		to: `user:${input}`
	};
	if (cached === false) return {
		kind: "channel",
		id: input,
		to: `channel:${input}`
	};
	const client = createMattermostClient({
		baseUrl,
		botToken: token,
		allowPrivateNetwork: isPrivateNetworkOptInEnabled(account?.config)
	});
	try {
		await fetchMattermostUser(client, input);
		mattermostOpaqueTargetCache.set(key, true);
		return {
			kind: "user",
			id: input,
			to: `user:${input}`
		};
	} catch (err) {
		if (parseMattermostApiStatus(err) === 404) mattermostOpaqueTargetCache.set(key, false);
		return {
			kind: "channel",
			id: input,
			to: `channel:${input}`
		};
	}
}
//#endregion
//#region extensions/mattermost/src/mattermost/send.ts
const botUserCache = /* @__PURE__ */ new Map();
const userByNameCache = /* @__PURE__ */ new Map();
const channelByNameCache = /* @__PURE__ */ new Map();
const dmChannelCache = /* @__PURE__ */ new Map();
const getCore = () => getMattermostRuntime();
function createMattermostSendReceipt(params) {
	const messageIds = params.messageId.trim() && params.messageId !== "unknown" ? [params.messageId] : [];
	return createMessageReceiptFromOutboundResults({
		kind: params.kind,
		...params.replyToId ? { replyToId: params.replyToId } : {},
		results: messageIds.map((messageId) => ({
			channel: "mattermost",
			messageId,
			channelId: params.channelId
		}))
	});
}
function resolveMattermostReceiptKind(params) {
	if (params.fileIds?.length) return "media";
	if (params.buttons?.length || params.props) return "card";
	return "text";
}
function recordMattermostOutboundActivity(accountId) {
	try {
		getCore().channel.activity.record({
			channel: "mattermost",
			accountId,
			direction: "outbound"
		});
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "Mattermost runtime not initialized") throw error;
	}
}
function cacheKey(baseUrl, token) {
	return `${baseUrl}::${token}`;
}
function normalizeMessage(text, mediaUrl) {
	return [normalizeOptionalString(text) ?? "", normalizeOptionalString(mediaUrl)].filter(Boolean).join("\n");
}
function isHttpUrl(value) {
	return /^https?:\/\//i.test(value);
}
function parseMattermostTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("Recipient is required for Mattermost sends");
	const lower = normalizeLowercaseStringOrEmpty(trimmed);
	if (lower.startsWith("channel:")) {
		const id = trimmed.slice(8).trim();
		if (!id) throw new Error("Channel id is required for Mattermost sends");
		if (id.startsWith("#")) {
			const name = id.slice(1).trim();
			if (!name) throw new Error("Channel name is required for Mattermost sends");
			return {
				kind: "channel-name",
				name
			};
		}
		if (!isMattermostId(id)) return {
			kind: "channel-name",
			name: id
		};
		return {
			kind: "channel",
			id
		};
	}
	if (lower.startsWith("user:")) {
		const id = trimmed.slice(5).trim();
		if (!id) throw new Error("User id is required for Mattermost sends");
		return {
			kind: "user",
			id
		};
	}
	if (lower.startsWith("mattermost:")) {
		const id = trimmed.slice(11).trim();
		if (!id) throw new Error("User id is required for Mattermost sends");
		return {
			kind: "user",
			id
		};
	}
	if (trimmed.startsWith("@")) {
		const username = trimmed.slice(1).trim();
		if (!username) throw new Error("Username is required for Mattermost sends");
		return {
			kind: "user",
			username
		};
	}
	if (trimmed.startsWith("#")) {
		const name = trimmed.slice(1).trim();
		if (!name) throw new Error("Channel name is required for Mattermost sends");
		return {
			kind: "channel-name",
			name
		};
	}
	if (!isMattermostId(trimmed)) return {
		kind: "channel-name",
		name: trimmed
	};
	return {
		kind: "channel",
		id: trimmed
	};
}
async function resolveBotUser(baseUrl, token, allowPrivateNetwork) {
	const key = cacheKey(baseUrl, token);
	const cached = botUserCache.get(key);
	if (cached) return cached;
	const user = await fetchMattermostMe(createMattermostClient({
		baseUrl,
		botToken: token,
		allowPrivateNetwork
	}));
	botUserCache.set(key, user);
	return user;
}
async function resolveUserIdByUsername(params) {
	const { baseUrl, token, username } = params;
	const key = `${cacheKey(baseUrl, token)}::${normalizeLowercaseStringOrEmpty(username)}`;
	const cached = userByNameCache.get(key);
	if (cached?.id) return cached.id;
	const user = await fetchMattermostUserByUsername(createMattermostClient({
		baseUrl,
		botToken: token,
		allowPrivateNetwork: params.allowPrivateNetwork
	}), username);
	userByNameCache.set(key, user);
	return user.id;
}
async function resolveChannelIdByName(params) {
	const { baseUrl, token, name } = params;
	const key = `${cacheKey(baseUrl, token)}::channel::${normalizeLowercaseStringOrEmpty(name)}`;
	const cached = channelByNameCache.get(key);
	if (cached) return cached;
	const client = createMattermostClient({
		baseUrl,
		botToken: token,
		allowPrivateNetwork: params.allowPrivateNetwork
	});
	const teams = await fetchMattermostUserTeams(client, (await fetchMattermostMe(client)).id);
	for (const team of teams) try {
		const channel = await fetchMattermostChannelByName(client, team.id, name);
		if (channel?.id) {
			channelByNameCache.set(key, channel.id);
			return channel.id;
		}
	} catch {}
	throw new Error(`Mattermost channel "#${name}" not found in any team the bot belongs to`);
}
function mergeDmRetryOptions(base, override) {
	const merged = {
		maxRetries: override?.maxRetries ?? base?.maxRetries,
		initialDelayMs: override?.initialDelayMs ?? base?.initialDelayMs,
		maxDelayMs: override?.maxDelayMs ?? base?.maxDelayMs,
		timeoutMs: override?.timeoutMs ?? base?.timeoutMs,
		onRetry: override?.onRetry
	};
	if (merged.maxRetries === void 0 && merged.initialDelayMs === void 0 && merged.maxDelayMs === void 0 && merged.timeoutMs === void 0 && merged.onRetry === void 0) return;
	return merged;
}
async function resolveTargetChannelId(params) {
	if (params.target.kind === "channel") return params.target.id;
	if (params.target.kind === "channel-name") return await resolveChannelIdByName({
		baseUrl: params.baseUrl,
		token: params.token,
		name: params.target.name,
		allowPrivateNetwork: params.allowPrivateNetwork
	});
	const userId = params.target.id ? params.target.id : await resolveUserIdByUsername({
		baseUrl: params.baseUrl,
		token: params.token,
		username: params.target.username ?? "",
		allowPrivateNetwork: params.allowPrivateNetwork
	});
	const dmKey = `${cacheKey(params.baseUrl, params.token)}::dm::${userId}`;
	const cachedDm = dmChannelCache.get(dmKey);
	if (cachedDm) return cachedDm;
	const botUser = await resolveBotUser(params.baseUrl, params.token, params.allowPrivateNetwork);
	const channel = await createMattermostDirectChannelWithRetry(createMattermostClient({
		baseUrl: params.baseUrl,
		botToken: params.token,
		allowPrivateNetwork: params.allowPrivateNetwork
	}), [botUser.id, userId], {
		...params.dmRetryOptions,
		onRetry: (attempt, delayMs, error) => {
			params.dmRetryOptions?.onRetry?.(attempt, delayMs, error);
			if (params.logger) params.logger.warn?.(`DM channel creation retry ${attempt} after ${delayMs}ms: ${error.message}`);
		}
	});
	dmChannelCache.set(dmKey, channel.id);
	return channel.id;
}
async function resolveMattermostSendContext(to, opts) {
	const core = getCore();
	const logger = core.logging.getChildLogger({ module: "mattermost" });
	if (!opts?.cfg) throw new Error("Mattermost send requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.");
	const cfg = requireRuntimeConfig(opts.cfg, "Mattermost send");
	const account = resolveMattermostAccount({
		cfg,
		accountId: opts.accountId
	});
	const token = normalizeOptionalString(opts.botToken) ?? normalizeOptionalString(account.botToken);
	if (!token) throw new Error(`Mattermost bot token missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.botToken or MATTERMOST_BOT_TOKEN for default).`);
	const baseUrl = normalizeMattermostBaseUrl(opts.baseUrl ?? account.baseUrl);
	if (!baseUrl) throw new Error(`Mattermost baseUrl missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.baseUrl or MATTERMOST_URL for default).`);
	const trimmedTo = normalizeOptionalString(to) ?? "";
	const opaqueTarget = await resolveMattermostOpaqueTarget({
		input: trimmedTo,
		token,
		baseUrl
	});
	const target = opaqueTarget?.kind === "user" ? {
		kind: "user",
		id: opaqueTarget.id
	} : opaqueTarget?.kind === "channel" ? {
		kind: "channel",
		id: opaqueTarget.id
	} : parseMattermostTarget(trimmedTo);
	const dmRetryOptions = mergeDmRetryOptions(account.config.dmChannelRetry ? {
		maxRetries: account.config.dmChannelRetry.maxRetries,
		initialDelayMs: account.config.dmChannelRetry.initialDelayMs,
		maxDelayMs: account.config.dmChannelRetry.maxDelayMs,
		timeoutMs: account.config.dmChannelRetry.timeoutMs
	} : void 0, opts.dmRetryOptions);
	const allowPrivateNetwork = isPrivateNetworkOptInEnabled(account.config);
	const channelId = await resolveTargetChannelId({
		target,
		baseUrl,
		token,
		allowPrivateNetwork,
		dmRetryOptions,
		logger: core.logging.shouldLogVerbose() ? logger : void 0
	});
	return {
		cfg,
		accountId: account.accountId,
		token,
		baseUrl,
		channelId,
		allowPrivateNetwork
	};
}
async function sendMessageMattermost(to, text, opts) {
	const core = getCore();
	const logger = core.logging.getChildLogger({ module: "mattermost" });
	const { cfg, accountId, token, baseUrl, channelId, allowPrivateNetwork } = await resolveMattermostSendContext(to, opts);
	const client = createMattermostClient({
		baseUrl,
		botToken: token,
		allowPrivateNetwork
	});
	let props = opts.props;
	if (!props && Array.isArray(opts.buttons) && opts.buttons.length > 0) {
		setInteractionSecret(accountId, token);
		props = buildButtonProps({
			callbackUrl: resolveInteractionCallbackUrl(accountId, {
				gateway: cfg.gateway,
				interactions: resolveMattermostAccount({
					cfg,
					accountId
				}).config?.interactions
			}),
			accountId,
			channelId,
			buttons: opts.buttons,
			text: opts.attachmentText
		});
	}
	let message = normalizeOptionalString(text) ?? "";
	let fileIds;
	let uploadError;
	const mediaUrl = opts.mediaUrl?.trim();
	if (mediaUrl) try {
		const media = await loadOutboundMediaFromUrl(mediaUrl, {
			mediaLocalRoots: opts.mediaLocalRoots,
			mediaReadFile: opts.mediaReadFile
		});
		fileIds = [(await uploadMattermostFile(client, {
			channelId,
			buffer: media.buffer,
			fileName: media.fileName ?? "upload",
			contentType: media.contentType ?? void 0
		})).id];
	} catch (err) {
		uploadError = err instanceof Error ? err : new Error(String(err));
		if (core.logging.shouldLogVerbose()) logger.debug?.(`mattermost send: media upload failed, falling back to URL text: ${String(err)}`);
		message = normalizeMessage(message, isHttpUrl(mediaUrl) ? mediaUrl : "");
	}
	if (message) {
		const tableMode = resolveMarkdownTableMode({
			cfg,
			channel: "mattermost",
			accountId
		});
		message = convertMarkdownTables(message, tableMode);
	}
	if (!message && (!fileIds || fileIds.length === 0)) {
		if (uploadError) throw new Error(`Mattermost media upload failed: ${uploadError.message}`);
		throw new Error("Mattermost message is empty");
	}
	const post = await createMattermostPost(client, {
		channelId,
		message,
		rootId: opts.replyToId,
		fileIds,
		props
	});
	recordMattermostOutboundActivity(accountId);
	const messageId = post.id ?? "unknown";
	return {
		messageId,
		channelId,
		receipt: createMattermostSendReceipt({
			messageId,
			channelId,
			kind: resolveMattermostReceiptKind({
				fileIds,
				buttons: opts.buttons,
				props
			}),
			replyToId: opts.replyToId
		})
	};
}
//#endregion
//#region extensions/mattermost/src/mattermost/slash-http.ts
const MAX_BODY_BYTES = 64 * 1024;
const BODY_READ_TIMEOUT_MS = 5e3;
const COMMAND_LOOKUP_TIMEOUT_MS = 1e3;
const COMMAND_VALIDATION_FAILURE_CACHE_MS = 5e3;
const COMMAND_VALIDATION_FAILURE_CACHE_MAX_KEYS = 2e3;
const COMMAND_VALIDATION_LOOKUP_BURST = 20;
const COMMAND_VALIDATION_LOOKUP_REFILL_MS = 500;
const COMMAND_VALIDATION_LOOKUP_LIMIT_LOG_MS = 5e3;
const COMMAND_VALIDATION_LOOKUP_RATE_LIMIT_MAX_KEYS = 2e3;
const commandLookupInflight = /* @__PURE__ */ new Map();
const commandValidationFailureCache = /* @__PURE__ */ new Map();
const commandValidationLookupRateLimit = /* @__PURE__ */ new Map();
const SECRET_LOG_KEYS = new Set([
	"access_token",
	"authorization",
	"bottoken",
	"client_secret",
	"refresh_token",
	"token"
]);
/**
* Read the full request body as a string.
*/
function readBody(req, maxBytes, timeoutMs = BODY_READ_TIMEOUT_MS) {
	return readRequestBodyWithLimit(req, {
		maxBytes,
		timeoutMs
	});
}
function sendJsonResponse(res, status, body) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}
function findRegisteredCommandForPayload(params) {
	const trigger = normalizeSlashCommandTrigger(params.payload.command);
	return params.registeredCommands.find((cmd) => cmd.teamId === params.payload.team_id && cmd.trigger === trigger);
}
function isDeletedMattermostCommand(command) {
	return typeof command.delete_at === "number" && command.delete_at > 0;
}
function sanitizeCommandLookupError(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]/gu, " ").replace(/https?:\/\/[^\s)\]}]+/giu, (urlText) => {
		try {
			const url = new URL(urlText);
			if (url.username || url.password) {
				url.username = "redacted";
				url.password = "redacted";
			}
			for (const key of url.searchParams.keys()) if (SECRET_LOG_KEYS.has(key.toLowerCase())) url.searchParams.set(key, "redacted");
			return url.toString();
		} catch {
			return urlText;
		}
	}).replace(/(^|[^\w-])(Bearer|Token)\s+[A-Za-z0-9._~+/=-]+/giu, "$1$2 [redacted]").replace(/\b(token|authorization|access_token|refresh_token|client_secret|botToken)\b(\s*["']?\s*(?:=|:)\s*["']?)[^"',\s;}]+/giu, "$1$2[redacted]").slice(0, 300);
}
function sanitizeMattermostLogValue(value) {
	return value.replace(/[\r\n\t]/gu, " ").slice(0, 200);
}
async function withCommandLookupTimeout(task) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), COMMAND_LOOKUP_TIMEOUT_MS);
	try {
		return await task(controller.signal);
	} finally {
		clearTimeout(timeout);
	}
}
function commandLookupKey(client, registered, accountId) {
	return `${client.apiBaseUrl}:${accountId}:${registered.teamId}:${registered.id}`;
}
function clearMattermostSlashCommandValidationCacheForAccount(accountId) {
	for (const [key, entry] of commandValidationFailureCache) if (entry.accountId === accountId) commandValidationFailureCache.delete(key);
	for (const [key, entry] of commandLookupInflight) if (entry.accountId === accountId) commandLookupInflight.delete(key);
	for (const [key, entry] of commandValidationLookupRateLimit) if (entry.accountId === accountId) commandValidationLookupRateLimit.delete(key);
}
function sweepCommandValidationFailureCache(now = Date.now()) {
	for (const [key, entry] of commandValidationFailureCache) if (entry.expiresAt <= now) commandValidationFailureCache.delete(key);
	while (commandValidationFailureCache.size > COMMAND_VALIDATION_FAILURE_CACHE_MAX_KEYS) {
		const oldestKey = commandValidationFailureCache.keys().next().value;
		if (!oldestKey) break;
		commandValidationFailureCache.delete(oldestKey);
	}
}
function hasCachedCommandValidationFailure(key, now = Date.now()) {
	sweepCommandValidationFailureCache(now);
	const cached = commandValidationFailureCache.get(key);
	if (!cached) return false;
	if (cached.expiresAt > now) return true;
	commandValidationFailureCache.delete(key);
	return false;
}
function cacheCommandValidationFailure(key, accountId) {
	sweepCommandValidationFailureCache();
	commandValidationFailureCache.set(key, {
		accountId,
		expiresAt: Date.now() + COMMAND_VALIDATION_FAILURE_CACHE_MS
	});
}
function sweepCommandValidationLookupRateLimit(now = Date.now()) {
	const staleAfterMs = COMMAND_VALIDATION_LOOKUP_REFILL_MS * COMMAND_VALIDATION_LOOKUP_BURST * 2;
	for (const [key, entry] of commandValidationLookupRateLimit) if (now - entry.updatedAt > staleAfterMs) commandValidationLookupRateLimit.delete(key);
	while (commandValidationLookupRateLimit.size > COMMAND_VALIDATION_LOOKUP_RATE_LIMIT_MAX_KEYS) {
		const oldestKey = commandValidationLookupRateLimit.keys().next().value;
		if (!oldestKey) break;
		commandValidationLookupRateLimit.delete(oldestKey);
	}
}
function reserveCommandValidationLookup(params) {
	const now = params.now ?? Date.now();
	sweepCommandValidationLookupRateLimit(now);
	const existing = commandValidationLookupRateLimit.get(params.key);
	if (!existing) {
		commandValidationLookupRateLimit.set(params.key, {
			accountId: params.accountId,
			tokens: COMMAND_VALIDATION_LOOKUP_BURST - 1,
			updatedAt: now,
			lastLimitedLogAt: 0
		});
		return { allowed: true };
	}
	const refill = Math.floor((now - existing.updatedAt) / COMMAND_VALIDATION_LOOKUP_REFILL_MS);
	if (refill > 0) {
		existing.tokens = Math.min(COMMAND_VALIDATION_LOOKUP_BURST, existing.tokens + refill);
		existing.updatedAt += refill * COMMAND_VALIDATION_LOOKUP_REFILL_MS;
	}
	if (existing.tokens <= 0) {
		const shouldLog = now - existing.lastLimitedLogAt >= COMMAND_VALIDATION_LOOKUP_LIMIT_LOG_MS;
		if (shouldLog) existing.lastLimitedLogAt = now;
		return {
			allowed: false,
			shouldLog
		};
	}
	existing.tokens -= 1;
	return { allowed: true };
}
async function fetchCurrentMattermostCommandUncached(params) {
	let commandLookupResult = null;
	let commandLookupError;
	let commandLookupFallbackDetail;
	try {
		commandLookupResult = await withCommandLookupTimeout((signal) => getMattermostCommand(params.client, params.registered.id, { signal }));
		if (!isDeletedMattermostCommand(commandLookupResult)) return commandLookupResult;
		commandLookupFallbackDetail = `command lookup by id returned deleted command ${sanitizeMattermostLogValue(commandLookupResult.id)}`;
	} catch (err) {
		commandLookupError = err;
	}
	try {
		const currentCommands = await withCommandLookupTimeout((signal) => listMattermostCommands(params.client, params.registered.teamId, { signal }));
		if (commandLookupError) params.log?.(`mattermost: slash command lookup by id failed for /${sanitizeMattermostLogValue(params.registered.trigger)}; using team list fallback: ${sanitizeCommandLookupError(commandLookupError)}`);
		else if (commandLookupFallbackDetail) params.log?.(`mattermost: slash ${commandLookupFallbackDetail} for /${sanitizeMattermostLogValue(params.registered.trigger)}; using team list fallback`);
		return currentCommands.find((cmd) => cmd.id === params.registered.id) ?? commandLookupResult;
	} catch (err) {
		const primaryDetail = commandLookupError ? `; command lookup: ${sanitizeCommandLookupError(commandLookupError)}` : commandLookupFallbackDetail ? `; command lookup: ${commandLookupFallbackDetail}` : "";
		params.log?.(`mattermost: slash command registration check failed for /${sanitizeMattermostLogValue(params.registered.trigger)}: ${sanitizeCommandLookupError(err)}${primaryDetail}`);
		return null;
	}
}
async function fetchCurrentMattermostCommand(params) {
	const key = commandLookupKey(params.client, params.registered, params.accountId);
	const existing = commandLookupInflight.get(key);
	if (existing) return await existing.promise;
	const lookup = fetchCurrentMattermostCommandUncached(params).finally(() => {
		commandLookupInflight.delete(key);
	});
	commandLookupInflight.set(key, {
		accountId: params.accountId,
		promise: lookup
	});
	return await lookup;
}
async function validateMattermostSlashCommandToken(params) {
	const lookupKey = commandLookupKey(params.client, params.registeredCommand, params.accountId);
	if (hasCachedCommandValidationFailure(lookupKey)) return false;
	if (!commandLookupInflight.has(lookupKey)) {
		const reservation = reserveCommandValidationLookup({
			key: lookupKey,
			accountId: params.accountId
		});
		if (!reservation.allowed) {
			if (reservation.shouldLog) params.log?.(`mattermost: slash command validation lookup rate-limited for /${sanitizeMattermostLogValue(params.registeredCommand.trigger)}`);
			return false;
		}
	}
	const current = await fetchCurrentMattermostCommand({
		accountId: params.accountId,
		client: params.client,
		registered: params.registeredCommand,
		log: params.log
	});
	if (!current || isDeletedMattermostCommand(current)) {
		cacheCommandValidationFailure(lookupKey, params.accountId);
		return false;
	}
	if (current.id !== params.registeredCommand.id || current.team_id !== params.registeredCommand.teamId || current.trigger !== params.registeredCommand.trigger || current.method !== "P" || current.url !== params.registeredCommand.url) {
		cacheCommandValidationFailure(lookupKey, params.accountId);
		return false;
	}
	if (!current.token || !safeEqualSecret(params.payload.token, current.token)) {
		cacheCommandValidationFailure(lookupKey, params.accountId);
		return false;
	}
	commandValidationFailureCache.delete(lookupKey);
	return true;
}
async function authorizeSlashInvocation(params) {
	const { account, cfg, client, commandText, channelId, senderId, senderName, log } = params;
	const core = getMattermostRuntime();
	let channelInfo = null;
	try {
		channelInfo = await fetchMattermostChannel(client, channelId);
	} catch (err) {
		log?.(`mattermost: slash channel lookup failed for ${sanitizeMattermostLogValue(channelId)}: ${sanitizeCommandLookupError(err)}`);
	}
	if (!channelInfo) return {
		ok: false,
		denyResponse: {
			response_type: "ephemeral",
			text: "Temporary error: unable to determine channel type. Please try again."
		},
		commandAuthorized: false,
		channelInfo: null,
		kind: "channel",
		chatType: "channel",
		channelName: "",
		channelDisplay: "",
		roomLabel: `#${channelId}`
	};
	const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
		cfg,
		surface: "mattermost"
	});
	const hasControlCommand = core.channel.text.hasControlCommand(commandText, cfg);
	const storeAllowFrom = normalizeMattermostAllowList(await core.channel.pairing.readAllowFromStore({
		channel: "mattermost",
		accountId: account.accountId
	}).catch(() => []));
	const decision = await authorizeMattermostCommandInvocation({
		account,
		cfg,
		senderId,
		senderName,
		channelId,
		channelInfo,
		storeAllowFrom,
		allowTextCommands,
		hasControlCommand
	});
	if (!decision.ok) {
		if (decision.denyReason === "dm-pairing") {
			const { code } = await core.channel.pairing.upsertPairingRequest({
				channel: "mattermost",
				accountId: account.accountId,
				id: senderId,
				meta: { name: senderName }
			});
			return {
				...decision,
				denyResponse: {
					response_type: "ephemeral",
					text: core.channel.pairing.buildPairingReply({
						channel: "mattermost",
						idLine: `Your Mattermost user id: ${senderId}`,
						code
					})
				}
			};
		}
		const denyText = decision.denyReason === "unknown-channel" ? "Temporary error: unable to determine channel type. Please try again." : decision.denyReason === "dm-disabled" ? "This bot is not accepting direct messages." : decision.denyReason === "channels-disabled" ? "Slash commands are disabled in channels." : decision.denyReason === "channel-no-allowlist" ? "Slash commands are not configured for this channel (no allowlist)." : "Unauthorized.";
		return {
			...decision,
			denyResponse: {
				response_type: "ephemeral",
				text: denyText
			}
		};
	}
	return {
		...decision,
		denyResponse: void 0
	};
}
/**
* Create the HTTP request handler for Mattermost slash command callbacks.
*
* This handler is registered as a plugin HTTP route and receives POSTs
* from the Mattermost server when a user invokes a registered slash command.
*/
function createSlashCommandHttpHandler(params) {
	const { account, cfg, runtime, registeredCommands, triggerMap, log, bodyTimeoutMs } = params;
	return async (req, res) => {
		if (req.method !== "POST") {
			res.statusCode = 405;
			res.setHeader("Allow", "POST");
			res.end("Method Not Allowed");
			return;
		}
		let body;
		try {
			body = await readBody(req, MAX_BODY_BYTES, bodyTimeoutMs);
		} catch (error) {
			if (isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT")) {
				res.statusCode = 408;
				res.end("Request body timeout");
				return;
			}
			res.statusCode = 413;
			res.end("Payload Too Large");
			return;
		}
		const contentType = req.headers["content-type"] ?? "";
		const payload = parseSlashCommandPayload(body, contentType);
		if (!payload) {
			sendJsonResponse(res, 400, {
				response_type: "ephemeral",
				text: "Invalid slash command payload."
			});
			return;
		}
		const registeredCommand = findRegisteredCommandForPayload({
			registeredCommands,
			payload
		});
		if (registeredCommands.length === 0 || !registeredCommand || !safeEqualSecret(payload.token, registeredCommand.token)) {
			sendJsonResponse(res, 401, {
				response_type: "ephemeral",
				text: "Unauthorized: invalid command token."
			});
			return;
		}
		const client = createMattermostClient({
			baseUrl: account.baseUrl ?? "",
			botToken: account.botToken ?? "",
			allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config)
		});
		if (!await validateMattermostSlashCommandToken({
			accountId: account.accountId,
			client,
			registeredCommand,
			payload,
			log
		})) {
			sendJsonResponse(res, 401, {
				response_type: "ephemeral",
				text: "Unauthorized: invalid command token."
			});
			return;
		}
		const trigger = normalizeSlashCommandTrigger(payload.command);
		const commandText = resolveCommandText(trigger, payload.text, triggerMap);
		const channelId = payload.channel_id;
		const senderId = payload.user_id;
		const senderName = payload.user_name ?? senderId;
		const auth = await authorizeSlashInvocation({
			account,
			cfg,
			client,
			commandText,
			channelId,
			senderId,
			senderName,
			log
		});
		if (!auth.ok) {
			sendJsonResponse(res, 200, auth.denyResponse ?? {
				response_type: "ephemeral",
				text: "Unauthorized."
			});
			return;
		}
		log?.(`mattermost: slash command /${sanitizeMattermostLogValue(trigger)} from ${sanitizeMattermostLogValue(senderName)} in ${sanitizeMattermostLogValue(channelId)}`);
		sendJsonResponse(res, 200, {
			response_type: "ephemeral",
			text: "Processing..."
		});
		try {
			await handleSlashCommandAsync({
				account,
				cfg,
				runtime,
				client,
				commandText,
				channelId,
				senderId,
				senderName,
				teamId: payload.team_id,
				triggerId: payload.trigger_id,
				kind: auth.kind,
				chatType: auth.chatType,
				channelName: auth.channelName,
				channelDisplay: auth.channelDisplay,
				roomLabel: auth.roomLabel,
				commandAuthorized: auth.commandAuthorized,
				log
			});
		} catch (err) {
			log?.(`mattermost: slash command handler error: ${sanitizeCommandLookupError(err)}`);
			try {
				await sendMessageMattermost(`channel:${channelId}`, "Sorry, something went wrong processing that command.", {
					cfg,
					accountId: account.accountId
				});
			} catch {}
		}
	};
}
async function handleSlashCommandAsync(params) {
	const { account, cfg, runtime, client, commandText, channelId, senderId, senderName, teamId, kind, chatType, channelName: _channelName, channelDisplay, roomLabel, commandAuthorized, triggerId, log } = params;
	const core = getMattermostRuntime();
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
	const fromLabel = kind === "direct" ? `Mattermost DM from ${senderName}` : `Mattermost message in ${roomLabel} from ${senderName}`;
	const to = kind === "direct" ? `user:${senderId}` : `channel:${channelId}`;
	const pickerEntry = resolveMattermostModelPickerEntry(commandText);
	if (pickerEntry) {
		const data = await buildModelsProviderData(cfg, route.agentId);
		if (data.providers.length === 0) {
			await sendMessageMattermost(to, "No models available.", {
				cfg,
				accountId: account.accountId
			});
			return;
		}
		const currentModel = resolveMattermostModelPickerCurrentModel({
			cfg,
			route,
			data
		});
		const view = pickerEntry.kind === "summary" ? renderMattermostModelSummaryView({
			ownerUserId: senderId,
			currentModel
		}) : pickerEntry.kind === "providers" ? renderMattermostProviderPickerView({
			ownerUserId: senderId,
			data,
			currentModel
		}) : renderMattermostModelsPickerView({
			ownerUserId: senderId,
			data,
			provider: pickerEntry.provider,
			page: 1,
			currentModel
		});
		await sendMessageMattermost(to, view.text, {
			cfg,
			accountId: account.accountId,
			buttons: view.buttons
		});
		runtime.log?.(`delivered model picker to ${to}`);
		return;
	}
	const ctxPayload = core.channel.reply.finalizeInboundContext({
		Body: commandText,
		BodyForAgent: commandText,
		RawBody: commandText,
		CommandBody: commandText,
		From: kind === "direct" ? `mattermost:${senderId}` : kind === "group" ? `mattermost:group:${channelId}` : `mattermost:channel:${channelId}`,
		To: to,
		SessionKey: route.sessionKey,
		AccountId: route.accountId,
		ChatType: chatType,
		ConversationLabel: fromLabel,
		GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : void 0,
		SenderName: senderName,
		SenderId: senderId,
		Provider: "mattermost",
		Surface: "mattermost",
		MessageSid: triggerId ?? `slash-${Date.now()}`,
		Timestamp: Date.now(),
		WasMentioned: true,
		CommandAuthorized: commandAuthorized,
		CommandSource: "native",
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
			start: () => sendMattermostTyping(client, { channelId }),
			onStartError: (err) => {
				logTypingFailure({
					log: (message) => log?.(message),
					channel: "mattermost",
					target: channelId,
					error: err
				});
			}
		}
	});
	const humanDelay = core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId);
	const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
		...replyPipeline,
		humanDelay,
		deliver: async (payload) => {
			await deliverMattermostReplyPayload({
				core,
				cfg,
				payload,
				to,
				accountId: account.accountId,
				agentId: route.agentId,
				textLimit,
				tableMode,
				sendMessage: sendMessageMattermost
			});
			runtime.log?.(`delivered slash reply to ${to}`);
		},
		onError: (err, info) => {
			runtime.error?.(`mattermost slash ${info.kind} reply failed: ${sanitizeCommandLookupError(err)}`);
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
}
//#endregion
//#region extensions/mattermost/src/mattermost/slash-state.ts
const MULTI_ACCOUNT_BODY_MAX_BYTES = 64 * 1024;
const MULTI_ACCOUNT_BODY_TIMEOUT_MS = 5e3;
/** Map from accountId → per-account slash command state. */
const accountStates = /* @__PURE__ */ new Map();
function resolveSlashHandlerForToken(token) {
	const matches = [];
	for (const [accountId, state] of accountStates) if (state.commandTokens.has(token) && state.handler) matches.push({
		accountId,
		handler: state.handler
	});
	if (matches.length === 0) return { kind: "none" };
	if (matches.length === 1) return {
		kind: "single",
		source: "token",
		handler: matches[0].handler,
		accountIds: [matches[0].accountId]
	};
	return {
		kind: "ambiguous",
		source: "token",
		accountIds: matches.map((entry) => entry.accountId)
	};
}
function resolveSlashHandlerForCommand(params) {
	const trigger = normalizeSlashCommandTrigger(params.command);
	if (!trigger) return { kind: "none" };
	const matches = [];
	for (const [accountId, state] of accountStates) if (state.handler && state.registeredCommands.some((cmd) => cmd.teamId === params.teamId && cmd.trigger === trigger)) matches.push({
		accountId,
		handler: state.handler
	});
	if (matches.length === 0) return { kind: "none" };
	if (matches.length === 1) return {
		kind: "single",
		source: "command",
		handler: matches[0].handler,
		accountIds: [matches[0].accountId]
	};
	return {
		kind: "ambiguous",
		source: "command",
		accountIds: matches.map((entry) => entry.accountId)
	};
}
/**
* Get the slash command state for a specific account, or null if not activated.
*/
function getSlashCommandState(accountId) {
	return accountStates.get(accountId) ?? null;
}
/**
* Activate slash commands for a specific account.
* Called from the monitor after bot connects.
*/
function activateSlashCommands(params) {
	const { account, commandTokens, registeredCommands, triggerMap, api, log } = params;
	const accountId = account.accountId;
	const tokenSet = new Set(commandTokens);
	const handler = createSlashCommandHttpHandler({
		account,
		cfg: api.cfg,
		runtime: api.runtime,
		registeredCommands,
		triggerMap,
		log
	});
	accountStates.set(accountId, {
		commandTokens: tokenSet,
		registeredCommands,
		handler,
		account,
		triggerMap: triggerMap ?? /* @__PURE__ */ new Map()
	});
	log?.(`mattermost: slash commands activated for account ${accountId} (${registeredCommands.length} commands)`);
}
/**
* Deactivate slash commands for a specific account (on shutdown/disconnect).
*/
function deactivateSlashCommands(accountId) {
	if (accountId) {
		const state = accountStates.get(accountId);
		if (state) {
			state.commandTokens.clear();
			state.registeredCommands = [];
			state.handler = null;
			clearMattermostSlashCommandValidationCacheForAccount(accountId);
			accountStates.delete(accountId);
		}
	} else {
		for (const [stateAccountId, state] of accountStates) {
			state.commandTokens.clear();
			state.registeredCommands = [];
			state.handler = null;
			clearMattermostSlashCommandValidationCacheForAccount(stateAccountId);
		}
		accountStates.clear();
	}
}
/**
* Register the HTTP route for slash command callbacks.
* Called during plugin registration.
*
* The single HTTP route dispatches to the correct per-account handler by
* matching the inbound token against each account's known tokens, falling back
* to registered team/trigger ownership so upstream validation can accept a
* rotated Mattermost token.
*/
function registerSlashCommandRoute(api) {
	const mmConfig = api.config.channels?.mattermost;
	const callbackPaths = /* @__PURE__ */ new Set();
	const addCallbackPaths = (raw) => {
		const resolved = resolveSlashCommandConfig(raw);
		callbackPaths.add(resolved.callbackPath);
		if (resolved.callbackUrl) try {
			const urlPath = new URL(resolved.callbackUrl).pathname;
			if (urlPath && urlPath !== resolved.callbackPath) callbackPaths.add(urlPath);
		} catch {}
	};
	const commandsRaw = mmConfig?.commands;
	addCallbackPaths(commandsRaw);
	const accountsRaw = mmConfig?.accounts ?? {};
	for (const accountId of Object.keys(accountsRaw)) {
		const accountCommandsRaw = accountsRaw[accountId]?.commands;
		addCallbackPaths(accountCommandsRaw);
	}
	const routeHandler = async (req, res) => {
		if (accountStates.size === 0) {
			res.statusCode = 503;
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.end(JSON.stringify({
				response_type: "ephemeral",
				text: "Slash commands are not yet initialized. Please try again in a moment."
			}));
			return;
		}
		if (accountStates.size === 1) {
			const [, state] = [...accountStates.entries()][0];
			if (!state.handler) {
				res.statusCode = 503;
				res.setHeader("Content-Type", "application/json; charset=utf-8");
				res.end(JSON.stringify({
					response_type: "ephemeral",
					text: "Slash commands are not yet initialized. Please try again in a moment."
				}));
				return;
			}
			await state.handler(req, res);
			return;
		}
		let bodyStr;
		try {
			bodyStr = await readRequestBodyWithLimit(req, {
				maxBytes: MULTI_ACCOUNT_BODY_MAX_BYTES,
				timeoutMs: MULTI_ACCOUNT_BODY_TIMEOUT_MS
			});
		} catch (error) {
			if (isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT")) {
				res.statusCode = 408;
				res.end("Request body timeout");
				return;
			}
			res.statusCode = 413;
			res.end("Payload Too Large");
			return;
		}
		let token = null;
		const ct = req.headers["content-type"] ?? "";
		try {
			if (ct.includes("application/json")) token = JSON.parse(bodyStr).token ?? null;
			else token = new URLSearchParams(bodyStr).get("token");
		} catch {}
		let match = token ? resolveSlashHandlerForToken(token) : { kind: "none" };
		if (match.kind === "none") {
			const payload = parseSlashCommandPayload(bodyStr, ct);
			if (payload) match = resolveSlashHandlerForCommand({
				teamId: payload.team_id,
				command: payload.command
			});
		}
		if (match.kind === "none") {
			res.statusCode = 401;
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.end(JSON.stringify({
				response_type: "ephemeral",
				text: "Unauthorized: invalid command token."
			}));
			return;
		}
		if (match.kind === "ambiguous") {
			api.logger.warn?.(`mattermost: slash callback matched multiple accounts via ${match.source} (${match.accountIds.join(", ")})`);
			const conflictText = match.source === "token" ? "Conflict: command token is not unique across accounts." : "Conflict: slash command is not unique across accounts.";
			res.statusCode = 409;
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.end(JSON.stringify({
				response_type: "ephemeral",
				text: conflictText
			}));
			return;
		}
		const matchedHandler = match.handler;
		const syntheticReq = new Readable({ read() {
			this.push(Buffer.from(bodyStr, "utf8"));
			this.push(null);
		} });
		syntheticReq.method = req.method;
		syntheticReq.url = req.url;
		syntheticReq.headers = req.headers;
		await matchedHandler(syntheticReq, res);
	};
	for (const callbackPath of callbackPaths) api.registerHttpRoute({
		path: callbackPath,
		auth: "plugin",
		handler: routeHandler
	});
}
//#endregion
export { resolveCallbackUrl as C, registerSlashCommands as S, renderMattermostProviderPickerView as _, sendMessageMattermost as a, cleanupSlashCommands as b, computeInteractionCallbackUrl as c, setInteractionCallbackUrl as d, setInteractionSecret as f, renderMattermostModelsPickerView as g, parseMattermostModelPickerContext as h, registerSlashCommandRoute as i, createMattermostInteractionHandler as l, buildMattermostAllowedModelRefs as m, deactivateSlashCommands as n, resolveMattermostOpaqueTarget as o, deliverMattermostReplyPayload as p, getSlashCommandState as r, buildButtonProps as s, activateSlashCommands as t, resolveInteractionCallbackPath as u, resolveMattermostModelPickerCurrentModel as v, resolveSlashCommandConfig as w, isSlashCommandsEnabled as x, DEFAULT_COMMAND_SPECS as y };
