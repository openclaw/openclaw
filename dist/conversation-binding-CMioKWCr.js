import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as expandHomePrefix } from "./home-dir-BOPFpGo8.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as resolveGlobalSingleton, t as resolveGlobalMap } from "./global-singleton-DE6St75u.js";
import { m as writeJson } from "./json-files-C2hqjU--.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { a as getActivePluginRegistry } from "./runtime-DHxRl5F1.js";
import { a as normalizeChannelId, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { n as getSessionBindingService } from "./session-binding-service-B19FMAqz.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
//#region src/bindings/records.ts
async function createConversationBindingRecord(input) {
	return await getSessionBindingService().bind(input);
}
function getConversationBindingCapabilities(params) {
	return getSessionBindingService().getCapabilities(params);
}
function listSessionBindingRecords(targetSessionKey) {
	return getSessionBindingService().listBySession(targetSessionKey);
}
function resolveConversationBindingRecord(conversation) {
	return getSessionBindingService().resolveByConversation(conversation);
}
function touchConversationBindingRecord(bindingId, at) {
	const service = getSessionBindingService();
	if (typeof at === "number") {
		service.touch(bindingId, at);
		return;
	}
	service.touch(bindingId);
}
async function unbindConversationBindingRecord(input) {
	return await getSessionBindingService().unbind(input);
}
//#endregion
//#region src/plugins/conversation-binding.ts
const log = createSubsystemLogger("plugins/binding");
const APPROVALS_PATH = "~/.openclaw/plugin-binding-approvals.json";
const PLUGIN_BINDING_CUSTOM_ID_PREFIX = "pluginbind";
const PLUGIN_BINDING_OWNER = "plugin";
const PLUGIN_BINDING_SESSION_PREFIX = "plugin-binding";
const LEGACY_CODEX_PLUGIN_SESSION_PREFIXES = ["openclaw-app-server:thread:", "openclaw-codex-app-server:thread:"];
const pendingRequests = resolveGlobalMap(Symbol.for("openclaw.pluginBindingPendingRequests"));
const pluginBindingGlobalState = resolveGlobalSingleton(Symbol.for("openclaw.plugins.binding.global-state"), () => ({
	fallbackNoticeBindingIds: /* @__PURE__ */ new Set(),
	approvalsCache: null,
	approvalsLoaded: false
}));
function getPluginBindingGlobalState() {
	return pluginBindingGlobalState;
}
function resolveApprovalsPath() {
	return expandHomePrefix(APPROVALS_PATH);
}
function normalizeChannel(value) {
	return normalizeOptionalLowercaseString(value) ?? "";
}
function normalizeConversation(params) {
	return {
		channel: normalizeChannel(params.channel),
		accountId: params.accountId.trim() || "default",
		conversationId: params.conversationId.trim(),
		parentConversationId: normalizeOptionalString(params.parentConversationId),
		threadId: typeof params.threadId === "number" ? Math.trunc(params.threadId) : normalizeOptionalString(params.threadId?.toString())
	};
}
function normalizeBindingData(data) {
	if (!data || typeof data !== "object" || Array.isArray(data)) return;
	return { ...data };
}
function toConversationRef(params) {
	const normalized = normalizeConversation(params);
	const channelId = normalizeChannelId(normalized.channel);
	const resolvedConversationRef = channelId ? getChannelPlugin(channelId)?.conversationBindings?.resolveConversationRef?.({
		accountId: normalized.accountId,
		conversationId: normalized.conversationId,
		parentConversationId: normalized.parentConversationId,
		threadId: normalized.threadId
	}) : null;
	if (resolvedConversationRef?.conversationId?.trim()) return {
		channel: normalized.channel,
		accountId: normalized.accountId,
		conversationId: resolvedConversationRef.conversationId.trim(),
		...resolvedConversationRef.parentConversationId?.trim() ? { parentConversationId: resolvedConversationRef.parentConversationId.trim() } : {}
	};
	return {
		channel: normalized.channel,
		accountId: normalized.accountId,
		conversationId: normalized.conversationId,
		...normalized.parentConversationId ? { parentConversationId: normalized.parentConversationId } : {}
	};
}
function buildApprovalScopeKey(params) {
	return [
		params.pluginRoot,
		normalizeChannel(params.channel),
		params.accountId.trim() || "default"
	].join("::");
}
function buildPluginBindingSessionKey(params) {
	const hash = crypto.createHash("sha256").update(JSON.stringify({
		pluginId: params.pluginId,
		channel: normalizeChannel(params.channel),
		accountId: params.accountId,
		conversationId: params.conversationId
	})).digest("hex").slice(0, 24);
	return `${PLUGIN_BINDING_SESSION_PREFIX}:${params.pluginId}:${hash}`;
}
function buildPluginBindingIdentity(params) {
	return {
		pluginId: params.pluginId,
		pluginName: params.pluginName,
		pluginRoot: params.pluginRoot
	};
}
function logPluginBindingLifecycleEvent(params) {
	const parts = [
		`plugin binding ${params.event}`,
		`plugin=${params.pluginId}`,
		`root=${params.pluginRoot}`,
		...params.decision ? [`decision=${params.decision}`] : [],
		`channel=${params.channel}`,
		`account=${params.accountId}`,
		`conversation=${params.conversationId}`
	];
	log.info(parts.join(" "));
}
function isLegacyPluginBindingRecord(params) {
	if (!params.record || isPluginOwnedBindingMetadata(params.record.metadata)) return false;
	const targetSessionKey = params.record.targetSessionKey.trim();
	return targetSessionKey.startsWith(`${PLUGIN_BINDING_SESSION_PREFIX}:`) || LEGACY_CODEX_PLUGIN_SESSION_PREFIXES.some((prefix) => targetSessionKey.startsWith(prefix));
}
function buildApprovalInteractiveReply(approvalId) {
	return { blocks: [{
		type: "buttons",
		buttons: [
			{
				label: "Allow once",
				value: buildPluginBindingApprovalCustomId(approvalId, "allow-once"),
				style: "success"
			},
			{
				label: "Always allow",
				value: buildPluginBindingApprovalCustomId(approvalId, "allow-always"),
				style: "primary"
			},
			{
				label: "Deny",
				value: buildPluginBindingApprovalCustomId(approvalId, "deny"),
				style: "danger"
			}
		]
	}] };
}
function createApprovalRequestId() {
	return crypto.randomBytes(9).toString("base64url");
}
function loadApprovalsFromDisk() {
	const filePath = resolveApprovalsPath();
	try {
		if (!fs.existsSync(filePath)) return {
			version: 1,
			approvals: []
		};
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed.approvals)) return {
			version: 1,
			approvals: []
		};
		return {
			version: 1,
			approvals: parsed.approvals.filter((entry) => entry !== null && typeof entry === "object").map((entry) => ({
				pluginRoot: typeof entry.pluginRoot === "string" ? entry.pluginRoot : "",
				pluginId: typeof entry.pluginId === "string" ? entry.pluginId : "",
				pluginName: typeof entry.pluginName === "string" ? entry.pluginName : void 0,
				channel: typeof entry.channel === "string" ? normalizeChannel(entry.channel) : "",
				accountId: normalizeOptionalString(entry.accountId) ?? "default",
				approvedAt: typeof entry.approvedAt === "number" && Number.isFinite(entry.approvedAt) ? Math.floor(entry.approvedAt) : Date.now()
			})).filter((entry) => entry.pluginRoot && entry.pluginId && entry.channel)
		};
	} catch (error) {
		log.warn(`plugin binding approvals load failed: ${String(error)}`);
		return {
			version: 1,
			approvals: []
		};
	}
}
async function saveApprovals(file) {
	const filePath = resolveApprovalsPath();
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const state = getPluginBindingGlobalState();
	state.approvalsCache = file;
	state.approvalsLoaded = true;
	await writeJson(filePath, file, {
		mode: 384,
		trailingNewline: true
	});
}
function getApprovals() {
	const state = getPluginBindingGlobalState();
	if (!state.approvalsLoaded || !state.approvalsCache) {
		state.approvalsCache = loadApprovalsFromDisk();
		state.approvalsLoaded = true;
	}
	return state.approvalsCache;
}
function hasPersistentApproval(params) {
	const key = buildApprovalScopeKey(params);
	return getApprovals().approvals.some((entry) => buildApprovalScopeKey({
		pluginRoot: entry.pluginRoot,
		channel: entry.channel,
		accountId: entry.accountId
	}) === key);
}
async function addPersistentApproval(entry) {
	const file = getApprovals();
	const key = buildApprovalScopeKey(entry);
	const approvals = file.approvals.filter((existing) => buildApprovalScopeKey({
		pluginRoot: existing.pluginRoot,
		channel: existing.channel,
		accountId: existing.accountId
	}) !== key);
	approvals.push(entry);
	await saveApprovals({
		version: 1,
		approvals
	});
}
function buildBindingMetadata(params) {
	return {
		pluginBindingOwner: PLUGIN_BINDING_OWNER,
		pluginId: params.pluginId,
		pluginName: params.pluginName,
		pluginRoot: params.pluginRoot,
		summary: normalizeOptionalString(params.summary),
		detachHint: normalizeOptionalString(params.detachHint),
		data: normalizeBindingData(params.data)
	};
}
function isPluginOwnedBindingMetadata(metadata) {
	if (!metadata || typeof metadata !== "object") return false;
	const record = metadata;
	return record.pluginBindingOwner === PLUGIN_BINDING_OWNER && typeof record.pluginId === "string" && typeof record.pluginRoot === "string";
}
function isPluginOwnedSessionBindingRecord(record) {
	return isPluginOwnedBindingMetadata(record?.metadata);
}
function toPluginConversationBinding(record) {
	if (!record || !isPluginOwnedBindingMetadata(record.metadata)) return null;
	const metadata = record.metadata;
	return {
		bindingId: record.bindingId,
		pluginId: metadata.pluginId,
		pluginName: metadata.pluginName,
		pluginRoot: metadata.pluginRoot,
		channel: record.conversation.channel,
		accountId: record.conversation.accountId,
		conversationId: record.conversation.conversationId,
		parentConversationId: record.conversation.parentConversationId,
		boundAt: record.boundAt,
		summary: metadata.summary,
		detachHint: metadata.detachHint,
		data: metadata.data
	};
}
function withConversationBindingContext(binding, conversation) {
	return {
		...binding,
		parentConversationId: conversation.parentConversationId,
		threadId: conversation.threadId
	};
}
function resolvePluginConversationBindingState(params) {
	const ref = toConversationRef(params.conversation);
	const record = resolveConversationBindingRecord(ref);
	return {
		ref,
		record,
		binding: toPluginConversationBinding(record),
		isLegacyForeignBinding: isLegacyPluginBindingRecord({ record })
	};
}
function resolveOwnedPluginConversationBinding(params) {
	const state = resolvePluginConversationBindingState({ conversation: params.conversation });
	if (!state.binding || state.binding.pluginRoot !== params.pluginRoot) return null;
	return withConversationBindingContext(state.binding, params.conversation);
}
function bindConversationFromIdentity(params) {
	return bindConversationNow({
		identity: buildPluginBindingIdentity(params.identity),
		conversation: params.conversation,
		summary: params.summary,
		detachHint: params.detachHint,
		data: params.data
	});
}
function bindConversationFromRequest(request) {
	return bindConversationFromIdentity({
		identity: buildPluginBindingIdentity(request),
		conversation: request.conversation,
		summary: request.summary,
		detachHint: request.detachHint,
		data: request.data
	});
}
function buildApprovalEntryFromRequest(request, approvedAt = Date.now()) {
	return {
		pluginRoot: request.pluginRoot,
		pluginId: request.pluginId,
		pluginName: request.pluginName,
		channel: request.conversation.channel,
		accountId: request.conversation.accountId,
		approvedAt
	};
}
async function bindConversationNow(params) {
	const ref = toConversationRef(params.conversation);
	const binding = toPluginConversationBinding(await createConversationBindingRecord({
		targetSessionKey: buildPluginBindingSessionKey({
			pluginId: params.identity.pluginId,
			channel: ref.channel,
			accountId: ref.accountId,
			conversationId: ref.conversationId
		}),
		targetKind: "session",
		conversation: ref,
		placement: "current",
		metadata: buildBindingMetadata({
			pluginId: params.identity.pluginId,
			pluginName: params.identity.pluginName,
			pluginRoot: params.identity.pluginRoot,
			summary: params.summary,
			detachHint: params.detachHint,
			data: params.data
		})
	}));
	if (!binding) throw new Error("plugin binding was created without plugin metadata");
	return withConversationBindingContext(binding, params.conversation);
}
function buildApprovalMessage(request) {
	const lines = [
		`Plugin bind approval required`,
		`Plugin: ${request.pluginName ?? request.pluginId}`,
		`Channel: ${request.conversation.channel}`,
		`Account: ${request.conversation.accountId}`
	];
	if (request.summary?.trim()) lines.push(`Request: ${request.summary.trim()}`);
	else lines.push("Request: Bind this conversation so future plain messages route to the plugin.");
	lines.push("Choose whether to allow this plugin to bind the current conversation.");
	return lines.join("\n");
}
function resolvePluginBindingDisplayName(binding) {
	return normalizeOptionalString(binding.pluginName) || binding.pluginId;
}
function buildDetachHintSuffix(detachHint) {
	const trimmed = detachHint?.trim();
	return trimmed ? ` To detach this conversation, use ${trimmed}.` : "";
}
function buildPluginBindingUnavailableText(binding) {
	return `The bound plugin ${resolvePluginBindingDisplayName(binding)} is not currently loaded. Routing this message to OpenClaw instead. If this started after an update, run "openclaw doctor --fix"; otherwise reinstall or enable the plugin.${buildDetachHintSuffix(binding.detachHint)}`;
}
function buildPluginBindingDeclinedText(binding) {
	return `The bound plugin ${resolvePluginBindingDisplayName(binding)} did not handle this message. This conversation is still bound to that plugin.${buildDetachHintSuffix(binding.detachHint)}`;
}
function buildPluginBindingErrorText(binding) {
	return `The bound plugin ${resolvePluginBindingDisplayName(binding)} hit an error handling this message. This conversation is still bound to that plugin.${buildDetachHintSuffix(binding.detachHint)}`;
}
function hasShownPluginBindingFallbackNotice(bindingId) {
	const normalized = bindingId.trim();
	if (!normalized) return false;
	return getPluginBindingGlobalState().fallbackNoticeBindingIds.has(normalized);
}
function markPluginBindingFallbackNoticeShown(bindingId) {
	const normalized = bindingId.trim();
	if (!normalized) return;
	getPluginBindingGlobalState().fallbackNoticeBindingIds.add(normalized);
}
function buildPendingReply(request) {
	return {
		text: buildApprovalMessage(request),
		interactive: buildApprovalInteractiveReply(request.id)
	};
}
function encodeCustomIdValue(value) {
	return encodeURIComponent(value);
}
function decodeCustomIdValue(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
function buildPluginBindingApprovalCustomId(approvalId, decision) {
	const decisionCode = decision === "allow-once" ? "o" : decision === "allow-always" ? "a" : "d";
	return `${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:${encodeCustomIdValue(approvalId)}:${decisionCode}`;
}
function parsePluginBindingApprovalCustomId(value) {
	const trimmed = value.trim();
	if (!trimmed.startsWith(`${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:`)) return null;
	const body = trimmed.slice(`${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:`.length);
	const separator = body.lastIndexOf(":");
	if (separator <= 0 || separator === body.length - 1) return null;
	const rawId = body.slice(0, separator).trim();
	const rawDecisionCode = body.slice(separator + 1).trim();
	if (!rawId) return null;
	const rawDecision = rawDecisionCode === "o" ? "allow-once" : rawDecisionCode === "a" ? "allow-always" : rawDecisionCode === "d" ? "deny" : null;
	if (!rawDecision) return null;
	return {
		approvalId: decodeCustomIdValue(rawId),
		decision: rawDecision
	};
}
async function requestPluginConversationBinding(params) {
	const conversation = normalizeConversation(params.conversation);
	const state = resolvePluginConversationBindingState({ conversation });
	if (state.record && !state.binding) if (state.isLegacyForeignBinding) logPluginBindingLifecycleEvent({
		event: "migrating legacy record",
		pluginId: params.pluginId,
		pluginRoot: params.pluginRoot,
		channel: state.ref.channel,
		accountId: state.ref.accountId,
		conversationId: state.ref.conversationId
	});
	else return {
		status: "error",
		message: "This conversation is already bound by core routing and cannot be claimed by a plugin."
	};
	if (state.binding && state.binding.pluginRoot !== params.pluginRoot) return {
		status: "error",
		message: `This conversation is already bound by plugin "${state.binding.pluginName ?? state.binding.pluginId}".`
	};
	if (state.binding && state.binding.pluginRoot === params.pluginRoot) {
		const rebound = await bindConversationFromIdentity({
			identity: buildPluginBindingIdentity(params),
			conversation,
			summary: params.binding?.summary,
			detachHint: params.binding?.detachHint,
			data: params.binding?.data
		});
		logPluginBindingLifecycleEvent({
			event: "auto-refresh",
			pluginId: params.pluginId,
			pluginRoot: params.pluginRoot,
			channel: state.ref.channel,
			accountId: state.ref.accountId,
			conversationId: state.ref.conversationId
		});
		return {
			status: "bound",
			binding: rebound
		};
	}
	if (hasPersistentApproval({
		pluginRoot: params.pluginRoot,
		channel: state.ref.channel,
		accountId: state.ref.accountId
	})) {
		const bound = await bindConversationFromIdentity({
			identity: buildPluginBindingIdentity(params),
			conversation,
			summary: params.binding?.summary,
			detachHint: params.binding?.detachHint,
			data: params.binding?.data
		});
		logPluginBindingLifecycleEvent({
			event: "auto-approved",
			pluginId: params.pluginId,
			pluginRoot: params.pluginRoot,
			channel: state.ref.channel,
			accountId: state.ref.accountId,
			conversationId: state.ref.conversationId
		});
		return {
			status: "bound",
			binding: bound
		};
	}
	const request = {
		id: createApprovalRequestId(),
		pluginId: params.pluginId,
		pluginName: params.pluginName,
		pluginRoot: params.pluginRoot,
		conversation,
		requestedAt: Date.now(),
		requestedBySenderId: normalizeOptionalString(params.requestedBySenderId),
		summary: normalizeOptionalString(params.binding?.summary),
		detachHint: normalizeOptionalString(params.binding?.detachHint),
		data: normalizeBindingData(params.binding?.data)
	};
	pendingRequests.set(request.id, request);
	logPluginBindingLifecycleEvent({
		event: "requested",
		pluginId: params.pluginId,
		pluginRoot: params.pluginRoot,
		channel: state.ref.channel,
		accountId: state.ref.accountId,
		conversationId: state.ref.conversationId
	});
	return {
		status: "pending",
		approvalId: request.id,
		reply: buildPendingReply(request)
	};
}
async function getCurrentPluginConversationBinding(params) {
	return resolveOwnedPluginConversationBinding(params);
}
async function detachPluginConversationBinding(params) {
	const binding = resolveOwnedPluginConversationBinding(params);
	if (!binding) return { removed: false };
	await unbindConversationBindingRecord({
		bindingId: binding.bindingId,
		reason: "plugin-detach"
	});
	logPluginBindingLifecycleEvent({
		event: "detached",
		pluginId: binding.pluginId,
		pluginRoot: binding.pluginRoot,
		channel: binding.channel,
		accountId: binding.accountId,
		conversationId: binding.conversationId
	});
	return { removed: true };
}
async function resolvePluginConversationBindingApproval(params) {
	const request = pendingRequests.get(params.approvalId);
	if (!request) return { status: "expired" };
	if (request.requestedBySenderId && params.senderId?.trim() && request.requestedBySenderId !== params.senderId.trim()) return { status: "expired" };
	pendingRequests.delete(params.approvalId);
	if (params.decision === "deny") {
		dispatchPluginConversationBindingResolved({
			status: "denied",
			decision: "deny",
			request
		});
		logPluginBindingLifecycleEvent({
			event: "denied",
			pluginId: request.pluginId,
			pluginRoot: request.pluginRoot,
			channel: request.conversation.channel,
			accountId: request.conversation.accountId,
			conversationId: request.conversation.conversationId
		});
		return {
			status: "denied",
			request
		};
	}
	if (params.decision === "allow-always") await addPersistentApproval(buildApprovalEntryFromRequest(request));
	const binding = await bindConversationFromRequest(request);
	logPluginBindingLifecycleEvent({
		event: "approved",
		pluginId: request.pluginId,
		pluginRoot: request.pluginRoot,
		decision: params.decision,
		channel: request.conversation.channel,
		accountId: request.conversation.accountId,
		conversationId: request.conversation.conversationId
	});
	dispatchPluginConversationBindingResolved({
		status: "approved",
		binding,
		decision: params.decision,
		request
	});
	return {
		status: "approved",
		binding,
		request,
		decision: params.decision
	};
}
function dispatchPluginConversationBindingResolved(params) {
	queueMicrotask(() => {
		notifyPluginConversationBindingResolved(params).catch((error) => {
			log.warn(`plugin binding resolved dispatch failed: ${String(error)}`);
		});
	});
}
async function notifyPluginConversationBindingResolved(params) {
	const registrations = getActivePluginRegistry()?.conversationBindingResolvedHandlers ?? [];
	for (const registration of registrations) {
		if (registration.pluginId !== params.request.pluginId) continue;
		const registeredRoot = registration.pluginRoot?.trim();
		if (registeredRoot && registeredRoot !== params.request.pluginRoot) continue;
		try {
			const event = {
				status: params.status,
				binding: params.binding,
				decision: params.decision,
				request: {
					summary: params.request.summary,
					detachHint: params.request.detachHint,
					data: params.request.data,
					requestedBySenderId: params.request.requestedBySenderId,
					conversation: params.request.conversation
				}
			};
			await registration.handler(event);
		} catch (error) {
			log.warn(`plugin binding resolved callback failed plugin=${registration.pluginId} root=${registration.pluginRoot ?? "<none>"}: ${formatErrorMessage(error)}`);
		}
	}
}
function buildPluginBindingResolvedText(params) {
	if (params.status === "expired") return "That plugin bind approval expired. Retry the bind command.";
	if (params.status === "denied") return `Denied plugin bind request for ${params.request.pluginName ?? params.request.pluginId}.`;
	const summarySuffix = params.request.summary?.trim() ? ` ${params.request.summary.trim()}` : "";
	if (params.decision === "allow-always") return `Allowed ${params.request.pluginName ?? params.request.pluginId} to bind this conversation.${summarySuffix}`;
	return `Allowed ${params.request.pluginName ?? params.request.pluginId} to bind this conversation once.${summarySuffix}`;
}
//#endregion
export { getConversationBindingCapabilities as _, buildPluginBindingUnavailableText as a, touchConversationBindingRecord as b, hasShownPluginBindingFallbackNotice as c, markPluginBindingFallbackNoticeShown as d, parsePluginBindingApprovalCustomId as f, createConversationBindingRecord as g, toPluginConversationBinding as h, buildPluginBindingResolvedText as i, isPluginOwnedBindingMetadata as l, resolvePluginConversationBindingApproval as m, buildPluginBindingDeclinedText as n, detachPluginConversationBinding as o, requestPluginConversationBinding as p, buildPluginBindingErrorText as r, getCurrentPluginConversationBinding as s, buildPluginBindingApprovalCustomId as t, isPluginOwnedSessionBindingRecord as u, listSessionBindingRecords as v, unbindConversationBindingRecord as x, resolveConversationBindingRecord as y };
