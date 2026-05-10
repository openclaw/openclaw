const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "sk-<redacted>"],
  [/\b(xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "xox<redacted>"],
  [/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "gh<redacted>"],
  [
    /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|COOKIE|API[_-]?KEY)[A-Za-z0-9_]*\s*=\s*)([^\s'"`]{4,})/gi,
    "$1<redacted>",
  ],
  [/\b(Bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi, "$1<redacted>"],
  [/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, "<email-redacted>"],
];

export function redactCodexBridgeText(value: unknown, maxChars = 1200): string {
  let text = stringifyRedactionInput(value);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  text = stripPromptInjectionCommands(text).replace(/\p{C}/gu, "?").trim();
  if (text.length > maxChars) {
    return `${text.slice(0, Math.max(0, maxChars - 14)).trimEnd()}... <truncated>`;
  }
  return text;
}

function stringifyRedactionInput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unprintable]";
  }
}

export function redactCodexBridgeJson<T>(value: T): T {
  if (typeof value === "string") {
    return redactCodexBridgeText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCodexBridgeJson(entry)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/\b(token|secret|password|cookie|authorization|apiKey|api_key)\b/i.test(key)) {
      next[key] = "<redacted>";
    } else {
      next[key] = redactCodexBridgeJson(entry);
    }
  }
  return next as T;
}

function stripPromptInjectionCommands(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) =>
      /\b(send|execute|run|forward|telegram|curl|rm\s+-rf|delete)\b/i.test(block)
        ? "[redacted code block]"
        : block,
    )
    .replace(
      /\b(?:send|forward)\s+(?:this|the following)\s+(?:command|message)\s+to\s+telegram\b/gi,
      "[redacted instruction]",
    );
}
