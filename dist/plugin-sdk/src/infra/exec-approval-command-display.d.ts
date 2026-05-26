import type { ExecApprovalRequestPayload } from "./exec-approvals.js";
export type SanitizedExecApprovalDisplayText = {
    text: string;
    truncated: boolean;
    oversized: boolean;
};
export declare function sanitizeExecApprovalDisplayText(commandText: string): string;
export declare function sanitizeExecApprovalDisplayTextWithStatus(commandText: string): SanitizedExecApprovalDisplayText;
export declare function sanitizeExecApprovalWarningText(warningText: string): string;
export declare function resolveExecApprovalCommandDisplay(request: ExecApprovalRequestPayload): {
    commandText: string;
    commandPreview: string | null;
};
