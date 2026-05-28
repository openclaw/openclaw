import type { OpenClawConfig } from "../runtime-api.js";
import type { TaskFlowWebhookTarget } from "./http.js";
import {
  formatZodError,
  webhookActionSchema,
  type WebhookAction,
} from "./taskflow-action-schema.js";
import type { JsonValue } from "./template.js";

type FlowView = {
  flowId: string;
  syncMode: "task_mirrored" | "managed";
  controllerId?: string;
  revision: number;
  status: string;
  notifyPolicy: string;
  goal: string;
  currentStep?: string;
  blockedTaskId?: string;
  blockedSummary?: string;
  stateJson?: JsonValue;
  waitJson?: JsonValue;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};

type TaskView = {
  taskId: string;
  runtime: string;
  sourceId?: string;
  scopeKind: string;
  childSessionKey?: string;
  parentFlowId?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  status: string;
  deliveryStatus: string;
  notifyPolicy: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: string;
};

function pickOptionalFields<T extends object, TKey extends keyof T & string>(
  source: T,
  keys: readonly TKey[],
): Partial<Pick<T, TKey>> {
  const result: Partial<Pick<T, TKey>> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function pickOptionalTruthyStringFields<T extends object, TKey extends keyof T & string>(
  source: T,
  keys: readonly TKey[],
): Partial<Pick<T, TKey>> {
  const result: Partial<Pick<T, TKey>> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value) {
      result[key] = value as T[TKey];
    }
  }
  return result;
}

export function toFlowView(flow: FlowView): FlowView {
  return {
    flowId: flow.flowId,
    syncMode: flow.syncMode,
    ...pickOptionalTruthyStringFields(flow, [
      "controllerId",
      "currentStep",
      "blockedTaskId",
      "blockedSummary",
    ]),
    revision: flow.revision,
    status: flow.status,
    notifyPolicy: flow.notifyPolicy,
    goal: flow.goal,
    ...pickOptionalFields(flow, ["stateJson", "waitJson", "cancelRequestedAt"]),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    ...pickOptionalFields(flow, ["endedAt"]),
  };
}

export function toTaskView(task: TaskView): TaskView {
  return {
    taskId: task.taskId,
    runtime: task.runtime,
    ...pickOptionalTruthyStringFields(task, [
      "sourceId",
      "childSessionKey",
      "parentFlowId",
      "parentTaskId",
      "agentId",
      "runId",
      "label",
      "error",
      "progressSummary",
      "terminalSummary",
      "terminalOutcome",
    ]),
    scopeKind: task.scopeKind,
    task: task.task,
    status: task.status,
    deliveryStatus: task.deliveryStatus,
    notifyPolicy: task.notifyPolicy,
    createdAt: task.createdAt,
    ...pickOptionalFields(task, ["startedAt", "endedAt", "lastEventAt", "cleanupAfter"]),
  };
}

function mapMutationResult(
  result:
    | {
        applied: true;
        flow: FlowView;
      }
    | {
        applied: false;
        code: string;
        current?: FlowView;
      },
): unknown {
  return result;
}

function mapFlowMutationResult(
  result:
    | {
        applied: true;
        flow: Parameters<typeof toFlowView>[0];
      }
    | {
        applied: false;
        code: string;
        current?: Parameters<typeof toFlowView>[0];
      },
): unknown {
  return mapMutationResult(
    result.applied
      ? { applied: true, flow: toFlowView(result.flow) }
      : {
          applied: false,
          code: result.code,
          ...(result.current ? { current: toFlowView(result.current) } : {}),
        },
  );
}

function mapMutationStatus(result: {
  applied: boolean;
  code?: "not_found" | "not_managed" | "revision_conflict";
}): { statusCode: number; code?: string; error?: string } {
  if (result.applied) {
    return { statusCode: 200 };
  }
  switch (result.code) {
    case "not_found":
      return { statusCode: 404, code: "not_found", error: "TaskFlow not found." };
    case "not_managed":
      return {
        statusCode: 409,
        code: "not_managed",
        error: "TaskFlow is not managed by this webhook surface.",
      };
    case "revision_conflict":
      return {
        statusCode: 409,
        code: "revision_conflict",
        error: "TaskFlow changed since the caller's expected revision.",
      };
    default:
      return {
        statusCode: 409,
        code: "mutation_rejected",
        error: "TaskFlow mutation was rejected.",
      };
  }
}

