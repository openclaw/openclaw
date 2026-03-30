import { formatInboundEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import { readSessionUpdatedAt } from "openclaw/plugin-sdk/config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import {
	resolveSlackMedia,
	resolveSlackThreadHistory,
	type SlackMediaResult,
	type SlackThreadStarter,
} from "../media.js";

export type SlackThreadContextData = {
	threadStarterBody: string | undefined;
	threadHistoryBody: string | undefined;
	threadSessionPreviousTimestamp: number | undefined;
	threadLabel: string | undefined;
	threadStarterMedia: SlackMediaResult[] | null;
};

export async function resolveSlackThreadContextData(params: {
	ctx: SlackMonitorContext;
	account: ResolvedSlackAccount;
	message: SlackMessageEvent;
	isThreadReply: boolean;
	threadTs: string | undefined;
	threadStarter: SlackThreadStarter | null;
	roomLabel: string;
	storePath: string;
	sessionKey: string;
	envelopeOptions: ReturnType<
		typeof import("openclaw/plugin-sdk/channel-inbound").resolveEnvelopeFormatOptions
	>;
	effectiveDirectMedia: SlackMediaResult[] | null;
}): Promise<SlackThreadContextData> {
	let threadStarterBody: string | undefined;
	let threadHistoryBody: string | undefined;
	let threadSessionPreviousTimestamp: number | undefined;
	let threadLabel: string | undefined;
	let threadStarterMedia: SlackMediaResult[] | null = null;

	if (!params.isThreadReply || !params.threadTs) {
		return {
			threadStarterBody,
			threadHistoryBody,
			threadSessionPreviousTimestamp,
			threadLabel,
			threadStarterMedia,
		};
	}

	const starter = params.threadStarter;
	if (starter?.text) {
		threadStarterBody = starter.text;
		const snippet = starter.text.replace(/\s+/g, " ").slice(0, 80);
		threadLabel = `Slack thread ${params.roomLabel}${snippet ? `: ${snippet}` : ""}`;
		if (
			!params.effectiveDirectMedia &&
			starter.files &&
			starter.files.length > 0
		) {
			threadStarterMedia = await resolveSlackMedia({
				files: starter.files,
				token: params.ctx.botToken,
				maxBytes: params.ctx.mediaMaxBytes,
			});
			if (threadStarterMedia) {
				const starterPlaceholders = threadStarterMedia
					.map((item) => item.placeholder)
					.join(", ");
				logVerbose(
					`slack: hydrated thread starter file ${starterPlaceholders} from root message`,
				);
			}
		}
	} else {
		threadLabel = `Slack thread ${params.roomLabel}`;
	}

	const threadInitialHistoryLimit =
		params.account.config?.thread?.initialHistoryLimit ?? 20;
	threadSessionPreviousTimestamp = readSessionUpdatedAt({
		storePath: params.storePath,
		sessionKey: params.sessionKey,
	});

	if (threadInitialHistoryLimit > 0 && !threadSessionPreviousTimestamp) {
		const threadHistory = await resolveSlackThreadHistory({
			channelId: params.message.channel,
			threadTs: params.threadTs,
			client: params.ctx.app.client,
			currentMessageTs: params.message.ts,
			limit: threadInitialHistoryLimit,
		});

		if (threadHistory.length > 0) {
			const uniqueUserIds = [
				...new Set(
					threadHistory
						.map((item) => item.userId)
						.filter((id): id is string => Boolean(id)),
				),
			];
			const userMap = new Map<string, { name?: string }>();
			await Promise.all(
				uniqueUserIds.map(async (id) => {
					const user = await params.ctx.resolveUserName(id);
					if (user) {
						userMap.set(id, user);
					}
				}),
			);

			const historyParts: string[] = [];
			for (const historyMsg of threadHistory) {
				const msgUser = historyMsg.userId
					? userMap.get(historyMsg.userId)
					: null;
				const msgSenderName =
					msgUser?.name ??
					(historyMsg.botId ? `Bot (${historyMsg.botId})` : "Unknown");
				const isBot = Boolean(historyMsg.botId);
				const role = isBot ? "assistant" : "user";
				const msgWithId = `${historyMsg.text}\n[slack message id: ${historyMsg.ts ?? "unknown"} channel: ${params.message.channel}]`;
				historyParts.push(
					formatInboundEnvelope({
						channel: "Slack",
						from: `${msgSenderName} (${role})`,
						timestamp: historyMsg.ts
							? Math.round(Number(historyMsg.ts) * 1000)
							: undefined,
						body: msgWithId,
						chatType: "channel",
						envelope: params.envelopeOptions,
					}),
				);
			}
			threadHistoryBody = historyParts.join("\n\n");
			logVerbose(
				`slack: populated thread history with ${threadHistory.length} messages for new session`,
			);
		}
	}

	return {
		threadStarterBody,
		threadHistoryBody,
		threadSessionPreviousTimestamp,
		threadLabel,
		threadStarterMedia,
	};
}
