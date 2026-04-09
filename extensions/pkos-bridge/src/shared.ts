import type { ResolvedPkosBridgeConfig } from "./config.js";

export function formatConfiguredPath(label: string, value?: string): string {
  return `${label}: ${value ?? "(unset)"}`;
}

export function buildBridgeStatusText(config: ResolvedPkosBridgeConfig): string {
  return [
    "PKOS bridge scaffold is active.",
    formatConfiguredPath("pkosRoot", config.pkosRoot),
    formatConfiguredPath("workbenchRoot", config.workbenchRoot),
    formatConfiguredPath("traceBundleRoot", config.traceBundleRoot),
    `http.basePath: ${config.http.basePath}`,
    "Bridge scope: task handoff, trace ingestion, review intake.",
  ].join("\n");
}

export function buildTaskHandoffDraft(params: {
  taskId: string;
  goal: string;
  expectedOutput: string;
  constraints: string[];
  handoffBackWhen: string;
}): Record<string, unknown> {
  return {
    task_id: params.taskId,
    goal: params.goal,
    expected_output: params.expectedOutput,
    constraints: params.constraints,
    handoff_back_when: params.handoffBackWhen,
    status: "draft",
    target: "workbench",
    contract: "mvp-minimal-task-handoff",
  };
}

export function buildTraceBundleReceipt(params: {
  runId: string;
  taskId?: string;
  traceBundlePath: string;
  summary?: string;
}): Record<string, unknown> {
  return {
    run_id: params.runId,
    task_id: params.taskId,
    trace_bundle_path: params.traceBundlePath,
    summary: params.summary,
    status: "accepted-placeholder",
    next_step: "review_intake",
  };
}
