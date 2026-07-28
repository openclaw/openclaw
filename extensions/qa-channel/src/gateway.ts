// Qa Channel plugin module implements gateway behavior.
import { pollQaBus } from "./bus-client.js";
import { handleQaInbound } from "./inbound.js";
import type { ChannelGatewayContext } from "./runtime-api.js";
import type { CoreConfig, ResolvedQaChannelAccount } from "./types.js";

export async function startQaGatewayAccount(
  channelId: string,
  channelLabel: string,
  ctx: ChannelGatewayContext<ResolvedQaChannelAccount>,
) {
  const account = ctx.account;
  if (!account.configured) {
    throw new Error(`QA channel is not configured for account "${account.accountId}"`);
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    configured: true,
    enabled: account.enabled,
    baseUrl: account.baseUrl,
  });
  let cursor = 0;
  let acknowledgedCursor = 0;
  let committedAcknowledgedCursor = 0;
  let queuedAcknowledgedCursor = 0;
  let supportsAcknowledgedCursor = false;
  let acknowledgementStopped = false;
  let inboundError: Error | undefined;
  let queuedInbound = Promise.resolve();
  let queuedAcknowledgements = Promise.resolve();
  const controlTasks = new Set<Promise<boolean>>();
  const handleMessage = (message: Parameters<typeof handleQaInbound>[0]["message"]) =>
    handleQaInbound({
      channelId,
      channelLabel,
      account,
      config: ctx.cfg as CoreConfig,
      message,
    });
  const captureInboundError = (error: unknown) => {
    inboundError ??= error instanceof Error ? error : new Error(String(error));
  };
  const dispatchControl = (message: Parameters<typeof handleQaInbound>[0]["message"]) => {
    const task = handleMessage(message)
      .then(
        () => true,
        (error: unknown) => {
          captureInboundError(error);
          return false;
        },
      )
      .finally(() => controlTasks.delete(task));
    controlTasks.add(task);
    return task;
  };
  const enqueueInbound = (message: Parameters<typeof handleQaInbound>[0]["message"]) => {
    let handled = false;
    queuedInbound = queuedInbound
      .then(async () => {
        if (inboundError) {
          return;
        }
        await handleMessage(message);
        handled = true;
      })
      .catch(captureInboundError);
    return queuedInbound.then(() => handled);
  };
  const acknowledgeProcessedEvent = (eventCursor: number, task?: Promise<boolean>) => {
    if (eventCursor <= queuedAcknowledgedCursor) {
      return;
    }
    // Empty long-polls repeat their cursor while dispatch is blocked. Enqueue
    // each event only once so stalled handlers cannot grow the promise chain.
    queuedAcknowledgedCursor = eventCursor;
    // Poll ahead so native controls bypass blocked messages, but commit only
    // the successfully dispatched prefix for crash-safe gateway restarts.
    queuedAcknowledgements = queuedAcknowledgements
      .then(async () => {
        if (acknowledgementStopped) {
          return;
        }
        if (task && !(await task)) {
          acknowledgementStopped = true;
          return;
        }
        if (eventCursor > acknowledgedCursor) {
          acknowledgedCursor = eventCursor;
        }
      })
      .catch((error: unknown) => {
        acknowledgementStopped = true;
        captureInboundError(error);
      });
  };
  try {
    while (!ctx.abortSignal.aborted) {
      if (inboundError) {
        throw inboundError;
      }
      const pollAcknowledgedCursor = acknowledgedCursor;
      const result = await pollQaBus({
        baseUrl: account.baseUrl,
        accountId: account.accountId,
        cursor,
        acknowledgedCursor: pollAcknowledgedCursor,
        timeoutMs: account.pollTimeoutMs,
        signal: ctx.abortSignal,
      });
      supportsAcknowledgedCursor ||= result.supportsAcknowledgedCursor === true;
      committedAcknowledgedCursor = Math.max(committedAcknowledgedCursor, pollAcknowledgedCursor);
      cursor = result.cursor;
      for (const event of result.events) {
        if (event.kind !== "inbound-message") {
          acknowledgeProcessedEvent(event.cursor);
          continue;
        }
        if (event.message.nativeCommand) {
          acknowledgeProcessedEvent(event.cursor, dispatchControl(event.message));
        } else {
          acknowledgeProcessedEvent(event.cursor, enqueueInbound(event.message));
        }
      }
      acknowledgeProcessedEvent(cursor);
      if (!supportsAcknowledgedCursor) {
        // Older private buses acknowledge the requested cursor implicitly;
        // never poll ahead until processed-prefix support is advertised.
        await Promise.all([queuedInbound, queuedAcknowledgements, ...controlTasks]);
      }
    }
    if (inboundError) {
      throw inboundError;
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      throw error;
    }
  } finally {
    try {
      await Promise.all([queuedInbound, queuedAcknowledgements, ...controlTasks]);
      if (acknowledgedCursor > committedAcknowledgedCursor) {
        // An aborted in-flight poll cannot carry the final successful prefix;
        // flush it without the cancelled gateway signal before releasing state.
        await pollQaBus({
          baseUrl: account.baseUrl,
          accountId: account.accountId,
          cursor: supportsAcknowledgedCursor ? cursor : acknowledgedCursor,
          acknowledgedCursor,
          timeoutMs: 0,
        });
      }
    } catch (error) {
      captureInboundError(error);
    } finally {
      ctx.setStatus({
        accountId: account.accountId,
        running: false,
      });
    }
  }
  if (inboundError) {
    throw inboundError;
  }
}
