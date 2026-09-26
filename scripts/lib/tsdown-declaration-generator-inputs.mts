import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { collectModuleReferencesFromSource } from "./guard-inventory-utils.mjs";
import { createNativeTypeScriptParser } from "./native-typescript.mts";
import { createRuntimeImportGraph } from "./runtime-import-closure.mts";
import { STATE_SCHEMA_GENERATOR_INPUTS } from "./state-schema-inline-plugin.mts";
import { resolveTsxImport } from "./tsx-cli-shim.mjs";
import { resolveWorkerDeployGeneratorInputs } from "./worker-deploy-build-plugin.mts";

const sourceFilePattern = /\.(?:[cm]?[jt]sx?)$/u;
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const portablePath = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    ? relative.split(path.sep).join("/")
    : file;
};

function dynamicEdgeExpressions(sourceFile: ts.SourceFile) {
  const expressions: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] !== undefined &&
      ((node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        !ts.isStringLiteralLikeNode(node.arguments[0])) ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require" &&
          !ts.isStringLiteralLikeNode(node.arguments[0])))
    ) {
      expressions.push(node.arguments[0].getText(sourceFile));
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return expressions;
}

/** Resolve the complete executable and non-module input graph for one declaration writer. */
export function resolveTsdownDeclarationGeneratorInputs(rootDir: string, generatorEntry: string) {
  const root = fs.realpathSync(rootDir);
  const nativeManifest = createRequire(path.join(root, "package.json")).resolve(
    "typescript/package.json",
  );
  const dynamicOwners = new Map<string, { expressions: string[]; targets: string[] }>([
    [
      "scripts/lib/dist-artifact-ownership.mts",
      { expressions: ["script"], targets: [generatorEntry] },
    ],
    [
      "scripts/lib/local-check-runtime.mts",
      {
        expressions: ['inputs.assert(path.join(nativeRoot, "lib/getExePath.js"))'],
        targets: [nativeManifest, path.join(path.dirname(nativeManifest), "lib/getExePath.js")],
      },
    ],
    [
      "scripts/lib/native-typescript.mts",
      {
        expressions: ['path.join(path.dirname(packageJson), "lib/getExePath.js")'],
        targets: [nativeManifest, path.join(path.dirname(nativeManifest), "lib/getExePath.js")],
      },
    ],
    [
      "scripts/lib/native-typescript-toolchain.mts",
      {
        expressions: ["executableResolver"],
        targets: [nativeManifest, path.join(path.dirname(nativeManifest), "lib/getExePath.js")],
      },
    ],
    [
      "scripts/lib/tsdown-declaration-writer.mts",
      {
        expressions: ['pathToFileURL(path.join(root, "tsdown.config.ts")).href'],
        targets: ["tsdown.config.ts"],
      },
    ],
    [
      "scripts/lib/tsx-cli-shim.mjs",
      {
        expressions: ["resolveTsxImport(SHIM_CHECKOUT_ROOT)"],
        targets: [fileURLToPath(resolveTsxImport(root))],
      },
    ],
    [
      "scripts/tsdown-build.mts",
      {
        // Runtime-only live Gateway dist fence. Declaration writers import this
        // file for constants/plan helpers and must not walk daemon service-layout.
        expressions: ["liveGatewayDistFenceHref"],
        targets: [generatorEntry],
      },
    ],
  ]);
  const observedDynamicOwners = new Set<string>();
  using parser = createNativeTypeScriptParser({ cwd: root });
  const entryFiles = [generatorEntry, "scripts/tsx.mjs", "tsdown.config.ts"];
  const explicitSources = [...dynamicOwners.values()]
    .flatMap((owner) => owner.targets)
    .filter((file) => !file.includes("node_modules") && sourceFilePattern.test(file));
  using graph = createRuntimeImportGraph(root, [...entryFiles, ...explicitSources], {
    sourceImports: true,
    includeTypeOnlyImports: true,
    includeDynamicImports: true,
    includeCommonJs: true,
  });
  const files = new Map<string, string>();
  const visited = new Set<string>();

  const visit = (input: string, compilerSource = false) => {
    const requested = input.startsWith("file:") ? fileURLToPath(input) : input;
    const absolute = fs.realpathSync(path.resolve(root, requested));
    const id = portablePath(root, absolute);
    files.set(id, absolute);
    if (
      compilerSource ||
      visited.has(id) ||
      id === absolute ||
      id.split("/").includes("node_modules") ||
      !sourceFilePattern.test(absolute)
    ) {
      return;
    }
    visited.add(id);
    const source = fs.readFileSync(absolute, "utf8");
    const sourceFile = parser.parseSourceFile(absolute, source);
    const expressions = dynamicEdgeExpressions(sourceFile);
    const owner = dynamicOwners.get(id);
    if (
      JSON.stringify(expressions) !== JSON.stringify(owner?.expressions ?? []) ||
      (expressions.length > 0 && !owner?.targets.length)
    ) {
      throw new Error(`Unresolved dynamic module edges in ${id}: ${JSON.stringify(expressions)}`);
    }
    if (owner) {
      observedDynamicOwners.add(id);
      owner.targets.forEach((target) => visit(target));
    }
    for (const reference of collectModuleReferencesFromSource(sourceFile)) {
      if (reference.kind === "import-meta-url") {
        const target = path.resolve(path.dirname(absolute), reference.specifier);
        if (fs.statSync(target).isDirectory()) {
          if (portablePath(root, fs.realpathSync(target)) !== "") {
            throw new Error(`Unowned import.meta directory in ${id}:${reference.line}`);
          }
        } else {
          // The handoff config passes these files to the runtime compiler, not
          // the declaration generator. Capture their bytes without interpreting
          // staged runtime paths as files in the source checkout.
          const targetIsCompilerSource =
            id === "scripts/lib/managed-handoff-build-config.mts" &&
            [
              "../../src/shared/freebsd-process-identity.ts",
              "../../src/infra/update-managed-service-handoff-native-loader.ts",
            ].includes(reference.specifier);
          visit(target, targetIsCompilerSource);
        }
        continue;
      }
      if (builtins.has(reference.specifier)) {
        continue;
      }
      const exact = reference.specifier.startsWith(".")
        ? path.resolve(path.dirname(absolute), reference.specifier)
        : undefined;
      const resolved =
        exact && fs.existsSync(exact) && fs.statSync(exact).isFile()
          ? exact
          : graph.dependencies(absolute).find((edge) => edge.specifier === reference.specifier)
              ?.resolvedFileName;
      if (!resolved) {
        throw new Error(
          `Unresolved ${reference.kind} in ${id}:${reference.line}: ${reference.specifier}`,
        );
      }
      const canonical = fs.realpathSync(resolved);
      const relative = path.relative(root, canonical);
      if (
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative) &&
        !relative.split(path.sep).includes("node_modules")
      ) {
        visit(canonical);
      }
      // The lockfile and installed topology own resolved package imports. Exact
      // computed package targets above remain byte inputs in this same closure.
    }
  };

  entryFiles.forEach((entry) => visit(entry));
  for (const owner of dynamicOwners.keys()) {
    if (!observedDynamicOwners.has(owner)) {
      throw new Error(`Dynamic module owner is outside the generator closure: ${owner}`);
    }
  }
  return [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    ...[...files.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([, file]) => file),
    ...STATE_SCHEMA_GENERATOR_INPUTS,
    ...resolveWorkerDeployGeneratorInputs(root),
    fs.realpathSync(path.resolve(root, "node_modules/tree-sitter-bash/LICENSE")),
  ];
}
