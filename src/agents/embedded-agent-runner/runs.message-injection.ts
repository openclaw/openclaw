import { createMessageInjectionAuthority } from "../../auto-reply/reply/message-injection-authority.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getDiagnosticSessionActivitySnapshot,
  resolveRunStaleThresholdMs,
} from "../../logging/diagnostic-run-activity.js";
import {
  diagnosticLogger as diag,
  logMessageQueuedWithBacklogPolicy,
} from "../../logging/diagnostic-runtime.js";
import type {
  ReplyBackendMessageInjection,
  ReplyBackendQueueMessageOptions,
  ReplyMessageInjectionOptions,
} from "../../sessions/session-controller.contracts.js";
import { resolveReplyRunForCurrentSessionId } from "../../sessions/session-controller.identity.js";
import { resolveReplyBackendQueueMessageMismatch } from "../../sessions/session-controller.message-injection-failure.js";
import { bindMessageInjectionV2 } from "../harness/tool-authority-preparation.js";
import {
  getDetachedNativeAttachment,
  resolveRegisteredEmbeddedRunRecoveryBlocker,
} from "./run-state.js";
import { canSteerEmbeddedRunDuringCompaction } from "./runs.probes.js";

/** Sessionless input belongs to its exact native registration, never a session scheduler. */
export function queueDetachedEmbeddedAgentMessage(
  sessionId: string,
  text: string,
  options?: ReplyMessageInjectionOptions,
): boolean {
  if (resolveReplyRunForCurrentSessionId(sessionId).kind !== "none") {
    return false;
  }
  const registration = getDetachedNativeAttachment(sessionId);
  if (!registration) {
    return false;
  }
  const { handle } = registration;
  const ownsRegistration = () => {
    registration.toolAuthority?.assertActive();
    return (
      resolveReplyRunForCurrentSessionId(sessionId).kind === "none" &&
      getDetachedNativeAttachment(sessionId) === registration
    );
  };
  const reportFailure = (error: unknown) =>
    diag.debug(`queue message rejected: sessionId=${sessionId} err=${formatErrorMessage(error)}`);
  let queueMessage: ReplyBackendMessageInjection["queueMessage"];
  let backendOptions: ReplyBackendQueueMessageOptions;
  try {
    const guarded = handle.messageInjectionV2;
    const legacy = handle.messageInjection;
    const available = guarded
      ? guarded.isAvailable()
      : legacy
        ? legacy.isAvailable()
        : handle.isStopped
          ? !handle.isStopped()
          : handle.isStreaming();
    if (!available || !canSteerEmbeddedRunDuringCompaction(sessionId, handle)) {
      return false;
    }
    const recoveryBlocker = resolveRegisteredEmbeddedRunRecoveryBlocker(
      registration,
      ownsRegistration,
    );
    const hasProtectedWait =
      recoveryBlocker === "human_input_wait" || recoveryBlocker === "runtime_owned_wait";
    const activity = getDiagnosticSessionActivitySnapshot({ sessionId });
    if (
      typeof activity.lastProgressAgeMs === "number" &&
      activity.lastProgressAgeMs > resolveRunStaleThresholdMs(activity) &&
      !hasProtectedWait
    ) {
      return false;
    }
    const { toolAuthorityOverlay, ...preparedOptions } = options ?? { steeringMode: "all" };
    backendOptions = preparedOptions;
    if (toolAuthorityOverlay) {
      // Caller evidence cannot replace projection by this native registration's authority.
      backendOptions.toolAuthorityFingerprint =
        registration.toolAuthority?.project(toolAuthorityOverlay);
      if (!backendOptions.toolAuthorityFingerprint) {
        return false;
      }
    }
    if (
      (backendOptions.waitForTranscriptCommit === true &&
        handle.supportsTranscriptCommitWait !== true) ||
      resolveReplyBackendQueueMessageMismatch(handle, backendOptions)
    ) {
      return false;
    }
    if (!ownsRegistration()) {
      return false;
    }
    const assertOwnerCurrent = createMessageInjectionAuthority(ownsRegistration);
    const assertCurrent = createMessageInjectionAuthority(() => {
      options?.assertCurrent?.();
      if (guarded && toolAuthorityOverlay) {
        const projected = registration.toolAuthority?.project(toolAuthorityOverlay);
        if (!projected || projected !== handle.toolAuthorityFingerprint) {
          return false;
        }
      }
      return ownsRegistration();
    });
    queueMessage = guarded
      ? bindMessageInjectionV2(guarded, assertCurrent, "run").queueMessage
      : (queuedText, queueOptions) => {
          options?.assertCurrent?.();
          assertOwnerCurrent();
          return (legacy ?? handle).queueMessage(queuedText, queueOptions);
        };
  } catch (error) {
    reportFailure(error);
    return false;
  }
  logMessageQueuedWithBacklogPolicy({ sessionId, source: "embedded-agent-runner" }, false);
  void queueMessage(text, backendOptions).catch(reportFailure);
  return true;
}
