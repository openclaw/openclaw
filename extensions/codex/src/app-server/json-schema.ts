import { z } from "zod";
import type { JsonObject, JsonValue } from "./protocol-json.js";

// Same recursive union z.json() builds, with an explicit type. TypeScript 7.1
// (tsrs and current tsgo nightlies) reports TS5115 when zod's inferred
// z.json() type is nested in z.record(); the annotation keeps the checker
// from re-deriving that recursive inference at each use.
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);
