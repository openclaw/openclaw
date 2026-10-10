import { pathToFileURL } from "node:url";
import {
  countMigrationSources,
  readInventorySources,
  type MigrationMetrics,
} from "./control-ui-solid-inventory.mts";
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

// Advisory until Lit pages can mount Solid components (the Solid bridge). Feature work
// in unported Lit UI must keep landing; enforcement returns with that transition.
export function main(
  root = process.cwd(),
  argv = process.argv.slice(2),
  { enforce = false }: { enforce?: boolean } = {},
) {
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
    const increasedTotals = compareRatchetCounts(
      totals(currentCounts),
      totals(baseCounts),
    ).increased;
    if (
      increasedTotals.length > 0 &&
      reportRatchetFailures(
        [
          {
            title: "Control UI Lit migration metric totals may not grow:",
            entries: increasedTotals.map(
              ({ entry, current, allowed }) => `${entry}: ${current} > ${allowed}`,
            ),
          },
          {
            title: "Per-file increases (diagnostic):",
            entries: compareRatchetCounts(
              flatten(currentCounts),
              flatten(baseCounts),
            ).increased.map(({ entry, current, allowed }) => `${entry}: ${current} > ${allowed}`),
          },
        ],
        enforce
          ? "Lit sites may move between ui/src files, but each metric's total must not grow. Use Solid or offset new sites with removals in the same change."
          : "Advisory only: Lit growth is reported, not enforced, until Solid components can be mounted from Lit pages.",
      )
    ) {
      return enforce ? 1 : 0;
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
