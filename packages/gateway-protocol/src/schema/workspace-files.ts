// Schemas for the workspace file browser RPC (agents.files.browse).
// Reuses the same session-file types for directory entries to keep the protocol uniform.
import { Type, type Static } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

/** One entry in a workspace directory listing. */
export const WorkspaceFileBrowseEntrySchema = Type.Object(
  {
    name: Type.String(),
    path: Type.String(),
    kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
    size: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

/** Lists files/directories inside the agent workspace. */
export const AgentsFilesBrowseParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    path: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type WorkspaceFileBrowseEntry = Static<typeof WorkspaceFileBrowseEntrySchema>;
export type AgentsFilesBrowseParams = Static<typeof AgentsFilesBrowseParamsSchema>;

/** Result for agents.files.browse. */
export const AgentsFilesBrowseResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    path: Type.String(),
    entries: Type.Array(WorkspaceFileBrowseEntrySchema),
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export type AgentsFilesBrowseResult = Static<typeof AgentsFilesBrowseResultSchema>;