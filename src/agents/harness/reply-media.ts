import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withChannelReadAuthority } from "../../shared/channel-read-authority.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

/** Capture policy before plugin invocation; the supplied reader only provides workspace bytes. */
export function bindHarnessReplyMedia(params: {
  attempt: Partial<EmbeddedRunAttemptParams>;
  config?: OpenClawConfig;
  assertActive: () => void;
  signal: AbortSignal;
}): AgentHarnessHostCapabilities["prepareReplyMedia"] {
  const { attempt, assertActive } = params;
  if (!attempt.workspaceDir) {
    return undefined;
  }
  const context = Object.freeze({
    cfg: params.config ?? {},
    workspaceDir: attempt.workspaceDir,
    agentId: attempt.agentId,
    sessionKey: attempt.sessionKey ?? attempt.sessionId,
    messageProvider: attempt.messageChannel ?? attempt.messageProvider,
    accountId: attempt.agentAccountId,
    groupId: attempt.groupId ?? undefined,
    groupChannel: attempt.groupChannel ?? undefined,
    groupSpace: attempt.groupSpace ?? undefined,
    requesterSenderId: attempt.senderId ?? undefined,
    requesterSenderName: attempt.senderName ?? undefined,
    requesterSenderUsername: attempt.senderUsername ?? undefined,
    requesterSenderE164: attempt.senderE164 ?? undefined,
    sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
    runId: attempt.runId,
    reasoningLevel: attempt.reasoningLevel,
  });
  const attemptSignal = attempt.abortSignal;
  return async (request) => {
    const assertSourceCurrent = request.assertCurrent;
    const signal = AbortSignal.any([
      params.signal,
      ...(attemptSignal ? [attemptSignal] : []),
      ...(request.signal ? [request.signal] : []),
    ]);
    const assertCurrent = () => {
      assertActive();
      assertSourceCurrent?.();
      signal.throwIfAborted();
    };
    assertCurrent();
    const { prepareHarnessReplyMedia } = await import("./reply-media-runtime.js");
    assertCurrent();
    const result = await withChannelReadAuthority(
      assertCurrent,
      () => prepareHarnessReplyMedia({ request, context, signal, assertCurrent }),
      signal,
    );
    assertCurrent();
    return result;
  };
}
