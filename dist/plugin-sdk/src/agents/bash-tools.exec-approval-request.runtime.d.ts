import type { ExecApprovalCommandSpan } from "../infra/exec-approvals.js";
export declare function resolveExecApprovalCommandSpans(command: string): Promise<ExecApprovalCommandSpan[] | undefined>;
