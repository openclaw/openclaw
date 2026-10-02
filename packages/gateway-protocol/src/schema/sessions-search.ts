import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { SessionsListParamsSchema } from "./sessions-list.js";
import { SessionRowSchema } from "./sessions-row.js";

/** Searches explicit agent keys, or the complete visible roster selected by scope. */
export const SessionsSearchParamsSchema = Object.assign(
  closedObject({
    agentId: Type.Optional(NonEmptyString),
    sessionKeys: Type.Optional(Type.Array(NonEmptyString, { minItems: 1, maxItems: 200 })),
    /** Search the complete visible roster selected by these membership filters. */
    scope: Type.Optional(
      closedObject(
        Type.Pick(SessionsListParamsSchema, [
          "activeMinutes",
          "activeOnly",
          "requireLastInteraction",
          "sortBy",
          "includeGlobal",
          "includeUnknown",
          "excludeSubagents",
          "excludeCron",
          "excludeSystem",
          "configuredAgentsOnly",
          "label",
          "projectId",
          "workspaceDir",
          "group",
          "pinned",
          "boardFace",
          "hasBoard",
          "creatorId",
          "ownerId",
          "involvingMe",
          "profileRelation",
          "involvingProfileId",
          "spawnedBy",
          "agentId",
          "search",
          "archived",
        ]).properties,
      ),
    ),
    query: Type.String({ minLength: 1, maxLength: 4096 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
  }),
  {
    not: {
      required: ["scope"],
      anyOf: [{ required: ["agentId"] }, { required: ["sessionKeys"] }],
    },
  },
);

/** One full-text session transcript match with follow-up provenance. */
export const SessionsSearchHitSchema = closedObject({
  sessionKey: NonEmptyString,
  sessionId: NonEmptyString,
  messageId: NonEmptyString,
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  timestamp: Type.Integer({ minimum: 0 }),
  snippet: Type.String(),
  score: Type.Number(),
});

/** Full-text search response; indexing marks a still-running first-use reconcile. */
export const SessionsSearchResultSchema = closedObject({
  results: Type.Array(SessionsSearchHitSchema),
  /** Scope searches include only the visible rows referenced by returned matches. */
  sessions: Type.Optional(Type.Array(SessionRowSchema, { maxItems: 25 })),
  indexing: Type.Optional(Type.Boolean()),
  archivedTranscriptsExcluded: Type.Optional(Type.Integer({ minimum: 0 })),
  truncated: Type.Optional(Type.Boolean()),
});

export type SessionsSearchParams = Static<typeof SessionsSearchParamsSchema>;
export type SessionsSearchHit = Static<typeof SessionsSearchHitSchema>;
export type SessionsSearchResult = Static<typeof SessionsSearchResultSchema>;
