import type { OpenClawConfig, ReplyPayload, RuntimeEnv } from "openclaw/plugin-sdk";
import crypto from "node:crypto";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import type { ZulipAuth } from "./client.js";
import { getZulipRuntime } from "../runtime.js";
import { resolveZulipAccount, type ResolvedZulipAccount } from "./accounts.js";
import { zulipRequest } from "./client.js";
import { normalizeStreamName, normalizeTopic } from "./normalize.js";
import { addZulipReaction, removeZulipReaction } from "./reactions.js";
import { sendZulipStreamMessage } from "./send.js";

export type MonitorZulipOptions = {
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: {
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastError?: string;
  }) => void;
};

type ZulipRegisterResponse = {
  result: "success" | "error";
  msg?: string;
  queue_id?: string;
  last_event_id?: number;
};

type ZulipEventMessage = {
  id: number;
  type: string;
  sender_id: number;
  sender_full_name?: string;
  sender_email?: string;
  display_recipient?: string;
  subject?: string;
  content?: string;
  content_type?: string;
  timestamp?: number;
};

type ZulipEvent = {
  id?: number;
  type?: string;
  message?: ZulipEventMessage;
};

type ZulipEventsResponse = {
  result: "success" | "error";
  msg?: string;
  events?: ZulipEvent[];
  last_event_id?: number;
};

type ZulipMeResponse = {
  result: "success" | "error";
  msg?: string;
  user_id?: number;
  email?: string;
  full_name?: string;
};

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    abortSignal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      },
      { once: true },
    );
  });
}

function buildAuth(account: ResolvedZulipAccount): ZulipAuth {
  if (!account.baseUrl || !account.email || !account.apiKey) {
    throw new Error("Missing zulip baseUrl/email/apiKey");
  }
  return {
    baseUrl: account.baseUrl,
    email: account.email,
    apiKey: account.apiKey,
  };
}

