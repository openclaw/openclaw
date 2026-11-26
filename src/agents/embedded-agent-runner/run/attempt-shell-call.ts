import { restartResumeSkipReason } from "../../../config/sessions/session-run-lifecycle-projection.js";
import { admitSessionShellCall } from "../../../config/sessions/session-shell-call.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import {
  getSessionControllerEntryForOperation,
  isCurrentSessionControllerOperation,
} from "../../../sessions/session-controller.identity.js";
import { isIncognitoSessionKey } from "../../../shared/incognito-session-key.js";
import { resolveExplicitIncognitoAgentSqliteTarget } from "../../../state/openclaw-agent-db.paths.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../../utils/message-channel-normalize.js";
import { readRunOperatorAuthority } from "../../admitted-run-context.js";
import { getGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

export function createShellCallAdmission(
  attempt: Pick<
    EmbeddedRunAttemptInternalParams,
    | "runId"
    | "sessionKey"
    | "sessionTarget"
    | "preparedSessionTarget"
    | "sessionManager"
    | "oneShotCliRun"
    | "sessionPersistence"
    | "replyOperation"
    | "sourceReplyDeliveryMode"
    | "admittedRunContext"
  >,
) {
  if (
    attempt.oneShotCliRun ||
    attempt.sessionPersistence === "detached" ||
    isIncognitoSessionKey(attempt.sessionKey) ||
    (attempt.sessionKey && restartResumeSkipReason(attempt.sessionKey))
  ) {
    return undefined;
  }
  const candidate =
    attempt.preparedSessionTarget?.target ??
    attempt.sessionManager?.getSessionTarget() ??
    attempt.sessionTarget;
  if (!candidate?.sessionKey || !candidate.storePath || !candidate.sessionId) {
    if (attempt.replyOperation) {
      return async () => {
        throw new Error(
          "The shell command was not started because its session store could not be identified.",
        );
      };
    }
    return undefined;
  }
  if (
    resolveExplicitIncognitoAgentSqliteTarget(candidate.storePath, { agentId: candidate.agentId })
  ) {
    return undefined;
  }
  const target = {
    ...candidate,
    agentId: candidate.agentId ?? resolveAgentIdFromSessionKey(candidate.sessionKey),
    sessionKey: candidate.sessionKey,
    sessionId: candidate.sessionId,
    storePath: candidate.storePath,
  };
  const { runId, replyOperation, admittedRunContext, sourceReplyDeliveryMode } = attempt;
  const fallbackFence = attempt.sessionTarget?.expectedWriterRunId
    ? attempt.sessionTarget
    : attempt.preparedSessionTarget?.target;
  const captureNotice = async () => {
    if (
      !replyOperation ||
      !isCurrentSessionControllerOperation(replyOperation) ||
      sourceReplyDeliveryMode === "message_tool_only" ||
      getGatewayToolCallerIdentity()?.turnSourceLocal === true ||
      getGatewayToolCallerIdentity()?.sessionEventDelivery === false ||
      getAgentRunContext(runId)?.sessionEventDelivery === false
    ) {
      return undefined;
    }
    const claim = getSessionControllerEntryForOperation(replyOperation).mailbox?.claim;
    if (claim?.operation !== replyOperation || claim.released || claim.releaseRequested) {
      return undefined;
    }
    const source = claim.sources[0];
    const channel = normalizeMessageChannel(source?.originatingChannel);
    if (
      !source?.originatingTo ||
      source.run.internalEventExecution ||
      source.run.inputProvenance?.kind === "internal_system" ||
      !channel ||
      !isDeliverableMessageChannel(channel)
    ) {
      return undefined;
    }
    const [
      {
        resolveFollowupReplyAnchor,
        resolveFollowupReplyDeliveryKey,
        resolveFollowupAuthorizationKey,
      },
      { captureQueuedOperatorRecoverySource },
    ] = await Promise.all([
      import("../../../auto-reply/reply/queue/delivery-context.js"),
      import("../../../gateway/operator-run-recovery-source.js"),
    ]);
    // Collected input can share a reply only when both delivery and authority agree.
    const routeKey = resolveFollowupReplyDeliveryKey(source);
    const authorizationKey = resolveFollowupAuthorizationKey(source);
    if (
      claim.sources.some(
        (input) =>
          input.run.internalEventExecution ||
          input.run.inputProvenance?.kind === "internal_system" ||
          resolveFollowupReplyDeliveryKey(input) !== routeKey ||
          resolveFollowupAuthorizationKey(input) !== authorizationKey,
      )
    ) {
      return undefined;
    }
    return {
      channel,
      to: source.originatingTo,
      accountId: source.originatingAccountId,
      threadId: source.originatingThreadId,
      replyToId: resolveFollowupReplyAnchor(source),
      operatorSource: captureQueuedOperatorRecoverySource(
        readRunOperatorAuthority({ admittedRunContext }),
      ),
    };
  };
  return (callId: string) =>
    admitSessionShellCall({ target, fallbackFence, runId, callId, captureNotice });
}
