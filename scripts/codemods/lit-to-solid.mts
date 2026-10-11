import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import {
  createNativeTypeScriptParser,
  type NativeTypeScriptParser,
} from "../lib/native-typescript.mts";
import { templateToJsx } from "./lit-template.mts";

type ConversionDiagnostic = { line: number; column: number; reason: string };
type Edit = { start: number; end: number; text: string };
type Context = {
  attribute?: boolean;
  child?: boolean;
  reads: Map<ts.Node, string>;
  narrowed?: { text: string; binding: ts.Node | undefined; accessor: string }[];
};

function replaceRanges(text: string, offset: number, edits: Edit[]) {
  let result = text;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start - offset) + edit.text + result.slice(edit.end - offset);
  }
  return result;
}

/** Syntax-only edits remain safe even inside expressions left for manual conversion. */
function tsxText(node: ts.Node, source: ts.SourceFile): string {
  if (ts.isTypeAssertion(node)) {
    return `(${tsxText(node.expression, source)} as ${tsxText(node.type, source)})`;
  }
  const edits: Edit[] = [];
  node.forEachChild((child) => {
    const text = tsxText(child, source);
    if (text !== child.getText(source)) {
      edits.push({ start: child.getStart(source), end: child.end, text });
    }
  });
  if (
    ts.isArrowFunction(node) &&
    node.typeParameters?.length === 1 &&
    !node.typeParameters.hasTrailingComma
  ) {
    const parameter = node.typeParameters[0]!;
    if (!parameter.constraint && !parameter.defaultType) {
      edits.push({ start: parameter.end, end: parameter.end, text: "," });
    }
  }
  return replaceRanges(node.getText(source), node.getStart(source), edits);
}

function isFunction(node: ts.Node) {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isAccessorDeclaration(node)
  );
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertion(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticPropertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (
    ts.isComputedPropertyName(name) &&
    (ts.isStringLiteral(name.expression) || ts.isNoSubstitutionTemplateLiteral(name.expression))
  ) {
    return name.expression.text;
  }
  return undefined;
}

function isReference(node: ts.Identifier) {
  const parent = node.parent;
  if (
    (ts.isTypeParameterDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isAccessorDeclaration(parent) ||
      ts.isMethodSignatureDeclaration(parent) ||
      ts.isPropertySignatureDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (
    (ts.isParameterDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) {
    return false;
  }
  return true;
}

function shadowsType(node: ts.Node, name: string): boolean {
  for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
    let shadowed = false;
    scope.forEachChild((child) => {
      if (
        (ts.isTypeParameterDeclaration(child) ||
          ts.isTypeAliasDeclaration(child) ||
          ts.isInterfaceDeclaration(child)) &&
        child.name.text === name
      ) {
        shadowed = true;
      }
    });
    if (shadowed) {
      return true;
    }
  }
  return false;
}

function directiveExports(source: ts.SourceFile) {
  const factories = new Set<string>();
  const exports = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/^(?:lit|lit-html)\/(?:async-)?directive\.js$/u.test(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const names = statement.importClause?.namedBindings;
    if (names && ts.isNamespaceImport(names)) {
      factories.add(`${names.name.text}.directive`);
    }
    if (names && ts.isNamedImports(names)) {
      for (const name of names.elements) {
        if ((name.propertyName ?? name.name).text === "directive") {
          factories.add(name.name.text);
        }
      }
    }
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      factories.has(node.initializer.expression.getText(source))
    ) {
      exports.add(node.name.text);
    }
    node.forEachChild(visit);
  };
  visit(source);
  for (const statement of source.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const specifier of statement.exportClause.elements) {
        if (exports.has((specifier.propertyName ?? specifier.name).text)) {
          exports.add(specifier.name.text);
        }
      }
    }
  }
  return exports;
}

function bindingNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) {
    return [name];
  }
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) && element.name ? bindingNames(element.name) : [],
  );
}

/** Bind identifiers lexically, so aliases work without converting shadowed helpers or callback locals. */
function lexicalBindings(source: ts.SourceFile) {
  const scopes = new Map<ts.Node, Map<string, ts.Node>>();
  const declare = (owner: ts.Node, name: ts.Identifier, declaration: ts.Node) => {
    let bindings = scopes.get(owner);
    if (!bindings) {
      scopes.set(owner, (bindings = new Map()));
    }
    bindings.set(name.text, declaration);
  };
  const enclosing = (node: ts.Node, functionOnly = false): ts.Node => {
    let owner = node.parent;
    while (owner !== source && !isFunction(owner)) {
      if (
        !functionOnly &&
        (ts.isBlock(owner) ||
          ts.isForStatement(owner) ||
          ts.isForOfStatement(owner) ||
          ts.isForInStatement(owner) ||
          ts.isCaseBlock(owner))
      ) {
        break;
      }
      owner = owner.parent;
    }
    return owner;
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node)) {
      declare(source, node.name, node);
    }
    if (ts.isNamespaceImport(node)) {
      declare(source, node.name, node);
    }
    if (ts.isImportClause(node) && node.name) {
      declare(source, node.name, node);
    }
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent;
      const owner = ts.isCatchClause(list)
        ? list
        : enclosing(
            node,
            ts.isVariableDeclarationList(list) && !(list.flags & ts.NodeFlags.BlockScoped),
          );
      for (const name of bindingNames(node.name)) {
        declare(owner, name, node);
      }
    }
    if (ts.isParameterDeclaration(node)) {
      for (const name of bindingNames(node.name)) {
        declare(node.parent, name, node);
      }
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      declare(enclosing(node), node.name, node);
    }
    if (ts.isFunctionExpression(node) && node.name) {
      declare(node, node.name, node);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return (node: ts.Identifier) => {
    let owner: ts.Node | undefined = node;
    while (owner) {
      const binding = scopes.get(owner)?.get(node.text);
      if (binding) {
        return binding;
      }
      owner = owner.parent;
    }
    return undefined;
  };
}

const manualDirectives = new Set([
  "asyncAppend",
  "asyncReplace",
  "keyed",
  "live",
  "guard",
  "cache",
  "until",
  "unsafeHTML",
  "unsafeSVG",
  "ref",
  "createRef",
  "directive",
  "unsafeStatic",
  "literal",
  "render",
]);
const lifecycleMethods = new Set([
  "connectedCallback",
  "disconnectedCallback",
  "willUpdate",
  "updated",
  "firstUpdated",
  "performUpdate",
  "shouldUpdate",
  "getUpdateComplete",
  "requestUpdate",
  "hostConnected",
  "hostDisconnected",
  "hostUpdated",
  "hostUpdate",
]);
const bindingFactories = new Set([
  ...manualDirectives,
  "classMap",
  "styleMap",
  "ifDefined",
  "repeat",
  "html",
  "svg",
]);

