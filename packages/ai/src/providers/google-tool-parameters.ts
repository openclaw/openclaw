import { asRecord, isStringArray } from "@openclaw/normalization-core/record-coerce";
import type { Tool } from "../types.js";

// Gemini 2.5 can emit MALFORMED_FUNCTION_CALL for Python keyword parameters.
// Only function parameters are renamed; nested objects are user data.
const PYTHON_KEYWORDS = new Set(
  (
    "False None True and as assert async await break class continue def del elif else except " +
    "finally for from global if import in is lambda nonlocal not or pass raise return try while with yield"
  ).split(" "),
);

function parameterNames(parameters: Record<string, unknown>): Map<string, string> {
  const properties = asRecord(parameters.properties);
  const names = new Map<string, string>();
  for (const name of Object.keys(properties)) {
    if (!PYTHON_KEYWORDS.has(name)) {
      continue;
    }
    let alias = `${name}_`;
    while (Object.hasOwn(properties, alias)) {
      alias += "_";
    }
    names.set(name, alias);
  }
  return names;
}

export function googleToolParameters(parameters: Tool["parameters"]): Record<string, unknown> {
  const schema = asRecord(parameters);
  const names = parameterNames(schema);
  if (names.size === 0) {
    return schema;
  }
  const projected: Record<string, unknown> = {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(asRecord(schema.properties)).map(([name, propertySchema]) => [
        names.get(name) ?? name,
        propertySchema,
      ]),
    ),
  };
  for (const key of ["required", "propertyOrdering"] as const) {
    const value = schema[key];
    if (isStringArray(value)) {
      projected[key] = value.map((name) => names.get(name) ?? name);
    }
  }
  return projected;
}

export function mapGoogleToolArguments(
  tools: Tool[] | undefined,
  toolName: string,
  args: Record<string, unknown>,
  direction: "encode" | "decode",
): Record<string, unknown> {
  const tool = tools?.find((candidate) => candidate.name === toolName);
  if (!tool) {
    return args;
  }
  const names = parameterNames(asRecord(tool.parameters));
  if (names.size === 0) {
    return args;
  }
  const mapping =
    direction === "encode" ? names : new Map([...names].map(([name, alias]) => [alias, name]));
  return Object.fromEntries(
    Object.entries(args).map(([name, value]) => [mapping.get(name) ?? name, value]),
  );
}
