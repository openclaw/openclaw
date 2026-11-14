import type { Static } from "typebox";
import { Type } from "typebox";
import { CANVAS_DOCUMENT_PREVIEW_MAX_BYTES } from "../canvas-limits.js";
import {
  SESSIONS_FILES_ASSETS_MAX_REFS,
  SESSIONS_FILES_ASSET_REF_MAX_CHARS,
} from "../session-limits.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { stringLiteralUnion } from "./string-literal-union.js";

/** Session file grouping used by the Control UI session workspace rail. */
export const SessionFileKindSchema = stringLiteralUnion(["modified", "read"]);

/** Session relevance marker for browser entries. */
export const SessionFileRelevanceSchema = stringLiteralUnion(["modified", "read", "mixed"]);

export const SessionFileContentEncodingSchema = stringLiteralUnion(["utf8", "base64"]);

export const SessionFilePreviewKindSchema = stringLiteralUnion(["text", "image", "unsupported"]);

const SessionFileHashSchema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-f0-9]{64}$",
});

/** One file path referenced by a session transcript. */
export const SessionFileEntrySchema = closedObject({
  path: NonEmptyString,
  workspacePath: Type.Optional(NonEmptyString),
  name: NonEmptyString,
  kind: SessionFileKindSchema,
  missing: Type.Boolean(),
  size: Type.Optional(Type.Integer({ minimum: 0 })),
  updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  content: Type.Optional(Type.String()),
  hash: Type.Optional(SessionFileHashSchema),
  mimeType: Type.Optional(NonEmptyString),
  contentEncoding: Type.Optional(SessionFileContentEncodingSchema),
  previewKind: Type.Optional(SessionFilePreviewKindSchema),
});

export const SessionFileBrowserEntrySchema = closedObject({
  path: Type.String(),
  name: NonEmptyString,
  kind: stringLiteralUnion(["file", "directory"]),
  sessionKind: Type.Optional(SessionFileRelevanceSchema),
  size: Type.Optional(Type.Integer({ minimum: 0 })),
  updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

/** Folder listing or search result rooted at the session workspace. */
export const SessionFileBrowserResultSchema = closedObject({
  path: Type.String(),
  parentPath: Type.Optional(Type.String()),
  search: Type.Optional(Type.String()),
  entries: Type.Array(SessionFileBrowserEntrySchema),
  truncated: Type.Optional(Type.Boolean()),
});

/** Lists files touched by a session transcript. */
export const SessionsFilesListParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  path: Type.Optional(Type.String()),
  search: Type.Optional(Type.String()),
});

/** File references visible in one session workspace. */
export const SessionsFilesListResultSchema = closedObject({
  sessionKey: NonEmptyString,
  root: Type.Optional(NonEmptyString),
  /** Whether the session workspace directory is inside a git checkout; absent when the workspace root is unknown or the gateway predates the field. */
  gitCheckout: Type.Optional(Type.Boolean()),
  files: Type.Array(SessionFileEntrySchema),
  browser: Type.Optional(SessionFileBrowserResultSchema),
});

/** Reads one session-referenced file by path. */
const sessionFilePathProperties = {
  sessionKey: NonEmptyString,
  path: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
};
export const SessionsFilesGetParamsSchema = closedObject({
  ...sessionFilePathProperties,
  messageEntryId: Type.Optional(NonEmptyString),
});

const SessionFileSourceSchema = closedObject({
  workspaceId: NonEmptyString,
  root: Type.Union([NonEmptyString, Type.Null()]),
  fileRoot: Type.Union([NonEmptyString, Type.Null()]),
});

export const SessionsFilesGetResultSchema = closedObject({
  sessionKey: NonEmptyString,
  source: Type.Optional(SessionFileSourceSchema),
  root: Type.Optional(NonEmptyString),
  file: SessionFileEntrySchema,
});

/** Original bytes use a connection-bound HTTP grant, independent of preview limits. */
export const SessionsFilesDownloadParamsSchema = closedObject(
  SessionsFilesGetParamsSchema.properties,
);
export const SessionsFilesDownloadResultSchema = closedObject({
  filename: NonEmptyString,
  mimeType: NonEmptyString,
  url: NonEmptyString,
  expiresAt: NonEmptyString,
});

export { SESSIONS_FILES_ASSETS_MAX_REFS } from "../session-limits.js";
export const SESSIONS_FILES_ASSET_MAX_BYTES = 1024 * 1024;
export const SESSIONS_FILES_ASSETS_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

const sessionFileAssetRefSchema = Type.String({
  minLength: 1,
  maxLength: SESSIONS_FILES_ASSET_REF_MAX_CHARS,
});

