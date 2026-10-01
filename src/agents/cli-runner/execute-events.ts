import { emitAgentEventForAdmittedRun } from "../../infra/agent-events.js";
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { getAdmittedRunDelegatedAuthority } from "../admitted-run-context.js";
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
import { createCliRunCurrentAssertion } from "./execution-target.js";
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
  const {
    admittedRunContext,
    runId,
    sessionId,
    sessionKey,
    agentId,
    provider,
    abortSignal,
    onExecutionPhase,
    executionMode,
  } = context.params;
  const model = context.modelId;
  const backend = context.backendResolved.id;
  const outputTransforms = context.backendResolved.textTransforms?.output;
  const resultContentSourceByToolName = context.resultContentSourceByToolName;
  const { handleCliToolUseStart, handleCliToolResult, resolveCliLoopbackTerminalOutcome } =
    params.toolTracking;
  const getRunState = params.getRunState;
  const assertCurrent = createCliRunCurrentAssertion(context.params);
  const root = getAdmittedRunDelegatedAuthority(admittedRunContext);
  const emitLiveEvents = executionMode !== "side-question";
  let active = true;
  const isCurrent = () => {
    if (!active || abortSignal?.aborted || !root) {
      return false;
    }
    try {
      assertCurrent();
    } catch {
      active = false;
      return false;
    }
    // The captured assertion can reenter and close or abort this attempt.
    return active && !abortSignal?.aborted;
  };
  const emit = (event: Parameters<typeof emitAgentEventForAdmittedRun>[0]) => {
    if (root) {
      emitAgentEventForAdmittedRun(event, root, isCurrent);
    }
  };
  let observedCliActivity = false;
  let signaledToolExecutionStarted = false;
  let signaledAssistantOutputStarted = false;
  let commentaryCounter = 0;
  const toolSummaryById = new Map<string, { name: string; failed: boolean }>();
  // CLI results report an outcome without repeating the request, so the terminal
  // progress event would otherwise describe the output instead of the command.
  const toolArgsByCallId = new Map<string, Record<string, unknown>>();
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
  const recordToolStart = (event: CliToolUseStartDelta) => {
    if (event.args && Object.keys(event.args).length > 0) {
      toolArgsByCallId.set(event.toolCallId, event.args);
    }
    const current = toolSummaryById.get(event.toolCallId);
    if (!current) {
      toolSummaryById.set(event.toolCallId, { name: event.name, failed: false });
    } else if (!current.name && event.name) {
      current.name = event.name;
    }
    rememberToolName(event.name);
  };
  const recordToolResult = (event: CliToolResult) => {
    const current = toolSummaryById.get(event.toolCallId);
    if (current) {
      current.failed ||= event.isError;
      if (!current.name && event.name) {
        current.name = event.name;
      }
    } else {
      toolSummaryById.set(event.toolCallId, { name: event.name, failed: event.isError });
    }
    rememberToolName(event.name);
  };
  const getToolSummary = (): ToolSummaryTrace => ({
    calls: toolSummaryById.size,
    tools: toolSummaryNames.slice(),
    failures: Array.from(toolSummaryById.values()).filter((entry) => entry.failed).length,
  });
  const emitToolUseStart = (event: CliToolUseStartDelta, tracked: boolean) => {
    if (!isCurrent()) {
      return;
    }
    observedCliActivity = true;
    recordToolStart(event);
    if (!signaledToolExecutionStarted) {
      signaledToolExecutionStarted = true;
      onExecutionPhase?.({
        phase: "tool_execution_started",
        provider,
        model,
        backend,
      });
      if (!isCurrent()) {
        return;
      }
    }
    if (tracked) {
      handleCliToolUseStart(event);
      if (!isCurrent()) {
        return;
      }
    }
    if (emitLiveEvents) {
      emit({
        runId,
        stream: "tool",
        data: {
          phase: "start",
          name: event.name,
          toolCallId: event.toolCallId,
          args: sanitizeToolArgs(event.args),
        },
      });
    }
  };
  const emitToolResult = (event: CliToolResult, tracked: boolean) => {
    if (!isCurrent()) {
      return;
    }
    observedCliActivity = true;
    recordToolResult(event);
    if (tracked) {
      handleCliToolResult(event);
      if (!isCurrent()) {
        return;
      }
    }
    if (emitLiveEvents) {
      const resultContentSource = tracked
        ? resultContentSourceByToolName?.get(stripOpenClawMcpToolPrefix(event.name))
        : undefined;
      const startedArgs = tracked ? toolArgsByCallId.get(event.toolCallId) : undefined;
      if (!isCurrent()) {
        return;
      }
      toolArgsByCallId.delete(event.toolCallId);
      emit({
        runId,
        stream: "tool",
        data: {
          phase: "result",
          name: event.name,
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: sanitizeToolResult(event.result),
          ...(startedArgs ? { args: sanitizeToolArgs(startedArgs) } : {}),
          ...(resultContentSource ? { resultContentSource } : {}),
        },
      });
    }
  };
  const emitParsedToolUseStart = (event: CliToolUseStartDelta) => {
    if (!isCurrent()) {
      return;
    }
    const startedAt = Date.now();
    activeParsedTools.set(event.toolCallId, {
      startedAt,
      toolName: event.name,
      kind: event.kind,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId,
      sessionId,
      ...(sessionKey ? { sessionKey } : {}),
      ...(agentId ? { agentId } : {}),
      toolName: event.name,
      toolSource: resolveCliToolSource(event.name, event.kind),
      toolOwner: "cli-runner",
      toolCallId: event.toolCallId,
    });
    emitToolUseStart(event, true);
  };
  const emitParsedToolTerminal = (event: CliToolResult, incomplete = false) => {
    const activeTool = activeParsedTools.get(event.toolCallId);
    // Teardown settles accepted starts without reopening incoming callbacks.
    if (incomplete ? !activeTool : !isCurrent()) {
      return false;
    }
    const trustedOutcome = resolveCliLoopbackTerminalOutcome(event.toolCallId);
    if (!incomplete && !isCurrent()) {
      return false;
    }
    const toolName = activeTool?.toolName ?? event.name;
    const now = Date.now();
    const trustedTerminalReason =
      trustedOutcome &&
      trustedOutcome.outcome !== "blocked" &&
      trustedOutcome.outcome !== "completed" &&
      trustedOutcome.outcome !== "unknown"
        ? trustedOutcome.outcome
        : undefined;
    const runState = getRunState();
    if (!incomplete && !isCurrent()) {
      return false;
    }
    const terminalReason =
      trustedTerminalReason ??
      resolveCliToolTerminalReason({
        error: incomplete ? runState.error : undefined,
        abortSignal,
      });
    // Incomplete client/MCP tools inherit the enclosing failed run even when
    // the loopback disconnect is ambiguous. Server-native tools do not.
    const useEnclosingTerminalReason =
      incomplete &&
      runState.failed &&
      activeTool !== undefined &&
      activeTool.kind !== "server_tool_use";
    const diagnosticBase = {
      runId,
      sessionId,
      ...(sessionKey ? { sessionKey } : {}),
      ...(agentId ? { agentId } : {}),
      toolName,
      toolSource: resolveCliToolSource(toolName, activeTool?.kind),
      toolOwner: "cli-runner",
      toolCallId: event.toolCallId,
      durationMs: Math.max(0, now - (activeTool?.startedAt ?? now)),
    };
    if ((!incomplete && !isCurrent()) || activeParsedTools.get(event.toolCallId) !== activeTool) {
      return false;
    }
    activeParsedTools.delete(event.toolCallId);
    if (trustedOutcome?.outcome === "unknown" && !useEnclosingTerminalReason) {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.error",
        ...diagnosticBase,
        errorCategory: "cli_tool_ambiguous",
        errorCode: "tool_outcome_unknown",
      });
      return true;
    }
    if (incomplete && activeTool?.kind === "server_tool_use" && !trustedOutcome) {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.error",
        ...diagnosticBase,
        errorCategory: "cli_tool_ambiguous",
        errorCode: "tool_outcome_unknown",
      });
      return true;
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
                  : incomplete && (!trustedOutcome || useEnclosingTerminalReason)
                    ? "cli_tool_incomplete"
                    : "cli_tool",
              terminalReason,
            }
          : { type: "tool.execution.completed", ...diagnosticBase },
    );
    return true;
  };
  const emitParsedToolResult = (event: CliToolResult) => {
    if (emitParsedToolTerminal(event)) {
      emitToolResult(event, true);
    }
  };
  const emitCliCompaction = (event: CliCompactionDelta) => {
    if (!isCurrent()) {
      return;
    }
    observedCliActivity = true;
    if (emitLiveEvents) {
      emit({
        runId,
        stream: "compaction",
        data: {
          ...event,
          backend,
        },
      });
    }
  };
  const finalizeParsedTools = () => {
    for (const [toolCallId, activeTool] of Array.from(activeParsedTools)) {
      emitParsedToolTerminal({ toolCallId, name: activeTool.toolName, isError: true }, true);
    }
  };
  const emitCliCommentaryText = (text: string) => {
    if (!emitLiveEvents || !isCurrent()) {
      return;
    }
    commentaryCounter += 1;
    emit({
      runId,
      stream: "item",
      data: {
        kind: "preamble",
        itemId: `commentary-${runId}-${commentaryCounter}`,
        // The JSONL parser flushes a complete pre-tool text segment here.
        // Mark its boundary so channels can safely create their first notification.
        phase: "end",
        title: "commentary",
        status: "running",
        progressText: applyPluginTextReplacements(text, outputTransforms),
      },
    });
  };
  const emitCliAssistantDelta = ({ text, delta }: CliStreamingDelta) => {
    if (!isCurrent()) {
      return;
    }
    if (text || delta) {
      observedCliActivity = true;
      if (!signaledAssistantOutputStarted) {
        signaledAssistantOutputStarted = true;
        onExecutionPhase?.({
          phase: "assistant_output_started",
          provider,
          model,
          backend,
        });
        if (!isCurrent()) {
          return;
        }
      }
    }
    if (emitLiveEvents) {
      emit({
        runId,
        stream: "assistant",
        data: {
          text: applyPluginTextReplacements(text, outputTransforms),
          delta: applyPluginTextReplacements(delta, outputTransforms),
        },
      });
    }
  };

  // Emit-always: thinking reaches the event bus and session archive like the
  // embedded reasoning stream; /reasoning and /verbose gate presentation only.
  const emitCliThinkingDelta = ({ text, delta, isReasoningSnapshot }: CliThinkingDelta) => {
    if (!isCurrent()) {
      return;
    }
    if (text || delta) {
      observedCliActivity = true;
    }
    if (emitLiveEvents) {
      emit({
        runId,
        stream: "thinking",
        data: { text, delta, ...(isReasoningSnapshot ? { isReasoningSnapshot } : {}) },
      });
    }
  };

  const emitCliThinkingProgress = ({ progressTokens }: CliThinkingProgress) => {
    if (!isCurrent()) {
      return;
    }
    observedCliActivity = true;
    if (emitLiveEvents) {
      emit({
        runId,
        stream: "thinking",
        data: { progressTokens },
      });
    }
  };

  return {
    emitLiveEvents,
    close: () => {
      active = false;
    },
    emitCliToolUseStart: (event: CliToolUseStartDelta) => emitToolUseStart(event, true),
    emitCliToolResult: (event: CliToolResult) => emitToolResult(event, true),
    // Native display events carry no host-tool correlation or delivery evidence.
    emitCliDisplayToolUseStart: (event: CliToolUseStartDelta) => emitToolUseStart(event, false),
    emitCliDisplayToolResult: (event: CliToolResult) => emitToolResult(event, false),
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
