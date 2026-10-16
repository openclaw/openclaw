import { pathToFileURL } from "node:url";
import {
  countMigrationSources,
  isTest,
  readInventorySources,
} from "./control-ui-solid-inventory.mts";
import {
  parseRatchetArgs,
  reportRatchetFailures,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";

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
