import type { OpenClawConfig, ReplyPayload, RuntimeEnv } from "openclaw/plugin-sdk";
import crypto from "node:crypto";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import type { ZulipAuth } from "./client.js";
import type { ZulipHttpError } from "./client.js";
import { getZulipRuntime } from "../runtime.js";
import { resolveZulipAccount, type ResolvedZulipAccount } from "./accounts.js";
import { zulipRequest } from "./client.js";
import { createDedupeCache } from "./dedupe.js";
import { normalizeStreamName, normalizeTopic } from "./normalize.js";
import { buildZulipQueuePlan, buildZulipRegisterNarrow } from "./queue-plan.js";
import { addZulipReaction, removeZulipReaction } from "./reactions.js";
import { sendZulipStreamMessage } from "./send.js";
import { downloadZulipUploads, resolveOutboundMedia, uploadZulipFile } from "./uploads.js";

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
  stream_id?: number;
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

export function computeZulipMonitorBackoffMs(params: {
  attempt: number;
  status: number | null;
  retryAfterMs?: number;
}): number {
  const cappedAttempt = Math.max(1, Math.min(10, Math.floor(params.attempt)));
  // Zulip can rate-limit /events fairly aggressively on some deployments; prefer slower retries.
  const base = params.status === 429 ? 10_000 : 500;
  const max = params.status === 429 ? 120_000 : 30_000;
  const exp = Math.min(max, base * 2 ** Math.min(7, cappedAttempt - 1));
  const jitter = Math.floor(Math.random() * 500);
  return Math.max(exp + jitter, params.retryAfterMs ?? 0, base);
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (onAbort && abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    if (abortSignal) {
      onAbort = () => {
        clearTimeout(timer);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function extractZulipHttpStatus(err: unknown): number | null {
  if (err && typeof err === "object" && "status" in err) {
    const value = (err as { status?: unknown }).status;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  const match = /Zulip API error \((\d{3})\):/.exec(String(err));
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
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

function extractZulipTopicDirective(text: string): { topic?: string; text: string } {
  const raw = text ?? "";
  // Allow an agent to create/switch topics by prefixing a reply with:
  // [[zulip_topic: <topic>]]
  const match = /^\s*\[\[zulip_topic:\s*([^\]]+)\]\]\s*\n?/i.exec(raw);
  if (!match) {
    return { text: raw };
  }
  const topic = normalizeTopic(match[1]) || undefined;
  const nextText = raw.slice(match[0].length).trimStart();
  if (!topic) {
    return { text: nextText };
  }
  // Keep topics reasonably short (UI-friendly).
  const truncated = topic.length > 60 ? topic.slice(0, 60).trim() : topic;
  return { topic: truncated || topic, text: nextText };
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
  stream: string;
  abortSignal?: AbortSignal;
}): Promise<{ queueId: string; lastEventId: number }> {
  const core = getZulipRuntime();
  const narrow = buildZulipRegisterNarrow(params.stream);
  const res = await zulipRequest<ZulipRegisterResponse>({
    auth: params.auth,
    method: "POST",
    path: "/api/v1/register",
    form: {
      event_types: JSON.stringify(["message"]),
      apply_markdown: "false",
      narrow,
    },
    abortSignal: params.abortSignal,
  });
  if (res.result !== "success" || !res.queue_id || typeof res.last_event_id !== "number") {
    throw new Error(res.msg || "Failed to register Zulip event queue");
  }
  core.logging
    .getChildLogger({ channel: "zulip" })
    .info(`[zulip] registered queue ${res.queue_id} (narrow=stream:${params.stream})`);
  return { queueId: res.queue_id, lastEventId: res.last_event_id };
}

async function pollEvents(params: {
  auth: ZulipAuth;
  queueId: string;
  lastEventId: number;
  abortSignal?: AbortSignal;
}): Promise<ZulipEventsResponse> {
  // Wrap the parent signal with a per-poll timeout so we don't hang forever
  // if the Zulip server goes unresponsive during long-poll.
  // REDUCED from 90s to 60s for faster recovery from stuck connections
  const POLL_TIMEOUT_MS = 60_000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onTimeout = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  timer = setTimeout(onTimeout, POLL_TIMEOUT_MS);

  const onParentAbort = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  params.abortSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    return await zulipRequest<ZulipEventsResponse>({
      auth: params.auth,
      method: "GET",
      path: "/api/v1/events",
      query: {
        queue_id: params.queueId,
        last_event_id: params.lastEventId,
        // Be explicit: we want long-poll behavior to avoid tight polling loops that can trigger 429s.
        dont_block: false,
      },
      abortSignal: controller.signal,
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    params.abortSignal?.removeEventListener("abort", onParentAbort);
  }
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
    return { ignore: true, reason: "dm" };
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

/**
 * Send a one-time "I only work in streams" reply to DM senders.
 * Uses a Set to avoid spamming the same sender repeatedly.
 */
async function replyToDm(params: {
  auth: ZulipAuth;
  senderId: number;
  dmNotifiedSenders: Set<number>;
  log?: (message: string) => void;
}): Promise<void> {
  if (params.dmNotifiedSenders.has(params.senderId)) {
    return;
  }
  params.dmNotifiedSenders.add(params.senderId);
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/messages",
      form: {
        type: "direct",
        to: JSON.stringify([params.senderId]),
        content:
          "👋 I only work in Zulip streams — mention me in a stream to chat! DMs are not supported.",
      },
    });
    params.log?.(`[zulip] sent DM redirect to user ${params.senderId}`);
  } catch (err) {
    params.log?.(`[zulip] failed to send DM redirect: ${String(err)}`);
  }
}

async function sendTypingIndicator(params: {
  auth: ZulipAuth;
  streamId: number;
  topic: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/typing",
      form: {
        op: "start",
        type: "stream",
        stream_id: params.streamId,
        topic: params.topic,
      },
      abortSignal: params.abortSignal,
    });
  } catch {
    // Best effort — typing indicators are non-critical.
  }
}

async function stopTypingIndicator(params: {
  auth: ZulipAuth;
  streamId: number;
  topic: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/typing",
      form: {
        op: "stop",
        type: "stream",
        stream_id: params.streamId,
        topic: params.topic,
      },
      abortSignal: params.abortSignal,
    });
  } catch {
    // Best effort — typing indicators are non-critical.
  }
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
  cfg: OpenClawConfig;
  abortSignal?: AbortSignal;
}) {
  const core = getZulipRuntime();
  const topicDirective = extractZulipTopicDirective(params.payload.text ?? "");
  const topic = topicDirective.topic ?? params.topic;
  const text = topicDirective.text;
  const mediaUrls = (params.payload.mediaUrls ?? []).filter(Boolean);
  const mediaUrl = params.payload.mediaUrl?.trim();
  if (mediaUrl) {
    mediaUrls.unshift(mediaUrl);
  }

  const sendTextChunks = async (value: string) => {
    const chunks = core.channel.text.chunkMarkdownText(value, params.account.textChunkLimit);
    for (const chunk of chunks.length > 0 ? chunks : [value]) {
      if (!chunk) {
        continue;
      }
      await sendZulipStreamMessage({
        auth: params.auth,
        stream: params.stream,
        topic,
        content: chunk,
        abortSignal: params.abortSignal,
      });
    }
  };

  const trimmedText = text.trim();
  if (!trimmedText && mediaUrls.length === 0) {
    return;
  }
  if (mediaUrls.length === 0) {
    await sendTextChunks(text);
    return;
  }

  // Match core outbound behavior: treat text as a caption for the first media item.
  // If the caption is very long, send it as text chunks first to avoid exceeding limits.
  let caption = trimmedText;
  if (caption.length > params.account.textChunkLimit) {
    await sendTextChunks(text);
    caption = "";
  }

  for (const source of mediaUrls) {
    const resolved = await resolveOutboundMedia({
      cfg: params.cfg,
      accountId: params.account.accountId,
      mediaUrl: source,
    });
    const uploadedUrl = await uploadZulipFile({
      auth: params.auth,
      buffer: resolved.buffer,
      contentType: resolved.contentType,
      filename: resolved.filename ?? "attachment",
      abortSignal: params.abortSignal,
    });
    const content = caption ? `${caption}\n\n${uploadedUrl}` : uploadedUrl;
    await sendZulipStreamMessage({
      auth: params.auth,
      stream: params.stream,
      topic,
      content,
      abortSignal: params.abortSignal,
    });
    caption = "";
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
  const abortController = new AbortController();
  const abortSignal = abortController.signal;
  let stopped = false;
  const stop = () => {
    stopped = true;
    abortController.abort();
  };
  opts.abortSignal?.addEventListener("abort", stop, { once: true });

  const run = async () => {
    const me = await fetchZulipMe(auth, abortSignal);
    if (me.result !== "success" || typeof me.user_id !== "number") {
      throw new Error(me.msg || "Failed to fetch Zulip bot identity");
    }
    const botUserId = me.user_id;
    logger.info(`[zulip:${account.accountId}] bot user_id=${botUserId}`);

    // Dedupe cache prevents reprocessing messages after queue re-registration or reconnect.
    const dedupe = createDedupeCache({ ttlMs: 5 * 60 * 1000, maxSize: 500 });

    // Track DM senders we've already notified to avoid spam.
    const dmNotifiedSenders = new Set<number>();

    const handleMessage = async (msg: ZulipEventMessage) => {
      if (typeof msg.id !== "number") {
        return;
      }
      if (dedupe.check(String(msg.id))) {
        return;
      }
      const ignore = shouldIgnoreMessage({ message: msg, botUserId, streams: account.streams });
      if (ignore.ignore) {
        return;
      }

      const stream = normalizeStreamName(msg.display_recipient);
      const topic = normalizeTopic(msg.subject) || account.defaultTopic;
      const content = msg.content ?? "";
      if (!stream || !content.trim()) {
        return;
      }

      core.channel.activity.record({
        channel: "zulip",
        accountId: account.accountId,
        direction: "inbound",
        at: Date.now(),
      });
      opts.statusSink?.({ lastInboundAt: Date.now() });

      // Per-handler delivery signal: allows reply delivery to complete even if the monitor
      // is stopping (e.g. gateway restart). Without this, in-flight HTTP calls to Zulip get
      // aborted immediately, wasting the LLM tokens already spent generating the response.
      const DELIVERY_GRACE_MS = 10_000;
      const DELIVERY_TIMEOUT_MS = 60_000;
      const deliveryController = new AbortController();
      const deliverySignal = deliveryController.signal;
      const deliveryTimer = setTimeout(() => {
        if (!deliveryController.signal.aborted) deliveryController.abort();
      }, DELIVERY_TIMEOUT_MS);
      const onMainAbortForDelivery = () => {
        // Give in-flight deliveries a grace period to finish before hard abort
        setTimeout(() => {
          if (!deliveryController.signal.aborted) deliveryController.abort();
        }, DELIVERY_GRACE_MS);
      };
      abortSignal.addEventListener("abort", onMainAbortForDelivery, { once: true });

      const prefix = account.reactions;
      if (prefix.enabled) {
        await bestEffortReaction({
          auth,
          messageId: msg.id,
          op: "add",
          emojiName: prefix.onStart,
          log: (m) => logger.debug?.(m),
          abortSignal,
        });
      }

      // Send typing indicator while the agent processes.
      if (typeof msg.stream_id === "number") {
        sendTypingIndicator({ auth, streamId: msg.stream_id, topic, abortSignal }).catch(
          () => undefined,
        );
      }

      const inboundUploads = await downloadZulipUploads({
        cfg,
        accountId: account.accountId,
        auth,
        content,
        abortSignal,
      });
      const mediaPaths = inboundUploads.map((entry) => entry.path);
      const mediaUrls = inboundUploads.map((entry) => entry.url);
      const mediaTypes = inboundUploads.map((entry) => entry.contentType ?? "");

      // Strip downloaded upload URLs from the content so the native image loader
      // doesn't try to open raw /user_uploads/... paths as local files.
      let cleanedContent = content;
      for (const upload of inboundUploads) {
        // Replace both the full URL and any relative /user_uploads/ path variants.
        cleanedContent = cleanedContent.replaceAll(upload.url, upload.placeholder);
        try {
          const urlObj = new URL(upload.url);
          cleanedContent = cleanedContent.replaceAll(urlObj.pathname, upload.placeholder);
        } catch {
          // Ignore URL parse errors.
        }
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
      const from = `zulip:channel:${stream}`;
      const senderName =
        msg.sender_full_name?.trim() || msg.sender_email?.trim() || String(msg.sender_id);

      const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
      const cleanedForMentions = content.replace(/@\*\*([^*]+)\*\*/g, "@$1");
      const wasMentioned = core.channel.mentions.matchesMentionPatterns(
        cleanedForMentions,
        mentionRegexes,
      );

      const body = core.channel.reply.formatInboundEnvelope({
        channel: "Zulip",
        from: `${stream} (${topic || account.defaultTopic})`,
        timestamp: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
        body: `${cleanedContent}\n[zulip message id: ${msg.id} stream: ${stream} topic: ${topic}]`,
        chatType: "channel",
        sender: { name: senderName, id: String(msg.sender_id) },
      });

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: cleanedContent,
        CommandBody: cleanedContent,
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
        GroupSystemPrompt: account.alwaysReply
          ? "Always reply to every message in this Zulip stream/topic. If a full response isn't needed, acknowledge briefly in 1 short sentence. To start a new topic, prefix your reply with: [[zulip_topic: <topic>]]"
          : undefined,
        Provider: "zulip" as const,
        Surface: "zulip" as const,
        SenderName: senderName,
        SenderId: String(msg.sender_id),
        MessageSid: String(msg.id),
        WasMentioned: wasMentioned,
        OriginatingChannel: "zulip" as const,
        OriginatingTo: to,
        Timestamp: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
        MediaPath: mediaPaths[0],
        MediaUrl: mediaUrls[0],
        MediaType: mediaTypes[0],
        MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
        MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
        MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
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
            // Use deliverySignal (not abortSignal) so in-flight replies survive
            // monitor shutdown with a grace period instead of being killed instantly.
            await deliverReply({
              account,
              auth,
              stream,
              topic,
              payload,
              cfg,
              abortSignal: deliverySignal,
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
        runtime.error?.(`zulip dispatch failed: ${String(err)}`);
      } finally {
        markDispatchIdle();
        // Clean up delivery abort controller
        clearTimeout(deliveryTimer);
        abortSignal.removeEventListener("abort", onMainAbortForDelivery);

        // Stop typing indicator now that the reply has been sent.
        if (typeof msg.stream_id === "number") {
          stopTypingIndicator({
            auth,
            streamId: msg.stream_id,
            topic,
            abortSignal: deliverySignal,
          }).catch(() => undefined);
        }
        // Use deliverySignal for final reactions so they can still be posted
        // during graceful shutdown (the grace period covers these too).
        if (account.reactions.enabled) {
          if (account.reactions.clearOnFinish) {
            await bestEffortReaction({
              auth,
              messageId: msg.id,
              op: "remove",
              emojiName: account.reactions.onStart,
              log: (m) => logger.debug?.(m),
              abortSignal: deliverySignal,
            });
          }
          const finalEmoji = ok ? account.reactions.onSuccess : account.reactions.onFailure;
          await bestEffortReaction({
            auth,
            messageId: msg.id,
            op: "add",
            emojiName: finalEmoji,
            log: (m) => logger.debug?.(m),
            abortSignal: deliverySignal,
          });
        }
        // Hard-abort delivery controller if it hasn't fired yet (cleanup)
        if (!deliveryController.signal.aborted) {
          deliveryController.abort();
        }
      }
    };

    const pollStreamQueue = async (stream: string) => {
      let queueId = "";
      let lastEventId = -1;
      let retry = 0;
      let stage: "register" | "poll" | "handle" = "register";

      // Backpressure: limit concurrent message handlers to prevent unbounded pile-up.
      const MAX_CONCURRENT_HANDLERS = 5;
      let activeHandlers = 0;
      const handlerWaiters: Array<() => void> = [];

      const throttledHandleMessage = async (msg: ZulipEventMessage) => {
        if (activeHandlers >= MAX_CONCURRENT_HANDLERS) {
          await new Promise<void>((resolve) => handlerWaiters.push(resolve));
        }
        activeHandlers++;
        try {
          await handleMessage(msg);
        } finally {
          activeHandlers--;
          const next = handlerWaiters.shift();
          if (next) next();
        }
      };

      while (!stopped && !abortSignal.aborted) {
        try {
          if (!queueId) {
            stage = "register";
            const wasReregistration = lastEventId !== -1;
            const reg = await registerQueue({ auth, stream, abortSignal });
            queueId = reg.queueId;
            lastEventId = reg.lastEventId;

            // Issue 5: recover messages lost during queue gap on re-registration.
            if (wasReregistration) {
              try {
                const recent = await zulipRequest<{
                  result: string;
                  messages?: ZulipEventMessage[];
                }>({
                  auth,
                  method: "GET",
                  path: "/api/v1/messages",
                  query: {
                    anchor: "newest",
                    num_before: 10,
                    num_after: 0,
                    narrow: JSON.stringify([["stream", stream]]),
                    apply_markdown: "false",
                  },
                  abortSignal,
                });
                if (recent.result === "success" && recent.messages) {
                  for (const msg of recent.messages) {
                    // dedupe.check skips already-processed messages
                    throttledHandleMessage(msg).catch((err) => {
                      runtime.error?.(`zulip: catchup message failed: ${String(err)}`);
                    });
                  }
                }
              } catch (catchupErr) {
                logger.debug?.(
                  `[zulip:${account.accountId}] catchup fetch failed: ${String(catchupErr)}`,
                );
              }
            }
          }

          stage = "poll";
          const events = await pollEvents({ auth, queueId, lastEventId, abortSignal });
          if (events.result !== "success") {
            throw new Error(events.msg || "Zulip events poll failed");
          }

          const list = events.events ?? [];
          if (typeof events.last_event_id === "number") {
            lastEventId = events.last_event_id;
          }

          const messages = list
            .map((evt) => evt.message)
            .filter((m): m is ZulipEventMessage => Boolean(m));

          // Issue 2: handle DMs by sending a redirect notice.
          const dmMessages = messages.filter(
            (m) => m.type !== "stream" && m.sender_id !== botUserId,
          );
          for (const dm of dmMessages) {
            if (typeof dm.sender_id === "number") {
              logger.debug?.(`[zulip:${account.accountId}] ignoring DM from user ${dm.sender_id}`);
              replyToDm({
                auth,
                senderId: dm.sender_id,
                dmNotifiedSenders,
                log: (m) => logger.debug?.(m),
              }).catch(() => undefined);
            }
          }

          // Defensive throttle: if Zulip responds immediately without any message payloads (e.g.
          // heartbeat-only events, proxies, or aggressive server settings), avoid a tight loop that can
          // hit 429s.
          if (messages.length === 0) {
            const jitterMs = Math.floor(Math.random() * 250);
            await sleep(2000 + jitterMs, abortSignal).catch(() => undefined);
            retry = 0;
            continue;
          }

          stage = "handle";
          for (const msg of messages) {
            // Use throttled handler with backpressure (max concurrent limit)
            throttledHandleMessage(msg).catch((err) => {
              runtime.error?.(`zulip: message processing failed: ${String(err)}`);
            });
            // Small stagger between starting each message for natural pacing
            await sleep(200, abortSignal).catch(() => undefined);
          }

          retry = 0;
        } catch (err) {
          // FIX: Only break if explicitly stopped, NOT on abort
          // Abort errors (timeouts) should trigger queue re-registration
          if (stopped) {
            break;
          }

          const status = extractZulipHttpStatus(err);
          const retryAfterMs = (err as ZulipHttpError).retryAfterMs;

          // FIX: Always clear queueId on ANY error to force re-registration
          // This prevents stuck queues when fetch times out or aborts
          queueId = "";

          // Detect timeout/abort errors specifically for better logging
          const isAbortError =
            err instanceof Error &&
            (err.name === "AbortError" ||
              err.message?.includes("aborted") ||
              err.message?.includes("timeout") ||
              err.message?.includes("ETIMEDOUT"));

          if (isAbortError) {
            logger.warn(
              `[zulip:${account.accountId}] poll timeout/abort detected (stream=${stream}, stage=${stage}): ${String(err)} - forcing queue re-registration`,
            );
          }

          retry += 1;
          const backoffMs = computeZulipMonitorBackoffMs({
            attempt: retry,
            status,
            retryAfterMs,
          });
          logger.warn(
            `[zulip:${account.accountId}] monitor error (stream=${stream}, stage=${stage}, attempt=${retry}): ${String(err)} (retry in ${backoffMs}ms)`,
          );
          await sleep(backoffMs, abortSignal).catch(() => undefined);
        }
      }

      // Issue 4: clean up the server-side event queue on shutdown.
      if (queueId) {
        try {
          await zulipRequest({
            auth,
            method: "DELETE",
            path: "/api/v1/events",
            form: { queue_id: queueId },
          });
        } catch {
          // Best effort — server will expire it anyway.
        }
      }
    };

    const plan = buildZulipQueuePlan(account.streams);
    if (plan.length === 0) {
      throw new Error(
        `Zulip streams allowlist missing for account "${account.accountId}" (set channels.zulip.streams)`,
      );
    }
    await Promise.all(plan.map((entry) => pollStreamQueue(entry.stream)));
  };

  void run()
    .catch((err) => {
      if (abortSignal.aborted || stopped) {
        return;
      }
      opts.statusSink?.({ lastError: err instanceof Error ? err.message : String(err) });
      runtime.error?.(`[zulip:${account.accountId}] monitor crashed: ${String(err)}`);
    })
    .finally(() => {
      logger.info(`[zulip:${account.accountId}] stopped`);
    });

  return { stop };
}
