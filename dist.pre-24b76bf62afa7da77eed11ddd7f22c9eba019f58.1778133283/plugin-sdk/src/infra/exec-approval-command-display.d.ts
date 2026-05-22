import type { ExecApprovalRequestPayload } from "./exec-approvals.js";
export declare function sanitizeExecApprovalDisplayText(commandText: string): string;
export declare function sanitizeExecApprovalWarningText(warningText: string): string;
export declare function resolveExecApprovalCommandDisplay(request: ExecApprovalRequestPayload): {
    commandText: string;
    commandPreview: string | null;
};
