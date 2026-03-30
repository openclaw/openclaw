import { loadConfig } from "../config/config.js";
import type { ExecAsk, ExecSecurity, SystemRunApprovalPlan } from "../infra/exec-approvals.js";
import { emitStandaloneResearchEvent } from "../research/events/runtime-hooks.js";
import {
  DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from "./bash-tools.exec-runtime.js";
import { callGatewayTool } from "./tools/gateway.js";

export type RequestExecApprovalDecisionParams = {
  id: string;
  command?: string;
  commandArgv?: string[];
  systemRunPlan?: SystemRunApprovalPlan;
  env?: Record<string, string>;
  cwd: string;
  nodeId?: string;
  host: "gateway" | "node";
  security: ExecSecurity;
  ask: ExecAsk;
  agentId?: string;
  resolvedPath?: string;
  sessionKey?: string;
  /** Chat/session UUID for research events (not the approval id). */
  sessionId?: string;
  /** Embedded agent `runId` so approval events stay in the same research buffer as the turn. */
  agentRunId?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

type ExecApprovalRequestToolParams = RequestExecApprovalDecisionParams & {
  timeoutMs: number;
  twoPhase: true;
};

function buildExecApprovalRequestToolParams(
  params: RequestExecApprovalDecisionParams,
): ExecApprovalRequestToolParams {
  return {
    id: params.id,
    ...(params.command ? { command: params.command } : {}),
    ...(params.commandArgv ? { commandArgv: params.commandArgv } : {}),
    systemRunPlan: params.systemRunPlan,
    env: params.env,
    cwd: params.cwd,
    nodeId: params.nodeId,
    host: params.host,
    security: params.security,
    ask: params.ask,
    agentId: params.agentId,
    resolvedPath: params.resolvedPath,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentRunId: params.agentRunId,
    turnSourceChannel: params.turnSourceChannel,
    turnSourceTo: params.turnSourceTo,
    turnSourceAccountId: params.turnSourceAccountId,
    turnSourceThreadId: params.turnSourceThreadId,
    timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    twoPhase: true,
  };
}

type ParsedDecision = { present: boolean; value: string | null };

function parseDecision(value: unknown): ParsedDecision {
  if (!value || typeof value !== "object") {
    return { present: false, value: null };
  }
  // Distinguish "field missing" from "field present but null/invalid".
  // Registration responses intentionally omit `decision`; decision waits can include it.
  if (!Object.hasOwn(value, "decision")) {
    return { present: false, value: null };
  }
  const decision = (value as { decision?: unknown }).decision;
  return { present: true, value: typeof decision === "string" ? decision : null };
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseExpiresAtMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type ExecApprovalResolutionTelemetryParams = {
  approvalId: string;
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
  agentRunId?: string;
};

/** Same payload shape as the `exec.approval.waitDecision` success path in `waitForExecApprovalDecision`. */
async function emitExecApprovalResolutionTelemetry(
  params: ExecApprovalResolutionTelemetryParams,
  decisionValue: string | null,
): Promise<void> {
  try {
    const cfg = loadConfig();
    await emitStandaloneResearchEvent({
      cfg,
      runId: params.agentRunId ?? params.approvalId,
      sessionId: params.sessionId ?? params.approvalId,
      sessionKey: params.sessionKey,
      agentId: params.agentId ?? "default",
      event: {
        kind:
          decisionValue && decisionValue.startsWith("allow") ? "approval.allow" : "approval.deny",
        payload: {
          approvalId: params.approvalId,
          ...(params.agentRunId ? { agentRunId: params.agentRunId } : {}),
          decision: decisionValue ?? undefined,
          ...(decisionValue && decisionValue.startsWith("allow")
            ? {}
            : { reason: "approval wait resolved deny" }),
        },
      },
    });
  } catch {
    // Best-effort telemetry only.
  }
}

export type ExecApprovalRegistration = {
  id: string;
  expiresAtMs: number;
  finalDecision?: string | null;
};

export async function registerExecApprovalRequest(
  params: RequestExecApprovalDecisionParams,
): Promise<ExecApprovalRegistration> {
  // Two-phase registration is critical: the ID must be registered server-side
  // before exec returns `approval-pending`, otherwise `/approve` can race and orphan.
  const registrationResult = await callGatewayTool<{
    id?: string;
    expiresAtMs?: number;
    decision?: string;
  }>(
    "exec.approval.request",
    { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
    buildExecApprovalRequestToolParams(params),
    { expectFinal: false },
  );
  const decision = parseDecision(registrationResult);
  const id = parseString(registrationResult?.id) ?? params.id;
  const expiresAtMs =
    parseExpiresAtMs(registrationResult?.expiresAtMs) ?? Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS;
  try {
    const cfg = loadConfig();
    await emitStandaloneResearchEvent({
      cfg,
      runId: params.agentRunId ?? id,
      sessionId: params.sessionId ?? id,
      sessionKey: params.sessionKey,
      agentId: params.agentId ?? "default",
      event: {
        kind: "approval.request",
        payload: {
          approvalId: id,
          ...(params.agentRunId ? { agentRunId: params.agentRunId } : {}),
          host: params.host,
          commandSummary: params.command?.slice(0, 200),
        },
      },
    });
  } catch {
    // Best-effort telemetry only.
  }
  if (decision.present) {
    return { id, expiresAtMs, finalDecision: decision.value };
  }
  return { id, expiresAtMs };
}

export async function waitForExecApprovalDecision(params: {
  id: string;
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
  agentRunId?: string;
}): Promise<string | null> {
  try {
    const decisionResult = await callGatewayTool<{ decision: string }>(
      "exec.approval.waitDecision",
      { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
      {
        id: params.id,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      },
    );
    const value = parseDecision(decisionResult).value;
    await emitExecApprovalResolutionTelemetry(
      {
        approvalId: params.id,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        sessionId: params.sessionId,
        agentRunId: params.agentRunId,
      },
      value,
    );
    return value;
  } catch (err) {
    // Timeout/cleanup path: treat missing/expired as no decision so askFallback applies.
    const message = String(err).toLowerCase();
    if (message.includes("approval expired or not found")) {
      try {
        const cfg = loadConfig();
        await emitStandaloneResearchEvent({
          cfg,
          runId: params.agentRunId ?? params.id,
          sessionId: params.sessionId ?? params.id,
          sessionKey: params.sessionKey,
          agentId: params.agentId ?? "default",
          event: {
            kind: "approval.deny",
            payload: {
              approvalId: params.id,
              ...(params.agentRunId ? { agentRunId: params.agentRunId } : {}),
              reason: "approval expired or not found",
            },
          },
        });
      } catch {
        // Best-effort telemetry only.
      }
      return null;
    }
    throw err;
  }
}

export async function resolveRegisteredExecApprovalDecision(params: {
  approvalId: string;
  preResolvedDecision: string | null | undefined;
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
  agentRunId?: string;
}): Promise<string | null> {
  if (params.preResolvedDecision !== undefined) {
    return params.preResolvedDecision ?? null;
  }
  return await waitForExecApprovalDecision({
    id: params.approvalId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionId: params.sessionId,
    agentRunId: params.agentRunId,
  });
}

export async function requestExecApprovalDecision(
  params: RequestExecApprovalDecisionParams,
): Promise<string | null> {
  const registration = await registerExecApprovalRequest(params);
  if (Object.hasOwn(registration, "finalDecision")) {
    await emitExecApprovalResolutionTelemetry(
      {
        approvalId: registration.id,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        sessionId: params.sessionId,
        agentRunId: params.agentRunId,
      },
      registration.finalDecision ?? null,
    );
    return registration.finalDecision ?? null;
  }
  return await waitForExecApprovalDecision({
    id: registration.id,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionId: params.sessionId,
    agentRunId: params.agentRunId,
  });
}

type HostExecApprovalParams = {
  approvalId: string;
  command?: string;
  commandArgv?: string[];
  systemRunPlan?: SystemRunApprovalPlan;
  env?: Record<string, string>;
  workdir: string;
  host: "gateway" | "node";
  nodeId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  agentId?: string;
  resolvedPath?: string;
  sessionKey?: string;
  sessionId?: string;
  agentRunId?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

type ExecApprovalRequesterContext = {
  agentId?: string;
  sessionKey?: string;
};

export function buildExecApprovalRequesterContext(params: ExecApprovalRequesterContext): {
  agentId?: string;
  sessionKey?: string;
} {
  return {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  };
}

type ExecApprovalTurnSourceContext = {
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

export function buildExecApprovalTurnSourceContext(
  params: ExecApprovalTurnSourceContext,
): ExecApprovalTurnSourceContext {
  return {
    turnSourceChannel: params.turnSourceChannel,
    turnSourceTo: params.turnSourceTo,
    turnSourceAccountId: params.turnSourceAccountId,
    turnSourceThreadId: params.turnSourceThreadId,
  };
}

function buildHostApprovalDecisionParams(
  params: HostExecApprovalParams,
): RequestExecApprovalDecisionParams {
  return {
    id: params.approvalId,
    command: params.command,
    commandArgv: params.commandArgv,
    systemRunPlan: params.systemRunPlan,
    env: params.env,
    cwd: params.workdir,
    nodeId: params.nodeId,
    host: params.host,
    security: params.security,
    ask: params.ask,
    ...buildExecApprovalRequesterContext({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    }),
    resolvedPath: params.resolvedPath,
    sessionId: params.sessionId,
    agentRunId: params.agentRunId,
    ...buildExecApprovalTurnSourceContext(params),
  };
}

export async function requestExecApprovalDecisionForHost(
  params: HostExecApprovalParams,
): Promise<string | null> {
  return await requestExecApprovalDecision(buildHostApprovalDecisionParams(params));
}

export async function registerExecApprovalRequestForHost(
  params: HostExecApprovalParams,
): Promise<ExecApprovalRegistration> {
  return await registerExecApprovalRequest(buildHostApprovalDecisionParams(params));
}

export async function registerExecApprovalRequestForHostOrThrow(
  params: HostExecApprovalParams,
): Promise<ExecApprovalRegistration> {
  try {
    return await registerExecApprovalRequestForHost(params);
  } catch (err) {
    throw new Error(`Exec approval registration failed: ${String(err)}`, { cause: err });
  }
}
