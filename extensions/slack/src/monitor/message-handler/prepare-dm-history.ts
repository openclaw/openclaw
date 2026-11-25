import { formatInboundEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolvePromptHistoryLimit } from "openclaw/plugin-sdk/number-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";
import { resolveSlackTimestampMs } from "./timestamp.js";

type SlackDmHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
};

export function resolveSlackDmHistoryLimit(params: {
  account: ResolvedSlackAccount;
  userId?: string;
  defaultLimit: number;
}): number {
  const override = params.userId
    ? params.account.config.dms?.[params.userId]?.historyLimit
    : undefined;
  return resolvePromptHistoryLimit(override ?? params.defaultLimit, 0);
}

export async function resolveSlackDmHistoryContext(params: {
  ctx: SlackMonitorContext;
  channelId: string;
  currentMessageTs?: string;
  limit: number;
  eventScope?: SlackEventScope;
  envelopeOptions: ReturnType<
    typeof import("openclaw/plugin-sdk/channel-inbound").resolveEnvelopeFormatOptions
  >;
}): Promise<{ body: string | undefined; inboundHistory: SlackDmHistoryEntry[] | undefined }> {
  const maxMessages = params.limit;
  if (maxMessages <= 0) {
    return { body: undefined, inboundHistory: undefined };
  }

  try {
    const response = await (
      params.eventScope?.client ?? params.ctx.app.client
    ).conversations.history({
      token: params.ctx.botToken,
      channel: params.channelId,
      ...(params.currentMessageTs ? { latest: params.currentMessageTs, inclusive: true } : {}),
      limit: maxMessages + 1,
    });

    const messages = (response.messages ?? [])
      .flatMap((message) => {
        if (params.currentMessageTs && message.ts === params.currentMessageTs) {
          return [];
        }
        const body = normalizeOptionalString(message.text);
        return body ? [{ message, body }] : [];
      })
      .slice(0, maxMessages)
      // oxlint-disable-next-line unicorn/no-array-reverse -- slice creates a private array.
      .reverse();

    if (messages.length === 0) {
      return { body: undefined, inboundHistory: undefined };
    }

    const isCurrentBot = (message: (typeof messages)[number]["message"]) =>
      (params.ctx.botUserId && message.user === params.ctx.botUserId) ||
      (params.ctx.botId && message.bot_id === params.ctx.botId);
    const userIds = [
      ...new Set(
        messages.flatMap(({ message }) =>
          !isCurrentBot(message) && message.user ? [message.user] : [],
        ),
      ),
    ];
    // Match thread history's bounded lookups; repeated authors share one request.
    const users = await runTasksWithConcurrency({
      tasks: userIds.map((userId) => async () => {
        const user = await params.ctx.resolveUserName(userId, params.eventScope);
        return [userId, normalizeOptionalString(user.name) ?? userId] as const;
      }),
      limit: 4,
      errorMode: "stop",
    });
    if (users.hasError) {
      throw users.firstError;
    }
    const userNames = new Map(users.results);

    const entries: SlackDmHistoryEntry[] = [];
    const formatted: string[] = [];
    for (const { message, body } of messages) {
      const currentBot = isCurrentBot(message);
      const role = currentBot || message.bot_id ? "assistant" : "user";
      const senderBase = currentBot
        ? "Assistant"
        : message.user
          ? userNames.get(message.user)!
          : (normalizeOptionalString(message.username) ?? (message.bot_id ? "Bot" : "Unknown"));
      const sender = `${senderBase} (${role})`;
      const timestamp = resolveSlackTimestampMs(message.ts);
      entries.push({ sender, body, timestamp });
      formatted.push(
        formatInboundEnvelope({
          channel: "Slack",
          from: sender,
          timestamp,
          body: `${body}\n[slack message id: ${message.ts ?? "unknown"} channel: ${params.channelId}]`,
          chatType: "direct",
          envelope: params.envelopeOptions,
        }),
      );
    }

    return {
      body: formatted.join("\n\n"),
      inboundHistory: entries,
    };
  } catch (err) {
    logVerbose(
      `slack: failed to fetch DM history for channel ${params.channelId}: ${formatErrorMessage(err)}`,
    );
    return { body: undefined, inboundHistory: undefined };
  }
}
