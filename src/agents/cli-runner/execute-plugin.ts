import { stripSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { toErrorObject } from "../../infra/errors.js";
import { resolveExecutablePath } from "../../infra/executable-path.js";
import { mergePathPrepend } from "../../infra/path-prepend.js";
import {
  resolveWindowsExecutablePath,
  resolveWindowsSpawnProgramCandidate,
} from "../../plugin-sdk/windows-spawn.js";
import type {
  CliBackendExecute,
  CliBackendToolPermissionRequest,
  CliBackendToolPermissionResult,
  CliBackendUserInputRequest,
  CliBackendUserInputResult,
} from "../../plugins/cli-backend.types.js";
import type { RunExit, TerminationReason } from "../../process/supervisor/types.js";
import {
  recordAdjustedParamsForToolCall,
  runBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import type { CliTerminalInterruption } from "../cli-output-contracts.js";
import { resolveExecDefaults } from "../exec-defaults.js";
import { FailoverError, isSignalTimeoutReason } from "../failover-error.js";
import { withAgentQuestionAnswerAuthority } from "../harness/host-private-capabilities.js";
import { runStructuredInput } from "../harness/structured-input-execution.js";
import { compileStructuredInputQuestions } from "../harness/structured-input.js";
import { resolveExecToolConfig } from "../lazy-exec-tool.js";
import { recordAgentCleanupFailure } from "../run-cleanup-timeout.js";
import { resolveToolLoopDetectionConfig } from "../tool-loop-detection-config.js";
import {
  restartCliLiveSession,
  createCliLiveSessionCapability,
  getCliLiveSessionApprovalGrants,
} from "./cli-live-session-registry.js";
import {
  requestCliNativeToolApproval,
  resolveCliNativeToolApprovalPlan,
} from "./cli-native-tool-approval.js";
import { createCliAbortError } from "./execute-node-claude.js";
import { createCliPluginWatchdog, type CliWatchdogClock } from "./execute-plugin-watchdog.js";
import { attachCliReplyBackend, createCliRunCurrentAssertion } from "./execution-target.js";
import { createCliFailoverError as failover } from "./exit-error.js";
import * as noOutputPolicy from "./no-output-timeout-policy.js";
import { normalizeCliToolName } from "./tool-policy.js";
import type { PreparedCliRunContext } from "./types.js";

const PLUGIN_ITERATOR_CLOSE_TIMEOUT_MS = 5_000;

function denyTool(message: string): CliBackendToolPermissionResult {
  return { behavior: "deny", message };
}

function createPluginToolPermissionHandler(params: {
  context: PreparedCliRunContext;
  abortSignal: AbortSignal;
  onPendingApproval: (delta: 1 | -1) => void;
  env: NodeJS.ProcessEnv;
}): (request: CliBackendToolPermissionRequest) => Promise<CliBackendToolPermissionResult> {
  const run = params.context.params;
  const permission = resolveExecDefaults({
    cfg: run.config,
    sessionEntry: run.sessionEntry,
    execOverrides: run.execOverrides,
    agentId: run.agentId,
    sessionKey: run.runtimePolicySessionKey ?? run.sessionKey,
  });
  const grants = new Set<string>();

  return async (request) => {
    const signal = request.abortSignal
      ? AbortSignal.any([params.abortSignal, request.abortSignal])
      : params.abortSignal;
    const assertActive = createCliRunCurrentAssertion(run, signal);
    try {
      assertActive();
    } catch {
      return denyTool("OpenClaw denied native tool use: the admitted run is no longer active.");
    }

    const toolName = request.toolName.trim();
    if (!toolName) {
      return denyTool("OpenClaw denied an unnamed native tool.");
    }
    if (run.cliToolAvailability && !run.cliToolAvailability.native.includes(toolName)) {
      return denyTool(`OpenClaw denied native tool ${toolName}: it is unavailable to this run.`);
    }

    // Provider schemas are not policy schemas: match canonical names and file operands.
    const canonicalToolName = normalizeCliToolName(toolName);
    const nativeFileTool =
      ["read", "write", "edit"].includes(canonicalToolName) &&
      Object.hasOwn(request.toolInput, "file_path");
    let policyInput = request.toolInput;
    if (nativeFileTool) {
      const nativePath = request.toolInput.file_path;
      if (typeof nativePath !== "string") {
        return denyTool("OpenClaw denied native file tool use: invalid file path.");
      }
      if (Object.hasOwn(request.toolInput, "path") && request.toolInput.path !== nativePath) {
        return denyTool("OpenClaw denied native file tool use: conflicting file paths.");
      }
      policyInput = { ...request.toolInput, path: nativePath };
      if (canonicalToolName === "edit") {
        const { old_string: oldText, new_string: newText, edits } = request.toolInput;
        if (typeof oldText !== "string" || typeof newText !== "string") {
          return denyTool("OpenClaw denied native edit tool use: invalid replacement.");
        }
        if (
          edits !== undefined &&
          (!Array.isArray(edits) ||
            edits.length !== 1 ||
            !isRecord(edits[0]) ||
            edits[0].oldText !== oldText ||
            edits[0].newText !== newText)
        ) {
          return denyTool("OpenClaw denied native edit tool use: conflicting replacements.");
        }
        policyInput.edits = [{ oldText, newText }];
      }
    }

    const requester = {
      ...((run.messageChannel ?? run.messageProvider)
        ? { channel: run.messageChannel ?? run.messageProvider }
        : {}),
      ...(run.agentAccountId ? { accountId: run.agentAccountId } : {}),
      ...(run.senderId ? { senderId: run.senderId } : {}),
      ...(run.senderIsOwner !== undefined ? { senderIsOwner: run.senderIsOwner } : {}),
    };
    const hookResult = await runBeforeToolCallHook({
      toolName: canonicalToolName,
      params: policyInput,
      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      signal,
      ctx: {
        ...(run.agentId ? { agentId: run.agentId } : {}),
        ...(run.config ? { config: run.config } : {}),
        cwd: params.context.cwd ?? params.context.workspaceDir,
        workspaceDir: params.context.workspaceDir,
        ...(run.sessionKey ? { sessionKey: run.sessionKey } : {}),
        sessionId: run.sessionId,
        runId: run.runId,
        ...(run.trigger ? { trigger: run.trigger } : {}),
        ...(run.approvalReviewerDeviceId
          ? { approvalReviewerDeviceId: run.approvalReviewerDeviceId }
          : {}),
        ...(run.currentChannelId ? { channelId: run.currentChannelId } : {}),
        ...(Object.keys(requester).length > 0 ? { requester } : {}),
        turnSourceChannel: run.messageChannel ?? run.messageProvider,
        turnSourceTo: run.chatId ?? run.currentChannelId,
        turnSourceAccountId: run.agentAccountId,
        turnSourceThreadId: run.currentThreadTs,
        loopDetection: resolveToolLoopDetectionConfig({
          cfg: run.config,
          agentId: run.agentId,
        }),
      },
    });
    try {
      assertActive();
    } catch {
      return denyTool("OpenClaw denied native tool use: the admitted run closed during policy.");
    }
    if (hookResult.blocked) {
      return denyTool(hookResult.reason);
    }
    if (!isRecord(hookResult.params)) {
      return denyTool("OpenClaw denied native tool use: before_tool_call returned invalid input.");
    }
    let toolInput = hookResult.params;
    // SDK permission replies must return the native schema, never policy-only aliases.
    if (nativeFileTool) {
      if (typeof toolInput.path !== "string") {
        return denyTool("OpenClaw denied native file tool use: invalid rewritten file path.");
      }
      if (toolInput === policyInput) {
        toolInput = request.toolInput;
      } else {
        toolInput = { ...toolInput, file_path: toolInput.path };
        if (!Object.hasOwn(request.toolInput, "path")) {
          delete toolInput.path;
        }
        if (canonicalToolName === "edit") {
          const edits = toolInput.edits;
          if (
            !Array.isArray(edits) ||
            edits.length !== 1 ||
            !isRecord(edits[0]) ||
            typeof edits[0].oldText !== "string" ||
            typeof edits[0].newText !== "string"
          ) {
            return denyTool("OpenClaw denied an unrepresentable native edit rewrite.");
          }
          toolInput.old_string = edits[0].oldText;
          toolInput.new_string = edits[0].newText;
          if (!Object.hasOwn(request.toolInput, "edits")) {
            delete toolInput.edits;
          }
        }
      }
    }

    const plan = resolveCliNativeToolApprovalPlan(permission);
    if (plan === "deny") {
      return denyTool(
        `OpenClaw exec policy denied native tool use (security=${permission.security}, ask=${permission.ask}).`,
      );
    }
    const currentGrants = getCliLiveSessionApprovalGrants(params.context) ?? grants;
    if (plan === "allow" || (permission.ask !== "always" && currentGrants.has(toolName))) {
      assertActive();
      recordAdjustedParamsForToolCall(request.toolCallId, toolInput, run.runId);
      return { behavior: "allow", updatedInput: toolInput };
    }

    params.onPendingApproval(1);
    let outcome: Awaited<ReturnType<typeof requestCliNativeToolApproval>>;
    try {
      outcome = await requestCliNativeToolApproval({
        toolName,
        toolInput,
        pluginId: params.context.backendResolved.id,
        sessionKey: run.sessionKey,
        agentId: run.agentId,
        toolCallId: request.toolCallId,
        cwd: request.cwd,
        fallbackCwd: params.context.cwd ?? params.context.workspaceDir,
        bindingEnv: params.env,
        env: {
          ...params.env,
          PATH: mergePathPrepend(
            params.env.PATH,
            resolveExecToolConfig({ cfg: run.config, agentId: run.agentId }).pathPrepend ?? [],
          ),
        },
        assertActive,
        abortSignal: signal,
        ask: permission.ask,
      });
    } finally {
      params.onPendingApproval(-1);
    }
    // Approval itself may outlive, replace, or close the exact admitted turn.
    // The host rechecks authority immediately before returning any capability.
    try {
      assertActive();
    } catch {
      return denyTool("OpenClaw denied native tool use: the admitted run closed during approval.");
    }
    if (outcome.kind !== "allow") {
      return denyTool(
        outcome.message ??
          (outcome.reason === "user"
            ? `OpenClaw user denied native tool use (${toolName}).`
            : `OpenClaw approval was not granted for native tool use (${toolName}).`),
      );
    }
    if (outcome.grantAlways) {
      currentGrants.add(toolName);
    }
    const updatedInput = outcome.updatedInput ?? toolInput;
    recordAdjustedParamsForToolCall(request.toolCallId, updatedInput, run.runId);
    return { behavior: "allow", updatedInput };
  };
}

function cancelUserInput(message: string): CliBackendUserInputResult {
  return { status: "cancelled", message };
}

function createPluginUserInputHandler(params: {
  context: PreparedCliRunContext;
  abortSignal: AbortSignal;
  onPendingInput: (delta: 1 | -1) => void;
}): (request: CliBackendUserInputRequest) => Promise<CliBackendUserInputResult> {
  const run = params.context.params;
  return async (request) => {
    const signal = request.abortSignal
      ? AbortSignal.any([params.abortSignal, request.abortSignal])
      : params.abortSignal;
    const assertActive = createCliRunCurrentAssertion(run, signal);
    try {
      assertActive();
    } catch {
      return cancelUserInput(
        "OpenClaw cancelled operator input: the admitted run is no longer active.",
      );
    }

    const toolName = request.toolName.trim();
    if (
      !toolName ||
      (run.cliToolAvailability && !run.cliToolAvailability.native.includes(toolName))
    ) {
      return cancelUserInput(
        toolName
          ? `OpenClaw cancelled operator input from ${toolName}: it is unavailable to this run.`
          : "OpenClaw cancelled an unnamed operator input request.",
      );
    }
    if (request.questions.length === 0 || request.questions.length > 12) {
      return cancelUserInput("OpenClaw cancelled an invalid operator input request.");
    }

    const questionAuthority = params.context.bindQuestionAnswerAuthority?.(assertActive);
    const assertQuestionActive = () => {
      assertActive();
      questionAuthority?.assertActive();
    };
    params.onPendingInput(1);
    try {
      const result = await withAgentQuestionAnswerAuthority(questionAuthority, () =>
        runStructuredInput({
          input: compileStructuredInputQuestions({
            questions: request.questions.map((question) => ({
              ...question,
              isSecret: false,
            })),
            intro: request.intro?.trim() || "Agent needs input:",
          }),
          sessionKey: run.sessionKey ?? run.sessionId,
          agentId: run.agentId,
          runId: run.runId,
          timeoutMs: run.timeoutMs,
          delivery: {
            onBlockReply: run.onBlockReply,
            onPartialReply: run.onPartialReply,
          },
          signal,
          isActive: () => {
            try {
              assertQuestionActive();
              return true;
            } catch {
              return false;
            }
          },
          questionId: request.toolCallId ? (batch) => `${request.toolCallId}:${batch}` : undefined,
        }),
      );
      try {
        assertQuestionActive();
      } catch {
        return cancelUserInput(
          "OpenClaw cancelled operator input: the admitted run closed before the answer was committed.",
        );
      }
      return result.status === "answered"
        ? { status: "answered", answers: result.answers }
        : cancelUserInput(
            result.message ??
              "OpenClaw cancelled operator input; continue with your best judgment.",
          );
    } catch {
      return cancelUserInput(
        "OpenClaw could not collect operator input; continue with your best judgment.",
      );
    } finally {
      params.onPendingInput(-1);
    }
  };
}

function waitForIteratorValue<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) {
    return Promise.reject(toErrorObject(signal.reason, "CLI plugin execution was aborted."));
  }
  return new Promise((resolve, reject) => {
    const rejectAborted = () =>
      reject(toErrorObject(signal.reason, "CLI plugin execution was aborted."));
    signal.addEventListener("abort", rejectAborted, { once: true });
    void iterator.next().then(
      (value) => {
        signal.removeEventListener("abort", rejectAborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", rejectAborted);
        reject(toErrorObject(error, "CLI plugin execution stream failed."));
      },
    );
  });
}

async function closePluginIterator(
  iterator: AsyncIterator<Record<string, unknown>> | undefined,
): Promise<void> {
  if (!iterator?.return) {
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      iterator.return(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("CLI plugin runtime did not close after its run ended.")),
          PLUGIN_ITERATOR_CLOSE_TIMEOUT_MS,
        );
        timeout.unref();
      }),
    ]);
  } catch (error) {
    recordAgentCleanupFailure();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Runs a prepared plugin transport while keeping cancellation and approvals host-owned. */
export async function executePluginOwnedProcess(params: {
  context: PreparedCliRunContext;
  execute: CliBackendExecute;
  executionCommand: string;
  executionArgv0?: string;
  executionArgs: readonly string[];
  env: Record<string, string>;
  prompt: string;
  promptContext?: PreparedCliRunContext["promptContext"];
  useResume: boolean;
  forceNewSession?: boolean;
  sessionId?: string;
  noOutputTimeoutMs: number;
  watchdogClock?: CliWatchdogClock;
  consumeStdout: (chunk: string) => void;
  onOutstandingWorkChange?: (active: boolean) => void;
  activeToolCount?: () => number;
  getActiveLoopbackAskUserDeadline?: () => number | undefined;
  onActiveLoopbackAskUserDeadlineChange?: (listener: () => void) => () => void;
  onNoOutputTimeout?: (error: FailoverError) => void;
  onInterrupted?: (reason: CliTerminalInterruption["reason"]) => boolean;
  mcpCapture?: {
    captureKey?: string;
    beginCapture: (captureKey: string | undefined, assertCurrent: () => void) => void;
  };
  liveSession?: {
    requiredGeneration?: string;
  };
}): Promise<RunExit> {
  const run = params.context.params;
  const cwd = params.context.cwd ?? params.context.workspaceDir;
  const executable =
    process.platform === "win32"
      ? resolveWindowsExecutablePath(params.executionCommand, params.env, cwd)
      : params.executionCommand;
  let command = resolveExecutablePath(executable, { cwd, env: params.env });
  if (!command) {
    throw new Error(`CLI backend executable could not be resolved: ${params.executionCommand}`);
  }
  let executionArgs = params.executionArgs;
  if (process.platform === "win32") {
    const program = resolveWindowsSpawnProgramCandidate({ command, env: params.env });
    // npm launchers need the child PATH's Node, not a packaged OpenClaw executable.
    command =
      program.resolution === "node-entrypoint"
        ? resolveWindowsExecutablePath("node", params.env, cwd)
        : program.command;
    if (program.leadingArgv.length > 0) {
      executionArgs = [...program.leadingArgv, ...executionArgs];
    }
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const signal = run.abortSignal
    ? AbortSignal.any([controller.signal, run.abortSignal])
    : controller.signal;
  const assertCurrent = createCliRunCurrentAssertion(run, signal);
  const assertRunCurrent = createCliRunCurrentAssertion(run);
  const termination: { reason: TerminationReason } = { reason: "exit" };
  // Normal cleanup closes native callbacks; MCP results retain their admitted
  // caller through the capture drain. Cancellation and timeouts still close both.
  const assertCaptureCurrent = () =>
    (termination.reason === "exit" ? assertRunCurrent : assertCurrent)();
  const outstanding = {
    approvals: 0,
    background: 0,
    observed: false,
    replayUnsafe: false,
  };
  const reportOutstandingWork = () =>
    params.onOutstandingWorkChange?.(outstanding.approvals > 0 || outstanding.background > 0);
  const updatePendingApproval = (delta: number) => {
    outstanding.approvals = Math.max(0, outstanding.approvals + delta);
    reportOutstandingWork();
  };
  const watchdog = createCliPluginWatchdog(
    {
      provider: run.provider,
      model: params.context.modelId,
      sessionId: run.sessionId,
      lane: run.lane,
      overallTimeoutMs: clampPositiveTimerTimeoutMs(run.timeoutMs),
      noOutputTimeoutMs: clampPositiveTimerTimeoutMs(params.noOutputTimeoutMs),
      useResume: params.useResume,
      getActiveAskUserDeadline: params.getActiveLoopbackAskUserDeadline,
      activeToolCount: () => Math.max(params.activeToolCount?.() ?? 0, outstanding.approvals),
      backgroundTaskCount: () => outstanding.background,
      hasObservedActivity: () => outstanding.observed,
      hasReplayUnsafeActivity: () => outstanding.replayUnsafe,
      onNoOutputTimeout: (error) => {
        termination.reason = "no-output-timeout";
        params.onNoOutputTimeout?.(error);
        controller.abort(error);
      },
      onOverallTimeout: () => {
        termination.reason = "overall-timeout";
        controller.abort(new Error("CLI plugin runtime exceeded its execution timeout."));
      },
    },
    params.watchdogClock,
  );
  const stopAskUserDeadlineListener = params.onActiveLoopbackAskUserDeadlineChange?.(() =>
    watchdog.reset(),
  );

  const detachReplyBackend = attachCliReplyBackend(run, () => {
    termination.reason = "manual-cancel";
    controller.abort(createCliAbortError());
  });

  let iterator: AsyncIterator<Record<string, unknown>> | undefined;
  let liveSession: ReturnType<typeof createCliLiveSessionCapability> | undefined;
  let terminalResult: "none" | "success" | "error" = "none";
  try {
    assertCurrent();
    watchdog.reset();
    if (
      params.liveSession &&
      (params.forceNewSession ||
        (Boolean(params.context.preparedBackend.backend.resumeArgs?.length) && !params.useResume))
    ) {
      if (params.liveSession.requiredGeneration) {
        throw new Error("The required CLI live session cannot be replaced by a fresh process.");
      }
      await restartCliLiveSession(params.context, signal);
    }
    assertCurrent();
    if (params.liveSession) {
      liveSession = createCliLiveSessionCapability({
        context: params.context,
        argv: [command, ...executionArgs],
        argv0: params.executionArgv0,
        env: params.env,
        ...params.liveSession,
        captureKey: params.mcpCapture?.captureKey,
        beginCapture: (captureKey) =>
          params.mcpCapture?.beginCapture(captureKey, assertCaptureCurrent),
        abortSignal: signal,
        claimResources: params.context.preparedBackend.claimLiveSessionResources,
      });
    } else {
      params.mcpCapture?.beginCapture(params.mcpCapture.captureKey, assertCaptureCurrent);
    }
    assertCurrent();
    const execution = params.execute({
      command,
      argv0: params.executionArgv0,
      args: executionArgs,
      cwd,
      env: params.env,
      prompt: params.prompt,
      ...(params.promptContext ? { promptContext: params.promptContext } : {}),
      modelId: params.context.normalizedModel,
      systemPrompt: stripSystemPromptCacheBoundary(params.context.systemPrompt).trim(),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      useResume: params.useResume,
      abortSignal: signal,
      assertCurrent,
      timeoutMs: run.timeoutMs,
      ...(run.executionMode ? { executionMode: run.executionMode } : {}),
      ...(run.cliToolAvailability ? { toolAvailability: run.cliToolAvailability } : {}),
      ...(liveSession ? { liveSession } : {}),
      requestToolPermission: createPluginToolPermissionHandler({
        context: params.context,
        abortSignal: signal,
        onPendingApproval: updatePendingApproval,
        env: params.env,
      }),
      requestUserInput: createPluginUserInputHandler({
        context: params.context,
        abortSignal: signal,
        onPendingInput: updatePendingApproval,
      }),
    });
    iterator = execution[Symbol.asyncIterator]();

    for (;;) {
      const next = await waitForIteratorValue(iterator, signal);
      if (next.done) {
        break;
      }
      if (!isRecord(next.value)) {
        outstanding.replayUnsafe = true;
        throw new Error("CLI plugin runtime emitted an invalid structured stream event.");
      }
      if (next.value.type === "result" && next.value.openclaw_interim_result !== true) {
        terminalResult =
          terminalResult === "error" ||
          next.value.is_error === true ||
          (typeof next.value.subtype === "string" && next.value.subtype.startsWith("error_"))
            ? "error"
            : "success";
      }
      if (
        next.value.type === "system" &&
        next.value.subtype === "background_tasks_changed" &&
        Array.isArray(next.value.tasks)
      ) {
        outstanding.background = next.value.tasks.filter(isRecord).length;
        reportOutstandingWork();
      }
      params.consumeStdout(`${JSON.stringify(next.value)}\n`);
      outstanding.observed = true;
      if (
        !(next.value.type === "system" && next.value.subtype === "init") &&
        next.value.type !== "command_lifecycle"
      ) {
        outstanding.replayUnsafe = true;
      }
      watchdog.noteOutput();
    }

    if (terminalResult === "none") {
      throw new Error("CLI plugin runtime completed without a terminal result.");
    }
  } catch (error) {
    if (run.abortSignal?.aborted || termination.reason === "manual-cancel") {
      const reason = isSignalTimeoutReason(run.abortSignal?.reason) ? "timeout" : "aborted";
      if (!params.onInterrupted?.(reason)) {
        throw createCliAbortError();
      }
      termination.reason = "manual-cancel";
    }
    if (termination.reason === "exit" && terminalResult !== "error") {
      if (
        params.liveSession?.requiredGeneration &&
        noOutputPolicy.isReplaySafeCliResumeControlOnly(
          params.useResume,
          outstanding.replayUnsafe,
          Boolean(outstanding.approvals || outstanding.background || params.activeToolCount?.()),
        )
      ) {
        try {
          liveSession?.current();
        } catch (sessionError) {
          if (sessionError instanceof FailoverError && sessionError.reason === "session_expired") {
            const { code, message, reason } = sessionError;
            throw failover(message, reason, sessionError, { cause: error, code });
          }
        }
      }
      throw error;
    }
  } finally {
    watchdog.dispose();
    stopAskUserDeadlineListener?.();
    params.onOutstandingWorkChange?.(false);
    // Permission callbacks can be retained by the plugin or its subprocess.
    // Closing the turn fences those capabilities before any outer cleanup runs.
    if (!controller.signal.aborted) {
      controller.abort(new Error("CLI plugin runtime turn is no longer active."));
    }
    detachReplyBackend?.();
    await closePluginIterator(iterator);
  }

  return {
    reason: termination.reason,
    exitCode: termination.reason === "exit" ? 0 : null,
    exitSignal: null,
    durationMs: Date.now() - startedAt,
    stdout: "",
    stderr: "",
    timedOut:
      termination.reason === "overall-timeout" || termination.reason === "no-output-timeout",
    noOutputTimedOut: termination.reason === "no-output-timeout",
  };
}
