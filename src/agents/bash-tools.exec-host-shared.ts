import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { loadConfig } from "../config/config.js";
import { buildExecApprovalUnavailableReplyPayload } from "../infra/exec-approval-reply.js";
import {
  hasConfiguredExecApprovalDmRoute,
  type ExecApprovalInitiatingSurfaceState,
  resolveExecApprovalInitiatingSurfaceState,
} from "../infra/exec-approval-surface.js";
import {
  maxAsk,
  minSecurity,
  resolveExecApprovals,
  type ExecAsk,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import { logWarn } from "../logger.js";
import { sendExecApprovalFollowup } from "./bash-tools.exec-approval-followup.js";
import {
  type ExecApprovalRegistration,
  resolveRegisteredExecApprovalDecision,
} from "./bash-tools.exec-approval-request.js";
import { buildApprovalPendingMessage } from "./bash-tools.exec-runtime.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";

type ResolvedExecApprovals = ReturnType<typeof resolveExecApprovals>;
const loggedExecApprovalFollowupFailures = new Set<string>();

export type ExecHostApprovalContext = {
  approvals: ResolvedExecApprovals;
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  askFallback: ResolvedExecApprovals["agent"]["askFallback"];
};

export type ExecApprovalPendingState = {
  warningText: string;
  expiresAtMs: number;
  preResolvedDecision: string | null | undefined;
};

export type ExecApprovalRequestState = ExecApprovalPendingState & {
  noticeSeconds: number;
};

export type ExecApprovalUnavailableReason =
  | "no-approval-route"
  | "initiating-platform-disabled"
  | "initiating-platform-unsupported";

export type RegisteredExecApprovalRequestContext = {
  approvalId: string;
  approvalSlug: string;
  warningText: string;
  expiresAtMs: number;
  preResolvedDecision: string | null | undefined;
  initiatingSurface: ExecApprovalInitiatingSurfaceState;
  sentApproverDms: boolean;
  unavailableReason: ExecApprovalUnavailableReason | null;
};

export type ExecApprovalFollowupTarget = {
  approvalId: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

export type DefaultExecApprovalRequestArgs = {
  warnings: string[];
  approvalRunningNoticeMs: number;
  createApprovalSlug: (approvalId: string) => string;
  turnSourceChannel?: string;
  turnSourceAccountId?: string;
};

export function createExecApprovalPendingState(params: {
  warnings: string[];
  timeoutMs: number;
}): ExecApprovalPendingState {
  return {
    warningText: params.warnings.length ? `${params.warnings.join("\n")}\n\n` : "",
    expiresAtMs: Date.now() + params.timeoutMs,
    preResolvedDecision: undefined,
  };
}

export function createExecApprovalRequestState(params: {
  warnings: string[];
  timeoutMs: number;
  approvalRunningNoticeMs: number;
}): ExecApprovalRequestState {
  const pendingState = createExecApprovalPendingState({
    warnings: params.warnings,
    timeoutMs: params.timeoutMs,
  });
  return {
    ...pendingState,
    noticeSeconds: Math.max(1, Math.round(params.approvalRunningNoticeMs / 1000)),
  };
}

export function createExecApprovalRequestContext(params: {
  warnings: string[];
  timeoutMs: number;
  approvalRunningNoticeMs: number;
  createApprovalSlug: (approvalId: string) => string;
}): ExecApprovalRequestState & {
  approvalId: string;
  approvalSlug: string;
  contextKey: string;
} {
  const approvalId = crypto.randomUUID();
  const pendingState = createExecApprovalRequestState({
    warnings: params.warnings,
    timeoutMs: params.timeoutMs,
    approvalRunningNoticeMs: params.approvalRunningNoticeMs,
  });
  return {
    ...pendingState,
    approvalId,
    approvalSlug: params.createApprovalSlug(approvalId),
    contextKey: `exec:${approvalId}`,
  };
}

export function createDefaultExecApprovalRequestContext(params: {
  warnings: string[];
  approvalRunningNoticeMs: number;
  createApprovalSlug: (approvalId: string) => string;
}) {
  return createExecApprovalRequestContext({
    warnings: params.warnings,
    timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    approvalRunningNoticeMs: params.approvalRunningNoticeMs,
    createApprovalSlug: params.createApprovalSlug,
  });
}

export function resolveBaseExecApprovalDecision(params: {
  decision: string | null;
  askFallback: ResolvedExecApprovals["agent"]["askFallback"];
  obfuscationDetected: boolean;
}): {
  approvedByAsk: boolean;
  deniedReason: string | null;
  timedOut: boolean;
} {
  if (params.decision === "deny") {
    return { approvedByAsk: false, deniedReason: "user-denied", timedOut: false };
  }
  if (!params.decision) {
    if (params.obfuscationDetected) {
      return {
        approvedByAsk: false,
        deniedReason: "approval-timeout (obfuscation-detected)",
        timedOut: true,
      };
    }
    if (params.askFallback === "full") {
      return { approvedByAsk: true, deniedReason: null, timedOut: true };
    }
    if (params.askFallback === "deny") {
      return { approvedByAsk: false, deniedReason: "approval-timeout", timedOut: true };
    }
    return { approvedByAsk: false, deniedReason: null, timedOut: true };
  }
  return { approvedByAsk: false, deniedReason: null, timedOut: false };
}

export function resolveExecHostApprovalContext(params: {
  agentId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  host: "gateway" | "node";
}): ExecHostApprovalContext {
  const approvals = resolveExecApprovals(params.agentId, {
    security: params.security,
    ask: params.ask,
  });
  const hostSecurity = minSecurity(params.security, approvals.agent.security);
  // An explicit ask=off policy in exec-approvals.json must be able to suppress
  // prompts even when tool/runtime defaults are stricter (for example on-miss).
  const hostAsk = approvals.agent.ask === "off" ? "off" : maxAsk(params.ask, approvals.agent.ask);
  const askFallback = approvals.agent.askFallback;
  if (hostSecurity === "deny") {
    throw new Error(`exec denied: host=${params.host} security=deny`);
  }
  return { approvals, hostSecurity, hostAsk, askFallback };
}

export async function resolveApprovalDecisionOrUndefined(params: {
  approvalId: string;
  preResolvedDecision: string | null | undefined;
  onFailure: () => void;
}): Promise<string | null | undefined> {
  try {
    return await resolveRegisteredExecApprovalDecision({
      approvalId: params.approvalId,
      preResolvedDecision: params.preResolvedDecision,
    });
  } catch {
    params.onFailure();
    return undefined;
  }
}

export function resolveExecApprovalUnavailableState(params: {
  turnSourceChannel?: string;
  turnSourceAccountId?: string;
  preResolvedDecision: string | null | undefined;
}): {
  initiatingSurface: ExecApprovalInitiatingSurfaceState;
  sentApproverDms: boolean;
  unavailableReason: ExecApprovalUnavailableReason | null;
} {
  const initiatingSurface = resolveExecApprovalInitiatingSurfaceState({
    channel: params.turnSourceChannel,
    accountId: params.turnSourceAccountId,
  });
  const sentApproverDms =
    (initiatingSurface.kind === "disabled" || initiatingSurface.kind === "unsupported") &&
    hasConfiguredExecApprovalDmRoute(loadConfig());
  const unavailableReason =
    params.preResolvedDecision === null
      ? "no-approval-route"
      : initiatingSurface.kind === "disabled"
        ? "initiating-platform-disabled"
        : initiatingSurface.kind === "unsupported"
          ? "initiating-platform-unsupported"
          : null;
  return {
    initiatingSurface,
    sentApproverDms,
    unavailableReason,
  };
}

export async function createAndRegisterDefaultExecApprovalRequest(params: {
  warnings: string[];
  approvalRunningNoticeMs: number;
  createApprovalSlug: (approvalId: string) => string;
  turnSourceChannel?: string;
  turnSourceAccountId?: string;
  register: (approvalId: string) => Promise<ExecApprovalRegistration>;
}): Promise<RegisteredExecApprovalRequestContext> {
  const {
    approvalId,
    approvalSlug,
    warningText,
    expiresAtMs: defaultExpiresAtMs,
    preResolvedDecision: defaultPreResolvedDecision,
  } = createDefaultExecApprovalRequestContext({
    warnings: params.warnings,
    approvalRunningNoticeMs: params.approvalRunningNoticeMs,
    createApprovalSlug: params.createApprovalSlug,
  });
  const registration = await params.register(approvalId);
  const preResolvedDecision = registration.finalDecision;
  const { initiatingSurface, sentApproverDms, unavailableReason } =
    resolveExecApprovalUnavailableState({
      turnSourceChannel: params.turnSourceChannel,
      turnSourceAccountId: params.turnSourceAccountId,
      preResolvedDecision,
    });

  return {
    approvalId,
    approvalSlug,
    warningText,
    expiresAtMs: registration.expiresAtMs ?? defaultExpiresAtMs,
    preResolvedDecision:
      registration.finalDecision === undefined
        ? defaultPreResolvedDecision
        : registration.finalDecision,
    initiatingSurface,
    sentApproverDms,
    unavailableReason,
  };
}

export function buildDefaultExecApprovalRequestArgs(
  params: DefaultExecApprovalRequestArgs,
): DefaultExecApprovalRequestArgs {
  return {
    warnings: params.warnings,
    approvalRunningNoticeMs: params.approvalRunningNoticeMs,
    createApprovalSlug: params.createApprovalSlug,
    turnSourceChannel: params.turnSourceChannel,
    turnSourceAccountId: params.turnSourceAccountId,
  };
}

export function buildExecApprovalFollowupTarget(
  params: ExecApprovalFollowupTarget,
): ExecApprovalFollowupTarget {
  return {
    approvalId: params.approvalId,
    sessionKey: params.sessionKey,
    turnSourceChannel: params.turnSourceChannel,
    turnSourceTo: params.turnSourceTo,
    turnSourceAccountId: params.turnSourceAccountId,
    turnSourceThreadId: params.turnSourceThreadId,
  };
}

export function createExecApprovalDecisionState(params: {
  decision: string | null | undefined;
  askFallback: ResolvedExecApprovals["agent"]["askFallback"];
  obfuscationDetected: boolean;
}) {
  const baseDecision = resolveBaseExecApprovalDecision({
    decision: params.decision ?? null,
    askFallback: params.askFallback,
    obfuscationDetected: params.obfuscationDetected,
  });
  return {
    baseDecision,
    approvedByAsk: baseDecision.approvedByAsk,
    deniedReason: baseDecision.deniedReason,
  };
}

export async function sendExecApprovalFollowupResult(
  target: ExecApprovalFollowupTarget,
  resultText: string,
): Promise<void> {
  await sendExecApprovalFollowup({
    approvalId: target.approvalId,
    sessionKey: target.sessionKey,
    turnSourceChannel: target.turnSourceChannel,
    turnSourceTo: target.turnSourceTo,
    turnSourceAccountId: target.turnSourceAccountId,
    turnSourceThreadId: target.turnSourceThreadId,
    resultText,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const key = `${target.approvalId}:${message}`;
    if (loggedExecApprovalFollowupFailures.has(key)) {
      return;
    }
    loggedExecApprovalFollowupFailures.add(key);
    logWarn(`exec approval followup dispatch failed (id=${target.approvalId}): ${message}`);
  });
}

export function buildExecApprovalPendingToolResult(params: {
  host: "gateway" | "node";
  command: string;
  cwd: string;
  warningText: string;
  approvalId: string;
  approvalSlug: string;
  expiresAtMs: number;
  initiatingSurface: ExecApprovalInitiatingSurfaceState;
  sentApproverDms: boolean;
  unavailableReason: ExecApprovalUnavailableReason | null;
  nodeId?: string;
}): AgentToolResult<ExecToolDetails> {
  return {
    content: [
      {
        type: "text",
        text:
          params.unavailableReason !== null
            ? (buildExecApprovalUnavailableReplyPayload({
                warningText: params.warningText,
                reason: params.unavailableReason,
                channelLabel: params.initiatingSurface.channelLabel,
                sentApproverDms: params.sentApproverDms,
              }).text ?? "")
            : buildApprovalPendingMessage({
                warningText: params.warningText,
                approvalSlug: params.approvalSlug,
                approvalId: params.approvalId,
                command: params.command,
                cwd: params.cwd,
                host: params.host,
                nodeId: params.nodeId,
              }),
      },
    ],
    details:
      params.unavailableReason !== null
        ? ({
            status: "approval-unavailable",
            reason: params.unavailableReason,
            channelLabel: params.initiatingSurface.channelLabel,
            sentApproverDms: params.sentApproverDms,
            host: params.host,
            command: params.command,
            cwd: params.cwd,
            nodeId: params.nodeId,
            warningText: params.warningText,
          } satisfies ExecToolDetails)
        : ({
            status: "approval-pending",
            approvalId: params.approvalId,
            approvalSlug: params.approvalSlug,
            expiresAtMs: params.expiresAtMs,
            host: params.host,
            command: params.command,
            cwd: params.cwd,
            nodeId: params.nodeId,
            warningText: params.warningText,
          } satisfies ExecToolDetails),
  };
}