/** Mechanical conversion only. Diagnostics mark every site still requiring ownership judgment. */
export function convertLitToSolid(
  sourceText: string,
  fileName: string,
  sharedParser?: NativeTypeScriptParser,
) {
  const parser = sharedParser ?? createNativeTypeScriptParser();
  try {
    const hashbang = /^#![^\r\n]*(?:\r?\n|$)/u.exec(sourceText)?.[0] ?? "";
    const source = parser.parseSourceFile(fileName, sourceText);
    const syntax = parser.getSyntacticDiagnostics(fileName);
    if (syntax.length) {
      throw new Error(
        `Cannot convert invalid TypeScript: ${syntax.map((item) => item.text).join("; ")}`,
      );
    }
    const resolve = lexicalBindings(source);
    const imports = new Map<
      ts.Node,
      { name: string; module: string; directive?: boolean; directives?: ReadonlySet<string> }
    >();
    const diagnostics: ConversionDiagnostic[] = [];
    const usedHelpers = new Map<string, string>();
    const identifiers = new Set<string>();
    const mutableBindings = new Set<ts.Node>();
    const mutableMembers: (ts.PropertyAccessExpression | ts.ElementAccessExpression)[] = [];
    const mutableCollections: ts.Expression[] = [];
    const typeAliases = new Map<string, ts.Node[]>();
    const classTypes = new Set<string>();
    const classDeclarations = new Map<string, ts.ClassDeclaration>();
    const optionWrites: (ts.PropertyAccessExpression | ts.ElementAccessExpression)[] = [];
    const configuredListeners: ts.Expression[] = [];
    const collectPatternWrites = (target: ts.Node): void => {
      if (ts.isIdentifier(target)) {
        const binding = resolve(target);
        if (binding) {
          mutableBindings.add(binding);
        }
      } else if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        mutableMembers.push(target);
        optionWrites.push(target);
        let receiver: ts.Expression = target.expression;
        while (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) {
          receiver = receiver.expression;
        }
        if (ts.isIdentifier(receiver)) {
          const binding = resolve(receiver);
          if (binding) {
            mutableBindings.add(binding);
          }
        }
      } else if (ts.isPropertyAssignment(target)) {
        collectPatternWrites(target.initializer);
      } else if (ts.isShorthandPropertyAssignment(target)) {
        collectPatternWrites(target.name);
      } else if (ts.isBinaryExpression(target)) {
        collectPatternWrites(target.left);
      } else if (
        ts.isSpreadElement(target) ||
        ts.isSpreadAssignment(target) ||
        ts.isParenthesizedExpression(target)
      ) {
        collectPatternWrites(target.expression);
      } else if (ts.isArrayLiteralExpression(target) || ts.isObjectLiteralExpression(target)) {
        target.forEachChild(collectPatternWrites);
      }
    };
    const collectNames = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        identifiers.add(node.text);
      }
      if (ts.isTypeAliasDeclaration(node)) {
        typeAliases.set(node.name.text, [...(typeAliases.get(node.name.text) ?? []), node.type]);
      }
      if (ts.isInterfaceDeclaration(node)) {
        typeAliases.set(node.name.text, [...(typeAliases.get(node.name.text) ?? []), node]);
      }
      if (ts.isClassDeclaration(node) && node.name) {
        classTypes.add(node.name.text);
        classDeclarations.set(node.name.text, node);
      }
      if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
        if (ts.isVariableDeclarationList(node.initializer)) {
          for (const declaration of node.initializer.declarations) {
            mutableBindings.add(declaration);
          }
        } else {
          collectPatternWrites(node.initializer);
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        (ts.isArrayLiteralExpression(node.left) || ts.isObjectLiteralExpression(node.left))
      ) {
        collectPatternWrites(node.left);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
      ) {
        optionWrites.push(node.left);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isIdentifier(node.left)
      ) {
        const binding = resolve(node.left);
        if (binding) {
          mutableBindings.add(binding);
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
      ) {
        mutableMembers.push(node.left);
        if (
          ts.isElementAccessExpression(node.left) ||
          (ts.isPropertyAccessExpression(node.left) && node.left.name.text === "length")
        ) {
          mutableCollections.push(node.left.expression);
        }
        if (ts.isElementAccessExpression(node.left)) {
          let root: ts.Expression = node.left.expression;
          while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
            root = root.expression;
          }
          if (ts.isIdentifier(root)) {
            const binding = resolve(root);
            if (binding) {
              mutableBindings.add(binding);
            }
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        [
          "push",
          "unshift",
          "splice",
          "fill",
          "copyWithin",
          "sort",
          "reverse",
          "set",
          "add",
        ].includes(node.expression.name.text)
      ) {
        mutableCollections.push(node.expression.expression);
      }
      if (ts.isDeleteExpression(node)) {
        const target = node.expression;
        if (ts.isElementAccessExpression(target)) {
          mutableCollections.push(target.expression);
        }
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
        ts.isPropertyAccessExpression(node.operand) &&
        node.operand.name.text === "length"
      ) {
        mutableCollections.push(node.operand.expression);
      }
      if (
        ts.isCallExpression(node) &&
        ["Object.assign", "Object.defineProperty", "Object.defineProperties"].includes(
          node.expression.getText(source),
        ) &&
        node.arguments[0]
      ) {
        configuredListeners.push(node.arguments[0]);
      }
      node.forEachChild(collectNames);
    };
    collectNames(source);
    // Generated helpers require the real intrinsics, even inside nested template scopes.
    if (identifiers.has("globalThis")) {
      let shadowed = false;
      const inspectGlobal = (node: ts.Node) => {
        if (ts.isIdentifier(node) && node.text === "globalThis" && resolve(node)) {
          shadowed = true;
        }
        node.forEachChild(inspectGlobal);
      };
      inspectGlobal(source);
      if (shadowed) {
        const edits = source.statements.map((statement) => ({
          start: statement.getStart(source),
          end: statement.end,
          text: tsxText(statement, source),
        }));
        const repaired = replaceRanges(sourceText, 0, edits).slice(hashbang.length);
        const code = `${hashbang}/* TODO(solid2): local globalThis binding shadows generated intrinsics */\n${repaired}`;
        parser.parseSourceFile(fileName.replace(/\.(?:m?tsx?|jsx?)$/u, ".tsx"), code);
        if (parser.getSyntacticDiagnostics().length) {
          throw new Error(`Conversion produced invalid final TSX for ${fileName}`);
        }
        return {
          code,
          diagnostics: [
            { line: 1, column: 1, reason: "local globalThis binding shadows generated intrinsics" },
          ],
          templates: 0,
        };
      }
    }
    const localDirectives = directiveExports(source);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      const directives = new Set<string>();
      if (statement.moduleSpecifier.text.startsWith(".")) {
        const requested = path.resolve(path.dirname(fileName), statement.moduleSpecifier.text);
        const dependency = [requested, requested.replace(/\.js$/u, ".ts")].find(
          (file) => fs.existsSync(file) && fs.statSync(file).isFile(),
        );
        if (dependency) {
          const text = fs.readFileSync(dependency, "utf8");
          if (/directive/u.test(text)) {
            for (const name of directiveExports(parser.parseSourceFile(dependency, text))) {
              directives.add(name);
            }
          }
        }
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          const name = (specifier.propertyName ?? specifier.name).text;
          imports.set(specifier, {
            name,
            module: statement.moduleSpecifier.text,
            directive: directives.has(name),
          });
        }
      }
      if (bindings && ts.isNamespaceImport(bindings)) {
        imports.set(bindings, { name: "*", module: statement.moduleSpecifier.text, directives });
      }
    }
    const imported = (node: ts.Node, name?: string) => {
      const identifier = ts.isIdentifier(node)
        ? node
        : ts.isQualifiedName(node) && ts.isIdentifier(node.left)
          ? node.left
          : ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
            ? node.expression
            : undefined;
      if (!identifier) {
        return undefined;
      }
      const binding = resolve(identifier);
      const value = binding && imports.get(binding);
      const selected =
        value?.name === "*" && ts.isPropertyAccessExpression(node)
          ? { ...value, name: node.name.text, directive: value.directives?.has(node.name.text) }
          : value?.name === "*" && ts.isQualifiedName(node)
            ? { ...value, name: node.right.text }
            : value;
      return selected && (!name || selected.name === name) ? selected : undefined;
    };
    const lit = (node: ts.Node, name?: string) => {
      const value = imported(node, name);
      return value && /^(?:lit(?:-html)?(?:\/|$)|@lit\/)/u.test(value.module) ? value : undefined;
    };
    const isDirective = (expression: ts.Expression, name: string) => {
      let unwrapped = expression;
      while (ts.isParenthesizedExpression(unwrapped) || ts.isNonNullExpression(unwrapped)) {
        unwrapped = unwrapped.expression;
      }
      return ts.isCallExpression(unwrapped) && Boolean(lit(unwrapped.expression, name));
    };
    const localValue = (
      node: ts.Expression,
      seen = new Set<ts.Node>(),
    ):
      | ts.Expression
      | ts.FunctionDeclaration
      | ts.MethodDeclaration
      | ts.GetAccessorDeclaration => {
      const expression = unwrapExpression(node);
      if (seen.has(expression)) {
        return expression;
      }
      seen.add(expression);
      if (ts.isIdentifier(expression)) {
        const binding = resolve(expression);
        if (binding && ts.isFunctionDeclaration(binding)) {
          return binding;
        }
        if (
          binding &&
          ts.isVariableDeclaration(binding) &&
          binding.initializer &&
          ts.isIdentifier(binding.name)
        ) {
          return localValue(binding.initializer, seen);
        }
      }
      if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
        const receiver = localValue(expression.expression, seen);
        if (ts.isGetAccessorDeclaration(receiver)) {
          return receiver;
        }
        const name = ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : expression.argumentExpression &&
              (ts.isStringLiteral(expression.argumentExpression) ||
                ts.isNumericLiteral(expression.argumentExpression))
            ? expression.argumentExpression.text
            : undefined;
        if (name && ts.isNewExpression(receiver)) {
          const declaration = classDeclarations.get(receiver.expression.getText(source));
          const member = declaration?.members.find(
            (item) =>
              (ts.isPropertyDeclaration(item) ||
                ts.isMethodDeclaration(item) ||
                ts.isGetAccessorDeclaration(item) ||
                ts.isSetAccessorDeclaration(item) ||
                ts.isAccessorDeclaration(item)) &&
              staticPropertyName(item.name) === name,
          );
          if (member && (ts.isGetAccessorDeclaration(member) || ts.isMethodDeclaration(member))) {
            return member;
          }
          if (member && ts.isPropertyDeclaration(member) && member.initializer) {
            return localValue(member.initializer, seen);
          }
        }
        if (name && ts.isObjectLiteralExpression(receiver)) {
          const property = receiver.properties.find(
            (entry) => !ts.isSpreadAssignment(entry) && staticPropertyName(entry.name) === name,
          );
          if (
            property &&
            (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property))
          ) {
            return property;
          }
          if (property && ts.isPropertyAssignment(property)) {
            return localValue(property.initializer, seen);
          }
          if (
            property &&
            ts.isShorthandPropertyAssignment(property) &&
            ts.isIdentifier(property.name)
          ) {
            return localValue(property.name, seen);
          }
        }
        if (name && ts.isArrayLiteralExpression(receiver)) {
          const item = receiver.elements[Number(name)];
          if (item && !ts.isOmittedExpression(item) && !ts.isSpreadElement(item)) {
            return localValue(item, seen);
          }
        }
      }
      return expression;
    };
    const hasNestedDirective = (node: ts.Node): boolean => {
      if (
        ts.isCallExpression(node) &&
        (lit(node.expression, "classMap") || lit(node.expression, "styleMap"))
      ) {
        return true;
      }
      let found = false;
      node.forEachChild((child) => {
        if (hasNestedDirective(child)) {
          found = true;
        }
      });
      return found;
    };
    const isHostReceiver = (node: ts.Expression, seen = new Set<ts.Node>()): boolean => {
      const expression = unwrapExpression(node);
      if (expression.kind === ts.SyntaxKind.ThisKeyword) {
        return true;
      }
      if (seen.has(expression)) {
        return false;
      }
      seen.add(expression);
      if (ts.isIdentifier(expression)) {
        const binding = resolve(expression);
        if (binding && ts.isVariableDeclaration(binding) && binding.initializer) {
          return isHostReceiver(binding.initializer, seen);
        }
      }
      return false;
    };
    const hasListenerOptions = (node: ts.Expression, seen = new Set<ts.Node>()): boolean => {
      const expression = unwrapExpression(node);
      const sameValue = (receiver: ts.Expression) =>
        localValue(receiver) === localValue(expression) ||
        (ts.isIdentifier(receiver) &&
          ts.isIdentifier(expression) &&
          resolve(receiver) === resolve(expression)) ||
        receiver.getText(source) === expression.getText(source);
      if (
        configuredListeners.some(sameValue) ||
        optionWrites.some((write) => {
          const key = ts.isPropertyAccessExpression(write)
            ? write.name.text
            : write.argumentExpression && localValue(write.argumentExpression);
          const name =
            typeof key === "string" ? key : key && ts.isStringLiteral(key) ? key.text : undefined;
          return (
            (!name || ["once", "capture", "passive"].includes(name)) && sameValue(write.expression)
          );
        })
      ) {
        return true;
      }
      if (seen.has(expression)) {
        return false;
      }
      seen.add(expression);
      const receiverDependent = (fn: ts.FunctionLikeDeclaration) => {
        let found = false;
        const inspect = (part: ts.Node) => {
          if (
            part.kind === ts.SyntaxKind.ThisKeyword ||
            (ts.isParameterDeclaration(part) && part.name.getText(source) === "this")
          ) {
            found = true;
          }
          part.forEachChild(inspect);
        };
        inspect(fn);
        return found;
      };
      if (ts.isFunctionExpression(expression)) {
        return receiverDependent(expression);
      }
      const resolved = localValue(expression);
      if (ts.isFunctionDeclaration(resolved) || ts.isMethodDeclaration(resolved)) {
        return receiverDependent(resolved);
      }
      if (ts.isGetAccessorDeclaration(resolved)) {
        return true;
      }
      if (resolved !== expression) {
        return hasListenerOptions(resolved, seen);
      }
      if (ts.isObjectLiteralExpression(expression)) {
        return true;
      }
      if (
        (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
        isHostReceiver(expression.expression)
      ) {
        return true;
      }
      if (ts.isIdentifier(expression)) {
        const binding = resolve(expression);
        if (binding && ts.isFunctionDeclaration(binding)) {
          return receiverDependent(binding);
        }
        if (binding && ts.isVariableDeclaration(binding) && binding.initializer) {
          return hasListenerOptions(binding.initializer, seen);
        }
      }
      if (ts.isConditionalExpression(expression)) {
        return (
          hasListenerOptions(expression.whenTrue, seen) ||
          hasListenerOptions(expression.whenFalse, seen)
        );
      }
      if (ts.isBinaryExpression(expression)) {
        return (
          hasListenerOptions(expression.left, seen) || hasListenerOptions(expression.right, seen)
        );
      }
      if (
        ts.isCallExpression(expression) &&
        expression.arguments.some(
          (argument) =>
            ts.isObjectLiteralExpression(argument) &&
            argument.properties.some(
              (property) =>
                !ts.isSpreadAssignment(property) &&
                ["once", "capture", "passive", "handleEvent"].includes(
                  staticPropertyName(property.name) ?? "",
                ),
            ),
        )
      ) {
        return true;
      }
      return false;
    };
    const helper = (name: string) => {
      let alias = usedHelpers.get(name);
      if (!alias) {
        alias = name;
        while (identifiers.has(alias)) {
          alias = `Solid${alias}`;
        }
        identifiers.add(alias);
        usedHelpers.set(name, alias);
      }
      return alias;
    };
    const rootBinding = (node: ts.Node): ts.Node | undefined => {
      let root = node;
      while (ts.isPropertyAccessExpression(root) || ts.isQualifiedName(root)) {
        root = ts.isPropertyAccessExpression(root) ? root.expression : root.left;
      }
      return ts.isIdentifier(root) ? resolve(root) : undefined;
    };
    const hasNothing = (node: ts.Node): boolean => {
      if (
        lit(node, "nothing") ||
        (ts.isCallExpression(node) && lit(node.expression, "ifDefined"))
      ) {
        return true;
      }
      let found = false;
      node.forEachChild((child) => {
        if (hasNothing(child)) {
          found = true;
        }
      });
      return found;
    };
    const isOmissionResult = (node: ts.Expression): boolean => {
      const expression = unwrapExpression(node);
      if (!hasNothing(expression) || lit(expression, "nothing")) {
        return true;
      }
      if (ts.isConditionalExpression(expression)) {
        return (
          !hasNothing(expression.condition) &&
          isOmissionResult(expression.whenTrue) &&
          isOmissionResult(expression.whenFalse)
        );
      }
      if (
        ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return !hasNothing(expression.left) && isOmissionResult(expression.right);
      }
      return false;
    };
    const note = (node: ts.Node, reason: string) => {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      if (
        !diagnostics.some(
          (item) =>
            item.line === line + 1 && item.column === character + 1 && item.reason === reason,
        )
      ) {
        diagnostics.push({ line: line + 1, column: character + 1, reason });
      }
    };
    const marker = (reason: string) => `/* TODO(solid2): ${reason.replaceAll("*/", "* /")} */`;
    const manual = (node: ts.Node, reason: string) => {
      note(node, reason);
      if (
        ts.isIdentifier(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isQualifiedName(node)
      ) {
        return `${marker(reason)} ${tsxText(node, source)}`;
      }
      return `(${marker(reason)} ${tsxText(node, source)})`;
    };
    let templates = 0;
    const render = (node: ts.Node, context: Context): string => {
      const escaped = lit(node);
      if (
        escaped &&
        (bindingFactories.has(escaped.name) || escaped.module.includes("/directives/")) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
        ((ts.isIdentifier(node) && isReference(node)) || ts.isPropertyAccessExpression(node))
      ) {
        return manual(node, `${escaped.name} factory escapes its binding context`);
      }
      const narrowed = context.narrowed?.find(
        (entry) => node.getText(source) === entry.text && rootBinding(node) === entry.binding,
      );
      if (
        narrowed &&
        (ts.isPropertyAccessExpression(node) || (ts.isIdentifier(node) && isReference(node)))
      ) {
        return `${narrowed.accessor}()`;
      }
      if (lit(node, "noChange")) {
        return manual(node, "noChange requires retained binding state");
      }
      if (ts.isPropertyAccessExpression(node) && lit(node, "nothing")) {
        if (!context.attribute && !context.child) {
          return manual(node, "nothing outside a binding needs an omission-context decision");
        }
        return context.attribute ? "undefined" : "null";
      }
      if (
        ts.isTypeReferenceNode(node) &&
        !(ts.isIdentifier(node.typeName) && shadowsType(node, node.typeName.text)) &&
        ["TemplateResult", "SVGTemplateResult", "HTMLTemplateResult"].includes(
          lit(node.typeName)?.name ?? "",
        )
      ) {
        return `${helper("JSX")}.Element`;
      }
      if (ts.isTypeQueryNode(node) && lit(node.exprName, "nothing")) {
        return "(null | undefined)";
      }
      if (ts.isTaggedTemplateExpression(node) && (lit(node.tag, "html") || lit(node.tag, "svg"))) {
        const previousTemplates = templates;
        const previousDiagnostics = diagnostics.length;
        const previousHelpers = new Map(usedHelpers);
        try {
          const result = templateToJsx(node, {
            expression: (expression, attribute) => {
              if (attribute && !isOmissionResult(expression)) {
                throw new Error("semantic nothing use needs its original sentinel");
              }
              return attribute
                ? render(expression, { ...context, attribute, child: false })
                : renderChild(expression, context);
            },
            hasNothing,
            attribute: (expression) => renderAttribute(expression, context),
            isClassMap: (expression) => isDirective(expression, "classMap"),
            isStyleMap: (expression) => isDirective(expression, "styleMap"),
            hasNestedDirective,
            hasListenerOptions,
            svg: Boolean(lit(node.tag, "svg")),
            directive: (expression) =>
              note(expression, "custom element directive needs an owned ref factory"),
          });
          templates += 1;
          return result;
        } catch (error) {
          templates = previousTemplates;
          diagnostics.splice(previousDiagnostics);
          usedHelpers.clear();
          for (const [name, alias] of previousHelpers) {
            usedHelpers.set(name, alias);
          }
          return manual(node, error instanceof Error ? error.message : String(error));
        }
      }
      if (ts.isIdentifier(node) && isReference(node) && !ts.isTypeNode(node.parent)) {
        if (lit(node, "nothing")) {
          if (!context.attribute && !context.child) {
            return manual(node, "nothing outside a binding needs an omission-context decision");
          }
          return context.attribute ? "undefined" : "null";
        }
        const binding = resolve(node);
        if (binding && context.reads.has(binding) && !ts.isTypeNode(node.parent)) {
          return `${context.reads.get(binding)}()`;
        }
      }
      if (ts.isShorthandPropertyAssignment(node) && ts.isIdentifier(node.name)) {
        const name = node.name;
        const shorthandNarrowing = context.narrowed?.find(
          (entry) => name.text === entry.text && resolve(name) === entry.binding,
        );
        if (shorthandNarrowing) {
          return `${name.text}: ${shorthandNarrowing.accessor}()`;
        }
        const binding = resolve(name);
        if (binding && context.reads.has(binding)) {
          return `${name.text}: ${context.reads.get(binding)}()`;
        }
      }
      if (ts.isCallExpression(node)) {
        const importedCall = lit(node.expression);
        if (importedCall && ["html", "svg"].includes(importedCall.name)) {
          return manual(node, "direct template-tag calls need manual conversion");
        }
        if (
          importedCall &&
          importedCall.module.includes("/directives/") &&
          !["styleMap", "classMap", "ifDefined", "repeat"].includes(importedCall.name)
        ) {
          return manual(node, `${importedCall.name} directive needs manual conversion`);
        }
        if (
          !context.attribute &&
          importedCall &&
          ["styleMap", "classMap", "ifDefined"].includes(importedCall.name)
        ) {
          return manual(node, `${importedCall.name} outside its binding needs manual conversion`);
        }
        const binding = ts.isIdentifier(node.expression) ? resolve(node.expression) : undefined;
        if (
          imported(node.expression)?.directive ||
          (binding &&
            ts.isVariableDeclaration(binding) &&
            ts.isIdentifier(binding.name) &&
            localDirectives.has(binding.name.text) &&
            binding.initializer &&
            ts.isCallExpression(binding.initializer) &&
            lit(binding.initializer.expression, "directive"))
        ) {
          return manual(node, "custom directive needs an owned Solid equivalent");
        }
        if (importedCall && manualDirectives.has(importedCall.name)) {
          return manual(node, `${importedCall.name} requires manual lifecycle or DOM ownership`);
        }
        if (importedCall?.name === "styleMap" && node.arguments.length === 1) {
          const object = node.arguments[0]!;
          if (!ts.isObjectLiteralExpression(object)) {
            return manual(node, "dynamic styleMap keys need manual normalization");
          }
          const properties: string[] = [];
          for (const property of object.properties) {
            if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
              return manual(node, "computed or spread styleMap keys need manual normalization");
            }
            if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) {
              return manual(node, "computed styleMap key needs manual normalization");
            }
            const name = property.name.text;
            const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
            let hasPriority = false;
            let dynamicPriority = false;
            const inspected = new Set<ts.Node>();
            const inspectPriority = (valueNode: ts.Node) => {
              if (inspected.has(valueNode)) {
                return;
              }
              inspected.add(valueNode);
              if (ts.isCallExpression(valueNode)) {
                dynamicPriority = true;
              }
              if (ts.isIdentifier(valueNode)) {
                const valueBinding = resolve(valueNode);
                if (valueBinding && ts.isParameterDeclaration(valueBinding)) {
                  dynamicPriority = true;
                }
                if (valueBinding && mutableBindings.has(valueBinding)) {
                  dynamicPriority = true;
                }
                if (
                  valueBinding &&
                  ts.isVariableDeclaration(valueBinding) &&
                  valueBinding.initializer
                ) {
                  inspectPriority(valueBinding.initializer);
                }
              }
              if (
                mutableMembers.some(
                  (member) =>
                    member.getText(source) === valueNode.getText(source) &&
                    rootBinding(member) === rootBinding(valueNode),
                )
              ) {
                dynamicPriority = true;
              }
              if (
                (ts.isStringLiteral(valueNode) ||
                  ts.isNoSubstitutionTemplateLiteral(valueNode) ||
                  ts.isTemplateHead(valueNode) ||
                  ts.isTemplateMiddle(valueNode) ||
                  ts.isTemplateTail(valueNode)) &&
                valueNode.text.includes("!important")
              ) {
                hasPriority = true;
              }
              valueNode.forEachChild(inspectPriority);
            };
            inspectPriority(value);
            if (dynamicPriority) {
              return manual(node, "computed style values need explicit priority handling");
            }
            if (hasPriority) {
              return manual(node, "important style priority needs an owned style binding");
            }
            const cssName = name.includes("-")
              ? name
              : name.replace(/(?:^(webkit|moz|ms|o)|)(?=[A-Z])/gu, "-$&").toLowerCase();
            if (cssName === name) {
              properties.push(render(property, { ...context, child: false }));
              continue;
            }
            properties.push(
              `${JSON.stringify(cssName)}: ${render(value, { ...context, child: false })}`,
            );
          }
          return `{ ${properties.join(", ")} }`;
        }
        if (importedCall?.name === "classMap" && node.arguments.length === 1) {
          return render(node.arguments[0]!, { ...context, child: false });
        }
        if (importedCall?.name === "ifDefined" && node.arguments.length === 1) {
          return render(node.arguments[0]!, { ...context, child: false });
        }
        if (!context.attribute && importedCall?.name === "repeat") {
          if (node.arguments.length !== 3) {
            return manual(node, "repeat without an explicit key needs an identity decision");
          }
          return list(node, node.arguments[0]!, node.arguments[2]!, node.arguments[1]!, context);
        }
        if (
          context.child &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "map"
        ) {
          if (node.arguments.length !== 1) {
            return manual(node, "map thisArg needs manual conversion");
          }
          return list(node, node.expression.expression, node.arguments[0]!, undefined, context);
        }
      }
      if (ts.isConditionalExpression(node) && context.child) {
        if (ts.isGetAccessorDeclaration(localValue(node.condition))) {
          return manual(node, "getter guard needs its original read count");
        }
        let guardedCall = false;
        const inspectCall = (child: ts.Node) => {
          if (
            ts.isCallExpression(child) &&
            unwrapExpression(child.expression).getText(source) ===
              unwrapExpression(node.condition).getText(source) &&
            ts.isPropertyAccessExpression(node.condition)
          ) {
            guardedCall = true;
          }
          child.forEachChild(inspectCall);
        };
        inspectCall(node.whenTrue);
        if (guardedCall) {
          return manual(node, "guarded method needs its original receiver");
        }
        let writesGuard = false;
        let queriesGuard = false;
        const containsGuard = (target: ts.Node): boolean => {
          if (
            target.getText(source) === node.condition.getText(source) &&
            rootBinding(target) === rootBinding(node.condition)
          ) {
            return true;
          }
          let found = false;
          target.forEachChild((child) => {
            if (containsGuard(child)) {
              found = true;
            }
          });
          return found;
        };
        const inspectWrites = (child: ts.Node) => {
          if (ts.isTypeQueryNode(child) && containsGuard(child.exprName)) {
            queriesGuard = true;
          }
          if (
            ts.isBinaryExpression(child) &&
            child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            child.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
            containsGuard(child.left)
          ) {
            writesGuard = true;
          }
          if (
            (ts.isPrefixUnaryExpression(child) || ts.isPostfixUnaryExpression(child)) &&
            [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(child.operator) &&
            containsGuard(child.operand)
          ) {
            writesGuard = true;
          }
          if (ts.isDeleteExpression(child) && containsGuard(child.expression)) {
            writesGuard = true;
          }
          child.forEachChild(inspectWrites);
        };
        inspectWrites(node.whenTrue);
        if (queriesGuard) {
          return manual(node, "conditional type query needs the narrowed accessor return type");
        }
        if (writesGuard) {
          return manual(node, "conditional writes its guard; preserve assignment ownership");
        }
        let optional = false;
        const inspectOptional = (child: ts.Node) => {
          if (
            (ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child)) &&
            child.questionDotToken
          ) {
            optional = true;
          }
          child.forEachChild(inspectOptional);
        };
        inspectOptional(node.condition);
        if (optional) {
          return manual(node, "optional-chain narrowing needs manual conversion");
        }
        const simple =
          ts.isIdentifier(node.condition) || ts.isPropertyAccessExpression(node.condition);
        const candidates = new Set<string>();
        const collect = (child: ts.Node) => {
          if (child.kind === ts.SyntaxKind.ThisKeyword) {
            candidates.add("this");
          }
          if (ts.isIdentifier(child) && isReference(child)) {
            candidates.add(child.text);
          }
          child.forEachChild(collect);
        };
        collect(node.condition);
        let usesCondition = false;
        let fallbackUsesCondition = false;
        const inspect = (child: ts.Node, fallback: boolean) => {
          if (
            simple
              ? child.getText(source) === node.condition.getText(source) &&
                rootBinding(child) === rootBinding(node.condition)
              : (child.kind === ts.SyntaxKind.ThisKeyword && candidates.has("this")) ||
                (ts.isIdentifier(child) && isReference(child) && candidates.has(child.text))
          ) {
            if (fallback) {
              fallbackUsesCondition = true;
            } else {
              usesCondition = true;
            }
          }
          child.forEachChild((nested) => inspect(nested, fallback));
        };
        inspect(node.whenTrue, false);
        inspect(node.whenFalse, true);
        if (ts.isPropertyAccessExpression(node.condition)) {
          const condition = node.condition;
          let root: ts.Expression = condition;
          while (ts.isPropertyAccessExpression(root)) {
            root = root.expression;
          }
          const rootName = root.getText(source);
          let unsafeSibling = false;
          const inspectSibling = (child: ts.Node) => {
            if (child.getText(source) === condition.getText(source)) {
              return;
            }
            if (child.kind === ts.SyntaxKind.ThisKeyword && rootName === "this") {
              unsafeSibling = true;
            }
            if (
              ts.isIdentifier(child) &&
              isReference(child) &&
              child.text === rootName &&
              resolve(child) === rootBinding(condition) &&
              !context.narrowed?.some(
                (entry) => entry.text === child.text && entry.binding === resolve(child),
              )
            ) {
              unsafeSibling = true;
            }
            child.forEachChild(inspectSibling);
          };
          inspectSibling(node.whenTrue);
          if (unsafeSibling) {
            return manual(node, "property-discriminant narrowing needs manual conversion");
          }
        }
        if ((usesCondition && !simple) || fallbackUsesCondition) {
          return manual(node, "conditional narrowing needs manual conversion");
        }
        if (usesCondition && asyncGuard(node.condition)) {
          return manual(node, "async or unknown guard needs explicit JavaScript truthiness");
        }
        const show = helper("Show");
        let branch: string;
        if (usesCondition) {
          let accessor = "showValue";
          while (identifiers.has(accessor)) {
            accessor = `_${accessor}`;
          }
          identifiers.add(accessor);
          const value = renderChild(node.whenTrue, {
            ...context,
            narrowed: [
              {
                text: node.condition.getText(source),
                binding: rootBinding(node.condition),
                accessor,
              },
              ...(context.narrowed ?? []),
            ],
          });
          branch = `(${accessor}) => ${value.startsWith("<") ? value : `<>{${value}}</>`}`;
        } else {
          branch = renderChild(node.whenTrue, context);
        }
        const condition = render(node.condition, { ...context, child: false });
        return `<${show} when={${usesCondition ? condition : `!!(${condition})`}} fallback={${renderChild(node.whenFalse, context)}}>{${branch}}</${show}>`;
      }
      if (ts.isParenthesizedExpression(node) && context.child) {
        return render(node.expression, context);
      }
      const edits: Edit[] = [];
      if (ts.isTypeAssertion(node)) {
        return `(${render(node.expression, context)} as ${render(node.type, { ...context, child: false })})`;
      }
      node.forEachChild((child) => {
        const text = render(child, { ...context, child: false });
        if (text !== child.getText(source)) {
          edits.push({ start: child.getStart(source), end: child.end, text });
        }
      });
      if (
        ts.isArrowFunction(node) &&
        node.typeParameters?.length === 1 &&
        !node.typeParameters.hasTrailingComma
      ) {
        const parameter = node.typeParameters[0]!;
        if (!parameter.constraint && !parameter.defaultType) {
          edits.push({ start: parameter.end, end: parameter.end, text: "," });
        }
      }
      return replaceRanges(node.getText(source), node.getStart(source), edits);
    };
    const renderAttribute = (node: ts.Expression, context: Context): string => {
      let hasClassStyleDirective = false;
      const inspect = (child: ts.Node) => {
        if (
          ts.isCallExpression(child) &&
          (lit(child.expression, "classMap") || lit(child.expression, "styleMap"))
        ) {
          hasClassStyleDirective = true;
        }
        child.forEachChild(inspect);
      };
      inspect(node);
      if (hasClassStyleDirective) {
        throw new Error("nested class/style directive needs a direct binding");
      }
      if (ts.isParenthesizedExpression(node)) {
        return renderAttribute(node.expression, context);
      }
      if (lit(node, "nothing")) {
        return "undefined";
      }
      if (ts.isConditionalExpression(node)) {
        return `(${render(node.condition, { ...context, child: false })} ? ${renderAttribute(node.whenTrue, context)} : ${renderAttribute(node.whenFalse, context)})`;
      }
      if (
        ts.isCallExpression(node) &&
        lit(node.expression, "ifDefined") &&
        node.arguments.length === 1
      ) {
        return `${helper("definedAttribute")}((${render(node.arguments[0]!, { ...context, child: false })}))`;
      }
      if (hasNothing(node)) {
        throw new Error("attribute omission expression needs manual conversion");
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.getText(source);
      }
      return `${helper("attributeValue")}((${render(node, { ...context, child: false, attribute: true })}))`;
    };
    const memberType = (
      type: ts.Node,
      name: string,
      seen = new Set<ts.Node>(),
    ): ts.Node | undefined => {
      if (seen.has(type)) {
        return undefined;
      }
      seen.add(type);
      if (ts.isArrayTypeNode(type) && (name === "$index" || /^\d+$/u.test(name))) {
        return type.elementType;
      }
      if (ts.isTupleTypeNode(type) && (name === "$index" || /^\d+$/u.test(name))) {
        if (name === "$index") {
          return type;
        }
        const item = type.elements[Number(name)];
        return item && ts.isNamedTupleMember(item) ? item.type : item;
      }
      if (ts.isTypeLiteralNode(type) || ts.isInterfaceDeclaration(type)) {
        const member = type.members.find(
          (entry) =>
            (ts.isPropertySignatureDeclaration(entry) || ts.isMethodSignatureDeclaration(entry)) &&
            staticPropertyName(entry.name) === name,
        );
        if (member && ts.isMethodSignatureDeclaration(member)) {
          return member;
        }
        if (member && ts.isPropertySignatureDeclaration(member)) {
          return member.type;
        }
        const index = type.members.find(ts.isIndexSignatureDeclaration);
        if (index) {
          return index.type;
        }
        if (ts.isInterfaceDeclaration(type)) {
          for (const heritage of type.heritageClauses ?? []) {
            for (const base of heritage.types) {
              const inherited = memberType(base, name, seen);
              if (inherited) {
                return inherited;
              }
            }
          }
        }
      }
      if (ts.isTypeReferenceNode(type) || ts.isExpressionWithTypeArguments(type)) {
        const typeName = ts.isTypeReferenceNode(type) ? type.typeName : type.expression;
        if (!ts.isIdentifier(typeName)) {
          return undefined;
        }
        if (
          ["Array", "ReadonlyArray"].includes(typeName.text) &&
          (name === "$index" || /^\d+$/u.test(name))
        ) {
          return type.typeArguments?.[0];
        }
        for (const alias of typeAliases.get(typeName.text) ?? []) {
          const member = memberType(alias, name, seen);
          if (member) {
            return member;
          }
        }
      }
      if (ts.isUnionTypeNode(type)) {
        const present = type.types.filter(
          (part) =>
            part.kind !== ts.SyntaxKind.UndefinedKeyword &&
            !(ts.isLiteralTypeNode(part) && part.literal.kind === ts.SyntaxKind.NullKeyword),
        );
        return present.length === 1 ? memberType(present[0]!, name, seen) : type;
      }
      if (ts.isIntersectionTypeNode(type)) {
        return type;
      }
      if (ts.isParenthesizedTypeNode(type)) {
        return memberType(type.type, name, seen);
      }
      return undefined;
    };
    const declaredType = (expression: ts.Expression): ts.Node | undefined => {
      let value = expression;
      while (ts.isParenthesizedExpression(value) || ts.isNonNullExpression(value)) {
        value = value.expression;
      }
      if (
        ts.isAsExpression(value) ||
        ts.isTypeAssertion(value) ||
        ts.isSatisfiesExpression(value)
      ) {
        return value.type;
      }
      if (ts.isIdentifier(value)) {
        const binding = resolve(value);
        if (binding && (ts.isParameterDeclaration(binding) || ts.isVariableDeclaration(binding))) {
          return binding.type;
        }
      }
      if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
        const base = declaredType(value.expression);
        const name = ts.isPropertyAccessExpression(value)
          ? value.name.text
          : value.argumentExpression &&
              (ts.isStringLiteral(value.argumentExpression) ||
                ts.isNumericLiteral(value.argumentExpression))
            ? value.argumentExpression.text
            : "$index";
        if (base && name) {
          return memberType(base, name);
        }
      }
      return undefined;
    };
    const primitiveConstraint = (type: ts.Node, seen = new Set<ts.Node>()): boolean => {
      if (seen.has(type)) {
        return false;
      }
      seen.add(type);
      if (
        [
          ts.SyntaxKind.StringKeyword,
          ts.SyntaxKind.NumberKeyword,
          ts.SyntaxKind.BigIntKeyword,
          ts.SyntaxKind.BooleanKeyword,
          ts.SyntaxKind.SymbolKeyword,
          ts.SyntaxKind.UndefinedKeyword,
          ts.SyntaxKind.NeverKeyword,
          ts.SyntaxKind.VoidKeyword,
        ].includes(type.kind) ||
        ts.isLiteralTypeNode(type)
      ) {
        return true;
      }
      if (ts.isParenthesizedTypeNode(type)) {
        return primitiveConstraint(type.type, seen);
      }
      if (ts.isUnionTypeNode(type)) {
        return type.types.every((item) => primitiveConstraint(item, new Set(seen)));
      }
      if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
        const aliases = typeAliases.get(type.typeName.text);
        return Boolean(
          aliases?.length && aliases.every((alias) => primitiveConstraint(alias, new Set(seen))),
        );
      }
      return false;
    };
    const ambiguousType = (type: ts.Node, seen = new Set<ts.Node>()): boolean => {
      if (seen.has(type)) {
        return false;
      }
      seen.add(type);
      if (
        type.kind === ts.SyntaxKind.UnknownKeyword ||
        type.kind === ts.SyntaxKind.AnyKeyword ||
        type.kind === ts.SyntaxKind.ObjectKeyword ||
        ts.isTypeLiteralNode(type) ||
        ts.isInterfaceDeclaration(type)
      ) {
        // Structural object types can also be implemented by functions.
        return true;
      }
      if (
        ts.isTypeReferenceNode(type) &&
        ts.isIdentifier(type.typeName) &&
        typeAliases.get(type.typeName.text)?.some((alias) => ambiguousType(alias, seen))
      ) {
        return true;
      }
      if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
        for (let owner: ts.Node | undefined = type.parent; owner; owner = owner.parent) {
          let parameter: ts.TypeParameterDeclaration | undefined;
          owner.forEachChild((child) => {
            if (
              ts.isTypeParameterDeclaration(child) &&
              child.name.text === type.typeName.getText(source)
            ) {
              parameter = child;
            }
          });
          if (parameter) {
            return !parameter.constraint || !primitiveConstraint(parameter.constraint);
          }
        }
      }
      let ambiguous = false;
      type.forEachChild((child) => {
        if (ambiguousType(child, seen)) {
          ambiguous = true;
        }
      });
      return ambiguous;
    };
    const asyncGuard = (expression: ts.Expression): boolean => {
      const type = declaredType(expression);
      const asyncType = (node: ts.Node, seen = new Set<ts.Node>()): boolean => {
        if (seen.has(node)) {
          return false;
        }
        seen.add(node);
        if (node.kind === ts.SyntaxKind.UnknownKeyword || node.kind === ts.SyntaxKind.AnyKeyword) {
          return true;
        }
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
          if (ambiguousType(node) && !typeAliases.has(node.typeName.text)) {
            return true;
          }
          if (["Promise", "PromiseLike"].includes(node.typeName.text)) {
            return true;
          }
          if (typeAliases.get(node.typeName.text)?.some((alias) => asyncType(alias, seen))) {
            return true;
          }
        }
        if (
          (ts.isMethodSignatureDeclaration(node) || ts.isPropertySignatureDeclaration(node)) &&
          staticPropertyName(node.name) === "then"
        ) {
          return true;
        }
        let async = false;
        node.forEachChild((child) => {
          if (asyncType(child, seen)) {
            async = true;
          }
        });
        return async;
      };
      if (type && asyncType(type)) {
        return true;
      }
      const value = localValue(expression);
      if (
        ts.isObjectLiteralExpression(value) &&
        value.properties.some(
          (item) => !ts.isSpreadAssignment(item) && staticPropertyName(item.name) === "then",
        )
      ) {
        return true;
      }
      if (ts.isCallExpression(value) || ts.isNewExpression(value)) {
        if (/^(?:globalThis\.)?Promise(?:\.|$)/u.test(value.expression.getText(source))) {
          return true;
        }
        const fn = localValue(value.expression);
        if (isFunction(fn) && fn.type && primitiveConstraint(fn.type)) {
          return false;
        }
        // A helper can return a thenable without being declared async.
        return true;
      }
      return false;
    };
    const nonArrayType = (type: ts.Node, seen = new Set<ts.Node>()): boolean => {
      if (seen.has(type)) {
        return false;
      }
      seen.add(type);
      if (ts.isTypeReferenceNode(type) || ts.isExpressionWithTypeArguments(type)) {
        const name = ts.isTypeReferenceNode(type) ? type.typeName : type.expression;
        if (ts.isIdentifier(name) && classTypes.has(name.text)) {
          return true;
        }
        if (
          /^(?:(?:Uint|Int|Float|BigInt|BigUint)\d+(?:Clamped)?Array|DataView)$/u.test(
            name.getText(source),
          )
        ) {
          return true;
        }
        if (
          ts.isIdentifier(name) &&
          typeAliases.get(name.text)?.some((alias) => nonArrayType(alias, seen))
        ) {
          return true;
        }
      }
      let found = false;
      type.forEachChild((child) => {
        if (nonArrayType(child, seen)) {
          found = true;
        }
      });
      return found;
    };
    const isJsxType = (type: ts.Node): boolean => {
      if (!ts.isTypeReferenceNode(type)) {
        return false;
      }
      const name = type.typeName;
      return (
        ["TemplateResult", "HTMLTemplateResult", "SVGTemplateResult"].includes(
          lit(name)?.name ?? "",
        ) ||
        (ts.isQualifiedName(name) &&
          name.right.text === "Element" &&
          imported(name.left, "JSX")?.module === "@solidjs/web")
      );
    };
    const unsafeChildType = (type: ts.Node, seen = new Set<ts.Node>()): boolean => {
      if (ambiguousType(type)) {
        return true;
      }
      if (seen.has(type)) {
        return false;
      }
      seen.add(type);
      if (
        ts.isFunctionTypeNode(type) ||
        ts.isConstructorTypeNode(type) ||
        ts.isMethodSignatureDeclaration(type) ||
        ts.isCallSignatureDeclaration(type) ||
        ts.isConstructSignatureDeclaration(type)
      ) {
        return true;
      }
      if (ts.isTypeReferenceNode(type) || ts.isExpressionWithTypeArguments(type)) {
        const name = ts.isTypeReferenceNode(type) ? type.typeName : type.expression;
        const litResult = ["TemplateResult", "HTMLTemplateResult", "SVGTemplateResult"].includes(
          lit(name)?.name ?? "",
        );
        const jsxResult =
          ts.isQualifiedName(name) &&
          name.right.text === "Element" &&
          imported(name.left, "JSX")?.module === "@solidjs/web";
        if (
          !litResult &&
          !jsxResult &&
          (!ts.isIdentifier(name) ||
            (!typeAliases.has(name.text) &&
              (!["Array", "ReadonlyArray"].includes(name.text) || resolve(name))))
        ) {
          return true;
        }
        if (
          ts.isIdentifier(name) &&
          (["Function", "CallableFunction", "NewableFunction"].includes(name.text) ||
            typeAliases.get(name.text)?.some((alias) => unsafeChildType(alias, seen)))
        ) {
          return true;
        }
      }
      if (ts.isTypeQueryNode(type) && ts.isIdentifier(type.exprName)) {
        const binding = resolve(type.exprName);
        if (binding && ts.isFunctionDeclaration(binding)) {
          return true;
        }
        if (
          binding &&
          (ts.isVariableDeclaration(binding) || ts.isParameterDeclaration(binding)) &&
          binding.type &&
          unsafeChildType(binding.type, seen)
        ) {
          return true;
        }
        if (
          binding &&
          ts.isVariableDeclaration(binding) &&
          binding.initializer &&
          functionValue(binding.initializer, seen)
        ) {
          return true;
        }
      }
      let callable = false;
      type.forEachChild((child) => {
        if (unsafeChildType(child, seen)) {
          callable = true;
        }
      });
      return callable;
    };
    const unsafeCallReturn = (type: ts.Node, seen = new Set<ts.Node>()): boolean => {
      if (seen.has(type)) {
        return false;
      }
      seen.add(type);
      if (
        (ts.isFunctionTypeNode(type) ||
          ts.isCallSignatureDeclaration(type) ||
          ts.isMethodSignatureDeclaration(type)) &&
        type.type
      ) {
        return unsafeChildType(type.type);
      }
      if (
        ts.isTypeReferenceNode(type) &&
        ts.isIdentifier(type.typeName) &&
        typeAliases.get(type.typeName.text)?.some((alias) => unsafeCallReturn(alias, seen))
      ) {
        return true;
      }
      let found = false;
      type.forEachChild((child) => {
        if (unsafeCallReturn(child, seen)) {
          found = true;
        }
      });
      return found;
    };
    const containsJsxType = (type: ts.Node, seen = new Set<ts.Node>()): boolean => {
      if (seen.has(type)) {
        return false;
      }
      seen.add(type);
      if (isJsxType(type)) {
        return true;
      }
      if (
        ts.isTypeReferenceNode(type) &&
        ts.isIdentifier(type.typeName) &&
        typeAliases.get(type.typeName.text)?.some((alias) => containsJsxType(alias, seen))
      ) {
        return true;
      }
      let found = false;
      type.forEachChild((child) => {
        if (containsJsxType(child, seen)) {
          found = true;
        }
      });
      return found;
    };
    const returnedExpressions = (body: ts.Block | ts.Expression | undefined): ts.Expression[] => {
      if (!body) {
        return [];
      }
      if (!ts.isBlock(body)) {
        return [body];
      }
      const results: ts.Expression[] = [];
      const visit = (node: ts.Node) => {
        if (node !== body && isFunction(node)) {
          return;
        }
        if (ts.isReturnStatement(node) && node.expression) {
          results.push(node.expression);
        }
        node.forEachChild(visit);
      };
      visit(body);
      return results;
    };
    const hasJsxReturnType = (type: ts.Node, seen = new Set<ts.Node>()): boolean => {
      if (seen.has(type)) {
        return false;
      }
      seen.add(type);
      if (
        (ts.isFunctionTypeNode(type) ||
          ts.isMethodSignatureDeclaration(type) ||
          ts.isCallSignatureDeclaration(type)) &&
        type.type
      ) {
        return isJsxType(type.type);
      }
      if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
        const aliases = typeAliases.get(type.typeName.text);
        return Boolean(
          aliases?.length && aliases.every((alias) => hasJsxReturnType(alias, new Set(seen))),
        );
      }
      return false;
    };
    const hasJsxMutation = (expression: ts.Expression): boolean => {
      const value = unwrapExpression(expression);
      const root = rootBinding(value);
      if (root && mutableBindings.has(root)) {
        return true;
      }
      const owner = localValue(
        ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)
          ? value.expression
          : value,
      );
      return (
        configuredListeners.some((entry) => localValue(entry) === owner) ||
        mutableMembers.some((entry) => localValue(entry.expression) === owner)
      );
    };
    const isJsxValue = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
      const value = unwrapExpression(expression);
      if (seen.has(value) || hasJsxMutation(value)) {
        return false;
      }
      seen.add(value);
      const type = declaredType(expression);
      if (type && isJsxType(type)) {
        return true;
      }
      if (ts.isTaggedTemplateExpression(value)) {
        return Boolean(lit(value.tag, "html") || lit(value.tag, "svg"));
      }
      if (ts.isIdentifier(value)) {
        const binding = resolve(value);
        return Boolean(
          binding &&
          ts.isVariableDeclaration(binding) &&
          ts.isIdentifier(binding.name) &&
          binding.initializer &&
          isJsxValue(binding.initializer, seen),
        );
      }
      if (ts.isCallExpression(value)) {
        if (hasJsxMutation(value.expression)) {
          return false;
        }
        const signature = declaredType(value.expression);
        if (signature && hasJsxReturnType(signature)) {
          return true;
        }
        const callee = unwrapExpression(value.expression);
        if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
          return false;
        }
        const fn = localValue(value.expression);
        if (
          ts.isFunctionDeclaration(fn) ||
          ts.isFunctionExpression(fn) ||
          ts.isArrowFunction(fn) ||
          ts.isMethodDeclaration(fn) ||
          ts.isGetAccessorDeclaration(fn)
        ) {
          if (fn.type && isJsxType(fn.type)) {
            return true;
          }
          const returns = returnedExpressions(fn.body);
          return returns.length > 0 && returns.every((result) => isJsxValue(result, new Set(seen)));
        }
      }
      return false;
    };
    const hasUnownedJsx = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
      const type = declaredType(expression);
      if (type && containsJsxType(type)) {
        return true;
      }
      const value = localValue(expression);
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
      if (ts.isGetAccessorDeclaration(value)) {
        return (
          Boolean(value.type && containsJsxType(value.type)) ||
          returnedExpressions(value.body).some((result) => hasUnownedJsx(result, seen))
        );
      }
      if (!ts.isExpression(value)) {
        return false;
      }
      if (isJsxValue(value)) {
        return true;
      }
      if (ts.isArrayLiteralExpression(value)) {
        return value.elements.some(
          (item) =>
            !ts.isOmittedExpression(item) &&
            hasUnownedJsx(ts.isSpreadElement(item) ? item.expression : item, seen),
        );
      }
      if (ts.isConditionalExpression(value)) {
        return hasUnownedJsx(value.whenTrue, seen) || hasUnownedJsx(value.whenFalse, seen);
      }
      if (ts.isBinaryExpression(value)) {
        return hasUnownedJsx(value.left, seen) || hasUnownedJsx(value.right, seen);
      }
      if (ts.isCallExpression(value)) {
        const signature = declaredType(value.expression);
        if (signature && containsJsxType(signature)) {
          return true;
        }
        const fn = localValue(value.expression);
        if (
          ts.isFunctionDeclaration(fn) ||
          ts.isFunctionExpression(fn) ||
          ts.isArrowFunction(fn) ||
          ts.isMethodDeclaration(fn) ||
          ts.isGetAccessorDeclaration(fn)
        ) {
          if (fn.type && containsJsxType(fn.type)) {
            return true;
          }
          if (returnedExpressions(fn.body).some((result) => hasUnownedJsx(result, seen))) {
            return true;
          }
        }
      }
      if (ts.isCallExpression(value) || ts.isNewExpression(value)) {
        return (
          value.arguments?.some((arg) => {
            if (ts.isArrowFunction(arg) && !ts.isBlock(arg.body)) {
              return hasUnownedJsx(arg.body, seen);
            }
            return hasUnownedJsx(arg, seen);
          }) ?? false
        );
      }
      return false;
    };
    const functionValue = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
      let asserted = expression;
      while (
        ts.isParenthesizedExpression(asserted) ||
        ts.isNonNullExpression(asserted) ||
        ts.isAsExpression(asserted) ||
        ts.isTypeAssertion(asserted) ||
        ts.isSatisfiesExpression(asserted)
      ) {
        if (
          (ts.isAsExpression(asserted) ||
            ts.isTypeAssertion(asserted) ||
            ts.isSatisfiesExpression(asserted)) &&
          unsafeChildType(asserted.type)
        ) {
          return true;
        }
        asserted = asserted.expression;
      }
      if (
        (ts.isAsExpression(expression) ||
          ts.isTypeAssertion(expression) ||
          ts.isSatisfiesExpression(expression)) &&
        unsafeChildType(expression.type)
      ) {
        return true;
      }
      const value = unwrapExpression(expression);
      if (lit(value, "nothing")) {
        return false;
      }
      if (
        ts.isClassExpression(value) ||
        ts.isYieldExpression(value) ||
        ts.isMetaProperty(value) ||
        value.kind === ts.SyntaxKind.ThisKeyword ||
        (ts.isTaggedTemplateExpression(value) && !lit(value.tag, "html") && !lit(value.tag, "svg"))
      ) {
        return true;
      }
      if (
        ts.isAwaitExpression(value) ||
        (ts.isNewExpression(value) && rootBinding(value.expression))
      ) {
        return true;
      }
      const root = rootBinding(value);
      if (
        root &&
        (ts.isVariableDeclaration(root) || ts.isParameterDeclaration(root)) &&
        !ts.isIdentifier(root.name)
      ) {
        return true;
      }
      if (
        mutableCollections.some(
          (collection) =>
            (collection.getText(source) === value.getText(source) &&
              rootBinding(collection) === root) ||
            localValue(collection) === localValue(value),
        )
      ) {
        return true;
      }
      if (root && mutableBindings.has(root)) {
        return true;
      }
      const settled = localValue(value);
      if (
        ts.isCallExpression(settled) &&
        !rootBinding(settled.expression) &&
        [
          "document.createElement",
          "document.createElementNS",
          "document.createTextNode",
          "document.createComment",
          "document.createDocumentFragment",
        ].includes(settled.expression.getText(source))
      ) {
        return false;
      }
      if (
        mutableMembers.some(
          (member) =>
            (member.getText(source) === value.getText(source) && rootBinding(member) === root) ||
            localValue(member.expression) === localValue(value) ||
            ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
              localValue(member.expression) === localValue(value.expression)),
        )
      ) {
        return true;
      }
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
      if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
        let access: ts.Expression = value;
        while (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) {
          const receiver = localValue(access.expression);
          if (
            ts.isObjectLiteralExpression(receiver) &&
            receiver.properties.some(ts.isSpreadAssignment)
          ) {
            return true;
          }
          access = access.expression;
        }
      }
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
        return true;
      }
      const type = declaredType(value);
      if (type && unsafeChildType(type)) {
        return true;
      }
      const resolved = localValue(value);
      if (
        (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
        resolved === value &&
        !type
      ) {
        return true;
      }
      if (ts.isGetAccessorDeclaration(resolved)) {
        if (resolved.type && unsafeChildType(resolved.type)) {
          return true;
        }
        if (!resolved.body) {
          return true;
        }
        let callable = false;
        const inspectGetter = (part: ts.Node) => {
          if (part !== resolved.body && isFunction(part)) {
            return;
          }
          if (
            ts.isReturnStatement(part) &&
            part.expression &&
            functionValue(part.expression, seen)
          ) {
            callable = true;
          }
          part.forEachChild(inspectGetter);
        };
        inspectGetter(resolved.body);
        return callable;
      }
      if (ts.isFunctionDeclaration(resolved) || ts.isMethodDeclaration(resolved)) {
        return true;
      }
      if (resolved !== value && functionValue(resolved, seen)) {
        return true;
      }
      if (ts.isCallExpression(value)) {
        let knownCall = Boolean(
          lit(value.expression) ||
          imported(value.expression, "t") ||
          imported(value.expression)?.directive ||
          localDirectives.has(value.expression.getText(source)),
        );
        if (
          ts.isIdentifier(value.expression) &&
          !resolve(value.expression) &&
          ["String", "Number", "Boolean", "BigInt"].includes(value.expression.text)
        ) {
          knownCall = true;
        }
        if (
          !rootBinding(value.expression) &&
          [
            "Array",
            "Array.of",
            "Array.from",
            "JSON.stringify",
            "document.createElement",
            "document.createElementNS",
            "document.createTextNode",
            "document.createComment",
            "document.createDocumentFragment",
          ].includes(value.expression.getText(source))
        ) {
          knownCall = true;
        }
        if (
          ts.isPropertyAccessExpression(value.expression) &&
          value.expression.name.text === "bind"
        ) {
          return true;
        }
        if (
          ts.isPropertyAccessExpression(value.expression) &&
          value.expression.name.text === "map" &&
          value.arguments[0]
        ) {
          if (functionValue(value.expression.expression, seen)) {
            return true;
          }
          const callback = localValue(value.arguments[0]);
          if (
            !ts.isArrowFunction(callback) &&
            !ts.isFunctionExpression(callback) &&
            !ts.isFunctionDeclaration(callback) &&
            !ts.isMethodDeclaration(callback)
          ) {
            return true;
          }
          if (callback.type && unsafeChildType(callback.type)) {
            return true;
          }
          if (callback.body && !ts.isBlock(callback.body) && functionValue(callback.body, seen)) {
            return true;
          }
          if (callback.body && ts.isBlock(callback.body)) {
            let unsafe = false;
            const inspect = (part: ts.Node) => {
              if (part !== callback.body && isFunction(part)) {
                return;
              }
              if (
                ts.isReturnStatement(part) &&
                part.expression &&
                functionValue(part.expression, seen)
              ) {
                unsafe = true;
              }
              part.forEachChild(inspect);
            };
            inspect(callback.body);
            if (unsafe) {
              return true;
            }
          }
          knownCall = true;
        }
        const signature = declaredType(value.expression);
        if (
          signature &&
          (ts.isFunctionTypeNode(signature) ||
            ts.isMethodSignatureDeclaration(signature) ||
            ts.isCallSignatureDeclaration(signature))
        ) {
          knownCall = true;
        }
        if (signature && unsafeCallReturn(signature)) {
          return true;
        }
        const definition = localValue(value.expression);
        const fn =
          ts.isFunctionDeclaration(definition) ||
          ts.isFunctionExpression(definition) ||
          ts.isArrowFunction(definition) ||
          ts.isMethodDeclaration(definition) ||
          ts.isGetAccessorDeclaration(definition)
            ? definition
            : undefined;
        if (fn?.type) {
          knownCall = true;
        }
        if (fn?.type && unsafeChildType(fn.type)) {
          return true;
        }
        if (fn?.asteriskToken) {
          return true;
        }
        if (fn?.body) {
          knownCall = true;
          if (!ts.isBlock(fn.body)) {
            return functionValue(fn.body, seen);
          }
          let returned = false;
          const inspectReturn = (part: ts.Node) => {
            if (part !== fn.body && isFunction(part)) {
              return;
            }
            if (
              ts.isReturnStatement(part) &&
              part.expression &&
              functionValue(part.expression, seen)
            ) {
              returned = true;
            }
            part.forEachChild(inspectReturn);
          };
          inspectReturn(fn.body);
          if (returned) {
            return true;
          }
        }
        if (!knownCall) {
          return true;
        }
      }
      if (ts.isIdentifier(value)) {
        const binding = resolve(value);
        if (!binding) {
          return !["undefined", "NaN", "Infinity"].includes(value.text);
        }
        if (
          ts.isImportSpecifier(binding) ||
          ts.isNamespaceImport(binding) ||
          ts.isImportClause(binding)
        ) {
          return true;
        }
        if (binding && (ts.isFunctionDeclaration(binding) || ts.isClassDeclaration(binding))) {
          return true;
        }
        if (ts.isVariableDeclaration(binding) && !binding.type && !binding.initializer) {
          return true;
        }
        if (
          binding &&
          ts.isParameterDeclaration(binding) &&
          !binding.type &&
          !binding.initializer
        ) {
          const callback = binding.parent;
          const call = callback.parent;
          if (
            ts.isArrowFunction(callback) &&
            ts.isCallExpression(call) &&
            call.arguments[0] === callback &&
            ts.isPropertyAccessExpression(call.expression) &&
            call.expression.name.text === "map"
          ) {
            return functionValue(call.expression.expression, seen);
          }
          return true;
        }
        if (
          binding &&
          (ts.isParameterDeclaration(binding) || ts.isVariableDeclaration(binding)) &&
          binding.type &&
          unsafeChildType(binding.type)
        ) {
          return true;
        }
        if (
          binding &&
          (ts.isVariableDeclaration(binding) || ts.isParameterDeclaration(binding)) &&
          binding.initializer
        ) {
          return functionValue(binding.initializer, seen);
        }
      }
      if (ts.isArrayLiteralExpression(value)) {
        return value.elements.some(
          (item) =>
            !ts.isOmittedExpression(item) &&
            functionValue(ts.isSpreadElement(item) ? item.expression : item, seen),
        );
      }
      if (ts.isObjectLiteralExpression(value)) {
        return value.properties.some(
          (property) =>
            ts.isSpreadAssignment(property) ||
            ts.isMethodDeclaration(property) ||
            (ts.isPropertyAssignment(property) && functionValue(property.initializer, seen)) ||
            (ts.isShorthandPropertyAssignment(property) &&
              (!ts.isIdentifier(property.name) || functionValue(property.name, seen))),
        );
      }
      if (ts.isConditionalExpression(value)) {
        return functionValue(value.whenTrue, seen) || functionValue(value.whenFalse, seen);
      }
      if (
        ts.isBinaryExpression(value) &&
        value.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        value.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        return true;
      }
      if (
        ts.isBinaryExpression(value) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(value.operatorToken.kind)
      ) {
        return functionValue(value.left, seen) || functionValue(value.right, seen);
      }
      if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        return functionValue(value.right, seen);
      }
      if (
        (ts.isNewExpression(value) || ts.isCallExpression(value)) &&
        ["Set", "Array", "Array.of", "Array.from"].includes(value.expression.getText(source))
      ) {
        return value.arguments?.some((item) => functionValue(item, seen)) ?? false;
      }
      if (ts.isNewExpression(value) && value.expression.getText(source) === "Map") {
        return true;
      }
      if (
        ts.isNewExpression(value) &&
        !/^(?:Date|URL|URLSearchParams|RegExp|(?:Type|Range|Syntax|Reference|URI|Eval|Aggregate)?Error|Array|(?:Uint|Int|Float|BigInt|BigUint)\d+(?:Clamped)?Array)$/u.test(
          value.expression.getText(source),
        )
      ) {
        return true;
      }
      return false;
    };
    const renderChild = (node: ts.Expression, context: Context): string => {
      if (functionValue(node)) {
        return manual(node, "child value needs an explicit text or JSX decision");
      }
      const value = render(node, { ...context, child: true, attribute: false });
      const unwrapped = ts.isParenthesizedExpression(node) ? node.expression : node;
      if (
        value.startsWith("<") ||
        value.startsWith("(/*") ||
        lit(unwrapped, "nothing") ||
        ts.isStringLiteral(unwrapped) ||
        ts.isNumericLiteral(unwrapped) ||
        ts.isNoSubstitutionTemplateLiteral(unwrapped) ||
        unwrapped.kind === ts.SyntaxKind.NullKeyword
      ) {
        return value;
      }
      const jsxValue = isJsxValue(node);
      if (!jsxValue && hasUnownedJsx(node)) {
        return manual(
          node,
          "JSX collections and mutable members need explicit rendering ownership",
        );
      }
      helper("JSX");
      return `${helper("normalizeLitChild")}((${value})${jsxValue ? ", true" : ""})`;
    };
    const list = (
      node: ts.Node,
      collection: ts.Expression,
      callback: ts.Expression,
      key: ts.Expression | undefined,
      context: Context,
    ): string => {
      if (hasUnownedJsx(collection)) {
        return manual(node, "JSX collections need explicit item rendering ownership");
      }
      if (functionValue(collection)) {
        return manual(node, "callable collection items need an explicit rendering decision");
      }
      const sparse = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
        const value = unwrapExpression(expression);
        const type = declaredType(value);
        if (type && nonArrayType(type)) {
          return true;
        }
        if (seen.has(value)) {
          return false;
        }
        seen.add(value);
        if (ts.isConditionalExpression(value)) {
          return sparse(value.whenTrue, seen) || sparse(value.whenFalse, seen);
        }
        if (
          ts.isBinaryExpression(value) &&
          [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
          ].includes(value.operatorToken.kind)
        ) {
          return sparse(value.left, seen) || sparse(value.right, seen);
        }
        const resolved = localValue(value);
        if (
          ts.isFunctionDeclaration(resolved) ||
          ts.isMethodDeclaration(resolved) ||
          ts.isGetAccessorDeclaration(resolved)
        ) {
          return true;
        }
        if (resolved !== value) {
          return sparse(resolved, seen);
        }
        if (ts.isArrayLiteralExpression(value)) {
          return value.elements.some(ts.isOmittedExpression);
        }
        if (
          ts.isObjectLiteralExpression(value) ||
          (ts.isNewExpression(value) && value.expression.getText(source) !== "Array")
        ) {
          return true;
        }
        if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
          const receiver = localValue(value.expression.expression);
          if (
            /^(?:Uint|Int|Float|BigInt|BigUint)\d+(?:Clamped)?Array$/u.test(
              receiver.getText(source),
            ) ||
            sparse(value.expression.expression, seen)
          ) {
            return true;
          }
        }
        if (
          ts.isCallExpression(value) &&
          !["Array.of", "Array.from"].includes(value.expression.getText(source))
        ) {
          return true;
        }
        if (ts.isIdentifier(value)) {
          const binding = resolve(value);
          if (binding && ts.isVariableDeclaration(binding) && binding.initializer) {
            return sparse(binding.initializer, seen);
          }
        }
        return (
          (ts.isNewExpression(value) || ts.isCallExpression(value)) &&
          value.expression.getText(source) === "Array" &&
          value.arguments?.length === 1
        );
      };
      if (!key && sparse(collection)) {
        return manual(node, "non-array or sparse map input needs its original iteration contract");
      }
      if (
        !ts.isArrowFunction(callback) ||
        callback.typeParameters?.length ||
        callback.modifiers?.length ||
        ts.isBlock(callback.body) ||
        callback.parameters.length < 1 ||
        callback.parameters.length > 2 ||
        callback.parameters.some(
          (parameter) =>
            !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken,
        )
      ) {
        return manual(
          node,
          "list callback needs manual conversion (use a simple item/index arrow)",
        );
      }
      const parameters = new Set<ts.Node>(callback.parameters);
      const reads = new Map(context.reads);
      callback.parameters.forEach((parameter, index) => {
        if (index === 0 || key) {
          reads.set(parameter, parameter.name.getText(source));
        }
      });
      let mutatesParameter = false;
      let queriesParameter = false;
      const writesParameter = (target: ts.Node): boolean => {
        if (ts.isIdentifier(target) && parameters.has(resolve(target)!)) {
          return true;
        }
        let found = false;
        target.forEachChild((child) => {
          if (writesParameter(child)) {
            found = true;
          }
        });
        return found;
      };
      const inspect = (child: ts.Node) => {
        if (ts.isTypeQueryNode(child) && writesParameter(child.exprName)) {
          queriesParameter = true;
        }
        if (
          ts.isBinaryExpression(child) &&
          child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          child.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          writesParameter(child.left)
        ) {
          mutatesParameter = true;
        }
        if (
          (ts.isPrefixUnaryExpression(child) || ts.isPostfixUnaryExpression(child)) &&
          [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(child.operator) &&
          ts.isIdentifier(child.operand) &&
          parameters.has(resolve(child.operand)!)
        ) {
          mutatesParameter = true;
        }
        child.forEachChild(inspect);
      };
      inspect(callback.body);
      if (queriesParameter) {
        return manual(node, "list item type queries need an accessor return type");
      }
      if (mutatesParameter) {
        return manual(node, "list callback reassigns its item/index");
      }
      if (
        key &&
        (!ts.isArrowFunction(key) ||
          key.parameters.length !== 1 ||
          key.parameters[0]?.dotDotDotToken)
      ) {
        return manual(node, "repeat key signature needs an item-only key function");
      }
      const component = helper("For");
      const params = callback.parameters
        .map((parameter) => parameter.name.getText(source))
        .join(", ");
      const keyText = key ? render(key, { ...context, child: false }) : "false";
      const items = render(collection, { ...context, child: false });
      const child = renderChild(callback.body, { ...context, reads, child: true });
      return `<${component} each={${key ? `globalThis.Array.from((${items}))` : items}} keyed={${keyText}}>{(${params}) => ${child.startsWith("<") ? child : `<>{${child}}</>`}}</${component}>`;
    };
    // Mark ownership work independently of whether a template can be converted.
    const ownership = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        let ownsTemplate = false;
        const inspect = (child: ts.Node) => {
          if (
            ts.isTaggedTemplateExpression(child) &&
            (lit(child.tag, "html") || lit(child.tag, "svg"))
          ) {
            ownsTemplate = true;
          }
          child.forEachChild(inspect);
        };
        inspect(node);
        if (ownsTemplate) {
          note(node, "class-held templates need an explicit Solid owner");
        }
      }
      if (ts.isMethodDeclaration(node) && lifecycleMethods.has(node.name.getText(source))) {
        note(node, `lifecycle ${node.name.getText(source)} needs an owned Solid equivalent`);
      }
      if (
        ts.isNewExpression(node) &&
        (lit(node.expression, "Task") || node.expression.getText(source).endsWith("Controller"))
      ) {
        note(node, `${node.expression.getText(source)} lifecycle needs manual conversion`);
      }
      if (
        ts.isHeritageClause(node) &&
        node.types.some((type) => /ReactiveController(?:Host)?/u.test(type.getText(source)))
      ) {
        note(node, "controller lifetime needs manual conversion");
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ["updateComplete", "requestUpdate", "addController", "removeController"].includes(
          node.name.text,
        )
      ) {
        note(node, `${node.name.text} lifecycle needs manual conversion`);
      }
      if (
        ts.isIdentifier(node) &&
        /^(?:AbortController|AbortSignal)$/u.test(node.text) &&
        !ts.isImportSpecifier(node.parent)
      ) {
        note(node, "cancellation authority must remain with its owner");
      }
      node.forEachChild(ownership);
    };
    ownership(source);
    const edits: Edit[] = [];
    const context: Context = { reads: new Map() };
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        continue;
      }
      const text = render(statement, context);
      if (text !== statement.getText(source)) {
        edits.push({ start: statement.getStart(source), end: statement.end, text });
      }
    }
    let code = replaceRanges(sourceText, 0, edits);
    // Prune only transformed helper imports: still-used manual expressions retain their Lit imports.
    const converted = parser.parseSourceFile(fileName.replace(/\.(?:m?tsx?|jsx?)$/u, ".tsx"), code);
    if (parser.getSyntacticDiagnostics().length) {
      throw new Error(`Conversion produced invalid TSX for ${fileName}`);
    }
    const convertedResolve = lexicalBindings(converted);
    const usedImports = new Set<ts.Node>();
    const countUses = (node: ts.Node) => {
      if (
        ts.isIdentifier(node) &&
        isReference(node) &&
        !(ts.isTypeReferenceNode(node.parent) && shadowsType(node, node.text)) &&
        !ts.isImportSpecifier(node.parent) &&
        !ts.isImportClause(node.parent)
      ) {
        const binding = convertedResolve(node);
        if (binding) {
          usedImports.add(binding);
        }
      }
      node.forEachChild(countUses);
    };
    countUses(converted);
    const importEdits: Edit[] = [];
    for (const statement of converted.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !/^(?:lit(?:-html)?(?:\/|$)|@lit\/)/u.test(statement.moduleSpecifier.text)
      ) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        if (!usedImports.has(bindings)) {
          importEdits.push({ start: statement.getStart(converted), end: statement.end, text: "" });
        }
        continue;
      }
      if (!bindings || !ts.isNamedImports(bindings)) {
        continue;
      }
      const kept = bindings.elements.filter((specifier) => usedImports.has(specifier));
      if (kept.length === bindings.elements.length) {
        continue;
      }
      const text = kept.length
        ? `import ${statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ? "type " : ""}{ ${kept.map((item) => item.getText(converted)).join(", ")} } from ${statement.moduleSpecifier.getText(converted)};`
        : "";
      // Default imports are not owned by this mechanical pass.
      if (!statement.importClause?.name) {
        importEdits.push({ start: statement.getStart(converted), end: statement.end, text });
      }
    }
    code = replaceRanges(code, 0, importEdits).slice(hashbang.length);
    const jsx = usedHelpers.get("JSX");
    const normalize = usedHelpers.get("normalizeLitChild");
    const definedAttribute = usedHelpers.get("definedAttribute");
    const attributeValue = usedHelpers.get("attributeValue");
    if (attributeValue) {
      code = `function ${attributeValue}<T extends string>(value: T): T;\nfunction ${attributeValue}(value: unknown): string;\nfunction ${attributeValue}(value: unknown): string { return typeof value === "string" ? value : globalThis.String(value ?? ""); }\n${code}`;
    }
    if (definedAttribute) {
      code = `function ${definedAttribute}<T extends string>(value: T | null | undefined): T | undefined;\nfunction ${definedAttribute}(value: unknown): string | undefined;\nfunction ${definedAttribute}(value: unknown): string | undefined { return value == null ? undefined : typeof value === "string" ? value : globalThis.String(value); }\n${code}`;
    }
    if (normalize) {
      const iterable = helper("isLitIterable");
      const domNode = helper("isLitNode");
      code = `function ${iterable}(value: unknown): value is globalThis.Iterable<unknown> { return typeof value === "object" && value !== null && globalThis.Symbol.iterator in value && typeof value[globalThis.Symbol.iterator] === "function"; }\nfunction ${domNode}(value: unknown): value is globalThis.Node { return typeof value === "object" && value !== null && "nodeType" in value && typeof value.nodeType === "number" && "nodeName" in value && typeof value.nodeName === "string" && "cloneNode" in value && typeof value.cloneNode === "function"; }\nfunction ${normalize}(value: unknown, allowJsx = false): ${jsx}.Element { if (value == null || ${domNode}(value)) return value; if (${iterable}(value)) return globalThis.Array.from(value, item => ${normalize}(item, allowJsx)); if (typeof value === "function") return allowJsx ? <>{${normalize}(value(), true)}</> : globalThis.String(value); return typeof value === "string" || typeof value === "number" ? value : globalThis.String(value); }\n${code}`;
    }
    if (jsx) {
      code = `import type { ${jsx === "JSX" ? "JSX" : `JSX as ${jsx}`} } from "@solidjs/web";\n${code}`;
    }
    const flow = [...usedHelpers].filter(([name]) => name === "Show" || name === "For");
    if (flow.length) {
      code = `import { ${flow.map(([name, alias]) => (name === alias ? name : `${name} as ${alias}`)).join(", ")} } from "solid-js";\n${code}`;
    }
    // The summary also catches class/controller sites outside template expressions.
    if (diagnostics.length) {
      code =
        diagnostics.map((item) => `${marker(`line ${item.line}: ${item.reason}`)}\n`).join("") +
        code;
    }
    code = hashbang + code;
    parser.parseSourceFile(fileName.replace(/\.(?:m?tsx?|jsx?)$/u, ".tsx"), code);
    if (parser.getSyntacticDiagnostics().length) {
      throw new Error(`Conversion produced invalid final TSX for ${fileName}`);
    }
    return {
      code,
      diagnostics: diagnostics.toSorted((a, b) => a.line - b.line || a.column - b.column),
      templates,
    };
  } finally {
    if (!sharedParser) {
      parser.close();
    }
  }
}

