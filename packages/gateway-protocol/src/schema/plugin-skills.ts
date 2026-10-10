import { Type, type Static } from "typebox";
import { lazyCompile } from "../protocol-validator.js";
import { closedObject } from "./closed-object.js";
import { SKILL_LIBRARY_MAX_FILE_BYTES, SKILL_LIBRARY_MAX_FILES } from "./skill-library.js";

const name = Type.String({ minLength: 1, maxLength: 256 });
const filePath = Type.String({ minLength: 1, maxLength: 512 });

/** Paths select files inside a declared skill; omitted means its SKILL.md entry. */
export const PluginsSkillsReadParamsSchema = Type.Union([
  closedObject({
    source: Type.Literal("installed"),
    pluginId: name,
    skillName: name,
    path: Type.Optional(filePath),
    version: Type.Optional(name),
  }),
  closedObject({
    source: Type.Literal("catalog"),
    catalogId: name,
    version: name,
    skillName: name,
    path: Type.Optional(filePath),
  }),
]);
export const PluginSkillFileSchema = closedObject({
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
});
export const PluginsSkillsReadResultSchema = closedObject({
  name,
  rootPath: filePath,
  entryPath: filePath,
  version: Type.Optional(name),
  files: Type.Array(PluginSkillFileSchema, { maxItems: SKILL_LIBRARY_MAX_FILES }),
  directories: Type.Array(filePath, { maxItems: SKILL_LIBRARY_MAX_FILES * 2 }),
  /** False means directory enumeration failed, not merely that a binary cannot render. */
  inventoryComplete: Type.Boolean(),
});
export type PluginsSkillsReadParams = Static<typeof PluginsSkillsReadParamsSchema>;
export type PluginsSkillsReadResult = Static<typeof PluginsSkillsReadResultSchema>;
export type PluginSkillFile = Static<typeof PluginSkillFileSchema>;
export const validatePluginsSkillsReadParams = lazyCompile(PluginsSkillsReadParamsSchema);
