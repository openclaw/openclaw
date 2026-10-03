#!/usr/bin/env node
import { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import {
  collectSourceFiles,
  collectStronglyConnectedComponents,
} from "./lib/import-cycle-graph.ts";
import { formatNativeTypeScriptDiagnostics } from "./lib/native-typescript-diagnostics.mts";
import {
  createNativeTypeScriptProject,
  resolveInstalledNativeTypeScriptCompiler,
  type NativeTypeScriptProject,
} from "./lib/native-typescript.mts";
import { visitModuleSpecifiers } from "./lib/ts-guard-utils.mts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = ["src", "extensions", "ui"] as const;
const sourceExtensions = [".ts"] as const;
const ignoredPathPartPattern =
  /(^|\/)(node_modules|dist|build|coverage|\.artifacts|\.git|assets)(\/|$)/;

function collectStaticModuleSpecifiers(sourceFile: ts.SourceFile): ts.StringLiteral[] {
  const specifiers: ts.StringLiteral[] = [];
  visitModuleSpecifiers(sourceFile, ({ kind, specifierNode }) => {
    if ((kind === "import" || kind === "export") && ts.isStringLiteral(specifierNode)) {
      specifiers.push(specifierNode);
    }
  });
  return specifiers;
}

async function createImportGraph(files: readonly string[]): Promise<Map<string, string[]>> {
  const configFileName = path.join(repoRoot, "tsconfig.madge-import-cycles.json");
  const absoluteToRepoPath = new Map(
    files.map((file): [string, string] => [path.resolve(repoRoot, file), file]),
  );
  const executable = resolveInstalledNativeTypeScriptCompiler().executable;
  const observed: ChildProcess[] = [];
  const compilers: { child: ChildProcess; closed: Promise<void> }[] = [];
  const children = channel("child_process");
  const observeCompiler = (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "process" in message &&
      message.process instanceof ChildProcess
    ) {
      observed.push(message.process);
    }
  };
  let session: NativeTypeScriptProject | undefined;
  try {
    children.subscribe(observeCompiler);
    try {
      session = createNativeTypeScriptProject({
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
    } finally {
      children.unsubscribe(observeCompiler);
      // Creation is synchronous: identify the spawned compiler before any event callback runs.
      for (const child of observed.filter((candidate) => candidate.spawnfile === executable)) {
        const closed = new Promise<void>((resolve, reject) => {
          let failure: Error | undefined;
          const onError = (error: Error) => {
            failure ??= error;
          };
          child.on("error", onError);
          child.once("close", () => {
            child.off("error", onError);
            if (failure && child.pid !== undefined) {
              reject(failure);
            } else {
              resolve();
            }
          });
        });
        compilers.push({ child, closed });
        // The synchronous transport unrefs its child; retain it until the real close event.
        if (child.pid !== undefined) {
          child.ref();
        }
      }
    }
    if (compilers.length !== 1 || compilers[0]?.child.pid === undefined) {
      throw new Error("Native TypeScript did not expose exactly one compiler process");
    }
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
    try {
      session?.close();
    } finally {
      // A synchronous spawn rejection has no OS child and may never emit close.
      await Promise.all(
        compilers.filter(({ child }) => child.pid !== undefined).map(({ closed }) => closed),
      );
    }
  }
}

async function main(): Promise<number> {
  const files = scanRoots.flatMap((root) =>
    collectSourceFiles(path.join(repoRoot, root), {
      repoRoot,
      sourceExtensions,
      shouldSkipRepoPath: (repoPath) => ignoredPathPartPattern.test(repoPath),
    }),
  );
  const graph = await createImportGraph(files);
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

process.exitCode = await main();
