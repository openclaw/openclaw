// Discord plugin module implements message run queue behavior.
import { createChannelRunQueue } from "openclaw/plugin-sdk/channel-outbound";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import {
  createDiscordInboundReplayGuard,
  type DiscordInboundReplayGuard,
  DiscordRetryableInboundError,
} from "./inbound-dedupe.js";
import { materializeDiscordInboundJob, type DiscordInboundJob } from "./inbound-job.js";
import type { RuntimeEnv } from "./message-handler.preflight.types.js";
import type { DiscordMonitorStatusSink } from "./status.js";

type ProcessDiscordMessage = typeof import("./message-handler.process.js").processDiscordMessage;

type DiscordMessageRunQueueParams = {
  runtime: RuntimeEnv;
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  replayGuard?: DiscordInboundReplayGuard;
  testing?: DiscordMessageRunQueueTestingHooks;
};

type DiscordMessageRunQueue = {
  enqueue: (job: DiscordInboundJob) => void;
  deactivate: () => void;
};

export type DiscordMessageRunQueueTestingHooks = {
  processDiscordMessage?: ProcessDiscordMessage;
};

type SkippedQueuedMessageCleanup = () => void;

const loadMessageProcessRuntime = createLazyRuntimeModule(
  () => import("./message-handler.process.js"),
);

async function processDiscordQueuedMessage(params: {
  job: DiscordInboundJob;
  lifecycleSignal?: AbortSignal;
  replayGuard: DiscordInboundReplayGuard;
  testing?: DiscordMessageRunQueueTestingHooks;
}) {
  const processDiscordMessageImpl =
    params.testing?.processDiscordMessage ??
    (await loadMessageProcessRuntime()).processDiscordMessage;
  const abortSignal =
    params.job.runtime.abortSignal && params.lifecycleSignal
      ? AbortSignal.any([params.job.runtime.abortSignal, params.lifecycleSignal])
      : (params.job.runtime.abortSignal ?? params.lifecycleSignal);
  try {
    await processDiscordMessageImpl(materializeDiscordInboundJob(params.job, abortSignal));
    await params.replayGuard.commit(params.job.replayKeys);
  } catch (error) {
    if (error instanceof DiscordRetryableInboundError) {
      params.replayGuard.release(params.job.replayKeys, { error });
    } else {
      await params.replayGuard.commit(params.job.replayKeys);
    }
    throw error;
  }
}

function cleanupSkippedDiscordQueuedMessage(params: {
  job: DiscordInboundJob;
  replayGuard: DiscordInboundReplayGuard;
}) {
  try {
    // Skipped jobs never reach processDiscordMessage's finally block.
    // Clean carried typing here before reopening the replay key for retry.
    params.job.runtime.replyTypingFeedback?.onCleanup?.();
  } finally {
    params.replayGuard.release(params.job.replayKeys, {
      error: new DiscordRetryableInboundError("discord queued run skipped before processing"),
    });
  }
}

export function createDiscordMessageRunQueue(
  params: DiscordMessageRunQueueParams,
): DiscordMessageRunQueue {
  const replayGuard = params.replayGuard ?? createDiscordInboundReplayGuard();
  const skippedCleanup = new Set<SkippedQueuedMessageCleanup>();
  const runQueue = createChannelRunQueue({
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
    onError: (error) => {
      params.runtime.error(danger(`discord message run failed: ${String(error)}`));
    },
  });
  let lifecycleActive = !params.abortSignal?.aborted;

  const cleanupSkippedQueuedMessages = () => {
    // These callbacks represent jobs accepted into the queue but not started.
    // Running jobs remove their callback before processDiscordMessage owns cleanup.
    if (!lifecycleActive && skippedCleanup.size === 0) {
      return;
    }
    lifecycleActive = false;
    const cleanups = [...skippedCleanup];
    skippedCleanup.clear();
    for (const cleanup of cleanups) {
      cleanup();
    }
  };

  if (params.abortSignal?.aborted) {
    cleanupSkippedQueuedMessages();
  } else {
    params.abortSignal?.addEventListener("abort", cleanupSkippedQueuedMessages, { once: true });
  }

  return {
    enqueue(job) {
      const cleanupSkipped = () => {
        cleanupSkippedDiscordQueuedMessage({ job, replayGuard });
      };
      if (!lifecycleActive) {
        cleanupSkipped();
        return;
      }
      skippedCleanup.add(cleanupSkipped);
      runQueue.enqueue(job.queueKey, async ({ lifecycleSignal }) => {
        // Once the task starts, normal process/commit handling owns cleanup.
        // Leaving it in skippedCleanup would double-release replay state.
        skippedCleanup.delete(cleanupSkipped);
        await processDiscordQueuedMessage({
          job,
          lifecycleSignal,
          replayGuard,
          testing: params.testing,
        });
      });
    },
    deactivate() {
      runQueue.deactivate();
      cleanupSkippedQueuedMessages();
    },
  };
}
