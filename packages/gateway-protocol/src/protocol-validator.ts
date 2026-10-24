import { normalizeTypeBoxValidationErrors } from "@openclaw/normalization-core/json-schema";
import type { Static, TSchema } from "typebox";
import { Compile, type Validator as TypeBoxValidator } from "typebox/schema";
import type { ValidationError } from "./validation-errors.js";

/** Runtime validator shape shared by gateway clients and server handlers. */
export type ProtocolValidator<T = unknown> = ((data: unknown) => data is T) & {
  errors: ValidationError[] | null; // Ajv-style last validation errors.
  /** Original schema used by the validator, exposed for diagnostics/tests. */
  schema: unknown;
};

type ValidationDiagnostics = (data: unknown) => ValidationError[] | undefined;

// Defer TypeBox compilation because the protocol entrypoint is common on startup paths.
export function lazyCompile<const Schema extends TSchema>(
  schema: Schema,
  precheck?: (data: unknown) => ValidationError | undefined,
  diagnostics?: ValidationDiagnostics,
): ProtocolValidator<Static<Schema>>;
// Keep compact hand-authored public types where schema-derived declarations are intentionally avoided.
export function lazyCompile<T>(
  schema: TSchema,
  precheck?: (data: unknown) => ValidationError | undefined,
  diagnostics?: ValidationDiagnostics,
): ProtocolValidator<T>;
/* @__NO_SIDE_EFFECTS__ */
export function lazyCompile<T = unknown>(
  schema: TSchema,
  precheck?: (data: unknown) => ValidationError | undefined,
  diagnostics?: ValidationDiagnostics,
): ProtocolValidator<T> {
  let compiled: TypeBoxValidator | undefined;
  let errors: ValidationError[] | null = null;

  const validate = ((data: unknown): data is T => {
    const precheckError = precheck?.(data);
    if (precheckError) {
      errors = [precheckError];
      return false;
    }
    const current = (compiled ??= Compile(schema));
    const valid = current.Check(data);
    if (valid) {
      errors = null;
    } else {
      const originalErrors = current.Errors(data)[1];
      // Diagnostic views never admit input or expand the validator's error budget.
      errors = normalizeTypeBoxValidationErrors(
        (diagnostics?.(data) ?? originalErrors).slice(0, originalErrors.length),
      );
    }
    return valid;
  }) as ProtocolValidator<T>;

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
