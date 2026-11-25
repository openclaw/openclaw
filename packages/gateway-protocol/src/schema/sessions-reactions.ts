import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { SessionSharingIdentitySchema } from "./sessions-sharing.js";
import { stringLiteralUnion } from "./string-literal-union.js";

const SessionReactionTargetParamsSchema = {
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
};

const ReactionEmojiSchema = Type.String({ minLength: 1, maxLength: 32 });

export { isReactionEmoji } from "../reaction-emoji.js";

export const MessageReactionSummarySchema = closedObject({
  emoji: ReactionEmojiSchema,
  count: Type.Integer({ minimum: 1 }),
  identities: Type.Array(
    closedObject({
      id: NonEmptyString,
      label: Type.Optional(Type.String()),
    }),
    { minItems: 1 },
  ),
});

export const SessionReactionMirrorSchema = closedObject({
  status: stringLiteralUnion(["delivered", "failed", "skipped"]),
  reason: Type.Optional(Type.String()),
});

export const SessionReactionsSetParamsSchema = closedObject({
  ...SessionReactionTargetParamsSchema,
  messageId: NonEmptyString,
  emoji: ReactionEmojiSchema,
  remove: Type.Optional(Type.Boolean()),
});

export const SessionReactionsListParamsSchema = closedObject(SessionReactionTargetParamsSchema);

export const SessionReactionsSetResultSchema = closedObject({
  messageId: NonEmptyString,
  reactions: Type.Array(MessageReactionSummarySchema),
  mirror: Type.Optional(SessionReactionMirrorSchema),
});

export const SessionReactionsListResultSchema = closedObject({
  sessionId: NonEmptyString,
  reactions: Type.Record(NonEmptyString, Type.Array(MessageReactionSummarySchema)),
});

export const SessionReactionEventSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: NonEmptyString,
  sessionId: NonEmptyString,
  messageId: NonEmptyString,
  emoji: ReactionEmojiSchema,
  action: stringLiteralUnion(["added", "removed"]),
  actor: SessionSharingIdentitySchema,
  reactions: Type.Array(MessageReactionSummarySchema),
});

export type MessageReactionSummary = Static<typeof MessageReactionSummarySchema>;
export type SessionReactionMirror = Static<typeof SessionReactionMirrorSchema>;
export type SessionReactionsSetParams = Static<typeof SessionReactionsSetParamsSchema>;
export type SessionReactionsListParams = Static<typeof SessionReactionsListParamsSchema>;
export type SessionReactionsSetResult = Static<typeof SessionReactionsSetResultSchema>;
export type SessionReactionsListResult = Static<typeof SessionReactionsListResultSchema>;
export type SessionReactionEvent = Static<typeof SessionReactionEventSchema>;
