import { createHash } from "node:crypto";
import * as ts from "typescript/unstable/ast";

type ModuleResolver = (specifier: string) => string[];
export type ClosedMockFactory = { line: number; specifier: string; fingerprint: string };

function unwrap(expression: ts.Expression): ts.Expression {
  let node = expression;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertion(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function containsBinding(name: ts.BindingName, expected: string): boolean {
  return ts.isIdentifier(name)
    ? name.text === expected
    : name.elements.some(
        (entry) =>
          ts.isBindingElement(entry) &&
          entry.name !== undefined &&
          containsBinding(entry.name, expected),
      );
}

const functionVariables = new WeakMap<ts.Node, Map<string, ts.VariableDeclaration>>();

function varBindings(scope: ts.Node) {
  const cached = functionVariables.get(scope);
  if (cached) {
    return cached;
  }
  const declarations = new Map<string, ts.VariableDeclaration>();
  const add = (name: ts.BindingName, declaration: ts.VariableDeclaration) => {
    if (ts.isIdentifier(name)) {
      declarations.set(name.text, declaration);
    } else {
      for (const element of name.elements) {
        if (ts.isBindingElement(element) && element.name) {
          add(element.name, declaration);
        }
      }
    }
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionLikeDeclaration(node) ||
      ts.isClassStaticBlockDeclaration(node) ||
      ts.isModuleBlock(node)
    ) {
      return;
    }
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) {
      for (const declaration of node.declarations) {
        add(declaration.name, declaration);
      }
    }
    node.forEachChild(visit);
  };
  scope.forEachChild(visit);
  functionVariables.set(scope, declarations);
  return declarations;
}

function binding(name: string, use: ts.Node): ts.Node | undefined {
  for (let scope: ts.Node | undefined = use.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLikeDeclaration(scope)) {
      const parameter = scope.parameters.find((entry) => containsBinding(entry.name, name));
      if (parameter) {
        return parameter;
      }
      const variable = scope.body && varBindings(scope.body).get(name);
      if (variable) {
        return variable;
      }
    }
    if (ts.isClassStaticBlockDeclaration(scope)) {
      const variable = varBindings(scope.body).get(name);
      if (variable) {
        return variable;
      }
    }
    if (
      ts.isCatchClause(scope) &&
      scope.variableDeclaration &&
      containsBinding(scope.variableDeclaration.name, name)
    ) {
      return scope.variableDeclaration;
    }
    if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
      const initializer = scope.initializer;
      if (
        initializer &&
        ts.isVariableDeclarationList(initializer) &&
        initializer.flags & ts.NodeFlags.BlockScoped
      ) {
        const declaration = initializer.declarations.find((entry) =>
          containsBinding(entry.name, name),
        );
        if (declaration) {
          return declaration;
        }
      }
    }
    const statements = ts.isCaseBlock(scope)
      ? scope.clauses.flatMap((clause) => [...clause.statements])
      : ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)
        ? scope.statements
        : undefined;
    if (!statements) {
      continue;
    }
    for (const statement of statements) {
      if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name?.text === name
      ) {
        return statement;
      }
      if (
        !ts.isVariableStatement(statement) ||
        (statement.declarationList.flags & ts.NodeFlags.BlockScoped) === 0
      ) {
        continue;
      }
      const declaration = statement.declarationList.declarations.find((entry) =>
        containsBinding(entry.name, name),
      );
      if (declaration) {
        return declaration;
      }
    }
    if (ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
      const variable = varBindings(scope).get(name);
      if (variable) {
        return variable;
      }
    }
  }
  return undefined;
}

