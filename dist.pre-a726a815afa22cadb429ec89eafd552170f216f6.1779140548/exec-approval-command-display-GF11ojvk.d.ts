import { c as ExecApprovalRequestPayload } from "./exec-approvals-gH2fED34.js";

//#region src/infra/exec-approval-command-display.d.ts
type SanitizedExecApprovalDisplayText = {
  text: string;
  truncated: boolean;
  oversized: boolean;
};
declare function sanitizeExecApprovalDisplayText(commandText: string): string;
declare function sanitizeExecApprovalDisplayTextWithStatus(commandText: string): SanitizedExecApprovalDisplayText;
declare function sanitizeExecApprovalWarningText(warningText: string): string;
declare function resolveExecApprovalCommandDisplay(request: ExecApprovalRequestPayload): {
  commandText: string;
  commandPreview: string | null;
};
//#endregion
export { sanitizeExecApprovalWarningText as a, sanitizeExecApprovalDisplayTextWithStatus as i, resolveExecApprovalCommandDisplay as n, sanitizeExecApprovalDisplayText as r, SanitizedExecApprovalDisplayText as t };