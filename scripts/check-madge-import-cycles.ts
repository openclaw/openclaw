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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = ["src", "extensions", "ui"] as const;
const sourceExtensions = [".ts", ".tsx"] as const;
const ignoredPathPartPattern =
  /(^|\/)(node_modules|dist|build|coverage|\.artifacts|\.git|assets)(\/|$)/;

function collectStaticModuleSpecifiers(sourceFile: ts.SourceFile): ts.StringLiteral[] {
  return sourceFile.imports.filter((specifier): specifier is ts.StringLiteral => {
    // Compiler-injected helpers are not source imports.
    if (!ts.isStringLiteral(specifier) || specifier.pos < 0) {
      return false;
    }
    const parent = specifier.parent;
    return (
      (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
      parent.moduleSpecifier === specifier
    );
  });
}

async function createImportGraph(files: readonly string[]): Promise<Map<string, string[]>> {
  const configFileName = path
    .join(repoRoot, "tsconfig.madge-import-cycles.json")
    .split(path.sep)
    .join("/");
  const absoluteToRepoPath = new Map(
    files.map((file): [string, string] => [path.resolve(repoRoot, file), file]),
  );
  // Keep one compiler, but release each batch's source trees before loading the next.
  const batchSize = 256;
  let batchFiles = files.slice(0, batchSize);
  const readConfig = () =>
    JSON.stringify({
      extends: "./tsconfig.json",
      // Resolve edges without adding their transitive source trees to the batch.
      compilerOptions: { noResolve: true },
      files: batchFiles.map((file) => path.resolve(repoRoot, file)),
      include: [],
      exclude: [],
    });
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
        fs: {
          readFile: (file) => (file === configFileName ? readConfig() : undefined),
          fileExists: (file) => (file === configFileName ? true : undefined),
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
    let snapshot = session.snapshot;
    const repoPaths = new Map<string, string>();
    const importedPaths = new Map<string, string[]>();
    // Empty inventories still validate the project configuration.
    for (let offset = 0; offset === 0 || offset < files.length; offset += batchSize) {
      if (offset > 0) {
        batchFiles = files.slice(offset, offset + batchSize);
        const previous = snapshot;
        // A config notification reloads the root list; invalidating files alone does not.
        snapshot = previous.update({
          fileNotifications: { changed: [configFileName] },
          ensurePrograms: true,
        });
        previous.dispose();
        session.api.clearSourceFileCache();
      }
      const project = snapshot.getConfiguredProject(configFileName);
      if (!project) {
        throw new Error("Native TypeScript did not open the import-cycle batch");
      }
      const diagnostics = project.program.getConfigFileParsingDiagnostics();
      if (diagnostics.length) {
        throw new Error(formatNativeTypeScriptDiagnostics(diagnostics));
      }
      for (const file of batchFiles) {
        const sourceFile = project.program.getSourceFile(path.resolve(repoRoot, file));
        if (!sourceFile) {
          throw new Error(`Native TypeScript did not load import-cycle input ${file}`);
        }
        const repoPath = absoluteToRepoPath.get(path.resolve(sourceFile.fileName));
        if (repoPath) {
          repoPaths.set(sourceFile.path, repoPath);
        }
        const resolved = session.api.batch(
          ...collectStaticModuleSpecifiers(sourceFile).map((specifier) =>
            project.program.getResolvedModuleFromModuleSpecifier.gen(
              specifier,
              sourceFile.fileName,
            ),
          ),
        );
        importedPaths.set(
          file,
          resolved.flatMap((module) =>
            module
              ? [
                  project.program.getCanonicalFileName(
                    path.resolve(module.resolvedFileName).split(path.sep).join("/"),
                  ),
                ]
              : [],
          ),
        );
        session.api.clearSourceFileCache();
      }
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
