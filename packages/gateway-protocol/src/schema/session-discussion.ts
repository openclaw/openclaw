import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { stringLiteralUnion } from "./string-literal-union.js";

export const SessionDiscussionStateSchema = stringLiteralUnion(["none", "available", "open"]);

export const SessionDiscussionInfoSchema = closedObject({
  state: SessionDiscussionStateSchema,
  embedUrl: Type.Optional(Type.String()),
  openUrl: Type.Optional(Type.String()),
});

export const SessionDiscussionInfoParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
});

export const SessionDiscussionOpenParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
});

export const SessionDiscussionInfoResultSchema = SessionDiscussionInfoSchema;
export const SessionDiscussionOpenResultSchema = SessionDiscussionInfoSchema;

export type SessionDiscussionState = Static<typeof SessionDiscussionStateSchema>;
export type SessionDiscussionInfo = Static<typeof SessionDiscussionInfoSchema>;
export type SessionDiscussionInfoParams = Static<typeof SessionDiscussionInfoParamsSchema>;
export type SessionDiscussionOpenParams = Static<typeof SessionDiscussionOpenParamsSchema>;
export type SessionDiscussionInfoResult = Static<typeof SessionDiscussionInfoResultSchema>;
export type SessionDiscussionOpenResult = Static<typeof SessionDiscussionOpenResultSchema>;
