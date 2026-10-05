import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { resolveChannelInboundRouteEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressError,
  createChannelIngressMonitor,
} from "openclaw/plugin-sdk/channel-outbound";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { ResolvedXAccount } from "./accounts.js";
import { parseXPost, parseXPostEnvelope, type XPostEnvelope } from "./api.js";
import { getXApi, getXTokenState } from "./client.js";
import { runXEvents, type XEventStatus } from "./events.js";
import { resolveXIngress, xMentionFacts } from "./ingress.js";
import type { XVisibleWorkSession } from "./reply.js";
import { getXRuntime } from "./runtime.js";
import { sendXDelivery } from "./send.js";
import { assembleXThread } from "./thread.js";

const InvalidXEvent = createChannelIngressError("InvalidXEvent");
type IngressPayload = { version: number; rawEvent: string };
type Stats = XEventStatus & { droppedMentions: number; lastDroppedAuthor?: string };

export async function startXAccount(ctx: ChannelGatewayContext<ResolvedXAccount>) {
  const core = getXRuntime();
  const account = ctx.account;
  const readConfig = createRuntimeConfigReader(ctx.cfg);
  const api = await getXApi(account.accountId, ctx.cfg);
  const log = core.logging.getChildLogger({ channel: "x", accountId: account.accountId });
  const stats: Stats = { droppedMentions: 0 };
  const publish = (next: Partial<Stats> = {}) => {
    Object.assign(stats, next);
    if (next.message) {
      log.info(next.message);
    }
    ctx.setStatus({
      ...ctx.getStatus(),
      ...stats,
      accountId: account.accountId,
      mode: stats.eventMode,
      connected: stats.eventMode === "poll" || stats.streamConnected,
      tokenStatus: getXTokenState(account.accountId),
      lastInboundAt: stats.lastEventAt,
    });
  };
  const cursor = core.state.openKeyedStore<{ userId: string; sinceId?: string }>({
    namespace: "x.cursor",
    maxEntries: 1_000,
    overflowPolicy: "reject-new",
  });
  const queue = core.state.openChannelIngressQueue<IngressPayload>({
    accountId: account.accountId,
  });
  const previous = await cursor.lookup(account.accountId);
  if (previous && previous.userId !== account.userId) {
    if (!queue.purge) {
      throw new Error("X bot identity changed; this host cannot reset its ingress queue.");
    }
    await queue.purge({ signal: ctx.abortSignal });
  }
  const assertCurrent = () => {
    ctx.abortSignal.throwIfAborted();
    if (getXRuntime() !== core) {
      throw new Error("X runtime was replaced");
    }
  };
  if (!previous || previous.userId !== account.userId) {
    await cursor.register(account.accountId, { userId: account.userId }, { assertCurrent });
  }
  const ingress = createChannelIngressMonitor<XPostEnvelope, string, IngressPayload>({
    queue,
    inspect: ({ post }) => {
      if (!parseXPost(post)) {
        throw new InvalidXEvent("Invalid X mention envelope");
      }
      return { eventId: post.id, laneKey: post.conversation_id };
    },
    payload: {
      storage: "raw-event",
      version: 1,
      serialize: (value) => JSON.stringify(value),
      deserialize: (value) => {
        const envelope = parseXPostEnvelope(JSON.parse(value));
        if (!envelope) {
          throw new InvalidXEvent("Invalid stored X mention envelope");
        }
        return envelope;
      },
      createClaimError: () => new InvalidXEvent("X mention identity changed after admission"),
    },
    pollIntervalMs: 1_000,
    retention: {
      completedMaxEntries: 2_000,
      completedTtlMs: 30 * 24 * 60 * 60 * 1_000,
      failedMaxEntries: 1_000,
    },
    abortSignal: ctx.abortSignal,
    deliver: async ({ post, users }, lifecycle) => {
      let cfg = readConfig();
      const { ingress: initial } = await resolveXIngress(account.accountId, post, cfg);
      if (post.author_id === account.userId || !initial.senderAccess.allowed) {
        publish({ droppedMentions: stats.droppedMentions + 1, lastDroppedAuthor: post.author_id });
        log.info(`mention post=${post.id} author=${post.author_id} dropped`);
        return;
      }
      const thread = await assembleXThread({
        api,
        mention: post,
        users,
        maxPosts: account.config.threadContext?.maxPosts ?? 50,
        signal: lifecycle.abortSignal,
      });
      cfg = readConfig();
      const { route } = resolveChannelInboundRouteEnvelope({
        cfg,
        channel: "x",
        accountId: account.accountId,
        peer: { kind: "group", id: post.conversation_id },
      });
      const authorization = await resolveXIngress(account.accountId, post, cfg, {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        messageId: post.id,
        inboundEventKind: "user_request",
      });
      const assertAdmissionCurrent = () => {
        assertCurrent();
        lifecycle.abortSignal.throwIfAborted();
        authorization.assertCurrent();
        if (cfg !== readConfig()) {
          throw new Error("X routing configuration changed during admission; retrying mention");
        }
      };
      const channelIngress = authorization.ingress;
      assertAdmissionCurrent();
      if (!channelIngress.senderAccess.allowed) {
        publish({ droppedMentions: stats.droppedMentions + 1, lastDroppedAuthor: post.author_id });
        log.info(`mention post=${post.id} author=${post.author_id} dropped`);
        return;
      }
      const handle =
        thread.users.find((user) => user.id === post.author_id)?.username ?? post.author_id;
      const ctxPayload = core.channel.inbound.buildContext({
        channelIngress,
        access: {
          mentions: { ...xMentionFacts, requireMention: true, explicitlyMentionedBot: true },
        },
        channel: "x",
        accountId: account.accountId,
        messageId: post.id,
        timestamp: post.created_at ? Date.parse(post.created_at) : undefined,
        from: `x:group:${post.conversation_id}`,
        sender: { id: post.author_id, name: `@${handle}` },
        conversation: {
          kind: "group",
          id: post.conversation_id,
          label: thread.label,
          link: { url: `https://x.com/${handle}/status/${post.id}`, label: "View on X" },
        },
        route: {
          agentId: route.agentId,
          accountId: route.accountId,
          routeSessionKey: route.sessionKey,
        },
        reply: { to: `x:${post.id}`, replyToId: post.id },
        message: {
          body: post.text,
          rawBody: post.text,
          commandBody: post.text,
          bodyForAgent: thread.bodyForAgent,
        },
      });
      const sessions: XVisibleWorkSession[] = [];
      log.info(`mention post=${post.id} author=${post.author_id} allowed`);
      assertAdmissionCurrent();
      await core.channel.inbound.dispatch({
        cfg,
        channel: "x",
        accountId: account.accountId,
        route: { agentId: route.agentId, sessionKey: route.sessionKey },
        ctxPayload,
        ...bindIngressLifecycleToReplyOptions(lifecycle),
        replyOptions: {
          onVisibleWorkSessions: (visible) => {
            sessions.push(...visible);
          },
        },
        delivery: {
          preparePayload: (payload, info) => (info.kind === "final" ? payload : null),
          observeMessageSent: true,
          deliver: async (payload) => {
            if (!payload.text?.trim() && !payload.mediaUrl && !payload.mediaUrls?.length) {
              return { visibleReplySent: false };
            }
            const sent = await sendXDelivery({
              cfg: readConfig(),
              accountId: account.accountId,
              to: `x:${post.id}`,
              text: payload.text ?? "",
              mediaUrl: payload.mediaUrl,
              mediaUrls: payload.mediaUrls,
              mention: post,
              visibleWorkSessions: sessions,
              signal: lifecycle.abortSignal,
            });
            ctx.setStatus({ ...ctx.getStatus(), lastOutboundAt: Date.now() });
            return { visibleReplySent: true, content: sent.content, receipt: sent.receipt };
          },
        },
      });
    },
    onError: () => {
      log.warn("X ingress failed; pending mentions will retry");
    },
    drain: {
      resolveNonRetryableFailure: (error) =>
        error instanceof InvalidXEvent ? { reason: "invalid-event", message: error.message } : null,
    },
  });
  ingress.start();
  ctx.setStatus({ ...ctx.getStatus(), running: true, lifecycle: "ready" });
  publish();
  try {
    await runXEvents({
      api,
      userId: account.userId,
      mode: account.config.events?.mode ?? "auto",
      pollSeconds: account.config.events?.pollSeconds ?? 60,
      bearerConfigured: Boolean(account.config.bearerToken),
      signal: ctx.abortSignal,
      onStatus: publish,
      getCursor: async () => (await cursor.lookup(account.accountId))?.sinceId,
      setCursor: async (sinceId) => {
        await cursor.register(
          account.accountId,
          { userId: account.userId, sinceId },
          { assertCurrent },
        );
      },
      onPost: async (post) => {
        await ingress.admit(post);
      },
    });
  } finally {
    await ingress.stop();
    ctx.setStatus({ ...ctx.getStatus(), running: false, connected: false, lifecycle: "stopped" });
  }
}
