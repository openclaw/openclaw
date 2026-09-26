import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionCloseReason,
  CliBackendLiveSessionHandle,
  CliBackendToolPermissionResult,
} from "openclaw/plugin-sdk/cli-backend";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { hasClaudeRawToolInvocation } from "./cli-output.js";
import type { ClaudeCliSecretInput } from "./cli-process.js";
import { prepareClaudeCliTransportArgs } from "./cli-runtime-args.js";
import { createClaudeCliTransport, writeClaudeCliSettingsFile } from "./cli-transport.js";
import { createClaudeCliUserInputAuthorizer } from "./cli-user-input.js";

const IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
// Claude Code emits interim results while these run, then delivers their answers
// in later results under the same admitted turn.
const RESULT_HOLDING_TASK_TYPES = new Set(["local_agent", "local_workflow"]);
// Explicit background commands may never finish. Only Bash tasks that started
// in the foreground and later entered the background list hold their turn.
const TIMEOUT_BACKGROUNDED_TASK_TYPE = "local_bash";

function readReplayedTaskId(
  message: Record<string, unknown>,
  inputUuid: string,
): string | undefined {
  if (
    message.type !== "user" ||
    message.isReplay !== true ||
    message.parent_tool_use_id !== null ||
    message.uuid === inputUuid ||
    !isRecord(message.message)
  ) {
    return undefined;
  }
  // Before Claude Code 2.1.274, inline notification receipts omitted origin.
  if (
    message.origin !== undefined &&
    (!isRecord(message.origin) ||
      message.origin.kind !== "task-notification" ||
      message.origin.subkind !== undefined)
  ) {
    return undefined;
  }
  const content = message.message.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  const text =
    typeof content === "string"
      ? content
      : isRecord(first) && first.type === "text" && typeof first.text === "string"
        ? first.text
        : "";
  return /^<task-notification>\s*<task-id>([^<]+)<\/task-id>/u.exec(text)?.[1];
}

/** Background work whose final answer Claude Code delivers in a later result. */
function hasResultHoldingBackgroundTasks(session: ClaudeCliSession, turn: ClaudeCliTurn): boolean {
  return session.hasBackgroundTasks || turn.pendingBackgroundTaskIds.size > 0;
}

type ClaudeCliTurn = {
  context: CliBackendExecuteContext;
  controller: AbortController;
  userInput: ReturnType<typeof createClaudeCliUserInputAuthorizer>;
  events: PassThrough;
  inputUuid: string;
  inputStarted: boolean;
  sawTerminalResult: boolean;
  foregroundTaskIds: Set<string>;
  pendingBackgroundTaskIds: Set<string>;
  error?: Error;
};
type ClaudeCliSession = {
  handle: CliBackendLiveSessionHandle;
  capability?: CliBackendLiveSessionCapability;
  transport?: ReturnType<typeof createClaudeCliTransport>;
  currentTurn?: ClaudeCliTurn;
  idleTimer?: ReturnType<typeof setTimeout>;
  hasBackgroundTasks: boolean;
  hasInputLifecycle: boolean;
  closed: boolean;
};
const sessions = new WeakMap<CliBackendLiveSessionHandle, ClaudeCliSession>();

function activeTurn(session: ClaudeCliSession): ClaudeCliTurn | undefined {
  const turn = session.currentTurn;
  if (!turn || turn.controller.signal.aborted || turn.context.abortSignal?.aborted) {
    return undefined;
  }
  // A warm child can emit prior-input callbacks while the next admitted input is queued.
  if (session.hasInputLifecycle && !turn.inputStarted) {
    return undefined;
  }
  try {
    turn.context.assertCurrent?.();
    return turn;
  } catch {
    return undefined;
  }
}

