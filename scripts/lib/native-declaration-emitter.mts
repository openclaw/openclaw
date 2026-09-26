import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { API, EmitOnly, type EmitOutputFile } from "typescript/unstable/async";
import { CompilerInputSnapshot } from "./compiler-input-snapshot.mts";
import { createDeclarationInputBoundary, resolveRepoToolBinPath } from "./local-check-runtime.mts";
import { createDeclarationFileSystem } from "./native-declaration-filesystem.mts";
import {
  collectNativeTypeScriptDiagnosticsAsync,
  formatNativeTypeScriptDiagnostics,
} from "./native-typescript-diagnostics.mts";
import { nativeTypeScriptToolchainFiles } from "./native-typescript-toolchain.mts";
import { resolveInstalledNativeTypeScriptCompiler } from "./native-typescript.mts";

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
  producedFiles?: ReadonlySet<string>;
  emit?: boolean;
};

/** Compile behind one filesystem boundary; callers publish only the sealed result. */
export async function compileNativeProject({
  cwd,
  configFile,
  roots,
  compilerOptions,
  diagnostics = "all",
  compilerRoot,
  assertInput,
  producedFiles,
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
    const compiler =
      compilerRoot === undefined
        ? resolveInstalledNativeTypeScriptCompiler()
        : {
            executable: resolveRepoToolBinPath("tsgo", { cwd: compilerRoot }),
            packageJson: createRequire(path.join(compilerRoot, "package.json")).resolve(
              "typescript/package.json",
            ),
          };
    // The toolchain owner admits the normalized path while Windows launches
    // retain the native executable's extended-length spelling.
    const binary = compiler.executable;
    const compilerPackage = admit(compiler.packageJson);
    const toolchainFiles = nativeTypeScriptToolchainFiles(compilerPackage, admit);
    const args = [
      "bounded-native-api",
      JSON.stringify({ roots, compilerOptions, diagnostics, emit }),
    ];
    const snapshot = () =>
      new CompilerInputSnapshot(root, {
        toolchainFiles,
        generatorInputs: [],
        assertInput: assertInput ? admit : undefined,
      });
    const before = snapshot();
    before.signature(admittedConfig, args, [], stage);
    const preparationStartedAt = Date.now();
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
    if (manifestText === null && assertInput) {
      throw new Error(`Missing declaration package manifest: ${manifestFile}`);
    }
    if (manifestText !== null) {
      const manifest: unknown = JSON.parse(manifestText);
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error(`Invalid declaration package manifest: ${manifestFile}`);
      }
    }
    api = new API({ cwd: root, tsserverPath: binary, fs: view.filesystem });
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
          // Declaration-only callers already validate the structural diagnostic
          // set below; emission must not add a second semantic check.
          noEmitOnError: diagnostics === "all",
          noCheck: false,
        },
      }),
    );
    const nativeSnapshot = await api.updateSnapshot({
      openProjects: [config],
      fileChanges: { changed: [config] },
    });
    view.assertValid();
    const project = nativeSnapshot.getProject(config);
    if (!project) {
      throw new Error(`Native TypeScript did not open ${config}`);
    }
    const errors = await collectNativeTypeScriptDiagnosticsAsync(project, {
      includeSemantic: diagnostics === "all",
      includeDeclaration: emit,
    });
    view.assertValid();
    if (errors.length) {
      throw new Error(formatNativeTypeScriptDiagnostics(errors));
    }
    const outputFiles = new Map<string, EmitOutputFile>();
    if (emit) {
      const result = await project.program.emitToString(EmitOnly.OnlyDts);
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
      view.inputs.add(admit(file));
    }
    view.assertValid();
    await api.close();
    api = undefined;
    const consumedInputs = view.inputs;
    const inputs = [...consumedInputs].toSorted();
    if (canonicalRoots.some((file) => !consumedInputs.has(file))) {
      throw new Error("Incomplete native compiler source membership");
    }
    const after = snapshot();
    after.seal(admittedConfig, args, inputs, before, preparationStartedAt, stage, producedFiles);
    return { inputs, outputFiles };
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
