import {
  createMessageReceiptFromOutboundResults,
  type ChannelMessageUnknownSendContext,
  type ChannelMessageUnknownSendReconciliationResult,
} from "openclaw/plugin-sdk/channel-outbound";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveIMessageAccount } from "./accounts.js";
import { createIMessageRpcClient, type IMessageRpcClient } from "./client.js";
import {
  DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS,
  DEFAULT_IMESSAGE_SEND_TIMEOUT_MS,
  DEFAULT_IMESSAGE_TEXT_CHUNK_LIMIT,
} from "./constants.js";
import { parseIMessageNotification } from "./monitor/parse-notification.js";
import { prepareIMessageOutboundText, sanitizeIMessageOutboundText } from "./outbound-text.js";
import { type IMessageService, normalizeIMessageHandle, parseIMessageTarget } from "./targets.js";

const RECONCILE_HISTORY_LIMIT = 100;
const RECONCILE_CHAT_LIMIT = 100;
const RECONCILE_MAX_CANDIDATE_CHATS = 20;

type ReconciliationClient = Pick<IMessageRpcClient, "request" | "stop">;

type ChatListEntry = {
  id?: number | null;
  identifier?: string | null;
  guid?: string | null;
  service?: string | null;
  participants?: string[] | null;
  is_group?: boolean | null;
};

type HistoryMatch = {
  guid: string;
  timestamp: number;
};

type MessageSendStatusResult = {
  ok?: boolean;
  guid?: string | null;
  send_state?: string | null;
};

function unresolved(params: {
  ctx: ChannelMessageUnknownSendContext;
  error: string;
  retryable?: boolean;
}): ChannelMessageUnknownSendReconciliationResult {
  return {
    status: "unresolved",
    error: params.error,
    retryable: params.retryable ?? params.ctx.retryCount < 2,
  };
}

function normalizeService(value: unknown): Exclude<IMessageService, "auto"> | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "imessage" || normalized === "sms" ? normalized : undefined;
}

function resolveExpectedService(params: {
  target: ReturnType<typeof parseIMessageTarget>;
  accountService?: string;
}): Exclude<IMessageService, "auto"> | undefined {
  if (
    params.target.kind === "handle" &&
    params.target.serviceExplicit &&
    params.target.service !== "auto"
  ) {
    return params.target.service;
  }
  return normalizeService(params.accountService);
}

function normalizeTargetValue(value: string | null | undefined): string {
  return value?.trim() ? normalizeIMessageHandle(value) : "";
}

function chatMatchesTarget(params: {
  chat: ChatListEntry;
  target: ReturnType<typeof parseIMessageTarget>;
  expectedService?: Exclude<IMessageService, "auto">;
}): boolean {
  const chatId =
    typeof params.chat.id === "number" && Number.isFinite(params.chat.id) && params.chat.id > 0
      ? params.chat.id
      : undefined;
  if (!chatId) {
    return false;
  }
  if (params.expectedService && normalizeService(params.chat.service) !== params.expectedService) {
    return false;
  }
  if (params.target.kind === "chat_id") {
    return chatId === params.target.chatId;
  }
  if (params.target.kind === "chat_guid") {
    return params.chat.guid?.trim() === params.target.chatGuid.trim();
  }
  if (params.target.kind === "chat_identifier") {
    return params.chat.identifier?.trim() === params.target.chatIdentifier.trim();
  }

  const handle = normalizeIMessageHandle(params.target.to);
  const participants = params.chat.participants ?? [];
  // A handle target is a direct conversation. Matching only on participant
  // membership would let a group containing that person prove a DM send.
  if (params.chat.is_group !== false || participants.length > 1) {
    return false;
  }
  return (
    normalizeTargetValue(params.chat.identifier) === handle ||
    participants.some((participant) => normalizeTargetValue(participant) === handle)
  );
}

type TargetChatResolution =
  | { chatIds: number[] }
  | {
      error: string;
      retryable: boolean;
    };

async function resolveTargetChatIds(params: {
  client: ReconciliationClient;
  target: ReturnType<typeof parseIMessageTarget>;
  expectedService?: Exclude<IMessageService, "auto">;
}): Promise<TargetChatResolution> {
  if (params.target.kind === "chat_id") {
    return { chatIds: [params.target.chatId] };
  }
  const result = await params.client.request<{ chats?: ChatListEntry[] }>(
    "chats.list",
    { limit: RECONCILE_CHAT_LIMIT },
    { timeoutMs: DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS },
  );
  const matches = (Array.isArray(result?.chats) ? result.chats : []).filter((chat) =>
    chatMatchesTarget({
      chat,
      target: params.target,
      expectedService: params.expectedService,
    }),
  );
  const chatIds = [
    ...new Set(
      matches
        .map((chat) => chat.id)
        .filter((id): id is number => typeof id === "number" && Number.isFinite(id) && id > 0),
    ),
  ];
  if (chatIds.length === 0) {
    return {
      error: "iMessage reconciliation found no exact target chat",
      retryable: true,
    };
  }
  if (chatIds.length > RECONCILE_MAX_CANDIDATE_CHATS) {
    return {
      error: `iMessage reconciliation found more than ${RECONCILE_MAX_CANDIDATE_CHATS} exact target chats`,
      retryable: false,
    };
  }
  return { chatIds };
}

