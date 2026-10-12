import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { PluginDiscoveryCatalogFactsSchema, PluginDiscoveryEntrySchema } from "./plugins.js";
import { NonEmptyString } from "./primitives.js";

export const CatalogKindSchema = Type.Union([Type.Literal("plugin"), Type.Literal("skill")]);
const CatalogCursorSchema = Type.String({ minLength: 1, maxLength: 4096 });
const CatalogPageSizeSchema = Type.Integer({ minimum: 1, maximum: 100 });

export const CatalogPluginEntrySchema = closedObject({
  kind: Type.Literal("plugin"),
  registry: NonEmptyString,
  ...PluginDiscoveryEntrySchema.properties,
});

export const CatalogSkillEntrySchema = closedObject({
  kind: Type.Literal("skill"),
  registry: NonEmptyString,
  id: NonEmptyString,
  installRef: NonEmptyString,
  slug: NonEmptyString,
  ownerHandle: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  installOnly: Type.Optional(Type.Literal(true)),
  trustState: Type.Optional(Type.Literal("not-scanned-by-clawhub")),
  catalog: PluginDiscoveryCatalogFactsSchema,
  local: closedObject({
    agentId: NonEmptyString,
    installed: Type.Boolean(),
    enabled: Type.Boolean(),
    eligible: Type.Boolean(),
    skillKey: Type.Optional(NonEmptyString),
  }),
});

export const CatalogEntrySchema = Type.Union([CatalogPluginEntrySchema, CatalogSkillEntrySchema]);
export const CatalogBrowseParamsSchema = closedObject({
  kind: CatalogKindSchema,
  query: Type.Optional(Type.String({ maxLength: 200 })),
  feed: Type.Optional(Type.Union([Type.Literal("catalog"), Type.Literal("trending")])),
  officialOnly: Type.Optional(Type.Boolean()),
  pageSize: Type.Optional(CatalogPageSizeSchema),
  cursor: Type.Optional(CatalogCursorSchema),
  agentId: Type.Optional(NonEmptyString),
});
export const CatalogBrowseResultSchema = closedObject({
  items: Type.Array(CatalogEntrySchema),
  mode: Type.Union([Type.Literal("catalog"), Type.Literal("trending"), Type.Literal("search")]),
  nextCursor: Type.Optional(CatalogCursorSchema),
  searchLimit: Type.Optional(Type.Integer({ minimum: 1 })),
  remoteError: Type.Optional(Type.String()),
});
export const CatalogSearchKeywordsParamsSchema = closedObject({
  keywords: Type.Array(Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }), {
    minItems: 1,
    maxItems: 100,
  }),
  kinds: Type.Optional(
    Type.Array(CatalogKindSchema, { minItems: 1, maxItems: 2, uniqueItems: true }),
  ),
  pageSize: Type.Optional(CatalogPageSizeSchema),
  cursor: Type.Optional(CatalogCursorSchema),
  agentId: Type.Optional(NonEmptyString),
});
export const CatalogSearchKeywordsResultSchema = closedObject({
  items: Type.Array(CatalogEntrySchema),
  keywords: Type.Array(NonEmptyString),
  searchLimit: Type.Integer({ minimum: 1 }),
  nextCursor: Type.Optional(CatalogCursorSchema),
  errors: Type.Array(
    closedObject({ kind: CatalogKindSchema, query: NonEmptyString, message: Type.String() }),
  ),
});

export type CatalogKind = Static<typeof CatalogKindSchema>;
export type CatalogEntry = Static<typeof CatalogEntrySchema>;
export type CatalogPluginEntry = Static<typeof CatalogPluginEntrySchema>;
export type CatalogSkillEntry = Static<typeof CatalogSkillEntrySchema>;
export type CatalogBrowseParams = Static<typeof CatalogBrowseParamsSchema>;
export type CatalogBrowseResult = Static<typeof CatalogBrowseResultSchema>;
export type CatalogSearchKeywordsParams = Static<typeof CatalogSearchKeywordsParamsSchema>;
export type CatalogSearchKeywordsResult = Static<typeof CatalogSearchKeywordsResultSchema>;
