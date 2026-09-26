import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

export function buildZaloNameIndex<T>(
  items: T[],
  nameFn: (item: T) => string | undefined,
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const name = normalizeOptionalLowercaseString(nameFn(item));
    if (!name) {
      continue;
    }
    const list = index.get(name) ?? [];
    list.push(item);
    index.set(name, list);
  }
  return index;
}
