import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { API, EmitOutputFile } from "typescript/async";
import { createDeclarationInputBoundary, resolveRepoToolBinPath } from "./local-check-runtime.mts";
import { createDeclarationFileSystem } from "./native-declaration-filesystem.mts";
import {
  collectNativeTypeScriptDiagnosticsAsync,
  formatNativeTypeScriptDiagnostics,
} from "./native-typescript-diagnostics.mts";
import { nativeTypeScriptToolchainFiles } from "./native-typescript-toolchain.mts";
import { resolveInstalledNativeTypeScriptCompiler } from "./native-typescript.mts";
import { isRecord } from "./record-shared.mjs";

export type NativeDeclaration = {
  code: string;
  map: { version: number; file: string; sources: string[]; names: string[]; mappings: string };
};

type NativeCompilationOptions = {
  cwd: string;
  configFile: string;
  roots?: string[];
  compilerOptions?: Record<string, unknown>;
  diagnostics?: "declarations" | "all";
  compilerRoot?: string;
  assertInput?: (file: string) => string;
  emit?: boolean;
};

type NativeApiModule = typeof import("typescript/async");
type NativeFsModule = typeof import("typescript/fs");
type NativeCompiler = {
  executable: string;
  packageJson: string;
  module: NativeApiModule;
  fakeStat: NativeFsModule["serverFS"]["fakeStat"] | undefined;
};

