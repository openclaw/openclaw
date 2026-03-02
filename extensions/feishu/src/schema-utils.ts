import { Type } from "@sinclair/typebox";

/**
 * Flat string enum for tool schemas — avoids Type.Union([Type.Literal(...)])
 * which compiles to anyOf and confuses weaker LLMs.
 */
export function stringEnum<T extends readonly string[]>(
  values: T,
  options: { description?: string; title?: string; default?: T[number] } = {},
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}
