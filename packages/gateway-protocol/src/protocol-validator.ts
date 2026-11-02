import { normalizeTypeBoxValidationErrors } from "@openclaw/normalization-core/json-schema";
import type { TSchema } from "typebox";
import { Errors } from "typebox/schema";
import type { ValidationError } from "./validation-errors.js";

/** Runtime validator shape shared by gateway clients and server handlers. */
export type ProtocolValidator<T = unknown> = ((data: unknown) => data is T) & {
  errors: ValidationError[] | null; // Ajv-style last validation errors.
  /** Original schema used by the validator, exposed for diagnostics/tests. */
  schema: unknown;
};

type ValidationDiagnostics = (data: unknown) => ValidationError[] | undefined;

// Checks are generated from this schema; only invalid input needs the diagnostic walker.
/* @__NO_SIDE_EFFECTS__ */
export function createProtocolValidator<T>(
  schema: TSchema,
  check: (data: unknown) => data is T,
  precheck?: (data: unknown) => ValidationError | undefined,
  diagnostics?: ValidationDiagnostics,
): ProtocolValidator<T> {
  let errors: ValidationError[] | null = null;
  const properties: { errors: ValidationError[] | null; schema: unknown } = {
    errors: null,
    schema,
  };
  const validate = Object.assign((data: unknown): data is T => {
    const precheckError = precheck?.(data);
    if (precheckError) {
      errors = [precheckError];
      return false;
    }
    const valid = check(data);
    if (valid) {
      errors = null;
    } else {
      const originalErrors = Errors(schema, data)[1];
      // Diagnostic views never admit input or expand the validator's error budget.
      errors = normalizeTypeBoxValidationErrors(
        (diagnostics?.(data) ?? originalErrors).slice(0, originalErrors.length),
      );
    }
    return valid;
  }, properties);

  Object.defineProperties(validate, {
    errors: {
      configurable: true,
      enumerable: true,
      get: () => errors,
      set: (nextErrors: ValidationError[] | null | undefined) => {
        // Preserve Ajv-compatible mutability for callers/tests that clear errors.
        errors = nextErrors ?? null;
      },
    },
    schema: {
      configurable: true,
      enumerable: true,
      get: () => schema,
    },
  });

  return validate;
}
