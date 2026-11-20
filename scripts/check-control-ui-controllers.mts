import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript/ast";
import {
  bindingScope,
  isTest,
  PLUGIN_UI_SOURCE_ROOTS,
  readInventorySources,
} from "./control-ui-solid-inventory.mts";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import {
  parseRatchetArgs,
  reportRatchetFailures,
  runPerFileCountRatchet,
} from "./lib/shrink-ratchet.mts";

const IMPORTED_PATTERNS = ["flush", "getOwner", "runWithOwner", "onCleanup"] as const;
const PATTERNS = [
  "createEffect",
  "untrack",
  "addEventListener",
  "querySelector",
  ...IMPORTED_PATTERNS,
  "manualImport",
] as const;
type Pattern = (typeof PATTERNS)[number];
const SURFACES = [
  { title: "Control UI", baseline: "control-ui", roots: ["ui/src"] },
  {
    title: "Plugin UI",
    baseline: "plugin-ui",
    roots: PLUGIN_UI_SOURCE_ROOTS,
  },
];
const GUIDANCE =
  "Use Solid ownership, derivations, refs, and shared primitives; see .agents/skills/solid/references/refactor-checklist.md.";

// The plain-TS context adapter supplies live children to the native host bridge.
// The other two wave-ten callers have since moved to JSX; do not restore them.
const COMPONENT_FACTORIES = new Set(["ui/src/lib/reactive/context.ts"]);
const COMPUTATIONS = new Set([
  "createMemo",
  "createProjection",
  "createDeferred",
  "createSignal",
  "createStore",
  "createOptimistic",
  "createOptimisticStore",
  "createEffect",
  "createRenderEffect",
  "createTrackedEffect",
]);

function isViewModule(file: string) {
  return (
    !file.startsWith("ui/src/lib/reactive/") &&
    (file.endsWith(".tsx") ||
      /^ui\/src\/(?:app|components|pages|plugins)\//u.test(file) ||
      /^extensions\/[^/]+\/browser\//u.test(file))
  );
}

function callbackCall(node: ts.Node) {
  let callback = node;
  while (
    ts.isParenthesizedExpression(callback.parent) ||
    ts.isAsExpression(callback.parent) ||
    ts.isSatisfiesExpression(callback.parent)
  ) {
    callback = callback.parent;
  }
  const call = callback.parent;
  return ts.isCallExpression(call) && call.arguments[0] === callback ? call : undefined;
}

function inComputation(
  node: ts.Node,
  importedName: (expression: ts.Expression) => string | undefined,
) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLikeDeclaration(parent)) {
      // Only the compute callback is owned; effect apply returns its teardown.
      const call = callbackCall(parent);
      return call !== undefined && COMPUTATIONS.has(importedName(call.expression) ?? "");
    }
  }
  return false;
}

// Count value-storing/chained imports, not route/utility loader callbacks or lazy().
// This is syntactic: it deliberately does not follow imported loader helpers.
function isManualImport(
  node: ts.CallExpression,
  importedName: (expression: ts.Expression) => string | undefined,
) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLikeDeclaration(parent)) {
      const call = callbackCall(parent);
      if (call && importedName(call.expression) === "lazy") {
        return false;
      }
    }
  }
  let current: ts.Node = node;
  let chained = false;
  for (let parent = current.parent; parent; current = parent, parent = parent.parent) {
    if (ts.isFunctionLikeDeclaration(parent) || ts.isReturnStatement(parent)) {
      return chained;
    }
    if (ts.isVariableDeclaration(parent)) {
      const specifier = node.arguments[0];
      return (
        parent.initializer === current &&
        (ts.isIdentifier(parent.name) ||
          (specifier !== undefined &&
            ts.isStringLiteral(specifier) &&
            /\.[jt]sx$/u.test(specifier.text)))
      );
    }
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
        parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken)
    ) {
      return parent.right === current;
    }
    if (ts.isCallExpression(parent)) {
      const name = callName(parent.expression);
      if (name === "then" || name === "catch" || name === "finally") {
        chained = true;
      } else if (parent.arguments.some((argument) => argument === current) && name !== "all") {
        // A direct setter/consumer owns the imported module value.
        return true;
      }
    }
    if (ts.isExpressionStatement(parent)) {
      return chained;
    }
  }
  return false;
}

