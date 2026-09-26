import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Live, metadata-only notification; no transcript or provider error crosses this boundary. */
export const SessionRunCompletedEventSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: NonEmptyString,
  runId: NonEmptyString,
  status: Type.Union([
    Type.Literal("ok"),
    Type.Literal("error"),
    Type.Literal("timeout"),
    Type.Literal("aborted"),
  ]),
});
export type SessionRunCompletedEvent = Static<typeof SessionRunCompletedEventSchema>;
