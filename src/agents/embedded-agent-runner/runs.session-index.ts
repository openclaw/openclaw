import fs from "node:fs";
import path from "node:path";

export function normalizeSessionFileRegistryKey(
  sessionFile: string | undefined,
): string | undefined {
  const normalized = sessionFile?.trim();
  if (!normalized) {
    return undefined;
  }
  if (
    normalized.startsWith("agent:") ||
    normalized.startsWith("sqlite:") ||
    normalized.startsWith("in-memory:")
  ) {
    return normalized;
  }
  const resolved = path.resolve(normalized);
  const parent = path.dirname(resolved);
  try {
    // Canonicalize only the parent so a registry key stays stable when the
    // transcript file itself is created or removed during the active run.
    // Artifact-file symlinks are not runtime session identity after SQLite migration.
    return path.join(fs.realpathSync(parent), path.basename(resolved));
  } catch {
    return resolved;
  }
}
