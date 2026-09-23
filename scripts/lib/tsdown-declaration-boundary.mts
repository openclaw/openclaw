import fs from "node:fs";
import path from "node:path";
import type { BuildContext, UserConfig, Rolldown } from "tsdown";
import type { NativeDeclaration } from "./native-declaration-emitter.mts";

type Plugin = Rolldown.Plugin;
type PluginOption = Rolldown.RolldownPluginOption;

const withinRoot = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function findAncestorInstall(root: string, real: string): string | undefined {
  let ancestor = path.dirname(root);
  while (true) {
    const install = path.join(ancestor, "node_modules");
    if (withinRoot(install, real)) {
      return install;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      return undefined;
    }
    ancestor = parent;
  }
}

export function createDeclarationInputBoundary(cwd: string) {
  const declared = path.resolve(cwd);
  const prefixes = [declared];
  if (fs.lstatSync(declared).isSymbolicLink()) {
    prefixes.push(path.resolve(path.dirname(declared), fs.readlinkSync(declared)));
  }
  prefixes.push(fs.realpathSync(declared));
  const root = fs.realpathSync.native(declared);
  // Runtimes differ on whether realpath preserves a case-only symlink target.
  // Translate only declared checkout spellings; never canonicalize outside candidates into scope.
  const resolve = (file: string) => {
    const absolute = path.resolve(declared, file);
    const prefix = prefixes.find((candidate) => withinRoot(candidate, absolute));
    return prefix ? path.resolve(root, path.relative(prefix, absolute)) : absolute;
  };
  return {
    root,
    resolve,
    assert(file: string) {
      const absolute = resolve(file);
      // Generated declaration IDs do not exist yet, but their source directory does.
      let existing = absolute;
      while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
        existing = path.dirname(existing);
      }
      const real = fs.realpathSync.native(existing);
      if (!withinRoot(root, absolute) || !withinRoot(root, real)) {
        // Hermetic declaration inputs must not inherit an ancestor install's exposed packages.
        const ancestorInstall = findAncestorInstall(root, real);
        const diagnosis = ancestorInstall
          ? `This checkout is nested inside another install at ${ancestorInstall}. Module resolution can read candidate manifests there even with a complete local install and a checkout-local final resolution. Repeating pnpm install will not isolate ancestor lookup. Provision a separate physical checkout outside ancestor node_modules installations, run pnpm install --frozen-lockfile there, and rerun declaration preparation and its dependent checks there. Do not modify the ancestor install or share its node_modules.`
          : `Keep declaration dependencies and compiler files physically inside ${root}; shared installs and external symlinks are unsupported. Inspect the reported path and dependency links; this error alone does not establish a missing or undeclared dependency.`;
        throw new Error(`Declaration input escapes checkout: ${absolute} -> ${real}. ${diagnosis}`);
      }
      return absolute;
    },
  };
}

type BuildInputs = { roots: Set<string>; inputs: Set<string> };
const completedBuilds = new WeakMap<BuildContext["options"], BuildInputs>();
type BuildOutputs = { files: Set<string>; producers: Set<Set<string>> };
const buildOutputs = new WeakMap<BuildContext["options"]["runBuild"], Map<string, BuildOutputs>>();

function declarationBuildOutputs(options: BuildContext["options"], root: string) {
  // tsdown creates one coordinator per build() invocation and preserves its
  // identity across workspace configs and formats. Never share facts across calls.
  let roots = buildOutputs.get(options.runBuild);
  if (!roots) {
    roots = new Map();
    buildOutputs.set(options.runBuild, roots);
  }
  let outputs = roots.get(root);
  if (!outputs) {
    outputs = { files: new Set(), producers: new Set() };
    roots.set(root, outputs);
  }
  return outputs;
}

