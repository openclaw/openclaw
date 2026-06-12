const EMAIL_ADDRESS_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const CHINA_MAINLAND_MOBILE_RE =
  /(?<![\dA-Za-z])(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?![\dA-Za-z])/g;
const CHINA_SERVICE_PHONE_RE =
  /(?<![\dA-Za-z])(?:95\d{3}|(?:400|800)[-\s]?\d{3}[-\s]?\d{4})(?![\dA-Za-z])/g;

const EMAIL_REDACTION_TEXT = "[email redacted]";
const PHONE_REDACTION_TEXT = "[phone redacted]";

/**
 * Feishu may reject bot messages that include contact identifiers with audit
 * code 230028. Redact them at the Feishu outbound boundary so a successful
 * agent result is not followed by a failed delivery fallback.
 */
export function redactFeishuAuditSensitiveText(text: string): string {
  return text
    .replace(EMAIL_ADDRESS_RE, EMAIL_REDACTION_TEXT)
    .replace(CHINA_MAINLAND_MOBILE_RE, PHONE_REDACTION_TEXT)
    .replace(CHINA_SERVICE_PHONE_RE, PHONE_REDACTION_TEXT);
}

export function redactFeishuAuditSensitiveValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactFeishuAuditSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactFeishuAuditSensitiveValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = redactFeishuAuditSensitiveValue(item);
  }
  return redacted;
}