function collectBindingWrites(source: ts.SourceFile) {
  const writes = new Map<ts.Node, ts.Node[]>();
  const record = (expression: ts.Expression, write: ts.Node) => {
    const target = unwrap(expression);
    if (ts.isIdentifier(target)) {
      const declaration = binding(target.text, target);
      if (declaration) {
        const existing = writes.get(declaration) ?? [];
        existing.push(write);
        writes.set(declaration, existing);
      }
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name)) {
          record(property.name, write);
        } else if (ts.isPropertyAssignment(property)) {
          record(property.initializer, write);
        } else if (ts.isSpreadAssignment(property)) {
          record(property.expression, write);
        }
      }
    } else if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) {
        record(ts.isSpreadElement(element) ? element.expression : element, write);
      }
    } else if (
      ts.isBinaryExpression(target) &&
      target.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      record(target.left, write);
    }
  };
  const recordBinding = (name: ts.BindingName, write: ts.Node) => {
    if (ts.isIdentifier(name)) {
      record(name, write);
    } else {
      for (const element of name.elements) {
        if (ts.isBindingElement(element) && element.name) {
          recordBinding(element.name, write);
        }
      }
    }
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      record(node.left, node);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
    ) {
      record(node.operand, node);
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          recordBinding(declaration.name, node);
        }
      } else if (!ts.isMissingDeclaration(node.initializer)) {
        record(node.initializer, node);
      }
    } else if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.BlockScoped) === 0
    ) {
      for (const declaration of node.declarations) {
        if (declaration.initializer) {
          recordBinding(declaration.name, declaration);
        }
      }
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return writes;
}

function moduleSpecifier(expression: ts.Expression | undefined): string | undefined {
  if (!expression) {
    return undefined;
  }
  const node = unwrap(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return moduleSpecifier(node.arguments[0]);
  }
  return undefined;
}

function isolationException(source: ts.SourceFile, call: ts.Node) {
  const line = source.getLineAndCharacterOfPosition(call.getStart(source)).line;
  const start = source.getLineStarts()[line - 1];
  if (start === undefined || start < call.pos) {
    return false;
  }
  const previous = source.text.slice(start, source.getLineStarts()[line]).trim();
  return /^\/\/ mock-isolation: \S.*$/u.test(previous);
}

function factoryFunction(
  expression: ts.Expression,
  writes: ReadonlyMap<ts.Node, readonly ts.Node[]>,
  seen = new Set<ts.Node>(),
): ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | undefined {
  const node = unwrap(expression);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return node;
  }
  if (!ts.isIdentifier(node)) {
    return undefined;
  }
  const declaration = binding(node.text, node);
  if (!declaration || seen.has(declaration) || writes.has(declaration)) {
    return undefined;
  }
  seen.add(declaration);
  if (ts.isFunctionDeclaration(declaration)) {
    return declaration;
  }
  if (
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    declaration.initializer
  ) {
    return factoryFunction(declaration.initializer, writes, seen);
  }
  return undefined;
}

function factoryIdentityNodes(
  factory: ts.Expression,
  writes: ReadonlyMap<ts.Node, readonly ts.Node[]>,
) {
  const nodes: ts.Node[] = [factory];
  const seen = new Set<ts.Node>();
  const visit = (expression: ts.Expression) => {
    const node = unwrap(expression);
    if (!ts.isIdentifier(node)) {
      return;
    }
    const declaration = binding(node.text, node);
    if (!declaration || seen.has(declaration)) {
      return;
    }
    seen.add(declaration);
    const assignments = writes.get(declaration) ?? [];
    nodes.push(declaration, ...assignments);
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      visit(declaration.initializer);
    }
    for (const assignment of assignments) {
      if (ts.isBinaryExpression(assignment)) {
        visit(assignment.right);
      } else if (ts.isVariableDeclaration(assignment) && assignment.initializer) {
        visit(assignment.initializer);
      } else if (ts.isForInStatement(assignment) || ts.isForOfStatement(assignment)) {
        visit(assignment.expression);
      }
    }
  };
  visit(factory);
  return nodes;
}

