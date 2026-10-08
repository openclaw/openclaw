/**
 * Dispatches serialized embedded-agent subscription events to specific handlers.
 */
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  type AgentAssistantSourceReceipt,
  bindAgentAssistantSource,
} from "../infra/agent-events.js";
import {
  handleAgentEnd,
  handleAgentStart,
  handleCompactionEnd,
  handleCompactionStart,
} from "./embedded-agent-subscribe.handlers.lifecycle.js";
import {
  handleMessageStart,
  handleMessageEnd,
} from "./embedded-agent-subscribe.handlers.messages.lifecycle.js";
import { isSubscribeTranscriptOnlyOpenClawAssistantMessage } from "./embedded-agent-subscribe.handlers.messages.stream.js";
import { handleMessageUpdate } from "./embedded-agent-subscribe.handlers.messages.update.js";
import { handleToolExecutionEnd } from "./embedded-agent-subscribe.handlers.tools.completion.js";
import { handleToolExecutionUpdate } from "./embedded-agent-subscribe.handlers.tools.progress.js";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { recordEmbeddedToolTrajectoryEvent } from "./embedded-agent-subscribe.trajectory.js";
import { prepareToolResult } from "./embedded-agent-tool-results.js";
import type { AgentSessionEvent } from "./sessions/index.js";

/** Create the serialized event dispatcher for subscribed embedded-agent sessions. */
export function createEmbeddedAgentSessionEventHandler(ctx: EmbeddedAgentSubscribeContext) {
  let assistantSource: AgentAssistantSourceReceipt | undefined;
  const scheduleEvent = (evt: AgentSessionEvent, handler: () => unknown): void | Promise<void> => {
    // Tool-result delivery must settle before later assistant or terminal events;
    // suppression flags would discard those events instead of preserving order.
    const run = () => {
      try {
        if (evt.type !== "message_update") {
          ctx.flushAssistantStream();
        }
        return handler();
      } catch (err) {
        ctx.log.debug(`${evt.type} handler failed: ${String(err)}`);
        return undefined;
      }
    };

    const result = ctx.state.pendingEventChain ? ctx.state.pendingEventChain.then(run) : run();
    if (!isPromiseLike(result)) {
      return;
    }

    const task = Promise.resolve(result)
      .then(
        () => {},
        (err: unknown) => {
          ctx.log.debug(`${evt.type} handler failed: ${String(err)}`);
        },
      )
      .finally(() => {
        if (ctx.state.pendingEventChain === task) {
          ctx.state.pendingEventChain = null;
        }
      });
    ctx.state.pendingEventChain = task;
    return task;
  };

  return (evt: AgentSessionEvent) => {
    if (
      (evt.type === "message_start" ||
        evt.type === "message_update" ||
        evt.type === "message_end") &&
      evt.message.role === "assistant" &&
      !isSubscribeTranscriptOnlyOpenClawAssistantMessage(evt.message)
    ) {
      if (evt.type === "message_start" || !assistantSource) {
        assistantSource = {};
      }
      bindAgentAssistantSource(evt.message, assistantSource);
    }
    // Model facts advance before persistence, independently of queued reply delivery.
    ctx.captureModelEvent(evt);
    // Capture tool facts before reply delivery can delay their lifecycle handlers.
    const readResult =
      evt.type === "tool_execution_end" ? prepareToolResult(evt.result) : undefined;
    recordEmbeddedToolTrajectoryEvent(ctx, evt, readResult);
    switch (evt.type) {
      case "message_start":
        void scheduleEvent(evt, () => handleMessageStart(ctx, evt));
        return;
      case "message_update":
        void scheduleEvent(evt, () => handleMessageUpdate(ctx, evt));
        return;
      case "message_end":
        void scheduleEvent(evt, () => handleMessageEnd(ctx, evt));
        return;
      case "turn_start":
        // Async tool fragments share one provider turn; only a new model call starts a batch.
        void scheduleEvent(evt, () => {
          ctx.state.turnToolsOnlySourceProgress = undefined;
        });
        return;
      case "turn_end":
        void scheduleEvent(evt, () => ctx.noteLastAssistant(evt.message));
        return;
      case "tool_execution_start":
        void scheduleEvent(evt, () => handleToolExecutionStart(ctx, evt));
        return;
      case "tool_execution_update":
        void scheduleEvent(evt, () => handleToolExecutionUpdate(ctx, evt));
        return;
      case "tool_execution_end":
        void scheduleEvent(evt, () => handleToolExecutionEnd(ctx, evt, readResult!));
        return;
      case "agent_start":
        void scheduleEvent(evt, () => handleAgentStart(ctx));
        return;
      case "compaction_start":
        void scheduleEvent(evt, () => handleCompactionStart(ctx, evt));
        return;
      case "compaction_end":
        // The attempt's replacement hook already recorded its private commit fact.
        // Keep public completion timing and standalone subscriber counting unchanged.
        void scheduleEvent(evt, () => handleCompactionEnd(ctx, evt));
        return;
      case "agent_end":
        return scheduleEvent(evt, () => handleAgentEnd(ctx, evt));
      default:
    }
  };
}
