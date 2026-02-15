import type {
  EmbeddedPiSubscribeContext,
  EmbeddedPiSubscribeEvent,
} from "./pi-embedded-subscribe.handlers.types.js";
import {
  handleAgentEnd,
  handleAgentStart,
  handleAutoCompactionEnd,
  handleAutoCompactionStart,
} from "./pi-embedded-subscribe.handlers.lifecycle.js";
import {
  handleMessageEnd,
  handleMessageStart,
  handleMessageUpdate,
} from "./pi-embedded-subscribe.handlers.messages.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
  handleToolExecutionUpdate,
} from "./pi-embedded-subscribe.handlers.tools.js";

/**
 * Single dispatch function for all event types. Returns a Promise only for
 * tool_execution_start (which may await the coalescer flush). All other
 * handlers are synchronous or fire-and-forget.
 *
 * To add a new event type: add a case here. If the handler is async and
 * needs to block subsequent events, return its promise (like
 * tool_execution_start). Otherwise keep it fire-and-forget or sync.
 */
function dispatchEvent(
  ctx: EmbeddedPiSubscribeContext,
  evt: EmbeddedPiSubscribeEvent,
): Promise<void> | void {
  switch (evt.type) {
    case "tool_execution_start":
      // Returns promise — may await onBlockReplyFlush.
      return handleToolExecutionStart(ctx, evt as never);
    case "tool_execution_end":
      // Fire-and-forget — after_tool_call hooks don't block subsequent events.
      handleToolExecutionEnd(ctx, evt as never).catch((err) => {
        ctx.log.debug(`tool_execution_end handler failed: ${String(err)}`);
      });
      return;
    case "message_start":
      handleMessageStart(ctx, evt as never);
      return;
    case "message_update":
      handleMessageUpdate(ctx, evt as never);
      return;
    case "message_end":
      handleMessageEnd(ctx, evt as never);
      return;
    case "tool_execution_update":
      handleToolExecutionUpdate(ctx, evt as never);
      return;
    case "agent_start":
      handleAgentStart(ctx);
      return;
    case "auto_compaction_start":
      handleAutoCompactionStart(ctx);
      return;
    case "auto_compaction_end":
      handleAutoCompactionEnd(ctx, evt as never);
      return;
    case "agent_end":
      handleAgentEnd(ctx);
      return;
  }
}

/**
 * Creates an event handler that serializes processing around async handlers.
 *
 * ## Design
 *
 * Two execution modes, selected per-event:
 *
 * - **Direct** (pendingCount === 0, no flush needed): calls dispatchEvent
 *   immediately. Sync handlers run synchronously; async handlers
 *   (tool_execution_start without a flush callback, tool_execution_end) are
 *   fire-and-forget. This is the original behavior and avoids microtask
 *   overhead.
 *
 * - **Chain** (tool_execution_start with onBlockReplyFlush, or any event
 *   while the chain is draining): events are queued on a promise chain.
 *   tool_execution_start is awaited so the flush completes before subsequent
 *   events (e.g. message_update with post-tool text) are processed.
 *
 * ## Invariants
 *
 * - `pendingCount` tracks items on the chain. Incremented synchronously when
 * - `pendingCount` tracks items on the chain. Incremented synchronously when
 * - When `pendingCount` returns to 0, subsequent events take the direct path.
 * - The handler always returns `void` — subscription contract unchanged.
 */
export function createEmbeddedPiSessionEventHandler(ctx: EmbeddedPiSubscribeContext) {
  let chain: Promise<void> = Promise.resolve();
  let pendingCount = 0;

  return (evt: EmbeddedPiSubscribeEvent) => {
    const needsChain =
      pendingCount > 0 || (evt.type === "tool_execution_start" && !!ctx.params.onBlockReplyFlush);

    if (!needsChain) {
      try {
        const result = dispatchEvent(ctx, evt);
        // Fire-and-forget for tool_execution_start without flush callback.
        if (result instanceof Promise) {
          result.catch((err) => {
            ctx.log.debug(`${evt.type} handler failed: ${String(err)}`);
          });
        }
      } catch (err) {
        ctx.log.debug(`event handler failed: type=${evt.type} error=${String(err)}`);
      }
      return;
    }

    pendingCount++;
    chain = chain.then(async () => {
      try {
        const result = dispatchEvent(ctx, evt);
        // Only await promises (tool_execution_start) — this is what blocks
        // subsequent events until the coalescer flush completes.
        if (result instanceof Promise) {
          await result;
        }
      } catch (err) {
        ctx.log.debug(`event handler failed: type=${evt.type} error=${String(err)}`);
      } finally {
        pendingCount--;
      }
    });
  };
}
