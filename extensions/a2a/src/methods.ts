import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import {
  contentTypeNotSupported,
  extendedCardNotConfigured,
  invalidParams,
  pushNotificationsUnsupported,
  taskNotFound,
  unsupportedOperation,
} from "./a2a-errors.js";
import {
  isInterruptedTaskState,
  isTerminalTaskState,
  type A2aPushNotificationConfig,
  type A2aStreamResponse,
  type A2aTask,
} from "./a2a-model.js";
import { buildA2aAgentCard, type A2aResolvedCapabilities } from "./agent-card.js";
import type { A2aChannelConfig } from "./config-schema.js";
import { dispatchA2aInbound } from "./inbound.js";
import {
  A2aCancelTaskParamsSchema,
  A2aDeleteTaskPushNotificationConfigParamsSchema,
  A2aGetTaskPushNotificationConfigParamsSchema,
  A2aListTaskPushNotificationConfigsParamsSchema,
  A2aListTasksParamsSchema,
  A2aPushNotificationConfigSchema,
  A2aSendMessageParamsSchema,
  A2aSubscribeToTaskParamsSchema,
  A2aTaskRequestParamsSchema,
  describeA2aMessageParts,
  extractA2aMessageText,
  findUnsupportedA2aPartMediaType,
  type A2aResolvedMethod,
} from "./protocol.js";
import type { A2aPushConfigStore } from "./push-config-store.js";
import { projectTask, type A2aTaskStore } from "./task-store.js";
import type { ResolvedA2aChannelAccount } from "./types.js";

export type A2aMethodContext = {
  account: ResolvedA2aChannelAccount;
  config: OpenClawConfig;
  a2aConfig: A2aChannelConfig;
  channelRuntime: PluginRuntime["channel"];
  store: A2aTaskStore;
  pushConfigs: A2aPushConfigStore;
  capabilities: A2aResolvedCapabilities;
  peerName: string;
  version: string;
  request: IncomingMessage;
  /** Bounds a blocking `SendMessage` wait. */
  replyTimeoutMs: number;
  /** Bounds a single SSE stream so a stalled task cannot pin the response. */
  streamTimeoutMs: number;
  /** Registers a webhook supplied inline with `SendMessage`. */
  registerInlinePushConfig: (taskId: string, config: A2aPushNotificationConfig) => void;
};

/** Reject a method whose Agent Card capability is disabled (spec §3.3.4). */
function assertCapability(ctx: A2aMethodContext, method: A2aResolvedMethod): void {
  if (!method.capability) {
    return;
  }
  if (ctx.capabilities[method.capability]) {
    return;
  }
  // §3.3.4: an undeclared capability is UnsupportedOperation for streaming and
  // the extended card. Push notifications are the one exception, with their own
  // dedicated error, so peers can tell "not implemented" from "implemented but
  // disabled" apart for the webhook surface specifically.
  if (method.capability === "pushNotifications") {
    throw pushNotificationsUnsupported();
  }
  throw unsupportedOperation(
    `${method.method} requires a capability that is not enabled; ` +
      (method.capability === "extendedAgentCard"
        ? "enable channels.a2a.capabilities.extendedAgentCard"
        : "enable channels.a2a.capabilities.streaming"),
  );
}

/**
 * Parse `SendMessage` params and resolve (or create) the target task.
 *
 * Returning the task separately from dispatching lets the streaming and
 * blocking paths share one admission path, so a task can never be admitted by
 * one binding and rejected by the other.
 */
