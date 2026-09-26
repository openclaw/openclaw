import { projectAgentToolActivity } from "../../infra/agent-activity-events.js";
import { emitAgentEvent, type AgentEventStream } from "../../infra/agent-events.js";
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { markToolExecutionLivenessDiagnosticEvent } from "../../infra/diagnostic-tool-execution-liveness.js";
import { projectProgressCardChannelUpdate } from "../../session-cards/progress-card-channel-summary.js";
import { isAgentPlanProgressToolName } from "../../session-cards/progress-card-input.js";
import type {
  CliCompactionDelta,
  CliStreamingDelta,
  CliThinkingDelta,
  CliThinkingProgress,
  CliToolUseStartDelta,
} from "../cli-output-contracts.js";
import type { ToolSummaryTrace } from "../embedded-agent-runner/types.js";
import {
  extractToolErrorMessage,
  sanitizeToolArgs,
  sanitizeToolResult,
} from "../embedded-agent-tool-results.js";
import { runAgentHarnessAfterToolCallHook } from "../harness/hook-helpers.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { resolveCliToolTerminalReason } from "../run-termination.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import { normalizeCliToolName, stripOpenClawMcpToolPrefix } from "./tool-policy.js";
import type { PreparedCliRunContext } from "./types.js";

type CliToolResult = {
  toolCallId: string;
  name: string;
  isError: boolean;
  result?: unknown;
};

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
  let signaledToolExecutionStarted = false;
  let signaledAssistantOutputStarted = false;
  let commentaryCounter = 0;
  const toolSummaryById = new Map<
    string,
    { name: string; failed: boolean; terminalObserved?: boolean }
  >();
  // CLI results report an outcome without repeating the request, so the terminal
  // progress event would otherwise describe the output instead of the command.
  const toolArgsByCallId = new Map<
    string,
    {
      args: Record<string, unknown>;
      kind: CliToolUseStartDelta["kind"];
      tracked: boolean;
      startedAt: number;
    }
  >();
  const emitToolEvent = (
    data: Parameters<typeof projectAgentToolActivity>[0] & {
      result?: unknown;
      resultContentSource?: "network";
    },
    execution?: { args: unknown },
  ) => {
    const item = projectAgentToolActivity({
      ...data,
      name: stripOpenClawMcpToolPrefix(data.name),
      args: execution ? execution.args : data.args,
    });
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
      current.failed ||= failed;
      if (!current.name && event.name) {
        current.name = event.name;
      }
    } else {
      current = { name: event.name, failed };
      toolSummaryById.set(event.toolCallId, current);
    }
    if (event.name) {
      toolSummaryNames.add(event.name);
    }
    return current;
  };
  const getToolSummary = (): ToolSummaryTrace => ({
    calls: toolSummaryById.size,
    tools: [...toolSummaryNames],
    failures: Array.from(toolSummaryById.values()).filter((entry) => entry.failed).length,
  });
  const emitToolUseStart = (event: CliToolUseStartDelta, tracked: boolean) => {
    observedCliActivity = true;
    // Empty arguments are meaningful: progress-card calls use {} to clear the card.
    toolArgsByCallId.set(event.toolCallId, {
      args: event.args,
      kind: event.kind,
      tracked,
      startedAt: Date.now(),
    });
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
      params.toolTracking.handleCliToolUseStart(event);
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
  const emitToolResult = (event: CliToolResult, tracked: boolean) => {
    observedCliActivity = true;
    const summary = recordToolSummary(event, event.isError);
    const firstTerminal = !summary.terminalObserved;
    summary.terminalObserved = true;
    const loopbackOutcome = tracked
      ? params.toolTracking.resolveCliLoopbackTerminalOutcome(event.toolCallId)
      : undefined;
    const executedArgs = tracked ? params.toolTracking.handleCliToolResult(event) : undefined;
    const startedCall = toolArgsByCallId.get(event.toolCallId);
    toolArgsByCallId.delete(event.toolCallId);
    // Gateway owns loopback completion even when CLI correlation is absent or ambiguous.
    if (
      event.name.trim() &&
      firstTerminal &&
      !runParams.isolatedCompletion &&
      !loopbackOutcome &&
      stripOpenClawMcpToolPrefix(event.name) === event.name
    ) {
      const result = sanitizeToolResult(event.result);
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
          result: sanitizeToolResult(event.result),
          ...(tracked && startedArgs ? { args: sanitizeToolArgs(startedArgs) } : {}),
          ...(resultContentSource ? { resultContentSource } : {}),
        },
        // An ambiguous MCP loopback has no authoritative executed args; native tools do.
        {
          args:
            executedArgs ??
            (startedCall?.kind === "tool_use" &&
            resolveCliToolSource(event.name, startedCall.kind) === "core" &&
            stripOpenClawMcpToolPrefix(event.name) === event.name
              ? startedArgs
              : undefined),
        },
      );
    }
  };
  // Display-only native events never enter host-tool correlation or delivery accounting.
  const emitCliToolUseStart = (event: CliToolUseStartDelta) => emitToolUseStart(event, true);
  const emitCliToolResult = (event: CliToolResult) => emitToolResult(event, true);
  const emitCliDisplayToolUseStart = (event: CliToolUseStartDelta) =>
    emitToolUseStart(event, false);
  const emitCliDisplayToolResult = (event: CliToolResult) => emitToolResult(event, false);
  const emitParsedToolUseStart = (event: CliToolUseStartDelta) => {
    const startedAt = Date.now();
    activeParsedTools.set(event.toolCallId, {
      startedAt,
      toolName: event.name,
      kind: event.kind,
    });
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
    emitCliToolUseStart(event);
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
  const emitParsedToolResult = (event: CliToolResult) => {
    emitParsedToolTerminal(event);
    emitCliToolResult(event);
  };
  const emitCliCompaction = (event: CliCompactionDelta) => {
    observedCliActivity = true;
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
    emitCliToolUseStart,
    emitCliToolResult,
    emitCliDisplayToolUseStart,
    emitCliDisplayToolResult,
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
    activeParsedToolCount: () => activeParsedTools.size,
    getToolSummary,
  };
}

export type CliEventHandlers = ReturnType<typeof createCliEventHandlers>;
