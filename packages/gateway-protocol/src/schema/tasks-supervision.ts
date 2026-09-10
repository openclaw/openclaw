import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
const id = Type.String({ minLength: 1, maxLength: 128 });
const text = Type.String({ minLength: 1, maxLength: 4096 });
const timestamp = Type.Integer({ minimum: 0 });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const phase = Type.Union([
  Type.Literal("ready"),
  Type.Literal("waiting"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("partial"),
  Type.Literal("input_required"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("quarantined"),
]);
const policy = closedObject({
  deadlineAt: timestamp,
  maxAttempts: Type.Integer({ minimum: 1, maximum: 100 }),
  attemptTimeoutMs: Type.Integer({ minimum: 1000, maximum: 3600000 }),
});
export const SupervisionControlParamsSchema = closedObject({
  flowId: id,
  episode: Type.Integer({ minimum: 1 }),
  revision: timestamp,
  inputId: id,
  action: Type.Union([
    closedObject({ kind: Type.Literal("cancel") }),
    closedObject({ kind: Type.Literal("steer"), input: text }),
    closedObject({ kind: Type.Literal("resume"), input: text, policy }),
    closedObject({
      kind: Type.Literal("approve"),
      sourceHash: hash,
      criterionIds: Type.Array(id, { minItems: 1, maxItems: 32 }),
    }),
  ]),
});
export const SupervisionGetParamsSchema = closedObject({ flowId: id });
export const SupervisionListParamsSchema = closedObject({
  agentId: id,
  sessionKey: Type.String({ minLength: 1, maxLength: 2048 }),
  after: Type.Optional(id),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
/** Outcome, current custody, and delivery are independent observations. */
export const SupervisionSummarySchema = closedObject({
  flowId: id,
  episode: Type.Integer({ minimum: 1 }),
  revision: timestamp,
  agentId: id,
  runtime: Type.Optional(Type.Union([Type.Literal("codex"), Type.Literal("claude-cli")])),
  phase,
  continuation: Type.Union([
    Type.Literal("armed"),
    Type.Literal("unknown"),
    Type.Literal("stopped"),
  ]),
  observedAt: timestamp,
  supervisorExpiresAt: Type.Union([timestamp, Type.Null()]),
  operatorRequired: Type.Boolean(),
  title: Type.String({ maxLength: 4096 }),
  attempts: timestamp,
  maxAttempts: timestamp,
  deadlineAt: timestamp,
  endpoint: Type.Optional(
    closedObject({
      reason: text,
      question: Type.Optional(text),
      effects: Type.Union([
        Type.Literal("attempt_completed"),
        Type.Literal("unknown"),
        Type.Literal("not_dispatched"),
      ]),
    }),
  ),
  artifact: Type.Optional(closedObject({ versionId: id, sourceHash: hash })),
  operatorCriteria: Type.Array(closedObject({ criterionId: id, accepted: Type.Boolean() }), {
    maxItems: 32,
  }),
  operations: Type.Array(
    closedObject({
      id,
      kind: Type.String({ maxLength: 32 }),
      state: Type.String({ maxLength: 32 }),
    }),
    { maxItems: 256 },
  ),
  notifications: Type.Array(
    closedObject({
      id: Type.String({ maxLength: 512 }),
      episode: timestamp,
      state: Type.Union([
        Type.Literal("pending"),
        Type.Literal("queued"),
        Type.Literal("delivered"),
        Type.Literal("suppressed"),
        Type.Literal("failed"),
        Type.Literal("unknown"),
      ]),
      updatedAt: timestamp,
    }),
    { maxItems: 32 },
  ),
});
export const SupervisionGetResultSchema = closedObject({ task: SupervisionSummarySchema });
/** The acknowledgement is immutable across input replay. The separately named
 * currentTask is a fresh observation, not the state produced by that control. */
export const SupervisionControlResultSchema = closedObject({
  acknowledgement: closedObject({
    flowId: id,
    episode: Type.Integer({ minimum: 1 }),
    revision: timestamp,
    phase: Type.Union([
      Type.Literal("ready"),
      Type.Literal("waiting"),
      Type.Literal("running"),
      Type.Literal("succeeded"),
      Type.Literal("partial"),
      Type.Literal("input_required"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
  }),
  currentTask: SupervisionSummarySchema,
});
export const SupervisionListResultSchema = closedObject({
  tasks: Type.Array(SupervisionSummarySchema, { maxItems: 100 }),
  next: Type.Optional(id),
});
export type SupervisionSummary = Static<typeof SupervisionSummarySchema>;
export type SupervisionControlParams = Static<typeof SupervisionControlParamsSchema>;
export type SupervisionGetParams = Static<typeof SupervisionGetParamsSchema>;
export type SupervisionListParams = Static<typeof SupervisionListParamsSchema>;
export type SupervisionGetResult = Static<typeof SupervisionGetResultSchema>;
export type SupervisionControlResult = Static<typeof SupervisionControlResultSchema>;
export type SupervisionListResult = Static<typeof SupervisionListResultSchema>;

export const SupervisionArtifactParamsSchema = closedObject({
  flowId: id,
  versionId: id,
  sourceHash: hash,
  after: Type.Optional(text),
  path: Type.Optional(text),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 8388608 })),
});
export const SupervisionArtifactResultSchema = closedObject({
  versionId: id,
  sourceHash: hash,
  files: Type.Array(
    closedObject({
      path: text,
      sha256: hash,
      bytes: Type.Integer({ minimum: 0, maximum: 8388608 }),
      executable: Type.Boolean(),
    }),
    { maxItems: 256 },
  ),
  next: Type.Optional(text),
  file: Type.Optional(
    closedObject({
      path: text,
      sha256: hash,
      bytes: Type.Integer({ minimum: 0, maximum: 8388608 }),
      offset: Type.Integer({ minimum: 0, maximum: 8388608 }),
      base64: Type.String({ maxLength: 87384 }),
      nextOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 8388608 })),
    }),
  ),
});
export type SupervisionArtifactParams = Static<typeof SupervisionArtifactParamsSchema>;
export type SupervisionArtifactResult = Static<typeof SupervisionArtifactResultSchema>;