function createDeclarationOutputPlugin(
  options: BuildContext["options"],
  boundary: ReturnType<typeof createDeclarationInputBoundary>,
  session: BuildOutputs,
): Plugin {
  const produced = new Set<string>();
  session.producers.add(produced);
  return {
    name: "openclaw-declaration-build-outputs",
    buildStart: {
      order: "pre",
      handler() {
        // A watch rebuild replaces only its producer's facts, retaining completed
        // siblings while another compiler in this invocation is still running.
        produced.clear();
        session.files.clear();
        for (const sibling of session.producers) {
          for (const file of sibling) {
            session.files.add(file);
          }
        }
      },
    },
    generateBundle: {
      order: "post",
      handler(output, bundle, isWrite) {
        if (!isWrite) {
          return;
        }
        const directory = boundary.resolve(
          output.dir ?? (output.file ? path.dirname(output.file) : options.outDir),
        );
        for (const file of Object.keys(bundle)) {
          const target = path.resolve(directory, file);
          if (!withinRoot(directory, target) || target === directory) {
            throw new Error(`Build output escapes its declared directory: ${file}`);
          }
          // Keep the producer's spelling. Resolving an output symlink here would
          // expand its exception into a different source directory.
          produced.add(target);
          session.files.add(target);
        }
      },
    },
  };
}

export function readDeclarationBuildInputs(options: BuildContext["options"]) {
  const result = completedBuilds.get(options);
  if (!result) {
    throw new Error("Missing successful native declaration compilation");
  }
  return result;
}

export function createDeclarationBoundaryHooks(existing?: UserConfig["hooks"]) {
  return async (hooks: BuildContext["hooks"]) => {
    if (typeof existing === "function") {
      await existing(hooks);
    } else if (existing) {
      hooks.addHooks(existing);
    }
    hooks.hook("build:prepare", prepareDeclarationBoundary);
  };
}

function prepareDeclarationBoundary({ options }: BuildContext) {
  const boundary = createDeclarationInputBoundary(options.cwd);
  const dts = options.dts
    ? {
        ...options.dts,
        cwd: boundary.assert(options.dts.cwd ?? options.cwd),
        generator: "tsgo" as const,
      }
    : undefined;
  if (dts) {
    options.dts = dts;
  }
  const outputs = declarationBuildOutputs(options, boundary.root);
  const inputOptions = options.inputOptions;
  options.inputOptions = async (input, format, context) => {
    let resolved = input;
    if (typeof inputOptions === "function") {
      resolved = (await inputOptions(input, format, context)) ?? input;
    } else if (inputOptions) {
      const { mergeConfig } = await import("tsdown/config");
      resolved = mergeConfig({ inputOptions: input }, { inputOptions })
        .inputOptions as typeof input;
    }
    let replacements = 0;
    const replace = async (value: PluginOption): Promise<PluginOption> => {
      const plugin = await value;
      if (Array.isArray(plugin)) {
        return Promise.all(plugin.map(replace));
      }
      if (
        !dts ||
        !plugin ||
        !("name" in plugin) ||
        plugin.name !== "rolldown-plugin-dts:generate"
      ) {
        return plugin;
      }
      replacements++;
      return createNativeDeclarationPlugin(options, dts, plugin, context.cjsDts, outputs.files);
    };
    resolved.plugins = await replace(resolved.plugins ?? []);
    resolved.plugins = [
      resolved.plugins,
      createDeclarationOutputPlugin(options, boundary, outputs),
    ];
    if (dts && (format === "es" || context.cjsDts) && replacements !== 1) {
      throw new Error(`Expected one declaration generator, found ${replacements}`);
    }
    return resolved;
  };
}

