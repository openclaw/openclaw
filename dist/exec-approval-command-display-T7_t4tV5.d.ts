import { c as ExecApprovalRequestPayload } from "./exec-approvals-BpVWMnuu.js";

//#region src/infra/exec-approval-command-display.d.ts
declare function sanitizeExecApprovalDisplayText(commandText: string): string;
declare function sanitizeExecApprovalWarningText(warningText: string): string;
declare function resolveExecApprovalCommandDisplay(request: ExecApprovalRequestPayload): {
  commandText: string;
  commandPreview: string | null;
};
//#endregion
export { sanitizeExecApprovalDisplayText as n, sanitizeExecApprovalWarningText as r, resolveExecApprovalCommandDisplay as t };