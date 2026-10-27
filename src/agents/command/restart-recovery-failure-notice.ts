import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { getGatewayRecoveryRuntime } from "../../gateway/server-recovery-runtime-context.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { deliveryContextKey } from "../../utils/delivery-context.shared.js";
import {
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agent-run-terminal-outcome.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner/types.js";
import { isAgentHarnessPreflightError } from "../harness/errors.js";
import { LiveSessionModelSwitchError } from "../live-model-switch-error.js";
import { resolveRestartRecoveryDeliveryContext } from "../main-session-recovery/main-session-restart-recovery-delivery.js";
import { resolveCliToolTerminalReason } from "../run-termination.js";
import type { AgentCommandDeliveryResult } from "./delivery-result.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import type { AgentCommandOpts } from "./types.js";

/** Deliver a public terminal refusal while the original source claim still owns its route. */
async function notifyCommandRestartRecoveryFailure(params: {
  error?: unknown;
  opts: AgentCommandOpts;
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  sessionId: string;
  storePath?: string;
  runId: string;
  originalEntry?: SessionEntry;
  lifecycleGeneration: string;
  gatewayRuntime?: GatewayRecoveryRuntime;
}): Promise<void> {
  const { error, opts, gatewayRuntime, sessionKey } = params;
  if (
    opts.inputProvenance?.kind !== "internal_system" ||
    opts.inputProvenance.sourceTool !== "main_session_restart_recovery" ||
    !gatewayRuntime ||
    !sessionKey ||
    params.originalEntry?.restartRecoveryFailureNoticeAllowed !== true
  ) {
    return;
  }
  const sourceRunId = normalizeOptionalString(
    params.originalEntry.restartRecoveryDeliverySourceRunId,
  );
  const originalRouteKey = deliveryContextKey(params.originalEntry.restartRecoveryDeliveryContext);
  if (!sourceRunId || !originalRouteKey) {
    return;
  }
  const resolveCurrentRoute = (cfg: OpenClawConfig) => {
    if (
      opts.abortSignal?.aborted ||
      getGatewayRecoveryRuntime() !== gatewayRuntime ||
      getAgentEventLifecycleGeneration() !== params.lifecycleGeneration
    ) {
      return undefined;
    }
    opts.assertSourceCurrent?.();
    const current = loadSessionEntryReadOnly({
      agentId: params.agentId,
      sessionKey,
      storePath: params.storePath,
      readConsistency: "latest",
    });
    if (
      current?.sessionId !== params.sessionId ||
      current.restartRecoveryDeliveryRunId !== params.runId ||
      current.restartRecoveryDeliverySourceRunId !== sourceRunId ||
      current.restartRecoveryFailureNoticeAllowed !== true ||
      current.pendingFinalDelivery !== undefined ||
      current.restartRecoveryDeliveryReceiptState !== undefined ||
      deliveryContextKey(current.restartRecoveryDeliveryContext) !== originalRouteKey
    ) {
      return undefined;
    }
    const route = resolveRestartRecoveryDeliveryContext({ cfg, entry: current, sessionKey });
    return deliveryContextKey(route) === originalRouteKey ? route : undefined;
  };
  const route = resolveCurrentRoute(params.cfg);
  if (!route) {
    return;
  }
  await gatewayRuntime.sendRecoveryNotice({
    ...route,
    text:
      (isAgentHarnessPreflightError(error) && error.userMessage?.trim()) ||
      "I couldn't finish recovering the interrupted request. Please send a new message to continue.",
    // The durable outbound intent belongs to the source, not this process's recovery attempt.
    idempotencyKey: `main-session-restart-recovery:${sourceRunId}:failed-notice`,
    isCurrent: (cfg) => resolveCurrentRoute(cfg) !== undefined,
  });
}

/** One reporter spans fallback; returned execution transfers responsibility to final delivery. */
export function createCommandRestartRecoveryFailureReporter(params: {
  prepared: PreparedAgentCommandExecution;
  getCurrent: () => { opts: AgentCommandOpts; sessionId: string; lifecycleGeneration: string };
  onError: (error: unknown) => void;
}) {
  const gatewayRuntime = getGatewayRecoveryRuntime();
  let executionReturned = false;
  const notify = async (error?: unknown, abortSignal?: AbortSignal) => {
    const current = params.getCurrent();
    try {
      await notifyCommandRestartRecoveryFailure({
        error,
        ...current,
        opts: { ...current.opts, abortSignal: abortSignal ?? current.opts.abortSignal },
        cfg: params.prepared.cfg,
        agentId: params.prepared.sessionAgentId,
        sessionKey: params.prepared.sessionKey,
        storePath: params.prepared.storePath,
        runId: params.prepared.runId,
        originalEntry: params.prepared.sessionEntry,
        gatewayRuntime,
      });
    } catch (noticeError) {
      params.onError(noticeError);
    }
  };
  return {
    finishExecution: () => {
      executionReturned = true;
    },
    onExecutionFailure: (abortSignal: AbortSignal) => notify(undefined, abortSignal),
    reportThrownFailure: async (error: unknown) => {
      if (
        !executionReturned &&
        !(error instanceof LiveSessionModelSwitchError) &&
        resolveCliToolTerminalReason({
          error,
          abortSignal: params.getCurrent().opts.abortSignal,
        }) !== "cancelled"
      ) {
        await notify(error);
      }
    },
  };
}

/** Normal transport and message-tool custody settle before a host terminal failure notice. */
export function shouldNotifyCommandExecutionFailure(params: {
  result: EmbeddedAgentRunResult;
  deliveryResult?: AgentCommandDeliveryResult;
  hasResultError: boolean;
  outcome: AgentRunTerminalOutcome;
  abortSignal: AbortSignal;
}): boolean {
  const classification = classifyAgentRunTerminalOutcome(params.outcome);
  const { result, deliveryResult } = params;
  return (
    !params.abortSignal.aborted &&
    classification !== "cancellation" &&
    (params.hasResultError || classification === "failure" || classification === "timeout") &&
    result.sourceReplyDeliveryState !== "pending" &&
    result.sourceReplyDeliveryState !== "delivered" &&
    result.sourceReplyDelivered !== true &&
    result.didDeliverSourceReplyViaMessageTool !== true &&
    deliveryResult?.deliveryStatus?.status !== "sent" &&
    (deliveryResult?.deliveryStatus?.resultCount ?? 0) === 0
  );
}
