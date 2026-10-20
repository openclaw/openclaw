import {
  createChannelInboundDebouncer,
  resolveInboundDebounceMs,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelRunQueue } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { Client } from "../internal/discord.js";
import type { DiscordIngressDispatchResult, DiscordIngressLifecycle } from "./ingress.js";
import type { DiscordMessageEvent } from "./listeners.js";
import { createDiscordLivePolicyReader, type DiscordLivePolicyReader } from "./live-policy.js";
import { createDiscordAvatarResolver } from "./message-avatar.js";
import { resolveDiscordMessageChannelId } from "./message-channel-info.js";
import {
  hasDiscordMessageStickers,
  resolveDiscordReferencedReplyMessageId,
} from "./message-forwarded.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import { resolveDiscordMessageText } from "./message-text.js";
import type { DiscordMonitorStatusSink } from "./status.js";

type DiscordMessageHandlerParams = Omit<
  DiscordMessagePreflightParams,
  "ackReactionScope" | "groupPolicy" | "data" | "client"
> & {
  readPolicy?: DiscordLivePolicyReader;
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
};

const loadMessagePreflightRuntime = createLazyRuntimeModule(
  () => import("./message-handler.preflight.js"),
);

const loadMessageProcessRuntime = createLazyRuntimeModule(
  () => import("./message-handler.process.js"),
);

type DiscordMessageDispatcher = (
  data: DiscordMessageEvent,
  client: Client,
  options?: { abortSignal?: AbortSignal; turnAdoptionLifecycle?: DiscordIngressLifecycle },
) => Promise<DiscordIngressDispatchResult | void>;

type DiscordMessageDispatcherWithLifecycle = DiscordMessageDispatcher & {
  deactivate: () => Promise<void>;
};

