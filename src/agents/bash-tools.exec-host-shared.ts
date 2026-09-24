/**
 * Shared approval helpers for gateway and node exec hosts.
 * Owns pending-state construction, policy merging, unavailable-route handling,
 * follow-up dispatch, and approval-pending tool result rendering.
 */
import crypto from "node:crypto";
import { isApprovalNotFoundError } from "../infra/approval-errors.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  minSecurity,
  maxAsk,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalsLocked,
  resolveExecApprovalsTranscriptPath,
  type ExecAsk,
  type ExecApprovalDecision,
  type ExecApprovalsResolved,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import { logWarn } from "../logger.js";
import { registerExecApprovalFollowupRuntimeHandoff } from "./bash-tools.exec-approval-followup-state.js";
import type { sendExecApprovalFollowup } from "./bash-tools.exec-approval-followup.js";
import {
  type ExecApprovalRegistration,
  isExecApprovalRunAbortedError,
  resolveRegisteredExecApprovalDecision,
} from "./bash-tools.exec-approval-request.js";
import { buildApprovalPendingMessage } from "./bash-tools.exec-runtime.js";
import type { ExecElevatedDefaults, ExecToolDetails } from "./bash-tools.exec-types.js";
import { isExecDeniedResultText } from "./exec-approval-result.js";
import type { AgentToolResult } from "./runtime/index.js";

/** Cap for deduplicating repeated follow-up dispatch failure log keys. */
const MAX_EXEC_APPROVAL_FOLLOWUP_FAILURE_LOG_KEYS = 256;
const loggedExecApprovalFollowupFailures = new Set<string>();

function rememberExecApprovalFollowupFailureKey(key: string): boolean {
  if (loggedExecApprovalFollowupFailures.has(key)) {
    return false;
  }
  loggedExecApprovalFollowupFailures.add(key);
  // Bound memory growth for long-lived processes that see many unique approval failures.
  if (loggedExecApprovalFollowupFailures.size > MAX_EXEC_APPROVAL_FOLLOWUP_FAILURE_LOG_KEYS) {
    const oldestKey = loggedExecApprovalFollowupFailures.values().next().value;
    if (typeof oldestKey === "string") {
      loggedExecApprovalFollowupFailures.delete(oldestKey);
    }
  }
  return true;
}

/** Effective approval policy after caller config and approvals file are merged. */
type ExecHostApprovalContext = {
  approvals: ExecApprovalsResolved;
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  askFallback: ExecApprovalsResolved["agent"]["askFallback"];
};

/** Context returned after a default approval request is registered. */
type RegisteredExecApprovalRequestContext = {
  approvalId: string;
  approvalSlug: string;
  warningText: string;
  expiresAtMs: number;
  preResolvedDecision: string | null | undefined;
  deliveryRoute: ExecApprovalRegistration["deliveryRoute"];
};

/** Destination and context for async exec approval follow-up delivery. */
type ExecApprovalFollowupTarget = {
  approvalId: string;
  agentId?: string;
  sessionKey?: string;
  /** Session UUID active when the approval was requested. Lets the followup be
   *  dropped if `/new` or `/reset` rebinds the session key to a new session. */
  expectedSessionId?: string;
  /** Session-store template, so the direct/denied path can resolve the key's
   *  current sessionId and drop a rebound followup before sending. */
  sessionStore?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  direct?: boolean;
  bashElevated?: ExecElevatedDefaults;
};

/** Test seam for follow-up delivery and warning logging. */
type ExecApprovalFollowupResultDeps = {
  sendExecApprovalFollowup?: typeof sendExecApprovalFollowup;
  logWarn?: typeof logWarn;
};

