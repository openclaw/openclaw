import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { resolveStorePath, updateSessionStoreEntry } from "../config/sessions.js";
import { readMessagesFromSessionTranscript } from "../hooks/session-transcript-messages.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { makeZeroUsageSnapshot } from "./usage.js";

export function handleAutoCompactionStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.state.compactionInFlight = true;
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
  // Read from transcript to preserve provenance and other extension fields
  // that the in-memory AgentMessage[] may not carry.
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_compaction")) {
    void readMessagesFromSessionTranscript(ctx.params.session.sessionFile)
      .then((transcriptMessages) =>
        hookRunner.runBeforeCompaction(
          {
            messageCount: transcriptMessages?.length ?? ctx.params.session.messages?.length ?? 0,
            messages: transcriptMessages ?? ctx.params.session.messages,
            sessionFile: ctx.params.session.sessionFile,
          },
          {
            sessionKey: ctx.params.sessionKey,
          },
        ),
      )
      .catch((err) => {
        ctx.log.warn(`before_compaction hook failed: ${String(err)}`);
      });
  }
}

export function handleAutoCompactionEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { willRetry?: unknown; result?: unknown; aborted?: unknown },
) {
  ctx.state.compactionInFlight = false;
  const willRetry = Boolean(evt.willRetry);
  // Increment counter whenever compaction actually produced a result,
  // regardless of willRetry.  Overflow-triggered compaction sets willRetry=true
  // (the framework retries the LLM request), but the compaction itself succeeded
  // and context was trimmed — the counter must reflect that.  (#38905)
  const hasResult = evt.result != null;
  const wasAborted = Boolean(evt.aborted);
  if (hasResult && !wasAborted) {
    ctx.incrementCompactionCount();
    const observedCompactionCount = ctx.getCompactionCount();
    void reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey: ctx.params.sessionKey,
      agentId: ctx.params.agentId,
      configStore: ctx.params.config?.session?.store,
      observedCompactionCount,
    }).catch((err) => {
      ctx.log.warn(`late compaction count reconcile failed: ${String(err)}`);
    });
  }
  if (willRetry) {
    ctx.noteCompactionRetry();
    ctx.resetForCompactionRetry();
    ctx.log.debug(`embedded run compaction retry: runId=${ctx.params.runId}`);
  } else {
    ctx.maybeResolveCompactionWait();
    clearStaleAssistantUsageOnSessionMessages(ctx);
  }
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "end", willRetry, completed: hasResult && !wasAborted },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "end", willRetry, completed: hasResult && !wasAborted },
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
            sessionFile: ctx.params.session.sessionFile,
          },
          { sessionKey: ctx.params.sessionKey },
        )
        .catch((err) => {
          ctx.log.warn(`after_compaction hook failed: ${String(err)}`);
        });
    }
  }
}

export async function reconcileSessionStoreCompactionCountAfterSuccess(params: {
  sessionKey?: string;
  agentId?: string;
  configStore?: string;
  observedCompactionCount: number;
  now?: number;
}): Promise<number | undefined> {
  const { sessionKey, agentId, configStore, observedCompactionCount, now = Date.now() } = params;
  if (!sessionKey || observedCompactionCount <= 0) {
    return undefined;
  }
  const storePath = resolveStorePath(configStore, { agentId });
  const nextEntry = await updateSessionStoreEntry({
    storePath,
    sessionKey,
    update: async (entry) => {
      const currentCount = Math.max(0, entry.compactionCount ?? 0);
      const nextCount = Math.max(currentCount, observedCompactionCount);
      if (nextCount === currentCount) {
        return null;
      }
      return {
        compactionCount: nextCount,
        updatedAt: Math.max(entry.updatedAt ?? 0, now),
      };
    },
  });
  return nextEntry?.compactionCount;
}

function clearStaleAssistantUsageOnSessionMessages(ctx: EmbeddedPiSubscribeContext): void {
  const messages = ctx.params.session.messages;
  if (!Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const candidate = message as { role?: unknown; usage?: unknown };
    if (candidate.role !== "assistant") {
      continue;
    }
    // pi-coding-agent expects assistant usage to exist when computing context usage.
    // Reset stale snapshots to zeros instead of deleting the field.
    candidate.usage = makeZeroUsageSnapshot();
  }
}