function mapRunTaskStatus(result: { created: boolean; found: boolean; reason?: string }): {
  statusCode: number;
  code?: string;
  error?: string;
} {
  if (result.created) {
    return { statusCode: 200 };
  }
  if (!result.found) {
    return { statusCode: 404, code: "not_found", error: "TaskFlow not found." };
  }
  if (result.reason === "Flow cancellation has already been requested.") {
    return { statusCode: 409, code: "cancel_requested", error: result.reason };
  }
  if (result.reason === "Flow does not accept managed child tasks.") {
    return { statusCode: 409, code: "not_managed", error: result.reason };
  }
  if (result.reason?.startsWith("Flow is already ")) {
    return { statusCode: 409, code: "terminal", error: result.reason };
  }
  return {
    statusCode: 409,
    code: "task_not_created",
    error: result.reason ?? "TaskFlow task was not created.",
  };
}

function mapCancelStatus(result: { found: boolean; cancelled: boolean; reason?: string }): {
  statusCode: number;
  code?: string;
  error?: string;
} {
  if (result.cancelled) {
    return { statusCode: 200 };
  }
  if (!result.found) {
    return { statusCode: 404, code: "not_found", error: "TaskFlow not found." };
  }
  if (result.reason === "One or more child tasks are still active.") {
    return { statusCode: 202, code: "cancel_pending", error: result.reason };
  }
  if (result.reason === "Flow changed while cancellation was in progress.") {
    return { statusCode: 409, code: "revision_conflict", error: result.reason };
  }
  if (result.reason?.startsWith("Flow is already ")) {
    return { statusCode: 409, code: "terminal", error: result.reason };
  }
  return {
    statusCode: 409,
    code: "cancel_rejected",
    error: result.reason ?? "TaskFlow cancellation was rejected.",
  };
}

function describeWebhookOutcome(params: { action: WebhookAction; result: unknown }): {
  statusCode: number;
  code?: string;
  error?: string;
} {
  switch (params.action.action) {
    case "set_waiting":
    case "resume_flow":
    case "finish_flow":
    case "fail_flow":
    case "request_cancel":
      return mapMutationStatus(
        params.result as {
          applied: boolean;
          code?: "not_found" | "not_managed" | "revision_conflict";
        },
      );
    case "cancel_flow":
      return mapCancelStatus(
        params.result as {
          found: boolean;
          cancelled: boolean;
          reason?: string;
        },
      );
    case "run_task":
      return mapRunTaskStatus(
        params.result as {
          created: boolean;
          found: boolean;
          reason?: string;
        },
      );
    default:
      return { statusCode: 200 };
  }
}

