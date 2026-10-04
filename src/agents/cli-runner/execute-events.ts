import { projectAgentToolActivity } from "../../infra/agent-activity-events.js";
import { emitAgentEvent, type AgentEventStream } from "../../infra/agent-events.js";
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { markToolExecutionLivenessDiagnosticEvent } from "../../infra/diagnostic-tool-execution-liveness.js";
import { projectProgressCardChannelUpdate } from "../../session-cards/progress-card-channel-summary.js";
import { isAgentPlanProgressToolName } from "../../session-cards/progress-card-input.js";
import { registerListener } from "../../shared/listeners.js";
import { projectAgentActivityItem } from "../agent-activity-presentation.js";
import type {
  CliCompactionDelta,
  CliStreamingDelta,
  CliThinkingDelta,
  CliThinkingProgress,
  CliToolResultDelta,
  CliToolUseStartDelta,
} from "../cli-output-contracts.js";
import { isClaudeForegroundAgentToolName } from "../cli-output-records.js";
import type { ToolSummaryTrace } from "../embedded-agent-runner/types.js";
import {
  extractToolErrorMessage,
  sanitizeToolArgs,
  prepareToolResult,
} from "../embedded-agent-tool-results.js";
import { runAgentHarnessAfterToolCallHook } from "../harness/hook-helpers.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { resolveCliToolTerminalReason } from "../run-termination.js";
import {
  evictOldestEntries,
  MAX_RETAINED_TOOL_ARG_CHARS,
  MAX_TRACKED_TOOL_NAMES,
  MAX_TRACKED_TOOL_SUMMARIES,
  MAX_UNFINISHED_TOOL_CALLS,
  measureToolArgChars,
} from "./execute-event-retention.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import { normalizeCliToolName, stripOpenClawMcpToolPrefix } from "./tool-policy.js";
import type { PreparedCliRunContext } from "./types.js";

function resolveCliToolSource(name: string, kind?: CliToolUseStartDelta["kind"]): "core" | "mcp" {
  return kind === "mcp_tool_use" || name.startsWith("mcp__") ? "mcp" : "core";
}

