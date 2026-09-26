import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { redactQaGatewayDebugText } from "./gateway-log-redaction.js";
import type { QaSuiteScenarioResult } from "./suite-types.js";

export function sanitizeQaProgressValue(value: string): string {
  const normalized = value.replace(/[\p{Cc}\s]+/gu, " ").trim();
  return normalized.length > 0 ? normalized : "<empty>";
}

export function formatQaScenarioFailureSuffix(result: QaSuiteScenarioResult): string {
  if (result.status !== "fail") {
    return "";
  }
  const step = result.steps.find((candidate) => candidate.status === "fail");
  const details = [step?.name, step?.details ?? result.details].filter(Boolean).join(": ");
  if (!details) {
    return "";
  }
  // Redact before flattening or truncating: either could break a secret pattern
  // or turn untrusted multiline diagnostics into a CI workflow command.
  const sanitized = sanitizeQaProgressValue(redactQaGatewayDebugText(details));
  const bounded = sanitized.length > 512 ? `${sliceUtf16Safe(sanitized, 0, 511)}…` : sanitized;
  return ` — ${bounded}`;
}
