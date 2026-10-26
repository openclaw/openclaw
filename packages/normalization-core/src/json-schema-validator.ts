import { CheckContext, CheckSchema, Errors, Stack } from "typebox/schema";
import {
  normalizeTypeBoxValidationErrors,
  type JsonSchemaValue,
  type TypeBoxValidationError,
} from "./json-schema.js";

export type JsonSchemaValidator = {
  readonly schema: JsonSchemaValue;
  check: (value: unknown) => boolean;
  errors: (value: unknown) => TypeBoxValidationError[];
};

/** Prepare an admitted schema for validation without generating JavaScript. */
export function createJsonSchemaValidator(
  schema: JsonSchemaValue,
  options: {
    context?: Record<string, JsonSchemaValue>;
  } = {},
): JsonSchemaValidator {
  const context = options.context ?? {};
  const stack = Stack(context, schema);
  // Evaluated-property state belongs to one value, including after a failed union branch.
  const check = (value: unknown) => CheckSchema(stack, new CheckContext(), schema, value);
  return {
    schema,
    check,
    errors: (value) => normalizeTypeBoxValidationErrors(Errors(context, schema, value)[1]),
  };
}