function inputFiles(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    return fs
      .readdirSync(target)
      .toSorted()
      .flatMap((entry) => inputFiles(path.join(target, entry)));
  }
  return /\.(?:tsx?|mts|jsx?)$/u.test(target) && !target.endsWith(".d.ts") ? [target] : [];
}

function main(argv: string[]) {
  if (argv.includes("--help") || argv.length === 0) {
    console.log(
      "Usage: node scripts/codemods/lit-to-solid.mts [--out-dir DIR] [--check] FILE_OR_DIR ...\nDry-run by default; --out-dir writes mirrored .tsx copies. --check exits 1 when manual work remains.",
    );
    return;
  }
  const targets: string[] = [];
  let outDir: string | undefined;
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--out-dir") {
      outDir = argv[++i];
      if (!outDir) {
        throw new Error("--out-dir requires a directory");
      }
    } else if (arg === "--check") {
      check = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      targets.push(arg);
    }
  }
  if (!targets.length) {
    throw new Error("Provide at least one source file or directory");
  }
  using parser = createNativeTypeScriptParser();
  let pending = 0;
  for (const file of new Set(targets.flatMap(inputFiles))) {
    const relative = path.relative(process.cwd(), path.resolve(file));
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Inputs must be inside the current directory");
    }
    const result = convertLitToSolid(fs.readFileSync(file, "utf8"), file, parser);
    pending += result.diagnostics.length;
    if (outDir) {
      const destination = path.resolve(outDir, relative.replace(/\.(?:m?tsx?|jsx?)$/u, ".tsx"));
      if (fs.existsSync(destination)) {
        throw new Error(`Refusing to overwrite ${destination}`);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, result.code, { flag: "wx" });
    }
    console.log(
      JSON.stringify({
        file: relative,
        templates: result.templates,
        diagnostics: result.diagnostics,
      }),
    );
  }
  if (check && pending) {
    process.exitCode = 1;
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2));
}
