import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { stripMixedSilentReplyTokens } from "../../auto-reply/reply/mixed-silent-reply-tokens.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { projectAgentToolActivity } from "../../infra/agent-activity-events.js";
import { emitAgentEvent, type AgentEventStream } from "../../infra/agent-events.js";
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { markToolExecutionLivenessDiagnosticEvent } from "../../infra/diagnostic-tool-execution-liveness.js";
import { projectProgressCardChannelUpdate } from "../../session-cards/progress-card-channel-summary.js";
import { isAgentPlanProgressToolName } from "../../session-cards/progress-card-input.js";
import { projectAgentActivityItem } from "../agent-activity-presentation.js";
import { prepareAgentRunTerminalReply } from "../agent-run-terminal-reply.js";
import {
  recordSkillUsed,
  resolvedSkillUsageMatch,
} from "../agent-tools.before-tool-call.diagnostics.js";
import type {
  CliCompactionDelta,
  CliStreamingDelta,
  CliThinkingDelta,
  CliThinkingProgress,
  CliToolInputDelta,
  CliToolResultDelta,
  CliToolUseStartDelta,
} from "../cli-output-contracts.js";
import { isClaudeForegroundAgentToolName } from "../cli-output-records.js";
import type { ToolSummaryTrace } from "../embedded-agent-runner/types.js";
import { extractToolErrorMessage, prepareToolResult } from "../embedded-agent-tool-results.js";
import { runAgentHarnessAfterToolCallHook } from "../harness/hook-helpers.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { resolveCliToolTerminalReason } from "../run-termination.js";
import { cliAssistantItemId } from "./assistant-identity.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import { normalizeCliToolName, stripOpenClawMcpToolPrefix } from "./tool-policy.js";
import type { PreparedCliRunContext } from "./types.js";

function resolveCliToolSource(name: string, kind?: CliToolUseStartDelta["kind"]): "core" | "mcp" {
  return kind === "mcp_tool_use" || name.startsWith("mcp__") ? "mcp" : "core";
}

