/**
 * skill-library.ts — 向后兼容重导出
 * @deprecated 使用 script-library.ts；此文件仅保留向后兼容
 */
export {
  createScriptLibrary as createSkillLibrary,
  registerBuiltinScripts as registerBuiltinSkills,
  type ScriptContext as SkillContext,
  type ScriptDefinition as SkillDefinition,
  type ScriptLibrary as SkillLibrary,
} from "./script-library.js";
