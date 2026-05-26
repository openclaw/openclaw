import { a as ModelCompatConfig } from "../../types.models-CkWCv1xp.js";
import { n as buildDoubaoProvider, t as buildDoubaoCodingProvider } from "../../provider-catalog-DKsFQ0Qp2.js";
import { a as buildDoubaoModelDefinition, i as DOUBAO_MODEL_CATALOG, n as DOUBAO_CODING_BASE_URL, r as DOUBAO_CODING_MODEL_CATALOG, t as DOUBAO_BASE_URL } from "../../models-mja14Dsc.js";

//#region extensions/volcengine/api.d.ts
declare const VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS: readonly ["minLength", "maxLength", "minItems", "maxItems", "minContains", "maxContains"];
declare function resolveVolcengineToolSchemaCompatPatch(compat?: ModelCompatConfig): ModelCompatConfig;
declare function applyVolcengineToolSchemaCompat<T extends {
  compat?: ModelCompatConfig;
}>(model: T): T;
//#endregion
export { DOUBAO_BASE_URL, DOUBAO_CODING_BASE_URL, DOUBAO_CODING_MODEL_CATALOG, DOUBAO_MODEL_CATALOG, VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS, applyVolcengineToolSchemaCompat, buildDoubaoCodingProvider, buildDoubaoModelDefinition, buildDoubaoProvider, resolveVolcengineToolSchemaCompatPatch };