async function authorizeTool(
  session: ClaudeCliSession,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CliBackendToolPermissionResult> {
  const turn = activeTurn(session);
  const input = request.input;
  const toolName = request.tool_name;
  if (!turn || signal.aborted || typeof toolName !== "string" || !isRecord(input)) {
    return {
      behavior: "deny",
      message: "The OpenClaw run or native tool input is no longer valid.",
    };
  }
  const toolUseId = typeof request.tool_use_id === "string" ? request.tool_use_id : undefined;
  const abortSignal = AbortSignal.any([signal, turn.controller.signal]);
  try {
    const decision =
      toolName === "AskUserQuestion"
        ? await turn.userInput.authorize({ input, signal: abortSignal, toolUseId })
        : await turn.context.requestToolPermission({
            toolName,
            toolInput: input,
            cwd: typeof request.cwd === "string" ? request.cwd : undefined,
            toolCallId: toolUseId,
            abortSignal,
          });
    // An operator decision can outlive its turn. Revalidate immediately before granting it.
    if (activeTurn(session) !== turn || abortSignal.aborted) {
      return { behavior: "deny", message: "The OpenClaw run is no longer active." };
    }
    return decision;
  } catch {
    return { behavior: "deny", message: "OpenClaw could not authorize this tool call." };
  }
}

async function handleRequest(
  session: ClaudeCliSession,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  if (request.subtype === "can_use_tool") {
    return { ...(await authorizeTool(session, request, signal)), toolUseID: request.tool_use_id };
  }
  if (request.subtype !== "hook_callback" || !isRecord(request.input)) {
    throw new Error("Unsupported Claude CLI control request.");
  }
  const input = request.input;
  const turn = activeTurn(session);
  if (request.callback_id === "UserPromptSubmit" && input.hook_event_name === "UserPromptSubmit") {
    if (!turn || signal.aborted) {
      return {};
    }
    const additionalContext = [
      turn.context.promptContext?.prependContext,
      turn.context.promptContext?.appendContext,
    ]
      .filter(Boolean)
      .join("\n\n");
    // Native can rewrite the prompt and rerun hooks; only its final pass is persisted.
    return additionalContext
      ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }
      : {};
  }
  if (request.callback_id === "PreToolUse" && input.hook_event_name === "PreToolUse") {
    if (
      turn &&
      !signal.aborted &&
      typeof input.tool_name === "string" &&
      input.tool_name.startsWith("mcp__openclaw__")
    ) {
      return { continue: true };
    }
    // Native settings can grant tools before can_use_tool. This hook preserves host policy.
    const decision = await authorizeTool(
      session,
      {
        tool_name: input.tool_name,
        input: input.tool_input,
        cwd: input.cwd,
        tool_use_id: request.tool_use_id ?? input.tool_use_id,
      },
      signal,
    );
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.behavior,
        ...(decision.behavior === "allow"
          ? { updatedInput: decision.updatedInput }
          : { permissionDecisionReason: decision.message }),
      },
    };
  }
  throw new Error("Unknown Claude CLI hook callback.");
}

function closeSession(
  session: ClaudeCliSession,
  _reason: CliBackendLiveSessionCloseReason,
  error?: unknown,
) {
  if (session.closed) {
    return;
  }
  session.closed = true;
  clearTimeout(session.idleTimer);
  session.capability?.remove(session.handle);
  const turn = session.currentTurn;
  session.currentTurn = undefined;
  if (turn) {
    turn.error = toErrorObject(error, "Claude CLI live session closed.");
    turn.controller.abort();
    turn.events.end();
  }
  session.transport?.close();
}

function completeTurn(session: ClaudeCliSession, turn: ClaudeCliTurn) {
  const holdsBackgroundTasks = hasResultHoldingBackgroundTasks(session, turn);
  session.currentTurn = undefined;
  turn.controller.abort();
  turn.events.end();
  if (!session.capability || holdsBackgroundTasks) {
    // A failed parent does not stop native background continuations. Never lend them a new turn.
    session.handle.close(holdsBackgroundTasks ? "abort" : "idle");
  } else {
    session.idleTimer = setTimeout(() => session.handle.close("idle"), IDLE_TIMEOUT_MS);
    session.idleTimer.unref();
  }
}

