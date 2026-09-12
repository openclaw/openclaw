import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Aborts the active or named run for a session. */
export const SessionsAbortParamsSchema = closedObject({
  key: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
  /** Also discard followup and lane queues for a key-only non-global session abort. */
  clearQueued: Type.Optional(Type.Boolean()),
});

/** Backward-compatible result for broad and exact session abort requests. */
export const SessionsAbortResultSchema = closedObject({
  ok: Type.Literal(true),
  abortedRunId: Type.Union([NonEmptyString, Type.Null()]),
  status: Type.Union([Type.Literal("aborted"), Type.Literal("no-active-run")]),
  runState: Type.Optional(
    Type.Union([Type.Literal("active"), Type.Literal("completed"), Type.Literal("unknown")]),
  ),
  terminalStatus: Type.Optional(
    Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("timeout")]),
  ),
});

export type SessionsAbortParams = Static<typeof SessionsAbortParamsSchema>;
export type SessionsAbortResult = Static<typeof SessionsAbortResultSchema>;
