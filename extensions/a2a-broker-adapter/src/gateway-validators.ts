/**
 * Plugin-local AJV validators for A2A gateway method params.
 */
import Ajv from "ajv";
import type {
  A2ATaskCancelParams,
  A2ATaskRequestParams,
  A2ATaskStatusParams,
  A2ATaskUpdateParams,
} from "./gateway-schema.js";
import {
  A2ATaskCancelParamsSchema,
  A2ATaskRequestParamsSchema,
  A2ATaskStatusParamsSchema,
  A2ATaskUpdateParamsSchema,
} from "./gateway-schema.js";

const ajv = new Ajv({ allErrors: true, strict: false, removeAdditional: false });

export const validateA2ATaskRequestParams = ajv.compile<A2ATaskRequestParams>(
  A2ATaskRequestParamsSchema,
);
export const validateA2ATaskUpdateParams =
  ajv.compile<A2ATaskUpdateParams>(A2ATaskUpdateParamsSchema);
export const validateA2ATaskCancelParams =
  ajv.compile<A2ATaskCancelParams>(A2ATaskCancelParamsSchema);
export const validateA2ATaskStatusParams =
  ajv.compile<A2ATaskStatusParams>(A2ATaskStatusParamsSchema);

/**
 * Minimal validation helper — replaces core assertValidParams.
 * Returns true if valid; returns an error object if not.
 */
export function validateParams<T>(
  params: unknown,
  validate: (data: unknown) => data is T,
  method: string,
): { valid: true; data: T } | { valid: false; error: { code: string; message: string } } {
  if (validate(params)) {
    return { valid: true, data: params };
  }
  const errors = validate.errors?.map((e) => `${e.instancePath || "/"}: ${e.message}`).join("; ");
  return {
    valid: false,
    error: { code: "INVALID_REQUEST", message: `invalid ${method} params: ${errors || "unknown"}` },
  };
}