/** Converts a raw approval decision plus fallback policy into execution state. */
function resolveBaseExecApprovalDecision(params: {
  decision: string | null;
  askFallback: ExecApprovalsResolved["agent"]["askFallback"];
}): {
  approvedByAsk: boolean;
  deniedReason: string | null;
  timedOut: boolean;
} {
  if (params.decision === "deny") {
    return { approvedByAsk: false, deniedReason: "user-denied", timedOut: false };
  }
  if (!params.decision) {
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

/** Resolves effective exec policy for a gateway/node host. */
export async function resolveExecHostApprovalContext(params: {
  agentId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  host: "gateway" | "node";
  bypassHostApprovalFloors?: boolean;
}): Promise<ExecHostApprovalContext> {
  const approvals = await resolveExecApprovalsLocked(params.agentId, {
    security: params.security,
    ask: params.ask,
  });
  // Session/config tool policy is the caller's requested contract. The host file
  // may tighten that contract, but it must not silently broaden it.
  const hostSecurity = params.bypassHostApprovalFloors
    ? params.security
    : minSecurity(params.security, approvals.agent.security);
  const hostAsk = params.bypassHostApprovalFloors
    ? params.ask
    : maxAsk(params.ask, approvals.agent.ask);
  const askFallback = params.bypassHostApprovalFloors
    ? "deny"
    : minSecurity(hostSecurity, approvals.agent.askFallback);
  if (hostSecurity === "deny") {
    throw new Error(`exec denied: host=${params.host} security=deny`);
  }
  return { approvals, hostSecurity, hostAsk, askFallback };
}

type DefaultExecApprovalRequestParams = {
  warnings: string[];
  createApprovalSlug: (approvalId: string) => string;
  register: (approvalId: string) => Promise<ExecApprovalRegistration>;
};

type ExecApprovalDecisionParams<TTimeoutContext> = {
  decision: string | null;
  askFallback: ExecApprovalsResolved["agent"]["askFallback"];
  resolveTimedOut?: (state: {
    baseDecision: { timedOut: boolean };
    approvedByAsk: boolean;
    deniedReason: string | null;
  }) =>
    | {
        approvedByAsk: boolean;
        deniedReason: string | null;
        context?: TTimeoutContext;
      }
    | Promise<{
        approvedByAsk: boolean;
        deniedReason: string | null;
        context?: TTimeoutContext;
      }>;
  requiresExplicitApproval: boolean | ((context: TTimeoutContext | undefined) => boolean);
  requiresAutoReviewHumanApproval?: boolean;
};

type ExecApprovalDecisionState<TTimeoutContext> = {
  baseDecision: ReturnType<typeof resolveBaseExecApprovalDecision>;
  approvedByAsk: boolean;
  deniedReason: string | null;
  timeoutContext: TTimeoutContext | undefined;
};

/** Resolves explicit, timeout-fallback, and strict-human approval policy in one owner. */
async function resolveExecApprovalDecisionState<TTimeoutContext = undefined>(
  params: ExecApprovalDecisionParams<TTimeoutContext>,
): Promise<ExecApprovalDecisionState<TTimeoutContext>> {
  const baseDecision = resolveBaseExecApprovalDecision(params);
  let { approvedByAsk, deniedReason } = baseDecision;
  let timeoutContext: TTimeoutContext | undefined;

  if (baseDecision.timedOut && params.resolveTimedOut) {
    const timedOut = await params.resolveTimedOut({ baseDecision, approvedByAsk, deniedReason });
    approvedByAsk = timedOut.approvedByAsk;
    deniedReason = timedOut.deniedReason;
    timeoutContext = timedOut.context;
  } else if (params.decision === "allow-once" || params.decision === "allow-always") {
    approvedByAsk = true;
  }

  const requiresExplicitApproval =
    typeof params.requiresExplicitApproval === "function"
      ? params.requiresExplicitApproval(timeoutContext)
      : params.requiresExplicitApproval;
  if (
    baseDecision.timedOut &&
    approvedByAsk &&
    (requiresExplicitApproval || params.requiresAutoReviewHumanApproval === true)
  ) {
    approvedByAsk = false;
    deniedReason ??= "approval-timeout";
  }
  return { baseDecision, approvedByAsk, deniedReason, timeoutContext };
}

type ExecApprovalRequestRoute<TTimeoutContext> =
  | (Omit<RegisteredExecApprovalRequestContext, "preResolvedDecision"> & {
      kind: "inline";
      preResolvedDecision: null;
      state: ExecApprovalDecisionState<TTimeoutContext>;
    })
  | (RegisteredExecApprovalRequestContext & { kind: "wait" });

/** Registers an approval and resolves terminal no-route fallback through the shared policy owner. */
export async function createExecApprovalRequestRoute<TTimeoutContext = undefined>(
  params: DefaultExecApprovalRequestParams &
    Omit<ExecApprovalDecisionParams<TTimeoutContext>, "decision">,
): Promise<ExecApprovalRequestRoute<TTimeoutContext>> {
  const registration = await params.register(crypto.randomUUID());
  const request: RegisteredExecApprovalRequestContext = {
    approvalId: registration.id,
    approvalSlug: params.createApprovalSlug(registration.id),
    warningText: params.warnings.length ? `${params.warnings.join("\n")}\n\n` : "",
    expiresAtMs: registration.expiresAtMs,
    preResolvedDecision: registration.finalDecision,
    deliveryRoute: registration.deliveryRoute,
  };
  if (request.preResolvedDecision !== null) {
    return { ...request, kind: "wait" };
  }
  const state = await resolveExecApprovalDecisionState({ ...params, decision: null });
  return { ...request, kind: "inline", preResolvedDecision: null, state };
}

/** Waits for an approval and normalizes cancellation, request failure, and resolved policy. */
export async function resolveExecApprovalWaitOutcome<TTimeoutContext = undefined>(
  params: Omit<ExecApprovalDecisionParams<TTimeoutContext>, "decision"> & {
    approvalId: string;
    preResolvedDecision: string | null | undefined;
    signal?: AbortSignal;
  },
): Promise<
  | { kind: "request-failed" }
  | { kind: "run-aborted" }
  | {
      kind: "resolved";
      decision: string | null;
      state: ExecApprovalDecisionState<TTimeoutContext>;
    }
> {
  let decision: string | null;
  try {
    decision = await resolveRegisteredExecApprovalDecision({
      approvalId: params.approvalId,
      preResolvedDecision: params.preResolvedDecision,
    });
  } catch (error) {
    return { kind: isExecApprovalRunAbortedError(error) ? "run-aborted" : "request-failed" };
  }
  if (params.signal?.aborted) {
    return { kind: "run-aborted" };
  }
  const state = await resolveExecApprovalDecisionState({ ...params, decision });
  return params.signal?.aborted ? { kind: "run-aborted" } : { kind: "resolved", decision, state };
}

/** Builds the denial copy for headless runs that cannot wait for approval. */
export function buildHeadlessExecApprovalDeniedMessage(params: {
  trigger?: string;
  host: "gateway" | "node";
  security: ExecSecurity;
  ask: ExecAsk;
  askFallback: ExecApprovalsResolved["agent"]["askFallback"];
}): string {
  // The TUI and chat channels never receive automation approval cards
  // (server-request-context canDeliverApprovals), so only name surfaces that
  // can actually answer this run's approval.
  const approvalSurfaceFix =
    params.trigger === "cron" && params.host === "gateway"
      ? "- keep the Control UI or a macOS/iOS/Android app connected and answer the next run's approval card; Allow Always mints a standing grant"
      : "- rerun interactively and approve when prompted (Control UI, a connected app, or a chat channel with exec approvals)";
  return [
    params.trigger === "cron"
      ? "exec denied: Automation runs cannot wait for interactive exec approval."
      : "exec denied: No interactive approval route is available. The command did not run.",
    `Effective host exec policy: security=${params.security} ask=${params.ask} askFallback=${params.askFallback}`,
    `Stricter values from tools.exec and ${resolveExecApprovalsTranscriptPath()} both apply.`,
    "Fix one of these:",
    '- align both files to security="full" and ask="off" for trusted local automation',
    "- keep allowlist mode and add an explicit allowlist entry for this command",
    approvalSurfaceFix,
    'Tip: run "openclaw doctor" and "openclaw approvals get --gateway" to inspect the effective policy.',
  ].join("\n");
}

/** Sends async approval follow-up results with deduped warning logs on failure. */
export async function sendExecApprovalFollowupResult(
  target: ExecApprovalFollowupTarget,
  resultText: string,
  deps: ExecApprovalFollowupResultDeps = {},
): Promise<void> {
  const send: typeof sendExecApprovalFollowup =
    deps.sendExecApprovalFollowup ??
    (async (params) => {
      const { sendExecApprovalFollowup } = await import("./bash-tools.exec-approval-followup.js");
      return sendExecApprovalFollowup(params);
    });
  const warn = deps.logWarn ?? logWarn;
  const runtimeHandoff =
    target.direct === true || !target.sessionKey || isExecDeniedResultText(resultText)
      ? undefined
      : registerExecApprovalFollowupRuntimeHandoff({
          approvalId: target.approvalId,
          sessionKey: target.sessionKey,
          bashElevated: target.bashElevated,
          resultText,
        });
  await send({
    approvalId: target.approvalId,
    ...(target.agentId ? { agentId: target.agentId } : {}),
    sessionKey: target.sessionKey,
    expectedSessionId: target.expectedSessionId,
    sessionStore: target.sessionStore,
    turnSourceChannel: target.turnSourceChannel,
    turnSourceTo: target.turnSourceTo,
    turnSourceAccountId: target.turnSourceAccountId,
    turnSourceThreadId: target.turnSourceThreadId,
    resultText,
    direct: target.direct,
    ...(runtimeHandoff
      ? {
          internalRuntimeHandoffId: runtimeHandoff.handoffId,
          idempotencyKey: runtimeHandoff.idempotencyKey,
        }
      : {}),
  }).catch((error: unknown) => {
    if (isApprovalNotFoundError(error)) {
      return;
    }
    const message = formatErrorMessage(error);
    const key = `${target.approvalId}:${message}`;
    if (!rememberExecApprovalFollowupFailureKey(key)) {
      return;
    }
    warn(`exec approval followup dispatch failed (id=${target.approvalId}): ${message}`);
  });
}

/** Renders a registered pending approval for callers that explicitly own follow-up delivery. */
export function buildExecApprovalPendingToolResult(params: {
  host: "gateway" | "node";
  command: string;
  cwd: string | undefined;
  warningText: string;
  approvalId: string;
  approvalSlug: string;
  expiresAtMs: number;
  deliveryRoute?: ExecApprovalRegistration["deliveryRoute"];
  allowedDecisions?: readonly ExecApprovalDecision[];
  nodeId?: string;
  processContinuationAvailable?: boolean;
}): AgentToolResult<ExecToolDetails> {
  const allowedDecisions = params.allowedDecisions ?? resolveExecApprovalAllowedDecisions();
  return {
    content: [
      {
        type: "text",
        text: buildApprovalPendingMessage({ ...params, allowedDecisions }),
      },
    ],
    details: {
      status: "approval-pending",
      approvalId: params.approvalId,
      approvalSlug: params.approvalSlug,
      expiresAtMs: params.expiresAtMs,
      deliveryRoute: params.deliveryRoute,
      allowedDecisions,
      host: params.host,
      command: params.command,
      cwd: params.cwd,
      nodeId: params.nodeId,
      warningText: params.warningText,
    } satisfies ExecToolDetails,
  };
}
