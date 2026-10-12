import {
  changedProductionFiles,
  inventory,
  type DialectInventoryCache,
} from "./database-dialect-inventory.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  compareRatchetCounts,
  parseRatchetArgs,
  reportRatchetFailures,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";
import { DIALECT_GROUPS, type DialectGroup } from "./lib/sqlite-dialect-constructs.mts";

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  try {
    const fullTree = argv.includes("--full-tree");
    const args = parseRatchetArgs(argv.filter((arg) => arg !== "--full-tree"));
    if (args.prune) {
      throw new Error("SQLite dialect ratchet has no baseline to prune.");
    }
    const base = resolveRatchetBase(root, args);
    if (!base) {
      throw new Error("SQLite dialect ratchet requires a Git base commit.");
    }
    const cache: DialectInventoryCache = new Map();
    const files = fullTree ? undefined : changedProductionFiles(root, base, args.staged);
    const head = inventory(root, "", args.staged, { files, cache });
    const before = inventory(root, base, false, { files, cache });
    const scope = fullTree ? "full tree" : "changed files";
    console.log(
      fullTree
        ? "SQLite dialect scope: full-tree totals."
        : `SQLite dialect scope: ${files?.length ?? 0} differing production files; use --full-tree for totals.`,
    );
    const counts = (rows: ReturnType<typeof inventory>, group: DialectGroup) =>
      new Map(
        rows.map((row) => [row.file, row.matches.filter((match) => match.group === group).length]),
      );
    const total = (fileCounts: ReadonlyMap<string, number>) =>
      [...fileCounts.values()].reduce((sum, count) => sum + count, 0);
    const failures = [];
    for (const group of DIALECT_GROUPS) {
      const previous = counts(before, group);
      const current = counts(head, group);
      const reduction = total(previous) - total(current);
      console.log(
        `SQLite dialect ${group} (${scope}): ${total(previous)} -> ${total(current)}${reduction > 0 ? ` (reduced by ${reduction})` : ""}.`,
      );
      if (reduction < 0) {
        failures.push({
          title: `SQLite dialect ${group} total grew by ${-reduction}: ${total(previous)} -> ${total(current)} in ${scope}`,
          entries: compareRatchetCounts(current, previous).increased.flatMap(
            ({ entry, allowed, current: count }) =>
              [`${entry}: ${allowed} -> ${count}`].concat(
                head
                  .filter((row) => row.file === entry)
                  .flatMap((row) => row.matches.filter((match) => match.group === group))
                  .map(
                    (match) =>
                      `${entry}:${match.line}:${match.column} ${match.construct}${match.owner ? " (owner)" : ""}`,
                  ),
              ),
          ),
        });
      }
    }
    const owners = head.reduce(
      (sum, row) => sum + row.matches.filter((match) => match.owner).length,
      0,
    );
    console.log(
      `SQLite string-set owner: ${owners} mechanical occurrences in ${scope} (included above).`,
    );
    if (
      reportRatchetFailures(
        failures,
        "Keep engine-specific SQL at its existing owner: docs/reference/database-schemas/storage-changes.md\n" +
          "For an intentional increase, document the owning operation, caller evidence, and backend migration contract in the PR; obtain maintainer review of this guard's scoped classification. There is no baseline or bypass to expand.",
      )
    ) {
      return 1;
    }
    console.log("SQLite dialect ratchet OK: no construct-group growth against " + base + ".");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
