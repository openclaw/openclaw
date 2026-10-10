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
    // Unchanged bytes cannot grow. Parse only changed files, keeping both sides
    // under the same counter even when the scanner itself changes.
    const changed = [...currentSources].filter(([file, source]) => previous.get(file) !== source);
    const currentCounts = countMigrationSources(root, new Map(changed));
    const baseCounts = countMigrationSources(
      root,
      new Map(
        changed.flatMap(([file]) => {
          const source = previous.get(file);
          return source === undefined ? [] : [[file, source] as const];
        }),
      ),
    );
    const increased = compareRatchetCounts(flatten(currentCounts), flatten(baseCounts)).increased;
    if (
      reportRatchetFailures(
        [
          {
            title: "Control UI Lit migration debt may not grow:",
            entries: increased.map(
              ({ entry, current, allowed }) => `${entry}: ${current} > ${allowed}`,
            ),
          },
        ],
        "Use Solid for new UI code and remove Lit sites before adding replacements. New ui/src files cannot import Lit.",
      )
    ) {
      return 1;
    }
    console.log(`Control UI Lit ratchet OK (${changed.length} changed files, base ${base}).`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
