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

function dispatchSync(ctx: EmbeddedPiSubscribeContext, evt: EmbeddedPiSubscribeEvent): void {
  switch (evt.type) {
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

export function createEmbeddedPiSessionEventHandler(ctx: EmbeddedPiSubscribeContext) {
  let chain: Promise<void> = Promise.resolve();
  let pendingCount = 0;

  return (evt: EmbeddedPiSubscribeEvent) => {
    // Serialization through the promise chain is only needed when
    // onBlockReplyFlush is provided (meaning there's an async flush to await
    // in handleToolExecutionStart). Without it, use the original fire-and-forget
    // dispatch to avoid unnecessary microtask delays.
    const needsChain =
      pendingCount > 0 || (evt.type === "tool_execution_start" && !!ctx.params.onBlockReplyFlush);

    if (!needsChain) {
      switch (evt.type) {
        case "tool_execution_start":
        case "tool_execution_end":
          // Async handlers — fire-and-forget (original behavior).
          (evt.type === "tool_execution_start"
            ? handleToolExecutionStart(ctx, evt as never)
            : handleToolExecutionEnd(ctx, evt as never)
          ).catch((err) => {
            ctx.log.debug(`${evt.type} handler failed: ${String(err)}`);
          });
          return;
        default:
          try {
            dispatchSync(ctx, evt);
          } catch (err) {
            ctx.log.debug(`event handler failed: type=${evt.type} error=${String(err)}`);
          }
          return;
      }
    }

    // tool_execution_start (with flush callback), or any event arriving while
    // tool_execution_start is in-flight, is serialized through the promise chain.
    // This ensures the coalescer flush completes before subsequent message_update
    // events are processed.
    //
    // pendingCount is managed inside the .then callback (not .finally) so it
    // decrements synchronously when the handler finishes, allowing subsequent
    // events to take the fast path immediately.
    pendingCount++;
    chain = chain.then(async () => {
      try {
        switch (evt.type) {
          case "tool_execution_start":
            await handleToolExecutionStart(ctx, evt as never);
            return;
          case "tool_execution_end":
            // Fire-and-forget within the chain — preserves order relative to
            // tool_execution_start but doesn't block subsequent events.
            handleToolExecutionEnd(ctx, evt as never).catch((err) => {
              ctx.log.debug(`tool_execution_end handler failed: ${String(err)}`);
            });
            return;
          default:
            dispatchSync(ctx, evt);
            return;
        }
      } catch (err) {
        ctx.log.debug(`event handler failed: type=${evt.type} error=${String(err)}`);
      } finally {
        pendingCount--;
      }
    });
  };
}
