import { r as listDiscordAccountIds, s as resolveDiscordAccount } from "./accounts-CaHGiVB4.js";
import { c as createChannelNativeOriginTargetResolver, i as isDiscordExecApprovalClientEnabled, n as getDiscordExecApprovalApprovers, o as createApproverRestrictedNativeApprovalCapability, r as isDiscordExecApprovalApprover, s as createChannelApproverDmTargetResolver, t as shouldHandleDiscordApprovalRequest } from "./approval-shared-GfJeMdLu.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import { resolveApprovalRequestSessionConversation } from "openclaw/plugin-sdk/approval-native-runtime";
//#region extensions/discord/src/approval-native.ts
function extractDiscordSessionKind(sessionKey) {
	if (!sessionKey) return null;
	const match = sessionKey.match(/discord:(channel|group|dm):/);
	if (!match) return null;
	return match[1];
}
function normalizeDiscordOriginChannelId(value) {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const prefixed = trimmed.match(/^(?:channel|group):(\d+)$/i);
	if (prefixed) return prefixed[1];
	return /^\d+$/.test(trimmed) ? trimmed : null;
}
function normalizeDiscordThreadId(value) {
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : void 0;
	if (typeof value !== "string") return;
	const normalized = value.trim();
	return /^\d+$/.test(normalized) ? normalized : void 0;
}
function createDiscordOriginTargetResolver(configOverride) {
	return createChannelNativeOriginTargetResolver({
		channel: "discord",
		shouldHandleRequest: ({ cfg, accountId, request }) => shouldHandleDiscordApprovalRequest({
			cfg,
			accountId,
			request,
			configOverride
		}),
		resolveTurnSourceTarget: (request) => {
			const sessionConversation = resolveApprovalRequestSessionConversation({
				request,
				channel: "discord",
				bundledFallback: false
			});
			const sessionKind = extractDiscordSessionKind(normalizeOptionalString(request.request.sessionKey) ?? null);
			const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
			const rawTurnSourceTo = normalizeOptionalString(request.request.turnSourceTo) ?? "";
			const turnSourceTo = normalizeDiscordOriginChannelId(rawTurnSourceTo);
			const threadId = normalizeDiscordThreadId(request.request.turnSourceThreadId) ?? normalizeDiscordThreadId(sessionConversation?.threadId) ?? void 0;
			const hasExplicitOriginTarget = /^(?:channel|group):/i.test(rawTurnSourceTo);
			if (turnSourceChannel !== "discord" || !turnSourceTo || sessionKind === "dm") return null;
			return hasExplicitOriginTarget || sessionKind === "channel" || sessionKind === "group" ? {
				to: turnSourceTo,
				threadId
			} : null;
		},
		resolveSessionTarget: (sessionTarget, request) => {
			const sessionConversation = resolveApprovalRequestSessionConversation({
				request,
				channel: "discord",
				bundledFallback: false
			});
			if (extractDiscordSessionKind(request.request.sessionKey?.trim() || null) === "dm") return null;
			const targetTo = normalizeDiscordOriginChannelId(sessionTarget.to);
			return targetTo ? {
				to: targetTo,
				threadId: normalizeDiscordThreadId(sessionTarget.threadId) ?? normalizeDiscordThreadId(sessionConversation?.threadId) ?? void 0
			} : null;
		},
		resolveFallbackTarget: (request) => {
			const sessionConversation = resolveApprovalRequestSessionConversation({
				request,
				channel: "discord",
				bundledFallback: false
			});
			if (extractDiscordSessionKind(request.request.sessionKey?.trim() || null) === "dm") return null;
			const fallbackChannelId = normalizeDiscordOriginChannelId(sessionConversation?.id);
			return fallbackChannelId ? {
				to: fallbackChannelId,
				threadId: normalizeDiscordThreadId(sessionConversation?.threadId) ?? void 0
			} : null;
		}
	});
}
function createDiscordApproverDmTargetResolver(configOverride) {
	return createChannelApproverDmTargetResolver({
		shouldHandleRequest: ({ cfg, accountId, request }) => shouldHandleDiscordApprovalRequest({
			cfg,
			accountId,
			request,
			configOverride
		}),
		resolveApprovers: ({ cfg, accountId }) => getDiscordExecApprovalApprovers({
			cfg,
			accountId,
			configOverride
		}),
		mapApprover: (approver) => ({ to: approver })
	});
}
function createDiscordApprovalCapability(configOverride) {
	return createApproverRestrictedNativeApprovalCapability({
		channel: "discord",
		channelLabel: "Discord",
		describeExecApprovalSetup: ({ accountId }) => {
			const prefix = accountId && accountId !== "default" ? `channels.discord.accounts.${accountId}` : "channels.discord";
			return `Approve it from the Web UI or terminal UI for now. Discord supports native exec approvals for this account. Configure \`${prefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; set \`${prefix}.execApprovals.enabled\` to \`auto\` or \`true\`.`;
		},
		listAccountIds: listDiscordAccountIds,
		hasApprovers: ({ cfg, accountId }) => getDiscordExecApprovalApprovers({
			cfg,
			accountId,
			configOverride
		}).length > 0,
		isExecAuthorizedSender: ({ cfg, accountId, senderId }) => isDiscordExecApprovalApprover({
			cfg,
			accountId,
			senderId,
			configOverride
		}),
		isNativeDeliveryEnabled: ({ cfg, accountId }) => isDiscordExecApprovalClientEnabled({
			cfg,
			accountId,
			configOverride
		}),
		resolveNativeDeliveryMode: ({ cfg, accountId }) => configOverride?.target ?? resolveDiscordAccount({
			cfg,
			accountId
		}).config.execApprovals?.target ?? "dm",
		resolveOriginTarget: createDiscordOriginTargetResolver(configOverride),
		resolveApproverDmTargets: createDiscordApproverDmTargetResolver(configOverride),
		notifyOriginWhenDmOnly: true,
		nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
			eventKinds: ["exec", "plugin"],
			isConfigured: ({ cfg, accountId }) => isDiscordExecApprovalClientEnabled({
				cfg,
				accountId,
				configOverride
			}),
			shouldHandle: ({ cfg, accountId, request }) => shouldHandleDiscordApprovalRequest({
				cfg,
				accountId,
				request,
				configOverride
			}),
			load: async () => (await import("./approval-handler.runtime-AZort68o.js").then((n) => n.t)).discordApprovalNativeRuntime
		})
	});
}
let cachedDiscordApprovalCapability;
function getDiscordApprovalCapability() {
	cachedDiscordApprovalCapability ??= createDiscordApprovalCapability();
	return cachedDiscordApprovalCapability;
}
//#endregion
export { getDiscordApprovalCapability as t };
