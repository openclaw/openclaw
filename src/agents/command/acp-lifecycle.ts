// ACP result and event projection does not need the embedded or CLI execution runtime.
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { ACP_TURN_TIMEOUT_DETAIL_CODE } from "../../acp/control-plane/manager.turn-timeout.js";
import { formatAcpErrorChain } from "../../acp/runtime/errors.js";
import { resolveAcpToolTerminalOutcome } from "../../acp/tool-status.js";
import { normalizeReplyPayload } from "../../auto-reply/reply/normalize-reply.js";
import { emitAgentAuditEvent, emitAgentEvent } from "../../infra/agent-events.js";
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agent-run-terminal-outcome.js";
import type { AgentRunTerminalReplySnapshot } from "../agent-run-terminal-reply.types.js";
import { resolveAgentRunAbortLifecycleFields } from "../run-termination.js";

export function buildAcpResult(params: {
  payloadText: string;
  terminalReply?: AgentRunTerminalReplySnapshot;
  startedAt: number;
  stopReason?: string;
  resultStatus?: Extract<AcpRuntimeEvent, { type: "done" }>["status"];
  abortSignal?: AbortSignal;
}) {
  const normalizedFinalPayload = normalizeReplyPayload({
    text: params.payloadText,
  });
  const payloads = normalizedFinalPayload ? [normalizedFinalPayload] : [];
  const abortFields = resolveAgentRunAbortLifecycleFields(params.abortSignal);
  const resultCancelled = params.resultStatus === "cancelled";
  return {
    payloads,
    meta: {
      durationMs: Date.now() - params.startedAt,
      aborted: abortFields.aborted ?? resultCancelled,
      stopReason: abortFields.stopReason ?? (resultCancelled ? "stop" : params.stopReason),
      ...(params.terminalReply ? { terminalReply: params.terminalReply } : {}),
    },
  };
}

type AcpRunIdentity = Pick<
  Parameters<typeof emitAgentEvent>[0],
  "runId" | "sessionKey" | "agentId"
>;
type AcpLifecycleContext = AcpRunIdentity & {
  lifecycleGeneration?: string;
  auditOnly?: boolean;
  completionSource?: "reply-dispatch";
};

function acpRunIdentity(params: AcpRunIdentity) {
  return {
    runId: params.runId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
  };
}

function emitAcpLifecycleEvent(params: AcpLifecycleContext, data: Record<string, unknown>) {
  const emit = params.auditOnly ? emitAgentAuditEvent : emitAgentEvent;
  emit({
    ...acpRunIdentity(params),
    ...(params.lifecycleGeneration ? { lifecycleGeneration: params.lifecycleGeneration } : {}),
    stream: "lifecycle",
    data,
  });
}

export function emitAcpLifecycleStart(params: AcpLifecycleContext & { startedAt: number }) {
  emitAcpLifecycleEvent(params, {
    phase: "start",
    ...(params.completionSource ? { completionSource: params.completionSource } : {}),
    startedAt: params.startedAt,
  });
}

const ACP_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
type ActiveAcpTool = AcpRunIdentity & {
  toolCallId: string;
  toolName: string;
  startedAt: number;
};

type AcpToolLifecycleTracker = {
  active: Map<string, ActiveAcpTool>;
  terminalToolCallIds: Set<string>;
  saturated: boolean;
};

const MAX_TRACKED_ACP_TOOLS = 4_096;

export function createAcpToolLifecycleTracker(): AcpToolLifecycleTracker {
  return {
    active: new Map(),
    terminalToolCallIds: new Set(),
    saturated: false,
  };
}

function acpAuditToolName(kind: unknown): string {
  switch (kind) {
    case "read":
    case "edit":
    case "delete":
    case "move":
    case "search":
    case "execute":
    case "fetch":
    case "switch_mode":
    case "think":
    case "other":
      return `acp_${kind}`;
    default:
      return "acp_tool";
  }
}

function resolveAcpToolTerminalReason(
  signal: AbortSignal | undefined,
  stopReason?: string,
  error?: unknown,
  resultStatus?: Extract<AcpRuntimeEvent, { type: "done" }>["status"],
): "failed" | "cancelled" | "timed_out" {
  const abortFields = resolveAgentRunAbortLifecycleFields(signal);
  if (abortFields.aborted) {
    return abortFields.stopReason === "timeout" ? "timed_out" : "cancelled";
  }
  const normalizedStopReason = normalizeOptionalLowercaseString(stopReason);
  if (normalizedStopReason === "timeout") {
    return "timed_out";
  }
  if (resultStatus === "cancelled") {
    return "cancelled";
  }
  if (
    error instanceof Error &&
    // SAFETY: Error is narrowed above; detailCode stays optional and unknown until compared.
    (error as Error & { detailCode?: unknown }).detailCode === ACP_TURN_TIMEOUT_DETAIL_CODE
  ) {
    return "timed_out";
  }
  if (
    normalizedStopReason === "cancel" ||
    normalizedStopReason === "cancelled" ||
    normalizedStopReason === "manual-cancel"
  ) {
    return "cancelled";
  }
  return "failed";
}

