#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs as parseNodeArgs } from "node:util";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const USAGE =
  "Usage: node scripts/watch-pr-ci.mjs <pr-number> <head-sha> [--repo owner/repo] [--after run-id] [--attach-timeout 900] [--timeout 3600] [--interval 120]";
const FAILURE_CONCLUSIONS = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "STARTUP_FAILURE",
  "STALE",
  "TIMED_OUT",
]);
const ROLLUP_QUERY = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){state mergeable headRefOid statusCheckRollup{state contexts(first:100){nodes{kind:__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}`;

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseNodeArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: "string", default: "openclaw/openclaw" },
        after: { type: "string" },
        "attach-timeout": { type: "string", default: "900" },
        timeout: { type: "string", default: "3600" },
        interval: { type: "string", default: "120" },
      },
    });
  } catch {
    throw new Error(USAGE);
  }
  const [prValue, rawSha, ...extra] = parsed.positionals;
  if (!prValue || !rawSha || extra.length > 0) {
    throw new Error(USAGE);
  }
  const args = {
    pr: positiveInteger(prValue, "pr-number"),
    headSha: rawSha.toLowerCase(),
    repo: parsed.values.repo,
    attachTimeout: positiveInteger(parsed.values["attach-timeout"], "--attach-timeout"),
    timeout: positiveInteger(parsed.values.timeout, "--timeout"),
    interval: positiveInteger(parsed.values.interval, "--interval"),
  };
  if (parsed.values.after !== undefined) {
    args.after = positiveInteger(parsed.values.after, "--after");
  }
  if (!/^[0-9a-f]{40}$/u.test(args.headSha)) {
    throw new Error("head-sha must be a full 40-character commit SHA");
  }
  if (!/^[^/\s]+\/[^/\s]+$/u.test(args.repo)) {
    throw new Error("--repo must be owner/repo");
  }
  return args;
}

const checkName = (check) => (check.kind === "StatusContext" ? check.context : check.name);
const isSuccess = (check) =>
  check.kind === "StatusContext" ? check.state === "SUCCESS" : check.conclusion === "SUCCESS";
const isAutoResponse = (check) =>
  checkName(check)
    ?.toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim() === "auto response";

export function classifyRollup(rollup) {
  const nodes = rollup?.contexts?.nodes ?? [];
  const checks = nodes.filter((check) => !isAutoResponse(check));
  const successfulNames = new Set(checks.filter(isSuccess).map(checkName));
  const pendingCount = checks.filter((check) =>
    check.kind === "StatusContext"
      ? check.state === "PENDING" || check.state === "EXPECTED"
      : check.status !== "COMPLETED",
  ).length;
  const failingChecks = checks.filter((check) => {
    if (check.kind === "StatusContext") {
      return check.state === "ERROR" || check.state === "FAILURE";
    }
    return FAILURE_CONCLUSIONS.has(check.conclusion);
  });
  const failingNames = failingChecks
    .map(checkName)
    .filter(Boolean)
    .toSorted()
    .filter((name, index, names) => name !== names[index - 1]);
  if (rollup?.state === "SUCCESS") {
    return { verdict: "GREEN", pendingCount, failingNames: [] };
  }
  if (rollup?.state === "ERROR" || rollup?.state === "FAILURE") {
    const staleCancelled =
      pendingCount === 0 &&
      failingChecks.length > 0 &&
      failingChecks.every(
        (check) =>
          check.kind === "CheckRun" &&
          check.conclusion === "CANCELLED" &&
          Boolean(check.name) &&
          successfulNames.has(check.name),
      );
    if (staleCancelled) {
      return { verdict: "STALE-CANCELLED", pendingCount, failingNames };
    }
    return {
      verdict: "FAILING",
      pendingCount,
      failingNames: failingNames.length > 0 ? failingNames : ["status rollup"],
    };
  }
  return { verdict: "PENDING", pendingCount, failingNames: [] };
}

function ghJson(...args) {
  return JSON.parse(
    execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    }),
  );
}

const readPr = (pr, repo) =>
  ghJson(...`pr view ${pr} --repo ${repo} --json state,mergeable,headRefOid`.split(" "));
export const buildFindRunArgs = (repo, sha) => [
  "run",
  "list",
  "--repo",
  repo,
  "--commit",
  sha,
  "--workflow",
  "ci.yml",
  "--event",
  "pull_request",
  "--limit",
  "1",
  "--json",
  "createdAt,databaseId",
];
export const selectRunAfter = (runs, after) =>
  runs.find((run) => after === undefined || run.databaseId > after);
const findRun = (repo, sha, after) => selectRunAfter(ghJson(...buildFindRunArgs(repo, sha)), after);
const readRun = (repo, runId) =>
  ghJson(...`run view ${runId} --repo ${repo} --json status,conclusion`.split(" "));

export function classifyRunAttachment(runId, run, after) {
  if (run.conclusion === "skipped") {
    return { attach: false };
  }
  return {
    attach: true,
    warning:
      after === undefined && String(run.status).toLowerCase() === "completed"
        ? `WARN attaching to already-completed run ${runId} (started before watcher); pass --after ${runId} to require a fresh run`
        : undefined,
  };
}

function readRollup(pr, repo) {
  const [owner, name] = repo.split("/");
  return ghJson(
    "api",
    "graphql",
    "-f",
    `query=${ROLLUP_QUERY}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `pr=${pr}`,
  ).data?.repository?.pullRequest;
}

const emit = (line, code) => {
  console.log(line);
  return code;
};
const pause = (deadline, interval) =>
  sleep(Math.max(0, Math.min(interval * 1000, deadline - Date.now())));
const retry = (phase, error) =>
  console.log(
    `RETRY phase=${phase} error=${(error instanceof Error ? error.message : String(error)).replaceAll(/\s+/gu, " ")}`,
  );

function precheck(pr, sha, midWait = false) {
  const state = String(pr?.state ?? "MISSING").toUpperCase();
  if (state !== "OPEN") {
    return emit(`PR-CLOSED state=${state}`, 10);
  }
  if (pr.headRefOid !== sha) {
    return emit(`HEAD-MOVED expected=${sha} actual=${pr.headRefOid}`, 11);
  }
  if (pr.mergeable === false || String(pr.mergeable).toUpperCase() === "CONFLICTING") {
    return emit(
      `${midWait ? "CONFLICTING-MID-WAIT" : "CONFLICTING"} mergeable=CONFLICTING`,
      midWait ? 14 : 12,
    );
  }
  return null;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const attachDeadline = Date.now() + args.attachTimeout * 1000;
  let runId;
  while (!runId) {
    if (Date.now() >= attachDeadline) {
      return emit(
        'NO-RUN-ATTACHED hint="close/reopen re-fires CI; pr-ci-sweeper re-fires hourly at :07"',
        13,
      );
    }
    try {
      const blocked = precheck(readPr(args.pr, args.repo), args.headSha);
      if (blocked !== null) {
        return blocked;
      }
      const candidate = findRun(args.repo, args.headSha, args.after);
      if (candidate) {
        const attachment = classifyRunAttachment(
          candidate.databaseId,
          readRun(args.repo, candidate.databaseId),
          args.after,
        );
        if (attachment.attach) {
          if (attachment.warning) {
            console.log(attachment.warning);
          }
          runId = candidate.databaseId;
        }
      }
    } catch (error) {
      retry("attach", error);
    }
    if (!runId) {
      await pause(attachDeadline, args.interval);
    }
  }
  console.log(`ATTACHED run=${runId} url=https://github.com/${args.repo}/actions/runs/${runId}`);

  const watchDeadline = Date.now() + args.timeout * 1000;
  let lastState = "NONE";
  let lastPending = 0;
  while (true) {
    if (Date.now() >= watchDeadline) {
      return emit(`TIMEOUT state=${lastState} pending=${lastPending}`, 16);
    }
    try {
      const pr = readRollup(args.pr, args.repo);
      const blocked = precheck(pr, args.headSha, true);
      if (blocked !== null) {
        return blocked;
      }
      const result = classifyRollup(pr.statusCheckRollup);
      lastState = pr.statusCheckRollup?.state ?? "NONE";
      lastPending = result.pendingCount;
      console.log(`STATUS state=${lastState} pending=${lastPending}`);
      if (result.verdict === "STALE-CANCELLED") {
        return emit(
          'STALE-CANCELLED hint="aggregate FAILURE but every failing context is a CANCELLED check run with a same-name SUCCESS — likely stale attempts; verify manually"',
          17,
        );
      }
      if (result.verdict === "FAILING") {
        return emit(`FAILING checks=${result.failingNames.join(", ")}`, 15);
      }
      const run = readRun(args.repo, runId);
      if (run.status === "completed" && run.conclusion !== "success") {
        return emit(`FAILING checks=CI workflow (${run.conclusion ?? "unknown"})`, 15);
      }
      if (
        result.verdict === "GREEN" &&
        run.status === "completed" &&
        run.conclusion === "success"
      ) {
        return emit("GREEN", 0);
      }
    } catch (error) {
      retry("watch", error);
    }
    await pause(watchDeadline, args.interval);
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
