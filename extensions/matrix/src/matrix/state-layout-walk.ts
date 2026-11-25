import path from "node:path";
import { hasNodeErrorCode } from "@openclaw/fs-safe/path";
import { walkDirectory } from "@openclaw/fs-safe/walk";
import { resolveMatrixStateLayoutChildDepth } from "../storage-paths.js";

/** Traverse only shipped Matrix layouts; archives and unrelated descendants stay unopened. */
export async function walkMatrixStateFiles(
  stateDir: string,
  includeFile: (name: string, layoutDepth: number) => boolean,
  stateRootDepths: readonly number[] = [],
) {
  const matrixRoot = path.resolve(stateDir, "matrix");
  const depths = new Map([[matrixRoot, 0]]);
  const result = await walkDirectory(matrixRoot, {
    symlinks: "skip",
    include: (entry) =>
      entry.kind === "file" && includeFile(entry.name, depths.get(path.dirname(entry.path))!),
    descend: (entry) => {
      const parentDepth = depths.get(path.dirname(entry.path))!;
      const depth =
        entry.name === "state" && stateRootDepths.includes(parentDepth)
          ? 5
          : resolveMatrixStateLayoutChildDepth(parentDepth, entry.name);
      if (depth === null) {
        return false;
      }
      depths.set(entry.path, depth);
      return true;
    },
  });
  return {
    entries: result.entries,
    failedDirs: result.failedDirs.filter(
      (failure) => failure.path !== matrixRoot || !hasNodeErrorCode(failure.error, "ENOENT"),
    ),
  };
}
