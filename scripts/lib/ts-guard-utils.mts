// Shared TypeScript AST and source-file helpers for guard scripts.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { createNativeTypeScriptParser, type NativeTypeScriptParser } from "./native-typescript.mts";

const baseTestSuffixes = [".test.ts", ".test-utils.ts", ".test-harness.ts", ".e2e-harness.ts"];

type CollectTypeScriptFilesOptions = {
  extraTestSuffixes?: string[];
  fileExtensions?: string[];
  ignoreMissing?: boolean;
  includeTests?: boolean;
  skipDirectories?: string[];
  skipNodeModules?: boolean;
};

type CollectFileViolationsParams<Violation extends object> = {
  extraTestSuffixes?: string[];
  findViolations: (
    content: string,
    filePath: string,
    sourceFile: ts.SourceFile,
    parser: NativeTypeScriptParser,
  ) => Iterable<Violation>;
  includeTests?: boolean;
  repoRoot: string;
  skipFile?: (filePath: string) => boolean;
  sourceRoots: string[];
};

/**
 * Converts repo-relative source roots into absolute paths.
 */
export function resolveSourceRoots(repoRoot: string, relativeRoots: string[]) {
  return relativeRoots.map((root) => path.join(repoRoot, ...root.split("/").filter(Boolean)));
}

export function isTestLikeTypeScriptFile(filePath: string, extraTestSuffixes: string[] = []) {
  return [...baseTestSuffixes, ...extraTestSuffixes].some((suffix) => filePath.endsWith(suffix));
}

/**
 * Recursively collects TypeScript files under a file or directory target.
 */
