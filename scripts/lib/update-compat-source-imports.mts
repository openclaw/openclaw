import * as ts from "typescript/unstable/ast";

function precedingConstInitializer(node: ts.Node, name: string): ts.Expression | undefined {
  let statement = node;
  while (statement.parent && !ts.isBlock(statement.parent)) {
    statement = statement.parent;
  }
  if (!statement.parent || !ts.isBlock(statement.parent)) {
    return undefined;
  }
  for (const preceding of statement.parent.statements) {
    if (preceding === statement) {
      break;
    }
    if (!ts.isVariableStatement(preceding)) {
      continue;
    }
    for (const declaration of preceding.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return preceding.declarationList.flags & ts.NodeFlags.Const
          ? declaration.initializer
          : undefined;
      }
    }
  }
  return undefined;
}

function isOwnPackageRoot(node: ts.Node, name: string): boolean {
  const awaited = node.parent;
  const declaration = awaited?.parent;
  const declarations = declaration?.parent;
  const statement = declarations?.parent;
  // The shipped bootstrap is a direct const initializer. Crossing loops or
  // functions could mistake an outer driverRoot for a shadowing lexical binding.
  if (
    !awaited ||
    !ts.isAwaitExpression(awaited) ||
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== awaited ||
    !declarations ||
    !ts.isVariableDeclarationList(declarations) ||
    !(declarations.flags & ts.NodeFlags.Const) ||
    declarations.declarations.length !== 1 ||
    !statement ||
    !ts.isVariableStatement(statement) ||
    !ts.isBlock(statement.parent)
  ) {
    return false;
  }
  const initializer = precedingConstInitializer(node, name);
  if (
    !initializer ||
    !ts.isCallExpression(initializer) ||
    initializer.questionDotToken ||
    initializer.expression.getText() !== "resolveOpenClawPackageRootSync" ||
    initializer.arguments.length !== 1
  ) {
    return false;
  }
  const options = initializer.arguments[0];
  const property =
    options && ts.isObjectLiteralExpression(options) && options.properties.length === 1
      ? options.properties[0]
      : undefined;
  return Boolean(
    property &&
    ts.isPropertyAssignment(property) &&
    ts.isIdentifier(property.name) &&
    property.name.text === "moduleUrl" &&
    ts.isPropertyAccessExpression(property.initializer) &&
    !property.initializer.questionDotToken &&
    property.initializer.name.text === "url" &&
    ts.isMetaProperty(property.initializer.expression) &&
    property.initializer.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    property.initializer.expression.name.text === "meta",
  );
}

/** Recognize shipped package assets outside the hashed dist compatibility graph. */
export function isUpdatePackageAssetImport(owner: string, node: ts.CallExpression): boolean {
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
    target = precedingConstInitializer(node, target.text);
  }
  if (!target || !ts.isCallExpression(target) || target.expression.getText() !== "path.join") {
    return false;
  }
  const [root, ...segments] = target.arguments;
  if (owner === "src/cli/update-cli/update-command-node-runtime-resolution.ts") {
    const entry = segments[0];
    // The published Node bootstrap resolves installer assets from its own package root.
    // It is not a dist bridge; unknown roots or paths must still fail recording.
    return Boolean(
      node.arguments.length === 1 &&
      !specifier.questionDotToken &&
      !url.questionDotToken &&
      !target.questionDotToken &&
      url.arguments[0] &&
      ts.isCallExpression(url.arguments[0]) &&
      root &&
      ts.isIdentifier(root) &&
      root.text === "driverRoot" &&
      segments.length === 1 &&
      entry &&
      ts.isStringLiteral(entry) &&
      entry.text === "node-runtime-recovery.mjs" &&
      isOwnPackageRoot(node, root.text),
    );
  }
  if (
    owner !== "src/cli/update-cli/update-command-runtime.ts" ||
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
