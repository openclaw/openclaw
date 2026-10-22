import {
  isJsonObject,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
} from "./protocol.js";

/** Validate the bounded immutable declarations shared by native and managed threads. */
export function parseCodexToolDeclarations(
  catalog: unknown,
  fail: () => Error,
): CodexDynamicToolSpec[] {
  if (!Array.isArray(catalog) || Buffer.byteLength(JSON.stringify(catalog)) > 1024 * 1024) {
    throw fail();
  }
  const names = new Set<string>();
  const namespaces = new Set<string>();
  const validName = (name: unknown): name is string =>
    typeof name === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(name);
  const readFunction = (value: unknown): CodexDynamicToolFunctionSpec => {
    if (
      !isJsonObject(value) ||
      value.type !== "function" ||
      !validName(value.name) ||
      typeof value.description !== "string" ||
      !isJsonObject(value.inputSchema) ||
      (value.deferLoading !== undefined && typeof value.deferLoading !== "boolean") ||
      Object.keys(value).some(
        (key) => !["type", "name", "description", "inputSchema", "deferLoading"].includes(key),
      ) ||
      names.has(value.name) ||
      names.size >= 2000
    ) {
      throw fail();
    }
    names.add(value.name);
    return {
      type: "function",
      name: value.name,
      description: value.description,
      inputSchema: value.inputSchema,
      ...(value.deferLoading === true ? { deferLoading: true } : {}),
    };
  };
  return catalog.map((value): CodexDynamicToolSpec => {
    if (!isJsonObject(value) || value.type !== "namespace") {
      return readFunction(value);
    }
    if (
      !validName(value.name) ||
      namespaces.has(value.name) ||
      typeof value.description !== "string" ||
      !Array.isArray(value.tools) ||
      !value.tools.length ||
      Object.keys(value).some((key) => !["type", "name", "description", "tools"].includes(key))
    ) {
      throw fail();
    }
    namespaces.add(value.name);
    return {
      type: "namespace",
      name: value.name,
      description: value.description,
      tools: value.tools.map(readFunction),
    };
  });
}
