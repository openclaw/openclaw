import type { TypeBoxValidationError } from "@openclaw/normalization-core/json-schema";
import { hasNonEmptyString, readNonBlankString } from "@openclaw/normalization-core/string-coerce";

/** Normalized validation error shape exposed by every protocol validator. */
export type ValidationError = TypeBoxValidationError;

export function checkProtocolJson(data: unknown, maxDepth: number): ValidationError | undefined {
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: data }];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    if (current.depth > maxDepth) {
      return {
        keyword: "maxDepth",
        params: { limit: maxDepth },
        message: `must not exceed JSON nesting depth ${maxDepth}`,
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
    const values = Array.isArray(current.value) ? current.value : Object.values(current.value);
    for (const value of values) {
      stack.push({ depth: current.depth + 1, value });
    }
  }
  return undefined;
}

const MAX_VALIDATION_ERROR_FIELDS = 8;

function stringParams(value: unknown, fallback?: unknown): string[] {
  if (hasNonEmptyString(value)) {
    return [value];
  }
  const values = Array.isArray(value)
    ? value.slice(0, MAX_VALIDATION_ERROR_FIELDS).filter(hasNonEmptyString)
    : [];
  return values.length > 0 || fallback === undefined ? values : stringParams(fallback);
}

/** Convert validator errors into compact operator-facing failure text. */
export function formatValidationErrors(errors: ValidationError[] | null | undefined) {
  if (!errors?.length) {
    return "unknown validation error";
  }

  const parts: string[] = [];

  for (const err of errors) {
    const keyword = typeof err?.keyword === "string" ? err.keyword : "";
    const instancePath = typeof err?.instancePath === "string" ? err.instancePath : "";

    if (keyword === "additionalProperties" || keyword === "required") {
      const additional = keyword === "additionalProperties";
      const properties = stringParams(
        additional ? err?.params?.additionalProperty : err?.params?.missingProperty,
        additional ? err?.params?.additionalProperties : err?.params?.requiredProperties,
      );
      if (properties.length > 0) {
        const where = instancePath ? `at ${instancePath}: ` : additional ? "at root: " : "";
        const message = additional ? "unexpected property" : "must have required property";
        for (const property of properties) {
          parts.push(`${where}${message} '${property}'`);
        }
        continue;
      }
    }
    if (keyword === "enum") {
      const allowedValues = stringParams(err?.params?.allowedValues);
      if (allowedValues.length > 0) {
        const where = instancePath ? `at ${instancePath}: ` : "";
        parts.push(
          `${where}must be one of: ${allowedValues.map((value) => JSON.stringify(value)).join(", ")}`,
        );
        continue;
      }
    }

    const failingKeyword =
      typeof err?.params?.failingKeyword === "string" ? err.params.failingKeyword : "";
    // TypeBox reports conditional required-property misses through if/then
    // keywords, which otherwise hide the actionable missing-property context.
    const message =
      keyword === "then" || (keyword === "if" && failingKeyword === "then")
        ? "must have required conditional properties"
        : (readNonBlankString(err?.message) ?? "validation error");
    const where = instancePath ? `at ${instancePath}: ` : "";
    parts.push(`${where}${message}`);
  }

  const unique = [...new Set(parts.filter((part) => part.trim()))];
  return unique.length > 0 ? unique.join("; ") : "unknown validation error";
}
