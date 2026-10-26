import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { closedObject } from "./schema/closed-object.js";
import { NonEmptyString } from "./schema/primitives.js";
import { SessionPermissionModeSchema } from "./schema/sessions-row.js";

/** A selection refusal, not permission to change the session's execution policy. */
export const AgentRuntimeRestrictionErrorDetailsSchema = closedObject({
  code: Type.Literal("AGENT_RUNTIME_RESTRICTED"),
  runtimeId: NonEmptyString,
  runtimeLabel: NonEmptyString,
  reason: Type.Union([
    Type.Literal("sandbox-required"),
    Type.Literal("sandbox"),
    Type.Literal("workspace-only"),
    Type.Literal("permission-mode"),
    Type.Literal("remote-execution"),
    Type.Literal("tool-policy"),
  ]),
  recovery: Type.Optional(
    closedObject({
      action: Type.Literal("use-native-permissions"),
      sessionId: NonEmptyString,
      lifecycleRevision: Type.Optional(NonEmptyString),
      expectedPermissionMode: Type.Union([SessionPermissionModeSchema, Type.Null()]),
      expectedSandboxMode: Type.Union([Type.Literal("off"), Type.Null()]),
      expectedNativeRuntimeConsent: Type.Union([NonEmptyString, Type.Null()]),
    }),
  ),
});

export type AgentRuntimeRestrictionErrorDetails = Static<
  typeof AgentRuntimeRestrictionErrorDetailsSchema
>;

export function readAgentRuntimeRestrictionErrorDetails(
  value: unknown,
): AgentRuntimeRestrictionErrorDetails | undefined {
  return Value.Check(AgentRuntimeRestrictionErrorDetailsSchema, value) ? value : undefined;
}
