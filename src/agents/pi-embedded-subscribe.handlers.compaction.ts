import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";

export const COMPACTION_HOOK_TIMEOUT_MS = 10_000;

async function waitForHookWithTimeout(
  hookPromise: Promise<void>,
  opts: {
    timeoutMs?: number;
    onTimeout: (timeoutMs: number) => void;
  },
): Promise<void> {
  const timeoutMs = Math.max(0, opts.timeoutMs ?? COMPACTION_HOOK_TIMEOUT_MS);
  if (timeoutMs <= 0) {
    await hookPromise;
    return;
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      hookPromise,
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
  if (timedOut) {
    opts.onTimeout(timeoutMs);
  }
}

const cloneMessageForHook = (value: unknown): unknown => {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneMessageForHook(item));
  }
  if (value instanceof Date || value instanceof RegExp) {
    return structuredClone(value);
  }
  const source = value as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(source)) {
    clone[key] = cloneMessageForHook(nested);
  }
  return clone;
};

const cloneMessagesForHook = (messages: readonly unknown[]): unknown[] => {
  try {
    return structuredClone(Array.from(messages));
  } catch {
    return messages.map((message) => cloneMessageForHook(message));
  }
};

export async function handleAutoCompactionStart(ctx: EmbeddedPiSubscribeContext): Promise<void> {
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
