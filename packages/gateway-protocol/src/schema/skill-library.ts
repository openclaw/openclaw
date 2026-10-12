import type { Static } from "typebox";
import { Type } from "typebox";
import { lazyCompile } from "../protocol-validator.js";
import { closedObject } from "./closed-object.js";

export const SKILL_LIBRARY_MAX_FILES = 256;
export const SKILL_LIBRARY_MAX_FILE_BYTES = 1024 * 1024;
export const SKILL_LIBRARY_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
export const SKILL_LIBRARY_MAX_SELECTIONS = 64;
const id = Type.String({ pattern: "^[a-f0-9-]{36}$" });
const revision = Type.String({ pattern: "^[a-f0-9]{64}$" });
const slug = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,62}$" });
const sessionKey = Type.String({ minLength: 1, maxLength: 512 });

export const SkillLibraryFileSchema = closedObject({
  path: Type.String({ minLength: 1, maxLength: 512 }),
  content: Type.String({ maxLength: Math.ceil(SKILL_LIBRARY_MAX_FILE_BYTES / 3) * 4 }),
  encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
  executable: Type.Optional(Type.Boolean()),
});
export const SkillLibrarySelectionSchema = closedObject({
  skillId: id,
  revision,
  /** Persisted command identity: library collisions never shadow workspace names. */
  name: Type.String({ minLength: 1, maxLength: 128 }),
  ownerProfileId: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
});
export const SkillsLibraryListParamsSchema = closedObject({
  sessionKey: Type.Optional(sessionKey),
  scope: Type.Optional(
    Type.Union([Type.Literal("mine"), Type.Literal("team"), Type.Literal("all")]),
  ),
});
export const SkillsLibraryReadParamsSchema = closedObject({
  skillId: id,
  revision: Type.Optional(revision),
  sessionKey: Type.Optional(sessionKey),
});
export const SkillsLibrarySaveParamsSchema = closedObject({
  skillId: Type.Optional(id),
  expectedRevision: Type.Union([revision, Type.Null()]),
  slug,
  content: Type.String({ minLength: 1, maxLength: SKILL_LIBRARY_MAX_FILE_BYTES }),
  files: Type.Optional(
    Type.Array(SkillLibraryFileSchema, { maxItems: SKILL_LIBRARY_MAX_FILES - 1 }),
  ),
  /** Existing support files from this skill's exact expectedRevision; no uploaded bytes. */
  retainFiles: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
      maxItems: SKILL_LIBRARY_MAX_FILES - 1,
    }),
  ),
});
export const SkillsLibraryMutateParamsSchema = closedObject({
  skillId: id,
  expectedRevision: revision,
  action: Type.Union([
    Type.Literal("share"),
    Type.Literal("unshare"),
    Type.Literal("transfer"),
    Type.Literal("remove"),
    Type.Literal("enable"),
    Type.Literal("disable"),
    Type.Literal("rollback"),
  ]),
  revision: Type.Optional(revision),
});
export const SkillsLibraryActivateParamsSchema = closedObject({
  sessionKey,
  action: Type.Union([Type.Literal("attach"), Type.Literal("detach"), Type.Literal("refresh")]),
  skillId: Type.Optional(id),
  revision: Type.Optional(revision),
});
export const SkillsLibraryImportParamsSchema = closedObject({
  slug,
  source: closedObject({
    kind: Type.Literal("clawhub"),
    slug: Type.String({ minLength: 1, maxLength: 256 }),
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  }),
});
export const SkillsLibraryUploadParamsSchema = Type.Union([
  closedObject({
    action: Type.Literal("begin"),
    slug,
    sizeBytes: Type.Integer({ minimum: 1, maximum: SKILL_LIBRARY_MAX_BUNDLE_BYTES }),
    sha256: revision,
  }),
  closedObject({
    action: Type.Literal("chunk"),
    uploadId: id,
    offset: Type.Integer({ minimum: 0 }),
    data: Type.String({ maxLength: 350000 }),
  }),
  closedObject({ action: Type.Literal("commit"), uploadId: id }),
]);

export type SkillLibraryFile = Static<typeof SkillLibraryFileSchema>;
export type SkillLibrarySelection = Static<typeof SkillLibrarySelectionSchema>;
export type SkillsLibraryListParams = Static<typeof SkillsLibraryListParamsSchema>;
export type SkillsLibraryReadParams = Static<typeof SkillsLibraryReadParamsSchema>;
export type SkillsLibrarySaveParams = Static<typeof SkillsLibrarySaveParamsSchema>;
export type SkillsLibraryMutateParams = Static<typeof SkillsLibraryMutateParamsSchema>;
export type SkillsLibraryActivateParams = Static<typeof SkillsLibraryActivateParamsSchema>;
export type SkillsLibraryImportParams = Static<typeof SkillsLibraryImportParamsSchema>;
export type SkillsLibraryUploadParams = Static<typeof SkillsLibraryUploadParamsSchema>;

export type SkillLibraryEntry = {
  skillId: string;
  slug: string;
  name: string;
  description: string;
  ownerProfileId: string | null;
  ownerLabel: string;
  authorProfileId: string;
  shared: boolean;
  enabled: boolean;
  removed: boolean;
  revision: string;
  createdAt: number;
  updatedAt: number;
  canEdit: boolean;
};
export type SkillsLibraryListResult = {
  entries: SkillLibraryEntry[];
  profileId: string | null;
  multipleProfiles: boolean;
  defaultTarget: "workspace" | "personal" | "unavailable";
  canManageWorkspace: boolean;
  defaultSelectionLimit: number;
  defaultSelectionNotice?: string;
  session?: {
    sessionKey: string;
    selections: Array<
      SkillLibrarySelection & { slug: string; description: string; ownerLabel: string }
    >;
    attachable: SkillLibraryEntry[];
  };
};
export type SkillsLibraryReadResult = {
  entry: SkillLibraryEntry;
  content: string;
  files: SkillLibraryFile[];
  revisions: Array<{ revision: string; createdAt: number }>;
};
export type SkillsLibraryReceipt = {
  state: "published" | "unchanged" | "removed";
  target: "personal" | "team";
  entry: SkillLibraryEntry;
  sessionActivation: "new-sessions";
  nextAction: string;
};
export type SkillsLibraryActivateResult = {
  sessionKey: string;
  selections: SkillLibrarySelection[];
  sessionActivation: "next-turn";
};
export type SkillsLibraryUploadResult =
  | { uploadId: string; offset: number; maxChunkBytes: number }
  | SkillsLibraryReceipt;

export const validateSkillsLibraryListParams = lazyCompile(SkillsLibraryListParamsSchema);
export const validateSkillsLibraryReadParams = lazyCompile(SkillsLibraryReadParamsSchema);
export const validateSkillsLibrarySaveParams = lazyCompile(SkillsLibrarySaveParamsSchema);
export const validateSkillsLibraryMutateParams = lazyCompile(SkillsLibraryMutateParamsSchema);
export const validateSkillsLibraryActivateParams = lazyCompile(SkillsLibraryActivateParamsSchema);
export const validateSkillsLibraryImportParams = lazyCompile(SkillsLibraryImportParamsSchema);
export const validateSkillsLibraryUploadParams = lazyCompile(SkillsLibraryUploadParamsSchema);
