// Discord plugin module implements message run queue behavior.
import { createChannelRunQueue } from "openclaw/plugin-sdk/channel-outbound";
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
  replayGuard?: ClaimableDedupe;
  testing?: DiscordMessageRunQueueTestingHooks;
};

type DiscordMessageRunQueue = {
  enqueue: (job: DiscordInboundJob) => void;
  cancel: (cancelKey: string, reason: string) => boolean;
  deactivate: () => void;
};

export type DiscordMessageRunQueueTestingHooks = {
  processDiscordMessage?: ProcessDiscordMessage;
};

type SkippedQueuedMessageCleanup = () => void;

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
  cancelSignal?: AbortSignal;
  replayGuard: ClaimableDedupe;
  testing?: DiscordMessageRunQueueTestingHooks;
}) {
  const processDiscordMessageImpl =
    params.testing?.processDiscordMessage ??
    (await loadMessageProcessRuntime()).processDiscordMessage;
  const abortSignal = mergeAbortSignals([
    params.job.runtime.abortSignal,
    params.lifecycleSignal,
    params.cancelSignal,
  ]);
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

function cleanupSkippedDiscordQueuedMessage(params: {
  job: DiscordInboundJob;
  replayGuard: ClaimableDedupe;
}) {
  try {
    // Skipped jobs never reach processDiscordMessage's finally block.
    // Clean carried typing here before reopening the replay key for retry.
    params.job.runtime.replyTypingFeedback?.onCleanup?.();
  } finally {
    releaseDiscordInboundReplay({
      replayKeys: params.job.replayKeys,
      error: new DiscordRetryableInboundError("discord queued run skipped before processing"),
      replayGuard: params.replayGuard,
    });
  }
}

export function createDiscordMessageRunQueue(
  params: DiscordMessageRunQueueParams,
): DiscordMessageRunQueue {
  const replayGuard = params.replayGuard ?? createDiscordInboundReplayGuard();
  const skippedCleanup = new Set<SkippedQueuedMessageCleanup>();
  // Active and queued jobs indexed by source-message cancel key so deletes and
  // superseding edits abort only the run their Discord message started.
  const cancelControllers = new Map<string, Set<AbortController>>();

  const registerCancelController = (job: DiscordInboundJob): AbortController | undefined => {
    const cancelKeys = job.cancelKeys ?? [];
    if (cancelKeys.length === 0) {
      return undefined;
    }
    const controller = new AbortController();
    for (const cancelKey of cancelKeys) {
      let controllers = cancelControllers.get(cancelKey);
      if (!controllers) {
        controllers = new Set();
        cancelControllers.set(cancelKey, controllers);
      }
      controllers.add(controller);
    }
    return controller;
  };

  const releaseCancelController = (job: DiscordInboundJob, controller?: AbortController) => {
    if (!controller) {
      return;
    }
    for (const cancelKey of job.cancelKeys ?? []) {
      const controllers = cancelControllers.get(cancelKey);
      controllers?.delete(controller);
      if (controllers?.size === 0) {
        cancelControllers.delete(cancelKey);
      }
    }
  };
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
      // Registered before dispatch so deletes can also cancel queued-but-not-
      // started jobs; processDiscordMessage bails on the aborted signal.
      const cancelController = registerCancelController(job);
      const cleanupSkipped = () => {
        releaseCancelController(job, cancelController);
        cleanupSkippedDiscordQueuedMessage({ job, replayGuard });
      };
      if (!lifecycleActive) {
        cleanupSkipped();
        return;
      }
      skippedCleanup.add(cleanupSkipped);
      runQueue.enqueue(job.queueKey, async ({ lifecycleSignal }) => {
        // Once the task starts, normal process/commit handling owns cleanup.
        // Leaving it in skippedCleanup would double-release replay/typing state.
        skippedCleanup.delete(cleanupSkipped);
        try {
          await processDiscordQueuedMessage({
            job,
            lifecycleSignal,
            cancelSignal: cancelController?.signal,
            replayGuard,
            testing: params.testing,
          });
        } finally {
          releaseCancelController(job, cancelController);
        }
      });
    },
    cancel(cancelKey, reason) {
      const controllers = cancelControllers.get(cancelKey);
      if (!controllers?.size) {
        return false;
      }
      for (const controller of [...controllers]) {
        controller.abort(new Error(reason));
      }
      return true;
    },
    deactivate() {
      runQueue.deactivate();
      cleanupSkippedQueuedMessages();
    },
  };
}