export async function collectTypeScriptFiles(
  targetPath: string,
  options: CollectTypeScriptFilesOptions = {},
): Promise<string[]> {
  const fileExtensions = options.fileExtensions ?? [".ts"];
  const includeTests = options.includeTests ?? false;
  const extraTestSuffixes = options.extraTestSuffixes ?? [];
  const skipNodeModules = options.skipNodeModules ?? true;
  const skipDirectories = options.skipDirectories ?? [];
  const ignoreMissing = options.ignoreMissing ?? false;
  const isSourceFile = (filePath: string) =>
    fileExtensions.some((extension) => filePath.endsWith(extension));

  let stat;
  try {
    stat = await fs.stat(targetPath);
  } catch (error) {
    if (
      ignoreMissing &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  if (stat.isFile()) {
    if (!isSourceFile(targetPath)) {
      return [];
    }
    if (!includeTests && isTestLikeTypeScriptFile(targetPath, extraTestSuffixes)) {
      return [];
    }
    return [targetPath];
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      if (
        (skipNodeModules && entry.name === "node_modules") ||
        skipDirectories.includes(entry.name)
      ) {
        continue;
      }
      out.push(...(await collectTypeScriptFiles(entryPath, options)));
      continue;
    }
    if (!entry.isFile() || !isSourceFile(entryPath)) {
      continue;
    }
    if (!includeTests && isTestLikeTypeScriptFile(entryPath, extraTestSuffixes)) {
      continue;
    }
    out.push(entryPath);
  }
  return out;
}

/**
 * Collects TypeScript files from multiple roots, ignoring missing roots by default.
 */
export async function collectTypeScriptFilesFromRoots(
  sourceRoots: string[],
  options: Omit<CollectTypeScriptFilesOptions, "ignoreMissing"> = {},
) {
  return (
    await Promise.all(
      sourceRoots.map(
        async (root) =>
          await collectTypeScriptFiles(root, {
            ignoreMissing: true,
            ...options,
          }),
      ),
    )
  ).flat();
}

/**
 * Runs a guard's violation scanner across collected TypeScript source files.
 */
export async function collectFileViolations<Violation extends object>(
  params: CollectFileViolationsParams<Violation>,
) {
  const files = await collectTypeScriptFilesFromRoots(params.sourceRoots, {
    includeTests: params.includeTests,
    extraTestSuffixes: params.extraTestSuffixes,
  });

  const violations: Array<Violation & { path: string }> = [];
  using parser = createNativeTypeScriptParser({ cwd: params.repoRoot });
  // Native snapshots reload their root list. Bound retained trees while amortizing that reload.
  const batchSize = 32;
  for (let offset = 0; offset < files.length; offset += batchSize) {
    const sources: Array<{ fileName: string; text: string }> = [];
    let readFailure: { error: unknown } | undefined;
    for (const filePath of files.slice(offset, offset + batchSize)) {
      if (params.skipFile?.(filePath)) {
        continue;
      }
      try {
        sources.push({ fileName: filePath, text: await fs.readFile(filePath, "utf8") });
      } catch (error) {
        readFailure = { error };
        break;
      }
    }
    for (const [index, sourceFile] of parser.parseSourceFiles(sources).entries()) {
      const { fileName, text } = sources[index]!;
      for (const violation of params.findViolations(text, fileName, sourceFile, parser)) {
        violations.push({
          path: path.relative(params.repoRoot, fileName),
          ...violation,
        });
      }
    }
    if (readFailure) {
      throw readFailure.error;
    }
  }
  return violations;
}

/**
 * Returns the one-based source line for a TypeScript AST node.
 */
export function toLine(sourceFile: ts.SourceFile, node: ts.Node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

type ModuleSpecifierKind =
  | "import"
  | "export"
  | "dynamic-import"
  | "commonjs-require"
  | "import-meta-url";

/** Visit static and dynamic module specifiers in the caller's parsed source. */
export function visitModuleSpecifiers(
  sourceFile: ts.SourceFile,
  visit: (reference: {
    kind: ModuleSpecifierKind;
    node: ts.Node;
    specifier: string;
    specifierNode: ts.StringLiteralLikeNode;
  }) => void,
  options: {
    includeImportTypes?: boolean;
    includeCommonJs?: boolean;
    includeImportMetaUrl?: boolean;
  } = {},
) {
  function walk(node: ts.Node): void {
    let kind: ModuleSpecifierKind | undefined;
    let specifierNode: ts.StringLiteralLikeNode | undefined;
    const argument =
      ts.isCallExpression(node) || ts.isNewExpression(node) ? node.arguments?.[0] : undefined;
    const base = ts.isNewExpression(node) ? node.arguments?.[1] : undefined;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      kind = "import";
      specifierNode = node.moduleSpecifier;
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      kind = "export";
      specifierNode = node.moduleSpecifier;
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      argument &&
      ts.isStringLiteralLikeNode(argument)
    ) {
      kind = "dynamic-import";
      specifierNode = argument;
    } else if (
      options.includeImportTypes &&
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLikeNode(node.argument.literal)
    ) {
      kind = "dynamic-import";
      specifierNode = node.argument.literal;
    } else if (
      options.includeCommonJs &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      argument &&
      ts.isStringLiteralLikeNode(argument)
    ) {
      kind = "commonjs-require";
      specifierNode = argument;
    } else if (
      options.includeCommonJs &&
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLikeNode(node.moduleReference.expression)
    ) {
      kind = "commonjs-require";
      specifierNode = node.moduleReference.expression;
    } else if (
      options.includeImportMetaUrl &&
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      argument &&
      ts.isStringLiteralLikeNode(argument) &&
      base &&
      ts.isPropertyAccessExpression(base) &&
      base.name.text === "url" &&
      ts.isMetaProperty(base.expression) &&
      base.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      base.expression.name.text === "meta"
    ) {
      kind = "import-meta-url";
      specifierNode = argument;
    }
    if (specifierNode && kind) {
      visit({ kind, node, specifier: specifierNode.text, specifierNode });
    }
    node.forEachChild(walk);
  }
  walk(sourceFile);
}

/**
 * Extracts text from identifier, string, or numeric property names.
 */
export function getPropertyNameText(name: ts.PropertyName) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

/**
 * Removes harmless expression wrappers before AST shape checks.
 */
export function unwrapExpression(expression: ts.Expression) {
  let current = expression;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isTypeAssertion(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** Walk literal spans and scanned gaps without interpreting literal text as trivia. */
export function walkTypeScriptTokens(
  sourceFile: ts.SourceFile,
  onToken: (kind: ts.SyntaxKind, pos: number, end: number) => void,
): void {
  const source = sourceFile.getFullText();
  const literals: Array<{ kind: ts.SyntaxKind; pos: number; end: number }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLikeNode(node) ||
      node.kind === ts.SyntaxKind.RegularExpressionLiteral ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail ||
      node.kind === ts.SyntaxKind.JsxText
    ) {
      literals.push({
        kind: node.kind,
        pos: node.kind === ts.SyntaxKind.JsxText ? node.pos : node.getStart(sourceFile),
        end: node.end,
      });
      return;
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  const scanner = ts.createScanner(false);
  const scanGap = (start: number, end: number): void => {
    scanner.setText(source, start, end - start);
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFile; kind = scanner.scan()) {
      onToken(kind, scanner.getTokenStart(), scanner.getTokenEnd());
    }
  };
  let end = 0;
  // Scan punctuation gaps too: AST child traversal omits comments before closing delimiters.
  // Literal spans come from the parser so regexp and template text cannot invent comments.
  for (const literal of literals.toSorted((left, right) => left.pos - right.pos)) {
    scanGap(end, literal.pos);
    onToken(literal.kind, literal.pos, literal.end);
    end = literal.end;
  }
  scanGap(end, source.length);
}

export function collectTypeScriptCommentRanges(
  sourceFile: ts.SourceFile,
): Iterable<ts.CommentRange> {
  const comments: ts.CommentRange[] = [];
  walkTypeScriptTokens(sourceFile, (kind, pos, end) => {
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      comments.push({ kind, pos, end });
    }
  });
  return comments;
}

/**
 * Collects one-based line numbers for call expressions selected by a callback.
 */
export function collectCallExpressionLines(
  sourceFile: ts.SourceFile,
  resolveLineNode: (call: ts.CallExpression) => ts.Node | null | undefined,
) {
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const lineNode = resolveLineNode(node);
      if (lineNode) {
        lines.push(toLine(sourceFile, lineNode));
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return lines;
}

function isDirectExecution(importMetaUrl: string) {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return path.resolve(entry) === fileURLToPath(importMetaUrl);
}

/**
 * Runs a script main function only when the module is the direct entrypoint.
 */
export function runAsScript(importMetaUrl: string, main: () => Promise<unknown>) {
  if (!isDirectExecution(importMetaUrl)) {
    return;
  }
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
