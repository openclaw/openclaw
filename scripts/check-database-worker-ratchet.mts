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
    const counts = (rows: ReturnType<typeof inventory>, normalizeForwarding = false) =>
      new Map(
        rows
          .filter((row) => row.tier === "T1")
          .map((row) => {
            const forwarded = new Set<string>();
            const calls = row.calls.filter((call) => {
              // These released wrappers warn, then forward the same query once.
              // Keep raw T1 inventory and charge every additional or altered call.
              // Remove this allowance with the wrappers at the next Plugin SDK major.
              if (
                normalizeForwarding &&
                row.file === "src/plugin-sdk/sqlite-runtime-legacy.ts" &&
                ["executeSqliteQuerySync", "executeSqliteQueryTakeFirstSync"].includes(
                  call.primitive,
                ) &&
                (call.operation === call.primitive ||
                  call.operation === `${call.primitive}Legacy`) &&
                call.forwarding?.namespace === "queries" &&
                call.forwarding.module === "../infra/kysely-sync.js" &&
                call.forwarding.arguments.length === 2 &&
                call.forwarding.arguments[0] === "database" &&
                call.forwarding.arguments[1] === "query" &&
                !forwarded.has(call.primitive)
              ) {
                forwarded.add(call.primitive);
                return false;
              }
              return true;
            });
            return [row.file, calls.length];
          }),
      );
    const head = inventory(root, "", args.staged);
    const baseline = inventory(root, base);
    const before = counts(baseline, true);
    const after = counts(head, true);
    const total = (files: ReadonlyMap<string, number>) =>
      [...files.values()].reduce((sum, count) => sum + count, 0);
    console.log(
      `SQLite T1 raw calls: ${total(counts(baseline))} -> ${total(counts(head))}; ` +
        `forwarding-normalized comparison: ${total(before)} -> ${total(after)}.`,
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
