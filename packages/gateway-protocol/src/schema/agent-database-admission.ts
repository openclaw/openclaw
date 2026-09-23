import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const AgentDatabaseAdmissionRefusalProperties = {
  agentId: NonEmptyString,
  paths: Type.Array(NonEmptyString),
  reason: NonEmptyString,
  repairHint: NonEmptyString,
};

export const AgentDatabaseAdmissionRefusalSchema = Type.Union([
  closedObject({
    ...AgentDatabaseAdmissionRefusalProperties,
    embeddedOwnerId: NonEmptyString,
    code: Type.Literal("agent-database-ownership-mismatch"),
  }),
  closedObject({
    ...AgentDatabaseAdmissionRefusalProperties,
    code: Type.Union([
      Type.Literal("agent-database-inspection-pending"),
      Type.Literal("agent-database-inspection-failed"),
    ]),
  }),
]);
