import {
  captureAgentHarnessCompletionCustody,
  createAgentHarnessCompletionEventSink,
  deliverAgentHarnessCompletion,
} from "openclaw/plugin-sdk/agent-harness-completion";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { defineCodexBuildState } from "../build-state.js";
import { interruptCodexTurnAndWaitBestEffort } from "./attempt-client-cleanup.js";
import {
  claimCodexAppServerLiveThread,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadProtected,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { CodexAppServerLiveThreadOwnership } from "./client-thread-owner.js";
import type { CodexAppServerClient } from "./client.js";
import type {
  MonitorOptions,
  NativeDescendantCancellation,
  NativeDescendantCancellationResult,
  NativeSubagentMonitorClient,
  NativeSubagentMonitorRuntime,
  NativeSubagentsReadRequest,
  NativeSubagentsSnapshot,
  NativeModelToolInputRequest,
  NativeModelSourceCapture,
  NativeModelSourceRequest,
  ParentRegistrationHandle,
} from "./native-subagent-monitor-types.js";
import type { NativeParentRegistration } from "./native-subagent-parent-owner.js";

type NativeMonitor = {
  readNativeSubagents(request: NativeSubagentsReadRequest): NativeSubagentsSnapshot;
  withDescendantCancellation<T>(
    params: NativeDescendantCancellation,
    run: (cancel: () => Promise<NativeDescendantCancellationResult>) => Promise<T>,
  ): Promise<T>;
  registerParent(params: NativeParentRegistration): Promise<ParentRegistrationHandle>;
  retireParent(parentThreadId: string): Promise<void>;
  captureModelSource(
    request: NativeModelSourceRequest,
  ): Promise<NativeModelSourceCapture | undefined>;
  resolveModelThreadId(turnId: string): string | undefined;
  prepareModelInput(request: NativeModelToolInputRequest): Promise<void>;
  releasePendingModelInputs(threadId: string): void;
};

type NativeMonitorConstructor = new (
  client: NativeSubagentMonitorClient,
  runtime?: NativeSubagentMonitorRuntime,
  options?: MonitorOptions,
) => NativeMonitor;

type ChildThreadOwnership = {
  ownership: CodexAppServerLiveThreadOwnership;
  releaseRetryTimer?: ReturnType<typeof setTimeout>;
};

const TERMINAL_CHILD_RELEASE_RETRY_MS = 30_000;

export const defaultNativeSubagentMonitorRuntime: NativeSubagentMonitorRuntime = {
  deliverAgentHarnessCompletion,
  captureAgentHarnessCompletionCustody,
  createAgentHarnessCompletionEventSink,
};

export function createCodexNativeSubagentMonitorRuntime<T extends NativeMonitorConstructor>(
  Monitor: T,
) {
  // Retirement and model admission must reach the original monitor's custody
  // when another same-build module copy receives the shared physical client.
  const monitors = defineCodexBuildState(
    "openclaw.codexNativeSubagentMonitors",
    () => new WeakMap<CodexAppServerClient, NativeMonitor>(),
  )();

  async function registerMonitor({
    client,
    runtime,
    retainClient,
    retainParentThread,
    ...registration
  }: NativeParentRegistration &
    Pick<MonitorOptions, "retainClient" | "retainParentThread"> & {
      client: CodexAppServerClient;
      runtime?: NativeSubagentMonitorRuntime;
    }): Promise<ParentRegistrationHandle> {
    let monitor = monitors.get(client);
    if (!monitor) {
      // Native start/completion can race; serialize each child so only its
      // original claim handle may publish or release the same subscription.
      const childThreadOwnership = new Map<string, ChildThreadOwnership>();
      const childThreadTransitions = new KeyedAsyncQueue();
      const clearReleaseRetry = (entry: ChildThreadOwnership) => {
        clearTimeout(entry.releaseRetryTimer);
        entry.releaseRetryTimer = undefined;
      };
      const releaseOwnership = async (
        threadId: string,
        entry: ChildThreadOwnership | undefined,
      ) => {
        if (!entry || childThreadOwnership.get(threadId) !== entry) {
          return;
        }
        await entry.ownership.release(threadId);
        clearReleaseRetry(entry);
        childThreadOwnership.delete(threadId);
      };
      const scheduleReleaseRetry = (threadId: string, entry: ChildThreadOwnership) => {
        if (childThreadOwnership.get(threadId) !== entry || entry.releaseRetryTimer !== undefined) {
          return;
        }
        // Only failed terminal releases enter this path. Waiting outside the
        // existing queue lets a new turn claim the child and cancel this retry.
        const timer = setTimeout(() => {
          void childThreadTransitions
            .enqueue(threadId, async () => {
              if (
                entry.releaseRetryTimer !== timer ||
                childThreadOwnership.get(threadId) !== entry
              ) {
                return;
              }
              entry.releaseRetryTimer = undefined;
              // Protected release defers the unsubscribe until unpinning. Keep
              // custody here so an admitted follow-up can cancel it instead.
              if (isCodexAppServerLiveThreadProtected(client, threadId)) {
                scheduleReleaseRetry(threadId, entry);
                return;
              }
              await releaseOwnership(threadId, entry);
            })
            .catch((error: unknown) => {
              embeddedAgentLog.warn("Failed to retry Codex native subagent thread release", {
                childThreadId: threadId,
                error: formatErrorMessage(error),
              });
              scheduleReleaseRetry(threadId, entry);
            });
        }, TERMINAL_CHILD_RELEASE_RETRY_MS);
        entry.releaseRetryTimer = timer;
        timer.unref?.();
      };
      monitor = new Monitor(client, runtime ?? defaultNativeSubagentMonitorRuntime, {
        retainClient,
        interruptChildAndWait: (threadId, turnId, assertCurrent, timeoutMs) =>
          interruptCodexTurnAndWaitBestEffort(client, {
            threadId,
            turnId,
            assertCurrent,
            timeoutMs,
          }),
        interruptModelExecution: (threadId, turnId) => {
          void interruptCodexTurnAndWaitBestEffort(client, { threadId, turnId });
        },
        retainParentThread,
        hasObservationBacking: (parentThreadId, childThreadId) =>
          hasCodexAppServerLiveThread(client, parentThreadId) ||
          hasCodexAppServerLiveThread(client, childThreadId),
        claimChildThread: (threadId) =>
          childThreadTransitions.enqueue(threadId, async () => {
            const existing = childThreadOwnership.get(threadId);
            if (existing?.releaseRetryTimer !== undefined) {
              // The failed terminal release still owns this subscription. An
              // admitted follow-up reuses that claim instead of releasing it.
              clearReleaseRetry(existing);
              return existing.ownership;
            }
            // Codex subscribes fresh children before thread/started; they have
            // no idle entry yet but must already be fenced from manual adoption.
            let ownership: CodexAppServerLiveThreadOwnership | undefined;
            let invalidated = false;
            ownership = await claimCodexAppServerLiveThread(client, threadId, () => {
              invalidated = true;
              const entry = childThreadOwnership.get(threadId);
              if (entry && entry.ownership === ownership) {
                clearReleaseRetry(entry);
                childThreadOwnership.delete(threadId);
              }
              ownership = undefined;
              void childThreadTransitions
                .enqueue(threadId, async () => {
                  if (!hasCodexAppServerLiveThread(client, threadId)) {
                    monitor?.releasePendingModelInputs(threadId);
                  }
                })
                .catch((error: unknown) => {
                  embeddedAgentLog.warn("Failed to release Codex native input custody", {
                    threadId,
                    error: formatErrorMessage(error),
                  });
                });
            });
            if (ownership && !invalidated) {
              childThreadOwnership.set(threadId, { ownership });
            }
            return invalidated ? undefined : ownership;
          }),
        retainChildThread: (threadId) =>
          childThreadTransitions.enqueue(threadId, async () => {
            const entry = childThreadOwnership.get(threadId);
            if (!entry) {
              return false;
            }
            let retained = false;
            try {
              retained = await retainCodexAppServerLiveThread(
                client,
                threadId,
                entry.ownership.release,
              );
              if (retained) {
                clearReleaseRetry(entry);
              }
              return retained;
            } finally {
              // A full idle pool can reject terminal child ownership. Release
              // its exact branded claim before the monitor forgets that child.
              if (!retained) {
                await releaseOwnership(threadId, entry).catch((error: unknown) => {
                  scheduleReleaseRetry(threadId, entry);
                  throw error;
                });
              }
            }
          }),
        releaseChildThread: (threadId) =>
          childThreadTransitions.enqueue(threadId, () =>
            releaseOwnership(threadId, childThreadOwnership.get(threadId)),
          ),
        captureChildThreadForget: (threadId) =>
          childThreadTransitions.enqueue(threadId, async () => {
            const entry = childThreadOwnership.get(threadId);
            return entry?.ownership.forget;
          }),
      });
      monitors.set(client, monitor);
    }
    return monitor.registerParent(registration);
  }

  return {
    Monitor,
    register: registerMonitor,
    readNativeSubagents: ({
      client,
      ...request
    }: NativeSubagentsReadRequest & {
      client: CodexAppServerClient;
    }) => monitors.get(client)?.readNativeSubagents(request),
    captureModelSource: ({
      client,
      ...request
    }: NativeModelSourceRequest & { client: CodexAppServerClient }) =>
      monitors.get(client)?.captureModelSource(request) ?? Promise.resolve(undefined),
    resolveModelThreadId: ({ client, turnId }: { client: CodexAppServerClient; turnId: string }) =>
      monitors.get(client)?.resolveModelThreadId(turnId),
    prepareModelInput: ({
      client,
      ...request
    }: NativeModelToolInputRequest & { client: CodexAppServerClient }) => {
      const monitor = monitors.get(client);
      if (!monitor) {
        return Promise.reject(new Error("Codex native input has no admitted model source"));
      }
      return monitor.prepareModelInput(request);
    },
    withDescendantCancellation: <Result>(
      client: CodexAppServerClient,
      params: NativeDescendantCancellation,
      run: (cancel: () => Promise<NativeDescendantCancellationResult>) => Promise<Result>,
    ): Promise<Result> =>
      monitors.get(client)?.withDescendantCancellation(params, run) ??
      run(async () => ({ killed: 0, cancelledRequesters: [] })),
    retireParent: (client: CodexAppServerClient, parentThreadId: string): Promise<void> =>
      monitors.get(client)?.retireParent(parentThreadId) ?? Promise.resolve(),
  };
}