export function resolveAcpLifecycleEndFields(
  signal: AbortSignal | undefined,
  stopReason?: string,
  resultStatus?: Extract<AcpRuntimeEvent, { type: "done" }>["status"],
) {
  const abortFields = resolveAgentRunAbortLifecycleFields(signal);
  if (abortFields.aborted) {
    return abortFields;
  }
  const terminalReason = resolveAcpToolTerminalReason(
    undefined,
    stopReason,
    undefined,
    resultStatus,
  );
  if (terminalReason === "timed_out") {
    return { aborted: true, stopReason: "timeout", status: "timed_out" } as const;
  }
  if (terminalReason === "cancelled") {
    return { aborted: true, stopReason: "stop", status: "cancelled" } as const;
  }
  return {};
}

function emitAcpToolExecutionEvent(
  params: AcpRunIdentity & {
    toolTracker: AcpToolLifecycleTracker;
    abortSignal?: AbortSignal;
    event: Extract<AcpRuntimeEvent, { type: "tool_call" }>;
  },
): void {
  const { event } = params;
  const now = Date.now();
  const toolCallId = event.toolCallId?.trim() ? event.toolCallId : undefined;
  const activeTool = toolCallId ? params.toolTracker.active.get(toolCallId) : undefined;
  const terminalOutcome = resolveAcpToolTerminalOutcome(event.status);
  const toolName = acpAuditToolName(event.kind);
  // ACP runtimes may replay terminal updates. Keep the closed identity until the run ends so a
  // late progress/terminal pair cannot reopen one invocation as a second durable audit action.
  if (toolCallId && !activeTool) {
    if (params.toolTracker.terminalToolCallIds.has(toolCallId)) {
      return;
    }
    // Never evict an open identity: once this run reaches its bound, ignore new identities until
    // lifecycle cleanup releases the complete set. Other runs own independent trackers.
    const trackedIdentities =
      params.toolTracker.active.size + params.toolTracker.terminalToolCallIds.size;
    if (params.toolTracker.saturated || trackedIdentities >= MAX_TRACKED_ACP_TOOLS) {
      params.toolTracker.saturated = true;
      return;
    }
  }
  // Without an identity, wait for a terminal event so every observed action closes immediately.
  // Opening on progress would leave an unmatched audit action if the runtime omits its result.
  const startsUnidentifiedTool = toolCallId === undefined && terminalOutcome !== undefined;
  if (!activeTool && (toolCallId !== undefined || startsUnidentifiedTool)) {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      ...acpRunIdentity(params),
      ...(toolCallId ? { toolCallId } : {}),
      toolName,
      toolSource: "core",
      toolOwner: "acp",
    });
    if (toolCallId) {
      params.toolTracker.active.set(toolCallId, {
        ...acpRunIdentity(params),
        toolCallId,
        toolName,
        startedAt: now,
      });
    }
  }
  if (!terminalOutcome) {
    return;
  }
  const terminalReason = resolveAcpToolTerminalReason(
    params.abortSignal,
    undefined,
    undefined,
    terminalOutcome === "cancelled" ? "cancelled" : undefined,
  );
  const durationMs = Math.max(0, now - (activeTool?.startedAt ?? now));
  const terminalFields = {
    ...acpRunIdentity(params),
    ...(toolCallId ? { toolCallId } : {}),
    toolName: activeTool?.toolName ?? toolName,
    toolSource: "core" as const,
    toolOwner: "acp",
    durationMs,
  };
  emitTrustedDiagnosticEvent(
    terminalOutcome === "completed"
      ? { type: "tool.execution.completed", ...terminalFields }
      : {
          type: "tool.execution.error",
          ...terminalFields,
          errorCategory: terminalReason === "cancelled" ? "aborted" : "acp_tool",
          terminalReason,
        },
  );
  if (toolCallId) {
    params.toolTracker.active.delete(toolCallId);
    params.toolTracker.terminalToolCallIds.add(toolCallId);
  }
}

function finalizeAcpToolsForRun(
  toolTracker: AcpToolLifecycleTracker,
  runId: string,
  terminalReason: "failed" | "cancelled" | "timed_out",
): void {
  const now = Date.now();
  for (const activeTool of toolTracker.active.values()) {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId,
      ...(activeTool.sessionKey ? { sessionKey: activeTool.sessionKey } : {}),
      ...(activeTool.agentId ? { agentId: activeTool.agentId } : {}),
      toolName: activeTool.toolName,
      toolSource: "core",
      toolOwner: "acp",
      toolCallId: activeTool.toolCallId,
      durationMs: Math.max(0, now - activeTool.startedAt),
      errorCategory: terminalReason === "cancelled" ? "aborted" : "acp_tool_incomplete",
      terminalReason,
    });
  }
  toolTracker.active.clear();
  toolTracker.terminalToolCallIds.clear();
  toolTracker.saturated = false;
}

function resolvePresentProxyEnvKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return ACP_PROXY_ENV_KEYS.filter((key) => Boolean(env[key]?.trim()));
}