// Each entry owns DOM produced outside Solid. Counts still ratchet within these files.
const DOM_ISLANDS = new Set([
  "ui/src/app/control-ui-environment-presentation.runtime.ts", // parsed favicon SVG
  "ui/src/components/link-reader-hovercard-owner.ts", // rendered Markdown
  "ui/src/components/link-reader-markdown.tsx", // parsed article HTML
  "ui/src/components/link-reader-panel-owner.ts", // rendered article anchors
  "ui/src/components/link-reader-prefetch-owner.ts", // rendered Markdown links
  "ui/src/components/lobster-image.ts", // computed-style snapshot of trusted SVG artwork
  "ui/src/components/markdown-blocks-owner.ts",
  "ui/src/components/markdown-code-blocks.ts",
  "ui/src/components/markdown-mermaid.tsx",
  "ui/src/components/markdown-tables.ts",
  "ui/src/components/markdown.ts",
  "ui/src/components/session-progress-card.ts", // parsed progress HTML
  "ui/src/components/session-progress-card-view.tsx", // rendered progress HTML
  "ui/src/components/desktop/desktop-client.ts", // noVNC canvas
  "ui/src/lib/chat/pasted-text-excerpt.ts", // clipboard HTML
  "ui/src/lib/markdown-dom-reconciler.ts",
  "ui/src/pages/chat/components/chat-context-copy.ts", // Markdown actions
  "ui/src/pages/chat/components/chat-image-lightbox.ts", // Markdown images
  "ui/src/pages/chat/components/chat-message-overflow.ts", // Markdown disclosures
  "ui/src/pages/chat/link-favicon-loader.ts", // rendered Markdown images
  "ui/src/pages/plugins/svg-icon-rasterizer.ts", // parsed plugin SVG
  "ui/src/plugins/control-ui-components.ts", // plugin-rendered dialogs
  "ui/src/plugins/control-ui-view.solid.tsx", // plugin-rendered view
]);

function callName(
  expression: ts.Expression,
  aliases?: ReadonlyMap<string, string>,
): string | undefined {
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) {
    return callName(expression.expression, aliases);
  }
  if (ts.isIdentifier(expression)) {
    return aliases?.get(expression.text) ?? expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (ts.isElementAccessExpression(expression)) {
    const key = expression.argumentExpression;
    if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
      return key.text;
    }
  }
  return undefined;
}

type SolidImport = { kind: "namespace" } | { kind: "member"; name: string };

// Resolve only actual Solid imports; owner methods and shadowed local names are unrelated.
function solidImportResolver(tree: ts.SourceFile) {
  const scopes = new WeakMap<ts.Node, Map<string, SolidImport | null>>();
  const bind = (scope: ts.Node, name: string, imported: SolidImport | null = null) => {
    let names = scopes.get(scope);
    if (!names) {
      names = new Map();
      scopes.set(scope, names);
    }
    names.set(name, imported);
  };
  const bindPattern = (scope: ts.Node, name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      bind(scope, name.text);
    } else {
      for (const element of name.elements) {
        if (ts.isBindingElement(element) && element.name) {
          bindPattern(scope, element.name);
        }
      }
    }
  };
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const module = node.moduleSpecifier;
      const solid =
        ts.isStringLiteral(module) &&
        (module.text === "solid-js" || module.text === "@solidjs/signals") &&
        node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword;
      const clause = node.importClause;
      if (clause?.name) {
        bind(bindingScope(node, tree), clause.name.text);
      }
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        bind(bindingScope(node, tree), bindings.name.text, solid ? { kind: "namespace" } : null);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          bind(
            bindingScope(node, tree),
            binding.name.text,
            solid && !binding.isTypeOnly
              ? { kind: "member", name: (binding.propertyName ?? binding.name).text }
              : null,
          );
        }
      }
    }
    if (ts.isVariableDeclaration(node)) {
      const isVar =
        ts.isVariableDeclarationList(node.parent) &&
        !(node.parent.flags & ts.NodeFlags.BlockScoped);
      bindPattern(bindingScope(node, tree, isVar), node.name);
    }
    if (ts.isFunctionLikeDeclaration(node)) {
      for (const parameter of node.parameters) {
        bindPattern(node, parameter.name);
      }
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      bind(bindingScope(node, tree), node.name.text);
    }
    if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
      bind(node, node.name.text);
    }
    node.forEachChild(collect);
  };
  collect(tree);
  const resolve = (input: ts.Expression): SolidImport | null => {
    const node = unwrapExpression(input);
    if (ts.isIdentifier(node)) {
      for (let scope = node.parent; scope; scope = scope.parent) {
        const names = scopes.get(scope);
        if (names?.has(node.text)) {
          return names.get(node.text) ?? null;
        }
      }
    } else if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      resolve(node.expression)?.kind === "namespace"
    ) {
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression && unwrapExpression(node.argumentExpression);
      if (typeof name === "string") {
        return { kind: "member", name };
      }
      if (name && (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))) {
        return { kind: "member", name: name.text };
      }
    }
    return null;
  };
  return (expression: ts.Expression) => {
    const imported = resolve(expression);
    return imported?.kind === "member" ? imported.name : undefined;
  };
}

