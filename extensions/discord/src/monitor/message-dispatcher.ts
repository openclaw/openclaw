// Discord plugin module dispatches inbound messages into the processing queue.
import {
  createChannelInboundDebouncer,
  resolveInboundDebounceMs,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { Client } from "../internal/discord.js";
import { buildDiscordInboundJob } from "./inbound-job.js";
import type {
  createDiscordIngressMonitor,
  DiscordIngressDispatchResult,
  DiscordIngressLifecycle,
} from "./ingress.js";
import type { DiscordMessageEvent } from "./listeners.js";
import { createDiscordLivePolicyReader, type DiscordLivePolicyReader } from "./live-policy.js";
import { createDiscordAvatarResolver } from "./message-avatar.js";
import { resolveDiscordMessageChannelId } from "./message-channel-info.js";
import {
  hasDiscordMessageStickers,
  resolveDiscordReferencedReplyMessageId,
} from "./message-forwarded.js";
import { applyImplicitReplyBatchGate } from "./message-handler.batch-gate.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import {
  createDiscordMessageRunQueue,
  type DiscordMessageRunQueueTestingHooks,
} from "./message-run-queue.js";
import { resolveDiscordMessageText } from "./message-text.js";
import type { DiscordMonitorStatusSink } from "./status.js";

type PreflightDiscordMessage =
  typeof import("./message-handler.preflight.js").preflightDiscordMessage;

type DiscordMessageHandlerParams = Omit<
  DiscordMessagePreflightParams,
  "ackReactionScope" | "groupPolicy" | "data" | "client"
> & {
  readPolicy?: DiscordLivePolicyReader;
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  testing?: DiscordMessageHandlerTestingHooks;
};

type DiscordMessageHandlerTestingHooks = DiscordMessageRunQueueTestingHooks & {
  preflightDiscordMessage?: PreflightDiscordMessage;
  createIngressMonitor?: typeof createDiscordIngressMonitor;
};

const loadMessagePreflightRuntime = createLazyRuntimeModule(
  () => import("./message-handler.preflight.js"),
);

type DiscordMessageDispatcher = (
  data: DiscordMessageEvent,
  client: Client,
  options?: { abortSignal?: AbortSignal; turnAdoptionLifecycle?: DiscordIngressLifecycle },
) => Promise<DiscordIngressDispatchResult | void>;

