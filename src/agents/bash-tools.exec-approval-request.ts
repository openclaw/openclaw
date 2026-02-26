import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import {
  DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from "./bash-tools.exec-runtime.js";
import { callGatewayTool } from "./tools/gateway.js";

export type RequestExecApprovalDecisionParams = {
  id: string;
  command: string;
  commandArgv?: string[];
  cwd: string;
  nodeId?: string;
  host: "gateway" | "node";
  security: ExecSecurity;
  ask: ExecAsk;
  agentId?: string;
  resolvedPath?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

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
    {
      id: params.id,
      command: params.command,
      commandArgv: params.commandArgv,
      cwd: params.cwd,
      nodeId: params.nodeId,
      host: params.host,
      security: params.security,
      ask: params.ask,
      agentId: params.agentId,
      resolvedPath: params.resolvedPath,
      sessionKey: params.sessionKey,
      turnSourceChannel: params.turnSourceChannel,
      turnSourceTo: params.turnSourceTo,
      turnSourceAccountId: params.turnSourceAccountId,
      turnSourceThreadId: params.turnSourceThreadId,
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      twoPhase: true,
    },
    { expectFinal: false },
  );
  const decision = parseDecision(registrationResult);
  const id = parseString(registrationResult?.id) ?? params.id;
  const expiresAtMs =
    parseExpiresAtMs(registrationResult?.expiresAtMs) ?? Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS;
  if (decision.present) {
    return { id, expiresAtMs, finalDecision: decision.value };
  }
  return { id, expiresAtMs };
}

export async function waitForExecApprovalDecision(id: string): Promise<string | null> {
  try {
    const decisionResult = await callGatewayTool<{ decision: string }>(
      "exec.approval.waitDecision",
      { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
      { id },
    );
    return parseDecision(decisionResult).value;
  } catch (err) {
    // Timeout/cleanup path: treat missing/expired as no decision so askFallback applies.
    const message = String(err).toLowerCase();
    if (message.includes("approval expired or not found")) {
      return null;
    }
    throw err;
  }
}

export async function requestExecApprovalDecision(
  params: RequestExecApprovalDecisionParams,
): Promise<string | null> {
  const registration = await registerExecApprovalRequest(params);
  if (Object.hasOwn(registration, "finalDecision")) {
    return registration.finalDecision ?? null;
  }
  return await waitForExecApprovalDecision(registration.id);
}

export async function requestExecApprovalDecisionForHost(params: {
  approvalId: string;
  command: string;
  commandArgv?: string[];
  workdir: string;
  host: "gateway" | "node";
  nodeId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  agentId?: string;
  resolvedPath?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
}): Promise<string | null> {
  return await requestExecApprovalDecision({
    id: params.approvalId,
    command: params.command,
    commandArgv: params.commandArgv,
    cwd: params.workdir,
    nodeId: params.nodeId,
    host: params.host,
    security: params.security,
    ask: params.ask,
    agentId: params.agentId,
    resolvedPath: params.resolvedPath,
    sessionKey: params.sessionKey,
    turnSourceChannel: params.turnSourceChannel,
    turnSourceTo: params.turnSourceTo,
    turnSourceAccountId: params.turnSourceAccountId,
    turnSourceThreadId: params.turnSourceThreadId,
  });
}

export async function registerExecApprovalRequestForHost(params: {
  approvalId: string;
  command: string;
  commandArgv?: string[];
  workdir: string;
  host: "gateway" | "node";
  nodeId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  agentId?: string;
  resolvedPath?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
}): Promise<ExecApprovalRegistration> {
  return await registerExecApprovalRequest({
    id: params.approvalId,
    command: params.command,
    commandArgv: params.commandArgv,
    cwd: params.workdir,
    nodeId: params.nodeId,
    host: params.host,
    security: params.security,
    ask: params.ask,
    agentId: params.agentId,
    resolvedPath: params.resolvedPath,
    sessionKey: params.sessionKey,
    turnSourceChannel: params.turnSourceChannel,
    turnSourceTo: params.turnSourceTo,
    turnSourceAccountId: params.turnSourceAccountId,
    turnSourceThreadId: params.turnSourceThreadId,
  });
}