/** Reads relative HTML resources under the session's current file-read authority. */
export const SessionsFilesAssetsParamsSchema = closedObject({
  ...SessionsFilesGetParamsSchema.properties,
  refs: Type.Array(sessionFileAssetRefSchema, { maxItems: SESSIONS_FILES_ASSETS_MAX_REFS }),
});

export const SessionsFilesAssetsResultSchema = closedObject({
  assets: Type.Array(
    Type.Union([
      closedObject({
        ref: sessionFileAssetRefSchema,
        mimeType: NonEmptyString,
        content: Type.String(),
      }),
      closedObject({
        ref: sessionFileAssetRefSchema,
        error: stringLiteralUnion([
          "not_found",
          "too_large",
          "outside_session_boundary",
          "unsupported",
        ]),
      }),
    ]),
    { maxItems: SESSIONS_FILES_ASSETS_MAX_REFS },
  ),
});

/** A bounded authored-CSP preview; resources retain the issuing reader's authority. */
export const SessionsFilesPreviewParamsSchema = closedObject({
  ...SessionsFilesGetParamsSchema.properties,
  html: Type.String({ maxLength: CANVAS_DOCUMENT_PREVIEW_MAX_BYTES }),
  allowScripts: Type.Optional(Type.Boolean()),
});
export const SessionsFilesPreviewResultSchema = closedObject({
  status: stringLiteralUnion(["ready", "unsupported"]),
  html: Type.String(),
  omitted: Type.Integer({ minimum: 0 }),
  previewId: Type.Optional(NonEmptyString),
  sandboxPath: Type.Optional(NonEmptyString),
  sandboxOrigin: Type.Optional(Type.String()),
});
export const SessionsFilesPreviewReleaseParamsSchema = closedObject({
  ...SessionsFilesGetParamsSchema.properties,
  previewId: Type.String({ minLength: 1, maxLength: 256 }),
});
export const SessionsFilesPreviewReleaseResultSchema = closedObject({
  released: Type.Boolean(),
});

/** Overwrites an existing file with content and optional managed-source preconditions. */
export const SessionsFilesSetParamsSchema = closedObject({
  ...sessionFilePathProperties,
  expectedSource: Type.Optional(SessionFileSourceSchema),
  content: Type.String(),
  expectedHash: SessionFileHashSchema,
});

export const SessionsFilesSetResultSchema = closedObject(SessionsFilesGetResultSchema.properties);

/** Opens a session workspace on the Gateway host without accepting a client path. */
export const SessionsFilesRevealParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
});

export const SessionsFilesRevealResultSchema = closedObject({
  ok: Type.Boolean(),
  path: Type.Optional(NonEmptyString),
  error: Type.Optional(NonEmptyString),
});

export type SessionFileContentEncoding = Static<typeof SessionFileContentEncodingSchema>;
export type SessionFileKind = Static<typeof SessionFileKindSchema>;
export type SessionFilePreviewKind = Static<typeof SessionFilePreviewKindSchema>;
export type SessionFileRelevance = Static<typeof SessionFileRelevanceSchema>;
export type SessionFileEntry = Static<typeof SessionFileEntrySchema>;
export type SessionFileBrowserEntry = Static<typeof SessionFileBrowserEntrySchema>;
export type SessionFileBrowserResult = Static<typeof SessionFileBrowserResultSchema>;
export type SessionsFilesListParams = Static<typeof SessionsFilesListParamsSchema>;
export type SessionsFilesListResult = Static<typeof SessionsFilesListResultSchema>;
export type SessionsFilesGetParams = Static<typeof SessionsFilesGetParamsSchema>;
export type SessionsFilesDownloadParams = Static<typeof SessionsFilesDownloadParamsSchema>;
export type SessionsFilesDownloadResult = Static<typeof SessionsFilesDownloadResultSchema>;
export type SessionsFilesGetResult = Static<typeof SessionsFilesGetResultSchema>;
export type SessionsFilesAssetsParams = Static<typeof SessionsFilesAssetsParamsSchema>;
export type SessionsFilesAssetsResult = Static<typeof SessionsFilesAssetsResultSchema>;
export type SessionsFilesPreviewParams = Static<typeof SessionsFilesPreviewParamsSchema>;
export type SessionsFilesPreviewResult = Static<typeof SessionsFilesPreviewResultSchema>;
export type SessionsFilesPreviewReleaseParams = Static<
  typeof SessionsFilesPreviewReleaseParamsSchema
>;
export type SessionsFilesPreviewReleaseResult = Static<
  typeof SessionsFilesPreviewReleaseResultSchema
>;
export type SessionsFilesSetParams = Static<typeof SessionsFilesSetParamsSchema>;
export type SessionsFilesSetResult = Static<typeof SessionsFilesSetResultSchema>;
export type SessionsFilesRevealParams = Static<typeof SessionsFilesRevealParamsSchema>;
export type SessionsFilesRevealResult = Static<typeof SessionsFilesRevealResultSchema>;
