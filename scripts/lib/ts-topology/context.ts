// Context script supports OpenClaw repository automation.
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

function symbolKind(symbol: Symbol, declaration: ts.Node | undefined): SymbolKind {
  if (declaration) {
    switch (declaration.kind) {
      case ts.SyntaxKind.FunctionDeclaration:
        return "function";
      case ts.SyntaxKind.ClassDeclaration:
        return "class";
      case ts.SyntaxKind.InterfaceDeclaration:
        return "interface";
      case ts.SyntaxKind.TypeAliasDeclaration:
        return "type";
      case ts.SyntaxKind.EnumDeclaration:
        return "enum";
      case ts.SyntaxKind.VariableDeclaration:
        return "variable";
      default:
        break;
    }
  }
  if (symbol.flags & SymbolFlags.Function) {
    return "function";
  }
  if (symbol.flags & SymbolFlags.Class) {
    return "class";
  }
  if (symbol.flags & SymbolFlags.Interface) {
    return "interface";
  }
  if (symbol.flags & SymbolFlags.TypeAlias) {
    return "type";
  }
  if (symbol.flags & SymbolFlags.Enum) {
    return "enum";
  }
  if (symbol.flags & SymbolFlags.Variable) {
    return "variable";
  }
  return "unknown";
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

export function countIdentifierUsages(
  context: ProgramContext,
  sourceFile: ts.SourceFile,
  importedSymbol: Symbol,
  localName: string,
): number {
  const targetSymbol = comparableSymbol(context.checker, importedSymbol);
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === localName) {
      const symbol = comparableSymbol(context.checker, context.checker.getSymbolAtLocation(node));
      if (
        symbol === targetSymbol &&
        !ts.isImportClause(node.parent) &&
        !ts.isImportSpecifier(node.parent)
      ) {
        count += 1;
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return count;
}

export function countNamespacePropertyUsages(
  context: ProgramContext,
  sourceFile: ts.SourceFile,
  namespaceSymbol: Symbol,
  exportedName: string,
): number {
  const targetSymbol = comparableSymbol(context.checker, namespaceSymbol);
  let count = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.name.text === exportedName
    ) {
      const symbol = comparableSymbol(
        context.checker,
        context.checker.getSymbolAtLocation(node.expression),
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