function resolveTypeScriptPackage(compilerRoot: string) {
  try {
    return createRequire(path.join(compilerRoot, "package.json")).resolve(
      "typescript/package.json",
    );
  } catch (error) {
    if (isRecord(error) && error.code === "MODULE_NOT_FOUND") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Pair a compiler root's executable with that package's own API client; the
 * client and server speak one release's protocol and filesystem contract.
 */
async function resolveNativeCompiler(compilerRoot: string | undefined): Promise<NativeCompiler> {
  const packageJson = compilerRoot && resolveTypeScriptPackage(compilerRoot);
  if (compilerRoot && packageJson) {
    const manifest: unknown = JSON.parse(fs.readFileSync(packageJson, "utf8"));
    const exports = isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports : {};
    // Resolve like Node's ESM loader so a linked package keeps one module instance;
    // filesystem sentinels are identity-checked by the client that loaded them.
    const load = (entry: unknown) => {
      if (typeof entry !== "string") {
        return undefined;
      }
      const compilerModuleUrl = pathToFileURL(
        fs.realpathSync(path.join(path.dirname(packageJson), entry)),
      ).href;
      return import(compilerModuleUrl);
    };
    // TypeScript 7 previews before 2026-10 published the API under unstable/.
    const entry = exports["./async"] ?? exports["./unstable/async"];
    if (typeof entry === "string") {
      const module: NativeApiModule = await load(entry);
      const fsModule: Partial<NativeFsModule> | undefined = await load(
        exports["./fs"] ?? exports["./unstable/fs"],
      );
      return {
        executable: resolveRepoToolBinPath("tsgo", { cwd: compilerRoot }),
        packageJson,
        module,
        fakeStat: fsModule?.serverFS?.fakeStat,
      };
    }
    if (entry !== undefined) {
      throw new Error(`Unsupported native TypeScript API export: ${packageJson}`);
    }
  }
  // Roots without TypeScript or with TypeScript 6 predate the native API; they keep
  // the installed compiler.
  const [module, fsModule] = await Promise.all([
    import("typescript/async"),
    import("typescript/fs"),
  ]);
  return {
    ...resolveInstalledNativeTypeScriptCompiler(),
    module,
    fakeStat: fsModule.serverFS.fakeStat,
  };
}

/** Compile behind one filesystem boundary; callers publish only successful results. */
export async function compileNativeProject({
  cwd,
  configFile,
  roots,
  compilerOptions,
  diagnostics = "all",
  compilerRoot,
  assertInput,
  emit = true,
}: NativeCompilationOptions) {
  // Build/lint callers require a checkout boundary. SDK revision rendering
  // intentionally uses its installed compiler and linked dependency snapshots.
  const boundary = assertInput ? createDeclarationInputBoundary(cwd) : undefined;
  const root = boundary?.root ?? path.resolve(cwd);
  const admit = (file: string) => {
    const accepted = boundary?.assert(file) ?? path.resolve(root, file);
    return assertInput ? assertInput(accepted) : accepted;
  };
  const admittedConfig = admit(configFile);
  const artifacts = admit(path.join(root, ".artifacts"));
  fs.mkdirSync(artifacts, { recursive: true });
  const stage = fs.mkdtempSync(path.join(artifacts, "native-declarations-"));
  let api: API | undefined;
  let view: ReturnType<typeof createDeclarationFileSystem> | undefined;
  try {
    const compiler = await resolveNativeCompiler(compilerRoot);
    // The toolchain owner admits the normalized path while Windows launches
    // retain the native executable's extended-length spelling.
    const binary = compiler.executable;
    const compilerPackage = admit(compiler.packageJson);
    nativeTypeScriptToolchainFiles(compilerPackage, admit);
    // Keep the private config beside its source so relative overrides, inherited
    // paths and ${configDir} retain the compiler's own interpretation.
    const config = path.join(path.dirname(admittedConfig), `${path.basename(stage)}.tsconfig.json`);
    const virtualFiles = new Map([
      [config, JSON.stringify({ extends: admittedConfig, compilerOptions })],
    ]);
    view = createDeclarationFileSystem(root, assertInput ? admit : undefined, virtualFiles);
    const manifestFile = admit(path.join(root, "package.json"));
    const manifestText = view.filesystem.readFile(manifestFile);
    view.assertValid();
    if (manifestText === undefined && assertInput) {
      throw new Error(`Missing declaration package manifest: ${manifestFile}`);
    }
    if (manifestText !== undefined) {
      const manifest: unknown = JSON.parse(manifestText);
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error(`Invalid declaration package manifest: ${manifestFile}`);
      }
    }
    api = new compiler.module.API({
      cwd: root,
      tsserverPath: binary,
      // Earlier clients forward only the callbacks they know and ignore stat.
      fs:
        compiler.fakeStat === undefined
          ? view.filesystem
          : { ...view.filesystem, stat: compiler.fakeStat },
    });
    const configured = await api.parseConfigFile(config);
    view.assertValid();
    const typeRoots = configured.options.typeRoots?.map(admit);
    const canonicalRoots = [
      ...new Set(
        roots === undefined
          ? configured.fileNames.map(admit)
          : [
              ...roots.map(admit),
              ...configured.fileNames.filter((file) => /\.d\.[cm]?ts$/u.test(file)).map(admit),
            ],
      ),
    ];
    const output =
      typeof compilerOptions?.outDir === "string"
        ? admit(path.resolve(root, compilerOptions.outDir))
        : path.join(stage, "out");
    virtualFiles.set(
      config,
      JSON.stringify({
        extends: admittedConfig,
        files: canonicalRoots,
        include: [],
        exclude: [],
        compilerOptions: {
          ...compilerOptions,
          ...(typeRoots ? { typeRoots } : {}),
          rootDir: compilerOptions?.rootDir ?? configured.options.rootDir ?? root,
          outDir: output,
          declarationDir: output,
          declaration: true,
          emitDeclarationOnly: emit,
          noEmit: !emit,
          // Validate the requested diagnostics below, then use the in-memory
          // emit result for declaration errors without a second preflight.
          noEmitOnError: false,
          noCheck: false,
          // Parallel emit can give shared inferred properties different readonly modifiers.
          ...(emit ? { singleThreaded: true } : {}),
        },
      }),
    );
    const nativeSnapshot = await api.createSnapshot({
      openProjects: [config],
      fileNotifications: { changed: [config] },
      ensurePrograms: true,
    });
    view.assertValid();
    const project = nativeSnapshot.getConfiguredProject(config);
    if (!project) {
      throw new Error(`Native TypeScript did not open ${config}`);
    }
    const errors = await collectNativeTypeScriptDiagnosticsAsync(project, {
      includeSemantic: diagnostics === "all",
    });
    view.assertValid();
    if (errors.length) {
      throw new Error(formatNativeTypeScriptDiagnostics(errors));
    }
    const outputFiles = new Map<string, EmitOutputFile>();
    if (emit) {
      const result = await project.program.emitToString(compiler.module.EmitOnly.OnlyDts);
      view.assertValid();
      if (result.emitSkipped || result.diagnostics.length) {
        throw new Error(
          result.diagnostics.length
            ? formatNativeTypeScriptDiagnostics(result.diagnostics)
            : "Native declaration emission was skipped",
        );
      }
      for (const [file, contents] of result.outputFiles) {
        const accepted = admit(file);
        const relative = path.relative(output, accepted);
        if (
          relative === "" ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          throw new Error(`Native declaration output escapes its directory: ${file}`);
        }
        if (contents.sourceFileName) {
          admit(contents.sourceFileName);
        }
        outputFiles.set(accepted, contents);
      }
    }
    for (const file of await project.program.getSourceFileNames()) {
      const accepted = admit(file);
      if (assertInput && !view.inputs.has(accepted)) {
        throw new Error(
          `Native compiler source was not observed through its filesystem: ${accepted}`,
        );
      }
      view.inputs.add(accepted);
    }
    view.assertValid();
    await api.close();
    api = undefined;
    const consumedInputs = view.inputs;
    const inputs = [...consumedInputs].toSorted();
    if (canonicalRoots.some((file) => !consumedInputs.has(file))) {
      throw new Error("Incomplete native compiler source membership");
    }
    return { inputs, outputFiles, lookups: view.getLookups() };
  } catch (error) {
    view?.assertValid();
    throw error;
  } finally {
    try {
      await api?.close();
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
}

/** Adapt the shared compiler's in-memory declarations to tsdown source ownership. */
export async function emitNativeDeclarations(
  options: Omit<NativeCompilationOptions, "roots" | "emit"> & { roots: string[] },
) {
  const declarations = new Map<string, NativeDeclaration>();
  if (!options.roots.length) {
    return { inputs: [], declarations };
  }
  const compilation = await compileNativeProject({
    ...options,
    compilerOptions: {
      ...options.compilerOptions,
      rootDir: fs.realpathSync.native(options.cwd),
      declarationMap: true,
    },
  });
  const inputs = new Set(compilation.inputs);
  for (const [file, output] of compilation.outputFiles) {
    if (!/\.d\.[cm]?ts$/u.test(file)) {
      continue;
    }
    const mapOutput = compilation.outputFiles.get(`${file}.map`);
    if (!mapOutput) {
      throw new Error(`Missing native declaration source map: ${file}`);
    }
    const map: NativeDeclaration["map"] & { sourceRoot?: string } = JSON.parse(mapOutput.text);
    if (
      !Array.isArray(map.sources) ||
      map.sources.length !== 1 ||
      typeof map.sources[0] !== "string" ||
      map.sourceRoot
    ) {
      throw new Error(`Ambiguous native declaration source owner: ${file}`);
    }
    const source = path.resolve(path.dirname(file), map.sources[0]);
    if (!inputs.has(source) || declarations.has(source)) {
      throw new Error(`Invalid native declaration source owner: ${source}`);
    }
    const code = output.text.replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gmu, "");
    declarations.set(source, { code, map: { ...map, sources: [source] } });
  }
  return { inputs: compilation.inputs, declarations };
}