function admitSendMessage(
  ctx: A2aMethodContext,
  params: unknown,
): {
  task: A2aTask;
  text: string;
  messageId: string;
  historyLength: number | undefined;
  pushConfig: A2aPushNotificationConfig | undefined;
  returnImmediately: boolean;
  /** Whether this message is new work for the agent, or a replay of one already admitted. */
  dispatch: boolean;
  resumed: boolean;
} {
  const send = A2aSendMessageParamsSchema.safeParse(params);
  if (!send.success) {
    throw invalidParams("Invalid SendMessage params: message and parts required");
  }
  const message = send.data.message;
  // Media-type validation precedes the text-part requirement (§3.1.1): a
  // message whose file part is in a format the agent cannot ingest is a
  // content-type problem, not a "missing prompt" problem, and the two have
  // different error codes.
  const unsupportedMedia = findUnsupportedA2aPartMediaType(
    message.parts,
    ctx.a2aConfig.inputModes ?? ["text/plain"],
  );
  if (unsupportedMedia !== undefined) {
    throw contentTypeNotSupported(
      `Message part media type ${unsupportedMedia} is not supported; ` +
        `this agent accepts ${(ctx.a2aConfig.inputModes ?? ["text/plain"]).join(", ")}`,
      { mediaType: unsupportedMedia },
    );
  }
  const textParts = extractA2aMessageText(message.parts);
  if (!textParts) {
    // A file-only message has no prompt content: inline bytes and file URLs have
    // no textual form, so it is rejected rather than silently emptied.
    throw invalidParams("Message must contain at least one usable text part");
  }
  // File parts ride along as annotations on the text prompt.
  const fileNotes = describeA2aMessageParts(message.parts);
  const text = [textParts, ...fileNotes]
    .filter((entry) => entry?.trim())
    .join("\n")
    .trim();

  const referencedTaskId = message.taskId;
  if (referencedTaskId !== undefined) {
    const referenced = ctx.store.get(referencedTaskId, ctx.peerName);
    if (!referenced) {
      throw taskNotFound("Task not found", referencedTaskId);
    }
    if (message.contextId !== undefined && message.contextId !== referenced.contextId) {
      throw invalidParams("Message contextId does not match the referenced task");
    }
    if (isTerminalTaskState(referenced.status.state)) {
      throw unsupportedOperation(
        `Task ${referencedTaskId} is in terminal state ${referenced.status.state} and cannot accept new messages`,
      );
    }
    if (!isInterruptedTaskState(referenced.status.state)) {
      // A second run cannot be attached to an in-flight task, and there is no
      // plugin-facing abort seam to detach the first one.
      throw unsupportedOperation(
        "Task is still running; wait for it to reach a terminal or interrupted state before sending a follow-up",
      );
    }
    const messageId = message.messageId ?? randomUUID();
    // Answering an `input-required` / `auth-required` task resumes the same task
    // and runs another turn on the same session.
    ctx.store.resume(referenced.id);
    ctx.store.appendHistory(referenced.id, {
      messageId,
      ...(message.contextId ? { contextId: message.contextId } : {}),
      role: "ROLE_USER",
      // SAFETY: both schemas accept the same wire `Part` union.
      parts: message.parts as A2aTask["history"][number]["parts"],
    });
    return {
      task: referenced,
      text,
      messageId,
      historyLength: send.data.configuration?.historyLength,
      pushConfig: undefined,
      returnImmediately: send.data.configuration?.returnImmediately === true,
      dispatch: true,
      resumed: true,
    };
  }

  const messageId = message.messageId ?? randomUUID();
  const task = ctx.store.create(
    message.contextId ?? `ctx-${randomUUID()}`,
    ctx.peerName,
    messageId,
  );
  if (message.metadata && Object.keys(message.metadata).length > 0) {
    task.metadata = { ...task.metadata, ...message.metadata };
  }
  // `create` returns the existing task for a replayed messageId, so guard the
  // history append: a replay must stay byte-identical to the first response.
  if (!task.history.some((entry) => entry.messageId === messageId)) {
    ctx.store.appendHistory(task.id, {
      messageId,
      ...(message.contextId ? { contextId: message.contextId } : {}),
      role: "ROLE_USER",
      // SAFETY: both schemas accept the same wire `Part` union.
      parts: message.parts as A2aTask["history"][number]["parts"],
    });
  }

  const inline = send.data.configuration?.taskPushNotificationConfig;
  const pushConfig = inline
    ? ({
        id: inline.id ?? randomUUID(),
        // `taskId` is intentionally empty in SendMessage requests; it is the
        // newly created task that owns the registration.
        taskId: task.id,
        url: inline.url,
        ...(inline.tenant ? { tenant: inline.tenant } : {}),
        ...(inline.token ? { token: inline.token } : {}),
        ...(inline.authentication ? { authentication: inline.authentication } : {}),
      } satisfies A2aPushNotificationConfig)
    : undefined;

  // `start` only advances a SUBMITTED task, so a replayed messageId (which
  // resolves to the task already created for it) is not dispatched twice.
  const started = ctx.store.start(task.id);
  return {
    task,
    text,
    messageId,
    historyLength: send.data.configuration?.historyLength,
    pushConfig,
    returnImmediately: send.data.configuration?.returnImmediately === true,
    dispatch: started !== undefined,
    resumed: false,
  };
}

