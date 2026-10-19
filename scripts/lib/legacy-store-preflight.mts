import * as ts from "typescript/unstable/ast";

function bindsFs(name: ts.BindingName): boolean {
  return ts.isIdentifier(name)
    ? name.text === "fs"
    : name.elements.some(
        (element) => ts.isBindingElement(element) && element.name && bindsFs(element.name),
      );
}

function namespaceHasValue(node: ts.ModuleDeclaration): boolean {
  const body = node.body;
  if (!body) {
    return false;
  }
  if (ts.isModuleDeclaration(body)) {
    return namespaceHasValue(body);
  }
  return body.statements.some((statement) => {
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isImportDeclaration(statement) ||
      ts.isEmptyStatement(statement)
    ) {
      return false;
    }
    return !ts.isModuleDeclaration(statement) || namespaceHasValue(statement);
  });
}

/** Prove the exact default node:fs binding permitted by the restart preflight. */
export function createLegacyStorePreflightBindingProof(sourceFile: ts.SourceFile) {
  const hasFsImport = sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "node:fs" &&
      statement.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
      statement.importClause?.name?.text === "fs",
  );
  if (!hasFsImport) {
    return (_identifier: ts.Identifier) => false;
  }

  const shadows = new WeakSet<ts.Node>();
  function visit(node: ts.Node, inputLexicalScope: ts.Node, inputVarScope: ts.Node): void {
    let lexicalScope = inputLexicalScope;
    let varScope = inputVarScope;
    if (
      ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name?.text === "fs") ||
      (ts.isEnumDeclaration(node) && node.name.text === "fs") ||
      (ts.isModuleDeclaration(node) && node.name.text === "fs" && namespaceHasValue(node)) ||
      (ts.isImportEqualsDeclaration(node) && node.name.text === "fs")
    ) {
      shadows.add(lexicalScope);
    }
    if (ts.isVariableDeclaration(node) && bindsFs(node.name)) {
      if (ts.isCatchClause(node.parent)) {
        shadows.add(node.parent);
      } else if (ts.isVariableDeclarationList(node.parent)) {
        shadows.add(node.parent.flags & ts.NodeFlags.BlockScoped ? lexicalScope : varScope);
      }
    }

    if (ts.isFunctionLikeDeclaration(node)) {
      if (
        node.parameters.some((parameter) => bindsFs(parameter.name)) ||
        (ts.isFunctionExpression(node) && node.name?.text === "fs")
      ) {
        shadows.add(node);
      }
      // Body vars do not bind references in parameter default expressions.
      node.forEachChild((child) => visit(child, node, node));
      return;
    }
    if (ts.isClassExpression(node)) {
      if (node.name?.text === "fs") {
        shadows.add(node);
      }
      lexicalScope = node;
    }
    if (
      ts.isBlock(node) ||
      ts.isModuleBlock(node) ||
      ts.isCaseBlock(node) ||
      ts.isCatchClause(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node)
    ) {
      lexicalScope = node;
    }
    if (
      ts.isModuleBlock(node) ||
      (ts.isBlock(node) &&
        (ts.isFunctionLikeDeclaration(node.parent) ||
          ts.isClassStaticBlockDeclaration(node.parent)))
    ) {
      varScope = node;
    }
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (
        clause?.name?.text === "fs" ||
        (bindings &&
          (ts.isNamespaceImport(bindings)
            ? bindings.name.text === "fs"
            : bindings.elements.some((element) => element.name.text === "fs")))
      ) {
        shadows.add(lexicalScope);
      }
    }
    if (ts.isWithStatement(node)) {
      shadows.add(node.statement);
    }
    node.forEachChild((child) => visit(child, lexicalScope, varScope));
  }
  visit(sourceFile, sourceFile, sourceFile);

  return (identifier: ts.Identifier) => {
    if (identifier.text !== "fs") {
      return false;
    }
    for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
      // The native binding query preserves the import even with conflicting
      // declarations at module scope; inner value declarations shadow it.
      if (scope === sourceFile) {
        return true;
      }
      if (shadows.has(scope)) {
        return false;
      }
    }
    return false;
  };
}
