import path from "node:path";
import { relativeStandaloneEntry } from "./bun-standalone-contract.mjs";

/** Emit the shared launcher for the CLI and its embedded child entrypoints. */
export function createStandaloneEntrySource({
  runtimeBootstrap,
  runtimeRoot,
  workerEntries,
  moduleEntries,
}) {
  const workerMap = workerEntries
    .map(
      (entry) =>
        `${JSON.stringify(entry)}: () => import(${JSON.stringify(path.join(runtimeRoot, entry))})`,
    )
    .join(",\n");
  return `import ${JSON.stringify(runtimeBootstrap)};
import path from "node:path";
const root = path.join(path.dirname(process.execPath), "runtime");
const workers = {${workerMap}};
const moduleEntries = new Set(${JSON.stringify(moduleEntries)});
const relativeStandaloneEntry = ${relativeStandaloneEntry.toString()};
let args = process.argv.slice(2);
if (args[0] === "--no-install") args = args.slice(1);
const relative = relativeStandaloneEntry(root, args[0]);
if (relative !== undefined) {
  const entry = args.shift();
  const load = workers[relative] ?? (moduleEntries.has(relative) ? () => import(entry) : undefined);
  if (!load) throw new Error("Unsupported standalone child: " + entry);
  // Keep Bun's runtime prefix: CLI reparsing must not treat the entry path as a command.
  process.argv = [process.argv[0], entry, ...args];
  await load();
} else {
  process.argv[1] = path.join(root, "openclaw.mjs");
  await import(${JSON.stringify(path.join(runtimeRoot, "openclaw.mjs"))});
}
`;
}
