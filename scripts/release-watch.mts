#!/usr/bin/env node
// Read-only publication watcher for any OpenClaw Release Publish parent run.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { watchPublication } from "./lib/release-publication-watch.mts";
import {
  ReleaseRefusal,
  createReleaseRunner,
  shellCommand,
  type ReleaseRunner,
} from "./lib/release-stable-state.mts";

const USAGE_LINE = "pnpm release:watch --run <publish-parent-run-id> [options]";
const USAGE = `Usage: ${USAGE_LINE}
  --run <id>                  OpenClaw Release Publish parent run (required)
  --repo <owner/repo>         Default: openclaw/openclaw
  --once                      Observe once and return
  --json                      Print the final JSON snapshot
  --poll-seconds <seconds>    Watch interval (default: 120)
  --timeout-seconds <seconds> Watch deadline (default: 43200)

Exit 0: the publication tree succeeded, or --once found nothing needing attention.
Exit 1: an environment approval is pending or a publication run or job failed.
Exit 2: usage, identity, transport, truncation, timeout, or observation failed.`;

export function parseReleaseWatchArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      run: { type: "string" },
      repo: { type: "string" },
      once: { type: "boolean" },
      json: { type: "boolean" },
      "poll-seconds": { type: "string" },
      "timeout-seconds": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return undefined;
  }
  const seconds = (name: "poll-seconds" | "timeout-seconds", fallback: number) => {
    const value = values[name];
    if (value !== undefined && !/^[1-9][0-9]*$/u.test(value)) {
      throw new ReleaseRefusal(`--${name} must be a positive integer`, [USAGE_LINE]);
    }
    return value === undefined ? fallback : Number(value);
  };
  const repo = values.repo ?? "openclaw/openclaw";
  if (!values.run || !/^[1-9][0-9]*$/u.test(values.run)) {
    throw new ReleaseRefusal("--run must name the publish parent run id", [USAGE_LINE]);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
    throw new ReleaseRefusal("--repo must be owner/name", [USAGE_LINE]);
  }
  return {
    run: values.run,
    repo,
    once: values.once ?? false,
    json: values.json ?? false,
    pollSeconds: seconds("poll-seconds", 120),
    timeoutSeconds: seconds("timeout-seconds", 43_200),
  };
}

export async function runReleaseWatch(
  options: NonNullable<ReturnType<typeof parseReleaseWatchArgs>>,
  runner?: ReleaseRunner,
) {
  const snapshot = await watchPublication(
    createReleaseRunner(false, runner),
    {
      repo: options.repo,
      parentRunId: options.run,
      label: `run ${options.run}`,
      rerunCommand: shellCommand("pnpm", [
        "release:watch",
        "--run",
        options.run,
        "--repo",
        options.repo,
      ]),
    },
    options,
  );
  return snapshot.state === "attention" ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseReleaseWatchArgs(process.argv.slice(2));
    if (options) {
      process.exitCode = await runReleaseWatch(options);
    }
  } catch (error) {
    console.error(`Refused: ${error instanceof Error ? error.message : String(error)}`);
    for (const command of error instanceof ReleaseRefusal ? error.next : []) {
      console.error(command);
    }
    process.exitCode = 2;
  }
}
