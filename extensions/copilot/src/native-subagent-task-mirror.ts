import type { SessionEvent } from "@github/copilot-sdk";
import {
  createAgentHarnessTaskRuntime,
  type AgentHarnessTaskRuntime,
  type AgentHarnessScopedFinalizeTaskRunParams,
  type AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";

const COPILOT_NATIVE_SUBAGENT_TASK_KIND = "copilot-native";
const COPILOT_NATIVE_SUBAGENT_RUN_ID_PREFIX = "copilot-agent:";

type CopilotNativeSubagentEvent = Extract<
  SessionEvent,
  { type: "subagent.started" | "subagent.completed" | "subagent.failed" }
>;

type TaskLifecycleRuntime = Pick<
  AgentHarnessTaskRuntime,
  "tryCreateRunningTaskRun" | "finalizeTaskRunByRunId" | "listTaskRecords"
>;

export function createCopilotNativeSubagentTaskMirror(params: {
  agentId?: string;
  now?: () => number;
  scope?: AgentHarnessTaskRuntimeScope;
}): CopilotNativeSubagentTaskMirror | undefined {
  if (!params.scope) {
    return undefined;
  }
  return new CopilotNativeSubagentTaskMirror(
    {
      agentId: params.agentId,
      now: params.now,
    },
    createAgentHarnessTaskRuntime({
      runtime: "subagent",
      taskKind: COPILOT_NATIVE_SUBAGENT_TASK_KIND,
      scope: params.scope,
      runIdPrefix: COPILOT_NATIVE_SUBAGENT_RUN_ID_PREFIX,
    }),
  );
}

class CopilotNativeSubagentTaskMirror {
  private readonly runIdByAgentId = new Map<string, string>();
  private readonly runIdByToolCallId = new Map<string, string>();
  private readonly activeRuns = new Map<
    string,
    { taskId: string; terminal?: AgentHarnessScopedFinalizeTaskRunParams }
  >();
  private readonly now: () => number;

  constructor(
    private readonly params: { agentId?: string; now?: () => number },
    private readonly runtime: TaskLifecycleRuntime,
  ) {
    this.now = params.now ?? Date.now;
  }

  handleEvent(event: CopilotNativeSubagentEvent): void {
    const toolCallId = event.data.toolCallId.trim();
    if (!toolCallId) {
      return;
    }
    const runId = this.resolveRunId(event);
    if (event.type === "subagent.started") {
      this.handleStarted(event, runId, toolCallId);
      return;
    }
    if (event.type === "subagent.completed") {
      this.handleCompleted(event, runId);
      return;
    }
    this.handleFailed(event, runId);
  }

  finalizeActiveRuns(): void {
    const eventAt = this.now();
    let failure: { error: unknown } | undefined;
    for (const runId of this.activeRuns.keys()) {
      try {
        this.finalizeRun({
          runId,
          status: "cancelled",
          endedAt: eventAt,
          lastEventAt: eventAt,
          error: "Subagent ended with its parent attempt.",
          progressSummary: "Subagent cancelled with its parent attempt.",
          terminalSummary: "Subagent cancelled.",
        });
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) {
      throw failure.error;
    }
  }

  private handleStarted(
    event: Extract<CopilotNativeSubagentEvent, { type: "subagent.started" }>,
    runId: string,
    toolCallId: string,
  ): void {
    const agentId = event.agentId?.trim();
    const existingRunId = agentId
      ? this.runIdByAgentId.get(agentId)
      : this.runIdByToolCallId.get(toolCallId);
    if (existingRunId) {
      return;
    }
    const eventAt = this.now();
    const label = event.data.agentDisplayName.trim() || event.data.agentName.trim();
    const task = event.data.agentDescription.trim() || `Subagent ${label}`;
    const taskRecord = this.runtime.tryCreateRunningTaskRun({
      sourceId: toolCallId,
      agentId: this.params.agentId,
      runId,
      label: label || "Subagent",
      task,
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: eventAt,
      lastEventAt: eventAt,
      progressSummary: "Subagent started.",
    });
    if (!taskRecord) {
      return;
    }
    if (agentId) {
      this.runIdByAgentId.set(agentId, runId);
    } else {
      this.runIdByToolCallId.set(toolCallId, runId);
    }
    this.activeRuns.set(runId, { taskId: taskRecord.taskId });
  }

  private handleCompleted(
    event: Extract<CopilotNativeSubagentEvent, { type: "subagent.completed" }>,
    runId: string,
  ): void {
    const eventAt = this.now();
    this.finalizeRun({
      runId,
      status: "succeeded",
      endedAt: eventAt,
      lastEventAt: eventAt,
      progressSummary: "Subagent completed.",
      terminalSummary: buildCompletionSummary(event),
    });
  }

  private handleFailed(
    event: Extract<CopilotNativeSubagentEvent, { type: "subagent.failed" }>,
    runId: string,
  ): void {
    const eventAt = this.now();
    this.finalizeRun({
      runId,
      status: "failed",
      endedAt: eventAt,
      lastEventAt: eventAt,
      error: event.data.error,
      progressSummary: "Subagent failed.",
      terminalSummary: "Subagent failed.",
    });
  }

  private finalizeRun(params: AgentHarnessScopedFinalizeTaskRunParams): void {
    const run = this.activeRuns.get(params.runId);
    if (!run) {
      return;
    }
    // A failed projection keeps its observed result; teardown must not replace it with cancellation.
    run.terminal ??= params;
    const matchesRun = (task: { taskId: string; runId?: string }) =>
      task.taskId === run.taskId && task.runId === params.runId;
    const before = this.runtime.listTaskRecords().find(matchesRun);
    if (!before || (before.status !== "queued" && before.status !== "running")) {
      this.activeRuns.delete(params.runId);
      return;
    }
    const updated = this.runtime.finalizeTaskRunByRunId(run.terminal);
    const current = updated.find(matchesRun) ?? this.runtime.listTaskRecords().find(matchesRun);
    // An empty result can mean failed persistence or an authoritative retirement/status fence.
    if (current?.status === "queued" || current?.status === "running") {
      throw new Error(`Native subagent task finalization did not persist: ${params.runId}`);
    }
    this.activeRuns.delete(params.runId);
  }

  private resolveRunId(event: CopilotNativeSubagentEvent): string {
    const agentId = event.agentId?.trim();
    if (agentId) {
      const existing = this.runIdByAgentId.get(agentId);
      if (existing) {
        return existing;
      }
    }
    const existing = this.runIdByToolCallId.get(event.data.toolCallId);
    if (existing) {
      return existing;
    }
    const identity = agentId || event.data.toolCallId.trim();
    return `${COPILOT_NATIVE_SUBAGENT_RUN_ID_PREFIX}${identity}`;
  }
}

function buildCompletionSummary(
  event: Extract<CopilotNativeSubagentEvent, { type: "subagent.completed" }>,
): string {
  const details = [
    event.data.totalToolCalls !== undefined ? `${event.data.totalToolCalls} tool calls` : undefined,
    event.data.totalTokens !== undefined ? `${event.data.totalTokens} tokens` : undefined,
  ].filter((value): value is string => value !== undefined);
  return details.length > 0 ? `Subagent completed (${details.join(", ")}).` : "Subagent completed.";
}
