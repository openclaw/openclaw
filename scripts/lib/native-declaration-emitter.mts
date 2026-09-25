import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { CompilerInputSnapshot } from "./compiler-input-snapshot.mts";
import { toErrorObject } from "./error-format.mts";
import { resolveRepoToolBinPath } from "./local-check-runtime.mts";
import { hasUnjoinedWork, runManagedCommand } from "./managed-child-process.mts";
import { createNativeDeclarationPolicy } from "./native-declaration-policy.mts";
import { readNativeTypeScriptConfig } from "./native-typescript-config.mts";
import {
  collectNativeTypeScriptDiagnostics,
  formatNativeTypeScriptDiagnostics,
} from "./native-typescript-diagnostics.mts";
import {
  createNativeTypeScriptProject,
  resolveInstalledNativeTypeScriptCompiler,
} from "./native-typescript.mts";

export type NativeDeclaration = {
  code: string;
  map: { version: number; file: string; sources: string[]; names: string[]; mappings: string };
};

type DeclarationEmitOptions = {
  cwd: string;
  configFile: string;
  roots: string[];
  compilerOptions?: Record<string, unknown>;
  diagnostics?: "declarations" | "all";
  compilerRoot?: string;
  assertInput?: (file: string) => string;
  producedFiles?: ReadonlySet<string>;
};

