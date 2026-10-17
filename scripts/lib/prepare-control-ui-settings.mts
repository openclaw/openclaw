import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

/** Keep the alias-aware native builder outside Vite's configuration bundle. */
export async function prepareControlUiSettings(repoRoot: string): Promise<void> {
  if (!fs.existsSync(path.join(repoRoot, "extensions"))) {
    return;
  }
  const scripts = path.resolve(import.meta.dirname, "..");
  // Vite bundles this helper; share the launcher's live ownership module, not a bundled copy.
  const {
    distArtifactEntryArgs,
    withDistArtifactOwnership,
  }: typeof import("./dist-artifact-ownership.mts") = await import(
    pathToFileURL(path.join(scripts, "lib/dist-artifact-ownership.mts")).href
  );
  await withDistArtifactOwnership(repoRoot, () =>
    promisify(execFile)(
      process.execPath,
      distArtifactEntryArgs(path.join(scripts, "build-plugin-control-ui.mts"), [
        "--prepare-settings",
        repoRoot,
      ]),
      { cwd: repoRoot, maxBuffer: 1024 * 1024 },
    ),
  );
}
