import { formatInboundEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackConversationHistory, type SlackThreadMessage } from "../media.js";

const MAX_DIRECT_HISTORY_ENTRY_CHARS = 1_200;
const MAX_DIRECT_HISTORY_TOTAL_CHARS = 12_000;
const CONTEXTUAL_FOLLOW_UP_RE =
  /\b(again|continue|context|history|last thing|last task|pick (?:it|this) up|previous|resume|retry|same thing|what (?:are|were) we|what was the last)\b/i;

type SlackDirectContextData = {
  historyBody: string | undefined;
  label: string | undefined;
};

type AgentHubSlackHistoryMessage = {
  text?: string;
  ts?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  source?: string;
};

type AgentHubSlackHistoryPayload = {
  messages?: AgentHubSlackHistoryMessage[];
  dag_context?: {
    archive_context?: Array<Record<string, unknown>>;
    related_nodes?: Array<Record<string, unknown>>;
  } | null;
  warnings?: string[];
};

type AgentHubJsonRpcResponse = {
  result?: {
    content?: Array<{ text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: {
    code?: number;
    message?: string;
  };
};

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function truncateHistoryBody(body: string, maxChars: number): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function resolveMcpGatewayBaseUrl(): string {
  return (process.env.MCP_GATEWAY_BASE_URL ?? "http://127.0.0.1:9090/mcp").replace(/\/$/, "");
}

function parseMaybeJson<T>(value: unknown): T | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    return value as T;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function shouldHydrateSlackDirectHistory(params: {
  rawBody: string;
  previousTimestamp: number | undefined;
}): boolean {
  if (!trimOrUndefined(params.rawBody)) {
    return false;
  }
  if (!params.previousTimestamp) {
    return true;
  }
  const normalized = params.rawBody.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized || normalized.startsWith("/")) {
    return false;
  }
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 3) {
    return true;
  }
  return normalized.length <= 80 && CONTEXTUAL_FOLLOW_UP_RE.test(normalized);
}

function normalizeAgentHubMessages(messages: AgentHubSlackHistoryMessage[]): SlackThreadMessage[] {
  const normalized: SlackThreadMessage[] = [];
  for (const message of messages) {
    const body = trimOrUndefined(message.text);
    if (!body) continue;
    normalized.push({
      text: body,
      ts: trimOrUndefined(message.ts),
      userId: trimOrUndefined(message.user),
      botId: trimOrUndefined(message.bot_id),
    });
  }
  return normalized.sort((left, right) => Number(left.ts ?? 0) - Number(right.ts ?? 0));
}

async function resolveSlackDirectHistoryUserMap(params: {
  ctx: SlackMonitorContext;
  messages: SlackThreadMessage[];
}) {
  const userIds = [
    ...new Set(
      params.messages.map((entry) => entry.userId).filter((id): id is string => Boolean(id)),
    ),
  ];
  const userMap = new Map<string, { name?: string }>();
  await Promise.all(
    userIds.map(async (id) => {
      const user = await params.ctx.resolveUserName(id);
      if (user) {
        userMap.set(id, user);
      }
    }),
  );
  return userMap;
}

function selectRecentDirectTurns(params: {
  messages: SlackThreadMessage[];
  turnLimit: number;
}): SlackThreadMessage[] {
  if (params.turnLimit <= 0 || params.messages.length === 0) {
    return [];
  }
  const selected: SlackThreadMessage[] = [];
  let userTurns = 0;
  for (let index = params.messages.length - 1; index >= 0; index -= 1) {
    const message = params.messages[index];
    selected.push(message);
    if (!message.botId) {
      userTurns += 1;
      if (userTurns >= params.turnLimit) {
        break;
      }
    }
  }
  selected.reverse();
  return selected;
}

