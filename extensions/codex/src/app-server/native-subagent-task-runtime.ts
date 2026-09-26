import type {
  ChildState,
  NativeSubagentMonitorRuntime,
  ParentState,
} from "./native-subagent-monitor-types.js";
import type { NativeParentRegistration } from "./native-subagent-parent-owner.js";
import {
  CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
  CODEX_NATIVE_SUBAGENT_RUNTIME,
  CODEX_NATIVE_SUBAGENT_TASK_KIND,
} from "./native-subagent-task-ids.js";

/** Transfer presentation only after successful yield; the monitor retains lifecycle ownership. */
export function authorizeNativeSubagentProgress(params: {
  parent: ParentState;
  registration: NativeParentRegistration;
  owner: symbol;
  children: Map<string, ChildState>;
  runtime: NativeSubagentMonitorRuntime;
  executionPid?: number;
  isRegistered: () => boolean;
  isCurrentParent: () => boolean;
  prune: () => void;
}): void {
  const { parent, registration } = params;
  if (
    !params.isRegistered() ||
    !params.isCurrentParent() ||
    parent.owners.size !== 1 ||
    !parent.owners.has(params.owner) ||
    !registration.taskRuntimeScope
  ) {
    return;
  }
  parent.progressOwner?.dispose();
  const runtime = params.runtime.createAgentHarnessTaskRuntime({
    runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
    taskKind: CODEX_NATIVE_SUBAGENT_TASK_KIND,
    scope: registration.taskRuntimeScope,
    runIdPrefix: CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
    executionPid: params.executionPid,
  });
  const children = [...params.children.values()]
    .filter((child) => child.parentThreadId === parent.parentThreadId && !child.terminal)
    .map((child) => ({ child, runId: child.runId }));
  if (children.length === 0) {
    return;
  }
  const owner = {
    notify: () => {
      // Authorization precedes foreground teardown. Do not enqueue until detached.
      if (parent.owners.size === 0) {
        progress?.notify();
      }
    },
    dispose: () => progress?.dispose(),
  };
  const progress = runtime.registerProgressOwner?.({
    runIds: children.map(({ runId }) => runId),
    agentId: registration.agentId,
    isCurrent: (): boolean =>
      params.isCurrentParent() &&
      parent.progressOwner === owner &&
      parent.owners.size === 0 &&
      children.every(({ child, runId }) => {
        const current = params.children.get(runId);
        return (
          child.runId === runId &&
          child.parentThreadId === parent.parentThreadId &&
          (current === child || (!current && child.terminal))
        );
      }),
    onStopped: () => {
      if (parent.progressOwner === owner) {
        parent.progressOwner = undefined;
        params.prune();
      }
    },
  });
  parent.progressOwner = progress ? owner : undefined;
}
