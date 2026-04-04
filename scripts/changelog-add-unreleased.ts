import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { appendUnreleasedChangelogEntry } from "../src/infra/changelog-unreleased.js";

type SectionArg = "breaking" | "changes" | "fixes";

function parseArgs(argv: string[]): {
  changelogPath: string;
  section: "Breaking" | "Changes" | "Fixes";
  entry: string;
} {
  let changelogPath = resolve("CHANGELOG.md");
  let section: SectionArg | undefined;
  const entryParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --file.");
      }
      changelogPath = resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--section") {
      const next = argv[index + 1] as SectionArg | undefined;
      if (!next || !["breaking", "changes", "fixes"].includes(next)) {
        throw new Error("Missing or invalid value for --section.");
      }
      section = next;
      index += 1;
      continue;
    }
    entryParts.push(arg);
  }

  if (!section) {
    throw new Error("Missing required --section <breaking|changes|fixes>.");
  }
  const entry = entryParts.join(" ").trim();
  if (!entry) {
    throw new Error("Missing changelog entry text.");
  }

  return {
    changelogPath,
    section: section === "breaking" ? "Breaking" : section === "changes" ? "Changes" : "Fixes",
    entry,
  };
}

if (import.meta.main) {
  const { changelogPath, section, entry } = parseArgs(process.argv.slice(2));
  const content = readFileSync(changelogPath, "utf8");
  const next = appendUnreleasedChangelogEntry(content, {
    section,
    entry,
  });
  if (next !== content) {
    writeFileSync(changelogPath, next);
  }
  console.log(`Updated ${changelogPath} (${section}).`);
}
