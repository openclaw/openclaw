import type { Static } from "typebox";
import { Type } from "typebox";
import {
  FILE_REFERENCE_MAX_CANDIDATES,
  FILE_REFERENCE_MAX_QUERY_BYTES,
  FILE_REFERENCE_NAMESPACE,
  FILE_REFERENCE_PROVIDER,
} from "../file-reference-limits.js";
import { closedObject } from "./closed-object.js";

const identityString = Type.String({ minLength: 1, maxLength: 256 });
const referenceIdentity = {
  schemaVersion: Type.Literal(1),
  namespace: Type.Literal(FILE_REFERENCE_NAMESPACE),
  providerId: Type.Literal(FILE_REFERENCE_PROVIDER),
  accountId: identityString,
  workspaceId: identityString,
  rootLabel: Type.String({ minLength: 1, maxLength: 2048 }),
  authorizationRevision: identityString,
  resolverRevision: identityString,
  leaseExpiresAt: Type.Integer({ minimum: 0 }),
};

export const FileReferenceCapabilitySchema = closedObject({
  ...referenceIdentity,
  leaseId: identityString,
});

export const FileReferenceSchema = closedObject({
  ...referenceIdentity,
  objectId: identityString,
  relativePath: Type.String({ minLength: 1, maxLength: 2048 }),
  displayLabel: Type.String({ minLength: 1, maxLength: 2048 }),
});

export const FileReferenceContextSchema = closedObject({
  captureId: identityString,
  generation: Type.Integer({ minimum: 0 }),
  transcriptRevision: Type.Integer({ minimum: 0 }),
  targetId: identityString,
  draftRevision: Type.Integer({ minimum: 0 }),
});

const request = {
  schemaVersion: Type.Literal(1),
  sessionKey: Type.String({ minLength: 1, maxLength: 1024 }),
  agentId: Type.Optional(identityString),
  context: FileReferenceContextSchema,
};

export const SessionsFilesReferencesParamsSchema = Type.Union([
  closedObject({ ...request, action: Type.Literal("capabilities") }),
  closedObject({
    ...request,
    action: Type.Literal("search"),
    leaseId: identityString,
    query: Type.String({ minLength: 1, maxLength: FILE_REFERENCE_MAX_QUERY_BYTES }),
    cursor: Type.Optional(identityString),
  }),
  closedObject({
    ...request,
    action: Type.Literal("revalidate"),
    leaseId: identityString,
    objectId: identityString,
  }),
  closedObject({ ...request, action: Type.Literal("release"), leaseId: identityString }),
]);

export const FileReferenceResultSchema = Type.Union([
  closedObject({ status: Type.Literal("ready"), capability: FileReferenceCapabilitySchema }),
  closedObject({
    status: Type.Literal("matches"),
    capability: FileReferenceCapabilitySchema,
    candidates: Type.Array(
      closedObject({
        reference: FileReferenceSchema,
        match: Type.Union([Type.Literal("path"), Type.Literal("name"), Type.Literal("spoken")]),
      }),
      { maxItems: FILE_REFERENCE_MAX_CANDIDATES },
    ),
    nextCursor: Type.Optional(identityString),
    indexComplete: Type.Boolean(),
    scannedEntries: Type.Integer({ minimum: 0 }),
  }),
  closedObject({ status: Type.Literal("validated"), reference: FileReferenceSchema }),
  closedObject({
    status: Type.Union([
      Type.Literal("released"),
      Type.Literal("denied"),
      Type.Literal("unsupported"),
      Type.Literal("stale"),
      Type.Literal("expired"),
    ]),
  }),
]);

export type FileReference = Static<typeof FileReferenceSchema>;
export type FileReferenceCapability = Static<typeof FileReferenceCapabilitySchema>;
export type FileReferenceContext = Static<typeof FileReferenceContextSchema>;
export type FileReferenceResult = Static<typeof FileReferenceResultSchema>;
export type SessionsFilesReferencesParams = Static<typeof SessionsFilesReferencesParamsSchema>;
