#!/usr/bin/env -S node --import tsx

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type Args = {
  version: string;
  changelogPath: string;
};

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}.`);
    }
    values.set(key, value);
    index += 1;
  }

  const version = values.get("version") ?? "";
  const changelogPath = values.get("changelog") ?? "CHANGELOG.md";

  if (!version) {
    throw new Error("Missing --version.");
  }

  return { version, changelogPath };
}

export function extractReleaseNotesSection(content: string, version: string): string {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (startIndex === -1) {
    throw new Error(`Version ${version} not found in CHANGELOG.md.`);
  }

  const collected: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("## ")) {
      break;
    }
    collected.push(line);
  }

  const body = collected.join("\n").trim();
  if (!body) {
    throw new Error(`Version ${version} has an empty changelog section.`);
  }

  return `${body}\n`;
}

function main(argv: string[]): number {
  const { version, changelogPath } = parseArgs(argv);
  const changelog = readFileSync(changelogPath, "utf8");
  process.stdout.write(extractReleaseNotesSection(changelog, version));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
