import { OcEmitSentinelError, REDACTED_SENTINEL } from "../sentinel.js";
import type { JsoncValue } from "./ast.js";

export function renderJsoncValue(
  value: JsoncValue,
  guardPath: string,
  walked: readonly string[] = [],
): string {
  if (value.kind === "null") {
    return "null";
  }
  if (value.kind === "number" || value.kind === "boolean") {
    return String(value.value);
  }
  if (value.kind === "string") {
    // Substring match: embedded sentinel leaks marker bytes too.
    if (value.value.includes(REDACTED_SENTINEL)) {
      throw new OcEmitSentinelError(`${guardPath}/${walked.join("/")}`);
    }
    return JSON.stringify(value.value);
  }
  if (value.kind === "array") {
    const parts = value.items.map((v, i) => renderJsoncValue(v, guardPath, [...walked, String(i)]));
    return `[${parts.join(",")}]`;
  }
  const parts = value.entries.map(
    (e) => `${JSON.stringify(e.key)}:${renderJsoncValue(e.value, guardPath, [...walked, e.key])}`,
  );
  return `{${parts.join(",")}}`;
}
