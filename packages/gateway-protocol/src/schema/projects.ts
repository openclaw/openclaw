// Gateway Protocol schema module for project workspaces.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const ProjectStatusSchema = Type.Union([Type.Literal("active"), Type.Literal("archived")]);
export const ProjectChatStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("archived"),
]);
export const ProjectRoleStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("archived"),
]);
export const ProjectDocumentStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("archived"),
]);
export const ProjectDocumentSummaryDiagnosticStatusSchema = Type.Union([
  Type.Literal("summarized"),
  Type.Literal("eligible"),
  Type.Literal("not_needed"),
  Type.Literal("unsupported"),
  Type.Literal("remote"),
  Type.Literal("missing"),
  Type.Literal("unreadable"),
]);
export const ProjectDocumentSummaryCacheStatusSchema = Type.Union([
  Type.Literal("hit"),
  Type.Literal("missing"),
  Type.Literal("stale"),
  Type.Literal("not_applicable"),
]);
export const ProjectDocumentSummaryUriKindSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("local"),
  Type.Literal("file"),
  Type.Literal("obsidian"),
  Type.Literal("remote"),
]);

const ProjectMetadataSchema = Type.Record(Type.String(), Type.Unknown());

export const ProjectSummarySchema = Type.Object(
  {
    projectId: NonEmptyString,
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    status: ProjectStatusSchema,
    createdAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
    archivedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    color: Type.Optional(Type.String()),
    icon: Type.Optional(Type.String()),
    sortOrder: Type.Integer(),
    defaultRoleKey: Type.Optional(Type.String()),
    metadata: Type.Optional(ProjectMetadataSchema),
  },
  { additionalProperties: false },
);

export const ProjectChatSummarySchema = Type.Object(
  {
    projectId: NonEmptyString,
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    title: Type.Optional(Type.String()),
    role: Type.Optional(Type.String()),
    status: ProjectChatStatusSchema,
    sortOrder: Type.Integer(),
    createdAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
    archivedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    metadata: Type.Optional(ProjectMetadataSchema),
  },
  { additionalProperties: false },
);

export const ProjectContextSchema = Type.Object(
  {
    projectId: NonEmptyString,
    summary: Type.Optional(Type.String()),
    instructions: Type.Optional(Type.String()),
    decisions: Type.Array(Type.String()),
    documents: Type.Array(Type.String()),
    updatedAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ProjectRoleSummarySchema = Type.Object(
  {
    projectId: NonEmptyString,
    roleKey: NonEmptyString,
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    instructions: Type.Optional(Type.String()),
    status: ProjectRoleStatusSchema,
    sortOrder: Type.Integer(),
    createdAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
    archivedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    metadata: Type.Optional(ProjectMetadataSchema),
  },
  { additionalProperties: false },
);

export const ProjectDocumentSummarySchema = Type.Object(
  {
    projectId: NonEmptyString,
    documentId: NonEmptyString,
    title: NonEmptyString,
    uri: Type.Optional(Type.String()),
    kind: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
    includeInContext: Type.Boolean(),
    status: ProjectDocumentStatusSchema,
    sortOrder: Type.Integer(),
    createdAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
    archivedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    metadata: Type.Optional(ProjectMetadataSchema),
    summaryDiagnostic: Type.Optional(
      Type.Object(
        {
          status: ProjectDocumentSummaryDiagnosticStatusSchema,
          label: Type.String(),
          reason: Type.String(),
          uriKind: ProjectDocumentSummaryUriKindSchema,
          cache: ProjectDocumentSummaryCacheStatusSchema,
          injectsSummary: Type.Boolean(),
          filePath: Type.Optional(Type.String()),
          extension: Type.Optional(Type.String()),
          sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
          mtimeMs: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const ProjectDetailSchema = Type.Intersect([
  ProjectSummarySchema,
  Type.Object({ context: Type.Optional(ProjectContextSchema) }, { additionalProperties: false }),
]);

export const ProjectsListParamsSchema = Type.Object(
  {
    includeArchived: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);

export const ProjectsListResultSchema = Type.Object(
  {
    projects: Type.Array(ProjectSummarySchema),
  },
  { additionalProperties: false },
);

export const ProjectsGetParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsGetResultSchema = Type.Object(
  {
    project: ProjectDetailSchema,
  },
  { additionalProperties: false },
);

export const ProjectsMutationResultSchema = Type.Object(
  {
    project: ProjectSummarySchema,
  },
  { additionalProperties: false },
);

export const ProjectsCreateParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    color: Type.Optional(Type.String()),
    icon: Type.Optional(Type.String()),
    sortOrder: Type.Optional(Type.Integer()),
    metadata: Type.Optional(ProjectMetadataSchema),
  },
  { additionalProperties: false },
);

export const ProjectsPatchParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    color: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    icon: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sortOrder: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    defaultRoleKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    metadata: Type.Optional(Type.Union([ProjectMetadataSchema, Type.Null()])),
  },
  { additionalProperties: false },
);

export const ProjectsArchiveParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsRestoreParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsRolesListParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    includeArchived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ProjectsRolesListResultSchema = Type.Object(
  {
    roles: Type.Array(ProjectRoleSummarySchema),
  },
  { additionalProperties: false },
);

export const ProjectsRoleMutationResultSchema = Type.Object(
  {
    role: ProjectRoleSummarySchema,
  },
  { additionalProperties: false },
);

export const ProjectsRolesCreateParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    instructions: Type.Optional(Type.String()),
    sortOrder: Type.Optional(Type.Integer()),
    metadata: Type.Optional(ProjectMetadataSchema),
  },
  { additionalProperties: false },
);

export const ProjectsRolesPatchParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    roleKey: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    instructions: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sortOrder: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    metadata: Type.Optional(Type.Union([ProjectMetadataSchema, Type.Null()])),
  },
  { additionalProperties: false },
);

export const ProjectsRolesArchiveParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    roleKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsRolesRestoreParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    roleKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsDocumentsListParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    includeArchived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ProjectsDocumentsListResultSchema = Type.Object(
  {
    documents: Type.Array(ProjectDocumentSummarySchema),
  },
  { additionalProperties: false },
);

export const ProjectsDocumentMutationResultSchema = Type.Object(
  {
    document: ProjectDocumentSummarySchema,
  },
  { additionalProperties: false },
);

export const ProjectsDocumentsImportResultSchema = Type.Object(
  {
    documents: Type.Array(ProjectDocumentSummarySchema),
    importedCount: Type.Integer({ minimum: 0 }),
    skippedCount: Type.Integer({ minimum: 0 }),
    scannedCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ProjectsDocumentsCreateParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    title: NonEmptyString,
    uri: Type.Optional(Type.String()),
    kind: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
    includeInContext: Type.Optional(Type.Boolean()),
    sortOrder: Type.Optional(Type.Integer()),
    metadata: Type.Optional(ProjectMetadataSchema),
  },
  { additionalProperties: false },
);

export const ProjectsDocumentsImportParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    text: Type.Optional(Type.String()),
    roots: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
    recursive: Type.Optional(Type.Boolean()),
    maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
    includeInContext: Type.Optional(Type.Boolean()),
    kind: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ProjectsDocumentsPatchParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    documentId: NonEmptyString,
    title: Type.Optional(NonEmptyString),
    uri: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    kind: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    includeInContext: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    sortOrder: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    metadata: Type.Optional(Type.Union([ProjectMetadataSchema, Type.Null()])),
  },
  { additionalProperties: false },
);

export const ProjectsDocumentsArchiveParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    documentId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsDocumentsRestoreParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    documentId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsChatsListParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    includeArchived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ProjectsChatsListResultSchema = Type.Object(
  {
    chats: Type.Array(ProjectChatSummarySchema),
  },
  { additionalProperties: false },
);

export const ProjectsChatsResolveParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsChatsResolveResultSchema = Type.Object(
  {
    project: Type.Optional(ProjectSummarySchema),
    chat: Type.Optional(ProjectChatSummarySchema),
  },
  { additionalProperties: false },
);

export const ProjectsChatMutationResultSchema = Type.Object(
  {
    chat: ProjectChatSummarySchema,
  },
  { additionalProperties: false },
);

export const ProjectsChatsAttachParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    title: Type.Optional(Type.String()),
    role: Type.Optional(Type.String()),
    sortOrder: Type.Optional(Type.Integer()),
    metadata: Type.Optional(ProjectMetadataSchema),
  },
  { additionalProperties: false },
);

export const ProjectsChatsPatchParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    sessionKey: NonEmptyString,
    title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    role: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sortOrder: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    metadata: Type.Optional(Type.Union([ProjectMetadataSchema, Type.Null()])),
  },
  { additionalProperties: false },
);

export const ProjectsChatsArchiveParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsChatsRestoreParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsChatsDetachParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsContextGetParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsContextPatchParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    instructions: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    decisions: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
    documents: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  },
  { additionalProperties: false },
);

export const ProjectsContextResultSchema = Type.Object(
  {
    context: Type.Optional(ProjectContextSchema),
  },
  { additionalProperties: false },
);
