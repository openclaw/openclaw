import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root as openRoot } from "@openclaw/fs-safe/root";
import { hasErrnoCode } from "../infra/errno.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

/** Prefer workspace-owned scratch; read-only workspaces use the private temp owner. */
export async function prepareAgentExecScratch(workspaceDir: string) {
  const root = await openRoot(workspaceDir, { symlinks: "reject" });
  let directory = path.join(root.rootReal, ".openclaw", "tmp");
  try {
    await root.mkdir(".openclaw/tmp");
  } catch (error) {
    if (error instanceof FsSafeError && error.code !== "path-alias") {
      throw error;
    }
    const cause = error instanceof FsSafeError ? error.cause : error;
    if (!hasErrnoCode(cause, "EACCES") && !hasErrnoCode(cause, "EROFS")) {
      throw error;
    }
    directory = resolvePreferredOpenClawTmpDir();
  }
  return { TMPDIR: directory, TMP: directory, TEMP: directory };
}
