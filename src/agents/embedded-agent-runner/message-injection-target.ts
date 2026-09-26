import { hasInboundAudio } from "../../auto-reply/reply/inbound-media.js";
import {
  replyMessageInjectionTargetOwner,
  type ReplyBackendHandle,
  type ReplyMessageInjectionRejectionReason,
  type ReplyMessageInjectionTarget,
} from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { resolveReplyBackendMessageInjectionRejection } from "../../auto-reply/reply/reply-run-registry.message-injection.js";
import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  getDiagnosticSessionActivitySnapshot,
  resolveRunStaleThresholdMs,
} from "../../logging/diagnostic-run-activity.js";
import {
  diagnosticLogger as diag,
  logMessageQueuedWithBacklogPolicy,
} from "../../logging/diagnostic-runtime.js";
import {
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
  resolveActiveEmbeddedRunRecoveryBlocker,
} from "./run-state.js";
import { isEmbeddedRunHandleAbortable } from "./runs.probes.js";

/** Capture a direct command's existing admitted owner, never authority from a session ID. */
export function captureDirectEmbeddedMessageInjectionTarget(
  sessionKey: string,
  allowsDirectOwner: () => boolean,
): ReplyMessageInjectionTarget | undefined {
  const sessionId = ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(sessionKey);
  const handle = sessionId ? ACTIVE_EMBEDDED_RUNS.get(sessionId) : undefined;
  const registration = handle && ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  const toolAuthority = registration?.toolAuthority;
  const instance = registration?.operationalRunInstance;
  const delegatedAuthority = registration?.delegatedAuthority;
  if (!sessionId || !handle || toolAuthority?.source !== "attempt") {
    return undefined;
  }
  if (
    !registration ||
    registration.sessionKey !== sessionKey ||
    registration.sessionId !== sessionId ||
    !instance ||
    instance.runId !== handle.runId ||
    !delegatedAuthority
  ) {
    diag.debug("direct steering unavailable", {
      reason: "admitted-injection-capability-unavailable",
      sessionKey,
      sessionId,
      runId: handle.runId,
    });
    return undefined;
  }
  const runId = instance.runId;
  const injection = handle.messageInjectionV2;
  const ownsRegistration = () =>
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(sessionKey) === sessionId &&
    ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle &&
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(runId) === handle &&
    ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration &&
    registration.operationalRunInstance === instance &&
    handle.messageInjectionV2 === injection;
  const canInject = () => {
    toolAuthority.assertActive();
    return (
      ownsRegistration() &&
      allowsDirectOwner() &&
      getActiveAgentRunDelegatedAuthority(instance) === delegatedAuthority &&
      validateAgentRunDelegatedAuthority(delegatedAuthority) &&
      !handle.isAborted?.() &&
      !handle.isStopped?.() &&
      ownsRegistration() &&
      allowsDirectOwner()
    );
  };
  try {
    if (!canInject()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const backend: ReplyBackendHandle = {
    ...handle,
    kind: "embedded",
    cancel: (reason) =>
      handle.cancel
        ? handle.cancel(reason)
        : handle.abort(reason === "restart" ? reason : undefined),
  };
  return {
    runId,
    sourceTurnId: toolAuthority.sourceTurnId,
    [replyMessageInjectionTargetOwner]: {
      projectToolAuthorityFingerprint: (overlay) => {
        try {
          // Direct command delivery has no reply-dispatch trace output surface.
          return canInject()
            ? toolAuthority.project({ ...overlay, traceAuthorized: false })
            : undefined;
        } catch {
          return undefined;
        }
      },
      resolve: (params) => {
        const reject = (reason: ReplyMessageInjectionRejectionReason) => {
          diag.info("direct steering rejected; keeping input for followup", {
            reason,
            runId,
            sessionKey,
            sessionId,
          });
          return { reason };
        };
        try {
          if (!canInject()) {
            return reject("no_active_run");
          }
        } catch {
          return reject("no_active_run");
        }
        if (injection?.version !== 2 || handle.supportsTranscriptCommitWait !== true) {
          return reject("injection_unavailable");
        }
        const blocker = resolveActiveEmbeddedRunRecoveryBlocker(sessionId, handle);
        const activity = getDiagnosticSessionActivitySnapshot({ sessionId });
        if (
          typeof activity.lastProgressAgeMs === "number" &&
          activity.lastProgressAgeMs > resolveRunStaleThresholdMs(activity) &&
          !blocker
        ) {
          return reject("stale_run");
        }
        if (params.inboundAudio || hasInboundAudio({ media: params.options?.media })) {
          // Direct tool contexts cannot adopt the reply operation's dynamic audio fact.
          return reject("audio_input_unsupported");
        }
        const resolved = resolveReplyBackendMessageInjectionRejection({
          ...params,
          sessionId,
          backend,
          canInject,
          options:
            params.options?.isInboundUserMessage && params.allowPendingUserInputAnswer !== false
              ? { ...params.options, terminalReplyExpectation: "required" }
              : params.options,
        });
        if (!("injection" in resolved)) {
          reject(resolved.reason);
        }
        return resolved;
      },
      recordAccepted: () => {
        if (ownsRegistration()) {
          logMessageQueuedWithBacklogPolicy({ sessionId, source: "embedded-agent-runner" }, false);
        }
      },
      abort: () => {
        try {
          if (!canInject() || !isEmbeddedRunHandleAbortable(sessionId, handle) || !canInject()) {
            return false;
          }
          backend.cancel("user_abort");
          return true;
        } catch (error) {
          diag.warn("direct steering target could not be aborted", {
            runId,
            sessionKey,
            error: String(error),
          });
          return false;
        }
      },
    },
  };
}
