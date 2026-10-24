import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
  CliBackendToolPermissionResult,
} from "openclaw/plugin-sdk/cli-backend";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { hasClaudeRawToolInvocation } from "./cli-output.js";
import type { ClaudeCliSecretInput } from "./cli-process.js";
import { prepareClaudeCliTransportArgs } from "./cli-runtime-args.js";
import { readReplayedTaskId, recordTaskOwnership } from "./cli-runtime-tasks.js";
import { createClaudeCliTransport } from "./cli-transport.js";
import { createClaudeCliUserInputAuthorizer } from "./cli-user-input.js";

const IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Host-internal, like the forwarded auth credential and not part of the plugin SDK: a host
 * whose history owner can change while the run lasts (a native login) passes a check for
 * where saved turn context leaves after startup, the prompt send and the prompt hook answer.
 */
export type ClaudeCliExecuteContext = CliBackendExecuteContext & {
  assertPrivateInputCurrent?: () => void;
};
type ClaudeCliTurn = {
  context: ClaudeCliExecuteContext;
  controller: AbortController;
  userInput: ReturnType<typeof createClaudeCliUserInputAuthorizer>;
  events: PassThrough;
  inputUuid: string;
  /** Replayed user text is never a task receipt, even after its input lifecycle ends. */
  submittedInputUuids: Set<string>;
  inputStarted: boolean;
  promptSubmitted: boolean;
  /** Hook reruns carry no input UUID and may rewrite text; retain their native input owner. */
  promptInputUuid: string;
  sawTerminalResult: boolean;
  interrupted: boolean;
  foregroundTaskIds: Set<string>;
  foregroundBashToolUseIds: Set<string>;
  pendingBackgroundTaskIds: Set<string>;
  taskNotifications: Map<string, "queued" | "replayed">;
  /** Same-turn inputs written to native, keyed by UUID until their lifecycle completes. */
  injectedInputs: Map<
    string,
    {
      text: string;
      started: ReturnType<typeof createDeferred<void>>;
    }
  >;
  /**
   * A successful result withheld until every injected input has completed. It is
   * released as terminal on completion, or as interim when native opens another
   * turn for the input first.
   */
  heldResult?: Record<string, unknown>;
  error?: Error;
};
type ClaudeCliSession = {
  handle: CliBackendLiveSessionHandle;
  capability?: CliBackendLiveSessionCapability;
  transport?: Awaited<ReturnType<typeof createClaudeCliTransport>>;
  transportStartup?: ReturnType<typeof createClaudeCliTransport>;
  currentTurn?: ClaudeCliTurn;
  idleTimer?: ReturnType<typeof setTimeout>;
  hasInputLifecycle: boolean;
  closed: boolean;
  // Tasks outlive inputs; false marks subagent work with no parent-stream query.
  taskOwners: Map<string, string | false>;
  // Native notification results identify task runs rather than task IDs.
  taskRuns: Map<string, string>;
};
const sessions = new WeakMap<CliBackendLiveSessionHandle, ClaudeCliSession>();

