import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { IMessagePayload, IMessagePoll } from "../monitor/types.js";

export async function resolvedApproval({ decision }: { decision: ExecApprovalReplyDecision }) {
  return {
    applied: true,
    approval: { status: decision === "deny" ? "denied" : "allowed", decision, reason: "user" },
  };
}

export function pollVote(
  pollGuid: string,
  votes: IMessagePoll["votes"],
  message: IMessagePayload = {},
  vote?: IMessagePoll["vote"],
): IMessagePayload {
  return {
    sender: "+15551230000",
    ...message,
    poll: { kind: "vote", original_guid: pollGuid, votes, vote },
  };
}
