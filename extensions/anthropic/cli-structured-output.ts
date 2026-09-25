import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Native StructuredOutput is terminal data submission, never an action grant.
 * Validate both its hook input and its terminal result. Never infer it from prose
 * or let native schema-compilation failure silently degrade to ordinary text. */
export function validateClaudeStructuredOutput(
  schema: Record<string, unknown>,
  value: unknown,
): string {
  if (!isRecord(value)) {
    throw new Error("Claude CLI returned missing or invalid structured output");
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 64 * 1024) {
    throw new Error("Claude CLI structured output exceeds 64 KiB");
  }
  const checked = validateJsonSchemaValue({
    schema,
    cacheKey: "claude-cli-terminal-output",
    value,
  });
  if (!checked.ok) {
    throw new Error("Claude CLI returned invalid structured output");
  }
  return encoded;
}
