import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve as resolvePackageImport } from "import-meta-resolve";
import ts from "typescript";
import { visitModuleSpecifiers } from "./guard-inventory-utils.mjs";

export function collectRuntimeImportClosure(
  root: string,
  inputs: readonly string[],
  {
    includeDynamicImports = false,
    validatePackages = false,
  }: { includeDynamicImports?: boolean; validatePackages?: boolean } = {},
): string[] {
  const { config } = ts.readConfigFile(join(root, "tsconfig.json"), (file) =>
    ts.sys.readFile(file),
  );
  const { options } = ts.convertCompilerOptionsFromJson(config.compilerOptions, root);
  const runtimeHost = {
    ...ts.sys,
    getCurrentDirectory: () => root,
    fileExists: (file: string) => !/\.d\.[cm]?ts$/.test(file) && ts.sys.fileExists(file),
  };
  const resolutionCache = ts.createModuleResolutionCache(root, (file) => file, options);
  const closure = new Set(inputs.map((file) => file.split(sep).join("/")));
  for (const file of closure) {
    if (!/\.[cm]?[jt]s$/.test(file)) {
      continue;
    }
    // Preserve Node's erased-type semantics without loading platform-specific modules.
    const { outputText } = ts.transpileModule(readFileSync(resolve(root, file), "utf8"), {
      fileName: file,
      compilerOptions: { ...options, module: ts.ModuleKind.ESNext },
    });
    const source = ts.createSourceFile(file, outputText, ts.ScriptTarget.Latest, true);
    visitModuleSpecifiers(
      ts,
      source,
      ({ kind, specifier }: { kind: string; specifier: string }) => {
        if (kind === "dynamic-import" && !includeDynamicImports) {
          return;
        }
        const dependency = ts.resolveModuleName(
          specifier,
          resolve(root, file),
          options,
          runtimeHost,
          resolutionCache,
        ).resolvedModule;
        if (!dependency && specifier.startsWith(".")) {
          throw new Error(`${file}: unresolved ${specifier}`);
        }
        if (dependency && !dependency.isExternalLibraryImport) {
          closure.add(relative(root, dependency.resolvedFileName).split(sep).join("/"));
        } else if (validatePackages && !isBuiltin(specifier)) {
          const packageName = specifier
            .split("/")
            .slice(0, specifier.startsWith("@") ? 2 : 1)
            .join("/");
          if (!existsSync(join(root, "node_modules", packageName, "package.json"))) {
            throw new Error(`${file}: unpinned package ${specifier}`);
          }
          // TypeScript declarations do not prove that Node can import an export subpath.
          resolvePackageImport(specifier, pathToFileURL(resolve(root, file)).href);
        }
      },
      { includeCommonJs: includeDynamicImports },
    );
  }
  return [...closure].toSorted();
}