function unwrapExpression(input: ts.Expression): ts.Expression {
  let node = input;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertion(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function isLiteralMemo(call: ts.CallExpression): boolean {
  const argument = call.arguments[0];
  if (call.arguments.length !== 1 || !argument) {
    return false;
  }
  const callback = unwrapExpression(argument);
  if (
    !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ||
    callback.parameters.length !== 0 ||
    callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    (ts.isFunctionExpression(callback) && callback.asteriskToken)
  ) {
    return false;
  }
  let value: ts.Expression;
  if (ts.isBlock(callback.body)) {
    const statement = callback.body.statements[0];
    if (
      callback.body.statements.length !== 1 ||
      !statement ||
      !ts.isReturnStatement(statement) ||
      !statement.expression
    ) {
      return false;
    }
    value = statement.expression;
  } else {
    value = callback.body;
  }
  value = unwrapExpression(value);
  return (
    ts.isStringLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  );
}

function solidPatterns(root: string, sources: ReadonlyMap<string, string>) {
  const counts: Record<Pattern, Map<string, number>> = {
    createEffect: new Map(),
    untrack: new Map(),
    addEventListener: new Map(),
    querySelector: new Map(),
    flush: new Map(),
    getOwner: new Map(),
    runWithOwner: new Map(),
    onCleanup: new Map(),
    manualImport: new Map(),
  };
  const forbidden: string[] = [];
  const files = [...sources]
    .filter(
      ([file, text]) =>
        !isTest(file) &&
        /create(?:Render)?Effect|untrack|addEventListener|querySelector|solid-js|@solidjs\/signals|classList|\bimport\b/u.test(
          text,
        ),
    )
    .map(([fileName, text]) => ({ fileName, text }));
  using parser = createNativeTypeScriptParser({ cwd: root });
  for (const tree of parser.parseSourceFiles(files)) {
    const file = path.relative(root, tree.fileName).split(path.sep).join("/");
    const importedName = solidImportResolver(tree);
    const aliases = new Map<string, string>();
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement)) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          aliases.set(binding.name.text, (binding.propertyName ?? binding.name).text);
        }
      }
    }
    const forbid = (node: ts.Node, message: string) => {
      const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
      forbidden.push(`${file}:${line + 1}: ${message}`);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText(tree) === "classList") {
        forbid(node, "classList is removed in Solid 2; use class arrays/objects");
      }
      if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === "classList" &&
        ts.isObjectLiteralExpression(node.parent) &&
        ts.isJsxSpreadAttribute(node.parent.parent)
      ) {
        forbid(node, "classList is removed in Solid 2; use class arrays/objects");
      }
      if (ts.isCallExpression(node)) {
        const name = callName(node.expression, aliases);
        const imported = importedName(node.expression);
        const pattern = PATTERNS.find((entry) => {
          if (entry === "manualImport") {
            return (
              isViewModule(file) &&
              !/\/route\.[jt]sx?$/u.test(file) &&
              node.expression.kind === ts.SyntaxKind.ImportKeyword &&
              isManualImport(node, importedName)
            );
          }
          if (entry === "onCleanup") {
            return imported === entry && isViewModule(file) && !inComputation(node, importedName);
          }
          return IMPORTED_PATTERNS.some((importedPattern) => importedPattern === entry)
            ? entry === imported
            : entry === name || (entry === "querySelector" && name === "querySelectorAll");
        });
        if (pattern) {
          const entries = counts[pattern];
          entries.set(file, (entries.get(file) ?? 0) + 1);
        }
        if (imported === "createMemo" && isLiteralMemo(node)) {
          forbid(node, "createMemo of a literal is unnecessary");
        }
        if (imported === "createComponent" && !COMPONENT_FACTORIES.has(file)) {
          forbid(node, "hand-written createComponent is not allowed here; use JSX");
        }
        if (
          (name === "createRenderEffect" && !file.startsWith("ui/src/lib/reactive/")) ||
          (name === "addEventListener" && file.endsWith(".tsx")) ||
          (pattern === "querySelector" && !DOM_ISLANDS.has(file))
        ) {
          forbid(node, `${name} is not allowed here`);
        }
      }
      node.forEachChild(visit);
    };
    visit(tree);
  }
  return { counts, forbidden };
}

