import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

// Zalo names reach OpenClaw in whichever Unicode form the sender's device stored, so
// "Nguyễn" typed as NFC and stored as NFD is the same person. Compare canonical forms;
// callers keep surfacing the original spelling.
export function normalizeZaloNameKey(value: string | null | undefined): string {
  return normalizeLowercaseStringOrEmpty(value).normalize("NFC");
}

export function buildZaloNameIndex<T>(
  items: T[],
  nameFn: (item: T) => string | undefined,
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const name = normalizeZaloNameKey(nameFn(item));
    if (!name) {
      continue;
    }
    const list = index.get(name) ?? [];
    list.push(item);
    index.set(name, list);
  }
  return index;
}
