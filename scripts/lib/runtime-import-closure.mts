import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { transformSync } from "esbuild";
import { resolve as resolvePackageImport } from "import-meta-resolve";
import * as ts from "typescript/unstable/ast";
import { readNativeTypeScriptConfig } from "./native-typescript-config.mts";
import {
  createNativeTypeScriptParser,
  createNativeTypeScriptProject,
} from "./native-typescript.mts";
import { visitModuleSpecifiers } from "./ts-guard-utils.mts";

const sourceFilePattern = /\.[cm]?[jt]sx?$/;

type ImportReference = {
  kind: string;
  specifier: string;
  resolutionMode?: "import" | "require";
};
type RuntimeImportGraphOptions = {
  includeDynamicImports?: boolean;
  includeCommonJs?: boolean;
  includeTypeOnlyImports?: boolean;
  includeImportMetaUrl?: boolean;
  sourceImports?: boolean;
  normalizeSpecifier?: (specifier: string) => string;
};

function isTypeOnlyReference(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    return Boolean(
      clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
      (clause &&
        !clause.name &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((binding) => binding.isTypeOnly)),
    );
  }
  if (ts.isExportDeclaration(node)) {
    return Boolean(
      node.isTypeOnly ||
      (node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((binding) => binding.isTypeOnly)),
    );
  }
  return ts.isImportEqualsDeclaration(node) && node.isTypeOnly;
}

function resolutionMode(node: ts.Node, kind: string): "import" | "require" | undefined {
  const attributes =
    ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportTypeNode(node)
      ? node.attributes?.attributes
      : undefined;
  const attribute = attributes?.find((item) => item.name.text === "resolution-mode");
  if (
    attribute &&
    ts.isStringLiteral(attribute.value) &&
    (attribute.value.text === "import" || attribute.value.text === "require")
  ) {
    return attribute.value.text;
  }
  if (kind === "commonjs-require") {
    return "require";
  }
  return kind === "dynamic-import" && ts.isCallExpression(node) ? "import" : undefined;
}

