import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressError,
  createChannelIngressMonitor,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveXAccount, type ResolvedXAccount } from "./accounts.js";
import { openXAllowlist, XAllowlistChangedError } from "./allowlist.js";
import { parseXPostEnvelope, type XPostEnvelope } from "./api.js";
import { getXApi, getXTokenState } from "./client.js";
import { runXEvents, waitForXBudgetReset, type XCursorState, type XEventStatus } from "./events.js";
import {
  formatXSenderLine,
  resolveXGuestSettings,
  resolveXGuestToolPolicy,
} from "./guest-policy.js";
import { openXGuestUsage, XGuestUsageUnavailableError } from "./guest-usage.js";
import { getXGuestStatus, resolveXGuestContainmentError } from "./guests.js";
import { resolveXIngress, xMentionFacts } from "./ingress.js";
import { verifyPublicXThread } from "./public-thread.js";
import { resolveXRecipient } from "./recipient.js";
import type { XVisibleWorkSession } from "./reply.js";
import { getXRuntime } from "./runtime.js";
import { sendXDelivery } from "./send.js";
import { XBudgetExceededError } from "./spend.js";
import { assembleXThread } from "./thread.js";

const InvalidXEvent = createChannelIngressError("InvalidXEvent");
type IngressPayload = { version: number; rawEvent: string };
type Stats = XEventStatus & {
  droppedMentions: number;
  lastDroppedAuthor?: string;
  guestModeBlockedReason?: string;
  guests?: Awaited<ReturnType<typeof getXGuestStatus>>;
};

