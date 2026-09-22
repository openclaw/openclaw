import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const ComputerStatusParamsSchema = closedObject({});

export const ComputerInvokeParamsSchema = closedObject({
  command: Type.Enum(["screen.snapshot", "computer.act"]),
  params: Type.Record(Type.String(), Type.Unknown()),
  generation: NonEmptyString,
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  idempotencyKey: NonEmptyString,
});

export type ComputerStatusParams = Static<typeof ComputerStatusParamsSchema>;
export type ComputerInvokeParams = Static<typeof ComputerInvokeParamsSchema>;