function createNativeDeclarationPlugin(
  options: BuildContext["options"],
  dts: Exclude<BuildContext["options"]["dts"], false>,
  upstream: Plugin,
  cjsDts: boolean,
  producedFiles: ReadonlySet<string>,
): Plugin {
  const boundary = createDeclarationInputBoundary(options.cwd);
  const declarationId = (file: string) =>
    file.replace(/\.([cm]?)[jt]sx?$/u, ".d.$1ts").replace(/\.json$/u, ".json.d.ts");
  const emitted = new Map<string, { code: string; map?: NativeDeclaration["map"] }>();
  const aliases = new Map<string, string>();
  const selected = new Set<string>();
  const emitOnly = cjsDts || dts.emitDtsOnly;
  return {
    name: "openclaw-native-declarations",
    // Preserve the bundler's public output naming contract for declaration chunks.
    outputOptions: upstream.outputOptions,
    buildStart: {
      order: "pre",
      async handler(input) {
        emitted.clear();
        aliases.clear();
        selected.clear();
        const entries = Array.isArray(input.input)
          ? input.input.map((file) => [undefined, file] as const)
          : Object.entries(input.input);
        for (const [name, file] of entries) {
          const source = boundary.assert(file);
          if (name) {
            aliases.set(source, name);
          }
        }
        const patterns = dts.entry
          ? Array.isArray(dts.entry)
            ? dts.entry
            : [dts.entry]
          : undefined;
        const roots = patterns
          ? fs
              .globSync(
                patterns.filter((pattern) => !pattern.startsWith("!")),
                {
                  cwd: dts.cwd,
                  exclude: patterns
                    .filter((pattern) => pattern.startsWith("!"))
                    .map((pattern) => pattern.slice(1)),
                },
              )
              .map((file) => boundary.assert(path.resolve(dts.cwd ?? boundary.root, file)))
          : entries.map(([, file]) => boundary.assert(file));
        roots.forEach((file) => selected.add(file));
        let config = dts.tsconfig ?? options.tsconfig;
        if (typeof config !== "string") {
          config = path.join(boundary.root, "tsconfig.json");
        }
        const { emitNativeDeclarations } = await import("./native-declaration-emitter.mts");
        const result = await emitNativeDeclarations({
          cwd: boundary.root,
          compilerRoot: boundary.root,
          assertInput: (file) => boundary.assert(file),
          configFile: boundary.assert(config),
          roots,
          compilerOptions: dts.compilerOptions,
          producedFiles,
        });
        for (const [source, declaration] of result.declarations) {
          emitted.set(declarationId(source), {
            code: declaration.code,
            ...(dts.sourcemap ? { map: declaration.map } : {}),
          });
        }
        const completed = completedBuilds.get(options) ?? {
          roots: new Set<string>(),
          inputs: new Set<string>(),
        };
        roots.forEach((file) => completed.roots.add(file));
        result.inputs.forEach((file) => completed.inputs.add(file));
        completedBuilds.set(options, completed);
      },
    },
    resolveId(id) {
      return emitted.has(id) ? id : undefined;
    },
    transform: {
      order: "pre",
      filter: {
        id: {
          include: [/\.([cm]?)[jt]sx?$/u, /\.json$/u],
          exclude: [/\.d\.[cm]?ts$/u, /[\\/]node_modules[\\/]/u],
        },
      },
      handler(_code, id) {
        if (!path.isAbsolute(id)) {
          return undefined;
        }
        const source = boundary.assert(id);
        if (selected.has(source)) {
          const name = aliases.get(source);
          this.emitFile({
            type: "chunk",
            id: declarationId(source),
            ...(name ? { name: `${name}.d` } : {}),
          });
        }
        return emitOnly ? (id.endsWith(".json") ? "{}" : "export {}") : undefined;
      },
    },
    load: {
      order: "pre",
      handler(id) {
        if (path.isAbsolute(id) && /\.(?:[cm]?ts|tsx|json)$/u.test(id)) {
          boundary.assert(id);
        }
        return emitted.get(id);
      },
    },
    generateBundle: emitOnly
      ? (_output, bundle) => {
          for (const [file, value] of Object.entries(bundle)) {
            if (value.type === "chunk" && !/\.d\.[cm]?ts(?:\.map)?$/u.test(file)) {
              delete bundle[file];
            }
          }
        }
      : undefined,
  };
}
