import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildPluginControlUi,
  writePluginBuildManifest,
} from "../src/cli/plugins-control-ui-build.js";
import { controlUiSource, normalizeManifestControlUi } from "../src/plugins/manifest-control-ui.js";
import { copyBundledPluginMetadata } from "./copy-bundled-plugin-metadata.mts";
import { collectSourceCheckoutPluginBuildEntries } from "./lib/bundled-plugin-build-entries.mjs";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
import { isRecord } from "./lib/record-shared.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

export async function buildBundledPluginControlUi(
  packageDir: string,
  options: { copy?: boolean; repoRoot?: string } = {},
): Promise<void> {
  const rootDir = path.resolve(packageDir);
  const packageManifest = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
  const manifestPath = path.join(rootDir, "openclaw.plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (options.copy) {
    const generatedManifest = JSON.parse(
      await fs.readFile(path.join(rootDir, "dist/openclaw.plugin.json"), "utf8"),
    );
    const repoRoot = options.repoRoot ?? resolveRepoRoot(import.meta.url);
    const pluginDir = path.relative(path.join(repoRoot, "extensions"), rootDir);
    if (!pluginDir || pluginDir.includes(path.sep) || pluginDir.startsWith(".")) {
      throw new Error("Bundled UI copy must run inside one bundled plugin package.");
    }
    const output = path.dirname(generatedManifest.controlUi.entry);
    if (!/^dist\/control-ui\/[a-f0-9]{64}$/u.test(output)) {
      throw new Error("Build the plugin's immutable Control UI assets before copying.");
    }
    assertRealOutputRoot(path.join(repoRoot, "dist"));
    assertRealOutputRoot(path.join(repoRoot, "dist/extensions"));
    assertRealOutputRoot(path.join(repoRoot, "dist/extensions", pluginDir));
    await fs.cp(
      path.join(rootDir, output),
      path.join(repoRoot, "dist/extensions", pluginDir, output),
      { recursive: true },
    );
  } else {
    assertRealOutputRoot(path.join(rootDir, "dist"));
    const source = controlUiSource(packageManifest);
    if (!source) {
      throw new Error("Missing package.json openclaw.controlUi browser entrypoint.");
    }
    const controlUi = await buildPluginControlUi({ rootDir, source });
    // Runtime builds own generated artifacts, never the authored source manifest.
    await writePluginBuildManifest(path.join(rootDir, "dist"), { ...manifest, controlUi });
  }
}

/** UI-only commands need static Settings presenters even without a runtime build. */
export async function prepareBundledSettingsControlUi(repoRoot: string): Promise<void> {
  const selected: string[] = [];
  for (const entry of collectSourceCheckoutPluginBuildEntries({ cwd: repoRoot })) {
    if (entry.isolated || !isRecord(entry.packageJson) || !controlUiSource(entry.packageJson)) {
      continue;
    }
    const rootDir = path.join(repoRoot, "extensions", entry.id);
    const manifest = JSON.parse(
      await fs.readFile(path.join(rootDir, "openclaw.plugin.json"), "utf8"),
    );
    const declaration = normalizeManifestControlUi(manifest.controlUi);
    if (!declaration.ok) {
      throw new Error(`Invalid Control UI declaration for ${entry.id}: ${declaration.error}`);
    }
    if (!declaration.value?.settingsViews?.length) {
      continue;
    }
    await buildBundledPluginControlUi(rootDir);
    await buildBundledPluginControlUi(rootDir, { copy: true, repoRoot });
    selected.push(entry.id);
  }
  if (selected.length) {
    copyBundledPluginMetadata({ repoRoot, pluginIds: new Set(selected) });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const packageDir = process.argv[2];
  if (!packageDir) {
    throw new Error("Pass the plugin package directory to build its Control UI assets.");
  }
  if (packageDir === "--prepare-settings") {
    await prepareBundledSettingsControlUi(path.resolve(process.argv[3] ?? "."));
  } else {
    await buildBundledPluginControlUi(packageDir, { copy: process.argv.includes("--copy") });
  }
}
