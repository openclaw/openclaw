import path from "node:path";
import { walkRootDirectory } from "openclaw/plugin-sdk/root-walk";

export async function findMatrixStateDatabases(rootDir: string): Promise<string[]> {
  const matches: string[] = [];
  try {
    for await (const entry of walkRootDirectory(rootDir, "", {
      order: "filesystem",
      symlinkPolicy: "skip",
      onDirectoryError: "skip-and-report",
      // A walker depth limit ends the scan; these probes must still visit siblings.
      entryFilter: (candidate) =>
        candidate.kind === "directory" && candidate.relativePath.split("/").length > 10
          ? "skip-subtree"
          : "include",
    })) {
      if (entry.kind === "file" && path.posix.basename(entry.relativePath) === "openclaw.sqlite") {
        matches.push(path.join(rootDir, entry.relativePath));
      }
    }
  } catch {
    // State roots may be absent or unreadable while a scenario restarts or removes them.
  }
  return matches.toSorted();
}
