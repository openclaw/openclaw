import { WORKSPACE_OPTIONS, type WorkspaceId } from "./workspaces";

/** Hardcoded IDs kept as a fast-path Set for backward compatibility. */
const VALID_WORKSPACE_IDS = new Set<string>(
  WORKSPACE_OPTIONS.map((w) => w.id)
);

/**
 * Returns true when `id` matches a known workspace ID (hardcoded or
 * dynamically created in the database).  Also serves as a type-guard
 * narrowing `string` to `WorkspaceId`.
 *
 * Server-only — uses db.ts which depends on better-sqlite3 and fs.
 */
export function isValidWorkspaceId(id: string): id is WorkspaceId {
  // Fast path: check hardcoded IDs first (avoids DB hit for common case)
  if (VALID_WORKSPACE_IDS.has(id)) {return true;}

  // Slow path: check database for dynamically-created workspaces
  try {
    // Use require to avoid circular-import issues at module init time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getWorkspace } = require("./db") as typeof import("./db");
    return !!getWorkspace(id);
  } catch {
    return false;
  }
}
