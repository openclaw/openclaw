import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { clearAllDecayStores } from "./context-decay/clear-stores.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

// Rough heuristic: average English text runs ~4 characters per token.
// Heuristic for rough telemetry: ~4 chars per token across common models.
const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Estimates token count from message character lengths using a fixed chars-per-token ratio.
 * Used for pre/post compaction lifecycle instrumentation only — not model billing.
 */
function estimateTokensFromChars(messages: AgentMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    const content = (msg as unknown as Record<string, unknown>).content;
    if (typeof content === "string") {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (typeof b.text === "string") {
            chars += b.text.length;
          }
          if (typeof b.thinking === "string") {
            chars += b.thinking.length;
          }
        }
      }
    }
  }
  return Math.round(chars / CHARS_PER_TOKEN_ESTIMATE);
}

export function handleAutoCompactionStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.state.compactionInFlight = true;
  // Snapshot token estimate before compaction for lifecycle instrumentation
  if (ctx.params.lifecycleEmitter) {
    try {
      ctx.state.compactionPreEstTokens = estimateTokensFromChars(ctx.params.session.messages ?? []);
    } catch {
      ctx.state.compactionPreEstTokens = undefined;
    }
  }
  ctx.incrementCompactionCount();
  ctx.ensureCompactionPromise();
  ctx.log.debug(`embedded run compaction start: runId=${ctx.params.runId}`);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "start" },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "start" },
  });

  // Run before_compaction plugin hook (fire-and-forget)
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_compaction")) {
    void hookRunner
      .runBeforeCompaction(
        {
          messageCount: ctx.params.session.messages?.length ?? 0,
        },
        {},
      )
      .catch((err) => {
        ctx.log.warn(`before_compaction hook failed: ${String(err)}`);
      });
  }
}

export function handleAutoCompactionEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { willRetry?: unknown },
) {
  ctx.state.compactionInFlight = false;
  const willRetry = Boolean(evt.willRetry);
  if (willRetry) {
    ctx.noteCompactionRetry();
    ctx.resetForCompactionRetry();
    ctx.log.debug(`embedded run compaction retry: runId=${ctx.params.runId}`);
  } else {
    ctx.maybeResolveCompactionWait();
  }
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "end", willRetry },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "end", willRetry },
  });

  // Run after_compaction plugin hook (fire-and-forget)
  if (!willRetry) {
    const hookRunnerEnd = getGlobalHookRunner();
    if (hookRunnerEnd?.hasHooks("after_compaction")) {
      void hookRunnerEnd
        .runAfterCompaction(
          {
            messageCount: ctx.params.session.messages?.length ?? 0,
            compactedCount: ctx.getCompactionCount(),
          },
          {},
        )
        .catch((err) => {
          ctx.log.warn(`after_compaction hook failed: ${String(err)}`);
        });
    }

    // Emit lifecycle event for auto-compaction
    const emitter = ctx.params.lifecycleEmitter;
    if (emitter && ctx.state.compactionPreEstTokens != null) {
      try {
        const afterTokens = estimateTokensFromChars(ctx.params.session.messages ?? []);
        const beforeTokens = ctx.state.compactionPreEstTokens;
        emitter.emit({
          turn: 0,
          rule: "compact:compaction",
          beforeTokens,
          afterTokens,
          freedTokens: Math.max(0, beforeTokens - afterTokens),
          details: { manual: false },
        });
      } catch {
        // Instrumentation must never block the agent pipeline
      }
      ctx.state.compactionPreEstTokens = undefined;
    }

    // Clear stale decay stores — indices are positional and become invalid after compaction.
    if (ctx.params.sessionFile) {
      void clearAllDecayStores(ctx.params.sessionFile).catch((err) => {
        ctx.log.warn(`failed to clear decay stores after auto-compaction: ${String(err)}`);
      });
    }
  }
}
