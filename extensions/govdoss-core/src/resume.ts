export type ApprovalContinuation = {
  approvalId: string;
  subject: string;
  action: string;
  createdAt: number;
  status: "pending" | "ready" | "expired";
};

export function createContinuation(input: {
  approvalId: string;
  subject: string;
  action: string;
}): ApprovalContinuation {
  return {
    approvalId: input.approvalId,
    subject: input.subject,
    action: input.action,
    createdAt: Date.now(),
    status: "pending"
  };
}

export function markContinuationReady(token: ApprovalContinuation): ApprovalContinuation {
  return {
    ...token,
    status: "ready"
  };
}
