// Gateway protocol schemas for explicitly configured, read-only filesystem roots.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const FileRootSummarySchema = closedObject({
  id: NonEmptyString,
  label: NonEmptyString,
  available: Type.Boolean(),
});

export const FilesRootsListParamsSchema = closedObject({});
export const FilesRootsListResultSchema = closedObject({
  roots: Type.Array(FileRootSummarySchema),
});

export const FileRootEntrySchema = closedObject({
  path: NonEmptyString,
  name: NonEmptyString,
  kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
  size: Type.Optional(Type.Integer({ minimum: 0 })),
  updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

export const FilesRootListParamsSchema = closedObject({
  rootId: NonEmptyString,
  path: Type.Optional(Type.String()),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});
export const FilesRootListResultSchema = closedObject({
  rootId: NonEmptyString,
  path: Type.String(),
  parentPath: Type.Optional(Type.String()),
  entries: Type.Array(FileRootEntrySchema),
  totalEntries: Type.Integer({ minimum: 0 }),
  offset: Type.Integer({ minimum: 0 }),
});

export const FilesRootGetParamsSchema = closedObject({
  rootId: NonEmptyString,
  path: NonEmptyString,
});
export const FileRootFileSchema = closedObject({
  path: NonEmptyString,
  name: NonEmptyString,
  size: Type.Integer({ minimum: 0 }),
  updatedAtMs: Type.Integer({ minimum: 0 }),
  mimeType: NonEmptyString,
  encoding: Type.Union([Type.Literal("utf8"), Type.Literal("base64")]),
  content: Type.String(),
});
export const FilesRootGetResultSchema = closedObject({
  rootId: NonEmptyString,
  file: FileRootFileSchema,
});

export type FileRootSummary = Static<typeof FileRootSummarySchema>;
export type FileRootEntry = Static<typeof FileRootEntrySchema>;
export type FileRootFile = Static<typeof FileRootFileSchema>;
export type FilesRootsListParams = Static<typeof FilesRootsListParamsSchema>;
export type FilesRootsListResult = Static<typeof FilesRootsListResultSchema>;
export type FilesRootListParams = Static<typeof FilesRootListParamsSchema>;
export type FilesRootListResult = Static<typeof FilesRootListResultSchema>;
export type FilesRootGetParams = Static<typeof FilesRootGetParamsSchema>;
export type FilesRootGetResult = Static<typeof FilesRootGetResultSchema>;