async function acceptMessage(session: ClaudeCliSession, message: Record<string, unknown>) {
  if (message.type === "system" && message.subtype === "init") {
    session.hasInputLifecycle =
      Array.isArray(message.capabilities) && message.capabilities.includes("msg_lifecycle_v1");
  }
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  if (message.type === "command_lifecycle") {
    if (message.state === "started" && message.command_uuid === turn.inputUuid) {
      turn.inputStarted = true;
    }
    return;
  }
  // Newer CLI builds identify the submitted input; ignore replayed prior-turn output.
  if (
    session.hasInputLifecycle &&
    !turn.inputStarted &&
    !(message.type === "system" && message.subtype === "init")
  ) {
    return;
  }
  if (message.type === "system" && message.subtype === "task_started") {
    // task_type is optional here; the background task list names it later.
    if (
      typeof message.task_id === "string" &&
      message.task_id &&
      message.is_backgrounded === false
    ) {
      turn.foregroundTaskIds.add(message.task_id);
    }
  }
  if (message.type === "system" && message.subtype === "background_tasks_changed") {
    session.hasBackgroundTasks = false;
    for (const task of Array.isArray(message.tasks) ? message.tasks : []) {
      if (!isRecord(task) || typeof task.task_id !== "string" || !task.task_id) {
        continue;
      }
      if (typeof task.task_type === "string" && RESULT_HOLDING_TASK_TYPES.has(task.task_type)) {
        session.hasBackgroundTasks = true;
      } else if (
        task.task_type === TIMEOUT_BACKGROUNDED_TASK_TYPE &&
        turn.foregroundTaskIds.has(task.task_id)
      ) {
        turn.pendingBackgroundTaskIds.add(task.task_id);
      }
    }
  }
  // Completion events precede notification delivery. Its replay receipt means
  // Claude consumed it, either in the running query or in a later query.
  if (turn.pendingBackgroundTaskIds.size > 0) {
    const taskId = readReplayedTaskId(message, turn.inputUuid);
    if (taskId && turn.pendingBackgroundTaskIds.delete(taskId)) {
      turn.foregroundTaskIds.delete(taskId);
    }
  }
  let completesTurn = false;
  if (message.type === "result") {
    // A batched notification can acknowledge input without running the model.
    const queuedContinuation =
      turn.sawTerminalResult &&
      isRecord(message.origin) &&
      message.origin.kind === "task-notification" &&
      message.origin.subkind === undefined &&
      message.num_turns === 0 &&
      message.result === "" &&
      message.stop_reason === null &&
      message.terminal_reason === undefined;
    turn.sawTerminalResult = true;
    // Background work holds successful interim results, never terminal failures.
    completesTurn =
      (!hasResultHoldingBackgroundTasks(session, turn) && !queuedContinuation) ||
      message.is_error === true ||
      (typeof message.subtype === "string" && message.subtype.startsWith("error")) ||
      (typeof message.result === "string" && hasClaudeRawToolInvocation(message.result));
  }
  // The transport owns continuation lifetime; the completed answer can be
  // delivered through normal reply hooks without waiting for the children.
  const outputMessage =
    message.type === "result" && !completesTurn
      ? { ...message, openclaw_interim_result: true }
      : message;
  if (!turn.events.write(outputMessage)) {
    await once(turn.events, "drain", { signal: turn.controller.signal });
  }
  if (completesTurn) {
    completeTurn(session, turn);
  }
}

function createSession(capability?: CliBackendLiveSessionCapability): ClaudeCliSession {
  const session: ClaudeCliSession = {
    capability,
    hasBackgroundTasks: false,
    hasInputLifecycle: false,
    closed: false,
    handle: {
      generation: randomUUID(),
      fingerprint: capability?.fingerprint ?? randomUUID(),
      isIdle: () => !session.closed && !session.currentTurn,
      close: (reason, error) => closeSession(session, reason, error),
      waitForExit: () => session.transport?.waitForExit() ?? Promise.resolve(),
    },
  };
  sessions.set(session.handle, session);
  capability?.register(session.handle);
  return session;
}

