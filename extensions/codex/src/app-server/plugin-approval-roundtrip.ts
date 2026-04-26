import {
  callGatewayTool,
  emitContinuityDiagnostic,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";

export const DEFAULT_CODEX_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_PLUGIN_APPROVAL_TITLE_LENGTH = 80;
const MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH = 256;

type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";

export type AppServerApprovalOutcome =
  | "approved-once"
  | "approved-session"
  | "denied"
  | "unavailable"
  | "cancelled";

type ApprovalRequestResult = {
  id?: string;
  decision?: ExecApprovalDecision | null;
};

type ApprovalWaitResult = {
  id?: string;
  decision?: ExecApprovalDecision | null;
};

type LivePluginApprovalState =
  | {
      ok: true;
      pending: boolean;
      request?: unknown;
    }
  | {
      ok: false;
      pending?: undefined;
      error: string;
    };

async function resolveLiveCodexPluginApprovalState(
  approvalId: string,
): Promise<LivePluginApprovalState> {
  try {
    const requests = await callGatewayTool<unknown[]>(
      "plugin.approval.list",
      { timeoutMs: 3_000 },
      {},
      { expectFinal: false },
    );
    const list = Array.isArray(requests) ? requests : [];
    const request = list.find(
      (entry) =>
        Boolean(entry) &&
        typeof entry === "object" &&
        (entry as { id?: unknown }).id === approvalId,
    );
    return {
      ok: true,
      pending: Boolean(request),
      request,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function describeCodexPluginCarriedApprovalState(
  decision: ExecApprovalDecision | null | undefined,
): string {
  if (decision === undefined) {
    return "wait-for-live-decision";
  }
  if (decision === null) {
    return "resolved:null";
  }
  return `resolved:${decision}`;
}

function describeCodexPluginLiveApprovalState(live: LivePluginApprovalState): string {
  if (!live.ok) {
    return "unknown";
  }
  return live.pending ? "pending" : "not-pending";
}

function readRunId(paramsForRun: EmbeddedRunAttemptParams): string | undefined {
  const runId = (paramsForRun as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.trim() ? runId.trim() : undefined;
}

function emitCodexPluginApprovalCarryMismatch(params: {
  approvalId: string;
  paramsForRun: EmbeddedRunAttemptParams;
  toolName: string;
  toolCallId?: string;
  phase: string;
  severity?: "info" | "warn" | "error";
  carriedState: string;
  liveState: string;
  error?: string;
}): void {
  emitContinuityDiagnostic({
    type: "diag.approval.carry_mismatch",
    severity: params.severity ?? "warn",
    runId: readRunId(params.paramsForRun) ?? params.approvalId,
    sessionKey: params.paramsForRun.sessionKey,
    phase: params.phase,
    correlation: {
      approvalKind: "plugin",
      approvalId: params.approvalId,
      pluginId: "openclaw-codex-app-server",
      toolName: params.toolName,
      toolCallId: params.toolCallId,
    },
    details: {
      carriedState: params.carriedState,
      liveState: params.liveState,
      error: params.error,
    },
  });
}

export async function requestPluginApproval(params: {
  paramsForRun: EmbeddedRunAttemptParams;
  title: string;
  description: string;
  severity: "info" | "warning";
  toolName: string;
  toolCallId?: string;
}): Promise<ApprovalRequestResult | undefined> {
  const timeoutMs = DEFAULT_CODEX_APPROVAL_TIMEOUT_MS;
  return callGatewayTool(
    "plugin.approval.request",
    { timeoutMs: timeoutMs + 10_000 },
    {
      pluginId: "openclaw-codex-app-server",
      title: truncateForGateway(params.title, MAX_PLUGIN_APPROVAL_TITLE_LENGTH),
      description: truncateForGateway(params.description, MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH),
      severity: params.severity,
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      agentId: params.paramsForRun.agentId,
      sessionKey: params.paramsForRun.sessionKey,
      turnSourceChannel: params.paramsForRun.messageChannel ?? params.paramsForRun.messageProvider,
      turnSourceTo: params.paramsForRun.currentChannelId,
      turnSourceAccountId: params.paramsForRun.agentAccountId,
      turnSourceThreadId: params.paramsForRun.currentThreadTs,
      timeoutMs,
      twoPhase: true,
    },
    { expectFinal: false },
  ) as Promise<ApprovalRequestResult | undefined>;
}

export function approvalRequestExplicitlyUnavailable(result: unknown): boolean {
  if (result === null || result === undefined || typeof result !== "object") {
    return false;
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(result, "decision");
  } catch {
    return false;
  }
  return descriptor !== undefined && "value" in descriptor && descriptor.value === null;
}

export async function waitForPluginApprovalDecision(params: {
  approvalId: string;
  signal?: AbortSignal;
}): Promise<ExecApprovalDecision | null | undefined> {
  const timeoutMs = DEFAULT_CODEX_APPROVAL_TIMEOUT_MS;
  const waitPromise: Promise<ApprovalWaitResult | undefined> = callGatewayTool(
    "plugin.approval.waitDecision",
    { timeoutMs: timeoutMs + 10_000 },
    { id: params.approvalId },
  );
  if (!params.signal) {
    return (await waitPromise)?.decision;
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    if (params.signal!.aborted) {
      reject(params.signal!.reason);
      return;
    }
    onAbort = () => reject(params.signal!.reason);
    params.signal!.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return (await Promise.race([waitPromise, abortPromise]))?.decision;
  } finally {
    if (onAbort) {
      params.signal.removeEventListener("abort", onAbort);
    }
  }
}

export async function resolveCodexPluginApprovalDecision(params: {
  approvalId: string;
  requestResult?: ApprovalRequestResult;
  paramsForRun: EmbeddedRunAttemptParams;
  toolName: string;
  toolCallId?: string;
  signal?: AbortSignal;
}): Promise<ExecApprovalDecision | null | undefined> {
  const hasImmediateDecision = Object.prototype.hasOwnProperty.call(
    params.requestResult ?? {},
    "decision",
  );
  const preResolvedDecision = hasImmediateDecision ? params.requestResult?.decision : undefined;
  const carriedState = describeCodexPluginCarriedApprovalState(preResolvedDecision);
  if (hasImmediateDecision) {
    const liveBefore = await resolveLiveCodexPluginApprovalState(params.approvalId);
    if (liveBefore.ok && liveBefore.pending) {
      emitCodexPluginApprovalCarryMismatch({
        approvalId: params.approvalId,
        paramsForRun: params.paramsForRun,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        phase: "before_plugin_decision_use",
        carriedState,
        liveState: describeCodexPluginLiveApprovalState(liveBefore),
      });
    } else if (!liveBefore.ok) {
      emitCodexPluginApprovalCarryMismatch({
        approvalId: params.approvalId,
        paramsForRun: params.paramsForRun,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        phase: "before_plugin_decision_use",
        severity: "info",
        carriedState,
        liveState: "unknown",
        error: liveBefore.error,
      });
    }
  }
  const decision = hasImmediateDecision
    ? preResolvedDecision
    : await waitForPluginApprovalDecision({
        approvalId: params.approvalId,
        signal: params.signal,
      });
  const liveAfter = await resolveLiveCodexPluginApprovalState(params.approvalId);
  if (liveAfter.ok && liveAfter.pending && decision !== undefined) {
    emitCodexPluginApprovalCarryMismatch({
      approvalId: params.approvalId,
      paramsForRun: params.paramsForRun,
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      phase: "after_plugin_decision_resolve",
      carriedState: `decision:${decision ?? "null"}`,
      liveState: describeCodexPluginLiveApprovalState(liveAfter),
    });
  }
  return decision;
}

export function mapExecDecisionToOutcome(
  decision: ExecApprovalDecision | null | undefined,
): AppServerApprovalOutcome {
  if (decision === "allow-once") {
    return "approved-once";
  }
  if (decision === "allow-always") {
    return "approved-session";
  }
  if (decision === null || decision === undefined) {
    return "unavailable";
  }
  return "denied";
}

function truncateForGateway(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
