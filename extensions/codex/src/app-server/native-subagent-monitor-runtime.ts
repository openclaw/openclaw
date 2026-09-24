import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  captureAgentHarnessCompletionCustody,
  createAgentHarnessTaskEventSink,
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { interruptCodexTurnAndWaitBestEffort } from "./attempt-client-cleanup.js";
import {
  claimCodexAppServerLiveThread,
  hasCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
  type CodexAppServerLiveThreadOwnership,
} from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import type {
  MonitorOptions,
  NativeSubagentMonitorClient,
  NativeSubagentMonitorRuntime,
  NativeModelToolInputRequest,
  NativeModelMapping,
  NativeModelSourceCapture,
  NativeModelSourceRequest,
} from "./native-subagent-monitor-types.js";
import type { NativeParentRegistration } from "./native-subagent-parent-owner.js";

type NativeMonitor = {
  registerParent(params: NativeParentRegistration): {
    bindTurn: (turnId: string, mapping?: NativeModelMapping) => void;
    unregister: () => Promise<void>;
  };
  retireParent(parentThreadId: string): void;
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

export const defaultNativeSubagentMonitorRuntime: NativeSubagentMonitorRuntime = {
  captureAgentHarnessCompletionCustody,
  createAgentHarnessTaskEventSink,
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
};

export function createCodexNativeSubagentMonitorRuntime<T extends NativeMonitorConstructor>(
  Monitor: T,
) {
  const monitors = new WeakMap<CodexAppServerClient, NativeMonitor>();

  function registerMonitor({
    client,
    runtime,
    retainClient,
    retainParentThread,
    ...registration
  }: NativeParentRegistration &
    Pick<MonitorOptions, "retainClient" | "retainParentThread"> & {
      client: CodexAppServerClient;
      runtime?: NativeSubagentMonitorRuntime;
    }): {
    bindTurn: (turnId: string, mapping?: NativeModelMapping) => void;
    unregister: () => Promise<void>;
  } {
    let monitor = monitors.get(client);
    if (!monitor) {
      // Native start/completion can race; serialize each child so only its
      // original claim handle may publish or release the same subscription.
      const childThreadOwnership = new Map<string, CodexAppServerLiveThreadOwnership>();
      const childThreadTransitions = new KeyedAsyncQueue();
      const releaseOwnership = async (
        threadId: string,
        ownership: CodexAppServerLiveThreadOwnership | undefined,
      ) => {
        if (!ownership) {
          return;
        }
        await ownership.release(threadId);
        if (childThreadOwnership.get(threadId) === ownership) {
          childThreadOwnership.delete(threadId);
        }
      };
      monitor = new Monitor(client, runtime ?? defaultNativeSubagentMonitorRuntime, {
        retainClient,
        interruptModelExecution: (threadId, turnId) => {
          void interruptCodexTurnAndWaitBestEffort(client, { threadId, turnId });
        },
        retainParentThread,
        hasObservationBacking: (parentThreadId, childThreadId) =>
          hasCodexAppServerLiveThread(client, parentThreadId) ||
          hasCodexAppServerLiveThread(client, childThreadId),
        claimChildThread: (threadId) =>
          childThreadTransitions.enqueue(threadId, async () => {
            // Codex subscribes fresh children before thread/started; they have
            // no idle entry yet but must already be fenced from manual adoption.
            let ownership: CodexAppServerLiveThreadOwnership | undefined;
            let invalidated = false;
            ownership = await claimCodexAppServerLiveThread(client, threadId, () => {
              invalidated = true;
              if (childThreadOwnership.get(threadId) === ownership) {
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
              childThreadOwnership.set(threadId, ownership);
            }
            return invalidated ? undefined : ownership;
          }),
        retainChildThread: (threadId) =>
          childThreadTransitions.enqueue(threadId, async () => {
            const ownership = childThreadOwnership.get(threadId);
            if (!ownership) {
              return false;
            }
            let retained = false;
            try {
              retained = await retainCodexAppServerLiveThread(client, threadId, ownership.release);
              return retained;
            } finally {
              // A full idle pool can reject terminal child ownership. Release
              // its exact branded claim before the monitor forgets that child.
              if (!retained) {
                await releaseOwnership(threadId, ownership);
              }
            }
          }),
        releaseChildThread: (threadId) =>
          childThreadTransitions.enqueue(threadId, () =>
            releaseOwnership(threadId, childThreadOwnership.get(threadId)),
          ),
        captureChildThreadForget: (threadId) =>
          childThreadTransitions.enqueue(threadId, async () => {
            const ownership = childThreadOwnership.get(threadId);
            return ownership?.forget;
          }),
      });
      monitors.set(client, monitor);
    }
    return monitor.registerParent(registration);
  }

  return {
    Monitor,
    register: registerMonitor,
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
    retireParent: (client: CodexAppServerClient, parentThreadId: string): void => {
      monitors.get(client)?.retireParent(parentThreadId);
    },
  };
}