// Live tool output text is read only from content block arrays; other shapes stay untouched.
function withBrowserTabDetails(result: unknown, browserTab: unknown): unknown {
  if (isRecord(result) && Array.isArray(result.content)) {
    return { ...result, details: { ...asOptionalRecord(result.details), browserTab } };
  }
  if (Array.isArray(result)) {
    return { content: result, details: { browserTab } };
  }
  if (typeof result === "string" || typeof result === "number" || typeof result === "boolean") {
    return { content: [{ type: "text", text: String(result) }], details: { browserTab } };
  }
  return result;
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
  let onCompactionActiveChange: (() => void) | undefined;
  const signaledPhases = new Set<"tool_execution_started" | "assistant_output_started">();
  const signalExecutionPhase = (phase: "tool_execution_started" | "assistant_output_started") => {
    if (signaledPhases.has(phase)) {
      return;
    }
    signaledPhases.add(phase);
    runParams.onExecutionPhase?.({
      phase,
      provider: runParams.provider,
      model: context.modelId,
      backend: context.backendResolved.id,
    });
  };
  let commentaryCounter = 0;
  let assistantVisibleText = "";
  const toolSummaryById = new Map<string, { failed: boolean; terminalObserved?: boolean }>();
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
    emitAgentEvent({
      runId: runParams.runId,
      stream: "tool",
      data: { ...data, name: stripOpenClawMcpToolPrefix(data.name) },
    });
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
    } else {
      current = { failed };
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
    signalExecutionPhase("tool_execution_started");
    if (tracked) {
      params.toolTracking.handleCliToolUseStart(event);
    }
    if (emitLiveEvents) {
      emitToolEvent({
        phase: "start",
        name: event.name,
        toolCallId: event.toolCallId,
        args: event.args,
      });
    }
  };
  const readNativeSkillCommand = (args: Record<string, unknown> | undefined) =>
    typeof args?.skill === "string"
      ? context.claudeSkillsPlugin.skillCommands?.get(args.skill.trim())
      : undefined;
  const emitToolResult = (event: CliToolResultDelta, tracked: boolean) => {
    observedCliActivity = true;
    const readResult = prepareToolResult(event.result);
    const summary = recordToolSummary(event, event.isError);
    const firstTerminal = !summary.terminalObserved;
    summary.terminalObserved = true;
    const loopbackOutcome = tracked
      ? params.toolTracking.resolveCliLoopbackTerminalOutcome(event.toolCallId)
      : undefined;
    // Resolve presentation metadata before the result retires loopback correlation.
    const browserTab =
      tracked && !event.isError && stripOpenClawMcpToolPrefix(event.name) === "browser"
        ? params.toolTracking.resolveCliLoopbackBrowserTab(event.toolCallId)
        : undefined;
    const executedArgs = tracked ? params.toolTracking.handleCliToolResult(event) : undefined;
    const startedCall = toolArgsByCallId.get(event.toolCallId);
    toolArgsByCallId.delete(event.toolCallId);
    // Claude loads plugin skills through its own Skill tool, which never passes the
    // OpenClaw tool wrapper; map the materialized command back to its canonical SKILL.md.
    const nativeSkill =
      event.name === "Skill" && firstTerminal && !event.isError
        ? readNativeSkillCommand(startedCall?.args)
        : undefined;
    if (nativeSkill) {
      recordSkillUsed({
        ctx: runParams,
        match: resolvedSkillUsageMatch({ activation: "read", skill: nativeSkill }),
        toolName: event.name,
        toolCallId: event.toolCallId,
      });
    }
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
          result:
            browserTab === undefined
              ? readResult()
              : withBrowserTabDetails(readResult(), browserTab),
          ...(tracked && startedArgs ? { args: startedArgs } : {}),
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
    const deadlineAtMs =
      timeoutMs !== undefined && event.name.startsWith("mcp__openclaw__")
        ? startedAt + timeoutMs
        : undefined;
    runParams.diagnosticOwner?.watchdogAttempt?.toolEvent({
      phase: "start",
      toolName: event.name,
      toolCallId: event.toolCallId,
      deadlineAtMs,
    });
    emitTrustedDiagnosticEvent(
      deadlineAtMs === undefined
        ? diagnosticEvent
        : markToolExecutionLivenessDiagnosticEvent(diagnosticEvent, { deadlineAtMs }),
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
    if (!event.incomplete) {
      runParams.diagnosticOwner?.watchdogAttempt?.toolEvent({
        phase: "end",
        toolName,
        toolCallId: event.toolCallId,
      });
    }
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
      onCompactionActiveChange?.();
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
    if (!emitLiveEvents || params.toolTracking.shouldSuppressAssistantOutput()) {
      return;
    }
    const prepared = prepareAgentRunTerminalReply({ rawText: text });
    const visibleText = applyPluginTextReplacements(
      prepared.text,
      context.backendResolved.textTransforms?.output,
    );
    if (!visibleText) {
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
      progressText: visibleText,
    }));
  };
  const emitCliAssistantDelta = ({ text, delta }: CliStreamingDelta) => {
    if (params.toolTracking.shouldSuppressAssistantOutput()) {
      return;
    }
    if (text || delta) {
      runParams.diagnosticOwner?.watchdogAttempt?.progress("semantic", "cli:assistant");
      observedCliActivity = true;
      signalExecutionPhase("assistant_output_started");
    }
    const candidate = text.trimStart().toUpperCase();
    const stripped = stripMixedSilentReplyTokens(text);
    if (
      stripped === null &&
      (SILENT_REPLY_TOKEN.startsWith(candidate) || isSilentReplyText(candidate))
    ) {
      return;
    }
    const sourceText = stripped ?? text;
    const sourceDelta = sourceText.startsWith(assistantVisibleText)
      ? sourceText.slice(assistantVisibleText.length)
      : sourceText;
    assistantVisibleText = sourceText;
    const preparedText = applyPluginTextReplacements(
      sourceText,
      context.backendResolved.textTransforms?.output,
    );
    emitLiveEvent("assistant", () => ({
      itemId: cliAssistantItemId(runParams.runId),
      text: preparedText,
      delta: applyPluginTextReplacements(
        sourceDelta,
        context.backendResolved.textTransforms?.output,
      ),
    }));
  };
  const emitCliCompletedReply = (text: string, assistantMessageIndex: number) => {
    if (params.toolTracking.shouldSuppressAssistantOutput()) {
      return;
    }
    if (text) {
      runParams.diagnosticOwner?.watchdogAttempt?.progress("semantic", "cli:completed_reply");
      observedCliActivity = true;
    }
    assistantVisibleText = "";
    const prepared = prepareAgentRunTerminalReply({ rawText: text });
    const visibleText = applyPluginTextReplacements(
      prepared.text,
      context.backendResolved.textTransforms?.output,
    );
    if (!visibleText) {
      return;
    }
    emitLiveEvent("assistant", () => ({
      assistantMessageIndex,
      completedText: visibleText,
    }));
  };

  // Emit-always: thinking reaches the event bus and session archive like the
  // embedded reasoning stream; /reasoning and /verbose gate presentation only.
  const emitCliThinkingDelta = ({
    text,
    delta,
    isReasoningSnapshot,
    modelProgress,
  }: CliThinkingDelta) => {
    if (params.toolTracking.shouldSuppressAssistantOutput()) {
      return;
    }
    if (modelProgress) {
      runParams.diagnosticOwner?.watchdogAttempt?.progressModel("cli:thinking");
    }
    if (text || delta) {
      observedCliActivity = true;
    }
    emitLiveEvent("thinking", () => ({
      text,
      delta,
      ...(isReasoningSnapshot ? { isReasoningSnapshot } : {}),
    }));
  };

  const emitCliThinkingProgress = ({ progressTokens, modelProgress }: CliThinkingProgress) => {
    if (!params.toolTracking.shouldSuppressAssistantOutput() && modelProgress) {
      runParams.diagnosticOwner?.watchdogAttempt?.progressModel("cli:thinking_tokens");
    }
    observedCliActivity = true;
    emitLiveEvent("thinking", () => ({ progressTokens }));
  };

  const emitCliToolInputDelta = (progress: CliToolInputDelta) => {
    observedCliActivity = true;
    emitLiveEvent("tool", () => ({ phase: "input_delta", ...progress }));
  };

  return {
    emitLiveEvents,
    emitCliToolInputDelta,
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
    setOnCompactionActiveChange: (listener: (() => void) | undefined) => {
      onCompactionActiveChange = listener;
    },
    activeParsedToolCount: () => activeParsedTools.size,
    isActiveForegroundAgentTool: (toolCallId: string) => {
      const tool = activeParsedTools.get(toolCallId);
      return tool !== undefined && isClaudeForegroundAgentToolName(tool.toolName);
    },
    getToolSummary,
  };
}

export type CliEventHandlers = ReturnType<typeof createCliEventHandlers>;
