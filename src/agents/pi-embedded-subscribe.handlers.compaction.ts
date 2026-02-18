import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { cloneMessagesForHook, waitForHookWithTimeout } from "./compaction-hook-utils.js";

export async function handleAutoCompactionStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.state.compactionInFlight = true;
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

  // Run before_compaction plugin hook (best effort).
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_compaction")) {
    const hookPromises: Array<Promise<unknown>> = [];
    hookPromises.push(
      waitForHookWithTimeout(
        hookRunner.runBeforeCompaction(
          {
            messageCount: ctx.params.session.messages?.length ?? 0,
            messages: cloneMessagesForHook(ctx.params.session.messages ?? []),
          },
          {},
        ),
        {
          onTimeout: (timeoutMs) => {
            ctx.log.warn(`before_compaction hook timed out after ${timeoutMs}ms`);
          },
        },
      ).catch((err) => {
        ctx.log.warn(`before_compaction hook failed: ${String(err)}`);
      }),
    );
    await Promise.allSettled(hookPromises);
  }
}

export async function handleAutoCompactionEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { willRetry?: unknown },
): Promise<void> {
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

  // Run after_compaction plugin hook (best effort).
  if (!willRetry) {
    const hookRunnerEnd = getGlobalHookRunner();
    if (hookRunnerEnd?.hasHooks("after_compaction")) {
      const hookPromises: Array<Promise<unknown>> = [];
      hookPromises.push(
        waitForHookWithTimeout(
          hookRunnerEnd.runAfterCompaction(
            {
              messageCount: ctx.params.session.messages?.length ?? 0,
              compactedCount: ctx.getCompactionCount(),
              messages: cloneMessagesForHook(ctx.params.session.messages ?? []),
            },
            {},
          ),
          {
            onTimeout: (timeoutMs) => {
              ctx.log.warn(`after_compaction hook timed out after ${timeoutMs}ms`);
            },
          },
        ).catch((err) => {
          ctx.log.warn(`after_compaction hook failed: ${String(err)}`);
        }),
      );
      await Promise.allSettled(hookPromises);
    }
  }
}
