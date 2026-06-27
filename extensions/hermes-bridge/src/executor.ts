import type { HermesBridgeConfig, HermesBridgeMode } from "./config.js";
import { createAuditEvent, createHermesBridgeResult } from "./schema.js";
import { getHermesBridgeTask } from "./task-registry.js";
import type { HermesBridgeRequest, HermesBridgeResult } from "./types.js";

type ExecuteParams = {
  config: HermesBridgeConfig;
  request: HermesBridgeRequest;
};

function reject(params: {
  request?: HermesBridgeRequest;
  type: string;
  message: string;
  status?: HermesBridgeResult["status"];
  mode?: HermesBridgeMode;
}): HermesBridgeResult {
  return createHermesBridgeResult({
    ok: false,
    request: params.request,
    mode: params.mode ?? "mock",
    status: params.status ?? "blocked",
    summary: params.message,
    error: {
      type: params.type,
      message: params.message,
    },
    auditLog: [createAuditEvent("rejected", params.message)],
  });
}

export async function executeHermesBridgeTask({
  config,
  request,
}: ExecuteParams): Promise<HermesBridgeResult> {
  const task = getHermesBridgeTask(request.taskId);
  if (!task) {
    return reject({
      request,
      type: "unknown_task",
      message: `Unknown Hermes bridge task: ${request.taskId}`,
      status: "failed",
    });
  }
  if (!config.allowedTasks.includes(request.taskId)) {
    return reject({
      request,
      type: "task_not_allowed",
      message: `Hermes bridge task is not allowlisted: ${request.taskId}`,
    });
  }
  const configDeniedTools = task.requiredTools.filter(
    (tool) => !config.allowedTools.includes(tool),
  );
  const requestDeniedTools = task.requiredTools.filter(
    (tool) => !request.allowedTools.includes(tool),
  );
  if (configDeniedTools.length > 0 || requestDeniedTools.length > 0) {
    const missing = Array.from(new Set([...configDeniedTools, ...requestDeniedTools])).toSorted();
    return reject({
      request,
      type: "tool_not_allowed",
      message: `Hermes bridge task requires unallowlisted tool(s): ${missing.join(", ")}`,
    });
  }
  if (task.dangerous && !request.requiresConfirmation) {
    return reject({
      request,
      type: "confirmation_required",
      message: `Hermes bridge task requires explicit confirmation: ${request.taskId}`,
      status: "needs_confirmation",
    });
  }
  if (task.requiresDryRun && !request.dryRun) {
    return reject({
      request,
      type: "dry_run_required",
      message: `Hermes bridge task requires dryRun=true: ${request.taskId}`,
      status: "blocked",
    });
  }
  if (config.hermesMode === "real" && task.mockOnly && !request.dryRun) {
    return reject({
      request,
      type: "real_task_unavailable",
      message: "Hermes real mode is configured, but this task has only a mock/dry-run executor.",
      status: "blocked",
      mode: config.mode,
    });
  }

  const effectiveMode: HermesBridgeMode = task.mockOnly ? "mock" : config.mode;
  const output = await task.execute({ request, mode: effectiveMode });
  return createHermesBridgeResult({
    ok: true,
    request,
    mode: effectiveMode,
    status: "succeeded",
    summary: task.successSummary ?? `Hermes bridge task succeeded: ${request.taskId}`,
    output,
    auditLog: [
      createAuditEvent("accepted", `Accepted Hermes task ${request.taskId}.`),
      createAuditEvent(
        "executed",
        `Executed Hermes task ${request.taskId} in ${effectiveMode} mode.`,
      ),
    ],
  });
}
