import {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
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
  ParentState,
  ParentOwner,
} from "./native-subagent-monitor-types.js";

type ParentRegistration = Pick<
  ParentState,
  | "parentThreadId"
  | "requesterSessionKey"
  | "taskRuntimeScope"
  | "historyOwner"
  | "agentId"
  | "submissionStore"
> &
  Omit<ParentOwner, "turnId">;

type NativeMonitor = {
  registerParent(params: ParentRegistration): {
    bindTurn: (turnId: string) => void;
    unregister: () => Promise<void>;
  };
  retireParent(parentThreadId: string): void;
};

type NativeMonitorConstructor = new (
  client: NativeSubagentMonitorClient,
  runtime?: NativeSubagentMonitorRuntime,
  options?: MonitorOptions,
) => NativeMonitor;

export const defaultNativeSubagentMonitorRuntime: NativeSubagentMonitorRuntime = {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
};

export function createCodexNativeSubagentMonitorRuntime<T extends NativeMonitorConstructor>(
  Monitor: T,
) {
  const monitors = new WeakMap<CodexAppServerClient, NativeMonitor>();

  function registerMonitor(params: {
    client: CodexAppServerClient;
    parentThreadId: string;
    requesterSessionKey?: string;
    taskRuntimeScope?: ParentState["taskRuntimeScope"];
    historyOwner?: ParentState["historyOwner"];
    submissionStore?: ParentState["submissionStore"];
    agentId?: string;
    runtime?: NativeSubagentMonitorRuntime;
    retainClient?: () => (() => void) | undefined;
    retainParentThread?: (threadId: string) => (() => void) | undefined;
    claimDirectChild?: (threadId: string) => (() => void) | undefined;
    rejectPendingDirectChild?: (threadId: string, reason: string) => void;
    onDirectChildAccepted?: () => void;
  }): { bindTurn: (turnId: string) => void; unregister: () => Promise<void> } {
    let monitor = monitors.get(params.client);
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
      monitor = new Monitor(params.client, params.runtime ?? defaultNativeSubagentMonitorRuntime, {
        retainClient: params.retainClient,
        retainParentThread: params.retainParentThread,
        hasObservationBacking: (parentThreadId, childThreadId) =>
          hasCodexAppServerLiveThread(params.client, parentThreadId) ||
          hasCodexAppServerLiveThread(params.client, childThreadId),
        claimChildThread: (threadId) =>
          childThreadTransitions.enqueue(threadId, async () => {
            // Codex subscribes fresh children before thread/started; they have
            // no idle entry yet but must already be fenced from manual adoption.
            let ownership: CodexAppServerLiveThreadOwnership | undefined;
            let invalidated = false;
            ownership = await claimCodexAppServerLiveThread(params.client, threadId, () => {
              invalidated = true;
              if (childThreadOwnership.get(threadId) === ownership) {
                childThreadOwnership.delete(threadId);
              }
              ownership = undefined;
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
              retained = await retainCodexAppServerLiveThread(
                params.client,
                threadId,
                ownership.release,
              );
              return retained;
            } finally {
              // A full idle pool can reject terminal child ownership. Release
              // its exact branded claim before the monitor forgets that child.
              if (!retained) {
                await ownership.release(threadId);
                if (childThreadOwnership.get(threadId) === ownership) {
                  childThreadOwnership.delete(threadId);
                }
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
      monitors.set(params.client, monitor);
    }
    return monitor.registerParent({
      parentThreadId: params.parentThreadId,
      requesterSessionKey: params.requesterSessionKey,
      taskRuntimeScope: params.taskRuntimeScope,
      historyOwner: params.historyOwner,
      submissionStore: params.submissionStore,
      agentId: params.agentId,
      claimDirectChild: params.claimDirectChild,
      rejectPendingDirectChild: params.rejectPendingDirectChild,
      onDirectChildAccepted: params.onDirectChildAccepted,
    });
  }

  return {
    Monitor,
    register: registerMonitor,
    retireParent: (client: CodexAppServerClient, parentThreadId: string): void => {
      monitors.get(client)?.retireParent(parentThreadId);
    },
  };
}