export async function startXAccount(ctx: ChannelGatewayContext<ResolvedXAccount>) {
  const core = getXRuntime();
  const account = ctx.account;
  const readConfig = createRuntimeConfigReader(ctx.cfg);
  const api = await getXApi(account.accountId, ctx.cfg);
  const log = core.logging.getChildLogger({ channel: "x", accountId: account.accountId });
  const stats: Stats = { droppedMentions: 0 };
  const guestUsage = openXGuestUsage(core);
  const publish = (next: Partial<Stats> = {}) => {
    if (next.message && next.message !== stats.message && !next.message.startsWith("X API ")) {
      log.info(next.message);
    }
    Object.assign(stats, next);
    ctx.setStatus({
      ...ctx.getStatus(),
      ...stats,
      ...(stats.guests
        ? {
            guests: {
              ...stats.guests,
              enabled: resolveXGuestSettings(resolveXAccount(readConfig(), account.accountId))
                .enabled,
            },
          }
        : {}),
      accountId: account.accountId,
      mode: stats.eventMode,
      connected: stats.eventMode === "poll" || stats.streamConnected,
      tokenStatus: getXTokenState(account.accountId),
      lastInboundAt: stats.lastEventAt,
    });
  };
  const cursor = core.state.openKeyedStore<XCursorState & { userId: string }>({
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
    inspect: ({ post }) => ({ eventId: post.id, laneKey: post.conversation_id }),
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
    deliver: async (envelope, lifecycle) => {
      let { post, users } = envelope;
      const dropMention = () => {
        publish({ droppedMentions: stats.droppedMentions + 1, lastDroppedAuthor: post.author_id });
        log.info(`mention post=${post.id} author=${post.author_id} dropped`);
      };
      let cfg = readConfig();
      let initialAuthorization = await resolveXIngress(account.accountId, post, cfg);
      const initial = initialAuthorization.ingress;
      if (post.author_id === account.userId || !initial.senderAccess.allowed) {
        dropMention();
        return;
      }
      if (envelope.recipientPending) {
        for (;;) {
          cfg = readConfig();
          initialAuthorization = await resolveXIngress(account.accountId, post, cfg);
          if (
            post.author_id === account.userId ||
            !initialAuthorization.ingress.senderAccess.allowed
          ) {
            dropMention();
            return;
          }
          try {
            const addressed = await resolveXRecipient({
              api,
              post,
              users,
              userId: account.userId,
              signal: lifecycle.abortSignal,
            });
            if (!addressed) {
              return;
            }
            ({ post, users } = addressed);
            break;
          } catch (error) {
            if (!(error instanceof XBudgetExceededError)) {
              throw error;
            }
            // Budget waits must not spend the queue's failure retries or lose its claim.
            const heartbeat = setInterval(
              () => lifecycle.onDeferredHeartbeat?.(),
              lifecycle.deferredHeartbeatIntervalMs ?? 60_000,
            );
            try {
              await waitForXBudgetReset(error.exhaustedUntil, lifecycle.abortSignal);
            } finally {
              clearInterval(heartbeat);
            }
          }
        }
      }
      const admitGuest = async (
        authorization: typeof initialAuthorization,
        currentCfg: typeof cfg,
      ) => {
        const guestAccount = resolveXAccount(currentCfg, account.accountId);
        const guestRoute = resolveAgentRoute({
          cfg: currentCfg,
          channel: "x",
          accountId: account.accountId,
          peer: { kind: "group", id: post.conversation_id },
        });
        const blocked = resolveXGuestContainmentError(currentCfg, guestRoute.agentId);
        const assertGuestCurrent = () => {
          assertCurrent();
          lifecycle.abortSignal.throwIfAborted();
          authorization.assertCurrent();
          if (currentCfg !== readConfig()) {
            throw new Error("X guest configuration changed during admission; retrying mention");
          }
        };
        let admitted = false;
        let blockedReason = blocked;
        if (!blockedReason) {
          try {
            admitted = await guestUsage.admit({
              accountId: account.accountId,
              authorId: post.author_id,
              postId: post.id,
              limit: resolveXGuestSettings(guestAccount).maxMentionsPerAuthorPerDay,
              assertCurrent: assertGuestCurrent,
            });
          } catch (error) {
            if (!(error instanceof XGuestUsageUnavailableError)) {
              throw error;
            }
            blockedReason = error.message;
          }
        }
        const guests = await getXGuestStatus(core, guestAccount, currentCfg, guestRoute.agentId);
        assertGuestCurrent();
        publish({
          guests,
          guestModeBlockedReason: blockedReason,
          ...(blockedReason ? { message: blockedReason } : {}),
          ...(!admitted
            ? { droppedMentions: stats.droppedMentions + 1, lastDroppedAuthor: post.author_id }
            : {}),
        });
        return admitted;
      };
      const initialSettings = resolveXGuestSettings(resolveXAccount(cfg, account.accountId));
      if (initialAuthorization.tier === "guest" && !(await admitGuest(initialAuthorization, cfg))) {
        return;
      }
      const thread = await assembleXThread({
        api,
        mention: post,
        users,
        maxPosts:
          initialAuthorization.tier === "guest"
            ? initialSettings.threadContextMaxPosts
            : (resolveXAccount(cfg, account.accountId).config.threadContext?.maxPosts ?? 50),
        signal: lifecycle.abortSignal,
      });
      cfg = readConfig();
      const route = resolveAgentRoute({
        cfg,
        channel: "x",
        accountId: account.accountId,
        peer: { kind: "group", id: post.conversation_id },
      });
      // Guest mentions never reuse a maintainer's session permissions, root, or skill state.
      const sessionKey =
        initialAuthorization.tier === "guest"
          ? `${route.sessionKey}:guest:${post.id}`
          : route.sessionKey;
      // Guests may start hidden helpers, never public visible work sessions.
      const publicationSnapshot =
        initialAuthorization.tier === "maintainer" &&
        resolveXAccount(cfg, account.accountId).config.autoPublishWorkSessions === true
          ? await openXAllowlist(core).readSnapshot(
              account.accountId,
              resolveXAccount(cfg, account.accountId).config.verifiedFromGitHub,
            )
          : undefined;
      const publicThread =
        publicationSnapshot &&
        (await verifyPublicXThread(api, thread.posts, lifecycle.abortSignal, post.conversation_id));
      const publication =
        publicationSnapshot && publicThread
          ? {
              audience: "public" as const,
              assertCurrent: () => {
                lifecycle.abortSignal.throwIfAborted();
                assertCurrent();
                publicationSnapshot.assertCurrent();
                // Any config publication retires the captured routing/access decision.
                if (readConfig() !== cfg) {
                  throw new Error("X work-session publication policy changed; send a new mention.");
                }
              },
            }
          : undefined;
      const authorization = await resolveXIngress(
        account.accountId,
        post,
        cfg,
        {
          agentId: route.agentId,
          sessionKey,
          messageId: post.id,
          inboundEventKind: "user_request",
        },
        publication,
      );
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
        dropMention();
        return;
      }
      if (
        authorization.tier !== initialAuthorization.tier ||
        (authorization.tier === "guest" &&
          initialSettings.threadContextMaxPosts !==
            resolveXGuestSettings(resolveXAccount(cfg, account.accountId)).threadContextMaxPosts)
      ) {
        throw new XAllowlistChangedError();
      }
      const guest = authorization.tier === "guest";
      if (guest && !(await admitGuest(authorization, cfg))) {
        return;
      }
      const handle =
        thread.users.find((user) => user.id === post.author_id)?.username ?? post.author_id;
      const ctxPayload = core.channel.inbound.buildContext({
        channelIngress,
        access: {
          mentions: { ...xMentionFacts, requireMention: true, explicitlyMentionedBot: true },
          ...(guest
            ? { toolPolicy: resolveXGuestToolPolicy(resolveXAccount(cfg, account.accountId)) }
            : {}),
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
        },
        route: {
          agentId: route.agentId,
          accountId: route.accountId,
          routeSessionKey: sessionKey,
        },
        reply: { to: `x:${post.id}`, replyToId: post.id },
        message: {
          body: post.text,
          rawBody: post.text,
          commandBody: post.text,
          bodyForAgent: `${formatXSenderLine(
            authorization.tier,
            post.author_id,
            thread.users.find((user) => user.id === post.author_id),
            authorization.github,
          )}\n${thread.bodyForAgent}`,
        },
      });
      const sessions: XVisibleWorkSession[] = [];
      log.info(`mention post=${post.id} author=${post.author_id} allowed`);
      assertAdmissionCurrent();
      await core.channel.inbound.dispatch({
        cfg,
        channel: "x",
        accountId: account.accountId,
        route: { agentId: route.agentId, sessionKey },
        ctxPayload,
        ...bindIngressLifecycleToReplyOptions(lifecycle),
        replyOptions: {
          onVisibleWorkSessions: (visible) => {
            if (!guest) {
              sessions.push(...visible);
            }
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
              visibleWorkSessions: guest ? undefined : sessions,
              senderTier: authorization.tier,
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
  const startupConfig = readConfig();
  stats.guests = await getXGuestStatus(
    core,
    resolveXAccount(startupConfig, account.accountId),
    startupConfig,
  );
  ingress.start();
  ctx.setStatus({ ...ctx.getStatus(), running: true, lifecycle: "ready" });
  publish();
  let stopped = false;
  const publishSpend = async () => {
    try {
      const spend = await api.spend.status();
      if (!stopped) {
        publish({ spend });
      }
    } catch {
      if (!stopped) {
        publish({ message: "X spend accounting unavailable; paid requests paused" });
      }
    }
  };
  const unsubscribeSpend = api.spend.subscribe(() => {
    void publishSpend();
  });
  try {
    await publishSpend();
    await runXEvents({
      api,
      userId: account.userId,
      mode: account.config.events?.mode ?? "auto",
      pollSeconds: account.config.events?.pollSeconds ?? 60,
      bearerConfigured: Boolean(account.config.bearerToken),
      signal: ctx.abortSignal,
      onStatus: publish,
      onWarning: (message) => log.warn(message),
      getCursor: async () => (await cursor.lookup(account.accountId)) ?? {},
      setCursor: async (next) => {
        await cursor.register(
          account.accountId,
          { ...next, userId: account.userId },
          { assertCurrent },
        );
      },
      onPost: async (post) => {
        await ingress.admit(post);
      },
    });
  } finally {
    stopped = true;
    unsubscribeSpend();
    await ingress.stop();
    ctx.setStatus({ ...ctx.getStatus(), running: false, connected: false, lifecycle: "stopped" });
  }
}
