import path from "node:path";
import * as ts from "typescript/ast";
import { createNativeTypeScriptParser } from "./native-typescript.mts";
import { getPropertyNameText } from "./ts-guard-utils.mts";
export type MethodSpec = {
  line: number;
  name: string;
  since: string | undefined;
  compatibilityRestored: boolean;
};
type LiteralMetadata = { name?: string; since?: string; compatibilityRestored?: boolean };

function collectMethodSpec(
  element: ts.Expression,
  sourceFile: ts.SourceFile,
  fileName: string,
  metadataFor: (expression: ts.Expression, file: string) => LiteralMetadata,
): MethodSpec {
  const line = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1;
  if (ts.isObjectLiteralExpression(element)) {
    const metadata = metadataFor(element, fileName);
    const name = metadata.name;
    if (!name) {
      throw new Error(
        `${fileName}:${line} core method spec names must be string literals so additions can be compared with origin/main.`,
      );
    }
    return {
      name,
      since: metadata.since,
      compatibilityRestored: metadata.compatibilityRestored ?? false,
      line,
    };
  }
  if (ts.isArrayLiteralExpression(element)) {
    const name = element.elements[0];
    const since = element.elements[3];
    if (
      !name ||
      !since ||
      !ts.isStringLiteralLikeNode(name) ||
      !ts.isStringLiteralLikeNode(since)
    ) {
      throw new Error(
        `${fileName}:${line} core method spec rows must use string literal names and vintage metadata.`,
      );
    }
    const policy = element.elements[4];
    const compatibilityRestored =
      policy === undefined ? false : (metadataFor(policy, fileName).compatibilityRestored ?? false);
    return { name: name.text, since: since.text, compatibilityRestored, line };
  }
  throw new Error(
    `${fileName}:${line} core method specs must be inline object literals or labeled rows so vintage metadata can be enforced.`,
  );
}

export type SourceSnapshot =
  | { kind: "worktree" }
  | { kind: "index" }
  | { kind: "tree"; ref: string };