/** Emit once and admit the compiler's actual membership before exposing declarations. */
export async function emitNativeDeclarations({
  cwd,
  configFile,
  roots,
  compilerOptions,
  diagnostics = "all",
  compilerRoot,
  assertInput,
  producedFiles,
}: DeclarationEmitOptions) {
  const root = path.resolve(cwd);
  const admit = assertInput ?? ((file: string) => path.resolve(root, file));
  const inputs = new Set<string>();
  const declarations = new Map<string, NativeDeclaration>();
  if (!roots.length) {
    return { inputs: [], declarations };
  }
  const admittedConfig = admit(configFile);
  const artifacts = admit(path.join(root, ".artifacts"));
  fs.mkdirSync(artifacts, { recursive: true });
  const stage = fs.mkdtempSync(path.join(artifacts, "native-declarations-"));
  let joined = true;
  try {
    const output = path.join(stage, "out");
    const config = path.join(stage, "tsconfig.json");
    const buildInfo = path.join(stage, "compiler.tsbuildinfo");
    const compiler =
      compilerRoot === undefined
        ? resolveInstalledNativeTypeScriptCompiler()
        : {
            executable: resolveRepoToolBinPath("tsgo", { cwd: compilerRoot }),
            packageJson: createRequire(path.join(compilerRoot, "package.json")).resolve(
              "typescript/package.json",
            ),
          };
    const binary = compiler.executable;
    const args = [
      "-p",
      config,
      "--pretty",
      "false",
      "--locale",
      "en",
      ...(assertInput ? ["--traceResolution"] : []),
      ...(diagnostics === "declarations" ? ["--noCheck"] : []),
    ];
    const snapshot = () =>
      new CompilerInputSnapshot(root, {
        toolchainFiles: [binary],
        generatorInputs: [],
        assertInput: admit,
      });
    const before = snapshot();
    before.signature(admittedConfig, args, [], stage);
    const preparationStartedAt = Date.now();
    // Parse overrides beside the original config so native inheritance and
    // ${configDir} substitution keep their project-relative meaning.
    const contextConfig = path.join(
      path.dirname(admittedConfig),
      `${path.basename(stage)}.tsconfig.json`,
    );
    const configured = readNativeTypeScriptConfig({
      cwd: root,
      configFileName: contextConfig,
      readFile: (file) =>
        path.resolve(file) === contextConfig
          ? JSON.stringify({ extends: admittedConfig, compilerOptions })
          : fs.readFileSync(admit(file), "utf8"),
    });
    const resolutionOptions: Record<string, unknown> = {
      rootDirs: configured.options.rootDirs,
      typeRoots: configured.options.typeRoots,
    };
    if (configured.options.paths !== undefined) {
      const { paths, pathsBasePath } = configured.options;
      if (
        !paths ||
        typeof paths !== "object" ||
        Array.isArray(paths) ||
        typeof pathsBasePath !== "string"
      ) {
        throw new Error("Invalid native declaration paths");
      }
      resolutionOptions.paths = Object.fromEntries(
        Object.entries(paths).map(([name, targets]) => {
          if (
            !Array.isArray(targets) ||
            !targets.every((target): target is string => typeof target === "string")
          ) {
            throw new Error("Invalid native declaration path targets");
          }
          return [name, targets.map((target) => path.resolve(pathsBasePath, target))];
        }),
      );
    }
    // Ambient declarations have no import edge from the selected entries. Retain
    // their configured roots without emitting or checking unrelated source roots.
    const canonicalRoots = [
      ...new Set([
        ...roots.map((file) => admit(file)),
        ...configured.fileNames.filter((file) => /\.d\.[cm]?ts$/u.test(file)).map(admit),
      ]),
    ];
    const preparedConfig = {
      extends: admittedConfig,
      files: canonicalRoots,
      include: [],
      exclude: [],
      compilerOptions: {
        ...compilerOptions,
        ...resolutionOptions,
        rootDir: root,
        outDir: output,
        declarationDir: output,
        declaration: true,
        declarationMap: true,
        emitDeclarationOnly: true,
        noEmit: false,
        noEmitOnError: true,
        noCheck: false,
        incremental: true,
        tsBuildInfoFile: buildInfo,
      },
    };
    fs.writeFileSync(config, JSON.stringify(preparedConfig));
    const policy = assertInput
      ? createNativeDeclarationPolicy(root, config, admittedConfig, admit, inputs)
      : undefined;
    if (policy) {
      fs.writeFileSync(
        config,
        JSON.stringify({
          ...preparedConfig,
          compilerOptions: { ...preparedConfig.compilerOptions, typeRoots: policy.typeRoots },
        }),
      );
    }
    // The original config fence starts before materialization. The owned staged
    // config gets its own later fence so its creation is not an input mutation.
    before.signature(config, args, [], stage);
    const compilationStartedAt = Date.now();
    if (diagnostics === "declarations") {
      using native = createNativeTypeScriptProject({ cwd: root, configFileName: config });
      const errors = collectNativeTypeScriptDiagnostics(native.project, {
        includeSemantic: false,
        includeDeclaration: true,
      });
      if (errors.length) {
        throw new Error(formatNativeTypeScriptDiagnostics(errors));
      }
      native.project.program.getSourceFileNames().forEach((file) => inputs.add(admit(file)));
    }
    let traceFailure: Error | undefined;
    let reportingDiagnostics = false;
    const exit = await runManagedCommand({
      bin: binary,
      args,
      cwd: root,
      ...(policy
        ? {
            stdio: ["ignore", "pipe", "inherit"] as const,
            onReady(child: import("node:child_process").ChildProcess) {
              const lines = createInterface({ input: child.stdout! });
              lines.on("line", (line) => {
                reportingDiagnostics ||= /\b(?:error|warning) TS\d+:/u.test(line);
                if (reportingDiagnostics) {
                  process.stdout.write(`${line}\n`);
                }
                try {
                  policy.recordTrace(line);
                } catch (error) {
                  traceFailure ??= toErrorObject(
                    error,
                    "Native declaration resolution trace failed",
                  );
                }
              });
            },
          }
        : {}),
    });
    if (traceFailure) {
      throw traceFailure;
    }
    if (!fs.existsSync(buildInfo)) {
      throw new Error(`Native declaration emit failed without compiler membership (exit ${exit})`);
    }
    const receipt: { fileNames?: unknown; fileInfos?: unknown; packageJsons?: unknown } =
      JSON.parse(fs.readFileSync(buildInfo, "utf8"));
    if (
      !Array.isArray(receipt.fileNames) ||
      !receipt.fileNames.every((file): file is string => typeof file === "string") ||
      !Array.isArray(receipt.fileInfos) ||
      receipt.fileInfos.length > receipt.fileNames.length ||
      (receipt.packageJsons !== undefined &&
        (!Array.isArray(receipt.packageJsons) ||
          !receipt.packageJsons.every((file): file is string => typeof file === "string")))
    ) {
      throw new Error("Invalid native declaration compiler membership");
    }
    const compilerPackage = admit(compiler.packageJson);
    const platformPackage = admit(
      createRequire(compilerPackage).resolve(
        `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
      ),
    );
    const libraryRoot = path.join(path.dirname(platformPackage), "lib");
    const compilerSources = receipt.fileNames
      .slice(0, receipt.fileInfos.length)
      .map((file) =>
        admit(
          path.resolve(file.startsWith("lib.") && !file.includes("/") ? libraryRoot : stage, file),
        ),
      );
    compilerSources.forEach((file) => inputs.add(file));
    for (const file of receipt.packageJsons ?? []) {
      inputs.add(admit(path.resolve(stage, file)));
    }
    for (const entry of canonicalRoots) {
      if (!inputs.has(entry)) {
        throw new Error(`Incomplete native declaration compiler membership: ${entry}`);
      }
    }
    if (exit !== 0) {
      throw new Error(`Native declaration emit failed with exit ${exit}`);
    }
    const outputs = fs.existsSync(output)
      ? fs.readdirSync(output, { recursive: true, encoding: "utf8" })
      : [];
    for (const entry of outputs) {
      if (!/\.d\.[cm]?ts$/u.test(entry)) {
        continue;
      }
      const mapFile = path.join(output, `${entry}.map`);
      const map: NativeDeclaration["map"] & { sourceRoot?: string } = JSON.parse(
        fs.readFileSync(mapFile, "utf8"),
      );
      if (
        !Array.isArray(map.sources) ||
        map.sources.length !== 1 ||
        typeof map.sources[0] !== "string" ||
        map.sourceRoot
      ) {
        throw new Error(`Ambiguous native declaration source owner: ${entry}`);
      }
      const source = admit(path.resolve(path.dirname(mapFile), map.sources[0]));
      if (!inputs.has(source) || declarations.has(source)) {
        throw new Error(`Invalid native declaration source owner: ${source}`);
      }
      const code = fs
        .readFileSync(mapFile.slice(0, -4), "utf8")
        .replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gmu, "");
      declarations.set(source, { code, map: { ...map, sources: [source] } });
    }
    // Native symlink discovery considers JSON source members even though
    // declaration-only emission produces no declaration map for them.
    policy?.admitEmissionSources([
      ...declarations.keys(),
      ...compilerSources.filter((file) => file.endsWith(".json")),
    ]);
    const after = snapshot();
    after.seal(
      admittedConfig,
      args,
      [...inputs],
      before,
      preparationStartedAt,
      stage,
      producedFiles,
    );
    after.seal(config, args, [], before, compilationStartedAt, stage, producedFiles);
    return { inputs: [...inputs].toSorted(), declarations };
  } catch (error) {
    joined = !hasUnjoinedWork(error);
    throw error;
  } finally {
    if (joined) {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
}
