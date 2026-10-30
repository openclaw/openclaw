import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const OwnerId = Type.String({ maxLength: 256 });
const Count = Type.Integer({ minimum: 0 });

/** Administrator-only, payload-free observations of the existing lifetime owner. */
export const PluginRuntimeRetentionSchema = closedObject({
  instanceId: NonEmptyString,
  pluginId: NonEmptyString,
  generation: Type.Optional(Count),
  acceptingCalls: Type.Boolean(),
  replacementPending: Type.Boolean(),
  disposing: Type.Boolean(),
  total: Count,
  omitted: Count,
  references: Type.Array(
    closedObject({
      referenceId: NonEmptyString,
      kind: Type.Union([
        Type.Literal("work"),
        Type.Literal("consumer"),
        Type.Literal("custody"),
        Type.Literal("call"),
        Type.Literal("cleanup"),
      ]),
      reason: Type.Union([
        Type.Literal("unknown"),
        Type.Literal("registry-construction"),
        Type.Literal("prepared-construction"),
        Type.Literal("prepared-generation-lease"),
        Type.Literal("invocation-scope"),
        Type.Literal("service-start"),
        Type.Literal("consumer"),
        Type.Literal("call"),
        Type.Literal("cleanup"),
      ]),
      acquiredAtMs: Type.Number(),
      ageMs: Type.Number({ minimum: 0 }),
      owner: Type.Union([
        Type.Literal("unknown"),
        closedObject({
          agentId: Type.Optional(OwnerId),
          sessionKey: Type.Optional(OwnerId),
          runId: Type.Optional(OwnerId),
          serviceId: Type.Optional(OwnerId),
        }),
      ]),
      parentReferenceId: Type.Optional(NonEmptyString),
      cleanupState: Type.Union([
        Type.Literal("active"),
        Type.Literal("pending"),
        Type.Literal("failed"),
      ]),
    }),
    { maxItems: 64 },
  ),
});