async function loadAgentHubDirectHistory(params: {
  channelId: string;
  currentMessageTs: string | undefined;
  historyLimit: number;
}): Promise<{
  messages: SlackThreadMessage[];
  dagArchiveCount: number;
  dagNodeCount: number;
} | null> {
  try {
    const response = await fetch(`${resolveMcpGatewayBaseUrl()}/agent-hub`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `slack-direct-context-${Date.now()}`,
        method: "tools/call",
        params: {
          name: "slack_messages_history",
          arguments: {
            channel: params.channelId,
            count: Math.max(params.historyLimit * 3, params.historyLimit),
            latest: params.currentMessageTs,
            inclusive: false,
            retrieval_level: "linked",
            source: "hybrid",
          },
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as AgentHubJsonRpcResponse;
    if (payload.error || payload.result?.isError) {
      return null;
    }

    const structured = payload.result?.structuredContent;
    const fallbackText = payload.result?.content
      ?.map((entry) => entry.text ?? "")
      .join("\n")
      .trim();
    const historyPayload =
      parseMaybeJson<AgentHubSlackHistoryPayload>(structured) ??
      parseMaybeJson<AgentHubSlackHistoryPayload>(fallbackText);
    if (!historyPayload) {
      return null;
    }

    return {
      messages: normalizeAgentHubMessages(historyPayload.messages ?? []),
      dagArchiveCount: historyPayload.dag_context?.archive_context?.length ?? 0,
      dagNodeCount: historyPayload.dag_context?.related_nodes?.length ?? 0,
    };
  } catch {
    return null;
  }
}

export async function resolveSlackDirectContextData(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  senderId: string;
  senderName: string;
  previousTimestamp: number | undefined;
  rawBody: string;
  envelopeOptions: ReturnType<
    typeof import("openclaw/plugin-sdk/channel-inbound").resolveEnvelopeFormatOptions
  >;
}): Promise<SlackDirectContextData> {
  const historyLimit =
    params.account.config?.dms?.[params.senderId]?.historyLimit ??
    params.account.config?.dmHistoryLimit ??
    0;

  if (
    historyLimit <= 0 ||
    !shouldHydrateSlackDirectHistory({
      rawBody: params.rawBody,
      previousTimestamp: params.previousTimestamp,
    })
  ) {
    return { historyBody: undefined, label: undefined };
  }

  const agentHubHistory = await loadAgentHubDirectHistory({
    channelId: params.message.channel,
    currentMessageTs: params.message.ts,
    historyLimit,
  });
  const recentHistory =
    agentHubHistory?.messages.length && agentHubHistory.messages.length > 0
      ? agentHubHistory.messages
      : await resolveSlackConversationHistory({
          channelId: params.message.channel,
          client: params.ctx.app.client,
          currentMessageTs: params.message.ts,
          limit: Math.max(historyLimit * 3, historyLimit),
        });
  if (recentHistory.length === 0) {
    return { historyBody: undefined, label: undefined };
  }

  const selectedHistory = selectRecentDirectTurns({
    messages: recentHistory,
    turnLimit: historyLimit,
  });
  if (selectedHistory.length === 0) {
    return { historyBody: undefined, label: undefined };
  }

  const userMap = await resolveSlackDirectHistoryUserMap({
    ctx: params.ctx,
    messages: selectedHistory,
  });

  const historyParts: string[] = [];
  let remainingChars = MAX_DIRECT_HISTORY_TOTAL_CHARS;

  for (const historyMsg of selectedHistory) {
    const body = truncateHistoryBody(historyMsg.text, MAX_DIRECT_HISTORY_ENTRY_CHARS);
    if (!body) {
      continue;
    }
    if (historyParts.length > 0 && body.length > remainingChars) {
      break;
    }
    const senderName =
      historyMsg.userId != null
        ? (trimOrUndefined(userMap.get(historyMsg.userId)?.name) ?? historyMsg.userId)
        : historyMsg.botId
          ? `Bot (${historyMsg.botId})`
          : "Unknown";
    const role = historyMsg.botId ? "assistant" : "user";
    historyParts.push(
      formatInboundEnvelope({
        channel: "Slack",
        from: `${senderName} (${role})`,
        timestamp: historyMsg.ts ? Math.round(Number(historyMsg.ts) * 1000) : undefined,
        body: `${body}\n[slack message id: ${historyMsg.ts ?? "unknown"} channel: ${params.message.channel}]`,
        chatType: "direct",
        envelope: params.envelopeOptions,
      }),
    );
    remainingChars -= body.length;
    if (remainingChars <= 0) {
      break;
    }
  }

  if (historyParts.length === 0) {
    return { historyBody: undefined, label: undefined };
  }

  if (agentHubHistory?.messages.length) {
    historyParts.unshift(
      `[Agent Hub linked context]\nrelated_nodes=${agentHubHistory.dagNodeCount} archive_snippets=${agentHubHistory.dagArchiveCount}`,
    );
    logVerbose(
      `slack: hydrated direct message history from agent-hub with ${historyParts.length - 1} entries`,
    );
  } else {
    logVerbose(`slack: hydrated direct message history with ${historyParts.length} entries`);
  }

  return {
    historyBody: historyParts.join("\n\n"),
    label: `Slack DM with ${params.senderName}`,
  };
}
