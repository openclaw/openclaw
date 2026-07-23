// Gateway Protocol schema module defines secret-safe Claw lifecycle inventory payloads.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const ClawLifecycleStateSchema = Type.Union([
  Type.Literal("present"),
  Type.Literal("unchanged"),
  Type.Literal("complete"),
  Type.Literal("modified"),
  Type.Literal("missing"),
  Type.Literal("unsafe"),
  Type.Literal("ambiguous"),
  Type.Literal("incomplete"),
  Type.Literal("pending"),
  Type.Literal("failed"),
  Type.Literal("removed"),
]);

const ClawRelationshipSchema = Type.Union([Type.Literal("managed"), Type.Literal("referenced")]);

const ClawOriginSchema = Type.Union([
  Type.Literal("claw-introduced"),
  Type.Literal("pre-existing"),
]);

export const ClawsStatusParamsSchema = closedObject({
  target: Type.Optional(NonEmptyString),
});

export const ClawsDoctorParamsSchema = closedObject({});

export const ClawResourceStatusSchema = closedObject({
  kind: Type.Union([
    Type.Literal("agent"),
    Type.Literal("workspace-file"),
    Type.Literal("skill"),
    Type.Literal("plugin"),
    Type.Literal("mcp-server"),
    Type.Literal("cron-job"),
  ]),
  id: NonEmptyString,
  state: ClawLifecycleStateSchema,
  relationship: Type.Optional(ClawRelationshipSchema),
  origin: Type.Optional(ClawOriginSchema),
  independentOwner: Type.Optional(Type.Boolean()),
});

export const ClawStatusEntrySchema = closedObject({
  agentId: NonEmptyString,
  name: NonEmptyString,
  version: NonEmptyString,
  sourceKind: Type.Union([Type.Literal("package"), Type.Literal("development")]),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("workspace_ready"),
    Type.Literal("config_committed"),
    Type.Literal("complete"),
    Type.Literal("partial"),
  ]),
  agentState: Type.Union([
    Type.Literal("present"),
    Type.Literal("modified"),
    Type.Literal("missing"),
  ]),
  orphaned: Type.Boolean(),
  addedAtMs: Type.Integer({ minimum: 0 }),
  updatedAtMs: Type.Integer({ minimum: 0 }),
  resources: Type.Array(ClawResourceStatusSchema),
});

export const ClawsStatusResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsGatewayStatus.v1"),
  records: Type.Array(ClawStatusEntrySchema),
  summary: closedObject({
    claws: Type.Integer({ minimum: 0 }),
    healthy: Type.Integer({ minimum: 0 }),
    attention: Type.Integer({ minimum: 0 }),
    managed: Type.Integer({ minimum: 0 }),
    referenced: Type.Integer({ minimum: 0 }),
  }),
});

export const ClawDoctorFindingSchema = closedObject({
  severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
  message: NonEmptyString,
  path: Type.Optional(NonEmptyString),
  requirement: Type.Optional(NonEmptyString),
  fixHint: Type.Optional(NonEmptyString),
});

export const ClawsDoctorResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsGatewayDoctor.v1"),
  findings: Type.Array(ClawDoctorFindingSchema),
  summary: closedObject({
    info: Type.Integer({ minimum: 0 }),
    warnings: Type.Integer({ minimum: 0 }),
    errors: Type.Integer({ minimum: 0 }),
  }),
});

export type ClawsStatusParams = Static<typeof ClawsStatusParamsSchema>;
export type ClawsDoctorParams = Static<typeof ClawsDoctorParamsSchema>;
export type ClawResourceStatus = Static<typeof ClawResourceStatusSchema>;
export type ClawStatusEntry = Static<typeof ClawStatusEntrySchema>;
export type ClawsStatusResult = Static<typeof ClawsStatusResultSchema>;
export type ClawDoctorFinding = Static<typeof ClawDoctorFindingSchema>;
export type ClawsDoctorResult = Static<typeof ClawsDoctorResultSchema>;
