import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  renderIosReleaseNotes,
  renderIosVersionXcconfig,
  resolveIosVersion,
} from "./lib/ios-version.ts";

type Mode = "check" | "write";

function parseArgs(argv: string[]): { mode: Mode; rootDir: string } {
  let mode: Mode = "write";
  let rootDir = path.resolve(".");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--check": {
        mode = "check";
        break;
      }
      case "--write": {
        mode = "write";
        break;
      }
      case "--root": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --root.");
        }
        rootDir = path.resolve(value);
        index += 1;
        break;
      }
      case "-h":
      case "--help": {
        console.log(
          "Usage: node --import tsx scripts/ios-sync-versioning.ts [--write|--check] [--root dir]",
        );
        process.exit(0);
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }

  return { mode, rootDir };
}

function normalizeTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function syncFile(params: {
  mode: Mode;
  path: string;
  nextContent: string;
  label: string;
}): boolean {
  const nextContent = normalizeTrailingNewline(params.nextContent);
  const currentContent = readFileSync(params.path, "utf8");
  if (currentContent === nextContent) {
    return false;
  }

  if (params.mode === "check") {
    throw new Error(`${params.label} is stale: ${path.relative(process.cwd(), params.path)}`);
  }

  writeFileSync(params.path, nextContent, "utf8");
  return true;
}

const options = parseArgs(process.argv.slice(2));
const version = resolveIosVersion(options.rootDir);
const changelogContent = readFileSync(version.changelogPath, "utf8");
const nextVersionXcconfig = renderIosVersionXcconfig(version);
const nextReleaseNotes = renderIosReleaseNotes(version, changelogContent);
const updatedLabels: string[] = [];

if (
  syncFile({
    mode: options.mode,
    path: version.versionXcconfigPath,
    nextContent: nextVersionXcconfig,
    label: "iOS version xcconfig",
  })
) {
  updatedLabels.push(path.relative(process.cwd(), version.versionXcconfigPath));
}

if (
  syncFile({
    mode: options.mode,
    path: version.releaseNotesPath,
    nextContent: nextReleaseNotes,
    label: "iOS release notes",
  })
) {
  updatedLabels.push(path.relative(process.cwd(), version.releaseNotesPath));
}

if (options.mode === "check") {
  process.stdout.write("iOS versioning artifacts are up to date.\n");
} else if (updatedLabels.length === 0) {
  process.stdout.write("iOS versioning artifacts already up to date.\n");
} else {
  process.stdout.write(`Updated iOS versioning artifacts:\n- ${updatedLabels.join("\n- ")}\n`);
}