async function executeWebhookAction(params: {
  action: WebhookAction;
  target: TaskFlowWebhookTarget;
  cfg: OpenClawConfig;
}): Promise<unknown> {
  const { action, target } = params;
  switch (action.action) {
    case "create_flow": {
      const flow = target.taskFlow.createManaged({
        controllerId: action.controllerId ?? target.defaultControllerId,
        goal: action.goal,
        status: action.status,
        notifyPolicy: action.notifyPolicy,
        currentStep: action.currentStep ?? undefined,
        stateJson: action.stateJson,
        waitJson: action.waitJson,
      });
      return { flow: toFlowView(flow) };
    }
    case "get_flow": {
      const flow = target.taskFlow.get(action.flowId);
      return { flow: flow ? toFlowView(flow) : null };
    }
    case "list_flows":
      return { flows: target.taskFlow.list().map(toFlowView) };
    case "find_latest_flow": {
      const flow = target.taskFlow.findLatest();
      return { flow: flow ? toFlowView(flow) : null };
    }
    case "resolve_flow": {
      const flow = target.taskFlow.resolve(action.token);
      return { flow: flow ? toFlowView(flow) : null };
    }
    case "get_task_summary":
      return { summary: target.taskFlow.getTaskSummary(action.flowId) ?? null };
    case "set_waiting":
      return mapFlowMutationResult(
        target.taskFlow.setWaiting({
          flowId: action.flowId,
          expectedRevision: action.expectedRevision,
          currentStep: action.currentStep,
          stateJson: action.stateJson,
          waitJson: action.waitJson,
          blockedTaskId: action.blockedTaskId,
          blockedSummary: action.blockedSummary,
        }),
      );
    case "resume_flow":
      return mapFlowMutationResult(
        target.taskFlow.resume({
          flowId: action.flowId,
          expectedRevision: action.expectedRevision,
          status: action.status,
          currentStep: action.currentStep,
          stateJson: action.stateJson,
        }),
      );
    case "finish_flow":
      return mapFlowMutationResult(
        target.taskFlow.finish({
          flowId: action.flowId,
          expectedRevision: action.expectedRevision,
          stateJson: action.stateJson,
        }),
      );
    case "fail_flow":
      return mapFlowMutationResult(
        target.taskFlow.fail({
          flowId: action.flowId,
          expectedRevision: action.expectedRevision,
          stateJson: action.stateJson,
          blockedTaskId: action.blockedTaskId,
          blockedSummary: action.blockedSummary,
        }),
      );
    case "request_cancel":
      return mapFlowMutationResult(
        target.taskFlow.requestCancel({
          flowId: action.flowId,
          expectedRevision: action.expectedRevision,
        }),
      );
    case "cancel_flow": {
      const result = await target.taskFlow.cancel({
        flowId: action.flowId,
        cfg: params.cfg,
      });
      return {
        found: result.found,
        cancelled: result.cancelled,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.flow ? { flow: toFlowView(result.flow) } : {}),
        ...(result.tasks ? { tasks: result.tasks.map(toTaskView) } : {}),
      };
    }
    case "run_task": {
      const result = target.taskFlow.runTask({
        flowId: action.flowId,
        runtime: action.runtime,
        sourceId: action.sourceId,
        childSessionKey: action.childSessionKey,
        parentTaskId: action.parentTaskId,
        agentId: action.agentId,
        runId: action.runId,
        label: action.label,
        task: action.task,
        preferMetadata: action.preferMetadata,
        notifyPolicy: action.notifyPolicy,
        status: action.status,
        startedAt: action.startedAt,
        lastEventAt: action.lastEventAt,
        progressSummary: action.progressSummary,
      });
      if (result.created) {
        return {
          created: true,
          flow: toFlowView(result.flow),
          task: toTaskView(result.task),
        };
      }
      return {
        found: result.found,
        created: false,
        reason: result.reason,
        ...(result.flow ? { flow: toFlowView(result.flow) } : {}),
      };
    }
  }
  throw new Error("Unsupported webhook action");
}

export async function executeTaskFlowActionDispatch(params: {
  body: unknown;
  target: TaskFlowWebhookTarget;
  cfg: OpenClawConfig;
}): Promise<{ statusCode: number; body: unknown }> {
  const parsed = webhookActionSchema.safeParse(params.body);
  if (!parsed.success) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        code: "invalid_request",
        error: formatZodError(parsed.error),
      },
    };
  }

  const result = await executeWebhookAction({
    action: parsed.data,
    target: params.target,
    cfg: params.cfg,
  });
  const outcome = describeWebhookOutcome({
    action: parsed.data,
    result,
  });
  return {
    statusCode: outcome.statusCode,
    body:
      outcome.statusCode < 400
        ? {
            ok: true,
            routeId: params.target.routeId,
            ...(outcome.code ? { code: outcome.code } : {}),
            result,
          }
        : {
            ok: false,
            routeId: params.target.routeId,
            code: outcome.code ?? "request_rejected",
            error: outcome.error ?? "request rejected",
            result,
          },
  };
}
