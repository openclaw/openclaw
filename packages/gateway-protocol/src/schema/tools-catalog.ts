import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Reads the configured tool catalog for an agent. */
export const ToolsCatalogParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  includePlugins: Type.Optional(Type.Boolean()),
});

/** Tool profile shown in catalog views. */
export const ToolCatalogProfileSchema = closedObject({
  id: Type.Union([
    Type.Literal("minimal"),
    Type.Literal("coding"),
    Type.Literal("messaging"),
    Type.Literal("full"),
  ]),
  label: NonEmptyString,
});

/** Tool catalog entry before session-specific filtering is applied. */
export const ToolCatalogEntrySchema = closedObject({
  id: NonEmptyString,
  label: NonEmptyString,
  description: Type.String(),
  source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
  pluginId: Type.Optional(NonEmptyString),
  optional: Type.Optional(Type.Boolean()),
  risk: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  ),
  tags: Type.Optional(Type.Array(NonEmptyString)),
  fullDescription: Type.Optional(Type.String()),
  defaultProfiles: Type.Array(
    Type.Union([
      Type.Literal("minimal"),
      Type.Literal("coding"),
      Type.Literal("messaging"),
      Type.Literal("full"),
    ]),
  ),
});

/** Group of related catalog tools from core or a plugin. */
export const ToolCatalogGroupSchema = closedObject({
  id: NonEmptyString,
  label: NonEmptyString,
  source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
  pluginId: Type.Optional(NonEmptyString),
  tools: Type.Array(ToolCatalogEntrySchema),
});

/** Tool catalog result for agent configuration UI. */
export const ToolsCatalogResultSchema = closedObject({
  agentId: NonEmptyString,
  profiles: Type.Array(ToolCatalogProfileSchema),
  groups: Type.Array(ToolCatalogGroupSchema),
});

export type ToolsCatalogParams = Static<typeof ToolsCatalogParamsSchema>;
export type ToolCatalogProfile = Static<typeof ToolCatalogProfileSchema>;
export type ToolCatalogEntry = Static<typeof ToolCatalogEntrySchema>;
export type ToolCatalogGroup = Static<typeof ToolCatalogGroupSchema>;
export type ToolsCatalogResult = Static<typeof ToolsCatalogResultSchema>;
