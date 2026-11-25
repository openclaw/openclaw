// Runs this install's release launcher instead of this tree, once an update has converted the
// install to releases. The update leaves `.openclaw-launcher` (Git: `.git/openclaw-launcher`)
// beside this tree, naming the launcher. Service definitions, PATH shims and scripts written
// before the conversion keep naming this tree and reach the current release through it.
// A tree inside the releases directory never forwards (it is what the launcher starts).
// Reinstalling the package replaces the tree and drops the marker, so it runs itself again.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FORWARDED_ENV = "OPENCLAW_RELEASE_LAUNCHER_FORWARDED";

function readLauncher(root) {
  for (const marker of [
    path.join(root, ".openclaw-launcher"),
    path.join(root, ".git", "openclaw-launcher"),
  ]) {
    try {
      const launcher = readFileSync(marker, "utf8").trim();
      if (launcher && existsSync(launcher)) {
        return launcher;
      }
    } catch {}
  }
  return null;
}

/** Imports the launcher and returns true when this tree should not run itself. */
export async function forwardToReleaseLauncher(rootUrl) {
  if (process.env[FORWARDED_ENV] === "1") {
    return false;
  }
  const root = fileURLToPath(rootUrl);
  const launcher = readLauncher(root);
  if (!launcher || root.startsWith(path.join(path.dirname(launcher), "releases") + path.sep)) {
    return false;
  }
  process.env[FORWARDED_ENV] = "1";
  // The launcher reads process.argv; argv[1] names it so its own classification applies.
  process.argv[1] = launcher;
  await import(pathToFileURL(launcher).href);
  return true;
}
