import type { Static, TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

export class ResearchValidationError extends Error {
  constructor(
    message: string,
    readonly constraint?: string,
  ) {
    super(message);
  }
}

/** Untrusted inputs are checked against owned TypeBox schemas once at ingress. */
export function parseValue<S extends TSchema>(schema: S, value: unknown): Static<S> {
  if (!Check(schema, value)) {
    const errors = [...Errors(schema, value)];
    const constraint = errors
      .flatMap((error) => {
        if (
          error.keyword !== "maxLength" ||
          !/^(?:\/(?:questions|queries|gaps|unanswered)\/\d+|\/findings\/\d+\/(?:statement|evidence\/\d+\/quote)|\/verdicts\/\d+\/reason)$/u.test(
            error.instancePath,
          )
        ) {
          return [];
        }
        return [`${error.instancePath}: maxLength ${error.params.limit}`];
      })
      .slice(0, 4)
      .join("; ");
    throw new ResearchValidationError(
      `Invalid research data: ${errors.map((error) => error.message).join("; ")}`,
      constraint || undefined,
    );
  }
  return value;
}
