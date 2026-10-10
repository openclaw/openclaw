import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  buildPluginControlUi,
  writePluginBuildManifest,
} from "../src/cli/plugins-control-ui-build.js";
import { controlUiSource } from "../src/plugins/package-manifest.js";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const packageDir = process.argv[2];
if (!packageDir) {
  throw new Error("Pass the plugin package directory to build its Control UI assets.");
}
const rootDir = path.resolve(packageDir);
const packageManifest = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
const manifestPath = path.join(rootDir, "openclaw.plugin.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
if (process.argv.includes("--copy")) {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const pluginDir = path.relative(path.join(repoRoot, "extensions"), rootDir);
  if (!pluginDir || pluginDir.includes(path.sep) || pluginDir.startsWith(".")) {
    throw new Error("Bundled UI copy must run inside one bundled plugin package.");
  }
  const output = path.dirname(manifest.controlUi.entry);
  if (!/^dist\/control-ui\/[a-f0-9]{64}$/u.test(output)) {
    throw new Error("Build the plugin's immutable Control UI assets before copying.");
  }
  await fs.cp(
    path.join(rootDir, output),
    path.join(repoRoot, "dist/extensions", pluginDir, output),
    { recursive: true },
  );
} else {
  const source = controlUiSource(packageManifest);
  if (!source) {
    throw new Error("Missing package.json openclaw.controlUi browser entrypoint.");
  }
  const controlUi = await buildPluginControlUi({ rootDir, source });
  // Rebuilding deleted assets must preserve unchanged manifest input identity.
  // Nonregular destinations still go through the atomic writer's safety checks.
  if (
    !isDeepStrictEqual(manifest.controlUi, controlUi) ||
    !(await fs.lstat(manifestPath)).isFile()
  ) {
    manifest.controlUi = controlUi;
    await writePluginBuildManifest(rootDir, manifest);
  }
}