/** A selected snapshot owns every read. Missing staged/base files never fall through to disk. */
export function snapshotReader(
  snapshot: SourceSnapshot,
  readWorking: (file: string) => string,
  git: (args: string[]) => string,
): (file: string) => string {
  return (file) =>
    snapshot.kind === "worktree"
      ? readWorking(file)
      : git(["show", snapshot.kind === "index" ? ":" + file : snapshot.ref + ":" + file]);
}
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Resolve only named static exports of canonical const arrays; never evaluate source. */
export function collectSnapshotMethodSpecs(
  root: string,
  read: (file: string) => string,
): MethodSpec[] {
  using parser = createNativeTypeScriptParser();
  const sources = new Map<string, ts.SourceFile>();
  const active = new Set<string>();
  const sourceFor = (file: string): ts.SourceFile => {
    const prior = sources.get(file);
    if (prior) {
      return prior;
    }
    const parsed = parser.parseSourceFile(file, read(file));
    sources.set(file, parsed);
    return parsed;
  };
  const importedFile = (from: string, value: ts.Expression | undefined): string => {
    if (!value || !ts.isStringLiteral(value) || !value.text.startsWith(".")) {
      throw new Error(from + ": method-table imports must be relative static modules");
    }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), value.text));
    if (resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
      throw new Error(from + ": method-table import escapes repository");
    }
    if (resolved.endsWith(".js")) {
      return resolved.slice(0, -3) + ".ts";
    }
    if (resolved.endsWith(".mjs")) {
      return resolved.slice(0, -4) + ".mts";
    }
    if (resolved.endsWith(".ts") || resolved.endsWith(".mts")) {
      return resolved;
    }
    throw new Error(from + ": method-table import requires an explicit TypeScript/ESM module path");
  };
  const resolve = <T,>(
    file: string,
    name: string,
    exported: boolean,
    readValue: (expression: ts.Expression, sourceFile: ts.SourceFile, fileName: string) => T,
  ): T => {
    const key = file + "#" + name;
    if (active.has(key)) {
      throw new Error("Cyclic method-table import: " + key);
    }
    active.add(key);
    try {
      const sf = sourceFor(file);
      const candidates: Array<() => T> = [];
      for (const statement of sf.statements) {
        if (ts.isVariableStatement(statement)) {
          const isExport =
            statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
          for (const declaration of statement.declarationList.declarations) {
            if (
              !ts.isIdentifier(declaration.name) ||
              declaration.name.text !== name ||
              (exported && !isExport)
            ) {
              continue;
            }
            candidates.push(() => {
              if (
                !(statement.declarationList.flags & ts.NodeFlags.Const) ||
                !declaration.initializer
              ) {
                throw new Error(file + ": method table must be an initialized const array");
              }
              return readValue(unwrap(declaration.initializer), sf, file);
            });
          }
        }
        if (
          !exported &&
          ts.isImportDeclaration(statement) &&
          statement.importClause &&
          statement.importClause.phaseModifier !== ts.SyntaxKind.TypeKeyword
        ) {
          const bindings = statement.importClause.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const entry of bindings.elements) {
              if (!entry.isTypeOnly && entry.name.text === name) {
                candidates.push(() =>
                  resolve(
                    importedFile(file, statement.moduleSpecifier),
                    (entry.propertyName ?? entry.name).text,
                    true,
                    readValue,
                  ),
                );
              }
            }
          }
        }
        if (
          exported &&
          ts.isExportDeclaration(statement) &&
          !statement.isTypeOnly &&
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause)
        ) {
          for (const entry of statement.exportClause.elements) {
            if (entry.isTypeOnly || entry.name.text !== name) {
              continue;
            }
            candidates.push(() =>
              resolve(
                statement.moduleSpecifier ? importedFile(file, statement.moduleSpecifier) : file,
                (entry.propertyName ?? entry.name).text,
                Boolean(statement.moduleSpecifier),
                readValue,
              ),
            );
          }
        }
      }
      if (candidates.length !== 1) {
        throw new Error(
          file +
            ": " +
            (candidates.length ? "ambiguous" : "unresolved") +
            " canonical method table " +
            name,
        );
      }
      return candidates[0]!();
    } finally {
      active.delete(key);
    }
  };
  const metadataFor = (expression: ts.Expression, file: string): LiteralMetadata => {
    const value = unwrap(expression);
    if (ts.isIdentifier(value)) {
      return resolve(file, value.text, false, (resolved, _source, resolvedFile) =>
        metadataFor(resolved, resolvedFile),
      );
    }
    if (!ts.isObjectLiteralExpression(value)) {
      throw new Error(file + ": present tuple policy must resolve to a static const object");
    }
    const metadata: LiteralMetadata = {};
    const seen = new Set<string>();
    let hasSpread = false;
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        hasSpread = true;
        // Existing canonical policies compose non-metadata options. Prove absence
        // in the same snapshot; never erase metadata introduced or overridden by a spread.
        if (Object.keys(metadataFor(property.expression, file)).length !== 0) {
          throw new Error(file + ": canonical metadata cannot be introduced by a spread");
        }
        continue;
      }
      if (ts.isComputedPropertyName(property.name)) {
        throw new Error(file + ": canonical metadata cannot use computed properties");
      }
      const key = getPropertyNameText(property.name);
      if (key !== "name" && key !== "since" && key !== "compatibilityRestored") {
        continue;
      }
      if (seen.has(key)) {
        throw new Error(file + ": duplicate canonical metadata property " + key);
      }
      seen.add(key);
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(file + ": canonical metadata must be a literal property assignment");
      }
      const literal = property.initializer;
      if (key === "compatibilityRestored") {
        if (
          literal.kind !== ts.SyntaxKind.TrueKeyword &&
          literal.kind !== ts.SyntaxKind.FalseKeyword
        ) {
          throw new Error(file + ": compatibilityRestored must be a boolean literal");
        }
        metadata.compatibilityRestored = literal.kind === ts.SyntaxKind.TrueKeyword;
      } else {
        if (!ts.isStringLiteralLikeNode(literal)) {
          throw new Error(file + ": canonical metadata must be a string literal");
        }
        metadata[key] = literal.text;
      }
    }
    if (hasSpread && Object.keys(metadata).length !== 0) {
      throw new Error(file + ": canonical metadata cannot coexist with spreads");
    }
    return metadata;
  };
  const readTable = (
    expression: ts.Expression,
    sourceFile: ts.SourceFile,
    file: string,
  ): MethodSpec[] => {
    if (!ts.isArrayLiteralExpression(expression)) {
      throw new Error(file + ": method table must be a static const array");
    }
    const rows: MethodSpec[] = [];
    for (const element of expression.elements) {
      if (ts.isSpreadElement(element)) {
        const identifier = unwrap(element.expression);
        if (!ts.isIdentifier(identifier)) {
          throw new Error(file + ": dynamic method-table spread is unsupported");
        }
        rows.push(...resolve(file, identifier.text, false, readTable));
      } else {
        rows.push(collectMethodSpec(unwrap(element), sourceFile, file, metadataFor));
      }
    }
    return rows;
  };
  const rows = resolve(root, "CORE_GATEWAY_METHOD_SPECS", true, readTable);
  const names = new Set<string>();
  for (const row of rows) {
    if (names.has(row.name)) {
      throw new Error("Duplicate canonical method " + row.name);
    }
    names.add(row.name);
  }
  return rows;
}

export function classifyMethodSpecs(current: MethodSpec[], base: MethodSpec[], train: string) {
  const names = new Set(base.map((spec) => spec.name));
  const added = current.filter((spec) => !names.has(spec.name));
  const restored = added.filter((spec) => spec.compatibilityRestored);
  const newMethods = added.filter((spec) => !spec.compatibilityRestored);
  const violations = added.filter((spec) =>
    spec.compatibilityRestored ? !spec.since?.startsWith("<=") : spec.since !== train,
  );
  return { added, restored, newMethods, violations };
}
