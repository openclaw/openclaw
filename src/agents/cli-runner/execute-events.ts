import { projectAgentToolActivity } from "../../infra/agent-activity-events.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import type {
  CliCompactionDelta,
  CliStreamingDelta,
  CliThinkingDelta,
  CliThinkingProgress,
  CliToolUseStartDelta,
} from "../cli-output-contracts.js";
import type { ToolSummaryTrace } from "../embedded-agent-runner/types.js";
import { sanitizeToolArgs, sanitizeToolResult } from "../embedded-agent-tool-results.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { resolveCliToolTerminalReason } from "../run-termination.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import { stripOpenClawMcpToolPrefix } from "./tool-policy.js";
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
  let observedCliActivity = false;
  let signaledToolExecutionStarted = false;
  let signaledAssistantOutputStarted = false;
  let commentaryCounter = 0;
  const toolSummaryById = new Map<string, { name: string; failed: boolean }>();
  // CLI results report an outcome without repeating the request, so the terminal
  // progress event would otherwise describe the output instead of the command.
  const toolArgsByCallId = new Map<string, Record<string, unknown>>();
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
  const toolSummaryNames: string[] = [];
  const toolSummaryNameSet = new Set<string>();
  const activeParsedTools = new Map<
    string,
    { startedAt: number; toolName: string; kind: CliToolUseStartDelta["kind"] }
  >();
  const rememberToolName = (name: string) => {
    if (!name || toolSummaryNameSet.has(name)) {
      return;
    }
    toolSummaryNameSet.add(name);
    toolSummaryNames.push(name);
  };
  const recordToolSummary = (event: { toolCallId: string; name: string }, failed: boolean) => {
    const current = toolSummaryById.get(event.toolCallId);
    if (current) {
      current.failed ||= failed;
      if (!current.name && event.name) {
        current.name = event.name;
      }
    } else {
      toolSummaryById.set(event.toolCallId, { name: event.name, failed });
    }
    rememberToolName(event.name);
  };
  const getToolSummary = (): ToolSummaryTrace => ({
    calls: toolSummaryById.size,
    tools: toolSummaryNames.slice(),
    failures: Array.from(toolSummaryById.values()).filter((entry) => entry.failed).length,
  });
  const emitToolUseStart = (event: CliToolUseStartDelta, tracked: boolean) => {
    observedCliActivity = true;
    if (event.args && Object.keys(event.args).length > 0) {
      toolArgsByCallId.set(event.toolCallId, event.args);
    }
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
    recordToolSummary(event, event.isError);
    const executedArgs = tracked ? params.toolTracking.handleCliToolResult(event) : undefined;
    if (emitLiveEvents) {
      const resultContentSource = tracked
        ? context.resultContentSourceByToolName?.get(stripOpenClawMcpToolPrefix(event.name))
        : undefined;
      const startedArgs = toolArgsByCallId.get(event.toolCallId);
      toolArgsByCallId.delete(event.toolCallId);
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
        { args: tracked ? executedArgs : startedArgs },
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
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: runParams.runId,
      sessionId: runParams.sessionId,
      ...(runParams.sessionKey ? { sessionKey: runParams.sessionKey } : {}),
      ...(runParams.agentId ? { agentId: runParams.agentId } : {}),
      toolName: event.name,
      toolSource: resolveCliToolSource(event.name, event.kind),
      toolOwner: "cli-runner",
      toolCallId: event.toolCallId,
    });
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
    if (emitLiveEvents) {
      emitAgentEvent({
        runId: runParams.runId,
        stream: "compaction",
        data: {
          ...event,
          backend: context.backendResolved.id,
        },
      });
    }
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
    emitAgentEvent({
      runId: runParams.runId,
      stream: "item",
      data: {
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
      },
    });
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
    if (emitLiveEvents) {
      emitAgentEvent({
        runId: runParams.runId,
        stream: "assistant",
        data: {
          text: applyPluginTextReplacements(text, context.backendResolved.textTransforms?.output),
          delta: applyPluginTextReplacements(delta, context.backendResolved.textTransforms?.output),
        },
      });
    }
  };

  // Emit-always: thinking reaches the event bus and session archive like the
  // embedded reasoning stream; /reasoning and /verbose gate presentation only.
  const emitCliThinkingDelta = ({ text, delta, isReasoningSnapshot }: CliThinkingDelta) => {
    if (text || delta) {
      observedCliActivity = true;
    }
    if (emitLiveEvents) {
      emitAgentEvent({
        runId: runParams.runId,
        stream: "thinking",
        data: { text, delta, ...(isReasoningSnapshot ? { isReasoningSnapshot } : {}) },
      });
    }
  };

  const emitCliThinkingProgress = ({ progressTokens }: CliThinkingProgress) => {
    observedCliActivity = true;
    if (emitLiveEvents) {
      emitAgentEvent({
        runId: runParams.runId,
        stream: "thinking",
        data: { progressTokens },
      });
    }
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
    emitCliThinkingDelta,
    emitCliThinkingProgress,
    hasObservedCliActivity: () => observedCliActivity,
    activeParsedToolCount: () => activeParsedTools.size,
    getToolSummary,
  };
}

export type CliEventHandlers = ReturnType<typeof createCliEventHandlers>;
