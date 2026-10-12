import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/file-access-runtime";
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

// Doctor-only locator for retired file-backed session indexes. Active runtime
// never resolves these paths; migration needs them only to find old sidecars.
export async function resolveLegacySessionFileLocator(
  sessionsDir: string,
  entry: { sessionFile?: string },
  sessionId: string,
): Promise<string> {
  const base = path.resolve(sessionsDir);
  const fallback = path.join(base, `${sessionId}.jsonl`);
  const sessionFile = entry.sessionFile?.trim();
  if (!sessionFile) {
    return fallback;
  }
  const candidate = path.resolve(base, sessionFile);
  const [canonicalBase, canonicalCandidate] = await Promise.all([
    canonicalPathFromExistingAncestor(base),
    canonicalPathFromExistingAncestor(candidate),
  ]);
  if (!isPathInside(canonicalBase, canonicalCandidate)) {
    throw new Error("legacy session file locator escapes its session directory");
  }
  return candidate;
}
