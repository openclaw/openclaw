import type { SessionEvent } from "@github/copilot-sdk";
import * as taskRuntimeSdk from "openclaw/plugin-sdk/agent-harness-task-runtime";
import type {
  AgentHarnessTaskAssignment,
  AgentHarnessTaskRuntime,
  AgentHarnessScopedFinalizeTaskRunParams,
  AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";

const COPILOT_NATIVE_SUBAGENT_TASK_KIND = "copilot-native";
const COPILOT_NATIVE_SUBAGENT_RUN_ID_PREFIX = "copilot-agent:";

type CopilotNativeSubagentEvent = Extract<
  SessionEvent,
  { type: "subagent.started" | "subagent.completed" | "subagent.failed" }
>;

type TaskLifecycleRuntime = Required<
  Pick<
    AgentHarnessTaskRuntime,
    | "assertTaskAssignmentSupported"
    | "createRunningTaskRunAsync"
    | "finalizeTaskRunByRunIdAsync"
    | "prepareTaskRunRead"
  >
> &
  Pick<
    typeof taskRuntimeSdk,
    "captureAgentHarnessTaskAssignment" | "matchesAgentHarnessTaskAssignment"
  >;

export function createCopilotNativeSubagentTaskMirror(params: {
  agentId?: string;
  now?: () => number;
  scope?: AgentHarnessTaskRuntimeScope;
}): CopilotNativeSubagentTaskMirror | undefined {
  if (!params.scope) {
    return undefined;
  }
  const runtime = taskRuntimeSdk.createAgentHarnessTaskRuntime({
    runtime: "subagent",
    taskKind: COPILOT_NATIVE_SUBAGENT_TASK_KIND,
    scope: params.scope,
    runIdPrefix: COPILOT_NATIVE_SUBAGENT_RUN_ID_PREFIX,
  });
  const assertTaskAssignmentSupported = runtime.assertTaskAssignmentSupported?.bind(runtime);
  const createRunningTaskRunAsync = runtime.createRunningTaskRunAsync?.bind(runtime);
  const finalizeTaskRunByRunIdAsync = runtime.finalizeTaskRunByRunIdAsync?.bind(runtime);
  const prepareTaskRunRead = runtime.prepareTaskRunRead?.bind(runtime);
  const captureAgentHarnessTaskAssignment = taskRuntimeSdk.captureAgentHarnessTaskAssignment;
  const matchesAgentHarnessTaskAssignment = taskRuntimeSdk.matchesAgentHarnessTaskAssignment;
  return new CopilotNativeSubagentTaskMirror(
    {
      agentId: params.agentId,
      now: params.now,
    },
    () => {
      // The advertised host floor predates native async task capabilities.
      if (
        !assertTaskAssignmentSupported ||
        !createRunningTaskRunAsync ||
        !finalizeTaskRunByRunIdAsync ||
        !prepareTaskRunRead ||
        !captureAgentHarnessTaskAssignment ||
        !matchesAgentHarnessTaskAssignment
      ) {
        throw new Error(
          "Copilot native task mirroring requires asynchronous exact-assignment persistence. Upgrade the OpenClaw host.",
        );
      }
      return {
        assertTaskAssignmentSupported,
        createRunningTaskRunAsync,
        finalizeTaskRunByRunIdAsync,
        prepareTaskRunRead,
        captureAgentHarnessTaskAssignment,
        matchesAgentHarnessTaskAssignment,
      };
    },
  );
}

class CopilotNativeSubagentTaskMirror {
  private readonly runIdByAgentId = new Map<string, string>();
  private readonly runIdByToolCallId = new Map<string, string>();
  private readonly activeRuns = new Map<
    string,
    { assignment: AgentHarnessTaskAssignment; terminal?: AgentHarnessScopedFinalizeTaskRunParams }
  >();
  private readonly failedStarts = new Map<string, { error: unknown }>();
  private readonly now: () => number;

  constructor(
    private readonly params: { agentId?: string; now?: () => number },
    private readonly getRuntime: () => TaskLifecycleRuntime,
  ) {
    this.now = params.now ?? Date.now;
  }

  async handleEvent(event: CopilotNativeSubagentEvent): Promise<void> {
    const toolCallId = event.data.toolCallId.trim();
    if (!toolCallId) {
      return;
    }
    const runId = this.resolveRunId(event);
    if (event.type === "subagent.started") {
      try {
        await this.handleStarted(event, runId, toolCallId);
        this.failedStarts.delete(runId);
      } catch (error) {
        this.failedStarts.set(runId, { error });
        throw error;
      }
      return;
    }
    if (event.type === "subagent.completed") {
      await this.handleCompleted(event, runId);
      return;
    }
    await this.handleFailed(event, runId);
  }

  async finalizeActiveRuns(): Promise<void> {
    const eventAt = this.now();
    let failure = this.failedStarts.values().next().value;
    for (const runId of this.activeRuns.keys()) {
      try {
        await this.finalizeRun({
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

  private async handleStarted(
    event: Extract<CopilotNativeSubagentEvent, { type: "subagent.started" }>,
    runId: string,
    toolCallId: string,
  ): Promise<void> {
    const agentId = event.agentId?.trim();
    const existingRunId = agentId
      ? this.runIdByAgentId.get(agentId)
      : this.runIdByToolCallId.get(toolCallId);
    if (existingRunId) {
      return;
    }
    const runtime = this.getRuntime();
    runtime.assertTaskAssignmentSupported();
    const eventAt = this.now();
    const label = event.data.agentDisplayName.trim() || event.data.agentName.trim();
    const task = event.data.agentDescription.trim() || `Subagent ${label}`;
    const taskRecord = await runtime.createRunningTaskRunAsync({
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
    if (agentId) {
      this.runIdByAgentId.set(agentId, runId);
    } else {
      this.runIdByToolCallId.set(toolCallId, runId);
    }
    this.activeRuns.set(runId, {
      assignment: runtime.captureAgentHarnessTaskAssignment(taskRecord),
    });
  }

  private async handleCompleted(
    event: Extract<CopilotNativeSubagentEvent, { type: "subagent.completed" }>,
    runId: string,
  ): Promise<void> {
    const eventAt = this.now();
    await this.finalizeRun({
      runId,
      status: "succeeded",
      endedAt: eventAt,
      lastEventAt: eventAt,
      progressSummary: "Subagent completed.",
      terminalSummary: buildCompletionSummary(event),
    });
  }

  private async handleFailed(
    event: Extract<CopilotNativeSubagentEvent, { type: "subagent.failed" }>,
    runId: string,
  ): Promise<void> {
    const eventAt = this.now();
    await this.finalizeRun({
      runId,
      status: "failed",
      endedAt: eventAt,
      lastEventAt: eventAt,
      error: event.data.error,
      progressSummary: "Subagent failed.",
      terminalSummary: "Subagent failed.",
    });
  }

  private async finalizeRun(params: AgentHarnessScopedFinalizeTaskRunParams): Promise<void> {
    const run = this.activeRuns.get(params.runId);
    if (!run) {
      return;
    }
    // A failed projection keeps its observed result; teardown must not replace it with cancellation.
    run.terminal ??= params;
    const runtime = this.getRuntime();
    const read = await runtime.prepareTaskRunRead(params.runId);
    const matchesRun = (
      task: Parameters<TaskLifecycleRuntime["matchesAgentHarnessTaskAssignment"]>[0],
    ) => runtime.matchesAgentHarnessTaskAssignment(task, run.assignment);
    const before = read().find(matchesRun);
    if (!before || (before.status !== "queued" && before.status !== "running")) {
      this.activeRuns.delete(params.runId);
      return;
    }
    const updated = await runtime.finalizeTaskRunByRunIdAsync({
      ...run.terminal,
      expectedTask: run.assignment,
    });
    const current = updated.find(matchesRun) ?? read().find(matchesRun);
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
