/**
 * Plugin-local AJV validators for A2A gateway method params.
 */
import AjvPkg, { type ErrorObject } from "ajv";
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

type Validator<T> = ((data: unknown) => data is T) & {
  errors?: ErrorObject[] | null;
};

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

export const validateA2ATaskRequestParams = ajv.compile<A2ATaskRequestParams>(
  A2ATaskRequestParamsSchema,
) as Validator<A2ATaskRequestParams>;
export const validateA2ATaskUpdateParams = ajv.compile<A2ATaskUpdateParams>(
  A2ATaskUpdateParamsSchema,
) as Validator<A2ATaskUpdateParams>;
export const validateA2ATaskCancelParams = ajv.compile<A2ATaskCancelParams>(
  A2ATaskCancelParamsSchema,
) as Validator<A2ATaskCancelParams>;
export const validateA2ATaskStatusParams = ajv.compile<A2ATaskStatusParams>(
  A2ATaskStatusParamsSchema,
) as Validator<A2ATaskStatusParams>;

/**
 * Minimal validation helper — replaces core assertValidParams.
 * Returns true if valid; returns an error object if not.
 */
export function validateParams<T>(
  params: unknown,
  validate: Validator<T>,
  method: string,
): { valid: true; data: T } | { valid: false; error: { code: string; message: string } } {
  if (validate(params)) {
    return { valid: true, data: params };
  }
  const errors = validate.errors
    ?.map((e: ErrorObject) => `${e.instancePath || "/"}: ${e.message}`)
    .join("; ");
  return {
    valid: false,
    error: { code: "INVALID_REQUEST", message: `invalid ${method} params: ${errors || "unknown"}` },
  };
}
