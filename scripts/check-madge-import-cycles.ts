#!/usr/bin/env node
// Check Madge Import Cycles script supports OpenClaw repository automation.
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import {
  collectSourceFiles,
  collectStronglyConnectedComponents,
} from "./lib/import-cycle-graph.ts";
import { formatNativeTypeScriptDiagnostics } from "./lib/native-typescript-diagnostics.mts";
import { createNativeTypeScriptProject } from "./lib/native-typescript.mts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = ["src", "extensions", "ui"] as const;
const sourceExtensions = [".ts"] as const;
const ignoredPathPartPattern =
  /(^|\/)(node_modules|dist|build|coverage|\.artifacts|\.git|assets)(\/|$)/;

function shouldSkipRepoPath(repoPath: string): boolean {
  return ignoredPathPartPattern.test(repoPath);
}

function collectStaticModuleSpecifiers(sourceFile: ts.SourceFile): ts.StringLiteral[] {
  const specifiers: ts.StringLiteral[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return specifiers;
}

function createImportGraph(files: readonly string[]): Map<string, string[]> {
  const configFileName = path.join(repoRoot, "tsconfig.madge-import-cycles.json");
  const absoluteToRepoPath = new Map(
    files.map((file): [string, string] => [path.resolve(repoRoot, file), file]),
  );
  const session = createNativeTypeScriptProject({
    cwd: repoRoot,
    configFileName,
    files: {
      [configFileName]: JSON.stringify({
        extends: "./tsconfig.json",
        files: [...absoluteToRepoPath.keys()],
        include: [],
        exclude: [],
      }),
    },
  });
  try {
    const { project } = session;
    const diagnostics = project.program.getConfigFileParsingDiagnostics();
    if (diagnostics.length) {
      throw new Error(formatNativeTypeScriptDiagnostics(diagnostics));
    }
    const repoPaths = new Map<ts.Path, string>();
    const importedPaths = new Map<string, ts.Path[]>();
    for (const file of files) {
      const absoluteFile = path.resolve(repoRoot, file);
      const sourceFile = project.program.getSourceFile(absoluteFile);
      if (!sourceFile) {
        throw new Error(`Native TypeScript did not load import-cycle input ${file}`);
      }
      const repoPath = absoluteToRepoPath.get(path.resolve(sourceFile.fileName));
      if (repoPath) {
        repoPaths.set(sourceFile.path, repoPath);
      }
      const specifiers = collectStaticModuleSpecifiers(sourceFile);
      const imports = project.checker.getSymbolAtLocation(specifiers).flatMap((symbol) => {
        const declaration = symbol?.declarations.find(
          (candidate) => candidate.kind === ts.SyntaxKind.SourceFile,
        );
        return declaration ? [declaration.path] : [];
      });
      importedPaths.set(file, imports);
      // Keep graph edges across files, not every decoded importer and target AST.
      session.api.clearSourceFileCache();
    }
    return new Map(
      [...importedPaths].map(([file, imports]) => [
        file,
        imports
          .flatMap((importedPath) => {
            const repoPath = repoPaths.get(importedPath);
            return repoPath ? [repoPath] : [];
          })
          .toSorted((left, right) => left.localeCompare(right)),
      ]),
    );
  } finally {
    session.close();
  }
}

function main(): number {
  const files = scanRoots.flatMap((root) =>
    collectSourceFiles(path.join(repoRoot, root), {
      repoRoot,
      sourceExtensions,
      shouldSkipRepoPath,
    }),
  );
  const graph = createImportGraph(files);
  const cycles = collectStronglyConnectedComponents(graph);

  console.log(`Madge import cycle check: ${cycles.length} cycle(s).`);
  if (cycles.length === 0) {
    return 0;
  }

  console.error("\nMadge circular dependencies:");
  for (const [index, cycle] of cycles.entries()) {
    console.error(`\n# cycle ${index + 1}`);
    console.error(`  ${cycle.join("\n  -> ")}`);
  }
  console.error(
    "\nBreak the cycle or extract a leaf contract instead of routing through a barrel.",
  );
  return 1;
}

process.exitCode = main();
