import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { SymbolFlags, type Symbol } from "typescript/unstable/sync";
import { createNativeTypeScriptProject } from "./native-typescript.mts";

// Each entry is a reviewed, released compatibility boundary, not a whole-file exemption.
// Kernels may join this list only after their bundled callers have moved to workers.
const reviewed = new Map<string, readonly string[]>([
  ["src/plugin-sdk/sqlite-runtime-legacy.ts", ["executeSqliteQueryTakeFirstSyncLegacy"]],
  ["src/sessions/session-upstream-links.ts", ["deleteSessionUpstreamLink"]],
]);

type CompatibilityOperation = { file: string; name: string; valid: boolean };

/** Classify only deprecated operations with no bundled runtime callers or escaped references. */
export function inspectDatabaseWorkerCompatibility(
  root: string,
  sourceTexts: ReadonlyMap<string, string>,
): { operations: Map<string, Set<string>>; violations: string[] } {
  const operations = new Map<string, Set<string>>();
  const violations: string[] = [];
  if (![...reviewed.keys()].some((file) => sourceTexts.has(file))) {
    return { operations, violations };
  }
  const config = ".openclaw-database-worker-compat.tsconfig.json";
  const files = Object.fromEntries(sourceTexts);
  files[config] = JSON.stringify({
    compilerOptions: {
      allowJs: true,
      noLib: true,
      types: [],
      target: "esnext",
      module: "nodenext",
      moduleResolution: "nodenext",
      jsx: "preserve",
      paths: {
        "openclaw/plugin-sdk": ["./src/plugin-sdk/index.ts"],
        "openclaw/plugin-sdk/*": ["./src/plugin-sdk/*.ts"],
        "@openclaw/plugin-sdk": ["./src/plugin-sdk/index.ts"],
        "@openclaw/plugin-sdk/*": ["./src/plugin-sdk/*.ts"],
      },
    },
    files: [...sourceTexts.keys()],
    include: [],
  });
  // The supplied snapshot owns all source bytes, including historical comparisons.
  using session = createNativeTypeScriptProject({
    cwd: root,
    configFileName: config,
    files,
    fs: {
      readFile: () => null,
      fileExists: () => false,
      directoryExists: () => false,
      getAccessibleEntries: () => ({ files: [], directories: [] }),
      realpath: (file) => file,
    },
  });
  const { checker, program } = session.project;
  const forwarded = new Map<Symbol, Symbol>();
  const resolveSymbol = (symbol: Symbol | undefined): Symbol | undefined => {
    const target =
      symbol && symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return target && (forwarded.get(target) ?? target);
  };
  const registered = new Map<Symbol, CompatibilityOperation>();
  const declarations = new Map<ts.Node, CompatibilityOperation>();
  const names = new Set([...reviewed.values()].flat());
  const sources = [...sourceTexts.keys()].map((file) => {
    const source = program.getSourceFile(path.resolve(root, file));
    if (!source) {
      throw new Error(`Compatibility scan did not load ${file}`);
    }
    for (const name of reviewed.get(file) ?? []) {
      const node = source.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) &&
          statement.name?.text === name &&
          Boolean(statement.body),
      );
      if (!node?.name) {
        continue;
      }
      const symbol = resolveSymbol(checker.getSymbolAtLocation(node.name));
      if (!symbol) {
        throw new Error(`Compatibility scan could not resolve ${file}:${name}`);
      }
      const valid = checker.getJsDocTagsOfSymbol(symbol).some((tag) => tag.name === "deprecated");
      if (!valid) {
        violations.push(`${file}:${name}: reviewed compatibility operation must be @deprecated`);
      }
      const operation = { file, name, valid };
      registered.set(symbol, operation);
      declarations.set(node, operation);
    }
    return { file, source };
  });
  const aliases: [string, string][] = [];
  const namespaces: (ts.Identifier | ts.StringLiteral)[] = [];
  const bindings: ts.VariableDeclaration[] = [];
  for (const { source } of sources) {
    const visit = (node: ts.Node) => {
      if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
        aliases.push([node.propertyName?.text ?? node.name.text, node.name.text]);
      } else if (ts.isImportClause(node) && node.name) {
        aliases.push(["default", node.name.text]);
      } else if (ts.isNamespaceImport(node) || ts.isNamespaceExport(node)) {
        namespaces.push(node.name);
      } else if (ts.isVariableDeclaration(node) && node.initializer) {
        bindings.push(node);
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
  }
  const contained = new Map<Symbol, Set<CompatibilityOperation>>();
  const targets = (rawSymbol: Symbol | undefined): Set<CompatibilityOperation> => {
    const symbol = resolveSymbol(rawSymbol);
    if (!symbol) {
      return new Set();
    }
    const cached = contained.get(symbol);
    if (cached) {
      return cached;
    }
    const found = new Set<CompatibilityOperation>();
    contained.set(symbol, found);
    const direct = registered.get(symbol);
    if (direct) {
      found.add(direct);
    } else if (symbol.flags & SymbolFlags.Module) {
      for (const member of checker.getExportsOfModule(symbol)) {
        for (const operation of targets(member)) {
          found.add(operation);
        }
      }
    }
    return found;
  };
  const namespaceSymbols = checker.getSymbolAtLocation(namespaces);
  for (const [index, namespace] of namespaces.entries()) {
    if (targets(namespaceSymbols[index]).size) {
      names.add(namespace.text);
    }
  }
  // Candidate spelling narrows native queries; declaration identity decides every exemption.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, to] of aliases) {
      if (names.has(from) && !names.has(to)) {
        names.add(to);
        changed = true;
      }
    }
  }
  const handledImports = new Set<ts.Node>();
  for (const binding of bindings) {
    const initializer = binding.initializer!;
    const expression = ts.isAwaitExpression(initializer) ? initializer.expression : initializer;
    const dynamicImport =
      ts.isCallExpression(expression) && expression.expression.kind === ts.SyntaxKind.ImportKeyword
        ? expression
        : undefined;
    const module = dynamicImport?.arguments[0]
      ? resolveSymbol(checker.getSymbolAtLocation(dynamicImport.arguments[0]))
      : undefined;
    if (!dynamicImport || !module) {
      continue;
    }
    const record = (name: ts.Identifier, target: Symbol | undefined) => {
      const local = checker.getSymbolAtLocation(name);
      if (local && target) {
        forwarded.set(local, target);
        if (targets(target).size) {
          names.add(name.text);
        }
      }
    };
    if (ts.isObjectBindingPattern(binding.name)) {
      if (
        binding.name.elements.some(
          (element) =>
            !ts.isBindingElement(element) ||
            !ts.isIdentifier(element.name) ||
            element.dotDotDotToken ||
            (element.propertyName && ts.isComputedPropertyName(element.propertyName)),
        )
      ) {
        continue;
      }
      for (const element of binding.name.elements) {
        if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) {
          continue;
        }
        const key =
          element.propertyName?.getText().replace(/^['"]|['"]$/g, "") ?? element.name.text;
        record(element.name, checker.getMemberInModuleExports(module, key));
      }
      handledImports.add(dynamicImport);
    } else if (ts.isIdentifier(binding.name)) {
      record(binding.name, module);
      handledImports.add(dynamicImport);
    }
  }
  const edges = new Map<CompatibilityOperation, Set<CompatibilityOperation>>();
  const accessSymbol = (expression: ts.Expression): Symbol | undefined => {
    const known = resolveSymbol(checker.getSymbolAtLocation(expression));
    if (known) {
      return known;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const base = accessSymbol(expression.expression);
      if (base && base.flags & SymbolFlags.Module) {
        return checker.getMemberInModuleExports(base, expression.name.text);
      }
    }
    return undefined;
  };
  for (const { file, source } of sources) {
    const references: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        return;
      }
      if (
        (((ts.isIdentifier(node) || ts.isStringLiteral(node)) && names.has(node.text)) ||
          (ts.isStringLiteral(node) &&
            ts.isCallExpression(node.parent) &&
            node.parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
            !handledImports.has(node.parent))) &&
        !declarations.has(node.parent) &&
        !(ts.isBindingElement(node.parent) && node.parent.name === node) &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
      ) {
        references.push(node);
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
    const symbols = checker.getSymbolAtLocation(references);
    for (const [index, node] of references.entries()) {
      let symbol = resolveSymbol(
        ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : symbols[index],
      );
      if (!symbol && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
        symbol = resolveSymbol(accessSymbol(node.parent));
      }
      if (!symbol && ts.isElementAccessExpression(node.parent) && ts.isStringLiteral(node)) {
        const base = accessSymbol(node.parent.expression);
        if (base && base.flags & SymbolFlags.Module) {
          symbol = resolveSymbol(checker.getMemberInModuleExports(base, node.text));
        }
      }
      const callees = targets(symbol);
      if (!callees.size) {
        continue;
      }
      // Namespace member access is inspected at its member. A computed/escaped
      // namespace cannot prove which member will be used, so it remains a caller.
      if (
        symbol &&
        symbol.flags & SymbolFlags.Module &&
        ((ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) ||
          (ts.isElementAccessExpression(node.parent) &&
            node.parent.expression === node &&
            ts.isStringLiteral(node.parent.argumentExpression)))
      ) {
        continue;
      }
      let owner: CompatibilityOperation | undefined;
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        owner = declarations.get(parent);
        if (owner) {
          break;
        }
      }
      for (const callee of callees) {
        if (owner) {
          const outgoing = edges.get(owner) ?? new Set<CompatibilityOperation>();
          outgoing.add(callee);
          edges.set(owner, outgoing);
        } else {
          const { line, character } = source.getLineAndCharacterOfPosition(node.getStart());
          violations.push(
            `${file}:${line + 1}:${character + 1}: bundled runtime reference to deprecated synchronous SQLite API ${callee.file}:${callee.name}`,
          );
          callee.valid = false;
        }
      }
    }
  }
  // A reachable compatibility wrapper also makes its compatibility callees live.
  changed = true;
  while (changed) {
    changed = false;
    for (const [caller, callees] of edges) {
      if (!caller.valid) {
        for (const callee of callees) {
          if (callee.valid) {
            callee.valid = false;
            changed = true;
          }
        }
      }
    }
  }
  for (const operation of registered.values()) {
    if (operation.valid) {
      const selected = operations.get(operation.file) ?? new Set<string>();
      selected.add(operation.name);
      operations.set(operation.file, selected);
    }
  }
  return { operations, violations: [...new Set(violations)].sort() };
}
