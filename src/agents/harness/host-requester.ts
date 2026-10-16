import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";

/** Requester facts a harness host forwards to tool hooks, frozen from the admitted attempt. */
export function buildHarnessHostRequester(
  attempt: Pick<
    Partial<EmbeddedRunAttemptParams>,
    | "messageChannel"
    | "messageProvider"
    | "agentAccountId"
    | "senderId"
    | "senderIsOwner"
    | "memberRoleIds"
  >,
) {
  return {
    ...((attempt.messageChannel ?? attempt.messageProvider)
      ? { channel: attempt.messageChannel ?? attempt.messageProvider ?? undefined }
      : {}),
    ...(attempt.agentAccountId ? { accountId: attempt.agentAccountId } : {}),
    ...(attempt.senderId ? { senderId: attempt.senderId } : {}),
    ...(attempt.senderIsOwner !== undefined ? { senderIsOwner: attempt.senderIsOwner } : {}),
    ...(attempt.memberRoleIds?.length
      ? { roleIds: Object.freeze([...attempt.memberRoleIds]) }
      : {}),
  };
}
