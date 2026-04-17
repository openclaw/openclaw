/**
 * A2A gateway method handlers, plugin-local.
 *
 * These handlers own the gateway RPC surface for a2a.task.* methods.
 * They delegate to the standalone a2a-broker HTTP endpoint directly,
 * keeping zero core imports (extension boundary compliant).
 */
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import {
  createConfiguredA2ABrokerClient,
  resolveA2ABrokerAdapterPluginConfig,
  type A2ABrokerAdapterPluginRuntimeConfig,
} from "../config.js";
import {
  A2ABrokerClientError,
  buildBrokerCreateTaskRequestFromOpenClaw,
  type A2ABrokerPartyRef,
  type A2ABrokerTaskRecord,
} from "../standalone-broker-client.js";
import type {
  A2ATaskCancelParams,
  A2ATaskRequestParams,
  A2ATaskStatusParams,
  A2ATaskUpdateParams,
} from "./gateway-schema.js";
import {
  validateA2ATaskCancelParams,
  validateA2ATaskRequestParams,
  validateA2ATaskStatusParams,
  validateA2ATaskUpdateParams,
  validateParams,
} from "./gateway-validators.js";
import { a2aError, A2AErrorCodes } from "./plugin-errors.js";

type RawBrokerClient = ReturnType<typeof createConfiguredA2ABrokerClient>;

type BrokerClient = {
  requestTask(params: A2ATaskRequestParams): Promise<unknown>;
  updateTask(params: A2ATaskUpdateParams): Promise<unknown>;
  cancelTask(params: A2ATaskCancelParams): Promise<unknown>;
  statusTask(params: A2ATaskStatusParams): Promise<unknown>;
};

export function createA2AGatewayBrokerClient(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  deps: {
    createRawBrokerClient?: (config: A2ABrokerAdapterPluginRuntimeConfig) => RawBrokerClient;
  } = {},
): BrokerClient {
  const rawClient = deps.createRawBrokerClient?.(config) ?? createConfiguredA2ABrokerClient(config);
  const resolvedConfig = resolveA2ABrokerAdapterPluginConfig(config);

  return {
    async requestTask(params: A2ATaskRequestParams): Promise<unknown> {
      const request = params.request;
      const brokerTask = await rawClient.createTask(
        buildBrokerCreateTaskRequestFromOpenClaw({
          taskId: normalizeString(request.taskId),
          waitRunId: normalizeString(request.runtime?.waitRunId),
          correlationId: normalizeString(request.correlationId),
          parentRunId: normalizeString(request.parentRunId),
          requesterSessionKey:
            normalizeString(request.requester?.sessionKey) ?? normalizeString(params.sessionKey),
          requesterChannel: normalizeString(request.requester?.channel),
          targetNodeId:
            normalizeString(request.target.displayKey) ??
            normalizeString(request.target.sessionKey),
          targetSessionKey: request.target.sessionKey,
          targetDisplayKey: request.target.displayKey,
          originalMessage: request.task.instructions,
          roundOneReply: normalizeString(request.runtime?.roundOneReply),
          announceTimeoutMs:
            request.runtime?.announceTimeoutMs ??
            Math.max(0, (request.constraints?.timeoutSeconds ?? 30) * 1000),
          maxPingPongTurns:
            request.runtime?.maxPingPongTurns ?? request.constraints?.maxPingPongTurns ?? 0,
          cancelTarget: request.runtime?.cancelTarget,
        }),
      );
      return buildGatewayTaskResult("a2a.task.request", brokerTask);
    },

    async updateTask(params: A2ATaskUpdateParams): Promise<unknown> {
      const brokerTask = await getBrokerTask(rawClient, params.update.taskId);
      if (!brokerTask) {
        return undefined;
      }
      const nextTask = await applyBrokerTaskUpdate({
        rawClient,
        brokerTask,
        update: params.update,
        requester: resolvedConfig.requester,
      });
      return buildGatewayTaskResult("a2a.task.update", nextTask);
    },

    async cancelTask(params: A2ATaskCancelParams): Promise<unknown> {
      const brokerTask = await getBrokerTask(rawClient, params.cancel.taskId);
      if (!brokerTask) {
        return undefined;
      }
      const actor = resolvedConfig.requester ??
        brokerTask.requester ?? {
          id: params.sessionKey,
          kind: "session",
          role: "hub",
        };
      const canceledTask = await rawClient.cancelTask(params.cancel.taskId, {
        actor,
        ...(normalizeString(params.cancel.reason)
          ? { reason: normalizeString(params.cancel.reason) }
          : {}),
      });
      return buildGatewayTaskResult("a2a.task.cancel", canceledTask);
    },

    async statusTask(params: A2ATaskStatusParams): Promise<unknown> {
      const brokerTask = await getBrokerTask(rawClient, params.taskId);
      if (!brokerTask) {
        return undefined;
      }
      return buildGatewayTaskStatus(brokerTask);
    },
  };
}

