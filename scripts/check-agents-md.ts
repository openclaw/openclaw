import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Line-count ceiling for every tracked `AGENTS.md` in the repo. Enforces the
// progressive-disclosure invariant: rules colocate with the surface they
// govern, and no single guide is allowed to grow back into a monolith.
//
// The target is 150. Exemptions below are tombstoned — remove once the
// corresponding migration lands.
export const DEFAULT_MAX_LINES = 150;

// Paths (repo-root relative, forward slash) that are intentionally allowed to
// exceed the cap today. Each entry MUST name the reason and the PR/condition
// under which it can be removed.
export const KNOWN_EXEMPTIONS: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: "AGENTS.md",
    // Remove once the root-CLAUDE.md slim-down PR (the "task -> guide" router
    // split) lands. Tracking: council verdict 2026-04-24.
    reason:
      "Root AGENTS.md is scheduled for extraction into docs/contributing/*. Exemption must be removed once that restructure lands.",
  },
  {
    path: "docs/reference/templates/AGENTS.md",
    // Templates document exemplar content (copy-paste starter material). They
    // are not live contributor rules and never should be.
    reason: "Template file — documents exemplar content, not live rules.",
  },
] as const;

function writeStdoutLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

type ParsedArgs = {
  maxLines: number;
};

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let maxLines = DEFAULT_MAX_LINES;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--max") {
      const next = argv[index + 1];
      if (!next || Number.isNaN(Number(next))) {
        throw new Error("Missing/invalid --max value");
      }
      maxLines = Number(next);
      index++;
      continue;
    }
  }

  return { maxLines };
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function gitLsAgentsFiles(cwd?: string): string[] {
  const stdout = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "*AGENTS.md"],
    { encoding: "utf8", cwd },
  );
  return stdout
    .split("\n")
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean)
    .filter((filePath) => path.basename(filePath) === "AGENTS.md");
}

export function isExempt(
  relativePath: string,
  exemptions: ReadonlyArray<{ path: string }> = KNOWN_EXEMPTIONS,
): boolean {
  const normalized = normalizePath(relativePath);
  return exemptions.some((entry) => entry.path === normalized);
}

export type Offender = {
  filePath: string;
  lines: number;
};

export async function findOversizedAgentsFiles(
  filePaths: ReadonlyArray<string>,
  maxLines: number,
  exemptions: ReadonlyArray<{ path: string }> = KNOWN_EXEMPTIONS,
  readFileImpl: (p: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<Offender[]> {
  const results = await Promise.all(
    filePaths
      .filter((filePath) => !isExempt(filePath, exemptions))
      .map(async (filePath) => {
        const content = await readFileImpl(filePath);
        // Count physical lines. Keeps the rule predictable across editors.
        const lines = content.split("\n").length;
        return { filePath, lines };
      }),
  );

  return results.filter((result) => result.lines > maxLines).toSorted((a, b) => b.lines - a.lines);
}

async function main(): Promise<void> {
  // Makes `... | head` safe.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });

  const { maxLines } = parseArgs(process.argv.slice(2));
  const tracked = gitLsAgentsFiles().filter((filePath) => existsSync(filePath));

  const offenders = await findOversizedAgentsFiles(tracked, maxLines);

  if (!offenders.length) {
    return;
  }

  writeStdoutLine(`AGENTS.md files exceeding ${maxLines} lines:`);
  for (const offender of offenders) {
    writeStdoutLine(`${offender.lines}\t${offender.filePath}`);
  }
  writeStdoutLine("");
  writeStdoutLine("Extract rules into the scoped guide they govern, or into docs/contributing/*.");
  writeStdoutLine(
    "If a file genuinely must exceed the cap, add it to KNOWN_EXEMPTIONS in scripts/check-agents-md.ts with a tombstoned reason.",
  );

  process.exitCode = 1;
}

// Only run main when executed directly (keeps tests clean).
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  normalizePath(process.argv[1]).endsWith("scripts/check-agents-md.ts");
if (invokedDirectly) {
  await main();
}
