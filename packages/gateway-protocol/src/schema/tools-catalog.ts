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
  parameters: Type.Optional(
    Type.Array(
      closedObject({
        name: NonEmptyString,
        required: Type.Boolean(),
        type: Type.Optional(NonEmptyString),
        description: Type.Optional(Type.String()),
      }),
    ),
  ),
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

/** Reads the effective tool set for one session. */
export const ToolsEffectiveParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  sessionKey: NonEmptyString,
});

/** Effective tool entry after session/profile/channel/plugin filtering. */
export const ToolsEffectiveEntrySchema = closedObject({
  id: NonEmptyString,
  label: NonEmptyString,
  description: Type.String(),
  rawDescription: Type.String(),
  source: Type.Union([
    Type.Literal("core"),
    Type.Literal("plugin"),
    Type.Literal("channel"),
    Type.Literal("mcp"),
  ]),
  pluginId: Type.Optional(NonEmptyString),
  channelId: Type.Optional(NonEmptyString),
  mcpServer: Type.Optional(NonEmptyString),
  mcpToolName: Type.Optional(NonEmptyString),
  deniedBySession: Type.Optional(Type.Literal(true)),
  risk: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  ),
  tags: Type.Optional(Type.Array(NonEmptyString)),
});

/** Effective tool group shown to runtime/session callers. */
export const ToolsEffectiveGroupSchema = closedObject({
  id: Type.Union([
    Type.Literal("core"),
    Type.Literal("plugin"),
    Type.Literal("channel"),
    Type.Literal("mcp"),
  ]),
  label: NonEmptyString,
  source: Type.Union([
    Type.Literal("core"),
    Type.Literal("plugin"),
    Type.Literal("channel"),
    Type.Literal("mcp"),
  ]),
  tools: Type.Array(ToolsEffectiveEntrySchema),
});

/** Notice explaining runtime filtering such as quarantined tool schemas. */
export const ToolsEffectiveNoticeSchema = closedObject({
  id: NonEmptyString,
  severity: Type.Union([Type.Literal("info"), Type.Literal("warning")]),
  message: Type.String(),
  servers: Type.Optional(Type.Array(NonEmptyString)),
});

/** Effective tool set for a session, including profile and filtering notices. */
export const ToolAccessDiagnosticsSchema = closedObject({
  checked: Type.Union([Type.Literal("local-config"), Type.Literal("live-session")]),
  profiles: Type.Array(
    closedObject({
      profile: NonEmptyString,
      source: NonEmptyString,
      active: Type.Boolean(),
    }),
  ),
  tools: Type.Array(
    closedObject({
      id: NonEmptyString,
      status: Type.Union([
        Type.Literal("allowed"),
        Type.Literal("excluded"),
        Type.Literal("available"),
        Type.Literal("unavailable"),
      ]),
      reasons: Type.Array(
        closedObject({
          kind: Type.Union([
            Type.Literal("profile"),
            Type.Literal("deny"),
            Type.Literal("allowlist"),
            Type.Literal("session"),
            Type.Literal("runtime"),
          ]),
          label: NonEmptyString,
          source: Type.Optional(NonEmptyString),
          profile: Type.Optional(NonEmptyString),
        }),
      ),
      alsoAllowPath: Type.Optional(NonEmptyString),
    }),
  ),
});

export const ToolsEffectiveResultSchema = closedObject({
  agentId: NonEmptyString,
  profile: NonEmptyString,
  groups: Type.Array(ToolsEffectiveGroupSchema),
  notices: Type.Optional(Type.Array(ToolsEffectiveNoticeSchema)),
  toolAccess: Type.Optional(ToolAccessDiagnosticsSchema),
});

export type ToolsEffectiveParams = Static<typeof ToolsEffectiveParamsSchema>;
export type ToolsEffectiveEntry = Static<typeof ToolsEffectiveEntrySchema>;
export type ToolsEffectiveGroup = Static<typeof ToolsEffectiveGroupSchema>;
export type ToolsEffectiveNotice = Static<typeof ToolsEffectiveNoticeSchema>;
export type ToolsEffectiveResult = Static<typeof ToolsEffectiveResultSchema>;
export type ToolAccessDiagnostics = Static<typeof ToolAccessDiagnosticsSchema>;
