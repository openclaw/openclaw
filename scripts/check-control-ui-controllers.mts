import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript/unstable/ast";
import {
  countMigrationSources,
  isTest,
  readInventorySources,
} from "./control-ui-solid-inventory.mts";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import {
  parseRatchetArgs,
  reportRatchetFailures,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";

function retiredControllerHostUsers(root: string, sources: ReadonlyMap<string, string>) {
  using parser = createNativeTypeScriptParser({ cwd: root });
  const files = [...sources]
    .filter(
      ([, text]) =>
        text.includes("solid-controller-host") ||
        text.includes("subscriptions-controller") ||
        text.includes("SolidController") ||
        text.includes("addController") ||
        text.includes("removeController"),
    )
    .map(([fileName, text]) => ({ fileName, text }));
  const users = new Set(
    [
      "ui/src/lib/reactive/solid-controller-host.ts",
      "ui/src/lib/subscriptions-controller.ts",
    ].filter((file) => sources.has(file)),
  );
  for (const tree of parser.parseSourceFiles(files)) {
    const visit = (node: ts.Node): void => {
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
        users.add(path.relative(root, tree.fileName).split(path.sep).join("/"));
      }
      node.forEachChild(visit);
    };
    visit(tree);
  }
  return users;
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  try {
    const args = parseRatchetArgs(argv);
    if (args.prune) {
      throw new Error("The controller guard reads its base from Git; --prune is not supported.");
    }
    const base = resolveRatchetBase(root, args);
    if (!base) {
      throw new Error("No controller guard base found; pass --base <ref>.");
    }
    const previous = readInventorySources(root, { ref: base, roots: ["ui/src"] });
    const current = readInventorySources(root, { staged: args.staged, roots: ["ui/src"] });
    // Parse candidates so comments and strings cannot keep the retirement gate open.
    const candidates = (sources: ReadonlyMap<string, string>) =>
      new Map(
        [...sources].filter(
          ([file, text]) =>
            !isTest(file) &&
            /\b(?:hostConnected|hostDisconnected|requestUpdate|\w*Controller)\b/u.test(text),
        ),
      );
    const controllersRetired = [
      ...countMigrationSources(root, candidates(previous)).values(),
    ].every((counts) => counts.controllerPatterns === 0);
    const reintroduced = controllersRetired
      ? [...countMigrationSources(root, candidates(current))]
          .filter(([, counts]) => counts.controllerPatterns > 0)
          .map(([file]) => file)
      : [];
    if (
      reportRatchetFailures(
        [
          {
            title:
              "Retired Control UI controller host modules and contracts must not be reintroduced:",
            entries: [...retiredControllerHostUsers(root, current)],
          },
          {
            title: "Retired Control UI controller patterns must not be reintroduced:",
            entries: reintroduced,
          },
        ],
        "Use Solid ownership and cleanup; see .agents/skills/solid/SKILL.md.",
      )
    ) {
      return 1;
    }
    console.log(`Control UI controller guard OK (base ${base}).`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
