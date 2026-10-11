import { pathToFileURL } from "node:url";
import * as ts from "typescript/unstable/ast";
import {
  countMigrationSources,
  isTest,
  readInventorySources,
  type MigrationMetrics,
} from "./control-ui-solid-inventory.mts";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import {
  compareRatchetCounts,
  parseRatchetArgs,
  reportRatchetFailures,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";

const METRICS = [
  "litImports",
  "htmlTemplates",
  "waTags",
  "requestUpdate",
  "stateDecorators",
  "tasks",
  "todoSolid2",
] as const satisfies readonly (keyof MigrationMetrics)[];

function loadsModule(node: ts.Node): boolean {
  return (
    (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))) ||
    Boolean(node.forEachChild(loadsModule))
  );
}

function isMovedSource(
  file: string,
  text: string,
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
  baseCounts: ReadonlyMap<string, MigrationMetrics>,
) {
  using parser = createNativeTypeScriptParser();
  const tree = parser.parseSourceFile(file, text);
  const statements = tree.statements
    .filter(
      (node) =>
        !ts.isImportDeclaration(node) &&
        !ts.isImportEqualsDeclaration(node) &&
        !ts.isExportDeclaration(node) &&
        !(ts.isVariableStatement(node) && loadsModule(node)),
    )
    .map((node) => text.slice(node.pos, node.end).trim());
  return [...baseCounts].some(([source, counts]) => {
    if (counts.litImports === 0 || isTest(source)) {
      return false;
    }
    const before = previous.get(source)!;
    const after = current.get(source) ?? "";
    if (before === text && after !== text) {
      return true;
    }
    // Recognize splits by moved implementation, never by shared import boilerplate.
    // A heavily rewritten extraction may need to land its move separately.
    const moved = statements.filter(
      (statement) => before.includes(statement) && !after.includes(statement),
    );
    return (
      moved.length > 0 &&
      moved.reduce((sum, statement) => sum + statement.length, 0) >=
        statements.reduce((sum, statement) => sum + statement.length, 0) / 2
    );
  });
}

function flatten(counts: ReadonlyMap<string, MigrationMetrics>) {
  return new Map(
    [...counts].flatMap(([file, row]) =>
      METRICS.map((metric): [string, number] => [`${file} [${metric}]`, row[metric]]),
    ),
  );
}

function totals(counts: ReadonlyMap<string, MigrationMetrics>) {
  return new Map(
    METRICS.map((metric) => [
      metric,
      [...counts.values()].reduce((sum, row) => sum + row[metric], 0),
    ]),
  );
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  try {
    const args = parseRatchetArgs(argv);
    if (args.prune) {
      throw new Error("The Lit ratchet reads its base from Git; --prune is not supported.");
    }
    const base = resolveRatchetBase(root, args);
    if (!base) {
      throw new Error("No Lit ratchet base found; pass --base <ref>.");
    }
    const previous = readInventorySources(root, { ref: base, roots: ["ui/src"] });
    const currentSources = readInventorySources(root, { staged: args.staged, roots: ["ui/src"] });
    // Include deleted paths so moves and splits retain their base contribution.
    // Unchanged files cancel out and do not need parsing on either side.
    const changed = new Set(
      [...new Set([...previous.keys(), ...currentSources.keys()])].filter(
        (file) => previous.get(file) !== currentSources.get(file),
      ),
    );
    const changedSources = (sources: ReadonlyMap<string, string>) =>
      new Map([...sources].filter(([file]) => changed.has(file)));
    const currentCounts = countMigrationSources(root, changedSources(currentSources));
    const baseCounts = countMigrationSources(root, changedSources(previous));
    const newLitFiles = [...currentCounts].filter(
      ([file, counts]) =>
        counts.litImports > 0 &&
        !previous.has(file) &&
        !isTest(file) &&
        !isMovedSource(file, currentSources.get(file)!, previous, currentSources, baseCounts),
    );
    const increasedTotals = compareRatchetCounts(
      totals(currentCounts),
      totals(baseCounts),
    ).increased;
    const perFileIncreases = compareRatchetCounts(
      flatten(currentCounts),
      flatten(baseCounts),
    ).increased;
    for (const [title, increases] of [
      ["Control UI Lit migration metric totals (advisory)", increasedTotals],
      ["Per-file increases (advisory)", perFileIncreases],
    ] as const) {
      if (increases.length > 0) {
        console.log(
          `${title}:\n${increases.map(({ entry, current, allowed }) => `  ${entry}: ${current} > ${allowed}`).join("\n")}`,
        );
      }
    }
    if (
      reportRatchetFailures(
        [
          {
            title: "New Control UI production files must not import Lit:",
            entries: newLitFiles.map(([file]) => file),
          },
        ],
        "Use Solid; see .agents/skills/solid/SKILL.md and defineSolidBridge in ui/src/lit/solid-bridge.ts to mount Solid from Lit.",
      )
    ) {
      return 1;
    }
    console.log(`Control UI Lit ratchet OK (${changed.size} changed files, base ${base}).`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