function preservesRealModule(
  factory: ts.Expression,
  targets: string[],
  resolve: ModuleResolver,
  viNames: Set<string>,
  writes: ReadonlyMap<ts.Node, readonly ts.Node[]>,
) {
  const fn = factoryFunction(factory, writes);
  if (!fn?.body) {
    return false;
  }
  const parameter = fn.parameters[0];
  const importOriginal =
    parameter &&
    ts.isIdentifier(parameter.name) &&
    !parameter.dotDotDotToken &&
    !writes.has(parameter)
      ? parameter
      : undefined;
  const sameModule = (node: ts.Expression | undefined) => {
    const specifier = moduleSpecifier(node);
    if (specifier === undefined) {
      return false;
    }
    const imported = resolve(specifier).toSorted();
    return imported.length > 0 && JSON.stringify(imported) === JSON.stringify(targets.toSorted());
  };
  const real = (
    expression: ts.Expression,
    needsResolved = false,
    seen = new Set<ts.Node>(),
  ): boolean => {
    const node = unwrap(expression);
    if (seen.has(node)) {
      return false;
    }
    seen.add(node);
    if (ts.isAwaitExpression(node)) {
      return real(node.expression, false, seen);
    }
    if (ts.isIdentifier(node)) {
      const declaration = binding(node.text, node);
      return (
        declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        ts.isIdentifier(declaration.name) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
        declaration.initializer !== undefined &&
        real(declaration.initializer, needsResolved, seen)
      );
    }
    if (needsResolved || !ts.isCallExpression(node)) {
      return false;
    }
    const callee = unwrap(node.expression);
    if (ts.isIdentifier(callee)) {
      return (
        importOriginal !== undefined &&
        binding(callee.text, callee) === importOriginal &&
        node.arguments.length === 0
      );
    }
    return (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      viNames.has(callee.expression.text) &&
      !binding(callee.expression.text, callee.expression) &&
      callee.name.text === "importActual" &&
      sameModule(node.arguments[0])
    );
  };
  const complete = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const node = unwrap(expression);
    if (seen.has(node)) {
      return false;
    }
    seen.add(node);
    if (real(node)) {
      return true;
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.some(
        (property) => ts.isSpreadAssignment(property) && real(property.expression, true),
      );
    }
    if (ts.isIdentifier(node)) {
      const declaration = binding(node.text, node);
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        ts.isIdentifier(declaration.name) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
        declaration.initializer
      ) {
        return complete(declaration.initializer, seen);
      }
    }
    if (ts.isAwaitExpression(node)) {
      return complete(node.expression, seen);
    }
    if (ts.isConditionalExpression(node)) {
      return complete(node.whenTrue, new Set(seen)) && complete(node.whenFalse, new Set(seen));
    }
    return false;
  };
  if (!ts.isBlock(fn.body)) {
    return complete(fn.body);
  }
  const returns: Array<ts.Expression | undefined> = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLikeDeclaration(node)) {
      return;
    }
    if (ts.isReturnStatement(node)) {
      returns.push(node.expression);
    } else {
      node.forEachChild(visit);
    }
  };
  fn.body.forEachChild(visit);
  return (
    returns.length > 0 &&
    returns.every((expression) => expression !== undefined && complete(expression))
  );
}

/** First-party factories must preserve exports or name their isolation contract. */
export function scanClosedMockFactories(
  source: ts.SourceFile,
  resolve: ModuleResolver,
): ClosedMockFactory[] {
  const writes = collectBindingWrites(source);
  const viNames = new Set(["vi", "vitest"]);
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "vitest"
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const entry of bindings.elements) {
        if (["vi", "vitest"].includes((entry.propertyName ?? entry.name).text)) {
          viNames.add(entry.name.text);
        }
      }
    }
  }
  const findings: ClosedMockFactory[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      viNames.has(node.expression.expression.text) &&
      ["mock", "doMock"].includes(node.expression.name.text)
    ) {
      const specifier = moduleSpecifier(node.arguments[0]);
      const factory = node.arguments[1];
      const targets = specifier === undefined ? [] : resolve(specifier);
      if (
        specifier !== undefined &&
        factory &&
        !ts.isObjectLiteralExpression(unwrap(factory)) &&
        targets.length > 0 &&
        !isolationException(source, node) &&
        !preservesRealModule(factory, targets, resolve, viNames, writes)
      ) {
        // Token identity survives formatting and comments, but not replacement factories.
        const nodes = factoryIdentityNodes(factory, writes);
        const hash = createHash("sha256");
        for (const identityNode of nodes) {
          const scanner = ts.createScanner(
            true,
            source.languageVariant,
            source.text,
            identityNode.getStart(source),
            identityNode.end - identityNode.getStart(source),
          );
          hash.update("factory-node:");
          for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFile; kind = scanner.scan()) {
            hash.update(JSON.stringify([scanner.getTokenText()]));
          }
        }
        findings.push({
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          specifier,
          fingerprint: hash.digest("hex"),
        });
      }
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return findings;
}