function retiredControllerUsers(root: string, sources: ReadonlyMap<string, string>) {
  const files = [...sources]
    .filter(([, text]) =>
      /solid-controller-host|subscriptions-controller|SolidController|addController|removeController|requestUpdate|hostConnected|hostDisconnected|\w*Controller/u.test(
        text,
      ),
    )
    .map(([fileName, text]) => ({ fileName, text }));
  const users = new Set(
    [
      "ui/src/lib/reactive/solid-controller-host.ts",
      "ui/src/lib/subscriptions-controller.ts",
    ].filter((file) => sources.has(file)),
  );
  const redrawUsers = new Set<string>();
  const patterns = new Set<string>();
  if (files.length === 0) {
    return { hosts: users, redraws: redrawUsers, patterns };
  }
  using parser = createNativeTypeScriptParser({ cwd: root });
  for (const tree of parser.parseSourceFiles(files)) {
    const file = path.relative(root, tree.fileName).split(path.sep).join("/");
    const visit = (node: ts.Node): void => {
      if (
        !isTest(file) &&
        ((ts.isIdentifier(node) &&
          (node.text === "hostConnected" || node.text === "hostDisconnected")) ||
          ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
            node.name?.text.endsWith("Controller")))
      ) {
        patterns.add(file);
      }
      // Test adapters and computed property names must not preserve the retired API.
      if (
        (ts.isIdentifier(node) ||
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node)) &&
        node.text === "requestUpdate"
      ) {
        redrawUsers.add(file);
      }
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
              ? node.argument.literal
              : undefined;
      if (
        (ts.isIdentifier(node) &&
          (node.text === "SolidController" ||
            node.text === "SolidControllerHost" ||
            node.text === "addController" ||
            node.text === "removeController")) ||
        (specifier &&
          (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)) &&
          /(?:^|\/)(?:solid-controller-host|subscriptions-controller)(?:\.ts)?$/u.test(
            specifier.text,
          ))
      ) {
        users.add(file);
      }
      node.forEachChild(visit);
    };
    visit(tree);
  }
  return { hosts: users, redraws: redrawUsers, patterns };
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  try {
    const args = parseRatchetArgs(argv);
    const current = readInventorySources(root, {
      staged: args.staged,
      roots: SURFACES.flatMap((surface) => surface.roots),
    });
    const retiredUsers = retiredControllerUsers(root, current);
    if (
      reportRatchetFailures(
        [
          {
            title: "Retired UI controller host modules and contracts must not be reintroduced:",
            entries: [...retiredUsers.hosts],
          },
          {
            title: "Retired UI requestUpdate contracts must not be reintroduced:",
            entries: [...retiredUsers.redraws],
          },
          {
            title: "Retired UI controller patterns must not be reintroduced:",
            entries: [...retiredUsers.patterns],
          },
        ],
        GUIDANCE,
      )
    ) {
      return 1;
    }
    const currentPatterns = solidPatterns(root, current);
    if (
      reportRatchetFailures(
        [{ title: "Forbidden UI Solid patterns:", entries: currentPatterns.forbidden }],
        GUIDANCE,
      )
    ) {
      return 1;
    }
    let result = 0;
    for (const surface of SURFACES) {
      for (const pattern of PATTERNS) {
        const baselinePath = `config/${surface.baseline}-${pattern}-baseline.txt`;
        const checked = runPerFileCountRatchet(root, argv, {
          baselinePath,
          baselineHeader: `# ${surface.title} ${pattern} calls; shrink only.\n# Run pnpm check:control-ui-controllers --prune after removing calls.\n`,
          renameSourceRoots: surface.roots,
          collectCurrent: () =>
            new Map(
              [...currentPatterns.counts[pattern]].filter(([file]) =>
                surface.roots.some(
                  (sourceRoot) => file === sourceRoot || file.startsWith(`${sourceRoot}/`),
                ),
              ),
            ),
          // The initial census covers all existing calls; unlisted debt has no allowance.
          countAtRef: () => 0,
          messages: {
            increaseTitle: `${surface.title} ${pattern} calls must not increase:`,
            expansionTitle: `${surface.title} ${pattern} allowances must not increase:`,
            guidance: GUIDANCE,
            countNoun: `${pattern} calls`,
            successTitle: `${surface.title} ${pattern} ratchet OK`,
          },
        });
        result ||= checked;
      }
    }
    if (result) {
      return result;
    }
    console.log("Control UI controller guard OK.");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
