import { Type, type Static } from "typebox";
import { SESSION_ENVIRONMENT_NODE_COMMANDS } from "../environment-node-capabilities.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const EnvironmentsSessionInvokeParamsSchema = closedObject({
  sessionKey: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
  environmentId: NonEmptyString,
  expectedOwnerEpoch: Type.Optional(Type.Integer({ minimum: 0 })),
  expectedGeneration: Type.Optional(Type.Integer({ minimum: 0 })),
  command: Type.Union(SESSION_ENVIRONMENT_NODE_COMMANDS.map((command) => Type.Literal(command))),
  params: Type.Unknown(),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
});
export type EnvironmentsSessionInvokeParams = Static<typeof EnvironmentsSessionInvokeParamsSchema>;
