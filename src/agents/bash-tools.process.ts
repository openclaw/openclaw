import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Static } from "typebox";
import { getAgentToolExecutionContext } from "../../packages/agent-core/src/tool-execution-context.js";
import { createAbortError as createNamedAbortError } from "../infra/abort-signal.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import { getDiagnosticSessionState } from "../logging/diagnostic-session-state.js";
import type { ManagedRunStdin } from "../process/supervisor/types.js";
import { sleep } from "../utils/sleep.js";
import {
  captureAgentToolSourceExecutionGuard,
  runWithAgentToolSourceExecutionScope,
} from "./agent-tool-source-execution-guard.js";
import { cancelBackgroundExecSession, isConfirmedRequestedStop } from "./bash-process-control.js";
import {
  acknowledgeNotifyOnExit,
  type ProcessSession,
  compareProcessSessionStartOrder,
  deleteSession,
  getFinishedSession,
  getSession,
  hasPendingPollDelivery,
  listFinishedSessions,
  listRunningSessions,
  prepareSessionPoll,
} from "./bash-process-registry.js";
import { describeProcessTool } from "./bash-tools.descriptions.js";
import {
  EXEC_MANUAL_COLLECTION_FOLLOW_UP,
  EXEC_RETENTION_CAP_NOTE,
  appendExecTimeoutRetryGuidance,
  renderExecExitLabel,
} from "./bash-tools.exec-output.js";
import { ProcessToolOutputSchema } from "./bash-tools.process-schema.js";
import { processSchema } from "./bash-tools.schemas.js";
import {
  clampWithDefault,
  deriveSessionName,
  readEnvInt,
  sliceLogLines,
  truncateMiddle,
} from "./bash-tools.shared.js";
import { recordCommandPoll, resetCommandPollCount } from "./command-poll-backoff.js";
import { encodeKeySequence, encodePaste, hasCursorModeSensitiveKeys } from "./pty-keys.js";
import type { AgentToolResult } from "./runtime/index.js";
import { attachInternalToolResultAcknowledgement } from "./runtime/internal-hooks.js";
import { PROCESS_TOOL_DISPLAY_SUMMARY } from "./tool-description-presets.js";
import { ToolInputError, type AgentToolWithMeta } from "./tools/common.js";
import { failText, textResult } from "./tools/tool-results.js";

export type ProcessToolDefaults = {
  hasCronTool?: boolean;
  inputWaitIdleMs?: number;
  scopeKey?: string;
};

const DEFAULT_LOG_TAIL_LINES = 200;
const DEFAULT_INPUT_WAIT_IDLE_MS = 15_000;
const MIN_INPUT_WAIT_IDLE_MS = 1_000;
const MAX_INPUT_WAIT_IDLE_MS = 10 * 60 * 1000;
const PROCESS_TOOL_ACTIONS = (
  processSchema.properties.action as typeof processSchema.properties.action & {
    enum: readonly string[];
  }
).enum;
type ProcessToolAction = (typeof PROCESS_TOOL_ACTIONS)[number];
const pollScopeByAssistantMessage = new WeakMap<object, object>();

function currentPollScope(): object | undefined {
  const assistantMessage = getAgentToolExecutionContext()?.assistantMessage;
  if (!assistantMessage) {
    return undefined;
  }
  const existing = pollScopeByAssistantMessage.get(assistantMessage);
  if (existing) {
    return existing;
  }
  // Retained sessions must not keep a full assistant message alive after a dropped result.
  const scope = {};
  pollScopeByAssistantMessage.set(assistantMessage, scope);
  return scope;
}

function resolveLogSliceWindow(offset?: number, limit?: number) {
  const usingDefaultTail = offset === undefined && limit === undefined;
  const effectiveLimit =
    typeof limit === "number" && Number.isFinite(limit)
      ? limit
      : usingDefaultTail
        ? DEFAULT_LOG_TAIL_LINES
        : undefined;
  return { effectiveOffset: offset, effectiveLimit, usingDefaultTail };
}

function defaultTailNote(totalLines: number, usingDefaultTail: boolean) {
  if (!usingDefaultTail || totalLines <= DEFAULT_LOG_TAIL_LINES) {
    return "";
  }
  return `\n\n[showing last ${DEFAULT_LOG_TAIL_LINES} of ${totalLines} lines; pass offset/limit to page]`;
}

