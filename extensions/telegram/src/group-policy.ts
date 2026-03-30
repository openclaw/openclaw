import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import {
	type GroupToolPolicyConfig,
	resolveChannelGroupRequireMention,
	resolveChannelGroupToolsPolicy,
} from "openclaw/plugin-sdk/channel-policy";

function parseTelegramGroupId(value?: string | null) {
	const raw = value?.trim() ?? "";
	if (!raw) {
		return { chatId: undefined, topicId: undefined };
	}
	const parts = raw.split(":").filter(Boolean);
	if (
		parts.length >= 3 &&
		parts[1] === "topic" &&
		/^-?\d+$/.test(parts[0]) &&
		/^\d+$/.test(parts[2])
	) {
		return { chatId: parts[0], topicId: parts[2] };
	}
	if (parts.length >= 2 && /^-?\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
		return { chatId: parts[0], topicId: parts[1] };
	}
	return { chatId: raw, topicId: undefined };
}

function resolveTelegramRequireMention(params: {
	cfg: ChannelGroupContext["cfg"];
	chatId?: string;
	topicId?: string;
}): boolean | undefined {
	const { cfg, chatId, topicId } = params;
	if (!chatId) {
		return undefined;
	}
	const groupConfig = cfg.channels?.telegram?.groups?.[chatId];
	const groupDefault = cfg.channels?.telegram?.groups?.["*"];
	const topicConfig =
		topicId && groupConfig?.topics ? groupConfig.topics[topicId] : undefined;
	const defaultTopicConfig =
		topicId && groupDefault?.topics ? groupDefault.topics[topicId] : undefined;
	if (typeof topicConfig?.requireMention === "boolean") {
		return topicConfig.requireMention;
	}
	if (typeof defaultTopicConfig?.requireMention === "boolean") {
		return defaultTopicConfig.requireMention;
	}
	if (typeof groupConfig?.requireMention === "boolean") {
		return groupConfig.requireMention;
	}
	if (typeof groupDefault?.requireMention === "boolean") {
		return groupDefault.requireMention;
	}
	return undefined;
}

export function resolveTelegramGroupRequireMention(
	params: ChannelGroupContext,
): boolean | undefined {
	const { chatId, topicId } = parseTelegramGroupId(params.groupId);
	const requireMention = resolveTelegramRequireMention({
		cfg: params.cfg,
		chatId,
		topicId,
	});
	if (typeof requireMention === "boolean") {
		return requireMention;
	}
	return resolveChannelGroupRequireMention({
		cfg: params.cfg,
		channel: "telegram",
		groupId: chatId ?? params.groupId,
		accountId: params.accountId,
	});
}

export function resolveTelegramGroupToolPolicy(
	params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
	const { chatId } = parseTelegramGroupId(params.groupId);
	return resolveChannelGroupToolsPolicy({
		cfg: params.cfg,
		channel: "telegram",
		groupId: chatId ?? params.groupId,
		accountId: params.accountId,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164,
	});
}
