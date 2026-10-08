import fs from "node:fs/promises";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type LegacySessionIndexEntry = {
  sessionId: string;
  sessionFile?: string;
  lifecycleRevision?: string;
  agentHarnessId?: string;
  updatedAt?: number;
};

export async function readLegacySessionIndex(
  storePath: string,
): Promise<
  { entries: Array<{ sessionKey: string; entry: LegacySessionIndexEntry }> } | { failure: string }
> {
  let contents: string;
  try {
    contents = await fs.readFile(storePath, "utf8");
  } catch (error) {
    const code = extractErrorCode(error);
    return code === "ENOENT"
      ? { entries: [] }
      : { failure: `session index ${storePath} could not be read${code ? ` (${code})` : ""}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return { failure: `session index ${storePath} could not be read (invalid JSON)` };
  }
  if (!isRecord(raw)) {
    return { failure: `session index ${storePath} has invalid entries` };
  }
  const entries: Array<{ sessionKey: string; entry: LegacySessionIndexEntry }> = [];
  for (const [sessionKey, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      return { failure: `session index ${storePath} has invalid entries` };
    }
    // Only file-era indexes retain these ownership facts; runtime session readers use SQLite.
    if (value.sessionId === undefined) {
      continue;
    }
    if (!isSafeLegacySessionId(value.sessionId)) {
      return { failure: `session index ${storePath} has invalid entries` };
    }
    const entry: LegacySessionIndexEntry = { sessionId: value.sessionId.trim() };
    for (const key of ["sessionFile", "lifecycleRevision", "agentHarnessId"] as const) {
      const field = value[key];
      if (field !== undefined) {
        if (typeof field !== "string") {
          return { failure: `session index ${storePath} has invalid entries` };
        }
        entry[key] = field;
      }
    }
    if (
      typeof value.updatedAt === "number" &&
      Number.isFinite(value.updatedAt) &&
      value.updatedAt >= 0
    ) {
      entry.updatedAt = value.updatedAt;
    }
    entries.push({ sessionKey, entry });
  }
  return { entries };
}

function isSafeLegacySessionId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return (
    trimmed.length > 0 && trimmed.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(trimmed)
  );
}
