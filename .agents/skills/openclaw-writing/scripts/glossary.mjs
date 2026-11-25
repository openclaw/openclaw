import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The Markdown rows are the source for both lookup and scoped copy checks.
export function readGlossary() {
  const source = readFileSync(new URL("../../../../GLOSSARY.md", import.meta.url), "utf8");
  return source
    .split("\n")
    .filter(
      (line) => line.startsWith("| ") && !/^\|\s*Use\s*\|/.test(line) && !line.startsWith("| ---"),
    )
    .map((line) => {
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      if (cells.length !== 3 || cells.some((cell) => !cell)) {
        throw new Error("Expected Use | Meaning | Avoid for this meaning");
      }
      return { use: cells[0], meaning: cells[1], avoid: cells[2] === "—" ? "" : cells[2] };
    });
}

export function lookup(entries, query) {
  const needle = query.trim().toLocaleLowerCase("en-US");
  if (!needle) {
    throw new Error("Provide a nonempty term");
  }
  return entries.filter((entry) =>
    [entry.use, entry.avoid].some((field) => field.toLocaleLowerCase("en-US").includes(needle)),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...queries] = process.argv.slice(2);
  if (command !== "lookup" || queries.length === 0 || queries.some((query) => !query.trim())) {
    console.error(
      'Usage: node .agents/skills/openclaw-writing/scripts/glossary.mjs lookup "term" ["term"]',
    );
    process.exitCode = 2;
  } else {
    const entries = readGlossary();
    for (const query of queries) {
      console.log(JSON.stringify({ query, entries: lookup(entries, query) }));
    }
  }
}
