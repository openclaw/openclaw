import { type Static, Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { stringLiteralUnion } from "./string-literal-union.js";

const NonBlankString = Type.String({ minLength: 1, pattern: "\\S" });
export const CronModelImpactParamsSchema = closedObject({
  model: Type.Union([NonBlankString, Type.Null()]),
  agentId: Type.Optional(NonBlankString),
});
export const CronModelImpactSelectionSchema = closedObject({
  model: Type.Union([Type.String(), Type.Null()]),
  source: Type.Union([
    stringLiteralUnion(["default", "subagent", "agent", "hook", "payload", "session"]),
    Type.Null(),
  ]),
});
export const CronModelImpactIssueSchema = closedObject({
  code: NonBlankString,
  severity: stringLiteralUnion(["blocker", "warning", "info"]),
  message: NonBlankString,
  recovery: Type.Optional(NonBlankString),
});
export const CronModelImpactJobSchema = closedObject({
  id: NonBlankString,
  name: Type.String(),
  enabled: Type.Boolean(),
  effectiveAgentId: Type.Union([Type.String(), Type.Null()]),
  before: CronModelImpactSelectionSchema,
  after: CronModelImpactSelectionSchema,
  changed: Type.Boolean(),
  status: stringLiteralUnion(["blocked", "unknown", "no-known-blocker", "not-applicable"]),
  issues: Type.Array(CronModelImpactIssueSchema),
});
export const CronModelImpactResultSchema = closedObject({
  model: Type.Union([Type.String(), Type.Null()]),
  agentId: Type.Optional(NonBlankString),
  jobs: Type.Array(CronModelImpactJobSchema),
  issues: Type.Array(CronModelImpactIssueSchema),
});
export type CronModelImpactParams = Static<typeof CronModelImpactParamsSchema>;
export type CronModelImpactSelection = Static<typeof CronModelImpactSelectionSchema>;
export type CronModelImpactIssue = Static<typeof CronModelImpactIssueSchema>;
export type CronModelImpactJob = Static<typeof CronModelImpactJobSchema>;
export type CronModelImpactResult = Static<typeof CronModelImpactResultSchema>;
