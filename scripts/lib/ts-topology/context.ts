import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { SymbolFlags, type Checker, type Symbol } from "typescript/unstable/sync";
import { formatNativeTypeScriptDiagnostics } from "../native-typescript-diagnostics.mts";
import { createNativeTypeScriptProject } from "../native-typescript.mts";
import type { CanonicalSymbol, ProgramContext, SymbolKind } from "./types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

export function createProgramContext(
  repoRoot: string,
  tsconfigName = "tsconfig.json",
): ProgramContext {
  let directory = path.resolve(repoRoot);
  let configPath = path.resolve(directory, tsconfigName);
  while (!fs.existsSync(configPath) && path.dirname(directory) !== directory) {
    directory = path.dirname(directory);
    configPath = path.resolve(directory, tsconfigName);
  }
  assert(fs.existsSync(configPath), `Could not find ${tsconfigName}`);
  const session = createNativeTypeScriptProject({ cwd: repoRoot, configFileName: configPath });
  try {
    const diagnostics = session.project.program.getConfigFileParsingDiagnostics();
    if (diagnostics.length) {
      throw new Error(formatNativeTypeScriptDiagnostics(diagnostics));
    }
  } catch (error) {
    session.close();
    throw error;
  }
  return {
    repoRoot,
    tsconfigPath: normalizePath(path.relative(repoRoot, configPath)),
    project: session.project,
    checker: session.project.checker,
    close: () => session.close(),
    normalizePath,
    relativeToRepo(filePath: string) {
      return normalizePath(path.relative(repoRoot, filePath));
    },
  };
}

function comparableSymbol(checker: Checker, symbol: Symbol | undefined): Symbol | undefined {
  if (!symbol) {
    return undefined;
  }
  return symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

const SYMBOL_KINDS: Array<[ts.SyntaxKind, number, SymbolKind]> = [
  [ts.SyntaxKind.FunctionDeclaration, SymbolFlags.Function, "function"],
  [ts.SyntaxKind.ClassDeclaration, SymbolFlags.Class, "class"],
  [ts.SyntaxKind.InterfaceDeclaration, SymbolFlags.Interface, "interface"],
  [ts.SyntaxKind.TypeAliasDeclaration, SymbolFlags.TypeAlias, "type"],
  [ts.SyntaxKind.EnumDeclaration, SymbolFlags.Enum, "enum"],
  [ts.SyntaxKind.VariableDeclaration, SymbolFlags.Variable, "variable"],
];

function symbolKind(symbol: Symbol, declaration: ts.Node | undefined): SymbolKind {
  return (
    SYMBOL_KINDS.find(([kind]) => declaration?.kind === kind)?.[2] ??
    SYMBOL_KINDS.find(([, flag]) => symbol.flags & flag)?.[2] ??
    "unknown"
  );
}

export function canonicalSymbolInfo(context: ProgramContext, symbol: Symbol): CanonicalSymbol {
  const resolved = comparableSymbol(context.checker, symbol) ?? symbol;
  const declaration =
    resolved.declarations
      .find((candidate) => candidate.kind !== ts.SyntaxKind.SourceFile)
      ?.resolve(context.project) ??
    symbol.declarations
      .find((candidate) => candidate.kind !== ts.SyntaxKind.SourceFile)
      ?.resolve(context.project);
  assert(declaration, `Missing declaration for symbol ${symbol.name}`);
  const sourceFile = declaration.getSourceFile();
  const declarationPath = context.relativeToRepo(sourceFile.fileName);
  const declarationLine = sourceFile.getLineAndCharacterOfPosition(declaration.getStart()).line + 1;
  return {
    canonicalKey: `${declarationPath}:${declarationLine}:${resolved.name}`,
    declarationPath,
    declarationLine,
    kind: symbolKind(resolved, declaration),
    aliasName: symbol.name !== resolved.name ? symbol.name : undefined,
  };
}

export function countImportUsages(
  context: ProgramContext,
  sourceFile: ts.SourceFile,
  importedSymbol: Symbol,
  name: string,
  kind: "identifier" | "namespace",
): number {
  const targetSymbol = comparableSymbol(context.checker, importedSymbol);
  let count = 0;
  const visit = (node: ts.Node) => {
    let reference: ts.Node | undefined;
    if (kind === "namespace") {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.name.text === name
      ) {
        reference = node.expression;
      }
    } else if (
      ts.isIdentifier(node) &&
      node.text === name &&
      !ts.isImportClause(node.parent) &&
      !ts.isImportSpecifier(node.parent)
    ) {
      reference = node;
    }
    if (reference) {
      const symbol = comparableSymbol(
        context.checker,
        context.checker.getSymbolAtLocation(reference),
      );
      if (symbol === targetSymbol) {
        count += 1;
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return count;
}

export function getRepoRevision(repoRoot: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
