import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript/ast";
import { isTest, readInventorySources } from "./control-ui-solid-inventory.mts";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import {
  parseRatchetArgs,
  reportRatchetFailures,
  runPerFileCountRatchet,
} from "./lib/shrink-ratchet.mts";

const PATTERNS = ["createEffect", "untrack", "addEventListener", "querySelector"] as const;
type Pattern = (typeof PATTERNS)[number];
const GUIDANCE =
  "Use Solid ownership, derivations, refs, and shared primitives; see .agents/skills/solid/references/refactor-checklist.md.";

// Each entry owns DOM produced outside Solid. Counts still ratchet within these files.
const DOM_ISLANDS = new Set([
  "ui/src/app/control-ui-environment-presentation.runtime.ts", // parsed favicon SVG
  "ui/src/components/link-reader-hovercard-owner.ts", // rendered Markdown
  "ui/src/components/link-reader-markdown.tsx", // parsed article HTML
  "ui/src/components/link-reader-panel-owner.ts", // rendered article anchors
  "ui/src/components/link-reader-prefetch-owner.ts", // rendered Markdown links
  "ui/src/components/lobster-image.ts", // parsed sprite SVG
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
  aliases: ReadonlyMap<string, string>,
): string | undefined {
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) {
    return callName(expression.expression, aliases);
  }
  if (ts.isIdentifier(expression)) {
    return aliases.get(expression.text) ?? expression.text;
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

function solidPatterns(root: string, sources: ReadonlyMap<string, string>) {
  const counts: Record<Pattern, Map<string, number>> = {
    createEffect: new Map(),
    untrack: new Map(),
    addEventListener: new Map(),
    querySelector: new Map(),
  };
  const forbidden: string[] = [];
  const files = [...sources]
    .filter(
      ([file, text]) =>
        !isTest(file) &&
        /create(?:Render)?Effect|untrack|addEventListener|querySelector/u.test(text),
    )
    .map(([fileName, text]) => ({ fileName, text }));
  using parser = createNativeTypeScriptParser({ cwd: root });
  for (const tree of parser.parseSourceFiles(files)) {
    const file = path.relative(root, tree.fileName).split(path.sep).join("/");
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
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = callName(node.expression, aliases);
        const pattern = PATTERNS.find(
          (entry) => entry === name || (entry === "querySelector" && name === "querySelectorAll"),
        );
        if (pattern) {
          const entries = counts[pattern];
          entries.set(file, (entries.get(file) ?? 0) + 1);
        }
        if (
          (name === "createRenderEffect" && !file.startsWith("ui/src/lib/reactive/")) ||
          (name === "addEventListener" && file.endsWith(".tsx")) ||
          (pattern === "querySelector" && !DOM_ISLANDS.has(file))
        ) {
          const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
          forbidden.push(`${file}:${line + 1}: ${name} is not allowed here`);
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
    const current = readInventorySources(root, { staged: args.staged, roots: ["ui/src"] });
    const retiredUsers = retiredControllerUsers(root, current);
    if (
      reportRatchetFailures(
        [
          {
            title:
              "Retired Control UI controller host modules and contracts must not be reintroduced:",
            entries: [...retiredUsers.hosts],
          },
          {
            title: "Retired Control UI requestUpdate contracts must not be reintroduced:",
            entries: [...retiredUsers.redraws],
          },
          {
            title: "Retired Control UI controller patterns must not be reintroduced:",
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
        [{ title: "Forbidden Control UI Solid patterns:", entries: currentPatterns.forbidden }],
        GUIDANCE,
      )
    ) {
      return 1;
    }
    let result = 0;
    for (const pattern of PATTERNS) {
      const baselinePath = `config/control-ui-${pattern}-baseline.txt`;
      const checked = runPerFileCountRatchet(root, argv, {
        baselinePath,
        baselineHeader: `# Control UI ${pattern} calls; shrink only.\n# Run pnpm check:control-ui-controllers --prune after removing calls.\n`,
        renameSourceRoots: ["ui/src"],
        collectCurrent: () => currentPatterns.counts[pattern],
        // The initial census covers all existing calls; unlisted debt has no allowance.
        countAtRef: () => 0,
        messages: {
          increaseTitle: `Control UI ${pattern} calls must not increase:`,
          expansionTitle: `Control UI ${pattern} allowances must not increase:`,
          guidance: GUIDANCE,
          countNoun: `${pattern} calls`,
          successTitle: `Control UI ${pattern} ratchet OK`,
        },
      });
      result ||= checked;
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
