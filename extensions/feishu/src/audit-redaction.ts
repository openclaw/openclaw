const EMAIL_ADDRESS_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const CHINA_MAINLAND_MOBILE_RE =
  /(?<![\dA-Za-z])(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?![\dA-Za-z])/g;
const CHINA_SERVICE_PHONE_RE =
  /(?<![\dA-Za-z])(?:95\d{3}|(?:400|800)[-\s]?\d{3}[-\s]?\d{4})(?![\dA-Za-z])/g;

const EMAIL_REDACTION_TEXT = "[email redacted]";
const PHONE_REDACTION_TEXT = "[phone redacted]";
const FEISHU_VISIBLE_TEXT_TAGS = new Set(["markdown", "plain_text", "lark_md"]);
const FEISHU_TEMPLATE_VARIABLE_KEYS = new Set(["template_variable", "template_variables"]);

type JsonRecord = Record<string, unknown>;

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

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isVisibleTextNode(record: JsonRecord): boolean {
  return typeof record.tag === "string" && FEISHU_VISIBLE_TEXT_TAGS.has(record.tag);
}

function redactFeishuTemplateVariableValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactFeishuAuditSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactFeishuTemplateVariableValue(item));
  }
  if (!isJsonRecord(value)) {
    return value;
  }

  const redacted: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = redactFeishuTemplateVariableValue(item);
  }
  return redacted;
}

function redactFeishuCardVisibleValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactFeishuCardVisibleValue(item));
  }
  if (!isJsonRecord(value)) {
    return value;
  }

  const redactsContent = isVisibleTextNode(value);
  const redacted: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] =
      redactsContent && key === "content" && typeof item === "string"
        ? redactFeishuAuditSensitiveText(item)
        : FEISHU_TEMPLATE_VARIABLE_KEYS.has(key)
          ? redactFeishuTemplateVariableValue(item)
          : redactFeishuCardVisibleValue(item);
  }
  return redacted;
}

export function redactFeishuCardVisibleText<T extends JsonRecord>(card: T): T {
  return redactFeishuCardVisibleValue(card) as T;
}