export function createA2AGatewayHandlers(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  deps: {
    createBrokerClient?: (config: A2ABrokerAdapterPluginRuntimeConfig) => BrokerClient | null;
  } = {},
) {
  let brokerClient: BrokerClient | null | undefined;
  let brokerClientError: Error | undefined;

  function getBrokerClient(): BrokerClient | null {
    if (brokerClient !== undefined) {
      return brokerClient;
    }
    try {
      brokerClient = deps.createBrokerClient?.(config) ?? createA2AGatewayBrokerClient(config);
      brokerClientError = undefined;
    } catch (error) {
      brokerClient = null;
      brokerClientError = error instanceof Error ? error : new Error(String(error));
    }
    return brokerClient;
  }

  function respondBrokerUnavailable(opts: GatewayRequestHandlerOptions): void {
    const message = brokerClientError?.message ?? "a2a broker client not initialized";
    opts.respond(false, undefined, a2aError(A2AErrorCodes.NOT_FOUND, message));
  }

  return {
    handleA2ATaskRequest: async (opts: GatewayRequestHandlerOptions): Promise<void> => {
      const check = validateParams(opts.params, validateA2ATaskRequestParams, "a2a.task.request");
      if (!check.valid) {
        opts.respond(false, undefined, check.error);
        return;
      }
      const broker = getBrokerClient();
      if (!broker) {
        respondBrokerUnavailable(opts);
        return;
      }
      try {
        const result = await broker.requestTask(check.data);
        opts.respond(true, result);
      } catch (err) {
        const error = toGatewayError(err);
        opts.respond(
          false,
          undefined,
          a2aError(A2AErrorCodes.INTERNAL, `a2a.task.request failed: ${error}`),
        );
      }
    },

    handleA2ATaskUpdate: async (opts: GatewayRequestHandlerOptions): Promise<void> => {
      const check = validateParams(opts.params, validateA2ATaskUpdateParams, "a2a.task.update");
      if (!check.valid) {
        opts.respond(false, undefined, check.error);
        return;
      }
      const broker = getBrokerClient();
      if (!broker) {
        respondBrokerUnavailable(opts);
        return;
      }
      try {
        const result = await broker.updateTask(check.data);
        if (result == null) {
          opts.respond(
            false,
            undefined,
            a2aError(A2AErrorCodes.NOT_FOUND, `a2a task not found: ${check.data.update.taskId}`),
          );
          return;
        }
        opts.respond(true, result);
      } catch (err) {
        const error = toGatewayError(err);
        opts.respond(
          false,
          undefined,
          a2aError(A2AErrorCodes.INVALID_REQUEST, `a2a.task.update failed: ${error}`),
        );
      }
    },

    handleA2ATaskCancel: async (opts: GatewayRequestHandlerOptions): Promise<void> => {
      const check = validateParams(opts.params, validateA2ATaskCancelParams, "a2a.task.cancel");
      if (!check.valid) {
        opts.respond(false, undefined, check.error);
        return;
      }
      const broker = getBrokerClient();
      if (!broker) {
        respondBrokerUnavailable(opts);
        return;
      }
      try {
        const result = await broker.cancelTask(check.data);
        if (result == null) {
          opts.respond(
            false,
            undefined,
            a2aError(A2AErrorCodes.NOT_FOUND, `a2a task not found: ${check.data.cancel.taskId}`),
          );
          return;
        }
        opts.respond(true, result);
      } catch (err) {
        const error = toGatewayError(err);
        opts.respond(
          false,
          undefined,
          a2aError(A2AErrorCodes.INVALID_REQUEST, `a2a.task.cancel failed: ${error}`),
        );
      }
    },

    handleA2ATaskStatus: async (opts: GatewayRequestHandlerOptions): Promise<void> => {
      const check = validateParams(opts.params, validateA2ATaskStatusParams, "a2a.task.status");
      if (!check.valid) {
        opts.respond(false, undefined, check.error);
        return;
      }
      const broker = getBrokerClient();
      if (!broker) {
        respondBrokerUnavailable(opts);
        return;
      }
      try {
        const result = await broker.statusTask(check.data);
        if (result == null) {
          opts.respond(
            false,
            undefined,
            a2aError(A2AErrorCodes.NOT_FOUND, `a2a task not found: ${check.data.taskId}`),
          );
          return;
        }
        opts.respond(true, result);
      } catch (err) {
        const error = toGatewayError(err);
        opts.respond(
          false,
          undefined,
          a2aError(A2AErrorCodes.INTERNAL, `a2a.task.status failed: ${error}`),
        );
      }
    },
  };
}

