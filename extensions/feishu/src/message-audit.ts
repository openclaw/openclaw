// Feishu plugin module classifies message audit failures.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const FEISHU_MESSAGE_AUDIT_REJECTION_CODE = 230028;
export const MESSAGE_AUDIT_REJECTION_NOTICE =
  "⚠️ Feishu couldn't deliver this reply because it didn't pass a content policy check.";

export function isFeishuMessageAuditRejection(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const response = isRecord(error.response) ? error.response : undefined;
  const data = isRecord(response?.data) ? response.data : undefined;
  if (data?.code === FEISHU_MESSAGE_AUDIT_REJECTION_CODE) {
    return true;
  }
  const cause = error.cause;
  return cause !== undefined && cause !== error && isFeishuMessageAuditRejection(cause);
}
