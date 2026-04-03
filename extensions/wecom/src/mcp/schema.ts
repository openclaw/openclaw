/**
 * MCP Schema 清洗模块
 *
 * 负责内联 $ref/$defs 引用并移除 Gemini 不支持的 JSON Schema 关键词，
 * 防止 Gemini 模型解析 function response 时报 400 错误。
 */

/** Gemini 不支持的 JSON Schema 关键词 */
const GEMINI_UNSUPPORTED_KEYWORDS = new Set([
  "patternProperties", "additionalProperties", "$schema", "$id", "$ref", "$defs",
  "definitions", "examples", "minLength", "maxLength", "minimum", "maximum",
  "multipleOf", "pattern", "format", "minItems", "maxItems", "uniqueItems",
  "minProperties", "maxProperties",
]);

/**
 * 清洗 JSON Schema，内联 $ref 引用并移除 Gemini 不支持的关键词，
 * 防止 Gemini 模型解析 function response 时报 400 错误。
 */
export function cleanSchemaForGemini(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchemaForGemini);

  const obj = schema as Record<string, unknown>;

  // 收集 $defs/definitions 用于后续 $ref 内联解析
  const defs: Record<string, unknown> = {
    ...(obj.$defs && typeof obj.$defs === "object" ? obj.$defs as Record<string, unknown> : {}),
    ...(obj.definitions && typeof obj.definitions === "object" ? obj.definitions as Record<string, unknown> : {}),
  };

  return cleanWithDefs(obj, defs, new Set());
}

function cleanWithDefs(
  schema: unknown,
  defs: Record<string, unknown>,
  refStack: Set<string>,
): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((item) => cleanWithDefs(item, defs, refStack));

  const obj = schema as Record<string, unknown>;

  // 合并当前层级的 $defs/definitions 到 defs 中
  if (obj.$defs && typeof obj.$defs === "object") {
    Object.assign(defs, obj.$defs as Record<string, unknown>);
  }
  if (obj.definitions && typeof obj.definitions === "object") {
    Object.assign(defs, obj.definitions as Record<string, unknown>);
  }

  // 处理 $ref 引用：尝试内联解析
  if (typeof obj.$ref === "string") {
    const ref = obj.$ref;
    if (refStack.has(ref)) return {}; // 防止循环引用

    const match = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
    if (match && match[1] && defs[match[1]]) {
      const nextStack = new Set(refStack);
      nextStack.add(ref);
      return cleanWithDefs(defs[match[1]], defs, nextStack);
    }
    return {}; // 无法解析的 $ref，返回空对象
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (GEMINI_UNSUPPORTED_KEYWORDS.has(key)) continue;

    if (key === "const") {
      cleaned.enum = [value];
      continue;
    }

    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k, cleanWithDefs(v, defs, refStack),
        ]),
      );
    } else if (key === "items" && value) {
      cleaned[key] = Array.isArray(value)
        ? value.map((item) => cleanWithDefs(item, defs, refStack))
        : cleanWithDefs(value, defs, refStack);
    } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      // 过滤掉 null 类型的变体
      const nonNull = value.filter((v) => {
        if (!v || typeof v !== "object") return true;
        const r = v as Record<string, unknown>;
        return r.type !== "null";
      });
      if (nonNull.length === 1) {
        // 只剩一个变体时直接内联
        const single = cleanWithDefs(nonNull[0], defs, refStack);
        if (single && typeof single === "object" && !Array.isArray(single)) {
          Object.assign(cleaned, single as Record<string, unknown>);
        }
      } else {
        cleaned[key] = nonNull.map((v) => cleanWithDefs(v, defs, refStack));
      }
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
}
