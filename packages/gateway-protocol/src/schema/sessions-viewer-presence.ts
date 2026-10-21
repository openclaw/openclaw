import type { Static } from "typebox";
import { Type } from "typebox";
import { SESSION_VIEWER_PRESENCE_MAX_KEYS } from "../session-limits.js";
import { closedObject } from "./closed-object.js";
import { ChatSendSessionKeyString, NonEmptyString } from "./primitives.js";

export { SESSION_VIEWER_PRESENCE_MAX_KEYS } from "../session-limits.js";

/** Replaces the sessions this connection is currently rendering. */
export const SessionsViewerPresenceSetParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  sessionKeys: Type.Array(ChatSendSessionKeyString, {
    maxItems: SESSION_VIEWER_PRESENCE_MAX_KEYS,
  }),
});

/** Canonical session keys retained for this connection's viewer presence. */
export const SessionsViewerPresenceSetResultSchema = closedObject({
  sessionKeys: Type.Array(ChatSendSessionKeyString, {
    maxItems: SESSION_VIEWER_PRESENCE_MAX_KEYS,
  }),
});

export type SessionsViewerPresenceSetParams = Static<typeof SessionsViewerPresenceSetParamsSchema>;
export type SessionsViewerPresenceSetResult = Static<typeof SessionsViewerPresenceSetResultSchema>;
