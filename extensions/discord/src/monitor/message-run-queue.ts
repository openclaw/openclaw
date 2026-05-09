import { createChannelRunQueue } from "openclaw/plugin-sdk/channel-lifecycle";
import type { ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import {
  commitDiscordInboundReplay,
  createDiscordInboundReplayGuard,
  DiscordRetryableInboundError,
  releaseDiscordInboundReplay,
} from "./inbound-dedupe.js";
import { materializeDiscordInboundJob, type DiscordInboundJob } from "./inbound-job.js";
import type { RuntimeEnv } from "./message-handler.preflight.types.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import { mergeAbortSignals } from "./timeouts.js";

type ProcessDiscordMessage = typeof import("./message-handler.process.js").processDiscordMessage;

type DiscordMessageRunQueueParams = {
  runtime: RuntimeEnv;
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  maxPendingPerSession?: number;
  maxQueuedAgeMs?: number;
  replayGuard?: ClaimableDedupe;
  __testing?: DiscordMessageRunQueueTestingHooks;
};

type DiscordMessageRunQueue = {
  enqueue: (job: DiscordInboundJob) => void;
  deactivate: () => void;
};

export type DiscordMessageRunQueueTestingHooks = {
  processDiscordMessage?: ProcessDiscordMessage;
};

type QueuedDiscordInboundJob = {
  job: DiscordInboundJob;
  enqueuedAt: number;
};

let messageProcessRuntimePromise:
  | Promise<typeof import("./message-handler.process.js")>
  | undefined;

async function loadMessageProcessRuntime() {
  messageProcessRuntimePromise ??= import("./message-handler.process.js");
  return await messageProcessRuntimePromise;
}

async function processDiscordQueuedMessage(params: {
  job: DiscordInboundJob;
  lifecycleSignal?: AbortSignal;
  replayGuard: ClaimableDedupe;
  testing?: DiscordMessageRunQueueTestingHooks;
}) {
  const processDiscordMessageImpl =
    params.testing?.processDiscordMessage ??
    (await loadMessageProcessRuntime()).processDiscordMessage;
  const abortSignal = mergeAbortSignals([params.job.runtime.abortSignal, params.lifecycleSignal]);
  try {
    await processDiscordMessageImpl(materializeDiscordInboundJob(params.job, abortSignal));
    await commitDiscordInboundReplay({
      replayKeys: params.job.replayKeys,
      replayGuard: params.replayGuard,
    });
  } catch (error) {
    if (error instanceof DiscordRetryableInboundError) {
      releaseDiscordInboundReplay({
        replayKeys: params.job.replayKeys,
        error,
        replayGuard: params.replayGuard,
      });
    } else {
      await commitDiscordInboundReplay({
        replayKeys: params.job.replayKeys,
        replayGuard: params.replayGuard,
      });
    }
    throw error;
  }
}

export function createDiscordMessageRunQueue(
  params: DiscordMessageRunQueueParams,
): DiscordMessageRunQueue {
  const replayGuard = params.replayGuard ?? createDiscordInboundReplayGuard();
  const maxPendingPerSession = normalizePositiveInteger(params.maxPendingPerSession);
  const maxQueuedAgeMs = normalizePositiveInteger(params.maxQueuedAgeMs);
  const pendingBySession = new Map<string, QueuedDiscordInboundJob[]>();
  const runQueue = createChannelRunQueue({
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
    onError: (error) => {
      params.runtime.error?.(danger(`discord message run failed: ${String(error)}`));
    },
  });

  return {
    enqueue(job) {
      const pending = pendingBySession.get(job.queueKey) ?? [];
      if (maxPendingPerSession !== undefined && pending.length >= maxPendingPerSession) {
        params.runtime.error?.(
          danger(
            `discord message queue full for session ${job.queueKey}; maxPendingPerSession=${maxPendingPerSession}`,
          ),
        );
        void commitDiscordInboundReplay({
          replayKeys: job.replayKeys,
          replayGuard,
        });
        return;
      }
      const queuedJob = { job, enqueuedAt: Date.now() };
      pending.push(queuedJob);
      pendingBySession.set(job.queueKey, pending);
      runQueue.enqueue(job.queueKey, async ({ lifecycleSignal }) => {
        removePendingJob(pendingBySession, queuedJob);
        if (isStaleQueuedJob(queuedJob, maxQueuedAgeMs)) {
          params.runtime.error?.(
            danger(
              `discord message queue dropped stale job for session ${job.queueKey} after ${Date.now() - queuedJob.enqueuedAt}ms`,
            ),
          );
          await commitDiscordInboundReplay({
            replayKeys: job.replayKeys,
            replayGuard,
          });
          return;
        }
        await processDiscordQueuedMessage({
          job,
          lifecycleSignal,
          replayGuard,
          testing: params.__testing,
        });
      });
    },
    deactivate() {
      pendingBySession.clear();
      runQueue.deactivate();
    },
  };
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function removePendingJob(
  pendingBySession: Map<string, QueuedDiscordInboundJob[]>,
  queuedJob: QueuedDiscordInboundJob,
): void {
  const pending = pendingBySession.get(queuedJob.job.queueKey);
  if (!pending) {
    return;
  }
  const index = pending.indexOf(queuedJob);
  if (index >= 0) {
    pending.splice(index, 1);
  }
  if (pending.length === 0) {
    pendingBySession.delete(queuedJob.job.queueKey);
  }
}

function isStaleQueuedJob(
  queuedJob: QueuedDiscordInboundJob,
  maxQueuedAgeMs: number | undefined,
): boolean {
  return maxQueuedAgeMs !== undefined && Date.now() - queuedJob.enqueuedAt > maxQueuedAgeMs;
}
