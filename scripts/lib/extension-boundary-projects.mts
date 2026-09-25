import fs from "node:fs";
import path from "node:path";
import {
  isTypeScriptPackageEntry,
  listBuiltRuntimeEntryCandidates,
} from "../../src/plugins/package-entrypoints.ts";
import { collectFilesSync } from "../check-file-utils.ts";
import { portableRelativePath } from "./build-artifact-cache.mts";
import { collectBundledPluginBuildEntries } from "./bundled-plugin-build-entries.mjs";
import { BOUNDARY_CACHE_ROOT } from "./extension-boundary-inputs.mts";
import { readNativeTypeScriptConfig } from "./native-typescript-config.mts";
import { isRecord } from "./record-shared.mjs";

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  return value && typeof value === "object" ? Object.values(value).flatMap(exportTargets) : [];
}

/** Build-only leaf projects retain the shared package config and its SDK aliases. */
export function prepareExtensionBoundaryProjects(rootDir: string, extensionIds: string[]) {
  const inventory = new Map(
    collectBundledPluginBuildEntries({
      cwd: rootDir,
      env: {},
      includeExternalSourceEntries: true,
    }).map((entry) => [entry.id, entry]),
  );
  return extensionIds.map((extensionId) => {
    const entry = inventory.get(extensionId);
    if (!entry) {
      throw new Error(`No packaged surface for extension boundary: ${extensionId}`);
    }
    const pluginRoot = path.resolve(rootDir, "extensions", extensionId);
    const sources = collectFilesSync(pluginRoot, { includeFile: isTypeScriptPackageEntry });
    const candidates = new Map<string, Set<string>>();
    const addCandidate = (target: string, source: string) => {
      const key = path.resolve(pluginRoot, target);
      const matches = candidates.get(key) ?? new Set<string>();
      matches.add(source);
      candidates.set(key, matches);
    };
    const parsed = readNativeTypeScriptConfig({
      cwd: rootDir,
      configFileName: path.join(pluginRoot, "tsconfig.json"),
    });
    const declarations = parsed.fileNames.filter((source) => /\.d\.[cm]?ts$/u.test(source));
    for (const source of sources) {
      const relative = portableRelativePath(pluginRoot, source);
      addCandidate(relative, source);
      if (/\.d\.[cm]?ts$/u.test(source)) {
        continue;
      }
      for (const output of listBuiltRuntimeEntryCandidates(relative)) {
        addCandidate(output, source);
        addCandidate(output.replace(/\.[cm]?js$/u, ".d.ts"), source);
      }
    }
    const pkg = isRecord(entry.packageJson) ? entry.packageJson : {};
    const targets = new Set([
      ...entry.sourceEntries,
      ...exportTargets(pkg.exports),
      ...exportTargets(pkg.main),
    ]);
    // Ambient module declarations need roots even when there is no import edge to them.
    const roots = new Set(declarations);
    for (const target of targets) {
      if (!/\.[cm]?[jt]sx?$/u.test(target)) {
        continue;
      }
      const absolute = path.resolve(pluginRoot, target);
      const relative = path.relative(pluginRoot, absolute);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Extension entry escapes its package: ${extensionId}: ${target}`);
      }
      const direct = candidates.get(absolute);
      const matches = direct
        ? Array.from(direct)
        : [...candidates]
            .filter(([candidate]) => path.matchesGlob(candidate, absolute))
            .flatMap(([, files]) => Array.from(files));
      if (!matches.length) {
        throw new Error(`No TypeScript source for extension entry: ${extensionId}: ${target}`);
      }
      for (const source of matches) {
        roots.add(source);
      }
    }
    if (!roots.size) {
      throw new Error(`Empty extension boundary surface: ${extensionId}`);
    }
    const config = `${BOUNDARY_CACHE_ROOT}/compile/${extensionId}.tsconfig.json`;
    const configPath = path.resolve(rootDir, config);
    const contents = `${JSON.stringify(
      {
        extends: path.join(pluginRoot, "tsconfig.json"),
        compilerOptions: { rootDir: parsed.options.rootDir },
        files: [...roots].toSorted(),
        include: [],
        exclude: [],
      },
      null,
      2,
    )}\n`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (!fs.existsSync(configPath) || fs.readFileSync(configPath, "utf8") !== contents) {
      fs.writeFileSync(configPath, contents);
    }
    const metadataInputs = ["package.json", "openclaw.plugin.json"]
      .map((file) => path.join(pluginRoot, file))
      .filter((file) => fs.existsSync(file))
      .map((file) => portableRelativePath(rootDir, file));
    return { extensionId, config, metadataInputs };
  });
}