/**
 * Hand the admitted task to the agent.
 *
 * Dispatch runs detached so the HTTP request can release its admission root;
 * the store resolves waiters and streams when the task settles.
 */
function dispatchTask(
  ctx: A2aMethodContext,
  params: { task: A2aTask; text: string; messageId: string; dispatch: boolean },
): void {
  if (!params.dispatch) {
    return;
  }
  void runDetachedWebhookWork(async () => {
    await dispatchA2aInbound({
      account: ctx.account,
      config: ctx.config,
      channelRuntime: ctx.channelRuntime,
      store: ctx.store,
      taskId: params.task.id,
      contextId: params.task.contextId,
      messageId: params.messageId,
      peerName: ctx.peerName,
      text: params.text,
    });
  }).catch((error: unknown) => ctx.store.fail(params.task.id, error));
}

async function settleTask(ctx: A2aMethodContext, task: A2aTask): Promise<A2aTask> {
  const timeoutMs = ctx.a2aConfig.replyTimeoutMs ?? ctx.replyTimeoutMs;
  return ctx.store.wait(task, timeoutMs);
}

export async function executeA2aMethod(
  ctx: A2aMethodContext,
  resolved: A2aResolvedMethod,
  requestParams: unknown,
): Promise<unknown> {
  assertCapability(ctx, resolved);

  switch (resolved.method) {
    case "SendMessage": {
      const admitted = admitSendMessage(ctx, requestParams);
      if (admitted.pushConfig) {
        ctx.registerInlinePushConfig(admitted.task.id, admitted.pushConfig);
      }
      dispatchTask(ctx, admitted);
      // Blocking mode is the default (spec §3.1.1): wait for a terminal or
      // interrupted state unless the peer asked for the task back immediately.
      const settled = admitted.returnImmediately
        ? (ctx.store.get(admitted.task.id, ctx.peerName) ?? admitted.task)
        : await settleTask(ctx, admitted.task);
      return { task: projectTask(settled, admitted.historyLength, true) };
    }

    case "GetTask": {
      const parsed = A2aTaskRequestParamsSchema.safeParse(requestParams);
      if (!parsed.success) {
        throw invalidParams("Invalid task params: id is required");
      }
      const task = ctx.store.get(parsed.data.id, ctx.peerName);
      if (!task) {
        throw taskNotFound("Task not found", parsed.data.id);
      }
      // `includeArtifacts` is a ListTasks concept; GetTask returns the full task.
      return projectTask(task, parsed.data.historyLength, true);
    }

    case "ListTasks": {
      const parsed = A2aListTasksParamsSchema.safeParse(requestParams ?? {});
      if (!parsed.success) {
        throw invalidParams("Invalid ListTasks params");
      }
      return ctx.store.listTasks({
        ownerPeer: ctx.peerName,
        ...(parsed.data.contextId !== undefined ? { contextId: parsed.data.contextId } : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(parsed.data.statusTimestampAfter
          ? { statusTimestampAfter: parsed.data.statusTimestampAfter }
          : {}),
        ...(parsed.data.pageSize !== undefined ? { pageSize: parsed.data.pageSize } : {}),
        ...(parsed.data.pageToken ? { pageToken: parsed.data.pageToken } : {}),
        ...(parsed.data.historyLength !== undefined
          ? { historyLength: parsed.data.historyLength }
          : {}),
        includeArtifacts: parsed.data.includeArtifacts === true,
      });
    }

    case "CancelTask": {
      const parsed = A2aCancelTaskParamsSchema.safeParse(requestParams);
      if (!parsed.success) {
        throw invalidParams("Invalid task params: id is required");
      }
      return ctx.store.cancel(parsed.data.id, ctx.peerName);
    }

    case "CreateTaskPushNotificationConfig": {
      const parsed = A2aPushNotificationConfigSchema.safeParse(requestParams);
      if (!parsed.success) {
        throw invalidParams("Invalid push notification config: taskId and url are required");
      }
      const task = ctx.store.get(parsed.data.taskId, ctx.peerName);
      if (!task) {
        throw taskNotFound("Task not found", parsed.data.taskId);
      }
      return ctx.pushConfigs.create(ctx.peerName, {
        taskId: parsed.data.taskId,
        url: parsed.data.url,
        ...(parsed.data.id ? { id: parsed.data.id } : {}),
        ...(parsed.data.tenant ? { tenant: parsed.data.tenant } : {}),
        ...(parsed.data.token ? { token: parsed.data.token } : {}),
        ...(parsed.data.authentication ? { authentication: parsed.data.authentication } : {}),
      });
    }

    case "GetTaskPushNotificationConfig": {
      const parsed = A2aGetTaskPushNotificationConfigParamsSchema.safeParse(requestParams);
      if (!parsed.success) {
        throw invalidParams("Invalid params: taskId and id are required");
      }
      return ctx.pushConfigs.get(ctx.peerName, parsed.data.taskId, parsed.data.id);
    }

    case "ListTaskPushNotificationConfigs": {
      const parsed = A2aListTaskPushNotificationConfigsParamsSchema.safeParse(requestParams);
      if (!parsed.success) {
        throw invalidParams("Invalid params: taskId is required");
      }
      return ctx.pushConfigs.list(ctx.peerName, parsed.data.taskId, {
        ...(parsed.data.pageSize !== undefined ? { pageSize: parsed.data.pageSize } : {}),
        ...(parsed.data.pageToken ? { pageToken: parsed.data.pageToken } : {}),
      });
    }

    case "DeleteTaskPushNotificationConfig": {
      const parsed = A2aDeleteTaskPushNotificationConfigParamsSchema.safeParse(requestParams);
      if (!parsed.success) {
        throw invalidParams("Invalid params: taskId and id are required");
      }
      ctx.pushConfigs.delete(ctx.peerName, parsed.data.taskId, parsed.data.id);
      // The specification maps this to `google.protobuf.Empty`: JSON-RPC `null`.
      return null;
    }

    case "GetExtendedAgentCard":
      // §3.3.4 draws a line the capability check cannot: an operator may
      // declare extendedAgentCard support and still never author card text.
      // Declaring support and serving an empty extension is worse than
      // refusing, so the un-configured case gets its own error.
      if (!Object.keys(ctx.a2aConfig.extendedSkillDescriptions ?? {}).length) {
        throw extendedCardNotConfigured();
      }
      return buildA2aAgentCard({
        config: ctx.config,
        a2aConfig: ctx.a2aConfig,
        version: ctx.version,
        request: ctx.request,
        capabilities: ctx.capabilities,
        extended: true,
      });

    default:
      // Streaming methods (`SendStreamingMessage` / `SubscribeToTask`) are served
      // by `streamA2aMethod`; reaching here means a caller tried to execute them
      // as a unary request.
      throw unsupportedOperation(`${resolved.method} must be delivered as a streaming request`);
  }
}

/**
 * Stream task updates for `SendStreamingMessage` / `SubscribeToTask`.
 *
 * `SendStreamingMessage` first admits and dispatches the task, then streams;
 * `SubscribeToTask` only attaches to an existing task (spec §3.1.6).
 */
export async function* streamA2aMethod(
  ctx: A2aMethodContext,
  resolved: A2aResolvedMethod,
  requestParams: unknown,
): AsyncGenerator<A2aStreamResponse> {
  assertCapability(ctx, resolved);

  if (resolved.method === "SubscribeToTask") {
    const parsed = A2aSubscribeToTaskParamsSchema.safeParse(requestParams);
    if (!parsed.success) {
      throw invalidParams("Invalid SubscribeToTask params: id is required");
    }
    const existing = ctx.store.get(parsed.data.id, ctx.peerName);
    if (!existing) {
      throw taskNotFound("Task not found", parsed.data.id);
    }
    if (isTerminalTaskState(existing.status.state)) {
      throw unsupportedOperation(
        `Task ${parsed.data.id} is already in terminal state ${existing.status.state}`,
      );
    }
    yield* ctx.store.stream(parsed.data.id, ctx.peerName, { timeoutMs: ctx.streamTimeoutMs });
    return;
  }

  const admitted = admitSendMessage(ctx, requestParams);
  if (admitted.pushConfig) {
    ctx.registerInlinePushConfig(admitted.task.id, admitted.pushConfig);
  }
  // The mailbox is reserved at task creation, so events produced between here and
  // the first `next()` are replayed rather than lost.
  dispatchTask(ctx, admitted);
  yield* ctx.store.stream(admitted.task.id, ctx.peerName, { timeoutMs: ctx.streamTimeoutMs });
}
