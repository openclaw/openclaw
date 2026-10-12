import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { SymbolFlags, type Symbol } from "typescript/unstable/sync";
import { createNativeTypeScriptProject } from "./native-typescript.mts";

// Each entry is a reviewed, released compatibility boundary, not a whole-file exemption.
// Kernels may join this list only after their bundled callers have moved to workers.
const reviewed = new Map<string, readonly string[]>([
  [
    "src/plugin-sdk/sqlite-runtime-legacy.ts",
    [
      "openOpenClawAgentDatabaseLegacy",
      "borrowOpenClawAgentDatabaseLegacy",
      "withOpenClawAgentDatabaseAsyncLegacy",
      "withOpenClawAgentDatabaseRuntimeLegacy",
      "withOpenClawAgentDatabaseWriteLegacy",
      "runOpenClawAgentWriteAdmissionLegacy",
      "executeSqliteQueryTakeFirstSyncLegacy",
      "iterateSqliteQuerySyncLegacy",
      "prepareSqliteQuerySyncLegacy",
      "runSqliteImmediateTransactionLegacy",
    ],
  ],
  ["src/sessions/session-upstream-links.ts", ["deleteSessionUpstreamLink"]],
  ["src/sessions/stored-model-overrides.ts", ["resolveStoredModelOverride"]],
  [
    "src/plugin-sdk/memory-core-host-engine-sessions.ts",
    [
      "loadArchivedSessions",
      "loadMemorySessionMetadata",
      "loadMemorySessionMetadataBatch",
      "resolveMemorySessionTargets",
    ],
  ],
  [
    "src/plugin-sdk/codex-session-transcript-runtime.ts",
    [
      "validateCodexSessionTranscriptReadAdmission",
      "validateCodexSessionTranscriptContextVersion",
      "withCodexSessionTranscriptMirrorWriteLock",
    ],
  ],
  ["src/plugin-sdk/session-transcript-runtime.ts", ["withSessionTranscriptWriteLock"]],
  ["src/plugin-sdk/provider-selection-runtime.ts", ["resolveConfiguredCapabilityProvider"]],
  ["src/pairing/pairing-store.ts", ["readChannelAllowFromStoreSync"]],
  ["src/media-generation/runtime-shared.ts", ["resolveCapabilityModelCandidates"]],
  ["src/talk/provider-resolver.ts", ["resolveConfiguredRealtimeVoiceProvider"]],
  ["src/auto-reply/commands-registry.ts", ["resolveCommandArgMenu"]],
  [
    "src/channels/direct-dm-access.ts",
    ["resolveInboundDirectDmAccessWithRuntime", "createPreCryptoDirectDmAuthorizer"],
  ],
  ["src/channels/direct-dm.ts", ["dispatchInboundDirectDmWithRuntime"]],
  ["src/channels/session-envelope.ts", ["resolveInboundSessionEnvelopeContext"]],
  [
    "src/channels/inbound-event/envelope.ts",
    [
      "createInboundEnvelopeBuilder",
      "resolveInboundRouteEnvelopeBuilder",
      "resolveInboundRouteEnvelopeBuilderWithRuntime",
    ],
  ],
  ["src/security/dm-policy-shared.ts", ["resolveDmGroupAccessWithLists"]],
  [
    "src/infra/outbound/account-scoped-conversation-bindings.ts",
    ["createAccountScopedConversationBindingManager"],
  ],
  [
    "extensions/imessage/src/conversation-bindings.ts",
    ["createIMessageConversationBindingManager"],
  ],
  ["extensions/matrix/auth-presence.ts", ["hasAnyMatrixAuth"]],
  [
    "src/agents/harness/native-session/binding-lifecycle.ts",
    ["createNativeSessionBindingLifecycle"],
  ],
  [
    "src/agents/harness/native-session/binding-generation.ts",
    [
      "resolveNativeSessionBinding",
      "reclaimNativeSessionGeneration",
      "captureNativeSessionGenerationAuthority",
    ],
  ],
  [
    "src/agents/harness/native-session/binding-generation-authority.ts",
    ["resolveNativeSessionBindingWithAuthority"],
  ],
]);

type CompatibilityOperation = {
  file: string;
  name: string;
  valid: boolean;
  reviewed: boolean;
  node:
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
    | ts.ClassDeclaration;
};