type DiscordMessageDispatcherWithLifecycle = DiscordMessageDispatcher & {
  deactivate: () => Promise<void>;
};

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

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
  const preflightDiscordMessageImpl = params.testing?.preflightDiscordMessage;
  const messageRunQueue = createDiscordMessageRunQueue({
    runtime: params.runtime,
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
    testing: params.testing,
  });
  const dispatcherShutdown = new AbortController();
  const avatarResolver = createDiscordAvatarResolver();

  type DiscordDebounceEntry = {
    data: DiscordMessageEvent;
    client: Client;
    abortSignal?: AbortSignal;
    turnAdoptionLifecycle?: DiscordIngressLifecycle;
    debounceKey?: string;
    laneKey?: string;
    laneTracked?: boolean;
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
  // The ingress monitor's admission lane is per channel (`channel:<channelId>`,
  // see ingress.ts), coarser than the debounce key above, which also splits on
  // author and reply target. Track it separately so a sender/reply-target
  // change can be detected within one channel.
  const resolveLaneKey = (entry: DiscordDebounceEntry) => {
    const message = entry.data.message;
    if (!message) {
      return null;
    }
    const channelId = resolveDiscordMessageChannelId({
      message,
      eventChannelId: entry.data.channel_id,
    });
    return channelId ? `discord:${params.accountId}:${channelId}` : null;
  };
  const shouldDebounceEntry = (entry: DiscordDebounceEntry) => {
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
  };
  // Reference-counted per-lane record of which debounce key currently holds
  // the lane's pending batch, mirroring the cross-sender flush guard in
  // extensions/whatsapp/src/inbound/message-debounce.ts. Releasing the
  // per-channel ingress lane on defer (deferredLaneOccupancy: "release" in
  // ingress.ts) lets independent author/reply-target debounce keys admit and
  // flush concurrently; without this guard a later-arriving key can flush
  // ahead of an earlier one still merging, inverting conversation order.
  const pendingLaneKeys = new Map<
    string,
    { count: number; batchKey: string; admission?: Promise<void> }
  >();
  const trackLane = (laneKey: string, batchKey: string) => {
    pendingLaneKeys.set(laneKey, {
      count: (pendingLaneKeys.get(laneKey)?.count ?? 0) + 1,
      batchKey,
    });
  };
  // Record that a lane's tracked batch has started flushing, so a
  // different-key arrival can await this flush's admission directly instead
  // of calling debouncer.flushKey — which is a no-op once the batch has left
  // the debouncer's own pending-buffer map, letting the arrival through
  // before the earlier batch is actually admitted.
  const markLaneFlushing = (laneKey: string, batchKey: string, admission: Promise<void>) => {
    const pending = pendingLaneKeys.get(laneKey);
    if (pending && pending.batchKey === batchKey) {
      pending.admission = admission;
    }
  };
  const releaseLane = (entry: DiscordDebounceEntry) => {
    if (!entry.laneKey || entry.laneTracked !== true) {
      return;
    }
    const pending = pendingLaneKeys.get(entry.laneKey);
    if (pending && pending.count > 1) {
      pending.count -= 1;
    } else {
      pendingLaneKeys.delete(entry.laneKey);
    }
  };
  const { debouncer } = createChannelInboundDebouncer<DiscordDebounceEntry>({
    cfg: params.cfg,
    channel: "discord",
    resolveDebounceMs: () => resolveInboundDebounceMs({ cfg: readConfig(), channel: "discord" }),
    buildKey: resolveDebounceKey,
    shouldDebounce: shouldDebounceEntry,
    onFlush: (entries, createFlush) => {
      // Only a lane-tracked entry (debounceMs > 0, ordinary batching) ever
      // holds a pendingLaneKeys record; release those synchronously here as
      // before so an untracked flush (debounceMs === 0) never pays an extra
      // microtask tick on its admission path, which upstream retry/backoff
      // logic can be timing-sensitive to.
      const trackedEntries = entries.filter((entry) => entry.laneTracked === true);
      for (const entry of entries) {
        if (entry.laneTracked !== true) {
          releaseLane(entry);
        }
      }
      const ingress = fanInChannelIngressLifecycles(
        entries.map((entry) => entry.turnAdoptionLifecycle),
      );
      const flush = createFlush({
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
            const preflight =
              preflightDiscordMessageImpl ??
              (await loadMessagePreflightRuntime()).preflightDiscordMessage;
            const ctx = await preflight({
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
            applyImplicitReplyBatchGate(ctx, params.replyToMode, entries.length > 1);
            const ids = entries.map((entry) => entry.data.message?.id).filter(isNonEmptyString);
            if (entries.length > 1 && ids.length > 0) {
              const ctxBatch = ctx as typeof ctx & {
                MessageSids?: string[];
                MessageSidFirst?: string;
                MessageSidLast?: string;
              };
              ctxBatch.MessageSids = ids;
              ctxBatch.MessageSidFirst = ids[0];
              ctxBatch.MessageSidLast = ids[ids.length - 1];
            }
            messageRunQueue.enqueue(buildDiscordInboundJob(ctx, { ingressSettlement: ingress }));
          } catch (error) {
            if (abortSignal?.aborted) {
              await ingress.cancel();
              return;
            }
            throw error;
          }
        },
      });
      // Hold the lane record until this flush is actually admitted, not
      // merely started: onFlush firing only means the timer elapsed, while
      // admission (onAdopted/onDeferred/onFailed, or completion for gated
      // dispatch) is when the earlier batch has genuinely cleared the lane.
      // Mark the flush's admission on the lane record so a different-key
      // arrival in dispatchMessage can await it directly, and release the
      // lane only once it settles.
      if (trackedEntries.length > 0) {
        for (const entry of trackedEntries) {
          if (entry.laneKey && entry.debounceKey) {
            markLaneFlushing(entry.laneKey, entry.debounceKey, flush.admission);
          }
        }
        void flush.admission.finally(() => {
          for (const entry of trackedEntries) {
            releaseLane(entry);
          }
        });
      }
      return flush;
    },
    onError: (err) => {
      params.runtime.error(danger(`discord debounce flush failed: ${String(err)}`));
    },
    onCancel: (entries) => {
      for (const entry of entries) {
        pendingDebounceEntries.delete(entry);
        releaseLane(entry);
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
        const laneKey = resolveLaneKey(entry);
        if (laneKey) {
          entry.laneKey = laneKey;
          const pendingLane = pendingLaneKeys.get(laneKey);
          // One channel lane orders admission; a sender/reply-target change
          // ends the current batch so a later-arriving key cannot flush
          // ahead of an earlier one still merging in the same channel.
          if (pendingLane && pendingLane.batchKey !== debounceKey) {
            // Once the pending batch has started flushing, its buffer is
            // already gone from the debouncer's own map, so flushKey would be
            // a no-op; await the flush's admission directly in that case.
            // Otherwise force the still-buffered batch to flush now (which
            // itself waits for admission) instead of its full debounce delay.
            await (pendingLane.admission ?? debouncer.flushKey(pendingLane.batchKey));
            // Deactivation can land while this await is pending, before the
            // new key has a buffer for cancelKey to remove. Recheck here so a
            // torn-down dispatcher does not enqueue work after shutdown.
            if (abortSignal.aborted) {
              pendingDebounceEntries.delete(entry);
              if (options?.turnAdoptionLifecycle) {
                await fanInChannelIngressLifecycles([options.turnAdoptionLifecycle]).cancel();
                return { kind: "deferred" };
              }
              return {
                kind: "failed-retryable",
                error: abortSignal.reason ?? new Error("discord dispatch aborted"),
              };
            }
          }
          const debounceMsNow = resolveInboundDebounceMs({ cfg: readConfig(), channel: "discord" });
          if (debounceMsNow > 0 && shouldDebounceEntry(entry)) {
            entry.laneTracked = true;
            trackLane(laneKey, debounceKey);
          }
        }
      }
      await debouncer.enqueue(entry);
      if (options?.turnAdoptionLifecycle) {
        return { kind: "deferred" };
      }
      return { kind: "completed" };
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
    await messageRunQueue.deactivate();
  };

  return handler;
}
