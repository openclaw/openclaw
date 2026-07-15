// Structural guard for worker transcript payloads: rejects overly deep,
// cyclic, or non-JSON values before schema validation walks them.
import { WORKER_TRANSCRIPT_MAX_JSON_DEPTH } from "./schema.js";
import type { ValidationError } from "./validation-errors.js";

export function checkWorkerProtocolJson(data: unknown): ValidationError | undefined {
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: data }];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    if (current.depth > WORKER_TRANSCRIPT_MAX_JSON_DEPTH) {
      return {
        keyword: "maxDepth",
        params: { limit: WORKER_TRANSCRIPT_MAX_JSON_DEPTH },
        message: `must not exceed JSON nesting depth ${WORKER_TRANSCRIPT_MAX_JSON_DEPTH}`,
      };
    }
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) {
        return { keyword: "finite", message: "must contain only finite JSON numbers" };
      }
      continue;
    }
    if (typeof current.value !== "object") {
      return { keyword: "jsonValue", message: "must contain only JSON values" };
    }
    if (seen.has(current.value)) {
      return { keyword: "acyclic", message: "must be an acyclic JSON value" };
    }
    seen.add(current.value);
    const values = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const value of values) {
      stack.push({ depth: current.depth + 1, value });
    }
  }
  return undefined;
}
