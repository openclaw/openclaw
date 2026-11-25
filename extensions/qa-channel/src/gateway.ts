import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { pollQaBus } from "./bus-client.js";
import { handleQaInbound } from "./inbound.js";
import type { CoreConfig, ResolvedQaChannelAccount } from "./types.js";

export async function startQaGatewayAccount(
  channelId: string,
  channelLabel: string,
  ctx: ChannelGatewayContext<ResolvedQaChannelAccount>,
) {
  const account = ctx.account;
  const channelRuntime = ctx.channelRuntime as PluginRuntime["channel"] | undefined;
  const buildContext = channelRuntime?.inbound.buildContext ?? buildChannelInboundEventContext;
  if (!account.configured) {
    throw new Error(`QA channel is not configured for account "${account.accountId}"`);
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    lifecycle: "starting",
    configured: true,
    enabled: account.enabled,
    baseUrl: account.baseUrl,
  });
  let cursor = 0;
  let queuedCursor = 0;
  let acknowledgementStopped = false;
  let ready = false;
  let inboundError: Error | undefined;
  let queuedInbound = Promise.resolve();
  let queuedAcknowledgements = Promise.resolve();
  const inboundAbort = new AbortController();
  const inboundTasks = new Set<Promise<void>>();
  type PendingEvent = {
    cursor: number;
    state: "pending" | "adopted" | "abandoned";
  };
  const adoptedEventCursors = new Set<number>();
  const completedEventCursors = new Set<number>();
  const captureInboundError = (error: unknown) => {
    inboundError ??= error instanceof Error ? error : new Error(String(error));
    // Fatal account failure must retire retained followups before joining them.
    // Ordinary external shutdown still drains their full delivery lifetime.
    inboundAbort.abort(inboundError);
  };
  const flushAcknowledgements = () => {
    const flush = queuedAcknowledgements.then(async () => {
      if (acknowledgementStopped) {
        throw inboundError ?? new Error("QA channel acknowledgement owner stopped");
      }
      const adopted = [...adoptedEventCursors];
      const completed = [...completedEventCursors];
      if (adopted.length === 0 && completed.length === 0) {
        return;
      }
      // Adoption must confirm transport custody before execution can continue.
      // Only the main poll consumes events; this response cannot advance fetch progress.
      await pollQaBus({
        baseUrl: account.baseUrl,
        accountId: account.accountId,
        cursor,
        adoptedEventCursors: adopted,
        completedEventCursors: completed,
        timeoutMs: 0,
      });
      for (const eventCursor of adopted) {
        adoptedEventCursors.delete(eventCursor);
      }
      for (const eventCursor of completed) {
        completedEventCursors.delete(eventCursor);
      }
    });
    queuedAcknowledgements = flush.catch((error: unknown) => {
      acknowledgementStopped = true;
      captureInboundError(error);
    });
    return flush;
  };
  const handleMessage = async (
    message: Parameters<typeof handleQaInbound>[0]["message"],
    event: PendingEvent,
    onFollowupQueued?: () => void,
  ) => {
    await handleQaInbound({
      channelId,
      channelLabel,
      account,
      config: ctx.cfg as CoreConfig,
      message,
      buildContext,
      ...(channelRuntime ? { channelRuntime } : {}),
      onFollowupQueued,
      // Keep QA collect batching; core awaits adoption for every collected source.
      turnAdoptionLifecycle: {
        abortSignal: inboundAbort.signal,
        onAdopted: async () => {
          if (acknowledgementStopped || event.state === "abandoned") {
            throw inboundError ?? new Error("QA input adoption is no longer available");
          }
          event.state = "adopted";
          adoptedEventCursors.add(event.cursor);
          // Native controls can overtake an unadopted input. Confirm this
          // exact input before execution without waiting for its predecessor.
          await flushAcknowledgements();
        },
        onAbandoned: () => {
          if (event.state !== "adopted") {
            event.state = "abandoned";
            captureInboundError(new Error("QA input abandoned before adoption"));
          }
        },
      },
    });
    // Policy refusals and terminal no-turn handlers still consume their event.
    // handleQaInbound also joins deferred delivery and preview cleanup.
    if (event.state === "pending" || event.state === "adopted") {
      event.state = "adopted";
      completedEventCursors.add(event.cursor);
      await flushAcknowledgements();
    }
  };
  const startMessage = (
    message: Parameters<typeof handleQaInbound>[0]["message"],
    event: PendingEvent,
    onFollowupQueued?: () => void,
  ) => {
    const task = handleMessage(message, event, onFollowupQueued)
      .catch(captureInboundError)
      .finally(() => inboundTasks.delete(task));
    inboundTasks.add(task);
    return task;
  };
  const enqueueInbound = (
    message: Parameters<typeof handleQaInbound>[0]["message"],
    event: PendingEvent,
  ) => {
    queuedInbound = queuedInbound
      .then(async () => {
        if (inboundError) {
          return;
        }
        const followupQueued = createDeferred();
        const task = startMessage(message, event, followupQueued.resolve);
        // Confirmed followups release intake for collect batching while their
        // full tasks retain delivery, completion receipts and shutdown custody.
        await Promise.race([followupQueued.promise, task]);
      })
      .catch(captureInboundError);
  };
  try {
    while (!ctx.abortSignal.aborted) {
      if (inboundError) {
        throw inboundError;
      }
      const result = await pollQaBus({
        baseUrl: account.baseUrl,
        accountId: account.accountId,
        cursor,
        timeoutMs: account.pollTimeoutMs,
        signal: ctx.abortSignal,
      });
      if (!ready) {
        ready = true;
        ctx.setStatus(channelReadyPatch({ accountId: account.accountId }));
      }
      cursor = result.cursor;
      for (const event of result.events) {
        if (event.cursor <= queuedCursor) {
          continue;
        }
        queuedCursor = event.cursor;
        if (event.kind !== "inbound-message") {
          continue;
        }
        const acknowledgement: PendingEvent = { cursor: event.cursor, state: "pending" };
        if (event.message.nativeCommand) {
          void startMessage(event.message, acknowledgement);
        } else {
          enqueueInbound(event.message, acknowledgement);
        }
      }
      queuedCursor = Math.max(queuedCursor, cursor);
    }
    if (inboundError) {
      throw inboundError;
    }
  } catch (error) {
    if (
      !(error instanceof Error && error.name === "AbortError" && ctx.abortSignal.aborted) ||
      inboundError
    ) {
      captureInboundError(error);
      ctx.setStatus({
        accountId: account.accountId,
        connected: false,
        lifecycle: "recovering",
        lastError: inboundError!.message,
      });
    }
  } finally {
    try {
      // Intake can start more full tasks while draining. Snapshot only afterward.
      await queuedInbound;
      await Promise.all(inboundTasks);
      // Join started writes and flush completed handlers without the cancelled
      // poll signal. Only successful handlers publish exact completion receipts.
      await flushAcknowledgements();
    } catch (error) {
      captureInboundError(error);
    } finally {
      acknowledgementStopped = true;
      ctx.setStatus(channelStoppedPatch({ accountId: account.accountId }));
    }
  }
  if (inboundError) {
    throw inboundError;
  }
}
