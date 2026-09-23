import type ts from "typescript";
import { getTypeScript } from "./ts-guard-utils.mts";

/** Source-update completion loads the installed checkout's scripts, not retained dist chunks. */
export function isUpdateSourceScriptImport(owner: string, node: ts.CallExpression): boolean {
  if (owner !== "src/cli/update-cli/update-command-runtime.ts") {
    return false;
  }
  const ts = getTypeScript();
  const specifier = node.arguments[0];
  if (!specifier || !ts.isPropertyAccessExpression(specifier) || specifier.name.text !== "href") {
    return false;
  }
  const url = specifier.expression;
  if (
    !ts.isCallExpression(url) ||
    url.expression.getText() !== "pathToFileURL" ||
    url.arguments.length !== 1
  ) {
    return false;
  }
  let target = url.arguments[0];
  if (target && ts.isIdentifier(target)) {
    const name = target.text;
    let statement: ts.Node = node;
    while (statement.parent && !ts.isBlock(statement.parent)) {
      statement = statement.parent;
    }
    if (!statement.parent || !ts.isBlock(statement.parent)) {
      return false;
    }
    target = undefined;
    for (const preceding of statement.parent.statements) {
      if (preceding === statement) {
        break;
      }
      if (
        !ts.isVariableStatement(preceding) ||
        !(preceding.declarationList.flags & ts.NodeFlags.Const)
      ) {
        continue;
      }
      for (const declaration of preceding.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
          target = declaration.initializer;
        }
      }
    }
  }
  if (!target || !ts.isCallExpression(target) || target.expression.getText() !== "path.join") {
    return false;
  }
  const [root, ...segments] = target.arguments;
  if (
    !root ||
    !ts.isIdentifier(root) ||
    root.text !== "root" ||
    !segments.every(ts.isStringLiteral)
  ) {
    return false;
  }
  // These shipped source-only contracts have no hashed compatibility output.
  // Keep every other nonliteral import fail-closed, including paths under dist.
  return [
    "scripts/stage-bundled-plugin-runtime.mts",
    "scripts/lib/dist-artifact-ownership.mts",
  ].includes(segments.map((segment) => segment.text).join("/"));
}