/** Resolve selected runtime edges with the native compiler's config and package rules. */
export function createRuntimeImportGraph(
  rootPath: string,
  inputs: readonly string[],
  {
    includeDynamicImports = false,
    includeCommonJs = includeDynamicImports,
    includeTypeOnlyImports = false,
    includeImportMetaUrl = false,
    sourceImports = false,
    normalizeSpecifier = (specifier) => specifier,
  }: RuntimeImportGraphOptions = {},
) {
  const root = resolve(rootPath);
  const configFileName = join(root, ".openclaw-runtime-imports.tsconfig.json");
  const roots = new Set(
    inputs.filter((file) => sourceFilePattern.test(file)).map((file) => resolve(root, file)),
  );
  const configText = () =>
    JSON.stringify({
      extends: join(root, "tsconfig.json"),
      compilerOptions: { allowJs: true, noLib: true, types: [] },
      files: [...roots],
      include: [],
    });
  const { options } = readNativeTypeScriptConfig({
    cwd: root,
    configFileName,
    readFile: (file) =>
      resolve(file) === configFileName ? configText() : readFileSync(file, "utf8"),
  });
  if (!sourceImports && (options.emitDecoratorMetadata || options.importHelpers)) {
    throw new Error(
      "Runtime import capture does not support decorator metadata or imported emit helpers",
    );
  }
  const jsx =
    typeof options.jsx === "number"
      ? [undefined, "preserve", "react", "react-native", "react-jsx", "react-jsxdev"][options.jsx]
      : options.jsx;
  const transformConfig = JSON.stringify({
    compilerOptions: {
      experimentalDecorators: options.experimentalDecorators,
      jsx,
      jsxFactory: options.jsxFactory,
      jsxFragmentFactory: options.jsxFragmentFactory,
      jsxImportSource: options.jsxImportSource,
      useDefineForClassFields: options.useDefineForClassFields,
      verbatimModuleSyntax: options.verbatimModuleSyntax,
    },
  });
  const parser = createNativeTypeScriptParser({ cwd: root });
  const references = new Map<string, ImportReference[]>();
  const isDeclaration = (file: string) => /\.d\.[cm]?ts$/.test(file);
  let session;
  try {
    session = createNativeTypeScriptProject({
      cwd: root,
      configFileName,
      fs: {
        fileExists: (file) =>
          resolve(file) === configFileName
            ? true
            : !sourceImports && isDeclaration(file)
              ? false
              : undefined,
        readFile(file) {
          if (resolve(file) === configFileName) {
            return configText();
          }
          if (isDeclaration(file)) {
            return sourceImports ? undefined : null;
          }
          if (!/\.[cm]?[jt]sx?$/.test(file) || file.split(/[\\/]/).includes("node_modules")) {
            return undefined;
          }
          if (!existsSync(file)) {
            return null;
          }
          const text = readFileSync(file, "utf8");
          // Source guards discard explicitly type-only bindings. Runtime capture follows
          // emitted code, including side effects retained by verbatimModuleSyntax.
          const sourceText = sourceImports
            ? text
            : transformSync(text, {
                sourcefile: file,
                loader: /\.[cm]?tsx?$/.test(file)
                  ? file.endsWith("x")
                    ? "tsx"
                    : "ts"
                  : file.endsWith("x")
                    ? "jsx"
                    : "js",
                format: "esm",
                target: "esnext",
                tsconfigRaw: transformConfig,
              }).code;
          const source = parser.parseSourceFile(file, sourceText);
          const selected: ImportReference[] = [];
          visitModuleSpecifiers(
            source,
            ({ kind, specifier, node }: ImportReference & { node: ts.Node }) => {
              if (
                (kind === "dynamic-import" && !includeDynamicImports) ||
                (sourceImports && !includeTypeOnlyImports && isTypeOnlyReference(node)) ||
                isBuiltin(specifier)
              ) {
                return;
              }
              selected.push({
                kind,
                specifier: normalizeSpecifier(specifier),
                resolutionMode: resolutionMode(node, kind),
              });
            },
            { includeCommonJs, includeImportTypes: includeTypeOnlyImports, includeImportMetaUrl },
          );
          references.set(resolve(file), selected);
          // A require literal has no checker symbol. Project each selected edge into
          // an import at the original path, retaining NodeNext's require conditions.
          return selected
            .map(
              ({ specifier, resolutionMode: mode }, index) =>
                `import ${mode ? "type " : ""}* as edge${index} from ${JSON.stringify(specifier)}${mode ? ` with { "resolution-mode": ${JSON.stringify(mode)} }` : ""};`,
            )
            .concat("export {};")
            .join("\n");
        },
      },
    });
  } catch (error) {
    session?.close();
    parser.close();
    throw error;
  }
  let { project, snapshot } = session;
  const close = () => {
    session.close();
    parser.close();
  };
  return {
    compilerOptions: project.compilerOptions,
    dependencies(file: string) {
      const absolute = resolve(root, file);
      let source = project.program.getSourceFile(absolute);
      if (!source && sourceFilePattern.test(absolute) && !roots.has(absolute)) {
        // Exact runtime files and computed generator inputs can be outside the
        // compiler's discovered graph. Admit them into this same projection.
        roots.add(absolute);
        const updated = session.api.updateSnapshot({ fileChanges: { changed: [configFileName] } });
        const nextProject = updated.getProject(configFileName);
        if (!nextProject) {
          throw new Error(`Native TypeScript did not reopen runtime graph ${configFileName}`);
        }
        snapshot.dispose();
        snapshot = updated;
        project = nextProject;
        source = project.program.getSourceFile(absolute);
      }
      if (!source) {
        throw new Error(`Native TypeScript did not load runtime source ${absolute}`);
      }
      const selected = references.get(absolute) ?? [];
      const imports = source.statements.filter(ts.isImportDeclaration);
      const symbols = project.checker.getSymbolAtLocation(
        imports.map((node) => node.moduleSpecifier),
      );
      return selected.map((reference, index) => {
        const declaration = symbols[index]?.declarations.find(
          (candidate) => candidate.kind === ts.SyntaxKind.SourceFile,
        );
        const resolvedFileName = declaration?.resolve(project)?.getSourceFile().fileName;
        return Object.assign({}, reference, {
          resolvedFileName,
          isExternalLibraryImport: resolvedFileName
            ? project.program.getSourceFileMetadata(resolvedFileName)?.isFromExternalLibrary ===
              true
            : false,
        });
      });
    },
    close,
    [Symbol.dispose]: close,
  };
}

export function collectRuntimeImportClosure(
  root: string,
  inputs: readonly string[],
  {
    includeDynamicImports = false,
    validatePackages = false,
  }: { includeDynamicImports?: boolean; validatePackages?: boolean } = {},
): string[] {
  const closure = new Set(inputs.map((file) => file.split(sep).join("/")));
  const sourceInputs = inputs.filter((file) => /\.[cm]?[jt]s$/.test(file));
  if (sourceInputs.length === 0) {
    return [...closure].toSorted();
  }
  const graph = createRuntimeImportGraph(root, sourceInputs, { includeDynamicImports });
  try {
    for (const file of closure) {
      if (!/\.[cm]?[jt]s$/.test(file)) {
        continue;
      }
      for (const { specifier, resolvedFileName, isExternalLibraryImport } of graph.dependencies(
        file,
      )) {
        if (!resolvedFileName && specifier.startsWith(".")) {
          throw new Error(`${file}: unresolved ${specifier}`);
        }
        if (resolvedFileName && !isExternalLibraryImport) {
          closure.add(relative(root, resolvedFileName).split(sep).join("/"));
        } else if (validatePackages) {
          const packageName = specifier
            .split("/")
            .slice(0, specifier.startsWith("@") ? 2 : 1)
            .join("/");
          if (!existsSync(join(root, "node_modules", packageName, "package.json"))) {
            throw new Error(`${file}: unpinned package ${specifier}`);
          }
          resolvePackageImport(specifier, pathToFileURL(resolve(root, file)).href);
        }
      }
    }
    return [...closure].toSorted();
  } finally {
    graph.close();
  }
}
