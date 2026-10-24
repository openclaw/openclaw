import type { ExecAutoReviewDecision, ExecAutoReviewInput } from "../infra/exec-auto-review.js";
import type { ExecApprovalRegistration } from "./bash-tools.exec-approval-request.js";

export type ExecApprovalExecution = {
  command: string;
  execCommand: string;
  cwd: string;
  env: Record<string, string>;
  pty: boolean;
};

/** One exec call's remote review and approval lifetime; never shared between commands. */
export type ExecApprovalTransport = {
  bindExecution(input: ExecApprovalExecution): void;
  assertExecution(input: ExecApprovalExecution): void;
  review(input: ExecAutoReviewInput): Promise<ExecAutoReviewDecision>;
  request(input: { id: string; warningText?: string }): Promise<ExecApprovalRegistration>;
  waitDecision(input: {
    id: string;
  }): Promise<{ decision: string | null; terminalReason?: string }>;
};
