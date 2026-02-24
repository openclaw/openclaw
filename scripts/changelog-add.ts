import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type UnreleasedSection = "changes" | "fixes";

function normalizeEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    throw new Error("entry must not be empty");
  }
  return trimmed.startsWith("- ") ? trimmed : `- ${trimmed}`;
}

function sectionHeading(section: UnreleasedSection): string {
  return section === "changes" ? "### Changes" : "### Fixes";
}

export function insertUnreleasedChangelogEntry(
  changelogContent: string,
  section: UnreleasedSection,
  entry: string,
): string {
  const normalizedEntry = normalizeEntry(entry);
  const lines = changelogContent.split(/\r?\n/);
  const unreleasedHeaderIndex = lines.findIndex((line) =>
    /^##\s+.+\s+\(Unreleased\)\s*$/.test(line.trim()),
  );
  if (unreleasedHeaderIndex < 0) {
    throw new Error("could not find an '(Unreleased)' changelog section");
  }

  const unreleasedEndIndex = lines.findIndex(
    (line, index) => index > unreleasedHeaderIndex && /^##\s+/.test(line.trim()),
  );
  const unreleasedLimit = unreleasedEndIndex < 0 ? lines.length : unreleasedEndIndex;
  const sectionLabel = sectionHeading(section);
  const sectionStartIndex = lines.findIndex(
    (line, index) =>
      index > unreleasedHeaderIndex && index < unreleasedLimit && line.trim() === sectionLabel,
  );
  if (sectionStartIndex < 0) {
    throw new Error(`could not find '${sectionLabel}' under unreleased section`);
  }

  const sectionEndIndex = lines.findIndex(
    (line, index) =>
      index > sectionStartIndex &&
      index < unreleasedLimit &&
      (/^###\s+/.test(line.trim()) || /^##\s+/.test(line.trim())),
  );
  const targetIndex = sectionEndIndex < 0 ? unreleasedLimit : sectionEndIndex;
  let insertionIndex = targetIndex;
  while (insertionIndex > sectionStartIndex + 1 && lines[insertionIndex - 1].trim() === "") {
    insertionIndex -= 1;
  }

  if (
    lines.slice(sectionStartIndex + 1, targetIndex).some((line) => line.trim() === normalizedEntry)
  ) {
    return changelogContent;
  }

  lines.splice(insertionIndex, 0, normalizedEntry);
  return `${lines.join("\n")}\n`;
}

type CliArgs = {
  section: UnreleasedSection;
  entry: string;
  file: string;
};

function parseCliArgs(argv: string[]): CliArgs {
  let section: UnreleasedSection | null = null;
  let entry = "";
  let file = "CHANGELOG.md";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--section") {
      const value = argv[i + 1];
      if (value !== "changes" && value !== "fixes") {
        throw new Error("--section must be one of: changes, fixes");
      }
      section = value;
      i += 1;
      continue;
    }
    if (arg === "--entry") {
      entry = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--file") {
      file = argv[i + 1] ?? file;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!section) {
    throw new Error("missing --section <changes|fixes>");
  }
  if (!entry.trim()) {
    throw new Error("missing --entry <text>");
  }
  return { section, entry, file };
}

function runCli(): void {
  const args = parseCliArgs(process.argv.slice(2));
  const changelogPath = resolve(process.cwd(), args.file);
  const content = readFileSync(changelogPath, "utf8");
  const next = insertUnreleasedChangelogEntry(content, args.section, args.entry);
  if (next !== content) {
    writeFileSync(changelogPath, next, "utf8");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