export async function* executeClaudeCli(
  context: CliBackendExecuteContext,
  secretInput?: ClaudeCliSecretInput,
): AsyncIterable<Record<string, unknown>> {
  context.assertCurrent?.();
  context.abortSignal?.throwIfAborted();
  const capability = context.liveSession;
  const existing = capability?.current();
  const reusable =
    existing && existing.fingerprint === capability?.fingerprint
      ? sessions.get(existing)
      : undefined;
  if (!reusable && capability) {
    await capability.restart();
  }
  context.assertCurrent?.();
  const session = reusable ?? createSession(capability);
  session.capability = capability;
  if (session.closed || session.currentTurn) {
    throw new Error("Claude CLI live session is closed or already handling another turn.");
  }
  clearTimeout(session.idleTimer);
  const turn: ClaudeCliTurn = {
    context,
    controller: new AbortController(),
    userInput: createClaudeCliUserInputAuthorizer(context),
    events: new PassThrough({ objectMode: true }),
    inputUuid: randomUUID(),
    inputStarted: false,
    sawTerminalResult: false,
    foregroundTaskIds: new Set(),
    pendingBackgroundTaskIds: new Set(),
  };
  session.currentTurn = turn;
  const abort = () => session.handle.close("abort", context.abortSignal?.reason);
  context.abortSignal?.addEventListener("abort", abort, { once: true });
  try {
    context.abortSignal?.throwIfAborted();
    // Adopt the process's exact MCP capture before prompt dispatch or native tool callbacks.
    capability?.activate(session.handle);
    if (!session.transport) {
      const { args, excludeDynamicSections, settings } = prepareClaudeCliTransportArgs(context);
      const settingsFile = settings && (await writeClaudeCliSettingsFile(settings));
      session.transport = createClaudeCliTransport({
        context,
        args,
        settingsFile,
        secretInput,
        currentContext: () => session.currentTurn?.context,
        initialize: {
          appendSystemPrompt: context.systemPrompt,
          excludeDynamicSections,
          hooks: {
            UserPromptSubmit: [{ hookCallbackIds: ["UserPromptSubmit"] }],
            PreToolUse: [{ hookCallbackIds: ["PreToolUse"] }],
          },
        },
        onMessage: (message) => acceptMessage(session, message),
        onRequest: async (request, signal) => {
          // No interactive MCP elicitation handler is registered; preserve its declined outcome.
          if (request.subtype === "elicitation") {
            return () => ({ action: "decline" });
          }
          const admittedTurn = activeTurn(session);
          const response = await handleRequest(session, request, signal);
          // The transport invokes this synchronously at its final write, after all awaits.
          return () => {
            if (admittedTurn && activeTurn(session) === admittedTurn && !signal.aborted) {
              return response;
            }
            const message = "The OpenClaw run is no longer active.";
            if (request.subtype === "can_use_tool") {
              return { behavior: "deny", message, toolUseID: request.tool_use_id };
            }
            return request.callback_id === "PreToolUse"
              ? {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: message,
                  },
                }
              : {};
          };
        },
        onError: (error) => session.handle.close("abort", error),
      });
      await session.transport.initialize();
    }
    context.assertCurrent?.();
    if (session.closed || session.currentTurn !== turn) {
      throw turn.error ?? new Error("Claude CLI closed before its prompt was accepted.");
    }
    await session.transport.send({
      type: "user",
      message: { role: "user", content: context.prompt },
      parent_tool_use_id: null,
      uuid: turn.inputUuid,
      ...(context.sessionId ? { session_id: context.sessionId } : {}),
    });
    for await (const record of turn.events) {
      yield record;
    }
    if (turn.error) {
      throw turn.error;
    }
    if (!turn.sawTerminalResult) {
      throw new Error("Claude CLI exited without a terminal result.");
    }
  } catch (error) {
    session.handle.close("abort", error);
    throw error;
  } finally {
    turn.controller.abort();
    context.abortSignal?.removeEventListener("abort", abort);
    // Iterator.return() is cancellation too; a partially consumed turn cannot stay warm.
    if (session.currentTurn === turn) {
      session.handle.close("abort");
    }
    if (session.closed) {
      await session.handle.waitForExit();
    }
  }
}
