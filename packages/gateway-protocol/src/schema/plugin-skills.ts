import { Type, type Static } from "typebox";
import { lazyCompile } from "../protocol-validator.js";
import { SKILL_LIBRARY_MAX_FILE_BYTES, SKILL_LIBRARY_MAX_FILES } from "./skill-library.js";

const closed = { additionalProperties: false } as const;
const name = Type.String({ minLength: 1, maxLength: 256 });
const filePath = Type.String({ minLength: 1, maxLength: 512 });

/** Paths select files inside a declared skill; omitted means its SKILL.md entry. */
export const PluginsSkillsReadParamsSchema = Type.Union([
  Type.Object(
    {
      source: Type.Literal("installed"),
      pluginId: name,
      skillName: name,
      path: Type.Optional(filePath),
      version: Type.Optional(name),
    },
    closed,
  ),
  Type.Object(
    {
      source: Type.Literal("catalog"),
      catalogId: name,
      version: name,
      skillName: name,
      path: Type.Optional(filePath),
    },
    closed,
  ),
]);
export const PluginSkillFileSchema = Type.Object(
  {
    path: filePath,
    sizeBytes: Type.Integer({ minimum: 0 }),
    status: Type.Union([
      Type.Literal("ready"),
      Type.Literal("deferred"),
      Type.Literal("binary"),
      Type.Literal("too-large"),
      Type.Literal("unavailable"),
    ]),
    content: Type.Optional(Type.String({ maxLength: SKILL_LIBRARY_MAX_FILE_BYTES })),
  },
  closed,
);
export const PluginsSkillsReadResultSchema = Type.Object(
  {
    name,
    rootPath: filePath,
    entryPath: filePath,
    version: Type.Optional(name),
    files: Type.Array(PluginSkillFileSchema, { maxItems: SKILL_LIBRARY_MAX_FILES }),
    directories: Type.Array(filePath, { maxItems: SKILL_LIBRARY_MAX_FILES * 2 }),
    /** False means directory enumeration failed, not merely that a binary cannot render. */
    inventoryComplete: Type.Boolean(),
  },
  closed,
);
export type PluginsSkillsReadParams = Static<typeof PluginsSkillsReadParamsSchema>;
export type PluginsSkillsReadResult = Static<typeof PluginsSkillsReadResultSchema>;
export type PluginSkillFile = Static<typeof PluginSkillFileSchema>;
export const validatePluginsSkillsReadParams = lazyCompile(PluginsSkillsReadParamsSchema);
