import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const CODE_MODE_STORE_CUSTOM_TYPE = "openclaw.code-mode-store";
export type CodeModeStoreWrites = Map<string, { value: unknown; networkContent: boolean } | null>;

export function readCodeModeStoreKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0 || key.length > 256) {
    throw new TypeError(
      "Code Mode store key must be a non-empty string of at most 256 characters.",
    );
  }
  return key;
}

/** Validate history once at its reader, retaining only each key's final write. */
export function collectCodeModeStoreWrites(
  entries: Iterable<unknown>,
  incremental = false,
): CodeModeStoreWrites {
  const writes = new Map<string, { value: unknown; networkContent: boolean } | null>();
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== CODE_MODE_STORE_CUSTOM_TYPE
    ) {
      continue;
    }
    const data = entry.data;
    if (
      !isRecord(data) ||
      !isRecord(data.set) ||
      !Array.isArray(data.delete) ||
      !isRecord(data.networkContent)
    ) {
      throw new Error(
        "Code Mode session store contains an invalid transcript entry; repair the session before using store/load.",
      );
    }
    for (const [key, value] of Object.entries(data.set)) {
      const networkContent = data.networkContent[key];
      if (typeof networkContent !== "boolean") {
        throw new Error(
          "Code Mode session store contains invalid content provenance; repair the session before using store/load.",
        );
      }
      writes.set(readCodeModeStoreKey(key), { value, networkContent });
    }
    for (const key of data.delete) {
      const name = readCodeModeStoreKey(key);
      if (incremental) {
        writes.set(name, null);
      } else {
        writes.delete(name);
      }
    }
  }
  return writes;
}