export function createCliEventHandlers(params: {
  context: PreparedCliRunContext;
  toolTracking: CliToolTracking;
  getRunState: () => { failed: boolean; error: unknown };
}) {
  const context = params.context;
  const runParams = context.params;
  const emitLiveEvents = runParams.executionMode !== "side-question";
  const emitLiveEvent = (stream: AgentEventStream, data: () => Record<string, unknown>) => {
    if (emitLiveEvents) {
      emitAgentEvent({ runId: runParams.runId, stream, data: data() });
    }
  };
  let observedCliActivity = false;
  let compactionActive = false;
  const compactionChangeListeners = new Set<() => void>();
  let signaledToolExecutionStarted = false;
  let signaledAssistantOutputStarted = false;
  let commentaryCounter = 0;
  // Bounded; see `execute-event-retention.ts`. The counts a summary reports are
  // kept as running totals instead of being read off this map's size, so FIFO
  // eviction costs recent-call dedup rather than corrupting the trace.
  const toolSummaryById = new Map<
    string,
    { name: string; failed: boolean; terminalObserved?: boolean }
  >();
  let toolCallCount = 0;
  let toolFailureCount = 0;
  // CLI results report an outcome without repeating the request, so the terminal
  // progress event would otherwise describe the output instead of the command.
  // Bounded twice: by how many calls may be outstanding at once, and by how many
  // argument characters all of them together may retain.
  const toolArgsByCallId = new Map<
    string,
    {
      args: Record<string, unknown>;
      argChars: number;
      kind: CliToolUseStartDelta["kind"];
      tracked: boolean;
      startedAt: number;
    }
  >();
  let retainedToolArgChars = 0;
  const releaseStartArgs = (toolCallId: string) => {
    const retained = toolArgsByCallId.get(toolCallId);
    if (!retained) {
      return undefined;
    }
    retainedToolArgChars -= retained.argChars;
    toolArgsByCallId.delete(toolCallId);
    return retained;
  };
  /**
   * Eviction, as opposed to a call finishing. The two holders of a start's
   * decoded arguments keep different sets under pressure — this map evicts
   * oldest-first, while the tracking side refuses new entries and keeps its
   * oldest — so an evicted entry whose arguments the tracking still held would
   * leave the two retaining DISJOINT sets, i.e. twice the intended bound. The
   * single retention decision has to follow the arguments here too.
   */
  const evictStartArgs = (toolCallId: string) => {
    const evicted = releaseStartArgs(toolCallId);
    if (evicted?.tracked && evicted.argChars > 0) {
      params.toolTracking.dropRetainedToolArgs(toolCallId);
    }
  };
  const emitToolEvent = (
    data: Parameters<typeof projectAgentToolActivity>[0] & {
      result?: unknown;
      resultContentSource?: "network";
    },
    execution?: { args: unknown; requestedArgs?: unknown },
  ) => {
    let item = projectAgentToolActivity({
      ...data,
      name: stripOpenClawMcpToolPrefix(data.name),
      args: execution ? execution.args : data.args,
    });
    if (execution?.args === undefined && execution?.requestedArgs !== undefined) {
      // Requested arguments can identify a quiet poll without proving command execution.
      item = projectAgentActivityItem(item, { args: execution.requestedArgs });
    }
    const activity = { runId: runParams.runId, stream: "item", data: item };
    if (data.phase === "start") {
      emitAgentEvent(activity);
    }
    emitAgentEvent({ runId: runParams.runId, stream: "tool", data });
    if (data.phase !== "start") {
      emitAgentEvent(activity);
    }
  };
  const toolSummaryNames = new Set<string>();
  const activeParsedTools = new Map<
    string,
    { startedAt: number; toolName: string; kind: CliToolUseStartDelta["kind"] }
  >();
  const recordToolSummary = (event: { toolCallId: string; name: string }, failed: boolean) => {
    let current = toolSummaryById.get(event.toolCallId);
    if (current) {
      if (failed && !current.failed) {
        current.failed = true;
        toolFailureCount += 1;
      }
      if (!current.name && event.name) {
        current.name = event.name;
      }
    } else {
      current = { name: event.name, failed };
      toolSummaryById.set(event.toolCallId, current);
      toolCallCount += 1;
      if (failed) {
        toolFailureCount += 1;
      }
      evictOldestEntries(toolSummaryById, MAX_TRACKED_TOOL_SUMMARIES);
    }
    if (event.name) {
      toolSummaryNames.add(event.name);
      evictOldestEntries(toolSummaryNames, MAX_TRACKED_TOOL_NAMES);
    }
    return current;
  };
  const getToolSummary = (): ToolSummaryTrace => ({
    calls: toolCallCount,
    tools: [...toolSummaryNames],
    failures: toolFailureCount,
  });
  /** Retains what this call's terminal event will need, within the run's bounds. */
  const rememberStartArgs = (event: CliToolUseStartDelta, tracked: boolean): boolean => {
    releaseStartArgs(event.toolCallId);
    // Empty arguments are meaningful: progress-card calls use {} to clear the card.
    const argChars = measureToolArgChars(event.args);
    // Over the aggregate bound the correlation entry still exists — the result
    // path reads `kind`, `tracked` and `startedAt` from it — but the arguments
    // it would have retained are not held. The start event below already carried
    // the real arguments downstream; what degrades is the terminal event's
    // argument echo, on a stream that is already pathological.
    const retainArgs = retainedToolArgChars + argChars <= MAX_RETAINED_TOOL_ARG_CHARS;
    toolArgsByCallId.set(event.toolCallId, {
      args: retainArgs ? event.args : {},
      argChars: retainArgs ? argChars : 0,
      kind: event.kind,
      tracked,
      startedAt: Date.now(),
    });
    if (retainArgs) {
      retainedToolArgChars += argChars;
    }
    evictOldestEntries(toolArgsByCallId, MAX_UNFINISHED_TOOL_CALLS, evictStartArgs);
    return retainArgs;
  };
  const emitToolUseStart = (event: CliToolUseStartDelta, tracked: boolean) => {
    observedCliActivity = true;
    const retainedArgs = rememberStartArgs(event, tracked);
    recordToolSummary(event, false);
    if (!signaledToolExecutionStarted) {
      signaledToolExecutionStarted = true;
      runParams.onExecutionPhase?.({
        phase: "tool_execution_started",
        provider: runParams.provider,
        model: context.modelId,
        backend: context.backendResolved.id,
      });
    }
    if (tracked) {
      // Ordered: loopback correlation and messaging-delivery evidence are both
      // decided inside this call from the real arguments, so the retention drop
      // has to come after it rather than by handing it emptied arguments.
      params.toolTracking.handleCliToolUseStart(event);
      if (!retainedArgs) {
        // Both maps hold the SAME decoded object, so releasing only one frees
        // nothing. One decision, applied to every consumer that would retain it.
        params.toolTracking.dropRetainedToolArgs(event.toolCallId);
      }
    }
    if (emitLiveEvents) {
      emitToolEvent({
        phase: "start",
        name: event.name,
        toolCallId: event.toolCallId,
        args: sanitizeToolArgs(event.args),
      });
    }
  };
  const emitToolResult = (event: CliToolResultDelta, tracked: boolean) => {
    observedCliActivity = true;
    const readResult = prepareToolResult(event.result);
    const summary = recordToolSummary(event, event.isError);
    const firstTerminal = !summary.terminalObserved;
    summary.terminalObserved = true;
    const loopbackOutcome = tracked
      ? params.toolTracking.resolveCliLoopbackTerminalOutcome(event.toolCallId)
      : undefined;
    const executedArgs = tracked ? params.toolTracking.handleCliToolResult(event) : undefined;
    const startedCall = releaseStartArgs(event.toolCallId);
    // Gateway owns loopback completion even when CLI correlation is absent or ambiguous.
    if (
      event.name.trim() &&
      firstTerminal &&
      !runParams.isolatedCompletion &&
      !loopbackOutcome &&
      stripOpenClawMcpToolPrefix(event.name) === event.name
    ) {
      const result = readResult();
      void runAgentHarnessAfterToolCallHook({
        toolName: normalizeCliToolName(event.name),
        toolCallId: event.toolCallId,
        runId: runParams.runId,
        agentId: runParams.agentId,
        sessionId: runParams.sessionId,
        sessionKey: runParams.sessionKey,
        channelId: runParams.currentChannelId,
        startArgs: executedArgs ?? startedCall?.args ?? {},
        result,
        ...(event.isError
          ? { error: extractToolErrorMessage(result) ?? "CLI tool execution failed" }
          : {}),
        startedAt: startedCall?.startedAt,
      }).catch(() => {});
    }
    if (emitLiveEvents) {
      const strippedName = stripOpenClawMcpToolPrefix(event.name);
      const resultContentSource = tracked
        ? context.resultContentSourceByToolName?.get(strippedName)
        : undefined;
      const startedArgs = startedCall?.args;
      const planUpdate =
        tracked &&
        startedCall?.tracked &&
        !event.isError &&
        (!loopbackOutcome || loopbackOutcome.outcome === "completed") &&
        isAgentPlanProgressToolName(strippedName)
          ? projectProgressCardChannelUpdate(executedArgs ?? startedArgs)
          : undefined;
      if (planUpdate) {
        emitAgentEvent({
          runId: runParams.runId,
          stream: "plan",
          data: {
            phase: "update",
            title: "Plan updated",
            source: "openclaw",
            ...planUpdate,
          },
        });
      }
      emitToolEvent(
        {
          phase: "result",
          name: event.name,
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: readResult(),
          ...(tracked && startedArgs ? { args: sanitizeToolArgs(startedArgs) } : {}),
          ...(resultContentSource ? { resultContentSource } : {}),
        },
        // An ambiguous MCP loopback has no authoritative executed args; native tools do.
        {
          args:
            executedArgs ??
            (startedCall?.kind === "tool_use" && !event.name.startsWith("mcp_")
              ? startedArgs
              : undefined),
          requestedArgs: startedArgs,
        },
      );
    }
  };
  const emitParsedToolUseStart = (event: CliToolUseStartDelta) => {
    const startedAt = Date.now();
    // Refuse-new rather than FIFO: the oldest entry here is the long-running
    // foreground `Agent` call that `isActiveForegroundAgentTool` needs so its
    // attributed subagent progress keeps renewing the recovery clock. Evicting
    // it would re-create the abort this branch exists to prevent. Past the cap a
    // new tool is simply not tracked; its terminal still fires, through the same
    // `activeTool === undefined` path a `server_tool_use` result already takes.
    if (
      activeParsedTools.has(event.toolCallId) ||
      activeParsedTools.size < MAX_UNFINISHED_TOOL_CALLS
    ) {
      activeParsedTools.set(event.toolCallId, {
        startedAt,
        toolName: event.name,
        kind: event.kind,
      });
    }
    const diagnosticEvent = {
      type: "tool.execution.started",
      runId: runParams.runId,
      sessionId: runParams.sessionId,
      ...(runParams.sessionKey ? { sessionKey: runParams.sessionKey } : {}),
      ...(runParams.agentId ? { agentId: runParams.agentId } : {}),
      toolName: event.name,
      toolSource: resolveCliToolSource(event.name, event.kind),
      toolOwner: "cli-runner",
      toolCallId: event.toolCallId,
    } as const;
    // Claude enforces this MCP response timeout. Keep recovery behind that
    // deadline while the request is still in the CLI's own tool runtime.
    const timeoutMs = context.managedMcpToolTimeoutMs;
    emitTrustedDiagnosticEvent(
      timeoutMs !== undefined && event.name.startsWith("mcp__openclaw__")
        ? markToolExecutionLivenessDiagnosticEvent(diagnosticEvent, {
            deadlineAtMs: startedAt + timeoutMs,
          })
        : diagnosticEvent,
    );
    emitToolUseStart(event, true);
  };
  const emitParsedToolTerminal = (event: {
    toolCallId: string;
    name: string;
    isError: boolean;
    incomplete?: boolean;
  }) => {
    const activeTool = activeParsedTools.get(event.toolCallId);
    activeParsedTools.delete(event.toolCallId);
    const trustedOutcome = params.toolTracking.resolveCliLoopbackTerminalOutcome(event.toolCallId);
    const toolName = activeTool?.toolName ?? event.name;
    const now = Date.now();
    const trustedTerminalReason =
      trustedOutcome &&
      trustedOutcome.outcome !== "blocked" &&
      trustedOutcome.outcome !== "completed" &&
      trustedOutcome.outcome !== "unknown"
        ? trustedOutcome.outcome
        : undefined;
    const runState = params.getRunState();
    const terminalReason =
      trustedTerminalReason ??
      resolveCliToolTerminalReason({
        error: event.incomplete ? runState.error : undefined,
        abortSignal: runParams.abortSignal,
      });
    // Incomplete client/MCP tools inherit the enclosing failed run even when
    // the loopback disconnect is ambiguous. Server-native tools do not.
    const useEnclosingTerminalReason =
      event.incomplete &&
      runState.failed &&
      activeTool !== undefined &&
      activeTool.kind !== "server_tool_use";
    const diagnosticBase = {
      runId: runParams.runId,
      sessionId: runParams.sessionId,
      ...(runParams.sessionKey ? { sessionKey: runParams.sessionKey } : {}),
      ...(runParams.agentId ? { agentId: runParams.agentId } : {}),
      toolName,
      toolSource: resolveCliToolSource(toolName, activeTool?.kind),
      toolOwner: "cli-runner",
      toolCallId: event.toolCallId,
      durationMs: Math.max(0, now - (activeTool?.startedAt ?? now)),
    };
    if (
      (trustedOutcome?.outcome === "unknown" && !useEnclosingTerminalReason) ||
      (event.incomplete && activeTool?.kind === "server_tool_use" && !trustedOutcome)
    ) {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.error",
        ...diagnosticBase,
        errorCategory: "cli_tool_ambiguous",
        errorCode: "tool_outcome_unknown",
      });
      return;
    }
    const trustedFailure = trustedOutcome !== undefined && trustedOutcome.outcome !== "completed";
    emitTrustedDiagnosticEvent(
      trustedOutcome?.outcome === "blocked"
        ? {
            type: "tool.execution.blocked",
            ...diagnosticBase,
            deniedReason: trustedOutcome.deniedReason,
            reason: "blocked by before-tool policy",
          }
        : trustedFailure || (!trustedOutcome && event.isError)
          ? {
              type: "tool.execution.error",
              ...diagnosticBase,
              errorCategory:
                terminalReason === "cancelled"
                  ? "aborted"
                  : event.incomplete && (!trustedOutcome || useEnclosingTerminalReason)
                    ? "cli_tool_incomplete"
                    : "cli_tool",
              terminalReason,
            }
          : { type: "tool.execution.completed", ...diagnosticBase },
    );
  };
  const emitParsedToolResult = (event: CliToolResultDelta) => {
    emitParsedToolTerminal(event);
    emitToolResult(event, true);
  };
  const emitCliCompaction = (event: CliCompactionDelta) => {
    observedCliActivity = true;
    // Native compaction is silent but busy: the no-output watchdog reads this
    // between phase boundaries, so an end event must always clear the flag,
    // even for a failed compaction (`completed: false`).
    const previous = compactionActive;
    compactionActive = event.phase === "start";
    if (compactionActive !== previous) {
      for (const listener of compactionChangeListeners) {
        listener();
      }
    }
    emitLiveEvent("compaction", () => ({ ...event, backend: context.backendResolved.id }));
  };
  const finalizeParsedTools = () => {
    for (const [toolCallId, activeTool] of Array.from(activeParsedTools)) {
      emitParsedToolTerminal({
        toolCallId,
        name: activeTool.toolName,
        isError: true,
        incomplete: true,
      });
    }
  };
  const emitCliCommentaryText = (text: string) => {
    if (!emitLiveEvents) {
      return;
    }
    commentaryCounter += 1;
    emitLiveEvent("item", () => ({
      kind: "preamble",
      itemId: `commentary-${runParams.runId}-${commentaryCounter}`,
      // The JSONL parser flushes a complete pre-tool text segment here.
      // Mark its boundary so channels can safely create their first notification.
      phase: "end",
      title: "commentary",
      status: "running",
      progressText: applyPluginTextReplacements(
        text,
        context.backendResolved.textTransforms?.output,
      ),
    }));
  };
  const emitCliAssistantDelta = ({ text, delta }: CliStreamingDelta) => {
    if (text || delta) {
      observedCliActivity = true;
      if (!signaledAssistantOutputStarted) {
        signaledAssistantOutputStarted = true;
        runParams.onExecutionPhase?.({
          phase: "assistant_output_started",
          provider: runParams.provider,
          model: context.modelId,
          backend: context.backendResolved.id,
        });
      }
    }
    emitLiveEvent("assistant", () => ({
      text: applyPluginTextReplacements(text, context.backendResolved.textTransforms?.output),
      delta: applyPluginTextReplacements(delta, context.backendResolved.textTransforms?.output),
    }));
  };
  const emitCliCompletedReply = (text: string, assistantMessageIndex: number) => {
    if (text) {
      observedCliActivity = true;
    }
    emitLiveEvent("assistant", () => ({
      assistantMessageIndex,
      completedText: applyPluginTextReplacements(
        text,
        context.backendResolved.textTransforms?.output,
      ),
    }));
  };

  // Emit-always: thinking reaches the event bus and session archive like the
  // embedded reasoning stream; /reasoning and /verbose gate presentation only.
  const emitCliThinkingDelta = ({ text, delta, isReasoningSnapshot }: CliThinkingDelta) => {
    if (text || delta) {
      observedCliActivity = true;
    }
    emitLiveEvent("thinking", () => ({
      text,
      delta,
      ...(isReasoningSnapshot ? { isReasoningSnapshot } : {}),
    }));
  };

  const emitCliThinkingProgress = ({ progressTokens }: CliThinkingProgress) => {
    observedCliActivity = true;
    emitLiveEvent("thinking", () => ({ progressTokens }));
  };

  return {
    emitLiveEvents,
    emitCliToolUseStart: (event: CliToolUseStartDelta) => emitToolUseStart(event, true),
    emitCliToolResult: (event: CliToolResultDelta) => emitToolResult(event, true),
    // Display-only native events never enter host-tool correlation or delivery accounting.
    emitCliDisplayToolUseStart: (event: CliToolUseStartDelta) => emitToolUseStart(event, false),
    emitCliDisplayToolResult: (event: CliToolResultDelta) => emitToolResult(event, false),
    emitParsedToolUseStart,
    emitParsedToolResult,
    emitCliCompaction,
    finalizeParsedTools,
    emitCliCommentaryText,
    emitCliAssistantDelta,
    emitCliCompletedReply,
    emitCliThinkingDelta,
    emitCliThinkingProgress,
    hasObservedCliActivity: () => observedCliActivity,
    hasActiveCompaction: () => compactionActive,
    onCompactionActiveChange: (listener: () => void) =>
      registerListener(compactionChangeListeners, listener),
    activeParsedToolCount: () => activeParsedTools.size,
    /**
     * What this consumer is holding right now. The caps in
     * `execute-event-retention.ts` are only meaningful if they are observable,
     * and a run that had to drop tool arguments is worth being able to see.
     */
    getRetainedStateSizes: () => ({
      toolSummaries: toolSummaryById.size,
      toolNames: toolSummaryNames.size,
      unfinishedToolCalls: toolArgsByCallId.size,
      retainedToolArgChars,
      activeParsedTools: activeParsedTools.size,
      // The tracking side holds a third copy of the same arguments for an
      // unresolved message send, so the run's retention is only observable
      // with it included.
      ...params.toolTracking.getRetainedMessagingSizes(),
    }),
    isActiveForegroundAgentTool: (toolCallId: string) => {
      const tool = activeParsedTools.get(toolCallId);
      return tool !== undefined && isClaudeForegroundAgentToolName(tool.toolName);
    },
    getToolSummary,
  };
}

export type CliEventHandlers = ReturnType<typeof createCliEventHandlers>;
