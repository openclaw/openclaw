// Gateway Protocol schemas for durable routines.
import { Type, type Static } from "typebox";
import {
  CronDeliverySchema,
  CronPayloadSchema,
  CronRunStatusSchema,
  CronScheduleSchema,
  CronSessionTargetSchema,
  CronWakeModeSchema,
} from "./cron.js";
import { NonEmptyString } from "./primitives.js";

const RoutineOwnerSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

const RoutineTargetSchema = Type.Object(
  {
    sessionTarget: CronSessionTargetSchema,
    wakeMode: CronWakeModeSchema,
    delivery: Type.Optional(CronDeliverySchema),
  },
  { additionalProperties: false },
);

const RoutineCreateTargetSchema = Type.Object(
  {
    sessionTarget: Type.Optional(CronSessionTargetSchema),
    wakeMode: Type.Optional(CronWakeModeSchema),
    delivery: Type.Optional(CronDeliverySchema),
  },
  { additionalProperties: false },
);

const RoutineScheduleTriggerCreateSchema = Type.Object(
  {
    kind: Type.Literal("schedule"),
    schedule: CronScheduleSchema,
  },
  { additionalProperties: false },
);

const RoutineScheduleTriggerSchema = Type.Object(
  {
    kind: Type.Literal("schedule"),
    schedule: CronScheduleSchema,
    cronJobId: NonEmptyString,
    cronStoreKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

const RoutineRuntimeStatusSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("enabled"),
      Type.Literal("disabled"),
      Type.Literal("running"),
      Type.Literal("missing"),
    ]),
    backing: Type.Union([Type.Literal("linked"), Type.Literal("missing")]),
    enabled: Type.Boolean(),
    cronJobId: Type.Optional(NonEmptyString),
    nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    runningAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunStatus: Type.Optional(CronRunStatusSchema),
    lastError: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const RoutineRecordFields = {
  id: NonEmptyString,
  name: NonEmptyString,
  description: Type.Optional(Type.String()),
  enabled: Type.Boolean(),
  owner: RoutineOwnerSchema,
  target: RoutineTargetSchema,
  trigger: RoutineScheduleTriggerSchema,
  action: CronPayloadSchema,
  createdAtMs: Type.Integer({ minimum: 0 }),
  updatedAtMs: Type.Integer({ minimum: 0 }),
};

export const RoutineRecordSchema = Type.Object(RoutineRecordFields, {
  additionalProperties: false,
});

export const RoutineViewSchema = Type.Object(
  {
    ...RoutineRecordFields,
    status: RoutineRuntimeStatusSchema,
  },
  { additionalProperties: false },
);

export const RoutinesCreateParamsSchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
    owner: Type.Optional(RoutineOwnerSchema),
    target: Type.Optional(RoutineCreateTargetSchema),
    trigger: RoutineScheduleTriggerCreateSchema,
    action: CronPayloadSchema,
  },
  { additionalProperties: false },
);

export const RoutinesListParamsSchema = Type.Object(
  {
    includeDisabled: Type.Optional(Type.Boolean()),
    agentId: Type.Optional(NonEmptyString),
    query: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const RoutinesGetParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

export const RoutinesSetEnabledParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

export const RoutinesDeleteParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

export const RoutinesListResultSchema = Type.Object(
  {
    routines: Type.Array(RoutineViewSchema),
  },
  { additionalProperties: false },
);

export const RoutinesGetResultSchema = Type.Object(
  {
    routine: Type.Union([RoutineViewSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const RoutinesCreateResultSchema = Type.Object(
  {
    routine: RoutineViewSchema,
    created: Type.Boolean(),
    idempotent: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const RoutinesSetEnabledResultSchema = Type.Object(
  {
    routine: RoutineViewSchema,
    changed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const RoutinesDeleteResultSchema = Type.Object(
  {
    id: NonEmptyString,
    deleted: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type RoutineRecord = Static<typeof RoutineRecordSchema>;
export type RoutineView = Static<typeof RoutineViewSchema>;
export type RoutinesCreateParams = Static<typeof RoutinesCreateParamsSchema>;
export type RoutinesListParams = Static<typeof RoutinesListParamsSchema>;
export type RoutinesGetParams = Static<typeof RoutinesGetParamsSchema>;
export type RoutinesSetEnabledParams = Static<typeof RoutinesSetEnabledParamsSchema>;
export type RoutinesDeleteParams = Static<typeof RoutinesDeleteParamsSchema>;
export type RoutinesListResult = Static<typeof RoutinesListResultSchema>;
export type RoutinesGetResult = Static<typeof RoutinesGetResultSchema>;
export type RoutinesCreateResult = Static<typeof RoutinesCreateResultSchema>;
export type RoutinesSetEnabledResult = Static<typeof RoutinesSetEnabledResultSchema>;
export type RoutinesDeleteResult = Static<typeof RoutinesDeleteResultSchema>;
