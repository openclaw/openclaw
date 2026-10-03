import { type Static, Type } from "typebox";
import { lazyCompile } from "./protocol-validator.js";
import { closedObject } from "./schema/closed-object.js";
import { NonEmptyString } from "./schema/primitives.js";

export const SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY = "system.run.execution-context.v1";

/** Routing hints only; never session, turn, or approval authority. */
export const SystemRunExecutionContextSchema = closedObject({
  senderId: Type.Optional(NonEmptyString),
  chatId: Type.Optional(NonEmptyString),
  subagent: Type.Optional(Type.Literal(true)),
});
export type SystemRunExecutionContext = Static<typeof SystemRunExecutionContextSchema>;
export const validateSystemRunExecutionContext = lazyCompile(SystemRunExecutionContextSchema);
