// LLM Format: token-efficient structured data format for AI context windows.
// Converts JSON objects to LLM format (key=value with sections).
// ~49% token savings vs compact JSON for structured, repetitive, schema-familiar data.
// Spec: G:\Dx\serializer\LLM_FORMAT_SPEC.md

const INDENT = "  ";

function escapeLlmValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function needsQuotes(value: string): boolean {
  return /[^A-Za-z0-9._\-]/.test(value) || value === "";
}

function formatLlmValue(value: unknown, indent = 0): string {
  const pad = INDENT.repeat(indent);
  if (value === null || value === undefined) return `${pad}null`;
  if (typeof value === "boolean") return `${pad}${value ? "true" : "false"}`;
  if (typeof value === "number") {
    if (Number.isInteger(value) && Number.isSafeInteger(value)) return `${pad}${value}`;
    return `${pad}${value}`;
  }
  if (typeof value === "string") {
    if (needsQuotes(value)) return `${pad}"${escapeLlmValue(value)}"`;
    return `${pad}${value}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    // Arrays of primitives: compact inline
    if (value.every((v) => typeof v !== "object" || v === null)) {
      return `${pad}[${value
        .map((v) => {
          if (typeof v === "string") {
            return needsQuotes(v) ? `"${escapeLlmValue(v)}"` : v;
          }
          return String(v);
        })
        .join(" ")}]`;
    }
    // Arrays of objects: one per line
    const items = value.map((v) => formatLlmValue(v, indent + 1)).join("\n");
    return `${pad}[\n${items}\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${pad}{}`;
    const body = entries
      .map(([k, v]) => {
        const val = formatLlmValue(v, indent + 1);
        return `${INDENT.repeat(indent + 1)}${k}=${val.trimStart()}`;
      })
      .join("\n");
    return `${pad}{\n${body}\n${pad}}`;
  }
  return `${pad}${String(value)}`;
}

/** Converts a JSON object to LLM format string. */
export function toLlmFormat(input: unknown, options?: { rootSection?: string }): string {
  if (typeof input !== "object" || input === null) {
    return formatLlmValue(input);
  }
  const obj = input as Record<string, unknown>;
  const lines: string[] = [];

  if (options?.rootSection) {
    lines.push(`[${options.rootSection}]`);
  }

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // Nested object → sub-section with dotted keys
      flattenObject(key, value as Record<string, unknown>, "", lines);
    } else if (Array.isArray(value) && value.every((v) => typeof v === "object" && v !== null)) {
      // Array of objects → section with index
      for (let i = 0; i < value.length; i++) {
        const entry = value[i] as Record<string, unknown>;
        flattenObject(`${key}.${i}`, entry, "", lines);
      }
    } else {
      const formatted = formatLlmValue(value);
      lines.push(`${key}=${formatted.trimStart()}`);
    }
  }

  return lines.join("\n");
}

function flattenObject(
  prefix: string,
  obj: Record<string, unknown>,
  _path: string,
  lines: string[],
): void {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = `${prefix}.${key}`;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      flattenObject(fullKey, value as Record<string, unknown>, "", lines);
    } else {
      const formatted = formatLlmValue(value);
      lines.push(`${fullKey}=${formatted.trimStart()}`);
    }
  }
}

/** Estimates token count of an LLM format string (rough: 1 token ≈ 4 chars for English). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Converts a JSON object to LLM format and estimates token savings vs JSON. */
export function toLlmFormatWithMetrics(input: unknown): {
  llm: string;
  json: string;
  llmTokens: number;
  jsonTokens: number;
  savingsPercent: number;
} {
  const json = JSON.stringify(input, null, 2);
  const llm = toLlmFormat(input);
  const jsonTokens = estimateTokens(json);
  const llmTokens = estimateTokens(llm);
  const savingsPercent =
    jsonTokens > 0 ? Math.round(((jsonTokens - llmTokens) / jsonTokens) * 100) : 0;
  return { llm, json, llmTokens, jsonTokens, savingsPercent };
}