/** Classify only deprecated operations with no bundled runtime callers or escaped references. */
export function inspectDatabaseWorkerCompatibility(
  root: string,
  sourceTexts: ReadonlyMap<string, string>,
  isNonRuntime: (file: string, operation: string) => boolean = (file) =>
    /\.worker\.[cm]?[jt]s$/.test(file),
): {
  operations: Map<string, Set<string>>;
  callLocations: Map<string, Set<string>>;
  violations: string[];
} {
  const operations = new Map<string, Set<string>>();
  const callLocations = new Map<string, Set<string>>();
  const violations: string[] = [];
  if (![...reviewed.keys()].some((file) => sourceTexts.has(file))) {
    return { operations, callLocations, violations };
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
  const declarationNames = new Set<ts.Node>();
  const families = new Map<CompatibilityOperation, Set<CompatibilityOperation>>();
  const names = new Set([...reviewed.values()].flat());
  const sources = [...sourceTexts.keys()].map((file) => {
    const source = program.getSourceFile(path.resolve(root, file));
    if (!source) {
      throw new Error(`Compatibility scan did not load ${file}`);
    }
    for (const name of reviewed.get(file) ?? []) {
      const node = source.statements.find(
        (statement): statement is ts.FunctionDeclaration | ts.ClassDeclaration =>
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === name &&
          (ts.isClassDeclaration(statement) || Boolean(statement.body)),
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
      const operation = { file, name, valid, reviewed: true, node };
      registered.set(symbol, operation);
      declarations.set(node, operation);
      declarationNames.add(node.name);
    }
    return { file, source };
  });
  // Follow named kernels from the reviewed boundaries. A symbol reference from
  // outside this closure (or an escaped callback) will make that kernel live.
  // A returned receiver exists only through its factory. Keep its methods in
  // the same reachability family; a live factory or escaped member retires it.
  const operationName = (node: ts.Node) => {
    const parts: string[] = [];
    for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
      if (
        (ts.isFunctionDeclaration(parent) ||
          ts.isFunctionExpression(parent) ||
          ts.isMethodDeclaration(parent)) &&
        parent.name &&
        ts.isIdentifier(parent.name)
      ) {
        parts.unshift(parent.name.text);
      } else if (
        (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
        parent.initializer &&
        (ts.isArrowFunction(parent.initializer) || ts.isFunctionExpression(parent.initializer)) &&
        ts.isIdentifier(parent.name)
      ) {
        parts.unshift(parent.name.text);
      }
    }
    return parts.join(".");
  };
  const addMember = (owner: CompatibilityOperation, node: CompatibilityOperation["node"]) => {
    let member = declarations.get(node);
    if (!member) {
      member = { file: owner.file, name: operationName(node), valid: true, reviewed: false, node };
      declarations.set(node, member);
      const name =
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        ts.isPropertyAssignment(node.parent)
          ? node.parent.name
          : "name" in node
            ? node.name
            : undefined;
      if (name) {
        declarationNames.add(name);
      }
      const symbol = name ? resolveSymbol(checker.getSymbolAtLocation(name)) : undefined;
      if (symbol) {
        registered.set(symbol, member);
        if (name && ts.isIdentifier(name)) {
          names.add(name.text);
        }
      }
    }
    const family = families.get(owner) ?? new Set<CompatibilityOperation>();
    family.add(member);
    families.set(owner, family);
    return member;
  };
  const primitives = new Set([
    "executeSqliteQuerySync",
    "executeSqliteQueryTakeFirstSync",
    "runOpenClawStateWriteTransaction",
    "runOpenClawAgentWriteTransaction",
    "withOpenClawAgentDatabaseReadOnly",
  ]);
  const examined = new Set<Symbol>();
  const expandedMembers = new Set<ts.Node>();
  let pending = [...registered.values()];
  while (pending.length > 0) {
    const references: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isTypeNode(node)) {
        return;
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        references.push(node.expression);
      }
      node.forEachChild(visit);
    };
    const members: CompatibilityOperation[] = [];
    for (const operation of pending) {
      const node = operation.node;
      const returned = (value: ts.Expression) => {
        if (
          ts.isParenthesizedExpression(value) ||
          ts.isAsExpression(value) ||
          ts.isSatisfiesExpression(value)
        ) {
          returned(value.expression);
        } else if (ts.isObjectLiteralExpression(value)) {
          for (const property of value.properties) {
            if (
              ts.isMethodDeclaration(property) ||
              ts.isGetAccessorDeclaration(property) ||
              ts.isSetAccessorDeclaration(property)
            ) {
              members.push(addMember(operation, property));
            } else if (
              ts.isPropertyAssignment(property) &&
              (ts.isArrowFunction(property.initializer) ||
                ts.isFunctionExpression(property.initializer))
            ) {
              members.push(addMember(operation, property.initializer));
            }
          }
        } else if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
          members.push(addMember(operation, value));
        }
      };
      const findReturns = (child: ts.Node) => {
        if (ts.isFunctionLikeDeclaration(child)) {
          return;
        }
        if (ts.isReturnStatement(child) && child.expression) {
          returned(child.expression);
        }
        child.forEachChild(findReturns);
      };
      if (ts.isClassDeclaration(node)) {
        // Class-definition effects run without constructing a receiver. Inherited
        // or field-bearing instances also need a separate ownership proof.
        if (
          node.heritageClauses?.length ||
          node.modifiers?.some((modifier) => ts.isDecorator(modifier)) ||
          node.members.some(
            (member) =>
              ts.isPropertyDeclaration(member) ||
              ts.isClassStaticBlockDeclaration(member) ||
              ((ts.isConstructorDeclaration(member) ||
                ts.isMethodDeclaration(member) ||
                ts.isGetAccessorDeclaration(member) ||
                ts.isSetAccessorDeclaration(member)) &&
                ((!ts.isConstructorDeclaration(member) && ts.isComputedPropertyName(member.name)) ||
                  member.modifiers?.some((modifier) => ts.isDecorator(modifier)) ||
                  member.parameters.some((parameter) =>
                    parameter.modifiers?.some((modifier) => ts.isDecorator(modifier)),
                  ))),
          )
        ) {
          operation.valid = false;
        } else {
          for (const member of node.members) {
            if (
              ts.isConstructorDeclaration(member) ||
              ts.isMethodDeclaration(member) ||
              ts.isGetAccessorDeclaration(member) ||
              ts.isSetAccessorDeclaration(member)
            ) {
              members.push(addMember(operation, member));
            }
          }
        }
      } else if (node.body) {
        if (ts.isBlock(node.body)) {
          node.body.forEachChild(findReturns);
        } else {
          returned(node.body);
        }
        visit(node.body);
      }
    }
    pending = members.filter((member) => !expandedMembers.has(member.node));
    for (const member of pending) {
      expandedMembers.add(member.node);
    }
    const symbols = checker.getSymbolAtLocation(references);
    for (const raw of symbols) {
      const symbol = resolveSymbol(raw);
      if (!symbol || examined.has(symbol) || registered.has(symbol)) {
        continue;
      }
      examined.add(symbol);
      if (primitives.has(symbol.name)) {
        continue;
      }
      const node = symbol.valueDeclaration?.resolve();
      if (
        !node ||
        !(ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) ||
        !node.name ||
        (ts.isFunctionDeclaration(node) && !node.body)
      ) {
        continue;
      }
      const file = path.relative(root, node.getSourceFile().fileName).split(path.sep).join("/");
      if (!sourceTexts.has(file)) {
        continue;
      }
      const name = operationName(node);
      if (isNonRuntime(file, name)) {
        continue;
      }
      const operation = { file, name, valid: true, reviewed: false, node };
      registered.set(symbol, operation);
      declarations.set(node, operation);
      declarationNames.add(node.name);
      names.add(node.name.text);
      pending.push(operation);
    }
  }
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
    // Instantiated receiver properties retain their declaration, but get a new symbol.
    const declaration = symbol.valueDeclaration?.resolve();
    const direct =
      registered.get(symbol) ??
      (declaration
        ? declarations.get(
            ts.isPropertyAssignment(declaration) ? declaration.initializer : declaration,
          )
        : undefined);
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
            !element.name ||
            !ts.isIdentifier(element.name) ||
            element.dotDotDotToken ||
            (element.propertyName && ts.isComputedPropertyName(element.propertyName)),
        )
      ) {
        continue;
      }
      for (const element of binding.name.elements) {
        if (!ts.isBindingElement(element) || !element.name || !ts.isIdentifier(element.name)) {
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
  const callerEdges = new Map<CompatibilityOperation, Set<CompatibilityOperation>>();
  const runtimeReferences = new Set<CompatibilityOperation>();
  for (const [owner, members] of families) {
    const outgoing = edges.get(owner) ?? new Set<CompatibilityOperation>();
    for (const member of members) {
      outgoing.add(member);
    }
    edges.set(owner, outgoing);
    for (const member of members) {
      const memberEdges = edges.get(member) ?? new Set<CompatibilityOperation>();
      memberEdges.add(owner);
      edges.set(member, memberEdges);
    }
  }
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
      // `extends` is a runtime reference even though its AST wrapper is a type.
      if (
        ts.isExpressionWithTypeArguments(node) &&
        ts.isHeritageClause(node.parent) &&
        node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
        (ts.isClassDeclaration(node.parent.parent) || ts.isClassExpression(node.parent.parent))
      ) {
        visit(node.expression);
        return;
      }
      if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        return;
      }
      if (
        (((ts.isIdentifier(node) || ts.isStringLiteral(node)) && names.has(node.text)) ||
          (ts.isStringLiteral(node) &&
            ts.isCallExpression(node.parent) &&
            node.parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
            !handledImports.has(node.parent))) &&
        !declarationNames.has(node) &&
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
      let unprovenCallback = false;
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        owner = declarations.get(parent);
        if (owner) {
          break;
        }
        if (
          ts.isMethodDeclaration(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
            !(ts.isCallExpression(parent.parent) && parent.parent.expression === parent))
        ) {
          unprovenCallback = ts.isArrowFunction(parent) || ts.isFunctionExpression(parent);
          break;
        }
      }
      for (const callee of callees) {
        const expression =
          ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)
            ? node.parent
            : node;
        const directCall =
          (ts.isCallExpression(expression.parent) || ts.isNewExpression(expression.parent)) &&
          expression.parent.expression === expression;
        if (owner && directCall) {
          const outgoing = edges.get(owner) ?? new Set<CompatibilityOperation>();
          outgoing.add(callee);
          edges.set(owner, outgoing);
          const calls = callerEdges.get(owner) ?? new Set<CompatibilityOperation>();
          calls.add(callee);
          callerEdges.set(owner, calls);
        } else {
          let nonRuntime = false;
          if (!callee.reviewed && directCall && !unprovenCallback) {
            const enclosingNames: string[] = [];
            for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
              if (
                (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) &&
                parent.name &&
                ts.isIdentifier(parent.name)
              ) {
                enclosingNames.unshift(parent.name.text);
              }
            }
            nonRuntime = isNonRuntime(file, enclosingNames.join("."));
          }
          if (nonRuntime) {
            continue;
          }
          const { line, character } = source.getLineAndCharacterOfPosition(node.getStart());
          if (callee.reviewed) {
            violations.push(
              `${file}:${line + 1}:${character + 1}: bundled runtime reference to deprecated synchronous SQLite API ${callee.file}:${callee.name}`,
            );
          }
          callee.valid = false;
          runtimeReferences.add(callee);
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
  // An unproven member keeps its family live, but does not establish a factory caller.
  for (const caller of runtimeReferences) {
    for (const callee of [...(callerEdges.get(caller) ?? []), ...(families.get(caller) ?? [])]) {
      runtimeReferences.add(callee);
    }
  }
  for (const operation of declarations.values()) {
    if (
      operation.reviewed &&
      runtimeReferences.has(operation) &&
      !violations.some((violation) => violation.includes(`${operation.file}:${operation.name}`))
    ) {
      violations.push(
        `${operation.file}:${operation.name}: reviewed compatibility operation is reachable through a live or escaped kernel`,
      );
    }
    if (operation.valid) {
      const selected = operations.get(operation.file) ?? new Set<string>();
      selected.add(operation.name);
      operations.set(operation.file, selected);
      const locations = callLocations.get(operation.file) ?? new Set<string>();
      const source = operation.node.getSourceFile();
      const visit = (node: ts.Node) => {
        if (ts.isFunctionLikeDeclaration(node) && node !== operation.node) {
          // Only an actual IIFE keeps the caller's execution scope. Callback
          // arguments and returned functions may escape, even inside a legacy API.
          if (!(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
            return;
          }
        }
        if (ts.isCallExpression(node)) {
          const { line, character } = source.getLineAndCharacterOfPosition(
            node.expression.getStart(),
          );
          locations.add(`${line + 1}:${character + 1}`);
        }
        node.forEachChild(visit);
      };
      visit(operation.node);
      callLocations.set(operation.file, locations);
    }
  }
  return { operations, callLocations, violations: [...new Set(violations)].toSorted() };
}