type GatewayTaskMethod = "a2a.task.request" | "a2a.task.update" | "a2a.task.cancel";

async function getBrokerTask(
  rawClient: RawBrokerClient,
  taskId: string,
): Promise<A2ABrokerTaskRecord | undefined> {
  try {
    return await rawClient.getTask(taskId);
  } catch (error) {
    if (error instanceof A2ABrokerClientError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function applyBrokerTaskUpdate(params: {
  rawClient: RawBrokerClient;
  brokerTask: A2ABrokerTaskRecord;
  update: A2ATaskUpdateParams["update"];
  requester?: A2ABrokerPartyRef;
}): Promise<A2ABrokerTaskRecord> {
  const executionStatus = params.update.executionStatus;
  if (!executionStatus) {
    return params.brokerTask;
  }

  switch (executionStatus) {
    case "accepted": {
      if (params.brokerTask.status !== "queued") {
        return params.brokerTask;
      }
      return await params.rawClient.claimTask(params.brokerTask.id, {
        workerId: resolveWorkerId(params.brokerTask, params.requester),
      });
    }

    case "running": {
      const claimedTask = await ensureBrokerTaskClaimed(params);
      if (claimedTask.status !== "claimed") {
        return claimedTask;
      }
      return await params.rawClient.startTask(claimedTask.id, {
        workerId: resolveWorkerId(claimedTask, params.requester),
      });
    }

    case "completed": {
      const activeTask = await ensureBrokerTaskStarted(params);
      if (activeTask.status === "succeeded") {
        return activeTask;
      }
      return await params.rawClient.completeTask(activeTask.id, {
        workerId: resolveWorkerId(activeTask, params.requester),
        ...(buildBrokerResult(params.update) ? { result: buildBrokerResult(params.update) } : {}),
      });
    }

    case "failed":
    case "timed_out": {
      const activeTask = await ensureBrokerTaskStarted(params);
      if (activeTask.status === "failed") {
        return activeTask;
      }
      return await params.rawClient.failTask(activeTask.id, {
        workerId: resolveWorkerId(activeTask, params.requester),
        error: buildBrokerError(params.update),
      });
    }

    case "waiting_reply":
    case "waiting_external":
    default:
      return params.brokerTask;
  }
}

async function ensureBrokerTaskClaimed(params: {
  rawClient: RawBrokerClient;
  brokerTask: A2ABrokerTaskRecord;
  requester?: A2ABrokerPartyRef;
}): Promise<A2ABrokerTaskRecord> {
  if (params.brokerTask.status !== "queued") {
    return params.brokerTask;
  }
  return await params.rawClient.claimTask(params.brokerTask.id, {
    workerId: resolveWorkerId(params.brokerTask, params.requester),
  });
}

async function ensureBrokerTaskStarted(params: {
  rawClient: RawBrokerClient;
  brokerTask: A2ABrokerTaskRecord;
  requester?: A2ABrokerPartyRef;
}): Promise<A2ABrokerTaskRecord> {
  const claimedTask = await ensureBrokerTaskClaimed(params);
  if (claimedTask.status !== "claimed") {
    return claimedTask;
  }
  return await params.rawClient.startTask(claimedTask.id, {
    workerId: resolveWorkerId(claimedTask, params.requester),
  });
}

function resolveWorkerId(brokerTask: A2ABrokerTaskRecord, requester?: A2ABrokerPartyRef): string {
  const workerId =
    normalizeString(requester?.id) ??
    normalizeString(brokerTask.claimedBy) ??
    normalizeString(brokerTask.assignedWorkerId) ??
    normalizeString(brokerTask.targetNodeId);
  if (!workerId) {
    throw new Error(`workerId is required to update broker task ${brokerTask.id}`);
  }
  return workerId;
}

function buildBrokerResult(
  update: A2ATaskUpdateParams["update"],
): Record<string, unknown> | undefined {
  const summary = normalizeString(update.summary);
  const output = normalizeUnknownRecord(update.output);
  if (!summary && output === undefined) {
    return undefined;
  }
  return {
    ...(summary ? { summary } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

function buildBrokerError(update: A2ATaskUpdateParams["update"]): {
  code?: string;
  message: string;
} {
  const message =
    normalizeString(update.error?.message) ??
    normalizeString(update.summary) ??
    (update.executionStatus === "timed_out" ? "task timed out" : "task failed");
  const code =
    normalizeString(update.error?.code) ??
    (update.executionStatus === "timed_out" ? "timed_out" : undefined);
  return {
    ...(code ? { code } : {}),
    message,
  };
}

function buildGatewayTaskResult(
  method: GatewayTaskMethod,
  brokerTask: A2ABrokerTaskRecord,
): unknown {
  const status = buildGatewayTaskStatus(brokerTask);
  if (method === "a2a.task.cancel") {
    return {
      method,
      abortStatus: brokerTask.status === "canceled" ? "aborted" : "not-attempted",
      ...status,
    };
  }
  return {
    method,
    ...status,
  };
}

function buildGatewayTaskStatus(brokerTask: A2ABrokerTaskRecord): Record<string, unknown> {
  const payload = readBrokerTaskPayload(brokerTask);
  const requester = buildRequesterRef(payload, brokerTask);
  const target = buildTargetRef(payload, brokerTask);
  const summary =
    normalizeString(brokerTask.result?.summary) ?? normalizeString(brokerTask.result?.note);
  const output = buildGatewayTaskOutput(brokerTask);
  const error = buildGatewayTaskError(brokerTask);

  return {
    taskId: brokerTask.id,
    ...(payload.correlationId ? { correlationId: payload.correlationId } : {}),
    ...(payload.parentRunId ? { parentRunId: payload.parentRunId } : {}),
    ...(requester ? { requester } : {}),
    target,
    executionStatus: mapBrokerStatusToExecutionStatus(brokerTask),
    deliveryStatus: mapBrokerStatusToDeliveryStatus(brokerTask.status),
    ...(summary ? { summary } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(error ? { error } : {}),
    updatedAt: toEpochMs(brokerTask.updatedAt),
    ...(brokerTask.claimedAt ? { startedAt: toEpochMs(brokerTask.claimedAt) } : {}),
    hasHeartbeat: false,
  };
}

function buildRequesterRef(
  payload: ReturnType<typeof readBrokerTaskPayload>,
  brokerTask: A2ABrokerTaskRecord,
) {
  const sessionKey =
    payload.requesterSessionKey ??
    (brokerTask.requester.kind === "session" ? brokerTask.requester.id : undefined);
  if (!sessionKey) {
    return undefined;
  }
  return {
    sessionKey,
    displayKey: sessionKey,
    ...(payload.requesterChannel ? { channel: payload.requesterChannel } : {}),
  };
}

function buildTargetRef(
  payload: ReturnType<typeof readBrokerTaskPayload>,
  brokerTask: A2ABrokerTaskRecord,
) {
  const sessionKey = payload.targetSessionKey ?? brokerTask.target.id;
  return {
    sessionKey,
    displayKey: payload.targetDisplayKey ?? sessionKey,
  };
}

function buildGatewayTaskOutput(brokerTask: A2ABrokerTaskRecord): unknown {
  const result = brokerTask.result;
  if (!result) {
    return undefined;
  }
  const output: Record<string, unknown> = {
    ...normalizeUnknownRecord(result.output),
    ...(normalizeString(result.note) ? { note: normalizeString(result.note) } : {}),
    ...(result.artifactIds?.length ? { artifactIds: result.artifactIds } : {}),
    ...(result.validation ? { validation: result.validation } : {}),
    ...(result.apply ? { apply: result.apply } : {}),
    status: brokerTask.status,
  };
  return Object.keys(output).length > 0 ? output : undefined;
}

function buildGatewayTaskError(
  brokerTask: A2ABrokerTaskRecord,
): { code: string; message?: string } | undefined {
  if (!brokerTask.error?.code && !brokerTask.error?.message) {
    return undefined;
  }
  return {
    code: normalizeString(brokerTask.error?.code) ?? "remote_task_failed",
    ...(normalizeString(brokerTask.error?.message)
      ? { message: normalizeString(brokerTask.error?.message) }
      : {}),
  };
}

function mapBrokerStatusToExecutionStatus(
  brokerTask: A2ABrokerTaskRecord,
): "accepted" | "running" | "completed" | "failed" | "cancelled" | "timed_out" {
  switch (brokerTask.status) {
    case "queued":
    case "claimed":
      return "accepted";
    case "running":
      return "running";
    case "succeeded":
      return "completed";
    case "failed":
      return isTimeoutCode(brokerTask.error?.code) ? "timed_out" : "failed";
    case "canceled":
      return "cancelled";
    default:
      return "failed";
  }
}

function mapBrokerStatusToDeliveryStatus(
  status: A2ABrokerTaskRecord["status"],
): "pending" | "skipped" {
  switch (status) {
    case "queued":
    case "claimed":
    case "running":
      return "pending";
    default:
      return "skipped";
  }
}

function isTimeoutCode(code: string | undefined): boolean {
  const normalized = normalizeString(code)?.toLowerCase();
  return normalized === "timeout" || normalized === "timed_out" || normalized === "broker_timeout";
}

function readBrokerTaskPayload(brokerTask: A2ABrokerTaskRecord): {
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey?: string;
  targetDisplayKey?: string;
  correlationId?: string;
  parentRunId?: string;
} {
  const payload = brokerTask.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const record = payload;
  return {
    requesterSessionKey: readOptionalRecordString(record, "requesterSessionKey"),
    requesterChannel: readOptionalRecordString(record, "requesterChannel"),
    targetSessionKey: readOptionalRecordString(record, "targetSessionKey"),
    targetDisplayKey: readOptionalRecordString(record, "targetDisplayKey"),
    correlationId: readOptionalRecordString(record, "correlationId"),
    parentRunId: readOptionalRecordString(record, "parentRunId"),
  };
}

function readOptionalRecordString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function toEpochMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function toGatewayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
