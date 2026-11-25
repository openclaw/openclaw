import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const SessionsStorageParamsSchema = closedObject({});

export const SessionsStorageStatusResultSchema = closedObject({
  agents: Type.Array(
    closedObject({
      agentId: NonEmptyString,
      storePath: NonEmptyString,
      hotTranscripts: Type.Integer({ minimum: 0 }),
      coldTranscripts: Type.Integer({ minimum: 0 }),
      databaseBytes: Type.Integer({ minimum: 0 }),
      walBytes: Type.Integer({ minimum: 0 }),
      archiveBytes: Type.Integer({ minimum: 0 }),
      embeddedArchiveBytes: Type.Integer({ minimum: 0 }),
    }),
  ),
  maintenance: closedObject({
    running: Type.Boolean(),
    lastStartedAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    lastCompletedAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    lastError: Type.Union([Type.String(), Type.Null()]),
    archivedTranscripts: Type.Integer({ minimum: 0 }),
    externalizedTranscripts: Type.Integer({ minimum: 0 }),
  }),
});

export type SessionsStorageStatusResult = Static<typeof SessionsStorageStatusResultSchema>;
