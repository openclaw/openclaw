import path from "node:path";
import { walkRootDirectory } from "openclaw/plugin-sdk/root-walk";

export async function findFilesByName(params: {
  filename: string;
  rootDir: string;
  maxDepth?: number;
}): Promise<string[]> {
  const maxDepth = params.maxDepth ?? 8;
  const matches: string[] = [];
  try {
    for await (const entry of walkRootDirectory(params.rootDir, "", {
      order: "filesystem",
      symlinkPolicy: "skip",
      onDirectoryError: "skip-and-report",
      // A walker depth limit ends the scan; these probes must still visit siblings.
      entryFilter: (candidate) =>
        candidate.kind === "directory" && candidate.relativePath.split("/").length > maxDepth
          ? "skip-subtree"
          : "include",
    })) {
      if (entry.kind === "file" && path.posix.basename(entry.relativePath) === params.filename) {
        matches.push(path.join(params.rootDir, entry.relativePath));
      }
    }
  } catch {
    // State roots may be absent or unreadable while a scenario restarts or removes them.
  }
  return matches.toSorted();
}
