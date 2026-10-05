import { hasInboundAudio } from "../../auto-reply/reply/inbound-media.js";
import {
  createMessageInjectionAuthority,
  enqueueMessageInjection,
} from "../../auto-reply/reply/message-injection-authority.js";
import {
  replyMessageInjectionTargetOwner,
  type ReplyBackendHandle,
  type ReplyMessageInjectionRejectionReason,
  type ReplyMessageInjectionTarget,
  type ReplyMessageInjectionOptions,
  type ReplyToolAuthorityPreparation,
} from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { resolveReplyBackendMessageInjectionRejection } from "../../auto-reply/reply/reply-run-registry.message-injection.js";
import {
  getAttachedBackend,
  resolveReplyRunForCurrentSessionId,
} from "../../auto-reply/reply/reply-run-registry.state.js";
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
import { bindWorkerToolPreparation } from "../harness/host-private-capabilities.js";
import {
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
  resolveActiveEmbeddedRunRecoveryBlocker,
  type EmbeddedAgentQueueHandle,
  type EmbeddedAgentQueueMessageOutcome,
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
      backendIdentity: handle,
      acceptParticipant: (overlay) => toolAuthority.personalToolParticipants?.accept(overlay),
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
      projectToolAuthorityFingerprintAsync: async (overlay) => {
        try {
          if (!canInject()) {
            return undefined;
          }
          const projected = await toolAuthority.projectAsync({
            ...overlay,
            traceAuthorized: false,
          });
          return canInject() ? projected : undefined;
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
          personalToolParticipants: toolAuthority.personalToolParticipants,
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

export type EmbeddedInjectionPreparation = Pick<
  ReplyToolAuthorityPreparation,
  "assertCurrent" | "prepareCurrent"
> & { prepareMessage?: () => Promise<string> };

type EmbeddedInjectionTask = (
  sessionId: string,
  text: string,
  options: ReplyMessageInjectionOptions | undefined,
  canInject: (() => boolean) | undefined,
  sourcePreparation: EmbeddedInjectionPreparation | undefined,
  release: () => void,
  assertCurrent: () => void,
) => Promise<EmbeddedAgentQueueMessageOutcome>;

export function createEmbeddedMessageInjectionQueue(consume: EmbeddedInjectionTask) {
  return (
    sessionId: string,
    text: string,
    options?: ReplyMessageInjectionOptions,
    canInject?: () => boolean,
    sourcePreparation?: EmbeddedInjectionPreparation,
  ): Promise<EmbeddedAgentQueueMessageOutcome> => {
    const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
    const registration = handle && ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
    const runId = handle?.runId;
    const assertCurrent = createMessageInjectionAuthority(() => {
      registration?.toolAuthority?.assertActive();
      return (
        ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle &&
        (!handle ||
          (ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration &&
            handle.runId === runId &&
            !handle.isStopped?.() &&
            !handle.isAborted?.()))
      );
    });
    const admitted = (release: () => void) =>
      consume(sessionId, text, options, canInject, sourcePreparation, release, assertCurrent);
    return handle ? enqueueMessageInjection(handle, admitted) : admitted(() => {});
  };
}

export async function prepareEmbeddedInjectionAuthority(
  sessionId: string,
  options?: ReplyMessageInjectionOptions,
  canInject?: () => boolean,
  sourcePreparation?: EmbeddedInjectionPreparation,
): Promise<{ fingerprint?: string; preparation: EmbeddedInjectionPreparation } | undefined> {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle?.messageInjectionV2?.queueMessageAsync) {
    return undefined;
  }
  const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  const ownedOperation =
    operation && getAttachedBackend(operation) === handle ? operation : undefined;
  const assertCurrent = createMessageInjectionAuthority(() => {
    sourcePreparation?.assertCurrent();
    registration?.toolAuthority?.assertActive();
    return (
      (!sourcePreparation && canInject ? canInject() : true) &&
      ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle &&
      ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration &&
      (!ownedOperation ||
        (resolveReplyRunForCurrentSessionId(sessionId) === ownedOperation &&
          getAttachedBackend(ownedOperation) === handle))
    );
  });
  const project = async () => {
    assertCurrent();
    await sourcePreparation?.prepareCurrent();
    const overlay = options?.toolAuthorityOverlay;
    const fingerprint = overlay
      ? await (
          registration?.toolAuthority
            ? registration.toolAuthority.projectAsync(overlay)
            : ownedOperation?.projectToolAuthorityFingerprintAsync(overlay)
        )?.catch(() => undefined)
      : options?.toolAuthorityFingerprint;
    assertCurrent();
    return fingerprint;
  };
  const fingerprint = await project();
  return {
    fingerprint,
    preparation: bindWorkerToolPreparation(
      {
        assertCurrent,
        prepareCurrent: async () => {
          if ((await project()) !== fingerprint) {
            throw new Error("Queued caller tool authority changed during preparation");
          }
        },
      },
      sourcePreparation ? [sourcePreparation] : [],
    ),
  };
}

export function bindEmbeddedMessageInjection(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  guarded: NonNullable<EmbeddedAgentQueueHandle["messageInjectionV2"]>,
  sourceCanInject?: () => boolean,
  preparation?: EmbeddedInjectionPreparation,
  options?: ReplyMessageInjectionOptions,
):
  | Pick<
      EmbeddedAgentQueueHandle,
      "queueMessage" | "claimPendingUserInputAnswer" | "cancelPendingUserInput"
    >
  | undefined {
  const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  const ownedOperation =
    operation && getAttachedBackend(operation) === handle ? operation : undefined;
  const assertCurrent = createMessageInjectionAuthority(() => {
    if (sourceCanInject && !sourceCanInject()) {
      return false;
    }
    const overlay = options?.toolAuthorityOverlay;
    if (overlay) {
      const projected = registration?.toolAuthority
        ? registration.toolAuthority.project(overlay)
        : ownedOperation?.projectToolAuthorityFingerprint(overlay);
      if (
        !projected ||
        projected !== (handle.toolAuthorityFingerprint ?? ownedOperation?.toolAuthorityFingerprint)
      ) {
        return false;
      }
    }
    registration?.toolAuthority?.assertActive();
    return (
      ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle &&
      ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration &&
      (!ownedOperation ||
        (resolveReplyRunForCurrentSessionId(sessionId) === ownedOperation &&
          getAttachedBackend(ownedOperation) === handle))
    );
  });
  const authorityKind = sourceCanInject ? "source-bound" : "run";
  return guarded.isAvailable()
    ? {
        queueMessage: (text, injectionOptions) =>
          preparation && guarded.queueMessageAsync
            ? guarded.queueMessageAsync(
                text,
                injectionOptions,
                { ...preparation, compatAssertCurrent: assertCurrent },
                authorityKind,
              )
            : guarded.queueMessage(text, injectionOptions, assertCurrent, authorityKind),
        claimPendingUserInputAnswer: guarded.claimPendingUserInputAnswer
          ? (text, injectionOptions) =>
              guarded.claimPendingUserInputAnswer!(
                text,
                injectionOptions,
                assertCurrent,
                authorityKind,
              )
          : undefined,
        cancelPendingUserInput: guarded.cancelPendingUserInput
          ? (resolvedBy) =>
              guarded.cancelPendingUserInput!(resolvedBy, assertCurrent, authorityKind)
          : undefined,
      }
    : undefined;
}
