import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const SESSION_PROCESSES_MAX_ROWS = 50;
export const SESSION_PROCESS_NAME_MAX_CHARS = 160;
export const SESSION_PROCESS_TAIL_MAX_CHARS = 2000;
export const SESSION_PROCESSES_MAX_BYTES = 48 * 1024;

/** An observation reference identifies one process incarnation, never grants access. */
export const SessionProcessSummarySchema = closedObject({
  processId: NonEmptyString,
  instanceId: NonEmptyString,
  name: Type.String({ maxLength: SESSION_PROCESS_NAME_MAX_CHARS }),
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("killed"),
  ]),
  startedAt: Type.Number(),
  endedAt: Type.Optional(Type.Number()),
  tail: Type.String({ maxLength: SESSION_PROCESS_TAIL_MAX_CHARS }),
  truncated: Type.Boolean(),
  canStop: Type.Boolean(),
  exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  exitSignal: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
  exitReason: Type.Optional(Type.String()),
});
export type SessionProcessSummary = Static<typeof SessionProcessSummarySchema>;

export const SessionsProcessesListParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
});
export type SessionsProcessesListParams = Static<typeof SessionsProcessesListParamsSchema>;

export const SessionsProcessesListResultSchema = closedObject({
  sessionId: NonEmptyString,
  processes: Type.Array(SessionProcessSummarySchema, { maxItems: SESSION_PROCESSES_MAX_ROWS }),
  truncated: Type.Boolean(),
});
export type SessionsProcessesListResult = Static<typeof SessionsProcessesListResultSchema>;

export const SessionsProcessesStopParamsSchema = closedObject({
  ...SessionsProcessesListParamsSchema.properties,
  sessionId: NonEmptyString,
  processId: NonEmptyString,
  instanceId: NonEmptyString,
});
export type SessionsProcessesStopParams = Static<typeof SessionsProcessesStopParamsSchema>;

export const SessionsProcessesStopResultSchema = closedObject({ requested: Type.Boolean() });
export type SessionsProcessesStopResult = Static<typeof SessionsProcessesStopResultSchema>;
