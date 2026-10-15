import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString, Sha256String } from "./primitives.js";

/** File metadata and optional content for agent-local editable files. */
export const AgentsFileEntrySchema = closedObject({
  name: NonEmptyString,
  path: NonEmptyString,
  missing: Type.Boolean(),
  // True when absence is a normal workspace state (optional profile files, and
  // MEMORY.md before anything is written). Editors should offer these for
  // creation rather than flagging them as faults.
  expectedAbsent: Type.Optional(Type.Boolean()),
  size: Type.Optional(Type.Integer({ minimum: 0 })),
  updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  hash: Type.Optional(Sha256String),
  content: Type.Optional(Type.String()),
});

/** Lists editable files for one agent. */
export const AgentsFilesListParamsSchema = closedObject({
  agentId: NonEmptyString,
});

/** Editable file list for an agent workspace. */
export const AgentsFilesListResultSchema = closedObject({
  agentId: NonEmptyString,
  workspace: NonEmptyString,
  files: Type.Array(AgentsFileEntrySchema),
});

/** Reads one editable agent file by name. */
export const AgentsFilesGetParamsSchema = closedObject({
  agentId: NonEmptyString,
  name: NonEmptyString,
});

/** Result for reading one editable agent file. */
export const AgentsFilesGetResultSchema = closedObject({
  agentId: NonEmptyString,
  workspace: NonEmptyString,
  file: AgentsFileEntrySchema,
});

/** Writes one editable agent file. */
export const AgentsFilesSetParamsSchema = Object.assign(
  closedObject({
    agentId: NonEmptyString,
    name: NonEmptyString,
    content: Type.String(),
    expectedHash: Type.Optional(Sha256String),
    expectedMissing: Type.Optional(Type.Literal(true)),
  }),
  { not: { required: ["expectedHash", "expectedMissing"] } },
);

/** Result returned after writing an editable agent file. */
export const AgentsFilesSetResultSchema = closedObject({
  ok: Type.Literal(true),
  agentId: NonEmptyString,
  workspace: NonEmptyString,
  file: AgentsFileEntrySchema,
});

export type AgentsFileEntry = Static<typeof AgentsFileEntrySchema>;
export type AgentsFilesListParams = Static<typeof AgentsFilesListParamsSchema>;
export type AgentsFilesListResult = Static<typeof AgentsFilesListResultSchema>;
export type AgentsFilesGetParams = Static<typeof AgentsFilesGetParamsSchema>;
export type AgentsFilesGetResult = Static<typeof AgentsFilesGetResultSchema>;
export type AgentsFilesSetParams = Static<typeof AgentsFilesSetParamsSchema>;
export type AgentsFilesSetResult = Static<typeof AgentsFilesSetResultSchema>;
