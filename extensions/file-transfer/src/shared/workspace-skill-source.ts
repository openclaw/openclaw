import path from "node:path";

/** Only task-created archives in this workspace may be consumed or retired. */
export function skillSourceArchive(workspace: string, value: unknown): string {
  if (
    typeof value !== "string" ||
    path.posix.dirname(value) !== path.posix.join(workspace, ".openclaw/skill-installs") ||
    !/^[a-f0-9-]{36}\.tgz$/.test(path.posix.basename(value))
  ) {
    throw new Error("Skill source archive is outside the workspace staging directory");
  }
  return value;
}
