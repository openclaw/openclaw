import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript/unstable/ast";
import { isTest, readInventorySources } from "./control-ui-solid-inventory.mts";
import { booleanFlag, parseFlagArgs } from "./lib/arg-utils.mts";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import { reportRatchetFailures } from "./lib/shrink-ratchet.mts";

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
    const args = parseFlagArgs(argv, { staged: false }, [booleanFlag("--staged", "staged")]);
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
        "Use Solid ownership and cleanup; see .agents/skills/solid/SKILL.md.",
      )
    ) {
      return 1;
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
