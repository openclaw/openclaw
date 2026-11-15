import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Routing hints only; never session, turn, or approval authority. */
export const SystemRunExecutionContextSchema = closedObject({
  senderId: Type.Optional(NonEmptyString),
  chatId: Type.Optional(NonEmptyString),
  subagent: Type.Optional(Type.Literal(true)),
});
