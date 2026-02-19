import { emitAgentEvent } from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { ExecutionCoordinator, resetExecutionCoordinator } from "./execution-coordinator.js";
import { formatAssistantErrorText } from "./pi-embedded-helpers.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { isAssistantMessage } from "./pi-embedded-utils.js";

export {
  handleAutoCompactionEnd,
  handleAutoCompactionStart,
} from "./pi-embedded-subscribe.handlers.compaction.js";

function getLastUserMessage(session: unknown): string | undefined {
  if (!session || typeof session !== "object") {
    return undefined;
  }
  const s = session as { messages?: unknown[] };
  if (!Array.isArray(s.messages)) {
    return undefined;
  }
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const msg = s.messages[i];
    if (msg && typeof msg === "object" && (msg as { role?: string }).role === "user") {
      const content = (msg as { content?: unknown }).content;
      if (typeof content === "string") {
        return content;
      }
      if (Array.isArray(content)) {
        const textPart = content.find(
          (p) => p && typeof p === "object" && (p as { type?: string }).type === "text",
        );
        if (textPart && typeof (textPart as { text?: string }).text === "string") {
          return (textPart as { text: string }).text;
        }
      }
    }
  }
  return undefined;
}

export function handleAgentStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.log.debug(`embedded run agent start: runId=${ctx.params.runId}`);

  if (ctx.params.config) {
    resetExecutionCoordinator();
    const coordinator = new ExecutionCoordinator({
      openClawConfig: ctx.params.config,
      agentSessionKey: ctx.params.sessionKey,
    });
    ctx.state.executionCoordinator = coordinator;

    const userMessage = getLastUserMessage(ctx.params.session);
    if (userMessage) {
      coordinator.initializeSession(userMessage).catch((err) => {
        ctx.log.debug(`coordinator initializeSession failed: ${String(err)}`);
      });
    }
  }

  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "lifecycle",
    data: {
      phase: "start",
      startedAt: Date.now(),
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "lifecycle",
    data: { phase: "start" },
  });
}

export function handleAgentEnd(ctx: EmbeddedPiSubscribeContext) {
  const lastAssistant = ctx.state.lastAssistant;
  const isError = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error";

  ctx.log.debug(`embedded run agent end: runId=${ctx.params.runId} isError=${isError}`);

  if (isError && lastAssistant) {
    const friendlyError = formatAssistantErrorText(lastAssistant, {
      cfg: ctx.params.config,
      sessionKey: ctx.params.sessionKey,
    });
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        error: friendlyError || lastAssistant.errorMessage || "LLM request failed.",
        endedAt: Date.now(),
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: friendlyError || lastAssistant.errorMessage || "LLM request failed.",
      },
    });
  } else {
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        endedAt: Date.now(),
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  }

  if (ctx.params.onBlockReply) {
    if (ctx.blockChunker?.hasBuffered()) {
      ctx.blockChunker.drain({ force: true, emit: ctx.emitBlockChunk });
      ctx.blockChunker.reset();
    } else if (ctx.state.blockBuffer.length > 0) {
      ctx.emitBlockChunk(ctx.state.blockBuffer);
      ctx.state.blockBuffer = "";
    }
  }

  ctx.state.blockState.thinking = false;
  ctx.state.blockState.final = false;
  ctx.state.blockState.inlineCode = createInlineCodeState();

  if (ctx.state.pendingCompactionRetry > 0) {
    ctx.resolveCompactionRetry();
  } else {
    ctx.maybeResolveCompactionWait();
  }
}