function activeTurn(session: ClaudeCliSession): ClaudeCliTurn | undefined {
  const turn = session.currentTurn;
  if (
    !turn ||
    turn.interrupted ||
    turn.controller.signal.aborted ||
    turn.context.abortSignal?.aborted
  ) {
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

function privateInputHolds(turn: ClaudeCliTurn): boolean {
  try {
    turn.context.assertPrivateInputCurrent?.();
    return true;
  } catch {
    return false;
  }
}

function carriesTurnContext(request: Record<string, unknown>, response: unknown): boolean {
  return (
    request.callback_id === "UserPromptSubmit" &&
    isRecord(response) &&
    isRecord(response.hookSpecificOutput) &&
    response.hookSpecificOutput.additionalContext !== undefined
  );
}

async function authorizeTool(
  session: ClaudeCliSession,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CliBackendToolPermissionResult> {
  const turn = activeTurn(session);
  const { input, tool_name: toolName } = request;
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
    if (
      decision.behavior === "allow" &&
      toolName === "Bash" &&
      toolUseId &&
      decision.updatedInput.run_in_background !== true
    ) {
      // Native may first announce an automatic timeout as already backgrounded.
      // The authorized input distinguishes it from explicit run_in_background work.
      turn.foregroundBashToolUseIds.add(toolUseId);
    }
    return decision;
  } catch {
    return { behavior: "deny", message: "OpenClaw could not authorize this tool call." };
  }
}

function isInjectedPrompt(turn: ClaudeCliTurn, prompt: unknown): boolean {
  if (turn.promptInputUuid !== turn.inputUuid) {
    return true;
  }
  // Some native versions submit hooks before the started receipt. Match only the
  // first pass; subsequent passes belong to that UUID even when text is rewritten.
  const injected = [...turn.injectedInputs].find(([, input]) => input.text === prompt);
  if (!injected) {
    return false;
  }
  turn.promptInputUuid = injected[0];
  return true;
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
    if (!turn || signal.aborted || isInjectedPrompt(turn, input.prompt)) {
      return {};
    }
    turn.promptSubmitted = true;
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

function createUserInput(context: CliBackendExecuteContext, text: string, uuid: string) {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid,
    ...(context.sessionId ? { session_id: context.sessionId } : {}),
  };
}

function rejectInjectedInputs(turn: ClaudeCliTurn, error: Error) {
  for (const input of turn.injectedInputs.values()) {
    input.started.reject(error);
  }
}

async function injectInput(
  session: ClaudeCliSession,
  turn: ClaudeCliTurn,
  text: string,
  withCurrent: (submit: () => void) => Promise<void>,
): Promise<void> {
  const uuid = randomUUID();
  const started = createDeferred<void>();
  // Closing can reject the receipt while the write is still pending.
  void started.promise.catch(() => {});
  let written: Promise<void> | undefined;
  await withCurrent(() => {
    // Native lifecycle is the receipt; recheck availability after host preparation.
    if (
      !session.hasInputLifecycle ||
      !session.transport ||
      !turn.promptSubmitted ||
      activeTurn(session) !== turn
    ) {
      throw new Error("The Claude CLI turn cannot accept more input.");
    }
    turn.injectedInputs.set(uuid, { text, started });
    turn.submittedInputUuids.add(uuid);
    written = session.transport.send(createUserInput(turn.context, text, uuid));
    // Host admission cleanup may await after the synchronous write.
    void written.catch(() => {});
  });
  if (!written) {
    throw new Error("The host did not admit Claude CLI input.");
  }
  try {
    await written;
  } catch (error) {
    turn.injectedInputs.delete(uuid);
    throw error;
  }
  await started.promise;
}

function closeSession(session: ClaudeCliSession, error?: unknown) {
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
    rejectInjectedInputs(turn, turn.error);
    turn.controller.abort();
    turn.events.end();
  }
  session.transport?.close();
}

function completeTurn(session: ClaudeCliSession, turn: ClaudeCliTurn) {
  const holdsBackgroundTasks = turn.pendingBackgroundTaskIds.size > 0;
  session.currentTurn = undefined;
  // Unfinished injected input would run as an orphan native turn; the host replays it instead.
  const orphanedInput = turn.injectedInputs.size > 0;
  rejectInjectedInputs(
    turn,
    new Error("Claude CLI turn ended before its injected input completed."),
  );
  turn.controller.abort();
  turn.events.end();
  if (!session.capability || holdsBackgroundTasks || orphanedInput) {
    // A failed parent does not stop native background continuations. Never lend them a new turn.
    // Input written into a turn that ended unanswered is the same kind of debt.
    session.handle.close(holdsBackgroundTasks || orphanedInput ? "abort" : "idle");
  } else {
    session.idleTimer = setTimeout(() => session.handle.close("idle"), IDLE_TIMEOUT_MS);
    session.idleTimer.unref();
  }
}

async function emitHeldInterimResult(turn: ClaudeCliTurn) {
  const heldResult = turn.heldResult;
  if (!heldResult) {
    return;
  }
  turn.heldResult = undefined;
  if (!turn.events.write({ ...heldResult, openclaw_interim_result: true })) {
    await once(turn.events, "drain", { signal: turn.controller.signal });
  }
}

async function acceptMessage(session: ClaudeCliSession, message: Record<string, unknown>) {
  if (message.type === "system" && message.subtype === "init") {
    session.hasInputLifecycle =
      Array.isArray(message.capabilities) && message.capabilities.includes("msg_lifecycle_v1");
  }
  const turn = session.currentTurn;
  let taskId: string | undefined;
  if (message.type === "system") {
    const input = turn && (!session.hasInputLifecycle || turn.inputStarted) ? turn : undefined;
    const inputUuid = input?.inputUuid ?? "";
    if (message.subtype === "background_tasks_changed") {
      if (Array.isArray(message.tasks)) {
        for (const task of message.tasks) {
          if (!isRecord(task)) {
            continue;
          }
          const id = recordTaskOwnership(session, task, inputUuid);
          if (
            id &&
            input &&
            !input.interrupted &&
            session.taskOwners.get(id) === input.inputUuid &&
            (task.task_type === "local_agent" ||
              task.task_type === "local_workflow" ||
              (task.task_type === "local_bash" && input.foregroundTaskIds.has(id)))
          ) {
            // Disappearing from a snapshot does not acknowledge the queued answer.
            input.pendingBackgroundTaskIds.add(id);
          }
        }
      }
    } else {
      taskId = recordTaskOwnership(session, message, inputUuid);
    }
  }
  if (!turn) {
    return;
  }
  if (turn.interrupted) {
    return;
  }
  if (message.type === "command_lifecycle") {
    if (message.state === "started" && message.command_uuid === turn.inputUuid) {
      turn.inputStarted = true;
    }
    const injectedUuid =
      typeof message.command_uuid === "string" ? message.command_uuid : undefined;
    const injected = injectedUuid ? turn.injectedInputs.get(injectedUuid) : undefined;
    if (injected && injectedUuid && message.state === "started") {
      turn.promptInputUuid = injectedUuid;
      injected.started.resolve();
      await emitHeldInterimResult(turn);
    } else if (
      injected &&
      injectedUuid &&
      (message.state === "completed" ||
        message.state === "cancelled" ||
        message.state === "discarded" ||
        message.state === "refused")
    ) {
      // Discarded/refused inputs never run; cancellation can also precede start.
      // Already-started receipts stay accepted, so terminal cleanup never replays them.
      if (message.state === "completed") {
        // Native may omit started on a terminal receipt; completion still proves consumption.
        injected.started.resolve();
      } else {
        injected.started.reject(new Error(`Claude CLI ${message.state} the injected input.`));
      }
      turn.injectedInputs.delete(injectedUuid);
      if (turn.promptInputUuid === injectedUuid) {
        turn.promptInputUuid = turn.inputUuid;
      }
      const heldResult = turn.heldResult;
      if (
        heldResult &&
        turn.injectedInputs.size === 0 &&
        turn.pendingBackgroundTaskIds.size === 0
      ) {
        turn.heldResult = undefined;
        if (!turn.events.write(heldResult)) {
          await once(turn.events, "drain", { signal: turn.controller.signal });
        }
        completeTurn(session, turn);
      }
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
  if (
    message.type === "system" &&
    message.subtype === "task_started" &&
    taskId &&
    session.taskOwners.get(taskId) === turn.inputUuid
  ) {
    if (message.is_backgrounded === false) {
      turn.foregroundTaskIds.add(taskId);
    }
    const foregroundBash =
      typeof message.tool_use_id === "string" &&
      turn.foregroundBashToolUseIds.delete(message.tool_use_id);
    if (foregroundBash && message.is_backgrounded === true) {
      turn.pendingBackgroundTaskIds.add(taskId);
    }
  }
  // A replay receipt acknowledges consumption within the current query. Keep its
  // queue slot until that query's result so it cannot acknowledge the next task twice.
  const replayedTaskId = readReplayedTaskId(message, turn.submittedInputUuids);
  if (replayedTaskId) {
    turn.pendingBackgroundTaskIds.delete(replayedTaskId);
    turn.foregroundTaskIds.delete(replayedTaskId);
    turn.taskNotifications.set(replayedTaskId, "replayed");
  }
  if (message.type === "system" && message.subtype === "task_notification" && taskId) {
    if (message.status === "stopped") {
      // Stopped work has no notification query to wait for.
      turn.pendingBackgroundTaskIds.delete(taskId);
      turn.foregroundTaskIds.delete(taskId);
      turn.taskNotifications.delete(taskId);
    } else if (turn.foregroundTaskIds.has(taskId) && !turn.pendingBackgroundTaskIds.has(taskId)) {
      turn.foregroundTaskIds.delete(taskId);
    } else {
      // Older inputs still consume their own ordered notification result.
      turn.taskNotifications.set(taskId, "queued");
    }
  }
  let completesTurn = false;
  let holdsForInput = false;
  if (message.type === "result") {
    const failed =
      message.is_error === true ||
      (typeof message.subtype === "string" && message.subtype.startsWith("error")) ||
      (typeof message.result === "string" && hasClaudeRawToolInvocation(message.result));
    const origin = isRecord(message.origin) ? message.origin : undefined;
    const taskNotification = origin?.kind === "task-notification" && origin.subkind === undefined;
    const runTaskId =
      taskNotification && typeof origin?.runId === "string"
        ? session.taskRuns.get(origin.runId)
        : undefined;
    const notifiedTaskId = taskNotification
      ? (runTaskId ?? turn.taskNotifications.keys().next().value)
      : undefined;
    // A prior input's continuation answers that input, not this one. Without a run ID
    // the queue order is the only correlation, so a failure still ends this turn.
    const priorInputResult =
      notifiedTaskId !== undefined &&
      session.taskOwners.get(notifiedTaskId) !== turn.inputUuid &&
      (!failed || runTaskId !== undefined);
    if (taskNotification && message.subtype === "success" && !failed && notifiedTaskId) {
      // A later task can finish during this query. Consume one notification, not all
      // completed tasks; retain pending work on failure so completeTurn retires it.
      turn.taskNotifications.delete(notifiedTaskId);
      turn.pendingBackgroundTaskIds.delete(notifiedTaskId);
      turn.foregroundTaskIds.delete(notifiedTaskId);
    }
    // A batched notification can acknowledge input without running the model.
    const queuedContinuation =
      turn.sawTerminalResult &&
      taskNotification &&
      message.num_turns === 0 &&
      message.result === "" &&
      message.stop_reason === null &&
      message.terminal_reason === undefined;
    if (!priorInputResult) {
      // A prior input cannot supersede this input's held answer or replay receipts.
      await emitHeldInterimResult(turn);
      for (const [replayedId, state] of turn.taskNotifications) {
        if (state === "replayed") {
          turn.taskNotifications.delete(replayedId);
        }
      }
      turn.sawTerminalResult = true;
      // Background work holds successful interim results, never terminal failures.
      completesTurn = (turn.pendingBackgroundTaskIds.size === 0 && !queuedContinuation) || failed;
      // Injected input holds a successful result until its lifecycle says whether it was the last.
      holdsForInput = completesTurn && !failed && turn.injectedInputs.size > 0;
    }
  }
  if (holdsForInput) {
    turn.heldResult = message;
    return;
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
    hasInputLifecycle: false,
    closed: false,
    taskOwners: new Map(),
    taskRuns: new Map(),
    handle: {
      generation: randomUUID(),
      fingerprint: capability?.fingerprint ?? randomUUID(),
      isIdle: () => !session.closed && !session.currentTurn,
      close: (_reason, error) => closeSession(session, error),
      waitForExit: async () => {
        const transport = session.transport ?? (await session.transportStartup);
        await transport?.waitForExit();
      },
    },
  };
  sessions.set(session.handle, session);
  capability?.register(session.handle);
  return session;
}

export async function* executeClaudeCli(
  context: ClaudeCliExecuteContext,
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
  const inputUuid = randomUUID();
  const turn: ClaudeCliTurn = {
    context,
    controller: new AbortController(),
    userInput: createClaudeCliUserInputAuthorizer(context),
    events: new PassThrough({ objectMode: true }),
    inputUuid,
    submittedInputUuids: new Set([inputUuid]),
    inputStarted: false,
    promptSubmitted: false,
    promptInputUuid: inputUuid,
    sawTerminalResult: false,
    interrupted: false,
    foregroundTaskIds: new Set(),
    foregroundBashToolUseIds: new Set(),
    pendingBackgroundTaskIds: new Set(),
    injectedInputs: new Map(),
    taskNotifications: new Map(),
  };
  session.currentTurn = turn;
  const abort = () => session.handle.close("abort", context.abortSignal?.reason);
  context.abortSignal?.addEventListener("abort", abort, { once: true });
  let startup: Promise<void> | undefined;
  try {
    // Consume startup records while initialization waits on the same stdout reader.
    startup = (async () => {
      context.abortSignal?.throwIfAborted();
      // Adopt the process's exact MCP capture before prompt dispatch or native tool callbacks.
      capability?.activate(session.handle);
      let transport = session.transport;
      if (!transport) {
        const { args, excludeDynamicSections } = prepareClaudeCliTransportArgs(context);
        session.transportStartup = createClaudeCliTransport({
          context,
          args,
          secretInput,
          currentContext: () => session.currentTurn?.context,
          initialize: {
            appendSystemPrompt: context.systemPrompt,
            // Native snapshots must not override the host's refreshed prompt on resume.
            systemPromptSnapshot: false,
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
                // Saved turn context leaves here, so it takes the private-input check too.
                return carriesTurnContext(request, response) && !privateInputHolds(admittedTurn)
                  ? {}
                  : response;
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
        }).then((created) => {
          session.transport = created;
          if (session.closed) {
            created.close();
          }
          return created;
        });
        transport = await session.transportStartup;
        if (session.closed) {
          throw turn.error ?? new Error("Claude CLI closed during startup.");
        }
        await transport.initialize();
      }
      context.assertCurrent?.();
      context.assertPrivateInputCurrent?.();
      if (session.closed || session.currentTurn !== turn) {
        throw turn.error ?? new Error("Claude CLI closed before its prompt was accepted.");
      }
      context.registerTurnInterrupt?.({
        async interrupt() {
          context.assertCurrent?.();
          if (session.currentTurn !== turn && turn.sawTerminalResult) {
            return;
          }
          if (session.closed || session.currentTurn !== turn || turn.controller.signal.aborted) {
            throw new Error("The Claude CLI turn is no longer active.");
          }
          turn.interrupted = true;
          // The host requests this only after consuming a successful yield tool result.
          // Native interrupt would persist a false user stop in the resumable transcript.
          turn.sawTerminalResult = true;
          // Native output owns the session ID; the input ID may still name a fork's parent.
          if (
            !turn.events.write({
              type: "result",
              subtype: "success",
              is_error: false,
              result: "",
            })
          ) {
            await once(turn.events, "drain", { signal: turn.controller.signal });
          }
          completeTurn(session, turn);
          session.handle.close("idle");
          await session.handle.waitForExit();
        },
      });
      await transport.send(createUserInput(context, context.prompt, turn.inputUuid));
      context.registerMessageInjection?.({
        isAvailable: () =>
          session.hasInputLifecycle &&
          turn.inputStarted &&
          turn.promptSubmitted &&
          activeTurn(session) === turn,
        queueMessage: (text, withCurrent) => injectInput(session, turn, text, withCurrent),
      });
    })().catch((error: unknown) => session.handle.close("abort", error));
    for await (const record of turn.events) {
      yield record;
    }
    await startup;
    if (turn.error) {
      throw turn.error;
    }
    if (!turn.sawTerminalResult) {
      throw new Error("Claude CLI exited without a terminal result.");
    }
  } catch (error) {
    session.handle.close("abort", error);
    throw turn.error ?? error;
  } finally {
    turn.controller.abort();
    context.abortSignal?.removeEventListener("abort", abort);
    // Iterator.return() is cancellation too; a partially consumed turn cannot stay warm.
    if (session.currentTurn === turn) {
      session.handle.close("abort");
    }
    await startup;
    if (session.closed) {
      await session.handle.waitForExit();
    }
  }
}
