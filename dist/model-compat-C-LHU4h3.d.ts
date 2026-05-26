import { o as ModelCompatConfig } from "./types.models-tqxsISRc.js";
//#region extensions/xai/model-compat.d.ts
declare const XAI_TOOL_SCHEMA_PROFILE = "xai";
declare const HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING = "html-entities";
declare const XAI_UNSUPPORTED_SCHEMA_KEYWORDS: Set<string>;
declare function resolveXaiModelCompatPatch(): ModelCompatConfig;
declare function applyXaiModelCompat<T extends {
  compat?: unknown;
}>(model: T): T;
//#endregion
export { resolveXaiModelCompatPatch as a, applyXaiModelCompat as i, XAI_TOOL_SCHEMA_PROFILE as n, XAI_UNSUPPORTED_SCHEMA_KEYWORDS as r, HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING as t };