function resolveExpectedText(params: {
  ctx: ChannelMessageUnknownSendContext;
  accountId: string;
}): string | undefined {
  const plan = params.ctx.renderedBatchPlan;
  if (plan) {
    const item = plan.items[0];
    if (
      plan.payloadCount !== 1 ||
      plan.textCount !== 1 ||
      plan.mediaCount !== 0 ||
      plan.items.length !== 1 ||
      !item ||
      item.kinds.length !== 1 ||
      item.kinds[0] !== "text"
    ) {
      return undefined;
    }
  } else {
    const payload = params.ctx.payloads[0];
    if (
      params.ctx.payloads.length !== 1 ||
      !payload ||
      payload.mediaUrl ||
      payload.mediaUrls?.length ||
      payload.presentation ||
      payload.interactive ||
      payload.location ||
      payload.channelData
    ) {
      return undefined;
    }
  }
  // The rendered batch plan is captured before channel delivery normalization,
  // including sanitizeText (see createRenderedMessageBatch), so apply the same
  // sanitizer the live iMessage outbound adapter applies exactly once here.
  const source = plan?.items[0]?.text ?? params.ctx.payloads[0]?.text;
  if (typeof source !== "string" || !source.trim()) {
    return undefined;
  }
  const sanitized = sanitizeIMessageOutboundText(source);
  const prepared = prepareIMessageOutboundText({
    cfg: params.ctx.cfg,
    accountId: params.accountId,
    text: sanitized,
  });
  const textLimit = resolveTextChunkLimit(params.ctx.cfg, "imessage", params.accountId, {
    fallbackLimit: DEFAULT_IMESSAGE_TEXT_CHUNK_LIMIT,
  });
  // messages.history exposes the final text but not native formatting ranges.
  // It also cannot identify every row in a post-enqueue multi-chunk send.
  return prepared.ranges.length === 0 && prepared.text.length <= textLimit
    ? prepared.text || undefined
    : undefined;
}

function normalizeReplyGuid(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value)?.replace(/^p:\d+\//iu, "");
  return normalized || undefined;
}

function resolveExpectedReplyGuid(ctx: ChannelMessageUnknownSendContext): string | undefined {
  if (Object.hasOwn(ctx, "effectiveReplyToId")) {
    return normalizeReplyGuid(ctx.effectiveReplyToId);
  }
  return normalizeReplyGuid(ctx.payloads[0]?.replyToId ?? ctx.replyToId);
}

function historyMessageMatches(params: {
  raw: unknown;
  chatId: number;
  text: string;
  startMs: number;
  endMs: number;
  replyGuid?: string;
}) {
  const message = parseIMessageNotification({ message: params.raw });
  if (
    !message ||
    message.chat_id !== params.chatId ||
    message.is_from_me !== true ||
    message.text !== params.text ||
    message.is_reaction === true ||
    message.is_tapback === true
  ) {
    return undefined;
  }
  const guid = normalizeOptionalString(message.guid);
  const timestamp = Date.parse(message.created_at ?? "");
  if (
    !guid ||
    !Number.isFinite(timestamp) ||
    timestamp < params.startMs ||
    timestamp >= params.endMs
  ) {
    return undefined;
  }
  if (normalizeReplyGuid(message.reply_to_guid) !== params.replyGuid) {
    return undefined;
  }
  return { guid, timestamp };
}

