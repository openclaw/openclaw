import path from "node:path";
import { root as openRoot } from "@openclaw/fs-safe/root";

/** Use the workspace's disposable root, already owned by scratch maintenance. */
export async function prepareAgentExecScratch(workspaceDir: string) {
  const root = await openRoot(workspaceDir, { symlinks: "reject" });
  await root.mkdir(".openclaw/tmp");
  const directory = path.join(root.rootReal, ".openclaw", "tmp");
  return { TMPDIR: directory, TMP: directory, TEMP: directory };
}
