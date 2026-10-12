import { inventory } from "./database-worker-inventory.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  compareRatchetCounts,
  parseRatchetArgs,
  reportRatchetFailures,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  try {
    const args = parseRatchetArgs(argv);
    if (args.prune) {
      throw new Error("SQLite worker ratchet has no baseline to prune.");
    }
    const base = resolveRatchetBase(root, args);
    if (!base) {
      throw new Error("SQLite worker ratchet requires a Git base commit.");
    }
    const counts = (rows: ReturnType<typeof inventory>, tier = "T1") =>
      new Map(rows.filter((row) => row.tier === tier).map((row) => [row.file, row.calls.length]));
    const head = inventory(root, "", args.staged);
    const baseline = inventory(root, base);
    const before = counts(baseline);
    const after = counts(head);
    const total = (files: ReadonlyMap<string, number>) =>
      [...files.values()].reduce((sum, count) => sum + count, 0);
    console.log(
      `SQLite T1 live calls: ${total(before)} -> ${total(after)}; ` +
        `T1-compat deprecated-only calls: ${total(counts(baseline, "T1-compat"))} -> ${total(counts(head, "T1-compat"))}.`,
    );
    const { increased } = compareRatchetCounts(after, before);
    if (
      total(after) > total(before) &&
      reportRatchetFailures(
        [
          {
            title: `Main-thread SQLite T1 comparison total grew: ${total(before)} -> ${total(after)}`,
            entries: increased.flatMap(({ entry, allowed, current }) =>
              [`${entry}: ${allowed} -> ${current}`].concat(
                head
                  .filter((row) => row.file === entry)
                  .flatMap((row) => row.calls)
                  .map((call) => `${entry}:${call.line}:${call.column} ${call.primitive}`),
              ),
            ),
          },
        ],
        "Move SQL behind the owner's worker operation: docs/reference/database-schemas/worker-access.md\n" +
          "If the file only executes inside a worker, name it *.worker.ts or add it to workerModules in scripts/database-worker-inventory.mjs with caller evidence.",
      )
    ) {
      return 1;
    }
    console.log("SQLite worker ratchet OK: no T1 call-count growth against " + base + ".");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