export async function reconcileIMessageUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
  opts?: {
    client?: ReconciliationClient;
    createClient?: (params: { cliPath: string; dbPath?: string }) => Promise<ReconciliationClient>;
  },
): Promise<ChannelMessageUnknownSendReconciliationResult> {
  const cfg = requireRuntimeConfig(ctx.cfg, "iMessage delivery reconciliation");
  const account = resolveIMessageAccount({ cfg, accountId: ctx.accountId ?? undefined });
  if (!ctx.platformSendStartedAt) {
    return unresolved({
      ctx,
      error: "iMessage reconciliation requires a platform send start timestamp",
      retryable: false,
    });
  }
  const expectedText = resolveExpectedText({ ctx, accountId: account.accountId });
  if (!expectedText) {
    return unresolved({
      ctx,
      error:
        "iMessage reconciliation requires exactly one non-empty, unformatted, unchunked text send",
      retryable: false,
    });
  }

  let target: ReturnType<typeof parseIMessageTarget>;
  try {
    target = parseIMessageTarget(ctx.to);
  } catch {
    return unresolved({
      ctx,
      error: "iMessage reconciliation could not parse the delivery target",
      retryable: false,
    });
  }

  const cliPath = account.config.cliPath?.trim() || "imsg";
  const dbPath = account.config.dbPath?.trim() || undefined;
  const client =
    opts?.client ??
    (opts?.createClient
      ? await opts.createClient({ cliPath, dbPath })
      : await createIMessageRpcClient({ cliPath, dbPath }));
  const shouldStopClient = !opts?.client;
  try {
    const targetChats = await resolveTargetChatIds({
      client,
      target,
      expectedService: resolveExpectedService({
        target,
        accountService: account.config.service,
      }),
    });
    if ("error" in targetChats) {
      return unresolved({
        ctx,
        error: targetChats.error,
        retryable: targetChats.retryable && ctx.retryCount < 2,
      });
    }

    const configuredTimeout = account.config.probeTimeoutMs;
    const sendTimeoutMs =
      typeof configuredTimeout === "number" &&
      Number.isFinite(configuredTimeout) &&
      configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_IMESSAGE_SEND_TIMEOUT_MS;
    // Never look before core recorded platform dispatch. Cross-host clock skew
    // can therefore cause a safe false negative, but cannot let an earlier
    // identical message stand in for this delivery attempt.
    const startMs = ctx.platformSendStartedAt;
    const endMs = ctx.platformSendStartedAt + sendTimeoutMs;
    const expectedReplyGuid = resolveExpectedReplyGuid(ctx);
    const matches: HistoryMatch[] = [];
    for (const chatId of targetChats.chatIds) {
      const result = await client.request<{ messages?: unknown[] }>(
        "messages.history",
        {
          chat_id: chatId,
          limit: RECONCILE_HISTORY_LIMIT,
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
          attachments: false,
        },
        { timeoutMs: DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS },
      );
      const rows = Array.isArray(result?.messages) ? result.messages : [];
      matches.push(
        ...rows
          .map((raw) =>
            historyMessageMatches({
              raw,
              chatId,
              text: expectedText,
              startMs,
              endMs,
              replyGuid: expectedReplyGuid,
            }),
          )
          .filter((match): match is HistoryMatch => Boolean(match)),
      );
    }

    // imsg does not expose a queue/idempotency token, so this proves one exact
    // recipient-visible effect, not cryptographic ownership by this queue row.
    // Concurrent byte-identical sends remain indistinguishable.
    if (matches.length !== 1) {
      return unresolved({
        ctx,
        error:
          matches.length > 1
            ? "iMessage history contains multiple exact outbound candidates"
            : "iMessage history contains no exact outbound candidate",
        retryable: matches.length === 0 && ctx.retryCount < 2,
      });
    }
    const match = matches[0]!;
    const matchedGuid = normalizeReplyGuid(match.guid) ?? match.guid;
    const sendStatus = await client.request<MessageSendStatusResult>(
      "message.send_status",
      { guid: matchedGuid },
      { timeoutMs: DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS },
    );
    const normalizedSendState = sendStatus?.send_state?.trim().toLowerCase();
    const statusConfirmsSend =
      sendStatus?.ok === true &&
      normalizeReplyGuid(sendStatus.guid) === matchedGuid &&
      (normalizedSendState === "sent" || normalizedSendState === "delivered");
    if (!statusConfirmsSend) {
      return unresolved({
        ctx,
        error: `iMessage send status is not confirmed${
          normalizedSendState ? `: ${normalizedSendState}` : ""
        }`,
        retryable: normalizedSendState === "pending" && ctx.retryCount < 2,
      });
    }
    return {
      status: "sent",
      messageId: match.guid,
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "imessage", messageId: match.guid, timestamp: match.timestamp }],
        kind: "text",
        sentAt: match.timestamp,
        ...(expectedReplyGuid ? { replyToId: expectedReplyGuid } : {}),
      }),
    };
  } catch (err) {
    const error = String(err);
    return unresolved({
      ctx,
      error: `iMessage delivery reconciliation failed: ${error}`,
      retryable: !/(?:code=-32601|method not found)/iu.test(error) && ctx.retryCount < 2,
    });
  } finally {
    if (shouldStopClient) {
      try {
        await client.stop();
      } catch {
        // Cleanup failure cannot invalidate delivery evidence already returned.
      }
    }
  }
}