export function createDiscordMessageDispatcher(
  params: DiscordMessageHandlerParams,
): DiscordMessageDispatcherWithLifecycle {
  const readPolicy =
    params.readPolicy ??
    createDiscordLivePolicyReader({
      ...params,
      discordConfig: {
        ...params.discordConfig,
        dmPolicy: params.dmPolicy,
        allowFrom: params.allowFrom,
        guilds: params.guildEntries,
        dm: {
          ...params.discordConfig?.dm,
          enabled: params.dmEnabled,
          groupEnabled: params.groupDmEnabled,
          groupChannels: params.groupDmChannels,
        },
      },
      resolvedAllowlist: { guildEntries: params.guildEntries, allowFrom: params.allowFrom },
    });
  const readConfig = createRuntimeConfigReader(params.cfg);
  const skippedCleanup = new Set<() => Promise<void>>();
  const runQueue = createChannelRunQueue({
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
    onError: (error) => {
      params.runtime.error(danger(`discord message run failed: ${String(error)}`));
    },
  });
  let lifecycleActive = !params.abortSignal?.aborted;
  const pendingTasks = new Set<Promise<void>>();
  const onAbort = () => void cleanupSkippedQueuedMessages();

  async function cleanupSkippedQueuedMessages() {
    params.abortSignal?.removeEventListener("abort", onAbort);
    // These callbacks represent jobs accepted into the queue but not started.
    // Running jobs remove their callback before processDiscordMessage owns cleanup.
    if (!lifecycleActive && skippedCleanup.size === 0) {
      return;
    }
    lifecycleActive = false;
    const cleanups = [...skippedCleanup];
    skippedCleanup.clear();
    for (const cleanup of cleanups) {
      await cleanup();
    }
  }

  if (params.abortSignal?.aborted) {
    void cleanupSkippedQueuedMessages();
  } else {
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  }
  const dispatcherShutdown = new AbortController();
  const avatarResolver = createDiscordAvatarResolver();

  type DiscordDebounceEntry = {
    data: DiscordMessageEvent;
    client: Client;
    abortSignal?: AbortSignal;
    turnAdoptionLifecycle?: DiscordIngressLifecycle;
    debounceKey?: string;
  };
  const pendingDebounceEntries = new Set<DiscordDebounceEntry>();
  const pendingCancellationSettlements = new Set<Promise<void>>();
  const resolveDebounceKey = (entry: DiscordDebounceEntry) => {
    const message = entry.data.message;
    const authorId = entry.data.author?.id;
    if (!message || !authorId) {
      return null;
    }
    const channelId = resolveDiscordMessageChannelId({
      message,
      eventChannelId: entry.data.channel_id,
    });
    if (!channelId) {
      return null;
    }
    const replyTargetId = resolveDiscordReferencedReplyMessageId(message);
    return `discord:${params.accountId}:${channelId}:${authorId}:reply:${replyTargetId ?? "none"}`;
  };
  const { debouncer } = createChannelInboundDebouncer<DiscordDebounceEntry>({
    cfg: params.cfg,
    channel: "discord",
    resolveDebounceMs: () => resolveInboundDebounceMs({ cfg: readConfig(), channel: "discord" }),
    buildKey: resolveDebounceKey,
    shouldDebounce: (entry) => {
      const message = entry.data.message;
      if (!message) {
        return false;
      }
      const baseText = resolveDiscordMessageText(message, { includeForwarded: false });
      return shouldDebounceTextInbound({
        text: baseText,
        cfg: params.cfg,
        hasMedia:
          (message.attachments && message.attachments.length > 0) ||
          hasDiscordMessageStickers(message),
      });
    },
    onFlush: (entries, createFlush) => {
      const ingress = fanInChannelIngressLifecycles(
        entries.map((entry) => entry.turnAdoptionLifecycle),
      );
      return createFlush({
        lifecycle: ingress.lifecycle,
        dispatch: async (admissionLifecycle) => {
          for (const entry of entries) {
            pendingDebounceEntries.delete(entry);
          }
          const last = entries.at(-1);
          if (!last) {
            return;
          }
          const abortSignal = last.abortSignal;
          if (abortSignal?.aborted) {
            await ingress.cancel();
            return;
          }
          try {
            const policy = await readPolicy();
            const { cfg } = policy;
            const { preflightDiscordMessage } = await loadMessagePreflightRuntime();
            const ctx = await preflightDiscordMessage({
              ...params,
              ...policy,
              isPolicyCurrent: policy.isCurrent,
              avatarResolver,
              ackReactionScope:
                params.discordConfig?.ackReactionScope ??
                cfg.messages?.ackReactionScope ??
                "group-mentions",
              abortSignal,
              data: last.data,
              client: last.client,
              // Preflight hydrates each original before deriving mention facts
              // or rendering the batch, so neither text nor metadata is lost.
              precedingMessages: entries.slice(0, -1).map((entry) => entry.data.message),
              turnAdoptionLifecycle: admissionLifecycle,
            });
            if (abortSignal?.aborted) {
              await ingress.cancel();
              return;
            }
            if (!ctx) {
              await ingress.settle();
              return;
            }
            const { promise: pending, resolve: resolvePending } = createDeferred();
            pendingTasks.add(pending);
            const settlePending = () => {
              pendingTasks.delete(pending);
              resolvePending();
            };
            const cleanupSkipped = async () => {
              try {
                // A skipped job never reached reply-lane adoption; reopen its durable claim.
                await ingress.cancel();
              } catch (error) {
                // Durable release is best-effort during shutdown. One failed claim
                // must not strand the remaining accepted jobs or their pending tasks.
                try {
                  params.runtime.error(
                    danger(`discord queued message cleanup failed: ${String(error)}`),
                  );
                } catch {
                  // Error reporting must not interrupt the remaining cleanup owners.
                }
              } finally {
                settlePending();
              }
            };
            if (!lifecycleActive) {
              void cleanupSkipped();
              return;
            }
            skippedCleanup.add(cleanupSkipped);
            // Core reply admission owns session serialization. A transport event key
            // lets later Discord messages reach active-run steering while this run continues.
            runQueue.enqueue(ctx.message.id, async ({ lifecycleSignal }) => {
              // Once the task starts, normal process/commit handling owns cleanup.
              // Leaving it in skippedCleanup would double-release replay state.
              skippedCleanup.delete(cleanupSkipped);
              try {
                const processAbortSignal =
                  ctx.abortSignal && lifecycleSignal
                    ? AbortSignal.any([ctx.abortSignal, lifecycleSignal])
                    : (ctx.abortSignal ?? lifecycleSignal);
                try {
                  const { processDiscordMessage } = await loadMessageProcessRuntime();
                  await processDiscordMessage({ ...ctx, abortSignal: processAbortSignal });
                  if (processAbortSignal?.aborted) {
                    // Retain prior retry facts when cancellation ends ownership before delivery.
                    await ingress.cancel();
                  } else {
                    await ingress.settle();
                  }
                } catch (error) {
                  if (processAbortSignal?.aborted) {
                    await ingress.cancel();
                  } else {
                    await ingress.abandon(error);
                  }
                  throw error;
                }
              } finally {
                settlePending();
              }
            });
          } catch (error) {
            if (abortSignal?.aborted) {
              await ingress.cancel();
              return;
            }
            throw error;
          }
        },
      });
    },
    onError: (err) => {
      params.runtime.error(danger(`discord debounce flush failed: ${String(err)}`));
    },
    onCancel: (entries) => {
      for (const entry of entries) {
        pendingDebounceEntries.delete(entry);
        const settlement = fanInChannelIngressLifecycles([entry.turnAdoptionLifecycle])
          .cancel()
          .catch((error: unknown) => {
            params.runtime.error(
              danger(`discord ingress cancellation settlement failed: ${String(error)}`),
            );
          })
          .finally(() => {
            pendingCancellationSettlements.delete(settlement);
          });
        pendingCancellationSettlements.add(settlement);
      }
    },
  });

  const dispatchMessage = async (
    data: DiscordMessageEvent,
    client: Client,
    options?: { abortSignal?: AbortSignal; turnAdoptionLifecycle?: DiscordIngressLifecycle },
  ): Promise<DiscordIngressDispatchResult> => {
    try {
      if (dispatcherShutdown.signal.aborted || options?.abortSignal?.aborted) {
        // Shutdown/abort before dispatch must NOT complete: completing
        // tombstones a message that never ran, and a restarted drain would
        // skip it forever. Retryable releases the claim for replay.
        const reason = dispatcherShutdown.signal.aborted
          ? (dispatcherShutdown.signal.reason ?? new Error("discord dispatcher shut down"))
          : (options?.abortSignal?.reason ?? new Error("discord dispatch aborted"));
        if (options?.turnAdoptionLifecycle) {
          await fanInChannelIngressLifecycles([options.turnAdoptionLifecycle]).cancel();
          return { kind: "deferred" };
        }
        return { kind: "failed-retryable", error: reason };
      }
      // Filter bot-own messages before they enter the debounce queue.
      // The same check exists in preflightDiscordMessage(), but by that point
      // the message has already consumed debounce capacity and blocked
      // legitimate user messages. On active servers this causes cumulative
      // slowdown (see #15874).
      const msgAuthorId = data.message?.author?.id ?? data.author?.id;
      if (params.botUserId && msgAuthorId === params.botUserId) {
        return { kind: "completed" };
      }
      const abortSignal = options?.abortSignal
        ? AbortSignal.any([options.abortSignal, dispatcherShutdown.signal])
        : dispatcherShutdown.signal;
      const entry: DiscordDebounceEntry = {
        data,
        client,
        abortSignal,
        turnAdoptionLifecycle: options?.turnAdoptionLifecycle,
      };
      const debounceKey = resolveDebounceKey(entry);
      if (debounceKey) {
        entry.debounceKey = debounceKey;
        pendingDebounceEntries.add(entry);
      }
      await debouncer.enqueue(entry);
      return { kind: options?.turnAdoptionLifecycle ? "deferred" : "completed" };
    } catch (err) {
      params.runtime.error(danger(`handler failed: ${String(err)}`));
      if (options?.turnAdoptionLifecycle) {
        throw err;
      }
      return { kind: "completed" };
    }
  };

  const handler: DiscordMessageDispatcherWithLifecycle = (data, client, options) => {
    const result = dispatchMessage(data, client, options);
    return options?.turnAdoptionLifecycle ? result : result.then(() => undefined);
  };

  handler.deactivate = async () => {
    dispatcherShutdown.abort(new Error("discord-message-handler-deactivated"));
    const pendingKeys = new Set(
      [...pendingDebounceEntries]
        .map((entry) => entry.debounceKey)
        .filter((key) => key !== undefined),
    );
    for (const key of pendingKeys) {
      debouncer.cancelKey(key);
    }
    pendingDebounceEntries.clear();
    await Promise.allSettled(pendingCancellationSettlements);
    await debouncer.drain();
    runQueue.deactivate();
    await cleanupSkippedQueuedMessages();
    await Promise.allSettled(pendingTasks);
  };

  return handler;
}
