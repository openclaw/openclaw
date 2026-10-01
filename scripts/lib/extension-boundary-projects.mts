import fs from "node:fs";
import path from "node:path";
import {
  isTypeScriptPackageEntry,
  listBuiltRuntimeEntryCandidates,
} from "../../src/plugins/package-entrypoints.ts";
import { collectFilesSync } from "../check-file-utils.ts";
import { portableRelativePath } from "./build-artifact-cache.mts";
import { collectBundledPluginBuildEntries } from "./bundled-plugin-build-entries.mjs";
import {
  BOUNDARY_CACHE_ROOT,
  BOUNDARY_PLUGIN_UNITS,
  LOCAL_PLUGIN_ROOT,
  LOCAL_SDK_ROOT,
} from "./extension-boundary-inputs.mts";
import { createDeclarationInputBoundary } from "./local-check-runtime.mts";
import { readNativeTypeScriptConfig } from "./native-typescript-config.mts";
import { createNativeTypeScriptProject } from "./native-typescript.mts";
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

/** Discover generated inputs; preparedSdk requires a verified current SDK emit or receipt. */
export function resolveExtensionBoundaryPreparation(
  rootDir: string,
  extensionIds: string[],
  { preparedSdk = false }: { preparedSdk?: boolean } = {},
) {
  const boundary = createDeclarationInputBoundary(rootDir);
  const sdkOutput = boundary.assert(LOCAL_SDK_ROOT);
  const pluginOutput = boundary.assert(LOCAL_PLUGIN_ROOT);
  const producerIds = new Set<string>(BOUNDARY_PLUGIN_UNITS.map(([id]) => id));
  const sdkRoots = new Set<string>();
  const pluginIds = new Set<string>();
  const dependencies = new Map<string, Set<string>>();
  const within = (root: string, file: string) =>
    file === root || file.startsWith(`${root}${path.sep}`);
  const sourceLocation = (file: string): { source: string; pluginId?: string } | undefined => {
    const absolute = boundary.resolve(file);
    if (within(sdkOutput, absolute)) {
      boundary.assert(absolute);
      return {
        source: boundary.assert(path.join(boundary.root, path.relative(sdkOutput, absolute))),
      };
    }
    if (within(pluginOutput, absolute)) {
      boundary.assert(absolute);
      const [id, ...parts] = path.relative(pluginOutput, absolute).split(path.sep);
      if (id && producerIds.has(id)) {
        return {
          source: boundary.assert(path.join(boundary.root, "extensions", id, ...parts)),
          pluginId: id,
        };
      }
    }
    return undefined;
  };
  const owned = (file: string) => {
    const absolute = boundary.resolve(file);
    return within(sdkOutput, absolute) || within(pluginOutput, absolute);
  };
  const currentSdkDeclaration = (file: string) => {
    const absolute = boundary.resolve(file);
    return (
      preparedSdk &&
      within(sdkOutput, absolute) &&
      /\.d\.[cm]?ts$/u.test(absolute) &&
      fs.statSync(boundary.assert(absolute), { throwIfNoEntry: false })?.isFile() === true
    );
  };
  const declarations = new Map<string, { source: string; pluginId?: string } | null>();
  const declaration = (file: string) => {
    const absolute = boundary.resolve(file);
    const cached = declarations.get(absolute);
    if (cached !== undefined) {
      return cached;
    }
    const location = sourceLocation(absolute);
    const match = location && /^(.*)\.d\.(ts|mts|cts)$/u.exec(location.source);
    const suffixes = match?.[2] === "ts" ? [".ts", ".tsx"] : match ? [`.${match[2]}`] : [];
    const source =
      match &&
      suffixes
        .map((suffix) => boundary.assert(`${match[1]}${suffix}`))
        .find((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
    const result = source && location ? { ...location, source } : null;
    declarations.set(absolute, result);
    return result;
  };
  const queue: { config: string; producerId?: string }[] = prepareExtensionBoundaryProjects(
    boundary.root,
    extensionIds,
  ).map(({ config }) => ({ config }));
  const visited = new Set<string>();
  for (const { config: candidate, producerId } of queue) {
    const config = boundary.assert(candidate);
    if (visited.has(config)) {
      continue;
    }
    visited.add(config);
    using project = createNativeTypeScriptProject({
      cwd: boundary.root,
      configFileName: config,
      fs: {
        fileExists(file) {
          return owned(file)
            ? currentSdkDeclaration(file) || declaration(file) !== null
            : undefined;
        },
        readFile(file) {
          // The first pass never consumes cache contents. A later pass follows only
          // the SDK tree just validated by its owner, discovering further producers.
          return owned(file) && !currentSdkDeclaration(file)
            ? declaration(file)
              ? ""
              : null
            : undefined;
        },
        directoryExists(directory) {
          if (!owned(directory)) {
            return undefined;
          }
          if (boundary.resolve(directory) === pluginOutput) {
            return true;
          }
          const location = sourceLocation(directory);
          return Boolean(
            location && fs.statSync(location.source, { throwIfNoEntry: false })?.isDirectory(),
          );
        },
        getAccessibleEntries(directory) {
          if (!owned(directory)) {
            return undefined;
          }
          if (boundary.resolve(directory) === pluginOutput) {
            return { files: [], directories: [...producerIds] };
          }
          const location = sourceLocation(directory);
          if (
            !location ||
            !fs.statSync(location.source, { throwIfNoEntry: false })?.isDirectory()
          ) {
            return { files: [], directories: [] };
          }
          const entries = fs.readdirSync(location.source, { withFileTypes: true });
          return {
            files: [
              ...new Set(
                entries
                  .filter((entry) => entry.isFile() && !/\.d\.[cm]?ts$/u.test(entry.name))
                  .flatMap((entry) =>
                    /\.tsx?$/u.test(entry.name)
                      ? [entry.name.replace(/\.tsx?$/u, ".d.ts")]
                      : /\.[cm]ts$/u.test(entry.name)
                        ? [entry.name.replace(/\.([cm]ts)$/u, ".d.$1")]
                        : [],
                  ),
              ),
            ],
            directories: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
          };
        },
        realpath(file) {
          return owned(file) ? boundary.assert(file) : undefined;
        },
      },
    });
    for (const file of project.project.program.getSourceFileNames()) {
      if (!owned(file) || currentSdkDeclaration(file)) {
        continue;
      }
      const input = declaration(file);
      if (!input) {
        throw new Error(`Unmapped generated extension boundary input: ${file}`);
      }
      if (input.pluginId) {
        if (producerId) {
          const inputs = dependencies.get(producerId) ?? new Set<string>();
          inputs.add(input.pluginId);
          dependencies.set(producerId, inputs);
        }
        if (!pluginIds.has(input.pluginId)) {
          pluginIds.add(input.pluginId);
          queue.push({
            config: `extensions/${input.pluginId}/tsconfig.json`,
            producerId: input.pluginId,
          });
        }
      } else {
        sdkRoots.add(portableRelativePath(boundary.root, input.source));
      }
    }
  }
  const ordered: string[] = [];
  const completed = new Set<string>();
  const visit = (id: string, chain: string[]) => {
    if (chain.includes(id)) {
      throw new Error(`Cyclic extension boundary producers: ${[...chain, id].join(" -> ")}`);
    }
    if (completed.has(id)) {
      return;
    }
    for (const dependency of [...(dependencies.get(id) ?? [])].toSorted()) {
      visit(dependency, [...chain, id]);
    }
    completed.add(id);
    ordered.push(id);
  };
  for (const id of [...pluginIds].toSorted()) {
    visit(id, []);
  }
  return { sdkRoots: [...sdkRoots].toSorted(), pluginIds: ordered };
}
