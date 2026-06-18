#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import type { IssueFixAgentArgs } from "./issue-fix-agent-lib/types.js";

function parsePositiveInteger(raw: string | undefined, label: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function renderIssueFixAgentUsage(): string {
  return [
    "Usage:",
    "  scripts/issue-fix-agent scan",
    "  scripts/issue-fix-agent run [--execute] [--push-pr] [--yes]",
    "  scripts/issue-fix-agent resume [--execute] [--push-pr] [--yes]",
    "  scripts/issue-fix-agent status",
    "  scripts/issue-fix-agent monitor <pr-number>",
    "  scripts/issue-fix-agent gc --dry-run",
  ].join("\n");
}

export function parseIssueFixAgentArgs(argv: readonly string[]): IssueFixAgentArgs {
  const [command, maybeValue, ...rest] = argv;
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const execute = flags.has("--execute");
  const pushPr = flags.has("--push-pr");
  const yes = flags.has("--yes");
  if (pushPr && !execute) {
    throw new Error("--push-pr requires --execute");
  }
  if (yes && (!execute || !pushPr)) {
    throw new Error("--yes requires --execute --push-pr");
  }
  switch (command) {
    case "scan":
    case "run":
    case "resume":
    case "status":
      return { command, execute, pushPr, yes };
    case "monitor":
      return {
        command,
        execute,
        prNumber: parsePositiveInteger(maybeValue, "pr-number"),
        pushPr,
        yes,
      };
    case "gc":
      if (!flags.has("--dry-run") || rest.length > 0) {
        throw new Error("gc requires --dry-run");
      }
      return { command, dryRun: true, execute, pushPr, yes };
    default:
      throw new Error(renderIssueFixAgentUsage());
  }
}

async function main() {
  const args = parseIssueFixAgentArgs(process.argv.slice(2));
  const { runIssueFixAgentCommand } = await import("./issue-fix-agent-lib/workflow.js");
  await runIssueFixAgentCommand({ args });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