function retentionCapNote(session: Pick<ProcessSession, "totalOutputChars" | "aggregated">) {
  return session.totalOutputChars > session.aggregated.length ? EXEC_RETENTION_CAP_NOTE : "";
}

const MAX_POLL_WAIT_MS = 30_000;

function isWritableStdin(stdin: ManagedRunStdin | undefined): stdin is ManagedRunStdin {
  if (!stdin || stdin.destroyed) {
    return false;
  }
  if (stdin.writable === false || stdin.writableEnded === true || stdin.writableFinished === true) {
    return false;
  }
  return true;
}

async function writeProcessStdin(stdin: ManagedRunStdin, data: string | Buffer) {
  await new Promise<void>((resolve, reject) => {
    stdin.write(data, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function resolvePollWaitMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(MAX_POLL_WAIT_MS, Math.floor(value)));
  }
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) {
      return Math.max(0, Math.min(MAX_POLL_WAIT_MS, parsed));
    }
  }
  return 0;
}

function recordPollRetrySuggestion(sessionId: string, hasNewOutput: boolean): number | undefined {
  try {
    const sessionState = getDiagnosticSessionState({ sessionId });
    return recordCommandPoll(sessionState, sessionId, hasNewOutput);
  } catch {
    // Optional retry hints must not prevent observing the process result.
    return undefined;
  }
}

function resetPollRetrySuggestion(sessionId: string): void {
  try {
    const sessionState = getDiagnosticSessionState({ sessionId });
    resetCommandPollCount(sessionState, sessionId);
  } catch {
    // Ignore diagnostics state failures for process tool behavior.
  }
}

function finishedSessionDetails(sessionId: string, finished: ProcessSession) {
  return {
    status:
      finished.terminalStatus === "completed" || isConfirmedRequestedStop(finished)
        ? "completed"
        : "failed",
    sessionId,
    exitCode: finished.exitCode ?? undefined,
    ...(finished.exitSignal != null ? { exitSignal: finished.exitSignal } : {}),
    ...(finished.exitReason
      ? {
          exitReason: finished.exitReason,
          timedOut:
            finished.exitReason === "overall-timeout" ||
            finished.exitReason === "no-output-timeout",
        }
      : {}),
    ...(finished.noOutputTimedOut !== undefined
      ? { noOutputTimedOut: finished.noOutputTimedOut }
      : {}),
    ...(finished.finalizationFailed ? { finalizationFailed: true } : {}),
    name: deriveSessionName(finished.command),
  };
}

function finishedSessionText(finished: ProcessSession): string {
  if (isConfirmedRequestedStop(finished)) {
    return `Process stopped by request (${renderExecExitLabel(finished)}).`;
  }
  return (
    `Process exited with ${renderExecExitLabel(finished)}.` +
    (finished.finalizationFailed ? " Cleanup failed; use process log for details." : "")
  );
}

function finishedPollResult(
  sessionId: string,
  finished: ProcessSession,
  pollScope: object | undefined,
): AgentToolResult<unknown> {
  resetPollRetrySuggestion(sessionId);
  const delivery = prepareSessionPoll(finished, pollScope);
  const { output: unreadOutput, outputDropped } = delivery;
  const output = unreadOutput.trim();
  // Omitted retained output is pageable only while this public id still owns
  // the exact process; a reused slug must never point the model at successor logs.
  const retainedOutputNote = outputDropped
    ? getFinishedSession(sessionId) === finished
      ? "[earlier output is omitted from this poll; use action=log with offset and limit to inspect retained output]\n\n"
      : "[earlier output is omitted from this poll; omitted output is no longer available through action=log]\n\n"
    : "";
  const text = appendExecTimeoutRetryGuidance(
    retentionCapNote(finished) +
      retainedOutputNote +
      (output || "(no new output)") +
      `\n\n${finishedSessionText(finished)}`,
    finished.exitReason,
  );
  return attachInternalToolResultAcknowledgement(
    textResult(text, {
      ...finishedSessionDetails(sessionId, finished),
      aggregated: finished.aggregated,
    }),
    () => {
      delivery.acknowledge();
      acknowledgeNotifyOnExit(finished);
    },
  );
}

function createAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return createNamedAbortError(typeof reason === "string" ? reason : "Aborted");
}

function sleepPollInterval(ms: number, signal?: AbortSignal): Promise<void> {
  // Shared sleeps retain their timer so one-shot callers still receive the child's result.
  return sleep(ms, signal).catch((error: unknown) => {
    throw signal?.aborted ? createAbortError(signal.reason) : error;
  });
}

// Unknown keys otherwise pass through the schema and silently turn a waiting poll into a no-wait poll.
function assertSupportedProcessParams(args: unknown): void {
  if (isRecord(args) && Object.hasOwn(args, "timeoutMs")) {
    throw new ToolInputError('process parameter "timeoutMs" is unsupported; use "timeout" instead');
  }
}

export function createProcessTool(
  defaults?: ProcessToolDefaults,
): AgentToolWithMeta<typeof processSchema, unknown> {
  const assertSourceCurrent = captureAgentToolSourceExecutionGuard();
  const scopeKey = defaults?.scopeKey;
  const inputWaitIdleMs = clampWithDefault(
    defaults?.inputWaitIdleMs ?? readEnvInt("OPENCLAW_PROCESS_INPUT_WAIT_IDLE_MS"),
    DEFAULT_INPUT_WAIT_IDLE_MS,
    MIN_INPUT_WAIT_IDLE_MS,
    MAX_INPUT_WAIT_IDLE_MS,
  );
  const isInScope = (session?: { scopeKey?: string } | null) =>
    !scopeKey || session?.scopeKey === scopeKey;

  const describeRunningSession = (session: ProcessSession) => {
    const lastOutputAt = session.processActivity?.lastOutputAtMs ?? session.startedAt;
    const idleMs = Math.max(0, Date.now() - lastOutputAt);
    const stdinWritable = isWritableStdin(session.stdin);
    return {
      ...(session.notifyOnExit === false ? { followUp: EXEC_MANUAL_COLLECTION_FOLLOW_UP } : {}),
      stdinWritable,
      waitingForInput: stdinWritable && idleMs >= inputWaitIdleMs,
      idleMs,
      lastOutputAt,
    };
  };

  const buildInputWaitHint = (waitingForInput: boolean) => {
    if (!waitingForInput) {
      return "";
    }
    return "\n\nNo new output; this session may be waiting for input. Use process write, send-keys, submit, or paste to provide input.";
  };

  const tool: AgentToolWithMeta<typeof processSchema, unknown> = {
    name: "process",
    label: "process",
    displaySummary: PROCESS_TOOL_DISPLAY_SUMMARY,
    description: describeProcessTool({ hasCronTool: defaults?.hasCronTool === true }),
    parameters: processSchema,
    outputSchema: ProcessToolOutputSchema,
    execute: async (_toolCallId, args, signal, _onUpdate): Promise<AgentToolResult<unknown>> => {
      const assertCurrent = () => {
        signal?.throwIfAborted();
        assertSourceCurrent();
      };
      assertCurrent();
      assertSupportedProcessParams(args);
      const action = (args as { action?: unknown }).action;
      if (!PROCESS_TOOL_ACTIONS.includes(action as ProcessToolAction)) {
        return failText(
          `Invalid process action. Expected one of: ${PROCESS_TOOL_ACTIONS.join(", ")}`,
        );
      }
      const params = args as Omit<Static<typeof processSchema>, "timeout"> & {
        timeout?: unknown;
      };

      if (params.action === "list") {
        return await runWithAgentToolSourceExecutionScope(assertSourceCurrent, async () => {
          assertCurrent();
          const sessions = [...listRunningSessions(), ...listFinishedSessions()]
            .filter((s) => isInScope(s))
            .toSorted(compareProcessSessionStartOrder)
            .map((s) =>
              Object.assign(
                {
                  sessionId: s.id,
                  status: isConfirmedRequestedStop(s)
                    ? "completed"
                    : (s.terminalStatus ?? "running"),
                  startedAt: s.startedAt,
                  runtimeMs: (s.endedAt ?? Date.now()) - s.startedAt,
                  cwd: s.cwd,
                  command: s.command,
                  name: deriveSessionName(s.command),
                  tail: s.tail,
                  truncated: s.truncated,
                },
                s.endedAt !== undefined
                  ? {
                      ...finishedSessionDetails(s.id, s),
                      status: isConfirmedRequestedStop(s)
                        ? "completed"
                        : (s.terminalStatus ?? "running"),
                      endedAt: s.endedAt,
                    }
                  : Object.assign({ pid: s.pid ?? undefined }, describeRunningSession(s)),
              ),
            );
          const lines = sessions.map((s) => {
            const label = s.name ? truncateMiddle(s.name, 80) : truncateMiddle(s.command, 120);
            const timeoutReason =
              "exitReason" in s &&
              (s.exitReason === "overall-timeout" || s.exitReason === "no-output-timeout")
                ? s.exitReason
                : undefined;
            const timeoutMarker = timeoutReason ? ` [${timeoutReason}]` : "";
            const stopMarker =
              s.status === "completed" && "exitReason" in s && s.exitReason === "manual-cancel"
                ? " [stopped by request]"
                : "";
            const marker = "waitingForInput" in s && s.waitingForInput ? " [input-wait]" : "";
            const wakeMarker = "followUp" in s ? " [no exit wake]" : "";
            return `${s.sessionId} ${s.status.padEnd(9)} ${
              formatDurationCompact(s.runtimeMs) ?? "n/a"
            }${timeoutMarker}${stopMarker}${marker}${wakeMarker} :: ${label}`;
          });
          const followUp = sessions.some((s) => "followUp" in s)
            ? `\n\n${EXEC_MANUAL_COLLECTION_FOLLOW_UP}`
            : "";
          return textResult((lines.join("\n") || "No running or recent sessions.") + followUp, {
            status: "completed",
            sessions,
          });
        });
      }

      if (!params.sessionId) {
        return failText("sessionId is required for this action.");
      }

      const sessionId = params.sessionId;
      const session = getSession(sessionId);
      const finished = getFinishedSession(sessionId);
      const scopedSession = isInScope(session) ? session : undefined;
      const scopedFinished = isInScope(finished) ? finished : undefined;
      const assertSelectedCurrent = (record: ProcessSession) => {
        assertCurrent();
        if (
          (getSession(record.id) ?? getFinishedSession(record.id)) !== record ||
          !isInScope(record)
        ) {
          throw new Error(
            "The selected process changed. Check its current status before trying again.",
          );
        }
      };

      const sessionControlError = (candidate: ProcessSession) =>
        !candidate.backgrounded
          ? `Session ${sessionId} is not backgrounded.`
          : candidate.finalizing
            ? `Session ${sessionId} is finalizing.`
            : undefined;
      const runningSessionResult = (
        sessionLocal: ProcessSession,
        text: string,
      ): AgentToolResult<unknown> =>
        textResult(text, {
          status: "running",
          sessionId,
          name: deriveSessionName(sessionLocal.command),
        });

      switch (params.action) {
        case "poll": {
          const pollScope = currentPollScope();
          if (!scopedSession) {
            if (scopedFinished) {
              return await runWithAgentToolSourceExecutionScope(assertSourceCurrent, async () => {
                assertCurrent();
                return finishedPollResult(sessionId, scopedFinished, pollScope);
              });
            }
            resetPollRetrySuggestion(sessionId);
            return failText(`No session found for ${sessionId}`);
          }
          if (!scopedSession.backgrounded) {
            return failText(`Session ${sessionId} is not backgrounded.`);
          }
          const pollWaitMs = resolvePollWaitMs(params.timeout);
          if (pollWaitMs > 0 && !scopedSession.exited) {
            if (signal?.aborted) {
              throw createAbortError(signal.reason);
            }
            // The wait budget is elapsed time, so a wall-clock step cannot end it early
            // or stretch it past the requested timeout.
            const deadline = performance.now() + pollWaitMs;
            // Interactive children cannot progress until their pending prompt reaches the model.
            while (
              !scopedSession.exited &&
              !hasPendingPollDelivery(scopedSession) &&
              scopedSession.pendingOutput.length === 0 &&
              !scopedSession.pendingOutputDropped &&
              performance.now() < deadline
            ) {
              await sleepPollInterval(
                Math.max(0, Math.min(250, deadline - performance.now())),
                signal,
              );
            }
          }
          return await runWithAgentToolSourceExecutionScope(assertSourceCurrent, async () => {
            assertCurrent();
            if (scopedSession.exited) {
              // Retention admission survives clear/eviction on this exact object.
              // A process removed before exit was never retained; never read a successor.
              if (scopedSession.endedAt !== undefined && isInScope(scopedSession)) {
                return finishedPollResult(sessionId, scopedSession, pollScope);
              }
              resetPollRetrySuggestion(sessionId);
              return failText(`No session found for ${sessionId}`);
            }
            const delivery = prepareSessionPoll(scopedSession, pollScope);
            const { output: unreadOutput, outputDropped } = delivery;
            const output = unreadOutput.trim();
            const aggregateOutputNote = retentionCapNote(scopedSession);
            const retainedOutputNote = outputDropped
              ? "[earlier output is omitted from this poll; use action=log with offset and limit to inspect retained output]\n\n"
              : "";
            const hasNewOutput = output.length > 0;
            const retryInMs = recordPollRetrySuggestion(sessionId, hasNewOutput);
            const runtime = describeRunningSession(scopedSession);
            const text =
              aggregateOutputNote +
              retainedOutputNote +
              (output || "(no new output)") +
              (buildInputWaitHint(runtime.waitingForInput) || "\n\nProcess still running.") +
              (runtime.followUp ? `\n\n${runtime.followUp}` : "");
            return attachInternalToolResultAcknowledgement(
              textResult(text, {
                status: "running",
                sessionId,
                aggregated: scopedSession.aggregated,
                name: deriveSessionName(scopedSession.command),
                ...runtime,
                ...(typeof retryInMs === "number" ? { retryInMs } : {}),
              }),
              () => delivery.acknowledge(),
            );
          });
        }

        case "log": {
          return await runWithAgentToolSourceExecutionScope(assertSourceCurrent, async () => {
            assertCurrent();
            const record = scopedSession ?? scopedFinished;
            if (!record) {
              return failText(`No session found for ${sessionId}`);
            }
            if (scopedSession && !scopedSession.backgrounded) {
              return failText(`Session ${sessionId} is not backgrounded.`);
            }
            const window = resolveLogSliceWindow(params.offset, params.limit);
            const { slice, totalLines, totalChars } = sliceLogLines(
              record.aggregated,
              window.effectiveOffset,
              window.effectiveLimit,
            );
            const runtime = scopedSession ? describeRunningSession(scopedSession) : undefined;
            const text =
              retentionCapNote(record) +
              (slice || (scopedSession ? "(no output yet)" : "(no output recorded)")) +
              defaultTailNote(totalLines, window.usingDefaultTail) +
              (isConfirmedRequestedStop(record)
                ? `\n\nProcess stopped by request (${renderExecExitLabel(record)}).`
                : "");
            const output = runtime
              ? text +
                buildInputWaitHint(runtime.waitingForInput) +
                (runtime.followUp ? `\n\n${runtime.followUp}` : "")
              : appendExecTimeoutRetryGuidance(text, record.exitReason);
            return textResult(output, {
              ...(runtime
                ? {
                    status: record.exited ? "completed" : "running",
                    sessionId,
                    name: deriveSessionName(record.command),
                    ...runtime,
                  }
                : finishedSessionDetails(sessionId, record)),
              // Code Mode reads details, so preserve the requested page and its recovery hints.
              output,
              total: totalLines,
              totalLines,
              totalChars,
              truncated: record.truncated,
            });
          });
        }

        case "write":
        case "send-keys":
        case "submit":
        case "paste": {
          return await runWithAgentToolSourceExecutionScope(assertSourceCurrent, async () => {
            assertCurrent();
            const inputAction = params.action;
            if (!scopedSession) {
              return failText(`No active session found for ${sessionId}`);
            }
            const controlError = sessionControlError(scopedSession);
            if (controlError) {
              return failText(controlError);
            }
            const stdin = scopedSession.stdin;
            if (!isWritableStdin(stdin)) {
              return failText(`Session ${sessionId} stdin is not writable.`);
            }
            if (inputAction === "send-keys") {
              const request = {
                keys: params.keys,
                hex: params.hex,
                literal: params.literal,
              };
              if (
                scopedSession.cursorKeyMode === "unknown" &&
                hasCursorModeSensitiveKeys(request)
              ) {
                // Arrow/keypad encodings depend on cursor key mode. Wait for startup output
                // to identify the mode before sending potentially wrong bytes.
                return failText(
                  `Session ${sessionId} cursor key mode is not known yet. Poll or log until startup output appears, then retry send-keys.`,
                );
              }
              const cursorKeyMode =
                scopedSession.cursorKeyMode === "unknown" ? undefined : scopedSession.cursorKeyMode;
              const { data, warnings } = encodeKeySequence(request, cursorKeyMode);
              if (data.length === 0) {
                return failText("No key data provided.");
              }
              await writeProcessStdin(stdin, data);
              const text =
                `Sent ${data.length} bytes to session ${sessionId}.` +
                (warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : "");
              return runningSessionResult(scopedSession, text);
            }
            const payload =
              inputAction === "paste"
                ? encodePaste(params.text ?? "", params.bracketed !== false)
                : inputAction === "submit"
                  ? "\r"
                  : (params.data ?? "");
            if (inputAction === "paste" && !payload) {
              return failText("No paste text provided.");
            }
            await writeProcessStdin(stdin, payload);
            if (inputAction === "write" && params.eof) {
              assertCurrent();
              stdin.end();
            }
            const text =
              inputAction === "paste"
                ? `Pasted ${params.text?.length ?? 0} chars to session ${sessionId}.`
                : inputAction === "submit"
                  ? `Submitted session ${sessionId} (sent CR).`
                  : `Wrote ${Buffer.byteLength(params.data ?? "", "utf8")} bytes to session ${sessionId}${
                      params.eof ? " (stdin closed)" : ""
                    }.`;
            return runningSessionResult(scopedSession, text);
          });
        }

        case "kill":
        case "clear":
        case "remove": {
          return await runWithAgentToolSourceExecutionScope(assertSourceCurrent, async () => {
            assertCurrent();
            if (params.action !== "clear" && scopedSession) {
              const controlError = sessionControlError(scopedSession);
              if (controlError) {
                return failText(controlError);
              }
              const removing = params.action === "remove";
              if (!cancelBackgroundExecSession(scopedSession.id)) {
                return failText(
                  `Unable to ${removing ? "remove" : "terminate"} session ${sessionId}: no active supervisor cancellation handle. Use process poll to check whether it is already exiting.`,
                );
              }
              await scopedSession.clearExitNotification?.();
              assertSelectedCurrent(scopedSession);
              if (removing) {
                // Hide the record now; the supervisor still owns process settlement.
                scopedSession.backgrounded = false;
                deleteSession(sessionId);
              }
              resetPollRetrySuggestion(sessionId);
              return textResult(
                removing
                  ? `Removed session ${sessionId} from the process list. Termination was requested but is not yet confirmed.`
                  : `Termination requested for session ${sessionId}. Use process poll to confirm exit and cleanup before reporting it stopped.`,
                {
                  status: "completed",
                  sessionId,
                  name: deriveSessionName(scopedSession.command),
                  cancellationRequested: true,
                  terminationConfirmed: false,
                  ...(!removing ? { followUp: { action: "poll", sessionId } } : {}),
                },
              );
            }
            if (params.action === "kill") {
              if (scopedFinished) {
                return textResult(
                  appendExecTimeoutRetryGuidance(
                    `Session ${sessionId} is already finished. ${finishedSessionText(scopedFinished)}`,
                    scopedFinished.exitReason,
                  ),
                  finishedSessionDetails(sessionId, scopedFinished),
                );
              }
              return failText(`No active session found for ${sessionId}`);
            }
            if (scopedFinished) {
              resetPollRetrySuggestion(sessionId);
              await scopedFinished.clearExitNotification?.();
              assertSelectedCurrent(scopedFinished);
              deleteSession(sessionId);
              return textResult(
                `${params.action === "clear" ? "Cleared" : "Removed"} session ${sessionId}.`,
                { status: "completed" },
              );
            }
            return failText(
              `No ${params.action === "clear" ? "finished session" : "session"} found for ${sessionId}`,
            );
          });
        }
      }

      return failText(`Unknown action ${params.action as string}`);
    },
  };
  return tool;
}

export const processTool = createProcessTool();
