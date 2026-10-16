import type { Static, TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

/** Untrusted inputs are checked against owned TypeBox schemas once at ingress. */
export function parseValue<S extends TSchema>(schema: S, value: unknown): Static<S> {
  if (!Check(schema, value)) {
    throw new Error(
      `Invalid research data: ${Errors(schema, value)
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  return value;
}
