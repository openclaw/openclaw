import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Keep the alias-aware native builder outside Vite's configuration bundle. */
export async function prepareControlUiSettings(
  repoRoot: string,
  scripts = path.resolve(import.meta.dirname, ".."),
  signal?: AbortSignal,
): Promise<void> {
  if (!fs.existsSync(path.join(repoRoot, "extensions"))) {
    return;
  }
  // Bypass Vite's module runner: its HTTP import URLs cannot launch native children,
  // and bundled copies would lose the launcher's live ownership context.
  const { runDistArtifactChild }: typeof import("./dist-artifact-ownership.mts") = createRequire(
    import.meta.url,
  )(path.join(scripts, "lib/dist-artifact-ownership.mts"));
  const status = await runDistArtifactChild(
    repoRoot,
    path.join(scripts, "build-plugin-control-ui.mts"),
    ["--prepare-settings", repoRoot],
    { signal },
  );
  if (status !== 0) {
    throw new Error(`Control UI Settings preparation failed (exit ${status})`);
  }
}