function sanitizeAcpDiagnosticText(value: string): string {
  return truncateUtf16Safe(redactSensitiveText(value).replace(/\s+/g, " ").trim(), 240);
}

function acpRuntimeEventDiagnostics(event: AcpRuntimeEvent): Record<string, unknown> {
  if (event.type === "status" || event.type === "tool_call") {
    return {
      eventType: event.type,
      text: sanitizeAcpDiagnosticText(event.text),
      ...(event.tag ? { tag: event.tag } : {}),
      ...(event.type === "tool_call"
        ? {
            ...(event.status ? { status: sanitizeAcpDiagnosticText(event.status) } : {}),
            ...(event.title ? { title: sanitizeAcpDiagnosticText(event.title) } : {}),
            ...(event.toolCallId
              ? { toolCallId: sanitizeAcpDiagnosticText(event.toolCallId) }
              : {}),
          }
        : {}),
    };
  }
  if (event.type === "error") {
    return {
      eventType: event.type,
      message: sanitizeAcpDiagnosticText(event.message),
      ...(event.code ? { code: sanitizeAcpDiagnosticText(event.code) } : {}),
      ...(typeof event.retryable === "boolean" ? { retryable: event.retryable } : {}),
    };
  }
  if (event.type === "done") {
    return {
      eventType: event.type,
      ...(event.status ? { status: event.status } : {}),
      ...(event.stopReason ? { stopReason: sanitizeAcpDiagnosticText(event.stopReason) } : {}),
    };
  }
  return {
    eventType: event.type,
    stream: event.stream ?? "output",
  };
}

export function emitAcpPromptSubmitted(params: { runId: string; sessionKey?: string; at: number }) {
  emitAgentEvent({
    runId: params.runId,
    stream: "acp",
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    data: {
      phase: "prompt_submitted",
      at: params.at,
      proxyEnvKeys: resolvePresentProxyEnvKeys(),
    },
  });
}

export function emitAcpRuntimeEvent(
  params: AcpRunIdentity & {
    toolTracker: AcpToolLifecycleTracker;
    event: AcpRuntimeEvent;
    abortSignal?: AbortSignal;
    auditOnly?: boolean;
  },
) {
  if (params.event.type === "tool_call") {
    emitAcpToolExecutionEvent({
      ...params,
      event: params.event,
    });
  }
  if (!params.auditOnly) {
    emitAgentEvent({
      ...acpRunIdentity(params),
      stream: "acp",
      data: {
        phase: "runtime_event",
        ...acpRuntimeEventDiagnostics(params.event),
      },
    });
  }
}

function emitAcpTerminalLifecycle(
  params: AcpLifecycleContext,
  terminal: Record<string, unknown> & { phase: "end" | "error"; endedAt: number },
) {
  const data = {
    ...terminal,
    executionSettled: true,
    ...(params.completionSource ? { completionSource: params.completionSource } : {}),
  };
  emitAcpLifecycleEvent(params, data);
  return buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase: terminal.phase,
    data,
    endedAt: terminal.endedAt,
  });
}

export function emitAcpLifecycleEnd(
  params: AcpLifecycleContext & {
    toolTracker: AcpToolLifecycleTracker;
    endFields: ReturnType<typeof resolveAcpLifecycleEndFields>;
    terminalReply?: AgentRunTerminalReplySnapshot;
  },
) {
  finalizeAcpToolsForRun(
    params.toolTracker,
    params.runId,
    params.endFields.stopReason === "timeout"
      ? "timed_out"
      : params.endFields.aborted
        ? "cancelled"
        : "failed",
  );
  return emitAcpTerminalLifecycle(params, {
    phase: "end",
    endedAt: Date.now(),
    ...params.endFields,
    ...(params.terminalReply ? { terminalReply: params.terminalReply } : {}),
  });
}

export function emitAcpLifecycleError(
  params: AcpLifecycleContext & {
    toolTracker: AcpToolLifecycleTracker;
    error: unknown;
    abortSignal?: AbortSignal;
    terminalOutcome?: "blocked";
  },
) {
  const terminalReason = resolveAcpToolTerminalReason(params.abortSignal, undefined, params.error);
  finalizeAcpToolsForRun(params.toolTracker, params.runId, terminalReason);
  const lifecycleFields =
    params.terminalOutcome === "blocked"
      ? ({ livenessState: "blocked" } as const)
      : terminalReason === "timed_out"
        ? ({ aborted: true, stopReason: "timeout", status: "timed_out" } as const)
        : resolveAgentRunAbortLifecycleFields(params.abortSignal);
  return emitAcpTerminalLifecycle(params, {
    phase: "error",
    ...(!params.auditOnly ? { error: formatAcpErrorChain(params.error) } : {}),
    endedAt: Date.now(),
    ...lifecycleFields,
  });
}

export function emitAcpAssistantDelta(params: { runId: string; text: string; delta: string }) {
  emitAgentEvent({
    runId: params.runId,
    stream: "assistant",
    data: {
      text: params.text,
      delta: params.delta,
    },
  });
}
