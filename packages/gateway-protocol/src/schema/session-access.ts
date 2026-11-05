import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Confidentiality is independent of collaboration/display mode. */
export const SessionAccessSchema = Type.Union([
  closedObject({ mode: Type.Literal("creator") }),
  closedObject({
    mode: Type.Literal("audience"),
    profileIds: Type.Array(NonEmptyString, { maxItems: 1000, uniqueItems: true }),
  }),
  closedObject({ mode: Type.Literal("source") }),
  closedObject({ mode: Type.Literal("unrestricted") }),
]);