function buildTopicKey(topic: string): string {
  const normalized = topic.trim().toLowerCase();
  const encoded = encodeURIComponent(normalized);
  if (encoded.length <= 80) {
    return encoded;
  }
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${encoded.slice(0, 64)}~${digest}`;
}

async function fetchZulipMe(auth: ZulipAuth, abortSignal?: AbortSignal): Promise<ZulipMeResponse> {
  return await zulipRequest<ZulipMeResponse>({
    auth,
    method: "GET",
    path: "/api/v1/users/me",
    abortSignal,
  });
}

async function registerQueue(params: {
  auth: ZulipAuth;
  streams: string[];
  abortSignal?: AbortSignal;
}): Promise<{ queueId: string; lastEventId: number }> {
  const core = getZulipRuntime();
  const useNarrow = params.streams.length === 1;
  const narrow = useNarrow ? JSON.stringify([["channel", params.streams[0]]]) : undefined;
  const res = await zulipRequest<ZulipRegisterResponse>({
    auth: params.auth,
    method: "POST",
    path: "/api/v1/register",
    form: {
      event_types: JSON.stringify(["message"]),
      apply_markdown: "false",
      ...(narrow ? { narrow } : {}),
    },
    abortSignal: params.abortSignal,
  });
  if (res.result !== "success" || !res.queue_id || typeof res.last_event_id !== "number") {
    throw new Error(res.msg || "Failed to register Zulip event queue");
  }
  core.logging
    .getChildLogger({ channel: "zulip" })
    .info(`[zulip] registered queue ${res.queue_id} (narrow=${useNarrow ? "channel" : "none"})`);
  return { queueId: res.queue_id, lastEventId: res.last_event_id };
}

async function pollEvents(params: {
  auth: ZulipAuth;
  queueId: string;
  lastEventId: number;
  abortSignal?: AbortSignal;
}): Promise<ZulipEventsResponse> {
  return await zulipRequest<ZulipEventsResponse>({
    auth: params.auth,
    method: "GET",
    path: "/api/v1/events",
    query: {
      queue_id: params.queueId,
      last_event_id: params.lastEventId,
    },
    abortSignal: params.abortSignal,
  });
}

function shouldIgnoreMessage(params: {
  message: ZulipEventMessage;
  botUserId: number;
  streams: string[];
}): { ignore: boolean; reason?: string } {
  const msg = params.message;
  if (msg.sender_id === params.botUserId) {
    return { ignore: true, reason: "self" };
  }
  if (msg.type !== "stream") {
    return { ignore: true, reason: "non-stream" };
  }
  const stream = normalizeStreamName(msg.display_recipient);
  if (!stream) {
    return { ignore: true, reason: "missing-stream" };
  }
  if (params.streams.length > 0 && !params.streams.includes(stream)) {
    return { ignore: true, reason: "not-allowed-stream" };
  }
  return { ignore: false };
}

async function bestEffortReaction(params: {
  auth: ZulipAuth;
  messageId: number;
  op: "add" | "remove";
  emojiName: string;
  log?: (message: string) => void;
  abortSignal?: AbortSignal;
}) {
  const emojiName = params.emojiName;
  if (!emojiName) {
    return;
  }
  try {
    if (params.op === "add") {
      await addZulipReaction({
        auth: params.auth,
        messageId: params.messageId,
        emojiName,
        abortSignal: params.abortSignal,
      });
      return;
    }
    await removeZulipReaction({
      auth: params.auth,
      messageId: params.messageId,
      emojiName,
      abortSignal: params.abortSignal,
    });
  } catch (err) {
    params.log?.(`[zulip] reaction ${params.op} ${emojiName} failed: ${String(err)}`);
  }
}

async function deliverReply(params: {
  account: ResolvedZulipAccount;
  auth: ZulipAuth;
  stream: string;
  topic: string;
  payload: ReplyPayload;
  abortSignal?: AbortSignal;
}) {
  const core = getZulipRuntime();
  const text = params.payload.text ?? "";
  if (!text.trim()) {
    return;
  }
  const chunks = core.channel.text.chunkMarkdownText(text, params.account.textChunkLimit);
  for (const chunk of chunks.length > 0 ? chunks : [text]) {
    if (!chunk) {
      continue;
    }
    await sendZulipStreamMessage({
      auth: params.auth,
      stream: params.stream,
      topic: params.topic,
      content: chunk,
      abortSignal: params.abortSignal,
    });
  }
}

export async function monitorZulipProvider(
  opts: MonitorZulipOptions,
): Promise<{ stop: () => void }> {
  const core = getZulipRuntime();
  const cfg = opts.config ?? core.config.loadConfig();
  const account = resolveZulipAccount({
    cfg,
    accountId: opts.accountId,
  });
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (message: string) => core.logging.getChildLogger().info(message),
    error: (message: string) => core.logging.getChildLogger().error(message),
    exit: () => {
      throw new Error("Runtime exit not available");
    },
  };

  const logger = core.logging.getChildLogger({ channel: "zulip", accountId: account.accountId });

  if (!account.baseUrl || !account.email || !account.apiKey) {
    throw new Error(`Zulip credentials missing for account "${account.accountId}"`);
  }
  if (!account.streams.length) {
    throw new Error(
      `Zulip streams allowlist missing for account "${account.accountId}" (set channels.zulip.streams)`,
    );
  }

  const auth = buildAuth(account);
  const abortSignal = opts.abortSignal;
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  abortSignal?.addEventListener("abort", stop, { once: true });

  const me = await fetchZulipMe(auth, abortSignal);
  if (me.result !== "success" || typeof me.user_id !== "number") {
    throw new Error(me.msg || "Failed to fetch Zulip bot identity");
  }
  const botUserId = me.user_id;
  logger.info(`[zulip:${account.accountId}] bot user_id=${botUserId}`);

  let queueId = "";
  let lastEventId = -1;
  let retry = 0;

  while (!stopped && !abortSignal?.aborted) {
    try {
      if (!queueId) {
        const reg = await registerQueue({ auth, streams: account.streams, abortSignal });
        queueId = reg.queueId;
        lastEventId = reg.lastEventId;
      }

      const events = await pollEvents({ auth, queueId, lastEventId, abortSignal });
      if (events.result !== "success") {
        throw new Error(events.msg || "Zulip events poll failed");
      }

      const list = events.events ?? [];
      if (typeof events.last_event_id === "number") {
        lastEventId = events.last_event_id;
      }

      for (const evt of list) {
        const msg = evt.message;
        if (!msg || typeof msg.id !== "number") {
          continue;
        }
        const ignore = shouldIgnoreMessage({ message: msg, botUserId, streams: account.streams });
        if (ignore.ignore) {
          continue;
        }

        const stream = normalizeStreamName(msg.display_recipient);
        const topic = normalizeTopic(msg.subject) || account.defaultTopic;
        const content = msg.content ?? "";
        if (!stream || !content.trim()) {
          continue;
        }

        core.channel.activity.record({
          channel: "zulip",
          accountId: account.accountId,
          direction: "inbound",
          at: Date.now(),
        });
        opts.statusSink?.({ lastInboundAt: Date.now() });

        const prefix = account.reactions;
        if (prefix.enabled) {
          await bestEffortReaction({
            auth,
            messageId: msg.id,
            op: "add",
            emojiName: prefix.onStart,
            log: (m) => logger.debug(m),
            abortSignal,
          });
        }

        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "zulip",
          accountId: account.accountId,
          peer: { kind: "channel", id: stream },
        });
        const baseSessionKey = route.sessionKey;
        const sessionKey = `${baseSessionKey}:topic:${buildTopicKey(topic)}`;

        const to = `stream:${stream}#${topic}`;
        const from = `zulip:stream:${stream}`;
        const senderName =
          msg.sender_full_name?.trim() || msg.sender_email?.trim() || String(msg.sender_id);

        const body = core.channel.reply.formatInboundEnvelope({
          channel: "Zulip",
          from: `${stream} (${topic || account.defaultTopic})`,
          timestamp: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
          body: `${content}\n[zulip message id: ${msg.id} stream: ${stream} topic: ${topic}]`,
          chatType: "channel",
          sender: { name: senderName, id: String(msg.sender_id) },
        });

        const ctxPayload = core.channel.reply.finalizeInboundContext({
          Body: body,
          RawBody: content,
          CommandBody: content,
          From: from,
          To: to,
          SessionKey: sessionKey,
          AccountId: route.accountId,
          ChatType: "channel",
          ThreadLabel: topic,
          MessageThreadId: topic,
          ConversationLabel: `${stream}#${topic}`,
          GroupSubject: stream,
          GroupChannel: `#${stream}`,
          Provider: "zulip" as const,
          Surface: "zulip" as const,
          SenderName: senderName,
          SenderId: String(msg.sender_id),
          MessageSid: String(msg.id),
          OriginatingChannel: "zulip" as const,
          OriginatingTo: to,
          Timestamp: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
          CommandAuthorized: true,
        });

        const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
          cfg,
          agentId: route.agentId,
          channel: "zulip",
          accountId: account.accountId,
        });

        const { dispatcher, replyOptions, markDispatchIdle } =
          core.channel.reply.createReplyDispatcherWithTyping({
            ...prefixOptions,
            humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
            deliver: async (payload: ReplyPayload) => {
              await deliverReply({
                account,
                auth,
                stream,
                topic,
                payload,
                abortSignal,
              });
              opts.statusSink?.({ lastOutboundAt: Date.now() });
              core.channel.activity.record({
                channel: "zulip",
                accountId: account.accountId,
                direction: "outbound",
                at: Date.now(),
              });
            },
            onError: (err) => {
              runtime.error?.(`zulip reply failed: ${String(err)}`);
            },
          });

        let ok = false;
        try {
          await core.channel.reply.dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg,
            dispatcher,
            replyOptions: {
              ...replyOptions,
              disableBlockStreaming: true,
              onModelSelected,
            },
          });
          ok = true;
        } catch (err) {
          ok = false;
          opts.statusSink?.({ lastError: err instanceof Error ? err.message : String(err) });
          throw err;
        } finally {
          markDispatchIdle();
          if (account.reactions.enabled) {
            await bestEffortReaction({
              auth,
              messageId: msg.id,
              op: "remove",
              emojiName: account.reactions.onStart,
              log: (m) => logger.debug(m),
              abortSignal,
            });
            const finalEmoji = ok ? account.reactions.onSuccess : account.reactions.onFailure;
            await bestEffortReaction({
              auth,
              messageId: msg.id,
              op: "add",
              emojiName: finalEmoji,
              log: (m) => logger.debug(m),
              abortSignal,
            });
          }
        }
      }

      retry = 0;
    } catch (err) {
      if (stopped || abortSignal?.aborted) {
        break;
      }
      queueId = "";
      lastEventId = -1;
      retry += 1;
      const backoffMs = Math.min(30_000, 500 * 2 ** Math.min(6, retry));
      logger.warn(
        `[zulip:${account.accountId}] monitor error: ${String(err)} (retry in ${backoffMs}ms)`,
      );
      await sleep(backoffMs, abortSignal).catch(() => undefined);
    }
  }

  logger.info(`[zulip:${account.accountId}] stopped`);
  return { stop };
}
